import assert from "node:assert/strict";

import type { AgentModelMenu } from "../agent/interface.js";
import {
  handleSlashCommand,
  ModelSelectionRegistry,
  type SlashCommandContext,
} from "./slash-commands.js";

const menu: AgentModelMenu = {
  currentModelId: "gpt-5.6-sol",
  options: [
    { id: "gpt-5.6-sol", name: "Sol" },
    {
      id: "gpt-5.6-terra",
      name: "Terra",
      description: "Terra 5.6 · Best for version-sensitive work",
    },
    { id: "gpt-5.6-luna", name: "Luna" },
  ],
};

function createContext(
  accountId: string,
  conversationId: string,
  replies: string[],
  selected: string[],
): SlashCommandContext {
  return {
    accountId,
    to: conversationId,
    baseUrl: "https://example.invalid",
    log: () => {},
    errLog: () => {},
    getModelMenu: async () => menu,
    selectModel: async (modelId) => {
      selected.push(modelId);
      const option = menu.options.find((candidate) => candidate.id === modelId);
      assert.ok(option);
      return { modelId, name: option.name };
    },
    reply: async (text) => {
      replies.push(text);
    },
  };
}

async function testMenuAndNumericFollowup(): Promise<void> {
  const replies: string[] = [];
  const selected: string[] = [];
  const registry = new ModelSelectionRegistry();
  const ctx = createContext("bot-a", "user-a", replies, selected);

  assert.deepEqual(
    await handleSlashCommand("/model", ctx, Date.now(), undefined, registry),
    { handled: true },
  );
  assert.match(replies[0] ?? "", /1\. Sol（当前）/);
  assert.match(replies[0] ?? "", /2\. Terra/);
  assert.match(replies[0] ?? "", /Terra 5\.6 · Best for version-sensitive work/);

  assert.deepEqual(
    await handleSlashCommand("先问个别的问题", ctx, Date.now(), undefined, registry),
    { handled: false },
  );
  assert.deepEqual(
    await handleSlashCommand("2", ctx, Date.now(), undefined, registry),
    { handled: true },
  );
  assert.deepEqual(selected, ["gpt-5.6-terra"]);
}

async function testAccountAndConversationIsolation(): Promise<void> {
  const replies: string[] = [];
  const selectedA: string[] = [];
  const selectedB: string[] = [];
  const registry = new ModelSelectionRegistry();
  const botA = createContext("bot-a", "same-user", replies, selectedA);
  const botB = createContext("bot-b", "same-user", replies, selectedB);

  await handleSlashCommand("/model", botA, Date.now(), undefined, registry);
  assert.deepEqual(
    await handleSlashCommand("3", botB, Date.now(), undefined, registry),
    { handled: false },
  );
  await handleSlashCommand("3", botA, Date.now(), undefined, registry);
  assert.deepEqual(selectedA, ["gpt-5.6-luna"]);
  assert.deepEqual(selectedB, []);
}

async function testTtlAndClearCompatibility(): Promise<void> {
  let now = 1_000;
  const replies: string[] = [];
  const selected: string[] = [];
  const registry = new ModelSelectionRegistry(100, () => now);
  const ctx = createContext("bot-a", "user-a", replies, selected);

  await handleSlashCommand("/model", ctx, now, undefined, registry);
  now += 101;
  assert.deepEqual(
    await handleSlashCommand("1", ctx, now, undefined, registry),
    { handled: false },
  );

  await handleSlashCommand("/model", ctx, now, undefined, registry);
  await handleSlashCommand("/new", ctx, now, undefined, registry);
  assert.deepEqual(
    await handleSlashCommand("1", ctx, now, undefined, registry),
    { handled: false },
  );
  assert.deepEqual(selected, []);
}

async function testDirectAndInvalidSelection(): Promise<void> {
  const replies: string[] = [];
  const selected: string[] = [];
  const registry = new ModelSelectionRegistry();
  const ctx = createContext("bot-a", "user-a", replies, selected);

  await handleSlashCommand("/model 2", ctx, Date.now(), undefined, registry);
  assert.deepEqual(selected, ["gpt-5.6-terra"]);

  await handleSlashCommand("/model", ctx, Date.now(), undefined, registry);
  await handleSlashCommand("9", ctx, Date.now(), undefined, registry);
  assert.match(replies.at(-1) ?? "", /不在当前模型列表/);
  assert.deepEqual(selected, ["gpt-5.6-terra"]);
}

await testMenuAndNumericFollowup();
await testAccountAndConversationIsolation();
await testTtlAndClearCompatibility();
await testDirectAndInvalidSelection();

console.log("wechat model command tests passed");
