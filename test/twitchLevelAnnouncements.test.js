"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildCommunityLevelUpMessage,
  displayMention,
} = require("../script/twitchLevelAnnouncements");

test("formats community level-up Twitch announcement", () => {
  assert.equal(
    buildCommunityLevelUpMessage({
      displayName: "Alice",
      login: "alice",
      level: 42,
      rankName: "Maitre du cosmos",
    }),
    "GG @Alice, tu passes niveau 42 - Maitre du cosmos !",
  );
});

test("level-up announcement falls back to login and skips invalid level", () => {
  assert.equal(displayMention("@Alice"), "@Alice");
  assert.equal(
    buildCommunityLevelUpMessage({
      login: "alice",
      level: 2,
    }),
    "GG @alice, tu passes niveau 2 !",
  );
  assert.equal(buildCommunityLevelUpMessage({ login: "alice", level: 0 }), "");
});
