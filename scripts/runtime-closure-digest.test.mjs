import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const digestScript = path.join(here, "runtime-closure-digest.mjs");

function digest(dir) {
  return execFileSync(process.execPath, [digestScript, dir], {
    encoding: "utf8",
  }).trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "closure-digest-test-"));
try {
  const tree = path.join(root, "node_modules");
  fs.mkdirSync(path.join(tree, "pkg", "dist"), { recursive: true });
  fs.writeFileSync(path.join(tree, "pkg", "package.json"), '{"name":"pkg"}');
  fs.writeFileSync(path.join(tree, "pkg", "dist", "acp-agent.js"), "original");
  fs.symlinkSync("pkg", path.join(tree, "alias"));

  const baseline = digest(tree);
  assert.equal(digest(tree), baseline, "digest must be deterministic");

  // Mutating one installed file — the exact gap the launcher gates on —
  // must turn the digest red.
  fs.writeFileSync(path.join(tree, "pkg", "dist", "acp-agent.js"), "tampered");
  const mutated = digest(tree);
  assert.notEqual(mutated, baseline, "content mutation must change digest");
  fs.writeFileSync(path.join(tree, "pkg", "dist", "acp-agent.js"), "original");
  assert.equal(digest(tree), baseline, "restore must return to baseline");

  // Retargeting a symlink must change the digest.
  fs.unlinkSync(path.join(tree, "alias"));
  fs.symlinkSync("pkg/dist", path.join(tree, "alias"));
  assert.notEqual(digest(tree), baseline, "symlink retarget must change digest");
  fs.unlinkSync(path.join(tree, "alias"));
  fs.symlinkSync("pkg", path.join(tree, "alias"));
  assert.equal(digest(tree), baseline, "restored link returns to baseline");

  // Adding a file must change the digest.
  fs.writeFileSync(path.join(tree, "pkg", "extra.js"), "x");
  assert.notEqual(digest(tree), baseline, "added file must change digest");

  console.log("runtime closure digest tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
