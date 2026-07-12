"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleOverlayModerationTestCommand,
  parseOverlayModerationTestCommand,
  publishOverlayModerationTestEvent,
} = require("../script/overlayModerationTestCommand");

function fakeDb() {
  const writes = [];
  return {
    writes,
    collection(collectionName) {
      return {
        doc(docId) {
          return {
            async set(data, options) {
              writes.push({ collectionName, docId, data, options });
            },
          };
        },
      };
    },
  };
}

const config = {
  twitch: { channelLogin: "erwayr" },
  overlay: {
    eventsCollection: "overlay_events",
    moderationEventType: "moderation_trash",
    moderationTestCommandEnabled: true,
    moderationTestAllowedLogins: "trusted_mod",
  },
};

test("moderation test commands parse ban and timeout aliases", () => {
  assert.deepEqual(parseOverlayModerationTestCommand("!testban Alice", "mod"), {
    alias: "!testban",
    sanctionType: "ban",
    targetLogin: "alice",
  });
  assert.deepEqual(
    parseOverlayModerationTestCommand("!testtimeout @Bob", "mod"),
    {
      alias: "!testtimeout",
      sanctionType: "timeout",
      targetLogin: "bob",
    },
  );
  assert.equal(parseOverlayModerationTestCommand("hello", "mod"), null);
});

test("test publisher writes minimal permanent and timeout payloads", async () => {
  const db = fakeDb();
  const now = () => 1781510000000;
  await publishOverlayModerationTestEvent({
    db,
    config,
    targetLogin: "alice",
    targetDisplayName: "Alice",
    requestedBy: "erwayr",
    sanctionType: "ban",
    now,
  });
  await publishOverlayModerationTestEvent({
    db,
    config,
    targetLogin: "bob",
    targetDisplayName: "Bob",
    requestedBy: "erwayr",
    sanctionType: "timeout",
    now,
  });

  assert.equal(db.writes.length, 2);
  assert.equal(db.writes[0].data.isPermanent, true);
  assert.equal(db.writes[0].data.endsAt, null);
  assert.equal(db.writes[1].data.isPermanent, false);
  assert.equal(
    db.writes[1].data.endsAt,
    new Date(1781510000000 + 10 * 60_000).toISOString(),
  );
  for (const write of db.writes) {
    assert.equal(Object.hasOwn(write.data, "reason"), false);
    assert.equal(Object.hasOwn(write.data, "moderator"), false);
  }
});

test("moderation test command is restricted and confirms authorized tests", async () => {
  const unauthorized = await handleOverlayModerationTestCommand({
    db: fakeDb(),
    config,
    login: "viewer",
    message: "!testban alice",
    tags: {},
  });
  assert.equal(unauthorized.reason, "unauthorized");

  const db = fakeDb();
  const messages = [];
  const authorized = await handleOverlayModerationTestCommand({
    db,
    config,
    login: "trusted_mod",
    displayName: "Trusted_Mod",
    message: "!testtimeout alice",
    tags: { mod: "1" },
    now: () => 1781510000000,
    sendTwitchChatMessage: async (message) => messages.push(message),
  });
  assert.equal(authorized.handled, true);
  assert.equal(authorized.sanctionType, "timeout");
  assert.equal(db.writes.length, 1);
  assert.match(messages[0], /test overlay timeout envoye pour @alice/i);
});
