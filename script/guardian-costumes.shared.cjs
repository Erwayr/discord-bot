"use strict";

// Credential-free catalog, shared by the site, Functions and the presence bot.
const HALLOWEEN_COSTUME_ID = "halloween-2026";
const BASE_COSTUME = "none";
const COSTUME_TIMEZONE = "Europe/Warsaw";
// Local midnight boundaries have different UTC offsets across the autumn change.
const HALLOWEEN_EVENT_START_MS = Date.parse("2026-10-23T22:00:00.000Z");
const HALLOWEEN_EVENT_END_MS = Date.parse("2026-11-07T23:00:00.000Z");
const COSTUMES = Object.freeze([Object.freeze({
  id: HALLOWEEN_COSTUME_ID,
  title: "Épouvantail d’Halloween",
  label: "Épouvantail d’Halloween",
  edition: 2026,
  description: "Une tête de citrouille et une tenue d’épouvantail sombre, édition Halloween 2026.",
  model: "assets/guardian/costumes/halloween-2026/costume.glb",
  thumbnail: "assets/guardian/costumes/halloween-2026/preview.webp",
  fallback: "assets/guardian/costumes/halloween-2026/fallback.png",
})]);
const TWITCH_ID_FIELDS = Object.freeze(["twitch_id", "twitchId", "twitchUserId", "user_id"]);

function getCostume(id) { return COSTUMES.find(costume => costume.id === id) || null; }
function costumeEventState(now = Date.now()) {
  const at = Number(now);
  if (!Number.isFinite(at) || at >= HALLOWEEN_EVENT_END_MS) return "closed";
  return at < HALLOWEEN_EVENT_START_MS ? "upcoming" : "open";
}
function isCostumePresenceEligible(id, observedAtMs) {
  return id === HALLOWEEN_COSTUME_ID && Number.isSafeInteger(observedAtMs)
    && observedAtMs >= HALLOWEEN_EVENT_START_MS && observedAtMs < HALLOWEEN_EVENT_END_MS;
}
function costumeGrantId(twitchUserId, id) {
  const userId = String(twitchUserId || "");
  if (!/^\d{1,25}$/.test(userId) || !getCostume(id)) {
    throw Object.assign(new Error("guardian_costume_grant_invalid"), { code: "guardian_costume_grant_invalid", status: 400 });
  }
  return `${userId}_${id}`;
}
function ownsCostume(profile = {}, id) {
  if (id === BASE_COSTUME) return true;
  if (!getCostume(id)) return false;
  const owned = profile?.guardianCosmetics?.costumes?.owned?.[id];
  if (owned?.costumeId !== id || !/^\d{1,25}$/.test(String(owned?.twitchUserId || ""))) return false;
  const linkedIds = TWITCH_ID_FIELDS.map(field => profile?.[field]).filter(value => value != null && value !== "").map(String);
  return linkedIds.length > 0 && linkedIds.every(value => value === String(owned.twitchUserId));
}

module.exports = { HALLOWEEN_COSTUME_ID, BASE_COSTUME, COSTUMES, COSTUME_TIMEZONE,
  HALLOWEEN_EVENT_START_MS, HALLOWEEN_EVENT_END_MS, TWITCH_ID_FIELDS,
  getCostume, costumeEventState, isCostumePresenceEligible, ownsCostume, costumeGrantId };
