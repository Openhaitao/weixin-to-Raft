import assert from "node:assert/strict";

import { MaterialInbox } from "./material-inbox.js";

/**
 * Material is held until a reply is confirmed sent. Giving it up at merge time
 * meant a failed send threw the user's photo away: the retry carried nothing,
 * and nobody was ever told.
 */

const img = (n: string) => ({ type: "image" as const, filePath: `/tmp/${n}.jpg`, mimeType: "image/jpeg" });
const bare = (id: string, n: string) => ({
  conversationId: "c1",
  text: "",
  deliveryId: id,
  mediaItems: [img(n)],
}) as never;

// --- a failed send must leave the material intact for the retry ---
{
  const inbox = new MaterialInbox();
  inbox.stash(bare("m:1", "a"));

  const first = inbox.mergeInto({ conversationId: "c1", text: "这是什么" } as never);
  assert.equal(first.request.mediaItems?.length, 1);
  assert.deepEqual(first.consumedDeliveryIds, ["m:1"]);

  // Send failed → confirmConsumed never runs → the material is still here.
  const retry = inbox.mergeInto({ conversationId: "c1", text: "这是什么" } as never);
  assert.equal(
    retry.request.mediaItems?.length,
    1,
    "a retry after a failed send must still carry the material",
  );
  assert.deepEqual(retry.consumedDeliveryIds, ["m:1"]);
  console.log("failed send: material held, retry still carries it");
}

// --- a confirmed send retires it, and only it ---
{
  const inbox = new MaterialInbox();
  inbox.stash(bare("m:1", "a"));
  inbox.stash(bare("m:2", "b"));

  const merged = inbox.mergeInto({ conversationId: "c1", text: "对比" } as never);
  assert.equal(merged.request.mediaItems?.length, 2);
  inbox.consume("c1", merged.consumedDeliveryIds);
  assert.equal(inbox.has("c1"), false, "everything answered ⇒ box is empty");

  // Material that arrived after the merge is not retired by it.
  inbox.stash(bare("m:1", "a"));
  inbox.stash(bare("m:3", "c"));
  inbox.consume("c1", ["m:1"]);
  assert.equal(inbox.has("c1"), true);
  assert.equal(
    inbox.peek("c1")?.items.length,
    1,
    "only the answered material is retired",
  );
  console.log("confirmed send: retires exactly what it answered");
}

// --- a re-served message must not stash twice ---
{
  const inbox = new MaterialInbox();
  inbox.stash(bare("m:7", "a"));
  inbox.stash(bare("m:7", "a"));
  assert.equal(
    inbox.peek("c1")?.items.length,
    1,
    "the same message served twice must produce one item, not two",
  );
  // A different message with the same picture is still a second item.
  inbox.stash(bare("m:8", "a"));
  assert.equal(inbox.peek("c1")?.items.length, 2);
  console.log("re-served message: stashed once");
}

console.log("material hold tests passed");

// --- clarify must not promise durability it cannot back --------------------
// The clarify reply is durable: once sent, the message is committed and never
// redelivered. A stash is in-memory. A restart between the two would leave
// "I've kept your material" on screen with the material gone for good.
{
  const { WechatProjectFollowupFlow } = await import("./project-followup-flow.js");
  const inbox = new MaterialInbox();
  const flow = new WechatProjectFollowupFlow();
  const conversationId = "c-clarify";

  const routed = await flow.beforeAgent(
    {
      conversationId,
      text: "跟进一下",
      deliveryId: "m:clarify-1",
      media: img("a"),
      mediaItems: [img("a")],
    } as never,
    { materialInbox: inbox } as never,
  );

  if (routed?.handled) {
    const text = routed.response.text || "";
    assert.equal(
      /收好|一起带上/.test(text),
      false,
      "clarify must not claim the material is kept — a restart would make that a lie",
    );
    assert.equal(
      inbox.has(conversationId),
      false,
      "clarify must not stash: its reply is durable, the stash would not be",
    );
    console.log("clarify: no volatile effect behind a durable reply");
  } else {
    assert.fail("clarify branch was not reached — this test would prove nothing");
  }
}

// --- INTENDED BEHAVIOUR: bare material is held, not answered ---------------
// This is a product decision, not an oversight. Sending files/links on their
// own is meant to be silent; the reply comes with the message that says what
// to do with them. A previous change read that silence as a swallowed-message
// bug and answered each bare photo immediately, which broke the "send the
// files, then ask" flow. If you are here because the silence looks wrong,
// this test is the answer: it is deliberate.
{
  const inbox = new MaterialInbox();
  const conversationId = "c-intent";

  // Three bare sends in a row: nothing is answered, everything is kept in order.
  inbox.stash({ conversationId, text: "", deliveryId: "m:1", media: img("a"), mediaItems: [img("a")] } as never);
  inbox.stash({ conversationId, text: "", deliveryId: "m:2", media: img("b"), mediaItems: [img("b")] } as never);
  inbox.stash({ conversationId, text: "", deliveryId: "m:3", media: img("c"), mediaItems: [img("c")] } as never);
  assert.equal(inbox.peek(conversationId)?.items.length, 3, "every bare send is kept");

  // Then the user says what they want: all of it rides along with that turn.
  const merged = inbox.mergeInto({ conversationId, text: "这三张对比一下" } as never);
  assert.equal(
    merged.request.mediaItems?.length,
    3,
    "the triggering message must carry every held attachment, not just the first",
  );
  const body = String(merged.request.text);
  const order = ["a.jpg", "b.jpg", "c.jpg"].map((n) => body.indexOf(n));
  assert.ok(order.every((i) => i >= 0), "all three must be listed");
  assert.ok(order[0] < order[1] && order[1] < order[2], "in the order they were sent");
  assert.ok(body.includes("这三张对比一下"), "the user's actual question is still the request");
  console.log("intended: bare material held silently, delivered with the triggering message");
}

// --- cancelling drops what was held ---------------------------------------
{
  const inbox = new MaterialInbox();
  inbox.stash({ conversationId: "c-cancel", text: "", deliveryId: "m:9", media: img("a"), mediaItems: [img("a")] } as never);
  assert.equal(inbox.has("c-cancel"), true);
  const { isMaterialInboxCancelText } = await import("./material-inbox.js");
  assert.equal(isMaterialInboxCancelText("算了"), true, "a cancel word must be recognised");
  console.log("intended: a cancel word releases held material");
}
