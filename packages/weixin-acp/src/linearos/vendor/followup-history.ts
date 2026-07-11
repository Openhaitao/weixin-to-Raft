// Vendored from LinearOS src/runtime/followup-history.ts
// source commit: 7d9fd96f7bcdab1b9f7f9137186bae98027225b2
// source sha256: 170641602df069a292c941acb990e1fce7e2f7e6e8d1f72bd4592faf4d16a100
// Do not edit by hand; run the drift sentinel after refreshing this file.
// @ts-nocheck

export interface FollowupHistoryScriptResult {
  ok?: boolean;
  reason?: string;
  meetingMemo?: string;
  followup?: string;
}

export interface FollowupHistoryFact {
  status: string;
  historyEmpty: boolean;
  meetingMemo: string;
  followup: string;
}

export function buildFollowupHistoryFact(result: FollowupHistoryScriptResult | null | undefined): FollowupHistoryFact {
  if (!result?.ok) {
    return {
      status: `投资云历史读取失败：${String(result?.reason || 'unknown')}`,
      historyEmpty: true,
      meetingMemo: '',
      followup: '',
    }
  }
  const meetingMemo = String(result.meetingMemo || '').trim()
  const followup = String(result.followup || '').trim()
  if (!meetingMemo && !followup) {
    return {
      status: '该项目在投资云暂无更早历史。',
      historyEmpty: true,
      meetingMemo: '',
      followup: '',
    }
  }
  return {
    status: `投资云历史字段已读取：会议纪要(AI)=${meetingMemo ? '有' : '无'}；项目跟进(AI)=${followup ? '有' : '无'}。`,
    historyEmpty: false,
    meetingMemo,
    followup,
  }
}

export function buildFollowupStage2Prompt(args: {
  projectId: string
  projectName?: string
  meetingRef?: string
  history: FollowupHistoryFact
}): string {
  const historyPayload = [
    `[项目历史脚本结果] historyStatus=${args.history.status}`,
    args.history.meetingMemo ? `会议纪要(AI)：\n${args.history.meetingMemo}` : '',
    args.history.followup ? `项目跟进(AI)：\n${args.history.followup}` : '',
    '[/项目历史脚本结果]',
  ].filter(Boolean).join('\n')
  return [
    `用户已确认跟进投资云项目「${args.projectName || ''}」(id ${args.projectId})；projectId 固定，不再搜索/改选。`,
    historyPayload,
    `读取上述历史里的有效纪要链接及本次会议材料${args.meetingRef ? `（${args.meetingRef}）` : ''}，生成单段会议总结（200-300 字）。`,
    '总结要素按序（材料里没有的要素跳过，不硬凑）：会议性质一句→新事实/验证点 2-4 个（数字优先）→判断变化一句→下一步。',
    '硬约束：结论先行；只写本次增量，不复述项目档案与上次跟进；禁「深入交流」类套话、禁形容词堆砌、禁重抄商业模式/团队背景。',
    `输出 [[PROJECT_FOLLOWUP_DRAFT]]（projectId=${args.projectId}）；historyStatus 必须原样使用脚本结果，不由模型推断。`,
  ].join('\n')
}
