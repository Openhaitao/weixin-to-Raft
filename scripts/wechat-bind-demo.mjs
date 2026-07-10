#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const linearosRoot = path.join(os.homedir(), ".linearos", "agents");

function usage() {
  console.log(`wechat-bind-demo — LinearOS per-bot WeChat binding spike

Usage:
  node scripts/wechat-bind-demo.mjs status <bot-slug>
  node scripts/wechat-bind-demo.mjs login <bot-slug>
  node scripts/wechat-bind-demo.mjs logout <bot-slug>
  node scripts/wechat-bind-demo.mjs start <bot-slug> [-- <acp-command> ...]

Examples:
  node scripts/wechat-bind-demo.mjs status hel9000
  node scripts/wechat-bind-demo.mjs login hel9000
  node scripts/wechat-bind-demo.mjs start hel9000
  node scripts/wechat-bind-demo.mjs start hel9000 -- codex-acp
`);
}

function parseEnvFile(filePath) {
  const env = {};
  const raw = fs.readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  if (typeof raw.name === "string" && raw.name.trim()) out.CTI_BOT_NAME = raw.name.trim();
  if (typeof raw.intro === "string" && raw.intro.trim()) out.CTI_BOT_INTRO = raw.intro.trim();
  if (typeof raw.persona === "string" && raw.persona.trim()) out.CTI_BOT_PERSONA = raw.persona.trim();
  if (typeof raw.role === "string" && raw.role.trim()) out.CTI_BOT_ROLE = raw.role.trim();
  if (Array.isArray(raw.aliases)) {
    const aliases = raw.aliases.map((alias) => String(alias).trim()).filter(Boolean);
    if (aliases.length) out.CTI_BOT_ALIASES = aliases.join(",");
  }
  return out;
}

function resolveBot(slug) {
  if (!slug) throw new Error("missing bot slug");
  if (!/^[a-zA-Z0-9._-]+$/.test(slug)) {
    throw new Error(`unsafe bot slug: ${slug}`);
  }
  const agentHome = path.join(linearosRoot, slug);
  const configPath = path.join(agentHome, "config.env");
  if (!fs.existsSync(configPath)) {
    throw new Error(`bot config not found: ${configPath}`);
  }
  const profilePath = path.join(agentHome, "profile", "profile.json");
  const config = {
    ...parseEnvFile(configPath),
    ...normalizeProfile(readJsonSafe(profilePath, null)),
  };
  const wechatDir = path.join(agentHome, "channels", "wechat");
  const legacyWechatDir = path.join(agentHome, "wechat");
  const promptFile = path.join(wechatDir, "CLAUDE.md");
  return { slug, agentHome, configPath, profilePath, config, wechatDir, legacyWechatDir, promptFile };
}

function writePromptFile(bot) {
  fs.mkdirSync(bot.wechatDir, { recursive: true });
  const botName = bot.config.CTI_BOT_NAME || bot.slug;
  const persona = bot.config.CTI_BOT_PERSONA || `你是 ${botName}。`;
  const prompt = [
    `# ${botName} WeChat Persona`,
    "",
    persona,
    "",
    "你现在通过微信和用户私聊。微信是个人私密入口，飞书是团队协作入口。",
    "保持和飞书侧一致的身份、语气、边界和工作方式；不要声称自己是另一个 bot。",
    "微信和飞书共享同一个 bot 的长期记忆边界；短期会话上下文按 channel 独立，不要把某个平台的原始私聊内容泄露到另一个平台。",
    "普通微信回复不要展示 `::card::`、`::field::` 或 `[[...]]` 卡片协议；只有当系统/项目创建流程明确要求输出 `::card:: project_draft` 结构化草稿时，按要求输出，微信 sidecar 会在发给用户前转换成文字草稿。",
    "如果用户发送 `/new`，微信通道会开启一段新会话；如果用户发送 `/clear`，微信通道会清理当前会话上下文。重置后继续保持同一个 persona。",
    "",
  ].join("\n");
  fs.writeFileSync(bot.promptFile, prompt, "utf-8");
  return bot.promptFile;
}

function resolveLocalWeixinAcpMain() {
  const built = path.join(repoRoot, "packages", "weixin-acp", "dist", "main.mjs");
  return fs.existsSync(built) ? built : undefined;
}

function buildBotPath(agentHome, env = process.env) {
  const runtimeBin = path.join(agentHome, "runtime", "bin");
  const currentPath = env.PATH || "";
  return currentPath ? `${runtimeBin}${path.delimiter}${currentPath}` : runtimeBin;
}

function buildEnv(bot) {
  const identityPath = path.join(bot.wechatDir, "bound-feishu-identity.json");
  const identity = readJsonSafe(identityPath, {});
  return {
    ...process.env,
    ...bot.config,
    PATH: buildBotPath(bot.agentHome),
    LOS_HOME: bot.agentHome,
    CTI_HOME: bot.agentHome,
    LOS_SHARED_DIR: process.env.LOS_SHARED_DIR || path.join(os.homedir(), ".linearos", "shared"),
    OPENCLAW_STATE_DIR: bot.wechatDir,
    CLAWDBOT_STATE_DIR: bot.wechatDir,
    WEIXIN_AGENT_BOT_SLUG: bot.slug,
    WEIXIN_AGENT_HOME: bot.agentHome,
    WEIXIN_AGENT_LINEAROS_REPO: process.env.WEIXIN_AGENT_LINEAROS_REPO || path.join(os.homedir(), "multi-agent-in-feishu"),
    WEIXIN_AGENT_FEISHU_CHAT_ID: process.env.WEIXIN_AGENT_FEISHU_CHAT_ID || identity.chatId || "",
    WEIXIN_AGENT_FEISHU_OPEN_ID: process.env.WEIXIN_AGENT_FEISHU_OPEN_ID || identity.userId || "",
    WEIXIN_AGENT_FEISHU_UNION_ID: process.env.WEIXIN_AGENT_FEISHU_UNION_ID || identity.userUnionId || "",
    WEIXIN_AGENT_FEISHU_NAME: process.env.WEIXIN_AGENT_FEISHU_NAME || identity.userName || "",
  };
}

function commandForWeixinAcp(args) {
  const localMain = resolveLocalWeixinAcpMain();
  if (localMain) {
    return {
      command: process.execPath,
      args: [localMain, ...args],
      display: `node ${path.relative(repoRoot, localMain)} ${args.join(" ")}`,
    };
  }
  return {
    command: "weixin-acp",
    args,
    display: `weixin-acp ${args.join(" ")}`,
  };
}

function runWeixinAcp(bot, args) {
  const cmd = commandForWeixinAcp(args);
  console.log(`[wechat-bind-demo] bot=${bot.slug}`);
  console.log(`[wechat-bind-demo] state=${bot.wechatDir}`);
  console.log(`[wechat-bind-demo] prompt=${bot.promptFile}`);
  console.log(`[wechat-bind-demo] command=${cmd.display}`);

  const child = spawn(cmd.command, cmd.args, {
    cwd: bot.wechatDir,
    env: buildEnv(bot),
    stdio: "inherit",
  });

  let shuttingDown = false;
  const forwardShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      child.kill(signal);
    } catch {
      // Child may already be gone.
    }
    setTimeout(() => process.exit(0), 1_500).unref();
  };

  process.on("SIGTERM", () => forwardShutdown("SIGTERM"));
  process.on("SIGINT", () => forwardShutdown("SIGINT"));

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function showStatus(bot) {
  const indexPath = path.join(bot.wechatDir, "openclaw-weixin", "accounts.json");
  const accountIds = readJsonSafe(indexPath, []);
  console.log(JSON.stringify({
    slug: bot.slug,
    agentHome: bot.agentHome,
    profilePath: bot.profilePath,
    profileExists: fs.existsSync(bot.profilePath),
    wechatStateDir: bot.wechatDir,
    legacyWechatStateDir: bot.legacyWechatDir,
    legacyStateExists: fs.existsSync(bot.legacyWechatDir),
    promptFile: bot.promptFile,
    promptExists: fs.existsSync(bot.promptFile),
    accountIndexPath: indexPath,
    accounts: Array.isArray(accountIds) ? accountIds : [],
    sharedStateUsed: false,
  }, null, 2));
}

const [command, slug, ...rest] = process.argv.slice(2);
if (!command || command === "-h" || command === "--help") {
  usage();
  process.exit(0);
}

try {
  const bot = resolveBot(slug);
  bot.promptFile = writePromptFile(bot);

  switch (command) {
    case "status":
      showStatus(bot);
      break;
    case "login":
      runWeixinAcp(bot, ["login"]);
      break;
    case "logout":
      runWeixinAcp(bot, ["logout"]);
      break;
    case "start": {
      const ddIndex = rest.indexOf("--");
      if (ddIndex === -1) {
        runWeixinAcp(bot, [
          "codex",
          "--cwd", bot.wechatDir,
          "--system-prompt-file", bot.promptFile,
        ]);
      } else {
        const acpArgs = rest.slice(ddIndex + 1);
        if (acpArgs.length === 0) {
          throw new Error("missing ACP command after --");
        }
        runWeixinAcp(bot, [
          "start",
          "--cwd", bot.wechatDir,
          "--system-prompt-file", bot.promptFile,
          "--",
          ...acpArgs,
        ]);
      }
      break;
    }
    default:
      usage();
      process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
