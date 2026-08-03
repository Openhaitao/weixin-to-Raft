/**
 * Manual live round-trip: simulated WeChat inbound → real Raft DM to one
 * allowlisted agent → wait for its real reply → pump it back to a fake
 * WeChat sender. Run only with a dedicated bridge profile (or explicit
 * WEIXIN_RAFT_ALLOW_AMBIENT=1 while debugging locally): the pump calls
 * `raft message check`, which CONSUMES the identity's unread inbox. Every
 * raw check output is appended to <stateDir>/live-roundtrip.log so nothing
 * drained during the test is lost.
 *
 *   WEIXIN_RAFT_ALLOW_AMBIENT=1 WEIXIN_RAFT_AGENTS="PM=产品研究" \
 *     pnpm --filter weixin-raft exec tsx scripts/live-roundtrip.ts "测试问题"
 */

import fs from "node:fs";
import path from "node:path";

import { loadConfig, requireBridgeCredential } from "../src/config.js";
import { RaftCliTransport } from "../src/raft-cli.js";
import { ReplyPump } from "../src/reply-pump.js";
import { BridgeStateStore } from "../src/state.js";
import { WeixinRaftAgent } from "../src/weixin-raft-agent.js";

const question = process.argv[2]
  ?? "这是微信桥接的自动化联调消息，请直接回复一句确认（例如：收到）。";
const timeoutMs = Number(process.env.WEIXIN_RAFT_E2E_TIMEOUT_MS ?? 180_000);

const config = loadConfig();
requireBridgeCredential(config);
fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
const drainLog = path.join(config.stateDir, "live-roundtrip.log");

const transport = new RaftCliTransport({
  bin: config.raftBin,
  profile: config.raftProfile,
  pollIntervalMs: Math.min(config.pollIntervalMs, 10_000),
});
const rawCheckInbox = transport.checkInbox.bind(transport);
transport.checkInbox = async () => {
  const output = await rawCheckInbox();
  fs.appendFileSync(drainLog, `--- check ${new Date().toISOString()} ---\n${output}\n`);
  return output;
};

const store = new BridgeStateStore(fs.mkdtempSync(path.join(config.stateDir, "e2e-")));
const agent = new WeixinRaftAgent({
  listAgents: config.agents
    ? async () => config.agents!
    : () => transport.listAgents(),
  defaultAgent: config.defaultAgent,
  store,
  transport,
});

const received: string[] = [];
let resolveDone: () => void;
const done = new Promise<void>((resolve) => { resolveDone = resolve; });

const pump = new ReplyPump({
  excludeAgents: config.excludeAgents,
  pollIntervalMs: Math.min(config.pollIntervalMs, 10_000),
  store,
  transport,
  sendWeixin: async (response) => {
    received.push(response.text ?? "");
    console.log(`\n[微信收到]\n${response.text}\n`);
    resolveDone();
  },
  onError: (error) => console.error(`[pump] ${String(error)}`),
});
transport.setDrainBeforeRetry(() => pump.drainNow());

console.log(`[e2e] inbox drain log: ${drainLog}`);
const ack = await agent.chat({ conversationId: "e2e-local", text: question });
console.log(`[微信收到] ${ack.text}`);

await pump.start();
const timer = setTimeout(() => {
  console.error(`[e2e] no reply within ${timeoutMs}ms`);
  resolveDone();
}, timeoutMs);
await done;
clearTimeout(timer);
pump.stop();

if (received.length === 0) process.exit(1);
console.log("[e2e] round-trip complete");
process.exit(0);
