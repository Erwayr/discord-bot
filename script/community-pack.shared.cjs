"use strict";

// The campaign ID and ledger source are stable: a new art direction must never
// reset a contribution, reopen a completed campaign or invalidate an old receipt.
const { CAMPAIGN, COMMUNITY_PACK: PACK_CORE, COMMUNITY_PACK_OWNER_TWITCH_ID, TWITCH_ID_FIELDS,
  normalizeCommunityPackClaim, hasCommunityPackClaim } = require("./community-pack-claim.shared.cjs");
function pack(themeId, title, extra = {}) {
  return Object.freeze({ ...CAMPAIGN, themeId, title, frameId: `card-frame-${themeId}`, costumeId: themeId,
    className: `profile-frame-card-${themeId}`,
    imageUrl: `/images/profile-frames/community/${themeId}.webp`,
    overlayImageUrl: `/images/profile-frames/community/overlay/${themeId}.webp`,
    backdropImageUrl: `/images/profile-frames/community/${themeId}-backdrop.webp`,
    overlayBackdropImageUrl: `/images/profile-frames/community/overlay/${themeId}-backdrop.webp`, ...extra });
}
const COMMUNITY_PACK = pack(PACK_CORE.themeId, PACK_CORE.title, {
  barId: PACK_CORE.barId, frameOutsetX: 32, frameOutsetY: 28 });
const COMMUNITY_BUS_DRIVER_PACK = COMMUNITY_PACK;
// Legacy identifiers remain valid receipt keys. They carry no retired visual
// definition and resolve to the only current community design.
const LEGACY_COMMUNITY_PACK = Object.freeze({ ...CAMPAIGN,
  frameId: "card-frame-community-astral", costumeId: "community-astral" });
const COMMUNITY_PACKS = Object.freeze([COMMUNITY_PACK]);
const COMMUNITY_PACK_GRANT_PAIRS = Object.freeze([COMMUNITY_PACK, LEGACY_COMMUNITY_PACK]);
const COMMUNITY_PACK_OWNER_GRANT_SOURCE = "community_owner_grant";
const COMMUNITY_PACK_OWNER_GRANT_KIND = "owner-early-access";
function normalizeCommunityPackFrameId(id) { return id === LEGACY_COMMUNITY_PACK.frameId ? COMMUNITY_PACK.frameId : id; }
function isCommunityPackCosmeticId(id) {
  return id === COMMUNITY_PACK.barId || COMMUNITY_PACK_GRANT_PAIRS.some(value => id === value.frameId || id === value.costumeId);
}
function normalizeCommunityPackGrant(input, twitchUserId = null) {
  const selected = COMMUNITY_PACK_GRANT_PAIRS.filter(value => (input?.frameId == null || input.frameId === value.frameId)
    && (input?.costumeId == null || input.costumeId === value.costumeId)
    && (input?.id == null || [value.id, value.frameId].includes(input.id)));
  if (!input || typeof input !== "object" || Array.isArray(input) || !selected.length
    || input.campaignId !== CAMPAIGN.id || input.schemaVersion !== 1
    || !/^\d{1,25}$/.test(String(input.twitchUserId || ""))
    || twitchUserId != null && String(input.twitchUserId) !== String(twitchUserId)) return null;
  if (input.source === COMMUNITY_PACK_OWNER_GRANT_SOURCE) {
    if (String(input.twitchUserId) !== COMMUNITY_PACK_OWNER_TWITCH_ID
      || input.grantKind !== COMMUNITY_PACK_OWNER_GRANT_KIND
      || input.frameId !== COMMUNITY_PACK.frameId || input.costumeId !== COMMUNITY_PACK.costumeId
      || input.contribution !== 0 || input.completedAtMs !== null
      || !Number.isSafeInteger(input.grantedAtMs) || input.grantedAtMs <= 0) return null;
    return { campaignId: CAMPAIGN.id, twitchUserId: COMMUNITY_PACK_OWNER_TWITCH_ID,
      frameId: COMMUNITY_PACK.frameId, costumeId: COMMUNITY_PACK.costumeId,
      source: COMMUNITY_PACK_OWNER_GRANT_SOURCE, grantKind: COMMUNITY_PACK_OWNER_GRANT_KIND,
      contribution: 0, completedAtMs: null, grantedAtMs: input.grantedAtMs, schemaVersion: 1 };
  }
  if (input.source !== CAMPAIGN.source || input.grantKind != null
    || !Number.isSafeInteger(input.contribution) || input.contribution < CAMPAIGN.minFirstContribution || input.contribution > CAMPAIGN.target
    || !Number.isSafeInteger(input.completedAtMs) || input.completedAtMs <= 0
    || !Number.isSafeInteger(input.grantedAtMs) || input.grantedAtMs < input.completedAtMs) return null;
  return { campaignId: CAMPAIGN.id, twitchUserId: String(input.twitchUserId), contribution: input.contribution,
    completedAtMs: input.completedAtMs, grantedAtMs: input.grantedAtMs, source: CAMPAIGN.source, schemaVersion: 1 };
}
function createCommunityPackOwnerGrant({ twitchUserId, grantedAtMs } = {}) {
  const grant = normalizeCommunityPackGrant({ campaignId: CAMPAIGN.id, twitchUserId,
    frameId: COMMUNITY_PACK.frameId, costumeId: COMMUNITY_PACK.costumeId,
    source: COMMUNITY_PACK_OWNER_GRANT_SOURCE, grantKind: COMMUNITY_PACK_OWNER_GRANT_KIND,
    contribution: 0, completedAtMs: null, grantedAtMs, schemaVersion: 1 }, twitchUserId);
  if (!grant) throw Object.assign(new Error("community_pack_owner_grant_invalid"), { code: "community_pack_owner_grant_invalid", status: 400 });
  return grant;
}
function communityPackUnlockedAt(value, grantedAtMs) {
  const millis = value instanceof Date ? value.getTime()
    : typeof value?.toMillis === "function" ? value.toMillis() : NaN;
  // Firestore reads Dates back as Timestamps. Preserve the server value when
  // its instant is already correct, so a state read does not rewrite ownership.
  return millis === grantedAtMs ? value : new Date(grantedAtMs);
}
function hasCommunityPackGrant(profile = {}, frameId = COMMUNITY_PACK.frameId) {
  if (normalizeCommunityPackFrameId(frameId) !== COMMUNITY_PACK.frameId) return false;
  const ids = TWITCH_ID_FIELDS.map(field => profile?.[field]).filter(value => value != null && value !== "").map(String);
  return COMMUNITY_PACK_GRANT_PAIRS.some(value => {
    const owned = profile?.popsShop?.profileFrames?.owned?.[value.frameId];
    const grant = normalizeCommunityPackGrant(owned);
    return Boolean(grant && (owned.frameId == null || owned.frameId === value.frameId)
      && (owned.costumeId == null || owned.costumeId === value.costumeId)
      && (owned.id == null || owned.id === value.frameId)
      && ids.length && ids.every(id => id === grant.twitchUserId));
  });
}
function frameForPack(value, profile) {
  const unlocked = hasCommunityPackGrant(profile, value.frameId);
  return { id: value.frameId, title: value.title, className: value.className, section: value.section,
    imageUrl: value.imageUrl, overlayImageUrl: value.overlayImageUrl, backdropImageUrl: value.backdropImageUrl,
    overlayBackdropImageUrl: value.overlayBackdropImageUrl, frameOutsetX: value.frameOutsetX, frameOutsetY: value.frameOutsetY,
    usesImageAsset: true, acquisitionMode: "community-reward", price: 0, basePrice: 0, unlocked,
    tone: value.themeId, sourceIndex: unlocked ? 0 : -1,
    isLevelFrame: false, cardId: null, titleStyleId: null, requiredCardId: "", unlockType: "community-campaign",
    campaignId: value.id, schemaVersion: 1,
    description: "Une façade de bus jaune et noir assortie à la tenue Chauffeur de la commu, acquise définitivement par les contributeurs.",
    missingDescription: unlocked ? "" : "Contribue au moins 1 000 POPS avant la clôture, puis récupère les trois récompenses lorsque la communauté atteint 50 000 POPS." };
}
function getCommunityPackFrame(profile = {}) { return frameForPack(COMMUNITY_PACK, profile); }
function getCommunityPackFrameById(id, profile = {}) {
  const value = COMMUNITY_PACKS.find(candidate => candidate.frameId === normalizeCommunityPackFrameId(id));
  return value ? frameForPack(value, profile) : null;
}
function getCommunityPackFrameCatalog(profile = {}) {
  return COMMUNITY_PACKS.map(value => frameForPack(value, profile));
}
module.exports = { COMMUNITY_PACK, COMMUNITY_BUS_DRIVER_PACK, LEGACY_COMMUNITY_PACK, COMMUNITY_PACKS, COMMUNITY_PACK_GRANT_PAIRS,
  COMMUNITY_PACK_OWNER_TWITCH_ID, COMMUNITY_PACK_OWNER_GRANT_SOURCE, COMMUNITY_PACK_OWNER_GRANT_KIND, createCommunityPackOwnerGrant,
  normalizeCommunityPackFrameId, isCommunityPackCosmeticId, normalizeCommunityPackGrant, normalizeCommunityPackClaim,
  hasCommunityPackClaim, communityPackUnlockedAt, hasCommunityPackGrant,
  getCommunityPackFrame, getCommunityPackFrameById, getCommunityPackFrameCatalog };
