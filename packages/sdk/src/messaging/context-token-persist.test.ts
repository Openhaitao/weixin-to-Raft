/**
 * context_token 落盘：重启之后还能不能发出消息。
 *
 * 这不是锦上添花的测试 —— token 只存在内存里的那版，进程一重启，
 * 所有答应过用户的提醒都会静静失效，而且没有任何报错。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxtok-"));
process.env.OPENCLAW_STATE_DIR = dir;
const file = path.join(dir, "openclaw-weixin", "context-tokens.json");

const first = await import("./inbound.js");
first.setContextToken("acct-1", "user-1", "TOKEN_ABC");
assert.equal(first.getContextToken("acct-1", "user-1"), "TOKEN_ABC");
assert.ok(fs.existsSync(file), "收到消息后应当把 token 落盘");
assert.equal(JSON.parse(fs.readFileSync(file, "utf-8"))["acct-1:user-1"].token, "TOKEN_ABC");

// 模拟进程重启：新的模块实例内存是空的，只能靠磁盘
const restarted = await import(`./inbound.js?restart=${Date.now()}`);
assert.equal(
  restarted.getContextToken("acct-1", "user-1"),
  "TOKEN_ABC",
  "重启后必须还能拿到 token，否则待发的提醒会全部静默失效",
);
assert.equal(restarted.getContextToken("acct-1", "nobody"), undefined, "没见过的人不该有 token");

// 文件损坏时当作空的处理，并且能被下一次写入修好
fs.writeFileSync(file, "{ not json");
const corrupt = await import(`./inbound.js?corrupt=${Date.now()}`);
assert.equal(corrupt.getContextToken("acct-1", "user-1"), undefined, "坏文件应当降级为空，而不是抛异常");
corrupt.setContextToken("acct-1", "user-1", "TOKEN_NEW");
assert.equal(JSON.parse(fs.readFileSync(file, "utf-8"))["acct-1:user-1"].token, "TOKEN_NEW");

fs.rmSync(dir, { recursive: true, force: true });
console.log("context-token persistence ok");
