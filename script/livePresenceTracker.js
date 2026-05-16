"use strict";

const { makeHelix } = require("../helper/helix");
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
  const helix = makeHelix({ tokenManager, clientId });
  const store = questStore; // déjà injecté depuis index.js

  // État interne
  let CURRENT_STREAM_ID = null;
  let CURRENT_STARTED_AT = null;
  const COUNTED_LOGINS_THIS_STREAM = new Set();

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
    const logins = [];
    let cursor = null,
      guard = 0;

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
      arr.forEach(
        (c) => c?.user_login && logins.push(c.user_login.toLowerCase())
      );
      cursor = data?.pagination?.cursor || null;
      guard++;
    } while (cursor && guard < 20);

    return logins;
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
