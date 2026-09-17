"use strict";
const { TRAVEL_MS, ARRIVAL_MS, CHAT_MAX_AGE_MS, CHAT_REACTION_COOLDOWN_MS, CHAT_BUBBLE_MS, CHAT_BUBBLE_LIMIT,
  isChatMessage, isChatAction, chatReaction, chatMessageText, actionDuration } = require("./guardian-actions.shared.cjs");

const APPEARANCE_MS = 60_000;
const GUARDIAN_MS = 5_000;
const COOLDOWN_MS = 600_000;
const QUEUE_TTL_MS = 900_000;
const MAX_QUEUE = 10;
const LIVE_LEASE_MS = 90_000;
const idOf = (value) => String(value || "").trim();

function freshState(streamId = "", now = 0) {
  return { schemaVersion: 1, streamId: idOf(streamId), queue: [], active: null, chatGreeting: null,
    chatAction: null, chatBubble: null, recentChatMessages: [], lastChatActionAtMs: null,
    guardianUntilMs: now + GUARDIAN_MS, liveUntilMs: 0, liveCheckedAtMs: 0, initialized: false };
}
function cleanState(input = {}, now = 0) {
  const state = { ...freshState(input.streamId, now), ...input };
  state.queue = (Array.isArray(input.queue) ? input.queue : []).filter((item) => item && item.streamId === state.streamId && item.expiresAtMs > now).slice(0, MAX_QUEUE);
  if (state.active && (state.active.streamId !== state.streamId || state.active.endsAtMs <= now)) {
    state.guardianUntilMs = now + GUARDIAN_MS;
    state.active = null;
  }
  const appearanceId = state.active?.requestId || "guardian";
  for (const field of ["chatGreeting", "chatAction", "chatBubble"]) {
    const cue = state[field];
    if (cue && (cue.streamId !== state.streamId || !Number.isFinite(cue.endsAtMs) || cue.endsAtMs <= now
      || state.liveUntilMs <= now || cue.appearanceId !== appearanceId)) state[field] = null;
  }
  state.recentChatMessages = (Array.isArray(input.recentChatMessages) ? input.recentChatMessages : [])
    .filter(item => item && item.receivedAtMs > now - CHAT_MAX_AGE_MS - 2000).slice(-128);
  return state;
}

function chatTargetMatches(cue, state, guardian) {
  if (!cue || cue.appearanceId !== (state.active?.requestId || "guardian")) return false;
  return state.active ? cue.userId === state.active.userId
    : cue.userId === (guardian?.userId || "") && cue.electionId === (guardian?.electionId || "");
}
function chatTransitionActive(state, now) {
  return Boolean(state.active && (now < state.active.startsAtMs + ARRIVAL_MS || now >= state.active.endsAtMs - TRAVEL_MS));
}
// Pure chat reducer, shared by the server transaction and the tokenless OBS preview.
// Reactions never advance a viewer queue or renew the live lease.
function applyGuardianChat(input, { guardian, streamId, userId, messageId, message, now = Date.now(), sentAtMs = now } = {}) {
  const state = cleanState(input, now);
  const rejected = reason => ({ accepted: false, reason, state });
  if (!/^\d{1,25}$/.test(String(userId)) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(messageId || ""))) return rejected("identity_missing");
  if (!isChatMessage(message)) return rejected("not_chat");
  if (!Number.isFinite(sentAtMs) || now - sentAtMs > CHAT_MAX_AGE_MS || sentAtMs > now + 2000) return rejected("stale_message");
  if (!streamId || state.streamId !== streamId || state.liveUntilMs <= now || state.liveCheckedAtMs > now) return rejected("offline");
  if (state.lastGuardianChatMessageId === messageId || state.recentChatMessages.some(item => item.id === messageId)) return rejected("duplicate");
  const keyword = chatReaction(message);
  const isGuardian = Boolean(guardian?.userId && guardian.userId === userId);
  if (!keyword && !isGuardian) return rejected("no_reaction");
  state.recentChatMessages = [...state.recentChatMessages, { id: messageId, receivedAtMs: now }].slice(-128);
  if (chatTransitionActive(state, now)) return rejected("transition_active");
  const guardianVisible = isGuardian && (!state.active || state.active.userId === guardian.userId);
  const target = { streamId, appearanceId: state.active?.requestId || "guardian",
    userId: state.active?.userId || guardian?.userId || "", electionId: state.active ? "" : guardian?.electionId || "" };
  let bubbleAccepted = false;
  if (guardianVisible) {
    const previous = state.chatBubble;
    const sameBubble = chatTargetMatches(previous, state, guardian) && previous.electionId === guardian.electionId;
    const messages = sameBubble ? previous.messages || [] : [];
    const text = chatMessageText(message);
    if (text) {
      state.chatBubble = { ...target, electionId: guardian.electionId,
        messages: [...messages, { id: messageId, text, sentAtMs }]
          .sort((a, b) => a.sentAtMs - b.sentAtMs).slice(-CHAT_BUBBLE_LIMIT),
        endsAtMs: Math.max(sameBubble ? previous.endsAtMs : 0, now + CHAT_BUBBLE_MS) };
      bubbleAccepted = true;
    }
  }
  const type = keyword || (guardianVisible ? "greet" : null);
  const activeCue = [state.chatAction, state.chatGreeting].find(cue => chatTargetMatches(cue, state, guardian));
  const lastActionAt = Math.max(state.lastChatActionAtMs ?? -Infinity, state.chatGreeting?.startsAtMs ?? -Infinity);
  const actionAccepted = Boolean(type && !activeCue && now - lastActionAt >= CHAT_REACTION_COOLDOWN_MS);
  if (actionAccepted) {
    state.chatAction = { ...target, id: messageId, type, startsAtMs: now, endsAtMs: now + actionDuration(type) };
    state.chatGreeting = null;
    state.lastChatActionAtMs = now;
  }
  return { accepted: actionAccepted || bubbleAccepted, actionAccepted, bubbleAccepted,
    reason: actionAccepted || bubbleAccepted ? null : activeCue ? "action_active" : "cooldown", state };
}

function guardianChatPresentation(input, guardian, now) {
  const state = cleanState(input, now);
  if (chatTransitionActive(state, now)) return { action: null, bubble: null };
  const cue = [state.chatAction, state.chatGreeting].find(item => chatTargetMatches(item, state, guardian) && isChatAction(item.type));
  const speech = state.chatBubble;
  const visibleBubble = chatTargetMatches(speech, state, guardian) && speech.userId === guardian?.userId && speech.electionId === guardian?.electionId;
  return {
    action: cue ? { id: cue.id, type: cue.type, startsAtMs: cue.startsAtMs, endsAtMs: cue.endsAtMs } : null,
    bubble: visibleBubble ? { messages: speech.messages.slice(-CHAT_BUBBLE_LIMIT).map(({ id, text }) => ({ id, text: chatMessageText(text) })), endsAtMs: speech.endsAtMs } : null,
  };
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
  return cleanState(state, now);
}
module.exports = { APPEARANCE_MS, GUARDIAN_MS, COOLDOWN_MS, QUEUE_TTL_MS, MAX_QUEUE, LIVE_LEASE_MS,
  freshState, cleanState, enqueueAppearance, advanceAppearance, applyGuardianChat, guardianChatPresentation };
