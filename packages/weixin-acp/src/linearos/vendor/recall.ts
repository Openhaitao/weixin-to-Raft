// Vendored from LinearOS src/memory/recall.ts
// source commit: 6d0338e77b4e874421c120c013bc2d52705e5b59
// source sha256: 7eae518f081670afd5b5982a515a1944f4cf8322802fc1921e9d34a4f16be381
// Do not edit by hand; run the drift sentinel after refreshing this file.
// @ts-nocheck

/**
 * [memory V1] Recall = RELEVANCE RETRIEVAL (not whole-index dump).
 *
 * Per Haitao "use the best": instead of injecting every fact each turn (the old
 * bloat root), we inject the slim index (cheap, recovery map) + only the top-N
 * facts whose `description`/name/type are relevant to the CURRENT message. Memory
 * can grow large (toward memory→skill) without blowing the context window.
 *
 * V1 scorer = keyword/tag overlap (cheap, deterministic, no embeddings). The seam
 * is isolated so V2 can swap in semantic/embedding retrieval without touching the
 * loader or the injection site.
 */

import { loadFacts, loadIndex, type MemoryFact } from './store.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'are', 'and', 'or', 'for', 'with', 'how', 'what',
  '的', '了', '是', '我', '你', '他', '在', '和', '吗', '呢', '这', '那', '吧', '怎么', '一个', '请',
]);

/** Tokenize: ascii words (≥2 chars) + CJK bigrams. Lowercased. */
export function tokenize(text: string): string[] {
  const s = String(text || '').toLowerCase();
  const out: string[] = [];
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) if (!STOPWORDS.has(w)) out.push(w);
  const cjk = s.match(/[一-鿿]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) { if (!STOPWORDS.has(run)) out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOPWORDS.has(bg)) out.push(bg);
    }
  }
  return out;
}

/**
 * Score a fact against query tokens. description + name weigh most (they're the
 * relevance signal); body contributes lightly. Returns 0 if no overlap.
 */
export function scoreFact(fact: MemoryFact, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const sig = new Set(tokenize(`${fact.name} ${fact.description} ${fact.type || ''}`));
  const bodyTokens = new Set(tokenize(fact.body.slice(0, 800)));
  let score = 0;
  for (const t of queryTokens) {
    if (sig.has(t)) score += 3;
    else if (bodyTokens.has(t)) score += 1;
  }
  return score;
}

/** Top-N facts relevant to `query`, by descending score (ties → keep file order). */
export function retrieveRelevant(facts: MemoryFact[], query: string, topN = 5): MemoryFact[] {
  const q = new Set(tokenize(query));
  return facts
    .map((f, i) => ({ f, i, s: scoreFact(f, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .slice(0, topN)
    .map((x) => x.f);
}

/**
 * Build the recall block to inject for this turn: slim index (always, recovery
 * map) + the top-N relevant fact bodies. Empty string when the bot has no memory
 * yet (fresh bot) → zero injection. `query` = the current user message.
 */
export function buildRecallInjection(memoryDir: string, query: string, topN = 5): string {
  // Nothing to recall against: an attachment-only turn carries no words. The
  // block used to be injected anyway, which made the memory header the ONLY
  // text in the user's turn — send a bare photo and the bot would start
  // talking about its memory instead of the photo.
  //
  // The index IS still injected whenever there are words, even if nothing
  // scores: it is the bot's recovery map, and the V1 scorer is weak enough
  // that dropping it on a miss would make a keyword miss look like an absent
  // memory.
  if (!tokenize(query).length) return '';

  const index = loadIndex(memoryDir);
  const facts = loadFacts(memoryDir);
  const relevant = retrieveRelevant(facts, query, topN);

  // The path line is ALWAYS injected so the bot knows where to write (even a
  // fresh bot with no facts yet) — it's the runtime half of the write loop, per
  // the "## 记忆" instruction. Index + relevant fact bodies added when present.
  const parts: string[] = [
    '\n\n## 我的长期记忆（持久 · 跨会话）',
    `记忆目录：\`${memoryDir}\`。`,
  ];
  if (index) {
    parts.push(`\n记忆索引（细节用 Read 打开对应文件）：\n${index}`);
  }
  if (relevant.length > 0) {
    const blocks = relevant.map((f) => `### ${f.name}${f.description ? `（${f.description}）` : ''}\n${f.body}`);
    parts.push(`\n与当前对话相关的记忆：\n\n${blocks.join('\n\n')}`);
  }
  return parts.join('\n');
}
