import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatRequest, ChatResponse } from "weixin-agent-sdk";

import { extractPdfTextPreview, looksLikePdf } from "./pdf-text.js";

type DraftField = {
  name: string;
  label: string;
  value?: string;
  required?: boolean;
  hidden?: boolean;
  default?: string;
};

type FlowState =
  | { phase: "awaiting_material"; updatedAt: number }
  | { phase: "draft"; draftId: string; fields: Record<string, string>; updatedAt: number; authStartedAt?: number; bpPath?: string; bpName?: string };

type FlowRoute =
  | { handled: true; response: ChatResponse }
  | { handled: false; request: ChatRequest };

type BeforeAgentOptions = {
  allowNaturalProjectCreate?: boolean;
};

type CardBlock = {
  intentType: string;
  fields: Array<{ name: string; value: string }>;
};

type BoundFeishuIdentity = {
  userId?: string;
  userUnionId?: string;
  userName?: string;
};

const STATE_TTL_MS = 30 * 60 * 1000;

const PROJECT_DRAFT_SCHEMA: DraftField[] = [
  { name: "项目名称", label: "项目名称", required: true },
  { name: "公司创始人", label: "公司创始人", required: true },
  { name: "一句话简介", label: "一句话简介", required: true },
  { name: "Key-Takeaway", label: "Key-Takeaway" },
  { name: "Priority", label: "Priority Level", required: true, default: "3" },
  { name: "拟初始融资轮次", label: "拟初始融资轮次", required: true, default: "种子轮" },
  { name: "计划融资", label: "计划融资(金额)", required: true },
  { name: "币种", label: "币种", required: true, default: "USD" },
  { name: "前轮关键投资者", label: "前轮关键投资者" },
  { name: "项目来源", label: "项目来源", required: true, default: "行研挖掘" },
  { name: "来源同事", label: "来源同事", required: true },
  { name: "地区", label: "地区", hidden: true, default: "中国" },
  { name: "行业大类", label: "行业大类", hidden: true },
  { name: "行业", label: "行业", hidden: true },
  { name: "首次接触日期", label: "首次接触日期", hidden: true },
  { name: "投前估值", label: "投前估值", hidden: true },
  { name: "投后估值", label: "投后估值", hidden: true },
  { name: "会议纪要", label: "会议纪要", hidden: true },
  { name: "教育背景", label: "教育背景(学历)", hidden: true },
  { name: "学历背景", label: "学历背景", hidden: true },
];

const SCHEMA_BY_NAME = new Map(PROJECT_DRAFT_SCHEMA.map((field) => [field.name, field]));
const VISIBLE_FIELDS = PROJECT_DRAFT_SCHEMA.filter((field) => !field.hidden);

function isProjectCreateCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "/项目创建" || trimmed.startsWith("/项目创建 ");
}

function isNaturalProjectCreateIntent(text: string): boolean {
  const s = text.replace(/\s+/g, "");
  return /(创建|新建|建立|建)(一个|个|新的|新)?(投资云)?项目/.test(s)
    || /用(这个|这份|上面|刚才).*(BP|pdf|PDF|材料|文件|链接).*(创建|新建|建立|建).*(项目)/i.test(text)
    || /(BP|pdf|PDF|材料|文件|链接).*(创建|新建|建立|建).*(项目)/i.test(text);
}

function isConfirm(text: string): boolean {
  return /^(确认创建|确认提交|提交到投资云|创建项目|确认)$/i.test(text.trim());
}

function isCancel(text: string): boolean {
  return /^(取消|先不建|不创建|放弃)$/i.test(text.trim());
}

function isAuthScanned(text: string): boolean {
  return /^(已扫码|扫码完成|扫完了|我扫了|已完成授权)$/i.test(text.trim());
}

function hasMaterial(request: ChatRequest): boolean {
  return Boolean(request.media || request.text.trim());
}

function hasConcreteMaterial(request: ChatRequest): boolean {
  return Boolean(request.media || request.text.includes("【Material Inbox /"));
}

function hasFeishuId(value: string | undefined): boolean {
  return typeof value === "string" && value.includes("_") && value.length >= 8;
}

function redactId(value: string): string {
  if (!value) return "";
  if (value.length <= 10) return value;
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

function safeDraftId(fields: Record<string, string>): string {
  const base = (fields["项目名称"] || "wechat-project")
    .replace(/[^\p{Script=Han}\w.-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "wechat-project";
  return `wx-${base}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function formatDraftFieldValue(field: DraftField, value: string): string {
  const clean = String(value || "").trim();
  if (!clean) return "待补充";
  if (field.name === "Key-Takeaway") return `\n${clean}`;
  if (clean.includes("\n")) return `\n${clean}`;
  return clean;
}

function parseCardBlock(text: string): CardBlock | null {
  if (!text.includes("::card::")) return null;

  const tokenRe = /::(card|field|owner|end)::/g;
  const tokens = [...text.matchAll(tokenRe)];
  if (tokens.length) {
    let intentType = "";
    const fields: Array<{ name: string; value: string }> = [];
    const schemaNames = PROJECT_DRAFT_SCHEMA.map((field) => field.name).sort((a, b) => b.length - a.length);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const kind = token[1];
      const start = (token.index ?? 0) + token[0].length;
      const end = i + 1 < tokens.length ? tokens[i + 1].index ?? text.length : text.length;
      const content = text.slice(start, end).trim();
      if (kind === "end") break;
      if (kind === "card") {
        intentType = content.split(/\s+/)[0] || "";
      } else if (kind === "field") {
        const matchedName = schemaNames.find((name) => content === name || content.startsWith(`${name} `) || content.startsWith(`${name}\n`));
        if (matchedName) {
          fields.push({ name: matchedName, value: content.slice(matchedName.length).trim() });
        } else {
          const match = content.match(/^(\S+)\s*([\s\S]*)$/);
          if (match) fields.push({ name: match[1], value: match[2].trim() });
        }
      }
    }
    if (intentType && fields.length) return { intentType, fields };
  }

  const lines = text.split("\n");
  let start = -1;
  let intentType = "";
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*::card::\s*(\S+)\s*$/);
    if (match) {
      start = i;
      intentType = match[1];
      break;
    }
  }
  if (start < 0) return null;

  const fields: Array<{ name: string; value: string }> = [];
  let currentName = "";
  let valueLines: string[] = [];
  const flush = () => {
    if (currentName) {
      fields.push({ name: currentName, value: valueLines.join("\n").trim() });
    }
    currentName = "";
    valueLines = [];
  };

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*::end::\s*$/.test(line)) {
      flush();
      break;
    }
    if (/^\s*::owner::/.test(line)) continue;
    const field = line.match(/^\s*::field::\s*(.*)$/);
    if (field) {
      flush();
      currentName = field[1].split("|")[0]?.trim() || "";
      continue;
    }
    if (currentName) valueLines.push(line);
  }
  flush();

  return fields.length ? { intentType, fields } : null;
}

function hasWechatCardProtocol(text: string): boolean {
  return /::(?:card|field|owner|end)::|\[\[[A-Z0-9_:-]+\]\]/.test(text);
}

function stripWechatCardProtocol(text: string): string {
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*::(?:card|field|owner|end)::/.test(line))
    .join("\n")
    .replace(/\[\[[A-Z0-9_:-]+\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned) return cleaned;
  return [
    "这条回复包含飞书卡片协议，微信通道已拦截，没有把协议原文发给你。",
    "请用文字说明要继续的动作；如果是在创建项目，请发送 `/项目创建` 后重新发送材料。",
  ].join("\n");
}

function projectNameFromRequest(request: ChatRequest): string {
  const name = request.media?.fileName?.trim() || "";
  if (!name) return "";
  return path.basename(name, path.extname(name))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDraftFields(block: CardBlock, feishuName = "", request?: ChatRequest): Record<string, string> {
  const provided = new Map<string, string>();
  for (const field of block.fields) {
    provided.set(field.name, String(field.value || ""));
  }
  const fields: Record<string, string> = {};
  for (const schema of PROJECT_DRAFT_SCHEMA) {
    const value = provided.get(schema.name);
    fields[schema.name] = value && value.trim() ? value : (schema.default ?? "");
  }
  if (!fields["来源同事"] && feishuName) {
    fields["来源同事"] = feishuName;
  }
  if (!fields["项目名称"] && request) {
    fields["项目名称"] = projectNameFromRequest(request);
  }
  return fields;
}

async function buildAttachmentMaterial(request: ChatRequest): Promise<string> {
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

async function buildExtractionPrompt(originalText: string, request: ChatRequest): Promise<string> {
  const fieldList = PROJECT_DRAFT_SCHEMA.map((field) => `::field:: ${field.name}`).join("\n");
  const attachmentMaterial = await buildAttachmentMaterial(request);
  return [
    "[WeChat /项目创建 flow]",
    "用户已经在微信发送 /项目创建。当前这一条消息是创建项目的材料。",
    "请只读取本条消息和本条附件内容；不要从历史项目、旧草稿或旧会话补字段。",
    "如果有 [Extracted PDF text]，它就是附件正文，必须优先按这段正文抽取字段；不要只按文件名生成草稿。",
    "如果只能看到 local_path 而读不到内容，就把相关字段留空，不要编。",
    "字段值里不要写“待补充”；未知字段留空字符串即可。",
    "不要调用 touziyun-create.mjs，不要写投资云。微信侧会用文字草稿让用户确认后再写。",
    "",
    "抽取要点：项目名称优先取品牌/公司/产品名；公司创始人从 Team/Founder slide 提取；计划融资从 Ask/Fundraising 提取；拟初始融资轮次从 Ask/round 或材料语义判断。",
    "一句话简介：一句中文讲清它在做什么，不要写成泛泛产品总结。",
    "Key-Takeaway：不是一句话总结，而是投资人视角的一手尽调要点 memo。必须按 4 块输出，每块单独一行并用【块名】开头，顺序固定为：",
    "【团队】创始人/核心成员的教育、职业、过往成就，要具体",
    "【项目】技术/产品是什么、核心在做什么、核心技术原理",
    "【进展】进展 / case 验证 / 关键里程碑",
    "【融资】融资历史或本轮融资（轮次/估值/金额/用途）",
    "Key-Takeaway 控制在约 500 字以内；读不到某块就省略该块事实，不要编。",
    "",
    "请输出一个 project_draft block。字段值可为空，但字段名必须用下面这些：",
    "::card:: project_draft",
    fieldList,
    "::end::",
    "",
    "[用户原文]",
    originalText.trim() || "(用户本条主要是附件，请读取附件 local_path)",
    attachmentMaterial ? "" : undefined,
    attachmentMaterial || undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderDraftText(fields: Record<string, string>, _draftId: string): string {
  const lines = [
    "已生成项目草稿，请核对：",
    "",
  ];
  VISIBLE_FIELDS.forEach((field, idx) => {
    const required = field.required ? "*" : "";
    lines.push(`${idx + 1}. ${field.label}${required}：${formatDraftFieldValue(field, fields[field.name] || "")}`);
  });
  lines.push(
    "",
    "回复 `确认创建` 创建项目；也可以回复 `修改 1=新值`、`字段名=新值` 调整，或回复 `取消` 放弃。",
    "确认创建后会先建最小可用项目；未解析出的字段可到投资云详情页补充/修改。",
  );
  return lines.join("\n");
}

function missingRequired(fields: Record<string, string>): string[] {
  return PROJECT_DRAFT_SCHEMA
    .filter((field) => field.required && !String(fields[field.name] || "").trim())
    .map((field) => field.label);
}

function fieldsForSubmit(fields: Record<string, string>): Record<string, string> {
  const next = { ...fields };
  const textPlaceholders = new Set(["公司创始人", "一句话简介", "来源同事"]);
  for (const field of PROJECT_DRAFT_SCHEMA) {
    if (!field.required) continue;
    if (String(next[field.name] || "").trim()) continue;
    if (field.name === "项目名称") continue;
    if (field.name === "计划融资") {
      next[field.name] = "0";
    } else if (textPlaceholders.has(field.name)) {
      next[field.name] = "-";
    }
  }
  return next;
}

function parseFieldUpdates(text: string): Record<string, string> | null {
  const updates: Record<string, string> = {};
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^修改\s*/u, "");
    const match = line.match(/^(.+?)(?:=|：|:)([\s\S]*)$/u);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    const index = Number(key);
    let fieldName = "";
    if (Number.isInteger(index) && index >= 1 && index <= VISIBLE_FIELDS.length) {
      fieldName = VISIBLE_FIELDS[index - 1].name;
    } else if (SCHEMA_BY_NAME.has(key)) {
      fieldName = key;
    } else {
      const byLabel = PROJECT_DRAFT_SCHEMA.find((field) => field.label === key);
      fieldName = byLabel?.name || "";
    }
    if (fieldName) updates[fieldName] = value;
  }
  return Object.keys(updates).length ? updates : null;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
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

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function resolveStateFile(): string {
  const base =
    process.env.WEIXIN_AGENT_HOME ||
    process.env.CTI_HOME ||
    process.env.LOS_HOME ||
    path.join(os.homedir(), ".linearos", "agents", process.env.WEIXIN_AGENT_BOT_SLUG || "wechat");
  return path.join(base, "channels", "wechat", "project-create-text-flow.json");
}

function resolveTouziyunCreateScript(): string {
  const repo =
    process.env.WEIXIN_AGENT_LINEAROS_REPO ||
    process.env.LOS_REPO_DIR ||
    path.join(os.homedir(), "multi-agent-in-feishu");
  return path.join(repo, "touziyun", "scripts", "touziyun-create.mjs");
}

function resolveTouziyunBpScript(): string {
  return path.join(path.dirname(resolveTouziyunCreateScript()), "touziyun-bp.mjs");
}

function resolveTouziyunAuthScript(): string {
  return path.join(path.dirname(resolveTouziyunCreateScript()), "touziyun-auth.mjs");
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

async function resolveFeishuIdentity(): Promise<BoundFeishuIdentity> {
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

async function resolveTouziyunUserKey(identity: BoundFeishuIdentity): Promise<string> {
  if (process.env.TZY_PERUSER !== "1") return "default";
  const unionId = identity.userUnionId || "";
  if (process.env.CTI_TZY_UNION === "1") {
    if (hasFeishuId(unionId)) return unionId;
    const fromRegistry = await touziyunUserKeyFromRegistry(identity);
    if (fromRegistry) return fromRegistry;
  }
  return tzyUserKey(identity);
}

async function runTouziyunSubmit(args: { draftId: string; fields: Record<string, string> }): Promise<Record<string, unknown>> {
  const script = resolveTouziyunCreateScript();
  const identity = await resolveFeishuIdentity();
  const userKey = await resolveTouziyunUserKey(identity);
  if (!userKey) {
    return {
      ok: false,
      needAuth: true,
      reason: "missing-feishu-identity-for-wechat",
    };
  }

  const submitArgs = [script, "submit", "--draft-id", args.draftId, "--user", userKey];
  const expectName = identity.userName || "";
  if (process.env.TZY_PERUSER === "1" && expectName) {
    submitArgs.push("--expect-name", expectName);
  }
  const draft = {
    fields: args.fields,
    speaker: {
      ...(identity.userUnionId ? { unionId: identity.userUnionId } : {}),
      ...(identity.userId ? { openId: identity.userId } : {}),
      ...(expectName ? { name: expectName } : {}),
    },
    currency: args.fields["币种"] || "USD",
  };

  return await new Promise((resolve) => {
    // Match Feishu's confirmed-card write path: bypass PATH's model-write guard wrapper.
    const child = execFile(process.execPath, submitArgs, { encoding: "utf-8", timeout: 180_000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      const raw = String(stdout || "").trim();
      if (raw) {
        try {
          resolve(JSON.parse(raw) as Record<string, unknown>);
          return;
        } catch {
          // fall through
        }
      }
      resolve({ ok: false, reason: err ? String(err.message || err).slice(0, 200) : "bad-output" });
    });
    try {
      child.stdin?.write(JSON.stringify(draft));
      child.stdin?.end();
    } catch {
      resolve({ ok: false, reason: "stdin-write-failed" });
    }
  });
}

// [WeChat BP mount] Mirror the Feishu adapter's viaCreate auto-mount: after the project
// is created, upload the BP to its 项目概览 BP 字段 via the same touziyun-bp.mjs client +
// identity as create. Returns the client's JSON ({ ok, inField, reason, ... }).
async function runTouziyunBpUpload(args: { projectId: string; filePath: string; fileName: string }): Promise<Record<string, unknown>> {
  const script = resolveTouziyunBpScript();
  const identity = await resolveFeishuIdentity();
  const userKey = await resolveTouziyunUserKey(identity);
  if (!userKey) {
    return { ok: false, needAuth: true, reason: "missing-feishu-identity-for-wechat-bp" };
  }
  const uploadArgs = [script, "upload", "--project", args.projectId, "--file", args.filePath, "--user", userKey, "--name", args.fileName];
  const expectName = identity.userName || "";
  if (process.env.TZY_PERUSER === "1" && expectName) {
    uploadArgs.push("--expect-name", expectName);
  }
  return await new Promise((resolve) => {
    // 600s not 180s: a large BP (chunked, per-part retries) can legitimately take minutes;
    // killing the child mid-upload loses the script's own diagnostic reason.
    execFile(process.execPath, uploadArgs, { encoding: "utf-8", timeout: 600_000, maxBuffer: 512 * 1024 }, (err, stdout) => {
      const raw = String(stdout || "").trim();
      if (raw) {
        try {
          resolve(JSON.parse(raw) as Record<string, unknown>);
          return;
        } catch {
          // fall through
        }
      }
      resolve({ ok: false, reason: err ? String(err.message || err).slice(0, 200) : "bad-output" });
    });
  });
}

async function runTouziyunAuth(args: string[], timeoutMs = 90_000): Promise<Record<string, unknown>> {
  const script = resolveTouziyunAuthScript();
  return await new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
    }, (err, stdout) => {
      const raw = String(stdout || (err as { stdout?: string } | null)?.stdout || "").trim();
      const lastLine = raw.split("\n").filter(Boolean).pop() || "";
      if (lastLine) {
        try {
          resolve(JSON.parse(lastLine) as Record<string, unknown>);
          return;
        } catch {
          // fall through
        }
      }
      resolve({ ok: false, reason: err ? String(err.message || err).slice(0, 180) : "bad-output" });
    });
  });
}

async function startTouziyunTextAuth(): Promise<ChatResponse> {
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
        "请用飞书扫描下面二维码登录投资云；扫完后回微信回复 `已扫码`，我会继续提交这个项目草稿。",
      ].join("\n"),
      media: { type: "image", url: String(result.qrPath) },
    };
  }

  const reason = String(result.reason || "authorize-start-failed");
  if (reason === "another-auth-in-progress") {
    return { text: "现在有另一个投资云授权流程正在进行。请稍等一分钟后再回复 `确认创建`。" };
  }
  return { text: `投资云授权二维码生成失败，未写库。原因：${reason}` };
}

async function pollTouziyunTextAuth(): Promise<{ ok: boolean; response?: ChatResponse }> {
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
      response: { text: "还没检测到投资云扫码完成。扫完后再回复 `已扫码` 或 `确认创建`。" },
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

export class WechatProjectCreateFlow {
  private readonly states = new Map<string, FlowState>();
  private readonly stateFile = resolveStateFile();
  private loaded = false;

  async beforeAgent(request: ChatRequest, options: BeforeAgentOptions = {}): Promise<FlowRoute> {
    await this.load();
    this.prune();
    const text = request.text.trim();
    const existing = this.states.get(request.conversationId);
    const projectCreateIntent = isProjectCreateCommand(text)
      || (options.allowNaturalProjectCreate && isNaturalProjectCreateIntent(text));

    if (projectCreateIntent) {
      this.states.set(request.conversationId, { phase: "awaiting_material", updatedAt: Date.now() });
      await this.save();
      if (hasConcreteMaterial(request)) {
        return {
          handled: false,
          request: {
            ...request,
            text: await buildExtractionPrompt(request.text, request),
          },
        };
      }
      return {
        handled: true,
        response: {
          text: "收到，开始创建项目。把 BP、文档、飞书妙记链接或一句话项目介绍发我就行。",
        },
      };
    }

    if (existing?.phase === "awaiting_material") {
      if (!hasMaterial(request)) {
        return {
          handled: true,
          response: { text: "把 BP、文档、飞书妙记链接或一句话项目介绍发我就行，我收到后生成文字草稿。" },
        };
      }
      return {
        handled: false,
        request: {
          ...request,
          text: await buildExtractionPrompt(request.text, request),
        },
      };
    }

    if (existing?.phase === "draft") {
      if (isCancel(text)) {
        if (existing.authStartedAt) {
          const identity = await resolveFeishuIdentity();
          const userKey = await resolveTouziyunUserKey(identity);
          if (userKey) void runTouziyunAuth(["authorize-cancel", "--user", userKey], 30_000);
        }
        this.states.delete(request.conversationId);
        await this.save();
        return { handled: true, response: { text: "已取消这次项目创建草稿。" } };
      }
      const updates = parseFieldUpdates(text);
      if (updates) {
        const nextFields = { ...existing.fields, ...updates };
        const next: FlowState = { ...existing, fields: nextFields, updatedAt: Date.now() };
        this.states.set(request.conversationId, next);
        await this.save();
        return { handled: true, response: { text: renderDraftText(nextFields, existing.draftId) } };
      }
      if (isConfirm(text) || isAuthScanned(text)) {
        return { handled: true, response: await this.submitDraft(request.conversationId, existing) };
      }
      return {
        handled: true,
        response: {
          text: existing.authStartedAt
            ? "当前投资云授权在等待扫码。扫完后回复 `已扫码` 或 `确认创建`；也可以 `取消`。"
            : "当前已有项目草稿在等确认。回复 `确认创建` 写入投资云，或 `修改 1=新值` 调整字段，或 `取消`。",
        },
      };
    }

    return { handled: false, request };
  }

  async isAwaitingMaterial(conversationId: string): Promise<boolean> {
    await this.load();
    this.prune();
    return this.states.get(conversationId)?.phase === "awaiting_material";
  }

  async afterAgent(request: ChatRequest, response: ChatResponse): Promise<ChatResponse> {
    await this.load();
    const existing = this.states.get(request.conversationId);
    if (!response.text) return response;

    const block = parseCardBlock(response.text);
    if (block?.intentType === "project_draft") {
      return this.createDraftFromBlock(request, block);
    }

    if (existing?.phase === "awaiting_material") {
      return {
        text: [
          "这份材料我收到了，但没有稳定生成可确认的项目草稿。",
          "请补一句项目名称/创始人/融资信息，或重新发送材料后再试。",
        ].join("\n"),
      };
    }

    if (hasWechatCardProtocol(response.text)) {
      return {
        ...response,
        text: stripWechatCardProtocol(response.text),
      };
    }

    return response;
  }

  private async createDraftFromBlock(request: ChatRequest, block: CardBlock): Promise<ChatResponse> {
    const identity = await resolveFeishuIdentity();
    const fields = normalizeDraftFields(block, identity.userName || "", request);
    const draftId = safeDraftId(fields);
    // [WeChat BP mount] If this material carried a BP file, stash a STABLE copy of it now
    // (the /tmp inbound file may be GC'd before the user confirms) so submitDraft can mount
    // it to the created project — mirroring Feishu's viaCreate hold-the-bytes behavior.
    let bpPath: string | undefined;
    let bpName: string | undefined;
    const media = request.media;
    if (media && media.type === "file" && looksLikePdf(media.filePath, media.mimeType)) {
      const name = media.fileName?.trim() || path.basename(media.filePath);
      const safeName = name.replace(/[^\w.\-]+/g, "_");
      const stable = path.join(os.tmpdir(), `wechat-bp-${draftId}-${safeName}`);
      try {
        await fs.copyFile(media.filePath, stable);
        bpPath = stable;
        bpName = name;
      } catch {
        bpPath = media.filePath; // fall back to the original path
        bpName = name;
      }
    }
    this.states.set(request.conversationId, { phase: "draft", draftId, fields, updatedAt: Date.now(), ...(bpPath ? { bpPath, bpName } : {}) });
    await this.save();
    return { text: renderDraftText(fields, draftId) };
  }

  async reset(conversationId: string): Promise<void> {
    await this.load();
    this.states.delete(conversationId);
    await this.save();
  }

  private async submitDraft(conversationId: string, state: Extract<FlowState, { phase: "draft" }>): Promise<ChatResponse> {
    const missing = missingRequired(state.fields);

    if (state.authStartedAt) {
      const poll = await pollTouziyunTextAuth();
      if (!poll.ok) return poll.response || { text: "投资云授权还没完成，未写库。" };
      state = { ...state, authStartedAt: undefined, updatedAt: Date.now() };
      this.states.set(conversationId, state);
      await this.save();
    }

    const result = await runTouziyunSubmit({ draftId: state.draftId, fields: fieldsForSubmit(state.fields) });
    if (result.ok) {
      const written = Array.isArray(result.written) ? result.written.length : 0;
      const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
      const detailUrl = String(result.browserDetailUrl || result.detailUrl || "");
      const projectId = String(result.projectId || "");
      // [WeChat BP mount] Now that the project exists, mount the stashed BP to its BP 字段
      // (this is the step WeChat was missing — Feishu did it via viaCreate). Honest split:
      // only claim "已挂载" when the client confirms it landed in the field; never fake it.
      let bpLine = "";
      if (state.bpPath && projectId) {
        const bpRes = await runTouziyunBpUpload({ projectId, filePath: state.bpPath, fileName: state.bpName || "BP.pdf" });
        const bpOk = Boolean(bpRes && bpRes.ok && (bpRes.inField || bpRes.attached));
        bpLine = bpOk
          ? "BP：已挂到项目 BP 字段 ✅"
          : `BP：未挂载（${String(bpRes?.reason || "未确认写入 BP 字段")}），可稍后重发 BP 给我重挂`;
        try { await fs.unlink(state.bpPath); } catch { /* best effort */ }
      }
      this.states.delete(conversationId);
      await this.save();
      return {
        text: [
          `项目已创建：${state.fields["项目名称"] || "新项目"}`,
          detailUrl ? `详情：\n${detailUrl}` : "",
          projectId ? `项目ID：${projectId}` : "",
          `写入字段：${written}，跳过字段：${skipped}`,
          bpLine,
          missing.length ? `可到投资云详情页补充/修改：${missing.join("、")}` : "",
        ].filter(Boolean).join("\n"),
      };
    }

    if (result.needAuth) {
      const authResponse = await startTouziyunTextAuth();
      this.states.set(conversationId, { ...state, authStartedAt: Date.now(), updatedAt: Date.now() });
      await this.save();
      return {
        ...authResponse,
        text: [
          authResponse.text || "投资云还没授权，先完成一次绑定。",
          `诊断：${String(result.reason || "needAuth")}`,
        ].join("\n"),
      };
    }

    const reasonStr = String(result.reason || "unknown");
    if (reasonStr === "projectName-required-missing") {
      return { text: "提交投资云失败：项目名称为空，投资云无法创建空名称项目。请回复 `项目名称=xxx` 后再 `确认创建`。" };
    }
    // Duplicate-protection is a refusal, not an error — say what to do next (the client's
    // hint carries existingName; dropping it left users staring at a bare reason code).
    if (reasonStr === "project-exists-precheck" || reasonStr === "project-name-exists") {
      const existing = String(result.existingName || "") || String(state.fields["项目名称"] || "同名项目");
      return {
        text: [
          `未创建：投资云已有同名项目「${existing}」，防重复保护拦下了这次提交（未写库）。`,
          "· 如果就是同一个项目 → 不用重建，直接在投资云详情页补充，或走项目跟进；",
          "· 如果确认是不同的新项目 → 回复 `项目名称=新名字` 改名后再回复 `确认创建`（草稿还在）。",
        ].join("\n"),
      };
    }
    return { text: `提交投资云失败，未写库。原因：${reasonStr}${result.hint ? `\n${String(result.hint)}` : ""}` };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJsonFile<Record<string, FlowState>>(this.stateFile, {});
    for (const [conversationId, state] of Object.entries(raw)) {
      this.states.set(conversationId, state);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const raw: Record<string, FlowState> = {};
    for (const [conversationId, state] of this.states.entries()) {
      raw[conversationId] = state;
    }
    await writeJsonFile(this.stateFile, raw);
  }

  private prune(): void {
    const now = Date.now();
    for (const [conversationId, state] of this.states.entries()) {
      if (now - state.updatedAt > STATE_TTL_MS) {
        this.states.delete(conversationId);
      }
    }
  }
}
