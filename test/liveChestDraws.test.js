"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createLiveChestDraws } = require("../script/liveChestDraws");
const { normalizeConfig, publicDraw } = require("../script/liveChestDraws.shared.cjs");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");

function fixture({ enabled = true, senderFails = false } = {}) {
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
    db, config, now: () => time, randomInt: () => 0, logger: { warn() {} },
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
    identities: () => identityCalls, service: () => service, restart: () => { service = createLiveChestDraws(deps); },
    async open() { await service.tick(); time += 3600000; await service.tick(); assert.equal(active().status, "open"); },
  };
}

test("disabled by default and first registration opens after one hour", async () => {
  const disabled = fixture({ enabled: false });
  await disabled.service().tick(); disabled.advance(7200000); await disabled.service().tick();
  assert.equal(disabled.active(), undefined);
  const f = fixture();
  await f.open();
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
