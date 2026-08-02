import assert from "node:assert/strict";

import { pollBackoffMs } from "./monitor.js";

/**
 * The poll cursor is not advanced on failure, so a transient blip delays
 * messages instead of losing them — the only cost is how long we stay away.
 * Observed 2026-08-02: 146/160 transients recovered on the first retry, yet
 * three in a row jumped straight to 30s (~36s of silence to the user).
 */
assert.equal(pollBackoffMs(1), 2_000);
assert.equal(pollBackoffMs(2), 4_000);
assert.equal(pollBackoffMs(3), 8_000);
assert.equal(pollBackoffMs(4), 16_000);

// Capped — a dead endpoint must not be hammered, and the wait cannot grow
// without bound.
assert.equal(pollBackoffMs(5), 30_000);
assert.equal(pollBackoffMs(50), 30_000);

// Defensive: a zero/negative counter still yields the base delay, never 0
// (a 0ms sleep would spin the loop against a failing endpoint).
assert.equal(pollBackoffMs(0), 2_000);
assert.equal(pollBackoffMs(-3), 2_000);

// The regression this fixes: a three-failure blip used to cost 2+2+30=34s.
const blip = pollBackoffMs(1) + pollBackoffMs(2) + pollBackoffMs(3);
assert.equal(blip, 14_000);
assert.ok(blip < 34_000);

console.log("wechat poll backoff tests passed");

// ── delivery de-dup: one message must reach the agent exactly once ─────────
{
  const { messageDeliveryId } = await import("./monitor.js");

  // Server id wins when present; seq is the fallback and is scoped per user so
  // two users' seq 7 are different deliveries.
  assert.equal(messageDeliveryId({ message_id: 42, seq: 7 }), "m:42");
  assert.equal(messageDeliveryId({ seq: 7, from_user_id: "u1" }), "s:u1:7");
  assert.notEqual(
    messageDeliveryId({ seq: 7, from_user_id: "u1" }),
    messageDeliveryId({ seq: 7, from_user_id: "u2" }),
  );
  // The same delivery always yields the same id — that is the whole mechanism.
  assert.equal(
    messageDeliveryId({ message_id: 42, from_user_id: "u1", create_time_ms: 1 }),
    messageDeliveryId({ message_id: 42, from_user_id: "u1", create_time_ms: 2 }),
  );
  // Unidentifiable ⇒ empty ⇒ caller delivers. A rare duplicate beats dropping
  // a message we cannot name.
  assert.equal(messageDeliveryId({}), "");
  assert.equal(messageDeliveryId({ from_user_id: "u1" }), "");
}

console.log("wechat delivery de-dup tests passed");

// ── the deduper the LOOP uses (not a re-implementation) ────────────────────
{
  const { DeliveryDeduper } = await import("./monitor.js");
  const d = new DeliveryDeduper();

  // The observed defect: an empty get_updates_buf re-serves the same batch.
  const msg = { message_id: 1001, from_user_id: "u1" };
  assert.equal(d.admit(msg), true, "first delivery goes through");
  assert.equal(d.admit(msg), false, "the re-served copy must be suppressed");
  assert.equal(d.admit({ ...msg }), false, "identity, not object reference");

  // Distinct messages are unaffected.
  assert.equal(d.admit({ message_id: 1002, from_user_id: "u1" }), true);
  // Unidentifiable messages always pass — never drop what we cannot name.
  assert.equal(d.admit({ from_user_id: "u1" }), true);
  assert.equal(d.admit({ from_user_id: "u1" }), true);

  // Memory is bounded, and the newest entries survive the eviction.
  const small = new DeliveryDeduper(10);
  for (let i = 0; i < 100; i++) small.admit({ message_id: i, from_user_id: "u" });
  assert.ok(small.size <= 10, `deduper must stay bounded, got ${small.size}`);
  assert.equal(small.admit({ message_id: 99, from_user_id: "u" }), false, "the newest id must still be remembered");
}

console.log("wechat delivery deduper tests passed");
