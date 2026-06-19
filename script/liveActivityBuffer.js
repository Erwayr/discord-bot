"use strict";

const DEFAULT_FLUSH_MS = 20 * 60 * 1000;
const DEFAULT_FLUSH_CHUNK_SIZE = 25;

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStreamId(value) {
  return String(value || "").trim();
}

function entryKey(login, streamId) {
  return `${login}::${streamId}`;
}

function cloneEntry(entry) {
  return {
    login: entry.login,
    streamId: entry.streamId,
    startedAt: entry.startedAt || null,
    displayName: entry.displayName || entry.login,
    chatEvents: entry.chatEvents.map((event) => ({ ...event })),
    emoteCount: entry.emoteCount,
  };
}

function createEmptyEntry({ login, streamId, startedAt, displayName }) {
  return {
    login,
    streamId,
    startedAt: startedAt || null,
    displayName: displayName || login,
    chatEvents: [],
    emoteCount: 0,
  };
}

function mergeEntries(target, source) {
  if (!target || !source) return target || source;
  if (!target.startedAt && source.startedAt) target.startedAt = source.startedAt;
  if (source.displayName) target.displayName = source.displayName;
  target.chatEvents.push(...source.chatEvents);
  target.chatEvents.sort((a, b) => a.atMs - b.atMs);
  target.emoteCount += source.emoteCount;
  return target;
}

function createLiveActivityBuffer({
  questStore,
  flushIntervalMs = DEFAULT_FLUSH_MS,
  flushChunkSize = DEFAULT_FLUSH_CHUNK_SIZE,
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
  const pending = new Map();
  let timer = null;
  let flushPromise = null;

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
        startedAt: meta.startedAt || null,
        displayName: meta.displayName || login,
      });
      pending.set(key, entry);
    } else {
      if (!entry.startedAt && meta.startedAt) entry.startedAt = meta.startedAt;
      if (meta.displayName) entry.displayName = meta.displayName;
    }

    return entry;
  }

  function noteChatMessage(login, streamId, meta = {}) {
    const entry = ensureEntry(login, streamId, meta);
    if (!entry) return { buffered: false, reason: "invalid_target" };
    entry.chatEvents.push({
      atMs: Math.max(1, Math.floor(Number(now()) || Date.now())),
      count: 1,
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
    entry.emoteCount += Math.max(1, Math.floor(Number(inc) || 1));
    return {
      buffered: true,
      login: entry.login,
      streamId: entry.streamId,
      pendingEmotes: entry.emoteCount,
    };
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
      reason,
    });
    await notifyLevelUps(entry, result);
    return result;
  }

  async function doFlush({ reason = "timer" } = {}) {
    const entries = Array.from(pending.values()).map(cloneEntry);
    pending.clear();
    if (!entries.length) {
      return { flushed: 0, failed: 0, reason };
    }

    let flushed = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i += chunkSize) {
      const slice = entries.slice(i, i + chunkSize);
      const results = await Promise.allSettled(
        slice.map((entry) => flushEntry(entry, reason)),
      );

      results.forEach((outcome, idx) => {
        if (outcome.status === "fulfilled") {
          flushed += 1;
          return;
        }

        failed += 1;
        const entry = slice[idx];
        requeue(entry);
        logger.warn(
          `[live-activity] flush failed for ${entry.login}/${entry.streamId}:`,
          outcome.reason?.message || outcome.reason,
        );
      });
    }

    if (flushed > 0 || failed > 0) {
      logger.log(
        `[live-activity] flush reason=${reason} flushed=${flushed} failed=${failed}`,
      );
    }

    return { flushed, failed, reason };
  }

  function flush(options = {}) {
    if (flushPromise) {
      return flushPromise.then((result) =>
        pending.size > 0 ? flush(options) : result,
      );
    }
    flushPromise = doFlush(options).finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  function start() {
    if (timer || intervalMs <= 0) return;
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

  return {
    noteChatMessage,
    noteEmoteUsage,
    flush,
    start,
    stop,
    pendingSize: () => pending.size,
    pendingSnapshot: () => Array.from(pending.values()).map(cloneEntry),
    flushIntervalMs: intervalMs,
    flushChunkSize: chunkSize,
  };
}

module.exports = {
  DEFAULT_FLUSH_MS,
  DEFAULT_FLUSH_CHUNK_SIZE,
  createLiveActivityBuffer,
  _test: {
    mergeEntries,
  },
};
