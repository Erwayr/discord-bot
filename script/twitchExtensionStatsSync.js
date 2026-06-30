"use strict";

const axios = require("axios");

const MS_PER_MINUTE = 60_000;
const DEFAULT_SOURCE = "discord-bot-live-activity";

function bool(value) {
  return !["0", "false", "no", "off"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function text(value, max = 160) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function safeInt(value) {
  const number = Math.floor(Number(value) || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function chatEventCount(event) {
  if (!event || event.count == null || event.count === "") return 1;
  return safeInt(event.count);
}

function sumChatEvents(events) {
  return Array.isArray(events)
    ? events.reduce((sum, event) => sum + chatEventCount(event), 0)
    : 0;
}

function validViewerId(value) {
  const id = text(value, 80);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

function normalizeWriteMode(value) {
  const mode = text(value, 40).toLowerCase();
  if (["set", "replace"].includes(mode)) return "set";
  return "increment";
}

function entryToViewerStatsPayload(
  entry = {},
  { source = DEFAULT_SOURCE, writeMode = "increment" } = {},
) {
  const userId = validViewerId(entry.twitchUserId || entry.userId);
  if (!userId) return null;

  const stats = {
    presenceStreams: safeInt(entry.presenceFirstSeenAtMs) > 0 ? 1 : 0,
    liveMinutes: Math.floor(safeInt(entry.uptimeMs) / MS_PER_MINUTE),
    chatMessages: sumChatEvents(entry.chatEvents),
    emotesUsed: safeInt(entry.emoteCount),
    channelPointsRedeemed: safeInt(entry.channelPointsCount),
  };
  if (!Object.values(stats).some((value) => value > 0)) return null;

  return {
    userId,
    login: text(entry.login, 120).toLowerCase(),
    displayName: text(entry.displayName || entry.login, 120),
    source,
    mode: normalizeWriteMode(writeMode),
    stats,
  };
}

function createTwitchExtensionStatsSync({
  enabled = false,
  endpoint = "",
  includeTokenInBody = false,
  source = DEFAULT_SOURCE,
  writeMode = "increment",
  tokenManager = null,
  axiosClient = axios,
  logger = console,
} = {}) {
  const url = text(endpoint, 500);
  const active = bool(enabled) && Boolean(url);

  async function syncEntry(entry) {
    if (!active) return { skipped: true, reason: "disabled" };
    const payload = entryToViewerStatsPayload(entry, { source, writeMode });
    if (!payload) return { skipped: true, reason: "empty_or_missing_user_id" };
    if (!tokenManager?.getAccessToken) {
      return { skipped: true, reason: "missing_token_manager" };
    }

    const token = await tokenManager.getAccessToken();
    const body = includeTokenInBody ? { ...payload, twitchToken: token } : payload;
    const response = await axiosClient.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (response?.data?.ok === false) {
      throw new Error(response.data.error || "twitch_extension_stats_sync_failed");
    }
    if (logger?.log) {
      logger.log(
        `[twitch-extension-stats] synced ${payload.login || payload.userId} presence=${payload.stats.presenceStreams} live=${payload.stats.liveMinutes} chat=${payload.stats.chatMessages} emotes=${payload.stats.emotesUsed} points=${payload.stats.channelPointsRedeemed}`,
      );
    }
    return { synced: true, payload, response: response?.data || null };
  }

  return {
    enabled: active,
    syncEntry,
  };
}

module.exports = {
  DEFAULT_SOURCE,
  entryToViewerStatsPayload,
  createTwitchExtensionStatsSync,
  normalizeWriteMode,
};
