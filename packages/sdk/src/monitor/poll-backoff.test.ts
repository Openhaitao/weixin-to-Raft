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
