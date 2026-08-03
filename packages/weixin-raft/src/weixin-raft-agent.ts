import { randomUUID } from "node:crypto";

import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

import type { RaftAgentOption } from "./config.js";
import type { RaftTransport } from "./raft-cli.js";
import { BridgeStateStore, type PendingOutbound } from "./state.js";

export interface WeixinRaftAgentOptions {
  /** Called on every /agent request, so the menu always reflects the live
   * server roster (static configurations wrap a constant list here). */
  listAgents: () => Promise<RaftAgentOption[]>;
  defaultAgent: string;
  store: BridgeStateStore;
  transport: Pick<RaftTransport, "sendToAgent">;
  /**
   * Wait for the target agent's reply so it can be returned as the direct
   * answer to this message — no acknowledgment, no sender label, WeChat's
   * typing indicator covers the wait. On timeout the chat turn ends silently
   * and the pump later delivers the reply labeled `来自 @xxx`. When absent
   * (e.g. tests), forwards fall back to an explicit acknowledgment text.
   */
  awaitReply?: (agent: string, timeoutMs: number) => Promise<PendingOutbound | null>;
  syncWaitMs?: number;
}

const MENU_DESCRIPTION_MAX = 24;

function menuLine(agent: RaftAgentOption, index: number, current: string): string {
  const selected = agent.name.toLowerCase() === current.toLowerCase();
  let description = agent.description ?? "";
  if (description.length > MENU_DESCRIPTION_MAX) {
    description = `${description.slice(0, MENU_DESCRIPTION_MAX)}…`;
  }
  return `${index + 1}. ${agent.name}${selected ? " ✓" : ""}${description ? ` — ${description}` : ""}`;
}

export class WeixinRaftAgent implements Agent {
  constructor(private readonly options: WeixinRaftAgentOptions) {}

  private async menu(conversationId: string): Promise<ChatResponse> {
    const current = this.options.store.selectedAgent(conversationId, this.options.defaultAgent);
    let agents: RaftAgentOption[];
    try {
      agents = await this.options.listAgents();
    } catch {
      return { text: "暂时拿不到 agent 列表（Raft 连接失败），稍后再试 /agent。" };
    }
    if (agents.length === 0) {
      return { text: "服务器上没有可选的 agent。" };
    }
    this.options.store.openAgentMenu(conversationId, agents.map((agent) => agent.name));
    return {
      text: [
        `当前 Agent：${current}`,
        "",
        ...agents.map((agent, index) => menuLine(agent, index, current)),
        "",
        "回复编号，或发送 /agent 名称；选择在 5 分钟内有效。",
      ].join("\n"),
    };
  }

  private select(conversationId: string, name: string): ChatResponse {
    this.options.store.selectAgent(conversationId, name);
    return { text: `已切换到 ${name}。下一条消息会交给它。` };
  }

  private async selectByName(conversationId: string, input: string): Promise<ChatResponse> {
    const requested = input.trim().replace(/^@/, "");
    let agents: RaftAgentOption[];
    try {
      agents = await this.options.listAgents();
    } catch {
      return { text: "暂时拿不到 agent 列表（Raft 连接失败），稍后再试 /agent。" };
    }
    const match = agents.find((agent) => agent.name.toLowerCase() === requested.toLowerCase());
    if (!match) {
      return { text: `没有找到「${input.trim()}」。请发送 /agent 查看可选列表。` };
    }
    return this.select(conversationId, match.name);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const text = request.text.trim();

    const choice = this.options.store.consumeAgentMenuChoice(request.conversationId, text);
    if (choice) {
      const name = choice.options[choice.index - 1];
      if (!name) {
        return { text: `没有编号 ${choice.index}。请重新发送 /agent 查看列表。` };
      }
      return this.select(request.conversationId, name);
    }

    const command = text.match(/^\/agent(?:\s+(.+))?$/i);
    if (command) {
      return command[1]
        ? this.selectByName(request.conversationId, command[1])
        : this.menu(request.conversationId);
    }

    if (request.media || request.mediaItems?.length) {
      return {
        text: "当前 MVP 先支持文字消息，附件还没有转入 Raft。请先把问题用文字发给我。",
      };
    }
    if (!text) return { text: "请发送文字，或发送 /agent 选择 Raft Agent。" };

    // The SDK does not persist silent turns in its delivery ledger, so a
    // restart can redeliver an already-forwarded WeChat message. Answer the
    // redelivery silently instead of forwarding twice.
    if (request.deliveryId && this.options.store.hasForwardedDelivery(request.deliveryId)) {
      return { silent: true };
    }

    const selected = this.options.store.selectedAgent(request.conversationId, this.options.defaultAgent);
    const requestId = randomUUID().slice(0, 8);
    const body = [
      `【微信桥接请求 ${requestId}】`,
      "来源：海涛绑定的微信；发送身份是微信桥接 Agent，不是 Raft 人类账号。",
      "请直接回复此 DM；你的回复会由桥接程序转回微信。",
      "",
      text,
    ].join("\n");
    try {
      await this.options.transport.sendToAgent(selected, body);
    } catch {
      return {
        text: `发送给 ${selected} 失败，它可能已下线或改名。发送 /agent 重新选择，或稍后再试。`,
      };
    }
    if (request.deliveryId) this.options.store.recordForwardedDelivery(request.deliveryId);

    if (!this.options.awaitReply) {
      return { text: `已发送给 ${selected}，它的回复会自动回到这里。` };
    }
    const reply = await this.options.awaitReply(selected, this.options.syncWaitMs ?? 90_000);
    // In-time answer becomes the direct reply — the conversation reads as
    // talking to the agent itself.
    if (reply) return { text: reply.text };
    // On timeout, total silence would be indistinguishable from a lost
    // message (seen live: a message forwarded to an agent whose computer was
    // asleep produced no response at all). Say so once; if the answer does
    // come later the pump delivers it labeled.
    return {
      text: `${selected} 暂时没有回应，可能正忙或它所在的电脑不在线。它的回答完成后会自动出现；急的话可以发 /agent 换一只。`,
    };
  }

  clearSession(conversationId: string): void {
    this.options.store.clearPendingMenu(conversationId);
  }
}
