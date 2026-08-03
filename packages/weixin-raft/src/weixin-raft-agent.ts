import { randomUUID } from "node:crypto";

import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

import type { RaftAgentOption } from "./config.js";
import type { RaftTransport } from "./raft-cli.js";
import { BridgeStateStore } from "./state.js";

export interface WeixinRaftAgentOptions {
  agents: RaftAgentOption[];
  defaultAgent: string;
  store: BridgeStateStore;
  transport: Pick<RaftTransport, "sendToAgent">;
}

export class WeixinRaftAgent implements Agent {
  constructor(private readonly options: WeixinRaftAgentOptions) {}

  private resolveAgent(input: string): RaftAgentOption | undefined {
    const trimmed = input.trim().replace(/^@/, "");
    if (/^\d+$/.test(trimmed)) return this.options.agents[Number(trimmed) - 1];
    return this.options.agents.find(
      (agent) => agent.name.toLowerCase() === trimmed.toLowerCase(),
    );
  }

  private menu(conversationId: string): ChatResponse {
    const current = this.options.store.selectedAgent(conversationId, this.options.defaultAgent);
    this.options.store.openAgentMenu(conversationId);
    const choices = this.options.agents.map((agent, index) => {
      const selected = agent.name.toLowerCase() === current.toLowerCase();
      return `${index + 1}. ${agent.name}${selected ? " ✓" : ""}`
        + `${agent.description ? ` — ${agent.description}` : ""}`;
    });
    return {
      text: [
        `当前 Agent：${current}`,
        "",
        ...choices,
        "",
        "回复编号，或发送 /agent 名称；选择在 5 分钟内有效。",
      ].join("\n"),
    };
  }

  private select(conversationId: string, input: string): ChatResponse {
    const agent = this.resolveAgent(input);
    if (!agent) {
      return {
        text: `没有找到「${input.trim()}」。请重新发送 /agent 查看可选列表。`,
      };
    }
    this.options.store.selectAgent(conversationId, agent.name);
    return { text: `已切换到 ${agent.name}。下一条消息会交给它。` };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const text = request.text.trim();
    const pendingNumber = this.options.store.consumeAgentMenuNumber(request.conversationId, text);
    if (pendingNumber !== undefined) return this.select(request.conversationId, String(pendingNumber));

    const command = text.match(/^\/agent(?:\s+(.+))?$/i);
    if (command) {
      return command[1] ? this.select(request.conversationId, command[1]) : this.menu(request.conversationId);
    }

    if (request.media || request.mediaItems?.length) {
      return {
        text: "当前 MVP 先支持文字消息，附件还没有转入 Raft。请先把问题用文字发给我。",
      };
    }
    if (!text) return { text: "请发送文字，或发送 /agent 选择 Raft Agent。" };

    const selected = this.options.store.selectedAgent(request.conversationId, this.options.defaultAgent);
    const requestId = randomUUID().slice(0, 8);
    const body = [
      `【微信桥接请求 ${requestId}】`,
      "来源：海涛绑定的微信；发送身份是微信桥接 Agent，不是 Raft 人类账号。",
      "请直接回复此 DM；你的回复会由桥接程序转回微信。",
      "",
      text,
    ].join("\n");
    await this.options.transport.sendToAgent(selected, body);
    return { text: `已发送给 ${selected}，它的回复会自动回到这里。` };
  }

  clearSession(conversationId: string): void {
    this.options.store.clearPendingMenu(conversationId);
  }
}
