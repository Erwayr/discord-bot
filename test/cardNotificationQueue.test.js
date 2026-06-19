"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createCardNotificationQueue } = require("../app/cardNotificationQueue");

class FakeSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = data;
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
