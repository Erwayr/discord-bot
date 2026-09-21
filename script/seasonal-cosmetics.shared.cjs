"use strict";

// This fixed edition uses Paris midnight at each boundary, including the DST change.
const HALLOWEEN_2026_EVENT = Object.freeze({
  id: "halloween-2026",
  title: "Halloween 2026",
  barId: "game-halloween-2026",
  frameId: "card-frame-game-halloween-2026",
  section: "\u00c9v\u00e9nements",
  source: "halloween_presence",
  schemaVersion: 1,
  timeZone: "Europe/Paris",
  startsAt: "2026-10-23T22:00:00.000Z",
  endsAt: "2026-11-07T23:00:00.000Z",
  startsAtMs: Date.parse("2026-10-23T22:00:00.000Z"),
  endsAtMs: Date.parse("2026-11-07T23:00:00.000Z"),
  requirementLabel: "Pr\u00e9sence en live du 24 octobre au 7 novembre 2026 inclus (heure de Paris).",
  description: "Citrouilles souriantes, petits fant\u00f4mes et magie violette. Pack offert pour ta pr\u00e9sence en live pendant Halloween 2026, conserv\u00e9 d\u00e9finitivement.",
});

function seasonalTimestampMs(value) {
  if (value == null || value === "") return NaN;
  try {
    if (typeof value?.toMillis === "function") return Number(value.toMillis());
    if (typeof value?.toDate === "function") return value.toDate().getTime();
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    if (typeof value === "string") return Date.parse(value);
    if (typeof value === "object") {
      const seconds = value.seconds ?? value._seconds;
      if (typeof seconds === "number" && Number.isFinite(seconds)) {
        return seconds * 1000 + Number(value.nanoseconds ?? value._nanoseconds ?? 0) / 1e6;
      }
    }
  } catch {
    return NaN;
  }
  return NaN;
}

function isHalloween2026EligiblePresence(value) {
  const ms = seasonalTimestampMs(value);
  return Number.isFinite(ms) && ms >= HALLOWEEN_2026_EVENT.startsAtMs && ms < HALLOWEEN_2026_EVENT.endsAtMs;
}

function qualifyingHalloween2026Timestamp(value) {
  return isHalloween2026EligiblePresence(value) ? seasonalTimestampMs(value) : 0;
}

function getHalloween2026Status(now = new Date()) {
  const ms = seasonalTimestampMs(now);
  if (!Number.isFinite(ms) || ms < HALLOWEEN_2026_EVENT.startsAtMs) return "upcoming";
  return ms < HALLOWEEN_2026_EVENT.endsAtMs ? "active" : "ended";
}

function isSeasonalCosmeticId(value) {
  return value === HALLOWEEN_2026_EVENT.barId || value === HALLOWEEN_2026_EVENT.frameId;
}

function isHalloween2026OwnershipEntry(entry, id) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !isSeasonalCosmeticId(id)) return false;
  const qualifiedAtMs = seasonalTimestampMs(entry.qualifiedAt);
  const grantedAtMs = seasonalTimestampMs(entry.grantedAt);
  return entry.eventId === HALLOWEEN_2026_EVENT.id &&
    entry.source === HALLOWEEN_2026_EVENT.source &&
    entry.schemaVersion === HALLOWEEN_2026_EVENT.schemaVersion &&
    (!entry.id || entry.id === id) &&
    isHalloween2026EligiblePresence(qualifiedAtMs) &&
    Number.isFinite(grantedAtMs) && grantedAtMs >= qualifiedAtMs;
}

function hasHalloween2026Grant(source = {}, kind = "experience-bar") {
  if (kind === "profile-frame" || kind === "frame") {
    return isHalloween2026OwnershipEntry(source?.popsShop?.profileFrames?.owned?.[HALLOWEEN_2026_EVENT.frameId], HALLOWEEN_2026_EVENT.frameId);
  }
  if (kind !== "experience-bar" && kind !== "experience_bar") return false;
  return isHalloween2026OwnershipEntry(source?.popsShop?.experienceBars?.owned?.[HALLOWEEN_2026_EVENT.barId], HALLOWEEN_2026_EVENT.barId);
}

module.exports = {
  HALLOWEEN_2026_EVENT,
  seasonalTimestampMs,
  isHalloween2026EligiblePresence,
  qualifyingHalloween2026Timestamp,
  getHalloween2026Status,
  isSeasonalCosmeticId,
  isHalloween2026OwnershipEntry,
  hasHalloween2026Grant,
};
