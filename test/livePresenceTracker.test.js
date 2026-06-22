"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  _test: { createUptimeAccumulator },
} = require("../script/livePresenceTracker");

test("uptime accumulator credits seen ticks, caps long gaps and skips absences", () => {
  const acc = createUptimeAccumulator({
    tickMs: 120_000,
    maxTickMs: 300_000,
  });
  acc.reset("stream-1", new Date("2026-05-16T10:00:00.000Z"));

  const first = acc.markSeen(["Alice", "wzbot"], 1_000);
  assert.deepEqual(first.presentLogins, ["alice"]);
  assert.deepEqual(first.presenceLogins, ["alice"]);
  assert.equal(first.creditedMs, 120_000);

  acc.markPresenceNoted("alice");
  const delayed = acc.markSeen(["alice"], 601_000);
  assert.deepEqual(delayed.presenceLogins, []);
  assert.equal(delayed.creditedMs, 300_000);

  const absent = acc.markSeen([], 721_000);
  assert.deepEqual(absent.presentLogins, []);
  assert.equal(absent.creditedMs, 0);

  const returned = acc.markSeen(["alice"], 1_321_000);
  assert.equal(returned.creditedMs, 120_000);

  const snapshot = acc.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].login, "alice");
  assert.equal(snapshot[0].streamId, "stream-1");
  assert.equal(snapshot[0].accumulatedMs, 540_000);
});

test("uptime accumulator can clear flushed logins", () => {
  const acc = createUptimeAccumulator({
    tickMs: 120_000,
    maxTickMs: 300_000,
  });
  acc.reset("stream-1", new Date("2026-05-16T10:00:00.000Z"));

  acc.markSeen(["alice", "bob"], 1_000);
  const removed = acc.removeLogins([{ login: "alice" }]);
  const snapshot = acc.snapshot();

  assert.deepEqual(removed, ["alice"]);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].login, "bob");
});
