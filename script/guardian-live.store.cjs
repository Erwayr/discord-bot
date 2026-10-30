"use strict";
const { isDeepStrictEqual } = require("node:util");
const { createHash } = require("node:crypto");
const { writeOverlaySignal } = require("./overlay-state-signals.shared.cjs");
const { TRAVEL_MS, ARRIVAL_MS } = require("./guardian-actions.shared.cjs");
const { subscriptionPresentationFor, createSubscriptionPresentation, SUBSCRIPTION_LEAD_MS, SUBSCRIPTION_DATES, SUBSCRIPTION_PREPARATION_MS } = require("./guardian-subscription.shared.cjs");

const { characterForProfile, characterLevel } = require("./guardian-character.shared.cjs");
const { weaponFormForProfile } = require("./guardian-weapon-progress.shared.cjs");
const { freshState, cleanState, enqueueAppearance, enqueueSubscriptionAppearance, advanceAppearance, LIVE_LEASE_MS, applyGuardianChat, guardianChatPresentation } = require("./guardian-live.shared.cjs");
const channelRef = (db, channelId) => {
  if (!/^\d{1,25}$/.test(String(channelId))) throw new Error("guardian_channel_invalid");
  return db.collection("guardian_live_channels").doc(String(channelId));
};
const visibleState = state => [state.streamId, state.queue || [], state.active || null,
  state.chatGreeting || null, state.chatAction || null, state.chatBubble || null];
function persistState(tx, db, ref, previous, next, now) {
  tx.set(ref, next);
  if (!isDeepStrictEqual(visibleState(previous), visibleState(next))) writeOverlaySignal(tx, db, "guardian", { now });
}

async function syncGuardianLive({ db, channelId, streamId, checkedAtMs }) {
  const ref = channelRef(db, channelId);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const previous = snapshot.data() || {};
    if ((previous.liveCheckedAtMs || 0) > checkedAtMs) return;
    const next = previous.streamId === String(streamId || "") ? previous : freshState(streamId, checkedAtMs);
    persistState(tx, db, ref, previous, cleanState({ ...next, liveUntilMs: streamId ? checkedAtMs + LIVE_LEASE_MS : 0, liveCheckedAtMs: checkedAtMs }, checkedAtMs), checkedAtMs);
  });
}

async function enqueueGuardianViewer({ db, channelId, streamId, request, now = Date.now() }) {
  if (!/^\d{1,25}$/.test(String(request.userId))) return { accepted: false, reason: "identity_missing" };
  if (!streamId) return { accepted: false, reason: "offline" };
  const ref = channelRef(db, channelId);
  const cooldownRef = ref.collection("viewers").doc(request.userId);
  const testRef = ref.collection("tests").doc("subscription");
  return db.runTransaction(async (tx) => {
    const [snapshot, cooldown, test] = await Promise.all([tx.get(ref), tx.get(cooldownRef), tx.get(testRef)]);
    const previous = snapshot.data() || freshState(streamId, now);
    // Do not let a delayed command revive a stream that the live monitor closed.
    if (previous.liveCheckedAtMs > now) return { accepted: false, reason: "offline" };
    const result = enqueueAppearance(previous, request, { now, streamId, lastAcceptedAtMs: cooldown.data()?.lastAcceptedAtMs ?? null });
    if (result.accepted) {
      persistState(tx, db, ref, previous, { ...result.state, liveUntilMs: now + LIVE_LEASE_MS, liveCheckedAtMs: now }, now);
      tx.set(cooldownRef, { lastAcceptedAtMs: now, requestId: request.requestId });
      cancelSubscriptionTest(tx, testRef, test.data(), now);
    }
    return { accepted: result.accepted, reason: result.reason || null, position: result.position || null, retryAfterMs: result.retryAfterMs || 0 };
  });
}

async function enqueueGuardianSubscription({ db, channelId, streamId, request, now = Date.now() }) {
  if (!/^\d{1,25}$/.test(String(request.userId)) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(request.requestId || ""))) return { accepted: false, reason: "identity_missing" };
  if (!streamId) return { accepted: false, reason: "offline" };
  const ref = channelRef(db, channelId);
  const viewerRef = ref.collection("viewers").doc(request.userId);
  const testRef = ref.collection("tests").doc("subscription");
  return db.runTransaction(async tx => {
    const [snapshot, viewerSnapshot, test] = await Promise.all([tx.get(ref), tx.get(viewerRef), tx.get(testRef)]);
    const previous = snapshot.data() || freshState(streamId, now);
    if (previous.liveCheckedAtMs > now) return { accepted: false, reason: "offline" };
    const viewer = viewerSnapshot.data() || {};
    // Retain delivery IDs beyond the bot's five-minute freshness window,
    // including IDs of correlated events rejected as duplicates.
    const events = (Array.isArray(viewer.recentSubscriptionEvents) ? viewer.recentSubscriptionEvents : [])
      .filter(item => item && item.receivedAtMs > now - 600_000).slice(-15);
    if (events.some(item => item.id === request.requestId)) return { accepted: false, reason: "duplicate" };
    const result = enqueueSubscriptionAppearance(previous, request, { now, streamId, lastSubscriptionAtMs: viewer.lastSubscriptionAtMs ?? null });
    if (result.accepted) {
      persistState(tx, db, ref, previous,
        { ...result.state, liveUntilMs: now + LIVE_LEASE_MS, liveCheckedAtMs: now }, now);
      cancelSubscriptionTest(tx, testRef, test.data(), now);
    }
    if (result.accepted || result.reason === "duplicate") tx.set(viewerRef, {
      recentSubscriptionEvents: [...events, { id: request.requestId, receivedAtMs: now }],
      ...(result.accepted ? { lastSubscriptionAtMs: now } : {}),
    }, { merge: true });
    return { accepted: result.accepted, reason: result.reason || null, position: result.position || null };
  });
}

function pendingSubscriptionTest(value) {
  return value?.schemaVersion === 2 && value.startsAtMs === 0 && value.endsAtMs === 0;
}
function activeSubscriptionTest(value, now) {
  return value?.type === "subscription" && value.viewer && !Number.isFinite(value.cancelledAtMs)
    && Number.isFinite(value.expiresAtMs) && value.expiresAtMs > now
    && (pendingSubscriptionTest(value) || (value.endsAtMs > now && subscriptionPresentationFor(value))) ? value : null;
}
function cancelSubscriptionTest(tx, ref, value, now) {
  const test = activeSubscriptionTest(value, now);
  if (test) tx.set(ref, { ...test, cancelledAtMs: now, expiresAtMs: now });
}
function subscriptionTestAccepted(value, deduped = false) {
  return { status: "accepted", accepted: true, deduped, requestId: value.requestId,
    login: value.viewer.login, displayName: value.viewer.pseudo,
    startsAtMs: value.startsAtMs, endsAtMs: value.endsAtMs,
    ...(value.subscriptionTest?.subMonths != null ? { subMonths: value.subscriptionTest.subMonths } : {}) };
}

// Moderator tests own one private, expiring reservation. They never impersonate
// a live stream, enter its real queue, or grant/update a subscription profile.
async function publishGuardianSubscriptionTest({ db, channelId, login, displayName, subMonths, subMessage = "", requestId, nowMs = Date.now() }) {
  const invalid = reason => ({ status: "error", accepted: false, reason });
  login = String(login || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login)) return invalid("invalid_target");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(requestId || ""))) return invalid("invalid_request_id");
  if (subMonths != null && (!Number.isSafeInteger(subMonths) || subMonths < 1)) return invalid("invalid_months");
  if (!Number.isFinite(nowMs) || nowMs < 0 || !/^\d{1,25}$/.test(String(channelId))) return invalid("invalid_request");
  if (!db?.runTransaction) return invalid("unavailable");
  const ref = channelRef(db, channelId), testRef = ref.collection("tests").doc("subscription");
  try {
    return await db.runTransaction(async tx => {
      const [snapshot, testSnapshot] = await Promise.all([tx.get(ref), tx.get(testRef)]);
      const previous = cleanState(snapshot.data() || freshState("", nowMs), nowMs);
      const test = testSnapshot.data();
      if (test?.requestId === requestId && test.viewer) return subscriptionTestAccepted(test, true);
      if (previous.active || previous.queue.length) return { status: "busy", accepted: false, reason: "real_appearance_active" };
      if (activeSubscriptionTest(test, nowMs)) return { status: "busy", accepted: false, reason: "test_active" };
      let profileSnapshot = await tx.get(db.collection("followers_all_time").doc(login));
      if (!profileSnapshot.exists) return invalid("profile_not_found");
      let profile = profileSnapshot.data() || {}, canonicalLogin = login;
      const ids = twitchIds(profile);
      if (new Set(ids).size > 1) return invalid("identity_conflict");
      if (ids[0]) {
        if (!/^\d{1,25}$/.test(ids[0])) return invalid("identity_conflict");
        const identity = (await tx.get(db.collection("twitch_identities").doc(ids[0]))).data() || {};
        if (identity.status === "conflict") return invalid("identity_conflict");
        canonicalLogin = validLogin(identity.currentLogin || login);
        if (!canonicalLogin) return invalid("identity_conflict");
        if (canonicalLogin !== login) {
          profileSnapshot = await tx.get(db.collection("followers_all_time").doc(canonicalLogin));
          if (!profileSnapshot.exists) return invalid("profile_not_found");
          profile = profileSnapshot.data() || {};
        }
        if (twitchIds(profile).some(id => id !== ids[0])) return invalid("identity_conflict");
      }
      const character = characterForProfile(profile);
      const viewer = { login: canonicalLogin,
        pseudo: String(displayName || profile.pseudo || canonicalLogin).replace(/\p{Cc}/gu, " ").trim().slice(0, 80),
        level: characterLevel(profile), weaponForm: weaponFormForProfile(profile, character), character };
      const value = { schemaVersion: 2, type: "subscription", requestId, createdAtMs: nowMs,
        startsAtMs: 0, endsAtMs: 0, expiresAtMs: nowMs + SUBSCRIPTION_PREPARATION_MS, viewer,
        subscriptionTest: { ...(subMonths != null ? { subMonths } : {}),
          subMessage: String(subMessage || "").replace(/\s+/g, " ").trim().slice(0, 500) } };
      tx.set(testRef, value);
      writeOverlaySignal(tx, db, "guardian", { now: nowMs });
      return subscriptionTestAccepted(value);
    });
  } catch { return invalid("unavailable"); }
}

async function readQueuedViewer(tx, db, request) {
  const identity = (await tx.get(db.collection("twitch_identities").doc(request.userId))).data() || {};
  const login = identity.status === "conflict" ? "" : String(identity.currentLogin || request.login || "").toLowerCase();
  let profile = {};
  if (/^[a-z0-9_]{1,50}$/.test(login)) profile = (await tx.get(db.collection("followers_all_time").doc(login))).data() || {};
  const linkedIds = [profile.twitch_id, profile.twitchId, profile.twitchUserId, profile.user_id].filter(Boolean).map(String);
  if (linkedIds.some((id) => id !== request.userId)) profile = {};
  const character = characterForProfile(profile);
  return { login: login || request.login, pseudo: request.displayName || request.login, level: characterLevel(profile), weaponForm: weaponFormForProfile(profile, character), character };
}

const twitchIds = profile => [profile.twitch_id, profile.twitchId, profile.twitchUserId, profile.user_id].filter(Boolean).map(String);
const validLogin = value => /^[a-z0-9_]{1,50}$/.test(String(value || "").toLowerCase()) ? String(value).toLowerCase() : "";

// winnerId is a Discord ID. Resolve the Twitch account from the elected
// follower, then its stable identity record, including after a Twitch rename.
async function readElectedGuardian({ db, read = ref => ref.get() }) {
  const empty = { electionId: "", userId: "", login: "", pseudo: "Gardien du Stream", level: 0, weaponForm: 1, character: characterForProfile({}) };
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
  const character = characterForProfile(profile);
  return { electionId: election.id, userId, login,
    pseudo: String(profile.pseudo || info.display_name || info.pseudo || login || empty.pseudo).slice(0, 80),
    level: characterLevel(profile), weaponForm: weaponFormForProfile(profile, character), character };
}

async function publishGuardianChat({ db, channelId, streamId, userId, messageId, message, now = Date.now(), sentAtMs = now }) {
  if (!/^\d{1,25}$/.test(String(userId)) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(messageId || ""))) return { accepted: false, reason: "identity_missing" };
  const ref = channelRef(db, channelId);
  return db.runTransaction(async tx => {
    const previous = (await tx.get(ref)).data() || {};
    if (!streamId || previous.streamId !== streamId || previous.liveUntilMs <= now || previous.liveCheckedAtMs > now) return { accepted: false, reason: "offline" };
    const guardian = await readElectedGuardian({ db, read: query => tx.get(query) });
    const { state, ...result } = applyGuardianChat(previous, { guardian, streamId, userId, messageId, message, sentAtMs, now });
    if (!["no_reaction", "stale_message", "not_chat", "duplicate"].includes(result.reason) && !isDeepStrictEqual(previous, state)) persistState(tx, db, ref, previous, state, now);
    return result;
  });
}

function subscriptionPreparation(request, viewer) {
  const fingerprint = createHash("sha256").update(JSON.stringify([
    "guardian-subscription-v3", request.requestId, request.userId || "", request.streamId || "",
    request.requestedAtMs ?? request.createdAtMs, viewer, request.subscriptionTest || null,
  ])).digest("hex");
  return { appearanceId: request.requestId, viewer, fingerprint };
}
function preparationMatches(prepared, preparation) {
  return Boolean(preparation && prepared?.appearanceId === preparation.appearanceId
    && typeof prepared.fingerprint === "string" && prepared.fingerprint === preparation.fingerprint);
}

async function pollGuardianLive({ db, channelId, guardian = null, now = Date.now, preparedSubscription = null,
  paidSource = null, preparedPaidAction = null, paidActionAck = null }) {
  const ref = channelRef(db, channelId);
  const testRef = ref.collection("tests").doc("subscription");
  const clock = typeof now === "function" ? now : () => now;
  return db.runTransaction(async (tx) => {
    const [snapshot, testSnapshot] = await Promise.all([tx.get(ref), tx.get(testRef)]);
    let at = clock();
    const original = snapshot.data() || freshState("", at);
    const paidActions = require("./guardian-paid-actions.store.cjs");
    const paid = await paidActions.prepareErwayrActionPoll({ tx, db, previous: original, channelId, now: at,
      source: paidSource, prepared: preparedPaidAction, ack: paidActionAck });
    const previous = paid.raw;
    let cleaned = cleanState(previous, at);
    const request = cleaned.queue[0];
    const canStart = (state, time) => state.initialized && state.liveUntilMs > time && !state.active
      && state.guardianUntilMs <= time && state.queue[0];
    const shouldStart = canStart(cleaned, at);
    const viewer = shouldStart ? paidActions.isPaidAction(request) ? paid.ready ? request.snapshot : null : await readQueuedViewer(tx, db, request) : null;
    // A transaction can retry or its profile read can cross an expiry. The
    // final clock and head must still authorize the exact prepared character.
    at = clock();
    cleaned = cleanState(previous, at);
    const eligible = viewer && canStart(cleaned, at) && cleaned.queue[0].requestId === request.requestId;
    const realPreparation = eligible && request.type === "subscription" && cleaned.streamId
      && cleaned.liveCheckedAtMs <= at ? subscriptionPreparation(request, viewer) : null;
    const startViewer = eligible && (!paidActions.isPaidAction(request) || request.leaseUntilMs > at && paid.own(request))
      && (request.type !== "subscription" || preparationMatches(preparedSubscription, realPreparation)) ? viewer : null;
    const next = advanceAppearance(cleaned, { now: at, viewer: startViewer });
    if (!isDeepStrictEqual(original, next)) persistState(tx, db, ref, original, next, at);
    paidActions.commitErwayrActionPoll(tx, paid, next, at);
    let test = activeSubscriptionTest(testSnapshot.data(), at);
    if (test && (next.active || next.queue.length)) {
      // Real traffic permanently preempts a test; it must not reappear after
      // the real card ends or a new stream clears its ordinary state.
      cancelSubscriptionTest(tx, testRef, test, at);
      test = null;
    }
    let preparation = !next.active ? realPreparation : null;
    if (test && pendingSubscriptionTest(test)) {
      preparation = subscriptionPreparation(test, test.viewer);
      if (preparationMatches(preparedSubscription, preparation)) {
        const startsAtMs = at + SUBSCRIPTION_LEAD_MS;
        const cue = createSubscriptionPresentation({ startsAtMs, appearanceId: test.requestId, viewer: test.viewer });
        test = { ...test, startsAtMs, endsAtMs: cue.returnEndsAtMs, expiresAtMs: cue.returnEndsAtMs };
        tx.set(testRef, test);
        writeOverlaySignal(tx, db, "guardian", { now: at });
        preparation = null;
      }
    }
    const active = next.active && (!paidActions.isPaidAction(next.active) || paid.own(next.active)) ? next.active
      : test && !pendingSubscriptionTest(test) ? test : null;
    const subscriptionPresentation = subscriptionPresentationFor(active);
    const deadlines = [active?.startsAtMs, active?.endsAtMs,
      ...SUBSCRIPTION_DATES.map(key => subscriptionPresentation?.[key]),
      active && active.startsAtMs + (active.type === "subscription" ? TRAVEL_MS : ARRIVAL_MS),
      active && active.endsAtMs - TRAVEL_MS,
      test?.expiresAtMs,
      preparation && next.queue[0]?.expiresAtMs,
      !next.active && next.queue.length && next.guardianUntilMs,
      (next.active || next.queue.length) && next.liveUntilMs];
    const future = deadlines.filter(value => Number.isFinite(value) && value > at);
    return {
      nextRefreshAtMs: future.length ? Math.min(...future) : null,
      generatedAtMs: at, kind: active ? "viewer" : "guardian", pendingCount: next.queue.length,
      appearanceType: active?.type === "subscription" ? "subscription" : active?.type === "paid_action" ? "paid_action" : "viewer",
      appearanceId: active?.requestId || "guardian", viewer: active?.viewer || null,
      startsAtMs: active?.startsAtMs || null, endsAtMs: active?.endsAtMs || null,
      ...(paidActions.isPaidAction(active) ? { paidActionId: active.actionId,
        paidActionClaim: { eventId: active.eventId, claimToken: active.claimToken, actionId: active.actionId,
          actionStartedAtMs: active.actionStartedAtMs || null } } : {}),
      ...(!next.active && paid.preparation ? { paidActionPreparation: paid.preparation } : {}),
      ...(subscriptionPresentation ? { subscriptionPresentation } : {}),
      ...(preparation ? { subscriptionPreparation: preparation } : {}),
      ...(paidActions.isPaidAction(active) ? { action: null, bubble: null }
        : test ? { subscriptionTest: test.subscriptionTest, action: null, bubble: null }
        : guardianChatPresentation(next, guardian, at)),
    };
  });
}
module.exports = { syncGuardianLive, enqueueGuardianViewer, enqueueGuardianSubscription, publishGuardianSubscriptionTest, pollGuardianLive, readElectedGuardian, publishGuardianChat };
