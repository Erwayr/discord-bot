"use strict";

// Shared absolute clock for the avatar, released magic and subscription card.
// Only the response descriptor is new; the persisted reservation keeps the
// existing startsAtMs/endsAtMs fields.
const SUBSCRIPTION_LEAD_MS = 1200;
// Version-two compatibility only: v3 character lifetime follows cardEndsAtMs.
const SUBSCRIPTION_CHARACTER_MS = 6000;
const SUBSCRIPTION_RETURN_MS = 600;
const LEGACY_SUBSCRIPTION_MS = 10400;
const SUBSCRIPTION_CARD_HOLD_MS = 5000;
const SUBSCRIPTION_CARD_EXIT_MS = 1800;
const SUBSCRIPTION_ENTRY_MS = 1400;
const SUBSCRIPTION_EXIT_MS = 800;
const SUBSCRIPTION_PREPARATION_MS = 30000;
const V2_DATES = Object.freeze(["attackStartsAtMs", "attackEndsAtMs", "releaseAtMs", "impactAtMs", "exitStartsAtMs", "characterEndsAtMs", "cardHideAtMs", "cardEndsAtMs"]);
const SUBSCRIPTION_DATES = Object.freeze([...V2_DATES, "entryEndsAtMs", "effectsEndsAtMs", "returnEndsAtMs"]);

function subscriptionWeaponTiming(viewer = {}) {
  const weapon = viewer.character?.weapon || "sword";
  const stage = Number(viewer.weaponForm) || 1;
  const release = { sword: 2480, hammer: 2504, bow: 3176, staff: 2840 }[weapon] || 2480;
  const impact = { sword: 3380, hammer: 3404, bow: 4076, staff: stage === 4 ? 4400 : 3950 }[weapon] || 3380;
  return { weapon, release, impact };
}
function createSubscriptionPresentation({ version = 3, startsAtMs, appearanceId, viewer = {} }) {
  const { weapon, release, impact } = subscriptionWeaponTiming(viewer);
  const delay = version === 2 ? 0 : 600;
  const impactAtMs = startsAtMs + impact + delay;
  const cardHideAtMs = impactAtMs + SUBSCRIPTION_CARD_HOLD_MS;
  const cardEndsAtMs = cardHideAtMs + SUBSCRIPTION_CARD_EXIT_MS;
  const characterEndsAtMs = version === 2 ? startsAtMs + SUBSCRIPTION_CHARACTER_MS : cardEndsAtMs + SUBSCRIPTION_EXIT_MS;
  return { version: version === 2 ? 2 : 3, attackKey: `attack_${weapon}:subscription:${appearanceId || startsAtMs}`,
    attackStartsAtMs: startsAtMs + 1400 + delay, attackEndsAtMs: startsAtMs + 3800 + delay,
    releaseAtMs: startsAtMs + release + delay, impactAtMs,
    exitStartsAtMs: version === 2 ? startsAtMs + 5200 : cardEndsAtMs,
    characterEndsAtMs, cardHideAtMs, cardEndsAtMs,
    ...(version === 2 ? {} : { entryEndsAtMs: startsAtMs + SUBSCRIPTION_ENTRY_MS,
      effectsEndsAtMs: startsAtMs + 5800, returnEndsAtMs: characterEndsAtMs + SUBSCRIPTION_RETURN_MS }) };
}
function subscriptionPresentationFor(value) {
  if (!value || (value.type !== "subscription" && value.appearanceType !== "subscription")
    || !Number.isFinite(value.startsAtMs) || !Number.isFinite(value.endsAtMs)
    || value.endsAtMs - value.startsAtMs === LEGACY_SUBSCRIPTION_MS) return null;
  const input = { ...value, appearanceId: value.appearanceId || value.requestId };
  const result = createSubscriptionPresentation(input);
  if (result.returnEndsAtMs === value.endsAtMs) return result;
  const previous = createSubscriptionPresentation({ ...input, version: 2 });
  return previous.cardEndsAtMs === value.endsAtMs ? previous : null;
}
function isSubscriptionPresentation(value) {
  return Boolean([2, 3].includes(value?.version) && (value.version === 2 ? V2_DATES : SUBSCRIPTION_DATES)
    .every(key => Number.isFinite(value[key])));
}
function localSubscriptionPresentation(value, offset = 0) {
  if (!isSubscriptionPresentation(value) || !Number.isFinite(offset)) return null;
  const dates = value.version === 2 ? V2_DATES : SUBSCRIPTION_DATES;
  return { ...value, ...Object.fromEntries(dates.map(key => [key, value[key] - offset])) };
}
module.exports = { SUBSCRIPTION_LEAD_MS, SUBSCRIPTION_CHARACTER_MS, SUBSCRIPTION_RETURN_MS,
  LEGACY_SUBSCRIPTION_MS, SUBSCRIPTION_CARD_HOLD_MS, SUBSCRIPTION_CARD_EXIT_MS,
  SUBSCRIPTION_ENTRY_MS, SUBSCRIPTION_EXIT_MS, SUBSCRIPTION_PREPARATION_MS,
  SUBSCRIPTION_DATES, subscriptionWeaponTiming, createSubscriptionPresentation, isSubscriptionPresentation,
  subscriptionPresentationFor, localSubscriptionPresentation };
