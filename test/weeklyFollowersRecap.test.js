"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createWeeklyFollowersRecap } = require("../script/weeklyFollowersRecap");

const DAY_MS = 24 * 60 * 60 * 1000;

function getPathValue(source, fieldPath) {
  return String(fieldPath)
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), source);
}

function applyFieldPath(target, fieldPath, value) {
  const parts = String(fieldPath).split(".");
  let node = target;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  }
  node[parts[0]] = value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeSnapshot {
  constructor(ref, data) {
    this.id = ref.id;
    this.ref = ref;
    this._data = data ? clone(data) : null;
    this.exists = !!data;
  }

  data() {
    return this._data ? clone(this._data) : undefined;
  }

  get(fieldPath) {
    return getPathValue(this._data || {}, fieldPath);
  }
}

class FakeDocRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").pop();
  }

  snapshot() {
    return new FakeSnapshot(this, this.db.store.get(this.path) || null);
  }

  async get() {
    this.db.calls.gets.push(this.path);
    return this.snapshot();
  }

  async set(payload, options = {}) {
    this.db.calls.sets.push({ path: this.path, payload, options });
    this.db.setDoc(this.path, payload, options);
  }
}

class FakeCollectionRef {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }

  doc(id) {
    return new FakeDocRef(this.db, `${this.name}/${id}`);
  }

  async get() {
    const prefix = `${this.name}/`;
    const docs = [];
    for (const [path, data] of this.db.store.entries()) {
      if (!path.startsWith(prefix)) continue;
      const id = path.slice(prefix.length);
      if (id.includes("/")) continue;
      docs.push(new FakeSnapshot(this.doc(id), data));
    }
    return {
      empty: docs.length === 0,
      docs,
      forEach: (callback) => docs.forEach(callback),
    };
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
  }

  async get(ref) {
    this.db.calls.txGets.push(ref.path);
    return ref.snapshot();
  }

  update(ref, payload) {
    this.db.calls.txUpdates.push({ path: ref.path, payload });
    const next = clone(this.db.store.get(ref.path) || {});
    for (const [fieldPath, value] of Object.entries(payload)) {
      applyFieldPath(next, fieldPath, value);
    }
    this.db.store.set(ref.path, next);
  }

  set(ref, payload, options = {}) {
    this.db.calls.txSets.push({ path: ref.path, payload, options });
    this.db.setDoc(ref.path, payload, options);
  }
}

class FakeDb {
  constructor(initialDocs = {}) {
    this.store = new Map(
      Object.entries(initialDocs).map(([path, data]) => [path, clone(data)]),
    );
    this.calls = {
      gets: [],
      sets: [],
      txGets: [],
      txSets: [],
      txUpdates: [],
      runTransactions: 0,
    };
  }

  collection(name) {
    return new FakeCollectionRef(this, name);
  }

  doc(path) {
    return new FakeDocRef(this, path);
  }

  async runTransaction(callback) {
    this.calls.runTransactions += 1;
    return callback(new FakeTransaction(this));
  }

  setDoc(path, payload, options = {}) {
    const current = options.merge ? clone(this.store.get(path) || {}) : {};
    this.store.set(path, { ...current, ...clone(payload) });
  }
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function followerWithWeeklyActivity() {
  const monthKey = currentMonthKey();
  return {
    login: "alice",
    pseudo: "Alice",
    discord_id: "123456789012345678",
    live_presence: {
      [monthKey]: {
        progress_pct: 20,
        streams: [
          {
            started_at: new Date(Date.now() - 7 * DAY_MS).toISOString(),
            presence: { seen: true },
            chat_message: { count: 2 },
          },
        ],
      },
    },
  };
}

function createFakeClient() {
  const sent = [];
  return {
    sent,
    channels: {
      async fetch(id) {
        return {
          isTextBased: () => true,
          send: async (payload) => {
            sent.push({ id, payload });
          },
        };
      },
    },
  };
}

test("manual preview sends recap without reward writes", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": followerWithWeeklyActivity(),
    "participants/alice": { pseudo: "Alice" },
  });
  const client = createFakeClient();
  const sendWeeklyFollowersRecap = createWeeklyFollowersRecap({
    db,
    client,
    defaultChannelId: "announcements",
    timeZone: "UTC",
    questBonusPct: 10,
  });

  const result = await sendWeeklyFollowersRecap({
    channelId: "logs",
    applyRewards: false,
  });

  assert.equal(result.bonus.reason, "MANUAL_PREVIEW");
  assert.equal(result.participantsSync.reason, "REWARDS_DISABLED");
  assert.equal(db.calls.runTransactions, 0);
  assert.equal(db.calls.txUpdates.length, 0);
  assert.equal(db.calls.sets.length, 0);
  assert.match(client.sent[0].payload.content, /Apercu manuel/);
});

test("default recap applies winner reward and participant sync", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": followerWithWeeklyActivity(),
    "participants/alice": { pseudo: "Alice" },
  });
  const client = createFakeClient();
  const sendWeeklyFollowersRecap = createWeeklyFollowersRecap({
    db,
    client,
    defaultChannelId: "announcements",
    timeZone: "UTC",
    questBonusPct: 10,
  });

  const result = await sendWeeklyFollowersRecap({ channelId: "announcements" });

  assert.equal(result.bonus.reason, "APPLIED");
  assert.equal(result.participantsSync.synced, true);
  assert.equal(db.calls.runTransactions, 1);
  assert.equal(db.calls.txUpdates.length, 1);
  assert.equal(
    db.calls.sets.some((call) => call.path === "participants/alice"),
    true,
  );
});
