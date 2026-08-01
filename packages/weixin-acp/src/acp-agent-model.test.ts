import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionId } from "@agentclientprotocol/sdk";

import { AcpAgent } from "./acp-agent.js";
import type { AcpClient, AcpConnectionLike } from "./acp-connection.js";
import {
  createBackendModelSelectionConfig,
  ModelSelectionStore,
} from "./model-selection.js";
import { ResponseCollector } from "./response-collector.js";
import type { SessionModelState } from "./types.js";

const allowlist = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const advertisedModels: SessionModelState = {
  currentModelId: "gpt-5.6-sol[high]",
  availableModels: [
    { modelId: "gpt-5.6-luna[medium]", name: "Luna (medium)" },
    { modelId: "gpt-5.6-luna[high]", name: "Luna (high)" },
    { modelId: "unreviewed-model[high]", name: "Unreviewed (high)" },
    { modelId: "gpt-5.6-sol[medium]", name: "Sol (medium)" },
    { modelId: "gpt-5.6-sol[high]", name: "Sol (high)" },
    { modelId: "gpt-5.6-terra[medium]", name: "Terra (medium)" },
    { modelId: "gpt-5.6-terra[high]", name: "Terra (high)" },
  ],
};

class FakeAcpConnection implements AcpConnectionLike {
  readonly events: string[] = [];
  readonly prompts: Array<{ sessionId: SessionId; text: string[] }> = [];
  disposeCount = 0;
  setModelCount = 0;
  private sequence = 0;
  private collectors = new Map<SessionId, ResponseCollector>();
  constructor(private readonly models: SessionModelState = advertisedModels) {}

  private readonly client: AcpClient = {
    newSession: async () => {
      const sessionId = `session-${++this.sequence}`;
      this.events.push(`new:${sessionId}`);
      return {
        sessionId,
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: this.models.currentModelId,
          options: this.models.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
            description: model.description,
          })),
        }],
      };
    },
    prompt: async ({ sessionId, prompt }) => {
      this.events.push(`prompt:${sessionId}`);
      this.prompts.push({
        sessionId,
        text: prompt
          .filter((block: { type: string }) => block.type === "text")
          .map((block: { type: string; text?: string }) => block.text || ""),
      });
      this.collectors.get(sessionId)?.handleUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        },
      });
      return { stopReason: "end_turn" };
    },
    setSessionConfigOption: async ({ sessionId, configId, value }) => {
      assert.equal(configId, "model");
      assert.equal(typeof value, "string");
      await this.setSessionModel(sessionId, String(value));
      return { configOptions: [] };
    },
  };

  async ensureReady(): Promise<AcpClient> {
    this.events.push("ready");
    return this.client;
  }

  registerCollector(sessionId: SessionId, collector: ResponseCollector): void {
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    this.collectors.delete(sessionId);
  }

  async setSessionModel(sessionId: SessionId, modelId: string): Promise<void> {
    this.setModelCount += 1;
    if (!this.models.availableModels.some((model) => model.modelId === modelId)) {
      throw new Error("ACP rejected model");
    }
    this.events.push(`set:${sessionId}:${modelId}`);
  }

  dispose(): void {
    this.disposeCount += 1;
    this.collectors.clear();
    this.events.push("dispose");
  }
}

function createAgent(
  store: ModelSelectionStore,
  connection: FakeAcpConnection,
): AcpAgent {
  return new AcpAgent(
    {
      command: "fake-acp",
      modelSelection: { strategy: "codex-family", allowlist, store },
    },
    () => connection,
  );
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-acp-model-test-"));

try {
  const store = new ModelSelectionStore(
    path.join(root, "bot-a", "channels", "wechat", "model-selection.json"),
    allowlist,
  );
  const connection = new FakeAcpConnection();
  const agent = createAgent(store, connection);

  assert.ok(agent.getModelMenu);
  assert.ok(agent.selectModel);
  const menu = await agent.getModelMenu("conversation-a");
  assert.equal(menu.currentModelId, "gpt-5.6-sol");
  assert.deepEqual(menu.options.map((option) => option.id), allowlist);
  assert.equal(menu.options.some((option) => option.id === "unreviewed-model"), false);

  await assert.rejects(
    () => agent.selectModel!("conversation-a", "unreviewed-model"),
    /not in the bot allowlist/,
  );
  const selected = await agent.selectModel("conversation-a", "gpt-5.6-terra");
  assert.deepEqual(selected, { modelId: "gpt-5.6-terra", name: "Terra" });
  assert.equal(store.read(), "gpt-5.6-terra[high]");
  assert.equal(connection.disposeCount, 1);

  const beforeChat = connection.events.length;
  const response = await agent.chat({ conversationId: "conversation-a", text: "hello" });
  assert.equal(response.text, "ok");
  assert.deepEqual(connection.events.slice(beforeChat), [
    "ready",
    "new:session-2",
    "set:session-2:gpt-5.6-terra[high]",
    "prompt:session-2",
  ]);

  agent.clearSession("conversation-a");
  const beforeClearedChat = connection.events.length;
  await agent.chat({ conversationId: "conversation-a", text: "after clear" });
  assert.deepEqual(connection.events.slice(beforeClearedChat), [
    "ready",
    "new:session-3",
    "set:session-3:gpt-5.6-terra[high]",
    "prompt:session-3",
  ]);
  assert.equal(store.read(), "gpt-5.6-terra[high]");

  const restartedConnection = new FakeAcpConnection();
  const restartedAgent = createAgent(store, restartedConnection);
  await restartedAgent.chat({ conversationId: "conversation-b", text: "after restart" });
  assert.deepEqual(restartedConnection.events, [
    "ready",
    "new:session-1",
    "set:session-1:gpt-5.6-terra[high]",
    "prompt:session-1",
  ]);

  const disabledAgent = new AcpAgent(
    { command: "fake-acp" },
    () => new FakeAcpConnection(),
  );
  assert.equal(disabledAgent.getModelMenu, undefined);
  assert.equal(disabledAgent.selectModel, undefined);
  assert.throws(
    () => new AcpAgent({ command: "fake-acp", memoryDir: "relative/memory" }),
    /memoryDir must be an absolute path/,
  );

  const claudeHome = path.join(root, "claude-bot");
  const claudeStatePath = path.join(
    claudeHome,
    "channels",
    "wechat",
    "model-selection.json",
  );
  const claudeModels: SessionModelState = {
    currentModelId: "claude-sonnet-fixture",
    availableModels: [
      {
        modelId: "default",
        name: "Default (recommended)",
        description: "vendor recommendation alias",
      },
      {
        modelId: "claude-sonnet-fixture",
        name: "Sonnet Fixture",
        description: "default fixture",
      },
      {
        modelId: "claude-opus-fixture",
        name: "Opus 5 Fixture",
        description: "large fixture",
      },
    ],
  };
  const requiredHome = path.join(root, "required-claude-bot");
  const requiredStatePath = path.join(
    requiredHome,
    "channels",
    "wechat",
    "model-selection.json",
  );
  const requiredConnection = new FakeAcpConnection(claudeModels);
  const requiredAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: createBackendModelSelectionConfig(
        "claude-agent-acp",
        [],
        {
          WEIXIN_AGENT_HOME: requiredHome,
          WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "claude-opus-fixture",
          WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX: "large fixture",
        },
      ),
    },
    () => requiredConnection,
  );
  const requiredMenu = await requiredAgent.getModelMenu!("required-default");
  assert.equal(requiredMenu.currentModelId, "claude-opus-fixture");
  // The vendor "default" alias contradicts the enforced fleet default and
  // must be hidden; concrete models must all survive.
  assert.deepEqual(
    requiredMenu.options.map((option) => option.id),
    ["claude-sonnet-fixture", "claude-opus-fixture"],
  );
  assert.deepEqual(requiredConnection.events, [
    "ready",
    "new:session-1",
    "set:session-1:claude-opus-fixture",
  ]);
  assert.equal(
    JSON.parse(fs.readFileSync(requiredStatePath, "utf8")).modelId,
    "claude-opus-fixture",
  );

  const missingRequiredAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: createBackendModelSelectionConfig(
        "claude-agent-acp",
        [],
        {
          WEIXIN_AGENT_HOME: path.join(root, "missing-required-claude-bot"),
          WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "claude-opus-5",
        },
      ),
    },
    () => new FakeAcpConnection(claudeModels),
  );
  await assert.rejects(
    () => missingRequiredAgent.getModelMenu!("missing-required-default"),
    /required default model is unavailable.*claude-opus-5/,
  );

  const mismatchedDescriptionAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: createBackendModelSelectionConfig(
        "claude-agent-acp",
        [],
        {
          WEIXIN_AGENT_HOME: path.join(root, "mismatched-description-claude-bot"),
          WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL: "claude-opus-fixture",
          WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX: "Opus 5",
        },
      ),
    },
    () => new FakeAcpConnection(claudeModels),
  );
  await assert.rejects(
    () => mismatchedDescriptionAgent.getModelMenu!("mismatched-description"),
    /model claude-opus-fixture is described as "large fixture"; expected prefix "Opus 5"/,
  );

  const claudeConnection = new FakeAcpConnection(claudeModels);
  let codexConfigFactoryCalls = 0;
  const claudeAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: createBackendModelSelectionConfig(
        "claude-agent-acp",
        [],
        {
          WEIXIN_AGENT_HOME: claudeHome,
          WEIXIN_AGENT_MODEL_ALLOWLIST: allowlist.join(","),
        },
        () => {
          codexConfigFactoryCalls += 1;
          throw new Error("Claude must not read the Codex allowlist");
        },
      ),
    },
    () => claudeConnection,
  );
  assert.ok(claudeAgent.getModelMenu);
  assert.ok(claudeAgent.selectModel);
  assert.equal(codexConfigFactoryCalls, 0);
  assert.equal(fs.existsSync(claudeStatePath), false);
  const claudeMenu = await claudeAgent.getModelMenu("claude-conversation");
  assert.equal(claudeMenu.currentModelId, "claude-sonnet-fixture");
  assert.deepEqual(
    claudeMenu.options,
    [
      // Without an enforced required default the vendor alias passes
      // through untouched — only the required-default path hides it.
      {
        id: "default",
        name: "Default (recommended)",
        description: "vendor recommendation alias",
      },
      {
        id: "claude-sonnet-fixture",
        name: "Sonnet Fixture",
        description: "default fixture",
      },
      {
        id: "claude-opus-fixture",
        name: "Opus 5 Fixture",
        description: "large fixture",
      },
    ],
  );
  assert.equal(
    claudeMenu.options.some((option) => option.id.startsWith("gpt-")),
    false,
  );
  await assert.rejects(
    () => claudeAgent.selectModel!("claude-conversation", "gpt-5.6-sol"),
    /not available from the candidate ACP/,
  );
  const claudeSelected = await claudeAgent.selectModel(
    "claude-conversation",
    "claude-opus-fixture",
  );
  assert.deepEqual(claudeSelected, {
    modelId: "claude-opus-fixture",
    name: "Opus 5 Fixture",
  });
  assert.equal(
    JSON.parse(fs.readFileSync(claudeStatePath, "utf8")).modelId,
    "claude-opus-fixture",
  );
  assert.equal(fs.statSync(claudeStatePath).mode & 0o777, 0o600);

  const restoredClaudeConnection = new FakeAcpConnection(claudeModels);
  const restoredClaudeAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: createBackendModelSelectionConfig(
        "claude-agent-acp",
        [],
        {
          WEIXIN_AGENT_HOME: claudeHome,
          WEIXIN_AGENT_MODEL_ALLOWLIST: allowlist.join(","),
        },
      ),
    },
    () => restoredClaudeConnection,
  );
  await restoredClaudeAgent.chat({
    conversationId: "restored-claude",
    text: "hello restored Claude",
  });
  assert.deepEqual(restoredClaudeConnection.events, [
    "ready",
    "new:session-1",
    "set:session-1:claude-opus-fixture",
    "prompt:session-1",
  ]);

  const retiredSelectionHome = path.join(root, "retired-selection-claude-bot");
  const retiredSelectionStore = new ModelSelectionStore(
    path.join(
      retiredSelectionHome,
      "channels",
      "wechat",
      "model-selection.json",
    ),
    { strategy: "acp-advertised" },
  );
  retiredSelectionStore.write("claude-retired-fixture");
  const retiredSelectionConnection = new FakeAcpConnection(claudeModels);
  const retiredSelectionAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: {
        strategy: "acp-advertised",
        requiredDefaultModel: "claude-opus-fixture",
        store: retiredSelectionStore,
      },
    },
    () => retiredSelectionConnection,
  );
  const retiredSelectionMenu = await retiredSelectionAgent.getModelMenu!(
    "retired-selection-claude",
  );
  assert.equal(retiredSelectionMenu.currentModelId, "claude-opus-fixture");
  assert.equal(retiredSelectionStore.read(), "claude-opus-fixture");
  assert.deepEqual(retiredSelectionConnection.events, [
    "ready",
    "new:session-1",
    "set:session-1:claude-opus-fixture",
  ]);

  const staleModels: SessionModelState = {
    currentModelId: "claude-sonnet-fixture",
    availableModels: [
      claudeModels.availableModels.find(
        (model) => model.modelId === "claude-sonnet-fixture",
      )!,
    ],
  };
  const staleConnection = new FakeAcpConnection(staleModels);
  const staleAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: createBackendModelSelectionConfig(
        "claude-agent-acp",
        [],
        { WEIXIN_AGENT_HOME: claudeHome },
      ),
    },
    () => staleConnection,
  );
  const staleLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    staleLogs.push(args.map(String).join(" "));
  };
  let staleResponse;
  try {
    staleResponse = await staleAgent.chat({
      conversationId: "stale-claude",
      text: "hello after retirement",
    });
  } finally {
    console.log = originalConsoleLog;
  }
  assert.match(staleResponse.text ?? "", /你之前选的型号已不可用/);
  assert.match(staleResponse.text ?? "", /ok/);
  assert.equal(
    staleLogs.some((line) =>
      line.includes("WARNING persisted model unavailable")
      && line.includes("default=claude-sonnet-fixture")
    ),
    true,
  );
  assert.equal(staleConnection.setModelCount, 0);
  assert.equal(fs.existsSync(claudeStatePath), false);
  const nextResponse = await staleAgent.chat({
    conversationId: "stale-claude",
    text: "second message",
  });
  assert.equal(nextResponse.text, "ok");

  const staleBeforeReselectStore = new ModelSelectionStore(
    claudeStatePath,
    { strategy: "acp-advertised" },
  );
  staleBeforeReselectStore.write("claude-opus-fixture");
  const reselectConnection = new FakeAcpConnection(staleModels);
  const reselectAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: {
        strategy: "acp-advertised",
        store: staleBeforeReselectStore,
      },
    },
    () => reselectConnection,
  );
  await reselectAgent.getModelMenu!("reselect-claude");
  await reselectAgent.selectModel!(
    "reselect-claude",
    "claude-sonnet-fixture",
  );
  const afterReselect = await reselectAgent.chat({
    conversationId: "reselect-claude",
    text: "selection fixed",
  });
  assert.equal(afterReselect.text, "ok");

  const unsafeStore = new ModelSelectionStore(
    claudeStatePath,
    { strategy: "acp-advertised" },
  );
  unsafeStore.write("claude-sonnet-fixture");
  fs.chmodSync(claudeStatePath, 0o644);
  const unsafeAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: {
        strategy: "acp-advertised",
        store: unsafeStore,
      },
    },
    () => new FakeAcpConnection(staleModels),
  );
  await assert.rejects(
    () => unsafeAgent.chat({
      conversationId: "unsafe-claude",
      text: "must not mask unsafe state",
    }),
    /permissions must be 0600/,
  );
  fs.chmodSync(claudeStatePath, 0o600);
  fs.unlinkSync(claudeStatePath);

  const emptyModels: SessionModelState = {
    currentModelId: "",
    availableModels: [],
  };
  const emptyAgent = new AcpAgent(
    {
      command: "claude-agent-acp",
      modelSelection: createBackendModelSelectionConfig(
        "claude-agent-acp",
        [],
        { WEIXIN_AGENT_HOME: path.join(root, "empty-claude") },
      ),
    },
    () => new FakeAcpConnection(emptyModels),
  );
  assert.deepEqual(
    await emptyAgent.getModelMenu!("empty-claude"),
    { currentModelId: undefined, options: [] },
  );

  const memoryDir = path.join(root, "memory-bot", "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "- [tea.md](tea.md) 茶偏好\n");
  fs.writeFileSync(path.join(memoryDir, "tea.md"), [
    "---",
    "name: tea",
    "description: 用户喜欢乌龙茶",
    "metadata.type: user",
    "metadata.scope: private",
    "---",
    "用户最喜欢凤凰单丛。",
  ].join("\n"));
  const memoryConnection = new FakeAcpConnection();
  const memoryAgent = new AcpAgent(
    {
      command: "fake-acp",
      memoryDir,
      systemPrompt: "persona",
    },
    () => memoryConnection,
  );
  await memoryAgent.chat({ conversationId: "memory-conversation", text: "我喜欢什么茶？" });
  assert.match(memoryConnection.prompts[0].text[0], /\[System instructions\]\npersona/);
  assert.match(memoryConnection.prompts[0].text[1], /记忆目录：/);
  assert.match(memoryConnection.prompts[0].text[1], /用户最喜欢凤凰单丛/);
  assert.equal(memoryConnection.prompts[0].text.at(-1), "我喜欢什么茶？");

  fs.writeFileSync(path.join(memoryDir, "tea.md"), [
    "---",
    "name: tea",
    "description: 用户喜欢乌龙茶",
    "metadata.type: user",
    "metadata.scope: private",
    "---",
    "用户现在最喜欢岩茶。",
  ].join("\n"));
  await memoryAgent.chat({ conversationId: "memory-conversation", text: "现在喜欢什么茶？" });
  assert.equal(memoryConnection.prompts[1].text.some((text) => text.includes("[System instructions]")), false);
  assert.match(memoryConnection.prompts[1].text[0], /用户现在最喜欢岩茶/);

  memoryAgent.clearSession("memory-conversation");
  await memoryAgent.chat({ conversationId: "memory-conversation", text: "新会话喜欢什么茶？" });
  assert.match(memoryConnection.prompts[2].text[0], /\[System instructions\]\npersona/);
  assert.match(memoryConnection.prompts[2].text[1], /用户现在最喜欢岩茶/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("wechat ACP model selection tests passed");
