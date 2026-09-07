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
    subMessage: "",
  });
  assert.deepEqual(parseOverlaySubCardTestCommand("!testcarteabo @Bob", "erwayr"), {
    alias: "!testcarteabo",
    targetLogin: "bob",
    subMessage: "",
  });
  assert.deepEqual(parseOverlaySubCardTestCommand("!testsub", "Erwayr"), {
    alias: "!testsub",
    targetLogin: "erwayr",
    subMessage: "",
  });
  assert.deepEqual(
    parseOverlaySubCardTestCommand("!testsubcard Alice Merci pour le live !", "erwayr"),
    {
      alias: "!testsubcard",
      targetLogin: "alice",
      subMessage: "Merci pour le live !",
    },
  );
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

test("all aliases accept explicit months with an optional message", () => {
  for (const alias of ["!testsub", "!testsubcard", "!testcarteabo", "!testsubcarte"]) {
    for (const subMonths of [1, 5, 6, 24, 120, 121]) {
      assert.deepEqual(parseOverlaySubCardTestCommand(`${alias} @Erwayr ${subMonths} Merci pour le live !`), {
        alias, targetLogin: "erwayr", subMonths, subMessage: "Merci pour le live !",
      });
    }
  }
  assert.deepEqual(parseOverlaySubCardTestCommand("!TESTSUB erwayr 6"), {
    alias: "!testsub", targetLogin: "erwayr", subMonths: 6, subMessage: "",
  });
  assert.equal(parseOverlaySubCardTestCommand("!testsub erwayr 0").error, "invalid_months");
});

test("the command carries test months through the overlay event without touching profiles", async () => {
  for (const subMonths of [5, 6, 24, 120]) {
    const db = fakeDb();
    const sent = [];
    const result = await handleOverlaySubCardTestCommand({
      db, config: fakeConfig(), login: "erwayr", displayName: "Erwayr",
      message: `!testsub erwayr ${subMonths} Merci !`,
      sendTwitchChatMessage: async message => sent.push(message), now: () => 1781510000000,
    });
    assert.equal(result.subMonths, subMonths);
    assert.equal(result.responded, true);
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0].path, "overlay_events/sub_card_test_erwayr_1781510000000");
    assert.equal(db.writes[0].data.subMonths, subMonths);
    assert.equal(db.writes[0].data.subMessage, "Merci !");
    assert.equal(db.writes[0].data.test, true);
    assert.equal(sent[0], `@Erwayr test overlay sub card envoye pour @erwayr (${subMonths} mois).`);
  }
});

test("invalid numeric month arguments return usage without publishing an alert", async () => {
  for (const months of ["0", "-1", "1.5", "6,5", "1e2", "6mois", "9007199254740992"]) {
    const db = fakeDb();
    const sent = [];
    const result = await handleOverlaySubCardTestCommand({
      db, config: fakeConfig(), login: "erwayr", message: `!testsub erwayr ${months}`,
      sendTwitchChatMessage: async message => sent.push(message),
    });
    assert.equal(result.reason, "invalid_months", months);
    assert.equal(result.responded, true);
    assert.equal(db.writes.length, 0);
    assert.match(sent[0], /!testsub erwayr 6/);
  }
  for (const subMonths of [0, -1, 1.5, NaN, Infinity, "6"]) {
    const db = fakeDb();
    assert.equal((await publishOverlaySubCardTestEvent({ db, targetLogin: "erwayr", subMonths })).reason, "invalid_months");
    assert.equal(db.writes.length, 0);
  }
});

test("explicit months preserve authorization and disabled-command guards", async () => {
  for (const disabled of [false, true]) {
    const db = fakeDb();
    const config = fakeConfig();
    if (disabled) config.overlay.subCardTestCommandEnabled = false;
    const result = await handleOverlaySubCardTestCommand({
      db, config, login: disabled ? "erwayr" : "viewer", message: "!testsub erwayr 6",
      sendTwitchChatMessage: async () => assert.fail("must not reply"),
    });
    assert.equal(result.reason, disabled ? "disabled" : "unauthorized");
    assert.equal(db.writes.length, 0);
  }
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
    subMessage: "",
  });
  assert.deepEqual(db.writes[0].options, { merge: true });
});

test("publishOverlaySubCardTestEvent can include a Twitch message preview", async () => {
  const db = fakeDb();
  const result = await publishOverlaySubCardTestEvent({
    db,
    config: fakeConfig(),
    targetLogin: "Alice",
    requestedBy: "erwayr",
    subMessage: "Merci pour le live !",
    now: () => 1781510000000,
  });

  assert.equal(result.published, true);
  assert.equal(result.subMessage, "Merci pour le live !");
  assert.equal(db.writes[0].data.subMessage, "Merci pour le live !");
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
