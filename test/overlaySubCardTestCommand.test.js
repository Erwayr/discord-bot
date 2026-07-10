"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  canRunOverlaySubCardTestCommand,
  handleOverlaySubCardTestCommand,
  parseOverlaySubCardTestCommand,
  publishOverlaySubCardTestEvent,
} = require("../script/overlaySubCardTestCommand");

function fakeDb() {
  const writes = [];
  return {
    writes,
    collection(name) {
      return {
        doc(id) {
          return {
            async set(data, options) {
              writes.push({
                path: `${name}/${id}`,
                data: JSON.parse(JSON.stringify(data)),
                options: { ...(options || {}) },
              });
            },
          };
        },
      };
    },
  };
}

function fakeConfig() {
  return {
    twitch: { channelLogin: "erwayr" },
    overlay: {
      eventsCollection: "overlay_events",
      subCardEventType: "sub_card",
      subCardTestCommandEnabled: true,
      subCardTestAllowedLogins: "",
    },
  };
}

test("parses overlay sub card test command and target login", () => {
  assert.deepEqual(parseOverlaySubCardTestCommand("!testsubcard Alice", "erwayr"), {
    alias: "!testsubcard",
    targetLogin: "alice",
  });
  assert.deepEqual(parseOverlaySubCardTestCommand("!testcarteabo @Bob", "erwayr"), {
    alias: "!testcarteabo",
    targetLogin: "bob",
  });
  assert.deepEqual(parseOverlaySubCardTestCommand("!testsub", "Erwayr"), {
    alias: "!testsub",
    targetLogin: "erwayr",
  });
  assert.equal(parseOverlaySubCardTestCommand("!lvl", "erwayr"), null);
});

test("overlay sub card test command is restricted to broadcaster mods or allowlist", () => {
  assert.equal(
    canRunOverlaySubCardTestCommand({
      login: "erwayr",
      channelLogin: "erwayr",
    }),
    true,
  );
  assert.equal(
    canRunOverlaySubCardTestCommand({
      login: "moduser",
      tags: { badges: { moderator: "1" } },
      channelLogin: "erwayr",
    }),
    true,
  );
  assert.equal(
    canRunOverlaySubCardTestCommand({
      login: "alice",
      channelLogin: "erwayr",
      allowedLogins: "alice",
    }),
    true,
  );
  assert.equal(
    canRunOverlaySubCardTestCommand({
      login: "viewer",
      channelLogin: "erwayr",
    }),
    false,
  );
});

test("publishOverlaySubCardTestEvent writes a sub_card overlay event", async () => {
  const db = fakeDb();
  const result = await publishOverlaySubCardTestEvent({
    db,
    config: fakeConfig(),
    targetLogin: "Alice",
    requestedBy: "erwayr",
    now: () => 1781510000000,
  });

  assert.equal(result.published, true);
  assert.equal(result.docId, "sub_card_test_alice_1781510000000");
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].path, "overlay_events/sub_card_test_alice_1781510000000");
  assert.deepEqual(db.writes[0].data, {
    type: "sub_card",
    eventMs: 1781510000000,
    createdAtMs: 1781510000000,
    source: "twitch_chat_test",
    twitchEventType: "manual_test",
    login: "alice",
    displayName: "alice",
    test: true,
    requestedBy: "erwayr",
  });
  assert.deepEqual(db.writes[0].options, { merge: true });
});

test("handleOverlaySubCardTestCommand writes and replies for authorized user", async () => {
  const db = fakeDb();
  const sent = [];
  const result = await handleOverlaySubCardTestCommand({
    db,
    config: fakeConfig(),
    login: "erwayr",
    displayName: "Erwayr",
    message: "!testsubcard bob",
    tags: { badges: { broadcaster: "1" } },
    sendTwitchChatMessage: async (message) => sent.push(message),
    now: () => 1781510000000,
  });

  assert.equal(result.handled, true);
  assert.equal(result.responded, true);
  assert.equal(result.targetLogin, "bob");
  assert.equal(db.writes.length, 1);
  assert.equal(sent[0], "@Erwayr test overlay sub card envoye pour @bob.");
});

test("handleOverlaySubCardTestCommand refuses unauthorized users without writing", async () => {
  const db = fakeDb();
  const sent = [];
  const result = await handleOverlaySubCardTestCommand({
    db,
    config: fakeConfig(),
    login: "viewer",
    displayName: "Viewer",
    message: "!testsubcard bob",
    tags: {},
    sendTwitchChatMessage: async (message) => sent.push(message),
    now: () => 1781510000000,
  });

  assert.equal(result.handled, true);
  assert.equal(result.responded, false);
  assert.equal(result.reason, "unauthorized");
  assert.equal(db.writes.length, 0);
  assert.equal(sent.length, 0);
});
