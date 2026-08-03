import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BridgeStateStore } from "./state.js";
import { WeixinRaftAgent } from "./weixin-raft-agent.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-raft-agent-"));
let clock = 1_000_000;
const store = new BridgeStateStore(stateDir, () => clock);

const sent: Array<{ agent: string; text: string }> = [];
const agent = new WeixinRaftAgent({
  agents: [
    { name: "code", description: "技术开发" },
    { name: "PM", description: "产品研究" },
    { name: "Buffett" },
  ],
  defaultAgent: "code",
  store,
  transport: {
    async sendToAgent(target, text) {
      sent.push({ agent: target, text });
      return { messageId: `m${sent.length}` };
    },
  },
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

// /agent opens the numbered menu with the current selection marked.
response = await chat("/agent");
assert.match(response.text!, /当前 Agent：code/);
assert.match(response.text!, /1\. code ✓ — 技术开发/);
assert.match(response.text!, /2\. PM — 产品研究/);
assert.match(response.text!, /3\. Buffett/);

// A bare number right after the menu is a selection, not a message.
response = await chat("2");
assert.match(response.text!, /已切换到 PM/);
assert.equal(sent.length, 1);

response = await chat("PM 你好");
assert.equal(sent[1]!.agent, "PM");

// The number is consumed: a second "2" is now an ordinary message.
response = await chat("2");
assert.equal(sent[2]!.agent, "PM");
assert.ok(sent[2]!.text.endsWith("2"));

// Out-of-range number after a fresh menu → clear error, nothing forwarded.
await chat("/agent");
response = await chat("9");
assert.match(response.text!, /没有找到/);
assert.equal(sent.length, 3);

// Direct switching without the menu: /agent <name>, @ prefix and case tolerated.
response = await chat("/agent @buffett");
assert.match(response.text!, /已切换到 Buffett/);
assert.match((await chat("估值问题")).text!, /已发送给 Buffett/);

// Unknown name → error, selection unchanged.
response = await chat("/agent Sys");
assert.match(response.text!, /没有找到/);
assert.equal((await chat("再问一个")) && sent.at(-1)!.agent, "Buffett");

// The menu expires after 5 minutes; a late number is treated as text.
await chat("/agent");
clock += 5 * 60_000 + 1;
await chat("1");
assert.equal(sent.at(-1)!.agent, "Buffett");
assert.ok(sent.at(-1)!.text.endsWith("1"));

// Media is out of MVP scope: explain instead of silently dropping.
const before = sent.length;
response = await chat("看看这个", {
  media: { type: "image", filePath: "/tmp/x.jpg", mimeType: "image/jpeg" },
});
assert.match(response.text!, /文字/);
assert.equal(sent.length, before);

// Empty text prompts for input instead of forwarding an empty request.
response = await chat("   ");
assert.match(response.text!, /文字|\/agent/);
assert.equal(sent.length, before);

// Selection survives a bridge restart (state is on disk, keyed by conversation).
const reloaded = new BridgeStateStore(stateDir, () => clock);
assert.equal(reloaded.selectedAgent("wx-haitao", "code"), "Buffett");
assert.equal(reloaded.selectedAgent("wx-other", "code"), "code");

console.log("weixin-raft agent routing tests passed");
