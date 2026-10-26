"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");
const { DEFAULT_CHARACTER } = require("../script/guardian-character.shared.cjs");
const { freshState } = require("../script/guardian-live.shared.cjs");
const { pollGuardianLive } = require("../script/guardian-live.store.cjs");

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
    twitch: { channelId: "123", channelLogin: "erwayr" },
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

test("the command routes explicit months and message to the Guardian without writing an independent card", async () => {
  for (const subMonths of [5, 6, 24, 120]) {
    const db = fakeDb();
    const sent = [];
    const calls = [];
    const result = await handleOverlaySubCardTestCommand({
      db, config: fakeConfig(), login: "erwayr", displayName: "Erwayr",
      message: `!testsub erwayr ${subMonths} Merci !`,
      tags: { id: "twitch-message-1" },
      publishGuardianTest: async (input) => { calls.push(input); return { status: "accepted", login: input.login, subMonths: input.subMonths }; },
      sendTwitchChatMessage: async message => sent.push(message), now: () => 1781510000000,
    });
    assert.equal(result.subMonths, subMonths);
    assert.equal(result.responded, true);
    assert.equal(result.presentation, "guardian");
    assert.deepEqual(db.writes, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { db, channelId: "123", login: "erwayr", displayName: "Erwayr", subMonths,
      subMessage: "Merci !", requestId: "test_twitch-message-1", nowMs: 1781510000000 });
    assert.equal(sent[0], `@Erwayr test Gardien + carte d'abonnement envoyé pour @erwayr (${subMonths} mois).`);
  }
});

test("invalid numeric month arguments return usage without publishing an alert", async () => {
  for (const months of ["0", "-1", "1.5", "6,5", "1e2", "6mois", "9007199254740992"]) {
    const db = fakeDb();
    const sent = [];
    const result = await handleOverlaySubCardTestCommand({
      db, config: fakeConfig(), login: "erwayr", message: `!testsub erwayr ${months}`,
      publishGuardianTest: async () => assert.fail("invalid months must not reach Guardian"),
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
      publishGuardianTest: async () => assert.fail("authorization must precede Guardian publication"),
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

test("an authorized command without months uses the target's saved tenure and works without a live gate", async () => {
  const db = fakeDb();
  const sent = [];
  const calls = [];
  const result = await handleOverlaySubCardTestCommand({
    db,
    config: fakeConfig(),
    login: "erwayr",
    displayName: "Erwayr",
    message: "!testsubcard bob",
    tags: { badges: { broadcaster: "1" } },
    publishGuardianTest: async (input) => { calls.push(input); return { status: "accepted", login: input.login, subMonths: 14 }; },
    sendTwitchChatMessage: async (message) => sent.push(message),
    now: () => 1781510000000,
  });

  assert.equal(result.handled, true);
  assert.equal(result.responded, true);
  assert.equal(result.targetLogin, "bob");
  assert.deepEqual(db.writes, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subMonths, undefined);
  assert.equal(calls[0].channelId, "123");
  assert.equal(calls[0].login, "bob");
  assert.equal(calls[0].displayName, "bob");
  assert.equal(result.subMonths, 14);
  assert.equal(sent[0], "@Erwayr test Gardien + carte d'abonnement envoyé pour @bob (14 mois).");
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

test("Twitch delivery identity dedupes command retries without replay or duplicate feedback", async () => {
  const db = fakeDb();
  const calls = [], sent = [], seen = new Set();
  const input = { db, config: fakeConfig(), login: "erwayr", message: "!testsub erwayr 6",
    tags: { id: "delivery-unique" }, now: () => 1781510000000,
    publishGuardianTest: async (value) => {
      calls.push(value);
      const deduped = seen.has(value.requestId);
      seen.add(value.requestId);
      return { status: "accepted", accepted: true, deduped, requestId: value.requestId, login: value.login };
    },
    sendTwitchChatMessage: async (message) => sent.push(message) };
  assert.equal((await handleOverlaySubCardTestCommand(input)).reason, null);
  const duplicate = await handleOverlaySubCardTestCommand(input);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(duplicate.responded, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(seen.size, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(db.writes, []);
});

test("commands without Twitch message IDs get distinct safe identities even within the same millisecond", async () => {
  const ids = [];
  const input = { db: fakeDb(), config: fakeConfig(), login: "erwayr", message: "!testsub erwayr", now: () => 1781510000000,
    publishGuardianTest: async (value) => { ids.push(value.requestId); return { status: "accepted", login: value.login }; } };
  for (let i = 0; i < 2; i++) assert.equal((await handleOverlaySubCardTestCommand(input)).responded, false);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)));
});

test("busy Guardian tests give useful feedback and never fall back to an independent card", async () => {
  for (const reason of ["real_appearance_active", "test_active"]) {
    const db = fakeDb(), sent = [];
    const result = await handleOverlaySubCardTestCommand({
      db, config: fakeConfig(), login: "erwayr", message: "!testsub erwayr 6",
      publishGuardianTest: async () => ({ status: "busy", accepted: false, reason }),
      sendTwitchChatMessage: async (message) => sent.push(message),
    });
    assert.equal(result.reason, reason);
    assert.equal(result.responded, true);
    assert.match(sent[0], /Attends la fin de la carte/);
    assert.deepEqual(db.writes, []);
  }
});

test("missing profiles, identity conflicts and publisher failures remain visible without legacy publication", async () => {
  for (const reason of ["profile_not_found", "identity_conflict", "unavailable"]) {
    const db = fakeDb(), sent = [];
    const result = await handleOverlaySubCardTestCommand({
      db, config: fakeConfig(), login: "erwayr", message: "!testsub erwayr 6",
      publishGuardianTest: async () => {
        if (reason === "unavailable") throw new Error("publication failed");
        return { status: "error", accepted: false, reason };
      },
      sendTwitchChatMessage: async (message) => sent.push(message),
    });
    assert.equal(result.reason, reason);
    assert.equal(result.responded, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], reason === "profile_not_found" ? /aucun profil/ : reason === "identity_conflict" ? /identité/ : /indisponible/);
    assert.deepEqual(db.writes, []);
  }
});

test("invalid target logins do not reach the Guardian publisher", async () => {
  const sent = [];
  const result = await handleOverlaySubCardTestCommand({
    db: fakeDb(), config: fakeConfig(), login: "erwayr", message: "!testsub bad/login 6",
    publishGuardianTest: async () => assert.fail("invalid target must not publish"),
    sendTwitchChatMessage: async (message) => sent.push(message),
  });
  assert.equal(result.reason, "invalid_target");
  assert.equal(sent.length, 1);
});

test("the production command's default publisher creates only an offline Guardian test and preserves real subscription state", async () => {
  const nowMs = 1_000_000;
  const profile = { pseudo: "erwayr", twitch_id: "42", subMonths: 25,
    currentGuardian: { character: { ...DEFAULT_CHARACTER, weapon: "staff", body: "feminine" } } };
  const participant = { pseudo: "erwayr", isSub: true };
  const live = { ...freshState("", nowMs), initialized: true };
  const viewerState = { lastAcceptedAtMs: nowMs - 1000, lastSubscriptionAtMs: nowMs - 500,
    recentSubscriptionEvents: [{ id: "real-subscription-event", receivedAtMs: nowMs - 500 }] };
  const initial = {
    "followers_all_time/erwayr": profile,
    "participants/erwayr": participant,
    "twitch_identities/42": { currentLogin: "erwayr", status: "active" },
    "guardian_live_channels/123": live,
    "guardian_live_channels/123/viewers/42": viewerState,
  };
  const db = createMemoryFirestore(initial), sent = [];
  const command = { db, config: fakeConfig(), login: "erwayr", displayName: "Erwayr",
    message: "!testsub erwayr 6 Merci !", tags: { id: "offline-test-command" }, now: () => nowMs,
    sendTwitchChatMessage: async (message) => sent.push(message) };
  const accepted = await handleOverlaySubCardTestCommand(command);
  assert.equal(accepted.reason, null);
  assert.equal(accepted.presentation, "guardian");
  const test = db.documents.get("guardian_live_channels/123/tests/subscription");
  assert.equal(test.requestId, "test_offline-test-command");
  assert.equal(test.viewer.login, "erwayr");
  assert.equal(test.viewer.character.weapon, "staff");
  assert.equal(test.viewer.character.body, "feminine");
  assert.equal(test.schemaVersion, 2);
  assert.equal(test.startsAtMs, 0);
  assert.equal(test.endsAtMs, 0);
  assert.equal(test.subscriptionTest.subMonths, 6);
  assert.equal(test.subscriptionTest.subMessage, "Merci !");
  assert.equal(test.expiresAtMs, nowMs + 30000);
  assert.deepEqual(db.writes, ["guardian_live_channels/123/tests/subscription", "overlay_state_signals/guardian"]);
  for (const path of Object.keys(initial)) assert.deepEqual(db.documents.get(path), initial[path], `${path} stays untouched`);
  const writes = db.writes.length;
  assert.equal((await handleOverlaySubCardTestCommand(command)).reason, "duplicate");
  assert.equal(db.writes.length, writes, "a retried message neither rewrites the test nor extends its deadline");
  assert.equal(sent.length, 1);
  const waiting = await pollGuardianLive({ db, channelId: "123", now: nowMs + 100 });
  assert.equal(waiting.kind, "guardian");
  assert.equal(waiting.subscriptionPresentation, undefined);
  const started = await pollGuardianLive({ db, channelId: "123", now: nowMs + 200,
    preparedSubscription: waiting.subscriptionPreparation });
  assert.equal(started.startsAtMs, nowMs + 200 + 1200);
  assert.equal(started.subscriptionPresentation.version, 3);
  assert.equal(started.endsAtMs, started.subscriptionPresentation.returnEndsAtMs);
  assert.equal(started.subscriptionPresentation.exitStartsAtMs, started.subscriptionPresentation.cardEndsAtMs);
  for (const path of Object.keys(initial)) assert.deepEqual(db.documents.get(path), initial[path], `${path} stays untouched after readiness`);
});
