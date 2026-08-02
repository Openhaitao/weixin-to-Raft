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
  const items = findMediaItems([textItem("看看"), imageItem("a"), fileItem("b.pdf"), imageItem("c")] as never);
  assert.equal(items.length, 3, "text is not media; all three attachments kept");
  assert.equal((items[0] as never as { image_item: { media: { full_url: string } } }).image_item.media.full_url, "https://cdn/a");
  assert.equal((items[2] as never as { image_item: { media: { full_url: string } } }).image_item.media.full_url, "https://cdn/c");
}
// A voice note that already carries a transcript needs no download.
assert.equal(findMediaItems([voiceTranscribed()] as never).length, 0);
assert.equal(findMediaItems([]).length, 0);
assert.equal(findMediaItems(undefined).length, 0);

// ── cap: fail-closed, never an unbounded fetch ─────────────────────────────
{
  const many = Array.from({ length: MAX_MEDIA_ITEMS + 5 }, (_, i) => imageItem(`i${i}`));
  assert.equal(findMediaItems(many as never).length, MAX_MEDIA_ITEMS);
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
