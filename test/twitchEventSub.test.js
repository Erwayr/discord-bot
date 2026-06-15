"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { _test } = require("../app/twitchEventSub");

test("overlay card redemption matches configured reward id first", () => {
  const redemption = {
    reward: {
      id: "reward-ma-carte-id",
      title: "Autre titre",
    },
  };

  assert.equal(
    _test.isOverlayCardRedemption(redemption, {
      cardRewardId: "reward-ma-carte-id",
      cardRewardTitle: "ma carte",
    }),
    true,
  );
  assert.equal(
    _test.isOverlayCardRedemption(redemption, {
      cardRewardId: "other-id",
      cardRewardTitle: "ma carte",
    }),
    false,
  );
});

test("overlay card redemption falls back to normalized title", () => {
  assert.equal(
    _test.isOverlayCardRedemption(
      { reward: { id: "any-id", title: "La recompense MA CARTE !" } },
      { cardRewardTitle: "ma carte" },
    ),
    true,
  );
  assert.equal(
    _test.isOverlayCardRedemption(
      { reward: { id: "any-id", title: "Ticket d'or" } },
      { cardRewardTitle: "ma carte" },
    ),
    false,
  );
});

test("overlay card redemption payload exposes only overlay fields", () => {
  const payload = _test.buildOverlayCardRedemptionEvent(
    {
      id: "abc/123",
      user_login: "Erwayr",
      user_name: "Erwayr",
      user_id: "private-user-id",
      status: "unfulfilled",
      redeemed_at: "2026-06-15T10:00:00Z",
      reward: {
        id: "reward-id",
        title: "Ma carte",
        cost: 1,
      },
    },
    { cardEventType: "reward_ma_carte" },
  );

  assert.equal(payload.type, "reward_ma_carte");
  assert.equal(payload.login, "erwayr");
  assert.equal(payload.displayName, "Erwayr");
  assert.equal(payload.rewardId, "reward-id");
  assert.equal(payload.rewardTitle, "Ma carte");
  assert.equal(payload.eventMs, Date.parse("2026-06-15T10:00:00Z"));
  assert.equal(Object.hasOwn(payload, "user_id"), false);
  assert.equal(Object.hasOwn(payload, "status"), false);
  assert.equal(Object.hasOwn(payload, "cost"), false);
});

test("overlay card event doc ids are Firestore-safe", () => {
  assert.equal(_test.safeOverlayEventDocId("abc/123 hello"), "abc_123_hello");
});
