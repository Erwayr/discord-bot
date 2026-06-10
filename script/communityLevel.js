"use strict";

const DEFAULT_RANK_TITLES = Object.freeze([
  { min: 0, label: "minimoys" },
  { min: 10, label: "Newbie" },
  { min: 20, label: "Apprenti follower" },
  { min: 30, label: "Conducteur de bus" },
  { min: 40, label: "Destructeur d' ASMR" },
  { min: 50, label: "Chevalier talentueux" },
  { min: 60, label: "Grand duc du comte" },
  { min: 70, label: "Dr hakim en puissance" },
  { min: 80, label: "Maitre du bourgeois orion" },
  { min: 90, label: "Adorateur de la chaine" },
  { min: 100, label: "Maitre Pixel" },
  { min: 110, label: "Maitre du cosmos" },
  { min: 150, label: "Ultra instinct" },
]);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  chatXp: 1,
  chatCooldownMs: 60_000,
  chatXpCapPerStream: 120,
  baseXp: 100,
  growthXp: 25,
  maxLevel: 999,
  legacyDoubleWrite: true,
  rankBatchSize: 400,
});

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback = 0) {
  return Math.floor(toNumber(value, fallback));
}

function positiveInt(value, fallback) {
  const n = toInt(value, fallback);
  return n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = toInt(value, fallback);
  return n >= 0 ? n : fallback;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function normalizeRankTitles(rawTitles) {
  const source = Array.isArray(rawTitles) && rawTitles.length
    ? rawTitles
    : DEFAULT_RANK_TITLES;
  const byMin = new Map();

  source.forEach((row) => {
    if (!row || typeof row !== "object") return;
    const rawMin = Number(row.min);
    if (!Number.isFinite(rawMin)) return;
    const min = Math.max(0, Math.floor(rawMin));
    const label = firstText(row.label, row.name, row.title);
    if (!label) return;
    byMin.set(min, { min, label });
  });

  const titles = Array.from(byMin.values()).sort((a, b) => a.min - b.min);
  return titles.length
    ? titles
    : DEFAULT_RANK_TITLES.map((row) => ({ ...row }));
}

function explicitRankName(source = {}) {
  const community = communitySource(source);
  return firstText(
    community.rankName,
    community.title,
    source.communityRankName,
    source.wizebotRankName,
  );
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof value.toMillis === "function") return Number(value.toMillis()) || 0;
  if (typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  }
  if (value.seconds != null) {
    return Math.floor(toNumber(value.seconds) * 1000 + toNumber(value.nanoseconds) / 1e6);
  }
  return 0;
}

function parseUptimeTextToMinutes(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Math.max(0, Math.floor(value * 60));

  const text = String(value).trim();
  if (!text) return 0;

  let minutes = 0;
  const dayMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:d|j|jour|jours)\b/i);
  const hourMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:h|heure|heures)\b/i);
  const minMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m|min|minute|minutes)\b/i);
  const secMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:s|sec|seconde|secondes)\b/i);

  if (dayMatch) minutes += Math.floor(Number(dayMatch[1].replace(",", ".")) * 1440);
  if (hourMatch) minutes += Math.floor(Number(hourMatch[1].replace(",", ".")) * 60);
  if (minMatch) minutes += Math.floor(Number(minMatch[1].replace(",", ".")));
  if (secMatch) minutes += Math.floor(Number(secMatch[1].replace(",", ".")) / 60);

  if (minutes > 0) return minutes;

  const numeric = Number(text.replace(",", "."));
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric * 60)) : 0;
}

function formatUptimeMinutes(minutes) {
  const total = Math.max(0, Math.floor(Number(minutes) || 0));
  if (total <= 0) return "";
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours <= 0) return `${mins}m`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function titleForLevel(level, rankTitles = DEFAULT_RANK_TITLES) {
  const lvl = Number.isFinite(Number(level)) ? Number(level) : 0;
  const titles = normalizeRankTitles(rankTitles);
  let current = titles[0].label;
  for (const title of titles) {
    if (lvl >= title.min) current = title.label;
    else break;
  }
  return current;
}

function resolveCommunityLevelConfig(raw = {}) {
  const rankTitles = normalizeRankTitles(raw.rankTitles || raw.titles);
  return {
    enabled: raw.enabled !== false,
    chatXp: positiveInt(raw.chatXp, DEFAULT_CONFIG.chatXp),
    chatCooldownMs: nonNegativeInt(raw.chatCooldownMs, DEFAULT_CONFIG.chatCooldownMs),
    chatXpCapPerStream: nonNegativeInt(
      raw.chatXpCapPerStream,
      DEFAULT_CONFIG.chatXpCapPerStream,
    ),
    baseXp: positiveInt(raw.baseXp, DEFAULT_CONFIG.baseXp),
    growthXp: nonNegativeInt(raw.growthXp, DEFAULT_CONFIG.growthXp),
    maxLevel: positiveInt(raw.maxLevel, DEFAULT_CONFIG.maxLevel),
    legacyDoubleWrite: raw.legacyDoubleWrite !== false,
    rankBatchSize: positiveInt(raw.rankBatchSize, DEFAULT_CONFIG.rankBatchSize),
    rankTitles,
  };
}

function communitySource(source = {}) {
  if (isObject(source.communityLevel)) return source.communityLevel;
  if (isObject(source.leveling)) return source.leveling;
  return {};
}

function normalizeCommunityLevel(source = {}, rawConfig = {}) {
  const config = resolveCommunityLevelConfig(rawConfig);
  const community = communitySource(source);
  const uptimeText = firstText(
    community.uptimeText,
    community.uptimeLabel,
    source.communityUptimeText,
    source.wizebotUptime,
  );
  const uptimeMinutes = toInt(
    firstDefined(
      community.uptimeMinutes,
      community.uptime_min,
      source.communityUptimeMinutes,
    ),
    parseUptimeTextToMinutes(uptimeText),
  );
  const level = toInt(
    firstDefined(community.level, source.communityLevelValue, source.wizebotLevel),
    0,
  );

  return {
    rank: toInt(firstDefined(community.rank, source.communityRank, source.wizebotRank), 0),
    level,
    xpTotal: toInt(
      firstDefined(
        community.xpTotal,
        community.exp,
        community.xp,
        source.communityXpTotal,
        source.wizebotExp,
      ),
      0,
    ),
    xpInLevel: toInt(firstDefined(community.xpInLevel, community.progressXp), 0),
    xpForNext: toInt(firstDefined(community.xpForNext), 0),
    rankName: explicitRankName(source) || titleForLevel(level, config.rankTitles),
    uptimeText: uptimeText || formatUptimeMinutes(uptimeMinutes),
    uptimeMinutes,
    uptimeRank: toInt(
      firstDefined(community.uptimeRank, source.communityUptimeRank, source.wizebotUptimeRank),
      0,
    ),
    chatMessages: toInt(firstDefined(community.chatMessages), 0),
    chatXpTotal: toInt(firstDefined(community.chatXpTotal), 0),
    source: firstText(community.source, source.wizebotSource),
    updatedAt: firstDefined(community.updatedAt, source.communityLevelUpdatedAt, source.wizebotUpdatedAt),
  };
}

function hasCommunityLevelData(source = {}) {
  if (!isObject(source)) return false;
  const community = communitySource(source);
  return [
    community.rank,
    community.level,
    community.xpTotal,
    community.rankName,
    community.uptimeText,
    community.uptimeMinutes,
    source.communityRank,
    source.communityLevelValue,
    source.communityXpTotal,
    source.wizebotRank,
    source.wizebotLevel,
    source.wizebotExp,
    source.wizebotRankName,
    source.wizebotUptime,
  ].some((value) => value !== undefined && value !== null && value !== "");
}

function xpRequiredForNextLevel(level, rawConfig = {}) {
  const config = resolveCommunityLevelConfig(rawConfig);
  const lvl = Math.max(1, toInt(level, 1));
  return config.baseXp + config.growthXp * Math.max(0, lvl - 1);
}

function extractCommunityLevelFields(source = {}, rawConfig = {}) {
  if (!hasCommunityLevelData(source)) return {};
  const config = resolveCommunityLevelConfig(rawConfig);
  const normalized = normalizeCommunityLevel(source);
  const level = Math.max(1, normalized.level || 1);
  const next = {
    communityLevel: {
      rank: normalized.rank,
      level,
      xpTotal: normalized.xpTotal,
      xpInLevel: Math.max(0, normalized.xpInLevel),
      xpForNext: normalized.xpForNext || xpRequiredForNextLevel(level, config),
      rankName: normalized.rankName || titleForLevel(level, config.rankTitles),
      uptimeText: normalized.uptimeText,
      uptimeMinutes: normalized.uptimeMinutes,
      uptimeRank: normalized.uptimeRank,
      chatMessages: normalized.chatMessages,
      chatXpTotal: normalized.chatXpTotal,
    },
  };
  if (normalized.source) next.communityLevel.source = normalized.source;
  if (normalized.updatedAt !== undefined) next.communityLevel.updatedAt = normalized.updatedAt;
  return next;
}

function applyChatMessageLevelProgress({
  data = {},
  entry,
  streamId,
  nowMs = Date.now(),
  rawConfig = {},
} = {}) {
  const config = resolveCommunityLevelConfig(rawConfig);
  if (!config.enabled) return { awarded: false, reason: "disabled" };
  if (!entry || typeof entry !== "object") return { awarded: false, reason: "missing_entry" };

  entry.community_level = {
    xp: 0,
    messages: 0,
    first_xp_at: null,
    last_xp_at: null,
    ...(entry.community_level || {}),
  };

  const lastAwardMs = Math.max(
    toMillis(entry.community_level.last_xp_at),
    toMillis(data?.communityLevel?.lastChatXpAt),
  );
  if (config.chatCooldownMs > 0 && lastAwardMs > 0 && nowMs - lastAwardMs < config.chatCooldownMs) {
    return { awarded: false, reason: "cooldown" };
  }

  const streamXpBefore = Math.max(0, toInt(entry.community_level.xp, 0));
  if (config.chatXpCapPerStream > 0 && streamXpBefore >= config.chatXpCapPerStream) {
    return { awarded: false, reason: "stream_cap" };
  }

  const awardXp =
    config.chatXpCapPerStream > 0
      ? Math.min(config.chatXp, config.chatXpCapPerStream - streamXpBefore)
      : config.chatXp;
  if (awardXp <= 0) return { awarded: false, reason: "no_xp" };

  const existingCommunity = isObject(data.communityLevel) ? data.communityLevel : {};
  const current = normalizeCommunityLevel(data, config);
  let level = Math.max(1, current.level || 1);
  let xpInLevel = Math.max(0, current.xpInLevel || 0) + awardXp;
  const xpTotal = Math.max(0, current.xpTotal || 0) + awardXp;
  let leveledUp = false;

  while (level < config.maxLevel) {
    const needed = xpRequiredForNextLevel(level, config);
    if (xpInLevel < needed) break;
    xpInLevel -= needed;
    level += 1;
    leveledUp = true;
  }

  const xpForNext = xpRequiredForNextLevel(level, config);
  const rankName = titleForLevel(level, config.rankTitles);
  const nextCommunityLevel = {
    ...existingCommunity,
    rank: current.rank,
    level,
    xpTotal,
    xpInLevel,
    xpForNext,
    rankName,
    uptimeText: current.uptimeText,
    uptimeMinutes: current.uptimeMinutes,
    uptimeRank: current.uptimeRank,
    chatMessages: Math.max(0, toInt(existingCommunity.chatMessages, current.chatMessages)) + 1,
    chatXpTotal: Math.max(0, toInt(existingCommunity.chatXpTotal, current.chatXpTotal)) + awardXp,
    lastChatXpAt: nowMs,
    lastStreamId: streamId || existingCommunity.lastStreamId || null,
    source: "twitch_chat",
    updatedAt: nowMs,
  };

  entry.community_level.xp = streamXpBefore + awardXp;
  entry.community_level.messages = Math.max(0, toInt(entry.community_level.messages, 0)) + 1;
  if (!entry.community_level.first_xp_at) entry.community_level.first_xp_at = nowMs;
  entry.community_level.last_xp_at = nowMs;

  const legacyFields = config.legacyDoubleWrite
    ? {
        wizebotLevel: level,
        wizebotExp: xpTotal,
        wizebotRankName: rankName,
        wizebotUpdatedAt: nowMs,
      }
    : {};
  if (config.legacyDoubleWrite && current.rank > 0) legacyFields.wizebotRank = current.rank;

  return {
    awarded: true,
    awardXp,
    level,
    xpTotal,
    xpInLevel,
    xpForNext,
    leveledUp,
    communityLevel: nextCommunityLevel,
    legacyFields,
  };
}

async function recalculateCommunityLevelRanks(db, rawConfig = {}) {
  const config = resolveCommunityLevelConfig(rawConfig);
  if (!config.enabled) return { updated: 0, skipped: true };

  const snap = await db.collection("followers_all_time").get();
  const rows = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (!hasCommunityLevelData(data)) return;
    const community = normalizeCommunityLevel(data, config);
    if (community.level <= 0 && community.xpTotal <= 0) return;
    rows.push({
      doc,
      data,
      community,
      login: String(data.pseudo || doc.id || "").toLowerCase(),
    });
  });

  rows.sort((a, b) => {
    if (b.community.level !== a.community.level) return b.community.level - a.community.level;
    if (b.community.xpTotal !== a.community.xpTotal) return b.community.xpTotal - a.community.xpTotal;
    return a.login.localeCompare(b.login);
  });

  let batch = db.batch();
  let pending = 0;
  let updated = 0;
  const nowMs = Date.now();

  async function commitPending() {
    if (!pending) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const rank = i + 1;
    const row = rows[i];
    const patch = {};
    const rankName = titleForLevel(row.community.level, config.rankTitles);
    if (isObject(row.data.communityLevel)) {
      patch["communityLevel.rank"] = rank;
      patch["communityLevel.rankName"] = rankName;
      patch["communityLevel.updatedAt"] = nowMs;
    } else {
      const migrated = extractCommunityLevelFields(row.data, config).communityLevel || {};
      patch.communityLevel = {
        ...migrated,
        rank,
        rankName,
        source: migrated.source || "legacy_migration",
        updatedAt: nowMs,
      };
    }
    if (config.legacyDoubleWrite) {
      patch.wizebotRank = rank;
      patch.wizebotRankName = rankName;
    }

    batch.set(row.doc.ref, patch, { merge: true });
    pending += 1;
    updated += 1;
    if (pending >= config.rankBatchSize) await commitPending();
  }

  await commitPending();
  return { updated, skipped: false };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_RANK_TITLES,
  normalizeRankTitles,
  titleForLevel,
  resolveCommunityLevelConfig,
  normalizeCommunityLevel,
  extractCommunityLevelFields,
  xpRequiredForNextLevel,
  applyChatMessageLevelProgress,
  recalculateCommunityLevelRanks,
};
