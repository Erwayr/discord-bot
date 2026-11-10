"use strict";

const { NOEL_2026_EVENT: EVENT, seasonalTimestampMs } = require("./seasonal-cosmetics.shared.cjs");
const ID_FIELDS = ["twitch_id", "twitchId", "twitchUserId", "user_id"];

function normalizeNoelPackGrant(grant, twitchUserId = grant?.twitchUserId) {
  const userId = String(twitchUserId || "");
  if (!grant || !/^\d{1,25}$/.test(userId) || grant.twitchUserId !== userId || grant.costumeId !== EVENT.costumeId ||
    !Number.isSafeInteger(grant.observedAtMs) || grant.observedAtMs < EVENT.startsAtMs || grant.observedAtMs >= EVENT.endsAtMs ||
    typeof grant.streamId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(grant.streamId)) return null;
  const unlockedAt = seasonalTimestampMs(grant.unlockedAt);
  if (!Number.isFinite(unlockedAt) || unlockedAt < grant.observedAtMs) return null;
  return { costumeId: EVENT.costumeId, twitchUserId: userId, observedAtMs: grant.observedAtMs,
    streamId: grant.streamId, unlockedAt: grant.unlockedAt };
}

// The caller must first load an existing canonical follower and the immutable
// server receipt. This pure projection never creates a profile or equips items.
function prepareNoelPackReconciliation({ profile = {}, twitchUserId, grant } = {}) {
  const userId = String(twitchUserId || "");
  const ids = ID_FIELDS.map(key => profile[key]).filter(value => value != null && value !== "").map(String);
  if (!/^\d{1,25}$/.test(userId) || ids.some(id => id !== userId)) {
    throw Object.assign(new Error("twitch_identity_conflict"), { code: "twitch_identity_conflict", status: 409 });
  }
  const proof = normalizeNoelPackGrant(grant, userId);
  const frameOwned = { ...profile.popsShop?.profileFrames?.owned };
  const barOwned = { ...profile.popsShop?.experienceBars?.owned };
  const costumeOwned = { ...profile.guardianCosmetics?.costumes?.owned };
  delete frameOwned[EVENT.frameId]; delete barOwned[EVENT.barId]; delete costumeOwned[EVENT.costumeId];
  if (proof) {
    const metadata = { ...proof, eventId: EVENT.id, source: EVENT.source, schemaVersion: EVENT.schemaVersion,
      qualifiedAt: proof.observedAtMs, grantedAt: seasonalTimestampMs(proof.unlockedAt) };
    frameOwned[EVENT.frameId] = { ...metadata, id: EVENT.frameId };
    barOwned[EVENT.barId] = { ...metadata, id: EVENT.barId };
    costumeOwned[EVENT.costumeId] = proof;
  }
  const update = {};
  for (const [path, before, after] of [
    ["popsShop.profileFrames.owned", profile.popsShop?.profileFrames?.owned, frameOwned],
    ["popsShop.experienceBars.owned", profile.popsShop?.experienceBars?.owned, barOwned],
    ["guardianCosmetics.costumes.owned", profile.guardianCosmetics?.costumes?.owned, costumeOwned],
  ]) if (JSON.stringify(before || {}) !== JSON.stringify(after)) update[path] = after;
  if (proof && !ids.length) update.twitch_id = userId;
  return { profile: { ...profile, ...(update.twitch_id ? { twitch_id: userId } : {}),
    popsShop: { ...profile.popsShop,
      profileFrames: { ...profile.popsShop?.profileFrames, owned: frameOwned },
      experienceBars: { ...profile.popsShop?.experienceBars, owned: barOwned } },
    guardianCosmetics: { ...profile.guardianCosmetics, costumes: { ...profile.guardianCosmetics?.costumes, owned: costumeOwned } } }, update };
}

function noelSeasonalOwnership(profile = {}) {
  return { profileFrames: { owned: profile.popsShop?.profileFrames?.owned?.[EVENT.frameId]
    ? { [EVENT.frameId]: profile.popsShop.profileFrames.owned[EVENT.frameId] } : {} },
  experienceBars: { owned: profile.popsShop?.experienceBars?.owned?.[EVENT.barId]
    ? { [EVENT.barId]: profile.popsShop.experienceBars.owned[EVENT.barId] } : {} },
  costumes: { owned: profile.guardianCosmetics?.costumes?.owned?.[EVENT.costumeId]
    ? { [EVENT.costumeId]: profile.guardianCosmetics.costumes.owned[EVENT.costumeId] } : {} } };
}
module.exports = { normalizeNoelPackGrant, prepareNoelPackReconciliation, noelSeasonalOwnership };
