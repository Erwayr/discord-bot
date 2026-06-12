"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

class FakeEmbedBuilder {
  constructor() {
    this.data = {};
  }

  setColor(value) {
    this.data.color = value;
    return this;
  }

  setTitle(value) {
    this.data.title = value;
    return this;
  }

  setDescription(value) {
    this.data.description = value;
    return this;
  }

  addFields(...fields) {
    this.data.fields = fields.flat();
    return this;
  }

  setFooter(value) {
    this.data.footer = value;
    return this;
  }

  setTimestamp(value) {
    this.data.timestamp = value;
    return this;
  }

  setImage(value) {
    this.data.image = { url: value };
    return this;
  }
}

const originalLoad = Module._load;
Module._load = function loadWithDiscordStub(request, parent, isMain) {
  if (request === "discord.js") {
    return { EmbedBuilder: FakeEmbedBuilder };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  buildDiscordBirthdayPayload,
  createBirthdayService,
} = require("../app/birthdays");

const fakeAdmin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => "__SERVER_TIMESTAMP__",
    },
  },
};

function setNestedValue(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let node = target;
  while (parts.length > 1) {
    const key = parts.shift();
    if (!node[key] || typeof node[key] !== "object") node[key] = {};
    node = node[key];
  }
  node[parts[0]] = value;
}

function applyUpdate(target, payload) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(payload || {})) {
    if (key.includes(".")) setNestedValue(next, key, value);
    else next[key] = value;
  }
  return next;
}

class FakeDocSnapshot {
  constructor(data) {
    this._data = data;
    this.exists = data !== undefined;
  }

  data() {
    return this._data;
  }
}

class FakeDocRef {
  constructor(db, pathValue) {
    this.db = db;
    this.path = pathValue;
  }

  collection(name) {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
  }

  async get() {
    return new FakeDocSnapshot(this.db.store.get(this.path));
  }

  async set(value, options = {}) {
    const previous = options.merge ? this.db.store.get(this.path) || {} : {};
    this.db.store.set(this.path, { ...previous, ...value });
  }

  async update(value) {
    this.db.store.set(this.path, applyUpdate(this.db.store.get(this.path), value));
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
}

class FakeDb {
  constructor(initialData = {}) {
    this.store = new Map(Object.entries(initialData));
  }

  collection(name) {
    return new FakeCollectionRef(this, name);
  }

  doc(pathValue) {
    return new FakeDocRef(this, pathValue);
  }

  async runTransaction(callback) {
    return callback({
      get: (ref) => ref.get(),
      set: (ref, value, options) => ref.set(value, options),
      update: (ref, value) => ref.update(value),
    });
  }

  data(pathValue) {
    return this.store.get(pathValue);
  }
}

function currentBirthdayKeys(timeZone = "Europe/Warsaw", now = new Date()) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const values = { year: "0000", month: "00", day: "00" };
  for (const part of parts) {
    if (part.type === "year") values.year = part.value;
    if (part.type === "month") values.month = part.value.padStart(2, "0");
    if (part.type === "day") values.day = part.value.padStart(2, "0");
  }
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    dayKey: `${values.month}-${values.day}`,
  };
}

function fakeBirthdayConfig() {
  return {
    timezone: "Europe/Warsaw",
    birthdays: {
      field: "birthday",
      indexCollection: "birthdays_index",
      indexMetaDoc: "settings/birthday_index_meta",
      discordAnnouncementCollection: "birthday_discord_announcements",
      indexMaxAgeHours: 0,
      indexFallbackScan: false,
      displayFields: ["display_name", "displayName", "pseudo"],
      indexVersion: 3,
    },
  };
}

function fakeTextChannel() {
  return {
    sent: [],
    isTextBased: () => true,
    async send(payload) {
      this.sent.push(payload);
      return { id: `message-${this.sent.length}` };
    },
  };
}

function fakeClient(channel) {
  return {
    channels: {
      fetch: async () => channel,
    },
  };
}

test("buildDiscordBirthdayPayload attaches birthday banner when asset exists", () => {
  const payload = buildDiscordBirthdayPayload({
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
    ],
  });

  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, "birthday-banner.png");
  assert.match(
    payload.files[0].attachment.replace(/\\/g, "/"),
    /assets\/birthday-banner\.png$/,
  );
  assert.equal(
    payload.embeds[0].data.image.url,
    "attachment://birthday-banner.png",
  );
  assert.match(payload.content, /QUÊTE ANNIVERSAIRE DÉBLOQUÉE/);
  assert.match(payload.embeds[0].data.description, /- \*\*Héros du jour :\*\*/);
  assert.match(
    payload.embeds[0].data.description,
    /communauté des loulous 🎮/,
  );
  assert.match(
    payload.embeds[0].data.description,
    /Une pluie de rubis pour le plus beau des joyaux : \+500 ♦️ ♦️/,
  );
  assert.deepEqual(payload.embeds[0].data.fields, [
    {
      name: "Mission du serveur ✨",
      value:
        "- Remplir le général de vœux, de GG et de petites étincelles de bonne humeur ✨",
      inline: false,
    },
  ]);
});

test("buildDiscordBirthdayPayload falls back cleanly without banner", () => {
  const payload = buildDiscordBirthdayPayload({
    bannerPath: path.join(__dirname, "missing-birthday-banner.png"),
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
    ],
  });

  assert.equal(payload.files, undefined);
  assert.equal(payload.embeds[0].data.image, undefined);
  assert.match(payload.content, /<@111111111111111111>/);
});

test("buildDiscordBirthdayPayload keeps test mentions inactive", () => {
  const payload = buildDiscordBirthdayPayload({
    test: true,
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
    ],
  });

  assert.match(payload.content, /TEST - non publié/);
  assert.match(payload.content, /<@111111111111111111>/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("buildDiscordBirthdayPayload groups multiple birthdays in one payload", () => {
  const payload = buildDiscordBirthdayPayload({
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
      {
        login: "bob",
        display: "Bob",
        discord_id: "222222222222222222",
      },
    ],
  });

  assert.match(payload.content, /double tournée de bougies/);
  assert.match(payload.content, /ANNIVERSAIRE COMMUNAUTÉ/);
  assert.equal(payload.embeds.length, 1);
  assert.match(payload.embeds[0].data.description, /111111111111111111/);
  assert.match(payload.embeds[0].data.description, /222222222222222222/);
  assert.equal(payload.embeds[0].data.fields.length, 1);
  assert.equal(payload.embeds[0].data.fields[0].name, "Mission du serveur ✨");
  assert.match(
    payload.embeds[0].data.description,
    /Une pluie de rubis pour les plus beaux des joyaux : \+500 ♦️ chacun ♦️/,
  );
  assert.deepEqual(payload.allowedMentions, {
    parse: [],
    users: ["111111111111111111", "222222222222222222"],
  });
});

test("sendDiscordBirthdayAnnouncements awards 500 birthday rubies once", async () => {
  const { dateKey, dayKey } = currentBirthdayKeys();
  const transactionPath =
    `followers_all_time/alice/pops_transactions/` +
    `birthday_${dateKey}_alice`;
  const db = new FakeDb({
    "settings/birthday_index_meta": { version: 3 },
    [`birthdays_index/${dayKey}`]: {
      list: [
        {
          login: "alice",
          display: "Alice",
          discord_id: "111111111111111111",
        },
      ],
    },
    "followers_all_time/alice": {
      pseudo: "Alice",
      pops: { balance: 7, lifetimeEarned: 10, schemaVersion: 1 },
    },
  });
  const channel = fakeTextChannel();
  const service = createBirthdayService({
    db,
    admin: fakeAdmin,
    config: fakeBirthdayConfig(),
  });

  await service.refreshTodayBirthdays();
  const first = await service.sendDiscordBirthdayAnnouncements({
    client: fakeClient(channel),
    channelId: "general",
  });
  const second = await service.sendDiscordBirthdayAnnouncements({
    client: fakeClient(channel),
    channelId: "general",
  });

  assert.equal(first.sent, true);
  assert.equal(first.rubyRewards[0].amount, 500);
  assert.equal(first.rubyRewards[0].after, 507);
  assert.equal(second.reason, "ALREADY_SENT");
  assert.equal(channel.sent.length, 1);
  assert.equal(db.data("followers_all_time/alice").pops.balance, 507);
  assert.equal(db.data("followers_all_time/alice").pops.lifetimeEarned, 510);
  assert.equal(db.data(transactionPath).amount, 500);
  assert.equal(db.data(transactionPath).type, "birthday_reward");
  assert.equal(
    db.data(transactionPath).source,
    "birthday_discord_announcement",
  );
});
