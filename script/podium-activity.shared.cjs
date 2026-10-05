"use strict";

const { podiumDayKey } = require("./podium-periods.shared.cjs");
const { isLiveRewardV2 } = require("./live-rewards.shared.cjs");

// Keep scoring, stream dating and tie-breaks aligned with the bot's
// script/weeklyFollowersRecap.js. No rewards or private activity leave this module.
const SCORE_WEIGHTS = Object.freeze({
  presence: 10,
  chatMessage: 5,
  emote: 1,
  channelPoints: 2,
  clips: 8,
  raid: 4,
  chatMessageCapPerStream: 10,
  emoteCapPerStream: 5,
  channelPointsCapPerStream: 10,
  clipsCapPerStream: 5,
});
const EXCLUDED_LOGINS = new Set(["erwayr", "wzbot", "streamelements", "streamstickers"]);
const IDENTITY_FIELDS = [
  "pseudo", "display_name", "displayName", "login", "user_login", "user_name",
  "user_display_name", "display", "creator_login", "creator_name", "__docId", "id",
];

function toNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return toNum(value.toMillis());
  if (typeof value.toDate === "function") return toMillis(value.toDate());
  if (value instanceof Date) return toNum(value.getTime());
  if (typeof value === "number") {
    return toNum(value < 1e12 ? Math.floor(value * 1000) : Math.floor(value));
  }
  if (typeof value === "string") return toNum(Date.parse(value));
  if (typeof value === "object" && value.seconds != null) {
    return Math.floor(toNum(value.seconds) * 1000 + toNum(value.nanoseconds || 0) / 1e6);
  }
  return 0;
}

function normalizeStreams(streams) {
  if (Array.isArray(streams)) return streams;
  if (streams && typeof streams === "object") {
    return Object.keys(streams)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => streams[key])
      .filter((value) => value && typeof value === "object");
  }
  return [];
}

function streamDayKey(stream) {
  const candidates = [
    stream?.presence?.last_at,
    stream?.chat_message?.last_at,
    stream?.emote?.last_at,
    stream?.channel_points?.last_at,
    stream?.raid?.at,
    stream?.started_at,
    stream?.ended_at,
    stream?.at,
    stream?.date,
    stream?.timestamp,
  ];
  // The Discord recap intentionally uses the latest of these timestamps,
  // then day_key. In particular, clips.last_at is not a dating override.
  const timestamp = Math.max(0, ...candidates.map(toMillis));
  if (timestamp > 0 && timestamp <= 8.64e15) return podiumDayKey(new Date(timestamp));
  const fallback = String(stream?.day_key || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : "";
}

function streamMetrics(stream) {
  const presence = stream?.presence?.seen ? 1 : 0;
  const chatMessages = Math.max(0, Math.floor(toNum(
    isLiveRewardV2(stream) ? stream?.podium_activity?.chat_messages || 0
      : stream?.chat_message?.count || (stream?.chat_message?.sent ? 1 : 0),
  )));
  const emote = Math.max(0, Math.floor(toNum(stream?.emote?.count || 0)));
  let channelPoints = Math.max(0, Math.floor(toNum(
    stream?.channel_points?.redemptions || stream?.channel_points?.count || 0,
  )));
  if (!channelPoints && stream?.channel_points?.used) channelPoints = 1;
  const clips = Math.max(0, Math.floor(toNum(stream?.clips?.count || 0)));
  const raids = stream?.raid?.participated ? 1 : 0;
  const watchtimePoints = isLiveRewardV2(stream)
    ? Math.min(72, Math.floor(Math.max(0, toNum(stream?.presence?.uptime_minutes)) / 5)) : 0;
  return { presence, chatMessages, emote, channelPoints, clips, raids, watchtimePoints };
}

function scoreFromMetrics(metrics) {
  return metrics.presence * SCORE_WEIGHTS.presence +
    Math.min(metrics.chatMessages, SCORE_WEIGHTS.chatMessageCapPerStream) * SCORE_WEIGHTS.chatMessage +
    Math.min(metrics.emote, SCORE_WEIGHTS.emoteCapPerStream) * SCORE_WEIGHTS.emote +
    Math.min(metrics.channelPoints, SCORE_WEIGHTS.channelPointsCapPerStream) * SCORE_WEIGHTS.channelPoints +
    Math.min(metrics.clips, SCORE_WEIGHTS.clipsCapPerStream) * SCORE_WEIGHTS.clips +
    metrics.raids * SCORE_WEIGHTS.raid + (metrics.watchtimePoints || 0);
}

function compareActivity(a, b) {
  return b.score - a.score ||
    b.presence - a.presence ||
    b.clips - a.clips ||
    b.chatMessages - a.chatMessages ||
    b.channelPoints - a.channelPoints ||
    b.emote - a.emote ||
    a.pseudo.localeCompare(b.pseudo, "fr", { sensitivity: "base" });
}

function emptyTotals() {
  return { presence: 0, chatMessages: 0, emote: 0, channelPoints: 0, clips: 0, raids: 0, watchtimePoints: 0, score: 0 };
}

function buildActivityRankings(docs = [], ranges = {}) {
  const periodNames = Object.keys(ranges);
  const rows = Object.fromEntries(periodNames.map((name) => [name, []]));
  for (const { id, data = {} } of docs) {
    const identities = [id, ...IDENTITY_FIELDS.map((field) => data[field]),
      ...IDENTITY_FIELDS.map((field) => data.winnerInfo?.[field])];
    if (identities.some((value) => EXCLUDED_LOGINS.has(String(value || "").trim().toLowerCase()))) continue;
    const pseudo = String(data.pseudo || data.display_name || data.displayName || id || "").trim();
    if (!pseudo || !data.live_presence || typeof data.live_presence !== "object") continue;
    const totals = Object.fromEntries(periodNames.map((name) => [name, emptyTotals()]));
    for (const month of Object.values(data.live_presence)) {
      for (const stream of normalizeStreams(month?.streams)) {
        const dayKey = streamDayKey(stream);
        if (!dayKey) continue;
        const metrics = streamMetrics(stream);
        const score = scoreFromMetrics(metrics);
        if (score <= 0) continue;
        for (const name of periodNames) {
          if (dayKey < ranges[name].startKey || dayKey > ranges[name].endKey) continue;
          for (const field of Object.keys(metrics)) totals[name][field] += metrics[field];
          totals[name].score += score;
        }
      }
    }
    for (const name of periodNames) {
      if (totals[name].score <= 0) continue;
      rows[name].push({
        id: String(id),
        pseudo,
        avatar: String(data.avatarUrl || data.avatar || data.profile_image_url || ""),
        ...totals[name],
      });
    }
  }
  for (const name of periodNames) rows[name].sort(compareActivity);
  return rows;
}

module.exports = { buildActivityRankings, streamMetrics, scoreFromMetrics, compareActivity };
