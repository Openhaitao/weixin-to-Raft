import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBackendModelSelectionConfig,
  createModelSelectionConfig,
  classifyAcpBackend,
  isCodexAcpBackend,
  ModelSelectionStore,
  parseModelAllowlist,
} from "./model-selection.js";

const allowlist = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-model-selection-test-"));

try {
  assert.deepEqual(
    parseModelAllowlist("gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-sol"),
    ["gpt-5.6-sol", "gpt-5.6-terra"],
  );
  assert.throws(() => parseModelAllowlist("../escape"), /invalid model family/);
  assert.equal(createModelSelectionConfig({}), null);
  assert.throws(
    () => createModelSelectionConfig({ WEIXIN_AGENT_MODEL_ALLOWLIST: allowlist.join(",") }),
    /WEIXIN_AGENT_HOME is required/,
  );
  const backendEnv = {
    WEIXIN_AGENT_HOME: root,
    WEIXIN_AGENT_MODEL_ALLOWLIST: allowlist.join(","),
  };
  assert.equal(classifyAcpBackend("claude-agent-acp"), "claude");
  assert.equal(
    classifyAcpBackend("npx", ["--yes", "@agentclientprotocol/claude-agent-acp"]),
    "claude",
  );
  assert.equal(
    classifyAcpBackend("pnpm", ["dlx", "claude-agent-acp"]),
    "claude",
  );
  assert.equal(
    classifyAcpBackend("yarn", ["dlx", "@agentclientprotocol/claude-agent-acp"]),
    "claude",
  );
  assert.equal(
    classifyAcpBackend("npx", ["claude-agent-acp-evil"]),
    "unsupported",
  );
  assert.equal(isCodexAcpBackend("claude-agent-acp"), false);
  assert.equal(isCodexAcpBackend("/usr/local/bin/codex-acp"), true);
  assert.equal(
    isCodexAcpBackend("npx", ["@agentclientprotocol/codex-acp"]),
    true,
  );
  assert.equal(isCodexAcpBackend("npx", ["--yes", "codex-acp"]), true);
  assert.equal(
    isCodexAcpBackend("pnpm", ["dlx", "@agentclientprotocol/codex-acp"]),
    true,
  );
  assert.equal(isCodexAcpBackend("pnpm", ["exec", "codex-acp"]), true);
  assert.equal(
    isCodexAcpBackend("yarn", ["dlx", "@agentclientprotocol/codex-acp"]),
    true,
  );
  assert.equal(isCodexAcpBackend("pnpm", ["run", "codex-acp"]), false);
  assert.equal(
    isCodexAcpBackend("pnpm", ["dlx", "@agentclientprotocol/codex-acp-evil"]),
    false,
  );
  assert.equal(isCodexAcpBackend("yarn", ["exec", "codex-acp"]), false);
  assert.equal(isCodexAcpBackend("pnpm", []), false);
  assert.equal(isCodexAcpBackend("pnpm", ["dlx"]), false);
  assert.equal(isCodexAcpBackend("pnpm", ["--silent", "dlx", "codex-acp"]), false);
  assert.equal(isCodexAcpBackend("pnpm", ["exec", "extra", "codex-acp"]), false);
  assert.equal(
    isCodexAcpBackend("pnpm", ["dlx", "@agentclientprotocol/claude-agent-acp"]),
    false,
  );
  assert.equal(isCodexAcpBackend("unknown-runner", ["codex-acp"]), false);
  assert.equal(isCodexAcpBackend("yarn", ["--silent", "dlx", "codex-acp"]), false);
  assert.equal(isCodexAcpBackend("pnpm.cmd", ["dlx", "codex-acp"]), false);
  assert.equal(isCodexAcpBackend("yarn.cmd", ["dlx", "codex-acp"]), false);
  assert.equal(isCodexAcpBackend("node", ["./unknown-agent.js"]), false);
  let codexConfigFactoryCalls = 0;
  const claudeConfig = createBackendModelSelectionConfig(
      "claude-agent-acp",
      [],
      backendEnv,
      () => {
        codexConfigFactoryCalls += 1;
        throw new Error("Claude must not read the Codex allowlist");
      },
  );
  assert.equal(claudeConfig?.strategy, "acp-advertised");
  if (claudeConfig?.strategy === "acp-advertised") {
    assert.equal(claudeConfig.requiredDefaultModel, undefined);
  }
  assert.equal(codexConfigFactoryCalls, 0);
  assert.equal(
    claudeConfig?.store.filePath,
    path.join(root, "channels", "wechat", "model-selection.json"),
  );
  assert.ok(createBackendModelSelectionConfig("codex-acp", [], backendEnv));
  const requiredClaudeConfig = createBackendModelSelectionConfig(
    "claude-agent-acp",
    [],
    {
      ...backendEnv,
      WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "opus",
      WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX: "Opus 5",
    },
  );
  assert.equal(requiredClaudeConfig?.strategy, "acp-advertised");
  if (requiredClaudeConfig?.strategy === "acp-advertised") {
    assert.equal(requiredClaudeConfig.requiredDefaultModel, "opus");
    assert.equal(
      requiredClaudeConfig.requiredDefaultModelDescriptionPrefix,
      "Opus 5",
    );
  }
  assert.throws(
    () => createBackendModelSelectionConfig(
      "claude-agent-acp",
      [],
      {
        ...backendEnv,
        WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "bad model",
      },
    ),
    /REQUIRED_DEFAULT_MODEL is invalid/,
  );
  assert.throws(
    () => createBackendModelSelectionConfig(
      "claude-agent-acp",
      [],
      {
        ...backendEnv,
        WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX: "Opus 5",
      },
    ),
    /REQUIRED_DEFAULT_MODEL is required/,
  );

  const botA = new ModelSelectionStore(
    path.join(root, "bot-a", "channels", "wechat", "model-selection.json"),
    allowlist,
  );
  const botB = new ModelSelectionStore(
    path.join(root, "bot-b", "channels", "wechat", "model-selection.json"),
    allowlist,
  );

  assert.equal(botA.read(), undefined);
  botA.write("gpt-5.6-terra[high]");
  botB.write("gpt-5.6-luna[medium]");
  assert.equal(botA.read(), "gpt-5.6-terra[high]");
  assert.equal(botB.read(), "gpt-5.6-luna[medium]");
  assert.equal(fs.statSync(botA.filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(botA.filePath)).mode & 0o077, 0);
  assert.throws(() => botA.write("gpt-5.6-unknown[high]"), /not in the allowlist/);
  assert.throws(() => botA.write("gpt-5.6-sol"), /invalid concrete model id/);

  fs.chmodSync(botA.filePath, 0o644);
  assert.throws(() => botA.read(), /permissions must be 0600/);
  fs.chmodSync(botA.filePath, 0o600);

  fs.writeFileSync(botA.filePath, '{"version":1,"modelId":"../escape"}\n', {
    mode: 0o600,
  });
  assert.throws(() => botA.read(), /state schema is invalid|invalid model id/);

  fs.unlinkSync(botA.filePath);
  fs.symlinkSync(botB.filePath, botA.filePath);
  assert.throws(() => botA.read(), /single regular file/);
  assert.throws(() => botA.write("gpt-5.6-sol[medium]"), /single regular file/);

  const dynamic = new ModelSelectionStore(
    path.join(root, "claude", "channels", "wechat", "model-selection.json"),
    { strategy: "acp-advertised" },
  );
  dynamic.write("claude-opus-fixture");
  assert.equal(dynamic.read(), "claude-opus-fixture");
  dynamic.clear();
  assert.equal(dynamic.read(), undefined);
  dynamic.clear();
  assert.throws(() => dynamic.write("../bad model"), /invalid ACP model id/);

  dynamic.write("claude-stale-fixture");
  fs.chmodSync(dynamic.filePath, 0o644);
  assert.throws(() => dynamic.clear(), /permissions must be 0600/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("wechat model selection store tests passed");
