"use strict";

const axios = require("axios");
const admin = require("firebase-admin");

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
}) {
  if (!db || !tokenManager || !clientId || !broadcasterId || !moderatorId) {
    throw new Error("createLivePresenceTicker: paramètres manquants");
  }

  const store = questStore; // déjà injecté depuis index.js

  // État interne
  let CURRENT_STREAM_ID = null;
  let CURRENT_STARTED_AT = null;
  const COUNTED_LOGINS_THIS_STREAM = new Set();

  function monthKeyFrom(date = new Date()) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

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
    let cursor = null,
      guard = 0;

    do {
      const { data } = await axios.get(base, {
        headers,
        params: cursor ? { ...params, after: cursor } : params,
      });
      const arr = data?.data || [];
      arr.forEach(
        (c) => c?.user_login && logins.push(c.user_login.toLowerCase())
      );
      cursor = data?.pagination?.cursor || null;
      guard++;
    } while (cursor && guard < 20);

    return logins;
  }

  async function incrementMonthlyPresenceIfNeeded(login, streamId) {
    const ref = db.collection("followers_all_time").doc(login);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data() || {};
      const monthKey = monthKeyFrom();
      const presence = { ...(data.live_presence || {}) };
      const node = {
        count: 0,
        last_stream_id: null,
        last_increment_at: null,
        ...(presence[monthKey] || {}),
      };

      if (node.last_stream_id === streamId) return;

      node.count = (node.count || 0) + 1;
      node.last_stream_id = streamId;
      node.last_increment_at = admin.firestore.FieldValue.serverTimestamp();
      presence[monthKey] = node;

      tx.update(ref, { live_presence: presence });
    });
  }

  async function runTick() {
    try {
      console.log("▶️ [ticker] polling stream…"); // ✅ LOG

      const stream = await getCurrentStreamInfo();

      if (!stream) {
        if (CURRENT_STREAM_ID) {
          console.log("📴 [ticker] stream ended — reset local cache");
        } else {
          console.log("📴 [ticker] offline");
        }
        CURRENT_STREAM_ID = null;
        CURRENT_STARTED_AT = null;
        COUNTED_LOGINS_THIS_STREAM.clear();
        return;
      }

      if (stream.id !== CURRENT_STREAM_ID) {
        CURRENT_STREAM_ID = stream.id;
        CURRENT_STARTED_AT = stream.started_at
          ? new Date(stream.started_at)
          : null;
        COUNTED_LOGINS_THIS_STREAM.clear();
        console.log(
          `🔴 [ticker] new stream detected id=${CURRENT_STREAM_ID} started_at=${
            CURRENT_STARTED_AT?.toISOString() || "?"
          }`
        );
      }

      const chatters = await fetchAllChatters();
      console.log(`👥 [ticker] chatters fetched: ${chatters.length}`);

      if (!chatters.length) return;

      const toProcess = chatters.filter(
        (l) => !COUNTED_LOGINS_THIS_STREAM.has(l)
      );
      if (!toProcess.length) {
        console.log("ℹ️ [ticker] no new chatters to process this tick");
        return;
      }

      const CHUNK = 50;
      let processed = 0;

      for (let i = 0; i < toProcess.length; i += CHUNK) {
        const slice = toProcess.slice(i, i + CHUNK);
        await Promise.all(
          slice.map(async (login) => {
            try {
              await incrementMonthlyPresenceIfNeeded(login, CURRENT_STREAM_ID);
              await store.notePresence(login, CURRENT_STREAM_ID, {
                startedAt: CURRENT_STARTED_AT,
                context: null,
              });
              COUNTED_LOGINS_THIS_STREAM.add(login);
              processed++;
            } catch (e) {
              console.warn(
                `[ticker] presence+1 failed for ${login}:`,
                e?.message || e
              );
            }
          })
        );
      }

      console.log(
        `✅ [ticker] processed ${processed} new logins (stream ${CURRENT_STREAM_ID})`
      );
    } catch (e) {
      console.warn("⚠️ [ticker] error:", e?.response?.data || e.message || e);
    }
  }

  runTick.getLiveStreamState = () => ({
    streamId: CURRENT_STREAM_ID,
    startedAt: CURRENT_STARTED_AT,
  });

  return runTick;
}

module.exports = { createLivePresenceTicker };
