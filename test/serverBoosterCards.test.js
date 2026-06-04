"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  SERVER_BOOSTER_CARD_ID,
  SERVER_BOOSTER_GRANTED_FIELD,
  buildServerBoosterCard,
  buildServerBoosterUpdatePayload,
  getServerBoosterStartedAt,
  hasNativeServerBoosterRole,
  hasServerBoosterCard,
  isServerBoosterMember,
} = require("../script/serverBoosterCards");

const fakeFieldValue = {
  arrayUnion: (...values) => ({ __op: "arrayUnion", values }),
};

test("isServerBoosterMember detects native Discord boost state", () => {
  assert.equal(
    isServerBoosterMember({
      id: "1",
      user: { bot: false },
      premiumSinceTimestamp: Date.parse("2026-06-01T12:00:00.000Z"),
    }),
    true,
  );
  assert.equal(
    isServerBoosterMember({
      id: "2",
      user: { bot: false },
      premiumSince: new Date("2026-06-01T12:00:00.000Z"),
    }),
    true,
  );
  assert.equal(
    isServerBoosterMember({
      id: "role",
      user: { bot: false },
      roles: {
        cache: new Map([
          ["booster", { tags: { premiumSubscriberRole: true } }],
        ]),
      },
    }),
    true,
  );
  assert.equal(
    isServerBoosterMember({
      id: "3",
      user: { bot: true },
      premiumSinceTimestamp: Date.now(),
    }),
    false,
  );
  assert.equal(isServerBoosterMember({ id: "4", user: { bot: false } }), false);
});

test("hasNativeServerBoosterRole detects the tagged Discord role", () => {
  assert.equal(
    hasNativeServerBoosterRole({
      roles: {
        premiumSubscriberRole: { id: "native-booster-role" },
      },
    }),
    true,
  );
  assert.equal(
    hasNativeServerBoosterRole({
      roles: {
        cache: new Map([
          ["member", { tags: {} }],
          ["booster", { tags: { premiumSubscriberRole: true } }],
        ]),
      },
    }),
    true,
  );
  assert.equal(
    hasNativeServerBoosterRole({
      roles: {
        cache: new Map([["member", { tags: {} }]]),
      },
    }),
    false,
  );
});

test("buildServerBoosterCard keeps permanent collection metadata", () => {
  const member = {
    premiumSinceTimestamp: Date.parse("2026-05-20T10:30:00.000Z"),
  };
  const card = buildServerBoosterCard({}, { pseudo: "Alice" }, member);

  assert.equal(card.id, SERVER_BOOSTER_CARD_ID);
  assert.equal(card.title, "Booster Discord");
  assert.equal(card.section, "Discord");
  assert.equal(card.subMenu, "Booster");
  assert.equal(card.position, 5);
  assert.equal(card.source, "discord_server_booster");
  assert.equal(card.isAlreadyView, false);
  assert.equal(card.pseudo, "Alice");
  assert.equal(card.discordBoostedAt, "2026-05-20T10:30:00.000Z");
  assert.ok(card.sentAt);
  assert.ok(card.autoGrantedAt);
});

test("hasServerBoosterCard detects existing card by id", () => {
  assert.equal(
    hasServerBoosterCard({
      cards_generated: [{ id: "discord_member" }, { id: SERVER_BOOSTER_CARD_ID }],
    }),
    true,
  );
  assert.equal(
    hasServerBoosterCard({
      cards_generated: { one: { id: SERVER_BOOSTER_CARD_ID } },
    }),
    true,
  );
  assert.equal(hasServerBoosterCard({ cards_generated: [] }), false);
});

test("buildServerBoosterUpdatePayload adds card once and repairs missing flag", () => {
  const addPayload = buildServerBoosterUpdatePayload({
    userData: { pseudo: "Alice", cards_generated: [] },
    cardTemplate: {},
    member: { premiumSinceTimestamp: Date.parse("2026-05-20T10:30:00.000Z") },
    fieldValue: fakeFieldValue,
  });

  assert.equal(addPayload[SERVER_BOOSTER_GRANTED_FIELD], true);
  assert.equal(addPayload.cards_generated.__op, "arrayUnion");
  assert.equal(addPayload.cards_generated.values[0].id, SERVER_BOOSTER_CARD_ID);

  const repairFlagPayload = buildServerBoosterUpdatePayload({
    userData: {
      cards_generated: [{ id: SERVER_BOOSTER_CARD_ID }],
      [SERVER_BOOSTER_GRANTED_FIELD]: false,
    },
    cardTemplate: {},
    fieldValue: fakeFieldValue,
  });

  assert.deepEqual(repairFlagPayload, {
    [SERVER_BOOSTER_GRANTED_FIELD]: true,
  });

  const skipPayload = buildServerBoosterUpdatePayload({
    userData: {
      cards_generated: [{ id: SERVER_BOOSTER_CARD_ID }],
      [SERVER_BOOSTER_GRANTED_FIELD]: true,
    },
    cardTemplate: {},
    fieldValue: fakeFieldValue,
  });

  assert.equal(skipPayload, null);
});

test("getServerBoosterStartedAt normalizes Date fallback", () => {
  assert.equal(
    getServerBoosterStartedAt({
      premiumSince: new Date("2026-05-20T10:30:00.000Z"),
    }),
    "2026-05-20T10:30:00.000Z",
  );
  assert.equal(getServerBoosterStartedAt({ premiumSince: "invalid" }), null);
});
