"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  DAILY_CHEST_AUTO_GRANT_TYPE,
  DAILY_CHEST_CARD_TEMPLATES,
  ensureDailyChestCardTemplates,
} = require("../script/dailyChestCards");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class FakeTemplateDb {
  constructor(initialDocs = {}) {
    this.store = new Map(
      Object.entries(initialDocs).map(([path, data]) => [path, clone(data)]),
    );
    this.commits = 0;
  }

  collection(name) {
    return {
      doc: (id) => {
        const path = `${name}/${id}`;
        return {
          path,
          get: async () => ({
            exists: this.store.has(path),
            data: () => clone(this.store.get(path)),
          }),
        };
      },
    };
  }

  batch() {
    const writes = [];
    return {
      create: (ref, payload) => writes.push({ ref, payload: clone(payload) }),
      commit: async () => {
        const conflict = writes.find(({ ref }) => this.store.has(ref.path));
        if (conflict) {
          const error = new Error(`${conflict.ref.path} already exists`);
          error.code = 6;
          throw error;
        }
        writes.forEach(({ ref, payload }) => this.store.set(ref.path, payload));
        this.commits += 1;
      },
    };
  }

  data(path) {
    return clone(this.store.get(path));
  }
}

test("daily chest card templates expose the expected progressive rules", () => {
  assert.deepEqual(
    DAILY_CHEST_CARD_TEMPLATES.map((card) => ({
      id: card.id,
      title: card.title,
      position: card.position,
      type: card.autoGrant.type,
      threshold: card.autoGrant.threshold,
    })),
    [
      {
        id: "discord_chest_opener",
        title: "Ouvre-boîte",
        position: 6,
        type: DAILY_CHEST_AUTO_GRANT_TYPE,
        threshold: 7,
      },
      {
        id: "discord_chest_addict",
        title: "Accro au coffre",
        position: 7,
        type: DAILY_CHEST_AUTO_GRANT_TYPE,
        threshold: 30,
      },
      {
        id: "discord_living_vault",
        title: "Coffre-fort vivant",
        position: 8,
        type: DAILY_CHEST_AUTO_GRANT_TYPE,
        threshold: 100,
      },
    ],
  );
});

test("template provisioning creates only missing cards", async () => {
  const existing = {
    id: "discord_chest_opener",
    title: "Titre personnalise",
    customField: true,
  };
  const db = new FakeTemplateDb({
    "cards_collections/discord_chest_opener": existing,
  });

  const first = await ensureDailyChestCardTemplates(db);
  const second = await ensureDailyChestCardTemplates(db);

  assert.deepEqual(first, { checked: 3, created: 2, existing: 1 });
  assert.deepEqual(second, { checked: 3, created: 0, existing: 3 });
  assert.equal(db.commits, 1);
  assert.deepEqual(
    db.data("cards_collections/discord_chest_opener"),
    existing,
  );
  assert.equal(
    db.data("cards_collections/discord_chest_addict").autoGrant.threshold,
    30,
  );
  assert.equal(
    db.data("cards_collections/discord_living_vault").imgUrl,
    "images/cards-collection/discord_living_vault.png",
  );
});
