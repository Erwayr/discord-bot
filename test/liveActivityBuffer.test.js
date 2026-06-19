"use strict";

const assert = require("node:assert/strict");
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
