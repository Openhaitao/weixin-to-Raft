/**
 * Which inbound messages have already been HANDLED — persisted, so it survives
 * a sidecar restart.
 *
 * WHY: the poll cursor only advances when the server returns a non-empty
 * get_updates_buf. An empty buf re-serves the same batch, so a message can be
 * delivered to the agent twice — the user sees one message answered twice, the
 * two replies talking past each other (observed 2026-08-02). An in-memory guard
 * is not enough: the case that actually bit us was a RESTART, where a fresh
 * process has no memory of what the previous one already answered.
 *
 * COMMIT SEMANTICS: an id is recorded only after the message was successfully
 * handled. Recording on arrival would suppress the server's redelivery of a
 * message we failed to answer — trading duplicates for silent loss, which is
 * strictly worse: nobody ever learns about the message that vanished.
 */

import fs from "node:fs";
import path from "node:path";

/** Bounded history. Enough to cover a redelivery burst, small enough to write. */
const DEFAULT_MAX_IDS = 500;

interface LedgerFile {
  version: 1;
  ids: string[];
}

/**
 * Stable per-delivery identity. `message_id` is the server's own id; `seq`
 * (scoped per sender) is the fallback. Returns "" when neither is usable — the
 * caller then delivers, because a rare duplicate beats dropping a real message
 * we cannot name.
 */
export function messageDeliveryId(msg: {
  message_id?: number;
  seq?: number;
  from_user_id?: string;
}): string {
  if (msg.message_id != null) return `m:${msg.message_id}`;
  // seq is only unique WITHIN a sender, so it is not an identity without one:
  // two unidentified senders both at seq 7 would collide and the second
  // message would be dropped. No identity ⇒ deliver.
  const sender = String(msg.from_user_id ?? "").trim();
  if (msg.seq != null && sender) return `s:${sender}:${msg.seq}`;
  return "";
}

export class DeliveryLedger {
  private ids: string[] = [];
  private set = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly maxIds: number = DEFAULT_MAX_IDS,
  ) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<LedgerFile>;
      if (parsed?.version === 1 && Array.isArray(parsed.ids)) {
        this.ids = parsed.ids.filter((id): id is string => typeof id === "string").slice(-this.maxIds);
        this.set = new Set(this.ids);
      }
    } catch {
      // Missing or corrupt ledger ⇒ start empty. Worst case is one duplicate,
      // never a dropped message.
    }
  }

  /** Has this delivery already been handled successfully? */
  has(msg: Parameters<typeof messageDeliveryId>[0]): boolean {
    const id = messageDeliveryId(msg);
    return id ? this.set.has(id) : false;
  }

  /** Record a delivery as handled. Call ONLY after successful processing. */
  commit(msg: Parameters<typeof messageDeliveryId>[0]): void {
    this.commitId(messageDeliveryId(msg));
  }

  /**
   * Commit a known id. Used to retire an EARLIER message whose effect this
   * turn just made durable (stashed material that has now been answered) —
   * without it, a consumed photo is re-served after a restart and comes back
   * as pending material for an unrelated question.
   */
  commitId(id: string): void {
    if (!id || this.set.has(id)) return;
    this.ids.push(id);
    this.set.add(id);
    if (this.ids.length > this.maxIds) {
      const dropped = this.ids.splice(0, this.ids.length - this.maxIds);
      for (const d of dropped) this.set.delete(d);
    }
    this.persist();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const body: LedgerFile = { version: 1, ids: this.ids };
      fs.writeFileSync(tmp, JSON.stringify(body), "utf-8");
      // Atomic replace: a torn ledger would be parsed as empty on restart,
      // which silently reopens the duplicate window.
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Persistence is best-effort: failing to write must not stop the reply
      // that was just produced.
    }
  }

  get size(): number { return this.ids.length; }
}

/**
 * Ledger path for ONE account, alongside its sync-buf state.
 *
 * The account id must stay in the filename: accounts share a state directory,
 * so a single shared ledger would let one account's message_id suppress
 * another's identical id — a cross-account silent drop.
 */
export function getDeliveryLedgerPath(syncBufPath: string): string {
  const base = path.basename(syncBufPath).replace(/\.sync\.json$/i, "");
  const account = base || "default";
  return path.join(path.dirname(syncBufPath), `${account}.delivery-ledger.json`);
}
