"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildDailyChestAnimationFrames,
  buildDailyChestEmbed,
  buildDailyChestStatsEmbed,
  forcedDailyChestTestReward,
  handleDailyChestInteraction,
  handleDailyChestStatsInteraction,
  openDailyChest,
  sendDailyChestTestMessage,
} = require("../script/dailyChest");
const {
  DAILY_CHEST_STATS_COMMAND_NAME,
  slashCommandPayloads,
} = require("../app/slashCommands");

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
  node[parts[0]] = clone(value);
}

class FakeSnapshot {
  constructor(ref, data) {
    this.id = ref.id;
    this.ref = ref;
    this._data = data == null ? null : clone(data);
    this.exists = data != null;
  }

  data() {
    return this._data == null ? undefined : clone(this._data);
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
    return new FakeSnapshot(this, this.db.store.get(this.path));
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
  constructor(db, path, filters = [], limitCount = null) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.limitCount = limitCount;
  }

  doc(id) {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }

  where(fieldPath, op, value) {
    return new FakeCollectionRef(
      this.db,
      this.path,
      this.filters.concat([{ fieldPath, op, value }]),
      this.limitCount,
    );
  }

  limit(limitCount) {
    return new FakeCollectionRef(
      this.db,
      this.path,
      this.filters,
      Math.max(0, Math.floor(Number(limitCount) || 0)),
    );
  }

  async get() {
    this.db.calls.queries.push({
      path: this.path,
      filters: clone(this.filters),
      limitCount: this.limitCount,
    });
    const prefix = `${this.path}/`;
    const docs = [];
    for (const [path, data] of this.db.store.entries()) {
      if (!path.startsWith(prefix)) continue;
      const id = path.slice(prefix.length);
      if (!id || id.includes("/")) continue;
      if (!this.matchesFilters(data)) continue;
      docs.push(new FakeSnapshot(this.doc(id), data));
      if (this.limitCount != null && docs.length >= this.limitCount) break;
    }
    return {
      empty: docs.length === 0,
      docs,
      forEach: (callback) => docs.forEach(callback),
    };
  }

  matchesFilters(data) {
    return this.filters.every((filter) => {
      const actual = getPathValue(data || {}, filter.fieldPath);
      if (filter.op === "==") return actual === filter.value;
      throw new Error(`Unsupported fake where op: ${filter.op}`);
    });
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
      queries: [],
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

const NOW = new Date("2026-06-16T10:00:00.000Z");
const BASE_CONFIG = {
  timezone: "UTC",
  discord: {
    dailyChestChannelId: "1516374903203565621",
    logChannelId: "log-channel",
  },
  communityLevel: {
    enabled: true,
    baseXp: 100,
    growthXp: 0,
    maxLevel: 999,
    rankTitles: [
      { min: 0, label: "Start" },
      { min: 2, label: "Level 2" },
    ],
  },
};

function follower(overrides = {}) {
  return {
    pseudo: "Alice",
    discord_id: "111111111111111111",
    pops: { balance: 10, lifetimeEarned: 20, schemaVersion: 1 },
    ...overrides,
  };
}

function embedField(embed, name) {
  return (embed.fields || []).find((field) => field.name === name);
}

test("daily chest stats slash command is registered with optional member option", () => {
  const payload = slashCommandPayloads().find(
    (command) => command.name === DAILY_CHEST_STATS_COMMAND_NAME,
  );

  assert.ok(payload);
  assert.equal(payload.name, "coffrestats");
  assert.match(payload.description, /statistiques/);
  assert.equal(payload.options?.[0]?.name, "membre");
  assert.equal(payload.options?.[0]?.required, false);
});

test("daily chest refuses members without a linked follower profile", async () => {
  const db = new FakeDb();

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "pops", amount: 37 },
  });

  assert.equal(result.status, "profile_missing");
  assert.equal(db.calls.runTransactions, 0);
});

test("daily chest slash command is restricted to chest and log channels", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower(),
  });
  const replies = [];
  const interaction = {
    channelId: "wrong-channel",
    user: { id: "111111111111111111" },
    replied: false,
    deferred: false,
    async reply(payload) {
      replies.push(payload);
      this.replied = true;
    },
    async deferReply() {
      throw new Error("deferReply should not run outside allowed channels");
    },
  };

  const result = await handleDailyChestInteraction(interaction, db, BASE_CONFIG);

  assert.equal(result.status, "wrong_channel");
  assert.equal(result.allowedChannelIds.length, 2);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /1516374903203565621/);
  assert.match(replies[0].content, /log-channel/);
  assert.equal(db.calls.gets.length, 0);
  assert.equal(db.calls.runTransactions, 0);
});

test("daily chest slash command is allowed in log channel", async () => {
  const db = new FakeDb();
  const edits = [];
  const interaction = {
    channelId: "log-channel",
    user: { id: "111111111111111111" },
    replied: false,
    deferred: false,
    async deferReply(payload) {
      this.deferred = true;
      this.deferPayload = payload;
    },
    async editReply(payload) {
      edits.push(payload);
    },
  };

  const result = await handleDailyChestInteraction(interaction, db, BASE_CONFIG);

  assert.equal(result.status, "profile_missing");
  assert.equal(interaction.deferPayload.ephemeral, false);
  assert.equal(edits.length, 1);
  assert.match(String(edits[0]), /Profil introuvable/);
});

test("daily chest stats slash command is restricted to chest and log channels", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower(),
  });
  const replies = [];
  const interaction = {
    channelId: "wrong-channel",
    user: { id: "111111111111111111" },
    replied: false,
    deferred: false,
    options: {
      getUser() {
        throw new Error("getUser should not run outside allowed channels");
      },
    },
    async reply(payload) {
      replies.push(payload);
      this.replied = true;
    },
    async deferReply() {
      throw new Error("deferReply should not run outside allowed channels");
    },
  };

  const result = await handleDailyChestStatsInteraction(
    interaction,
    db,
    BASE_CONFIG,
  );

  assert.equal(result.status, "wrong_channel");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true);
  assert.match(replies[0].content, /1516374903203565621/);
  assert.equal(db.calls.queries.length, 0);
  assert.equal(db.calls.runTransactions, 0);
});

test("daily chest stats slash command handles missing linked profile", async () => {
  const db = new FakeDb();
  const edits = [];
  const interaction = {
    channelId: "log-channel",
    user: { id: "111111111111111111", username: "AliceDiscord" },
    replied: false,
    deferred: false,
    options: {
      getUser() {
        return null;
      },
    },
    async deferReply(payload) {
      this.deferred = true;
      this.deferPayload = payload;
    },
    async editReply(payload) {
      edits.push(payload);
    },
  };

  const result = await handleDailyChestStatsInteraction(
    interaction,
    db,
    BASE_CONFIG,
  );

  assert.equal(result.status, "profile_missing");
  assert.equal(interaction.deferPayload.ephemeral, false);
  assert.equal(db.calls.queries.length, 1);
  assert.equal(db.calls.runTransactions, 0);
  assert.equal(db.calls.txUpdates.length, 0);
  assert.match(String(edits[0]), /Profil introuvable/);
});

test("daily chest stats slash command renders current member stats without writes", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      dailyChest: {
        totalOpenings: 12,
        lastOpenedDay: "2026-06-16",
        lastRewards: [
          { type: "pops", tier: "rare", amount: 150, message: "" },
          { type: "quest_bonus", tier: "rare", amount: 1, message: "" },
        ],
        stats: {
          trackedOpenings: 4,
          startedDay: "2026-06-13",
          byTier: { common: 1, small: 1, rare: 1, legendary: 1 },
          byType: { pops: 2, exp: 1, quest_bonus: 2, nothing: 1 },
          totals: { pops: 287, xp: 200, questBonusPct: 11 },
          multiRewardOpenings: 2,
        },
      },
    }),
  });
  const edits = [];
  const interaction = {
    channelId: "1516374903203565621",
    user: { id: "111111111111111111", username: "AliceDiscord" },
    replied: false,
    deferred: false,
    options: {
      getUser(name) {
        assert.equal(name, "membre");
        return null;
      },
    },
    async deferReply(payload) {
      this.deferred = true;
      this.deferPayload = payload;
    },
    async editReply(payload) {
      edits.push(payload);
    },
  };

  const result = await handleDailyChestStatsInteraction(
    interaction,
    db,
    BASE_CONFIG,
  );
  const finalEmbed = edits.at(-1).embeds[0].toJSON();

  assert.equal(result.status, "stats");
  assert.equal(result.profile.displayName, "Alice");
  assert.equal(result.totalOpenings, 12);
  assert.equal(result.stats.trackedOpenings, 4);
  assert.equal(db.calls.runTransactions, 0);
  assert.equal(db.calls.txUpdates.length, 0);
  assert.equal(db.calls.txSets.length, 0);
  assert.match(finalEmbed.title, /Stats coffre de Alice/);
  assert.match(embedField(finalEmbed, "Ouvertures").value, /Historique: \*\*12\*\*/);
  assert.match(embedField(finalEmbed, "Ouvertures").value, /Suivies: \*\*4\*\*/);
  assert.match(embedField(finalEmbed, "Coffres speciaux").value, /Rares: \*\*1\*\*/);
  assert.match(
    embedField(finalEmbed, "Coffres speciaux").value,
    /Legendaires: \*\*1\*\*/,
  );
  assert.match(embedField(finalEmbed, "Gains cumules").value, /287 \u2666\uFE0F POPS/);
  assert.match(embedField(finalEmbed, "Gains cumules").value, /200 \u2728 EXP/);
  assert.match(embedField(finalEmbed, "Gains cumules").value, /\+11% \uD83C\uDF40/);
  assert.match(embedField(finalEmbed, "Dernier coffre").value, /2026-06-16/);
  assert.match(embedField(finalEmbed, "Dernier coffre").value, /\+150/);
  assert.match(embedField(finalEmbed, "Dernier coffre").value, /\+1%/);
});

test("daily chest stats slash command can target another member", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower(),
    "followers_all_time/bob": follower({
      pseudo: "Bob",
      discord_id: "222222222222222222",
      dailyChest: {
        totalOpenings: 2,
        stats: {
          trackedOpenings: 2,
          byTier: { common: 0, small: 2, rare: 0, legendary: 0 },
          byType: { pops: 1, exp: 1, quest_bonus: 0, nothing: 0 },
          totals: { pops: 15, xp: 20, questBonusPct: 0 },
          multiRewardOpenings: 0,
        },
      },
    }),
  });
  const edits = [];
  const targetUser = { id: "222222222222222222", username: "BobDiscord" };
  const interaction = {
    channelId: "log-channel",
    user: { id: "111111111111111111", username: "AliceDiscord" },
    options: {
      getUser(name) {
        assert.equal(name, "membre");
        return targetUser;
      },
    },
    async deferReply() {},
    async editReply(payload) {
      edits.push(payload);
    },
  };

  const result = await handleDailyChestStatsInteraction(
    interaction,
    db,
    BASE_CONFIG,
  );
  const finalEmbed = edits.at(-1).embeds[0].toJSON();

  assert.equal(result.status, "stats");
  assert.equal(result.targetDiscordId, "222222222222222222");
  assert.equal(result.profile.displayName, "Bob");
  assert.equal(db.calls.queries[0].filters[0].value, "222222222222222222");
  assert.match(finalEmbed.title, /Stats coffre de Bob/);
});

test("daily chest stats embed supports profiles without tracked stats", () => {
  const embed = buildDailyChestStatsEmbed(
    {
      status: "stats",
      profile: { displayName: "Alice" },
      totalOpenings: 3,
      stats: undefined,
      lastOpenedDay: "2026-06-15",
      lastReward: { type: "pops", tier: "small", amount: 5, message: "" },
    },
    { username: "AliceDiscord" },
  ).toJSON();

  assert.match(embed.title, /Stats coffre de Alice/);
  assert.match(embedField(embed, "Ouvertures").value, /Historique: \*\*3\*\*/);
  assert.match(embedField(embed, "Ouvertures").value, /Suivies: \*\*0\*\*/);
  assert.match(embedField(embed, "Coffres speciaux").value, /Rares: \*\*0\*\*/);
  assert.match(
    embedField(embed, "Coffres speciaux").value,
    /Legendaires: \*\*0\*\*/,
  );
  assert.match(embedField(embed, "Gains cumules").value, /0 \u2666\uFE0F POPS/);
  assert.match(embedField(embed, "Gains cumules").value, /0 \u2728 EXP/);
  assert.match(embedField(embed, "Gains cumules").value, /\+0% \uD83C\uDF40/);
  assert.match(embedField(embed, "Dernier coffre").value, /\+5 \u2666\uFE0F POPS/);
});

test("daily chest credits POPS and writes an idempotent ledger entry", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower(),
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "pops", amount: 37 },
  });

  assert.equal(result.status, "opened");
  assert.equal(result.totalOpenings, 1);
  assert.equal(db.data("followers_all_time/alice").pops.balance, 47);
  assert.equal(db.data("followers_all_time/alice").pops.lifetimeEarned, 57);
  assert.equal(
    db.data("followers_all_time/alice/daily_chest_claims/2026-06-16").reward
      .amount,
    37,
  );
  assert.deepEqual(
    db.data("followers_all_time/alice/daily_chest_claims/2026-06-16").rewards,
    [{ type: "pops", tier: "custom", amount: 37, message: "" }],
  );
  assert.equal(
    db.data(
      "followers_all_time/alice/pops_transactions/daily_chest_2026-06-16",
    ).type,
    "daily_chest",
  );
  assert.deepEqual(db.data("followers_all_time/alice").dailyChest.stats, {
    trackedOpenings: 1,
    startedDay: "2026-06-16",
    byTier: { common: 0, small: 1, rare: 0, legendary: 0 },
    byType: { pops: 1, exp: 0, quest_bonus: 0, nothing: 0 },
    totals: { pops: 37, xp: 0, questBonusPct: 0 },
    multiRewardOpenings: 0,
  });
  assert.deepEqual(
    result.stats,
    db.data("followers_all_time/alice").dailyChest.stats,
  );
});

test("daily chest POPS embed uses casino panel and ruby icon", () => {
  const embed = buildDailyChestEmbed(
    {
      dayKey: "2026-06-16",
      profile: { displayName: "Alice" },
      reward: { type: "pops", tier: "small", amount: 37 },
      rewardResult: {
        reward: { type: "pops", tier: "small", amount: 37 },
      },
    },
    { username: "Alice" },
  ).toJSON();

  const fields = embed.fields || [];
  assert.match(embed.description, /```text/);
  assert.match(embed.description, /\+==============================\+/);
  assert.match(embed.description, /COFFRE PETIT GAIN/);
  assert.match(embed.description, /\| GAIN\s+\|/);
  assert.doesNotMatch(embed.description, /TIRAGE/);
  assert.doesNotMatch(embed.description, /RARET/);
  assert.doesNotMatch(embed.description, /JACKPOT/);
  assert.match(embed.description, /\+37/);
  assert.match(embed.description, /\u2666/);
  assert.match(embed.description, /\u2666\uFE0F POPS/);
  assert.equal(
    fields.some((field) => field.name.includes("Impact")),
    false,
  );
  assert.equal(fields.length, 0);
  assert.doesNotMatch(JSON.stringify(embed), /Tirage de/);
});

test("daily chest stats do not backfill existing total openings", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      dailyChest: {
        totalOpenings: 5,
        lastOpenedDay: "2026-06-15",
      },
    }),
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: {
      type: "nothing",
      tier: "common",
      message: "Rien, mais avec panache.",
    },
  });
  const doc = db.data("followers_all_time/alice");
  const embed = buildDailyChestEmbed(result, { username: "Alice" }).toJSON();

  assert.equal(result.status, "opened");
  assert.equal(result.totalOpenings, 6);
  assert.equal(doc.dailyChest.totalOpenings, 6);
  assert.equal(doc.dailyChest.stats.trackedOpenings, 1);
  assert.equal(doc.dailyChest.stats.startedDay, "2026-06-16");
  assert.match(embed.description, /Ouverts: 6/);
  assert.doesNotMatch(embed.description, /Suivis:/);
});

test("daily chest real embed includes compact user stats", () => {
  const embed = buildDailyChestEmbed(
    {
      dayKey: "2026-06-16",
      totalOpenings: 12,
      reward: { type: "pops", tier: "small", amount: 37 },
      stats: {
        trackedOpenings: 4,
        startedDay: "2026-06-13",
        byTier: { common: 1, small: 1, rare: 1, legendary: 1 },
        byType: { pops: 2, exp: 1, quest_bonus: 2, nothing: 1 },
        totals: { pops: 287, xp: 200, questBonusPct: 11 },
        multiRewardOpenings: 2,
      },
    },
    { username: "Alice" },
  ).toJSON();

  assert.match(embed.description, /Ouverts: 12/);
  assert.doesNotMatch(embed.description, /Suivis:/);
  assert.match(embed.description, /Rares: 1/);
  assert.match(embed.description, /Legendaires: 1/);
  assert.match(embed.description, /287 \u2666\uFE0F POPS/);
  assert.match(embed.description, /200 \u2728 EXP/);
  assert.match(embed.description, /\+11% \uD83C\uDF40/);
  assert.equal(embed.footer, undefined);
});

test("daily chest embed uses distinct visual frames by reward tier", () => {
  const rareEmbed = buildDailyChestEmbed(
    {
      dayKey: "2026-06-16",
      reward: { type: "pops", tier: "rare", amount: 150 },
      rewards: [
        { type: "pops", tier: "rare", amount: 150 },
        { type: "quest_bonus", tier: "rare", amount: 1 },
      ],
    },
    { username: "Alice" },
  ).toJSON();
  const legendaryEmbed = buildDailyChestEmbed(
    {
      dayKey: "2026-06-16",
      reward: { type: "quest_bonus", tier: "legendary", amount: 10 },
      rewards: [
        { type: "quest_bonus", tier: "legendary", amount: 10 },
        { type: "pops", tier: "legendary", amount: 250 },
        { type: "exp", tier: "legendary", amount: 200 },
      ],
    },
    { username: "Alice" },
  ).toJSON();

  assert.match(rareEmbed.description, /\+\*{30}\+/);
  assert.match(rareEmbed.description, /COFFRE RARE/);
  assert.match(rareEmbed.description, /\uD83D\uDC8E/);
  assert.equal((rareEmbed.description.match(/\| GAIN\s+\|/g) || []).length, 2);
  assert.match(rareEmbed.description, /\+1%/);
  assert.doesNotMatch(rareEmbed.description, /JACKPOT/);
  assert.doesNotMatch(rareEmbed.description, /TIRAGE/);

  assert.match(legendaryEmbed.description, /\+#{30}\+/);
  assert.match(legendaryEmbed.description, /COFFRE LEGENDAIRE/);
  assert.match(legendaryEmbed.description, /\uD83D\uDC51/);
  assert.equal(
    (legendaryEmbed.description.match(/\| GAIN\s+\|/g) || []).length,
    3,
  );
  assert.match(legendaryEmbed.description, /\+10%/);
  assert.match(legendaryEmbed.description, /\+250/);
  assert.match(legendaryEmbed.description, /\+200/);
  assert.doesNotMatch(legendaryEmbed.description, /JACKPOT/);
  assert.doesNotMatch(legendaryEmbed.description, /TIRAGE/);
});

test("daily chest animation frames do not include player draw title", () => {
  const frames = buildDailyChestAnimationFrames({
    reward: { type: "exp", tier: "small", amount: 15 },
    rng: () => 0.2,
  });

  assert.ok(frames.length >= 5);
  assert.doesNotMatch(frames.join("\n"), /Tirage de/);
});

test("daily chest nothing embed appends laughing emoji to funny message", () => {
  const embed = buildDailyChestEmbed(
    {
      dayKey: "2026-06-16",
      reward: {
        type: "nothing",
        tier: "common",
        amount: 0,
        message: "Rien, mais avec panache.",
      },
    },
    { username: "Alice" },
  ).toJSON();

  assert.match(embed.description, /Rien, mais avec panache\. \uD83D\uDE02$/);
  assert.match(embed.description, /\+-{30}\+/);
  assert.match(embed.description, /\|\s+COFFRE\s+\|/);
  assert.doesNotMatch(embed.description, /Commun/);
  assert.doesNotMatch(embed.description, /TIRAGE/);
});

test("daily chest test reward parser supports forced reward aliases", () => {
  const rng = () => 0;

  assert.deepEqual(forcedDailyChestTestReward("pops", rng), {
    type: "pops",
    tier: "small",
    amount: 15,
    message: "",
  });
  assert.deepEqual(forcedDailyChestTestReward("exp rare", rng), {
    type: "exp",
    tier: "rare",
    amount: 150,
    message: "",
  });
  assert.deepEqual(forcedDailyChestTestReward("chance", rng), {
    type: "quest_bonus",
    tier: "small",
    amount: 1,
    message: "",
  });
  assert.deepEqual(forcedDailyChestTestReward("legendaire", rng), {
    type: "quest_bonus",
    tier: "legendary",
    amount: 10,
    message: "",
  });

  const nothing = forcedDailyChestTestReward("rien", rng);
  assert.equal(nothing.type, "nothing");
  assert.equal(nothing.tier, "common");
  assert.equal(nothing.amount, 0);
  assert.ok(nothing.message);
});

test("daily chest does not double credit the same day", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower(),
  });

  await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "pops", amount: 37 },
  });
  db.resetCalls();

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "pops", amount: 250 },
  });

  assert.equal(result.status, "already_opened");
  assert.equal(db.data("followers_all_time/alice").pops.balance, 47);
  assert.equal(
    db.data("followers_all_time/alice").dailyChest.stats.trackedOpenings,
    1,
  );
  assert.equal(
    db.data("followers_all_time/alice").dailyChest.stats.totals.pops,
    37,
  );
  assert.equal(db.calls.runTransactions, 1);
  assert.equal(db.calls.txUpdates.length, 0);
  assert.equal(db.calls.txSets.length, 0);
});

test("daily chest EXP reward recalculates community level", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      communityLevel: {
        rank: 5,
        level: 1,
        xpTotal: 90,
        xpInLevel: 90,
        xpForNext: 100,
        rankName: "Start",
      },
    }),
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "exp", amount: 15 },
  });

  const community = db.data("followers_all_time/alice").communityLevel;
  assert.equal(result.status, "opened");
  assert.equal(community.level, 2);
  assert.equal(community.xpTotal, 105);
  assert.equal(community.xpInLevel, 5);
  assert.equal(community.xpForNext, 100);
  assert.equal(community.rankName, "Level 2");
  assert.equal(community.dailyChestXpTotal, 15);
  assert.equal(db.data("followers_all_time/alice").dailyChest.stats.byType.exp, 1);
  assert.equal(db.data("followers_all_time/alice").dailyChest.stats.totals.xp, 15);
});

test("daily chest quest bonus caps monthly progress and mirrors participants", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      live_presence: {
        "2026-06": { progress_pct: 98 },
      },
    }),
    "participants/alice": { pseudo: "Alice" },
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "quest_bonus", amount: 10 },
  });

  assert.equal(result.status, "opened");
  assert.equal(
    db.data("followers_all_time/alice").live_presence["2026-06"].progress_pct,
    100,
  );
  assert.equal(db.data("participants/alice").progress_pct, 100);
  assert.equal(db.data("participants/alice").quest_progress_pct, 100);
  assert.equal(
    db.data("participants/alice").live_presence["2026-06"].progress_pct,
    100,
  );
  assert.equal(
    db.data("followers_all_time/alice").dailyChest.stats.byType.quest_bonus,
    1,
  );
  assert.equal(
    db.data("followers_all_time/alice").dailyChest.stats.totals.questBonusPct,
    10,
  );
});

test("daily chest rare POPS also applies quest bonus", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      live_presence: {
        "2026-06": { progress_pct: 40 },
      },
    }),
    "participants/alice": { pseudo: "Alice" },
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "pops", tier: "rare", amount: 150 },
  });

  const doc = db.data("followers_all_time/alice");
  const claim = db.data(
    "followers_all_time/alice/daily_chest_claims/2026-06-16",
  );
  const transaction = db.data(
    "followers_all_time/alice/pops_transactions/daily_chest_2026-06-16",
  );

  assert.equal(result.status, "opened");
  assert.equal(result.rewards.length, 2);
  assert.deepEqual(
    result.rewards.map((reward) => reward.type),
    ["pops", "quest_bonus"],
  );
  assert.equal(doc.pops.balance, 160);
  assert.equal(doc.live_presence["2026-06"].progress_pct, 41);
  assert.equal(db.data("participants/alice").progress_pct, 41);
  assert.equal(claim.reward.type, "pops");
  assert.equal(claim.rewards.length, 2);
  assert.equal(doc.dailyChest.lastRewards.length, 2);
  assert.equal(transaction.amount, 150);
  assert.equal(transaction.rewards.length, 2);
  assert.equal(doc.dailyChest.stats.trackedOpenings, 1);
  assert.equal(doc.dailyChest.stats.byTier.rare, 1);
  assert.equal(doc.dailyChest.stats.byType.pops, 1);
  assert.equal(doc.dailyChest.stats.byType.quest_bonus, 1);
  assert.equal(doc.dailyChest.stats.totals.pops, 150);
  assert.equal(doc.dailyChest.stats.totals.questBonusPct, 1);
  assert.equal(doc.dailyChest.stats.multiRewardOpenings, 1);
});

test("daily chest rare EXP also applies quest bonus", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      communityLevel: {
        rank: 5,
        level: 1,
        xpTotal: 0,
        xpInLevel: 0,
        xpForNext: 100,
        rankName: "Start",
      },
      live_presence: {
        "2026-06": { progress_pct: 99 },
      },
    }),
    "participants/alice": { pseudo: "Alice" },
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "exp", tier: "rare", amount: 150 },
  });

  const doc = db.data("followers_all_time/alice");
  const claim = db.data(
    "followers_all_time/alice/daily_chest_claims/2026-06-16",
  );

  assert.equal(result.status, "opened");
  assert.deepEqual(
    result.rewards.map((reward) => reward.type),
    ["exp", "quest_bonus"],
  );
  assert.equal(doc.communityLevel.xpTotal, 150);
  assert.equal(doc.communityLevel.dailyChestXpTotal, 150);
  assert.equal(doc.live_presence["2026-06"].progress_pct, 100);
  assert.equal(db.data("participants/alice").quest_progress_pct, 100);
  assert.equal(claim.reward.type, "exp");
  assert.equal(claim.rewards.length, 2);
  assert.equal(doc.dailyChest.stats.byTier.rare, 1);
  assert.equal(doc.dailyChest.stats.byType.exp, 1);
  assert.equal(doc.dailyChest.stats.byType.quest_bonus, 1);
  assert.equal(doc.dailyChest.stats.totals.xp, 150);
  assert.equal(doc.dailyChest.stats.totals.questBonusPct, 1);
  assert.equal(doc.dailyChest.stats.multiRewardOpenings, 1);
  assert.equal(
    db.data(
      "followers_all_time/alice/pops_transactions/daily_chest_2026-06-16",
    ),
    undefined,
  );
});

test("daily chest legendary applies quest bonus POPS and EXP", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      communityLevel: {
        rank: 5,
        level: 1,
        xpTotal: 0,
        xpInLevel: 0,
        xpForNext: 100,
        rankName: "Start",
      },
      live_presence: {
        "2026-06": { progress_pct: 95 },
      },
    }),
    "participants/alice": { pseudo: "Alice" },
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "quest_bonus", tier: "legendary", amount: 10 },
  });

  const doc = db.data("followers_all_time/alice");
  const claim = db.data(
    "followers_all_time/alice/daily_chest_claims/2026-06-16",
  );
  const transaction = db.data(
    "followers_all_time/alice/pops_transactions/daily_chest_2026-06-16",
  );

  assert.equal(result.status, "opened");
  assert.deepEqual(
    result.rewards.map((reward) => reward.type),
    ["quest_bonus", "pops", "exp"],
  );
  assert.equal(doc.live_presence["2026-06"].progress_pct, 100);
  assert.equal(doc.pops.balance, 260);
  assert.equal(doc.pops.lifetimeEarned, 270);
  assert.equal(doc.communityLevel.xpTotal, 200);
  assert.equal(doc.communityLevel.dailyChestXpTotal, 200);
  assert.equal(db.data("participants/alice").progress_pct, 100);
  assert.equal(claim.reward.type, "quest_bonus");
  assert.equal(claim.rewards.length, 3);
  assert.equal(doc.dailyChest.lastRewards.length, 3);
  assert.equal(transaction.amount, 250);
  assert.equal(transaction.rewards.length, 3);
  assert.equal(doc.dailyChest.stats.byTier.legendary, 1);
  assert.equal(doc.dailyChest.stats.byType.quest_bonus, 1);
  assert.equal(doc.dailyChest.stats.byType.pops, 1);
  assert.equal(doc.dailyChest.stats.byType.exp, 1);
  assert.equal(doc.dailyChest.stats.totals.pops, 250);
  assert.equal(doc.dailyChest.stats.totals.xp, 200);
  assert.equal(doc.dailyChest.stats.totals.questBonusPct, 10);
  assert.equal(doc.dailyChest.stats.multiRewardOpenings, 1);
});

test("daily chest does not double credit bundled rewards same day", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower({
      communityLevel: {
        rank: 5,
        level: 1,
        xpTotal: 0,
        xpInLevel: 0,
        xpForNext: 100,
        rankName: "Start",
      },
      live_presence: {
        "2026-06": { progress_pct: 0 },
      },
    }),
  });

  await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "quest_bonus", tier: "legendary", amount: 10 },
  });
  db.resetCalls();

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "quest_bonus", tier: "legendary", amount: 10 },
  });
  const doc = db.data("followers_all_time/alice");

  assert.equal(result.status, "already_opened");
  assert.equal(doc.pops.balance, 260);
  assert.equal(doc.communityLevel.xpTotal, 200);
  assert.equal(doc.live_presence["2026-06"].progress_pct, 10);
  assert.equal(doc.dailyChest.stats.trackedOpenings, 1);
  assert.equal(doc.dailyChest.stats.byTier.legendary, 1);
  assert.equal(doc.dailyChest.stats.multiRewardOpenings, 1);
  assert.equal(db.calls.txUpdates.length, 0);
  assert.equal(db.calls.txSets.length, 0);
});

test("daily chest nothing reward records claim without wallet or progress writes", async () => {
  const db = new FakeDb({
    "followers_all_time/alice": follower(),
  });

  const result = await openDailyChest(db, {
    discordId: "111111111111111111",
    config: BASE_CONFIG,
    now: NOW,
    reward: { type: "nothing", message: "Rien, mais avec panache." },
  });

  const doc = db.data("followers_all_time/alice");
  assert.equal(result.status, "opened");
  assert.equal(doc.pops.balance, 10);
  assert.equal(doc.communityLevel, undefined);
  assert.equal(doc.live_presence, undefined);
  assert.equal(doc.dailyChest.totalOpenings, 1);
  assert.deepEqual(doc.dailyChest.stats, {
    trackedOpenings: 1,
    startedDay: "2026-06-16",
    byTier: { common: 1, small: 0, rare: 0, legendary: 0 },
    byType: { pops: 0, exp: 0, quest_bonus: 0, nothing: 1 },
    totals: { pops: 0, xp: 0, questBonusPct: 0 },
    multiRewardOpenings: 0,
  });
  assert.equal(
    db.data("followers_all_time/alice/daily_chest_claims/2026-06-16").reward
      .type,
    "nothing",
  );
  assert.equal(
    db.data(
      "followers_all_time/alice/pops_transactions/daily_chest_2026-06-16",
    ),
    undefined,
  );
});

test("daily chest test message renders preview without Firestore dependencies", async () => {
  const sentMessages = [];
  const message = {
    author: { id: "999999999999999999", username: "Tester" },
    member: { displayName: "Tester" },
    channel: {
      async send(payload) {
        const sent = {
          payload,
          edits: [],
          async edit(nextPayload) {
            this.edits.push(nextPayload);
            this.payload = nextPayload;
          },
        };
        sentMessages.push(sent);
        return sent;
      },
    },
  };

  const result = await sendDailyChestTestMessage(message, {
    config: BASE_CONFIG,
    now: NOW,
    animationDelayMs: 0,
    forceReward: "legendaire",
    rng: () => 0.1,
  });

  assert.equal(result.testMode, true);
  assert.equal(result.reward.type, "quest_bonus");
  assert.equal(result.reward.tier, "legendary");
  assert.equal(result.rewards.length, 3);
  assert.equal(sentMessages.length, 1);
  const finalEdit = sentMessages[0].edits.at(-1);
  const finalEmbed = finalEdit.embeds[0].toJSON();
  assert.match(String(finalEdit.content), /aucun gain applique/);
  assert.equal(finalEdit.embeds.length, 1);
  assert.match(finalEmbed.description, /```text/);
  assert.match(finalEmbed.description, /\+#{30}\+/);
  assert.match(finalEmbed.description, /COFFRE LEGENDAIRE/);
  assert.match(finalEmbed.description, /\+10%/);
  assert.match(finalEmbed.description, /\+250/);
  assert.match(finalEmbed.description, /\+200/);
  assert.equal(
    (finalEmbed.description.match(/\| GAIN\s+\|/g) || []).length,
    3,
  );
  assert.match(finalEmbed.description, /\| GAIN\s+\|/);
  assert.doesNotMatch(finalEmbed.description, /TIRAGE/);
  assert.doesNotMatch(finalEmbed.description, /RARET/);
  assert.doesNotMatch(finalEmbed.description, /Commun/);
  assert.doesNotMatch(finalEmbed.description, /JACKPOT/);
  assert.doesNotMatch(finalEmbed.description, /Ouverts:/);
  assert.doesNotMatch(finalEmbed.description, /Suivis:/);
  assert.equal((finalEmbed.fields || []).length, 0);
  assert.ok(sentMessages[0].edits.length >= 5);
});
