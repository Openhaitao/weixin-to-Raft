import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WechatProjectCreateFlow } from "./project-create-flow.js";

const PROTOCOL_RE = /::(?:card|field|owner|end)::|\[\[[A-Z0-9_:-]+\]\]/;

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-project-flow-test-"));
  const prevHome = process.env.WEIXIN_AGENT_HOME;
  process.env.WEIXIN_AGENT_HOME = dir;
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) {
      delete process.env.WEIXIN_AGENT_HOME;
    } else {
      process.env.WEIXIN_AGENT_HOME = prevHome;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testProjectDraftConvertsOutsideAwaitingMaterial(): Promise<void> {
  await withTempHome(async () => {
    const flow = new WechatProjectCreateFlow();
    const response = await flow.afterAgent(
      { conversationId: "c1", text: "用户直接发 BP" },
      {
        text: [
          "::card:: project_draft",
          "::field:: 项目名称",
          "LeakSafe",
          "::field:: 公司创始人",
          "Alice",
          "::field:: 一句话简介",
          "微信侧协议兜底测试",
          "::field:: 计划融资",
          "100万 USD",
          "::end::",
        ].join("\n"),
      },
    );

    assert.match(response.text || "", /已生成项目草稿/);
    assert.match(response.text || "", /LeakSafe/);
    assert.doesNotMatch(response.text || "", PROTOCOL_RE);
  });
}

async function testOtherCardProtocolsAreStripped(): Promise<void> {
  await withTempHome(async () => {
    const flow = new WechatProjectCreateFlow();
    const response = await flow.afterAgent(
      { conversationId: "c2", text: "hello" },
      {
        text: [
          "前置文字",
          "[[CREATE_PROJECT_ASK]]",
          "::field:: 项目名称",
          "后置文字",
          "[[MINUTES_AUTH_NEEDED]]",
        ].join("\n"),
      },
    );

    assert.match(response.text || "", /前置文字/);
    assert.match(response.text || "", /后置文字/);
    assert.doesNotMatch(response.text || "", PROTOCOL_RE);
  });
}

async function testAwaitingMaterialBadDraftGetsFallbackDraft(): Promise<void> {
  await withTempHome(async () => {
    const flow = new WechatProjectCreateFlow();
    const routed = await flow.beforeAgent({ conversationId: "c3", text: "/项目创建" });
    assert.equal(routed.handled, true);

    const response = await flow.afterAgent(
      { conversationId: "c3", text: "材料" },
      { text: "::card:: something_else\n::end::" },
    );

    assert.match(response.text || "", /已生成项目草稿/);
    assert.match(response.text || "", /项目名称/);
    assert.doesNotMatch(response.text || "", PROTOCOL_RE);
  });
}

async function testInlineMaterialStartsExtractionInsteadOfAskingAgain(): Promise<void> {
  await withTempHome(async () => {
    const flow = new WechatProjectCreateFlow();
    const routed = await flow.beforeAgent({
      conversationId: "c4",
      text: "/项目创建 星海科技，创始人张三，计划融资 100 万美元",
    });
    assert.equal(routed.handled, false);
    assert.match(routed.request.text, /星海科技/);
    assert.match(routed.request.text, /请输出一个 project_draft block/);
  });
}

await testProjectDraftConvertsOutsideAwaitingMaterial();
await testOtherCardProtocolsAreStripped();
await testAwaitingMaterialBadDraftGetsFallbackDraft();
await testInlineMaterialStartsExtractionInsteadOfAskingAgain();

console.log("wechat project-create flow guard tests passed");
