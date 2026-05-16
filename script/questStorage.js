// script/questStorage.js
"use strict";

const admin = require("firebase-admin");
const CHAT_MESSAGE_CAP_PER_STREAM = 10;
const STREAM_RESTART_MERGE_WINDOW_MS = 3 * 60 * 60 * 1000;

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

/**
 * Helpers pour journaliser les quêtes par STREAM (tableau).
 * @param {import('firebase-admin').firestore.Firestore} db
 */
function createQuestStorage(db) {
  const col = db.collection("followers_all_time");

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
      if (!entry.presence.first_at) entry.presence.first_at = Date.now();
      entry.presence.last_at = Date.now();

      // compteur mensuel optionnel
      if (!wasSeen) {
        month.count = (month.count || 0) + 1;
      }

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
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

      if (nextCount === beforeCount && entry.chat_message.sent) return;

      entry.chat_message.sent = true;
      entry.chat_message.count = nextCount;
      if (!entry.chat_message.first_at) entry.chat_message.first_at = Date.now();
      entry.chat_message.last_at = Date.now();

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });

    return {
      count: nextCount,
      capped: nextCount >= CHAT_MESSAGE_CAP_PER_STREAM,
    };
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
    const ref = col.doc(login.toLowerCase());
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      // 🔧 crée le doc minimal si absent
      if (!snap.exists) {
        tx.set(
          ref,
          { pseudo: login.toLowerCase(), live_presence: {} },
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
        (entry.channel_points.redemptions || 0) + Math.max(1, redemptionsInc);
      entry.channel_points.last_at = Date.now();

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
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
    noteChatMessage,
    noteEmoteUsage,
    noteClipCreated,
    noteChannelPoints,
    noteRaidParticipation,
    updateStreamContext, // optionnel
  };
}

module.exports = { createQuestStorage };
