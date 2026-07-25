#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp claude-code                     # Start with Claude Code
 *   npx weixin-acp codex                           # Start with Codex
 *   npx weixin-acp start -- <command> [args...]    # Start with custom agent
 *
 * Examples:
 *   npx weixin-acp start -- node ./my-agent.js
 */

import fs from "node:fs";

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";

import { AcpAgent } from "./src/acp-agent.js";
import { createBackendModelSelectionConfig } from "./src/model-selection.js";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

const command = process.argv[2];

type CliOptions = {
  cwd?: string;
  systemPromptFile?: string;
};

function parseCliOptions(args: string[]): CliOptions {
  let cwd: string | undefined;
  let systemPromptFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cwd") {
      cwd = args[++i];
      continue;
    }
    if (arg === "--system-prompt-file") {
      systemPromptFile = args[++i];
      continue;
    }
  }

  return { cwd, systemPromptFile };
}

function readSystemPrompt(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  return fs.readFileSync(filePath, "utf-8");
}

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

async function startAgent(acpCommand: string, acpArgs: string[] = [], opts: CliOptions = {}) {
  await ensureLoggedIn();

  const agent = new AcpAgent({
    command: acpCommand,
    args: acpArgs,
    cwd: opts.cwd,
    systemPrompt: readSystemPrompt(opts.systemPromptFile),
    modelSelection: createBackendModelSelectionConfig(acpCommand, acpArgs),
  });

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n正在停止...");
    agent.dispose();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    agent.dispose();
    ac.abort();
  });

  return start(agent, { abortSignal: ac.signal });
}

async function main() {
  if (command === "login") {
    const json = process.argv.includes("--json");
    const accountId = await login({
      printQr: !json,
      log: json ? (message) => console.error(message) : console.log,
      onQr: json
        ? (result) => console.log(`WEIXIN_LOGIN_QR ${JSON.stringify(result)}`)
        : undefined,
    });
    if (json) console.log(`WEIXIN_LOGIN_DONE ${JSON.stringify({ accountId })}`);
    return;
  }

  if (command === "logout") {
    logout();
    return;
  }

  if (command === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
      console.error("示例: npx weixin-acp start -- codex-acp");
      process.exit(1);
    }

    const opts = parseCliOptions(process.argv.slice(3, ddIndex));
    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    const bot = await startAgent(acpCommand, acpArgs, opts);
    await bot.wait();
    return;
  }

  if (command && command in BUILTIN_AGENTS) {
    const opts = parseCliOptions(process.argv.slice(3));
    const { command: acpCommand } = BUILTIN_AGENTS[command];
    const bot = await startAgent(acpCommand, [], opts);
    await bot.wait();
    return;
  }

  console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp login --json                   输出结构化二维码事件并等待扫码
  npx weixin-acp logout                         退出登录
  npx weixin-acp claude-code                     使用 Claude Code
  npx weixin-acp codex                           使用 Codex
  npx weixin-acp start -- <command> [args...]    使用自定义 agent

选项:
  --cwd <dir>                                    ACP session 工作目录
  --system-prompt-file <file>                    新会话注入的系统提示词

示例:
  npx weixin-acp claude-code --system-prompt-file ./CLAUDE.md
  npx weixin-acp start -- node ./my-agent.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
