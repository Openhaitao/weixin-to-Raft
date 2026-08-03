import type { ChatResponse } from "weixin-agent-sdk";

import type { RaftTransport } from "./raft-cli.js";
import { isAllowedAgentReply, parseRaftMessages } from "./raft-message.js";
import { BridgeStateStore } from "./state.js";

export interface ReplyPumpOptions {
  agents: string[];
  pollIntervalMs: number;
  store: BridgeStateStore;
  transport: Pick<RaftTransport, "checkInbox" | "startWakeLoop">;
  sendWeixin: (response: ChatResponse) => Promise<void>;
  onError?: (error: unknown) => void;
}

export class ReplyPump {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopWake: (() => void) | undefined;
  private draining = false;
  private drainAgain = false;

  constructor(private readonly options: ReplyPumpOptions) {}

  async start(): Promise<void> {
    await this.flushPending();
    this.stopWake = this.options.transport.startWakeLoop(() => { void this.drainNow(); });
    this.timer = setInterval(() => { void this.drainNow(); }, this.options.pollIntervalMs);
    await this.drainNow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopWake?.();
    this.stopWake = undefined;
  }

  async drainNow(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      const output = await this.options.transport.checkInbox();
      for (const message of parseRaftMessages(output)) {
        if (!isAllowedAgentReply(message, this.options.agents)) continue;
        this.options.store.enqueueOutbound({
          messageId: message.messageId,
          sender: message.sender,
          text: message.text,
          receivedAt: message.time,
        });
      }
      await this.flushPending();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.draining = false;
      if (this.drainAgain) {
        this.drainAgain = false;
        void this.drainNow();
      }
    }
  }

  private async flushPending(): Promise<void> {
    for (const item of this.options.store.pendingOutbound()) {
      try {
        await this.options.sendWeixin({
          text: [`来自 @${item.sender}：`, "", item.text].join("\n"),
        });
        this.options.store.markOutboundDelivered(item.messageId);
      } catch (error) {
        this.options.onError?.(error);
        return;
      }
    }
  }
}
