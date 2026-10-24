"use strict";

// Compact identity and XP ownership contract. Card/profile bootstraps need this
// synchronously; visual frame catalogues stay in the deferred full contract.
const CAMPAIGN = Object.freeze({ id: "community-astral", target: 50000,
  minFirstContribution: 1000, source: "community_astral_contribution", schemaVersion: 1, section: "Communauté" });
const THEME_ID = "community-bus-driver";
const COMMUNITY_PACK = Object.freeze({ ...CAMPAIGN, themeId: THEME_ID, title: "Chauffeur de la commu",
  frameId: `card-frame-${THEME_ID}`, costumeId: THEME_ID, barId: `${THEME_ID}-xp` });
const COMMUNITY_PACK_OWNER_TWITCH_ID = "480296446";
const TWITCH_ID_FIELDS = Object.freeze(["twitch_id", "twitchId", "twitchUserId", "user_id"]);

// This complete immutable receipt is the only XP proof. Historical pair grants
// never imply XP ownership, including the owner's early-access pair.
function normalizeCommunityPackClaim(input, twitchUserId = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || input.campaignId !== CAMPAIGN.id || input.schemaVersion !== 1 || input.source !== "community_pack_claim"
    || !/^\d{1,25}$/.test(String(input.twitchUserId || ""))
    || twitchUserId != null && String(input.twitchUserId) !== String(twitchUserId)
    || input.frameId !== COMMUNITY_PACK.frameId || input.costumeId !== COMMUNITY_PACK.costumeId
    || input.barId !== COMMUNITY_PACK.barId || input.id != null && input.id !== COMMUNITY_PACK.barId
    || !Number.isSafeInteger(input.completedAtMs) || input.completedAtMs <= 0
    || !Number.isSafeInteger(input.claimedAtMs) || input.claimedAtMs < input.completedAtMs
    || !Number.isSafeInteger(input.contribution) || input.contribution < 0 || input.contribution > CAMPAIGN.target
    || !["contribution", "legacy-grant", "owner-early-access"].includes(input.eligibilitySource)) return null;
  if (input.eligibilitySource === "owner-early-access"
    ? String(input.twitchUserId) !== COMMUNITY_PACK_OWNER_TWITCH_ID || input.contribution !== 0
    : input.contribution < CAMPAIGN.minFirstContribution) return null;
  return { campaignId: CAMPAIGN.id, twitchUserId: String(input.twitchUserId),
    frameId: COMMUNITY_PACK.frameId, costumeId: COMMUNITY_PACK.costumeId, barId: COMMUNITY_PACK.barId,
    source: "community_pack_claim", eligibilitySource: input.eligibilitySource, contribution: input.contribution,
    completedAtMs: input.completedAtMs, claimedAtMs: input.claimedAtMs, schemaVersion: 1 };
}
function hasCommunityPackClaim(profile = {}, barId = COMMUNITY_PACK.barId) {
  if (barId !== COMMUNITY_PACK.barId) return false;
  const claim = normalizeCommunityPackClaim(profile?.popsShop?.experienceBars?.owned?.[barId]);
  const ids = TWITCH_ID_FIELDS.map(field => profile?.[field]).filter(value => value != null && value !== "").map(String);
  return Boolean(claim && ids.length && ids.every(id => id === claim.twitchUserId));
}

module.exports = { CAMPAIGN, COMMUNITY_PACK, COMMUNITY_PACK_OWNER_TWITCH_ID, TWITCH_ID_FIELDS,
  normalizeCommunityPackClaim, hasCommunityPackClaim };
