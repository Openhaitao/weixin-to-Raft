import assert from "node:assert/strict";

import { handleSlashCommand } from "./slash-commands.js";

/**
 * `handled` answers "did this take the command branch". Only `replied` answers
 * "did the user hear anything". The de-dup ledger commits on the second, so a
 * command whose reply AND whose error reply both failed must stay
 * redeliverable — otherwise the message is silently swallowed forever.
 */

const base = {
  to: "u1",
  baseUrl: "https://api",
  token: "t",
  accountId: "acct-slash",
  contextToken: "ctx",
  log: () => {},
  errLog: () => {},
};

// --- every send fails: handled, but nothing was delivered ---
{
  const res = await handleSlashCommand(
    "/clear",
    { ...base, reply: async () => { throw new Error("network down"); } },
    Date.now(),
  );
  assert.equal(res.handled, true);
  assert.equal(
    res.replied,
    false,
    "both the reply and the error reply failed — the user got nothing, so this must not be committed",
  );
  console.log("slash: total send failure is handled but NOT delivered");
}

// --- the error reply gets through: that counts as delivered ---
{
  const seen: string[] = [];
  let first = true;
  const res = await handleSlashCommand(
    "/clear",
    {
      ...base,
      // The success reply fails, which throws into the outer catch; the error
      // notice it sends instead does get through.
      reply: async (text: string) => {
        if (first) { first = false; throw new Error("first send failed"); }
        seen.push(text);
      },
    },
    Date.now(),
  );
  assert.equal(res.handled, true);
  assert.equal(res.replied, true, "the error notice reached the user, so redelivery would duplicate it");
  assert.equal(seen.length, 1);
  console.log("slash: a delivered error notice counts as delivered");
}

// --- the ordinary success path still reports delivered ---
{
  const seen: string[] = [];
  const res = await handleSlashCommand(
    "/clear",
    { ...base, reply: async (t: string) => { seen.push(t); } },
    Date.now(),
  );
  assert.equal(res.handled, true);
  assert.equal(res.replied, true);
  assert.equal(seen.length, 1);
  console.log("slash: success path delivered");
}

// --- a non-command reports neither handled nor delivered ---
{
  const res = await handleSlashCommand("你好", { ...base, reply: async () => {} }, Date.now());
  assert.equal(res.handled, false);
  assert.equal(res.replied, false);
  console.log("slash: plain text falls through to the AI pipeline");
}

console.log("slash command delivery authority tests passed");
