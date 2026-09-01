import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

// ---------------------------------------------------------------------------
// Context token store (in-process cache: accountId+userId → contextToken)
// ---------------------------------------------------------------------------

/**
 * contextToken is issued per-message by the Weixin getupdates API and must
 * be echoed verbatim in every outbound send. The monitor loop populates this
 * map on each inbound message, and the outbound adapter reads it back.
 *
 * **It is also persisted to disk**, because without the token we cannot send
 * at all — and a bot that only ever replies is fine, but one that has promised
 * to remind you at 8am is not. Keeping this in memory only meant every restart
 * silently killed every pending reminder until the user happened to speak again.
 * Nothing reported that; the reminder just never arrived.
 *
 * State file: `<stateDir>/openclaw-weixin/context-tokens.json`
 * Format:     `{ "<accountId>:<userId>": { "token": "…", "at": "<ISO>" } }`
 *
 * The token still expires on the Weixin side (session expiry / re-login), and
 * a stale one simply fails the send — which is no worse than having none.
 */
const contextTokenStore = new Map<string, { token: string; at: string }>();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function resolveContextTokenPath(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "context-tokens.json");
}

interface StoredToken {
  token: string;
  /** When we last saw this token, so we can reason about staleness later. */
  at: string;
}

/** Disk is loaded once, lazily: the map is authoritative afterwards. */
let loadedFromDisk = false;

function loadTokensFromDisk(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const raw = fs.readFileSync(resolveContextTokenPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, StoredToken>;
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (value?.token) contextTokenStore.set(key, { token: value.token, at: value.at ?? new Date().toISOString() });
    }
    logger.debug(`loadTokensFromDisk: restored ${contextTokenStore.size} token(s)`);
  } catch {
    // missing or corrupt — start fresh, exactly like debug-mode does
  }
}

function saveTokensToDisk(): void {
  const filePath = resolveContextTokenPath();
  try {
    // ⚠️ 每条 token 记自己的时间，不能所有 key 共用一个「现在」。
    // 原来是后者：任何一次写盘都会把所有 token 的 at 刷成同一个时刻，
    // 于是文件里的"年龄"是假的 —— 而我们正要靠它判断 token 还能不能用。
    const out: Record<string, StoredToken> = {};
    for (const [key, v] of contextTokenStore) out[key] = { token: v.token, at: v.at };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // temp + rename so a crash mid-write cannot leave a corrupt file behind
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    // Never let persistence break message handling — but say so, because a
    // silent failure here reintroduces exactly the bug this code exists to fix.
    logger.debug(`saveTokensToDisk failed: ${String(error)}`);
  }
}

/** Store a context token for a given account+user pair. */
export function setContextToken(accountId: string, userId: string, token: string): void {
  loadTokensFromDisk();
  const k = contextTokenKey(accountId, userId);
  logger.debug(`setContextToken: key=${k}`);
  const changed = contextTokenStore.get(k)?.token !== token;
  // 只有 token 真的换了才更新时间戳：同一个 token 反复看到，不该让它"变年轻"。
  if (changed) {
    contextTokenStore.set(k, { token, at: new Date().toISOString() });
    saveTokensToDisk();
  }
}

/** Retrieve the cached context token for a given account+user pair. */
export function getContextToken(accountId: string, userId: string): string | undefined {
  loadTokensFromDisk();
  const k = contextTokenKey(accountId, userId);
  const val = contextTokenStore.get(k);
  // 把年龄一起记下来：每一次发送因此都成为一个「token 多老 → 成不成功」的数据点，
  // 不用为了测有效期去额外打扰任何人。
  const ageH = val ? ((Date.now() - Date.parse(val.at)) / 3600000).toFixed(1) : "n/a";
  logger.debug(
    `getContextToken: key=${k} found=${val !== undefined} ageHours=${ageH} storeSize=${contextTokenStore.size}`,
  );
  return val?.token;
}

// ---------------------------------------------------------------------------
// Message ID generation
// ---------------------------------------------------------------------------

function generateMessageSid(): string {
  return generateId("openclaw-weixin");
}

/** Inbound context passed to the OpenClaw core pipeline (matches MsgContext shape). */
export type WeixinMsgContext = {
  Body: string;
  From: string;
  To: string;
  AccountId: string;
  OriginatingChannel: "openclaw-weixin";
  OriginatingTo: string;
  MessageSid: string;
  Timestamp?: number;
  Provider: "openclaw-weixin";
  ChatType: "direct";
  /** Set by monitor after resolveAgentRoute so dispatchReplyFromConfig uses the correct session. */
  SessionKey?: string;
  context_token?: string;
  MediaUrl?: string;
  MediaPath?: string;
  MediaType?: string;
  /** Raw message body for framework command authorization. */
  CommandBody?: string;
  /** Whether the sender is authorized to execute slash commands. */
  CommandAuthorized?: boolean;
};

/** Returns true if the message item is a media type (image, video, file, or voice). */
export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

export function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Quoted media is passed as MediaPath; only include the current text as body.
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      // Build quoted context from both title and message_item content.
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // 语音转文字：如果语音消息有 text 字段，直接使用文字内容
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export type WeixinInboundMediaOpts = {
  /** Local path to decrypted image file. */
  decryptedPicPath?: string;
  /** MIME type sniffed from the image's magic bytes. */
  picMediaType?: string;
  /** Local path to transcoded/raw voice file (.wav or .silk). */
  decryptedVoicePath?: string;
  /** MIME type for the voice file (e.g. "audio/wav" or "audio/silk"). */
  voiceMediaType?: string;
  /** Local path to decrypted file attachment. */
  decryptedFilePath?: string;
  /** MIME type for the file attachment (guessed from file_name). */
  fileMediaType?: string;
  /** Local path to decrypted video file. */
  decryptedVideoPath?: string;
};

/**
 * Convert a WeixinMessage from getUpdates to the inbound MsgContext for the core pipeline.
 * Media: only pass MediaPath (local file, after CDN download + decrypt).
 * We never pass MediaUrl — the upstream CDN URL is encrypted/auth-only.
 * Priority when multiple media types present: image > video > file > voice.
 */
export function weixinMessageToMsgContext(
  msg: WeixinMessage,
  accountId: string,
  opts?: WeixinInboundMediaOpts,
): WeixinMsgContext {
  const from_user_id = msg.from_user_id ?? "";
  const ctx: WeixinMsgContext = {
    Body: bodyFromItemList(msg.item_list),
    From: from_user_id,
    To: from_user_id,
    AccountId: accountId,
    OriginatingChannel: "openclaw-weixin",
    OriginatingTo: from_user_id,
    MessageSid: generateMessageSid(),
    Timestamp: msg.create_time_ms,
    Provider: "openclaw-weixin",
    ChatType: "direct",
  };
  if (msg.context_token) {
    ctx.context_token = msg.context_token;
  }

  if (opts?.decryptedPicPath) {
    ctx.MediaPath = opts.decryptedPicPath;
    ctx.MediaType = "image/*";
  } else if (opts?.decryptedVideoPath) {
    ctx.MediaPath = opts.decryptedVideoPath;
    ctx.MediaType = "video/mp4";
  } else if (opts?.decryptedFilePath) {
    ctx.MediaPath = opts.decryptedFilePath;
    ctx.MediaType = opts.fileMediaType ?? "application/octet-stream";
  } else if (opts?.decryptedVoicePath) {
    ctx.MediaPath = opts.decryptedVoicePath;
    ctx.MediaType = opts.voiceMediaType ?? "audio/wav";
  }

  return ctx;
}

/** Extract the context_token from an inbound WeixinMsgContext. */
export function getContextTokenFromMsgContext(ctx: WeixinMsgContext): string | undefined {
  return ctx.context_token;
}
