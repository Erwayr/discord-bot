"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_FLUSH_MS = 20 * 60 * 1000;
const DEFAULT_FLUSH_CHUNK_SIZE = 25;
const DEFAULT_FLUSH_MODE = "live-end";
const JOURNAL_FILE = "pending.jsonl";

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeFlushMode(value) {
  return String(value || "").trim().toLowerCase() === "interval"
    ? "interval"
    : DEFAULT_FLUSH_MODE;
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStreamId(value) {
  return String(value || "").trim();
}

function normalizeStartedAt(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function entryKey(login, streamId) {
  return `${login}::${streamId}`;
}

function cloneEvent(event) {
  return {
    atMs: nonNegativeInt(event?.atMs, Date.now()),
    count: positiveInt(event?.count, 1),
  };
}

function cloneEntry(entry) {
  return {
    login: entry.login,
    streamId: entry.streamId,
    segmentId: entry.segmentId,
    flushId: entry.flushId || null,
    startedAt: entry.startedAt || null,
    displayName: entry.displayName || entry.login,
    chatEvents: entry.chatEvents.map(cloneEvent),
    emoteCount: nonNegativeInt(entry.emoteCount, 0),
    channelPointsCount: nonNegativeInt(entry.channelPointsCount, 0),
    uptimeMs: nonNegativeInt(entry.uptimeMs, 0),
    presenceFirstSeenAtMs: nonNegativeInt(entry.presenceFirstSeenAtMs, 0),
    presenceLastSeenAtMs: nonNegativeInt(entry.presenceLastSeenAtMs, 0),
  };
}

function createEmptyEntry({ login, streamId, segmentId, startedAt, displayName }) {
  return {
    login,
    streamId,
    segmentId,
    flushId: null,
    startedAt: normalizeStartedAt(startedAt),
    displayName: displayName || login,
    chatEvents: [],
    emoteCount: 0,
    channelPointsCount: 0,
    uptimeMs: 0,
    presenceFirstSeenAtMs: 0,
    presenceLastSeenAtMs: 0,
  };
}

function mergeEntries(target, source) {
  if (!target || !source) return target || source;
  if (!target.startedAt && source.startedAt) target.startedAt = source.startedAt;
  if (source.displayName) target.displayName = source.displayName;
  if (!target.segmentId && source.segmentId) target.segmentId = source.segmentId;
  if (
    !target.flushId &&
    source.flushId &&
    target.chatEvents.length <= 0 &&
    target.emoteCount <= 0 &&
    target.channelPointsCount <= 0
  ) {
    target.flushId = source.flushId;
  }

  target.chatEvents.push(...source.chatEvents.map(cloneEvent));
  target.chatEvents.sort((a, b) => a.atMs - b.atMs);
  target.emoteCount += nonNegativeInt(source.emoteCount, 0);
  target.channelPointsCount += nonNegativeInt(source.channelPointsCount, 0);
  target.uptimeMs += nonNegativeInt(source.uptimeMs, 0);

  const first = nonNegativeInt(source.presenceFirstSeenAtMs, 0);
  const last = nonNegativeInt(source.presenceLastSeenAtMs, 0);
  if (first > 0) {
    target.presenceFirstSeenAtMs = target.presenceFirstSeenAtMs
      ? Math.min(target.presenceFirstSeenAtMs, first)
      : first;
  }
  if (last > 0) {
    target.presenceLastSeenAtMs = Math.max(target.presenceLastSeenAtMs || 0, last);
  }

  return target;
}

function streamFilterSet({ streamId, streamIds } = {}) {
  const ids = new Set();
  const one = normalizeStreamId(streamId);
  if (one) ids.add(one);
  if (Array.isArray(streamIds)) {
    streamIds.forEach((id) => {
      const safe = normalizeStreamId(id);
      if (safe) ids.add(safe);
    });
  }
  return ids.size ? ids : null;
}

function matchesStreamFilter(entry, filter) {
  return !filter || filter.has(entry.streamId);
}

function safeLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function createLiveActivityBuffer({
  questStore,
  flushIntervalMs = DEFAULT_FLUSH_MS,
  flushChunkSize = DEFAULT_FLUSH_CHUNK_SIZE,
  flushMode = DEFAULT_FLUSH_MODE,
  persistenceDir = "",
  onLevelUp,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  if (!questStore || typeof questStore.noteLiveActivity !== "function") {
    throw new Error("createLiveActivityBuffer: noteLiveActivity missing");
  }

  const intervalMs = positiveInt(flushIntervalMs, DEFAULT_FLUSH_MS);
  const chunkSize = positiveInt(flushChunkSize, DEFAULT_FLUSH_CHUNK_SIZE);
  const mode = normalizeFlushMode(flushMode);
  const pending = new Map();
  const journalPath = persistenceDir
    ? path.join(path.resolve(persistenceDir), JOURNAL_FILE)
    : "";
  let sequence = 0;
  let timer = null;
  let flushPromise = null;
  let rewritingJournal = false;

  function nextSegmentId() {
    sequence += 1;
    return `${Date.now().toString(36)}-${sequence.toString(36)}`;
  }

  function ensureJournalDir() {
    if (!journalPath) return;
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  }

  function appendJournal(event) {
    if (!journalPath || rewritingJournal) return;
    try {
      ensureJournalDir();
      fs.appendFileSync(journalPath, safeLine(event), "utf8");
    } catch (e) {
      logger.warn("[live-activity] journal append failed:", e?.message || e);
    }
  }

  function entryToJournalEvents(entry) {
    const base = {
      v: 1,
      login: entry.login,
      streamId: entry.streamId,
      segmentId: entry.segmentId,
      startedAt: entry.startedAt || null,
      displayName: entry.displayName || entry.login,
    };
    const events = entry.chatEvents.map((event) => ({
      ...base,
      type: "chat",
      atMs: nonNegativeInt(event.atMs, Date.now()),
      count: positiveInt(event.count, 1),
    }));
    if (entry.emoteCount > 0) {
      events.push({
        ...base,
        type: "emote",
        atMs: Date.now(),
        inc: nonNegativeInt(entry.emoteCount, 0),
      });
    }
    if (entry.channelPointsCount > 0) {
      events.push({
        ...base,
        type: "channel_points",
        atMs: Date.now(),
        inc: nonNegativeInt(entry.channelPointsCount, 0),
      });
    }
    if (entry.uptimeMs > 0 || entry.presenceFirstSeenAtMs > 0) {
      events.push({
        ...base,
        type: "uptime",
        flushId: entry.flushId || null,
        uptimeMs: nonNegativeInt(entry.uptimeMs, 0),
        presenceFirstSeenAtMs: nonNegativeInt(entry.presenceFirstSeenAtMs, 0),
        presenceLastSeenAtMs: nonNegativeInt(entry.presenceLastSeenAtMs, 0),
      });
    }
    return events;
  }

  function rewriteJournal() {
    if (!journalPath) return;
    try {
      ensureJournalDir();
      rewritingJournal = true;
      const entries = Array.from(pending.values());
      if (!entries.length) {
        if (fs.existsSync(journalPath)) fs.unlinkSync(journalPath);
        return;
      }

      const tmpPath = `${journalPath}.tmp`;
      const payload = entries
        .flatMap(entryToJournalEvents)
        .map(safeLine)
        .join("");
      fs.writeFileSync(tmpPath, payload, "utf8");
      fs.renameSync(tmpPath, journalPath);
    } catch (e) {
      logger.warn("[live-activity] journal rewrite failed:", e?.message || e);
    } finally {
      rewritingJournal = false;
    }
  }

  function ensureEntry(loginValue, streamIdValue, meta = {}) {
    const login = normalizeLogin(loginValue);
    const streamId = normalizeStreamId(streamIdValue);
    if (!login || !streamId) return null;

    const key = entryKey(login, streamId);
    let entry = pending.get(key);
    if (!entry) {
      entry = createEmptyEntry({
        login,
        streamId,
        segmentId: meta.segmentId || nextSegmentId(),
        startedAt: meta.startedAt || null,
        displayName: meta.displayName || login,
      });
      pending.set(key, entry);
    } else {
      if (!entry.startedAt && meta.startedAt) {
        entry.startedAt = normalizeStartedAt(meta.startedAt);
      }
      if (meta.displayName) entry.displayName = meta.displayName;
      if (!entry.segmentId && meta.segmentId) entry.segmentId = meta.segmentId;
    }

    return entry;
  }

  function applyJournalEvent(raw) {
    if (!raw || typeof raw !== "object") return;
    const entry = ensureEntry(raw.login, raw.streamId, {
      segmentId: raw.segmentId || null,
      startedAt: raw.startedAt || null,
      displayName: raw.displayName || raw.login,
    });
    if (!entry) return;

    if (raw.type === "chat") {
      entry.chatEvents.push({
        atMs: nonNegativeInt(raw.atMs, Date.now()),
        count: positiveInt(raw.count, 1),
      });
      entry.chatEvents.sort((a, b) => a.atMs - b.atMs);
      return;
    }

    if (raw.type === "emote") {
      entry.emoteCount += Math.max(1, nonNegativeInt(raw.inc, 1));
      return;
    }

    if (raw.type === "channel_points") {
      entry.channelPointsCount += Math.max(1, nonNegativeInt(raw.inc, 1));
      return;
    }

    if (raw.type === "uptime") {
      entry.flushId = raw.flushId || entry.flushId || null;
      entry.uptimeMs += nonNegativeInt(raw.uptimeMs, 0);
      const first = nonNegativeInt(raw.presenceFirstSeenAtMs, 0);
      const last = nonNegativeInt(raw.presenceLastSeenAtMs, 0);
      if (first > 0) {
        entry.presenceFirstSeenAtMs = entry.presenceFirstSeenAtMs
          ? Math.min(entry.presenceFirstSeenAtMs, first)
          : first;
      }
      if (last > 0) {
        entry.presenceLastSeenAtMs = Math.max(entry.presenceLastSeenAtMs || 0, last);
      }
    }
  }

  function loadJournal() {
    if (!journalPath || !fs.existsSync(journalPath)) return;
    try {
      const raw = fs.readFileSync(journalPath, "utf8");
      raw
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => applyJournalEvent(JSON.parse(line)));
      if (pending.size > 0) {
        logger.log(
          `[live-activity] restored ${pending.size} pending stream/user entr${pending.size > 1 ? "ies" : "y"}`,
        );
      }
      rewriteJournal();
    } catch (e) {
      logger.warn("[live-activity] journal restore failed:", e?.message || e);
    }
  }

  function noteChatMessage(login, streamId, meta = {}) {
    const entry = ensureEntry(login, streamId, meta);
    if (!entry) return { buffered: false, reason: "invalid_target" };
    const event = {
      atMs: Math.max(1, Math.floor(Number(now()) || Date.now())),
      count: 1,
    };
    entry.chatEvents.push(event);
    appendJournal({
      v: 1,
      type: "chat",
      login: entry.login,
      streamId: entry.streamId,
      segmentId: entry.segmentId,
      startedAt: entry.startedAt,
      displayName: entry.displayName,
      ...event,
    });
    return {
      buffered: true,
      login: entry.login,
      streamId: entry.streamId,
      pendingChatEvents: entry.chatEvents.length,
    };
  }

  function noteEmoteUsage(login, streamId, inc = 1, meta = {}) {
    const entry = ensureEntry(login, streamId, meta);
    if (!entry) return { buffered: false, reason: "invalid_target" };
    const safeInc = Math.max(1, Math.floor(Number(inc) || 1));
    entry.emoteCount += safeInc;
    appendJournal({
      v: 1,
      type: "emote",
      login: entry.login,
      streamId: entry.streamId,
      segmentId: entry.segmentId,
      startedAt: entry.startedAt,
      displayName: entry.displayName,
      atMs: Math.max(1, Math.floor(Number(now()) || Date.now())),
      inc: safeInc,
    });
    return {
      buffered: true,
      login: entry.login,
      streamId: entry.streamId,
      pendingEmotes: entry.emoteCount,
    };
  }

  function noteChannelPoints(login, streamId, inc = 1, meta = {}) {
    const entry = ensureEntry(login, streamId, meta);
    if (!entry) return { buffered: false, reason: "invalid_target" };
    const safeInc = Math.max(1, Math.floor(Number(inc) || 1));
    entry.channelPointsCount += safeInc;
    appendJournal({
      v: 1,
      type: "channel_points",
      login: entry.login,
      streamId: entry.streamId,
      segmentId: entry.segmentId,
      startedAt: entry.startedAt,
      displayName: entry.displayName,
      atMs: Math.max(1, Math.floor(Number(now()) || Date.now())),
      inc: safeInc,
    });
    return {
      buffered: true,
      login: entry.login,
      streamId: entry.streamId,
      pendingChannelPoints: entry.channelPointsCount,
    };
  }

  function normalizeUptimeEntry(raw = {}) {
    const login = normalizeLogin(raw.login);
    const streamId = normalizeStreamId(raw.streamId);
    if (!login || !streamId) return null;
    const firstSeen = nonNegativeInt(raw.firstSeenAtMs, raw.presenceFirstSeenAtMs || 0);
    const lastSeen = nonNegativeInt(raw.lastSeenAtMs, raw.presenceLastSeenAtMs || 0);
    const uptimeMs = nonNegativeInt(raw.accumulatedMs, raw.uptimeMs || 0);
    if (uptimeMs <= 0 && firstSeen <= 0) return null;
    return createEmptyEntry({
      login,
      streamId,
      segmentId:
        raw.segmentId ||
        `uptime-${streamId}-${login}-${firstSeen || "0"}-${lastSeen || "0"}-${uptimeMs}`,
      startedAt: raw.startedAt || null,
      displayName: raw.displayName || login,
    });
  }

  function addUptimeToEntry(entry, raw = {}) {
    entry.uptimeMs += nonNegativeInt(raw.accumulatedMs, raw.uptimeMs || 0);
    const firstSeen = nonNegativeInt(raw.firstSeenAtMs, raw.presenceFirstSeenAtMs || 0);
    const lastSeen = nonNegativeInt(raw.lastSeenAtMs, raw.presenceLastSeenAtMs || 0);
    if (firstSeen > 0) {
      entry.presenceFirstSeenAtMs = entry.presenceFirstSeenAtMs
        ? Math.min(entry.presenceFirstSeenAtMs, firstSeen)
        : firstSeen;
    }
    if (lastSeen > 0) {
      entry.presenceLastSeenAtMs = Math.max(entry.presenceLastSeenAtMs || 0, lastSeen);
    }
    entry.flushId =
      entry.flushId ||
      `live-activity:${entry.streamId}:${entry.login}:${entry.segmentId}`;
    return entry;
  }

  function selectedPendingEntries(filter) {
    return Array.from(pending.values())
      .filter((entry) => matchesStreamFilter(entry, filter))
      .map(cloneEntry);
  }

  function selectedPendingKeys(filter) {
    return Array.from(pending.values())
      .filter((entry) => matchesStreamFilter(entry, filter))
      .map((entry) => entryKey(entry.login, entry.streamId));
  }

  function entriesForFlush(options = {}) {
    const filter = streamFilterSet(options);
    const byKey = new Map(
      selectedPendingEntries(filter).map((entry) => [
        entryKey(entry.login, entry.streamId),
        entry,
      ]),
    );

    const extras = Array.isArray(options.uptimeEntries) ? options.uptimeEntries : [];
    for (const raw of extras) {
      const extra = normalizeUptimeEntry(raw);
      if (!extra || !matchesStreamFilter(extra, filter)) continue;
      addUptimeToEntry(extra, raw);
      const key = entryKey(extra.login, extra.streamId);
      byKey.set(key, byKey.has(key) ? mergeEntries(byKey.get(key), extra) : extra);
    }

    return Array.from(byKey.values());
  }

  async function notifyLevelUps(entry, result) {
    if (typeof onLevelUp !== "function") return;
    const levelUps = Array.isArray(result?.levelUps) ? result.levelUps : [];
    for (const levelUp of levelUps) {
      await onLevelUp({
        login: entry.login,
        displayName: entry.displayName,
        level: levelUp.level,
        rankName: levelUp.rankName,
      });
    }
  }

  function ensureFlushId(entry) {
    if (!entry.flushId) {
      entry.flushId = `live-activity:${entry.streamId}:${entry.login}:${entry.segmentId || nextSegmentId()}`;
    }
    return entry.flushId;
  }

  function requeue(entry) {
    const key = entryKey(entry.login, entry.streamId);
    const current = pending.get(key);
    pending.set(key, current ? mergeEntries(entry, current) : entry);
  }

  async function flushEntry(entry, reason) {
    const result = await questStore.noteLiveActivity(entry.login, entry.streamId, {
      startedAt: entry.startedAt,
      chatEvents: entry.chatEvents,
      emoteCount: entry.emoteCount,
      channelPointsCount: entry.channelPointsCount,
      uptimeMs: entry.uptimeMs,
      presenceFirstSeenAtMs: entry.presenceFirstSeenAtMs,
      presenceLastSeenAtMs: entry.presenceLastSeenAtMs,
      flushId: ensureFlushId(entry),
      reason,
    });
    await notifyLevelUps(entry, result);
    return result;
  }

  async function doFlush(options = {}) {
    const reason = options.reason || "timer";
    const filter = streamFilterSet(options);
    const entries = entriesForFlush(options);
    const keys = selectedPendingKeys(filter);
    keys.forEach((key) => pending.delete(key));

    if (!entries.length) {
      rewriteJournal();
      return {
        flushed: 0,
        failed: 0,
        reason,
        flushedEntries: [],
        failedEntries: [],
      };
    }

    let flushed = 0;
    let failed = 0;
    const flushedEntries = [];
    const failedEntries = [];

    for (let i = 0; i < entries.length; i += chunkSize) {
      const slice = entries.slice(i, i + chunkSize);
      const results = await Promise.allSettled(
        slice.map((entry) => flushEntry(entry, reason)),
      );

      results.forEach((outcome, idx) => {
        const entry = slice[idx];
        const summary = {
          login: entry.login,
          streamId: entry.streamId,
          flushId: entry.flushId || null,
        };
        if (outcome.status === "fulfilled") {
          flushed += 1;
          flushedEntries.push(summary);
          return;
        }

        failed += 1;
        failedEntries.push(summary);
        requeue(entry);
        logger.warn(
          `[live-activity] flush failed for ${entry.login}/${entry.streamId}:`,
          outcome.reason?.message || outcome.reason,
        );
      });
    }

    rewriteJournal();

    if (flushed > 0 || failed > 0) {
      logger.log(
        `[live-activity] flush reason=${reason} flushed=${flushed} failed=${failed}`,
      );
    }

    return { flushed, failed, reason, flushedEntries, failedEntries };
  }

  function flush(options = {}) {
    if (flushPromise) {
      return flushPromise.then(() => flush(options));
    }
    flushPromise = doFlush(options).finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  function start() {
    if (mode !== "interval" || timer || intervalMs <= 0) return;
    timer = setIntervalFn(() => {
      flush({ reason: "timer" }).catch((e) =>
        logger.warn("[live-activity] timer flush failed:", e?.message || e),
      );
    }, intervalMs);
    if (typeof timer?.unref === "function") timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function pendingSnapshot(options = {}) {
    const filter = streamFilterSet(options);
    return selectedPendingEntries(filter);
  }

  function pendingForLogin(loginValue) {
    const login = normalizeLogin(loginValue);
    if (!login) return [];
    return Array.from(pending.values())
      .filter((entry) => entry.login === login)
      .map(cloneEntry);
  }

  function pendingStreamIds() {
    return Array.from(new Set(Array.from(pending.values()).map((entry) => entry.streamId)));
  }

  loadJournal();

  return {
    noteChatMessage,
    noteEmoteUsage,
    noteChannelPoints,
    flush,
    start,
    stop,
    pendingSize: () => pending.size,
    pendingSnapshot,
    pendingForLogin,
    pendingStreamIds,
    flushMode: mode,
    shouldFlushOnShutdown: mode === "interval",
    flushIntervalMs: intervalMs,
    flushChunkSize: chunkSize,
    journalPath,
  };
}

module.exports = {
  DEFAULT_FLUSH_MS,
  DEFAULT_FLUSH_CHUNK_SIZE,
  DEFAULT_FLUSH_MODE,
  createLiveActivityBuffer,
  _test: {
    mergeEntries,
    normalizeFlushMode,
  },
};
