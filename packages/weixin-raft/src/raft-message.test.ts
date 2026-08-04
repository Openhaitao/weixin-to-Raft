import assert from "node:assert/strict";

import { parseServerAgents } from "./raft-cli.js";
import { extractAttachments, isAllowedAgentReply, parseRaftMessages } from "./raft-message.js";
import { mediaTypeForFile } from "./weixin-response.js";

// Shaped like real `raft message check` output observed on 2026-08-03:
// one header line per message, multi-line bodies continue without a header,
// and the stream ends with a terminator sentence.
const checkOutput = [
  "[target=dm:@PM msg=11111111 time=2026-08-03 18:20:11 type=agent] @PM: 第一行",
  "第二行",
  "",
  "第四行（上面保留空行）",
  "[target=#Tech msg=22222222 time=2026-08-03 18:21:00 type=human] @Haitao_Hu: 频道消息",
  "[target=dm:@Buffett msg=33333333 time=2026-08-03 18:22:00 type=agent] @Buffett: 单行回复",
  "[target=dm:@PM:aaaaaaaa msg=44444444 time=2026-08-03 18:23:00 type=agent] @PM: 线程回复",
  "No more new messages.",
].join("\n");

const messages = parseRaftMessages(checkOutput);
assert.equal(messages.length, 4);

// Multi-line body is reassembled verbatim, including interior blank lines,
// but without the trailing newline padding.
assert.deepEqual(messages[0], {
  target: "dm:@PM",
  messageId: "11111111",
  time: "2026-08-03 18:20:11",
  type: "agent",
  sender: "PM",
  text: "第一行\n第二行\n\n第四行（上面保留空行）",
});
assert.equal(messages[1]!.type, "human");
assert.equal(messages[2]!.text, "单行回复");
assert.equal(messages[3]!.target, "dm:@PM:aaaaaaaa");

// "No new messages." alone parses to nothing.
assert.deepEqual(parseRaftMessages("No new messages.\n"), []);
assert.deepEqual(parseRaftMessages(""), []);

// A body line that merely mentions a bracket must not start a new message.
const tricky = parseRaftMessages(
  "[target=dm:@PM msg=55555555 time=2026-08-03 18:24:00 type=agent] @PM: 代码示例\n[not a header] 仍是正文\nNo more new messages.",
);
assert.equal(tricky.length, 1);
assert.equal(tricky[0]!.text, "代码示例\n[not a header] 仍是正文");

// Any agent's own top-level DM reply goes back to WeChat (dynamic mode).
assert.ok(isAllowedAgentReply(messages[0]!));
assert.ok(isAllowedAgentReply(messages[2]!));

// Humans never echo back to WeChat, even in a DM-shaped target.
assert.equal(
  isAllowedAgentReply(
    { target: "dm:@PM", messageId: "x", time: "t", type: "human", sender: "PM", text: "hi" },
  ),
  false,
);

// Channel traffic stays in Raft.
assert.equal(
  isAllowedAgentReply(
    { target: "#Tech", messageId: "x", time: "t", type: "agent", sender: "PM", text: "hi" },
  ),
  false,
);

// Thread replies are deliberately excluded from the MVP pump: the bridge
// only speaks in top-level DM messages, so only those are relayed back.
assert.equal(isAllowedAgentReply(messages[3]!), false);

// An excluded agent's DM must not leak to WeChat, case-insensitively.
assert.equal(
  isAllowedAgentReply(
    { target: "dm:@Sys", messageId: "x", time: "t", type: "agent", sender: "Sys", text: "hi" },
    ["sys"],
  ),
  false,
);

// A DM whose peer differs from the sender is not that agent's own reply lane.
assert.equal(
  isAllowedAgentReply(
    { target: "dm:@PM", messageId: "x", time: "t", type: "agent", sender: "Buffett", text: "hi" },
  ),
  false,
);

// Case-insensitive on both sender and target, matching Raft name resolution.
assert.ok(
  isAllowedAgentReply(
    { target: "DM:@pm", messageId: "x", time: "t", type: "agent", sender: "pm", text: "hi" },
  ),
);

// --- Server roster parsing (shaped like real `raft server info --agents`) ---
const roster = parseServerAgents(
  [
    "## Server Agents",
    "",
    "Role labels show server-level owner/admin authority; no role label means ordinary member.",
    "@Momo (active; online)",
    "@code (active; working: Listing server…)",
    // Status prose may contain parentheses and dashes — must not hide the agent.
    "@LT (active; working: Sending a message (retry #2) — step 3)",
    "@Buffett (active; online) — 投资研究 Agent。做公司基本面分析、估值。",
    "@Server (active; error: Failed to authenticate: OAuth session expired)",
    "@Gone (inactive; offline)",
    "Showing 1-7 of 7.",
  ].join("\n"),
);
assert.deepEqual(roster.map((agent) => agent.name), ["Momo", "code", "LT", "Buffett", "Server"]);
assert.equal(roster.find((agent) => agent.name === "Buffett")?.description, "投资研究 Agent。做公司基本面分析、估值。");
assert.equal(roster.find((agent) => agent.name === "Momo")?.description, undefined);

// --- Attachment markers (shaped like real check/read output) ---

// The CLI-facing marker is split into ids for forwarding; the prose keeps
// none of the CLI instructions.
const single = extractAttachments(
  "我发给你了 [1 attachment: image.png (id:bd525ce0-74d0-48d9-8e7f-c73c82509601) — use raft attachment view to download]",
);
assert.equal(single.text, "我发给你了");
assert.deepEqual(single.attachments, [
  { name: "image.png", id: "bd525ce0-74d0-48d9-8e7f-c73c82509601" },
]);

const multi = extractAttachments(
  "两个文件 [2 attachments: 报告 v2.pdf (id:11111111-2222-3333-4444-555555555555), demo.mp4 (id:66666666-7777-8888-9999-aaaaaaaaaaaa) — use raft attachment view to download]",
);
assert.equal(multi.text, "两个文件");
assert.deepEqual(multi.attachments.map((ref) => ref.name), ["报告 v2.pdf", "demo.mp4"]);

// No marker → text untouched, no attachments. Bracketed prose survives.
const none = extractAttachments("正文里 [不是附件标记] 保持原样");
assert.equal(none.text, "正文里 [不是附件标记] 保持原样");
assert.deepEqual(none.attachments, []);

// Media type inference for the WeChat side.
assert.equal(mediaTypeForFile("photo.JPG"), "image");
assert.equal(mediaTypeForFile("clip.mp4"), "video");
assert.equal(mediaTypeForFile("报告 v2.pdf"), "file");
assert.equal(mediaTypeForFile("noext"), "file");

console.log("weixin-raft message parsing tests passed");
