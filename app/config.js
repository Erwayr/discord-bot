"use strict";

const { EXCLUDED_USER_NAMES } = require("../helper/excludedUsers");

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

const config = {
  discord: {
    logChannelId: process.env.LOG_CHANNEL_ID || "1377870229153120257",
    generalChannelId:
      process.env.GENERAL_CHANNEL_ID || "797077170974490645",
    bootyChannelId:
      process.env.BOOTY_CHANNEL_ID || "948504568969449513",
    announcementChannelId:
      process.env.ANNOUNCEMENT_CHANNEL_ID || "827682574024966194",
    clipChannelId:
      process.env.CLIP_CHANNEL_ID ||
      process.env.clip_channel_id ||
      "839642015444762654",
    botToken: process.env.DISCORD_BOT_TOKEN,
    guildId: process.env.DISCORD_GUILD_ID || "",
  },

  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    channelId: process.env.TWITCH_CHANNEL_ID,
    moderatorId:
      process.env.TWITCH_MODERATOR_ID || process.env.TWITCH_CHANNEL_ID,
    channelLogin: process.env.TWITCH_CHANNEL_LOGIN || "erwayr",
    webhookSecret: process.env.WEBHOOK_SECRET,
    internalApiKey: process.env.INTERNAL_API_KEY,
    tokenDocPath: "settings/twitch_moderator",
    eventsubCallback:
      process.env.TWITCH_EVENTSUB_CALLBACK ||
      "https://discord-bot-production-95c5.up.railway.app/twitch-callback",
    oauthRedirect:
      process.env.TWITCH_OAUTH_REDIRECT ||
      "https://discord-bot-production-95c5.up.railway.app/auth/twitch/callback",
    ticketRewardId: process.env.TICKET_REWARD_ID || null,
  },

  urls: {
    collection: process.env.COLLECTION_URL || "https://erwayr.online",
    eventsub: "https://api.twitch.tv/helix/eventsub/subscriptions",
    oauthToken: "https://id.twitch.tv/oauth2/token",
    oauthValidate: "https://id.twitch.tv/oauth2/validate",
    helixChatters: "https://api.twitch.tv/helix/chat/chatters",
    helixChatMessages: "https://api.twitch.tv/helix/chat/messages",
    helixEmotes: "https://api.twitch.tv/helix/chat/emotes",
  },

  firestore: {
    enableListener: process.env.FIRESTORE_ENABLE_LISTENER !== "0",
    preferRest: process.env.FIRESTORE_PREFER_REST !== "0",
  },

  overlay: {
    eventsCollection: process.env.OVERLAY_EVENTS_COLLECTION || "overlay_events",
    cardEventType: process.env.OVERLAY_CARD_EVENT_TYPE || "reward_ma_carte",
    cardRewardId:
      process.env.OVERLAY_CARD_REWARD_ID ||
      process.env.MA_CARTE_REWARD_ID ||
      "",
    cardRewardTitle:
      process.env.OVERLAY_CARD_REWARD_TITLE ||
      process.env.MA_CARTE_REWARD_TITLE ||
      "ma carte",
  },

  timezone: process.env.TIMEZONE || "Europe/Warsaw",

  birthdays: {
    field: process.env.BIRTHDAY_FIELD || "birthday",
    indexCollection:
      process.env.BIRTHDAY_INDEX_COLLECTION || "birthdays_index",
    indexMetaDoc:
      process.env.BIRTHDAY_INDEX_META_DOC || "settings/birthday_index_meta",
    discordAnnouncementCollection:
      process.env.BIRTHDAY_DISCORD_ANNOUNCEMENT_COLLECTION ||
      "birthday_discord_announcements",
    indexMaxAgeHours: Number(process.env.BIRTHDAY_INDEX_MAX_AGE_HOURS || 0),
    indexFallbackScan: process.env.BIRTHDAY_INDEX_FALLBACK_SCAN === "1",
    displayFields: ["display_name", "displayName", "pseudo"],
    indexVersion: 3,
  },

  cron: {
    pollClips: "*/5 * * * *",
    tokenKeepalive: process.env.CRON_TOKEN_KEEPALIVE || "0 */6 * * *",
    livePresence: "*/2 * * * *",
    birthdayRefresh: "0 0 * * *",
    assignOldMemberCards: "0 0 * * *",
    assignServerBoosterCards:
      process.env.CRON_ASSIGN_SERVER_BOOSTER_CARDS || "0 0 * * *",
    emoteRefresh: "0 */6 * * *",
    weeklyRecap: process.env.CRON_WEEKLY_RECAP || "0 9 * * 1",
    weeklyPlanning: process.env.CRON_WEEKLY_PLANNING || "0 9 * * 1",
  },

  weeklyRecap: {
    excludedLogins: Array.from(
      new Set(
        String(process.env.WEEKLY_RECAP_EXCLUDED_LOGINS || "erwayr")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .concat(EXCLUDED_USER_NAMES),
      ),
    ),
    bonusPct: Number(process.env.WEEKLY_RECAP_BONUS_PCT || 10),
    rankRewards: [
      {
        rank: 1,
        bonusPct: Number(
          process.env.WEEKLY_RECAP_RANK1_BONUS_PCT ||
            process.env.WEEKLY_RECAP_BONUS_PCT ||
            10,
        ),
        popsReward: Number(process.env.WEEKLY_RECAP_RANK1_POPS || 100),
      },
      {
        rank: 2,
        bonusPct: Number(process.env.WEEKLY_RECAP_RANK2_BONUS_PCT || 5),
        popsReward: Number(process.env.WEEKLY_RECAP_RANK2_POPS || 50),
      },
      {
        rank: 3,
        bonusPct: Number(process.env.WEEKLY_RECAP_RANK3_BONUS_PCT || 2),
        popsReward: Number(process.env.WEEKLY_RECAP_RANK3_POPS || 25),
      },
    ],
  },

  communityLevel: {
    enabled: boolEnv("COMMUNITY_LEVEL_ENABLED", true),
    chatXp: numberEnv("COMMUNITY_LEVEL_CHAT_XP", 10),
    chatCooldownMs: numberEnv("COMMUNITY_LEVEL_CHAT_COOLDOWN_MS", 60_000),
    chatXpCapPerStream: numberEnv("COMMUNITY_LEVEL_CHAT_XP_CAP_PER_STREAM", 1200),
    presenceXp: numberEnv("COMMUNITY_LEVEL_PRESENCE_XP", 200),
    presenceXpCapPerStream: numberEnv(
      "COMMUNITY_LEVEL_PRESENCE_XP_CAP_PER_STREAM",
      200,
    ),
    channelPointsXp: numberEnv("COMMUNITY_LEVEL_CHANNEL_POINTS_XP", 5),
    channelPointsXpCapPerStream: numberEnv(
      "COMMUNITY_LEVEL_CHANNEL_POINTS_XP_CAP_PER_STREAM",
      50,
    ),
    baseXp: numberEnv("COMMUNITY_LEVEL_BASE_XP", 100),
    growthXp: numberEnv("COMMUNITY_LEVEL_GROWTH_XP", 25),
    maxLevel: numberEnv("COMMUNITY_LEVEL_MAX_LEVEL", 999),
    legacyDoubleWrite: boolEnv("COMMUNITY_LEVEL_LEGACY_DOUBLE_WRITE", false),
    rankCron: process.env.CRON_COMMUNITY_LEVEL_RANKS || "*/10 * * * *",
    rankBatchSize: numberEnv("COMMUNITY_LEVEL_RANK_BATCH_SIZE", 400),
  },

  twitchCommands: {
    userCooldownMs: numberEnv("TWITCH_COMMAND_USER_COOLDOWN_MS", 10_000),
    globalCooldownMs: numberEnv("TWITCH_COMMAND_GLOBAL_COOLDOWN_MS", 2_000),
  },

  planning: {
    reviewChannelId:
      process.env.PLANNING_REVIEW_CHANNEL_ID ||
      process.env.LOG_CHANNEL_ID ||
      "1377870229153120257",
    publicChannelId:
      process.env.PLANNING_PUBLIC_CHANNEL_ID ||
      process.env.ANNOUNCEMENT_CHANNEL_ID ||
      "827682574024966194",
    approverUserIds: process.env.PLANNING_APPROVER_USER_IDS || "",
  },

  timing: {
    emoteRefreshMinIntervalMs: 5 * 60 * 1000,
    liveStateRefreshMinIntervalMs: 60_000,
    liveStateCacheMs: 2 * 60 * 1000,
    subDebounceMs: 3500,
    subCooldownMs: 10_000,
    offlineConfirmTicks: 2,
  },

  batchSize: 10,
};

module.exports = config;
