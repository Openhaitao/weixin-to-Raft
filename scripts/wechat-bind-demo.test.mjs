import assert from "node:assert/strict";

import {
  buildAgentEnv,
  buildBotPath,
  resolveStartArgs,
} from "./wechat-bind-demo-lib.mjs";

const cwd = "/tmp/bot/channels/wechat";
const prompt = `${cwd}/CLAUDE.md`;
const memory = "/tmp/bot/memory";

assert.deepEqual(resolveStartArgs([], cwd, prompt, memory), [
  "start",
  "--cwd", cwd,
  "--system-prompt-file", prompt,
  "--memory-dir", memory,
  "--",
  "claude-agent-acp",
]);

assert.deepEqual(resolveStartArgs(["--", "custom-acp", "--flag"], cwd, prompt, memory), [
  "start",
  "--cwd", cwd,
  "--system-prompt-file", prompt,
  "--memory-dir", memory,
  "--",
  "custom-acp",
  "--flag",
]);

assert.deepEqual(
  buildAgentEnv(
    { PATH: "/usr/bin:/bin", ANTHROPIC_MODEL: "codex-deep" },
    { CTI_DEFAULT_MODEL: "codex-deep", ANTHROPIC_MODEL: "also-wrong" },
  ),
  { PATH: "/usr/bin:/bin", CTI_DEFAULT_MODEL: "codex-deep" },
);
// [task16] claude-prefixed CTI_DEFAULT_MODEL must NOT re-inject
// ANTHROPIC_MODEL any more: model routing goes through the ACP protocol,
// and the env injection bypassed the required-default gate.
assert.deepEqual(
  buildAgentEnv(
    { PATH: "/usr/bin:/bin", ANTHROPIC_MODEL: "ambient-wrong" },
    { CTI_DEFAULT_MODEL: "  claude-opus-4-8  " },
  ),
  {
    PATH: "/usr/bin:/bin",
    CTI_DEFAULT_MODEL: "  claude-opus-4-8  ",
  },
);
// [task16] Gate variables are protected fields: launcher (ambient) wins,
// config cannot override, widen, or inject them.
assert.deepEqual(
  buildAgentEnv(
    {
      PATH: "/usr/bin:/bin",
      WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "opus",
      WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX: "Opus 5",
    },
    {
      CTI_DEFAULT_MODEL: "claude-opus-4-6",
      WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "sonnet",
      WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX: "Sonnet",
    },
  ),
  {
    PATH: "/usr/bin:/bin",
    CTI_DEFAULT_MODEL: "claude-opus-4-6",
    WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "opus",
    WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX: "Opus 5",
  },
);
// Config must not be able to conjure a gate the launcher did not set.
assert.deepEqual(
  buildAgentEnv(
    { PATH: "/usr/bin:/bin" },
    { WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "haiku" },
  ),
  { PATH: "/usr/bin:/bin" },
);
assert.equal(
  buildBotPath("/Users/test/.linearos/agents/bot", "/opt/local/bin:/usr/bin", ":"),
  "/Users/test/.linearos/agents/bot/runtime/bin:/opt/local/bin:/usr/bin",
);
assert.equal(
  buildBotPath("/home/test/.linearos/agents/bot", "/usr/local/bin:/usr/bin", ":"),
  "/home/test/.linearos/agents/bot/runtime/bin:/usr/local/bin:/usr/bin",
);

console.log("wechat bind default Claude routing tests passed");
