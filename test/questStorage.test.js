"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createQuestStorage } = require("../script/questStorage");
const { titleForLevel } = require("../script/communityLevel");

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(target, source) {
  const next = clone(target || {});
  for (const [key, value] of Object.entries(source || {})) {
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = deepMerge(next[key], value);
    } else {
      next[key] = clone(value);
    }
  }
  return next;
}

function refKey(ref) {
  return ref.path || ref.id;
}

class FakeSnapshot {
  constructor(data) {
    this._data = data;
    this.exists = !!data;
  }

  data() {
    return this._data;
  }
}

class FakeTransaction {
  constructor(store) {
    this.store = store;
  }

  async get(ref) {
    return new FakeSnapshot(this.store.get(refKey(ref)) || null);
  }

  set(ref, data, options = {}) {
    const key = refKey(ref);
    if (options.merge) {
      this.store.set(key, deepMerge(this.store.get(key) || {}, data));
      return;
    }
    this.store.set(key, clone(data));
  }

  update(ref, payload) {
    const key = refKey(ref);
    const current = this.store.get(key);
    assert.ok(current, `missing fake doc ${key}`);
    this.store.set(key, { ...current, ...clone(payload) });
  }
}

class FakeDb {
  constructor(initialDocs = {}) {
    this.store = new Map(Object.entries(initialDocs));
    this.transactions = 0;
  }

  collection(name) {
    return {
      doc: (id) => ({
        id,
        path: name === "followers_all_time" ? id : `${name}/${id}`,
      }),
    };
  }

  async runTransaction(callback) {
    this.transactions += 1;
    return callback(new FakeTransaction(this.store));
  }

  doc(id) {
    return this.store.get(id);
  }
}

function monthNodeFor(db, docId) {
  const livePresence = db.doc(docId)?.live_presence || {};
  const monthKeys = Object.keys(livePresence);
  assert.equal(monthKeys.length, 1);
  return livePresence[monthKeys[0]];
}

async function withDateNow(nowMs, callback) {
  const realDateNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await callback();
  } finally {
    Date.now = realDateNow;
  }
}

test("default community rank titles map level 110 through 149 to Maitre du cosmos", () => {
  assert.equal(titleForLevel(109), "Maitre Pixel");
  assert.equal(titleForLevel(110), "Maitre du cosmos");
  assert.equal(titleForLevel(149), "Maitre du cosmos");
  assert.equal(titleForLevel(150), "Ultra instinct");
});

test("same stream_id repeated keeps a single stream and count", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db);
  const startedAt = new Date("2026-05-16T10:00:00.000Z");

  await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), async () => {
    await store.notePresence("alice", "stream-1", { startedAt });
    await store.notePresence("alice", "stream-1", { startedAt });
  });

  const month = monthNodeFor(db, "alice");
  assert.equal(month.streams.length, 1);
  assert.equal(month.count, 1);
  assert.equal(month.streams[0].stream_id, "stream-1");
});

test("new stream_id under 3h from last activity is merged as restart", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db);

  await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), async () => {
    await store.notePresence("alice", "stream-1", {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    });
  });

  await withDateNow(Date.parse("2026-05-16T12:10:00.000Z"), async () => {
    await store.notePresence("alice", "stream-2", {
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
    });
  });

  const month = monthNodeFor(db, "alice");
  assert.equal(month.streams.length, 1);
  assert.equal(month.count, 1);
  assert.deepEqual(month.streams[0].stream_ids.sort(), [
    "stream-1",
    "stream-2",
  ]);
});

test("new stream_id after 3h or more creates a second stream", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db);

  await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), async () => {
    await store.notePresence("alice", "stream-1", {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    });
  });

  await withDateNow(Date.parse("2026-05-16T14:10:00.000Z"), async () => {
    await store.notePresence("alice", "stream-2", {
      startedAt: new Date("2026-05-16T14:00:00.000Z"),
    });
  });

  const month = monthNodeFor(db, "alice");
  assert.equal(month.streams.length, 2);
  assert.equal(month.count, 2);
  assert.equal(month.streams[0].stream_id, "stream-1");
  assert.equal(month.streams[1].stream_id, "stream-2");
  assert.equal(month.streams[0].day_key, month.streams[1].day_key);
});

test("default chat level awards 10 xp per eligible message", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db);

  const result = await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.noteChatMessage("alice", "stream-1", 1, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(result.levelAwarded, true);
  assert.equal(result.levelXp, 10);
  assert.equal(doc.communityLevel.xpTotal, 10);
  assert.equal(doc.communityLevel.chatXpTotal, 10);
  assert.equal(stream.community_level.chat_xp, 10);
  assert.equal(stream.community_level.xp, 10);
});

test("default chat level caps at 1200 xp per live", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatCooldownMs: 0,
    },
  });

  const result = await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.noteChatMessage("alice", "stream-1", 130, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(result.levelAwarded, true);
  assert.equal(result.levelXp, 1200);
  assert.equal(doc.communityLevel.xpTotal, 1200);
  assert.equal(doc.communityLevel.chatXpTotal, 1200);
  assert.equal(doc.communityLevel.chatMessages, 120);
  assert.equal(stream.community_level.chat_xp, 1200);
  assert.equal(stream.community_level.xp, 1200);
});

test("chat level xp continues after quest chat count cap", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatCooldownMs: 0,
    },
  });
  const startedAt = new Date("2026-05-16T10:00:00.000Z");
  let last;

  for (let i = 0; i < 11; i += 1) {
    last = await withDateNow(
      Date.parse("2026-05-16T11:00:00.000Z") + i * 1000,
      () => store.noteChatMessage("alice", "stream-1", 1, { startedAt }),
    );
  }

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(last.count, 10);
  assert.equal(last.capped, true);
  assert.equal(doc.communityLevel.xpTotal, 110);
  assert.equal(doc.communityLevel.chatXpTotal, 110);
  assert.equal(doc.communityLevel.chatMessages, 11);
  assert.equal(stream.chat_message.count, 10);
  assert.equal(stream.community_level.messages, 11);
  assert.equal(stream.community_level.chat_xp, 110);
});

test("presence level awards 200 xp once per live", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db);
  const startedAt = new Date("2026-05-16T10:00:00.000Z");

  const first = await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.notePresence("alice", "stream-1", { startedAt }),
  );
  const second = await withDateNow(Date.parse("2026-05-16T11:10:00.000Z"), () =>
    store.notePresence("alice", "stream-1", { startedAt }),
  );

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(first.levelAwarded, true);
  assert.equal(first.levelXp, 200);
  assert.equal(second.levelAwarded, false);
  assert.equal(doc.communityLevel.xpTotal, 200);
  assert.equal(doc.communityLevel.presenceXpTotal, 200);
  assert.equal(doc.communityLevel.presenceStreams, 1);
  assert.equal(stream.community_level.presence_xp, 200);
  assert.equal(stream.community_level.xp, 200);
});

test("presence level awards again on a new live", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db);

  await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.notePresence("alice", "stream-1", {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );
  const secondLive = await withDateNow(
    Date.parse("2026-05-16T16:00:00.000Z"),
    () =>
      store.notePresence("alice", "stream-2", {
        startedAt: new Date("2026-05-16T15:00:00.000Z"),
      }),
  );

  const doc = db.doc("alice");
  const month = monthNodeFor(db, "alice");
  assert.equal(secondLive.levelAwarded, true);
  assert.equal(secondLive.levelXp, 200);
  assert.equal(doc.communityLevel.xpTotal, 400);
  assert.equal(doc.communityLevel.presenceXpTotal, 400);
  assert.equal(doc.communityLevel.presenceStreams, 2);
  assert.equal(month.streams.length, 2);
});

test("finalize live uptime adds minutes once and mirrors participant", async () => {
  const db = new FakeDb({
    alice: {
      pseudo: "alice",
      communityLevel: {
        rank: 7,
        level: 42,
        xpTotal: 1234,
        xpInLevel: 34,
        xpForNext: 200,
        rankName: "Maitre du cosmos",
        uptimeMinutes: 120,
        uptimeText: "2h",
        chatXpTotal: 99,
      },
      live_presence: {
        "2026-05": {
          streams: [
            {
              stream_id: "stream-1",
              day_key: "2026-05-16",
              presence: {
                seen: true,
                first_at: Date.parse("2026-05-16T10:00:00.000Z"),
                last_at: Date.parse("2026-05-16T11:00:00.000Z"),
              },
            },
          ],
        },
      },
    },
    "participants/alice": {
      pseudo: "alice",
      communityLevel: {
        level: 42,
        uptimeMinutes: 120,
        uptimeText: "2h",
      },
    },
  });
  const store = createQuestStorage(db);

  const first = await withDateNow(Date.parse("2026-05-16T13:00:00.000Z"), () =>
    store.finalizeLiveUptime("Alice", "stream-1", {
      uptimeMs: 30 * 60 * 1000,
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
      endedAt: new Date("2026-05-16T13:00:00.000Z"),
    }),
  );
  const second = await withDateNow(Date.parse("2026-05-16T13:05:00.000Z"), () =>
    store.finalizeLiveUptime("alice", "stream-1", {
      uptimeMs: 30 * 60 * 1000,
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
      endedAt: new Date("2026-05-16T13:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  const stream = doc.live_presence["2026-05"].streams[0];
  const participant = db.doc("participants/alice");

  assert.equal(first.applied, true);
  assert.equal(first.uptimeMinutesAdded, 30);
  assert.equal(first.uptimeMinutes, 150);
  assert.equal(first.uptimeText, "2h 30m");
  assert.equal(first.participantMirrored, true);
  assert.equal(second.applied, false);
  assert.equal(second.reason, "already_finalized");

  assert.equal(doc.communityLevel.uptimeMinutes, 150);
  assert.equal(doc.communityLevel.uptimeText, "2h 30m");
  assert.equal(doc.communityLevel.rank, 7);
  assert.equal(doc.communityLevel.level, 42);
  assert.equal(doc.communityLevel.xpTotal, 1234);
  assert.equal(doc.communityLevel.xpInLevel, 34);
  assert.equal(doc.communityLevel.xpForNext, 200);
  assert.equal(doc.communityLevel.chatXpTotal, 99);

  assert.equal(stream.presence.uptime_minutes, 30);
  assert.deepEqual(stream.presence.uptime_finalized_stream_ids, ["stream-1"]);
  assert.equal(participant.communityLevel.level, 42);
  assert.equal(participant.communityLevel.uptimeMinutes, 150);
  assert.equal(participant.communityLevel.uptimeText, "2h 30m");
});

test("channel points level awards 5 xp per redemption and caps at 50 per live", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db);
  const startedAt = new Date("2026-05-16T10:00:00.000Z");
  let last;

  for (let i = 0; i < 11; i += 1) {
    last = await withDateNow(
      Date.parse("2026-05-16T11:00:00.000Z") + i * 1000,
      () => store.noteChannelPoints("alice", "stream-1", 1, { startedAt }),
    );
  }

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(last.levelAwarded, false);
  assert.equal(last.reason, "stream_cap");
  assert.equal(doc.communityLevel.xpTotal, 50);
  assert.equal(doc.communityLevel.channelPointsXpTotal, 50);
  assert.equal(doc.communityLevel.channelPointsRedemptions, 10);
  assert.equal(stream.channel_points.redemptions, 11);
  assert.equal(stream.community_level.channel_points_xp, 50);
  assert.equal(stream.community_level.xp, 50);
});

test("chat presence and channel points xp add up on the same live", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatCooldownMs: 0,
    },
  });
  const startedAt = new Date("2026-05-16T10:00:00.000Z");

  await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.notePresence("alice", "stream-1", { startedAt }),
  );
  await withDateNow(Date.parse("2026-05-16T11:01:00.000Z"), () =>
    store.noteChatMessage("alice", "stream-1", 1, { startedAt }),
  );
  await withDateNow(Date.parse("2026-05-16T11:02:00.000Z"), () =>
    store.noteChannelPoints("alice", "stream-1", 1, { startedAt }),
  );

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(doc.communityLevel.xpTotal, 215);
  assert.equal(doc.communityLevel.presenceXpTotal, 200);
  assert.equal(doc.communityLevel.chatXpTotal, 10);
  assert.equal(doc.communityLevel.channelPointsXpTotal, 5);
  assert.equal(stream.community_level.presence_xp, 200);
  assert.equal(stream.community_level.chat_xp, 10);
  assert.equal(stream.community_level.channel_points_xp, 5);
  assert.equal(stream.community_level.xp, 215);
});

test("chat message during live awards community level xp from legacy floor", async () => {
  const db = new FakeDb({
    alice: {
      pseudo: "alice",
      wizebotLevel: 42,
      wizebotExp: 1000,
      wizebotRankName: "Ancien legacy",
      live_presence: {},
    },
  });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatXp: 5,
      chatCooldownMs: 0,
      chatXpCapPerStream: 10,
      baseXp: 10,
      growthXp: 0,
    },
  });

  const result = await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.noteChatMessage("alice", "stream-1", 1, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  assert.equal(result.levelAwarded, true);
  assert.equal(result.levelXp, 5);
  assert.equal(doc.communityLevel.level, 42);
  assert.equal(doc.communityLevel.xpTotal, 1005);
  assert.equal(doc.communityLevel.xpInLevel, 5);
  assert.equal(doc.communityLevel.rankName, "Destructeur d' ASMR");
  assert.equal(doc.wizebotLevel, 42);
  assert.equal(doc.wizebotExp, 1000);
  assert.equal(doc.wizebotRankName, "Ancien legacy");
});

test("chat level legacy double-write is opt-in", async () => {
  const db = new FakeDb({
    alice: {
      pseudo: "alice",
      communityLevel: {
        level: 42,
        xpTotal: 1000,
      },
      live_presence: {},
    },
  });
  const store = createQuestStorage(db, {
    communityLevel: {
      legacyDoubleWrite: true,
      chatXp: 5,
      chatCooldownMs: 0,
      chatXpCapPerStream: 10,
      baseXp: 10,
      growthXp: 0,
    },
  });

  await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.noteChatMessage("alice", "stream-1", 1, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  assert.equal(doc.wizebotLevel, 42);
  assert.equal(doc.wizebotExp, 1005);
  assert.equal(doc.wizebotRankName, "Destructeur d' ASMR");
});

test("chat level stores rank name from configured rank title catalog", async () => {
  const db = new FakeDb({
    alice: {
      pseudo: "alice",
      communityLevel: {
        level: 110,
        xpTotal: 100,
        rankName: "Ancien nom stocke",
      },
      wizebotRankName: "Nom legacy",
      live_presence: {},
    },
  });
  const store = createQuestStorage(db, {
    communityLevel: {
      legacyDoubleWrite: true,
      chatXp: 1,
      chatCooldownMs: 0,
      chatXpCapPerStream: 10,
      rankTitles: [
        { min: 0, label: "Debutant" },
        { min: 110, label: "Maitre du cosmos custom" },
        { min: 150, label: "Ultra custom" },
      ],
    },
  });

  await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.noteChatMessage("alice", "stream-1", 1, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  assert.equal(doc.communityLevel.rankName, "Maitre du cosmos custom");
  assert.equal(doc.wizebotRankName, "Maitre du cosmos custom");
});

test("chat level cooldown does not block quest chat count", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatXp: 1,
      chatCooldownMs: 60_000,
      chatXpCapPerStream: 10,
      baseXp: 10,
      growthXp: 0,
    },
  });
  const now = Date.parse("2026-05-16T11:00:00.000Z");

  await withDateNow(now, () =>
    store.noteChatMessage("alice", "stream-1", 1, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );
  const second = await withDateNow(now + 10_000, () =>
    store.noteChatMessage("alice", "stream-1", 1, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  const month = monthNodeFor(db, "alice");
  assert.equal(second.levelAwarded, false);
  assert.equal(doc.communityLevel.xpTotal, 1);
  assert.equal(month.streams[0].chat_message.count, 2);
  assert.equal(month.streams[0].community_level.xp, 1);
});

test("chat level progresses to next level when xp threshold is reached", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatXp: 2,
      chatCooldownMs: 0,
      chatXpCapPerStream: 10,
      baseXp: 2,
      growthXp: 0,
    },
  });

  const result = await withDateNow(Date.parse("2026-05-16T11:00:00.000Z"), () =>
    store.noteChatMessage("alice", "stream-1", 1, {
      startedAt: new Date("2026-05-16T10:00:00.000Z"),
    }),
  );

  const doc = db.doc("alice");
  assert.equal(result.leveledUp, true);
  assert.equal(doc.communityLevel.level, 2);
  assert.equal(doc.communityLevel.xpInLevel, 0);
  assert.equal(doc.communityLevel.xpForNext, 2);
});

test("batched live chat applies 100 messages in one transaction", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatCooldownMs: 0,
    },
  });
  const startedAt = new Date("2026-05-16T10:00:00.000Z");
  const baseMs = Date.parse("2026-05-16T11:00:00.000Z");

  const result = await store.noteLiveActivity("alice", "stream-1", {
    startedAt,
    chatEvents: Array.from({ length: 100 }, (_, index) => ({
      atMs: baseMs + index * 1000,
    })),
  });

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(db.transactions, 1);
  assert.equal(result.applied, true);
  assert.equal(result.chatEvents, 100);
  assert.equal(result.chatCount, 10);
  assert.equal(result.chatCapped, true);
  assert.equal(doc.communityLevel.chatMessages, 100);
  assert.equal(doc.communityLevel.chatXpTotal, 1000);
  assert.equal(stream.chat_message.count, 10);
  assert.equal(stream.community_level.messages, 100);
  assert.equal(stream.community_level.chat_xp, 1000);
});

test("batched live chat replays timestamps for cooldown", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatXp: 10,
      chatCooldownMs: 60_000,
    },
  });
  const startedAt = new Date("2026-05-16T10:00:00.000Z");
  const baseMs = Date.parse("2026-05-16T11:00:00.000Z");

  const result = await store.noteLiveActivity("alice", "stream-1", {
    startedAt,
    chatEvents: [
      { atMs: baseMs },
      { atMs: baseMs + 10_000 },
      { atMs: baseMs + 61_000 },
    ],
  });

  const doc = db.doc("alice");
  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(db.transactions, 1);
  assert.equal(result.chatCount, 3);
  assert.equal(doc.communityLevel.chatMessages, 2);
  assert.equal(doc.communityLevel.chatXpTotal, 20);
  assert.equal(stream.chat_message.count, 3);
  assert.equal(stream.community_level.messages, 2);
  assert.equal(stream.community_level.chat_xp, 20);
});

test("batched live activity groups emotes with chat in one transaction", async () => {
  const db = new FakeDb({ alice: { pseudo: "alice", live_presence: {} } });
  const store = createQuestStorage(db, {
    communityLevel: {
      chatCooldownMs: 0,
    },
  });

  const result = await store.noteLiveActivity("alice", "stream-1", {
    startedAt: new Date("2026-05-16T10:00:00.000Z"),
    chatEvents: [{ atMs: Date.parse("2026-05-16T11:00:00.000Z") }],
    emoteCount: 7,
  });

  const stream = monthNodeFor(db, "alice").streams[0];
  assert.equal(db.transactions, 1);
  assert.equal(result.emoteCount, 7);
  assert.equal(stream.chat_message.count, 1);
  assert.equal(stream.emote.count, 7);
  assert.equal(stream.emote.used, true);
});
