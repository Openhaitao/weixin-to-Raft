// Vendored from LinearOS src/memory/store.ts
// source commit: 5a55d5f48810ea601aeb0dc6c40cb60b853d602d
// source sha256: 21126c9af4f8dbac260aabe82e57ceca32168ca83297ce9c32ac5b508edadb07
// Do not edit by hand; run the drift sentinel after refreshing this file.
// @ts-nocheck

/**
 * [memory V1] Per-bot structured memory store — the RECALL layer.
 *
 * Authoritative model (overturns the old MEMORY_DIR index-dump, per Haitao's
 * "use the best"): one fact = one `<name>.md` file with frontmatter; MEMORY.md
 * is a slim pointer index. Human-readable, git-able, editable. The raw journal
 * (runtime-sessions/*.jsonl) is a SEPARATE layer and never loaded here.
 *
 * This module only READS + PARSES the store (recall). Writing facts is done by
 * the bot itself via its file tools, per the agent-instructions convention.
 *
 * Spec: feishu docx CdR6dsDjvoNptSxAnYXc37Ywn0d (Allen, V1).
 */

import fs from 'node:fs';
import path from 'node:path';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'procedure' | 'skill-seed';
export type MemoryScope = 'private' | 'team' | 'public';

export interface MemoryFact {
  name: string;            // = filename slug
  description: string;     // relevance signal for recall
  type?: MemoryType;
  scope?: MemoryScope;     // V1 always 'private'
  body: string;            // fact text (frontmatter stripped)
  file: string;            // absolute path
}

/**
 * Parse a `---` frontmatter block + body. Tolerant, dependency-free: handles the
 * flat keys (name/description) and dotted `metadata.x:` keys the spec uses. Bad
 * input → empty frontmatter + whole text as body (never throws).
 */
export function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw.trim() };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_.]+)\s*:\s*(.*)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: (m[2] || '').trim() };
}

/** Load all fact files from a memory dir (excludes the MEMORY.md index). */
export function loadFacts(memoryDir: string): MemoryFact[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(memoryDir);
  } catch {
    return []; // no memory dir yet (fresh bot)
  }
  const facts: MemoryFact[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md') || entry === 'MEMORY.md') continue;
    const file = path.join(memoryDir, entry);
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const { fm, body } = parseFrontmatter(raw);
    facts.push({
      name: fm['name'] || entry.replace(/\.md$/, ''),
      description: fm['description'] || '',
      type: (fm['metadata.type'] || fm['type']) as MemoryType | undefined,
      scope: (fm['metadata.scope'] || fm['scope'] || 'private') as MemoryScope,
      body,
      file,
    });
  }
  return facts;
}

/** Read the slim MEMORY.md index (pointers). '' if absent. */
export function loadIndex(memoryDir: string): string {
  try {
    return fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8').trim();
  } catch {
    return '';
  }
}
