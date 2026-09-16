"use strict";
const { TRAVEL_MS } = require("./guardian-actions.shared.cjs");

const APPEARANCE_MS = 60_000;
const GUARDIAN_MS = 5_000;
const COOLDOWN_MS = 600_000;
const QUEUE_TTL_MS = 900_000;
const MAX_QUEUE = 10;
const LIVE_LEASE_MS = 90_000;
const idOf = (value) => String(value || "").trim();

function freshState(streamId = "", now = 0) {
  return { schemaVersion: 1, streamId: idOf(streamId), queue: [], active: null, chatGreeting: null, guardianUntilMs: now + GUARDIAN_MS, liveUntilMs: 0, liveCheckedAtMs: 0, initialized: false };
}
function cleanState(input = {}, now = 0) {
  const state = { ...freshState(input.streamId, now), ...input };
  state.queue = (Array.isArray(input.queue) ? input.queue : []).filter((item) => item && item.streamId === state.streamId && item.expiresAtMs > now).slice(0, MAX_QUEUE);
  if (state.active && (state.active.streamId !== state.streamId || state.active.endsAtMs <= now)) {
    state.guardianUntilMs = now + GUARDIAN_MS;
    state.active = null;
  }
  if (state.chatGreeting && (state.chatGreeting.streamId !== state.streamId || state.chatGreeting.endsAtMs <= now || state.liveUntilMs <= now)) state.chatGreeting = null;
  return state;
}
function enqueueAppearance(input, request, { now, streamId, lastAcceptedAtMs = null } = {}) {
  let state = cleanState(input, now);
  if (!streamId) return { accepted: false, reason: "offline", state };
  if (state.streamId !== streamId) state = freshState(streamId, now);
  if (state.active?.userId === request.userId || state.queue.some((item) => item.userId === request.userId)) return { accepted: false, reason: "already_queued", state };
  if (lastAcceptedAtMs != null && now - lastAcceptedAtMs < COOLDOWN_MS) return { accepted: false, reason: "cooldown", retryAfterMs: COOLDOWN_MS - (now - lastAcceptedAtMs), state };
  if (state.queue.length >= MAX_QUEUE) return { accepted: false, reason: "queue_full", state };
  state.queue.push({ requestId: idOf(request.requestId), userId: idOf(request.userId), login: idOf(request.login).toLowerCase(), displayName: idOf(request.displayName).slice(0, 80), streamId, requestedAtMs: now, expiresAtMs: now + QUEUE_TTL_MS });
  return { accepted: true, position: state.queue.length, state };
}
// Pure scheduling; callers persist this transition in a Firestore transaction.
function advanceAppearance(input, { now, viewer = null } = {}) {
  const state = cleanState(input, now);
  if (!state.initialized) {
    state.initialized = true;
    state.guardianUntilMs = now + GUARDIAN_MS;
    return state;
  }
  if (state.liveUntilMs <= now) {
    if (state.active || state.queue.length) state.guardianUntilMs = now + GUARDIAN_MS;
    state.active = null;
    state.queue = [];
    return state;
  }
  if (!state.active && now >= state.guardianUntilMs && state.queue.length && viewer) {
    const request = state.queue.shift();
    // Announce the incoming viewer while the Guardian leaves. The viewer's
    // complete minute starts only after this shared departure deadline.
    state.active = { ...request, viewer, startsAtMs: now + TRAVEL_MS, endsAtMs: now + TRAVEL_MS + APPEARANCE_MS };
  }
  return state;
}
module.exports = { APPEARANCE_MS, GUARDIAN_MS, COOLDOWN_MS, QUEUE_TTL_MS, MAX_QUEUE, LIVE_LEASE_MS, freshState, cleanState, enqueueAppearance, advanceAppearance };
