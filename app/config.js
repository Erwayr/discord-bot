"use strict";

const { EXCLUDED_USER_NAMES } = require("../helper/excludedUsers");

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

  timezone: process.env.TIMEZONE || "Europe/Warsaw",

  birthdays: {
    field: process.env.BIRTHDAY_FIELD || "birthday",
    indexCollection:
      process.env.BIRTHDAY_INDEX_COLLECTION || "birthdays_index",
    indexMetaDoc:
      process.env.BIRTHDAY_INDEX_META_DOC || "settings/birthday_index_meta",
    indexMaxAgeHours: Number(process.env.BIRTHDAY_INDEX_MAX_AGE_HOURS || 0),
    indexFallbackScan: process.env.BIRTHDAY_INDEX_FALLBACK_SCAN === "1",
    displayFields: ["display_name", "displayName", "pseudo"],
    indexVersion: 2,
  },

  cron: {
    pollClips: "*/5 * * * *",
    tokenKeepalive: process.env.CRON_TOKEN_KEEPALIVE || "0 */6 * * *",
    livePresence: "*/2 * * * *",
    birthdayRefresh: "0 0 * * *",
    assignOldMemberCards: "0 0 * * *",
    emoteRefresh: "0 */6 * * *",
    weeklyRecap: process.env.CRON_WEEKLY_RECAP || "0 9 * * 1",
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
