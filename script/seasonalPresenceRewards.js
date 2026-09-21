"use strict";

const { HALLOWEEN_2026_EVENT: event, qualifyingHalloween2026Timestamp, hasHalloween2026Grant } = require("./seasonal-cosmetics.shared.cjs");

function qualifyingPresenceMs(value) {
  const atMs = Number(value);
  return Number.isFinite(atMs) && atMs > 0 ? qualifyingHalloween2026Timestamp(Math.floor(atMs)) : 0;
}

function mergeQualifyingPresenceMs(...values) {
  const qualified = values.map(qualifyingPresenceMs).filter(Boolean);
  return qualified.length ? Math.min(...qualified) : 0;
}

// Called only inside the authoritative follower transaction, after presence gates.
// A complete nested map works for both update(existing) and set(new, merge).
function buildHalloweenPresencePatch(data = {}, qualifiedAtMs = 0, grantedAtMs = Date.now()) {
  const qualifiedAt = qualifyingPresenceMs(qualifiedAtMs);
  if (!qualifiedAt) return {};
  const shop = data.popsShop || {};
  const nextShop = { ...shop };
  let changed = false;
  for (const [storeName, kind, id] of [
    ["profileFrames", "profile-frame", event.frameId],
    ["experienceBars", "experience-bar", event.barId],
  ]) {
    if (hasHalloween2026Grant(data, kind)) continue;
    const current = shop[storeName] || {};
    nextShop[storeName] = {
      ...current,
      owned: {
        ...(current.owned || {}),
        [id]: {
          id,
          source: event.source,
          eventId: event.id,
          qualifiedAt,
          grantedAt: grantedAtMs,
          schemaVersion: event.schemaVersion,
        },
      },
    };
    changed = true;
  }
  return changed ? { popsShop: nextShop } : {};
}

module.exports = { qualifyingPresenceMs, mergeQualifyingPresenceMs, buildHalloweenPresencePatch };
