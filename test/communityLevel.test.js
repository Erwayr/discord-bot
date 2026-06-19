"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { recalculateCommunityLevelRanks } = require("../script/communityLevel");

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

class FakeDoc {
  constructor(id, data) {
    this.id = id;
    this._data = clone(data);
    this.ref = { id, path: `followers_all_time/${id}` };
  }

  data() {
    return clone(this._data);
  }
}

class FakeDb {
  constructor(docs = {}) {
    this.docs = Object.entries(docs).map(([id, data]) => new FakeDoc(id, data));
    this.commits = 0;
    this.sets = [];
  }

  collection(name) {
    assert.equal(name, "followers_all_time");
    return {
      get: async () => ({
        forEach: (callback) => this.docs.forEach(callback),
      }),
    };
  }

  batch() {
    const ops = [];
    return {
      set: (ref, patch, options) => {
        ops.push({ ref, patch: clone(patch), options: clone(options) });
      },
      commit: async () => {
        this.commits += 1;
        this.sets.push(...ops);
      },
    };
  }
}

test("recalculateCommunityLevelRanks skips profiles with current rank metadata", async () => {
  const db = new FakeDb({
    alice: {
      pseudo: "alice",
      communityLevel: {
        rank: 1,
        rankName: "minimoys",
        level: 5,
        xpTotal: 500,
      },
    },
    bob: {
      pseudo: "bob",
      communityLevel: {
        rank: 2,
        rankName: "minimoys",
        level: 1,
        xpTotal: 100,
      },
    },
  });

  const result = await recalculateCommunityLevelRanks(db);

  assert.deepEqual(result, { updated: 0, skipped: false });
  assert.equal(db.commits, 0);
  assert.equal(db.sets.length, 0);
});

test("recalculateCommunityLevelRanks writes only stale rank metadata", async () => {
  const db = new FakeDb({
    alice: {
      pseudo: "alice",
      communityLevel: {
        rank: 2,
        rankName: "minimoys",
        level: 5,
        xpTotal: 500,
      },
    },
    bob: {
      pseudo: "bob",
      communityLevel: {
        rank: 2,
        rankName: "minimoys",
        level: 1,
        xpTotal: 100,
      },
    },
  });

  const result = await recalculateCommunityLevelRanks(db);

  assert.deepEqual(result, { updated: 1, skipped: false });
  assert.equal(db.commits, 1);
  assert.equal(db.sets.length, 1);
  assert.equal(db.sets[0].ref.id, "alice");
  assert.equal(db.sets[0].patch["communityLevel.rank"], 1);
  assert.equal(db.sets[0].patch["communityLevel.rankName"], "minimoys");
  assert.equal(db.sets[0].options.merge, true);
});

