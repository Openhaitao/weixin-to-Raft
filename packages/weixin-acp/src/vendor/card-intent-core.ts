// Vendored from LinearOS src/card/card-intent-core.ts
// source commit: 3f55ecd20d3894c2cf1ac39a47f074542d54bd23
// source sha256: f41d943fc80ebef9b9184c2ca330c7eedfaff13075e9df834c08688b1ae9ee15
// Do not edit by hand; run the drift sentinel after refreshing this file.
// @ts-nocheck

/**
 * Card Intent — the canonical, input-agnostic structure every interactive card
 * normalizes to, before validation + rendering.
 *
 * WHY (2026-06-25, Haitao + Harness + Max aligned): we used to let the model
 * hand-write a big escaped JSON directive (`[[PROJECT_DRAFT_CARD]]{...}`) as the
 * card protocol. Models are bad at escaping long free-text (quotes/newlines), so
 * the JSON often failed to parse → the raw directive leaked + no card rendered
 * (Rose/Mood Cam, see memory draft-card-directive-leak). Root cause = we
 * outsourced *protocol generation* to the model. Fix = the model only expresses
 * SEMANTICS; the system deterministically builds every card.
 *
 * The pipeline is:
 *   input syntax (block protocol now / SDK tool seam later)
 *     → parse → canonical CardIntent { intentType, fields, actions, evidence }
 *     → validate (fail-closed registry)
 *     → render (intentType → Feishu card template)
 *
 * The parser and the future tool handler are just two FRONT-ENDS producing the
 * same CardIntent; validation/render/callback is input-agnostic, so swapping the
 * input method later (once the tool seam is spiked) rewrites nothing downstream.
 *
 * BLOCK PROTOCOL (the model emits this as plain text — values need NO escaping):
 *   ::card:: project_draft
 *   ::owner:: 李瑞思
 *   ::field:: 项目名称 | single | required
 *   Mood Cam（开放海域 OPENSEA）
 *   ::field:: Key-Takeaway | multi
 *   【团队】… 任意多行、随便带 " 引号和换行，
 *   直到下一个 ::field:: 或 ::end::
 *   ::end::
 *
 * A field's value runs verbatim from the line after its `::field::` header until
 * the next `::field::` or `::end::` — so quotes/newlines/colons in content can
 * never break the parse. That is the whole point: the escaping error class is
 * eliminated by grammar, not tolerated by a repair heuristic.
 */

/**
 * Shared CardIntent contract source. This file is vendored by the WeChat agent
 * and covered by drift sentinels; changes here must be re-vendored in lockstep.
 */

export type DraftKind = 'single' | 'multiline' | 'number' | 'date' | 'select' | 'person';

/** A single semantic field the model wants on the card. */
export interface CardIntentField {
  /** form_value key + (default) display label. For 项目创建 these are identical. */
  name: string;
  label?: string;
  value?: string;
  kind?: DraftKind;
  required?: boolean;
  hidden?: boolean;
  options?: Array<{ text: string; value: string }>;
}

export interface BpPickCandidate {
  projectId: string;
  projectName: string;
  company: string;
  leaderName: string;
  lastUpdate: string;
  evidence: string;
}

/** The canonical card request. Every input front-end normalizes to this. */
export interface CardIntent {
  intentType: string;
  ownerName?: string;
  projectId?: string;
  projectName?: string;
  meetingRef?: string;
  meetingDate?: string;
  meetingUrl?: string;
  meetingMemoAppend?: string;
  followupAppend?: string;
  historyStatus?: string;
  historyEmpty?: boolean;
  selfCheck?: string;
  packageOverview?: Record<string, unknown>;
  pendingConfirm?: unknown[];
  cashflowDraft?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
  minuteLink?: string;
  resumePrompt?: string;
  autoPick?: string;
  bpCandidates?: BpPickCandidate[];
  fields: CardIntentField[];
  /** optional supporting bullets (e.g. follow-up evidence). */
  evidence?: string[];
  /** model's natural lead-in text that preceded the card block. */
  preamble?: string;
  candidateName?: string;
  isPersonName?: boolean;
  candidateType?: string;
  date?: string;
  meetingsScanned?: unknown;
  readOk?: unknown;
  readFail?: unknown;
  candidates?: CardIntent[];
  meetingLabel?: string;
  sourceOwner?: string;
  projectOwnerCandidate?: string;
  source?: {
    minuteTitle?: string;
    minuteTime?: string;
    minuteToken?: string;
  };
  minutesText?: string;
  founder?: string;
  oneLiner?: string;
  keyTakeaway?: string;
  nonTargetReason?: string;
  evidenceKeywords?: string[];
}

export interface CardIntentValidation {
  ok: boolean;
  error?: string;
}

/** Registry entry for one intentType. Unknown types fail-closed (no render). */
interface IntentSpec {
  /** default pointer text shown in place of raw protocol. */
  defaultPointer: string;
}

export const REGISTRY: Record<string, IntentSpec> = {
  project_draft: {
    defaultPointer:
      '已生成项目草稿，请在下方卡片逐字段核对/编辑，确认后点【提交到投资云】。',
  },
  project_followup_ask: {
    defaultPointer:
      '我找到一个匹配项目，请在下方卡片确认是否继续生成本次跟进。',
  },
  project_followup_draft: {
    defaultPointer:
      '已生成本次跟进草稿，请在下方卡片编辑确认后提交到投资云。',
  },
  houtou_draft: {
    defaultPointer:
      '已生成投后录入草稿卡，请在下方卡片核对后提交试算。',
  },
  minutes_auth_needed: {
    defaultPointer:
      '读这条妙记需要补充飞书妙记权限，我会发补权卡并在授权后自动续跑。',
  },
  radar_candidate: {
    defaultPointer: '',
  },
  radar_digest: {
    defaultPointer: '',
  },
  bp_pick: {
    defaultPointer: '',
  },
};

/** True only for an intentType the adapter knows how to render. */
export function isRegisteredIntent(intentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, intentType);
}

/** Fail-closed validation: unknown intentType / no fields → not ok (don't render
 * garbage). The caller renders the card ONLY when ok.
 *
 * IMPORTANT: required fields (e.g. 项目名称) are enforced at SUBMIT time by the
 * Feishu form (required:true input), NOT at render time. The draft card is
 * EDITABLE — an empty required field must still render (placeholder 待补充) so the
 * user can fill it. Blocking render on an empty required value was a real bug: the
 * model legitimately leaves 项目名称 blank when no name is in the material, which
 * made the card never render AND leaked the raw ::card:: block to the user. So we
 * do NOT gate rendering on required-field values. */
export function validateCardIntent(intent: CardIntent | null | undefined): CardIntentValidation {
  if (!intent || typeof intent !== 'object') return { ok: false, error: 'intent-missing' };
  if (!intent.intentType || !isRegisteredIntent(intent.intentType)) {
    return { ok: false, error: `unknown-intentType:${intent?.intentType ?? ''}(fail-closed)` };
  }
  if (intent.intentType === 'project_followup_ask' || intent.intentType === 'project_followup_draft') {
    if (!intent.projectId || !String(intent.projectId).trim()) {
      return { ok: false, error: 'projectId-missing' };
    }
    return { ok: true };
  }
  if (intent.intentType === 'houtou_draft') {
    if (!Array.isArray(intent.fields) || intent.fields.length === 0) {
      return { ok: false, error: 'houtou-fields-empty' };
    }
    return { ok: true };
  }
  if (intent.intentType === 'minutes_auth_needed') {
    if (!intent.minuteLink || !String(intent.minuteLink).trim()) {
      return { ok: false, error: 'minuteLink-missing' };
    }
    return { ok: true };
  }
  if (intent.intentType === 'radar_candidate') {
    const hasCandidateName = typeof intent.candidateName === 'string' && intent.candidateName.trim() !== '';
    const hasMinuteToken = typeof intent.source?.minuteToken === 'string' && intent.source.minuteToken.trim() !== '';
    if (!hasCandidateName || !hasMinuteToken) {
      return { ok: false, error: 'radar-candidate-missing-required' };
    }
    return { ok: true };
  }
  if (intent.intentType === 'radar_digest') {
    if (!Array.isArray(intent.candidates)) {
      return { ok: false, error: 'radar-digest-candidates-missing' };
    }
    return { ok: true };
  }
  if (intent.intentType === 'bp_pick') {
    if (!Array.isArray(intent.bpCandidates)) {
      return { ok: false, error: 'bp-pick-candidates-missing' };
    }
    return { ok: true };
  }
  if (!Array.isArray(intent.fields) || intent.fields.length === 0) {
    return { ok: false, error: 'fields-empty' };
  }
  return { ok: true };
}

/** The clean pointer text for an intentType (shown instead of raw protocol). */
export function pointerFor(intentType: string): string {
  return REGISTRY[intentType]?.defaultPointer ?? '';
}

/**
 * Canonical project_draft field schema — the SYSTEM owns the structure
 * (name/label/kind/required/hidden/order/default), the model owns only the VALUES.
 * This is the core of "reduce model error": labels like "Priority Level", kinds,
 * required/hidden flags, display order, and stable defaults (Priority=3 / 币种=USD /
 * 项目来源=行研挖掘 / 地区=中国) are CONSTANTS — the model never re-emits them, so it
 * can't get them wrong. The 11 non-hidden fields render on the card in this order;
 * hidden fields are AI-filled but off-card, still written on submit.
 *
 * Field NAMES here must match exactly what the submit client (touziyun-create.mjs)
 * + injectSelectOptions expect — they are the form_value keys. (Mirrors the 20-field
 * set the skill used to hand-write as JSON.)
 */
interface SchemaField {
  name: string;
  label: string;
  kind: DraftKind;
  required?: boolean;
  hidden?: boolean;
  default?: string;
}
export const PROJECT_DRAFT_SCHEMA: SchemaField[] = [
  { name: '项目名称', label: '项目名称', kind: 'single', required: true },
  { name: '公司创始人', label: '公司创始人', kind: 'single', required: true },
  { name: '一句话简介', label: '一句话简介', kind: 'single', required: true },
  { name: 'Key-Takeaway', label: 'Key-Takeaway', kind: 'multiline' },
  { name: 'Priority', label: 'Priority Level', kind: 'select', required: true, default: '3' },
  { name: '拟初始融资轮次', label: '拟初始融资轮次', kind: 'select', required: true, default: '种子轮' },
  { name: '计划融资', label: '计划融资(金额)', kind: 'number', required: true },
  { name: '币种', label: '币种', kind: 'select', required: true, default: 'USD' },
  { name: '前轮关键投资者', label: '前轮关键投资者', kind: 'single' },
  { name: '项目来源', label: '项目来源', kind: 'select', required: true, default: '行研挖掘' },
  { name: '来源同事', label: '来源同事', kind: 'select', required: true },
  { name: '地区', label: '地区', kind: 'single', hidden: true, default: '中国' },
  { name: '行业大类', label: '行业大类', kind: 'single', hidden: true },
  { name: '行业', label: '行业', kind: 'single', hidden: true },
  { name: '首次接触日期', label: '首次接触日期', kind: 'date', hidden: true },
  { name: '投前估值', label: '投前估值', kind: 'number', hidden: true },
  { name: '投后估值', label: '投后估值', kind: 'number', hidden: true },
  { name: '会议纪要', label: '会议纪要', kind: 'single', hidden: true },
  { name: '教育背景', label: '教育背景(学历)', kind: 'select', hidden: true },
  { name: '学历背景', label: '学历背景', kind: 'single', hidden: true },
];

export interface CardIntentSelectOption {
  text: string;
  value: string;
}

export interface ProjectDraftFieldNormalizationIssue {
  field: string;
  value: string;
  optionCount: number;
}

export interface ProjectDraftFieldNormalizationCorrection {
  field: string;
  from: string;
  to: string;
  value: string;
  reason: string;
}

export interface ProjectDraftFieldNormalizationResult {
  issues: ProjectDraftFieldNormalizationIssue[];
  corrections: ProjectDraftFieldNormalizationCorrection[];
}

interface ProjectDraftSelectPolicy {
  single: boolean;
  takeFirstWhenMultiple?: boolean;
}

export const PROJECT_DRAFT_SELECT_POLICY: Record<string, ProjectDraftSelectPolicy> = {
  Priority: { single: true, takeFirstWhenMultiple: true },
  拟初始融资轮次: { single: true, takeFirstWhenMultiple: true },
  币种: { single: true, takeFirstWhenMultiple: true },
  项目来源: { single: true, takeFirstWhenMultiple: true },
  来源同事: { single: true, takeFirstWhenMultiple: true },
  教育背景: { single: true, takeFirstWhenMultiple: true },
};

/** [#9] 拟初始融资轮次 filter: keep only A-round-and-earlier (Pre-Seed/种子/天使/Pre-A/A
 * incl. A+/A++/A-N); drop CB/SAFE/IPO and Pre-B/B/C/D/E and later. */
export function isPreAFundingRound(label: unknown): boolean {
  const s = String(label || '').trim();
  if (!s || /^(CB|SAFE|IPO)$/i.test(s)) return false;
  if (/^(pre-?seed|种子|天使)/i.test(s)) return true;
  if (/^pre-?a/i.test(s)) return true;
  if (/^A($|[轮+\-\s])/i.test(s)) return true; // A轮 / A+ / A++ / A-1 / A+ second closing
  return false; // Pre-B, B, C, D, E, …
}

export function normalizeSelectLabel(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[·•・_\-\s，,。.\(\)（）\[\]【】]/g, '')
    .replace(/輪/g, '轮');
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
}

export function projectDraftSelectValueAliases(fieldName: string, raw: unknown): string[] {
  const s = String(raw || '').trim();
  if (!s) return [];
  const aliases = [s];
  if (fieldName === '来源同事') {
    const colleagueAliases: Record<string, string> = {
      '列娜': '李瑞思',
      elena: '李瑞思',
      lena: '李瑞思',
      can: '郑灿',
      harry: '王淮',
      haitao: '胡海涛',
    };
    const hit = colleagueAliases[s.toLowerCase()] || colleagueAliases[s];
    if (hit) aliases.push(hit);
  }
  if (fieldName === '币种') {
    const currencyAliases: Record<string, string[]> = {
      usd: ['USD'],
      美元: ['USD'],
      美金: ['USD'],
      dollar: ['USD'],
      dollars: ['USD'],
      '$': ['USD'],
      cny: ['CNY', 'RMB'],
      rmb: ['RMB', 'CNY'],
      人民币: ['CNY', 'RMB'],
      人民币元: ['CNY', 'RMB'],
      元: ['CNY', 'RMB'],
    };
    aliases.push(...(currencyAliases[s.toLowerCase()] || currencyAliases[s] || []));
  }
  if (fieldName === '拟初始融资轮次') {
    const roundAliases: Record<string, string[]> = {
      seed: ['种子轮'],
      preseed: ['Pre-Seed', '种子轮'],
      'pre-seed': ['Pre-Seed', '种子轮'],
      种子: ['种子轮'],
      种子轮: ['种子轮'],
      angel: ['天使轮'],
      天使: ['天使轮'],
      天使轮: ['天使轮'],
      prea: ['Pre-A轮', 'Pre-A'],
      'pre-a': ['Pre-A轮', 'Pre-A'],
      prea轮: ['Pre-A轮', 'Pre-A'],
      'pre-a轮': ['Pre-A轮', 'Pre-A'],
      a: ['A轮', 'A'],
      a轮: ['A轮', 'A'],
    };
    aliases.push(...(roundAliases[s.toLowerCase()] || roundAliases[s] || []));
  }
  return uniqueValues(aliases);
}

function splitSelectCandidateValues(raw: string): string[] {
  return raw
    .split(/[、，,;；\n]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchSingleProjectDraftSelectOption(
  fieldName: string,
  raw: string,
  options: CardIntentSelectOption[],
): { option: CardIntentSelectOption; reason: string } | null {
  const exact = options.find((o) => String(o.value) === raw || String(o.text) === raw);
  if (exact) return { option: exact, reason: 'exact' };
  const aliases = projectDraftSelectValueAliases(fieldName, raw);
  const aliasKeys = aliases.map((v) => normalizeSelectLabel(v)).filter(Boolean);
  const normalizedMatches = options.filter((o) => {
    const optionKeys = [o.text, o.value].map((v) => normalizeSelectLabel(v)).filter(Boolean);
    return aliasKeys.some((k) => optionKeys.includes(k));
  });
  if (normalizedMatches.length === 1) return { option: normalizedMatches[0], reason: 'alias' };
  const fuzzyMatches = options.filter((o) => {
    const text = normalizeSelectLabel(o.text);
    return aliasKeys.some((k) => k.length >= 2 && text.length >= 2 && (text.includes(k) || k.includes(text)));
  });
  return fuzzyMatches.length === 1 ? { option: fuzzyMatches[0], reason: 'fuzzy' } : null;
}

export function matchProjectDraftSelectOption(
  fieldName: string,
  raw: unknown,
  options: CardIntentSelectOption[] = [],
): { option: CardIntentSelectOption; reason: string } | null {
  const rawText = String(raw ?? '').trim();
  if (!rawText || !Array.isArray(options) || !options.length) return null;
  const policy = PROJECT_DRAFT_SELECT_POLICY[fieldName];
  const parts = policy?.single && policy.takeFirstWhenMultiple ? splitSelectCandidateValues(rawText) : [];
  if (parts.length > 1) {
    const first = matchSingleProjectDraftSelectOption(fieldName, parts[0], options);
    return first ? { option: first.option, reason: 'first-legal' } : null;
  }
  return matchSingleProjectDraftSelectOption(fieldName, rawText, options);
}

export function normalizeProjectDraftFieldValues(
  fields: CardIntentField[],
  optionMap: Record<string, CardIntentSelectOption[]> = {},
): ProjectDraftFieldNormalizationResult {
  const issues: ProjectDraftFieldNormalizationIssue[] = [];
  const corrections: ProjectDraftFieldNormalizationCorrection[] = [];
  if (!Array.isArray(fields)) return { issues, corrections };
  for (const f of fields) {
    if (!f) continue;
    if (f.kind !== 'select') {
      if (typeof f.value === 'string') f.value = f.value.trim();
      continue;
    }
    if ((!Array.isArray(f.options) || !f.options.length) && Array.isArray(optionMap[f.name])) {
      f.options = optionMap[f.name];
    }
    if (!Array.isArray(f.options) || !f.options.length) continue;
    const raw = String(f.value ?? '').trim();
    if (!raw) continue;
    const matched = matchProjectDraftSelectOption(f.name, raw, f.options);
    if (matched?.option) {
      const next = String(matched.option.value);
      if (raw !== next) {
        corrections.push({ field: f.name, from: raw, to: matched.option.text, value: next, reason: matched.reason });
      }
      f.value = next;
      continue;
    }
    f.value = '';
    f.placeholder = `未匹配到「${raw}」，请从下拉中选择`;
    if (f.required || !f.hidden) {
      issues.push({ field: f.name, value: raw, optionCount: f.options.length });
    } else {
      corrections.push({ field: f.name, from: raw, to: '', value: '', reason: 'optional-hidden-unmatched-cleared' });
    }
  }
  return { issues, corrections };
}

/**
 * Merge a parsed project_draft intent (model-provided name→value) onto the
 * canonical schema. The model only supplies VALUES (by field name); structure +
 * defaults come from the schema. Result: a full CardIntent whose fields[] is the
 * 20-field set in canonical order, ready for buildProjectDraftCardJson. A field
 * the model omitted (or left empty) falls back to the schema default, else ''.
 */
export function normalizeProjectDraft(intent: CardIntent): CardIntent {
  const provided = new Map<string, string>();
  for (const f of intent.fields || []) {
    provided.set(f.name, String(f.value ?? ''));
  }
  const fields: CardIntentField[] = PROJECT_DRAFT_SCHEMA.map((s) => {
    const v = provided.get(s.name);
    const value = v && v.trim() ? v : (s.default ?? '');
    return {
      name: s.name,
      label: s.label,
      value,
      kind: s.kind,
      required: s.required,
      hidden: s.hidden,
    };
  });
  return {
    intentType: 'project_draft',
    ownerName: intent.ownerName,
    fields,
    preamble: intent.preamble,
  };
}

export const KIND_ALIASES: Record<string, DraftKind> = {
  single: 'single',
  multi: 'multiline',
  multiline: 'multiline',
  number: 'number',
  date: 'date',
  select: 'select',
  person: 'person',
};

/**
 * Strip a card block (`::card:: … ::end::`, or an unclosed `::card::` to end) out
 * of text — the safety net so a block that FAILED to render never reaches the user
 * as raw protocol. Returns the text before the block (the model's natural lead-in),
 * trimmed. Used only on the not-rendered path.
 */
export function stripCardBlock(text: string): string {
  if (!text || !text.includes('::card::')) return text;
  const inlineStart = text.indexOf('::card::');
  if (inlineStart > 0) return text.slice(0, inlineStart).trim();
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*::card::/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return text;
  return lines.slice(0, start).join('\n').trim();
}

export function stripProjectFollowupAskDirective(text: string): string {
  if (!text || !text.includes('[[PROJECT_FOLLOWUP_ASK]]')) return text;
  return text
    .replace(/\[\[PROJECT_FOLLOWUP_ASK\]\][\s\S]*?(?:\[\[\/PROJECT_FOLLOWUP_ASK\]\]|$)/g, '')
    .trim();
}

/** Parse the legacy stage-1 follow-up ask marker into a CardIntent. This keeps
 * model-emitted JSON as a temporary input syntax while the adapter downstream
 * sees the same structured shape it will get from a future tool seam. */
export function parseProjectFollowupAskDirective(text: string): CardIntent | null {
  if (!text || !text.includes('[[PROJECT_FOLLOWUP_ASK]]')) return null;
  const m = text.match(/\[\[PROJECT_FOLLOWUP_ASK\]\]([\s\S]*?)\[\[\/PROJECT_FOLLOWUP_ASK\]\]/);
  if (!m) return null;
  const json = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const p = JSON.parse(json);
    if (!p || !p.projectId) return null;
    return {
      intentType: 'project_followup_ask',
      projectId: String(p.projectId),
      projectName: String(p.projectName || ''),
      meetingRef: String(p.meetingRef || ''),
      evidence: Array.isArray(p.evidence) ? p.evidence.map(String).filter(Boolean) : [],
      fields: [],
      preamble: text.slice(0, m.index).trim(),
    };
  } catch {
    return null;
  }
}

export function stripProjectFollowupDraftDirective(text: string): string {
  if (!text || !text.includes('[[PROJECT_FOLLOWUP_DRAFT]]')) return text;
  return text
    .replace(/\[\[PROJECT_FOLLOWUP_DRAFT\]\][\s\S]*?(?:\[\[\/PROJECT_FOLLOWUP_DRAFT\]\]|$)/g, '')
    .trim();
}

/** Parse the legacy stage-2 follow-up draft marker into a CardIntent. This keeps
 * the current model marker as a temporary input syntax while centralizing
 * validation/rendering. The adapter persists this same payload before submit. */
export function parseProjectFollowupDraftDirective(text: string): CardIntent | null {
  if (!text || !text.includes('[[PROJECT_FOLLOWUP_DRAFT]]')) return null;
  const m = text.match(/\[\[PROJECT_FOLLOWUP_DRAFT\]\]([\s\S]*?)\[\[\/PROJECT_FOLLOWUP_DRAFT\]\]/);
  if (!m) return null;
  const json = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const p = JSON.parse(json);
    if (!p || !p.projectId) return null;
    const historyStatus = String(p.historyStatus || '');
    return {
      intentType: 'project_followup_draft',
      projectId: String(p.projectId),
      projectName: String(p.projectName || ''),
      meetingDate: String(p.meetingDate || ''),
      meetingUrl: String(p.meetingUrl || ''),
      meetingMemoAppend: String(p.meetingMemoAppend || ''),
      followupAppend: String(p.followupAppend || ''),
      evidence: Array.isArray(p.evidence) ? p.evidence.map(String).filter(Boolean) : [],
      historyStatus,
      historyEmpty: p.historyEmpty === true || /未读取到|无历史|均为空|没有历史/.test(historyStatus),
      fields: [],
      preamble: text.slice(0, m.index).trim(),
    };
  } catch {
    return null;
  }
}

export function stripHoutouDraftDirective(text: string): string {
  if (!text || !text.includes('[[HOUTOU_DRAFT_CARD]]')) return text;
  return text
    .replace(/\[\[HOUTOU_DRAFT_CARD\]\][\s\S]*?(?:\[\[\/HOUTOU_DRAFT_CARD\]\]|$)/g, '')
    .trim();
}

/** Parse the legacy 投后录入 draft marker into a CardIntent. The write payload is
 * preserved verbatim for adapter persistence; only rendering moves to registry. */
export function parseHoutouDraftDirective(text: string): CardIntent | null {
  if (!text || !text.includes('[[HOUTOU_DRAFT_CARD]]')) return null;
  const m = text.match(/\[\[HOUTOU_DRAFT_CARD\]\]([\s\S]*?)\[\[\/HOUTOU_DRAFT_CARD\]\]/);
  if (!m) return null;
  const json = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const p = JSON.parse(json);
    if (!p || !Array.isArray(p.fields) || p.fields.length === 0) return null;
    return {
      intentType: 'houtou_draft',
      projectId: p.projectId ? String(p.projectId) : '',
      projectName: String(p.projectName || ''),
      selfCheck: String(p.selfCheck || ''),
      packageOverview: (p.packageOverview && typeof p.packageOverview === 'object') ? p.packageOverview : {},
      pendingConfirm: Array.isArray(p.pendingConfirm) ? p.pendingConfirm : [],
      cashflowDraft: (p.cashflowDraft && typeof p.cashflowDraft === 'object') ? p.cashflowDraft : null,
      fields: p.fields,
      payload: (p.payload && typeof p.payload === 'object') ? p.payload : {},
      preamble: text.slice(0, m.index).trim(),
    };
  } catch {
    return null;
  }
}

export function stripMinutesAuthDirective(text: string): string {
  if (!text || !text.includes('[[MINUTES_AUTH_NEEDED]]')) return text;
  return text
    .replace(/\[\[MINUTES_AUTH_NEEDED\]\][\s\S]*?(?:\[\[\/MINUTES_AUTH_NEEDED\]\]|$)/g, '')
    .trim();
}

/** Parse the legacy minutes-permission marker into a CardIntent. This is an
 * auth-control intent: the adapter still owns startAuthFlow + resume semantics. */
export function parseMinutesAuthDirective(text: string): CardIntent | null {
  if (!text || !text.includes('[[MINUTES_AUTH_NEEDED]]')) return null;
  const m = text.match(/\[\[MINUTES_AUTH_NEEDED\]\]([\s\S]*?)\[\[\/MINUTES_AUTH_NEEDED\]\]/);
  if (!m) return null;
  const json = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const p = JSON.parse(json);
    const minuteLink = String(p.minuteLink || p.minuteUrl || '');
    if (!minuteLink.trim()) return null;
    return {
      intentType: 'minutes_auth_needed',
      minuteLink,
      projectName: String(p.projectName || ''),
      projectId: p.projectId ? String(p.projectId) : '',
      resumePrompt: String(p.resumePrompt || ''),
      fields: [],
      preamble: text.slice(0, m.index).trim(),
    };
  } catch {
    return null;
  }
}

/**
 * [[RADAR_CANDIDATE]] is a short structured proposal only. The adapter injects
 * owner-scoped minutes text/evidence later, so the directive body is never
 * trusted for long meeting content or write-side behavior.
 */
export function parseRadarCandidateDirective(text: string): CardIntent | null {
  if (!text || !text.includes('[[RADAR_CANDIDATE]]')) return null;
  const m = text.match(/\[\[RADAR_CANDIDATE\]\]([\s\S]*?)(?:\[\[\/RADAR_CANDIDATE\]\]|$)/);
  if (!m) return null;
  const json = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const nonEmpty = (v: unknown): boolean => v != null && String(v).trim() !== '';
  const source = obj.source && typeof obj.source === 'object' ? obj.source as Record<string, unknown> : null;
  if (!nonEmpty(obj.candidateName) || !source || !nonEmpty(source.minuteToken)) return null;

  return {
    intentType: 'radar_candidate',
    fields: [],
    candidateName: String(obj.candidateName).trim(),
    isPersonName: !!obj.isPersonName,
    candidateType: ['new', 'follow', 'uncertain'].includes(String(obj.candidateType)) ? String(obj.candidateType) : 'uncertain',
    sourceOwner: String(obj.sourceOwner || '').trim(),
    projectOwnerCandidate: String(obj.projectOwnerCandidate || '').trim(),
    source: {
      minuteTitle: String(source.minuteTitle || '').trim(),
      minuteTime: String(source.minuteTime || '').trim(),
      minuteToken: String(source.minuteToken).trim(),
    },
    minutesText: '',
    founder: nonEmpty(obj.founder) ? String(obj.founder).trim() : undefined,
    oneLiner: nonEmpty(obj.oneLiner) ? String(obj.oneLiner).trim() : undefined,
    keyTakeaway: nonEmpty(obj.keyTakeaway) ? String(obj.keyTakeaway).trim() : undefined,
    evidenceKeywords: Array.isArray(obj.evidenceKeywords) ? obj.evidenceKeywords.map(String) : undefined,
    preamble: text.slice(0, m.index).trim(),
  };
}

/** Strip only the candidate marker; RADAR_DIGEST stays owned by the adapter path. */
export function stripRadarCandidateDirective(text: string): string {
  if (!text || !text.includes('[[RADAR_CANDIDATE]]')) return text;
  return text.replace(/\[\[RADAR_CANDIDATE\]\][\s\S]*?(?:\[\[\/RADAR_CANDIDATE\]\]|$)/g, '').trim();
}

/** Parse the BP picker marker into a CardIntent. Upload/write behavior remains
 * adapter-owned: this function only normalizes the model's candidate handoff. */
export function parseBpPickDirective(text: string): CardIntent | null {
  if (!text || !text.includes('[[BP_PICK]]')) return null;
  const m = text.match(/\[\[BP_PICK\]\]([\s\S]*?)\[\[\/BP_PICK\]\]/);
  if (!m) return null;
  const json = m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    const p = JSON.parse(json);
    const arr = Array.isArray(p) ? p : (Array.isArray(p?.candidates) ? p.candidates : null);
    if (!arr) return null;
    const candidates: BpPickCandidate[] = arr.map((c: Record<string, unknown> | null) => ({
      projectId: c && c.projectId != null ? String(c.projectId) : '',
      projectName: c && c.projectName != null ? String(c.projectName) : '',
      company: c && c.company != null ? String(c.company) : '',
      leaderName: c && c.leaderName != null ? String(c.leaderName) : '',
      lastUpdate: c && c.lastUpdate != null ? String(c.lastUpdate) : '',
      evidence: c && c.evidence != null ? String(c.evidence) : '',
    })).filter((c) => c.projectId);
    const autoPick = p && !Array.isArray(p) && p.autoPick != null && String(p.autoPick).trim()
      ? String(p.autoPick).trim()
      : '';
    return {
      intentType: 'bp_pick',
      fields: [],
      bpCandidates: candidates,
      autoPick,
      preamble: text.slice(0, m.index).trim(),
    };
  } catch {
    return null;
  }
}

/** Strip the BP picker marker so malformed upload handoffs never leak raw JSON. */
export function stripBpPickDirective(text: string): string {
  if (!text || !text.includes('[[BP_PICK]]')) return text;
  return text.replace(/\[\[BP_PICK\]\][\s\S]*?(?:\[\[\/BP_PICK\]\]|$)/g, '').trim();
}

/**
 * [[RADAR_DIGEST]] carries a short list of candidate stubs only. Per-candidate
 * minutes text remains adapter-injected by owner-scoped fetch before rendering.
 */
export function parseRadarDigestDirective(text: string): CardIntent | null {
  if (!text || !text.includes('[[RADAR_DIGEST]]')) return null;
  const m = text.match(/\[\[RADAR_DIGEST\]\]([\s\S]*?)(?:\[\[\/RADAR_DIGEST\]\]|$)/);
  if (!m) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim());
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.candidates)) return null;
  const nonEmpty = (v: unknown): boolean => v != null && String(v).trim() !== '';
  const candidates = obj.candidates
    .filter((c: unknown): c is Record<string, unknown> => {
      if (!c || typeof c !== 'object') return false;
      const source = c.source && typeof c.source === 'object' ? c.source as Record<string, unknown> : null;
      return nonEmpty(c.candidateName) && !!source && nonEmpty(source.minuteToken);
    })
    .map((c): CardIntent => {
      const source = c.source as Record<string, unknown>;
      return {
        intentType: 'radar_candidate',
        fields: [],
        candidateName: String(c.candidateName).trim(),
        candidateType: ['new', 'follow', 'needs_identity', 'no_candidate'].includes(String(c.candidateType)) ? String(c.candidateType) : 'needs_identity',
        isPersonName: !!c.isPersonName,
        projectOwnerCandidate: String(c.projectOwnerCandidate || '').trim(),
        founder: nonEmpty(c.founder) ? String(c.founder).trim() : undefined,
        oneLiner: nonEmpty(c.oneLiner) ? String(c.oneLiner).trim() : undefined,
        keyTakeaway: nonEmpty(c.keyTakeaway) ? String(c.keyTakeaway).trim() : undefined,
        nonTargetReason: nonEmpty(c.nonTargetReason) ? String(c.nonTargetReason).trim() : undefined,
        evidenceKeywords: Array.isArray(c.evidenceKeywords) ? c.evidenceKeywords.map(String) : undefined,
        source: {
          minuteTitle: String(source.minuteTitle || '').trim(),
          minuteTime: String(source.minuteTime || '').trim(),
          minuteToken: String(source.minuteToken).trim(),
        },
        minutesText: '',
        meetingLabel: nonEmpty(c.meetingLabel) ? String(c.meetingLabel).trim() : undefined,
      };
    });

  return {
    intentType: 'radar_digest',
    fields: [],
    date: String(obj.date || ''),
    meetingsScanned: obj.meetingsScanned,
    readOk: obj.readOk,
    readFail: obj.readFail,
    candidates,
    preamble: text.slice(0, m.index).trim(),
  };
}

/** Strip only the daily digest marker. */
export function stripRadarDigestDirective(text: string): string {
  if (!text || !text.includes('[[RADAR_DIGEST]]')) return text;
  return text.replace(/\[\[RADAR_DIGEST\]\][\s\S]*?(?:\[\[\/RADAR_DIGEST\]\]|$)/g, '').trim();
}

/**
 * Parse the block protocol out of a model reply. Returns a CardIntent or null
 * (no `::card::` marker, or no fields). Tolerant by GRAMMAR, not by repair:
 * a field value is taken verbatim to the next `::field::`/`::end::`, so any
 * quotes/newlines/colons inside it are safe.
 */
export function parseCardBlock(text: string): CardIntent | null {
  if (!text || !text.includes('::card::')) return null;
  // The model sometimes emits the header immediately after a natural lead-in:
  // "我整理好了。::card:: project_draft\n...". Treat the marker as a protocol
  // boundary even when it is not at column 0, while keeping field markers
  // line-anchored so value text containing "::field::" is still preserved.
  const inlineStart = text.indexOf('::card::');
  const parseText = inlineStart > 0 ? `${text.slice(0, inlineStart)}\n${text.slice(inlineStart)}` : text;
  const lines = parseText.split('\n');

  // locate the ::card:: <intentType> header
  let startIdx = -1;
  let intentType = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*::card::\s*(\S+)\s*$/);
    if (m) {
      startIdx = i;
      intentType = m[1];
      break;
    }
  }
  if (startIdx < 0) return null;

  // preamble = everything before the ::card:: line (model's natural lead-in)
  const preamble = lines.slice(0, startIdx).join('\n').trim();

  let ownerName = '';
  const fields: CardIntentField[] = [];
  const bodyLines = lines.slice(startIdx + 1);
  let cur: CardIntentField | null = null;
  let valueLines: string[] = [];
  const flush = () => {
    if (cur) {
      cur.value = valueLines.join('\n').trim();
      fields.push(cur);
    }
    cur = null;
    valueLines = [];
  };

  for (const line of bodyLines) {
    if (/^\s*::end::\s*$/.test(line)) {
      flush();
      break;
    }
    const owner = line.match(/^\s*::owner::\s*(.*)$/);
    if (owner && !cur) {
      ownerName = owner[1].trim();
      continue;
    }
    const fh = line.match(/^\s*::field::\s*(.*)$/);
    if (fh) {
      flush();
      const parts = fh[1].split('|').map((s) => s.trim());
      const name = parts[0] || '';
      const kindRaw = (parts[1] || '').toLowerCase();
      const required = parts.slice(2).some((p) => /required/i.test(p));
      cur = {
        name,
        label: name,
        kind: KIND_ALIASES[kindRaw] || 'single',
        required,
      };
      continue;
    }
    // a content line for the current field's value (verbatim)
    if (cur) valueLines.push(line);
  }
  // tolerate a missing ::end:: — flush whatever field is open
  flush();

  if (fields.length === 0) return null;
  return { intentType, ownerName, fields, preamble };
}
