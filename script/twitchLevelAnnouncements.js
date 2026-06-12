"use strict";

function displayMention(value) {
  const clean = String(value || "")
    .trim()
    .replace(/^@+/, "");
  return `@${clean || "viewer"}`;
}

function formatLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Math.floor(n));
}

function buildCommunityLevelUpMessage({ displayName, login, level, rankName } = {}) {
  const safeLevel = formatLevel(level);
  if (!safeLevel) return "";

  const mention = displayMention(displayName || login);
  const cleanRankName = String(rankName || "").trim();
  const rankPart = cleanRankName ? ` - ${cleanRankName}` : "";
  return `GG ${mention}, tu passes niveau ${safeLevel}${rankPart} !`;
}

module.exports = {
  buildCommunityLevelUpMessage,
  displayMention,
};
