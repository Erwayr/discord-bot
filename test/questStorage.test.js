"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createQuestStorage } = require("../script/questStorage");

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

