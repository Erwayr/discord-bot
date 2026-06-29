"use strict";

const { makeHelix } = require("../helper/helix");
const { isExcludedLogin } = require("../helper/excludedUsers");

const DEFAULT_UPTIME_TICK_MS = 120_000;
const DEFAULT_UPTIME_MAX_TICK_MS = 300_000;
const UPTIME_FLUSH_CHUNK_SIZE = 25;

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

function normalizeTwitchUserId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
}

function normalizeChatter(raw) {
  if (typeof raw === "string") {
    const login = normalizeLogin(raw);
    return login ? { login, twitchUserId: "", displayName: raw } : null;
  }
  const login = normalizeLogin(raw?.user_login || raw?.login || raw?.userName);
  if (!login) return null;
  return {
    login,
    twitchUserId: normalizeTwitchUserId(raw?.user_id || raw?.userId),
    displayName: String(raw?.user_name || raw?.displayName || raw?.user_login || login).trim(),
  };
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function createUptimeAccumulator({ tickMs, maxTickMs } = {}) {
  const safeMaxTickMs = positiveInt(maxTickMs, DEFAULT_UPTIME_MAX_TICK_MS);
  const safeTickMs = Math.min(
    positiveInt(tickMs, DEFAULT_UPTIME_TICK_MS),
    safeMaxTickMs,
  );
  let streamId = null;
  let startedAt = null;
  const entries = new Map();

  function reset(nextStreamId, nextStartedAt = null) {
    streamId = normalizeStreamId(nextStreamId);
    startedAt = normalizeDate(nextStartedAt);
    entries.clear();
  }

  function markSeen(logins = [], nowMs = Date.now()) {
    const seenAtMs = Math.max(0, Math.floor(Number(nowMs) || Date.now()));
    const present = new Map();

    for (const rawLogin of Array.isArray(logins) ? logins : []) {
      const chatter = normalizeChatter(rawLogin);
      if (!chatter?.login || isExcludedLogin(chatter.login)) continue;
      present.set(chatter.login, chatter);
    }

    entries.forEach((entry, login) => {
      if (!present.has(login)) entry.seenInLastTick = false;
    });

    const presenceLogins = [];
    let creditedMs = 0;

    for (const [login, chatter] of present.entries()) {
      let entry = entries.get(login);
      if (!entry) {
        entry = {
          firstSeenAtMs: seenAtMs,
          lastSeenAtMs: seenAtMs,
          accumulatedMs: 0,
          seenInLastTick: false,
          presenceNoted: false,
          twitchUserId: chatter.twitchUserId || "",
          displayName: chatter.displayName || login,
        };
        entries.set(login, entry);
      } else {
        if (!entry.twitchUserId && chatter.twitchUserId) {
          entry.twitchUserId = chatter.twitchUserId;
        }
        if (chatter.displayName) entry.displayName = chatter.displayName;
      }

      const deltaMs = Math.max(0, seenAtMs - entry.lastSeenAtMs);
      const creditMs = entry.seenInLastTick
        ? Math.min(deltaMs, safeMaxTickMs)
        : safeTickMs;

      entry.accumulatedMs += creditMs;
      entry.lastSeenAtMs = seenAtMs;
      entry.seenInLastTick = true;
      creditedMs += creditMs;

      if (!entry.presenceNoted) presenceLogins.push(login);
    }

    return {
      presentLogins: Array.from(present.keys()),
      presenceLogins,
      creditedMs,
      trackedLogins: entries.size,
    };
  }

  function markPresenceNoted(login) {
    const entry = entries.get(normalizeLogin(login));
    if (entry) entry.presenceNoted = true;
  }

  function snapshot(targetStreamId = streamId) {
    const safeStreamId = normalizeStreamId(targetStreamId);
    return Array.from(entries.entries())
      .map(([login, entry]) => ({
        login,
        streamId: safeStreamId,
        firstSeenAtMs: entry.firstSeenAtMs,
        lastSeenAtMs: entry.lastSeenAtMs,
        accumulatedMs: Math.max(0, Math.floor(entry.accumulatedMs || 0)),
        twitchUserId: entry.twitchUserId || "",
        displayName: entry.displayName || login,
      }))
      .filter((entry) => entry.login && entry.streamId && entry.accumulatedMs > 0);
  }

  function removeLogins(logins = []) {
    const removed = [];
    for (const rawLogin of Array.isArray(logins) ? logins : []) {
      const login = normalizeLogin(rawLogin?.login || rawLogin);
      if (!login || !entries.has(login)) continue;
      entries.delete(login);
      removed.push(login);
    }
    return removed;
  }

  return {
    reset,
    markSeen,
    markPresenceNoted,
    snapshot,
    removeLogins,
    clear: () => entries.clear(),
    hasEntries: () => entries.size > 0,
    get streamId() {
      return streamId;
    },
    get startedAt() {
      return startedAt;
    },
    tickMs: safeTickMs,
    maxTickMs: safeMaxTickMs,
  };
}

/**
 * @param {Object} deps
 * @param {import('firebase-admin').firestore.Firestore} deps.db
 * @param {{ getAccessToken: () => Promise<string> }} deps.tokenManager
 * @param {string} deps.clientId
 * @param {string} deps.broadcasterId
 * @param {string} deps.moderatorId
 * @param {Object} [deps.questStore]
 */
function createLivePresenceTicker({
  db,
  tokenManager,
  clientId,
  broadcasterId,
  moderatorId,
  questStore,
  uptimeTickMs,
  uptimeMaxTickMs,
  deferPresenceWrites = false,
  onDeferredPresence,
}) {
  if (!db || !tokenManager || !clientId || !broadcasterId || !moderatorId) {
    throw new Error("createLivePresenceTicker: parametres manquants");
  }
  const helix = makeHelix({ tokenManager, clientId });
  const store = questStore;
  const uptime = createUptimeAccumulator({
    tickMs: uptimeTickMs,
    maxTickMs: uptimeMaxTickMs,
  });
  let deferredPresenceHandler =
    typeof onDeferredPresence === "function" ? onDeferredPresence : null;

  let CURRENT_STREAM_ID = null;
  let CURRENT_STARTED_AT = null;

  async function getCurrentStreamInfo() {
    const { data } = await helix({
      url: "https://api.twitch.tv/helix/streams",
      params: { user_id: broadcasterId, first: 1 },
    });
    const s = data?.data?.[0];
    if (!s) return null;
    return { id: s.id, started_at: s.started_at, title: s.title };
  }

  async function fetchAllChatters() {
    const chatters = [];
    let cursor = null;
    let guard = 0;

    do {
      const { data } = await helix({
        url: "https://api.twitch.tv/helix/chat/chatters",
        params: {
          broadcaster_id: broadcasterId,
          moderator_id: moderatorId,
          first: 1000,
          after: cursor || undefined,
        },
      });
      const arr = data?.data || [];
      arr.forEach((c) => {
        const login = normalizeLogin(c?.user_login);
        if (login) {
          chatters.push({
            login,
            user_login: login,
            user_name: c?.user_name || c?.user_login || login,
            user_id: c?.user_id || "",
          });
        }
      });
      cursor = data?.pagination?.cursor || null;
      guard += 1;
    } while (cursor && guard < 20);

    return chatters;
  }

  async function flushStreamUptime(streamId, { reason = "live-end" } = {}) {
    const safeStreamId = normalizeStreamId(streamId || uptime.streamId);
    const entries = uptime.snapshot(safeStreamId);
    if (!safeStreamId || !entries.length) {
      return {
        streamId: safeStreamId || null,
        processed: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
      };
    }

    if (!store || typeof store.finalizeLiveUptime !== "function") {
      console.warn("[ticker] uptime flush skipped: finalizeLiveUptime missing");
      return {
        streamId: safeStreamId,
        processed: 0,
        applied: 0,
        skipped: 0,
        failed: entries.length,
        reason: "missing_store_method",
      };
    }

    console.log(
      `[ticker] flushing uptime stream=${safeStreamId} users=${entries.length} reason=${reason}`,
    );

    let applied = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i += UPTIME_FLUSH_CHUNK_SIZE) {
      const slice = entries.slice(i, i + UPTIME_FLUSH_CHUNK_SIZE);
      const results = await Promise.all(
        slice.map(async (entry) => {
          try {
            if (
              deferPresenceWrites &&
              typeof store.noteLiveActivity === "function"
            ) {
              return await store.noteLiveActivity(entry.login, safeStreamId, {
                startedAt: uptime.startedAt,
                uptimeMs: entry.accumulatedMs,
                presenceFirstSeenAtMs: entry.firstSeenAtMs,
                presenceLastSeenAtMs: entry.lastSeenAtMs,
                flushId:
                  `live-activity:${safeStreamId}:${entry.login}:` +
                  `uptime-${safeStreamId}-${entry.login}-${entry.firstSeenAtMs || 0}-` +
                  `${entry.lastSeenAtMs || 0}-${entry.accumulatedMs || 0}`,
                reason,
              });
            }
            return await store.finalizeLiveUptime(entry.login, safeStreamId, {
              uptimeMs: entry.accumulatedMs,
              startedAt: uptime.startedAt,
              endedAt: new Date(),
            });
          } catch (e) {
            console.warn(
              `[ticker] uptime finalize failed for ${entry.login}:`,
              e?.message || e,
            );
            return { failed: true };
          }
        }),
      );

      results.forEach((result) => {
        if (result?.failed) failed += 1;
        else if (result?.applied) applied += 1;
        else skipped += 1;
      });
    }

    uptime.clear();
    console.log(
      `[ticker] uptime flush done stream=${safeStreamId} applied=${applied} skipped=${skipped} failed=${failed}`,
    );

    return {
      streamId: safeStreamId,
      processed: entries.length,
      applied,
      skipped,
      failed,
    };
  }

  async function runTick() {
    try {
      console.log("[ticker] polling stream...");

      const stream = await getCurrentStreamInfo();

      if (!stream) {
        if (CURRENT_STREAM_ID) {
          console.log("[ticker] stream ended - waiting offline confirmation");
        } else {
          console.log("[ticker] offline");
        }
        CURRENT_STREAM_ID = null;
        CURRENT_STARTED_AT = null;
        return;
      }

      if (stream.id !== CURRENT_STREAM_ID) {
        if (uptime.hasEntries() && uptime.streamId && uptime.streamId !== stream.id) {
          await flushStreamUptime(uptime.streamId, { reason: "stream-switch" });
        }

        CURRENT_STREAM_ID = stream.id;
        CURRENT_STARTED_AT = stream.started_at
          ? new Date(stream.started_at)
          : null;
        uptime.reset(CURRENT_STREAM_ID, CURRENT_STARTED_AT);
        console.log(
          `[ticker] new stream detected id=${CURRENT_STREAM_ID} started_at=${
            CURRENT_STARTED_AT?.toISOString() || "?"
          }`,
        );
      }

      const chatters = await fetchAllChatters();
      console.log(`[ticker] chatters fetched: ${chatters.length}`);

      const uptimeTick = uptime.markSeen(chatters, Date.now());
      if (!uptimeTick.presentLogins.length) return;

      const toProcess = uptimeTick.presenceLogins;
      if (!toProcess.length) {
        console.log(
          `[ticker] uptime credited ${Math.floor(
            uptimeTick.creditedMs / 60000,
          )} minute(s), no new presence to process`,
        );
        return;
      }

      const CHUNK = 50;
      let processed = 0;

      for (let i = 0; i < toProcess.length; i += CHUNK) {
        const slice = toProcess.slice(i, i + CHUNK);
        if (deferPresenceWrites) {
          await Promise.all(
            slice.map(async (login) => {
              uptime.markPresenceNoted(login);
              processed += 1;
              if (typeof deferredPresenceHandler !== "function") return;
              try {
                await deferredPresenceHandler({
                  login,
                  streamId: CURRENT_STREAM_ID,
                  startedAt: CURRENT_STARTED_AT,
                });
              } catch (e) {
                console.warn(
                  `[ticker] deferred presence handler failed for ${login}:`,
                  e?.message || e,
                );
              }
            }),
          );
        } else {
          await Promise.all(
            slice.map(async (login) => {
              try {
                await store.notePresence(login, CURRENT_STREAM_ID, {
                  startedAt: CURRENT_STARTED_AT,
                  context: null,
                });
                uptime.markPresenceNoted(login);
                processed += 1;
              } catch (e) {
                console.warn(
                  `[ticker] presence+1 failed for ${login}:`,
                  e?.message || e,
                );
              }
            }),
          );
        }
      }

      console.log(
        `[ticker] processed ${processed} new logins (stream ${CURRENT_STREAM_ID}, uptime +${Math.floor(
          uptimeTick.creditedMs / 60000,
        )}m)`,
      );
    } catch (e) {
      console.warn("[ticker] error:", e?.response?.data || e.message || e);
    }
  }

  runTick.getLiveStreamState = () => ({
    streamId: CURRENT_STREAM_ID,
    startedAt: CURRENT_STARTED_AT,
  });
  runTick.flushStreamUptime = flushStreamUptime;
  runTick.getPendingUptime = (targetStreamId = uptime.streamId) =>
    uptime.snapshot(targetStreamId);
  runTick.clearPendingUptime = (entries = []) => uptime.removeLogins(entries);
  runTick.isPresenceDeferred = () => !!deferPresenceWrites;
  runTick.setDeferredPresenceHandler = (handler) => {
    deferredPresenceHandler = typeof handler === "function" ? handler : null;
  };

  return runTick;
}

module.exports = {
  createLivePresenceTicker,
  _test: {
    createUptimeAccumulator,
  },
};
