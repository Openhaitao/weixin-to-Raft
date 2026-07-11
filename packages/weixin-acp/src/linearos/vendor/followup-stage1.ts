// Vendored from LinearOS src/runtime/followup-stage1.ts
// source commit: e8215c8f7b77f1869a2b2f1c6273280e29e82d2d
// source sha256: efe04f008be877d98a046ae8225c89f35d023797748467beeb6fe2c3971e66d0
// Do not edit by hand; run the drift sentinel after refreshing this file.
// @ts-nocheck

export type FollowupStage1Status = 'unique' | 'multiple' | 'no_match' | 'auth' | 'unresolved' | 'error';

export interface FollowupStage1Project {
  id: string;
  name: string;
}

export interface FollowupStage1Result {
  status: FollowupStage1Status;
  keyword: string;
  attempts: number;
  project?: FollowupStage1Project;
  matches?: FollowupStage1Project[];
  reason?: string;
}

function cleanCandidate(value: string): string {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/^[/／]项目跟进(?:@\S+)?\s*/i, '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/^[\s:：_-]+|[\s:：_-]+$/g, '')
    .trim();
}

function candidateFromTitle(title: string): string {
  const cleaned = cleanCandidate(title)
    .replace(/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\s*/, '')
    .replace(/^(?:会议纪要|访谈纪要|项目交流|项目沟通|路演)[\s:：_-]*/i, '');
  if (!cleaned) return '';

  const latin = cleaned.match(/[A-Za-z][A-Za-z0-9._-]{1,60}/)?.[0] || '';
  if (latin) return latin;

  return cleaned
    .split(/[\s　|｜:：,，、/（(]|创始人|创始团队|项目交流|项目沟通|会议纪要|访谈纪要/)[0]
    .replace(/(?:项目|公司)$/g, '')
    .trim()
    .slice(0, 60);
}

/** Conservative project-name extraction for deterministic stage-1 search.
 * Material title is preferred. Free text is accepted only when the command
 * carries a short, link-free project hint before the material URL. */
export function deriveFollowupSearchKeyword(args: { text?: string; materialTitle?: string }): string {
  const commandTail = cleanCandidate(args.text || '').split(/https?:\/\//i)[0].trim();
  if (commandTail && commandTail.length <= 80 && !/[。！？!?\n]/.test(commandTail)) {
    const first = commandTail.split(/[\s　:：,，、/（(]/)[0].trim();
    if (first.length >= 2) return first.slice(0, 60);
  }

  const fromTitle = candidateFromTitle(args.materialTitle || '');
  return fromTitle.length >= 2 ? fromTitle : '';
}

function projects(value: unknown): FollowupStage1Project[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item: any) => ({ id: String(item?.id || '').trim(), name: String(item?.name || '').trim() }))
    .filter((item) => item.id)
    .slice(0, 6);
}

export function isRetryableFollowupSearchFailure(result: any): boolean {
  if (!result || typeof result !== 'object') return true;
  if (result.needAuth === true) return false;
  const reason = String(result.reason || '');
  if (/needs-qr-bind|no-token|no-user-key|identity-fail-closed/i.test(reason)) return false;
  return result.ok !== true;
}

export function classifyFollowupSearchResult(
  raw: any,
  keyword: string,
  attempts: number,
): FollowupStage1Result {
  if (raw?.needAuth === true || /needs-qr-bind|no-token|no-user-key|identity-fail-closed/i.test(String(raw?.reason || ''))) {
    return { status: 'auth', keyword, attempts, reason: String(raw?.reason || 'touziyun-auth-required') };
  }
  if (raw?.ok !== true) {
    return { status: 'error', keyword, attempts, reason: String(raw?.reason || 'search-failed') };
  }

  const matches = projects(raw.matches);
  if (!matches.length) return { status: 'no_match', keyword, attempts, matches: [] };
  const pickedId = String(raw.autoPick || '').trim();
  const project = pickedId ? matches.find((item) => item.id === pickedId) : undefined;
  if (project) return { status: 'unique', keyword, attempts, project, matches };
  return { status: 'multiple', keyword, attempts, matches };
}

export function buildFollowupStage1Fact(result?: FollowupStage1Result | null): string {
  if (!result) return '';
  const payload = JSON.stringify({
    status: result.status,
    keyword: result.keyword,
    attempts: result.attempts,
    project: result.project,
    matches: result.matches,
    reason: result.reason,
  });
  if (result.status === 'unique') {
    return `\n[项目跟进 stage-1 受信结果] ${payload}。系统已完成投资云查询；禁止再次调用搜索。`
      + `必须使用这里的 exact project.id/project.name 输出 PROJECT_FOLLOWUP_ASK，不能改写 projectId。`;
  }
  return `\n[项目跟进 stage-1 受信结果] ${payload}。系统已完成或尝试投资云查询；禁止再次调用搜索，`
    + `不得输出 PROJECT_FOLLOWUP_ASK/PROJECT_FOLLOWUP_DRAFT。请按 status 如实说明下一步。`;
}
