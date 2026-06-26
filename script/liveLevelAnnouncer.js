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

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
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
  now = () => Date.now(),
  logger = console,
} = {}) {
  const profileCache = new Map();
  const highestAnnouncedLevel = new Map();
  const queues = new Map();
  const safeProfileCacheTtlMs = positiveInt(
    profileCacheTtlMs,
    DEFAULT_PROFILE_CACHE_TTL_MS,
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
    pendingEntries,
  } = {}) {
    const safeLogin = normalizeLogin(login);
    if (!safeLogin) return { announced: 0, reason: "invalid_login" };

    const communityConfig = await loadCommunityConfig();
    const initialData = await loadProfile(safeLogin);
    if (!initialData) return { announced: 0, reason: "missing_profile" };

    const initialPending = pendingEntriesForLogin(safeLogin, pendingEntries);
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

    const freshData = await loadProfile(safeLogin, { force: true });
    if (!freshData) return { announced: 0, reason: "missing_profile" };
    const freshPending = pendingEntriesForLogin(safeLogin, pendingEntries);
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
    highestAnnouncedLevel: (login) =>
      highestAnnouncedLevel.get(normalizeLogin(login)) || 0,
    journalPath,
  };
}

module.exports = {
  createLiveLevelAnnouncer,
  _test: {
    loadFollowerDoc,
  },
};
