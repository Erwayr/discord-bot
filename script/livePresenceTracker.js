// script/livePresenceTracker.js
"use strict";

const axios = require("axios");
const admin = require("firebase-admin");

/**
 * Fabrique un "tick" d’incrément de présence live (1x par stream / par user).
 * Tout l’état est encapsulé dans la closure du ticker (pas d’état global).
 *
 * @param {Object} deps
 * @param {import('firebase-admin').firestore.Firestore} deps.db
 * @param {{ getAccessToken: () => Promise<string> }} deps.tokenManager
 * @param {string} deps.clientId - Twitch Client ID
 * @param {string} deps.broadcasterId - ID numérique de la chaîne
 * @param {string} deps.moderatorId - ID numérique d’un mod (peut = broadcaster)
 */
function createLivePresenceTicker({
  db,
  tokenManager,
  clientId,
  broadcasterId,
  moderatorId,
  questStore,
}) {
  if (!db || !tokenManager || !clientId || !broadcasterId || !moderatorId) {
    throw new Error("createLivePresenceTicker: paramètres manquants");
  }

  // crée un store local si on ne l’a pas injecté
  const { createQuestStorage } = require("./questStorage");
  const store = questStore || createQuestStorage(db);

  // État interne (réinitialisé à chaque nouveau stream)
  let CURRENT_STREAM_ID = null;
  let CURRENT_STARTED_AT = null;
  const COUNTED_LOGINS_THIS_STREAM = new Set();

  // Clé mois "YYYY-MM" (UTC pour la stabilité entre serveurs)
  function monthKeyFrom(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  // Stream en cours (null si offline)
  async function getCurrentStreamInfo() {
    const accessToken = await tokenManager.getAccessToken();
    const { data } = await axios.get("https://api.twitch.tv/helix/streams", {
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${accessToken}`,
      },
      params: { user_id: broadcasterId, first: 1 },
    });
    const s = data?.data?.[0];
    if (!s) return null;
    return { id: s.id, started_at: s.started_at, title: s.title };
  }

  // Tous les chatters (pagination)
  async function fetchAllChatters() {
    const accessToken = await tokenManager.getAccessToken();
    const headers = {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
    };
    const base = "https://api.twitch.tv/helix/chat/chatters";
    const params = {
      broadcaster_id: broadcasterId,
      moderator_id: moderatorId,
      first: 1000,
    };

    const logins = [];
    let cursor = null;
    let guard = 0;

    do {
      const { data } = await axios.get(base, {
        headers,
        params: cursor ? { ...params, after: cursor } : params,
      });
      const arr = data?.data || [];
      for (const c of arr) {
        if (c?.user_login) logins.push(c.user_login.toLowerCase());
      }
      cursor = data?.pagination?.cursor || null;
      guard++;
    } while (cursor && guard < 20);

    return logins;
  }

  // Incrémente pour un login s’il a pas encore été compté sur ce stream
  async function incrementMonthlyPresenceIfNeeded(login, streamId) {
    const ref = db.collection("followers_all_time").doc(login);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return; // on ne compte que les users présents en BD

      const data = snap.data() || {};
      const monthKey = monthKeyFrom();
      const presence = { ...(data.live_presence || {}) };
      const node = {
        count: 0,
        last_stream_id: null,
        last_increment_at: null,
        ...(presence[monthKey] || {}),
      };

      // déjà compté pour ce stream → stop
      if (node.last_stream_id === streamId) return;

      node.count = (node.count || 0) + 1;
      node.last_stream_id = streamId;
      node.last_increment_at = admin.firestore.FieldValue.serverTimestamp();
      presence[monthKey] = node;

      tx.update(ref, { live_presence: presence });
    });
  }

  // Fonction rendue (appelée par le cron)
  async function runTick() {
    try {
      const stream = await getCurrentStreamInfo();

      // Pas en live → reset local + exit
      if (!stream) {
        if (CURRENT_STREAM_ID) {
          console.log("📴 Stream terminé — reset du cache local de présence.");
        }
        CURRENT_STREAM_ID = null;
        CURRENT_STARTED_AT = null;
        COUNTED_LOGINS_THIS_STREAM.clear();
        return;
      }

      // Nouveau stream détecté → reset
      if (stream.id !== CURRENT_STREAM_ID) {
        CURRENT_STREAM_ID = stream.id;
        CURRENT_STARTED_AT = stream.started_at
          ? new Date(stream.started_at)
          : null;
        COUNTED_LOGINS_THIS_STREAM.clear();
        console.log(
          `🔴 Nouveau stream (id=${CURRENT_STREAM_ID}) — compteur local réinitialisé.`
        );
        // Exemple au moment où tu détectes un nouveau stream (dans livePresenceTracker.js)
        // après avoir rafraîchi title/game/lang/chat …
        await Promise.all(
          chatters.map((login) =>
            store.updateStreamContext(login, CURRENT_STREAM_ID, {
              title,
              game_id,
              game_name,
              lang,
              chat: { slow_mode, followers_only, sub_only, emote_only },
            })
          )
        );
      }

      // Récupère les chatters
      const chatters = await fetchAllChatters();
      if (!chatters.length) return;

      // On évite de retraiter ceux déjà comptés localement
      const toProcess = chatters.filter(
        (l) => !COUNTED_LOGINS_THIS_STREAM.has(l)
      );

      // Traite par paquets
      const CHUNK = 50;
      for (let i = 0; i < toProcess.length; i += CHUNK) {
        const slice = toProcess.slice(i, i + CHUNK);
        await Promise.all(
          slice.map(async (login) => {
            try {
              await incrementMonthlyPresenceIfNeeded(login, CURRENT_STREAM_ID);
              await store.notePresence(login, CURRENT_STREAM_ID, {
                startedAt: CURRENT_STARTED_AT,
                context: null, // tu peux y passer titre/jeu si tu veux (voir updateStreamContext)
              });
              COUNTED_LOGINS_THIS_STREAM.add(login);
            } catch (e) {
              console.warn(
                `presence+1 échouée pour ${login}:`,
                e?.message || e
              );
            }
          })
        );
      }

      if (toProcess.length > 0) {
        console.log(
          `✅ Live presence tick: ${toProcess.length} logins traités (stream ${CURRENT_STREAM_ID}).`
        );
      }
    } catch (e) {
      console.warn(
        "⚠️ runTick (live presence) error:",
        e?.response?.data || e.message || e
      );
    }
  }

  runTick.getLiveStreamState = () => ({
    streamId: CURRENT_STREAM_ID,
    startedAt: CURRENT_STARTED_AT,
  });

  return runTick;
}

module.exports = { createLivePresenceTicker };
