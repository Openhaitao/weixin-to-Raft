// Vendored from LinearOS src/runtime/followup-history.ts
// source commit: a571b00cc747a4e6aadf0ba5ec8d66b515f07fae
// source sha256: 4f9362f0c817a37a1fe9ee64563156fabd50fd8a84457609ef81fde0f6204872
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
    `读取上述历史里的有效纪要链接及本次会议材料${args.meetingRef ? `（${args.meetingRef}）` : ''}，对比生成本次更新与核心结论。`,
    `输出 [[PROJECT_FOLLOWUP_DRAFT]]（projectId=${args.projectId}）；historyStatus 必须原样使用脚本结果，不由模型推断。`,
  ].join('\n')
}
