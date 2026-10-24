"use strict";
const { COMMUNITY_PACK, LEGACY_COMMUNITY_PACK, isCommunityPackCosmeticId, normalizeCommunityPackGrant } = require("./community-pack.shared.cjs");

// Credential-free catalog, shared by the site, Functions and the presence bot.
const HALLOWEEN_COSTUME_ID = "halloween-2026";
const COMMUNITY_ASTRAL_COSTUME_ID = LEGACY_COMMUNITY_PACK.costumeId;
const COMMUNITY_BUS_DRIVER_COSTUME_ID = COMMUNITY_PACK.costumeId;
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
  appearanceMode: "full-body",
}), Object.freeze({
  id: COMMUNITY_BUS_DRIVER_COSTUME_ID,
  title: "Chauffeur de la commu", label: "Chauffeur de la commu",
  description: "Veste jaune, casquette et détails de conducteur humoristique, assortis à la bordure de bus communautaire.",
  model: "assets/guardian/costumes/community-bus-driver/costume.glb",
  thumbnail: "assets/guardian/costumes/community-bus-driver/preview.webp",
  fallback: "assets/guardian/costumes/community-bus-driver/fallback.png",
  appearanceMode: "clothes", hideHair: true,
  nativeNeckFit: Object.freeze({ yMin: -.12, yMax: .025, zMax: .035, minNeckWeight: .12,
    radiusX: .055, radiusZ: .067, centerZ: -.002, blendStartY: -.025, blendEndY: .025 }),
  acquisitionMode: "community-reward", campaignId: COMMUNITY_PACK.id,
})]);
const TWITCH_ID_FIELDS = Object.freeze(["twitch_id", "twitchId", "twitchUserId", "user_id"]);

function normalizeCostumeId(id) { return id === LEGACY_COMMUNITY_PACK.costumeId ? COMMUNITY_BUS_DRIVER_COSTUME_ID : id; }
function getCostume(id) { return COSTUMES.find(costume => costume.id === normalizeCostumeId(id)) || null; }
function getCostumeAppearanceMode(id) { return getCostume(id)?.appearanceMode || "full-body"; }
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
  // Receipt identity is never canonicalized: historical records stay readable
  // at their original immutable key.
  return `${userId}_${id}`;
}
function ownsCostume(profile = {}, id) {
  if (id === BASE_COSTUME) return true;
  if (!getCostume(id)) return false;
  const linkedIds = TWITCH_ID_FIELDS.map(field => profile?.[field]).filter(value => value != null && value !== "").map(String);
  const canonical = normalizeCostumeId(id);
  const candidates = canonical === COMMUNITY_BUS_DRIVER_COSTUME_ID ? [canonical, LEGACY_COMMUNITY_PACK.costumeId] : [canonical];
  return candidates.some(candidate => {
    const owned = profile?.guardianCosmetics?.costumes?.owned?.[candidate];
    if (owned?.costumeId !== candidate || !/^\d{1,25}$/.test(String(owned?.twitchUserId || ""))) return false;
    if (isCommunityPackCosmeticId(candidate) && !normalizeCommunityPackGrant(owned)) return false;
    return linkedIds.length > 0 && linkedIds.every(value => value === String(owned.twitchUserId));
  });
}

module.exports = { HALLOWEEN_COSTUME_ID, COMMUNITY_ASTRAL_COSTUME_ID, COMMUNITY_BUS_DRIVER_COSTUME_ID, BASE_COSTUME, COSTUMES, COSTUME_TIMEZONE,
  HALLOWEEN_EVENT_START_MS, HALLOWEEN_EVENT_END_MS, TWITCH_ID_FIELDS,
  normalizeCostumeId, getCostume, getCostumeAppearanceMode, costumeEventState, isCostumePresenceEligible, ownsCostume, costumeGrantId };
