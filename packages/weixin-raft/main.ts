#!/usr/bin/env node

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";

import { loadConfig, requireBridgeCredential, type RaftAgentOption, type WeixinRaftConfig } from "./src/config.js";
import { RaftCliTransport } from "./src/raft-cli.js";
import { ReplyPump } from "./src/reply-pump.js";
import { BridgeStateStore } from "./src/state.js";
import { WeixinRaftAgent } from "./src/weixin-raft-agent.js";

function makeAgentProvider(
  config: WeixinRaftConfig,
  transport: RaftCliTransport,
): () => Promise<RaftAgentOption[]> {
  if (config.agents) {
    const fixed = config.agents;
    return async () => fixed;
  }
  const excluded = new Set(config.excludeAgents.map((name) => name.toLowerCase()));
  return async () => {
    const live = await transport.listAgents();
    return live.filter((agent) => !excluded.has(agent.name.toLowerCase()));
  };
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  requireBridgeCredential(config);
  const transport = new RaftCliTransport({
    bin: config.raftBin,
    profile: config.raftProfile,
    pollIntervalMs: config.pollIntervalMs,
  });
  const available = await transport.listAgents();
  if (config.agents) {
    const missing = config.agents.filter(
      (agent) => !available.some((item) => item.name.toLowerCase() === agent.name.toLowerCase()),
    );
    if (missing.length) {
      throw new Error(`Configured Raft agents not found or inactive: ${missing.map((item) => item.name).join(", ")}`);
    }
    console.log(`Raft ready: ${config.agents.map((agent) => agent.name).join(", ")}`);
    return;
  }
  const visible = await makeAgentProvider(config, transport)();
  if (!visible.some((agent) => agent.name.toLowerCase() === config.defaultAgent.toLowerCase())) {
    throw new Error(`Default agent not found or inactive on the server: ${config.defaultAgent}`);
  }
  console.log(
    `Raft ready (dynamic): ${visible.length} agents visible, default ${config.defaultAgent}`
    + `${config.excludeAgents.length ? `, excluded: ${config.excludeAgents.join(", ")}` : ""}`,
  );
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

环境变量:
  RAFT_PROFILE                       必填，专用 Raft External Agent profile
  WEIXIN_RAFT_DEFAULT_AGENT          默认 Agent（默认 code）
  WEIXIN_RAFT_AGENTS                 可选静态白名单；不设置则 /agent 实时列出全部在线 agent
  WEIXIN_RAFT_EXCLUDE                动态模式下要隐藏的 agent，逗号分隔
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
    listAgents: makeAgentProvider(config, transport),
    defaultAgent: config.defaultAgent,
    store,
    transport,
  });
  const abort = new AbortController();
  const bot = start(agent, { abortSignal: abort.signal });
  const pump = new ReplyPump({
    excludeAgents: config.excludeAgents,
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
