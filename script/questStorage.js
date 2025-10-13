// script/questStorage.js
"use strict";

const admin = require("firebase-admin");

function monthKeyUTC(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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
  return streams.findIndex((s) => s && s.stream_id === streamId);
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

    const entry = {
      stream_id: streamId,
      started_at: startedAt
        ? admin.firestore.Timestamp.fromDate(new Date(startedAt))
        : null,
      presence: { seen: false, first_at: null, last_at: null },
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
      if (!entry.presence.first_at)
        entry.presence.first_at = Date.now();
      entry.presence.last_at = Date.now();

      // compteur mensuel optionnel
      if (!wasSeen) {
        month.count = (month.count || 0) + 1;
      }

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  async function noteEmoteUsage(login, streamId, inc = 1) {
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

      entry.emote.used = true;
      entry.emote.count = (entry.emote.count || 0) + Math.max(1, inc);
      entry.emote.last_at =  Date.now();

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  async function noteClipCreated(login, streamId, clipId = null) {
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

      entry.clips.count = (entry.clips.count || 0) + 1;
      if (clipId) entry.clips.last_id = clipId;
      entry.clips.last_at =  Date.now();

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  async function noteChannelPoints(login, streamId, redemptionsInc = 1) {
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

      entry.channel_points.used = true;
      entry.channel_points.redemptions =
        (entry.channel_points.redemptions || 0) + Math.max(1, redemptionsInc);
      entry.channel_points.last_at =
         Date.now();

      month.last_update_at = Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  async function noteRaidParticipation(login, streamId) {
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

      if (!entry.raid.participated) {
        entry.raid.participated = true;
        entry.raid.at =  Date.now();
      }

      month.last_update_at =  Date.now();
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
      month.last_update_at =  Date.now();
      tx.update(ref, { live_presence: lp });
    });
  }

  return {
    notePresence,
    noteEmoteUsage,
    noteClipCreated,
    noteChannelPoints,
    noteRaidParticipation,
    updateStreamContext, // optionnel
  };
}

module.exports = { createQuestStorage };
