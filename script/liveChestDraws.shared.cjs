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
  if (draw.status === "open") return { phase: nowMs >= draw.closesAtMs ? "drawing" : "registration", index: -1 };
  if (draw.status === "drawing") return { phase: "drawing", index: -1 };
  if (draw.status !== "completed" || !draw.winners?.length) return { phase: "idle", index: -1 };
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
  normalizeConfig, chooseWinners, timeline, makeDemo, publicDraw };
