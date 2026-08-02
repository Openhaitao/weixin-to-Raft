import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { downloadMediaFromItem } from "./media-download.js";
import { getExtensionFromMime, sniffImageMime } from "./mime.js";

/**
 * PIPELINE tests, not helper tests. The previous round only proved
 * sniffImageMime in isolation, which is precisely why two defects survived:
 * HEIC sniffed correctly but still saved as `.bin` (no extension mapping), and
 * an unknown buffer was relabelled `image/jpeg` on the real path even though
 * the helper honestly returned null. A helper assertion is not a path proof.
 *
 * These drive downloadMediaFromItem with a stub CDN and a real saveMedia, then
 * assert on what actually lands on disk and in the media descriptor.
 */
const roots: string[] = [];
function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "img-pipeline-"));
  roots.push(root);
  return root;
}

/** Real saveMedia semantics: extension comes from the content type. */
function makeSaveMedia(dir: string) {
  return async (buffer: Buffer, contentType?: string) => {
    const ext = contentType ? getExtensionFromMime(contentType) : ".bin";
    const p = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    fs.writeFileSync(p, buffer);
    return { path: p };
  };
}

async function runImage(buf: Buffer) {
  const dir = scratch();
  const logs: string[] = [];
  const item = {
    type: 2 /* MessageItemType.IMAGE */,
    image_item: { media: { full_url: "https://cdn.test/img", aes_key: "" } },
  } as never;
  const globalAny = globalThis as unknown as { fetch: unknown };
  const realFetch = globalAny.fetch;
  globalAny.fetch = async () => new Response(new Uint8Array(buf), { status: 200 });
  try {
    return {
      result: await downloadMediaFromItem(item, {
        cdnBaseUrl: "https://cdn.test",
        saveMedia: makeSaveMedia(dir),
        log: (m: string) => logs.push(m),
        errLog: (m: string) => logs.push(m),
        label: "test",
      }),
      logs,
    };
  } finally {
    globalAny.fetch = realFetch;
  }
}

try {
  // ── HEIC: sniffed AND saved with a real extension (the mapping gap) ────────
  const heic = Buffer.concat([
    Buffer.alloc(4), Buffer.from("ftyp", "ascii"), Buffer.from("heic", "ascii"),
    Buffer.alloc(64),
  ]);
  assert.equal(sniffImageMime(heic), "image/heic");
  assert.equal(getExtensionFromMime("image/heic"), ".heic");
  const heicRun = await runImage(heic);
  assert.ok(heicRun.result.decryptedPicPath, "HEIC should be delivered as an image");
  assert.ok(
    heicRun.result.decryptedPicPath!.endsWith(".heic"),
    `HEIC must not land as .bin, got ${heicRun.result.decryptedPicPath}`,
  );
  assert.equal(heicRun.result.picMediaType, "image/heic");

  // Every sniffable format must survive the whole path with a real extension.
  const samples: Array<[string, Buffer]> = [
    [".jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)])],
    [".png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])],
    [".gif", Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(32)])],
    [".webp", Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(32)])],
    [".bmp", Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(32)])],
    [".heic", heic],
  ];
  for (const [ext, buf] of samples) {
    const run = await runImage(buf);
    assert.ok(run.result.decryptedPicPath?.endsWith(ext), `expected ${ext}, got ${run.result.decryptedPicPath}`);
  }

  // ── Unknown bytes must NOT be relabelled as an image ───────────────────────
  for (const [name, buf] of [
    ["PDF", Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "binary")],
    ["truncated", Buffer.from([0x00, 0x01])],
    ["RIFF-but-WAV", Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii")])],
  ] as Array<[string, Buffer]>) {
    const run = await runImage(buf);
    assert.equal(run.result.decryptedPicPath, undefined, `${name} must not produce an image path`);
    assert.equal(run.result.picMediaType, undefined, `${name} must not claim an image MIME`);
    assert.ok(run.result.decryptedFilePath, `${name} should still reach the model as a file`);
    assert.ok(
      !run.result.decryptedFilePath!.endsWith(".jpg"),
      `${name} must never be renamed .jpg — got ${run.result.decryptedFilePath}`,
    );
    assert.equal(run.result.fileMediaType, "application/octet-stream");
    assert.ok(
      run.logs.some((l) => l.includes("unrecognised")),
      `${name} must leave a visible signal, not fail silently`,
    );
  }

  console.log("wechat inbound image pipeline tests passed");
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
