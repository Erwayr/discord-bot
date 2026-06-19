// script/questStorage.js
"use strict";

const admin = require("firebase-admin");
const {
  applyCommunityLevelUptime,
  applyCommunityLevelXpProgress,
  applyChatMessageLevelProgress,
  resolveCommunityLevelConfig,
} = require("./communityLevel");
const CHAT_MESSAGE_CAP_PER_STREAM = 10;
const STREAM_RESTART_MERGE_WINDOW_MS = 3 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

function monthKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function dayKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function toDateMaybe(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "object" && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
  }
  return null;
}

function dayKeyFromValue(value) {
  const d = toDateMaybe(value);
  return d ? dayKeyUTC(d) : null;
}

function streamDayKey(entry) {
  if (!entry) return null;
  return (
    entry.day_key ||
    dayKeyFromValue(entry.started_at) ||
    dayKeyFromValue(entry?.presence?.first_at) ||
    dayKeyFromValue(entry?.presence?.last_at) ||
    null
  );
}

function timestampToMs(value) {
  const d = toDateMaybe(value);
  return d ? d.getTime() : null;
}

function normalizeStreamId(streamId) {
  return String(streamId || "").trim();
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

function streamHasId(entry, streamId) {
  const safeStreamId = normalizeStreamId(streamId);
  return !!safeStreamId && streamIdsFor(entry).has(safeStreamId);
}

function rememberStreamId(entry, streamId) {
  const safeStreamId = normalizeStreamId(streamId);
  if (!entry || !safeStreamId) return;

  const ids = streamIdsFor(entry);
  if (!entry.stream_id) entry.stream_id = safeStreamId;
  ids.add(normalizeStreamId(entry.stream_id));
  ids.add(safeStreamId);

  if (ids.size > 1) {
    entry.stream_ids = Array.from(ids);
  }
}

function latestKnownActivityMs(entry) {
  if (!entry) return null;
  const candidates = [
    entry?.ended_at,
    entry?.presence?.last_at,
    entry?.chat_message?.last_at,
    entry?.emote?.last_at,
    entry?.clips?.last_at,
    entry?.channel_points?.last_at,
    entry?.raid?.at,
    entry?.started_at,
    entry?.at,
    entry?.date,
    entry?.timestamp,
  ];

  let latest = null;
  for (const candidate of candidates) {
    const ms = timestampToMs(candidate);
    if (ms == null) continue;
    latest = latest == null ? ms : Math.max(latest, ms);
  }
  return latest;
}

function findRestartMergeIndex(streams, dayKey, startedDate) {
  if (!dayKey || !startedDate) return -1;

  const startedMs = startedDate.getTime();
  let best = { idx: -1, gapMs: Infinity };

  streams.forEach((stream, idx) => {
    if (streamDayKey(stream) !== dayKey) return;
    const lastActivityMs = latestKnownActivityMs(stream);
    if (lastActivityMs == null || lastActivityMs > startedMs) return;

    const gapMs = startedMs - lastActivityMs;
    if (gapMs < STREAM_RESTART_MERGE_WINDOW_MS && gapMs < best.gapMs) {
      best = { idx, gapMs };
    }
  });

  return best.idx;
}

function ensureMonthLayer(livePresence, monthKey) {
  const month = { ...(livePresence[monthKey] || {}) };
  month.streams = Array.isArray(month.streams) ? [...month.streams] : [];
  livePresence[monthKey] = month;
  return month;
}

function pickContext(ctx = {}) {
  // on ne garde que le nécessaire (évite les gros objets)
  const out = {};
  if (ctx.title != null) out.title = ctx.title;
  if (ctx.game_id != null) out.game_id = ctx.game_id;
  if (ctx.game_name != null) out.game_name = ctx.game_name;
  if (ctx.lang != null) out.lang = ctx.lang;
  if (ctx.chat != null) {
    out.chat = {
      slow_mode: !!ctx.chat.slow_mode,
      followers_only: !!ctx.chat.followers_only,
      sub_only: !!ctx.chat.sub_only,
      emote_only: !!ctx.chat.emote_only,
    };
  }
  return out;
}

function findStreamIndex(streams, streamId) {
  return streams.findIndex((s) => streamHasId(s, streamId));
}

function findStreamEntryAcrossMonths(livePresence, streamId) {
  if (!livePresence || typeof livePresence !== "object") return null;
  const safeStreamId = normalizeStreamId(streamId);
  if (!safeStreamId) return null;

  for (const monthKey of Object.keys(livePresence).sort()) {
    const month = livePresence[monthKey];
    if (!month || typeof month !== "object") continue;
    month.streams = Array.isArray(month.streams) ? [...month.streams] : [];
    const idx = findStreamIndex(month.streams, safeStreamId);
    if (idx < 0) continue;
    return {
      monthKey,
      month,
      idx,
      entry: month.streams[idx],
    };
  }

  return null;
}

function uptimeMinutesFromMs(value) {
  const ms = Math.max(0, Math.floor(Number(value) || 0));
  return Math.floor(ms / MS_PER_MINUTE);
}

function finalizedUptimeStreamIds(entry) {
  const raw = entry?.presence?.uptime_finalized_stream_ids;
  return Array.isArray(raw)
    ? raw.map((id) => normalizeStreamId(id)).filter(Boolean)
    : [];
}

function normalizeActivityEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event) => {
      const atMs = Math.max(0, Math.floor(Number(event?.atMs) || Date.now()));
      const count = Math.max(1, Math.floor(Number(event?.count) || 1));
      return { atMs, count };
    })
    .filter((event) => event.atMs > 0 && event.count > 0)
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * Helpers pour journaliser les quêtes par STREAM (tableau).
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function createQuestStorage(db, options = {}) {
  const col = db.collection("followers_all_time");
  const communityLevelConfig = resolveCommunityLevelConfig(options.communityLevel || {});

  async function getCommunityLevelConfig() {
    if (typeof options.getCommunityLevelConfig !== "function") {
      return communityLevelConfig;
    }
    try {
      return resolveCommunityLevelConfig(await options.getCommunityLevelConfig());
    } catch (e) {
      console.warn("[community-level] config load failed:", e?.message || e);
      return communityLevelConfig;
    }
  }

  /**
   * Assure qu'un objet stream existe et le retourne (par index).
   * Incrémente month.count la 1ère fois qu'on marque presence.seen=true.
   */
  async function ensureStreamEntry(
    tx,
    ref,
    month,
    streamId,
    startedAt,
    context
  ) {
    const idx = findStreamIndex(month.streams, streamId);
    if (idx >= 0) return { idx, created: false };

    const startedDate = toDateMaybe(startedAt);
    const anchorDate = startedDate || new Date();
    const dayKey = dayKeyUTC(anchorDate);
    const restartIdx = findRestartMergeIndex(
      month.streams,
      dayKey,
      startedDate
    );
    if (restartIdx >= 0) {
      const entry = month.streams[restartIdx];
      rememberStreamId(entry, streamId);
      if (!entry.day_key) entry.day_key = dayKey;
      return { idx: restartIdx, created: false };
    }

    const entry = {
      stream_id: streamId,
      started_at: startedDate
        ? admin.firestore.Timestamp.fromDate(startedDate)
        : null,
      day_key: dayKey,
      presence: { seen: false, first_at: null, last_at: null },
      chat_message: { sent: false, count: 0, first_at: null, last_at: null },
      emote: { used: false, count: 0, last_at: null },
      clips: { count: 0, last_id: null, last_at: null },
      channel_points: { used: false, redemptions: 0, last_at: null },
      raid: { participated: false, at: null },
      context: pickContext(context || {}),
    };

    month.streams.push(entry);
    return { idx: month.streams.length - 1, created: true };
  }

  async function notePresence(login, streamId, { startedAt, context } = {}) {
    const ref = col.doc(login);
    let presenceLevelResult = null;
    const effectiveCommunityLevelConfig = await getCommunityLevelConfig();

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data() || {};
      const lp = { ...(data.live_presence || {}) };
      const mk = monthKeyUTC();
      const month = ensureMonthLayer(lp, mk);

      const { idx } = await ensureStreamEntry(
        tx,
        ref,
        month,
        streamId,
        startedAt,
        context
      );
      const entry = month.streams[idx];

      const wasSeen = !!entry.presence.seen;
      entry.presence.seen = true;
      const nowMs = Date.now();
      if (!entry.presence.first_at) entry.presence.first_at = nowMs;
      entry.presence.last_at = nowMs;

      // compteur mensuel optionnel
      if (!wasSeen) {
        month.count = (month.count || 0) + 1;
        presenceLevelResult = applyCommunityLevelXpProgress({
          data,
          entry,
          streamId,
          nowMs,
          rawConfig: effectiveCommunityLevelConfig,
          source: "presence",
        });
      }

      month.last_update_at = nowMs;
      const patch = { live_presence: lp };
      if (presenceLevelResult?.awarded) {
        patch.communityLevel = presenceLevelResult.communityLevel;
        Object.assign(patch, presenceLevelResult.legacyFields);
      }
      tx.update(ref, patch);
    });

    return {
      levelAwarded: !!presenceLevelResult?.awarded,
      levelXp: presenceLevelResult?.awardXp || 0,
      level: presenceLevelResult?.level || null,
      rankName: presenceLevelResult?.communityLevel?.rankName || "",
      leveledUp: !!presenceLevelResult?.leveledUp,
      reason: presenceLevelResult?.reason || null,
    };
  }

  async function finalizeLiveUptime(
    login,
    streamId,
    { uptimeMs = 0, startedAt = null, endedAt = null } = {},
  ) {
    const docId = String(login || "").trim().toLowerCase();
    const safeStreamId = normalizeStreamId(streamId);
    const uptimeMinutes = uptimeMinutesFromMs(uptimeMs);
    if (!docId || !safeStreamId) {
      return { applied: false, reason: "invalid_target" };
    }
    if (uptimeMinutes <= 0) {
      return { applied: false, reason: "no_uptime" };
    }

    const ref = col.doc(docId);
    const participantRef = db.collection("participants").doc(docId);
    let result = {
      applied: false,
      reason: "not_processed",
      login: docId,
      streamId: safeStreamId,
      uptimeMinutesAdded: 0,
    };

    await db.runTransaction(async (tx) => {
      const [snap, participantSnap] = await Promise.all([
        tx.get(ref),
        tx.get(participantRef),
      ]);
      if (!snap.exists) {
        result = {
          ...result,
          reason: "missing_follower",
        };
        return;
      }

      const data = snap.data() || {};
      const lp = { ...(data.live_presence || {}) };
      let found = findStreamEntryAcrossMonths(lp, safeStreamId);

      if (!found) {
        const anchorDate =
          toDateMaybe(startedAt) || toDateMaybe(endedAt) || new Date();
        const mk = monthKeyUTC(anchorDate);
        const month = ensureMonthLayer(lp, mk);
        const ensured = await ensureStreamEntry(
          tx,
          ref,
          month,
          safeStreamId,
          startedAt,
        );
        found = {
          monthKey: mk,
          month,
          idx: ensured.idx,
          entry: month.streams[ensured.idx],
        };
      }

      const entry = found.entry;
      entry.presence = {
        seen: false,
        first_at: null,
        last_at: null,
        ...(entry.presence || {}),
      };

      const finalizedIds = finalizedUptimeStreamIds(entry);
      if (finalizedIds.includes(safeStreamId)) {
        result = {
          ...result,
          reason: "already_finalized",
          monthKey: found.monthKey,
          uptimeMinutesAdded: 0,
        };
        return;
      }

      const nowMs = Date.now();
      const wasSeen = !!entry.presence.seen;
      entry.presence.seen = true;
      if (!wasSeen) {
        found.month.count = Math.max(0, Number(found.month.count || 0)) + 1;
      }
      if (!entry.presence.first_at) entry.presence.first_at = nowMs;
      entry.presence.last_at = nowMs;
      entry.presence.uptime_minutes =
        Math.max(0, Math.floor(Number(entry.presence.uptime_minutes || 0))) +
        uptimeMinutes;
      entry.presence.uptime_finalized_stream_ids = [
        ...finalizedIds,
        safeStreamId,
      ];
      found.month.last_update_at = nowMs;

      const uptimeResult = applyCommunityLevelUptime({
        data,
        uptimeMinutes,
        nowMs,
      });
      if (!uptimeResult.applied) {
        result = {
          ...result,
          reason: uptimeResult.reason || "no_uptime",
          monthKey: found.monthKey,
        };
        return;
      }

      tx.update(ref, {
        live_presence: lp,
        communityLevel: uptimeResult.communityLevel,
      });

      if (participantSnap.exists) {
        tx.set(
          participantRef,
          {
            communityLevel: {
              uptimeMinutes: uptimeResult.uptimeMinutes,
              uptimeText: uptimeResult.uptimeText,
              source: "twitch_presence_uptime",
              updatedAt: nowMs,
            },
          },
          { merge: true },
        );
      }

      result = {
        applied: true,
        reason: "applied",
        login: docId,
        streamId: safeStreamId,
        monthKey: found.monthKey,
        uptimeMinutesAdded: uptimeMinutes,
        uptimeMinutes: uptimeResult.uptimeMinutes,
        uptimeText: uptimeResult.uptimeText,
        participantMirrored: !!participantSnap.exists,
      };
    });

    return result;
  }

  async function noteEmoteUsage(login, streamId, inc = 1, { startedAt } = {}) {
    const docId = login.toLowerCase();
    const ref = col.doc(docId);
    const mk = monthKeyUTC();

    console.log(
      `[EMOTE:TX] start login=${docId} stream=${streamId} +${inc} month=${mk}`
    );

    await db
      .runTransaction(async (tx) => {
        const snap = await tx.get(ref);

        if (!snap.exists) {
          console.log(`[EMOTE:TX] creating doc followers_all_time/${docId}`);
          tx.set(ref, { pseudo: docId, live_presence: {} }, { merge: true });
        }

        const data = snap.exists ? snap.data() : {};
        const lp = { ...(data?.live_presence || {}) };
        const month = ensureMonthLayer(lp, mk);

        const { idx, created } = await ensureStreamEntry(
          tx,
          ref,
          month,
          streamId,
          startedAt
        );
        const entry = month.streams[idx];
        const before = entry.emote?.count || 0;

        entry.emote.used = true;
        entry.emote.count = (entry.emote.count || 0) + Math.max(1, inc);
        entry.emote.last_at = Date.now();

        month.last_update_at = Date.now();

        tx.update(ref, { live_presence: lp });

        console.log(
          `[EMOTE:TX] doc=${docId} idx=${idx} ` +
            `streamCreated=${!!created} before=${before} after=${
              entry.emote.count
            }`
        );
      })
      .then(() => {
        console.log(`[EMOTE:TX] commit OK login=${docId} stream=${streamId}`);
      })
      .catch((e) => {
        console.error(
          `[EMOTE:TX] commit FAIL login=${docId} stream=${streamId}`
        );
        console.error(e?.stack || e?.message || e);
        throw e; // laisse remonter pour le log dans l'appelant
      });
  }

  async function noteChatMessage(login, streamId, inc = 1, { startedAt } = {}) {
    const docId = login.toLowerCase();
    const ref = col.doc(docId);
    const mk = monthKeyUTC();
    const safeInc = Math.max(1, Math.floor(Number(inc) || 1));
    let nextCount = 0;
    let chatLevelResult = null;
    const effectiveCommunityLevelConfig = await getCommunityLevelConfig();

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      // cree le doc minimal si absent
      if (!snap.exists) {
        tx.set(ref, { pseudo: docId, live_presence: {} }, { merge: true });
      }

      const data = snap.exists ? snap.data() : {};
      const lp = { ...(data?.live_presence || {}) };
      const month = ensureMonthLayer(lp, mk);

      const { idx } = await ensureStreamEntry(
        tx,
        ref,
        month,
        streamId,
        startedAt,
      );
      const entry = month.streams[idx];

      entry.chat_message = {
        sent: false,
        count: 0,
        first_at: null,
        last_at: null,
        ...(entry.chat_message || {}),
      };

      const beforeCount = Math.max(
        0,
        Math.floor(Number(entry.chat_message.count || 0)),
      );
      nextCount = Math.min(CHAT_MESSAGE_CAP_PER_STREAM, beforeCount + safeInc);
      const levelResult = applyChatMessageLevelProgress({
        data,
        entry,
        streamId,
        nowMs: Date.now(),
        rawConfig: effectiveCommunityLevelConfig,
        eventCount: safeInc,
      });
      chatLevelResult = levelResult;

      if (
        nextCount === beforeCount &&
        entry.chat_message.sent &&
        !levelResult.awarded
      ) {
        return;
      }

      if (nextCount !== beforeCount || !entry.chat_message.sent) {
        entry.chat_message.sent = true;
        entry.chat_message.count = nextCount;
        if (!entry.chat_message.first_at) entry.chat_message.first_at = Date.now();
        entry.chat_message.last_at = Date.now();
      }

      month.last_update_at = Date.now();
      const patch = { live_presence: lp };
      if (levelResult.awarded) {
        patch.communityLevel = levelResult.communityLevel;
        Object.assign(patch, levelResult.legacyFields);
      }
      tx.update(ref, patch);
    });

    return {
      count: nextCount,
      capped: nextCount >= CHAT_MESSAGE_CAP_PER_STREAM,
      levelAwarded: !!chatLevelResult?.awarded,
      levelXp: chatLevelResult?.awardXp || 0,
      level: chatLevelResult?.level || null,
      rankName: chatLevelResult?.communityLevel?.rankName || "",
      leveledUp: !!chatLevelResult?.leveledUp,
    };
  }

  async function noteLiveActivity(
    login,
    streamId,
    { startedAt, chatEvents = [], emoteCount = 0 } = {},
  ) {
    const docId = String(login || "").trim().toLowerCase();
    const safeStreamId = normalizeStreamId(streamId);
    const normalizedChatEvents = normalizeActivityEvents(chatEvents);
    const safeEmoteCount = Math.max(0, Math.floor(Number(emoteCount) || 0));
    if (!docId || !safeStreamId) {
      return { applied: false, reason: "invalid_target" };
    }
    if (!normalizedChatEvents.length && safeEmoteCount <= 0) {
      return { applied: false, reason: "empty_activity" };
    }

    const ref = col.doc(docId);
    const mk = monthKeyUTC();
    let result = {
      applied: false,
      login: docId,
      streamId: safeStreamId,
      chatEvents: normalizedChatEvents.length,
      chatCount: 0,
      chatCapped: false,
      emoteCount: safeEmoteCount,
      levelAwarded: false,
      levelXp: 0,
      level: null,
      rankName: "",
      leveledUp: false,
      levelUps: [],
    };
    const effectiveCommunityLevelConfig = normalizedChatEvents.length
      ? await getCommunityLevelConfig()
      : null;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      const workingData = { ...data };
      const lp = { ...(data.live_presence || {}) };
      const month = ensureMonthLayer(lp, mk);

      const { idx, created } = await ensureStreamEntry(
        tx,
        ref,
        month,
        safeStreamId,
        startedAt,
      );
      const entry = month.streams[idx];
      let latestAtMs = Date.now();
      let latestLevelResult = null;
      const patch = { live_presence: lp };

      if (normalizedChatEvents.length) {
        entry.chat_message = {
          sent: false,
          count: 0,
          first_at: null,
          last_at: null,
          ...(entry.chat_message || {}),
        };

        for (const event of normalizedChatEvents) {
          latestAtMs = Math.max(latestAtMs, event.atMs);
          const beforeCount = Math.max(
            0,
            Math.floor(Number(entry.chat_message.count || 0)),
          );
          const nextCount = Math.min(
            CHAT_MESSAGE_CAP_PER_STREAM,
            beforeCount + event.count,
          );
          const levelResult = applyChatMessageLevelProgress({
            data: workingData,
            entry,
            streamId: safeStreamId,
            nowMs: event.atMs,
            rawConfig: effectiveCommunityLevelConfig,
            eventCount: event.count,
          });

          if (nextCount !== beforeCount || !entry.chat_message.sent) {
            entry.chat_message.sent = true;
            entry.chat_message.count = nextCount;
            if (!entry.chat_message.first_at) {
              entry.chat_message.first_at = event.atMs;
            }
            entry.chat_message.last_at = event.atMs;
          }

          if (levelResult.awarded) {
            latestLevelResult = levelResult;
            workingData.communityLevel = levelResult.communityLevel;
            Object.assign(workingData, levelResult.legacyFields);
            if (levelResult.leveledUp) {
              result.levelUps.push({
                level: levelResult.level,
                rankName: levelResult.communityLevel?.rankName || "",
              });
            }
          }
        }

        result.chatCount = Math.max(
          0,
          Math.floor(Number(entry.chat_message.count || 0)),
        );
        result.chatCapped = result.chatCount >= CHAT_MESSAGE_CAP_PER_STREAM;
      }

      if (safeEmoteCount > 0) {
        entry.emote = {
          used: false,
          count: 0,
          last_at: null,
          ...(entry.emote || {}),
        };
        entry.emote.used = true;
        entry.emote.count =
          Math.max(0, Math.floor(Number(entry.emote.count || 0))) +
          safeEmoteCount;
        entry.emote.last_at = latestAtMs;
      }

      month.last_update_at = latestAtMs;
      if (latestLevelResult?.awarded) {
        patch.communityLevel = latestLevelResult.communityLevel;
        Object.assign(patch, latestLevelResult.legacyFields);
      }

      if (snap.exists) {
        tx.update(ref, patch);
      } else {
        tx.set(
          ref,
          {
            pseudo: docId,
            ...patch,
          },
          { merge: true },
        );
      }

      result = {
        ...result,
        applied: true,
        streamCreated: !!created,
        levelAwarded: !!latestLevelResult?.awarded,
        levelXp: latestLevelResult?.awardXp || 0,
        level: latestLevelResult?.level || null,
        rankName: latestLevelResult?.communityLevel?.rankName || "",
        leveledUp: result.levelUps.length > 0,
      };
    });

    return result;
  }

  async function noteClipCreated(
    login,
    streamId,
    clipId = null,
    { startedAt } = {}
  ) {
    const ref = col.doc(login);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data() || {};
      const lp = { ...(data.live_presence || {}) };
      const mk = monthKeyUTC();
      const month = ensureMonthLayer(lp, mk);

      const { idx } = await ensureStreamEntry(
        tx,
        ref,
        month,
        streamId,
        startedAt
      );
      const entry = month.streams[idx];

      entry.clips.count = (entry.clips.count || 0) + 1;
      if (clipId) entry.clips.last_id = clipId;
      entry.clips.last_at = Date.now();

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  async function noteChannelPoints(
    login,
    streamId,
    redemptionsInc = 1,
    { startedAt } = {}
  ) {
    const docId = login.toLowerCase();
    const ref = col.doc(docId);
    const safeInc = Math.max(1, Math.floor(Number(redemptionsInc) || 1));
    let channelPointsLevelResult = null;
    const effectiveCommunityLevelConfig = await getCommunityLevelConfig();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      // 🔧 crée le doc minimal si absent
      if (!snap.exists) {
        tx.set(
          ref,
          { pseudo: docId, live_presence: {} },
          { merge: true }
        );
      }

      const data = snap.exists ? snap.data() : {};
      const lp = { ...(data.live_presence || {}) };
      const mk = monthKeyUTC();
      const month = ensureMonthLayer(lp, mk);

      const { idx } = await ensureStreamEntry(
        tx,
        ref,
        month,
        streamId,
        startedAt
      );
      const entry = month.streams[idx];

      entry.channel_points.used = true;
      entry.channel_points.redemptions =
        (entry.channel_points.redemptions || 0) + safeInc;
      const nowMs = Date.now();
      entry.channel_points.last_at = nowMs;
      channelPointsLevelResult = applyCommunityLevelXpProgress({
        data,
        entry,
        streamId,
        nowMs,
        rawConfig: effectiveCommunityLevelConfig,
        source: "channel_points",
        eventCount: safeInc,
      });

      month.last_update_at = nowMs;
      const patch = { live_presence: lp };
      if (channelPointsLevelResult.awarded) {
        patch.communityLevel = channelPointsLevelResult.communityLevel;
        Object.assign(patch, channelPointsLevelResult.legacyFields);
      }
      tx.update(ref, patch);
    });

    return {
      levelAwarded: !!channelPointsLevelResult?.awarded,
      levelXp: channelPointsLevelResult?.awardXp || 0,
      level: channelPointsLevelResult?.level || null,
      rankName: channelPointsLevelResult?.communityLevel?.rankName || "",
      leveledUp: !!channelPointsLevelResult?.leveledUp,
      reason: channelPointsLevelResult?.reason || null,
    };
  }

  async function noteRaidParticipation(login, streamId, { startedAt } = {}) {
    const ref = col.doc(login);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data() || {};
      const lp = { ...(data.live_presence || {}) };
      const mk = monthKeyUTC();
      const month = ensureMonthLayer(lp, mk);

      const { idx } = await ensureStreamEntry(
        tx,
        ref,
        month,
        streamId,
        startedAt
      );
      const entry = month.streams[idx];

      if (!entry.raid.participated) {
        entry.raid.participated = true;
        entry.raid.at = Date.now();
      }

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  /**
   * (Optionnel) mets/merge le contexte du stream sur l'entrée (titre, jeu, chat…)
   */
  async function updateStreamContext(login, streamId, ctx = {}) {
    const ref = col.doc(login);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data() || {};
      const lp = { ...(data.live_presence || {}) };
      const mk = monthKeyUTC();
      const month = ensureMonthLayer(lp, mk);

      const { idx } = await ensureStreamEntry(tx, ref, month, streamId);
      const entry = month.streams[idx];

      entry.context = { ...(entry.context || {}), ...pickContext(ctx) };
      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  return {
    notePresence,
    finalizeLiveUptime,
    noteLiveActivity,
    noteChatMessage,
    noteEmoteUsage,
    noteClipCreated,
    noteChannelPoints,
    noteRaidParticipation,
    updateStreamContext, // optionnel
  };
}

module.exports = { createQuestStorage };
