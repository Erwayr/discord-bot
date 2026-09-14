"use strict";

const QUEST_CHEST_SCHEMA_VERSION = 1;
const QUEST_MILESTONES_CONFIG_VERSION = 1;
const QUEST_CHEST_TRANSACTION_SOURCE = "quest_chests_v1";
const QUEST_MILESTONE_TRANSACTION_SOURCE = "quest_milestones_v1";
const QUEST_CHEST_TYPES = Object.freeze(["runic", "epic", "legendary"]);
const QUEST_CHEST_ITEM_ROLL_SCALE = 0x100000000;

const DEFAULT_QUEST_MILESTONES = Object.freeze({
  schemaVersion: QUEST_MILESTONES_CONFIG_VERSION,
  slots: Object.freeze([
    Object.freeze({ id: "pops-1", progressPct: 20, kind: "pops", popsAmount: 100 }),
    Object.freeze({ id: "pops-2", progressPct: 40, kind: "pops", popsAmount: 200 }),
    Object.freeze({
      id: "runic",
      progressPct: 60,
      kind: "chest",
      chestType: "runic",
      label: "Coffre runique",
      aura: "cyan",
      itemChanceBps: 20,
      popsMin: 100,
      popsMax: 350,
      xpMin: 40,
      xpMax: 90,
    }),
    Object.freeze({
      id: "epic",
      progressPct: 80,
      kind: "chest",
      chestType: "epic",
      label: "Coffre épique",
      aura: "violet",
      itemChanceBps: 50,
      popsMin: 300,
      popsMax: 700,
      xpMin: 90,
      xpMax: 170,
    }),
    Object.freeze({
      id: "legendary",
      progressPct: 100,
      kind: "chest",
      chestType: "legendary",
      label: "Coffre légendaire",
      aura: "gold",
      itemChanceBps: 100,
      popsMin: 600,
      popsMax: 1000,
      xpMin: 250,
      xpMax: 500,
    }),
  ]),
});

const SLOT_IDS = Object.freeze(DEFAULT_QUEST_MILESTONES.slots.map((slot) => slot.id));

function questChestError(status, code, message = code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function safeInt(value, fallback, min, max) {
  const number = Number(value);
  const integer = Number.isFinite(number) ? Math.floor(number) : fallback;
  return Math.max(min, Math.min(max, integer));
}

function requireStrictInt(value, min, max, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw questChestError(400, code);
  }
}

function normalizeQuestMilestones(raw = null, { strict = false } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const inputSlots = Array.isArray(source.slots) ? source.slots : [];
  if (strict && inputSlots.length !== SLOT_IDS.length) {
    throw questChestError(400, "invalid_quest_milestone_slot_count");
  }

  const byId = new Map(inputSlots.map((slot) => [String(slot?.id || "").trim(), slot]));
  const slots = DEFAULT_QUEST_MILESTONES.slots.map((fallback) => {
    const input = byId.get(fallback.id) || {};
    if (strict && !byId.has(fallback.id)) {
      throw questChestError(400, "invalid_quest_milestone_slot_id");
    }
    if (strict) {
      if (input.kind !== fallback.kind) {
        throw questChestError(400, "invalid_quest_milestone_slot_kind");
      }
      if (
        fallback.kind === "chest" &&
        input.chestType !== fallback.chestType
      ) {
        throw questChestError(400, "invalid_quest_milestone_chest_type");
      }
      requireStrictInt(
        input.progressPct,
        1,
        100,
        "invalid_quest_milestone_progress",
      );
      if (fallback.kind === "pops") {
        requireStrictInt(
          input.popsAmount,
          0,
          10000,
          "invalid_quest_milestone_pops",
        );
      } else {
        requireStrictInt(
          input.itemChanceBps,
          0,
          10000,
          "invalid_quest_chest_item_probability",
        );
        ["popsMin", "popsMax", "xpMin", "xpMax"].forEach((field) =>
          requireStrictInt(
            input[field],
            1,
            100000,
            "invalid_quest_chest_reward_range",
          ),
        );
      }
    }
    const slot = {
      ...fallback,
      progressPct: safeInt(input.progressPct, fallback.progressPct, 1, 100),
    };
    if (fallback.kind === "pops") {
      slot.popsAmount = safeInt(input.popsAmount, fallback.popsAmount, 0, 10000);
      return slot;
    }
    slot.itemChanceBps = safeInt(input.itemChanceBps, fallback.itemChanceBps, 0, 10000);
    slot.popsMin = safeInt(input.popsMin, fallback.popsMin, 1, 100000);
    slot.popsMax = safeInt(input.popsMax, fallback.popsMax, 1, 100000);
    slot.xpMin = safeInt(input.xpMin, fallback.xpMin, 1, 100000);
    slot.xpMax = safeInt(input.xpMax, fallback.xpMax, 1, 100000);
    if (strict && slot.itemChanceBps % 2 !== 0) {
      throw questChestError(400, "invalid_quest_chest_probability_split");
    }
    if (strict && (slot.popsMin > slot.popsMax || slot.xpMin > slot.xpMax)) {
      throw questChestError(400, "invalid_quest_chest_reward_range");
    }
    if (slot.popsMin > slot.popsMax) [slot.popsMin, slot.popsMax] = [slot.popsMax, slot.popsMin];
    if (slot.xpMin > slot.xpMax) [slot.xpMin, slot.xpMax] = [slot.xpMax, slot.xpMin];
    return slot;
  });

  const thresholds = slots.map((slot) => slot.progressPct);
  const ordered = thresholds.every((value, index) => index === 0 || value > thresholds[index - 1]);
  if (!ordered) throw questChestError(400, "invalid_quest_milestone_order");

  return { schemaVersion: QUEST_MILESTONES_CONFIG_VERSION, slots };
}

function buildQuestChestId(month, slotId) {
  return `${String(month || "").trim()}-${String(slotId || "").trim()}`;
}

function buildQuestMilestonePopsTransactionId(month, slotId) {
  return `quest_milestone_${String(month || "").trim()}_${String(slotId || "").trim()}`;
}

function buildQuestChestPopsTransactionId(chestId) {
  return `quest_chest_${String(chestId || "").trim()}_pops`;
}

function countAvailableQuestChestsByType(chests = []) {
  const counts = Object.fromEntries(
    QUEST_CHEST_TYPES.map((chestType) => [chestType, 0]),
  );
  (Array.isArray(chests) ? chests : []).forEach((chest) => {
    const chestType = String(chest?.chestType || "").trim().toLowerCase();
    if (chest?.status !== "available" || !(chestType in counts)) return;
    counts[chestType] += 1;
  });
  return counts;
}

function buildChestSnapshot(slot) {
  const remaining = 10000 - slot.itemChanceBps;
  return {
    schemaVersion: QUEST_CHEST_SCHEMA_VERSION,
    itemChanceBps: slot.itemChanceBps,
    popsChanceBps: remaining / 2,
    xpChanceBps: remaining / 2,
    popsMin: slot.popsMin,
    popsMax: slot.popsMax,
    xpMin: slot.xpMin,
    xpMax: slot.xpMax,
  };
}

function planQuestMilestoneRewards({ month, progressPct = 0, config = null, existingIds = [] } = {}) {
  const milestones = normalizeQuestMilestones(config);
  const progress = Math.max(0, Math.min(100, Number(progressPct) || 0));
  const existing = new Set(existingIds);
  const pops = [];
  const chests = [];
  milestones.slots.forEach((slot) => {
    if (progress < slot.progressPct) return;
    const rewardId = slot.kind === "pops"
      ? buildQuestMilestonePopsTransactionId(month, slot.id)
      : buildQuestChestId(month, slot.id);
    if (existing.has(rewardId)) return;
    if (slot.kind === "pops") {
      pops.push({ ...slot, rewardId, month });
      return;
    }
    chests.push({
      id: rewardId,
      month,
      slotId: slot.id,
      progressPct: slot.progressPct,
      chestType: slot.chestType,
      label: slot.label,
      aura: slot.aura,
      status: "available",
      rewardSnapshot: buildChestSnapshot(slot),
      schemaVersion: QUEST_CHEST_SCHEMA_VERSION,
    });
  });
  return { pops, chests, milestones };
}

function inclusiveRandomInt(min, max, randomInt) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  return low + randomInt(high - low + 1);
}

function normalizeEligibleItems(items) {
  return (Array.isArray(items) ? items : []).filter(
    (item) => item && item.id && item.unlocked !== false && item.owned !== true,
  );
}

function planQuestChestReward({ chest, randomInt } = {}) {
  if (!chest || chest.status !== "available") {
    throw questChestError(409, "quest_chest_not_available");
  }
  if (typeof randomInt !== "function") {
    throw questChestError(500, "quest_chest_rng_missing");
  }
  const snapshot = chest.rewardSnapshot || {};
  const rollBps = randomInt(10000);
  const itemChanceBps = safeInt(snapshot.itemChanceBps, 0, 0, 10000);
  const popsChanceBps = safeInt(snapshot.popsChanceBps, 0, 0, 10000);

  if (rollBps < itemChanceBps) {
    return {
      kind: "item",
      rollBps,
      preferredCategory: randomInt(2) === 0 ? "profile_frame" : "experience_bar",
      itemRoll: randomInt(QUEST_CHEST_ITEM_ROLL_SCALE),
      compensationPops: safeInt(snapshot.popsMax, 1, 1, 100000),
    };
  }

  if (rollBps < itemChanceBps + popsChanceBps) {
    return {
      kind: "pops",
      amount: inclusiveRandomInt(snapshot.popsMin, snapshot.popsMax, randomInt),
      rollBps,
    };
  }

  return {
    kind: "xp",
    amount: inclusiveRandomInt(snapshot.xpMin, snapshot.xpMax, randomInt),
    rollBps,
  };
}

function resolveQuestChestRewardPlan({ plan, profileFrames = [], experienceBars = [] } = {}) {
  if (!plan || !["item", "pops", "xp"].includes(plan.kind)) {
    throw questChestError(500, "quest_chest_reward_plan_missing");
  }
  if (plan.kind !== "item") return { ...plan };

  const frames = normalizeEligibleItems(profileFrames);
  const bars = normalizeEligibleItems(experienceBars);
  if (!frames.length && !bars.length) {
    return {
      kind: "pops",
      amount: safeInt(plan.compensationPops, 1, 1, 100000),
      compensation: "empty_item_catalog",
      rollBps: plan.rollBps,
    };
  }

  const preferred = plan.preferredCategory === "experience_bar" ? bars : frames;
  const candidates = preferred.length ? preferred : preferred === frames ? bars : frames;
  const safeRoll = Math.max(0, Math.min(
    QUEST_CHEST_ITEM_ROLL_SCALE - 1,
    Math.floor(Number(plan.itemRoll) || 0),
  ));
  const item = candidates[Math.floor((safeRoll / QUEST_CHEST_ITEM_ROLL_SCALE) * candidates.length)];
  return {
    kind: "item",
    category: candidates === frames ? "profile_frame" : "experience_bar",
    item: {
      id: item.id,
      title: item.title || item.name || item.id,
      imageUrl: item.imageUrl || item.imgUrl || "",
      className: item.className || "",
      collectionSection: item.collectionSection || item.section || "",
    },
    rollBps: plan.rollBps,
  };
}

function normalizeQuestChestPendingSummary(summary = {}) {
  const source = summary && typeof summary === "object" ? summary : {};
  const pendingByTypeSource = source.pendingByType && typeof source.pendingByType === "object"
    ? source.pendingByType
    : {};
  return {
    pendingCount: safeInt(source.pendingCount, 0, 0, Number.MAX_SAFE_INTEGER),
    pendingByType: Object.fromEntries(
      QUEST_CHEST_TYPES.map((chestType) => [
        chestType,
        safeInt(pendingByTypeSource[chestType], 0, 0, Number.MAX_SAFE_INTEGER),
      ]),
    ),
  };
}

function decrementQuestChestPendingSummary(summary = {}, chestType = "") {
  const normalized = normalizeQuestChestPendingSummary(summary);
  const normalizedType = String(chestType || "").trim().toLowerCase();
  const pendingByType = { ...normalized.pendingByType };
  if (normalizedType in pendingByType) {
    pendingByType[normalizedType] = Math.max(0, pendingByType[normalizedType] - 1);
  }
  return {
    pendingCount: Math.max(0, normalized.pendingCount - 1),
    pendingByType,
  };
}

function rollQuestChestReward({ chest, profileFrames = [], experienceBars = [], randomInt } = {}) {
  return resolveQuestChestRewardPlan({
    plan: planQuestChestReward({ chest, randomInt }),
    profileFrames,
    experienceBars,
  });
}

module.exports = {
  DEFAULT_QUEST_MILESTONES,
  QUEST_CHEST_SCHEMA_VERSION,
  QUEST_CHEST_TYPES,
  QUEST_CHEST_TRANSACTION_SOURCE,
  QUEST_MILESTONES_CONFIG_VERSION,
  QUEST_MILESTONE_TRANSACTION_SOURCE,
  SLOT_IDS,
  buildChestSnapshot,
  buildQuestChestId,
  buildQuestChestPopsTransactionId,
  buildQuestMilestonePopsTransactionId,
  countAvailableQuestChestsByType,
  decrementQuestChestPendingSummary,
  normalizeQuestMilestones,
  normalizeQuestChestPendingSummary,
  planQuestMilestoneRewards,
  planQuestChestReward,
  questChestError,
  resolveQuestChestRewardPlan,
  rollQuestChestReward,
};
