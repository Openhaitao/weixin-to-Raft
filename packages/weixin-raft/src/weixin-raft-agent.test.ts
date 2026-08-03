import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RaftAgentOption } from "./config.js";
import { BridgeStateStore } from "./state.js";
import { WeixinRaftAgent } from "./weixin-raft-agent.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-raft-agent-"));
let clock = 1_000_000;
const store = new BridgeStateStore(stateDir, () => clock);

// Live roster, mutable mid-test the way a real server roster is.
let roster: RaftAgentOption[] = [
  { name: "code", description: "技术开发" },
  { name: "PM", description: "产品研究" },
  { name: "Buffett", description: "投资研究 Agent。做公司基本面分析、估值、行业与竞争格局研究。" },
];
let listFailures = 0;
let sendFailures = 0;

const sent: Array<{ agent: string; text: string; attachmentIds: string[] }> = [];
const uploads: Array<{ filePath: string; target: string }> = [];
const testTransport = {
  async sendToAgent(target: string, text: string, attachmentIds: string[] = []) {
    if (sendFailures > 0) {
      sendFailures -= 1;
      throw new Error("send failed");
    }
    sent.push({ agent: target, text, attachmentIds });
    return { messageId: `m${sent.length}` };
  },
  async uploadAttachment(filePath: string, target: string) {
    uploads.push({ filePath, target });
    return { attachmentId: `att-${uploads.length}` };
  },
};
const agent = new WeixinRaftAgent({
  listAgents: async () => {
    if (listFailures > 0) {
      listFailures -= 1;
      throw new Error("raft unreachable");
    }
    return roster;
  },
  defaultAgent: "code",
  store,
  transport: testTransport,
});

const chat = (text: string, extra: Record<string, unknown> = {}) =>
  agent.chat({ conversationId: "wx-haitao", text, ...extra });

// Plain text goes to the default agent, wrapped with provenance the receiving
// agent needs: it came from Haitao's WeChat via the bridge, not from a human
// Raft account, and the reply lane is this DM.
let response = await chat("帮我查一下服务器状态");
assert.match(response.text!, /已发送给 code/);
assert.equal(sent.length, 1);
assert.equal(sent[0]!.agent, "code");
assert.match(sent[0]!.text, /微信桥接请求/);
assert.match(sent[0]!.text, /海涛绑定的微信/);
assert.match(sent[0]!.text, /请直接回复此 DM/);
assert.ok(sent[0]!.text.endsWith("帮我查一下服务器状态"));

// /agent lists the live roster with the current selection marked and long
// descriptions truncated for a phone screen.
response = await chat("/agent");
assert.match(response.text!, /当前 Agent：code/);
assert.match(response.text!, /1\. code ✓ — 技术开发/);
assert.match(response.text!, /2\. PM — 产品研究/);
assert.match(response.text!, /3\. Buffett — .+…/);
assert.ok(!response.text!.includes("竞争格局"));

// A bare number right after the menu is a selection, not a message.
response = await chat("2");
assert.match(response.text!, /已切换到 PM/);
assert.equal(sent.length, 1);

await chat("PM 你好");
assert.equal(sent[1]!.agent, "PM");

// The number is consumed: a second "2" is now an ordinary message.
await chat("2");
assert.equal(sent[2]!.agent, "PM");
assert.ok(sent[2]!.text.endsWith("2"));

// Out-of-range number after a fresh menu → clear error, nothing forwarded.
await chat("/agent");
response = await chat("9");
assert.match(response.text!, /没有编号 9/);
assert.equal(sent.length, 3);

// Numeric selection binds to the menu snapshot the user saw, even if the
// roster changed between showing the menu and the reply.
await chat("/agent");
roster = [{ name: "Newcomer" }, ...roster];
response = await chat("3");
assert.match(response.text!, /已切换到 Buffett/);

// A fresh menu reflects the new roster immediately — no config change needed.
response = await chat("/agent");
assert.match(response.text!, /1\. Newcomer/);
assert.match(response.text!, /4\. Buffett ✓/);
await chat("1");
assert.match((await chat("你是谁")).text!, /已发送给 Newcomer/);

// Direct switching without the menu: /agent <name>, @ prefix and case tolerated.
response = await chat("/agent @buffett");
assert.match(response.text!, /已切换到 Buffett/);

// Unknown name → error, selection unchanged.
response = await chat("/agent Nobody");
assert.match(response.text!, /没有找到/);
await chat("再问一个");
assert.equal(sent.at(-1)!.agent, "Buffett");

// The menu expires after 5 minutes; a late number is treated as text.
await chat("/agent");
clock += 5 * 60_000 + 1;
await chat("1");
assert.equal(sent.at(-1)!.agent, "Buffett");
assert.ok(sent.at(-1)!.text.endsWith("1"));

// Raft being unreachable degrades to an explanation, not a crash.
listFailures = 1;
response = await chat("/agent");
assert.match(response.text!, /拿不到 agent 列表/);

// A failed forward tells the user instead of losing the message silently.
sendFailures = 1;
response = await chat("这条会失败");
assert.match(response.text!, /失败/);

// /help lists the available commands.
response = await chat("/help");
assert.match(response.text!, /\/agent/);
assert.match(response.text!, /\/help/);

// A WeChat attachment is uploaded to the selected agent's DM and linked on
// the forwarded message; the caption travels as the text.
const mediaFile = path.join(stateDir, "photo.jpg");
fs.writeFileSync(mediaFile, "fake-image-bytes");
response = await chat("看看这个", {
  media: { type: "image", filePath: mediaFile, mimeType: "image/jpeg", fileName: "photo.jpg" },
});
assert.equal(uploads.length, 1);
assert.equal(uploads[0]!.target, "dm:@Buffett");
assert.deepEqual(sent.at(-1)!.attachmentIds, ["att-1"]);
assert.ok(sent.at(-1)!.text.includes("看看这个"));

// Attachment with no caption still forwards, with a stand-in note.
response = await chat("", {
  mediaItems: [{ type: "file", filePath: mediaFile, mimeType: "application/pdf", fileName: "报告.pdf" }],
});
assert.equal(uploads.length, 2);
assert.match(sent.at(-1)!.text, /附件/);

// A missing local file degrades to an explanation instead of a broken send.
const before = sent.length;
response = await chat("这个文件坏了", {
  media: { type: "file", filePath: path.join(stateDir, "missing.bin"), mimeType: "application/octet-stream" },
});
assert.match(response.text!, /失败/);
assert.equal(sent.length, before);

// Empty text prompts for input instead of forwarding an empty request.
response = await chat("   ");
assert.match(response.text!, /文字|\/agent/);
assert.equal(sent.length, before);

// --- Direct-conversation mode (awaitReply wired) ---

// An in-time reply is returned as the direct answer: no acknowledgment text,
// no sender label — the exchange reads like talking to the agent itself.
let nextReply:
  | { text: string; attachments?: Array<{ id: string; name: string }> }
  | null = { text: "这是直接回答" };
const directAgent = new WeixinRaftAgent({
  listAgents: async () => roster,
  defaultAgent: "code",
  store,
  transport: testTransport,
  awaitReply: async () =>
    nextReply
      ? {
          messageId: "r1",
          sender: "Buffett",
          text: nextReply.text,
          receivedAt: "t",
          ...(nextReply.attachments ? { attachments: nextReply.attachments } : {}),
        }
      : null,
  syncWaitMs: 1_000,
  fetchAttachment: async (ref) => `/tmp/media/${ref.id}-${ref.name}`,
});
response = await directAgent.chat({ conversationId: "wx-haitao", text: "第一个问题" });
assert.equal(response.text, "这是直接回答");
assert.equal(response.silent, undefined);

// A direct reply carrying an attachment comes back as real WeChat media,
// still without any label.
nextReply = {
  text: "图表在这",
  attachments: [{ id: "aaaabbbb-cccc-dddd-eeee-ffff00001111", name: "chart.png" }],
};
response = await directAgent.chat({ conversationId: "wx-haitao", text: "要图" });
assert.equal(response.text, "图表在这");
assert.equal(response.media?.type, "image");
assert.match(response.media?.url ?? "", /chart\.png$/);

// On timeout the user gets one honest notice — silence would read as a lost
// message. The late reply still arrives via the pump, labeled.
nextReply = null;
response = await directAgent.chat({ conversationId: "wx-haitao", text: "慢问题" });
assert.match(response.text!, /暂时没有回应/);
assert.match(response.text!, /\/agent/);

// Silent turns are not persisted by the SDK ledger, so a restart can
// redeliver the same WeChat message. The forwarded-delivery record answers
// the redelivery silently instead of forwarding twice.
const forwardedBefore = sent.length;
response = await directAgent.chat({ conversationId: "wx-haitao", text: "去重测试", deliveryId: "d1" });
assert.equal(sent.length, forwardedBefore + 1);
response = await directAgent.chat({ conversationId: "wx-haitao", text: "去重测试", deliveryId: "d1" });
assert.equal(response.silent, true);
assert.equal(sent.length, forwardedBefore + 1);

// Selection survives a bridge restart (state is on disk, keyed by conversation).
const reloaded = new BridgeStateStore(stateDir, () => clock);
assert.equal(reloaded.selectedAgent("wx-haitao", "code"), "Buffett");
assert.equal(reloaded.selectedAgent("wx-other", "code"), "code");

console.log("weixin-raft agent routing tests passed");
