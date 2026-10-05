"use strict";

const LIVE_REWARD_VERSION = 2;
const LIVE_REWARD_DEFAULTS = Object.freeze({
  chatXp: 5, chatCooldownMs: 60_000, chatXpCapPerStream: 300,
  presenceXp: 50, presenceXpCapPerStream: 50, presenceMinMinutes: 10,
  channelPointsXp: 5, channelPointsXpCapPerStream: 50,
  watchtimeXpPerMinute: 8, watchtimeMaxMinutesPerStream: 360,
});
const LEGACY_REWARD_DEFAULTS = Object.freeze({
  chatXp: 10, chatCooldownMs: 60_000, chatXpCapPerStream: 1200,
  presenceXp: 200, presenceXpCapPerStream: 200,
  channelPointsXp: 5, channelPointsXpCapPerStream: 50,
});

function timestampMs(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value?.seconds != null) return Number(value.seconds) * 1000;
  if (typeof value === "number") return value;
  return Number(new Date(value || "")) || 0;
}

function rewardVersionForStart(startedAt, config = {}) {
  const activation = timestampMs(config.liveRewardsActivatedAt);
  const start = timestampMs(startedAt);
  return activation > 0 && start >= activation ? LIVE_REWARD_VERSION : 1;
}

function isLiveRewardV2(entry) {
  return entry?.reward_version === LIVE_REWARD_VERSION;
}

function rewardConfigForStream(entry, raw = {}) {
  return isLiveRewardV2(entry)
    ? { ...raw, ...LIVE_REWARD_DEFAULTS, ...(raw.liveRewards || {}) }
    : { ...raw, ...(raw.legacyLiveRewards || {}) };
}

// Quest messages retain their own counter. Only this counter is rate limited.
function recordPodiumMessage(entry, atMs) {
  if (!isLiveRewardV2(entry)) return;
  const activity = entry.podium_activity ||= { chat_messages: 0, last_chat_at: 0 };
  if (activity.chat_messages >= 10 ||
      (activity.last_chat_at > 0 && atMs - activity.last_chat_at < 60_000)) return;
  activity.chat_messages += 1;
  activity.last_chat_at = atMs;
}

module.exports = { LIVE_REWARD_VERSION, LIVE_REWARD_DEFAULTS, LEGACY_REWARD_DEFAULTS,
  timestampMs, rewardVersionForStart, isLiveRewardV2, rewardConfigForStream, recordPodiumMessage };
