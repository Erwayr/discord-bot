"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const cron = require("node-cron");
const { createJobs } = require("../app/jobs");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");

test("startup and hourly rewards require fresh consecutive offline ticks and a successful full flush", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-01T07:00:00Z"));
  const scheduled = new Map();
  t.mock.method(cron, "schedule", (expression, callback) => { scheduled.set(expression, callback); return {}; });
  const db = createMemoryFirestore({ "followers_all_time/alice": { pseudo: "Alice", twitch_id: "1",
    live_presence: { "2026-09": { streams: [{ day_key: "2026-09-30", presence: { seen: true } }] } } } });
  let stream = null, networkError = false, flushFailed = true, uptimeFailed = false;
  const livePresenceTick = async () => { if (networkError) throw new Error("twitch_unavailable"); };
  livePresenceTick.getLiveStreamState = () => ({ streamId: stream, startedAt: null });
  livePresenceTick.getPendingUptime = () => [];
  livePresenceTick.clearPendingUptime = () => {};
  livePresenceTick.flushStreamUptime = async () => ({ failed: uptimeFailed ? 1 : 0 });
  const config = { monthlyPodiumRewards: { enabled: true }, timezone: "Europe/Brussels",
    communityLevel: { enabled: false }, timing: { offlineConfirmTicks: 2 },
    cron: { pollClips: "clips", tokenKeepalive: "tokens", livePresence: "live", birthdayRefresh: "birthday", emoteRefresh: "emote" } };
  const jobs = createJobs({ db, config, livePresenceTick, pollClipsTick() {},
    birthdays: { async refreshTodayBirthdays() {} },
    twitchChat: { async flushLiveActivity() { return { failed: flushFailed ? 1 : 0, flushedEntries: [] }; },
      getPendingLiveActivityStreams: () => flushFailed ? ["pending"] : [], refreshChannelEmotesThrottled() {} } });
  jobs.scheduleCoreJobs();
  const tick = scheduled.get("live"), hourly = scheduled.get("0 * * * *");
  await tick();
  networkError = true; await tick(); networkError = false;
  await tick(); assert.equal(db.writes.length, 0);
  await tick(); assert.equal(db.writes.length, 0); // Confirmed offline, but activity failed to save.
  flushFailed = false; uptimeFailed = true;
  hourly(); await tick(); assert.equal(db.writes.length, 0); // Presence saving failed.
  uptimeFailed = false;
  await tick(); assert.equal(db.writes.length, 0); // Wait for the next retry request.
  hourly(); stream = "new-live"; await tick(); assert.equal(db.writes.length, 0);
  stream = null; await tick(); assert.equal(db.writes.length, 0);
  await tick();
  assert.equal(db.documents.get("monthly_podium_rewards/2026-09").status, "completed");
  assert.equal(db.documents.get("followers_all_time/alice").pops.balance, 1000);
  hourly(); await tick();
  assert.equal(db.documents.get("followers_all_time/alice").pops.balance, 1000);
});
