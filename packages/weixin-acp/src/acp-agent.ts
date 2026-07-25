import type {
  Agent,
  AgentModelMenu,
  AgentModelSelection,
  ChatRequest,
  ChatResponse,
} from "weixin-agent-sdk";
import type { SessionId, SessionModelState } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import {
  AcpConnection,
  type AcpClient,
  type AcpConnectionLike,
} from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { WechatProjectCreateFlow } from "./linearos/project-create-flow.js";
import { WechatProjectFollowupFlow } from "./linearos/project-followup-flow.js";
import { ResponseCollector } from "./response-collector.js";
import { isBareMaterialRequest, isMaterialInboxCancelText, MaterialInbox } from "./linearos/material-inbox.js";
import { parseConcreteModelId } from "./model-selection.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

function isEmptyUserContentError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /user messages must have non-empty content/.test(message);
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnectionLike;
  private sessions = new Map<string, SessionId>();
  private sessionModels = new Map<string, SessionModelState | null>();
  private systemPromptSent = new Set<string>();
  private projectCreateFlow = new WechatProjectCreateFlow();
  private projectFollowupFlow = new WechatProjectFollowupFlow();
  private materialInbox = new MaterialInbox();
  private options: AcpAgentOptions;
  private modelQueue: Promise<void> = Promise.resolve();

  readonly getModelMenu?: (conversationId: string) => Promise<AgentModelMenu>;
  readonly selectModel?: (
    conversationId: string,
    modelId: string,
  ) => Promise<AgentModelSelection>;

  constructor(
    options: AcpAgentOptions,
    connectionFactory: (onExit: () => void) => AcpConnectionLike = (onExit) =>
      new AcpConnection(options, onExit),
  ) {
    this.options = options;
    this.connection = connectionFactory(() => {
      log("subprocess exited, clearing session cache");
      this.clearAcpSessionState();
    });
    if (options.modelSelection) {
      this.getModelMenu = (conversationId) => this.getModelMenuImpl(conversationId);
      this.selectModel = (conversationId, modelId) =>
        this.selectModelImpl(conversationId, modelId);
    }
  }

  async shouldShowTyping(request: ChatRequest): Promise<boolean> {
    if (isBareMaterialRequest(request)) {
      return (await this.projectCreateFlow.isAwaitingMaterial(request.conversationId))
        || (await this.projectFollowupFlow.isAwaitingMaterial(request.conversationId));
    }
    return true;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Followup routes first: its command/state must win over the create flow's
    // awaiting_material state (which would otherwise swallow /项目跟进 as material).
    // The inbox is passed so a bare-material-then-command sequence sees its material.
    const followupRouted = await this.projectFollowupFlow.beforeAgent(request, { materialInbox: this.materialInbox });
    if (followupRouted.handled) {
      return await this.runFollowupModelTurns(request, followupRouted.response);
    }
    request = followupRouted.request;

    const routed = await this.projectCreateFlow.beforeAgent(request);
    if (routed.handled) {
      return routed.response;
    }
    request = routed.request;

    if (isBareMaterialRequest(request)) {
      this.materialInbox.stash(request);
      log(`material inbox stashed conversation=${request.conversationId} media=${request.media?.type || "text"}`);
      return {};
    }

    let mergedMaterial = false;
    if (this.materialInbox.has(request.conversationId)) {
      if (isMaterialInboxCancelText(request.text)) {
        this.materialInbox.clear(request.conversationId);
        log(`material inbox cleared conversation=${request.conversationId}`);
      } else {
        request = this.materialInbox.mergeInto(request);
        mergedMaterial = true;
        log(`material inbox merged conversation=${request.conversationId}`);
      }
    }

    if (mergedMaterial) {
      const rerouted = await this.projectCreateFlow.beforeAgent(request, { allowNaturalProjectCreate: true });
      if (rerouted.handled) {
        return rerouted.response;
      }
      request = rerouted.request;
    }

    const conn = await this.connection.ensureReady();

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(request.conversationId, conn, request.timing?.receivedAt);

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    if (this.options.systemPrompt && !this.systemPromptSent.has(request.conversationId)) {
      blocks.unshift({
        type: "text",
        text: [
          "[System instructions]",
          this.options.systemPrompt.trim(),
          "",
          "[User message]",
        ].join("\n"),
      });
      this.systemPromptSent.add(request.conversationId);
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);
    const promptStart = Date.now();
    try {
      await conn.prompt({ sessionId, prompt: blocks });
    } catch (err) {
      this.sessions.delete(request.conversationId);
      this.systemPromptSent.delete(request.conversationId);
      if (isEmptyUserContentError(err)) {
        log(`prompt failed: empty user content; reset conversation=${request.conversationId}`);
        return {
          text: "我刚才收到的这条文件消息没有成功进入模型。请重新发一次文件，或补一句要我用这个文件做什么。",
        };
      }
      throw err;
    } finally {
      this.connection.unregisterCollector(sessionId);
    }
    const promptDoneAt = Date.now();
    const firstContentAt = collector.getFirstContentAt();
    log(`[timing] acp_prompt_to_first_token_ms=${firstContentAt === null ? "n/a" : firstContentAt - promptStart}`);
    log(`[timing] acp_prompt_to_final_reply_ms=${promptDoneAt - promptStart}`);

    let response = await this.projectFollowupFlow.afterAgent(request, await collector.toResponse());
    response = await this.runFollowupModelTurns(request, response);
    response = await this.projectCreateFlow.afterAgent(request, response);
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  /** Drive the followup flow's deterministic model turns: stage-2 analysis after a
   * handled beforeAgent (progress receipt already composed) and the flow's single
   * silent self-heal retry. Bounded to 2 turns; the flow's own retryCount guard
   * keeps this from looping regardless. */
  private async runFollowupModelTurns(request: ChatRequest, initial: ChatResponse): Promise<ChatResponse> {
    let prompt = this.projectFollowupFlow.takePendingModelPrompt(request.conversationId);
    if (!prompt) return initial;

    const conn = await this.connection.ensureReady();
    const sessionId = await this.getOrCreateSession(request.conversationId, conn);
    let final: ChatResponse = {};
    let turns = 0;
    while (prompt && turns < 2) {
      turns += 1;
      const collector = new ResponseCollector();
      this.connection.registerCollector(sessionId, collector);
      try {
        await conn.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
      } catch (err) {
        this.connection.unregisterCollector(sessionId);
        this.sessions.delete(request.conversationId);
        this.systemPromptSent.delete(request.conversationId);
        log(`followup model turn failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
          ...initial,
          text: [initial.text, "生成跟进草稿的模型调用失败了，本次未写库。请重新发送 /项目跟进 + 材料。"].filter(Boolean).join("\n\n"),
        };
      }
      this.connection.unregisterCollector(sessionId);
      final = await this.projectFollowupFlow.afterAgent(request, await collector.toResponse());
      prompt = this.projectFollowupFlow.takePendingModelPrompt(request.conversationId);
    }
    const text = [initial.text, final.text].filter(Boolean).join("\n\n");
    return { ...final, text };
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: AcpClient,
    receivedAt?: number,
  ): Promise<SessionId> {
    return this.withModelLock(() =>
      this.getOrCreateSessionUnlocked(conversationId, conn, receivedAt)
    );
  }

  private async getOrCreateSessionUnlocked(
    conversationId: string,
    conn: AcpClient,
    receivedAt?: number,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
    const createdAt = Date.now();
    if (receivedAt !== undefined) {
      log(`[timing] first_wechat_message_to_acp_session_created_ms=${createdAt - receivedAt}`);
    }
    log(`session created: ${res.sessionId}`);
    this.sessions.set(conversationId, res.sessionId);
    this.sessionModels.set(conversationId, res.models ?? null);

    const persistedModelId = this.options.modelSelection?.store.read();
    if (persistedModelId) {
      try {
        this.assertModelAvailable(res.models, persistedModelId);
        await this.connection.setSessionModel(res.sessionId, persistedModelId);
        this.sessionModels.set(
          conversationId,
          this.withCurrentModel(res.models, persistedModelId),
        );
        log(`restored model selection: ${persistedModelId}`);
      } catch (err) {
        this.resetAcpRuntime();
        throw err;
      }
    }
    return res.sessionId;
  }

  private async getModelMenuImpl(conversationId: string): Promise<AgentModelMenu> {
    return this.withModelLock(async () => {
      const connection = await this.connection.ensureReady();
      await this.getOrCreateSessionUnlocked(conversationId, connection);
      const state = this.sessionModels.get(conversationId);
      const options = this.allowedModels(state);
      return {
        currentModelId: this.normalizeCurrentModelId(state?.currentModelId, options),
        options,
      };
    });
  }

  private async selectModelImpl(
    conversationId: string,
    modelId: string,
  ): Promise<AgentModelSelection> {
    return this.withModelLock(async () => {
      const config = this.options.modelSelection;
      if (!config || !config.allowlist.includes(modelId)) {
        throw new Error("model is not in the bot allowlist");
      }

      const connection = await this.connection.ensureReady();
      const sessionId = await this.getOrCreateSessionUnlocked(conversationId, connection);
      const option = this.allowedModels(this.sessionModels.get(conversationId))
        .find((candidate) => candidate.id === modelId);
      if (!option) {
        throw new Error("model is not available from the candidate ACP");
      }
      const concreteModelId = this.resolveConcreteModelId(
        this.sessionModels.get(conversationId),
        modelId,
      );

      try {
        await this.connection.setSessionModel(sessionId, concreteModelId);
        config.store.write(concreteModelId);
      } catch (err) {
        this.resetAcpRuntime();
        throw err;
      }

      this.resetAcpRuntime();
      log(`model selection persisted: ${concreteModelId}; ACP will restart lazily`);
      return { modelId, name: option.name };
    });
  }

  private allowedModels(state: SessionModelState | null | undefined): AgentModelMenu["options"] {
    const allowlist = this.options.modelSelection?.allowlist ?? [];
    if (!state) return [];
    return allowlist.flatMap((modelId) => {
      const concreteModelId = this.tryResolveConcreteModelId(state, modelId);
      if (!concreteModelId) return [];
      const model = state.availableModels.find(
        (candidate) => candidate.modelId === concreteModelId,
      );
      if (!model) return [];
      const effort = parseConcreteModelId(concreteModelId).effort;
      const effortSuffix = ` (${effort})`;
      return [{
        id: modelId,
        name: model.name.endsWith(effortSuffix)
          ? model.name.slice(0, -effortSuffix.length)
          : model.name,
        description: model.description ?? undefined,
      }];
    });
  }

  private normalizeCurrentModelId(
    currentModelId: string | undefined,
    options: AgentModelMenu["options"],
  ): string | undefined {
    if (!currentModelId) return undefined;
    let family: string;
    try {
      family = parseConcreteModelId(currentModelId).family;
    } catch {
      return undefined;
    }
    return options.find((option) => option.id === family)?.id;
  }

  private assertModelAvailable(
    state: SessionModelState | null | undefined,
    modelId: string,
  ): void {
    let family: string;
    try {
      family = parseConcreteModelId(modelId).family;
    } catch {
      throw new Error(`persisted model ID is invalid: ${modelId}`);
    }
    if (
      !state
      || !this.options.modelSelection?.allowlist.includes(family)
      || !state.availableModels.some((model) => model.modelId === modelId)
    ) {
      throw new Error(`persisted model is unavailable from the candidate ACP: ${modelId}`);
    }
  }

  private resolveConcreteModelId(
    state: SessionModelState | null | undefined,
    family: string,
  ): string {
    const modelId = this.tryResolveConcreteModelId(state, family);
    if (!modelId) {
      throw new Error(`model family is unavailable from the candidate ACP: ${family}`);
    }
    return modelId;
  }

  private tryResolveConcreteModelId(
    state: SessionModelState | null | undefined,
    family: string,
  ): string | undefined {
    if (!state) return undefined;
    let currentEffort: string | undefined;
    try {
      currentEffort = parseConcreteModelId(state.currentModelId).effort;
    } catch {
      currentEffort = undefined;
    }

    const variants = state.availableModels.flatMap((model) => {
      try {
        const concrete = parseConcreteModelId(model.modelId);
        return concrete.family === family ? [concrete] : [];
      } catch {
        return [];
      }
    });
    return (
      variants.find((model) => model.effort === currentEffort)
      ?? variants.find((model) => model.effort === "medium")
      ?? variants[0]
    )?.modelId;
  }

  private withCurrentModel(
    state: SessionModelState | null | undefined,
    modelId: string,
  ): SessionModelState {
    if (!state) {
      throw new Error("candidate ACP did not advertise model state");
    }
    return { ...state, currentModelId: modelId };
  }

  private async withModelLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.modelQueue;
    let release!: () => void;
    this.modelQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private clearAcpSessionState(): void {
    this.sessions.clear();
    this.sessionModels.clear();
    this.systemPromptSent.clear();
  }

  private resetAcpRuntime(): void {
    this.clearAcpSessionState();
    this.connection.dispose();
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
      this.sessionModels.delete(conversationId);
    }
    this.systemPromptSent.delete(conversationId);
    this.materialInbox.clear(conversationId);
    void this.projectCreateFlow.reset(conversationId);
    void this.projectFollowupFlow.reset(conversationId);
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.clearAcpSessionState();
    this.connection.dispose();
  }
}
