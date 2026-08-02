import assert from "node:assert/strict";

import { processOneMessage, EMPTY_RESPONSE_NOTICE } from "./process-message.js";

/**
 * An agent turn that produces neither text nor media used to report
 * delivered=true while sending nothing at all. Combined with the de-dup
 * ledger that is a permanent swallow: the message is marked answered and the
 * server never redelivers it, so the user is left waiting forever.
 */

const sent: string[] = [];
let failSends = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? init.body : "";
  if (String(url).includes("sendmessage")) {
    if (failSends) throw new Error("network down");
    sent.push(body);
  }
  return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const deps = (chat: () => Promise<unknown>) => ({
  accountId: "acct-empty",
  agent: { chat } as never,
  baseUrl: "https://api",
  cdnBaseUrl: "https://cdn",
  token: "t",
  log: () => {},
  errLog: () => {},
});

const message = {
  message_id: 1,
  from_user_id: "u1",
  context_token: "ctx",
  item_list: [{ type: 1, text_item: { text: "在吗" } }],
} as never;

try {
  // --- empty agent response: say so, and count that notice as the delivery ---
  {
    sent.length = 0;
    const out = await processOneMessage(message, deps(async () => ({})) as never);
    assert.equal(sent.length, 1, "an empty response must still produce exactly one send");
    assert.ok(
      sent[0].includes(EMPTY_RESPONSE_NOTICE.slice(0, 8)),
      "the user must be told the turn produced nothing",
    );
    assert.equal(
      out.delivered,
      true,
      "the notice WAS delivered; redelivering would just produce another empty turn",
    );
    console.log("empty response: user is told, and the turn is committed");
  }

  // --- ordinary reply still delivers ---
  {
    sent.length = 0;
    const out = await processOneMessage(
      message,
      deps(async () => ({ text: "好的" })) as never,
    );
    assert.equal(out.delivered, true);
    assert.equal(sent.length, 1);
    console.log("normal reply: delivered");
  }

  // --- send failure must stay redeliverable ---
  {
    sent.length = 0;
    const out = await processOneMessage(
      message,
      deps(async () => { throw new Error("agent exploded"); }) as never,
    );
    assert.equal(
      out.delivered,
      false,
      "a failed turn must stay eligible for the server's redelivery",
    );
    console.log("failed turn: NOT committed");
  }

  // --- deliberate silence must NOT be turned into an apology ---
  {
    sent.length = 0;
    const out = await processOneMessage(
      message,
      deps(async () => ({ silent: true })) as never,
    );
    assert.equal(sent.length, 0, "a deliberately silent turn must send nothing at all");
    assert.equal(out.delivered, true, "it was handled, so it must not be redelivered");
    console.log("deliberate silence: nothing sent, nothing redelivered");
  }

  // --- material is released ONLY after the reply is confirmed sent ---
  // Asserting MaterialInbox alone would stay green if process-message stopped
  // calling it, which is how the release could silently never happen.
  {
    sent.length = 0;
    const released: Array<[string, string[]]> = [];
    const agentDeps = {
      ...deps(async () => ({ text: "好的", consumedDeliveryIds: ["m:41"] })),
      agent: {
        chat: async () => ({ text: "好的", consumedDeliveryIds: ["m:41"] }),
        confirmConsumed: async (cid: string, ids: string[]) => { released.push([cid, ids]); },
      } as never,
    };
    const out = await processOneMessage(message, agentDeps as never);
    assert.equal(out.delivered, true);
    assert.deepEqual(out.commitIds, ["m:41"]);
    assert.deepEqual(released, [["u1", ["m:41"]]], "a delivered reply must release its material");
    console.log("consumed material: released after a confirmed send");
  }

  // --- a failed send must NOT release it ---
  {
    sent.length = 0;
    const released: string[][] = [];
    const agentDeps = {
      ...deps(async () => ({})),
      agent: {
        // The agent SUCCEEDS and produces material-consuming output; it is the
        // send that fails. That is the case that matters: the material was
        // already merged into a request, and losing it here means the user's
        // photo is gone with nothing said.
        chat: async () => ({ text: "好的", consumedDeliveryIds: ["m:41"] }),
        confirmConsumed: async (_c: string, ids: string[]) => { released.push(ids); },
      } as never,
    };
    failSends = true;
    const out = await processOneMessage(message, agentDeps as never);
    failSends = false;
    assert.equal(out.delivered, false);
    assert.deepEqual(
      released,
      [],
      "a failed turn must keep the material so the retry can carry it",
    );
    console.log("failed send: material NOT released");
  }

  console.log("empty response handling tests passed");
} finally {
  globalThis.fetch = realFetch;
}
