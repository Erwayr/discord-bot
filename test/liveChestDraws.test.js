"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createLiveChestDraws } = require("../script/liveChestDraws");
const { normalizeConfig, publicDraw } = require("../script/liveChestDraws.shared.cjs");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");

function fixture({ enabled = true, senderFails = false, randomInt = () => 0 } = {}) {
  let time = Date.UTC(2026, 8, 14, 12);
  let stream = { streamId: "stream1", startedAt: new Date(time).toISOString() };
  let failure = null;
  let identityCalls = 0;
  const messages = [];
  const db = createMemoryFirestore({
    "site_config/live_chest_draws": normalizeConfig({ enabled }),
    "followers_all_time/alice": { twitch_id: "11", pops: { balance: 50 }, questChestSummary: { pendingCount: 0, totalEarned: 0 } },
    "followers_all_time/bob": { twitch_id: "12" },
    "followers_all_time/charlie": { twitch_id: "13" },
  });
  const config = { twitch: { channelId: "480296446", channelLogin: "erwayr", moderatorId: "99" } };
  const deps = {
    db, config, now: () => time, randomInt, logger: { warn() {} },
    resolveTwitchIdentity: async ({ login }) => { identityCalls++; return { login: login === "alice_new" ? "alice" : login, status: "active" }; },
    getLiveState: async () => { if (failure) throw failure; return stream; },
    sendMessage: async (message) => { messages.push(message); return { is_sent: !senderFails, message_id: String(messages.length) }; },
  };
  let service = createLiveChestDraws(deps);
  function command(message, login = "erwayr", userId = "480296446", extras = {}) {
    return service.handleMessage({ message, login, displayName: login, channel: "#erwayr", tags: { "user-id": userId, ...extras } });
  }
  const runtime = () => db.documents.get("settings/live_chest_draws") || {};
  const active = () => db.documents.get(`live_chest_draws/${runtime().activeDrawId || runtime().displayDrawId}`);
  return { db, messages, command, runtime, active, now: () => time, advance: (ms) => { time += ms; },
    setStream: (value) => { stream = value; }, setFailure: (value) => { failure = value; },
    identities: () => identityCalls, service: () => service, newService: () => createLiveChestDraws(deps), restart: () => { service = createLiveChestDraws(deps); },
    async open() { await service.tick(); time = runtime().nextOpenAtMs; await service.tick(); assert.equal(active().status, "open"); },
  };
}

test("disabled by default and first random registration opens no earlier than three minutes", async () => {
  const disabled = fixture({ enabled: false });
  await disabled.service().tick(); disabled.advance(7200000); await disabled.service().tick();
  assert.equal(disabled.active(), undefined);
  const f = fixture();
  const start = f.now();
  await f.open();
  assert.equal(f.active().opensAtMs, start + 180000);
  assert.equal(f.active().config.winnerCount, 2);
  assert.equal(f.active().closesAtMs - f.active().opensAtMs, 180000);
  assert.equal(f.messages.length, 1);
});

test("test command is owner-only, works offline and writes no profiles, entries, chests or XP", async () => {
  const f = fixture({ enabled: false });
  f.setStream(null);
  await f.service().tick();
  assert.equal((await f.command("!coffretest", "erwayr", "11", { badges: { broadcaster: "1" } })).reason, "unauthorized");
  assert.equal((await f.command("!coffretest")).reason, "test_started");
  const demo = f.db.documents.get(`live_chest_draw_tests/${f.runtime().demoId}`);
  assert.equal(demo.winners.length, 2);
  assert.deepEqual(demo.winners.map((winner) => winner.chestType), ["runic", "legendary"]);
  assert.equal(demo.closesAtMs - demo.opensAtMs, 10000);
  assert.equal(f.identities(), 0);
  assert.equal((await f.command("!coffretest")).reason, "cooldown");
  f.advance(22001); await f.service().tick();
  assert.equal(publicDraw(demo, f.now()).status, "completed");
  f.advance(20000); await f.service().tick();
  assert.equal(f.runtime().demoId, null);
  assert.equal(publicDraw(demo, f.now()), null);
  assert.ok(f.messages.some((message) => message.includes("Démonstration terminée")));
  assert.ok(f.db.writes.every((entry) => entry.startsWith("settings/") || entry.startsWith("live_chest_draw_tests/")));
});

test("the first three minutes stay closed and a restart, visual edit or test command preserves the chosen time", async () => {
  const f = fixture();
  await f.service().tick();
  const scheduled = f.runtime().nextOpenAtMs;
  f.advance(179000); await f.service().tick();
  assert.equal(f.active(), undefined);
  assert.equal((await f.command("!coffre", "alice", "11")).reason, "closed");
  const settings = f.db.documents.get("site_config/live_chest_draws");
  f.db.documents.set("site_config/live_chest_draws", { ...settings, width: 280, corner: "bottom-left", volume: 0 });
  f.restart(); await f.service().tick();
  assert.equal(f.runtime().nextOpenAtMs, scheduled);
  await f.command("!coffretest");
  assert.equal(f.runtime().nextOpenAtMs, scheduled);
  f.advance(1000); await f.service().tick();
  assert.equal(f.active().opensAtMs, scheduled);
  assert.equal(f.active().config.width, 280);
  assert.equal(f.runtime().demoId, null);
});

test("concurrent planners and transaction retries choose one appointment and create one draw per window", async () => {
  let calls = 0;
  const f = fixture({ randomInt: () => { calls++; return 0; } });
  const other = f.newService();
  f.db.retryNext(2);
  await Promise.all([f.service().tick(), other.tick()]);
  assert.equal(calls, 1);
  const scheduled = f.runtime().nextOpenAtMs;
  f.advance(scheduled - f.now());
  await Promise.all([f.service().tick(), other.tick()]);
  assert.equal(f.active().status, "open");
  assert.equal(f.messages.filter((text) => text.includes("Écris !coffre")).length, 1);
  await Promise.all([f.service().tick(), other.tick()]);
  assert.equal([...f.db.documents.keys()].filter((key) => /^live_chest_draws\/[^/]+$/.test(key)).length, 1);
});

test("missed appointments and long outages skip to a future window without catching up", async () => {
  const f = fixture();
  await f.service().tick();
  const missed = f.runtime().nextOpenAtMs;
  f.advance(missed - f.now() + 30001);
  f.restart(); await f.service().tick();
  assert.equal(f.active(), undefined);
  assert.equal(f.runtime().scheduleWindowIndex, 1);
  assert.ok(f.runtime().nextOpenAtMs > f.now());
  const next = f.runtime().nextOpenAtMs;
  await f.service().tick();
  assert.equal(f.runtime().nextOpenAtMs, next);
  f.advance(5 * 3600000); f.restart(); await f.service().tick();
  assert.ok(f.runtime().nextOpenAtMs > f.now());
  assert.equal(f.active(), undefined);
});

test("the grace period permits a late tick only while the complete event still fits", async () => {
  const f = fixture();
  await f.service().tick(); f.advance(f.runtime().nextOpenAtMs - f.now() + 30000);
  await f.service().tick();
  assert.equal(f.active().status, "open");
  const last = fixture({ randomInt: (max) => max - 1 });
  await last.service().tick();
  const end = last.runtime().scheduleWindowEndAtMs;
  last.advance(last.runtime().nextOpenAtMs - last.now() + 25000);
  await last.service().tick();
  assert.equal(last.active().status, "open");
  last.advance(185000); await last.service().tick();
  assert.ok(last.active().expiresAtMs <= end);
});

test("too-short windows are reported once and resume in a window with sufficient room", async () => {
  const f = fixture();
  const start = f.now();
  f.db.documents.set("site_config/live_chest_draws", normalizeConfig({ enabled: true, intervalMinutes: 5 }));
  await f.service().tick();
  assert.equal(f.runtime().nextOpenAtMs, null);
  assert.equal(f.runtime().scheduleIssue, "window_too_short");
  const count = f.db.writes.length;
  f.advance(60000); await f.service().tick();
  assert.equal(f.db.writes.length, count);
  f.advance(240000); await f.service().tick();
  assert.equal(f.active().opensAtMs, start + 300000);
  assert.equal(f.runtime().scheduleIssue, null);
});

test("timing edits move to the next boundary and disabling cannot reroll a consumed window", async () => {
  const f = fixture();
  const start = f.now();
  await f.service().tick();
  f.db.documents.set("site_config/live_chest_draws", normalizeConfig({ enabled: true, intervalMinutes: 30 }));
  f.advance(15000); await f.service().tick();
  assert.equal(f.runtime().nextOpenAtMs, start + 3600000);
  assert.equal(f.runtime().scheduleIntervalMinutes, 30);
  const active = fixture(); await active.open();
  active.db.documents.set("site_config/live_chest_draws", normalizeConfig({ enabled: false }));
  active.advance(15000); await active.service().tick();
  assert.equal(active.active().status, "cancelled");
  active.db.documents.set("site_config/live_chest_draws", normalizeConfig({ enabled: true }));
  active.advance(15000); await active.service().tick();
  assert.equal(active.runtime().scheduleWindowIndex, 1);
  assert.ok(active.runtime().nextOpenAtMs > active.now());
});

test("legacy scheduling migrates at the next window and preserves an ongoing registration", async () => {
  const f = fixture();
  const start = f.now();
  await f.open();
  const draw = f.active();
  f.db.documents.set("settings/live_chest_draws", {
    streamId: "stream1", scheduleIntervalMinutes: 60, nextOpenAtMs: start + 7200000,
    activeDrawId: draw.id, displayDrawId: draw.id,
  });
  f.advance(60000); f.restart(); await f.service().tick();
  assert.equal(f.active().id, draw.id);
  assert.equal(f.active().closesAtMs, draw.closesAtMs);
  assert.equal(f.runtime().nextOpenAtMs, start + 3600000);
  assert.equal(f.runtime().scheduleVersion, 2);
});

test("offline clears the appointment and each new Twitch live gets its own three-minute minimum", async () => {
  const f = fixture();
  await f.service().tick();
  f.setStream(null); await f.service().tick();
  assert.equal(f.runtime().nextOpenAtMs, null);
  assert.equal(f.active(), undefined);
  f.advance(10000);
  f.setStream({ streamId: "stream2", startedAt: new Date(f.now()).toISOString() });
  await f.service().tick();
  assert.equal(f.runtime().nextOpenAtMs, f.now() + 180000);
  for (const startedAt of [null, undefined, "invalid", new Date(f.now() + 60000).toISOString()]) {
    f.setStream({ streamId: "stream3", startedAt });
    await f.service().tick();
    assert.equal(f.runtime().nextOpenAtMs, null);
    assert.equal(f.runtime().scheduleIssue, "invalid_live_start");
  }
});

test("successive hours can have different random times without overlapping events", async () => {
  let count = 0;
  const f = fixture({ randomInt: (max) => count++ % 2 ? max - 1 : 0 });
  const start = f.now();
  let previousEnd = 0;
  for (let hour = 0; hour < 4; hour++) {
    await f.open();
    const draw = f.active();
    assert.equal(draw.scheduleWindowStartAtMs, start + hour * 3600000);
    assert.ok(draw.opensAtMs >= previousEnd);
    f.advance(180000); await f.service().tick();
    previousEnd = f.active().expiresAtMs;
    assert.ok(previousEnd <= draw.scheduleWindowEndAtMs);
    f.advance(25000); await f.service().tick();
  }
  assert.equal([...f.db.documents.keys()].filter((key) => /^live_chest_draws\/[^/]+$/.test(key)).length, 4);
});

test("test event cooldown persists across restart, shared-chat and other channels are rejected", async () => {
  const f = fixture({ enabled: false });
  await f.command("!coffretest"); f.restart();
  assert.equal((await f.command("!coffretest")).reason, "cooldown");
  f.advance(60001);
  const before = f.db.writes.length;
  await f.command("!coffretest", "erwayr", "480296446", { "source-room-id": "another" });
  assert.equal(f.db.writes.length, before);
  assert.equal((await f.command("!COFFRETEST")).reason, "test_started");
});

test("duplicate admissions are atomic, missing profiles cannot enter, stable IDs preserve renames", async () => {
  const f = fixture(); await f.open();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.command("!coffre", "alice", "11")));
  assert.equal(results.filter((result) => result.reason === "joined").length, 1);
  assert.equal(f.active().entrantCount, 1);
  assert.equal((await f.command("!coffre", "alice_new", "11")).reason, "duplicate");
  assert.equal((await f.command("!coffre", "absent", "14")).reason, "missing_profile");
  assert.ok(f.messages.some((message) => message.includes("crée ton profil")));
  assert.equal((await f.command("!coffre", "bob", "15")).reason, "identity_conflict");
  assert.equal((await f.command("!coffre", "erwayr", "480296446")).reason, "excluded");
  assert.equal((await f.command("!coffre", "streamelements", "16")).reason, "excluded");
  assert.equal(f.active().entrantCount, 1);
});

test("two winners receive immutable chests once despite transaction retries and duplicate settlement", async () => {
  const f = fixture(); await f.open();
  await f.command("!coffre", "alice", "11"); await f.command("!coffre", "bob", "12"); await f.command("!coffre", "charlie", "13");
  f.advance(150001); await f.service().tick();
  assert.ok(f.messages.some((message) => message.includes("30 secondes")));
  f.advance(30000);
  f.db.retryNext(2);
  const ref = f.db.collection("live_chest_draws").doc(f.active().id);
  await Promise.all([f.service().settle(ref), f.service().settle(ref)]);
  assert.equal(f.active().status, "completed");
  assert.equal(f.active().winners.length, 2);
  const chests = [...f.db.documents].filter(([key]) => key.includes("/quest_chests/"));
  assert.equal(chests.length, 2);
  for (const [, chest] of chests) {
    assert.equal(chest.source, "live_draw"); assert.equal(chest.status, "available");
    assert.equal(chest.rewardSnapshot.popsMin, 100); assert.equal(chest.drawId, f.active().id);
  }
  assert.equal(f.db.documents.get("followers_all_time/alice").questChestSummary.pendingCount, 1);
  assert.equal(f.db.documents.get("followers_all_time/alice").questChestSummary.totalEarned, 1);
  assert.equal(f.db.documents.get("followers_all_time/alice").pops.balance, 50);
  assert.equal(f.db.writes.some((key) => key.startsWith("participants/") || key.includes("pops_transactions")), false);
  f.advance(9001); await f.service().tick();
  assert.ok(f.messages.some((message) => message.includes("@alice") && message.includes("@bob") && message.includes("coffres.html")));
});

for (const count of [0, 1]) test(`${count} entrants award exactly ${count} chests`, async () => {
  const f = fixture(); await f.open();
  if (count) await f.command("!coffre", "alice", "11");
  f.advance(180001); await f.service().tick();
  assert.equal(f.active().winners.length, count);
  assert.equal([...f.db.documents.keys()].filter((key) => key.includes("/quest_chests/")).length, count);
});

test("previous winners can join the next draw; settings and contents freeze per draw", async () => {
  const f = fixture(); await f.open();
  await f.command("!coffre", "alice", "11");
  f.db.documents.set("site_config/live_chest_draws", normalizeConfig({ enabled: true, winnerCount: 3, probabilities: { runic: 0, epic: 0, legendary: 100 } }));
  f.advance(180001); await f.service().tick();
  assert.equal(f.active().winners[0].chestType, "runic");
  f.advance(25000); await f.service().tick();
  f.advance(f.runtime().nextOpenAtMs - f.now()); await f.service().tick();
  assert.equal(f.active().status, "open"); assert.equal(f.active().config.winnerCount, 3);
  assert.equal((await f.command("!coffre", "alice", "11")).reason, "joined");
  f.advance(180001); await f.service().tick();
  assert.equal(f.active().winners[0].chestType, "legendary");
  assert.equal(f.db.documents.get("followers_all_time/alice").questChestSummary.totalEarned, 2);
});

test("restarting resumes unexpired registrations, cancels expired ones, and does not catch up missed slots", async () => {
  const f = fixture(); await f.open(); await f.command("!coffre", "alice", "11");
  const deadline = f.active().closesAtMs;
  f.advance(60000); f.restart(); await f.service().tick();
  assert.equal(f.active().closesAtMs, deadline); assert.equal(f.active().entrantCount, 1);
  f.advance(180000); f.restart(); await f.service().tick();
  assert.equal(f.active().status, "cancelled"); assert.equal(f.active().cancelReason, "restart_expired");
  f.advance(7200000); await f.service().tick();
  assert.ok(f.runtime().nextOpenAtMs > f.now());
  assert.equal([...f.db.documents.keys()].filter((key) => key.startsWith("live_chest_draws/") && key.split("/").length === 2).length, 1);
});

test("network errors defer work, offline or disable cancels registrations, tests cannot interrupt a real draw", async () => {
  const f = fixture(); await f.open();
  assert.equal((await f.command("!coffretest")).reason, "busy");
  f.setFailure(new Error("network")); f.advance(15000);
  await assert.rejects(f.service().tick(), /network/); assert.equal(f.active().status, "open");
  f.setFailure(null); f.setStream(null); await f.service().tick();
  assert.equal(f.active().status, "cancelled");
  const disabled = fixture(); await disabled.open();
  disabled.db.documents.set("site_config/live_chest_draws", normalizeConfig());
  disabled.advance(15001); await disabled.service().tick();
  assert.equal(disabled.active().cancelReason, "disabled");
});

test("failed chat sends are recorded while confirmed rewards survive restart", async () => {
  const f = fixture({ senderFails: true }); await f.open();
  await f.command("!coffre", "alice", "11"); f.advance(180001); await f.service().tick();
  const id = f.active().id; f.advance(25000); f.restart(); await f.service().tick();
  assert.equal(f.db.documents.get(`live_chest_draws/${id}`).announcements.result.error, "chat_delivery_failed");
  assert.equal(f.db.documents.get("followers_all_time/alice").questChestSummary.totalEarned, 1);
});

test("grant summary reconciles an existing chest opened concurrently", async () => {
  const f = fixture(); await f.open(); await f.command("!coffre", "alice", "11");
  f.db.documents.set("followers_all_time/alice/quest_chests/old", { status: "available", chestType: "epic" });
  f.db.documents.set("followers_all_time/alice", { twitch_id: "11", questChestSummary: { pendingCount: 1, pendingByType: { runic: 0, epic: 1, legendary: 0 }, totalEarned: 1, totalOpened: 0 } });
  f.advance(180001);
  await Promise.all([
    f.db.runTransaction(async (tx) => {
      const profile = f.db.collection("followers_all_time").doc("alice"); await tx.get(profile);
      tx.update(profile, { "questChestSummary.pendingCount": 0, "questChestSummary.pendingByType.epic": 0, "questChestSummary.totalOpened": 1 });
      tx.update(profile.collection("quest_chests").doc("old"), { status: "opened" });
    }),
    f.service().settle(f.db.collection("live_chest_draws").doc(f.active().id)),
  ]);
  const summary = f.db.documents.get("followers_all_time/alice").questChestSummary;
  assert.equal(summary.pendingCount, 1); assert.equal(summary.pendingByType.epic, 0);
  assert.equal(summary.totalOpened, 1); assert.equal(summary.totalEarned, 2);
});

test("a profile renamed after registration receives its chest at the current canonical login", async () => {
  const f = fixture(); await f.open(); await f.command("!coffre", "alice", "11");
  f.db.documents.set("twitch_identities/11", { currentLogin: "alice_new", status: "active" });
  f.db.documents.set("followers_all_time/alice_new", f.db.documents.get("followers_all_time/alice"));
  f.db.documents.delete("followers_all_time/alice");
  f.advance(180001); await f.service().tick();
  assert.equal(f.active().winners[0].login, "alice_new");
  assert.equal(f.db.documents.get("followers_all_time/alice_new").questChestSummary.pendingCount, 1);
  assert.equal([...f.db.documents.keys()].some((key) => key.startsWith("followers_all_time/alice/")), false);
});

test("Twitch handler processes chest tests before the live-only gate and returns the send receipt", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../app/twitchChat.js"), "utf8");
  const messageHandler = source.slice(source.indexOf('tmiClient.on("message"'));
  assert.ok(messageHandler.indexOf("liveChestDraws.handleMessage") < messageHandler.indexOf("getLiveStreamStateForEmotes"));
  assert.match(source, /return r;/);
});
