"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { _test } = require("../app/twitchEventSub");
const {
  parseTwitchPollInput,
  processTwitchPollRedemption,
} = require("../script/twitchPolls");

function fakePollDb(scopes = ["channel:manage:polls"]) {
  return {
    doc(path) {
      return {
        path,
        async get() {
          return {
            exists: true,
            data: () => ({ scopes }),
          };
        },
      };
    },
  };
}

function fakePollConfig() {
  return {
    twitch: {
      channelId: "broadcaster-1",
      clientId: "client-1",
      tokenDocPath: "settings/twitch_moderator",
    },
    twitchPoll: {
      durationSeconds: 300,
      channelPointsPerExtraVote: 0,
    },
    urls: {
      helixPolls: "https://api.twitch.tv/helix/polls",
    },
  };
}

function fakePollRedemption(input = "Va-t-il rager ? oui/non/peut-etre") {
  return {
    id: "redemption-1",
    user_login: "alice",
    user_name: "Alice",
    user_input: input,
    reward: {
      id: "reward-poll",
      title: "Faire un sondage",
    },
  };
}

function fakeLivePresenceTick(streamId = "stream-1") {
  return {
    getLiveStreamState: () => ({
      streamId,
      startedAt: new Date("2026-06-20T10:00:00Z"),
    }),
  };
}

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

test("twitch poll parser accepts question and 2-5 slash choices", () => {
  const parsed = parseTwitchPollInput("Va-t-il rager ? oui/non/peut-être");

  assert.equal(parsed.ok, true);
  assert.equal(parsed.title, "Va-t-il rager ?");
  assert.deepEqual(
    parsed.choices.map((choice) => choice.title),
    ["oui", "non", "peut-être"],
  );
});

test("twitch poll parser rejects missing question mark", () => {
  const parsed = parseTwitchPollInput("Va-t-il rager oui/non");

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "missing_question_mark");
});

test("twitch poll parser rejects fewer than two choices", () => {
  const parsed = parseTwitchPollInput("Va-t-il rager ? oui");

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "not_enough_choices");
});

test("twitch poll parser rejects more than five choices", () => {
  const parsed = parseTwitchPollInput("Question ? a/b/c/d/e/f");

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "too_many_choices");
});

test("twitch poll parser rejects too-long question or choice", () => {
  const longQuestion = `${"Q".repeat(61)} ? oui/non`;
  const longChoice = `Question ? oui/${"n".repeat(26)}`;

  assert.equal(parseTwitchPollInput(longQuestion).code, "question_too_long");
  assert.equal(parseTwitchPollInput(longChoice).code, "choice_too_long");
});

test("twitch poll parser rejects duplicate choices after normalization", () => {
  const parsed = parseTwitchPollInput("Question ? Oui/oui/non");

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "duplicate_choice");
});

test("poll redemption creates a Twitch poll and fulfills the redemption", async () => {
  const updates = [];
  const createdPolls = [];

  const result = await processTwitchPollRedemption({
    db: fakePollDb(),
    config: fakePollConfig(),
    tokenManager: { getAccessToken: async () => "user-token" },
    redemption: fakePollRedemption(),
    livePresenceTick: fakeLivePresenceTick(),
    sendTwitchChatMessage: async () => {
      throw new Error("chat should not be used on success");
    },
    updateRedemptionStatusFn: async (payload) => updates.push(payload),
    createPollFn: async (payload) => {
      createdPolls.push(payload);
      return { id: "poll-1" };
    },
  });

  assert.equal(result.status, "FULFILLED");
  assert.equal(result.poll.id, "poll-1");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "FULFILLED");
  assert.equal(updates[0].accessToken, "user-token");
  assert.equal(createdPolls.length, 1);
  assert.equal(createdPolls[0].title, "Va-t-il rager ?");
  assert.deepEqual(
    createdPolls[0].choices.map((choice) => choice.title),
    ["oui", "non", "peut-etre"],
  );
});

test("poll redemption cancels invalid input", async () => {
  const updates = [];
  const chatMessages = [];

  const result = await processTwitchPollRedemption({
    db: fakePollDb(),
    config: fakePollConfig(),
    tokenManager: { getAccessToken: async () => "user-token" },
    redemption: fakePollRedemption("Va-t-il rager oui/non"),
    livePresenceTick: fakeLivePresenceTick(),
    sendTwitchChatMessage: async (message) => chatMessages.push(message),
    updateRedemptionStatusFn: async (payload) => updates.push(payload),
    createPollFn: async () => {
      throw new Error("createPollFn should not be called");
    },
  });

  assert.equal(result.status, "CANCELED");
  assert.equal(result.reason, "missing_question_mark");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "CANCELED");
  assert.equal(chatMessages.length, 1);
  assert.match(chatMessages[0], /Format attendu/);
});

test("poll redemption cancels when Twitch reports an active poll", async () => {
  const updates = [];
  const chatMessages = [];
  const activePollError = new Error("active poll");
  activePollError.response = {
    status: 400,
    data: { message: "A poll is currently active." },
  };

  const result = await processTwitchPollRedemption({
    db: fakePollDb(),
    config: fakePollConfig(),
    tokenManager: { getAccessToken: async () => "user-token" },
    redemption: fakePollRedemption(),
    livePresenceTick: fakeLivePresenceTick(),
    sendTwitchChatMessage: async (message) => chatMessages.push(message),
    updateRedemptionStatusFn: async (payload) => updates.push(payload),
    createPollFn: async () => {
      throw activePollError;
    },
  });

  assert.equal(result.status, "CANCELED");
  assert.equal(result.reason, "poll_already_active");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "CANCELED");
  assert.match(chatMessages[0], /deja actif/);
});
