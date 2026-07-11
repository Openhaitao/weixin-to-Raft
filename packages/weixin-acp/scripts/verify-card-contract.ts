import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { __wechatProjectCreateTest } from "../src/linearos/project-create-flow.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const linearosRepo = process.env.WEIXIN_AGENT_LINEAROS_REPO || process.env.LOS_REPO_DIR || path.join(os.homedir(), "multi-agent-in-feishu");

const VENDORED_FILES: Array<{ sourceRel: string[]; vendorName: string }> = [
  { sourceRel: ["src", "card", "card-intent-core.ts"], vendorName: "card-intent-core.ts" },
  { sourceRel: ["src", "runtime", "followup-stage1.ts"], vendorName: "followup-stage1.ts" },
  { sourceRel: ["src", "runtime", "followup-history.ts"], vendorName: "followup-history.ts" },
];

function stripVendorBanner(raw: string): string {
  const lines = raw.split("\n");
  let bodyStart = 0;
  while (bodyStart < lines.length && /^\/\//.test(lines[bodyStart])) bodyStart += 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart += 1;
  assert.ok(bodyStart > 0 && bodyStart < lines.length, "vendored file must keep source body after banner");
  return lines.slice(bodyStart).join("\n");
}

async function assertVendorDriftClean(): Promise<void> {
  for (const entry of VENDORED_FILES) {
    const sourcePath = path.join(linearosRepo, ...entry.sourceRel);
    const vendorPath = path.join(packageRoot, "src", "linearos", "vendor", entry.vendorName);
    const [source, vendor] = await Promise.all([
      fs.readFile(sourcePath, "utf-8"),
      fs.readFile(vendorPath, "utf-8"),
    ]);
    assert.equal(stripVendorBanner(vendor), source, `vendored ${entry.vendorName} drifted from LinearOS source`);
  }
}

function installOptionFixture(): void {
  process.env.WEIXIN_AGENT_CARD_CONTRACT = "1";
  process.env.WEIXIN_AGENT_TOUZIYUN_OPTIONS_JSON = JSON.stringify({
    Priority: [
      { label: "P0", value: "1" },
      { label: "P1", value: "2" },
      { label: "P2", value: "3" },
    ],
    项目来源: [
      { label: "行研挖掘", value: "project-source-research" },
      { label: "熟人推荐", value: "project-source-friend" },
    ],
    拟初始融资轮次: [
      { label: "Pre-Seed轮", value: "round-pre-seed" },
      { label: "种子轮", value: "round-seed" },
      { label: "天使轮", value: "round-angel" },
      { label: "A轮", value: "round-a" },
    ],
    地区: [
      { label: "中国", value: "area-cn" },
      { label: "美国", value: "area-us" },
    ],
    来源同事: [
      { label: "方涵", value: "2066000000000000001" },
      { label: "郑灿", value: "2066000000000000002" },
      { label: "胡海涛", value: "1805499449884016640" },
    ],
  });
}

function goldProjectDraftBlock(overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    项目名称: "Agent社区",
    公司创始人: "姜宇宁",
    一句话简介: "面向 AI Agent 开发者的社区和工具平台",
    "Key-Takeaway": "【团队】创始人有社区运营经验\n【项目】正文里出现 ::field:: 不应切断\n【融资】100万美元种子轮",
    Priority: "3",
    拟初始融资轮次: "seed",
    计划融资: "100万美元",
    币种: "美元",
    项目来源: "行研",
    来源同事: "方涵、郑灿",
    ...overrides,
  };
  return [
    "我整理好了。::card:: project_draft",
    "::owner:: Haitao",
    ...Object.entries(fields).flatMap(([name, value]) => [`::field:: ${name} | single`, value]),
    "::end::",
  ].join("\n");
}

async function assertHappyPath(): Promise<void> {
  const block = __wechatProjectCreateTest.parseDraftCardBlock(goldProjectDraftBlock());
  assert.ok(block, "core parser should parse inline project_draft block");
  assert.equal(block.intentType, "project_draft");
  assert.equal(block.fields.length, 20, "core normalization should return the canonical 20 project fields");

  const initial = __wechatProjectCreateTest.normalizeDraftFields(block, "Haitao");
  assert.match(initial["Key-Takeaway"], /正文里出现 ::field:: 不应切断/);

  const normalized = await __wechatProjectCreateTest.normalizeDraftForTouziyun(initial, { userName: "Haitao" });
  assert.deepEqual(normalized.issues, []);
  assert.equal(normalized.fields["币种"], "USD");
  assert.equal(normalized.fields["拟初始融资轮次"], "种子轮");
  assert.equal(normalized.fields["来源同事"], "方涵");
  assert.equal(normalized.fields["项目来源"], "行研挖掘");

  const prepared = await __wechatProjectCreateTest.prepareFieldsForSubmit(normalized.fields, { userName: "Haitao" });
  assert.deepEqual(prepared.issues, []);
  assert.equal(prepared.submitFields["币种"], "USD");
  assert.equal(prepared.submitFields["拟初始融资轮次"], "round-seed");
  assert.equal(prepared.submitFields["来源同事"], "2066000000000000001");
  assert.equal(prepared.submitFields["项目来源"], "project-source-research");
}

async function assertBadValueBlocksBeforeSubmit(): Promise<void> {
  const block = __wechatProjectCreateTest.parseDraftCardBlock(goldProjectDraftBlock({ 拟初始融资轮次: "火星轮" }));
  assert.ok(block);
  const initial = __wechatProjectCreateTest.normalizeDraftFields(block, "Haitao");
  const normalized = await __wechatProjectCreateTest.normalizeDraftForTouziyun(initial, { userName: "Haitao" });
  assert.equal(normalized.fields["拟初始融资轮次"], "");
  assert.equal(normalized.issues.length, 1);
  assert.equal(normalized.issues[0].field, "拟初始融资轮次");
  assert.match(__wechatProjectCreateTest.renderSelectIssuesText(normalized.fields, "wx-test", normalized.issues, "draft"), /未写库|草稿已生成/);

  const persisted = __wechatProjectCreateTest.preserveRejectedSelectValues(initial, normalized);
  assert.equal(persisted["拟初始融资轮次"], "火星轮", "retry state must retain the rejected raw value");
  let retryState = persisted;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retry = await __wechatProjectCreateTest.prepareFieldsForSubmit(retryState, { userName: "Haitao" });
    assert.equal(retry.issues.length, 1, `bare confirm ${attempt} must block the same invalid select again`);
    assert.equal(retry.issues[0].field, "拟初始融资轮次");
    retryState = __wechatProjectCreateTest.preserveRejectedSelectValues(retryState, retry);
  }
}

async function assertExtractionPromptUsesCanonicalFieldLayout(): Promise<void> {
  const prompt = await __wechatProjectCreateTest.buildExtractionPrompt("帮我创建项目", {
    conversationId: "wx-contract-prompt",
    text: "帮我创建项目",
  });
  assert.match(prompt, /每个 `::field:: 字段名` 必须独占一行，字段值从下一行开始/);
  assert.match(prompt, /禁止把值写在 field header 同一行/);
  assert.match(prompt, /::field:: 项目名称\n星海科技\n::field:: 公司创始人\n张三/);
  assert.match(prompt, /不要写 `::field:: 项目名称 = xxx`/);
  assert.match(prompt, /也不要写 `::field:: 项目名称：xxx`/);
}

async function main(): Promise<void> {
  installOptionFixture();
  await assertVendorDriftClean();
  await assertHappyPath();
  await assertBadValueBlocksBeforeSubmit();
  await assertExtractionPromptUsesCanonicalFieldLayout();
  console.log("card contract vendor + WeChat draft normalization verified");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
