import assert from "node:assert/strict";

import { sniffImageMime, getExtensionFromMime } from "./mime.js";

/**
 * WeChat's CDN hands us a decrypted buffer with no filename and no
 * content-type. Before 2026-08-02 that meant every inbound photo was saved as
 * `.bin`, and a model that only receives the path cannot tell a `.bin` is an
 * image — a two-image turn left the second photo unreadable.
 */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const gif89 = Buffer.from("GIF89a-rest", "ascii");
const webp = Buffer.concat([
  Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"),
]);
const heic = Buffer.concat([
  Buffer.alloc(4), Buffer.from("ftyp", "ascii"), Buffer.from("heic", "ascii"),
]);
const bmp = Buffer.from([0x42, 0x4d, 0x00, 0x00]);

assert.equal(sniffImageMime(jpeg), "image/jpeg");
assert.equal(sniffImageMime(png), "image/png");
assert.equal(sniffImageMime(gif89), "image/gif");
assert.equal(sniffImageMime(webp), "image/webp");
assert.equal(sniffImageMime(heic), "image/heic");
assert.equal(sniffImageMime(bmp), "image/bmp");

// Non-images and truncated buffers must not be claimed as images.
assert.equal(sniffImageMime(Buffer.from("%PDF-1.7", "ascii")), null);
assert.equal(sniffImageMime(Buffer.from([0x00, 0x01, 0x02])), null);
assert.equal(sniffImageMime(Buffer.alloc(0)), null);
// A RIFF container that is not WEBP (e.g. WAV) is not an image.
assert.equal(
  sniffImageMime(Buffer.concat([
    Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii"),
  ])),
  null,
);

// The whole point: a sniffed type yields a real extension, not `.bin`.
for (const buf of [jpeg, png, gif89, webp, bmp]) {
  const mime = sniffImageMime(buf);
  assert.ok(mime, "expected a sniffed mime");
  assert.notEqual(getExtensionFromMime(mime), ".bin");
}

console.log("wechat image mime sniffing tests passed");
