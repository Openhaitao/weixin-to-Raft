import crypto from "node:crypto";

import type { ChatRequest, ChatResponse } from "weixin-agent-sdk";

import {
  classifyDraftReply,
  composeProjectFollowupAppend,
  parseProjectFollowupAppend,
  parseProjectFollowupDraftDirectiveResult,
  validateCardIntent,
  type ProjectDraftSchemaField,
  type ProjectFollowupSections,
} from "./vendor/card-intent-core.js";
import {
  buildFollowupHistoryFact,
  buildFollowupStage2Prompt,
  type FollowupHistoryFact,
} from "./vendor/followup-history.js";
import {
  classifyFollowupSearchResult,
  deriveFollowupSearchKeyword,
  isRetryableFollowupSearchFailure,
  type FollowupStage1Project,
  type FollowupStage1Result,
} from "./vendor/followup-stage1.js";
import {
  buildAttachmentMaterial,
  normalizeMemoEntry,
  pollTouziyunTextAuth,
  readJsonFile,
  resolveFeishuIdentity,
  resolveTouziyunBpScript,
  resolveTouziyunUserKey,
  resolveWechatStateFile,
  runTouziyunAuth,
  runTouziyunScriptJson,
  startTouziyunTextAuth,
  writeJsonFile,
} from "./touziyun-shared.js";

type FlowRoute =
  | { handled: true; response: ChatResponse }
  | { handled: false; request: ChatRequest };

/** The slice of MaterialInbox the flow needs: material stashed BEFORE the command
 * (bare link/file, silently cached) must be visible to /项目跟进, mirroring the
 * Feishu adapter's merge-before-intent ordering. */
type MaterialInboxLike = {
  has(conversationId: string): boolean;
  mergeInto(request: ChatRequest): ChatRequest;
};

type BeforeAgentOptions = {
  materialInbox?: MaterialInboxLike;
};

type Candidate = FollowupStage1Project;

type SubmissionRecord = { status: "inflight" | "completed"; savedAt: number };

type FlowState =
  | { phase: "awaiting_material"; hint: string; updatedAt: number }
  | {
      phase: "choosing";
      keyword: string;
      candidates: Candidate[];
      materialText: string;
      updatedAt: number;
    }
  | {
      phase: "analyzing";
      followupId: string;
      projectId: string;
      projectName: string;
      alternates: Candidate[];
      history: FollowupHistoryFact;
      materialText: string;
      retryCount: number;
      updatedAt: number;
    }
  | {
      phase: "draft";
      followupId: string;
      projectId: string;
      projectName: string;
      alternates: Candidate[];
      sections: ProjectFollowupSections;
      meetingMemoAppend: string;
      historyStatus: string;
      historyEmpty: boolean;
      history: FollowupHistoryFact;
      materialText: string;
      authStartedAt?: number;
      updatedAt: number;
    };

const STATE_TTL_MS = 30 * 60 * 1000;
const SUBMISSION_TTL_MS = 30 * 60 * 1000;
const MAX_ALTERNATES = 4;
const ALTERNATE_LETTERS = ["A", "B", "C", "D"] as const;

/** Text-editable projection of the single followup confirmation card: the three
 * conclusion sections plus meeting link/date. Numeric indexes address these in
 * order, exactly like the Feishu card's separate inputs. */
const FOLLOWUP_EDIT_SCHEMA: ProjectDraftSchemaField[] = [
  { name: "followup_new", label: "本次新增", kind: "multiline" },
  { name: "followup_change", label: "判断变化", kind: "multiline" },
  { name: "followup_next", label: "下一步", kind: "multiline" },
  { name: "meetingMemo", label: "会议纪要链接", kind: "single" },
  { name: "meetingDate", label: "会议日期", kind: "single" },
];

function isFollowupCommand(text: string): boolean {
  return /^[/／]项目跟进(?:\s|$)/.test(text.trim());
}

function followupCommandTail(text: string): string {
  const match = text.trim().match(/^[/／]项目跟进(?:\s+([\s\S]*))?$/);
  return match?.[1]?.trim() || "";
}

function hasConcreteMaterial(request: ChatRequest): boolean {
  return Boolean(
    request.media ||
    request.text.includes("【Material Inbox /") ||
    /https?:\/\/\S+/i.test(request.text),
  );
}

function materialTitleOf(request: ChatRequest): string {
  return request.media?.fileName?.trim() || "";
}

function newFollowupId(projectId: string): string {
  return `wxf-${projectId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function parseSwitchCommand(text: string, limit: number): number | null {
  const match = text.trim().match(/^(?:切换|选择)?\s*([A-Da-d])$/);
  const explicit = text.trim().match(/^(?:切换|选择)\s*([A-Da-d])$/);
  const letter = (explicit || (text.trim().length === 1 ? match : null))?.[1];
  if (!letter) return null;
  const index = ALTERNATE_LETTERS.indexOf(letter.toUpperCase() as (typeof ALTERNATE_LETTERS)[number]);
  return index >= 0 && index < limit ? index : null;
}

async function buildMaterialText(request: ChatRequest): Promise<string> {
  const attachment = await buildAttachmentMaterial(request);
  const tail = isFollowupCommand(request.text) ? followupCommandTail(request.text) : request.text.trim();
  return [tail, attachment].filter(Boolean).join("\n\n");
}

function envFixture(name: string): Record<string, unknown> | null {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runFollowupSearch(keyword: string, userKey: string, expectName: string): Promise<Record<string, unknown>> {
  const fixture = envFixture("WEIXIN_AGENT_TOUZIYUN_SEARCH_JSON");
  if (fixture) return fixture;
  const args = [resolveTouziyunBpScript(), "search", "--keyword", keyword, "--user", userKey];
  if (userKey !== "default" && expectName) args.push("--expect-name", expectName);
  return runTouziyunScriptJson(args, { timeoutMs: 60_000 });
}

async function runFollowupHistoryGet(projectId: string, userKey: string, expectName: string): Promise<Record<string, unknown>> {
  const fixture = envFixture("WEIXIN_AGENT_TOUZIYUN_GET_JSON");
  if (fixture) return fixture;
  const args = [resolveTouziyunBpScript(), "get", "--project", projectId, "--user", userKey];
  if (userKey !== "default" && expectName) args.push("--expect-name", expectName);
  return runTouziyunScriptJson(args, { timeoutMs: 60_000 });
}

async function runFollowupWrite(args: string[]): Promise<Record<string, unknown>> {
  const fixture = envFixture("WEIXIN_AGENT_TOUZIYUN_FOLLOW_JSON");
  if (fixture) return fixture;
  return runTouziyunScriptJson(args, { timeoutMs: 120_000 });
}

/** Deterministic stage-1: derive keyword → search Touziyun → classify. Mirrors the
 * Feishu adapter's prepareFollowupStage1 including the single transient retry. */
async function prepareStage1(args: {
  text: string;
  materialTitle: string;
  userKey: string;
  expectName: string;
}): Promise<FollowupStage1Result> {
  const keyword = deriveFollowupSearchKeyword({ text: args.text, materialTitle: args.materialTitle });
  if (!keyword) return { status: "unresolved", keyword: "", attempts: 0 };
  if (!args.userKey) return { status: "auth", keyword, attempts: 0, reason: "no-user-key" };

  let raw: Record<string, unknown> = {};
  let attempts = 0;
  for (attempts = 1; attempts <= 2; attempts++) {
    raw = await runFollowupSearch(keyword, args.userKey, args.expectName);
    if (!isRetryableFollowupSearchFailure(raw)) break;
    if (attempts === 1) continue;
  }
  return classifyFollowupSearchResult(raw, keyword, Math.min(attempts, 2));
}

/** WeChat stage-2 prompt: the vendored Feishu prompt (fixed projectId + script-truth
 * history) plus the marker grammar the Feishu model gets from its skill file. */
function buildWechatStage2Prompt(args: {
  projectId: string;
  projectName: string;
  history: FollowupHistoryFact;
  materialText: string;
}): string {
  const base = buildFollowupStage2Prompt({
    projectId: args.projectId,
    projectName: args.projectName,
    history: args.history,
  });
  return [
    "[WeChat /项目跟进 flow]",
    base,
    "",
    "输出格式（微信侧严格要求）：先用一两句话自然说明，然后输出一个 marker 块，JSON 放在两行 marker 之间：",
    "[[PROJECT_FOLLOWUP_DRAFT]]",
    `{"projectId":"${args.projectId}","projectName":"${args.projectName}","meetingDate":"YYYY-MM-DD","meetingUrl":"材料里的会议纪要链接，没有就空串","meetingMemoAppend":"YYYY-MM-DD：<纪要链接>，没有链接就空串","followupAppend":"【本次新增】…\\n【判断变化】…\\n【下一步】…","historyStatus":"原样复制上面脚本结果里的 historyStatus"}`,
    "[[/PROJECT_FOLLOWUP_DRAFT]]",
    "规则：projectId 必须原样使用，不能改写；historyStatus 必须原样复制脚本结果，不由你推断；",
    "followupAppend 必须包含【本次新增】【判断变化】【下一步】三段（某段确实没有内容可留空段落但保留其他段）；",
    "只读本次材料与上面注入的历史，不要调用任何搜索或写库工具；不要输出 ::card:: 块。",
    "",
    "[本次会议材料]",
    args.materialText || "(无附加材料文本)",
  ].join("\n");
}

function renderAlternatesLines(alternates: Candidate[]): string[] {
  if (!alternates.length) return [];
  const lines = ["", "备选项目（如果上面匹配错了）："];
  alternates.forEach((candidate, idx) => {
    lines.push(`${ALTERNATE_LETTERS[idx]}. ${candidate.name || candidate.id}`);
  });
  lines.push("回复 `切换 A`（对应字母）换成备选项目，当前草稿将作废重新生成。");
  return lines;
}

function renderDraftText(state: Extract<FlowState, { phase: "draft" }>): string {
  const value = (v: string) => (String(v || "").trim() ? String(v).trim() : "（空）");
  const lines = [
    `📝 确认本次跟进 · ${state.projectName || state.projectId}`,
    "",
    `会议日期：${state.sections.meetingDate || "（未识别）"}`,
    `1. 本次新增：${value(state.sections.newFacts)}`,
    `2. 判断变化：${value(state.sections.judgmentChanges)}`,
    `3. 下一步：${value(state.sections.nextSteps)}`,
    `4. 会议纪要链接：${value(state.meetingMemoAppend)}`,
    "",
    state.historyEmpty ? "（该项目在投资云暂无更早历史，本次为首条跟进）" : "（写入方式为追加，不覆盖历史跟进）",
    ...renderAlternatesLines(state.alternates),
    "",
    "回复 `确认提交` 写入投资云；`修改 1=新值` 或 `本次新增=新值` 编辑（多行内容一次改一段）；`取消` 放弃。",
  ];
  return lines.join("\n");
}

function renderCandidatesText(keyword: string, candidates: Candidate[]): string {
  const lines = [
    `按关键词「${keyword}」在投资云找到多个项目，请选择本次跟进的对象：`,
  ];
  candidates.forEach((candidate, idx) => {
    lines.push(`${ALTERNATE_LETTERS[idx]}. ${candidate.name || candidate.id}`);
  });
  lines.push("", "回复 `选择 A`（对应字母）继续；回复 `取消` 放弃。");
  return lines.join("\n");
}

export class WechatProjectFollowupFlow {
  private readonly states = new Map<string, FlowState>();
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly pendingModelPrompts = new Map<string, string>();
  private readonly stateFile = resolveWechatStateFile("project-followup-text-flow.json");
  private loaded = false;

  async beforeAgent(request: ChatRequest, options: BeforeAgentOptions = {}): Promise<FlowRoute> {
    await this.load();
    this.prune();
    const text = request.text.trim();
    const existing = this.states.get(request.conversationId);

    if (isFollowupCommand(text)) {
      // Material-first sequence: bare material stashed by the inbox before the
      // command counts as this command's material (keyword still derives from the
      // original command text, not the merged block).
      const merged = this.mergeInboxMaterial(request, options);
      if (!hasConcreteMaterial(merged) && !followupCommandTail(text)) {
        this.states.set(request.conversationId, { phase: "awaiting_material", hint: "", updatedAt: Date.now() });
        await this.save();
        return {
          handled: true,
          response: { text: "收到，开始项目跟进。把这次的会议纪要链接、文档或材料发我（可以带项目名，如 `/项目跟进 星海科技 + 链接`）。" },
        };
      }
      return { handled: true, response: await this.startStage1(merged, text) };
    }

    if (!existing) return { handled: false, request };

    if (existing.phase === "awaiting_material") {
      if (/^(取消|先不跟|放弃)$/i.test(text)) {
        this.states.delete(request.conversationId);
        await this.save();
        return { handled: true, response: { text: "已取消这次项目跟进。" } };
      }
      const merged = this.mergeInboxMaterial(request, options);
      if (!hasConcreteMaterial(merged) && !text) {
        return { handled: true, response: { text: "把这次的会议纪要链接、文档或材料发我就行。" } };
      }
      return { handled: true, response: await this.startStage1(merged, text) };
    }

    if (existing.phase === "choosing") {
      if (/^(取消|先不跟|放弃)$/i.test(text)) {
        this.states.delete(request.conversationId);
        await this.save();
        return { handled: true, response: { text: "已取消这次项目跟进。" } };
      }
      const picked = parseSwitchCommand(text, existing.candidates.length);
      if (picked === null) {
        return { handled: true, response: { text: renderCandidatesText(existing.keyword, existing.candidates) } };
      }
      const project = existing.candidates[picked];
      const alternates = existing.candidates.filter((_, idx) => idx !== picked).slice(0, MAX_ALTERNATES);
      return await this.enterStage2(request, {
        project,
        alternates,
        materialText: existing.materialText,
      });
    }

    if (existing.phase === "analyzing") {
      // A user message racing the model turn: keep it simple and deterministic.
      if (/^(取消|先不跟|放弃)$/i.test(text)) {
        this.states.delete(request.conversationId);
        await this.save();
        return { handled: true, response: { text: "已取消这次项目跟进。" } };
      }
      return { handled: true, response: { text: `正在为「${existing.projectName}」生成本次跟进草稿，请稍候。` } };
    }

    // draft phase
    return { handled: true, response: await this.handleDraftReply(request, existing) };
  }

  private mergeInboxMaterial(request: ChatRequest, options: BeforeAgentOptions): ChatRequest {
    if (hasConcreteMaterial(request)) return request;
    if (!options.materialInbox?.has(request.conversationId)) return request;
    return options.materialInbox.mergeInto(request);
  }

  async isAwaitingMaterial(conversationId: string): Promise<boolean> {
    await this.load();
    this.prune();
    return this.states.get(conversationId)?.phase === "awaiting_material";
  }

  /** One-shot silent self-heal: when the model turn produced an invalid draft marker,
   * the flow stashes a retry prompt here; the agent re-prompts once and re-runs
   * afterAgent. Mirrors the Feishu adapter's scheduleHardFollowRetry semantics. */
  takePendingModelPrompt(conversationId: string): string | null {
    const prompt = this.pendingModelPrompts.get(conversationId) || null;
    this.pendingModelPrompts.delete(conversationId);
    return prompt;
  }

  async afterAgent(request: ChatRequest, response: ChatResponse): Promise<ChatResponse> {
    await this.load();
    const state = this.states.get(request.conversationId);
    if (state?.phase !== "analyzing" || !response.text) return response;

    const parsed = parseProjectFollowupDraftDirectiveResult(response.text);
    const intent = parsed.intent;
    const validation = intent ? validateCardIntent(intent) : { ok: false, error: parsed.error || "marker-missing" };
    const projectLocked = intent ? String(intent.projectId) === state.projectId : false;

    if (!intent || !validation.ok || !projectLocked) {
      const failure = !intent
        ? (parsed.error || "模型没有输出结构化跟进草稿")
        : !validation.ok
          ? (validation.error || "草稿校验失败")
          : `projectId 被改写（期望 ${state.projectId}）`;
      if (state.retryCount < 1) {
        this.states.set(request.conversationId, { ...state, retryCount: state.retryCount + 1, updatedAt: Date.now() });
        await this.save();
        this.pendingModelPrompts.set(request.conversationId, [
          `[系统重试] 上一次输出无效：${failure}。`,
          buildWechatStage2Prompt({
            projectId: state.projectId,
            projectName: state.projectName,
            history: state.history,
            materialText: state.materialText,
          }),
        ].join("\n"));
        return response;
      }
      this.states.delete(request.conversationId);
      await this.save();
      return {
        text: `本次跟进草稿生成失败（${failure}），未写库。请重新发送 /项目跟进 + 材料再试一次。`,
      };
    }

    // Script truth overrides model output (same as Feishu PR #58 semantics): the
    // history status shown/persisted comes from the get-script result, never the model.
    const sections = parseProjectFollowupAppend(String(intent.followupAppend || ""), String(intent.meetingDate || ""));
    const draft: Extract<FlowState, { phase: "draft" }> = {
      phase: "draft",
      followupId: state.followupId,
      projectId: state.projectId,
      projectName: state.projectName || String(intent.projectName || ""),
      alternates: state.alternates,
      sections,
      meetingMemoAppend: String(intent.meetingMemoAppend || ""),
      historyStatus: state.history.status,
      historyEmpty: state.history.historyEmpty,
      history: state.history,
      materialText: state.materialText,
      updatedAt: Date.now(),
    };
    this.states.set(request.conversationId, draft);
    await this.save();
    return { text: renderDraftText(draft) };
  }

  async reset(conversationId: string): Promise<void> {
    await this.load();
    this.states.delete(conversationId);
    this.pendingModelPrompts.delete(conversationId);
    await this.save();
  }

  private async startStage1(request: ChatRequest, text: string): Promise<ChatResponse> {
    const identity = await resolveFeishuIdentity();
    const userKey = await resolveTouziyunUserKey(identity);
    const stage1 = await prepareStage1({
      text: isFollowupCommand(text) ? text : `/项目跟进 ${text}`,
      materialTitle: materialTitleOf(request),
      userKey,
      expectName: identity.userName || "",
    });

    if (stage1.status === "unresolved") {
      return {
        text: "没能从这条消息确定要跟进的项目。请带上项目名重发，例如 `/项目跟进 星海科技` + 材料链接。",
      };
    }
    if (stage1.status === "auth") {
      this.states.delete(request.conversationId);
      await this.save();
      const auth = await startTouziyunTextAuth("然后重新发送 /项目跟进 + 材料，我会继续。");
      return auth;
    }
    if (stage1.status === "error") {
      this.states.delete(request.conversationId);
      await this.save();
      return { text: `投资云项目查询失败（${stage1.reason || "unknown"}），本次未写库。请稍后重发 /项目跟进 + 材料。` };
    }
    if (stage1.status === "no_match") {
      this.states.delete(request.conversationId);
      await this.save();
      return {
        text: `投资云里没找到「${stage1.keyword}」对应的项目。请确认项目名后重发；如果是新项目，先走 /项目创建。`,
      };
    }

    const materialText = await buildMaterialText(request);
    if (stage1.status === "multiple") {
      const candidates = (stage1.matches || []).slice(0, MAX_ALTERNATES);
      this.states.set(request.conversationId, {
        phase: "choosing",
        keyword: stage1.keyword,
        candidates,
        materialText,
        updatedAt: Date.now(),
      });
      await this.save();
      return { text: renderCandidatesText(stage1.keyword, candidates) };
    }

    // unique: trusted autoPick only — auto-advance to stage-2 (single merged flow).
    const project = stage1.project!;
    const alternates = (stage1.matches || []).filter((m) => m.id !== project.id).slice(0, MAX_ALTERNATES);
    return (await this.enterStage2(request, { project, alternates, materialText })).response;
  }

  /** Read history (script truth), then hand the conversation to the model for the
   * stage-2 analysis turn. Returns handled:false with the rewritten request. */
  private async enterStage2(
    request: ChatRequest,
    args: { project: Candidate; alternates: Candidate[]; materialText: string },
  ): Promise<Extract<FlowRoute, { handled: true }>> {
    const identity = await resolveFeishuIdentity();
    const userKey = await resolveTouziyunUserKey(identity);
    const raw = await runFollowupHistoryGet(args.project.id, userKey, identity.userName || "");
    const history = buildFollowupHistoryFact(raw as never);

    this.states.set(request.conversationId, {
      phase: "analyzing",
      followupId: newFollowupId(args.project.id),
      projectId: args.project.id,
      projectName: args.project.name || "",
      alternates: args.alternates,
      history,
      materialText: args.materialText,
      retryCount: 0,
      updatedAt: Date.now(),
    });
    await this.save();

    this.pendingModelPrompts.set(request.conversationId, buildWechatStage2Prompt({
      projectId: args.project.id,
      projectName: args.project.name || "",
      history,
      materialText: args.materialText,
    }));
    return {
      handled: true,
      response: {
        text: `✅ 已锁定投资云项目「${args.project.name || args.project.id}」，正在读取历史并生成本次跟进草稿…`,
      },
    };
  }

  private async handleDraftReply(
    request: ChatRequest,
    state: Extract<FlowState, { phase: "draft" }>,
  ): Promise<ChatResponse> {
    const text = request.text.trim();

    const switched = parseSwitchCommand(text, state.alternates.length);
    if (switched !== null && /^(?:切换|选择)/.test(text)) {
      return await this.switchProject(request, state, switched);
    }

    const reply = classifyDraftReply(text, FOLLOWUP_EDIT_SCHEMA);
    if (reply.kind === "cancel") {
      if (state.authStartedAt) {
        const identity = await resolveFeishuIdentity();
        const userKey = await resolveTouziyunUserKey(identity);
        if (userKey) void runTouziyunAuth(["authorize-cancel", "--user", userKey], 30_000);
      }
      await this.reset(request.conversationId);
      return { text: "已取消这次项目跟进，未写库。" };
    }
    if (reply.kind === "edit" && reply.updates) {
      const next: Extract<FlowState, { phase: "draft" }> = {
        ...state,
        sections: {
          meetingDate: reply.updates.meetingDate ?? state.sections.meetingDate,
          newFacts: reply.updates.followup_new ?? state.sections.newFacts,
          judgmentChanges: reply.updates.followup_change ?? state.sections.judgmentChanges,
          nextSteps: reply.updates.followup_next ?? state.sections.nextSteps,
        },
        meetingMemoAppend: reply.updates.meetingMemo ?? state.meetingMemoAppend,
        updatedAt: Date.now(),
      };
      this.states.set(request.conversationId, next);
      await this.save();
      return { text: renderDraftText(next) };
    }
    if (reply.kind === "confirm" || reply.kind === "auth-scanned") {
      return await this.submitDraft(request.conversationId, state);
    }
    return {
      text: state.authStartedAt
        ? "当前投资云授权在等待扫码。扫完后回复 `已扫码`；也可以 `取消`。"
        : "当前有一份跟进草稿在等确认。回复 `确认提交` 写入投资云，`修改 1=新值` 编辑，`切换 A` 换项目，或 `取消`。",
    };
  }

  /** Switch to an alternate project: the old draft is superseded fail-closed —
   * its followupId is recorded and any submit path for it is rejected; a fresh
   * followupId + stage-2 rerun replaces it. */
  private async switchProject(
    request: ChatRequest,
    state: Extract<FlowState, { phase: "draft" }>,
    index: number,
  ): Promise<ChatResponse> {
    const target = state.alternates[index];
    if (!target) return { text: "没有这个备选项目编号。" };
    this.submissions.set(state.followupId, { status: "completed", savedAt: Date.now() });
    const alternates = [
      { id: state.projectId, name: state.projectName },
      ...state.alternates.filter((_, idx) => idx !== index),
    ].slice(0, MAX_ALTERNATES);
    const advanced = await this.enterStage2(request, {
      project: target,
      alternates,
      materialText: state.materialText,
    });
    return {
      text: [
        `上一份「${state.projectName || state.projectId}」的跟进草稿已作废（不会写库）。`,
        advanced.response.text || "",
      ].filter(Boolean).join("\n"),
    };
  }

  private async submitDraft(
    conversationId: string,
    state: Extract<FlowState, { phase: "draft" }>,
  ): Promise<ChatResponse> {
    // superseded fail-closed: switchProject records the old followupId as completed
    // in the submissions map, so a switched-away draft can never submit — even one
    // resurrected from a stale state file.
    const prior = this.submissions.get(state.followupId);
    if (prior && Date.now() - prior.savedAt < SUBMISSION_TTL_MS) {
      return {
        text: prior.status === "completed"
          ? "这次跟进已经提交过（或已作废），不再重复写入。"
          : "这次跟进正在写入中，请勿重复提交。",
      };
    }

    const followupText = composeProjectFollowupAppend(state.sections);
    // Same canonical entry format as the create path: date-prefixed, full-width colon.
    const memoText = normalizeMemoEntry(state.meetingMemoAppend, state.sections.meetingDate);
    if (!followupText.trim() && !memoText) {
      return { text: "没有可写入内容——跟进结论和会议纪要链接都是空的，请 `修改` 补充后再 `确认提交`。" };
    }

    if (state.authStartedAt) {
      const poll = await pollTouziyunTextAuth();
      if (!poll.ok) return poll.response || { text: "投资云授权还没完成，未写库。" };
      state = { ...state, authStartedAt: undefined, updatedAt: Date.now() };
      this.states.set(conversationId, state);
      await this.save();
    }

    const identity = await resolveFeishuIdentity();
    const userKey = await resolveTouziyunUserKey(identity);
    if (!userKey) {
      const auth = await startTouziyunTextAuth("我会继续写入这次跟进。");
      this.states.set(conversationId, { ...state, authStartedAt: Date.now(), updatedAt: Date.now() });
      await this.save();
      return auth;
    }

    this.submissions.set(state.followupId, { status: "inflight", savedAt: Date.now() });
    let completed = false;
    try {
      const args = [resolveTouziyunBpScript(), "follow", "--project", state.projectId, "--user", userKey];
      if (userKey !== "default") args.push("--expect-name", identity.userName || "用户");
      if (state.sections.meetingDate) args.push("--date", state.sections.meetingDate);
      if (memoText) args.push("--memo-append", memoText);
      if (followupText) args.push("--followup-append", followupText);
      const result = await runFollowupWrite(args);

      if (result.needAuth) {
        const auth = await startTouziyunTextAuth("我会继续写入这次跟进。");
        this.states.set(conversationId, { ...state, authStartedAt: Date.now(), updatedAt: Date.now() });
        await this.save();
        return auth;
      }
      if (result.ok) {
        completed = true;
        this.submissions.set(state.followupId, { status: "completed", savedAt: Date.now() });
        this.states.delete(conversationId);
        await this.save();
        const written = Array.isArray(result.written) ? result.written.join("、") : "";
        const detailUrl = String(result.detailUrl || "");
        return {
          text: [
            `✅ 已把本次跟进写进「${state.projectName || state.projectId}」${written ? `（已更新：${written}）` : ""}`,
            detailUrl ? `详情：\n${detailUrl}` : "",
          ].filter(Boolean).join("\n"),
        };
      }
      return { text: `项目跟进写入失败，本次未追加。原因：${String(result.reason || "unknown")}` };
    } finally {
      if (!completed) this.submissions.delete(state.followupId);
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJsonFile<{ states?: Record<string, FlowState>; submissions?: Record<string, SubmissionRecord> }>(this.stateFile, {});
    for (const [conversationId, state] of Object.entries(raw.states || {})) {
      this.states.set(conversationId, state);
    }
    for (const [followupId, record] of Object.entries(raw.submissions || {})) {
      this.submissions.set(followupId, record);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const states: Record<string, FlowState> = {};
    for (const [conversationId, state] of this.states.entries()) {
      states[conversationId] = state;
    }
    const submissions: Record<string, SubmissionRecord> = {};
    for (const [followupId, record] of this.submissions.entries()) {
      submissions[followupId] = record;
    }
    await writeJsonFile(this.stateFile, { states, submissions });
  }

  private prune(): void {
    const now = Date.now();
    for (const [conversationId, state] of this.states.entries()) {
      if (now - state.updatedAt > STATE_TTL_MS) this.states.delete(conversationId);
    }
    for (const [followupId, record] of this.submissions.entries()) {
      if (now - record.savedAt > SUBMISSION_TTL_MS) this.submissions.delete(followupId);
    }
  }
}

export const __wechatProjectFollowupTest = {
  FOLLOWUP_EDIT_SCHEMA,
  buildWechatStage2Prompt,
  deriveKeyword: deriveFollowupSearchKeyword,
  isFollowupCommand,
  parseSwitchCommand,
  prepareStage1,
  renderCandidatesText,
};
