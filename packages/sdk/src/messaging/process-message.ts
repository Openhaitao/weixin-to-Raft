import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Agent, ChatRequest, MediaAttachment } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { MediaBudgetExceededError } from "../cdn/pic-decrypt.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, bodyFromItemList, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";
import { messageDeliveryId } from "../storage/delivery-ledger.js";

const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "weixin-agent/media");
const firstMessageLoggedByAccount = new Set<string>();

export function buildMediaSendFallbackText(responseText?: string): string {
  return [
    responseText ? markdownToPlainText(responseText) : "",
    "（附件/二维码发送失败，请稍后重试或在飞书里完成对应授权。）",
  ].filter(Boolean).join("\n");
}

/**
 * The last gate before disk. The streaming cap bounds CDN INPUT bytes; it does
 * not bound what is finally written — SILK→WAV transcoding can multiply the
 * data, so an in-budget download could still land an over-budget file and be
 * delivered as if nothing were wrong.
 *
 * Exported so the regression can hit the PRODUCTION check rather than a mock
 * that re-implements it (a test that asserts its own stub stays green when the
 * real gate is deleted).
 */
export function assertWithinMediaBudget(buffer: Buffer, maxBytes?: number): void {
  if (maxBytes != null && buffer.length > maxBytes) {
    throw new MediaBudgetExceededError("saveMedia", maxBytes);
  }
}

/** Save a buffer to a temporary file, returning the file path. */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  assertWithinMediaBudget(buffer, maxBytes);
  const dir = path.join(MEDIA_TEMP_DIR, subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  let ext = ".bin";
  if (originalFilename) {
    ext = path.extname(originalFilename) || ".bin";
  } else if (contentType) {
    ext = getExtensionFromMime(contentType);
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

/** Dependencies for processOneMessage. */
export type ProcessMessageDeps = {
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
};

/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Find the first downloadable media item from a message. */
/** Hard caps: without them a message with many attachments could pull an
 * unbounded amount of data (the single-file limit alone does not bound N). */
export const MAX_MEDIA_ITEMS = 9;

function isDownloadableMediaItem(i: MessageItem): boolean {
  const has = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    Boolean(m?.encrypt_query_param || m?.full_url);
  if (i.type === MessageItemType.IMAGE) return has(i.image_item?.media);
  if (i.type === MessageItemType.VIDEO) return has(i.video_item?.media);
  if (i.type === MessageItemType.FILE) return has(i.file_item?.media);
  // A voice note that already carries a transcript needs no download.
  if (i.type === MessageItemType.VOICE) return has(i.voice_item?.media) && !i.voice_item?.text;
  return false;
}

/**
 * ALL downloadable media in this message, in their original order.
 *
 * Previously this returned exactly one item, chosen by a type priority
 * (IMAGE > VIDEO > FILE > VOICE) — so a message carrying two photos, or an
 * image plus a PDF, silently lost everything after the first.
 */
/** Total bytes across all attachments of one message. The per-file limit does
 * not bound N, so a many-attachment message needs its own ceiling. */
export const MAX_TOTAL_MEDIA_BYTES = 200 * 1024 * 1024;

/**
 * Download ONE attachment and map it to a MediaAttachment. Returns null when
 * the item yields nothing — a failure here is logged and skipped so the other
 * attachments in the same message still reach the model.
 */
async function downloadOneAttachment(
  item: MessageItem,
  deps: ProcessMessageDeps,
  budgetBytes: number,
): Promise<MediaAttachment | undefined> {
  try {
    const d = await downloadMediaFromItem(item, {
      cdnBaseUrl: deps.cdnBaseUrl,
      saveMedia: saveMediaBuffer,
      log: deps.log,
      errLog: deps.errLog,
      label: "inbound",
    }, budgetBytes);
    if (d.decryptedPicPath) {
      // picMediaType is always set alongside an image path: the path only
      // exists once the bytes were positively identified as an image.
      return { type: "image", filePath: d.decryptedPicPath, mimeType: d.picMediaType ?? "application/octet-stream" };
    }
    if (d.decryptedVideoPath) {
      return { type: "video", filePath: d.decryptedVideoPath, mimeType: "video/mp4" };
    }
    if (d.decryptedFilePath) {
      return {
        type: "file",
        filePath: d.decryptedFilePath,
        mimeType: d.fileMediaType ?? "application/octet-stream",
        fileName: item.file_item?.file_name ?? undefined,
      };
    }
    if (d.decryptedVoicePath) {
      return { type: "audio", filePath: d.decryptedVoicePath, mimeType: d.voiceMediaType ?? "audio/wav" };
    }
    return undefined;
  } catch (err) {
    // One bad attachment must not take the rest of the message with it.
    deps.errLog(`[weixin] attachment download failed (others preserved): ${String(err)}`);
    return undefined;
  }
}

export function findMediaItems(itemList?: MessageItem[]): {
  items: MessageItem[];
  /** How many downloadable attachments the message actually carried. Kept so a
   * count-cap truncation can be reported instead of vanishing silently. */
  candidateCount: number;
} {
  if (!itemList?.length) return { items: [], candidateCount: 0 };
  const all = itemList.filter(isDownloadableMediaItem);
  return { items: all.slice(0, MAX_MEDIA_ITEMS), candidateCount: all.length };
}

/**
 * Outcome of handling one inbound message. Callers need this to decide whether
 * the delivery may be committed as done: recording "handled" on arrival would
 * suppress the server's redelivery of a message we in fact failed to answer,
 * trading duplicates for silent loss.
 */
export type ProcessOutcome = {
  /** The turn finished without needing the server to redeliver it. */
  delivered: boolean;
  /**
   * The turn's effect survives a restart.
   *
   * A reply that was sent is durable — it is out of the process. Material
   * stashed into the in-memory inbox is NOT: after a restart the material is
   * gone, so if the message had been committed to the persistent ledger the
   * server's redelivery would be suppressed and the material would be lost
   * with no reply ever sent. A de-dup record must not outlive the effect it
   * protects.
   */
  durable: boolean;
  /** Earlier messages this turn made durable (consumed material). */
  commitIds: string[];
};

/** Shown when the agent returns neither text nor media. */
export const EMPTY_RESPONSE_NOTICE =
  "这条我没能生成回复，麻烦你换个说法再发一次。";

export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<ProcessOutcome> {
  const receivedAt = Date.now();
  let delivered = false;
  let durable = false;
  let commitIds: string[] = [];
  if (!firstMessageLoggedByAccount.has(deps.accountId)) {
    firstMessageLoggedByAccount.add(deps.accountId);
    const sidecarReadyAt = Number(process.env.WEIXIN_AGENT_SIDECAR_READY_AT);
    if (Number.isFinite(sidecarReadyAt) && sidecarReadyAt > 0) {
      deps.log(`[timing] sidecar_ready_to_first_wechat_message_ms=${receivedAt - sidecarReadyAt}`);
    }
    deps.log(`[timing] first_wechat_message_received_at_ms=${receivedAt}`);
  }
  const textBody = extractTextBody(full.item_list);

  // --- Slash commands and short-lived command followups ---
  if (textBody) {
    const conversationId = full.from_user_id ?? "";
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: conversationId,
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        accountId: deps.accountId,
        log: deps.log,
        errLog: deps.errLog,
        onClear: () => deps.agent.clearSession?.(conversationId),
        getModelMenu: deps.agent.getModelMenu
          ? () => deps.agent.getModelMenu!(conversationId)
          : undefined,
        selectModel: deps.agent.selectModel
          ? (modelId) => deps.agent.selectModel!(conversationId, modelId)
          : undefined,
      },
      receivedAt,
      full.create_time_ms,
    );
    // Only a confirmed send counts. A command that failed AND failed to report
    // the failure has told the user nothing, so it must stay redeliverable.
    // A slash reply is out of the process once sent, so delivered ⇒ durable.
    if (slashResult.handled) {
      return { delivered: slashResult.replied, durable: slashResult.replied, commitIds: [] };
    }
  }

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  // --- Download media ---
  // Every downloadable attachment in this ONE message, in order. A failure on
  // one must not discard the others: a two-photo turn where the second download
  // fails should still deliver the first, with the loss stated out loud.
  const mediaItems: MediaAttachment[] = [];
  let totalMediaBytes = 0;
  const allMedia = findMediaItems(full.item_list);
  const allMediaItems = allMedia.items;
  if (allMediaItems.length > 1) {
    deps.log(`[weixin] inbound carries ${allMediaItems.length} attachments`);
  }
  const skipped: string[] = [];
  if (allMedia.candidateCount > allMediaItems.length) {
    skipped.push(`${allMedia.candidateCount - allMediaItems.length} 个附件超出单条消息上限（最多 ${MAX_MEDIA_ITEMS} 个）`);
  }
  for (const item of allMediaItems) {
    // The remaining budget is pushed DOWN into the download so an oversized
    // attachment is refused while streaming — checking size after the fact has
    // already paid the memory cost, and a 199MB running total could still be
    // followed by a fresh 100MB read.
    const remaining = MAX_TOTAL_MEDIA_BYTES - totalMediaBytes;
    if (remaining <= 0) {
      skipped.push("(budget exhausted)");
      continue;
    }
    const one = await downloadOneAttachment(item, deps, remaining);
    if (!one) {
      skipped.push(item.file_item?.file_name ?? "attachment");
      continue;
    }
    mediaItems.push(one);
    try { totalMediaBytes += (await fs.stat(one.filePath)).size; } catch { /* size unknown */ }
  }
  // A log line is invisible to the person and to the model. The whole defect
  // being fixed here is "an attachment vanished without anyone saying so", so
  // the loss must ride into the SAME agent turn as structured text.
  let missingNotice = "";
  if (skipped.length) {
    deps.errLog(`[weixin] ${skipped.length} attachment(s) not delivered: ${skipped.join(", ")}`);
    missingNotice = [
      "",
      "[附件缺失说明]",
      ...skipped.map((s, i) => `${i + 1}. ${s}`),
      "以上附件没有送达，请不要假设它们的内容；需要的话请用户重新发送。",
    ].join("\n");
  }

  let media: ChatRequest["media"] = mediaItems[0];

  // --- Build ChatRequest ---
  const request: ChatRequest = {
    conversationId: full.from_user_id ?? "",
    deliveryId: messageDeliveryId(full),
    text: `${bodyFromItemList(full.item_list)}${missingNotice}`,
    timing: { receivedAt },
    // `media` stays the first attachment for legacy agents; `mediaItems`
    // carries the full ordered set. Consumers should read normalizeChatMedia().
    media,
    ...(mediaItems.length ? { mediaItems } : {}),
  };

  // --- Typing indicator (start + periodic refresh) ---
  const to = full.from_user_id ?? "";
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const startTyping = () => {
    if (!deps.typingTicket) return;
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.TYPING,
      },
    }).catch(() => {});
  };
  const showTyping = deps.agent.shouldShowTyping
    ? await deps.agent.shouldShowTyping(request)
    : true;
  if (deps.typingTicket && showTyping) {
    startTyping();
    typingTimer = setInterval(startTyping, 10_000);
  }

  // --- Call agent & send reply ---
  try {
    const response = await deps.agent.chat(request);

    if (response.media) {
      let filePath: string;
      const mediaUrl = response.media.url;
      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        filePath = await downloadRemoteImageToTemp(
          mediaUrl,
          path.join(MEDIA_TEMP_DIR, "outbound"),
        );
      } else {
        filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
      }
      try {
        await sendWeixinMediaFile({
          filePath,
          to,
          text: response.text ? markdownToPlainText(response.text) : "",
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
          cdnBaseUrl: deps.cdnBaseUrl,
        });
      } catch (err) {
        logger.error(`processOneMessage: media send failed, falling back to text: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
        const fallbackText = buildMediaSendFallbackText(response.text);
        await sendMessageWeixin({
          to,
          text: fallbackText,
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        });
      }
      delivered = true;
      durable = true;
    } else if (response.text) {
      await sendMessageWeixin({
        to,
        text: markdownToPlainText(response.text),
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
      });
      delivered = true;
      durable = true;
    } else if (response.silent) {
      // Handled with no reply owed — but the effect (stashed material) lives
      // only in memory, so this must NOT be written to the persistent ledger.
      delivered = true;
      durable = false;
    } else {
      // The agent produced nothing to send. Staying undelivered would just have
      // the server redeliver a message that deterministically produces nothing
      // again, so say so once and treat that notice as the delivery.
      await sendMessageWeixin({
        to,
        text: EMPTY_RESPONSE_NOTICE,
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
      });
      delivered = true;
      durable = true;
    }
    // The reply is out. Only now may the material that produced it be given
    // up, and only now may those earlier messages be retired durably.
    if (durable) {
      commitIds = response.consumedDeliveryIds ?? [];
      if (commitIds.length) {
        try {
          await deps.agent.confirmConsumed?.(request.conversationId, commitIds);
        } catch (err) {
          // Holding material too long only costs a stale merge; dropping it
          // costs the user's photo. Keep it and let the TTL expire it.
          logger.error(`processOneMessage: confirmConsumed failed: ${String(err)}`);
        }
      }
    }
  } catch (err) {
    // delivered stays false: the server's redelivery is the user's only second
    // chance, so this message must NOT be committed as handled.
    logger.error(`processOneMessage: agent or send failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    void sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  } finally {
    // --- Typing indicator (cancel) ---
    if (typingTimer) clearInterval(typingTimer);
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => {});
    }
  }
  return { delivered, durable, commitIds };
}
