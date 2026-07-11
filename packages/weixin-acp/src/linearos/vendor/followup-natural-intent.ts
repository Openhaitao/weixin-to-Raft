// Vendored from LinearOS src/runtime/followup-natural-intent.ts
// source commit: f6609c161718b9aa7ed4b15b9be13ca2189bb0b1
// source sha256: 67ba955c5b4fde908d710afdd3624d9e242d44a345b7236af6f72b24e3c8abc1
// Do not edit by hand; run the drift sentinel after refreshing this file.
// @ts-nocheck

export type NaturalFollowupEntry =
  | { kind: 'route'; normalizedText: string; projectHint: string }
  | { kind: 'clarify' }
  | { kind: 'none' };

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>]+/gi;
const URL_TEST_RE = /(?:https?:\/\/|www\.)[^\s<>]+/i;
const MATERIAL_RE = /\/(?:minutes|docx|docs|doc|sheets|sheet|base|bitable|wiki|file|wenjian)\/|(?:minute_token|obj_token)\s*[:=]/i;
const FOLLOWUP_WORD_RE = /项目跟进|项目.{0,10}跟进|跟进(?:一下|下)?(?:这个|该|这家)?项目|跟进(?:一下|下)?(?:[？?]|$)/i;
const STRONG_FOLLOWUP_RE = /(?:帮我|请|麻烦|劳驾|直接|现在|需要|想要|我要|给我)?\s*(?:做|处理|整理|录入|更新|发起|开始|走|跑)(?:一下|下|一遍|个)?\s*(?:这份|这个|该)?\s*项目跟进(?!材料|记录|文档|内容|怎么|如何)|(?:帮我|请|麻烦|劳驾)\s*(?:对\s*)?(?:这个|该|这家)?\s*项目\s*跟进(?:一下|下)?|(?:帮我|请|麻烦|劳驾)\s*跟进(?:一下|下)?\s*(?:这个|该|这家)?\s*项目/i;
const NEGATED_RE = /(?:不要|不用|无需|不需要|别|取消|停止|不是|并非).{0,12}(?:项目跟进|跟进.{0,6}项目)|(?:项目跟进|跟进.{0,6}项目).{0,8}(?:不要|不用|取消|停止)/i;
const INFORMATIONAL_RE = /(?:怎么|如何|什么是|介绍|说明|文档|用法|支持|能不能|能否|可以吗|是否可以).{0,12}项目跟进|项目跟进.{0,12}(?:怎么|如何|是什么|用法|支持|能不能|能否|可以吗)/i;
const OTHER_TASK_RE = /(?:帮我|请|麻烦).{0,12}(?:总结|分析|阅读|看看|看一下|提炼|翻译|评价|创建项目|项目创建|投后录入)/i;
const FOLLOWUP_ARTIFACT_TASK_RE = /(?:整理|处理|总结|分析|阅读|看看|提炼|翻译|评价).{0,12}项目跟进(?:材料|记录|文档|内容)/i;

function hasMaterial(text: string, attachmentCount: number): boolean {
  return attachmentCount > 0 || MATERIAL_RE.test(text) || URL_TEST_RE.test(text);
}

function projectHint(text: string): string {
  const quoted = text.match(/[「“"]([^」”"\n]{2,60})[」”"]\s*(?:的)?项目跟进/i)?.[1]?.trim();
  if (quoted) return quoted;

  const latin = text.match(/(?:帮我|请|麻烦)?\s*(?:做|处理|整理|发起|开始|走|跑)(?:一下|下)?\s*([A-Za-z][A-Za-z0-9._-]{1,60})\s*(?:的)?项目跟进/i)?.[1];
  if (latin) return latin;

  const chinese = text.match(/(?:帮我|请|麻烦)\s*(?:做|处理|整理|发起|开始|走|跑)(?:一下|下)?\s*([\p{Script=Han}]{2,20})\s*(?:的)?项目跟进/iu)?.[1];
  return chinese || '';
}

function normalizedFollowupText(text: string, hint: string): string {
  const refs = Array.from(text.matchAll(URL_RE), (match) => match[0])
    .map((url) => url.replace(/[，。！？；：、)）\]}】>]+$/g, ''))
    .filter(Boolean);
  const tokenRefs = Array.from(text.matchAll(/(?:minute_token|obj_token)\s*[:=]\s*[A-Za-z0-9_-]+/gi), (match) => match[0]);
  return ['/项目跟进', hint, ...refs, ...tokenRefs].filter(Boolean).join(' ');
}

/** Deterministic NL ingress for the existing /项目跟进 flow. It only classifies
 * turns that carry material in the same turn (including Material Inbox merges). */
export function classifyNaturalFollowupEntry(args: {
  text?: string;
  attachmentCount?: number;
}): NaturalFollowupEntry {
  const text = String(args.text || '').trim();
  if (!text || text.startsWith('/') || !hasMaterial(text, args.attachmentCount || 0)) return { kind: 'none' };
  if (NEGATED_RE.test(text) || INFORMATIONAL_RE.test(text) || FOLLOWUP_ARTIFACT_TASK_RE.test(text)) return { kind: 'none' };

  const strong = STRONG_FOLLOWUP_RE.test(text)
    || /(?:帮我|请|麻烦)\s*(?:做|处理|整理|发起|开始|走|跑)(?:一下|下)?\s*[「“"]?[^\s，。！？]{2,60}[」”"]?\s*(?:的)?项目跟进(?!材料|记录|文档|内容|怎么|如何)/i.test(text);
  if (strong) {
    const hint = projectHint(text);
    return { kind: 'route', normalizedText: normalizedFollowupText(text, hint), projectHint: hint };
  }

  if (FOLLOWUP_WORD_RE.test(text) && !OTHER_TASK_RE.test(text)) return { kind: 'clarify' };
  return { kind: 'none' };
}
