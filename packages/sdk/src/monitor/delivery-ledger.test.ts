import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { monitorWeixinProvider } from "./monitor.js";
import { DeliveryLedger, getDeliveryLedgerPath, messageDeliveryId } from "../storage/delivery-ledger.js";

/**
 * These drive the REAL poll loop. Asserting a ledger class in isolation would
 * stay green if the loop stopped consulting it — which is exactly how an
 * earlier version of this fix shipped a guard nothing called.
 */
const roots: string[] = [];
const scratch = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  roots.push(r);
  return r;
};

const msg = (id: number) => ({
  message_id: id,
  from_user_id: "u1",
  item_list: [{ type: 1, text_item: { text: `hello ${id}` } }],
});

/** Run the loop until it has served `rounds` responses, then abort. */
async function runLoop(opts: {
  ledgerPath: string;
  responses: Array<{ msgs: unknown[]; get_updates_buf?: string }>;
  onProcess: (m: { message_id?: number }) => Promise<{ delivered: boolean; durable?: boolean; commitIds?: string[] }>;
}) {
  const ac = new AbortController();
  let i = 0;
  await monitorWeixinProvider({
    baseUrl: "https://api", cdnBaseUrl: "https://cdn", token: "t",
    accountId: `acct-${path.basename(opts.ledgerPath)}`,
    agent: { chat: async () => ({}) } as never,
    abortSignal: ac.signal,
    log: () => {},
    __ledgerPathForTest: opts.ledgerPath,
    __getUpdatesForTest: (async () => {
      const r = opts.responses[i++];
      if (!r) { ac.abort(); return { ret: 0, msgs: [] }; }
      // Empty get_updates_buf on purpose: this is the condition that re-serves
      // the same batch and caused one message to be answered twice.
      return { ret: 0, msgs: r.msgs, get_updates_buf: r.get_updates_buf ?? "" };
    }) as never,
    __processOneMessageForTest: (async (m: { message_id?: number }) => {
      const o = await opts.onProcess(m);
      // A reply that was sent is durable unless the case says otherwise.
      return { durable: o.delivered, commitIds: [], ...o };
    }) as never,
  } as never).catch(() => {});
}

try {
  // ── a re-served batch must not be handled twice ──────────────────────────
  {
    const ledgerPath = path.join(scratch(), "ledger.json");
    const handled: number[] = [];
    await runLoop({
      ledgerPath,
      responses: [{ msgs: [msg(1)] }, { msgs: [msg(1)] }],   // same message twice
      onProcess: async (m) => { handled.push(m.message_id!); return { delivered: true }; },
    });
    assert.deepEqual(handled, [1], `the re-served copy must be skipped, got ${JSON.stringify(handled)}`);
  }

  // ── survives a RESTART: a fresh loop must not re-answer ──────────────────
  {
    const ledgerPath = path.join(scratch(), "ledger.json");
    const first: number[] = [];
    await runLoop({
      ledgerPath, responses: [{ msgs: [msg(7)] }],
      onProcess: async (m) => { first.push(m.message_id!); return { delivered: true }; },
    });
    assert.deepEqual(first, [7]);

    // New process, same account: the ledger is the ONLY thing carrying over.
    const second: number[] = [];
    await runLoop({
      ledgerPath, responses: [{ msgs: [msg(7)] }],
      onProcess: async (m) => { second.push(m.message_id!); return { delivered: true }; },
    });
    assert.deepEqual(second, [], "a restart must not re-answer an already-handled message");
  }

  // ── a FAILED turn stays eligible for redelivery ──────────────────────────
  {
    const ledgerPath = path.join(scratch(), "ledger.json");
    const attempts: number[] = [];
    await runLoop({
      ledgerPath,
      responses: [{ msgs: [msg(9)] }, { msgs: [msg(9)] }],
      onProcess: async (m) => {
        attempts.push(m.message_id!);
        // First attempt fails (agent or send error), second succeeds.
        return { delivered: attempts.length > 1 };
      },
    });
    assert.deepEqual(attempts, [9, 9], "a failed turn must NOT be committed — redelivery is the user's second chance");

    // And once it finally succeeded, it is committed.
    const after = new DeliveryLedger(ledgerPath);
    assert.equal(after.has(msg(9)), true, "the successful attempt must be committed");
  }

  // ── unnameable messages are always delivered ─────────────────────────────
  {
    const ledgerPath = path.join(scratch(), "ledger.json");
    const handled: number[] = [];
    const anon = { from_user_id: "u1", item_list: [] } as never;
    await runLoop({
      ledgerPath,
      responses: [{ msgs: [anon] }, { msgs: [anon] }],
      onProcess: async () => { handled.push(0); return { delivered: true }; },
    });
    assert.equal(messageDeliveryId({ from_user_id: "u1" }), "");
    assert.equal(handled.length, 2, "a message we cannot name must never be dropped");
  }

  console.log("wechat delivery ledger loop tests passed");
} finally {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
}

// --- identity namespace: an id is only an id within its own account ---
{
  const dir = scratch();
  const a = getDeliveryLedgerPath(path.join(dir, "acct-A.sync.json"));
  const b = getDeliveryLedgerPath(path.join(dir, "acct-B.sync.json"));
  assert.notEqual(a, b, "two accounts must not share one ledger file");

  // The SAME message_id, as two different accounts would legitimately see it.
  const shared = { message_id: 123, from_user_id: "u1" } as never;
  const other = { message_id: 999, from_user_id: "u1" } as never;

  const la = new DeliveryLedger(a);
  const lb = new DeliveryLedger(b);
  la.commit(shared);
  assert.equal(la.has(shared), true);
  assert.equal(
    lb.has(shared),
    false,
    "account A's message_id must not suppress account B's identical id",
  );
  // and each persists independently
  lb.commit(other);
  assert.equal(new DeliveryLedger(a).has(other), false);
  assert.equal(new DeliveryLedger(b).has(other), true);
  console.log("account-scoped ledger: no cross-account suppression");
}

// --- seq is not an identity without a sender ---
{
  assert.equal(
    messageDeliveryId({ seq: 7 } as never),
    "",
    "seq alone must not be an identity: two unknown senders both at seq 7 collide",
  );
  assert.equal(messageDeliveryId({ seq: 7, from_user_id: "" } as never), "");
  assert.equal(messageDeliveryId({ seq: 7, from_user_id: "   " } as never), "");
  assert.equal(messageDeliveryId({ seq: 7, from_user_id: "u1" } as never), "s:u1:7");
  // the collision this prevents, stated as the ledger sees it
  // What that prevents, as the ledger sees it: committing an unnameable
  // message must be a no-op, so the next one is still delivered.
  const l = new DeliveryLedger(path.join(scratch(), "l.json"));
  const anon = { seq: 7 } as never;
  l.commit(anon);
  assert.equal(l.size, 0, "an unnameable message must never enter the ledger");
  assert.equal(l.has(anon), false, "and must therefore always be delivered");
  console.log("seq identity requires a non-empty sender");
}

// --- volatile effects must not be recorded durably --------------------------
// A silent material stash lives only in memory. If the loop had committed it to
// the persistent ledger, a restart would lose the material AND suppress the
// server's redelivery of it: the photo vanishes and no reply is ever sent.
{
  const dir = scratch();
  const ledgerPath = path.join(dir, "vol.json");

  // Round 1: the message is stashed (handled, but not durably).
  const stashed: number[] = [];
  await runLoop({
    ledgerPath,
    responses: [{ msgs: [msg(41)] }, { msgs: [], get_updates_buf: "" }],
    onProcess: async (m) => {
      stashed.push(m.message_id!);
      return { delivered: true, durable: false };
    },
  });
  assert.deepEqual(stashed, [41], "an in-process re-serve must not stash twice");
  assert.equal(
    fs.existsSync(ledgerPath) && JSON.parse(fs.readFileSync(ledgerPath, "utf-8")).ids.includes("m:41"),
    false,
    "a volatile effect must never reach the persistent ledger",
  );

  // Restart: the in-memory material AND the in-memory record are gone together,
  // so the redelivery is re-stashed exactly once and stays recoverable.
  const afterRestart: number[] = [];
  await runLoop({
    ledgerPath,
    responses: [{ msgs: [msg(41)] }, { msgs: [], get_updates_buf: "" }],
    onProcess: async (m) => {
      afterRestart.push(m.message_id!);
      return { delivered: true, durable: false };
    },
  });
  assert.deepEqual(
    afterRestart,
    [41],
    "after a restart the material must be recoverable, and appear exactly once",
  );
  console.log("volatile stash: not persisted, recoverable once after restart");
}

// --- consumed material must not come back to life ---------------------------
{
  const dir = scratch();
  const ledgerPath = path.join(dir, "consume.json");

  // The command that consumes the stashed material replies for real, and
  // retires the material's source message along with itself.
  await runLoop({
    ledgerPath,
    responses: [{ msgs: [msg(50)] }, { msgs: [], get_updates_buf: "" }],
    onProcess: async () => ({ delivered: true, durable: true, commitIds: ["m:41"] }),
  });

  // Restart, and the server re-serves the ORIGINAL material message.
  const revived: number[] = [];
  await runLoop({
    ledgerPath,
    responses: [{ msgs: [msg(41)] }, { msgs: [], get_updates_buf: "" }],
    onProcess: async (m) => {
      revived.push(m.message_id!);
      return { delivered: true, durable: false };
    },
  });
  assert.deepEqual(
    revived,
    [],
    "material already consumed and answered must not be re-stashed after a restart",
  );
  console.log("consumed material: retired durably, does not revive");
}

// The blocks after the first `finally` register their own scratch roots.
process.on("exit", () => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
