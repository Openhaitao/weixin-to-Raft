import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { WechatProjectCreateFlow } from "./linearos/project-create-flow.js";
import { ResponseCollector } from "./response-collector.js";
import { isBareMaterialRequest, isMaterialInboxCancelText, MaterialInbox } from "./linearos/material-inbox.js";

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
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private systemPromptSent = new Set<string>();
  private projectCreateFlow = new WechatProjectCreateFlow();
  private materialInbox = new MaterialInbox();
  private options: AcpAgentOptions;

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.connection = new AcpConnection(options, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
      this.systemPromptSent.clear();
    });
  }

  async shouldShowTyping(request: ChatRequest): Promise<boolean> {
    if (isBareMaterialRequest(request)) {
      return this.projectCreateFlow.isAwaitingMaterial(request.conversationId);
    }
    return true;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
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

    const response = await this.projectCreateFlow.afterAgent(request, await collector.toResponse());
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
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
    return res.sessionId;
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
    }
    this.systemPromptSent.delete(conversationId);
    this.materialInbox.clear(conversationId);
    void this.projectCreateFlow.reset(conversationId);
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.systemPromptSent.clear();
    this.connection.dispose();
  }
}
