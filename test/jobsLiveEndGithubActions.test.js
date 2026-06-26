"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const cron = require("node-cron");
const { createJobs } = require("../app/jobs");

function createLivePresenceTick(states, calls, pendingUptime = []) {
  let current = { streamId: null, startedAt: null };
  let pendingUptimeEntries = pendingUptime.slice();

  async function livePresenceTick() {
    current = states.shift() || { streamId: null, startedAt: null };
  }

  livePresenceTick.getLiveStreamState = () => current;
  livePresenceTick.getPendingUptime = () => pendingUptimeEntries.slice();
  livePresenceTick.clearPendingUptime = (entries = []) => {
    const cleared = new Set(entries.map((entry) => entry.login));
    if (!cleared.size) return;
    pendingUptimeEntries = pendingUptimeEntries.filter(
      (entry) => !cleared.has(entry.login),
    );
    calls.push(`clear-uptime:${Array.from(cleared).join(",")}`);
  };
  livePresenceTick.flushStreamUptime = async (streamId, options = {}) => {
    calls.push(`uptime:${streamId}:${options.reason}`);
  };

  return livePresenceTick;
}

function createEmptyRankRefreshDb(rankReads) {
  return {
    collection(name) {
      assert.equal(name, "followers_all_time");
      return {
        get: async () => {
          rankReads.push("followers_all_time");
          return { forEach() {} };
        },
      };
    },
    batch() {
      return {
        set() {},
        commit: async () => {},
      };
    },
  };
}

function createTestJobs({
  states,
  calls,
  pendingUptime = [],
  flushPayloads = [],
  db = {},
  communityLevel = {
    enabled: false,
    rankCron: "0",
    rankRefreshOnLiveStart: false,
    rankRefreshOnLiveEnd: false,
  },
  getCommunityLevelConfig = async () => ({}),
}) {
  const livePresenceTick = createLivePresenceTick(states, calls, pendingUptime);

  return createJobs({
    db,
    admin: {},
    client: { guilds: { cache: new Map() } },
    config: {
      timezone: "Europe/Warsaw",
      batchSize: 10,
      cron: {
        pollClips: "poll-clips",
        tokenKeepalive: "token-keepalive",
        livePresence: "live-presence",
        birthdayRefresh: "birthday-refresh",
        emoteRefresh: "emote-refresh",
      },
      communityLevel,
      timing: {
        offlineConfirmTicks: 2,
      },
      discord: {
        generalChannelId: "general",
      },
    },
    livePresenceTick,
    pollClipsTick: async () => {},
    sendWeeklyFollowersRecap: async () => {},
    weeklyPlanningPublisher: null,
    authHealth: {
      ensureValidUserAccessToken: async () => {},
      notifyAuthIssueToLog: async () => {},
    },
    birthdays: {
      refreshTodayBirthdays: async () => {},
      sendDiscordBirthdayAnnouncements: async () => ({}),
    },
    twitchChat: {
      flushLiveActivity: async (payload) => {
        flushPayloads.push(payload);
        calls.push(`flush:${payload.reason}`);
        return {
          flushedEntries: (payload.uptimeEntries || []).map((entry) => ({
            login: entry.login,
            streamId: entry.streamId,
          })),
        };
      },
      refreshChannelEmotesThrottled: async () => {},
      getPendingLiveActivityStreams: () => [],
    },
    getCommunityLevelConfig,
    cardNotifications: null,
    githubActions: {
      dispatchLiveEndWorkflows: async ({ streamId }) => {
        calls.push(`dispatch:${streamId}`);
        return { ok: true };
      },
    },
  });
}

test("live-end dispatch waits for confirmed offline state and existing flushes", async (t) => {
  const originalSchedule = cron.schedule;
  const scheduled = [];
  cron.schedule = (expr, fn, options) => {
    scheduled.push({ expr, fn, options });
    return {
      start: () => {},
      stop: () => {},
    };
  };
  t.after(() => {
    cron.schedule = originalSchedule;
  });

  const calls = [];
  const jobs = createTestJobs({
    calls,
    states: [
      {
        streamId: "stream-1",
        startedAt: new Date("2026-06-19T20:00:00.000Z"),
      },
      { streamId: null, startedAt: null },
      { streamId: null, startedAt: null },
      { streamId: null, startedAt: null },
    ],
  });

  jobs.scheduleCoreJobs();
  const liveJob = scheduled.find((entry) => entry.expr === "live-presence");
  assert.ok(liveJob, "live presence cron job should be scheduled");

  await liveJob.fn();
  assert.deepEqual(calls, []);

  await liveJob.fn();
  assert.deepEqual(calls, []);

  await liveJob.fn();
  assert.deepEqual(calls, [
    "flush:live-end",
    "uptime:stream-1:live-end",
    "dispatch:stream-1",
  ]);

  await liveJob.fn();
  assert.deepEqual(calls, [
    "flush:live-end",
    "uptime:stream-1:live-end",
    "dispatch:stream-1",
  ]);
});

test("live-end flush passes pending uptime entries before uptime fallback", async (t) => {
  const originalSchedule = cron.schedule;
  const scheduled = [];
  cron.schedule = (expr, fn, options) => {
    scheduled.push({ expr, fn, options });
    return {
      start: () => {},
      stop: () => {},
    };
  };
  t.after(() => {
    cron.schedule = originalSchedule;
  });

  const calls = [];
  const flushPayloads = [];
  const jobs = createTestJobs({
    calls,
    flushPayloads,
    pendingUptime: [
      {
        login: "alice",
        streamId: "stream-1",
        accumulatedMs: 30 * 60 * 1000,
      },
    ],
    states: [
      {
        streamId: "stream-1",
        startedAt: new Date("2026-06-19T20:00:00.000Z"),
      },
      { streamId: null, startedAt: null },
      { streamId: null, startedAt: null },
    ],
  });

  jobs.scheduleCoreJobs();
  const liveJob = scheduled.find((entry) => entry.expr === "live-presence");
  await liveJob.fn();
  await liveJob.fn();
  await liveJob.fn();

  assert.equal(flushPayloads.length, 1);
  assert.equal(flushPayloads[0].reason, "live-end");
  assert.equal(flushPayloads[0].streamId, "stream-1");
  assert.equal(flushPayloads[0].uptimeEntries.length, 1);
  assert.equal(flushPayloads[0].uptimeEntries[0].login, "alice");
  assert.deepEqual(calls, [
    "flush:live-end",
    "clear-uptime:alice",
    "uptime:stream-1:live-end",
    "dispatch:stream-1",
  ]);
});

test("community rank refresh runs at live start and end only", async (t) => {
  const originalSchedule = cron.schedule;
  const scheduled = [];
  cron.schedule = (expr, fn, options) => {
    scheduled.push({ expr, fn, options });
    return {
      start: () => {},
      stop: () => {},
    };
  };
  t.after(() => {
    cron.schedule = originalSchedule;
  });

  const calls = [];
  const rankReads = [];
  const jobs = createTestJobs({
    calls,
    db: createEmptyRankRefreshDb(rankReads),
    communityLevel: {
      enabled: true,
      rankCron: "*/1 * * * *",
      rankRefreshOnLiveStart: true,
      rankRefreshOnLiveEnd: true,
    },
    states: [
      {
        streamId: "stream-1",
        startedAt: new Date("2026-06-19T20:00:00.000Z"),
      },
      {
        streamId: "stream-1",
        startedAt: new Date("2026-06-19T20:00:00.000Z"),
      },
      { streamId: null, startedAt: null },
      { streamId: null, startedAt: null },
    ],
  });

  jobs.scheduleCoreJobs();
  const liveJob = scheduled.find((entry) => entry.expr === "live-presence");
  assert.ok(liveJob, "live presence cron job should be scheduled");

  await liveJob.fn();
  assert.equal(rankReads.length, 1);
  assert.equal(
    scheduled.filter((entry) => entry.expr === "*/1 * * * *").length,
    0,
  );

  await liveJob.fn();
  assert.equal(rankReads.length, 1);

  await liveJob.fn();
  assert.equal(rankReads.length, 1);

  await liveJob.fn();
  assert.equal(rankReads.length, 2);
});
