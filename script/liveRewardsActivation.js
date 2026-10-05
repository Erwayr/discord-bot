"use strict";
const { LIVE_REWARD_DEFAULTS, LEGACY_REWARD_DEFAULTS } = require("./live-rewards.shared.cjs");

// The jobs caller must first confirm offline and successfully drain both queues.
async function activateLiveRewards(db, baseConfig = {}, nowMs = Date.now()) {
  const ref = db.collection("site_config").doc("community_level");
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const current = snap.exists ? snap.data() || {} : {};
    if (Number(current.liveRewardsActivatedAt) > 0) return false;
    const previous = { ...LEGACY_REWARD_DEFAULTS, ...baseConfig, ...current };
    const legacyLiveRewards = Object.fromEntries(Object.keys(LEGACY_REWARD_DEFAULTS)
      .map(key => [key, previous[key]]));
    tx.set(ref, { ...LIVE_REWARD_DEFAULTS, legacyLiveRewards,
      liveRewards: { ...LIVE_REWARD_DEFAULTS }, liveRewardsActivatedAt: nowMs }, { merge: true });
    return true;
  });
}
module.exports = { activateLiveRewards };
