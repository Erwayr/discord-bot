"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createCardNotificationQueue } = require("../app/cardNotificationQueue");

class FakeSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = structuredClone(data);
    this.exists = !!data;
  }

  data() {
    return this._data;
  }
}

class FakeDocRef {
  constructor(id, data) {
    this.id = id;
    this.path = `followers_all_time/${id}`;
    this._data = data;
    this.updates = [];
  }

  async get() {
    return new FakeSnapshot(this.id, this._data);
  }

  async update(patch) {
    this.updates.push(patch);
    this._data = { ...this._data, ...patch };
  }
}

function firestoreFor(ref, beforeFirstCommit = () => {}) {
  return {
    async runTransaction(callback) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const version = JSON.stringify(ref._data);
        const updates = [];
        await callback({
          get: (target) => target.get(),
          update: (target, patch) => updates.push(() => target.update(patch)),
        });
        if (attempt === 0) beforeFirstCommit();
        if (JSON.stringify(ref._data) !== version) continue;
        for (const update of updates) await update();
        return;
      }
      throw new Error("Transaction conflict");
    },
  };
}

test("card notification queue targets one follower doc", async () => {
  const sent = [];
  const ref = new FakeDocRef("alice", {
    pseudo: "Alice",
    discord_id: "123",
    cards_generated: [
      { id: "card-a", title: "Carte A" },
      { id: "card-b", title: "Carte B", notifiedAt: "already" },
    ],
  });
  const queue = createCardNotificationQueue({
    db: firestoreFor(ref),
    config: { urls: { collection: "https://example.test" } },
    sendDMOrFallback: async (discordId, message) => {
      sent.push({ discordId, message });
    },
    now: () => new Date("2026-05-16T12:00:00.000Z"),
    logger: { log() {}, warn() {} },
  });

  const result = await queue.enqueueFollowerDoc(ref);

  assert.equal(result.processed, true);
  assert.equal(result.notified, 1);
  assert.deepEqual(sent.map((row) => row.discordId), ["123"]);
  assert.match(sent[0].message, /Carte A/);
  assert.equal(ref.updates.length, 1);
  assert.equal(ref._data.cards_generated[0].notifiedAt, "2026-05-16T12:00:00.000Z");
  assert.equal(ref._data.cards_generated[0].isAlreadyView, false);
  assert.equal(ref._data.cards_generated[1].notifiedAt, "already");
});

test("grants and viewed flags changed during a DM survive notification", async () => {
  const ref = new FakeDocRef("alice", {
    discord_id: "123",
    cards_generated: [{ id: "a", title: "A", isAlreadyView: false }],
  });
  const queue = createCardNotificationQueue({
    db: firestoreFor(ref),
    sendDMOrFallback: async () => {
      ref._data.cards_generated[0].isAlreadyView = true;
      ref._data.cards_generated.push({ id: "b", title: "B" });
    },
    logger: { log() {}, warn() {} },
  });
  await queue.enqueueFollowerDoc(ref);
  assert.deepEqual(ref._data.cards_generated.map((card) => card.id), ["a", "b"]);
  assert.equal(ref._data.cards_generated[0].isAlreadyView, true);
  assert.ok(ref._data.cards_generated[0].notifiedAt);
  assert.equal(ref._data.cards_generated[1].notifiedAt, undefined);
});

test("a retried acknowledgement keeps concurrent grants and sends Discord only once", async () => {
  const ref = new FakeDocRef("alice", {
    discord_id: "123", cards_generated: [{ id: "a" }],
  });
  let sends = 0;
  const queue = createCardNotificationQueue({
    db: firestoreFor(ref, () => {
      ref._data.cards_generated.push({ id: "b" });
      ref._data.cards_generated[0].notifiedAt = "other-acknowledgement";
    }),
    sendDMOrFallback: async () => { sends++; },
    logger: { log() {}, warn() {} },
  });
  await queue.enqueueFollowerDoc(ref);
  assert.equal(sends, 1);
  assert.deepEqual(ref._data.cards_generated, [
    { id: "a", notifiedAt: "other-acknowledgement" }, { id: "b" },
  ]);
});

test("a removed card or follower is never recreated by a notification", async () => {
  for (const removeFollower of [false, true]) {
    const ref = new FakeDocRef("alice", {
      discord_id: "123", cards_generated: [{ id: "a" }],
    });
    const queue = createCardNotificationQueue({
      db: firestoreFor(ref),
      sendDMOrFallback: async () => {
        if (removeFollower) ref._data = undefined;
        else ref._data.cards_generated = [];
      },
      logger: { log() {}, warn() {} },
    });
    await queue.enqueueFollowerDoc(ref);
    assert.equal(ref.updates.length, 0);
    assert.deepEqual(ref._data?.cards_generated, removeFollower ? undefined : []);
  }
});
