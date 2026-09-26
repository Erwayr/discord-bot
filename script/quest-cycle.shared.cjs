"use strict";

const QUEST_CYCLE_PATH = "site_config/quest_cycle";
let clientCycle = null;

function timeMs(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value?.seconds != null) return Number(value.seconds) * 1000;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value || "") || 0;
}
function normalizeQuestCycle(value) {
  const id = String(value?.id || "").trim();
  const startedAtMs = timeMs(value?.startedAtMs ?? value?.startedAt);
  return /^[a-zA-Z0-9_-]{1,120}$/.test(id) && startedAtMs > 0
    ? { id, startedAtMs } : null;
}
function setClientQuestCycle(value) { clientCycle = normalizeQuestCycle(value); }
function getClientQuestCycle() { return clientCycle; }
function clampProgress(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function questCycleState(data = {}, cycle = clientCycle) {
  const active = normalizeQuestCycle(cycle);
  if (!active) return null;
  return data.quest_cycle?.id === active.id
    ? { ...data.quest_cycle, progress_pct: clampProgress(data.quest_cycle.progress_pct) }
    : { id: active.id, startedAtMs: active.startedAtMs, progress_pct: 0, streams: [] };
}
function questProgress(data = {}, month = "", cycle = clientCycle) {
  const state = questCycleState(data, cycle);
  return state ? state.progress_pct : clampProgress(
    data.live_presence?.[month]?.progress_pct ?? data.live_presence?.[month]?.quest_progress_pct ?? data.quest_progress_pct ?? data.progress_pct);
}
function questStreams(data = {}, month = "", cycle = clientCycle) {
  return questCycleState(data, cycle)?.streams || (normalizeQuestCycle(cycle) ? [] : data.live_presence?.[month]?.streams) || [];
}
module.exports = { QUEST_CYCLE_PATH, timeMs, normalizeQuestCycle, questCycleState, questProgress, questStreams, setClientQuestCycle, getClientQuestCycle, clampProgress };
