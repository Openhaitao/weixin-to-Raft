import assert from "node:assert/strict";

import {
  buildAgentEnv,
  buildBotPath,
  resolveStartArgs,
} from "./wechat-bind-demo-lib.mjs";

const cwd = "/tmp/bot/channels/wechat";
const prompt = `${cwd}/CLAUDE.md`;

assert.deepEqual(resolveStartArgs([], cwd, prompt), [
  "start",
  "--cwd", cwd,
  "--system-prompt-file", prompt,
  "--",
  "claude-agent-acp",
]);

assert.deepEqual(resolveStartArgs(["--", "custom-acp", "--flag"], cwd, prompt), [
  "start",
  "--cwd", cwd,
  "--system-prompt-file", prompt,
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
assert.deepEqual(
  buildAgentEnv(
    { PATH: "/usr/bin:/bin", ANTHROPIC_MODEL: "ambient-wrong" },
    { CTI_DEFAULT_MODEL: "  claude-opus-4-8  " },
  ),
  {
    PATH: "/usr/bin:/bin",
    CTI_DEFAULT_MODEL: "  claude-opus-4-8  ",
    ANTHROPIC_MODEL: "claude-opus-4-8",
  },
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
