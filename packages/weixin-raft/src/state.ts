import fs from "node:fs";
import path from "node:path";

export interface PendingOutbound {
  messageId: string;
  sender: string;
  text: string;
  receivedAt: string;
}

interface PendingMenu {
  expiresAt: number;
}

interface StoredState {
  version: 1;
  selectionByConversation: Record<string, string>;
  pendingMenuByConversation: Record<string, PendingMenu>;
  deliveredRaftMessageIds: string[];
  pendingOutbound: PendingOutbound[];
}

const EMPTY_STATE: StoredState = {
  version: 1,
  selectionByConversation: {},
  pendingMenuByConversation: {},
  deliveredRaftMessageIds: [],
  pendingOutbound: [],
};

export class BridgeStateStore {
  private state: StoredState;
  private readonly filePath: string;

  constructor(
    stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.filePath = path.join(stateDir, "state.json");
    this.state = this.load();
  }

  private load(): StoredState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<StoredState>;
      return {
        version: 1,
        selectionByConversation: parsed.selectionByConversation ?? {},
        pendingMenuByConversation: parsed.pendingMenuByConversation ?? {},
        deliveredRaftMessageIds: parsed.deliveredRaftMessageIds ?? [],
        pendingOutbound: parsed.pendingOutbound ?? [],
      };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
  }

  selectedAgent(conversationId: string, fallback: string): string {
    return this.state.selectionByConversation[conversationId] ?? fallback;
  }

  selectAgent(conversationId: string, agent: string): void {
    this.state.selectionByConversation[conversationId] = agent;
    delete this.state.pendingMenuByConversation[conversationId];
    this.save();
  }

  openAgentMenu(conversationId: string, ttlMs = 5 * 60_000): void {
    this.state.pendingMenuByConversation[conversationId] = { expiresAt: this.now() + ttlMs };
    this.save();
  }

  consumeAgentMenuNumber(conversationId: string, text: string): number | undefined {
    const pending = this.state.pendingMenuByConversation[conversationId];
    if (!pending) return undefined;
    if (pending.expiresAt <= this.now()) {
      delete this.state.pendingMenuByConversation[conversationId];
      this.save();
      return undefined;
    }
    if (!/^\d+$/.test(text.trim())) return undefined;
    delete this.state.pendingMenuByConversation[conversationId];
    this.save();
    return Number(text.trim());
  }

  clearPendingMenu(conversationId: string): void {
    if (!(conversationId in this.state.pendingMenuByConversation)) return;
    delete this.state.pendingMenuByConversation[conversationId];
    this.save();
  }

  hasRaftMessage(messageId: string): boolean {
    return this.state.deliveredRaftMessageIds.includes(messageId)
      || this.state.pendingOutbound.some((item) => item.messageId === messageId);
  }

  enqueueOutbound(item: PendingOutbound): void {
    if (this.hasRaftMessage(item.messageId)) return;
    this.state.pendingOutbound.push(item);
    this.save();
  }

  pendingOutbound(): PendingOutbound[] {
    return this.state.pendingOutbound.map((item) => ({ ...item }));
  }

  markOutboundDelivered(messageId: string): void {
    this.state.pendingOutbound = this.state.pendingOutbound.filter(
      (item) => item.messageId !== messageId,
    );
    this.state.deliveredRaftMessageIds.push(messageId);
    if (this.state.deliveredRaftMessageIds.length > 2_000) {
      this.state.deliveredRaftMessageIds = this.state.deliveredRaftMessageIds.slice(-2_000);
    }
    this.save();
  }
}
