"use strict";

// Shared absolute clock for the avatar, released magic and subscription card.
// Only the response descriptor is new; the persisted reservation keeps the
// existing startsAtMs/endsAtMs fields.
const SUBSCRIPTION_LEAD_MS = 1200;
const SUBSCRIPTION_CHARACTER_MS = 6000;
const SUBSCRIPTION_RETURN_MS = 600;
const LEGACY_SUBSCRIPTION_MS = 10400;
const SUBSCRIPTION_CARD_HOLD_MS = 5000;
const SUBSCRIPTION_CARD_EXIT_MS = 1800;
const SUBSCRIPTION_DATES = Object.freeze(["attackStartsAtMs", "attackEndsAtMs", "releaseAtMs", "impactAtMs", "exitStartsAtMs", "characterEndsAtMs", "cardHideAtMs", "cardEndsAtMs"]);

function subscriptionWeaponTiming(viewer = {}) {
  const weapon = viewer.character?.weapon || "sword";
  const stage = Number(viewer.weaponForm) || 1;
  const release = { sword: 2480, hammer: 2504, bow: 3176, staff: 2840 }[weapon] || 2480;
  const impact = { sword: 3380, hammer: 3404, bow: 4076, staff: stage === 4 ? 4400 : 3950 }[weapon] || 3380;
  return { weapon, release, impact };
}
function createSubscriptionPresentation({ startsAtMs, appearanceId, viewer = {} }) {
  const { weapon, release, impact } = subscriptionWeaponTiming(viewer);
  const impactAtMs = startsAtMs + impact;
  const cardHideAtMs = impactAtMs + SUBSCRIPTION_CARD_HOLD_MS;
  return { version: 2, attackKey: `attack_${weapon}:subscription:${appearanceId || startsAtMs}`,
    attackStartsAtMs: startsAtMs + 1400, attackEndsAtMs: startsAtMs + 3800,
    releaseAtMs: startsAtMs + release, impactAtMs, exitStartsAtMs: startsAtMs + 5200,
    characterEndsAtMs: startsAtMs + SUBSCRIPTION_CHARACTER_MS, cardHideAtMs,
    cardEndsAtMs: cardHideAtMs + SUBSCRIPTION_CARD_EXIT_MS };
}
function subscriptionPresentationFor(value) {
  if (!value || (value.type !== "subscription" && value.appearanceType !== "subscription")
    || !Number.isFinite(value.startsAtMs) || !Number.isFinite(value.endsAtMs)
    || value.endsAtMs - value.startsAtMs === LEGACY_SUBSCRIPTION_MS) return null;
  const result = createSubscriptionPresentation({ ...value, appearanceId: value.appearanceId || value.requestId });
  return result.cardEndsAtMs === value.endsAtMs ? result : null;
}
function localSubscriptionPresentation(value, offset = 0) {
  if (value?.version !== 2 || !SUBSCRIPTION_DATES.every(key => Number.isFinite(value[key]))) return null;
  return { ...value, ...Object.fromEntries(SUBSCRIPTION_DATES.map(key => [key, value[key] - offset])) };
}
module.exports = { SUBSCRIPTION_LEAD_MS, SUBSCRIPTION_CHARACTER_MS, SUBSCRIPTION_RETURN_MS,
  LEGACY_SUBSCRIPTION_MS, SUBSCRIPTION_CARD_HOLD_MS, SUBSCRIPTION_CARD_EXIT_MS,
  SUBSCRIPTION_DATES, subscriptionWeaponTiming, createSubscriptionPresentation,
  subscriptionPresentationFor, localSubscriptionPresentation };
