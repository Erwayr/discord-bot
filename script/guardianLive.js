"use strict";
const { randomUUID } = require("node:crypto");
const { syncGuardianLive, enqueueGuardianViewer, readElectedGuardian, publishGuardianChatGreeting } = require("./guardian-live.store.cjs");
const { CHAT_MAX_AGE_MS } = require("./guardian-actions.shared.cjs");

function createGuardianLive({ db, channelId, getLiveState, resolveTwitchIdentity, sendMessage, now = Date.now, logger = console }) {
  let timer = null;
  let ticking = false;
  const replies = new Map();
  let guardianPromise = null;
  let guardianCheckedAt = -Infinity;
  let greetingPending = false;
  async function noteChat(tags) {
    const userId = String(tags["user-id"] || "");
    const messageId = String(tags.id || "");
    const at = now();
    const sentAt = Number(tags["tmi-sent-ts"] || at);
    if (!/^\d{1,25}$/.test(userId) || !messageId || !Number.isFinite(sentAt) || at - sentAt > CHAT_MAX_AGE_MS || sentAt > at + 2000) return;
    try {
      if (!guardianPromise || at - guardianCheckedAt >= 15_000) {
        guardianCheckedAt = at;
        guardianPromise = readElectedGuardian({ db }).catch(error => { guardianPromise = null; throw error; });
      }
      const guardian = await guardianPromise;
      if (guardian.userId !== userId || greetingPending) return;
      greetingPending = true;
      try {
        const live = await getLiveState();
        // Chat reactions never refresh a live heartbeat or advance the queue.
        await publishGuardianChatGreeting({ db, channelId, streamId: live?.streamId || "", userId, messageId, now: at });
      } finally { greetingPending = false; }
    } catch (error) { logger.warn("[guardian-live] greeting failed", error.code || error.message); }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    const checkedAtMs = now();
    try {
      const live = await getLiveState();
      await syncGuardianLive({ db, channelId, streamId: live?.streamId || "", checkedAtMs });
    } catch (error) { logger.warn("[guardian-live] live check failed", error.code || error.message); }
    finally { ticking = false; }
  }
  async function handleMessage({ message, login, displayName, tags = {} }) {
    await noteChat(tags);
    if (!/^!perso\s*$/i.test(String(message).trim())) return { handled: false };
    const userId = String(tags["user-id"] || "");
    if (!/^\d{1,25}$/.test(userId)) return { handled: true, reason: "identity_missing" };
    const requestedAtMs = now();
    let result;
    try {
      const live = await getLiveState();
      let identity = { login };
      if (live?.streamId && typeof resolveTwitchIdentity === "function") {
        identity = await resolveTwitchIdentity({ login, twitchUserId: userId, allowCreate: false });
      }
      result = await enqueueGuardianViewer({
        db, channelId, streamId: live?.streamId || "", now: requestedAtMs,
        request: { userId, login: identity.login || login, displayName, requestId: String(tags.id || randomUUID()) },
      });
    } catch (error) {
      logger.warn("[guardian-live] request failed", error.code || error.message);
      result = { accepted: false, reason: error.code === "twitch_identity_conflict" ? "identity_missing" : "unavailable" };
    }
    const time = now();
    if (time - (replies.get(userId) ?? -Infinity) >= 10_000) {
      replies.set(userId, time);
      for (const [id, at] of replies) if (time - at > 60_000) replies.delete(id);
      const messages = {
        offline: "les personnages apparaissent pendant les lives.",
        already_queued: "ton personnage est déjà à l’écran ou dans la file.",
        queue_full: "la file est pleine (10 places). Réessaie après un passage.",
        cooldown: `tu pourras rappeler ton personnage dans ${Math.ceil(result.retryAfterMs / 60_000)} min.`,
        identity_missing: "ton identité Twitch n’a pas pu être vérifiée.",
      };
      await sendMessage(`@${displayName || login}, ${result.accepted ? `ton personnage est en position ${result.position} pour un passage de 60 s ! Personnalisation : https://erwayr.online/gardien.html` : messages[result.reason] || "apparition indisponible, réessaie."}`);
    }
    return { handled: true, ...result };
  }
  return { handleMessage, tick, start() { if (timer) return; void tick(); timer = setInterval(tick, 30_000); timer.unref?.(); }, stop() { clearInterval(timer); timer = null; } };
}
module.exports = { createGuardianLive };
