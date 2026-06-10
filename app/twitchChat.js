"use strict";

const axios = require("axios");
const tmi = require("tmi.js");
const { isExcludedLogin } = require("../helper/excludedUsers");
const { createTwitchChatCommands } = require("../script/twitchChatCommands");

function createTwitchChat({
  config,
  db,
  helix,
  tokenManager,
  questStore,
  livePresenceTick,
  birthdays,
  getCommunityLevelConfig,
}) {
  let CHANNEL_EMOTE_IDS = new Set();
  let CHANNEL_EMOTE_NAMES = new Set();
  let lastEmoteRefreshAt = 0;
  let lastLiveStateFetchAt = 0;
  let liveStreamStateCache = { streamId: null, startedAt: null, cachedAt: 0 };
  let chatQuestStreamId = null;
  const CHAT_MESSAGE_SCORE_CAP_PER_STREAM = 10;
  const chatMessageCountsByLogin = new Map();

  function buildTwitchHeaders(accessToken, { includeContentType = true } = {}) {
    const headers = {
      "Client-ID": config.twitch.clientId,
      Authorization: `Bearer ${accessToken}`,
    };
    if (includeContentType) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function refreshChannelEmotes() {
    try {
      const { data } = await helix({
        url: config.urls.helixEmotes,
        params: { broadcaster_id: config.twitch.channelId },
      });
      const list = data?.data || [];
      CHANNEL_EMOTE_IDS = new Set(list.map((e) => String(e.id)));
      CHANNEL_EMOTE_NAMES = new Set(list.map((e) => e.name));
      const sample = list
        .slice(0, 5)
        .map((e) => e.name)
        .join(", ");
      console.log(
        `🎭 Emotes de chaîne chargées: ${CHANNEL_EMOTE_IDS.size} (sample: ${
          sample || "—"
        })`,
      );
    } catch (e) {
      console.warn("⚠️ refreshChannelEmotes:", e?.response?.data || e.message);
    }
  }

  async function refreshChannelEmotesThrottled() {
    const now = Date.now();
    if (now - lastEmoteRefreshAt < config.timing.emoteRefreshMinIntervalMs) {
      return;
    }
    lastEmoteRefreshAt = now;
    await refreshChannelEmotes();
  }

  async function fetchLiveStreamState() {
    const { data } = await helix({
      url: "https://api.twitch.tv/helix/streams",
      params: { user_id: config.twitch.channelId, first: 1 },
    });
    const s = data?.data?.[0];
    const now = Date.now();

    if (!s) {
      liveStreamStateCache = { streamId: null, startedAt: null, cachedAt: now };
      return null;
    }

    const startedAt = s.started_at ? new Date(s.started_at) : null;
    liveStreamStateCache = { streamId: s.id, startedAt, cachedAt: now };
    return { streamId: s.id, startedAt };
  }

  async function getLiveStreamStateForEmotes() {
    const state = livePresenceTick.getLiveStreamState();
    if (state.streamId) {
      liveStreamStateCache = {
        streamId: state.streamId,
        startedAt: state.startedAt || null,
        cachedAt: Date.now(),
      };
      return state;
    }

    const now = Date.now();
    if (
      liveStreamStateCache.streamId &&
      now - liveStreamStateCache.cachedAt < config.timing.liveStateCacheMs
    ) {
      return {
        streamId: liveStreamStateCache.streamId,
        startedAt: liveStreamStateCache.startedAt,
      };
    }

    if (now - lastLiveStateFetchAt < config.timing.liveStateRefreshMinIntervalMs) {
      return { streamId: null, startedAt: null };
    }

    lastLiveStateFetchAt = now;

    try {
      return (
        (await fetchLiveStreamState()) || {
          streamId: null,
          startedAt: null,
        }
      );
    } catch (e) {
      if (process.env.DEBUG_EMOTES) {
        console.warn(
          "[emotes] live stream fetch failed:",
          e?.response?.data || e?.message || e,
        );
      }
      return { streamId: null, startedAt: null };
    }
  }

  async function sendTwitchChatMessage(message) {
    const accessToken = await tokenManager.getAccessToken();

    const { data } = await axios.post(
      config.urls.helixChatMessages,
      {
        broadcaster_id: config.twitch.channelId,
        sender_id: config.twitch.moderatorId,
        message,
      },
      {
        headers: buildTwitchHeaders(accessToken),
      },
    );

    const r = data?.data?.[0];
    if (!r?.is_sent) {
      console.warn("⚠️ Chat message dropped:", r?.drop_reason || r);
    }
  }

  const twitchChatCommands = createTwitchChatCommands({
    db,
    config: config.twitchCommands,
    getCommunityLevelConfig,
    sendTwitchChatMessage,
  });

  const tmiClient = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    channels: [config.twitch.channelLogin],
  });

  tmiClient.on("connected", async () => {
    await refreshChannelEmotesThrottled();
  });

  tmiClient.on("message", async (channel, tags, msg, self) => {
    if (self) return;
    const login = (tags.username || "").toLowerCase();
    if (!login) return;
    if (isExcludedLogin(login)) return;

    birthdays.maybeSendBirthdayCongrats(login, sendTwitchChatMessage).catch((e) =>
      console.warn("birthday congrats failed:", e?.message || e),
    );

    if (!CHANNEL_EMOTE_IDS.size && !CHANNEL_EMOTE_NAMES.size) {
      await refreshChannelEmotesThrottled();
    }

    const liveState = await getLiveStreamStateForEmotes();
    const streamId = liveState.streamId;
    if (!streamId) {
      if (process.env.DEBUG_EMOTES) {
        console.log(
          `[emotes:skip] no live streamId | from=${login} msg="${msg.slice(0, 80)}"`,
        );
      }
      return;
    }

    try {
      const commandResult = await twitchChatCommands.handleMessage({
        login,
        displayName: tags["display-name"] || tags.displayName || tags.username || login,
        message: msg,
      });
      if (commandResult?.handled) return;
    } catch (e) {
      console.warn("twitch chat command failed:", e?.message || e);
      return;
    }

    if (chatQuestStreamId !== streamId) {
      chatQuestStreamId = streamId;
      chatMessageCountsByLogin.clear();
    }
    if (
      (chatMessageCountsByLogin.get(login) || 0) <
      CHAT_MESSAGE_SCORE_CAP_PER_STREAM
    ) {
      try {
        const chatProgress = await questStore.noteChatMessage(login, streamId, 1, {
          startedAt: liveState.startedAt,
        });
        if (process.env.DEBUG_COMMUNITY_LEVEL && chatProgress?.levelAwarded) {
          console.log(
            `[community-level] ${login} +${chatProgress.levelXp} xp -> level ${chatProgress.level}`,
          );
        }
        const nextCount = Math.max(
          Number(chatMessageCountsByLogin.get(login) || 0),
          Number(chatProgress?.count || 0),
        );
        chatMessageCountsByLogin.set(
          login,
          Math.min(CHAT_MESSAGE_SCORE_CAP_PER_STREAM, nextCount),
        );
      } catch (e) {
        console.warn("noteChatMessage failed:", e?.message || e);
      }
    }

    const emotesObj = tags.emotes || null;

    if (process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:raw] from=${login} stream=${streamId} hasEmotes=${!!emotesObj} msg="${msg.slice(
          0,
          80,
        )}"`,
      );
      if (emotesObj) {
        const keys = Object.keys(emotesObj);
        console.log(`  keys=${keys.join(",") || "(none)"}`);
        keys.slice(0, 8).forEach((id) => {
          const tag = CHANNEL_EMOTE_IDS.has(String(id)) ? "mine" : "other";
          console.log(
            `  └ id=${id} tag=${tag} count=${emotesObj[id]?.length || 0}`,
          );
        });
      }
      if (CHANNEL_EMOTE_IDS.size === 0) {
        console.log(
          "⚠️ CHANNEL_EMOTE_IDS est vide — refreshChannelEmotes n'a peut-être pas marché.",
        );
      }
    }

    if (!emotesObj) {
      let incByName = 0;
      if (CHANNEL_EMOTE_NAMES.size) {
        for (const token of msg.split(/\s+/)) {
          if (CHANNEL_EMOTE_NAMES.has(token)) incByName += 1;
        }
      }
      if (incByName > 0) {
        console.log(
          `[emotes:fallback-name] ${login} +${incByName} msg="${msg.slice(
            0,
            80,
          )}"`,
        );
        try {
          await questStore.noteEmoteUsage(login, streamId, incByName, {
            startedAt: liveState.startedAt,
          });
          console.log(
            `[emotes→DB] OK fallback-name | ${login} +${incByName} stream=${streamId}`,
          );
        } catch (e) {
          console.error(
            `[emotes→DB] FAIL fallback-name | ${login} +${incByName} stream=${streamId}`,
          );
          console.error(e?.stack || e?.message || e);
        }
      } else if (process.env.DEBUG_EMOTES) {
        console.log(
          `[emotes:skip] no twitch emote & no fallback-name match | from=${login}`,
        );
      }
      return;
    }

    const idsInMsg = Object.keys(emotesObj);
    const hasChannelList = CHANNEL_EMOTE_IDS.size > 0;
    const matchedIds = hasChannelList
      ? idsInMsg.filter((id) => CHANNEL_EMOTE_IDS.has(String(id)))
      : idsInMsg;
    let inc = matchedIds.reduce(
      (sum, id) => sum + (emotesObj[id]?.length || 0),
      0,
    );

    if (!hasChannelList && inc > 0 && process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:unfiltered] ${login} +${inc} ids=${matchedIds.join(",")}`,
      );
    }

    if (inc === 0 && CHANNEL_EMOTE_NAMES.size) {
      for (const token of msg.split(/\s+/)) {
        if (CHANNEL_EMOTE_NAMES.has(token)) inc += 1;
      }
      if (inc > 0) {
        console.log(
          `[emotes:fallback-name] ${login} +${inc} msg="${msg.slice(0, 80)}"`,
        );
      }
    }

    if (inc <= 0) {
      if (process.env.DEBUG_EMOTES) {
        console.log(
          `[emotes:skip] detected emotes but none are YOUR channel emotes | from=${login}`,
        );
      }
      return;
    }

    const idsLabel =
      matchedIds.join(",") || (hasChannelList ? "-" : "unfiltered");
    console.log(
      `[emotes] ${login} +${inc} (ids=${idsLabel}) msg="${msg.slice(0, 80)}"`,
    );
    try {
      await questStore.noteEmoteUsage(login, streamId, inc, {
        startedAt: liveState.startedAt,
      });
      console.log(`[emotes→DB] OK | ${login} +${inc} stream=${streamId}`);
    } catch (e) {
      console.error(`[emotes→DB] FAIL | ${login} +${inc} stream=${streamId}`);
      console.error(e?.stack || e?.message || e);
    }
  });

  function start() {
    tmiClient.connect().catch(console.error);
    return tmiClient;
  }

  return {
    start,
    tmiClient,
    refreshChannelEmotes,
    refreshChannelEmotesThrottled,
    sendTwitchChatMessage,
  };
}

module.exports = { createTwitchChat };
