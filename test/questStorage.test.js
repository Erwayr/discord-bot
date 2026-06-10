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
