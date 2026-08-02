import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findMediaItems, MAX_MEDIA_ITEMS } from "./process-message.js";
import { normalizeChatMedia } from "../agent/interface.js";
import { convertRequestToContentBlocks } from "../../../weixin-acp/src/content-converter.js";

/**
 * A WeChat message can pack several attachments. Until 2026-08-02 the
 * selector returned exactly ONE (by type priority), so two photos, or an
 * image plus a PDF, silently lost everything after the first.
 */
const media = (over: Record<string, unknown> = {}) => ({
  full_url: "https://cdn.test/x", aes_key: "", ...over,
});
const imageItem = (n: string) => ({ type: 2, image_item: { media: media({ full_url: `https://cdn/${n}` }) } });
const fileItem = (n: string) => ({ type: 4, file_item: { file_name: n, media: media() } });
const textItem = (s: string) => ({ type: 1, text_item: { text: s } });
const voiceTranscribed = () => ({ type: 3, voice_item: { text: "已转写", media: media() } });

// ── selection: order preserved, every downloadable item kept ────────────────
{
  const { items } = findMediaItems([textItem("看看"), imageItem("a"), fileItem("b.pdf"), imageItem("c")] as never);
  assert.equal(items.length, 3, "text is not media; all three attachments kept");
  assert.equal((items[0] as never as { image_item: { media: { full_url: string } } }).image_item.media.full_url, "https://cdn/a");
  assert.equal((items[2] as never as { image_item: { media: { full_url: string } } }).image_item.media.full_url, "https://cdn/c");
}
// A voice note that already carries a transcript needs no download.
assert.equal(findMediaItems([voiceTranscribed()] as never).items.length, 0);
assert.equal(findMediaItems([]).items.length, 0);
assert.equal(findMediaItems(undefined).items.length, 0);

// ── cap: fail-closed, never an unbounded fetch ─────────────────────────────
{
  const many = Array.from({ length: MAX_MEDIA_ITEMS + 5 }, (_, i) => imageItem(`i${i}`));
  const capped = findMediaItems(many as never);
  assert.equal(capped.items.length, MAX_MEDIA_ITEMS);
  // The original count must survive the cap, so the truncation can be reported
  // instead of the extra attachments simply not existing.
  assert.equal(capped.candidateCount, MAX_MEDIA_ITEMS + 5);
}

// ── normalize: plural wins, legacy single still works, no double-count ──────
{
  const one = { type: "image" as const, filePath: "/a.jpg", mimeType: "image/jpeg" };
  const two = { type: "image" as const, filePath: "/b.png", mimeType: "image/png" };
  assert.deepEqual(normalizeChatMedia({ media: one }), [one], "legacy single must still be seen");
  assert.deepEqual(normalizeChatMedia({ media: one, mediaItems: [one, two] }), [one, two]);
  // The first item must appear exactly once even though `media` duplicates it.
  assert.equal(normalizeChatMedia({ media: one, mediaItems: [one, two] }).filter((m) => m === one).length, 1);
  assert.deepEqual(normalizeChatMedia({}), []);
}

// ── conversion: every attachment becomes its own block, in order ────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), "multi-attach-"));
try {
  const jpg = path.join(root, "one.jpg");
  const png = path.join(root, "two.png");
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));

  const blocks = await convertRequestToContentBlocks({
    conversationId: "c", text: "对比这两张",
    media: { type: "image", filePath: jpg, mimeType: "image/jpeg" },
    mediaItems: [
      { type: "image", filePath: jpg, mimeType: "image/jpeg" },
      { type: "image", filePath: png, mimeType: "image/png" },
    ],
  } as never);
  const images = blocks.filter((b) => b.type === "image");
  assert.equal(images.length, 2, "BOTH photos must reach the model");
  assert.equal((images[0] as { mimeType: string }).mimeType, "image/jpeg", "order preserved");
  assert.equal((images[1] as { mimeType: string }).mimeType, "image/png");

  // Mixed image + file.
  const pdf = path.join(root, "doc.pdf");
  fs.writeFileSync(pdf, Buffer.from("%PDF-1.7\n"));
  const mixed = await convertRequestToContentBlocks({
    conversationId: "c", text: "看看",
    mediaItems: [
      { type: "image", filePath: jpg, mimeType: "image/jpeg" },
      { type: "file", filePath: pdf, mimeType: "application/pdf", fileName: "doc.pdf" },
    ],
  } as never);
  assert.equal(mixed.filter((b) => b.type === "image").length, 1);
  assert.ok(mixed.some((b) => b.type === "text" && String((b as { text: string }).text).includes("doc.pdf")));

  // One unreadable attachment must NOT swallow the others.
  const degraded = await convertRequestToContentBlocks({
    conversationId: "c", text: "两张",
    mediaItems: [
      { type: "image", filePath: path.join(root, "missing.jpg"), mimeType: "image/jpeg" },
      { type: "image", filePath: png, mimeType: "image/png" },
    ],
  } as never);
  assert.equal(degraded.filter((b) => b.type === "image").length, 1, "the readable one still arrives");
  assert.ok(
    degraded.some((b) => b.type === "text" && String((b as { text: string }).text).includes("Attachment unavailable")),
    "the loss must be stated, not silent",
  );

  // Legacy single-attachment requests must not regress.
  const legacy = await convertRequestToContentBlocks({
    conversationId: "c", text: "一张",
    media: { type: "image", filePath: jpg, mimeType: "image/jpeg" },
  } as never);
  assert.equal(legacy.filter((b) => b.type === "image").length, 1);

  console.log("wechat multi-attachment tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── byte budget: enforced DURING download, not after ────────────────────────
{
  const { MediaBudgetExceededError } = await import("../cdn/pic-decrypt.js");
  const { downloadMediaFromItem } = await import("../media/media-download.js");
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  try {
    const big = Buffer.alloc(4096, 7);
    const globalAny = globalThis as unknown as { fetch: unknown };
    const realFetch = globalAny.fetch;
    let readBytes = 0;
    globalAny.fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            // Two chunks, so a mid-stream abort is observable.
            readBytes += 2048; c.enqueue(new Uint8Array(big.subarray(0, 2048)));
            readBytes += 2048; c.enqueue(new Uint8Array(big.subarray(2048)));
            c.close();
          },
        }),
        { status: 200 },
      );
    try {
      const saved: string[] = [];
      const res = await downloadMediaFromItem(
        { type: 2, image_item: { media: { full_url: "https://cdn/x", aes_key: "" } } } as never,
        {
          cdnBaseUrl: "https://cdn",
          saveMedia: async (b: Buffer) => {
            const p = path.join(root2, `f${saved.length}.bin`); fs.writeFileSync(p, b); saved.push(p);
            return { path: p };
          },
          log: () => {}, errLog: () => {}, label: "t",
        } as never,
        1024, // budget smaller than the payload
      );
      // Over-budget must NOT yield an attachment, and must not have written one.
      assert.equal(res.decryptedPicPath, undefined, "over-budget attachment must not be delivered");
      assert.equal(saved.length, 0, "over-budget attachment must not be written to disk");
      assert.ok(MediaBudgetExceededError, "budget error type is exported for callers");
    } finally {
      globalAny.fetch = realFetch;
    }
  } finally {
    fs.rmSync(root2, { recursive: true, force: true });
  }
}

console.log("wechat attachment budget tests passed");

// ── the loss must reach the AGENT, not just a log line ─────────────────────
{
  const { processOneMessage } = await import("./process-message.js");
  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "notice-"));
  try {
    const seen: Array<{ text: string; mediaItems?: unknown[] }> = [];
    const agent = {
      chat: async (req: { text: string; mediaItems?: unknown[] }) => {
        seen.push({ text: req.text, mediaItems: req.mediaItems });
        return {};
      },
    };
    const globalAny = globalThis as unknown as { fetch: unknown };
    const realFetch = globalAny.fetch;
    // Every CDN read fails, so every attachment is lost.
    globalAny.fetch = async () => { throw new Error("cdn down"); };
    try {
      await processOneMessage(
        {
          from_user_id: "u1",
          item_list: [
            { type: 1, text_item: { text: "对比这两张" } },
            { type: 2, image_item: { media: { full_url: "https://cdn/a", aes_key: "" } } },
            { type: 2, image_item: { media: { full_url: "https://cdn/b", aes_key: "" } } },
          ],
        } as never,
        {
          accountId: "acct", agent: agent as never, baseUrl: "https://api",
          cdnBaseUrl: "https://cdn", log: () => {}, errLog: () => {},
        } as never,
      );
    } finally {
      globalAny.fetch = realFetch;
    }

    assert.equal(seen.length, 1, "one inbound message is still exactly one agent turn");
    const text = seen[0].text;
    // The defect being fixed: the model used to see only "对比这两张" and would
    // reason as if both photos were present.
    assert.ok(text.includes("对比这两张"), "original text preserved");
    assert.ok(text.includes("[附件缺失说明]"), "the agent must be told attachments are missing");
    assert.ok(text.includes("不要假设它们的内容"), "and told not to invent their contents");
    assert.ok(!seen[0].mediaItems?.length, "no attachment was delivered");

    console.log("attachment loss notice reaches the agent");
  } finally {
    fs.rmSync(root3, { recursive: true, force: true });
  }
}

// ── the PRODUCTION save path, hit directly ────────────────────────────────
{
  // Testing the shared helper was not enough: deleting the CALL inside
  // saveMediaBuffer still left it green, which is exactly the original defect
  // ("saveMediaBuffer ignores maxBytes"). The wiring is what must be pinned.
  const { saveMediaBuffer } = await import("./process-message.js");
  const { MediaBudgetExceededError } = await import("../cdn/pic-decrypt.js");

  const subdir = `budget-wiring-${process.pid}-${Date.now()}`;
  const dir = path.join(os.tmpdir(), "weixin-agent/media", subdir);

  await assert.rejects(
    () => saveMediaBuffer(Buffer.alloc(2048), "audio/wav", subdir, 1024),
    (err: unknown) => err instanceof MediaBudgetExceededError,
    "saveMediaBuffer must refuse a buffer larger than its budget",
  );
  assert.equal(fs.existsSync(dir), false, "the refused save must not even create its directory");

  // Exactly at the budget still writes — the gate must not be over-tight.
  const ok = await saveMediaBuffer(Buffer.alloc(1024, 9), "audio/wav", subdir, 1024);
  assert.ok(fs.existsSync(ok.path), "an in-budget buffer must still be written");
  assert.equal(fs.statSync(ok.path).size, 1024);
  fs.rmSync(dir, { recursive: true, force: true });
}


// ── count cap is visible on the REAL path, not just in the helper ──────────
{
  const { processOneMessage } = await import("./process-message.js");
  const seen: string[] = [];
  const globalAny = globalThis as unknown as { fetch: unknown };
  const realFetch = globalAny.fetch;
  globalAny.fetch = async () => { throw new Error("cdn down"); };
  try {
    await processOneMessage(
      {
        from_user_id: "u2",
        item_list: [
          { type: 1, text_item: { text: "都看一下" } },
          ...Array.from({ length: 14 }, (_, i) => ({
            type: 2, image_item: { media: { full_url: `https://cdn/${i}`, aes_key: "" } },
          })),
        ],
      } as never,
      {
        accountId: "a", agent: { chat: async (r: { text: string }) => { seen.push(r.text); return {}; } } as never,
        baseUrl: "https://api", cdnBaseUrl: "https://cdn", log: () => {}, errLog: () => {},
      } as never,
    );
  } finally {
    globalAny.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes("超出单条消息上限"), "the 5 attachments over the cap must be stated to the agent");
}

console.log("attachment save-gate and count-cap visibility tests passed");
