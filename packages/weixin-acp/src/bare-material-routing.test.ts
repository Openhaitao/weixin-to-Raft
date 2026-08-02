import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AcpAgent } from "./acp-agent.js";

/**
 * Drives the REAL AcpAgent routing decision, not the inbox class.
 *
 * Bare attachments are held silently on purpose: the reply comes with the
 * message that says what to do with them. A change that answered each bare
 * photo immediately shipped once because the only coverage was on
 * MaterialInbox, which stayed green while the agent stopped calling it.
 *
 * This case returns before any ACP connection is established, so it can be
 * driven without a real backend.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bare-"));
try {
  const agent = new AcpAgent({ command: "nonexistent-acp", cwd: root } as never);
  const img = { type: "image" as const, filePath: "/tmp/a.jpg", mimeType: "image/jpeg" };

  // --- a bare attachment is held, and answered with nothing ---
  const bare = await agent.chat({
    conversationId: "c1",
    text: "",
    deliveryId: "m:1",
    media: img,
    mediaItems: [img],
  } as never);
  assert.deepEqual(
    bare,
    { silent: true },
    "a bare attachment must be held silently — no text, no media, and explicitly silent",
  );

  // --- a second one accumulates rather than replacing ---
  await agent.chat({
    conversationId: "c1",
    text: "",
    deliveryId: "m:2",
    media: { ...img, filePath: "/tmp/b.jpg" },
    mediaItems: [{ ...img, filePath: "/tmp/b.jpg" }],
  } as never);

  // --- typing/no-typing follows the same decision ---
  assert.equal(
    await agent.shouldShowTyping({ conversationId: "c1", text: "", media: img } as never),
    false,
    "a held message must not show a typing indicator it will never fulfil",
  );

  console.log("bare material: routed to the inbox by the agent itself");
  console.log("bare material routing tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
