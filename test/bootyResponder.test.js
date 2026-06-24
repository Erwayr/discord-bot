"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  BOOTY_RESPONSES,
  containsBooty,
  maybeReplyToBooty,
  pickBootyResponse,
  shouldReplyToBooty,
} = require("../script/bootyResponder");

test("detects booty in any casing and inside words", () => {
  assert.equal(containsBooty("booty"), true);
  assert.equal(containsBooty("BOOTY"), true);
  assert.equal(containsBooty("xxbootyxx"), true);
});

test("ignores messages without booty", () => {
  assert.equal(containsBooty("nothing to see here"), false);
  assert.equal(containsBooty(""), false);
  assert.equal(containsBooty(null), false);
});

test("uses a 50 percent reply chance", () => {
  assert.equal(shouldReplyToBooty({ rng: () => 0.49 }), true);
  assert.equal(shouldReplyToBooty({ rng: () => 0.5 }), false);
  assert.equal(shouldReplyToBooty({ rng: () => 0.99 }), false);
});

test("picks a deterministic response with injected rng", () => {
  assert.equal(pickBootyResponse({ rng: () => 0 }), BOOTY_RESPONSES[0]);
  assert.equal(
    pickBootyResponse({ rng: () => 0.999 }),
    BOOTY_RESPONSES[BOOTY_RESPONSES.length - 1],
  );
});

test("maybeReplyToBooty replies only when detection and chance pass", async () => {
  const replies = [];
  const message = {
    content: "hello booty",
    reply: async (payload) => {
      replies.push(payload);
    },
  };

  assert.equal(await maybeReplyToBooty(message, { rng: () => 0 }), true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].content, BOOTY_RESPONSES[0]);
  assert.deepEqual(replies[0].allowedMentions, { repliedUser: false });

  assert.equal(await maybeReplyToBooty(message, { rng: () => 0.5 }), false);
  assert.equal(replies.length, 1);

  assert.equal(
    await maybeReplyToBooty({ ...message, content: "hello" }, { rng: () => 0 }),
    false,
  );
  assert.equal(replies.length, 1);
});
