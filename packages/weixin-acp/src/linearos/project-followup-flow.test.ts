import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatRequest } from "weixin-agent-sdk";

import { WechatProjectFollowupFlow, __wechatProjectFollowupTest } from "./project-followup-flow.ts";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "wx-followup-test-"));
process.env.WEIXIN_AGENT_HOME = tmpHome;
process.env.WEIXIN_AGENT_FEISHU_OPEN_ID = "ou_test_user_0001";
process.env.WEIXIN_AGENT_FEISHU_UNION_ID = "on_test_user_0001";
process.env.WEIXIN_AGENT_FEISHU_NAME = "测试用户";
delete process.env.TZY_PERUSER; // user key resolves to "default"; no live auth needed

const MINUTE_LINK = "https://linear.feishu.cn/minutes/obcn72h4testminute";

function req(text: string, conversationId = "wx-conv-1"): ChatRequest {
  return { conversationId, text } as ChatRequest;
}

function setSearchFixture(value: unknown): void {
  process.env.WEIXIN_AGENT_TOUZIYUN_SEARCH_JSON = JSON.stringify(value);
}

function setGetFixture(value: unknown): void {
  process.env.WEIXIN_AGENT_TOUZIYUN_GET_JSON = JSON.stringify(value);
}

function setFollowFixture(value: unknown): void {
  process.env.WEIXIN_AGENT_TOUZIYUN_FOLLOW_JSON = JSON.stringify(value);
}

function draftMarker(projectId: string, overrides: Record<string, unknown> = {}): string {
  return [
    "我对比了历史，生成了本次跟进草稿。",
    "[[PROJECT_FOLLOWUP_DRAFT]]",
    JSON.stringify({
      projectId,
      projectName: "星海科技",
      meetingDate: "2026-07-11",
      meetingUrl: MINUTE_LINK,
      meetingMemoAppend: `2026-07-11：${MINUTE_LINK}`,
      followupAppend: "本次复谈确认完成 POC 验证，置信度上调；下一步两周内出报价。",
      historyStatus: "该项目在投资云暂无更早历史。",
      ...overrides,
    }),
    "[[/PROJECT_FOLLOWUP_DRAFT]]",
  ].join("\n");
}

async function buildDraft(flow: WechatProjectFollowupFlow, conversationId: string): Promise<void> {
  setSearchFixture({
    ok: true,
    keyword: "星海科技",
    matches: [
      { id: "p-100", name: "星海科技" },
      { id: "p-200", name: "星海智能" },
    ],
    autoPick: "p-100",
  });
  setGetFixture({ ok: true, project: "p-100", projectName: "星海科技", meetingMemo: "", followup: "" });

  const routed = await flow.beforeAgent(req(`/项目跟进 星海科技 ${MINUTE_LINK}`, conversationId));
  assert.ok(routed.handled, "unique stage-1 must be handled with a progress receipt");
  assert.match(routed.handled ? routed.response.text || "" : "", /已锁定投资云项目「星海科技」/);

  const prompt = flow.takePendingModelPrompt(conversationId);
  assert.ok(prompt, "stage-2 model prompt must be pending after unique lock");
  assert.match(prompt!, /projectId 必须原样使用/);
  assert.match(prompt!, /p-100/);
  assert.match(prompt!, /\[\[PROJECT_FOLLOWUP_DRAFT\]\]/);

  const draftResponse = await flow.afterAgent(req("", conversationId), { text: draftMarker("p-100") });
  assert.match(draftResponse.text || "", /确认本次跟进 · 星海科技/);
  assert.match(draftResponse.text || "", /1\. 会议总结（200-300 字，结论先行）：本次复谈确认完成 POC 验证/);
  assert.match(draftResponse.text || "", /2\. 会议纪要链接：/);
  assert.match(draftResponse.text || "", /3\. 会议日期：2026-07-11/);
  assert.match(draftResponse.text || "", /备选项目/);
  assert.match(draftResponse.text || "", /A\. 星海智能/);
}

async function testCommandWithoutMaterialAsksForMaterial(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  const routed = await flow.beforeAgent(req("/项目跟进", "wx-conv-nomat"));
  assert.ok(routed.handled);
  assert.match(routed.handled ? routed.response.text || "" : "", /会议纪要链接|材料/);
  assert.equal(await flow.isAwaitingMaterial("wx-conv-nomat"), true);
  await flow.reset("wx-conv-nomat");
}

async function testUniqueAutoAdvancesAndRendersSingleDraft(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  await buildDraft(flow, "wx-conv-unique");
  await flow.reset("wx-conv-unique");
}

async function testNoAutoPickShowsCandidatesAndPickEntersStage2(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  setSearchFixture({
    ok: true,
    keyword: "星海",
    matches: [
      { id: "p-100", name: "星海科技" },
      { id: "p-200", name: "星海智能" },
    ],
    autoPick: null,
  });
  setGetFixture({ ok: true, project: "p-200", projectName: "星海智能", meetingMemo: "", followup: "" });

  const routed = await flow.beforeAgent(req(`/项目跟进 星海 ${MINUTE_LINK}`, "wx-conv-multi"));
  assert.ok(routed.handled);
  const listText = routed.handled ? routed.response.text || "" : "";
  assert.match(listText, /找到多个项目/);
  assert.match(listText, /A\. 星海科技/);
  assert.match(listText, /B\. 星海智能/);
  assert.equal(flow.takePendingModelPrompt("wx-conv-multi"), null, "no model turn before user picks");

  const picked = await flow.beforeAgent(req("选择 B", "wx-conv-multi"));
  assert.ok(picked.handled);
  assert.match(picked.handled ? picked.response.text || "" : "", /已锁定投资云项目「星海智能」/);
  const prompt = flow.takePendingModelPrompt("wx-conv-multi");
  assert.ok(prompt && prompt.includes("p-200"), "stage-2 prompt must target the picked project");
  await flow.reset("wx-conv-multi");
}

async function testNoMatchAndErrorAreDeterministicStops(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  setSearchFixture({ ok: true, keyword: "不存在的项目", matches: [], autoPick: null });
  const noMatch = await flow.beforeAgent(req(`/项目跟进 不存在的项目 ${MINUTE_LINK}`, "wx-conv-nomatch"));
  assert.ok(noMatch.handled);
  assert.match(noMatch.handled ? noMatch.response.text || "" : "", /没找到.*项目|没找到「/);

  setSearchFixture({ ok: false, reason: "search-timeout" });
  const errored = await flow.beforeAgent(req(`/项目跟进 星海科技 ${MINUTE_LINK}`, "wx-conv-error"));
  assert.ok(errored.handled);
  assert.match(errored.handled ? errored.response.text || "" : "", /查询失败/);
  assert.match(errored.handled ? errored.response.text || "" : "", /未写库/);
}

async function testProjectIdRewriteGetsOneSilentRetryThenFailsClosed(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  setSearchFixture({ ok: true, keyword: "星海科技", matches: [{ id: "p-100", name: "星海科技" }], autoPick: "p-100" });
  setGetFixture({ ok: true, project: "p-100", projectName: "星海科技", meetingMemo: "", followup: "" });
  const conversationId = "wx-conv-lock";

  const routed = await flow.beforeAgent(req(`/项目跟进 星海科技 ${MINUTE_LINK}`, conversationId));
  assert.ok(routed.handled);
  assert.ok(flow.takePendingModelPrompt(conversationId));

  const firstBad = await flow.afterAgent(req("", conversationId), { text: draftMarker("p-999") });
  assert.equal(firstBad.text, draftMarker("p-999"), "first invalid turn passes through while retry is scheduled");
  const retryPrompt = flow.takePendingModelPrompt(conversationId);
  assert.ok(retryPrompt, "one silent self-heal retry must be scheduled");
  assert.match(retryPrompt!, /系统重试/);

  const secondBad = await flow.afterAgent(req("", conversationId), { text: draftMarker("p-999") });
  assert.match(secondBad.text || "", /生成失败/);
  assert.match(secondBad.text || "", /未写库/);
  assert.equal(flow.takePendingModelPrompt(conversationId), null, "no second retry — fail closed");
}

async function testEditUpdatesSingleSection(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  await buildDraft(flow, "wx-conv-edit");
  const edited = await flow.beforeAgent(req("修改 会议总结=改后的总结正文，两句话。", "wx-conv-edit"));
  assert.ok(edited.handled);
  assert.match(edited.handled ? edited.response.text || "" : "", /1\. 会议总结（200-300 字，结论先行）：改后的总结正文，两句话。/);
  assert.match(edited.handled ? edited.response.text || "" : "", /3\. 会议日期：2026-07-11/);
  await flow.reset("wx-conv-edit");
}

async function testConfirmSubmitsAndReportsWrittenFields(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  await buildDraft(flow, "wx-conv-submit");
  setFollowFixture({ ok: true, project: "p-100", written: ["项目跟进(AI)", "会议纪要(AI)"], detailUrl: "https://applink.feishu.cn/x" });
  const confirmed = await flow.beforeAgent(req("确认提交", "wx-conv-submit"));
  assert.ok(confirmed.handled);
  const text = confirmed.handled ? confirmed.response.text || "" : "";
  assert.match(text, /✅ 已把本次跟进写进「星海科技」/);
  assert.match(text, /项目跟进\(AI\)/);
  delete process.env.WEIXIN_AGENT_TOUZIYUN_FOLLOW_JSON;

  // draft is consumed: a second confirm must not find an active draft
  const again = await flow.beforeAgent(req("确认提交", "wx-conv-submit"));
  assert.equal(again.handled, false, "no active draft after successful submit");
}

async function testSwitchSupersedesOldDraftFailClosed(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  const conversationId = "wx-conv-switch";
  await buildDraft(flow, conversationId);
  setGetFixture({ ok: true, project: "p-200", projectName: "星海智能", meetingMemo: "", followup: "" });

  const stateFile = path.join(tmpHome, "channels", "wechat", "project-followup-text-flow.json");
  const beforeSwitch = JSON.parse(await fs.readFile(stateFile, "utf-8")) as {
    states: Record<string, { followupId?: string }>;
  };
  const oldFollowupId = beforeSwitch.states[conversationId]?.followupId;
  assert.ok(oldFollowupId, "active draft must have a followupId before switch");

  const switched = await flow.beforeAgent(req("切换 A", conversationId));
  assert.ok(switched.handled);
  const switchText = switched.handled ? switched.response.text || "" : "";
  assert.match(switchText, /「星海科技」的跟进草稿已作废/);
  assert.match(switchText, /已锁定投资云项目「星海智能」/);
  const prompt = flow.takePendingModelPrompt(conversationId);
  assert.ok(prompt && prompt.includes("p-200"), "switch reruns stage-2 for the new project");

  // superseded fail-closed across restart: the old draft, if it ever resurfaces via a
  // stale state file, is rejected because its followupId is recorded as consumed.
  const persisted = JSON.parse(await fs.readFile(stateFile, "utf-8")) as {
    states: Record<string, Record<string, unknown>>;
    submissions: Record<string, { status: string }>;
  };
  assert.equal(persisted.submissions[oldFollowupId]?.status, "completed", "old followupId must be recorded as consumed on switch");

  const staleDraft = {
    phase: "draft",
    followupId: oldFollowupId,
    projectId: "p-100",
    projectName: "星海科技",
    alternates: [],
    summaryEntry: { meetingDate: "2026-07-11", summary: "旧草稿" },
    meetingMemoAppend: "",
    historyStatus: "x",
    historyEmpty: true,
    history: { status: "x", historyEmpty: true, meetingMemo: "", followup: "" },
    materialText: "",
    updatedAt: Date.now(),
  };
  persisted.states[conversationId] = staleDraft;
  await fs.writeFile(stateFile, JSON.stringify(persisted));

  const freshFlow = new WechatProjectFollowupFlow();
  setFollowFixture({ ok: true, project: "p-100", written: ["项目跟进(AI)"] });
  const staleConfirm = await freshFlow.beforeAgent(req("确认提交", conversationId));
  assert.ok(staleConfirm.handled);
  assert.match(
    staleConfirm.handled ? staleConfirm.response.text || "" : "",
    /已经提交过（或已作废）/,
    "a superseded draft must never submit",
  );
  delete process.env.WEIXIN_AGENT_TOUZIYUN_FOLLOW_JSON;
  await freshFlow.reset(conversationId);
}

async function testEmptyContentBlocksSubmit(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  const conversationId = "wx-conv-empty";
  await buildDraft(flow, conversationId);
  await flow.beforeAgent(req("修改 会议总结=", conversationId));
  await flow.beforeAgent(req("修改 会议纪要链接=", conversationId));
  const blocked = await flow.beforeAgent(req("确认提交", conversationId));
  assert.ok(blocked.handled);
  assert.match(blocked.handled ? blocked.response.text || "" : "", /没有可写入内容/);
  await flow.reset(conversationId);
}

async function testMaterialFirstThenCommandConsumesInbox(): Promise<void> {
  const { MaterialInbox } = await import("./material-inbox.ts");
  const inbox = new MaterialInbox();
  const conversationId = "wx-conv-inbox";
  inbox.stash({ ...req(MINUTE_LINK, conversationId), deliveryId: "m:bare-1" } as never);

  const flow = new WechatProjectFollowupFlow();
  setSearchFixture({ ok: true, keyword: "星海科技", matches: [{ id: "p-100", name: "星海科技" }], autoPick: "p-100" });
  setGetFixture({ ok: true, project: "p-100", projectName: "星海科技", meetingMemo: "", followup: "" });

  const routed = await flow.beforeAgent(req("/项目跟进 星海科技", conversationId), { materialInbox: inbox });
  assert.ok(routed.handled);
  assert.match(
    routed.handled ? routed.response.text || "" : "",
    /已锁定投资云项目「星海科技」/,
    "stashed bare material must count as this command's material (no re-send ask)",
  );
  // The merge REPORTS what it used; it does not give it up yet. Consuming at
  // merge time meant a failed send threw the material away and the retry
  // carried nothing, so the box is held until delivery is confirmed.
  assert.deepEqual(
    routed.handled ? routed.response.consumedDeliveryIds ?? [] : [],
    ["m:bare-1"],
    "the merge must report the material it consumed so it can be retired on delivery",
  );
  assert.equal(
    inbox.has(conversationId),
    true,
    "material stays held until the reply is confirmed sent",
  );
  inbox.consume(conversationId, ["m:bare-1"]);
  assert.equal(inbox.has(conversationId), false, "confirmed delivery retires it");
  assert.equal(await flow.isAwaitingMaterial(conversationId), false);

  const prompt = flow.takePendingModelPrompt(conversationId);
  assert.ok(prompt, "stage-2 must start directly");
  assert.match(prompt!, /Material Inbox|minutes\/obcn72h4testminute/, "stage-2 material must contain the stashed link");
  await flow.reset(conversationId);
}

async function testNaturalStrongPhraseRoutesWithInboxMaterial(): Promise<void> {
  const { MaterialInbox } = await import("./material-inbox.ts");
  const inbox = new MaterialInbox();
  const conversationId = "wx-conv-nl-route";
  inbox.stash({ ...req(MINUTE_LINK, conversationId), deliveryId: "m:nl-1" } as never);

  const flow = new WechatProjectFollowupFlow();
  setSearchFixture({ ok: true, keyword: "星海科技", matches: [{ id: "p-100", name: "星海科技" }], autoPick: "p-100" });
  setGetFixture({ ok: true, project: "p-100", projectName: "星海科技", meetingMemo: "", followup: "" });
  process.env.WEIXIN_AGENT_FEISHU_TITLE_JSON = JSON.stringify({ obcn72h4testminute: "星海科技项目交流 2026-07-11" });

  const routed = await flow.beforeAgent(req("帮我做项目跟进", conversationId), { materialInbox: inbox });
  assert.ok(routed.handled, "strong NL phrase with inbox material must route into the command flow");
  assert.match(
    routed.handled ? routed.response.text || "" : "",
    /已锁定投资云项目「星海科技」/,
    "NL route + fetched material title must lock the project",
  );
  // Reported now, retired on confirmed delivery — see the command-route test.
  assert.deepEqual(
    routed.handled ? routed.response.consumedDeliveryIds ?? [] : [],
    ["m:nl-1"],
    "the NL route must report the material it consumed",
  );
  assert.equal(inbox.has(conversationId), true, "material stays held until the reply lands");
  inbox.consume(conversationId, ["m:nl-1"]);
  assert.equal(inbox.has(conversationId), false, "confirmed delivery retires it");
  const prompt = flow.takePendingModelPrompt(conversationId);
  assert.ok(prompt && prompt.includes("p-100"));
  delete process.env.WEIXIN_AGENT_FEISHU_TITLE_JSON;
  await flow.reset(conversationId);
}

async function testNaturalAmbiguousAsksExactlyOnce(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  const conversationId = "wx-conv-nl-clarify";
  const ambiguous = `跟进一下这个项目 ${MINUTE_LINK}`;

  const first = await flow.beforeAgent(req(ambiguous, conversationId));
  assert.ok(first.handled, "ambiguous followup wording with material must clarify");
  assert.match(first.handled ? first.response.text || "" : "", /项目跟进/);

  const second = await flow.beforeAgent(req(ambiguous, conversationId));
  assert.equal(second.handled, false, "clarify happens exactly once, then falls through to the model");
  await flow.reset(conversationId);
}

async function testNaturalPhraseWithoutMaterialPassesThrough(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  const routed = await flow.beforeAgent(req("帮我做项目跟进", "wx-conv-nl-none"));
  assert.equal(routed.handled, false, "NL entry is material-bearing only");
}

async function testBareLinkCommandUsesFetchedTitle(): Promise<void> {
  const flow = new WechatProjectFollowupFlow();
  const conversationId = "wx-conv-title";
  setSearchFixture({ ok: true, keyword: "星海科技", matches: [{ id: "p-100", name: "星海科技" }], autoPick: "p-100" });
  setGetFixture({ ok: true, project: "p-100", projectName: "星海科技", meetingMemo: "", followup: "" });
  process.env.WEIXIN_AGENT_FEISHU_TITLE_JSON = JSON.stringify({ obcn72h4testminute: "星海科技项目交流 2026-07-11" });

  const routed = await flow.beforeAgent(req(`/项目跟进 ${MINUTE_LINK}`, conversationId));
  assert.ok(routed.handled);
  assert.match(
    routed.handled ? routed.response.text || "" : "",
    /已锁定投资云项目「星海科技」/,
    "bare-link command must resolve the keyword from the fetched Feishu title",
  );

  // Title unavailable → deterministic unresolved copy, no hang.
  delete process.env.WEIXIN_AGENT_FEISHU_TITLE_JSON;
  process.env.WEIXIN_AGENT_FEISHU_TITLE_JSON = JSON.stringify({});
  const unresolved = await flow.beforeAgent(req(`/项目跟进 ${MINUTE_LINK}`, "wx-conv-title2"));
  assert.ok(unresolved.handled);
  assert.match(unresolved.handled ? unresolved.response.text || "" : "", /没能从这条消息确定要跟进的项目/);
  delete process.env.WEIXIN_AGENT_FEISHU_TITLE_JSON;
  await flow.reset(conversationId);
}

async function testLegacySectionsDraftMigratesOnLoad(): Promise<void> {
  const conversationId = "wx-conv-migrate";
  const stateFile = path.join(tmpHome, "channels", "wechat", "project-followup-text-flow.json");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({
    states: {
      [conversationId]: {
        phase: "draft",
        followupId: "wxf-legacy-1",
        projectId: "p-100",
        projectName: "星海科技",
        alternates: [],
        sections: { meetingDate: "2026-07-10", newFacts: "新增事实", judgmentChanges: "判断上调", nextSteps: "推进合同" },
        meetingMemoAppend: "",
        historyStatus: "x",
        historyEmpty: true,
        history: { status: "x", historyEmpty: true, meetingMemo: "", followup: "" },
        materialText: "",
        updatedAt: Date.now(),
      },
    },
    submissions: {},
  }));

  const flow = new WechatProjectFollowupFlow();
  const routed = await flow.beforeAgent(req("随便说点什么", conversationId));
  assert.ok(routed.handled, "migrated legacy draft must still be an active draft");
  const nudge = routed.handled ? routed.response.text || "" : "";
  assert.match(nudge, /确认提交/, "migrated draft keeps the confirm path");

  const edited = await flow.beforeAgent(req("修改 1=看看迁移后的正文", conversationId));
  assert.ok(edited.handled);
  assert.match(edited.handled ? edited.response.text || "" : "", /1\. 会议总结（200-300 字，结论先行）：看看迁移后的正文/);
  assert.match(edited.handled ? edited.response.text || "" : "", /3\. 会议日期：2026-07-10/);
  await flow.reset(conversationId);
}

async function testMemoEntryFormatMatchesFeishuScript(): Promise<void> {
  const { normalizeMemoEntry } = await import("./touziyun-shared.ts");
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(normalizeMemoEntry(MINUTE_LINK), `${today}：${MINUTE_LINK}`, "bare link gets today prefix");
  assert.equal(
    normalizeMemoEntry(MINUTE_LINK, "2026-07-10"),
    `2026-07-10：${MINUTE_LINK}`,
    "meeting date from material wins over today",
  );
  assert.equal(
    normalizeMemoEntry(`2026-07-09: ${MINUTE_LINK}`),
    `2026-07-09：${MINUTE_LINK}`,
    "half-width colon unifies to full-width",
  );
  assert.equal(
    normalizeMemoEntry(`2026-07-09：${MINUTE_LINK}`, "2026-07-10"),
    `2026-07-09：${MINUTE_LINK}`,
    "existing date is preserved, not overwritten",
  );
  assert.equal(normalizeMemoEntry(""), "", "empty stays empty");
}

async function testKeywordPriorityExplicitBeatsMaterialTitle(): Promise<void> {
  const keyword = __wechatProjectFollowupTest.deriveKeyword({
    text: "/项目跟进 星海科技",
    materialTitle: "2026-07-11 Finn Ding 项目交流",
  });
  assert.equal(keyword, "星海科技", "explicit command name must beat material title");
  const fromTitle = __wechatProjectFollowupTest.deriveKeyword({
    text: "/项目跟进",
    materialTitle: "2026-07-11 会议纪要 Finn Ding",
  });
  assert.equal(fromTitle, "Finn", "material title is the fallback keyword source");
}

async function main(): Promise<void> {
  await testCommandWithoutMaterialAsksForMaterial();
  await testUniqueAutoAdvancesAndRendersSingleDraft();
  await testNoAutoPickShowsCandidatesAndPickEntersStage2();
  await testNoMatchAndErrorAreDeterministicStops();
  await testProjectIdRewriteGetsOneSilentRetryThenFailsClosed();
  await testEditUpdatesSingleSection();
  await testConfirmSubmitsAndReportsWrittenFields();
  await testSwitchSupersedesOldDraftFailClosed();
  await testEmptyContentBlocksSubmit();
  await testMaterialFirstThenCommandConsumesInbox();
  await testNaturalStrongPhraseRoutesWithInboxMaterial();
  await testNaturalAmbiguousAsksExactlyOnce();
  await testNaturalPhraseWithoutMaterialPassesThrough();
  await testBareLinkCommandUsesFetchedTitle();
  await testLegacySectionsDraftMigratesOnLoad();
  await testMemoEntryFormatMatchesFeishuScript();
  await testKeywordPriorityExplicitBeatsMaterialTitle();
  await fs.rm(tmpHome, { recursive: true, force: true });
  console.log("wechat project-followup flow tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
