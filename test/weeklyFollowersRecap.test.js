"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createWeeklyFollowersRecap } = require("../script/weeklyFollowersRecap");

const DAY_MS = 24 * 60 * 60 * 1000;

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

  collection(name) {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
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
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }

  async get() {
    const prefix = `${this.path}/`;
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
    this.resetCalls();
  }

  resetCalls() {
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
    const current = options.merge ? this.store.get(path) || {} : {};
    this.store.set(path, deepMerge(current, payload));
  }

  data(path) {
    return clone(this.store.get(path));
  }
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function streamOn(date, chatCount) {
  return {
    started_at: date.toISOString(),
    presence: { seen: true },
    chat_message: { count: chatCount },
  };
}

function followerDoc({ login, pseudo, discordId, currentChat = 0, previousChat = 0 }) {
  const now = new Date();
  const currentDate = now;
  const previousDate = addDays(now, -7);
  const livePresence = {};

  function addStream(date, chatCount) {
    if (chatCount <= 0) return;
    const key = monthKey(date);
    livePresence[key] ||= { progress_pct: 20, streams: [] };
    livePresence[key].streams.push(streamOn(date, chatCount));
  }

  addStream(currentDate, currentChat);
  addStream(previousDate, previousChat);

  return {
    login,
    pseudo,
    discord_id: discordId,
    pops: { balance: 0, lifetimeEarned: 0, schemaVersion: 1 },
    live_presence: livePresence,
  };
}

function buildDb({ includeThreePrevious = true } = {}) {
  const docs = {
    "followers_all_time/current_one": followerDoc({
      login: "current_one",
      pseudo: "CurrentOne",
      discordId: "111111111111111111",
      currentChat: 10,
    }),
    "followers_all_time/current_two": followerDoc({
      login: "current_two",
      pseudo: "CurrentTwo",
      discordId: "222222222222222222",
      currentChat: 8,
    }),
    "followers_all_time/current_three": followerDoc({
      login: "current_three",
      pseudo: "CurrentThree",
      discordId: "333333333333333333",
      currentChat: 6,
    }),
    "followers_all_time/previous_one": followerDoc({
      login: "previous_one",
      pseudo: "PreviousOne",
      discordId: "444444444444444444",
      previousChat: 10,
    }),
    "participants/previous_one": { pseudo: "PreviousOne" },
  };

  if (includeThreePrevious) {
    Object.assign(docs, {
      "followers_all_time/previous_two": followerDoc({
        login: "previous_two",
        pseudo: "PreviousTwo",
        discordId: "555555555555555555",
        previousChat: 8,
      }),
      "followers_all_time/previous_three": followerDoc({
        login: "previous_three",
        pseudo: "PreviousThree",
        discordId: "666666666666666666",
        previousChat: 6,
      }),
      "participants/previous_two": { pseudo: "PreviousTwo" },
      "participants/previous_three": { pseudo: "PreviousThree" },
    });
  }

  return new FakeDb(docs);
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

function createRecap(db, client) {
  return createWeeklyFollowersRecap({
    db,
    client,
    defaultChannelId: "announcements",
    timeZone: "UTC",
    limit: 10,
    rankRewards: [
      { rank: 1, bonusPct: 10, popsReward: 100 },
      { rank: 2, bonusPct: 5, popsReward: 50 },
      { rank: 3, bonusPct: 2, popsReward: 25 },
    ],
    headerText: "✨ Meilleurs Loulou de la semaine passee ✨",
  });
}

test("manual preview uses current week and shows top 3 ruby rewards without writes", async () => {
  const db = buildDb();
  const client = createFakeClient();
  const sendWeeklyFollowersRecap = createRecap(db, client);

  const result = await sendWeeklyFollowersRecap({
    channelId: "logs",
    applyRewards: false,
    rangeMode: "current",
  });

  assert.equal(result.range.mode, "current");
  assert.deepEqual(
    result.rewardResult.rewards.map((reward) => reward.popsReward),
    [100, 50, 25],
  );
  assert.equal(result.rewardResult.rewards[0].winnerLogin, "current_one");
  assert.equal(db.calls.runTransactions, 0);
  assert.equal(db.calls.txUpdates.length, 0);
  assert.equal(db.calls.txSets.length, 0);
  assert.equal(db.calls.sets.length, 0);

  const content = client.sent[0].payload.content;
  assert.match(content, /semaine en cours/);
  assert.match(content, /Voici les Gagnants/);
  assert.match(content, /Apercu manuel - gains non appliques/);
  assert.match(content, /\+100 ♦️/);
  assert.match(content, /\+50 ♦️/);
  assert.match(content, /\+25 ♦️/);
  assert.doesNotMatch(content, /Gagnant de la semaine/);
  assert.doesNotMatch(content, /POPS/);
  assert.doesNotMatch(content, /444444444444444444/);
});

test("default recap uses previous week and applies top 3 progress and POPS", async () => {
  const db = buildDb();
  const client = createFakeClient();
  const sendWeeklyFollowersRecap = createRecap(db, client);

  const result = await sendWeeklyFollowersRecap({ channelId: "announcements" });

  assert.equal(result.range.mode, "previous");
  assert.equal(result.rewardResult.reason, "APPLIED");
  assert.deepEqual(
    result.rewardResult.rewards.map((reward) => reward.winnerLogin),
    ["previous_one", "previous_two", "previous_three"],
  );
  assert.deepEqual(
    result.rewardResult.rewards.map((reward) => reward.popsReward),
    [100, 50, 25],
  );
  assert.equal(db.calls.runTransactions, 1);
  assert.equal(db.calls.txUpdates.length, 3);
  assert.equal(
    db.calls.txSets.filter((call) => call.path.includes("/pops_transactions/"))
      .length,
    3,
  );
  assert.equal(db.calls.sets.length, 3);

  assert.equal(db.data("followers_all_time/previous_one").pops.balance, 100);
  assert.equal(db.data("followers_all_time/previous_two").pops.balance, 50);
  assert.equal(db.data("followers_all_time/previous_three").pops.balance, 25);
  assert.equal(db.data("participants/previous_one").progress_pct, 30);
  assert.equal(db.data("participants/previous_two").progress_pct, 25);
  assert.equal(db.data("participants/previous_three").progress_pct, 22);
  assert.equal(db.data("participants/previous_one").pops, undefined);
});

test("second default recap run does not double-credit rewards", async () => {
  const db = buildDb();
  const client = createFakeClient();
  const sendWeeklyFollowersRecap = createRecap(db, client);

  await sendWeeklyFollowersRecap({ channelId: "announcements" });
  db.resetCalls();

  const result = await sendWeeklyFollowersRecap({ channelId: "announcements" });

  assert.equal(result.rewardResult.reason, "ALREADY_AWARDED");
  assert.equal(db.calls.runTransactions, 1);
  assert.equal(db.calls.txUpdates.length, 0);
  assert.equal(db.calls.txSets.length, 0);
  assert.equal(db.calls.sets.length, 0);
  assert.equal(db.data("followers_all_time/previous_one").pops.balance, 100);
  assert.match(client.sent.at(-1).payload.content, /Gains deja attribues/);
});

test("recap works when fewer than three users are ranked", async () => {
  const db = buildDb({ includeThreePrevious: false });
  const client = createFakeClient();
  const sendWeeklyFollowersRecap = createRecap(db, client);

  const result = await sendWeeklyFollowersRecap({ channelId: "announcements" });

  assert.equal(result.rewardResult.reason, "APPLIED");
  assert.equal(result.rewardResult.rewards.length, 1);
  assert.equal(result.rewardResult.rewards[0].popsReward, 100);

  const content = client.sent[0].payload.content;
  assert.match(content, /Voici les Gagnants/);
  assert.match(content, /\+100 ♦️/);
  assert.doesNotMatch(content, /\+50 ♦️/);
  assert.doesNotMatch(content, /POPS/);
  assert.equal(db.data("followers_all_time/previous_one").pops.balance, 100);
});
