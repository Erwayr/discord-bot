"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const cron = require("node-cron");
const { createJobs } = require("../app/jobs");

function createLivePresenceTick(states, calls) {
  let current = { streamId: null, startedAt: null };

  async function livePresenceTick() {
    current = states.shift() || { streamId: null, startedAt: null };
  }

  livePresenceTick.getLiveStreamState = () => current;
  livePresenceTick.flushStreamUptime = async (streamId, options = {}) => {
    calls.push(`uptime:${streamId}:${options.reason}`);
  };

  return livePresenceTick;
}

function createTestJobs({ states, calls }) {
  const livePresenceTick = createLivePresenceTick(states, calls);

  return createJobs({
    db: {},
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
      communityLevel: {
        enabled: false,
        rankCron: "0",
        rankRefreshOnLiveEnd: false,
      },
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
      flushLiveActivity: async ({ reason }) => calls.push(`flush:${reason}`),
      refreshChannelEmotesThrottled: async () => {},
    },
    getCommunityLevelConfig: async () => ({}),
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
