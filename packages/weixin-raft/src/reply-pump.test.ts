import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatResponse } from "weixin-agent-sdk";

import { ReplyPump } from "./reply-pump.js";
import { BridgeStateStore } from "./state.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-raft-pump-"));
const store = new BridgeStateStore(stateDir, () => 1);

let inbox = "No new messages.\n";
const delivered: string[] = [];
let failNextSend = false;

const pump = new ReplyPump({
  excludeAgents: ["Sys"],
  pollIntervalMs: 60_000,
  store,
  transport: {
    async checkInbox() {
      const current = inbox;
      // Like the real CLI, a check consumes the unread window.
      inbox = "No new messages.\n";
      return current;
    },
    startWakeLoop() {
      return () => {};
    },
  },
  sendWeixin: async (response: ChatResponse) => {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("weixin send failed");
    }
    delivered.push(response.text ?? "");
  },
  onError: () => {},
});

// Any agent's own DM reply is relayed to WeChat, labeled by sender so
// switching agents never leaves an unattributed answer. Channel traffic and
// explicitly excluded agents (here @Sys) stay in Raft.
inbox = [
  "[target=dm:@PM msg=aaaa0001 time=2026-08-03 18:30:00 type=agent] @PM: 分析结果",
  "第二行",
  "[target=#Tech msg=aaaa0002 time=2026-08-03 18:30:10 type=human] @Haitao_Hu: 频道闲聊",
  "[target=dm:@Sys msg=aaaa0003 time=2026-08-03 18:30:20 type=agent] @Sys: 系统通知",
  "No more new messages.",
].join("\n");
await pump.drainNow();
assert.deepEqual(delivered, ["来自 @PM：\n\n分析结果\n第二行"]);

// Draining again with an empty inbox re-sends nothing.
await pump.drainNow();
assert.equal(delivered.length, 1);

// A WeChat send failure keeps the reply pending: it survives on disk and is
// retried on the next drain instead of being lost.
inbox = "[target=dm:@code msg=aaaa0004 time=2026-08-03 18:31:00 type=agent] @code: 稍后要重发的回复\nNo more new messages.";
failNextSend = true;
await pump.drainNow();
assert.equal(delivered.length, 1);
assert.equal(store.pendingOutbound().length, 1);

await pump.drainNow();
assert.deepEqual(delivered.at(-1), "来自 @code：\n\n稍后要重发的回复");
assert.equal(store.pendingOutbound().length, 0);

// The same Raft message id seen twice (e.g. wake + poll racing a slow check)
// is delivered exactly once, and stays delivered across a bridge restart.
inbox = "[target=dm:@PM msg=aaaa0005 time=2026-08-03 18:32:00 type=agent] @PM: 只发一次\nNo more new messages.";
await pump.drainNow();
inbox = "[target=dm:@PM msg=aaaa0005 time=2026-08-03 18:32:00 type=agent] @PM: 只发一次\nNo more new messages.";
await pump.drainNow();
assert.equal(delivered.filter((text) => text.includes("只发一次")).length, 1);

const restarted = new BridgeStateStore(stateDir, () => 1);
assert.equal(restarted.hasRaftMessage("aaaa0005"), true);
assert.equal(restarted.pendingOutbound().length, 0);

// --- Claims: a waiting chat() takes the reply as its direct answer ---

// A claim opened before the reply arrives receives the item; the pump must
// NOT also send it to WeChat as a labeled message.
const sentBeforeClaim = delivered.length;
const claimPromise = pump.claimNextReply("PM", 5_000);
inbox = "[target=dm:@PM msg=aaaa0006 time=2026-08-03 18:33:00 type=agent] @PM: 直接回答内容\nNo more new messages.";
await pump.drainNow();
const claimed = await claimPromise;
assert.equal(claimed?.text, "直接回答内容");
assert.equal(delivered.length, sentBeforeClaim);
assert.equal(store.pendingOutbound().length, 0);
assert.equal(store.hasRaftMessage("aaaa0006"), true);

// A reply already sitting in the durable queue satisfies a new claim
// immediately (it arrived between forward and claim).
inbox = "[target=dm:@code msg=aaaa0007 time=2026-08-03 18:34:00 type=agent] @code: 早到的回答\nNo more new messages.";
failNextSend = true; // keep it queued instead of flushed
await pump.drainNow();
assert.equal(store.pendingOutbound().length, 1);
const early = await pump.claimNextReply("code", 5_000);
assert.equal(early?.text, "早到的回答");
assert.equal(store.pendingOutbound().length, 0);

// A claim that nothing answers resolves null after its timeout.
const timedOut = await pump.claimNextReply("PM", 50);
assert.equal(timedOut, null);

// --- Attachments: Raft replies with files become real WeChat media ---

const mediaStore = new BridgeStateStore(
  fs.mkdtempSync(path.join(os.tmpdir(), "weixin-raft-pump-media-")),
  () => 1,
);
let mediaInbox = [
  "[target=dm:@PM msg=bbbb0001 time=2026-08-04 00:30:00 type=agent] @PM: 图表在这 [1 attachment: chart.png (id:aaaabbbb-cccc-dddd-eeee-ffff00001111) — use raft attachment view to download]",
  "No more new messages.",
].join("\n");
const mediaDelivered: ChatResponse[] = [];
const mediaPump = new ReplyPump({
  pollIntervalMs: 60_000,
  store: mediaStore,
  transport: {
    async checkInbox() {
      const current = mediaInbox;
      mediaInbox = "No new messages.\n";
      return current;
    },
    startWakeLoop() {
      return () => {};
    },
  },
  sendWeixin: async (response) => {
    mediaDelivered.push(response);
  },
  fetchAttachment: async (ref) => `/tmp/dl/${ref.name}`,
  onError: () => {},
});
await mediaPump.drainNow();
assert.equal(mediaDelivered.length, 1);
// Label kept, CLI marker stripped, first attachment as media.
assert.match(mediaDelivered[0]!.text ?? "", /来自 @PM：/);
assert.ok(!(mediaDelivered[0]!.text ?? "").includes("attachment view"));
assert.equal(mediaDelivered[0]!.media?.type, "image");
assert.equal(mediaDelivered[0]!.media?.fileName, "chart.png");

// A checkInbox failure is reported, not fatal, and does not corrupt state.
const errors: unknown[] = [];
const failingPump = new ReplyPump({
  pollIntervalMs: 60_000,
  store: restarted,
  transport: {
    async checkInbox(): Promise<string> {
      throw new Error("raft unreachable");
    },
    startWakeLoop() {
      return () => {};
    },
  },
  sendWeixin: async () => {},
  onError: (error) => errors.push(error),
});
await failingPump.drainNow();
assert.equal(errors.length, 1);

console.log("weixin-raft reply pump tests passed");
