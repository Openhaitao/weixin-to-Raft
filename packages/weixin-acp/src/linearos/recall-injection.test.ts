import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRecallInjection } from "./vendor/recall.js";

/**
 * A turn with no words carries nothing to recall against. The block used to be
 * injected anyway AND unshifted as the first content block, so an
 * attachment-only message arrived at the model as a memory instruction with
 * some pictures attached — which is exactly what it then talked about.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-"));
try {
  fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [Tea](tea.md) — 茶偏好\n");
  fs.writeFileSync(
    path.join(dir, "tea.md"),
    ["---", "name: tea", "description: 用户喜欢乌龙茶", "type: user", "---", "", "乌龙。"].join("\n"),
  );

  // --- attachment-only turns inject nothing ---
  for (const q of ["", "   ", "？？", "。"]) {
    assert.equal(
      buildRecallInjection(dir, q),
      "",
      `a turn with no recallable words must inject nothing (query=${JSON.stringify(q)})`,
    );
  }
  console.log("attachment-only turn: zero injection");

  // --- a turn with words still gets the path line (the write loop) ---
  const plain = buildRecallInjection(dir, "在吗");
  assert.ok(plain.includes("记忆目录"), "a turn with words still knows where to write");
  console.log("plain turn: path line kept");

  // --- a miss still gets the index: it is the recovery map ---
  // The V1 scorer is CJK-bigram overlap and misses easily; dropping the index
  // on a miss would make a keyword miss look like an absent memory.
  const miss = buildRecallInjection(dir, "香蕉奶昔怎么做");
  assert.ok(miss.includes("记忆索引"), "a scorer miss must not hide the index");
  console.log("scorer miss: index still injected");

  // --- a hit brings the fact body ---
  const hit = buildRecallInjection(dir, "喜欢喝什么茶");
  assert.ok(hit.includes("乌龙"), "a relevant fact must still be recalled");
  console.log("hit: fact body recalled");

  // --- the vendor pin must match the file we actually vendored ---
  const vendored = fs.readFileSync(
    new URL("./vendor/recall.ts", import.meta.url),
    "utf-8",
  );
  assert.match(
    vendored,
    /\/\/ source commit: [0-9a-f]{40}\n/,
    "the vendored copy must pin a full source commit, not a placeholder",
  );
  console.log("vendor header: pinned");

  console.log("recall injection tests passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
