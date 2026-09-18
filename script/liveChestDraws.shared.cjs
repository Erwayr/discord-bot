"use strict";

// Canonical contract. scripts/sync-live-chest-contracts.js copies this into the bot.
const TYPES = Object.freeze(["runic", "epic", "legendary"]);
const LABELS = Object.freeze({ runic: "runique", epic: "épique", legendary: "légendaire" });
const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1, enabled: false, intervalMinutes: 60, registrationSeconds: 180,
  winnerCount: 2, probabilities: Object.freeze({ runic: 80, epic: 18, legendary: 2 }),
  corner: "top-right", width: 420, volume: 0.25,
});
const CORNERS = ["top-right", "top-left", "bottom-right", "bottom-left"];
const ROLL_MS = 3000;
const WINNER_MS = 3000;
const SUMMARY_MS = 10000;
const TEST_COOLDOWN_MS = 60000;
const SCHEDULE_VERSION = 2;
const FIRST_OPEN_DELAY_MS = 180000;
const SCHEDULE_GRACE_MS = 30000;
const TICK_MS = 5000;

function scheduleTimingKey(config) {
  return `${config.intervalMinutes}/${config.registrationSeconds}/${config.winnerCount}`;
}

function drawDurationMs(config) {
  return config.registrationSeconds * 1000 + ROLL_MS + config.winnerCount * WINNER_MS + SUMMARY_MS;
}

// Only the chosen timestamp is persisted; random choices never run on clients.
function createScheduleWindow(startedAtMs, windowIndex, config, nowMs, randomInt) {
  const intervalMs = config.intervalMinutes * 60000;
  const windowStartAtMs = startedAtMs + windowIndex * intervalMs;
  const windowEndAtMs = windowStartAtMs + intervalMs;
  const firstSecond = Math.ceil(Math.max(windowStartAtMs, startedAtMs + FIRST_OPEN_DELAY_MS, nowMs) / 1000);
  const lastSecond = Math.floor((windowEndAtMs - drawDurationMs(config) - SCHEDULE_GRACE_MS) / 1000);
  return {
    scheduleVersion: SCHEDULE_VERSION, scheduleTimingKey: scheduleTimingKey(config),
    scheduleIntervalMinutes: config.intervalMinutes, streamStartedAtMs: startedAtMs,
    scheduleWindowIndex: windowIndex, scheduleWindowStartAtMs: windowStartAtMs, scheduleWindowEndAtMs: windowEndAtMs,
    nextOpenAtMs: firstSecond <= lastSecond ? (firstSecond + randomInt(lastSecond - firstSecond + 1)) * 1000 : null,
    scheduleStatus: firstSecond <= lastSecond ? "scheduled" : "skipped",
    scheduleIssue: firstSecond <= lastSecond ? null : "window_too_short",
  };
}

function configError() {
  return Object.assign(new Error("Configuration des coffres du live invalide."), { status: 400, code: "invalid_live_chest_config" });
}

function normalizeConfig(raw = {}, { strict = false } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = { ...DEFAULT_CONFIG, probabilities: { ...DEFAULT_CONFIG.probabilities } };
  for (const [field, min, max] of [["intervalMinutes", 5, 240], ["registrationSeconds", 30, 600], ["winnerCount", 1, 10], ["width", 280, 640]]) {
    const value = source[field] ?? result[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      if (strict) throw configError();
    } else result[field] = value;
  }
  if (strict && source.enabled != null && typeof source.enabled !== "boolean") throw configError();
  result.enabled = source.enabled === true;
  if (CORNERS.includes(source.corner)) result.corner = source.corner;
  else if (strict && source.corner != null) throw configError();
  if (typeof source.volume === "number" && Number.isFinite(source.volume) && source.volume >= 0 && source.volume <= 1) result.volume = source.volume;
  else if (strict && source.volume != null) throw configError();
  if (source.probabilities != null) {
    const probabilities = source.probabilities;
    if (TYPES.every((type) => Number.isInteger(probabilities?.[type]) && probabilities[type] >= 0 && probabilities[type] <= 100)
      && TYPES.reduce((sum, type) => sum + probabilities[type], 0) === 100) {
      result.probabilities = Object.fromEntries(TYPES.map((type) => [type, probabilities[type]]));
    } else if (strict) throw configError();
  }
  if (result.registrationSeconds >= result.intervalMinutes * 60) {
    if (strict) throw configError();
    result.registrationSeconds = DEFAULT_CONFIG.registrationSeconds;
  }
  return result;
}

function chooseWinners(entries, config, randomInt) {
  const pool = [...new Map(entries.map((entry) => [entry.userId, entry])).values()];
  const winners = [];
  while (pool.length && winners.length < config.winnerCount) {
    const [entry] = pool.splice(randomInt(pool.length), 1);
    const roll = randomInt(100);
    const type = roll < config.probabilities.runic ? "runic"
      : roll < config.probabilities.runic + config.probabilities.epic ? "epic" : "legendary";
    winners.push({ ...entry, chestType: type });
  }
  return winners;
}

function timeline(draw, nowMs) {
  if (!draw || draw.status === "cancelled" || nowMs >= draw.expiresAtMs) return { phase: "idle", index: -1 };
  if (nowMs < draw.opensAtMs) return { phase: "idle", index: -1 };
  if (draw.status === "open" && nowMs < draw.closesAtMs) return { phase: "registration", index: -1 };
  const emptyPhase = nowMs < draw.closesAtMs + SUMMARY_MS ? "empty" : "idle";
  if (draw.status === "open" || draw.status === "drawing") {
    // The last registration count cannot confirm a result: wait for the server.
    return { phase: draw.entrantCount > 0 ? "waiting" : emptyPhase, index: -1 };
  }
  if (draw.status !== "completed") return { phase: "idle", index: -1 };
  if (!draw.winners?.length) return { phase: emptyPhase, index: -1 };
  const elapsed = nowMs - draw.revealAtMs;
  if (elapsed < ROLL_MS) return { phase: "drawing", index: -1 };
  const index = Math.floor((elapsed - ROLL_MS) / WINNER_MS);
  return index < draw.winners.length ? { phase: "winner", index } : { phase: "summary", index: -1 };
}

function makeDemo(id, nowMs, config = DEFAULT_CONFIG, leadInMs = 0) {
  const opensAtMs = nowMs + leadInMs;
  const revealAtMs = opensAtMs + 10000;
  return {
    id, test: true, status: "open", createdAtMs: nowMs, opensAtMs, closesAtMs: revealAtMs,
    revealAtMs, expiresAtMs: revealAtMs + ROLL_MS + 2 * WINNER_MS + SUMMARY_MS,
    config: { ...normalizeConfig(config), winnerCount: 2 }, entrantCount: 8,
    candidates: ["Démo 1", "Démo 2", "Démo 3", "Démo 4", "Démo 5"],
    winners: [{ displayName: "Démo 1", chestType: "runic" }, { displayName: "Démo 2", chestType: "legendary" }],
  };
}

function publicDraw(draw, nowMs) {
  if (!draw || draw.status === "cancelled" || nowMs >= draw.expiresAtMs) return null;
  const test = draw.test === true;
  const status = test && nowMs >= draw.closesAtMs && draw.winners?.length ? "completed" : draw.status;
  const text = (value) => String(value || "").slice(0, 80);
  return {
    id: text(draw.id), test, status, config: normalizeConfig(draw.config),
    opensAtMs: Number(draw.opensAtMs) || 0, closesAtMs: Number(draw.closesAtMs) || 0,
    revealAtMs: Number(draw.revealAtMs) || 0, expiresAtMs: Number(draw.expiresAtMs) || 0,
    entrantCount: Math.max(0, Number(draw.entrantCount) || 0),
    candidates: (draw.candidates || []).slice(0, 40).map(text),
    winners: status === "completed" ? (draw.winners || []).slice(0, 10).map((winner) => ({
      displayName: text(winner.displayName || winner.login), chestType: TYPES.includes(winner.chestType) ? winner.chestType : "runic",
    })) : [],
  };
}

module.exports = { TYPES, LABELS, DEFAULT_CONFIG, CORNERS, ROLL_MS, WINNER_MS, SUMMARY_MS, TEST_COOLDOWN_MS,
  SCHEDULE_VERSION, FIRST_OPEN_DELAY_MS, SCHEDULE_GRACE_MS, TICK_MS, scheduleTimingKey, drawDurationMs, createScheduleWindow,
  normalizeConfig, chooseWinners, timeline, makeDemo, publicDraw };
