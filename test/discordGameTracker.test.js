"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");
const { createDiscordGameTracker, playingGame, CHECKPOINT_MS } = require("../script/discordGameTracker");

const PROFILE = "followers_all_time/pepigom";
const LOCK = "discord_game_tracking/discord-pepigom";
const rawPresence = (name = "RedM", status = "online") => ({
  user: { id: "discord-pepigom" }, status,
  activities: name ? [{ type: 0, name, timestamps: { start: 1 } }] : [],
});

function fixture(options = {}) {
  const clock = options.clock || { wall: 1_000_000, mono: 0 };
  const db = options.db || createMemoryFirestore({
    [PROFILE]: { discord_id: "discord-pepigom", untouched: "keep", games_history: [{ name: "RedM", count: 11307, custom: "keep" }] },
    "participants/pepigom": { untouched: "mirror" },
  });
  const client = new EventEmitter();
  const guild = {
    id: "guild", shardId: 0, available: true,
    channels: { cache: new Map([["general", {}]]) },
    members: { fetch: async (request) => fetchMembers(request) },
  };
  client.guilds = { cache: new Map([[guild.id, guild]]) };
  client.channels = { cache: new Map([["general", { guildId: guild.id }]]) };
  let snapshot = options.snapshot || [rawPresence()];
  let fetchMembers = async (request) => {
    client.emit("raw", { t: "GUILD_MEMBERS_CHUNK", d: { guild_id: guild.id, nonce: request.nonce, presences: snapshot } });
    return new Map();
  };
  const timers = new Set();
  const logs = [];
  let token = 0;
  const tracker = createDiscordGameTracker({
    db, client,
    admin: { firestore: { Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } } },
    config: { discord: { guildId: "guild", generalChannelId: "general", ...options.discord }, discordGameTracking: { enabled: options.enabled !== false } },
    now: () => clock.wall, monotonicNow: () => clock.mono,
    createId: () => `${options.id || "a"}-${++token}`,
    setIntervalFn: (fn, ms) => { assert.equal(ms, CHECKPOINT_MS); const timer = { fn }; timers.add(timer); return timer; },
    clearIntervalFn: (timer) => timers.delete(timer),
    logger: { info: (line) => logs.push(line), warn: (...parts) => logs.push(parts.join(" ")) },
  });
  return {
    tracker, db, client, guild, clock, timers, logs,
    advance(ms) { clock.wall += ms; clock.mono += ms; },
    snapshot(value) { snapshot = value; },
    fetchWith(fn) { fetchMembers = fn; },
    emitSnapshot(request, presences = snapshot) { client.emit("raw", { t: "GUILD_MEMBERS_CHUNK", d: { guild_id: guild.id, nonce: request.nonce, presences } }); },
    event(name = "RedM", status = "online") { return tracker.onPresence(null, { ...rawPresence(name, status), guild, userId: "discord-pepigom" }); },
    game(name = "RedM") { return db.documents.get(PROFILE).games_history.find((entry) => entry.name === name); },
  };
}

test("duration uses observed intervals, freezes legacy score and preserves unrelated data", async () => {
  const f = fixture();
  await f.tracker.start();
  for (let i = 0; i < 5; i++) { f.advance(60_000); await f.tracker.tick(); }
  await f.event(null, "offline");
  assert.equal(f.game().trackedDurationMs, 300_000);
  assert.equal(f.game().count, 11307);
  assert.equal(f.game().custom, "keep");
  assert.equal(f.game().trackingStartedAt.toMillis(), 1_000_000);
  assert.equal(f.db.documents.get(PROFILE).untouched, "keep");
  assert.deepEqual(f.db.documents.get("participants/pepigom"), { untouched: "mirror" });
  assert.equal(f.db.documents.get(LOCK).leaseUntilMs, 0);
  assert.ok(f.logs.some((line) => line.includes("schema=1 ready")));
  await f.tracker.stop();
});

test("one short session credits minutes, activity detail updates do not multiply time", async () => {
  const f = fixture();
  await f.tracker.start();
  for (let i = 0; i < 60; i++) { f.advance(1000); await f.event("RedM", i % 2 ? "idle" : "dnd"); }
  await Promise.all([f.tracker.tick(), f.event("RedM"), f.event("RedM")]);
  f.advance(30_000);
  await f.event(null);
  assert.equal(f.game().trackedDurationMs, 90_000);
  await f.tracker.stop();
});

test("switching games closes the first interval; new games have no historical score", async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(30_000);
  await f.event("Another game");
  f.advance(45_000);
  await f.event(null, "offline");
  assert.equal(f.game().trackedDurationMs, 30_000);
  assert.equal(f.game("Another game").trackedDurationMs, 45_000);
  assert.equal(f.game("Another game").count, 0);
  await f.tracker.stop();
});

test("selection retains the active game, otherwise uses deterministic names", () => {
  const presence = rawPresence();
  presence.activities.unshift({ type: 0, name: "Alpha" });
  assert.equal(playingGame(presence, "RedM"), "RedM");
  assert.equal(playingGame(presence), "Alpha");
  assert.equal(playingGame({ ...presence, activities: [...presence.activities].reverse() }), "Alpha");
  assert.equal(playingGame({ ...presence, status: "offline" }), null);
  assert.equal(playingGame({ ...presence, status: "invisible" }), null);
  assert.equal(playingGame({ ...presence, activities: [{ type: 0, name: "  RédM   RP " }] }, "redm rp"), "redm rp");
});

test("an offline update during snapshot cannot be overwritten by a late playing chunk", async () => {
  const f = fixture();
  f.fetchWith(async (request) => {
    await f.event(null, "offline");
    f.emitSnapshot(request, [rawPresence("RedM")]);
  });
  await f.tracker.start();
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.db.writes.length, 0);
  await f.tracker.stop();
});

test("normalized name aliases keep the original history entry and legacy score", async () => {
  const f = fixture({ snapshot: [rawPresence("RédM")] });
  await f.tracker.start();
  f.advance(60_000);
  await f.tracker.tick();
  const history = f.db.documents.get(PROFILE).games_history;
  assert.equal(history.length, 1);
  assert.equal(history[0].name, "RedM");
  assert.equal(history[0].count, 11307);
  assert.equal(history[0].trackedDurationMs, 60_000);
  await f.tracker.stop();
});

test("transaction retries and a lost successful response apply a checkpoint once", async () => {
  const f = fixture();
  await f.tracker.start();
  f.db.retryNext(2);
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 60_000);
  const original = f.db.runTransaction.bind(f.db);
  let fail = true;
  f.db.runTransaction = async (callback) => {
    const result = await original(callback);
    if (fail) { fail = false; throw new Error("response_lost_after_commit"); }
    return result;
  };
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 120_000);
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 180_000);
  await f.tracker.stop();
});

test("an uncommitted failed checkpoint is retried before newer observed slices", async () => {
  const f = fixture();
  await f.tracker.start();
  const original = f.db.runTransaction.bind(f.db);
  let fail = true;
  f.db.runTransaction = (callback) => {
    if (fail) { fail = false; return Promise.reject(new Error("unavailable")); }
    return original(callback);
  };
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 0);
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 120_000);
  await f.tracker.stop();
});

test("two processes cannot credit the same session; takeover never catches up", async () => {
  const a = fixture();
  const b = fixture({ db: a.db, clock: a.clock, id: "b" });
  await Promise.all([a.tracker.start(), b.tracker.start()]);
  a.advance(60_000);
  await Promise.all([a.tracker.tick(), b.tracker.tick()]);
  assert.equal(a.game().trackedDurationMs, 60_000);
  await a.tracker.suspend("connection lost");
  await b.tracker.tick();
  assert.equal(a.game().trackedDurationMs, 60_000);
  a.advance(60_000);
  await b.tracker.tick();
  assert.equal(a.game().trackedDurationMs, 120_000);
  await Promise.all([a.tracker.stop(), b.tracker.stop()]);
});

test("expired lease, late old owner and release all preserve single ownership", async () => {
  const a = fixture();
  const b = fixture({ db: a.db, clock: a.clock, id: "b" });
  await a.tracker.start();
  await b.tracker.start();
  a.advance(181_000);
  await b.tracker.tick();
  await a.tracker.tick();
  assert.equal(a.game().trackedDurationMs, 0);
  a.advance(60_000);
  await Promise.all([a.tracker.tick(), b.tracker.tick()]);
  assert.equal(a.game().trackedDurationMs, 60_000);
  await b.tracker.stop();
  await a.tracker.tick();
  a.advance(60_000);
  await a.tracker.tick();
  assert.equal(a.game().trackedDurationMs, 120_000);
  await a.tracker.stop();
});

test("late cleanup by an expired owner cannot release the replacement owner's lease", async () => {
  const a = fixture();
  const b = fixture({ db: a.db, clock: a.clock, id: "b" });
  await a.tracker.start();
  await b.tracker.start();
  a.advance(181_000);
  await b.tracker.tick();
  const newOwner = a.db.documents.get(LOCK).ownerId;
  await a.tracker.suspend("late disconnect");
  assert.equal(a.db.documents.get(LOCK).ownerId, newOwner);
  assert.ok(a.db.documents.get(LOCK).leaseUntilMs > a.clock.wall);
  a.advance(60_000);
  await b.tracker.tick();
  assert.equal(a.game().trackedDurationMs, 60_000);
  await Promise.all([a.tracker.stop(), b.tracker.stop()]);
});

test("a lost close response can be replayed after release without a duplicate", async () => {
  const f = fixture();
  await f.tracker.start();
  const original = f.db.runTransaction.bind(f.db);
  let fail = true;
  f.db.runTransaction = async (callback) => {
    const result = await original(callback);
    if (fail) { fail = false; throw new Error("close_response_lost"); }
    return result;
  };
  f.advance(30_000);
  await f.event(null, "offline");
  assert.equal(f.game().trackedDurationMs, 30_000);
  assert.equal(f.db.documents.get(LOCK).leaseUntilMs, 0);
  f.advance(181_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 30_000);
  await f.event("RedM");
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 90_000);
  await f.tracker.stop();
});

test("reconnect uses a fresh snapshot and never credits disconnected time", async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(60_000);
  await f.tracker.tick();
  f.advance(20_000);
  await f.tracker.suspendShard(0);
  f.advance(3_600_000);
  await f.event("RedM");
  f.snapshot([rawPresence("Another game")]);
  await f.tracker.resumeShard(0);
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 60_000);
  assert.equal(f.game("Another game").trackedDurationMs, 60_000);
  await f.tracker.stop();
});

test("resume during an unfinished snapshot starts a new snapshot, ignoring the old one", async () => {
  const f = fixture();
  let resolveOld;
  let calls = 0;
  let firstRequest;
  f.fetchWith(async (request) => {
    calls++;
    if (calls === 1) {
      firstRequest = request;
      await new Promise((resolve) => { resolveOld = resolve; });
      f.emitSnapshot(request, [rawPresence("Old game")]);
    } else { f.emitSnapshot(request, [rawPresence("Fresh game")]); }
  });
  const initial = f.tracker.start();
  while (!firstRequest) await Promise.resolve();
  await f.tracker.suspendShard(0);
  await f.tracker.resumeShard(0);
  resolveOld();
  await initial;
  f.advance(60_000);
  await f.tracker.tick();
  assert.equal(calls, 2);
  assert.equal(f.game("Fresh game").trackedDurationMs, 60_000);
  assert.equal(f.game("Old game"), undefined);
  assert.equal(f.timers.size, 1);
  await f.tracker.stop();
});

test("large event-loop gaps are discarded and wall clock changes cannot create duration", async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(60_000);
  await f.tracker.tick();
  f.advance(121_000);
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 60_000);
  f.clock.wall -= 30_000;
  f.clock.mono += 60_000;
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 120_000);
  await f.tracker.stop();
});

test("graceful shutdown flushes the final connected interval and clears the timer", async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(42_000);
  await f.tracker.stop();
  assert.equal(f.game().trackedDurationMs, 42_000);
  assert.equal(f.db.documents.get(LOCK).leaseUntilMs, 0);
  assert.equal(f.timers.size, 0);
  f.advance(60_000);
  await f.event("RedM");
  await f.tracker.tick();
  assert.equal(f.game().trackedDurationMs, 42_000);
});

test("kill switch and ambiguous guild resolution perform no writes", async () => {
  for (const options of [{ enabled: false }, { discord: { guildId: "", generalChannelId: "missing" } }]) {
    const f = fixture(options);
    await f.tracker.start();
    f.advance(60_000);
    await f.event("RedM");
    await f.tracker.tick();
    assert.equal(f.db.writes.length, 0);
    await f.tracker.stop();
  }
  const fallback = fixture({ discord: { guildId: "" } });
  await fallback.tracker.start();
  assert.equal(fallback.game().trackedDurationMs, 0);
  await fallback.tracker.stop();
});

test("fresh snapshot errors fail closed, without using stale presence caches", async () => {
  const f = fixture();
  f.fetchWith(async () => { throw new Error("snapshot_timeout"); });
  await f.tracker.start();
  f.advance(60_000);
  await f.event("RedM");
  await f.tracker.tick();
  assert.equal(f.db.writes.length, 0);
  assert.equal(f.timers.size, 0);
  await f.tracker.stop();
});
