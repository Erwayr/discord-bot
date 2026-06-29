"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createTwitchExtensionStatsSync,
  entryToViewerStatsPayload,
} = require("../script/twitchExtensionStatsSync");

test("entryToViewerStatsPayload converts live activity entries to EBS stats", () => {
  const payload = entryToViewerStatsPayload(
    {
      twitchUserId: "12345",
      login: "alice",
      displayName: "Alice",
      chatEvents: [{ count: 1 }, { count: 3 }],
      emoteCount: 5,
      channelPointsCount: 2,
      uptimeMs: 125_000,
    },
    { source: "bot-test" },
  );

  assert.deepEqual(payload, {
    userId: "12345",
    login: "alice",
    displayName: "Alice",
    source: "bot-test",
    mode: "increment",
    stats: {
      liveMinutes: 2,
      chatMessages: 4,
      emotesUsed: 5,
      channelPointsRedeemed: 2,
    },
  });
});

test("entryToViewerStatsPayload skips missing Twitch ids and empty stats", () => {
  assert.equal(
    entryToViewerStatsPayload({
      login: "alice",
      chatEvents: [{ count: 1 }],
    }),
    null,
  );
  assert.equal(
    entryToViewerStatsPayload({
      twitchUserId: "12345",
      login: "alice",
      chatEvents: [],
      emoteCount: 0,
      channelPointsCount: 0,
      uptimeMs: 0,
    }),
    null,
  );
});

test("entryToViewerStatsPayload rejects unsafe viewer ids and clamps negative counters", () => {
  assert.equal(
    entryToViewerStatsPayload({
      twitchUserId: "bad/viewer",
      login: "alice",
      chatEvents: [{ count: 1 }],
    }),
    null,
  );

  assert.equal(
    entryToViewerStatsPayload({
      twitchUserId: "12345",
      login: "alice",
      chatEvents: [{ count: -12 }],
      emoteCount: -4,
      channelPointsCount: -2,
      uptimeMs: -60_000,
    }),
    null,
  );
});

test("syncEntry posts payload with broadcaster OAuth token", async () => {
  const calls = [];
  const sync = createTwitchExtensionStatsSync({
    enabled: true,
    endpoint: "https://example.test/twitchExtensionViewerStatsWrite",
    includeTokenInBody: true,
    source: "bot-test",
    tokenManager: {
      getAccessToken: async () => "oauth-token",
    },
    axiosClient: {
      post: async (url, body, options) => {
        calls.push({ url, body, options });
        return { data: { ok: true, userId: body.userId } };
      },
    },
    logger: { log() {} },
  });

  const result = await sync.syncEntry({
    twitchUserId: "12345",
    login: "alice",
    displayName: "Alice",
    chatEvents: [{ count: 1 }],
  });

  assert.equal(result.synced, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/twitchExtensionViewerStatsWrite");
  assert.equal(calls[0].options.headers.Authorization, "Bearer oauth-token");
  assert.equal(calls[0].body.twitchToken, "oauth-token");
  assert.equal(calls[0].body.userId, "12345");
  assert.equal(calls[0].body.mode, "increment");
  assert.deepEqual(calls[0].body.stats, {
    liveMinutes: 0,
    chatMessages: 1,
    emotesUsed: 0,
    channelPointsRedeemed: 0,
  });
});

test("syncEntry can post complete counters in set mode", async () => {
  const calls = [];
  const sync = createTwitchExtensionStatsSync({
    enabled: true,
    endpoint: "https://example.test/twitchExtensionViewerStatsWrite",
    includeTokenInBody: false,
    source: "external-total-collector",
    writeMode: "set",
    tokenManager: {
      getAccessToken: async () => "oauth-token",
    },
    axiosClient: {
      post: async (url, body, options) => {
        calls.push({ url, body, options });
        return { data: { ok: true } };
      },
    },
    logger: { log() {} },
  });

  await sync.syncEntry({
    twitchUserId: "12345",
    login: "alice",
    uptimeMs: 60_000,
  });

  assert.equal(calls[0].body.mode, "set");
  assert.equal(calls[0].body.source, "external-total-collector");
  assert.equal(Object.hasOwn(calls[0].body, "twitchToken"), false);
});

test("syncEntry is disabled without endpoint and skips missing token manager", async () => {
  const disabled = createTwitchExtensionStatsSync({
    enabled: true,
    endpoint: "",
  });
  assert.deepEqual(await disabled.syncEntry({ twitchUserId: "123", chatEvents: [{ count: 1 }] }), {
    skipped: true,
    reason: "disabled",
  });

  const missingToken = createTwitchExtensionStatsSync({
    enabled: true,
    endpoint: "https://example.test/write",
  });
  assert.deepEqual(
    await missingToken.syncEntry({ twitchUserId: "123", chatEvents: [{ count: 1 }] }),
    {
      skipped: true,
      reason: "missing_token_manager",
    },
  );
});
