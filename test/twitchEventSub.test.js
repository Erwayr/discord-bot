"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { createTwitchEventSub, _test } = require("../app/twitchEventSub");
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

function fakeEventSubConfig(secret = "secret") {
  return {
    twitch: {
      channelId: "broadcaster-1",
      clientId: "client-1",
      moderatorId: "moderator-1",
      webhookSecret: secret,
      ticketRewardId: "ticket-reward",
    },
    twitchPoll: {
      rewardId: "poll-reward",
      rewardTitle: "Faire un sondage",
    },
    overlay: {
      cardRewardId: "overlay-card-reward",
      cardRewardTitle: "ma carte",
      eventsCollection: "overlay_events",
      subCardEventType: "sub_card",
      subCardDedupeMs: 15_000,
    },
    urls: {},
    timing: {
      subCooldownMs: 10_000,
      subDebounceMs: 0,
    },
    discord: {
      bootyChannelId: "booty-channel",
    },
  };
}

function fakeSignedRequest(body, secret = "secret", id = "message-1") {
  const timestamp = "2026-06-20T10:00:00Z";
  const signature = crypto
    .createHmac("sha256", secret)
    .update(id + timestamp + JSON.stringify(body))
    .digest("hex");
  const headers = new Map([
    ["twitch-eventsub-message-id", id],
    ["twitch-eventsub-message-timestamp", timestamp],
    ["twitch-eventsub-message-signature", `sha256=${signature}`],
  ]);
  return {
    body,
    header(name) {
      return headers.get(String(name || "").toLowerCase());
    },
  };
}

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return {
        send: (body) => {
          this.body = body;
          return this;
        },
      };
    },
  };
}

function channelPointBody(login = "alice") {
  return {
    subscription: {
      type: "channel.channel_points_custom_reward_redemption.add",
    },
    event: {
      id: `redemption-${login}`,
      user_id: `id-${login}`,
      user_login: login,
      user_name: login[0].toUpperCase() + login.slice(1),
      reward: {
        id: "channel-points-reward",
        title: "Hydrate",
      },
    },
  };
}

function cloneData(data) {
  return data == null ? data : JSON.parse(JSON.stringify(data));
}

function fakeFirestore(initial = {}) {
  const docs = new Map(
    Object.entries(initial).map(([path, data]) => [path, cloneData(data)]),
  );
  const writes = [];

  function ref(path) {
    return {
      path,
      async get() {
        const data = docs.get(path);
        return {
          exists: data != null,
          data: () => cloneData(data),
        };
      },
      async set(data, options = {}) {
        const next = options.merge
          ? { ...(docs.get(path) || {}), ...cloneData(data) }
          : cloneData(data);
        docs.set(path, next);
        writes.push({
          type: "set",
          path,
          data: cloneData(data),
          options: { ...options },
        });
      },
      async update(data) {
        if (!docs.has(path)) throw new Error(`missing document: ${path}`);
        docs.set(path, { ...docs.get(path), ...cloneData(data) });
        writes.push({ type: "update", path, data: cloneData(data) });
      },
    };
  }

  return {
    writes,
    data(path) {
      return cloneData(docs.get(path));
    },
    collection(name) {
      return {
        doc(id) {
          return ref(`${name}/${id}`);
        },
      };
    },
    doc(path) {
      return ref(path);
    },
    async runTransaction(fn) {
      return fn({
        get: (docRef) => docRef.get(),
        set: (docRef, data, options) => docRef.set(data, options),
        update: (docRef, data) => docRef.update(data),
      });
    },
  };
}

function subscriptionBody(type, login = "alice", eventOverrides = {}) {
  const displayName = login[0].toUpperCase() + login.slice(1);
  return {
    subscription: { type },
    event: {
      user_id: `id-${login}`,
      user_login: login,
      user_name: displayName,
      tier: "Prime",
      is_gift: false,
      ...(type === "channel.subscription.message"
        ? { cumulative_months: 6, streak_months: 3, duration_months: 1 }
        : {}),
      ...eventOverrides,
    },
  };
}

function overlayWrites(db) {
  return db.writes.filter(
    (write) =>
      write.type === "set" &&
      write.path.startsWith("overlay_events/") &&
      write.data?.type === "sub_card",
  );
}

function createOverlayEventSub(db, configPatch = {}) {
  const baseConfig = fakeEventSubConfig();
  const config = {
    ...baseConfig,
    ...configPatch,
    overlay: {
      ...baseConfig.overlay,
      ...(configPatch.overlay || {}),
    },
    timing: {
      ...baseConfig.timing,
      ...(configPatch.timing || {}),
    },
  };
  return createTwitchEventSub({
    db,
    client: {},
    config,
    tokenManager: {},
    questStore: {},
    livePresenceTick: fakeLivePresenceTick("stream-1"),
    postDiscord: async () => {},
    sendTwitchChatMessage: async () => {},
    bufferLiveChannelPoints: () => null,
    twitchExtensionStatsSync: null,
  });
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

test("channel.subscribe publishes one overlay sub card event", async () => {
  const db = fakeFirestore();
  const eventSub = createOverlayEventSub(db);
  const res = fakeResponse();

  await eventSub.handleTwitchCallback(
    fakeSignedRequest(
      subscriptionBody("channel.subscribe", "alice"),
      "secret",
      "sub-message-1",
    ),
    res,
  );

  assert.equal(res.statusCode, 200);
  const writes = overlayWrites(db);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "overlay_events/sub_card_sub-message-1");
  assert.equal(writes[0].data.login, "alice");
  assert.equal(writes[0].data.displayName, "Alice");
  assert.equal(writes[0].data.twitchEventType, "channel.subscribe");
  assert.equal(writes[0].data.subTier, "Prime");
  assert.equal(writes[0].data.subMonths, 1);
  assert.equal(writes[0].data.subMessage, "");
});

test("channel.subscription.message publishes one overlay sub card event", async () => {
  const db = fakeFirestore();
  const eventSub = createOverlayEventSub(db);
  const res = fakeResponse();

  await eventSub.handleTwitchCallback(
    fakeSignedRequest(
      subscriptionBody("channel.subscription.message", "bob", {
        cumulative_months: 14,
        tier: "3000",
        message: { text: "Merci pour le stream !" },
      }),
      "secret",
      "resub-message-1",
    ),
    res,
  );

  assert.equal(res.statusCode, 200);
  const writes = overlayWrites(db);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "overlay_events/sub_card_resub-message-1");
  assert.equal(writes[0].data.login, "bob");
  assert.equal(writes[0].data.displayName, "Bob");
  assert.equal(writes[0].data.twitchEventType, "channel.subscription.message");
  assert.equal(writes[0].data.subTier, "3000");
  assert.equal(writes[0].data.subMonths, 14);
  assert.equal(writes[0].data.subMessage, "Merci pour le stream !");
});

test("sub then resub for same login is deduped for overlay card", async () => {
  const db = fakeFirestore();
  const eventSub = createOverlayEventSub(db);
  const subRes = fakeResponse();
  const resubRes = fakeResponse();

  await eventSub.handleTwitchCallback(
    fakeSignedRequest(
      subscriptionBody("channel.subscribe", "carol"),
      "secret",
      "combo-sub-1",
    ),
    subRes,
  );
  await eventSub.handleTwitchCallback(
    fakeSignedRequest(
      subscriptionBody("channel.subscription.message", "carol"),
      "secret",
      "combo-resub-1",
    ),
    resubRes,
  );

  assert.equal(subRes.statusCode, 200);
  assert.equal(resubRes.statusCode, 200);
  const writes = overlayWrites(db);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.login, "carol");
  assert.equal(writes[0].data.twitchEventType, "channel.subscribe");
});

test("same login can publish overlay sub card after dedupe window", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-06-20T10:00:00Z");
  Date.now = () => now;
  try {
    const db = fakeFirestore();
    const eventSub = createOverlayEventSub(db, {
      overlay: { subCardDedupeMs: 15_000 },
    });

    await eventSub.handleTwitchCallback(
      fakeSignedRequest(
        subscriptionBody("channel.subscription.message", "diane"),
        "secret",
        "resub-window-1",
      ),
      fakeResponse(),
    );
    now += 16_000;
    await eventSub.handleTwitchCallback(
      fakeSignedRequest(
        subscriptionBody("channel.subscription.message", "diane", {
          cumulative_months: 7,
        }),
        "secret",
        "resub-window-2",
      ),
      fakeResponse(),
    );

    const writes = overlayWrites(db);
    assert.equal(writes.length, 2);
    assert.deepEqual(
      writes.map((write) => write.path),
      [
        "overlay_events/sub_card_resub-window-1",
        "overlay_events/sub_card_resub-window-2",
      ],
    );
  } finally {
    Date.now = originalNow;
  }
});

test("channel point redemption updates existing profile immediately", async () => {
  const noteCalls = [];
  const bufferCalls = [];
  const syncCalls = [];
  const eventSub = createTwitchEventSub({
    db: {},
    client: {},
    config: fakeEventSubConfig(),
    tokenManager: {},
    questStore: {
      noteChannelPoints: async (...args) => {
        noteCalls.push(args);
        return { reason: null, leveledUp: false };
      },
    },
    livePresenceTick: fakeLivePresenceTick("stream-1"),
    postDiscord: async () => {},
    sendTwitchChatMessage: async () => {},
    bufferLiveChannelPoints: (...args) => {
      bufferCalls.push(args);
      return { buffered: true };
    },
    twitchExtensionStatsSync: {
      syncEntry: async (entry) => {
        syncCalls.push(entry);
      },
    },
  });
  const res = fakeResponse();

  await eventSub.handleTwitchCallback(
    fakeSignedRequest(channelPointBody("alice")),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(noteCalls.length, 1);
  assert.equal(noteCalls[0][0], "alice");
  assert.equal(noteCalls[0][1], "stream-1");
  assert.equal(noteCalls[0][2], 1);
  assert.equal(noteCalls[0][3].createIfMissing, false);
  assert.equal(bufferCalls.length, 0);
  assert.equal(syncCalls.length, 1);
  assert.deepEqual(syncCalls[0], {
    twitchUserId: "id-alice",
    login: "alice",
    displayName: "Alice",
    channelPointsCount: 1,
  });
});

test("channel point redemption buffers missing live profile", async () => {
  const noteCalls = [];
  const bufferCalls = [];
  const syncCalls = [];
  const eventSub = createTwitchEventSub({
    db: {},
    client: {},
    config: fakeEventSubConfig(),
    tokenManager: {},
    questStore: {
      noteChannelPoints: async (...args) => {
        noteCalls.push(args);
        return { reason: "missing_follower", leveledUp: false };
      },
    },
    livePresenceTick: fakeLivePresenceTick("stream-1"),
    postDiscord: async () => {},
    sendTwitchChatMessage: async () => {},
    bufferLiveChannelPoints: (...args) => {
      bufferCalls.push(args);
      return { buffered: true };
    },
    twitchExtensionStatsSync: {
      syncEntry: async (entry) => {
        syncCalls.push(entry);
      },
    },
  });
  const res = fakeResponse();

  await eventSub.handleTwitchCallback(
    fakeSignedRequest(channelPointBody("bob"), "secret", "message-2"),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(noteCalls.length, 1);
  assert.equal(noteCalls[0][3].createIfMissing, false);
  assert.equal(bufferCalls.length, 1);
  assert.equal(bufferCalls[0][0], "bob");
  assert.equal(bufferCalls[0][1], "stream-1");
  assert.equal(bufferCalls[0][2], 1);
  assert.equal(bufferCalls[0][3].displayName, "Bob");
  assert.equal(bufferCalls[0][3].twitchUserId, "id-bob");
  assert.equal(syncCalls.length, 0);
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

test("poll redemption creates a Twitch poll without updating redemption status", async () => {
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
    createPollFn: async (payload) => {
      createdPolls.push(payload);
      return { id: "poll-1" };
    },
  });

  assert.equal(result.status, "CREATED");
  assert.equal(result.poll.id, "poll-1");
  assert.equal(createdPolls.length, 1);
  assert.equal(createdPolls[0].title, "Va-t-il rager ?");
  assert.deepEqual(
    createdPolls[0].choices.map((choice) => choice.title),
    ["oui", "non", "peut-etre"],
  );
});

test("poll redemption rejects invalid input without canceling redemption", async () => {
  const chatMessages = [];

  const result = await processTwitchPollRedemption({
    db: fakePollDb(),
    config: fakePollConfig(),
    tokenManager: { getAccessToken: async () => "user-token" },
    redemption: fakePollRedemption("Va-t-il rager oui/non"),
    livePresenceTick: fakeLivePresenceTick(),
    sendTwitchChatMessage: async (message) => chatMessages.push(message),
    createPollFn: async () => {
      throw new Error("createPollFn should not be called");
    },
  });

  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "missing_question_mark");
  assert.equal(chatMessages.length, 1);
  assert.match(chatMessages[0], /Format attendu/);
  assert.doesNotMatch(chatMessages[0], /rembours/i);
});

test("poll redemption rejects when Twitch reports an active poll", async () => {
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
    createPollFn: async () => {
      throw activePollError;
    },
  });

  assert.equal(result.status, "REJECTED");
  assert.equal(result.reason, "poll_already_active");
  assert.match(chatMessages[0], /deja actif/);
});
