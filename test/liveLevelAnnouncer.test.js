"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  createLiveLevelAnnouncer,
} = require("../script/liveLevelAnnouncer");

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

class FakeSnapshot {
  constructor(data) {
    this._data = data;
    this.exists = !!data;
  }

  data() {
    return clone(this._data);
  }
}

class FakeDb {
  constructor(docs = {}) {
    this.docs = docs;
    this.reads = [];
    this.writes = [];
  }

  collection(name) {
    assert.equal(name, "followers_all_time");
    return {
      doc: (id) => ({
        get: async () => {
          this.reads.push(id);
          return new FakeSnapshot(this.docs[id] || null);
        },
        set: async (...args) => {
          this.writes.push(["set", id, args]);
          throw new Error("unexpected write");
        },
        update: async (...args) => {
          this.writes.push(["update", id, args]);
          throw new Error("unexpected write");
        },
      }),
    };
  }

  runTransaction() {
    this.writes.push(["runTransaction"]);
    throw new Error("unexpected transaction");
  }
}

function baseProfile(overrides = {}) {
  return {
    pseudo: "alice",
    communityLevel: {
      level: 1,
      rank: 1,
      rankName: "minimoys",
      xpTotal: 90,
      xpInLevel: 90,
      xpForNext: 100,
      ...overrides.communityLevel,
    },
    live_presence: {},
    ...overrides,
  };
}

test("announces a live chat level-up without writing Firestore", async () => {
  const db = new FakeDb({ alice: baseProfile() });
  const sent = [];
  const pending = [
    {
      login: "alice",
      streamId: "stream-1",
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
      chatEvents: [{ atMs: Date.parse("2026-05-16T11:00:00.000Z") }],
    },
  ];
  const announcer = createLiveLevelAnnouncer({
    db,
    getCommunityLevelConfig: async () => ({ chatCooldownMs: 0 }),
    getPendingLiveActivity: () => pending,
    sendTwitchChatMessage: async (message) => sent.push(message),
    persistenceDir: "",
  });

  const result = await announcer.checkAndAnnounce({
    login: "Alice",
    displayName: "Alice",
    streamId: "stream-1",
  });

  assert.equal(result.announced, 1);
  assert.deepEqual(sent, ["GG @Alice, tu passes niveau 2 - minimoys !"]);
  assert.deepEqual(db.reads, ["alice", "alice"]);
  assert.deepEqual(db.writes, []);
});

test("announces a deferred presence level-up from pending uptime", async () => {
  const db = new FakeDb({
    alice: baseProfile({
      communityLevel: {
        level: 1,
        rank: 1,
        rankName: "minimoys",
        xpTotal: 0,
        xpInLevel: 0,
        xpForNext: 100,
      },
    }),
  });
  const sent = [];
  const announcer = createLiveLevelAnnouncer({
    db,
    getPendingUptime: () => [
      {
        login: "alice",
        streamId: "stream-1",
        firstSeenAtMs: Date.parse("2026-05-16T10:05:00.000Z"),
        lastSeenAtMs: Date.parse("2026-05-16T10:05:00.000Z"),
        accumulatedMs: 15 * 60 * 1000,
      },
    ],
    sendTwitchChatMessage: async (message) => sent.push(message),
    persistenceDir: "",
  });

  const result = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
  });

  assert.equal(result.announced, 1);
  assert.deepEqual(sent, ["GG @Alice, tu passes niveau 2 - minimoys !"]);
  assert.deepEqual(db.writes, []);
});

test("defers a presence level-up before 15 minutes and announces at 15:00", async () => {
  const db = new FakeDb({
    alice: baseProfile({
      communityLevel: {
        level: 1,
        rank: 1,
        rankName: "minimoys",
        xpTotal: 0,
        xpInLevel: 0,
        xpForNext: 100,
      },
    }),
  });
  const sent = [];
  let accumulatedMs = 14 * 60 * 1000 + 59 * 1000;
  const announcer = createLiveLevelAnnouncer({
    db,
    getPendingUptime: () => [
      {
        login: "alice",
        streamId: "stream-1",
        firstSeenAtMs: Date.parse("2026-05-16T10:00:00.000Z"),
        lastSeenAtMs: Date.parse("2026-05-16T10:14:59.000Z"),
        accumulatedMs,
      },
    ],
    sendTwitchChatMessage: async (message) => sent.push(message),
    persistenceDir: "",
  });

  const deferred = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
  });
  assert.equal(deferred.announced, 0);
  assert.equal(deferred.reason, "announcement_deferred");
  assert.equal(deferred.presenceMs, 14 * 60 * 1000 + 59 * 1000);
  assert.deepEqual(sent, []);

  accumulatedMs = 15 * 60 * 1000;
  const announced = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
  });
  assert.equal(announced.announced, 1);
  assert.deepEqual(sent, ["GG @Alice, tu passes niveau 2 - minimoys !"]);
  assert.deepEqual(db.writes, []);
});

test("a Twitch message releases a deferred level-up before 15 minutes", async () => {
  const db = new FakeDb({ alice: baseProfile() });
  const sent = [];
  const announcer = createLiveLevelAnnouncer({
    db,
    getCommunityLevelConfig: async () => ({ presenceXp: 10 }),
    getPendingUptime: () => [
      {
        login: "alice",
        streamId: "stream-1",
        accumulatedMs: 2 * 60 * 1000,
        firstSeenAtMs: Date.parse("2026-05-16T10:00:00.000Z"),
        lastSeenAtMs: Date.parse("2026-05-16T10:02:00.000Z"),
      },
    ],
    sendTwitchChatMessage: async (message) => sent.push(message),
    persistenceDir: "",
  });

  const deferred = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
  });
  assert.equal(deferred.reason, "announcement_deferred");

  assert.equal(
    announcer.markSpoken({ login: "alice", streamId: "stream-1" }),
    true,
  );
  const announced = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
    source: "chat_command",
  });

  assert.equal(announced.announced, 1);
  assert.deepEqual(sent, ["GG @Alice, tu passes niveau 2 - minimoys !"]);
});

test("speech from another stream does not release the current level-up", async () => {
  const db = new FakeDb({ alice: baseProfile() });
  const sent = [];
  const announcer = createLiveLevelAnnouncer({
    db,
    getCommunityLevelConfig: async () => ({ chatCooldownMs: 0 }),
    getPendingLiveActivity: () => [
      {
        login: "alice",
        streamId: "stream-1",
        chatEvents: [{ atMs: Date.parse("2026-05-16T11:00:00.000Z") }],
      },
    ],
    sendTwitchChatMessage: async (message) => sent.push(message),
    persistenceDir: "",
  });

  announcer.markSpoken({ login: "alice", streamId: "stream-old" });
  const result = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-2",
  });

  assert.equal(result.announced, 0);
  assert.equal(result.reason, "no_level_up");
  assert.deepEqual(sent, []);
});

test("expiring a stream clears its local speech eligibility", async () => {
  const db = new FakeDb({ alice: baseProfile() });
  const sent = [];
  const announcer = createLiveLevelAnnouncer({
    db,
    getCommunityLevelConfig: async () => ({ presenceXp: 10 }),
    getPendingUptime: () => [
      {
        login: "alice",
        streamId: "stream-1",
        accumulatedMs: 2 * 60 * 1000,
        firstSeenAtMs: Date.parse("2026-05-16T10:00:00.000Z"),
        lastSeenAtMs: Date.parse("2026-05-16T10:02:00.000Z"),
      },
    ],
    sendTwitchChatMessage: async (message) => sent.push(message),
    persistenceDir: "",
  });

  announcer.markSpoken({ login: "alice", streamId: "stream-1" });
  assert.equal(announcer.expireStream("stream-1"), true);
  const result = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
  });

  assert.equal(result.announced, 0);
  assert.equal(result.reason, "announcement_deferred");
  assert.deepEqual(sent, []);
});

test("does not announce the same live level twice", async () => {
  const db = new FakeDb({ alice: baseProfile() });
  const sent = [];
  const pending = [
    {
      login: "alice",
      streamId: "stream-1",
      chatEvents: [{ atMs: Date.parse("2026-05-16T11:00:00.000Z") }],
    },
  ];
  const announcer = createLiveLevelAnnouncer({
    db,
    getCommunityLevelConfig: async () => ({ chatCooldownMs: 0 }),
    getPendingLiveActivity: () => pending,
    sendTwitchChatMessage: async (message) => sent.push(message),
    persistenceDir: "",
  });

  await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
  });
  const result = await announcer.checkAndAnnounce({
    login: "alice",
    displayName: "Alice",
    streamId: "stream-1",
  });

  assert.equal(result.announced, 0);
  assert.deepEqual(sent, ["GG @Alice, tu passes niveau 2 - minimoys !"]);
  assert.equal(announcer.highestAnnouncedLevel("alice"), 2);
  assert.deepEqual(db.writes, []);
});

test("restores announced levels from the local runtime journal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-level-"));
  const pending = [
    {
      login: "alice",
      streamId: "stream-1",
      chatEvents: [{ atMs: Date.parse("2026-05-16T11:00:00.000Z") }],
    },
  ];

  try {
    const firstDb = new FakeDb({ alice: baseProfile() });
    const firstSent = [];
    const first = createLiveLevelAnnouncer({
      db: firstDb,
      getCommunityLevelConfig: async () => ({ chatCooldownMs: 0 }),
      getPendingLiveActivity: () => pending,
      sendTwitchChatMessage: async (message) => firstSent.push(message),
      persistenceDir: dir,
      now: () => 1000,
    });
    await first.checkAndAnnounce({
      login: "alice",
      displayName: "Alice",
      streamId: "stream-1",
    });
    assert.equal(firstSent.length, 1);

    const secondDb = new FakeDb({ alice: baseProfile() });
    const secondSent = [];
    const restored = createLiveLevelAnnouncer({
      db: secondDb,
      getCommunityLevelConfig: async () => ({ chatCooldownMs: 0 }),
      getPendingLiveActivity: () => pending,
      sendTwitchChatMessage: async (message) => secondSent.push(message),
      persistenceDir: dir,
      logger: { warn() {} },
    });
    const result = await restored.checkAndAnnounce({
      login: "alice",
      displayName: "Alice",
      streamId: "stream-1",
    });

    assert.equal(result.announced, 0);
    assert.deepEqual(secondSent, []);
    assert.equal(restored.highestAnnouncedLevel("alice"), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
