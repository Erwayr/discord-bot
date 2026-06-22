"use strict";

const {
  applyCommunityLevelUptime,
  applyCommunityLevelXpProgress,
  applyChatMessageLevelProgress,
  normalizeCommunityLevel,
  resolveCommunityLevelConfig,
  xpRequiredForNextLevel,
} = require("./communityLevel");

const COMMAND_ALIASES = Object.freeze({
  "!lvl": "level",
  "!level": "level",
  "!niveau": "level",
  "!rank": "rank",
  "!rang": "rank",
  "!uptime": "uptime",
  "!watchtime": "uptime",
});

const DEFAULT_USER_COOLDOWN_MS = 10_000;
const DEFAULT_GLOBAL_COOLDOWN_MS = 2_000;
const DEFAULT_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function displayMention(value) {
  const clean = String(value || "")
    .trim()
    .replace(/^@+/, "");
  return `@${clean || "viewer"}`;
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.floor(n));
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function monthKeyUTC(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const y = safeDate.getUTCFullYear();
  const m = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function dayKeyUTC(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const y = safeDate.getUTCFullYear();
  const m = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(safeDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return Math.max(0, Math.floor(value));
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  if (typeof value === "object" && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeStreamId(value) {
  return String(value || "").trim();
}

function streamIdsFor(entry) {
  const out = new Set();
  const mainId = normalizeStreamId(entry?.stream_id);
  if (mainId) out.add(mainId);
  if (Array.isArray(entry?.stream_ids)) {
    entry.stream_ids.forEach((id) => {
      const safeId = normalizeStreamId(id);
      if (safeId) out.add(safeId);
    });
  }
  return out;
}

function finalizedUptimeStreamIds(entry) {
  const raw = entry?.presence?.uptime_finalized_stream_ids;
  return Array.isArray(raw)
    ? raw.map((id) => normalizeStreamId(id)).filter(Boolean)
    : [];
}

function findPreviewStream(data, streamId) {
  const safeStreamId = normalizeStreamId(streamId);
  const livePresence = data?.live_presence;
  if (!safeStreamId || !livePresence || typeof livePresence !== "object") return null;
  for (const [monthKey, month] of Object.entries(livePresence)) {
    if (!month || typeof month !== "object") continue;
    month.streams = Array.isArray(month.streams) ? month.streams : [];
    const idx = month.streams.findIndex((stream) =>
      streamIdsFor(stream).has(safeStreamId),
    );
    if (idx >= 0) {
      return { monthKey, month, entry: month.streams[idx] };
    }
  }
  return null;
}

function ensurePreviewStream(data, streamId, startedAt) {
  const safeStreamId = normalizeStreamId(streamId);
  const found = findPreviewStream(data, safeStreamId);
  if (found) return found.entry;

  const startedMs = toMillis(startedAt) || Date.now();
  data.live_presence = data.live_presence && typeof data.live_presence === "object"
    ? data.live_presence
    : {};
  const mk = monthKeyUTC(startedMs);
  const month = data.live_presence[mk] && typeof data.live_presence[mk] === "object"
    ? data.live_presence[mk]
    : { streams: [] };
  month.streams = Array.isArray(month.streams) ? month.streams : [];
  data.live_presence[mk] = month;

  const entry = {
    stream_id: safeStreamId,
    started_at: new Date(startedMs).toISOString(),
    day_key: dayKeyUTC(startedMs),
    presence: { seen: false, first_at: null, last_at: null },
    chat_message: { sent: false, count: 0, first_at: null, last_at: null },
    emote: { used: false, count: 0, last_at: null },
    clips: { count: 0, last_id: null, last_at: null },
    channel_points: { used: false, redemptions: 0, last_at: null },
    raid: { participated: false, at: null },
  };
  month.streams.push(entry);
  return entry;
}

function normalizePendingActivityEntry(entry = {}) {
  const login = String(entry.login || "").trim().toLowerCase();
  const streamId = normalizeStreamId(entry.streamId);
  if (!login || !streamId) return null;
  return {
    login,
    streamId,
    startedAt: entry.startedAt || null,
    chatEvents: Array.isArray(entry.chatEvents) ? entry.chatEvents : [],
    uptimeMs: Math.max(
      0,
      Math.floor(Number(entry.uptimeMs ?? entry.accumulatedMs) || 0),
    ),
    presenceFirstSeenAtMs: Math.max(
      0,
      Math.floor(Number(entry.presenceFirstSeenAtMs ?? entry.firstSeenAtMs) || 0),
    ),
    presenceLastSeenAtMs: Math.max(
      0,
      Math.floor(Number(entry.presenceLastSeenAtMs ?? entry.lastSeenAtMs) || 0),
    ),
  };
}

function applyPendingLiveDeltas(data, pendingEntries = [], communityConfig = {}) {
  const workingData = clone(data || {});
  const entries = (Array.isArray(pendingEntries) ? pendingEntries : [])
    .map(normalizePendingActivityEntry)
    .filter(Boolean)
    .sort((a, b) => {
      const aMs = Math.min(
        ...a.chatEvents.map((event) => toMillis(event?.atMs)).filter(Boolean),
        a.presenceFirstSeenAtMs || Infinity,
      );
      const bMs = Math.min(
        ...b.chatEvents.map((event) => toMillis(event?.atMs)).filter(Boolean),
        b.presenceFirstSeenAtMs || Infinity,
      );
      return (Number.isFinite(aMs) ? aMs : 0) - (Number.isFinite(bMs) ? bMs : 0);
    });

  for (const pending of entries) {
    const stream = ensurePreviewStream(workingData, pending.streamId, pending.startedAt);

    if (pending.presenceFirstSeenAtMs > 0) {
      stream.presence = {
        seen: false,
        first_at: null,
        last_at: null,
        ...(stream.presence || {}),
      };
      const wasSeen = !!stream.presence.seen;
      stream.presence.seen = true;
      if (!stream.presence.first_at) {
        stream.presence.first_at = pending.presenceFirstSeenAtMs;
      }
      stream.presence.last_at = Math.max(
        toMillis(stream.presence.last_at),
        pending.presenceLastSeenAtMs || pending.presenceFirstSeenAtMs,
      );

      if (!wasSeen) {
        const presenceResult = applyCommunityLevelXpProgress({
          data: workingData,
          entry: stream,
          streamId: pending.streamId,
          nowMs: pending.presenceFirstSeenAtMs,
          rawConfig: communityConfig,
          source: "presence",
        });
        if (presenceResult.awarded) {
          workingData.communityLevel = presenceResult.communityLevel;
          Object.assign(workingData, presenceResult.legacyFields);
        }
      }
    }

    const chatEvents = pending.chatEvents
      .map((event) => ({
        atMs: toMillis(event?.atMs) || Date.now(),
        count: Math.max(1, Math.floor(Number(event?.count) || 1)),
      }))
      .sort((a, b) => a.atMs - b.atMs);

    for (const event of chatEvents) {
      const result = applyChatMessageLevelProgress({
        data: workingData,
        entry: stream,
        streamId: pending.streamId,
        nowMs: event.atMs,
        rawConfig: communityConfig,
        eventCount: event.count,
      });
      if (result.awarded) {
        workingData.communityLevel = result.communityLevel;
        Object.assign(workingData, result.legacyFields);
      }
    }

    const uptimeMinutes = Math.floor(pending.uptimeMs / MS_PER_MINUTE);
    if (
      uptimeMinutes > 0 &&
      !finalizedUptimeStreamIds(stream).includes(pending.streamId)
    ) {
      const uptimeResult = applyCommunityLevelUptime({
        data: workingData,
        uptimeMinutes,
        nowMs: pending.presenceLastSeenAtMs || Date.now(),
      });
      if (uptimeResult.applied) {
        workingData.communityLevel = uptimeResult.communityLevel;
      }
    }
  }

  return workingData;
}

function parseTwitchChatCommand(message) {
  const firstToken = String(message || "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  const type = COMMAND_ALIASES[firstToken];
  return type ? { type, alias: firstToken } : null;
}

function resolveUptimeText(communityLevel) {
  const uptimeText = String(communityLevel?.uptimeText || "").trim();
  if (uptimeText) return uptimeText;
  const minutes = Number(communityLevel?.uptimeMinutes || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  if (hours <= 0) return `${mins}m`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

async function loadCommunityLevelConfig(getCommunityLevelConfig) {
  if (typeof getCommunityLevelConfig !== "function") {
    return resolveCommunityLevelConfig({});
  }
  try {
    return resolveCommunityLevelConfig(await getCommunityLevelConfig());
  } catch (e) {
    console.warn("[twitch-commands] community config fallback:", e?.message || e);
    return resolveCommunityLevelConfig({});
  }
}

async function loadFollowerDoc(db, login) {
  const safeLogin = String(login || "")
    .trim()
    .toLowerCase();
  if (!safeLogin || !db) return null;
  const snap = await db.collection("followers_all_time").doc(safeLogin).get();
  return snap.exists ? snap.data() || {} : null;
}

function createCachedProfileLoader({ db, ttlMs, now = () => Date.now() } = {}) {
  const cache = new Map();
  const safeTtlMs = Math.max(0, Math.floor(Number(ttlMs) || 0));
  return async function cachedLoadFollowerDoc(login) {
    const safeLogin = String(login || "").trim().toLowerCase();
    if (!safeLogin) return null;
    const currentTime = now();
    const cached = cache.get(safeLogin);
    if (cached && safeTtlMs > 0 && currentTime - cached.loadedAt < safeTtlMs) {
      return clone(cached.data);
    }
    const data = await loadFollowerDoc(db, safeLogin);
    cache.set(safeLogin, { data: clone(data), loadedAt: currentTime });
    return data;
  };
}

async function buildTwitchCommandResponse({
  db,
  login,
  displayName,
  type,
  getCommunityLevelConfig,
  loadProfile,
  pendingEntries,
}) {
  const mention = displayMention(displayName || login);
  const data =
    typeof loadProfile === "function"
      ? await loadProfile(login)
      : await loadFollowerDoc(db, login);
  if (!data) return `${mention} Profil introuvable pour le moment.`;

  const communityConfig = await loadCommunityLevelConfig(getCommunityLevelConfig);
  const effectiveData = applyPendingLiveDeltas(
    data,
    pendingEntries,
    communityConfig,
  );
  const communityLevel = normalizeCommunityLevel(effectiveData, communityConfig);
  const level = Math.max(0, Number(communityLevel.level || 0));

  if (type === "level") {
    const xpTotal = Math.max(0, Number(communityLevel.xpTotal || 0));
    const xpInLevel = Math.max(0, Number(communityLevel.xpInLevel || 0));
    const xpForNext = Math.max(
      0,
      Number(communityLevel.xpForNext || xpRequiredForNextLevel(level || 1, communityConfig)),
    );
    const rankName = String(communityLevel.rankName || "").trim();
    const titlePart = rankName ? ` - ${rankName}` : "";
    const progressPart = xpForNext > 0
      ? ` (${formatNumber(xpInLevel)}/${formatNumber(xpForNext)})`
      : "";
    return `${mention} Niveau ${formatNumber(level)}${titlePart} - XP ${formatNumber(xpTotal)}${progressPart}`;
  }

  if (type === "rank") {
    const rank = Math.max(0, Number(communityLevel.rank || 0));
    if (!rank) {
      return `${mention} Classement communautaire non disponible pour le moment.`;
    }
    return `${mention} #${formatNumber(rank)} au classement communautaire - Niveau ${formatNumber(level)}`;
  }

  if (type === "uptime") {
    const uptime = resolveUptimeText(communityLevel);
    if (!uptime) return `${mention} Uptime non disponible pour le moment.`;
    return `${mention} Uptime communautaire: ${uptime}`;
  }

  return null;
}

function createTwitchChatCommands({
  db,
  config = {},
  getCommunityLevelConfig,
  sendTwitchChatMessage,
  getPendingLiveActivity,
  getPendingUptime,
  now = () => Date.now(),
} = {}) {
  const userCooldownMs = toPositiveNumber(
    config.userCooldownMs,
    DEFAULT_USER_COOLDOWN_MS,
  );
  const globalCooldownMs = toPositiveNumber(
    config.globalCooldownMs,
    DEFAULT_GLOBAL_COOLDOWN_MS,
  );
  const profileCacheTtlMs = toPositiveNumber(
    config.profileCacheTtlMs,
    DEFAULT_PROFILE_CACHE_TTL_MS,
  );
  const loadProfile = createCachedProfileLoader({
    db,
    ttlMs: profileCacheTtlMs,
    now,
  });
  const userCooldowns = new Map();
  let lastGlobalResponseAt = 0;

  async function handleMessage({ login, displayName, message } = {}) {
    const command = parseTwitchChatCommand(message);
    if (!command) return { handled: false };

    const currentTime = now();
    const safeLogin = String(login || "")
      .trim()
      .toLowerCase();
    const userKey = `${safeLogin}:${command.type}`;
    const lastUserResponseAt = userCooldowns.get(userKey) || 0;

    if (
      userCooldownMs > 0 &&
      lastUserResponseAt > 0 &&
      currentTime - lastUserResponseAt < userCooldownMs
    ) {
      return { handled: true, responded: false, reason: "user_cooldown" };
    }

    if (
      globalCooldownMs > 0 &&
      lastGlobalResponseAt > 0 &&
      currentTime - lastGlobalResponseAt < globalCooldownMs
    ) {
      return { handled: true, responded: false, reason: "global_cooldown" };
    }

    const pendingEntries = [];
    if (typeof getPendingLiveActivity === "function") {
      pendingEntries.push(...(getPendingLiveActivity(safeLogin) || []));
    }
    if (typeof getPendingUptime === "function") {
      pendingEntries.push(
        ...(getPendingUptime() || []).filter(
          (entry) => String(entry?.login || "").toLowerCase() === safeLogin,
        ),
      );
    }

    const response = await buildTwitchCommandResponse({
      db,
      login: safeLogin,
      displayName,
      type: command.type,
      getCommunityLevelConfig,
      loadProfile,
      pendingEntries,
    });
    if (!response) return { handled: true, responded: false, reason: "empty" };

    await sendTwitchChatMessage(response);
    userCooldowns.set(userKey, currentTime);
    lastGlobalResponseAt = currentTime;
    return {
      handled: true,
      responded: true,
      type: command.type,
      response,
    };
  }

  return {
    handleMessage,
  };
}

module.exports = {
  COMMAND_ALIASES,
  parseTwitchChatCommand,
  applyPendingLiveDeltas,
  buildTwitchCommandResponse,
  createTwitchChatCommands,
  resolveUptimeText,
};
