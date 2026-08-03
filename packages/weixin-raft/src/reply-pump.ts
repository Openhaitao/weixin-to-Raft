import type { ChatResponse } from "weixin-agent-sdk";

import type { RaftTransport } from "./raft-cli.js";
import { isAllowedAgentReply, parseRaftMessages } from "./raft-message.js";
import { BridgeStateStore, type PendingOutbound } from "./state.js";

export interface ReplyPumpOptions {
  excludeAgents?: string[];
  pollIntervalMs: number;
  store: BridgeStateStore;
  transport: Pick<RaftTransport, "checkInbox" | "startWakeLoop">;
  sendWeixin: (response: ChatResponse) => Promise<void>;
  onError?: (error: unknown) => void;
}

interface Claim {
  agent: string;
  resolve: (item: PendingOutbound | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ReplyPump {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopWake: (() => void) | undefined;
  private draining = false;
  private drainAgain = false;
  private claims: Claim[] = [];

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
    for (const claim of this.claims.splice(0)) {
      clearTimeout(claim.timer);
      claim.resolve(null);
    }
  }

  /**
   * Wait for the next reply from `agent`, up to `timeoutMs`. While a claim is
   * open, a matching reply is handed to the claimer (and marked delivered)
   * instead of being sent to WeChat by the pump — this is what lets a
   * forwarded message be answered synchronously, as a direct reply, rather
   * than as a labeled asynchronous drop. Resolves null on timeout.
   */
  claimNextReply(agent: string, timeoutMs: number): Promise<PendingOutbound | null> {
    return new Promise((resolve) => {
      const claim: Claim = {
        agent,
        resolve,
        timer: setTimeout(() => {
          this.claims = this.claims.filter((item) => item !== claim);
          resolve(null);
        }, timeoutMs),
      };
      this.claims.push(claim);
      // A matching reply may already be sitting in the durable queue (e.g.
      // it arrived between forward and claim); serve it immediately.
      for (const pending of this.options.store.pendingOutbound()) {
        if (this.settleClaims(pending)) break;
      }
    });
  }

  /** Give `item` to the oldest matching claim. True if a claim took it. */
  private settleClaims(item: PendingOutbound): boolean {
    const index = this.claims.findIndex(
      (claim) => claim.agent.toLowerCase() === item.sender.toLowerCase(),
    );
    if (index === -1) return false;
    const [claim] = this.claims.splice(index, 1);
    clearTimeout(claim!.timer);
    this.options.store.markOutboundDelivered(item.messageId);
    claim!.resolve(item);
    return true;
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
        if (!isAllowedAgentReply(message, this.options.excludeAgents ?? [])) continue;
        if (this.options.store.hasRaftMessage(message.messageId)) continue;
        const item: PendingOutbound = {
          messageId: message.messageId,
          sender: message.sender,
          text: message.text,
          receivedAt: message.time,
        };
        this.options.store.enqueueOutbound(item);
        this.settleClaims(item);
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
      // A claim settlement can race this loop: skip anything a waiting
      // chat() has taken (or is about to take) as its direct reply.
      if (!this.options.store.hasPendingOutbound(item.messageId)) continue;
      if (this.claims.some((claim) => claim.agent.toLowerCase() === item.sender.toLowerCase())) {
        continue;
      }
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
