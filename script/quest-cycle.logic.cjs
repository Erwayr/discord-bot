"use strict";
const core = require("./quest-cycle.shared.cjs");
const { timeMs, normalizeQuestCycle, questCycleState, clampProgress } = core;
const CYCLE_FIELDS = new Set(["streams", "progress_pct", "quest_progress_pct", "quest_completion_bonuses", "completed_at"]);
// Adapt existing monthly quest calculations without overwriting monthly statistics.
function questCycleView(data = {}, cycle, month) {
  const state = questCycleState(data, cycle);
  if (!state) return data;
  return { ...data, live_presence: { ...data.live_presence, [month]: {
    ...data.live_presence?.[month], ...state,
    quest_progress_pct: state.progress_pct,
    streams: state.streams || [], quest_completion_bonuses: state.quest_completion_bonuses || {},
  } } };
}
function cycleProgressPatch(data, cycle, progress) {
  const state = questCycleState(data, cycle);
  if (!state) return {};
  return { quest_cycle: { ...state, progress_pct: clampProgress(progress) },
    quest_progress_pct: clampProgress(progress), progress_pct: clampProgress(progress) };
}
function cycleSummary(data, cycle) {
  const state = questCycleState(data, cycle);
  return state ? { id: state.id, startedAtMs: normalizeQuestCycle(cycle).startedAtMs, progress_pct: state.progress_pct } : null;
}
function cyclePatch(data, cycle, month, patch = {}) {
  const state = questCycleState(data, cycle);
  if (!state) return patch;
  const result = {};
  const prefix = `live_presence.${month}.`;
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    const sub = key.startsWith(prefix) ? key.slice(prefix.length) : null;
    if (sub && CYCLE_FIELDS.has(sub.split(".")[0])) {
      const parts = sub.split(".");
      let target = state;
      for (const part of parts.slice(0, -1)) target = target[part] = { ...(target[part] || {}) };
      target[parts.at(-1)] = value;
      changed = true;
    } else result[key] = value;
  }
  if (changed) Object.assign(result, cycleProgressPatch({ quest_cycle: state }, cycle, state.progress_pct));
  return result;
}
function assertCurrentQuestCycle(requested, cycle) {
  if (normalizeQuestCycle(cycle) && requested !== cycle.id) {
    const error = new Error("quest_cycle_changed");
    error.code = "quest_cycle_changed"; error.status = 409;
    throw error;
  }
}

// Events retain observation timestamps across buffer flushes and process restarts.
// Historical activity still goes into live_presence; only current events enter here.
function applyQuestCycleActivity(data, cycle, { streamId, startedAt, events = [], flushId = "" } = {}) {
  const active = normalizeQuestCycle(cycle);
  if (!active || !streamId) return null;
  const accepted = events.filter(event => timeMs(event.atMs) >= active.startedAtMs);
  if (!accepted.length) return null;
  const state = questCycleState(data, active);
  const streams = Array.isArray(state.streams) ? [...state.streams] : Object.values(state.streams || {});
  let index = streams.findIndex(stream => String(stream.stream_id) === String(streamId));
  const entry = index < 0 ? { stream_id: String(streamId), started_at: startedAt || null } : { ...streams[index] };
  if (flushId && (entry.activity_flush_ids || []).includes(flushId)) return null;
  const flags = { presence: "seen", chat_message: "sent", emote: "used", channel_points: "used", raid: "participated" };
  for (const event of accepted) {
    if (!["presence", "chat_message", "emote", "channel_points", "raid", "clips"].includes(event.type)) continue;
    const quest = { ...(entry[event.type] || {}) };
    if (flags[event.type]) quest[flags[event.type]] = true;
    const countKey = event.type === "channel_points" ? "redemptions" : "count";
    quest[countKey] = Math.min(event.type === "chat_message" ? 10 : Number.MAX_SAFE_INTEGER,
      (Number(quest[countKey]) || 0) + Math.max(1, Number(event.count) || 1));
    quest.first_at ||= timeMs(event.atMs);
    quest.last_at = Math.max(Number(quest.last_at) || 0, timeMs(event.atMs));
    entry[event.type] = quest;
  }
  if (flushId) entry.activity_flush_ids = [...(entry.activity_flush_ids || []), flushId];
  if (index < 0) streams.push(entry); else streams[index] = entry;
  return { ...state, streams };
}

module.exports = { ...core, questCycleView, cyclePatch, cycleProgressPatch, cycleSummary, assertCurrentQuestCycle, applyQuestCycleActivity };
