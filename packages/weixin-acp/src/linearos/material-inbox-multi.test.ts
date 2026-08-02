import assert from "node:assert/strict";

import { MaterialInbox, isBareMaterialRequest } from "./material-inbox.js";

/**
 * Multi-attachment semantics of the material inbox. Order is the whole point
 * when the user says "compare these two" — an earlier version pushed
 * slice(1) before the first item, turning [a,b,c] into [b,c,a].
 */
const img = (n: string) => ({ type: "image" as const, filePath: `/tmp/${n}.jpg`, mimeType: "image/jpeg" });
const audio = () => ({ type: "audio" as const, filePath: "/tmp/v.wav", mimeType: "audio/wav" });

// ── order preserved across a multi-attachment message ──────────────────────
{
  const inbox = new MaterialInbox();
  inbox.stash({
    conversationId: "c1", text: "",
    mediaItems: [img("a"), img("b"), img("c")],
  } as never);
  const merged = inbox.mergeInto({ conversationId: "c1", text: "对比一下" } as never);
  const body = String(merged.text);
  const ia = body.indexOf("a.jpg"), ib = body.indexOf("b.jpg"), ic = body.indexOf("c.jpg");
  assert.ok(ia >= 0 && ib >= 0 && ic >= 0, "all three attachments must be listed");
  assert.ok(ia < ib && ib < ic, `order must be a,b,c — got a@${ia} b@${ib} c@${ic}`);
}

// ── audio first, image second: still recognised as bare material ────────────
{
  // Only the first attachment used to be inspected, so an audio-led message
  // was misclassified and its photo never stashed.
  assert.equal(
    isBareMaterialRequest({ conversationId: "c", text: "", mediaItems: [audio(), img("x")] } as never),
    true,
  );
  // Text alongside attachments is a trigger turn, not bare material.
  assert.equal(
    isBareMaterialRequest({ conversationId: "c", text: "看看这个", mediaItems: [img("x")] } as never),
    false,
  );
  // Legacy single-media requests must behave exactly as before.
  assert.equal(isBareMaterialRequest({ conversationId: "c", text: "", media: img("x") } as never), true);
}

// ── the 9th attachment must be reachable, not truncated away ───────────────
{
  const inbox = new MaterialInbox();
  inbox.stash({
    conversationId: "c2", text: "",
    mediaItems: Array.from({ length: 9 }, (_, i) => img(`n${i}`)),
  } as never);
  const body = String(inbox.mergeInto({ conversationId: "c2", text: "整理" } as never).text);
  for (let i = 0; i < 9; i++) {
    assert.ok(body.includes(`n${i}.jpg`), `attachment n${i} must be reachable in the merged block`);
  }
}

console.log("material inbox multi-attachment tests passed");

// ── accumulation across MESSAGES must stay reachable, and truncation visible ─
{
  const inbox = new MaterialInbox();
  // Two messages of 9 attachments each: under the old fixed list of 8 the
  // second batch was unreachable in the block meant to surface it.
  for (const batch of ["p", "q"]) {
    inbox.stash({
      conversationId: "c3", text: "",
      mediaItems: Array.from({ length: 9 }, (_, i) => img(`${batch}${i}`)),
    } as never);
  }
  const body = String(inbox.mergeInto({ conversationId: "c3", text: "整理" } as never).text);
  // The box ceiling keeps the most recent; everything it still holds is listed.
  for (let i = 0; i < 9; i++) {
    assert.ok(body.includes(`q${i}.jpg`), `most recent batch item q${i} must be reachable`);
  }
  // Nothing is presented as complete when it is not.
  const held = (body.match(/\.jpg/g) ?? []).length;
  assert.ok(held >= 9, `expected at least the latest batch, got ${held}`);
}

// ── exceeding the box ceiling must SAY so, not quietly show a subset ────────
{
  const inbox = new MaterialInbox();
  for (let b = 0; b < 5; b++) {
    inbox.stash({
      conversationId: "c4", text: "",
      mediaItems: Array.from({ length: 9 }, (_, i) => img(`b${b}n${i}`)),
    } as never);
  }
  const body = String(inbox.mergeInto({ conversationId: "c4", text: "整理" } as never).text);
  assert.ok(
    body.includes("因超出缓存上限已丢弃"),
    "an evicted material must be stated, never silently missing",
  );
}

console.log("material inbox accumulation tests passed");
