"use strict";
const { isDeepStrictEqual } = require("node:util");

const { characterForProfile } = require("./guardian-character.shared.cjs");
const { freshState, cleanState, enqueueAppearance, advanceAppearance, LIVE_LEASE_MS } = require("./guardian-live.shared.cjs");
const { GREETING_MS, TRAVEL_MS } = require("./guardian-actions.shared.cjs");
const channelRef = (db, channelId) => {
  if (!/^\d{1,25}$/.test(String(channelId))) throw new Error("guardian_channel_invalid");
  return db.collection("guardian_live_channels").doc(String(channelId));
};

async function syncGuardianLive({ db, channelId, streamId, checkedAtMs }) {
  const ref = channelRef(db, channelId);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const previous = snapshot.data() || {};
    if ((previous.liveCheckedAtMs || 0) > checkedAtMs) return;
    const next = previous.streamId === String(streamId || "") ? previous : freshState(streamId, checkedAtMs);
    tx.set(ref, { ...next, liveUntilMs: streamId ? checkedAtMs + LIVE_LEASE_MS : 0, liveCheckedAtMs: checkedAtMs });
  });
}

async function enqueueGuardianViewer({ db, channelId, streamId, request, now = Date.now() }) {
  if (!/^\d{1,25}$/.test(String(request.userId))) return { accepted: false, reason: "identity_missing" };
  if (!streamId) return { accepted: false, reason: "offline" };
  const ref = channelRef(db, channelId);
  const cooldownRef = ref.collection("viewers").doc(request.userId);
  return db.runTransaction(async (tx) => {
    const [snapshot, cooldown] = await Promise.all([tx.get(ref), tx.get(cooldownRef)]);
    const previous = snapshot.data() || freshState(streamId, now);
    // Do not let a delayed command revive a stream that the live monitor closed.
    if (previous.liveCheckedAtMs > now) return { accepted: false, reason: "offline" };
    const result = enqueueAppearance(previous, request, { now, streamId, lastAcceptedAtMs: cooldown.data()?.lastAcceptedAtMs ?? null });
    if (result.accepted) {
      tx.set(ref, { ...result.state, liveUntilMs: now + LIVE_LEASE_MS, liveCheckedAtMs: now });
      tx.set(cooldownRef, { lastAcceptedAtMs: now, requestId: request.requestId });
    }
    return { accepted: result.accepted, reason: result.reason || null, position: result.position || null, retryAfterMs: result.retryAfterMs || 0 };
  });
}

async function readQueuedViewer(tx, db, request) {
  const identity = (await tx.get(db.collection("twitch_identities").doc(request.userId))).data() || {};
  const login = identity.status === "conflict" ? "" : String(identity.currentLogin || request.login || "").toLowerCase();
  let profile = {};
  if (/^[a-z0-9_]{1,50}$/.test(login)) profile = (await tx.get(db.collection("followers_all_time").doc(login))).data() || {};
  const linkedIds = [profile.twitch_id, profile.twitchId, profile.twitchUserId, profile.user_id].filter(Boolean).map(String);
  if (linkedIds.some((id) => id !== request.userId)) profile = {};
  return { login: login || request.login, pseudo: request.displayName || request.login, character: characterForProfile(profile) };
}

const twitchIds = profile => [profile.twitch_id, profile.twitchId, profile.twitchUserId, profile.user_id].filter(Boolean).map(String);
const validLogin = value => /^[a-z0-9_]{1,50}$/.test(String(value || "").toLowerCase()) ? String(value).toLowerCase() : "";

// winnerId is a Discord ID. Resolve the Twitch account from the elected
// follower, then its stable identity record, including after a Twitch rename.
async function readElectedGuardian({ db, read = ref => ref.get() }) {
  const empty = { electionId: "", userId: "", login: "", pseudo: "Gardien du Stream", character: characterForProfile({}) };
  const snapshot = await read(db.collection("elections").orderBy("endedAt", "desc").limit(1));
  const election = snapshot.docs[0];
  const data = election?.data() || {};
  if (!data.endedAt || (!data.winnerId && !data.winnerInfo)) return empty;
  const info = data.winnerInfo || {};
  let login = validLogin(info.login || info.user_login || info.pseudo);
  let profile = {};
  let userId = twitchIds(info)[0] || "";
  if (!userId && data.winnerId) {
    const followers = await read(db.collection("followers_all_time").where("discord_id", "==", String(data.winnerId)).limit(1));
    if (!followers.empty) { profile = followers.docs[0].data() || {}; login = followers.docs[0].id; userId = twitchIds(profile)[0] || ""; }
  }
  if (!userId && login) {
    profile = (await read(db.collection("followers_all_time").doc(login))).data() || {};
    if (data.winnerId && String(profile.discord_id || "") !== String(data.winnerId)) profile = {};
    userId = twitchIds(profile)[0] || "";
  }
  if (userId) {
    if (!/^\d{1,25}$/.test(userId) || twitchIds(info).some(id => id !== userId)) return empty;
    const identity = (await read(db.collection("twitch_identities").doc(userId))).data() || {};
    if (identity.status === "conflict") return empty;
    login = validLogin(identity.currentLogin || login);
    if (login) profile = (await read(db.collection("followers_all_time").doc(login))).data() || {};
    if (twitchIds(profile).some(id => id !== userId)) return empty;
  }
  return { electionId: election.id, userId, login,
    pseudo: String(profile.pseudo || info.display_name || info.pseudo || login || empty.pseudo).slice(0, 80),
    character: characterForProfile(profile) };
}

async function publishGuardianChatGreeting({ db, channelId, streamId, userId, messageId, now = Date.now() }) {
  if (!/^\d{1,25}$/.test(String(userId)) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(messageId || ""))) return { accepted: false, reason: "identity_missing" };
  const ref = channelRef(db, channelId);
  return db.runTransaction(async tx => {
    const previous = (await tx.get(ref)).data() || {};
    const state = cleanState(previous, now);
    if (!streamId || state.streamId !== streamId || state.liveUntilMs <= now || state.liveCheckedAtMs > now) return { accepted: false, reason: "offline" };
    if (previous.lastGuardianChatMessageId === messageId) return { accepted: false, reason: "duplicate" };
    if (state.chatGreeting) return { accepted: false, reason: "greeting_active" };
    if (state.active && (now < state.active.startsAtMs || now >= state.active.endsAtMs - TRAVEL_MS)) return { accepted: false, reason: "transition_active" };
    if (state.active && state.active.userId !== userId) return { accepted: false, reason: "viewer_visible" };
    const guardian = await readElectedGuardian({ db, read: query => tx.get(query) });
    if (guardian.userId !== userId) return { accepted: false, reason: "not_guardian" };
    const chatGreeting = { id: messageId, type: "greet", userId, electionId: guardian.electionId,
      streamId, appearanceId: state.active?.requestId || "guardian", startsAtMs: now, endsAtMs: now + GREETING_MS };
    tx.set(ref, { ...state, chatGreeting, lastGuardianChatMessageId: messageId });
    return { accepted: true };
  });
}

async function pollGuardianLive({ db, channelId, guardian = null, now = Date.now() }) {
  const ref = channelRef(db, channelId);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const previous = snapshot.data() || freshState("", now);
    const cleaned = cleanState(previous, now);
    const request = cleaned.queue[0];
    const shouldStart = cleaned.initialized && cleaned.liveUntilMs > now && !cleaned.active && cleaned.guardianUntilMs <= now && request;
    const viewer = shouldStart ? await readQueuedViewer(tx, db, request) : null;
    const next = advanceAppearance(cleaned, { now, viewer });
    if (!isDeepStrictEqual(previous, next)) tx.set(ref, next);
    const cue = next.chatGreeting;
    const appearanceId = next.active?.requestId || "guardian";
    const travelling = next.active && (now < next.active.startsAtMs || now >= next.active.endsAtMs - TRAVEL_MS);
    const visibleCue = cue && !travelling && cue.appearanceId === appearanceId && cue.userId === guardian?.userId && cue.electionId === guardian?.electionId;
    return {
      generatedAtMs: now, kind: next.active ? "viewer" : "guardian", pendingCount: next.queue.length,
      appearanceId: next.active?.requestId || "guardian", viewer: next.active?.viewer || null,
      startsAtMs: next.active?.startsAtMs || null, endsAtMs: next.active?.endsAtMs || null,
      action: visibleCue ? { id: cue.id, type: "greet", startsAtMs: cue.startsAtMs, endsAtMs: cue.endsAtMs } : null,
    };
  });
}
module.exports = { syncGuardianLive, enqueueGuardianViewer, pollGuardianLive, readElectedGuardian, publishGuardianChatGreeting };
