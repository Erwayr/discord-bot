"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createQuestStorage } = require("../script/questStorage");
const { titleForLevel } = require("../script/communityLevel");

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
    return new FakeSnapshot(this.store.get(ref.id) || null);
  }

  set(ref, data, options = {}) {
    if (options.merge) {
      this.store.set(ref.id, { ...(this.store.get(ref.id) || {}), ...data });
      return;
    }
    this.store.set(ref.id, data);
  }

  update(ref, payload) {
    const current = this.store.get(ref.id);
    assert.ok(current, `missing fake doc ${ref.id}`);
    this.store.set(ref.id, { ...current, ...payload });
  }
}

class FakeDb {
  constructor(initialDocs = {}) {
    this.store = new Map(Object.entries(initialDocs));
  }

  collection() {
    return {
      doc: (id) => ({ id }),
    };
  }

  async runTransaction(callback) {
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
