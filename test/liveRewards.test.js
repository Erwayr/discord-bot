"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createQuestStorage } = require("../script/questStorage");
const { applyLiveUptimeProgress, applyChatMessageLevelProgress } = require("../script/communityLevel");
const { applyPendingLiveDeltas } = require("../script/twitchChatCommands");
const { streamMetrics, scoreFromMetrics } = require("../script/podium-activity.shared.cjs");
const { activateLiveRewards } = require("../script/liveRewardsActivation");
const { rewardVersionForStart } = require("../script/live-rewards.shared.cjs");

const START = Date.parse("2026-10-06T12:00:00Z");
const CONFIG = { liveRewardsActivatedAt: START - 1 };
const copy = value => structuredClone(value);
function merge(a, b) {
  const result = copy(a || {});
  for (const [key, value] of Object.entries(b)) result[key] = value && typeof value === "object" &&
    !Array.isArray(value) ? merge(result[key], value) : copy(value);
  return result;
}
class Db {
  constructor(docs = {}) { this.docs = copy(docs); }
  collection(name) { return { doc: id => ({ path: `${name}/${id}` }) }; }
  async runTransaction(run) {
    const pending = [];
    const result = await run({
      get: async ref => ({ exists: !!this.docs[ref.path], data: () => copy(this.docs[ref.path]) }),
      set: (ref, data, options) => pending.push(() => {
        this.docs[ref.path] = options?.merge ? merge(this.docs[ref.path], data) : copy(data);
      }),
      update: (ref, data) => pending.push(() => { this.docs[ref.path] = { ...this.docs[ref.path], ...copy(data) }; }),
    });
    pending.forEach(write => write()); return result;
  }
}
const profile = db => db.docs["followers_all_time/alice"];
const streams = db => Object.values(profile(db).live_presence).flatMap(month => month.streams);
function fixture(options = {}) {
  const db = new Db({ "followers_all_time/alice": { pseudo: "alice" }, "participants/alice": { pseudo: "alice" } });
  return { db, store: createQuestStorage(db, { communityLevel: CONFIG, ...options }) };
}
function activity(minutes, extra = {}) {
  return { startedAt: new Date(START).toISOString(), uptimeMs: minutes * 60_000,
    presenceFirstSeenAtMs: START, presenceLastSeenAtMs: START + minutes * 60_000,
    flushId: "segment-1", ...extra };
}

test("watchtime thresholds, fractions and cap: 1 minute, 10 minutes, 3 and 6 hours", () => {
  const entry = { reward_version: 2 };
  let data = {};
  for (const [milliseconds, xp, minutes] of [[59_999, 0, 0], [60_000, 8, 1],
    [599_999, 72, 9], [600_000, 130, 10], [180 * 60_000, 1490, 180],
    [360 * 60_000, 2930, 360], [420 * 60_000, 2930, 420]]) {
    const result = applyLiveUptimeProgress({ data, entry, streamId: "live", uptimeMs: milliseconds, nowMs: START + milliseconds });
    data = { communityLevel: result.communityLevel };
    assert.equal(data.communityLevel.xpTotal || 0, xp);
    assert.equal(data.communityLevel.uptimeMinutes || 0, minutes);
  }
  assert.equal(entry.community_level.presence_awards, 1);
  assert.equal(entry.community_level.watchtime_minutes, 360);
  assert.equal(data.communityLevel.watchtimeXpTotal, 2880);
});

test("podium five-minute threshold, cap and legacy exclusion", () => {
  for (const [minutes, expected] of [[4, 0], [5, 1], [180, 36], [360, 72], [500, 72]]) {
    const entry = { reward_version: 2, presence: { uptime_minutes: minutes } };
    assert.equal(scoreFromMetrics(streamMetrics(entry)), expected);
    delete entry.reward_version;
    assert.equal(scoreFromMetrics(streamMetrics(entry)), 0);
  }
});

test("chat XP and podium cooldown are separate from quest counts and cap independently", async () => {
  const { db, store } = fixture();
  const chatEvents = Array.from({ length: 80 }, (_, minute) => [
    { atMs: START + minute * 60_000, count: 1 }, { atMs: START + minute * 60_000 + 1, count: 1 },
  ]).flat();
  await store.noteLiveActivity("alice", "live", activity(180, { chatEvents, channelPointsCount: 40 }));
  assert.equal(profile(db).communityLevel.xpTotal, 1840);
  assert.equal(profile(db).communityLevel.chatXpTotal, 300);
  assert.equal(profile(db).communityLevel.channelPointsXpTotal, 50);
  assert.equal(streams(db)[0].chat_message.count, 10);
  assert.equal(streams(db)[0].podium_activity.chat_messages, 10);
  assert.equal(scoreFromMetrics(streamMetrics(streams(db)[0])), 116);
  assert.deepEqual(db.docs["participants/alice"].communityLevel, profile(db).communityLevel);
});

test("transaction replay and cumulative updates never credit the same minute twice", async () => {
  const { db, store } = fixture();
  await store.noteLiveActivity("alice", "live", activity(10, { chatEvents: [{ atMs: START, count: 1 }] }));
  const first = copy(profile(db));
  await store.noteLiveActivity("alice", "live", activity(10, { chatEvents: [{ atMs: START, count: 1 }] }));
  assert.deepEqual(profile(db), first);
  await store.noteLiveActivity("alice", "live", activity(180, { chatEvents: [{ atMs: START, count: 1 }] }));
  assert.equal(profile(db).communityLevel.xpTotal, 1495);
  await store.finalizeLiveUptime("alice", "live", activity(180));
  assert.equal(profile(db).communityLevel.xpTotal, 1495);
});

test("transaction retries return level-ups and rewards only from the successful attempt", async () => {
  const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");
  const db = createMemoryFirestore({ "followers_all_time/alice": { pseudo: "alice" },
    "participants/alice": { pseudo: "alice" } });
  const store = createQuestStorage(db, { communityLevel: CONFIG });
  db.retryNext(2);
  const result = await store.noteLiveActivity("alice", "live", activity(180));
  assert.equal(db.documents.get("followers_all_time/alice").communityLevel.xpTotal, 1490);
  assert.equal(result.levelUps.length, 1);
  assert.equal(result.levelXp, 1490);
});

test("restarts share bonus, fractional minutes and reward caps", async () => {
  const { db, store } = fixture();
  await store.noteLiveActivity("alice", "one", activity(180.5));
  const secondStart = START + 181 * 60_000;
  await store.noteLiveActivity("alice", "two", activity(180.5, {
    startedAt: new Date(secondStart).toISOString(), presenceFirstSeenAtMs: secondStart,
    presenceLastSeenAtMs: secondStart + 180.5 * 60_000, flushId: "segment-2",
  }));
  assert.equal(streams(db).length, 1);
  assert.equal(profile(db).communityLevel.xpTotal, 2930);
  assert.equal(profile(db).communityLevel.uptimeMinutes, 361);
  assert.equal(scoreFromMetrics(streamMetrics(streams(db)[0])), 82);
});

test("preview and saved rewards agree even with two copies of the same duration snapshot", async () => {
  const { db, store } = fixture();
  const pending = { login: "alice", streamId: "live", ...activity(180),
    chatEvents: [{ atMs: START, count: 1 }], channelPointsCount: 2 };
  const preview = applyPendingLiveDeltas(profile(db), [pending, { ...pending, chatEvents: [], channelPointsCount: 0 }], CONFIG);
  await store.noteLiveActivity("alice", "live", pending);
  assert.equal(preview.communityLevel.xpTotal, profile(db).communityLevel.xpTotal);
  assert.equal(preview.communityLevel.level, profile(db).communityLevel.level);
});

test("new profiles qualify on observed duration, never the gap between endpoints", async () => {
  const db = new Db();
  const store = createQuestStorage(db, { communityLevel: CONFIG, minNewProfilePresenceMs: 600_000 });
  const denied = await store.noteLiveActivity("alice", "live", activity(1, { presenceLastSeenAtMs: START + 3 * 3600_000 }));
  assert.equal(denied.reason, "new_profile_presence_below_threshold");
  assert.equal(profile(db), undefined);
  await store.noteLiveActivity("alice", "live", activity(10));
  assert.equal(profile(db).communityLevel.xpTotal, 130);
});

test("activation preserves legacy overrides, resets the new rates once and keeps old streams legacy", async () => {
  const db = new Db({ "site_config/community_level": { chatXp: 20, rankTitles: [{ min: 0, label: "A" }] } });
  assert.equal(await activateLiveRewards(db, {}, START), true);
  const config = db.docs["site_config/community_level"];
  assert.equal(config.chatXp, 5);
  assert.equal(config.legacyLiveRewards.chatXp, 20);
  assert.equal(await activateLiveRewards(db, {}, START + 1), false);
  assert.equal(rewardVersionForStart(new Date(START - 1), config), 1);
  assert.equal(rewardVersionForStart(new Date(START + 1), config), 2);
  const legacy = applyChatMessageLevelProgress({ entry: {}, rawConfig: config, nowMs: START });
  assert.equal(legacy.awardXp, 20);
  assert.equal(applyChatMessageLevelProgress({ entry: { reward_version: 2 }, rawConfig: config, nowMs: START }).awardXp, 5);
});

test("durable checkpoints recover without outage credit and replay after commit is harmless", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const os = require("node:os");
  const { createLiveActivityBuffer } = require("../script/liveActivityBuffer");
  const { _test: { createUptimeAccumulator } } = require("../script/livePresenceTracker");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live-rewards-test-"));
  try {
    const { db, store } = fixture();
    const options = { questStore: store, persistenceDir: directory, logger: { log() {}, warn() {} } };
    const buffer = createLiveActivityBuffer(options);
    const acc = createUptimeAccumulator();
    acc.reset("live", new Date(START));
    for (let minute = 0; minute <= 20; minute += 2) {
      acc.markSeen([{ user_login: "alice", user_id: "100" }], START + minute * 60_000);
      buffer.noteUptimeObservation({ ...acc.snapshot()[0], startedAt: new Date(START) });
    }
    buffer.noteChatMessage("alice", "live", { observedAtMs: START, twitchUserId: "100" });
    const recovered = createLiveActivityBuffer(options);
    const resumed = createUptimeAccumulator();
    resumed.reset("live", new Date(START));
    resumed.restore(recovered.pendingSnapshot());
    resumed.markSeen([{ user_login: "alice", user_id: "100" }], START + 60 * 60_000);
    assert.equal(resumed.snapshot()[0].accumulatedMs, 20 * 60_000);
    resumed.markSeen([{ user_login: "alice", user_id: "100" }], START + 62 * 60_000);
    recovered.noteUptimeObservation({ ...resumed.snapshot()[0], startedAt: new Date(START) });
    const journal = fs.readFileSync(path.join(directory, "pending.jsonl"));
    await recovered.flush({ reason: "live-end", uptimeEntries: resumed.snapshot() });
    assert.equal(profile(db).communityLevel.xpTotal, 231);
    assert.equal(profile(db).communityLevel.uptimeMinutes, 22);
    fs.writeFileSync(path.join(directory, "pending.jsonl"), journal);
    await createLiveActivityBuffer(options).flush({ reason: "startup-offline" });
    assert.equal(profile(db).communityLevel.xpTotal, 231);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("failed Twitch calls and temporary offline observations break continuity without resetting totals", async () => {
  const { createLivePresenceTicker } = require("../script/livePresenceTracker");
  let time = START, failed = false, offline = false;
  const ticker = createLivePresenceTicker({ db: {}, tokenManager: {}, clientId: "client",
    broadcasterId: "owner", moderatorId: "mod", questStore: {}, deferPresenceWrites: true,
    now: () => time, helixClient: async ({ url }) => {
      if (failed) throw new Error("test_outage");
      return { data: { data: url.endsWith("/streams")
        ? offline ? [] : [{ id: "live", started_at: new Date(START).toISOString() }]
        : [{ user_login: "alice", user_id: "100" }] } };
    } });
  await ticker(); time += 120_000; await ticker();
  assert.equal(ticker.getPendingUptime()[0].accumulatedMs, 120_000);
  time += 120_000; failed = true; await assert.rejects(ticker(), /test_outage/);
  time += 120_000; failed = false; await ticker();
  assert.equal(ticker.getPendingUptime()[0].accumulatedMs, 120_000);
  time += 120_000; await ticker();
  time += 120_000; offline = true; await ticker();
  time += 120_000; offline = false; await ticker();
  assert.equal(ticker.getPendingUptime()[0].accumulatedMs, 240_000);
});

test("renamed viewers keep observed duration and canonical writes", async () => {
  const { _test: { createUptimeAccumulator } } = require("../script/livePresenceTracker");
  const acc = createUptimeAccumulator(); acc.reset("live");
  acc.markSeen([{ user_login: "old", user_id: "100" }], START);
  acc.markSeen([{ user_login: "old", user_id: "100" }], START + 120_000);
  acc.markSeen([{ user_login: "new", user_id: "100" }], START + 240_000);
  assert.equal(acc.snapshot().length, 1);
  assert.equal(acc.snapshot()[0].accumulatedMs, 120_000);
  const { db, store } = fixture({ resolveTwitchIdentity: async () => ({ login: "alice" }) });
  await store.noteLiveActivity("old", "live", activity(180, { twitchUserId: "100" }));
  await store.noteLiveActivity("new", "live", activity(180, { twitchUserId: "100" }));
  assert.equal(profile(db).communityLevel.xpTotal, 1490);
  assert.equal(db.docs["followers_all_time/new"], undefined);
});
