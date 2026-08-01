#!/usr/bin/env node
/**
 * Deterministic digest of a runtime dependency closure (an installed
 * node_modules tree). The artifact's git tree hash covers every tracked file,
 * but node_modules is gitignored: without this digest, editing any installed
 * dependency (e.g. the ACP adapter's dist/acp-agent.js) keeps every launch
 * gate green while the running bytes change.
 *
 * Digest = sha256 over a sorted manifest of every entry:
 *   regular file  ->  "F <relpath> <sha256(content)>"
 *   symlink       ->  "L <relpath> <link-target>"
 * Directories contribute only through their contents. Any content change,
 * addition, removal, or symlink retarget changes the digest.
 *
 * Usage: node runtime-closure-digest.mjs <dir>
 * Prints the digest hex on stdout; exits 1 on any traversal error.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: runtime-closure-digest <dir>");
  process.exit(2);
}
const rootReal = fs.realpathSync(root);

/** Collect entries without following symlinks (link targets are recorded,
 * never traversed — content behind an in-tree link is hashed at its real
 * path; a link escaping the tree contributes its target string only). */
function walk(dir, rel, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      out.push(`L ${relPath} ${fs.readlinkSync(abs)}`);
    } else if (entry.isDirectory()) {
      walk(abs, relPath, out);
    } else if (entry.isFile()) {
      const hash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(abs))
        .digest("hex");
      out.push(`F ${relPath} ${hash}`);
    } else {
      throw new Error(`unsupported entry type: ${relPath}`);
    }
  }
}

const manifest = [];
walk(rootReal, "", manifest);
manifest.sort();
const digest = crypto
  .createHash("sha256")
  .update(manifest.join("\n"))
  .digest("hex");
console.log(digest);
