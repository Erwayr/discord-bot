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

const NOEL_2026_EVENT = Object.freeze({
  id: "noel-2026", title: "Lutin de Noël — Noël 2026", costumeId: "noel-2026",
  barId: "game-noel-2026", frameId: "card-frame-game-noel-2026",
  section: "Événements", source: "noel_presence", schemaVersion: 1,
  timeZone: "Europe/Warsaw", startsAt: "2026-11-30T23:00:00.000Z", endsAt: "2026-12-31T23:00:00.000Z",
  startsAtMs: Date.parse("2026-11-30T23:00:00.000Z"), endsAtMs: Date.parse("2026-12-31T23:00:00.000Z"),
  requirementLabel: "Présence en live du 1er au 31 décembre 2026 inclus (heure de Varsovie).",
  description: "Vert sapin, rouge, clochettes et lumières chaudes. Cadre, barre XP et tenue de lutin offerts grâce à ta présence en live pendant Noël 2026, conservés définitivement.",
});
const SEASONAL_EVENTS = Object.freeze([HALLOWEEN_2026_EVENT, NOEL_2026_EVENT]);
function getSeasonalEventById(id) { return SEASONAL_EVENTS.find(event => event.id === id) || null; }
function getSeasonalEventByCosmeticId(id) {
  if (typeof id !== "string" || !id) return null;
  return SEASONAL_EVENTS.find(event => event.frameId === id || event.barId === id || event.costumeId === id) || null;
}
function getSeasonalEvent(value) {
  const id = typeof value === "object" ? value?.id : value;
  return getSeasonalEventById(id) || getSeasonalEventByCosmeticId(id);
}
function getSeasonalEventStatus(value, now = new Date()) {
  const event = getSeasonalEvent(value), ms = seasonalTimestampMs(now);
  if (!event || !Number.isFinite(ms) || ms < event.startsAtMs) return "upcoming";
  return ms < event.endsAtMs ? "active" : "ended";
}

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
  return Boolean(getSeasonalEventByCosmeticId(value));
}

function isSeasonalOwnershipEntry(entry, id) {
  const event = getSeasonalEventByCosmeticId(id);
  if (!event || !entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const qualifiedAt = seasonalTimestampMs(entry.qualifiedAt), grantedAt = seasonalTimestampMs(entry.grantedAt);
  if (entry.eventId !== event.id || entry.source !== event.source || entry.schemaVersion !== event.schemaVersion ||
    (entry.id && entry.id !== id) || !Number.isFinite(qualifiedAt) || qualifiedAt < event.startsAtMs || qualifiedAt >= event.endsAtMs ||
    !Number.isFinite(grantedAt) || grantedAt < qualifiedAt) return false;
  if (event.id === NOEL_2026_EVENT.id) {
    return /^\d{1,25}$/.test(String(entry.twitchUserId || "")) && entry.costumeId === event.costumeId &&
      Number.isSafeInteger(entry.observedAtMs) && entry.observedAtMs === qualifiedAt && typeof entry.streamId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(entry.streamId) &&
      seasonalTimestampMs(entry.unlockedAt) === grantedAt;
  }
  return true;
}
function hasSeasonalCosmeticGrant(source = {}, id) {
  const event = getSeasonalEventByCosmeticId(id);
  if (!event) return false;
  const entry = id === event.frameId ? source?.popsShop?.profileFrames?.owned?.[id]
    : id === event.barId ? source?.popsShop?.experienceBars?.owned?.[id] : null;
  if (!isSeasonalOwnershipEntry(entry, id)) return false;
  if (event.id !== NOEL_2026_EVENT.id) return true;
  const ids = ["twitch_id", "twitchId", "twitchUserId", "user_id"].map(key => source[key]).filter(value => value != null && value !== "").map(String);
  return ids.length > 0 && ids.every(value => value === entry.twitchUserId);
}
function hasSeasonalGrant(source = {}, kind = "experience-bar", value = HALLOWEEN_2026_EVENT.id) {
  const event = getSeasonalEvent(value);
  if (!["frame", "profile-frame", "experience-bar", "experience_bar"].includes(kind)) return false;
  return Boolean(event && hasSeasonalCosmeticGrant(source, kind === "frame" || kind === "profile-frame" ? event.frameId : event.barId));
}

function isHalloween2026OwnershipEntry(entry, id) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || ![HALLOWEEN_2026_EVENT.barId, HALLOWEEN_2026_EVENT.frameId].includes(id)) return false;
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
  NOEL_2026_EVENT, SEASONAL_EVENTS, getSeasonalEvent, getSeasonalEventById, getSeasonalEventByCosmeticId,
  getSeasonalEventStatus, getSeasonalStatus: getSeasonalEventStatus, isSeasonalOwnershipEntry, hasSeasonalCosmeticGrant, hasSeasonalGrant,
  HALLOWEEN_2026_EVENT,
  seasonalTimestampMs,
  isHalloween2026EligiblePresence,
  qualifyingHalloween2026Timestamp,
  getHalloween2026Status,
  isSeasonalCosmeticId,
  isHalloween2026OwnershipEntry,
  hasHalloween2026Grant,
};
