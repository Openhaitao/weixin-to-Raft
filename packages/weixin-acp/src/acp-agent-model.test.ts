import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionId, SessionModelState } from "@agentclientprotocol/sdk";

import { AcpAgent } from "./acp-agent.js";
import type { AcpClient, AcpConnectionLike } from "./acp-connection.js";
import {
  createBackendModelSelectionConfig,
  ModelSelectionStore,
} from "./model-selection.js";
import { ResponseCollector } from "./response-collector.js";

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

  private readonly client: AcpClient = {
    newSession: async () => {
      const sessionId = `session-${++this.sequence}`;
      this.events.push(`new:${sessionId}`);
      return {
        sessionId,
        models: {
          ...advertisedModels,
          availableModels: advertisedModels.availableModels.map((model) => ({ ...model })),
        },
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
    unstable_setSessionModel: async ({ sessionId, modelId }) => {
      await this.setSessionModel(sessionId, modelId);
      return {};
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
    if (!advertisedModels.availableModels.some((model) => model.modelId === modelId)) {
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
      modelSelection: { allowlist, store },
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
  const claudeConnection = new FakeAcpConnection();
  let claudeStoreConstructionCount = 0;
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
          claudeStoreConstructionCount += 1;
          throw new Error("Claude must not construct model-selection state");
        },
      ),
    },
    () => claudeConnection,
  );
  assert.equal(claudeAgent.getModelMenu, undefined);
  assert.equal(claudeAgent.selectModel, undefined);
  assert.equal(claudeStoreConstructionCount, 0);
  assert.equal(fs.existsSync(claudeStatePath), false);
  await claudeAgent.chat({ conversationId: "claude-conversation", text: "hello Claude" });
  assert.deepEqual(claudeConnection.events, [
    "ready",
    "new:session-1",
    "prompt:session-1",
  ]);
  assert.equal(claudeConnection.setModelCount, 0);
  assert.equal(fs.existsSync(claudeStatePath), false);

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
