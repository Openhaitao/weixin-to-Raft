import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { uploadBufferToCdn } from "../../sdk/src/cdn/cdn-upload.ts";
import { buildMediaSendFallbackText } from "../../sdk/src/messaging/process-message.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");

function assertCanonicalPaths(): void {
  assert.equal(fs.existsSync(path.join(repoRoot, "packages", "agent-acp")), false, "retired packages/agent-acp must not return");
  const wrapper = fs.readFileSync(path.join(repoRoot, "scripts", "wechat-bind-demo.mjs"), "utf-8");
  assert.match(wrapper, /packages["'],\s*["']weixin-acp["']/, "wrapper must resolve packages/weixin-acp");
  assert.doesNotMatch(wrapper, /packages["'],\s*["']agent-acp["']/, "wrapper must not resolve retired agent-acp");
  const cli = fs.readFileSync(path.join(packageRoot, "main.ts"), "utf-8");
  assert.match(cli, /WEIXIN_LOGIN_QR/);
  assert.match(cli, /WEIXIN_LOGIN_DONE/);
}

async function assertUploadShapes(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response("", { status: 200, headers: { "x-encrypted-param": "download-token" } });
  }) as typeof fetch;
  try {
    const common = {
      buf: Buffer.from("linearos-upload-fixture"),
      filekey: "fixture-key",
      cdnBaseUrl: "https://cdn.example.test",
      label: "fixture",
      aeskey: Buffer.alloc(16, 7),
    };
    await uploadBufferToCdn({ ...common, uploadFullUrl: "https://upload.example.test/full" });
    assert.equal(urls.at(-1), "https://upload.example.test/full");
    await uploadBufferToCdn({ ...common, uploadParam: "legacy-param" });
    assert.match(urls.at(-1) || "", /legacy-param/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function assertFallbackText(): void {
  const text = buildMediaSendFallbackText("二维码在附件里");
  assert.match(text, /二维码在附件里/);
  assert.match(text, /附件\/二维码发送失败/);
}

assertCanonicalPaths();
await assertUploadShapes();
assertFallbackText();
console.log("LinearOS package path, QR upload shapes, and media fallback verified");
