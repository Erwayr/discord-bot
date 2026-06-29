"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  DEFAULT_FLUSH_MS,
  createLiveActivityBuffer,
} = require("../script/liveActivityBuffer");

function createFakeScheduler() {
  const intervals = [];
  return {
    intervals,
    setIntervalFn(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      timer.cleared = true;
    },
  };
}

test("chat messages are buffered until flush", async () => {
  const calls = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async (...args) => {
        calls.push(args);
        return { applied: true };
      },
    },
    now: () => 1000,
  });

  buffer.noteChatMessage("Alice", "stream-1", {
    startedAt: new Date("2026-05-16T10:00:00.000Z"),
    displayName: "Alice",
  });

  assert.equal(calls.length, 0);
  assert.equal(buffer.pendingSize(), 1);

  const result = await buffer.flush({ reason: "manual" });
  assert.equal(result.flushed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "alice");
  assert.equal(calls[0][1], "stream-1");
  assert.equal(calls[0][2].chatEvents.length, 1);
});

test("100 messages from one user flush as one store call", async () => {
  const calls = [];
  let currentTime = 10_000;
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async (...args) => {
        calls.push(args);
        return { applied: true };
      },
    },
    now: () => currentTime,
  });

  for (let i = 0; i < 100; i += 1) {
    currentTime += 1000;
    buffer.noteChatMessage("Alice", "stream-1", { displayName: "Alice" });
  }

  await buffer.flush({ reason: "manual" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].chatEvents.length, 100);
});

test("emotes are accumulated with chat events", async () => {
  const calls = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async (...args) => {
        calls.push(args);
        return { applied: true };
      },
    },
    now: () => 1000,
  });

  buffer.noteChatMessage("alice", "stream-1");
  buffer.noteEmoteUsage("alice", "stream-1", 2);
  buffer.noteEmoteUsage("alice", "stream-1", 3);

  await buffer.flush({ reason: "manual" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].chatEvents.length, 1);
  assert.equal(calls[0][2].emoteCount, 5);
});

test("channel points are buffered with live activity", async () => {
  const calls = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async (...args) => {
        calls.push(args);
        return { applied: true };
      },
    },
    now: () => 1000,
  });

  buffer.noteChatMessage("alice", "stream-1");
  buffer.noteChannelPoints("alice", "stream-1", 2);
  buffer.noteChannelPoints("alice", "stream-1", 3);

  await buffer.flush({ reason: "manual" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].chatEvents.length, 1);
  assert.equal(calls[0][2].channelPointsCount, 5);
});

test("timer flush uses the 20 minute default", async () => {
  const scheduler = createFakeScheduler();
  const calls = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async (...args) => {
        calls.push(args);
        return { applied: true };
      },
    },
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
    flushMode: "interval",
    now: () => 1000,
  });

  buffer.noteChatMessage("alice", "stream-1");
  buffer.start();

  assert.equal(scheduler.intervals.length, 1);
  assert.equal(scheduler.intervals[0].ms, DEFAULT_FLUSH_MS);

  scheduler.intervals[0].fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  buffer.stop();
  assert.equal(scheduler.intervals[0].cleared, true);
});

test("live-end mode disables the timer by default", () => {
  const scheduler = createFakeScheduler();
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async () => ({ applied: true }),
    },
    setIntervalFn: scheduler.setIntervalFn,
    clearIntervalFn: scheduler.clearIntervalFn,
  });

  buffer.noteChatMessage("alice", "stream-1");
  buffer.start();

  assert.equal(scheduler.intervals.length, 0);
  assert.equal(buffer.pendingSize(), 1);
});

test("pending chat is restored from the local journal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-activity-"));
  const calls = [];

  try {
    const first = createLiveActivityBuffer({
      questStore: {
        noteLiveActivity: async (...args) => {
          calls.push(args);
          return { applied: true };
        },
      },
      persistenceDir: dir,
      now: () => 1234,
    });
    first.noteChatMessage("Alice", "stream-1", {
      displayName: "Alice",
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    });

    const restored = createLiveActivityBuffer({
      questStore: {
        noteLiveActivity: async (...args) => {
          calls.push(args);
          return { applied: true };
        },
      },
      persistenceDir: dir,
      now: () => 2000,
      logger: { log() {}, warn() {} },
    });

    assert.equal(restored.pendingSize(), 1);
    const result = await restored.flush({ reason: "manual" });
    assert.equal(result.flushed, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "alice");
    assert.equal(calls[0][2].chatEvents.length, 1);
    assert.match(calls[0][2].flushId, /^live-activity:stream-1:alice:/);
    assert.equal(fs.existsSync(path.join(dir, "pending.jsonl")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pending channel points are restored from the local journal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-activity-"));
  const calls = [];

  try {
    const first = createLiveActivityBuffer({
      questStore: {
        noteLiveActivity: async (...args) => {
          calls.push(args);
          return { applied: true };
        },
      },
      persistenceDir: dir,
      now: () => 1234,
    });
    first.noteChannelPoints("Alice", "stream-1", 2, {
      displayName: "Alice",
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    });

    const restored = createLiveActivityBuffer({
      questStore: {
        noteLiveActivity: async (...args) => {
          calls.push(args);
          return { applied: true };
        },
      },
      persistenceDir: dir,
      now: () => 2000,
      logger: { log() {}, warn() {} },
    });

    assert.equal(restored.pendingSize(), 1);
    await restored.flush({ reason: "manual" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "alice");
    assert.equal(calls[0][2].channelPointsCount, 2);
    assert.equal(fs.existsSync(path.join(dir, "pending.jsonl")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("merged uptime keeps the journaled chat segment flush id", async () => {
  const calls = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async (...args) => {
        calls.push(args);
        return { applied: true };
      },
    },
    now: () => 1000,
  });

  buffer.noteChatMessage("alice", "stream-1");
  const segmentId = buffer.pendingSnapshot()[0].segmentId;
  await buffer.flush({
    reason: "live-end",
    uptimeEntries: [
      {
        login: "alice",
        streamId: "stream-1",
        firstSeenAtMs: 1000,
        lastSeenAtMs: 61_000,
        accumulatedMs: 60_000,
      },
    ],
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][2].flushId,
    `live-activity:stream-1:alice:${segmentId}`,
  );
  assert.equal(calls[0][2].chatEvents.length, 1);
  assert.equal(calls[0][2].uptimeMs, 60_000);
});

test("level-up notifications are emitted after flush", async () => {
  const levelUps = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async () => ({
        applied: true,
        levelUps: [{ level: 42, rankName: "Maitre du cosmos" }],
      }),
    },
    onLevelUp: async (payload) => levelUps.push(payload),
    now: () => 1000,
  });

  buffer.noteChatMessage("alice", "stream-1", { displayName: "Alice" });
  assert.equal(levelUps.length, 0);

  await buffer.flush({ reason: "manual" });
  assert.deepEqual(levelUps, [
    {
      login: "alice",
      displayName: "Alice",
      level: 42,
      rankName: "Maitre du cosmos",
    },
  ]);
});

test("post-flush hook receives Twitch user id and live stats", async () => {
  const hooks = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async () => ({ applied: true }),
    },
    onFlushSuccess: async (...args) => hooks.push(args),
    now: () => 1000,
  });

  buffer.noteChatMessage("Alice", "stream-1", {
    displayName: "Alice",
    twitchUserId: "12345",
  });
  buffer.noteEmoteUsage("Alice", "stream-1", 2);
  buffer.noteChannelPoints("Alice", "stream-1", 1);

  await buffer.flush({
    reason: "manual",
    uptimeEntries: [
      {
        login: "Alice",
        streamId: "stream-1",
        twitchUserId: "12345",
        accumulatedMs: 120_000,
      },
    ],
  });

  assert.equal(hooks.length, 1);
  assert.equal(hooks[0][0].login, "alice");
  assert.equal(hooks[0][0].displayName, "Alice");
  assert.equal(hooks[0][0].twitchUserId, "12345");
  assert.equal(hooks[0][0].chatEvents.length, 1);
  assert.equal(hooks[0][0].emoteCount, 2);
  assert.equal(hooks[0][0].channelPointsCount, 1);
  assert.equal(hooks[0][0].uptimeMs, 120_000);
  assert.equal(hooks[0][2], "manual");
});

test("post-flush hook failures do not requeue successful live activity", async () => {
  const warnings = [];
  const buffer = createLiveActivityBuffer({
    questStore: {
      noteLiveActivity: async () => ({ applied: true }),
    },
    onFlushSuccess: async () => {
      throw new Error("extension EBS down");
    },
    logger: { log() {}, warn: (...args) => warnings.push(args) },
    now: () => 1000,
  });

  buffer.noteChatMessage("Alice", "stream-1", { twitchUserId: "12345" });
  const result = await buffer.flush({ reason: "manual" });

  assert.equal(result.flushed, 1);
  assert.equal(result.failed, 0);
  assert.equal(buffer.pendingSize(), 0);
  assert.match(String(warnings[0]?.[0] || ""), /post-flush hook failed/);
});
