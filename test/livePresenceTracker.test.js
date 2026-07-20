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

  const first = acc.markSeen(
    ["Alice", "wzbot", "StreamElements", "streamstickers"],
    1_000,
  );
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

test("uptime accumulator keeps Twitch ids from Helix chatters", () => {
  const acc = createUptimeAccumulator({
    tickMs: 60_000,
    maxTickMs: 300_000,
  });
  acc.reset("stream-1", new Date("2026-05-16T10:00:00.000Z"));

  acc.markSeen(
    [
      {
        user_id: "12345",
        user_login: "Alice",
        user_name: "Alice Display",
      },
    ],
    1_000,
  );
  acc.markSeen(
    [
      {
        user_id: "12345",
        user_login: "alice",
        user_name: "Alice Display",
      },
    ],
    61_000,
  );

  const snapshot = acc.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].login, "alice");
  assert.equal(snapshot[0].twitchUserId, "12345");
  assert.equal(snapshot[0].displayName, "Alice Display");
  assert.equal(snapshot[0].accumulatedMs, 120_000);
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

test("uptime accumulator signals the 15-minute level threshold once", () => {
  const acc = createUptimeAccumulator({
    tickMs: 60_000,
    maxTickMs: 300_000,
    levelAnnouncementMinPresenceMs: 15 * 60 * 1000,
  });
  acc.reset("stream-1", new Date("2026-05-16T10:00:00.000Z"));

  let tick = null;
  for (let minute = 1; minute <= 14; minute += 1) {
    tick = acc.markSeen(["alice"], 1_000 + (minute - 1) * 60_000);
    assert.deepEqual(tick.levelAnnouncementLogins, []);
  }

  const absent = acc.markSeen([], 1_000 + 14 * 60_000);
  assert.deepEqual(absent.levelAnnouncementLogins, []);
  assert.equal(acc.snapshot()[0].accumulatedMs, 14 * 60 * 1000);

  const threshold = acc.markSeen(["alice"], 1_000 + 15 * 60_000);
  assert.equal(acc.snapshot()[0].accumulatedMs, 15 * 60 * 1000);
  assert.deepEqual(threshold.levelAnnouncementLogins, ["alice"]);

  acc.markLevelAnnouncementNoted("alice");
  const later = acc.markSeen(["alice"], 1_000 + 16 * 60_000);
  assert.deepEqual(later.levelAnnouncementLogins, []);
});
