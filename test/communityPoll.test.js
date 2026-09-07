"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  buildPublicCommunityPollSnapshot,
  queuePublicCommunityPollSync,
  registerCommunityPollEvents,
  syncPublicCommunityPollSnapshot,
} = require("../script/communityPoll");

class FakeSnapshot {
  constructor(ref, data, exists) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = exists;
    this._data = data;
  }

  data() {
    return this.exists ? this._data : undefined;
  }
}

class FakeDocRef {
  constructor(db, pathValue) {
    this.db = db;
    this.path = pathValue;
    this.id = pathValue.split("/").pop();
  }

  collection(name) {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
  }

  async get() {
    const exists = this.db.store.has(this.path);
    return new FakeSnapshot(this, this.db.store.get(this.path), exists);
  }

  async set(payload) {
    if (this.path === "site_config/community_poll") {
      this.db.publicSetAttempts += 1;
      if (this.db.publicSetFailures > 0) {
        this.db.publicSetFailures -= 1;
        const error = new Error("unavailable");
        error.code = 14;
        throw error;
      }
      if (this.db.beforePublicSet) await this.db.beforePublicSet(payload);
      this.db.publicSetHistory.push(payload);
    }
    this.db.store.set(this.path, payload);
  }
}

class FakeCollectionRef {
  constructor(db, pathValue) {
    this.db = db;
    this.path = pathValue;
  }

  doc(id) {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [];
    for (const [key, value] of this.db.store.entries()) {
      if (!key.startsWith(prefix)) continue;
      const relative = key.slice(prefix.length);
      if (!relative || relative.includes("/")) continue;
      docs.push(new FakeSnapshot(new FakeDocRef(this.db, key), value, true));
    }
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeDb {
  constructor(initialDocs = {}) {
    this.store = new Map(Object.entries(initialDocs));
    this.publicSetAttempts = 0;
    this.publicSetFailures = 0;
    this.publicSetHistory = [];
    this.beforePublicSet = null;
  }

  collection(name) {
    return new FakeCollectionRef(this, name);
  }
}

const proposalDoc = (id, data) => ({ id, data: () => data });
const createdAt = (millis) => ({ toMillis: () => millis });

function activeStore(guildId, voteCount = 1) {
  return {
    [`discord_community_poll_state/${guildId}`]: {
      activePollId: "poll-1",
    },
    "discord_community_polls/poll-1": {
      active: true,
      title: "Quel jeu pour le prochain live ?",
      description: "La communauté choisit.",
      guildId,
      channelId: "123456789012345678",
      messageId: "223456789012345678",
    },
    "discord_community_polls/poll-1/proposals/one": {
      name: "Minecraft",
      voteCount,
      authorId: "private-author",
      createdAt: createdAt(1),
    },
  };
}

test("builds a sanitized top-five public snapshot with stable tie ordering", () => {
  const proposals = [
    proposalDoc("late", {
      name: "Late tie",
      description: "private detail",
      authorId: "private-author",
      voteCount: 8,
      createdAt: createdAt(20),
    }),
    proposalDoc("winner", {
      name: "Winner",
      authorName: "private name",
      voteCount: 12,
      createdAt: createdAt(30),
    }),
    proposalDoc("early", {
      name: "Early tie",
      voteCount: 8,
      createdAt: createdAt(10),
    }),
    proposalDoc("four", { name: "Fourth", voteCount: 7, createdAt: createdAt(1) }),
    proposalDoc("five", { name: "Fifth", voteCount: 6, createdAt: createdAt(1) }),
    proposalDoc("six", { name: "Sixth", voteCount: 5, createdAt: createdAt(1) }),
  ];

  const payload = buildPublicCommunityPollSnapshot(
    {
      active: true,
      title: "  Prochain live  ",
      description: "  Choisissez votre jeu.  ",
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      messageId: "323456789012345678",
    },
    proposals,
  );

  assert.deepEqual(
    payload.proposals.map((proposal) => proposal.name),
    ["Winner", "Early tie", "Late tie", "Fourth", "Fifth"],
  );
  assert.equal(payload.title, "Prochain live");
  assert.equal(payload.description, "Choisissez votre jeu.");
  assert.equal(payload.proposals.length, 5);
  assert.doesNotMatch(JSON.stringify(payload), /author|private detail|Sixth/);
  assert.deepEqual(Object.keys(payload.proposals[0]).sort(), ["name", "voteCount"]);
});

test("uses the minimal inactive shape for closed or incomplete polls", () => {
  assert.deepEqual(buildPublicCommunityPollSnapshot({ active: false }), {
    active: false,
  });
  assert.deepEqual(
    buildPublicCommunityPollSnapshot({
      active: true,
      title: "Incomplete",
      guildId: "1",
      channelId: "2",
    }),
    { active: false },
  );
});

test("reconciles active and inactive state and retries transient writes", async () => {
  const activeDb = new FakeDb(activeStore("guild-retry", 4));
  activeDb.publicSetFailures = 1;
  const active = await syncPublicCommunityPollSnapshot(activeDb, "guild-retry", {
    maxAttempts: 2,
    baseDelayMs: 0,
  });

  assert.equal(active.active, true);
  assert.equal(active.proposals[0].voteCount, 4);
  assert.equal(activeDb.publicSetAttempts, 2);

  const inactiveDb = new FakeDb();
  const inactive = await syncPublicCommunityPollSnapshot(
    inactiveDb,
    "guild-inactive",
  );
  assert.deepEqual(inactive, { active: false });
  assert.deepEqual(inactiveDb.store.get("site_config/community_poll"), {
    active: false,
  });
});

test("serializes concurrent publications so the newest ranking wins", async () => {
  const guildId = "guild-queue";
  const db = new FakeDb(activeStore(guildId, 1));
  let releaseFirstSet;
  let markFirstSetStarted;
  const firstSetStarted = new Promise((resolve) => {
    markFirstSetStarted = resolve;
  });
  const firstSetGate = new Promise((resolve) => {
    releaseFirstSet = resolve;
  });
  let setIndex = 0;
  db.beforePublicSet = async () => {
    setIndex += 1;
    if (setIndex !== 1) return;
    markFirstSetStarted();
    await firstSetGate;
  };

  const first = queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  await firstSetStarted;
  db.store.get("discord_community_polls/poll-1/proposals/one").voteCount = 9;
  const second = queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  releaseFirstSet();
  await Promise.all([first, second]);

  assert.deepEqual(
    db.publicSetHistory.map((payload) => payload.proposals[0].voteCount),
    [1, 9],
  );
  assert.equal(
    db.store.get("site_config/community_poll").proposals[0].voteCount,
    9,
  );
});

test("mirrors the create, auto-vote, vote move, removal and close lifecycle", async () => {
  const guildId = "guild-lifecycle";
  const db = new FakeDb({
    [`discord_community_poll_state/${guildId}`]: {
      activePollId: "poll-1",
    },
    "discord_community_polls/poll-1": {
      active: true,
      title: "Prochain live",
      description: "Votez sur Discord.",
      guildId,
      channelId: "123456789012345678",
      messageId: "223456789012345678",
    },
  });

  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(db.publicSetHistory.at(-1).proposals, []);

  db.store.set("discord_community_polls/poll-1/proposals/one", {
    name: "Minecraft",
    voteCount: 1,
    authorId: "private-author",
    createdAt: createdAt(1),
  });
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(db.publicSetHistory.at(-1).proposals, [
    { name: "Minecraft", voteCount: 1 },
  ]);

  db.store.get("discord_community_polls/poll-1/proposals/one").voteCount = 0;
  db.store.set("discord_community_polls/poll-1/proposals/two", {
    name: "Phasmophobia",
    voteCount: 2,
    createdAt: createdAt(2),
  });
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(
    db.publicSetHistory.at(-1).proposals.map(({ name, voteCount }) => [
      name,
      voteCount,
    ]),
    [
      ["Phasmophobia", 2],
      ["Minecraft", 0],
    ],
  );

  db.store.get("discord_community_polls/poll-1/proposals/two").voteCount = 1;
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.equal(db.publicSetHistory.at(-1).proposals[0].voteCount, 1);

  db.store.get(`discord_community_poll_state/${guildId}`).activePollId = null;
  db.store.get("discord_community_polls/poll-1").active = false;
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(db.publicSetHistory.at(-1), { active: false });
});

test("event registration performs startup reconciliation", async () => {
  const guildId = "guild-startup";
  const db = new FakeDb(activeStore(guildId, 3));
  const client = {
    listeners: [],
    on(event, handler) {
      this.listeners.push({ event, handler });
    },
  };

  await registerCommunityPollEvents({ client, guildId, db });

  assert.equal(client.listeners.length, 1);
  assert.equal(db.store.get("site_config/community_poll").active, true);
  assert.equal(
    db.store.get("site_config/community_poll").proposals[0].voteCount,
    3,
  );
});

test("all authoritative poll mutations publish the public mirror", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../script/communityPoll.js"),
    "utf8",
  );

  for (const context of [
    "after create",
    "after proposal",
    "after vote",
    "after close",
    "startup",
  ]) {
    assert.match(source, new RegExp(`publishPublicCommunityPollBestEffort\\([\\s\\S]*?${context}`));
  }
});
