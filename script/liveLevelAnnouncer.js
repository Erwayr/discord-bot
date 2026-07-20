"use strict";

const fs = require("fs");
const path = require("path");
const {
  applyPendingLiveDeltas,
} = require("./twitchChatCommands");
const {
  normalizeCommunityLevel,
  resolveCommunityLevelConfig,
  titleForLevel,
} = require("./communityLevel");
const {
  buildCommunityLevelUpMessage,
} = require("./twitchLevelAnnouncements");

const JOURNAL_FILE = "level-announcements.jsonl";
const DEFAULT_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MIN_PRESENCE_MS = 15 * 60 * 1000;

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStreamId(value) {
  return String(value || "").trim();
}

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function safeLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function toLevel(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function streamIdsFor(entry) {
  const ids = new Set();
  const primary = normalizeStreamId(entry?.stream_id);
  if (primary) ids.add(primary);
  if (Array.isArray(entry?.stream_ids)) {
    entry.stream_ids.forEach((value) => {
      const id = normalizeStreamId(value);
      if (id) ids.add(id);
    });
  }
  return ids;
}

function storedStreamEntries(data, streamId) {
  const safeStreamId = normalizeStreamId(streamId);
  const livePresence = data?.live_presence;
  if (!safeStreamId || !livePresence || typeof livePresence !== "object") {
    return [];
  }

  const entries = [];
  Object.values(livePresence).forEach((month) => {
    const streams = Array.isArray(month?.streams) ? month.streams : [];
    streams.forEach((entry) => {
      if (streamIdsFor(entry).has(safeStreamId)) entries.push(entry);
    });
  });
  return entries;
}

function pendingEntryMatchesStream(entry, streamId) {
  return normalizeStreamId(entry?.streamId) === normalizeStreamId(streamId);
}

function pendingPresenceMs(entry) {
  return Math.max(
    0,
    positiveInt(entry?.uptimeMs, 0),
    positiveInt(entry?.accumulatedMs, 0),
  );
}

async function loadFollowerDoc(db, login) {
  const safeLogin = normalizeLogin(login);
  if (!safeLogin || !db) return null;
  const snap = await db.collection("followers_all_time").doc(safeLogin).get();
  return snap.exists ? snap.data() || {} : null;
}

function createLiveLevelAnnouncer({
  db,
  getCommunityLevelConfig,
  sendTwitchChatMessage,
  getPendingLiveActivity,
  getPendingUptime,
  persistenceDir = "",
  profileCacheTtlMs = DEFAULT_PROFILE_CACHE_TTL_MS,
  levelAnnouncementMinPresenceMs = DEFAULT_MIN_PRESENCE_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const profileCache = new Map();
  const highestAnnouncedLevel = new Map();
  const spokenLoginsByStream = new Map();
  const queues = new Map();
  const safeProfileCacheTtlMs = positiveInt(
    profileCacheTtlMs,
    DEFAULT_PROFILE_CACHE_TTL_MS,
  );
  const safeMinPresenceMs = positiveInt(
    levelAnnouncementMinPresenceMs,
    DEFAULT_MIN_PRESENCE_MS,
  );
  const journalPath = persistenceDir
    ? path.join(path.resolve(persistenceDir), JOURNAL_FILE)
    : "";

  function ensureJournalDir() {
    if (!journalPath) return;
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  }

  function appendJournal(login, level) {
    if (!journalPath) return;
    try {
      ensureJournalDir();
      fs.appendFileSync(
        journalPath,
        safeLine({ v: 1, login, level, atMs: now() }),
        "utf8",
      );
    } catch (e) {
      logger.warn("[live-level] journal append failed:", e?.message || e);
    }
  }

  function loadJournal() {
    if (!journalPath || !fs.existsSync(journalPath)) return;
    try {
      const raw = fs.readFileSync(journalPath, "utf8");
      raw
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => {
          const event = JSON.parse(line);
          const login = normalizeLogin(event?.login);
          const level = toLevel(event?.level);
          if (!login || !level) return;
          const current = highestAnnouncedLevel.get(login) || 0;
          if (level > current) highestAnnouncedLevel.set(login, level);
        });
    } catch (e) {
      logger.warn("[live-level] journal restore failed:", e?.message || e);
    }
  }

  async function loadProfile(login, { force = false } = {}) {
    const safeLogin = normalizeLogin(login);
    if (!safeLogin) return null;

    const cached = profileCache.get(safeLogin);
    const currentTime = now();
    if (
      !force &&
      cached &&
      safeProfileCacheTtlMs > 0 &&
      currentTime - cached.loadedAt < safeProfileCacheTtlMs
    ) {
      return clone(cached.data);
    }

    const data = await loadFollowerDoc(db, safeLogin);
    profileCache.set(safeLogin, {
      data: clone(data),
      loadedAt: currentTime,
    });
    return data;
  }

  async function loadCommunityConfig() {
    if (typeof getCommunityLevelConfig !== "function") {
      return resolveCommunityLevelConfig({});
    }
    try {
      return resolveCommunityLevelConfig(await getCommunityLevelConfig());
    } catch (e) {
      logger.warn("[live-level] config fallback:", e?.message || e);
      return resolveCommunityLevelConfig({});
    }
  }

  function pendingEntriesForLogin(login, extraPendingEntries = []) {
    const safeLogin = normalizeLogin(login);
    const entries = [];
    if (typeof getPendingLiveActivity === "function") {
      entries.push(...(getPendingLiveActivity(safeLogin) || []));
    }
    if (typeof getPendingUptime === "function") {
      entries.push(
        ...(getPendingUptime() || []).filter(
          (entry) => normalizeLogin(entry?.login) === safeLogin,
        ),
      );
    }
    if (Array.isArray(extraPendingEntries)) {
      entries.push(
        ...extraPendingEntries.filter(
          (entry) => normalizeLogin(entry?.login) === safeLogin,
        ),
      );
    }
    return entries.filter((entry) => normalizeLogin(entry?.login) === safeLogin);
  }

  function markSpoken({ login, streamId } = {}) {
    const safeLogin = normalizeLogin(login);
    const safeStreamId = normalizeStreamId(streamId);
    if (!safeLogin || !safeStreamId) return false;
    const spoken = spokenLoginsByStream.get(safeStreamId) || new Set();
    spoken.add(safeLogin);
    spokenLoginsByStream.set(safeStreamId, spoken);
    return true;
  }

  function expireStream(streamId) {
    const safeStreamId = normalizeStreamId(streamId);
    if (!safeStreamId) return false;
    return spokenLoginsByStream.delete(safeStreamId);
  }

  function announcementEligibility(data, pendingEntries, login, streamId) {
    const safeLogin = normalizeLogin(login);
    const safeStreamId = normalizeStreamId(streamId);
    const storedEntries = storedStreamEntries(data, safeStreamId);
    const matchingPending = pendingEntries.filter((entry) =>
      pendingEntryMatchesStream(entry, safeStreamId),
    );
    const spokenInMemory =
      spokenLoginsByStream.get(safeStreamId)?.has(safeLogin) || false;
    const spokenInStoredActivity = storedEntries.some(
      (entry) =>
        !!entry?.chat_message?.sent ||
        positiveInt(entry?.chat_message?.count, 0) > 0,
    );
    const spokenInPendingActivity = matchingPending.some((entry) =>
      (Array.isArray(entry?.chatEvents) ? entry.chatEvents : []).some(
        (event) => positiveInt(event?.count, 1) > 0,
      ),
    );
    const storedPresenceMs = storedEntries.reduce(
      (max, entry) =>
        Math.max(
          max,
          positiveInt(entry?.presence?.uptime_minutes, 0) * 60 * 1000,
        ),
      0,
    );
    const pendingUptimeMs = matchingPending.reduce(
      (max, entry) => Math.max(max, pendingPresenceMs(entry)),
      0,
    );
    const presenceMs = Math.max(storedPresenceMs, pendingUptimeMs);
    const hasSpoken =
      spokenInMemory || spokenInStoredActivity || spokenInPendingActivity;
    const presenceQualified = presenceMs >= safeMinPresenceMs;

    return {
      eligible: hasSpoken || presenceQualified,
      hasSpoken,
      presenceMs,
      presenceQualified,
    };
  }

  function evaluateLevels(data, pendingEntries, communityConfig) {
    const base = normalizeCommunityLevel(data || {}, communityConfig);
    const effectiveData = applyPendingLiveDeltas(
      data || {},
      pendingEntries,
      communityConfig,
    );
    const effective = normalizeCommunityLevel(effectiveData, communityConfig);
    return {
      baseLevel: toLevel(base.level),
      effectiveLevel: toLevel(effective.level),
    };
  }

  function markAnnounced(login, level) {
    const safeLogin = normalizeLogin(login);
    const safeLevel = toLevel(level);
    if (!safeLogin || !safeLevel) return;
    const current = highestAnnouncedLevel.get(safeLogin) || 0;
    if (safeLevel <= current) return;
    highestAnnouncedLevel.set(safeLogin, safeLevel);
    appendJournal(safeLogin, safeLevel);
  }

  async function runCheck({
    login,
    displayName,
    streamId,
    pendingEntries,
  } = {}) {
    const safeLogin = normalizeLogin(login);
    if (!safeLogin) return { announced: 0, reason: "invalid_login" };
    const safeStreamId = normalizeStreamId(streamId);
    if (!safeStreamId) return { announced: 0, reason: "invalid_stream" };

    const communityConfig = await loadCommunityConfig();
    const initialData = await loadProfile(safeLogin);
    if (!initialData) return { announced: 0, reason: "missing_profile" };

    const initialPending = pendingEntriesForLogin(
      safeLogin,
      pendingEntries,
    ).filter((entry) => pendingEntryMatchesStream(entry, safeStreamId));
    const initialLevels = evaluateLevels(
      initialData,
      initialPending,
      communityConfig,
    );
    let threshold = Math.max(
      initialLevels.baseLevel,
      highestAnnouncedLevel.get(safeLogin) || 0,
    );
    if (initialLevels.effectiveLevel <= threshold) {
      return { announced: 0, reason: "no_level_up" };
    }

    const initialEligibility = announcementEligibility(
      initialData,
      initialPending,
      safeLogin,
      safeStreamId,
    );
    if (!initialEligibility.eligible) {
      return {
        announced: 0,
        reason: "announcement_deferred",
        level: initialLevels.effectiveLevel,
        presenceMs: initialEligibility.presenceMs,
      };
    }

    const freshData = await loadProfile(safeLogin, { force: true });
    if (!freshData) return { announced: 0, reason: "missing_profile" };
    const freshPending = pendingEntriesForLogin(
      safeLogin,
      pendingEntries,
    ).filter((entry) => pendingEntryMatchesStream(entry, safeStreamId));
    const freshLevels = evaluateLevels(
      freshData,
      freshPending,
      communityConfig,
    );
    threshold = Math.max(
      freshLevels.baseLevel,
      highestAnnouncedLevel.get(safeLogin) || 0,
    );
    if (freshLevels.effectiveLevel <= threshold) {
      return { announced: 0, reason: "stale_profile_refresh" };
    }

    const freshEligibility = announcementEligibility(
      freshData,
      freshPending,
      safeLogin,
      safeStreamId,
    );
    if (!freshEligibility.eligible) {
      return {
        announced: 0,
        reason: "announcement_deferred",
        level: freshLevels.effectiveLevel,
        presenceMs: freshEligibility.presenceMs,
      };
    }

    if (typeof sendTwitchChatMessage !== "function") {
      return { announced: 0, reason: "missing_sender" };
    }

    let announced = 0;
    for (let level = threshold + 1; level <= freshLevels.effectiveLevel; level += 1) {
      const message = buildCommunityLevelUpMessage({
        displayName,
        login: safeLogin,
        level,
        rankName: titleForLevel(level, communityConfig.rankTitles),
      });
      if (!message) continue;
      await sendTwitchChatMessage(message);
      markAnnounced(safeLogin, level);
      announced += 1;
    }

    return {
      announced,
      reason: announced > 0 ? "announced" : "empty_message",
      level: freshLevels.effectiveLevel,
    };
  }

  function checkAndAnnounce(payload = {}) {
    const safeLogin = normalizeLogin(payload.login);
    if (!safeLogin) return Promise.resolve({ announced: 0, reason: "invalid_login" });

    const previous = queues.get(safeLogin) || Promise.resolve();
    const next = previous
      .catch(() => null)
      .then(() => runCheck({ ...payload, login: safeLogin }))
      .finally(() => {
        if (queues.get(safeLogin) === next) queues.delete(safeLogin);
      });
    queues.set(safeLogin, next);
    return next;
  }

  loadJournal();

  return {
    checkAndAnnounce,
    markSpoken,
    expireStream,
    highestAnnouncedLevel: (login) =>
      highestAnnouncedLevel.get(normalizeLogin(login)) || 0,
    journalPath,
  };
}

module.exports = {
  DEFAULT_MIN_PRESENCE_MS,
  createLiveLevelAnnouncer,
  _test: {
    loadFollowerDoc,
    pendingPresenceMs,
    storedStreamEntries,
  },
};
