"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createGuardianLive } = require("../script/guardianLive");
const { createTwitchEventSub } = require("../app/twitchEventSub");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");

const NOW = 1_000_000;
const eventFor = (overrides = {}) => ({
  broadcaster_user_id: "123", user_id: "42", user_login: "renamed", user_name: "Renamed",
  tier: "1000", is_gift: false, ...overrides,
});

function serviceFixture(overrides = {}) {
  const db = createMemoryFirestore();
  const messages = [], warnings = [], identities = [];
  let time = NOW;
  const app = createGuardianLive({
    db, channelId: "123", now: () => time,
    getLiveState: async () => ({ streamId: "live" }),
    resolveTwitchIdentity: async (request) => { identities.push(request); return { login: "canonical" }; },
    sendMessage: async (message) => messages.push(message),
    logger: { warn: (...args) => warnings.push(args) },
    ...overrides,
  });
  const subscribe = (patch = {}) => app.handleSubscription({ event: eventFor(), messageId: "eventsub-42", sentAtMs: time, ...patch });
  return { db, app, subscribe, messages, warnings, identities, setTime: (value) => { time = value; } };
}

test("subscription service rejects stale, future, missing and foreign identities before accessing live state", async () => {
  const fixture = serviceFixture({ getLiveState: async () => { throw new Error("must not look up live state"); } });
  for (const sentAtMs of [NOW - 300_001, NOW + 2001, NaN, undefined]) {
    assert.equal((await fixture.subscribe({ sentAtMs })).reason, "stale");
  }
  for (const patch of [{ event: eventFor({ user_id: "" }) }, { event: eventFor({ user_login: "" }) }, { messageId: "" }]) {
    assert.equal((await fixture.subscribe(patch)).reason, "identity_missing");
  }
  assert.equal((await fixture.subscribe({ event: eventFor({ broadcaster_user_id: "999" }) })).reason, "channel_mismatch");
  assert.deepEqual(fixture.db.writes, []);
  assert.deepEqual(fixture.identities, []);
  assert.deepEqual(fixture.messages, []);
  assert.deepEqual(fixture.warnings, []);
});

test("offline subscriptions do not resolve profiles, write state or send chat messages", async () => {
  const fixture = serviceFixture({ getLiveState: async () => ({ streamId: "" }) });
  assert.equal((await fixture.subscribe()).reason, "offline");
  assert.deepEqual(fixture.db.writes, []);
  assert.deepEqual(fixture.identities, []);
  assert.deepEqual(fixture.messages, []);
});

test("subscription lookup errors are contained and a delayed lookup cannot enqueue an expired event", async () => {
  const failed = serviceFixture({ resolveTwitchIdentity: async () => { throw new Error("identity unavailable"); } });
  assert.equal((await failed.subscribe()).reason, "unavailable");
  assert.equal(failed.warnings.length, 1);
  assert.deepEqual(failed.db.writes, []);
  assert.deepEqual(failed.messages, []);
  let fixture;
  fixture = serviceFixture({ resolveTwitchIdentity: async () => { fixture.setTime(NOW + 300_001); return { login: "canonical" }; } });
  assert.equal((await fixture.subscribe()).reason, "stale");
  assert.deepEqual(fixture.db.writes, []);
});

test("gift subscriptions queue the recipient's canonical character using the EventSub delivery ID", async () => {
  const fixture = serviceFixture();
  const event = eventFor({ is_gift: true, gifter_user_id: "99", gifter_user_login: "generous", gifter_user_name: "Generous" });
  const first = await fixture.subscribe({ event });
  assert.equal(first.accepted, true);
  assert.deepEqual(fixture.identities[0], { login: "renamed", twitchUserId: "42", allowCreate: false });
  const state = fixture.db.documents.get("guardian_live_channels/123");
  const serialized = JSON.stringify(state);
  assert.ok(serialized.includes("eventsub-42"));
  assert.ok(serialized.includes("canonical"));
  assert.ok(serialized.includes('"userId":"42"'));
  assert.ok(!serialized.includes("generous"));
  assert.deepEqual(fixture.messages, []);
  const previous = structuredClone(state);
  assert.equal((await fixture.subscribe({ event })).accepted, false);
  assert.deepEqual(fixture.db.documents.get("guardian_live_channels/123"), previous, "a retry keeps the existing celebration");
});

test("a delayed subscription identity lookup cannot revive a stream that the live monitor replaced", async () => {
  let streamId = "old", release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixture = serviceFixture({
    getLiveState: async () => ({ streamId }),
    resolveTwitchIdentity: async () => { await gate; return { login: "canonical" }; },
  });
  const pending = fixture.subscribe();
  await Promise.resolve();
  fixture.setTime(NOW + 1000);
  streamId = "new";
  await fixture.app.tick();
  release();
  assert.equal((await pending).reason, "offline");
  assert.equal(fixture.db.documents.get("guardian_live_channels/123").streamId, "new");
  assert.ok(!fixture.db.documents.has("guardian_live_channels/123/viewers/42"));
});

function signedRequest(body, id, timestamp = new Date(NOW).toISOString(), secret = "secret") {
  const signature = crypto.createHmac("sha256", secret).update(id + timestamp + JSON.stringify(body)).digest("hex");
  const headers = {
    "twitch-eventsub-message-id": id,
    "twitch-eventsub-message-timestamp": timestamp,
    "twitch-eventsub-message-signature": `sha256=${signature}`,
  };
  return { body, header: (name) => headers[String(name).toLowerCase()] };
}

function response() {
  return {
    statusCode: null,
    sendStatus(code) { this.statusCode = code; return this; },
    status(code) { this.statusCode = code; return { send: () => this }; },
  };
}

function eventSubFixture(handleGuardianSubscription, { overlay = {}, resolveTwitchIdentity } = {}) {
  const db = createMemoryFirestore();
  const notices = [];
  const app = createTwitchEventSub({
    db,
    config: {
      twitch: { channelId: "123", webhookSecret: "secret" },
      overlay: { subCardResubWaitMs: 0, subCardDedupeMs: 0, ...overlay },
      timing: { subCooldownMs: 0, subDebounceMs: 0 },
      discord: { bootyChannelId: "existing-notices" },
    },
    handleGuardianSubscription,
    resolveTwitchIdentity,
    postDiscord: async (...args) => notices.push(args),
  });
  const deliver = async (type, id, event = eventFor(), secret = "secret") => {
    const res = response();
    await app.handleTwitchCallback(signedRequest({ subscription: { type }, event }, id, undefined, secret), res);
    return res;
  };
  return { db, app, deliver, notices };
}

test("verified new-sub and resub callbacks forward signed delivery identity once without changing the existing flow", async () => {
  const calls = [];
  const fixture = eventSubFixture(async (input) => calls.push(input));
  for (const [type, id] of [["channel.subscribe", "sub-delivery"], ["channel.subscription.message", "resub-delivery"]]) {
    const event = eventFor({ is_gift: true, gifter_user_id: "99", cumulative_months: 6 });
    assert.equal((await fixture.deliver(type, id, event)).statusCode, 200);
    assert.equal((await fixture.deliver(type, id, event)).statusCode, 200);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ messageId }) => messageId), ["sub-delivery", "resub-delivery"]);
  assert.ok(calls.every(({ event, sentAtMs }) => event.user_id === "42" && event.gifter_user_id === "99" && sentAtMs === NOW));
  assert.equal(fixture.db.documents.get("participants/renamed").isSub, true);
  assert.equal(fixture.db.documents.get("followers_all_time/renamed").subMonths, 6);
  assert.equal([...fixture.db.documents.keys()].filter((path) => path.startsWith("overlay_events/")).length, 2);
});

test("accepted Guardian subscriptions read fresh canonical subscription data and own the only card presentation", async () => {
  const calls = [];
  let fixture;
  fixture = eventSubFixture(async (input) => {
    assert.equal(fixture.db.documents.get("participants/canonical").isSub, true);
    assert.equal(fixture.db.documents.get("followers_all_time/canonical").subMonths, input.event.cumulative_months);
    calls.push(input);
    return { accepted: true, position: 1 };
  }, {
    overlay: { subCardResubWaitMs: 60_000 },
    resolveTwitchIdentity: async () => ({ login: "canonical" }),
  });
  for (const [type, id, months] of [["channel.subscribe", "accepted-sub", 6], ["channel.subscription.message", "accepted-resub", 14]]) {
    assert.equal((await fixture.deliver(type, id, eventFor({ cumulative_months: months }))).statusCode, 200);
    assert.equal((await fixture.deliver(type, id, eventFor({ cumulative_months: months }))).statusCode, 200);
  }
  assert.equal(calls.length, 2, "delivery retries never enqueue another presentation");
  assert.ok(calls.every(({ event }) => event.user_login === "canonical" && event.user_id === "42"));
  assert.equal(fixture.db.documents.get("followers_all_time/canonical").subMonths, 14);
  assert.ok(!fixture.db.documents.has("participants/renamed"));
  assert.ok(!fixture.db.documents.has("followers_all_time/renamed"));
  assert.equal([...fixture.db.documents.keys()].filter((path) => path.startsWith("overlay_events/")).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.notices.length, 1, "the resub still replaces the debounced subscription notice");
});

test("a correlated Guardian duplicate updates subscription months without publishing or replaying a legacy card", async () => {
  let calls = 0;
  const fixture = eventSubFixture(async () => {
    calls++;
    return calls === 1 ? { accepted: true } : { accepted: false, reason: "duplicate" };
  });
  await fixture.deliver("channel.subscribe", "correlated-sub");
  await fixture.deliver("channel.subscription.message", "correlated-resub", eventFor({ cumulative_months: 25 }));
  assert.equal(calls, 2);
  assert.equal(fixture.db.documents.get("followers_all_time/renamed").subMonths, 25);
  assert.equal([...fixture.db.documents.keys()].filter((path) => path.startsWith("overlay_events/")).length, 0);
});

test("Guardian acceptance or duplicate cancels only that viewer's pending legacy fallback", async () => {
  for (const result of [{ accepted: true }, { accepted: false, reason: "duplicate" }]) {
    let recovered = false;
    const fixture = eventSubFixture(async () => recovered ? result : { accepted: false, reason: "offline" }, {
      overlay: { subCardResubWaitMs: 60 },
    });
    await fixture.deliver("channel.subscribe", `pending-alice-${result.accepted}`, eventFor({ user_id: "42", user_login: "alice" }));
    await fixture.deliver("channel.subscribe", `pending-bob-${result.accepted}`, eventFor({ user_id: "43", user_login: "bob" }));
    recovered = true;
    await fixture.deliver("channel.subscription.message", `recovered-alice-${result.accepted}`, eventFor({ user_id: "42", user_login: "alice", cumulative_months: 9 }));
    await new Promise((resolve) => setTimeout(resolve, 90));
    const cards = [...fixture.db.documents.values()].filter((value) => value?.type === "sub_card");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].login, "bob");
    assert.equal(fixture.db.documents.get("followers_all_time/alice").subMonths, 9);
  }
});

test("explicit offline and unavailable Guardian results keep the standalone subscription fallback", async () => {
  for (const reason of ["offline", "unavailable"]) {
    const fixture = eventSubFixture(async () => ({ accepted: false, reason }));
    await fixture.deliver("channel.subscription.message", `fallback-${reason}`, eventFor({ cumulative_months: 12 }));
    assert.equal(fixture.db.documents.get("participants/renamed").isSub, true);
    assert.equal(fixture.db.documents.get("followers_all_time/renamed").subMonths, 12);
    assert.equal(fixture.db.documents.get(`overlay_events/sub_card_fallback-${reason}`).subMonths, 12);
    assert.equal(fixture.notices.length, 1);
  }
});

test("failed Guardian subscription appearances preserve existing sub cards, subscription writes and Discord notices", async () => {
  const fixture = eventSubFixture(async () => { throw new Error("Guardian unavailable"); });
  for (const [type, id, login] of [["channel.subscribe", "failed-sub", "alice"], ["channel.subscription.message", "failed-resub", "bob"]]) {
    assert.equal((await fixture.deliver(type, id, eventFor({ user_login: login, user_name: login }))).statusCode, 200);
    assert.equal(fixture.db.documents.get(`participants/${login}`).isSub, true);
    assert.equal(fixture.db.documents.get(`followers_all_time/${login}`).isStillSub, true);
    assert.ok(fixture.db.documents.has(`overlay_events/sub_card_${id}`));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.notices.length, 2);
  assert.ok(fixture.notices.every(([channel]) => channel === "existing-notices"));
});

test("invalid signatures and excluded service accounts cannot invoke Guardian subscription appearances", async () => {
  const calls = [];
  const fixture = eventSubFixture(async (input) => calls.push(input));
  assert.equal((await fixture.deliver("channel.subscribe", "untrusted", eventFor(), "wrong-secret")).statusCode, 403);
  assert.equal((await fixture.deliver("channel.subscribe", "excluded", eventFor({ user_login: "streamelements" }))).statusCode, 200);
  assert.deepEqual(calls, []);
  assert.deepEqual(fixture.db.writes, []);
});
