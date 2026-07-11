import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatRequest, ChatResponse } from "weixin-agent-sdk";

import { extractPdfTextPreview, looksLikePdf } from "./pdf-text.js";

export type BoundFeishuIdentity = {
  userId?: string;
  userUnionId?: string;
  userName?: string;
};

export function hasFeishuId(value: string | undefined): boolean {
  return typeof value === "string" && value.includes("_") && value.length >= 8;
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const env: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

export function resolveWechatStateFile(fileName: string): string {
  const base =
    process.env.WEIXIN_AGENT_HOME ||
    process.env.CTI_HOME ||
    process.env.LOS_HOME ||
    path.join(os.homedir(), ".linearos", "agents", process.env.WEIXIN_AGENT_BOT_SLUG || "wechat");
  return path.join(base, "channels", "wechat", fileName);
}

export function resolveTouziyunCreateScript(): string {
  const repo =
    process.env.WEIXIN_AGENT_LINEAROS_REPO ||
    process.env.LOS_REPO_DIR ||
    path.join(os.homedir(), "multi-agent-in-feishu");
  return path.join(repo, "touziyun", "scripts", "touziyun-create.mjs");
}

export function resolveTouziyunBpScript(): string {
  return path.join(path.dirname(resolveTouziyunCreateScript()), "touziyun-bp.mjs");
}

export function resolveTouziyunAuthScript(): string {
  return path.join(path.dirname(resolveTouziyunCreateScript()), "touziyun-auth.mjs");
}

export function resolveTouziyunOptionsScript(): string {
  return path.join(path.dirname(resolveTouziyunCreateScript()), "touziyun-options.mjs");
}

function boundIdentityPath(): string {
  const base =
    process.env.WEIXIN_AGENT_HOME ||
    process.env.CTI_HOME ||
    process.env.LOS_HOME ||
    "";
  return base ? path.join(base, "channels", "wechat", "bound-feishu-identity.json") : "";
}

function stateRegistryPath(): string {
  return path.join(os.homedir(), ".linearos", "shared", "state-registry.json");
}

async function resolveAppId(): Promise<string> {
  const home = process.env.WEIXIN_AGENT_HOME || process.env.CTI_HOME || process.env.LOS_HOME || "";
  const config = home ? await readEnvFile(path.join(home, "config.env")) : {};
  return process.env.CTI_FEISHU_APP_ID || config.CTI_FEISHU_APP_ID || "";
}

export async function resolveFeishuIdentity(): Promise<BoundFeishuIdentity> {
  const filePath = boundIdentityPath();
  const fromFile = filePath ? await readJsonFile<BoundFeishuIdentity>(filePath, {}) : {};
  const resolved = {
    userId: process.env.WEIXIN_AGENT_FEISHU_OPEN_ID || fromFile.userId || "",
    userUnionId: process.env.WEIXIN_AGENT_FEISHU_UNION_ID || fromFile.userUnionId || "",
    userName: process.env.WEIXIN_AGENT_FEISHU_NAME || fromFile.userName || "",
  };
  if (hasFeishuId(resolved.userId)) return resolved;
  const authed = await resolveAuthedFeishuUserFromLarkCli();
  return {
    userId: authed.userId || resolved.userId,
    userUnionId: resolved.userUnionId,
    userName: authed.userName || resolved.userName,
  };
}

async function resolveAuthedFeishuUserFromLarkCli(): Promise<BoundFeishuIdentity> {
  const home = process.env.WEIXIN_AGENT_HOME || process.env.CTI_HOME || process.env.LOS_HOME || "";
  if (!home) return {};
  const config = await readEnvFile(path.join(home, "config.env"));
  const appId = process.env.CTI_FEISHU_APP_ID || config.CTI_FEISHU_APP_ID || "";
  if (!appId) return {};
  return await new Promise((resolve) => {
    execFile("lark-cli", ["auth", "status", "--verify", "--profile", appId], {
      encoding: "utf-8",
      timeout: 20_000,
      maxBuffer: 512 * 1024,
    }, (_err, stdout) => {
      const raw = String(stdout || "");
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end < start) {
        resolve({});
        return;
      }
      try {
        const data = JSON.parse(raw.slice(start, end + 1)) as {
          identities?: { user?: Record<string, unknown> };
        };
        const user = data.identities?.user;
        const openId = String(user?.openId || "").trim();
        const name = String(user?.userName || "").trim();
        const tokenStatus = String(user?.tokenStatus || "");
        const refreshExpRaw = user?.refreshExpiresAt ? String(user.refreshExpiresAt) : "";
        const refreshAlive = refreshExpRaw ? Date.parse(refreshExpRaw) > Date.now() : false;
        const tokenValid = user?.status === "ready" && user?.available === true
          && (tokenStatus === "valid" || (tokenStatus === "needs_refresh" && refreshAlive));
        resolve(hasFeishuId(openId) && tokenValid ? { userId: openId, userName: name || "已授权用户" } : {});
      } catch {
        resolve({});
      }
    });
  });
}

function tzyUserKey(identity: BoundFeishuIdentity): string {
  if (process.env.TZY_PERUSER !== "1") return "default";
  const unionId = identity.userUnionId || "";
  const openId = identity.userId || "";
  if (process.env.CTI_TZY_UNION === "1") {
    if (hasFeishuId(unionId)) return unionId;
    if (hasFeishuId(openId)) return openId;
    return "";
  }
  return hasFeishuId(openId) ? openId : "";
}

async function touziyunUserKeyFromRegistry(identity: BoundFeishuIdentity): Promise<string> {
  if (!identity.userName) return "";
  const botId = await resolveAppId();
  if (!botId) return "";
  const registry = await readJsonFile<Record<string, Record<string, unknown>>>(stateRegistryPath(), {});
  const rows = Object.values(registry).filter((row) =>
    row.service === "touziyun" &&
    row.status === "valid" &&
    row.botId === botId &&
    row.userName === identity.userName &&
    (row.action === "write" || row.action === "create_write" || row.action === "read" || row.action === "bind")
  );
  const preferred = rows.find((row) => row.action === "write" || row.action === "create_write")
    || rows.find((row) => row.action === "bind")
    || rows[0];
  const userId = String(preferred?.userId || "");
  return hasFeishuId(userId) ? userId : "";
}

export async function resolveTouziyunUserKey(identity: BoundFeishuIdentity): Promise<string> {
  if (process.env.TZY_PERUSER !== "1") return "default";
  const unionId = identity.userUnionId || "";
  if (process.env.CTI_TZY_UNION === "1") {
    if (hasFeishuId(unionId)) return unionId;
    const fromRegistry = await touziyunUserKeyFromRegistry(identity);
    if (fromRegistry) return fromRegistry;
  }
  return tzyUserKey(identity);
}

/** Spawn a touziyun script with node (bypassing PATH's model-write guard wrapper,
 * same as the Feishu confirmed-card write path) and parse its JSON stdout. */
export function runTouziyunScriptJson(
  scriptArgs: string[],
  opts: { timeoutMs: number; stdin?: string },
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, scriptArgs, {
      encoding: "utf-8",
      timeout: opts.timeoutMs,
      maxBuffer: 512 * 1024,
    }, (err, stdout) => {
      const raw = String(stdout || (err as { stdout?: string } | null)?.stdout || "").trim();
      const lastLine = raw.split("\n").filter(Boolean).pop() || "";
      for (const candidate of [raw, lastLine]) {
        if (!candidate) continue;
        try {
          resolve(JSON.parse(candidate) as Record<string, unknown>);
          return;
        } catch {
          // try next candidate
        }
      }
      resolve({ ok: false, reason: err ? String(err.message || err).slice(0, 200) : "bad-output" });
    });
    if (opts.stdin !== undefined) {
      try {
        child.stdin?.write(opts.stdin);
        child.stdin?.end();
      } catch {
        resolve({ ok: false, reason: "stdin-write-failed" });
      }
    }
  });
}

export async function runTouziyunAuth(args: string[], timeoutMs = 90_000): Promise<Record<string, unknown>> {
  return runTouziyunScriptJson([resolveTouziyunAuthScript(), ...args], { timeoutMs });
}

/** Start the touziyun QR bind flow and render it as a WeChat text+image response.
 * `resumeHint` tells the user what happens after they reply 已扫码. */
export async function startTouziyunTextAuth(resumeHint: string): Promise<ChatResponse> {
  const identity = await resolveFeishuIdentity();
  const userKey = await resolveTouziyunUserKey(identity);
  if (!userKey || !identity.userName) {
    return {
      text: [
        "投资云写入需要先确认你的飞书身份，目前微信侧没有拿到完整身份，所以没有生成授权二维码。",
        "请先在飞书私聊这个 bot 发送 `/wechat` 重新绑定微信，或发送 `/touziyun` 完成投资云绑定。",
      ].join("\n"),
    };
  }

  const result = await runTouziyunAuth(["authorize-start", "--user", userKey], 90_000);
  if (result.ok && result.qrPath) {
    return {
      text: [
        "投资云还没授权，先完成一次绑定。",
        `请用飞书扫描下面二维码登录投资云；扫完后回微信回复 \`已扫码\`，${resumeHint}`,
      ].join("\n"),
      media: { type: "image", url: String(result.qrPath) },
    };
  }

  const reason = String(result.reason || "authorize-start-failed");
  if (reason === "another-auth-in-progress") {
    return { text: "现在有另一个投资云授权流程正在进行。请稍等一分钟后再试。" };
  }
  return { text: `投资云授权二维码生成失败，未写库。原因：${reason}` };
}

export async function pollTouziyunTextAuth(): Promise<{ ok: boolean; response?: ChatResponse }> {
  const identity = await resolveFeishuIdentity();
  const userKey = await resolveTouziyunUserKey(identity);
  if (!userKey) {
    return {
      ok: false,
      response: {
        text: "微信侧没有拿到完整飞书身份，不能保存投资云授权。请先在飞书私聊这个 bot 发送 `/wechat` 重新绑定微信。",
      },
    };
  }
  const expectName = identity.userName || "";
  const args = ["authorize-poll", "--user", userKey];
  if (expectName) args.push("--expect-name", expectName);
  const result = await runTouziyunAuth(args, 30_000);
  if (result.ok) {
    return { ok: true };
  }
  const reason = String(result.reason || "pending");
  if (reason === "pending") {
    return {
      ok: false,
      response: { text: "还没检测到投资云扫码完成。扫完后再回复 `已扫码`。" },
    };
  }
  if (reason === "identity-mismatch") {
    return {
      ok: false,
      response: {
        text: `授权身份不一致，未写库。飞书身份是 ${expectName || "未知"}，投资云扫码身份是 ${String(result.capturedName || "另一个账号")}。请切换到自己的投资云账号后重新授权。`,
      },
    };
  }
  if (reason === "no-expect-name") {
    return {
      ok: false,
      response: { text: "无法确认你的飞书姓名，已拒绝保存投资云授权。请在飞书里重新 `/wechat` 绑定后再试。" },
    };
  }
  return {
    ok: false,
    response: { text: `投资云授权检查失败，未写库。原因：${reason}` },
  };
}

/** Canonical 会议纪要(AI) entry format, matching what touziyun-bp.mjs follow writes
 * (`YYYY-MM-DD：<链接>`, full-width colon). A non-empty entry without a leading date
 * gets `fallbackDate` prefixed; a half-width/space separator after an existing date
 * is unified to the full-width colon. */
export function normalizeMemoEntry(value: string, fallbackDate?: string): string {
  const clean = String(value || "").trim();
  if (!clean) return "";
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(clean)) return clean;
  const dated = clean.match(/^(\d{4}-\d{1,2}-\d{1,2})\s*[：:]?\s*(\S[\s\S]*)$/);
  if (dated) return `${dated[1]}：${dated[2].trim()}`;
  const date = fallbackDate && /^\d{4}-\d{1,2}-\d{1,2}$/.test(fallbackDate)
    ? fallbackDate
    : new Date().toISOString().slice(0, 10);
  return `${date}：${clean}`;
}

export async function buildAttachmentMaterial(request: ChatRequest): Promise<string> {
  const media = request.media;
  if (!media) return "";

  let sizeLine = "size_bytes: unknown";
  try {
    const stat = await fs.stat(media.filePath);
    sizeLine = `size_bytes: ${stat.size}`;
  } catch {
    // Keep the material prompt useful even if the temp file has already moved.
  }

  const name = media.fileName?.trim() || path.basename(media.filePath);
  const lines = [
    "[Attachment material]",
    `type: ${media.type}`,
    `name: ${name}`,
    `mime: ${media.mimeType || "unknown"}`,
    `local_path: ${media.filePath}`,
    sizeLine,
  ];

  if (media.type === "file" && looksLikePdf(media.filePath, media.mimeType)) {
    const text = await extractPdfTextPreview(media.filePath);
    lines.push(
      "",
      `[Extracted PDF text chars=${text.length}]`,
      text || "(PDF text extraction returned empty. Leave unavailable fields empty; do not invent them.)",
    );
  }

  return lines.join("\n");
}
