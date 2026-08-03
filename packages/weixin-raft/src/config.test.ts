import assert from "node:assert/strict";

import { loadConfig, parseAgentList, requireBridgeCredential } from "./config.js";

// Allowlist parsing: name=description pairs, @ prefix tolerated, order kept.
const agents = parseAgentList("code=技术开发, @PM=产品研究 ,Buffett");
assert.deepEqual(agents, [
  { name: "code", description: "技术开发" },
  { name: "PM", description: "产品研究" },
  { name: "Buffett" },
]);

// Description may itself contain "=" (only the first split is structural).
assert.deepEqual(parseAgentList("code=a=b"), [{ name: "code", description: "a=b" }]);

// Empty list and malformed names fail loudly — a silent empty allowlist
// would make every WeChat message unroutable.
assert.throws(() => parseAgentList("  ,  "), /at least one/);
assert.throws(() => parseAgentList("bad name=x"), /Invalid Raft agent name/);
assert.throws(() => parseAgentList("@=x"), /Invalid Raft agent name/);

// Duplicates are a config bug (menu numbers would be ambiguous), including
// case-insensitive duplicates because Raft names resolve case-insensitively.
assert.throws(() => parseAgentList("code,CODE"), /Duplicate/);

// loadConfig: default agent must be a member of the allowlist.
const config = loadConfig({
  WEIXIN_RAFT_AGENTS: "code=技术,PM=产品",
  WEIXIN_RAFT_DEFAULT_AGENT: "@pm",
  RAFT_PROFILE: "wechat-bridge",
  WEIXIN_RAFT_POLL_INTERVAL_MS: "5000",
} as NodeJS.ProcessEnv);
// Canonical casing comes from the allowlist entry, not the env override.
assert.equal(config.defaultAgent, "PM");
assert.equal(config.pollIntervalMs, 5_000);
assert.equal(config.raftProfile, "wechat-bridge");

assert.throws(
  () => loadConfig({ WEIXIN_RAFT_AGENTS: "code", WEIXIN_RAFT_DEFAULT_AGENT: "PM" } as NodeJS.ProcessEnv),
  /not in WEIXIN_RAFT_AGENTS/,
);

// Unset default falls back to the first allowlist entry.
assert.equal(loadConfig({ WEIXIN_RAFT_AGENTS: "PM,code" } as NodeJS.ProcessEnv).defaultAgent, "PM");

assert.throws(
  () => loadConfig({ WEIXIN_RAFT_POLL_INTERVAL_MS: "0" } as NodeJS.ProcessEnv),
  /positive integer/,
);

// The bridge must run as a dedicated Raft External Agent. Falling back to
// whatever ambient identity happens to be configured would let WeChat speak
// as that identity; require an explicit opt-in for local testing only.
const noProfile = loadConfig({ WEIXIN_RAFT_AGENTS: "code" } as NodeJS.ProcessEnv);
assert.throws(() => requireBridgeCredential(noProfile), /RAFT_PROFILE is required/);
requireBridgeCredential(
  loadConfig({ WEIXIN_RAFT_AGENTS: "code", RAFT_PROFILE: "wechat-bridge" } as NodeJS.ProcessEnv),
);
requireBridgeCredential(
  loadConfig({ WEIXIN_RAFT_AGENTS: "code", WEIXIN_RAFT_ALLOW_AMBIENT: "1" } as NodeJS.ProcessEnv),
);

console.log("weixin-raft config tests passed");
