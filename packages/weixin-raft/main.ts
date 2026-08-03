#!/usr/bin/env node

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";

import { loadConfig, requireBridgeCredential } from "./src/config.js";
import { RaftCliTransport } from "./src/raft-cli.js";
import { ReplyPump } from "./src/reply-pump.js";
import { BridgeStateStore } from "./src/state.js";
import { WeixinRaftAgent } from "./src/weixin-raft-agent.js";

async function doctor(): Promise<void> {
  const config = loadConfig();
  requireBridgeCredential(config);
  const transport = new RaftCliTransport({
    bin: config.raftBin,
    profile: config.raftProfile,
    pollIntervalMs: config.pollIntervalMs,
  });
  const available = await transport.listAgents();
  const missing = config.agents.filter(
    (agent) => !available.some((name) => name.toLowerCase() === agent.name.toLowerCase()),
  );
  if (missing.length) {
    throw new Error(`Configured Raft agents not found or inactive: ${missing.map((item) => item.name).join(", ")}`);
  }
  console.log(`Raft ready: ${config.agents.map((agent) => agent.name).join(", ")}`);
}

async function run(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "login") {
    await login();
    return;
  }
  if (command === "logout") {
    logout();
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command !== "start") {
    console.log(`weixin-raft — 微信到 Raft Agent 路由器

用法:
  weixin-raft login      扫码绑定微信
  weixin-raft doctor     检查 Raft 身份和 Agent 白名单
  weixin-raft start      启动双向桥接
  weixin-raft logout     清除微信绑定

必需环境变量:
  RAFT_PROFILE                       专用 Raft External Agent profile
  WEIXIN_RAFT_AGENTS                 逗号分隔白名单，例如 code=技术开发,PM=产品研究
  WEIXIN_RAFT_DEFAULT_AGENT          默认 Agent（可选，默认白名单第一项）
`);
    return;
  }

  const config = loadConfig();
  requireBridgeCredential(config);
  await doctor();
  if (!isLoggedIn()) {
    console.log("未检测到微信绑定，请扫码登录。\n");
    await login();
  }

  const store = new BridgeStateStore(config.stateDir);
  const transport = new RaftCliTransport({
    bin: config.raftBin,
    profile: config.raftProfile,
    pollIntervalMs: config.pollIntervalMs,
  });
  const agent = new WeixinRaftAgent({
    agents: config.agents,
    defaultAgent: config.defaultAgent,
    store,
    transport,
  });
  const abort = new AbortController();
  const bot = start(agent, { abortSignal: abort.signal });
  const pump = new ReplyPump({
    agents: config.agents.map((item) => item.name),
    pollIntervalMs: config.pollIntervalMs,
    store,
    transport,
    sendWeixin: (response) => bot.sendMessage(response),
    onError: (error) => console.error(`[weixin-raft] ${String(error)}`),
  });
  transport.setDrainBeforeRetry(() => pump.drainNow());
  await pump.start();

  const shutdown = () => {
    pump.stop();
    abort.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await bot.wait();
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
