"use strict";

const { EmbedBuilder } = require("discord.js");
const { applyFlatCommunityLevelXp } = require("./communityLevel");

const DAILY_CHEST_SCHEMA_VERSION = 1;
const POPS_SCHEMA_VERSION = 1;
const DAILY_CHEST_TRANSACTION_TYPE = "daily_chest";
const DAILY_CHEST_TRANSACTION_SOURCE = "discord_daily_chest";
const DEFAULT_TIMEZONE = "Europe/Warsaw";
const DEFAULT_ANIMATION_DELAY_MS = 650;
const DEFAULT_DAILY_CHEST_CHANNEL_ID = "1516374903203565621";

const REWARD_ICONS = Object.freeze({
  pops: "\u2666\uFE0F",
  exp: "\u2728",
  quest_bonus: "\uD83C\uDF40",
  nothing: "\uD83D\uDCA8",
  chest: "\uD83C\uDF81",
  slot: "\uD83C\uDFB0",
  lock: "\uD83D\uDD10",
  unlock: "\uD83D\uDD13",
  spark: "\u2728",
  laugh: "\uD83D\uDE02",
});

const SLOT_SYMBOLS = Object.freeze([
  REWARD_ICONS.chest,
  REWARD_ICONS.pops,
  REWARD_ICONS.exp,
  REWARD_ICONS.quest_bonus,
  REWARD_ICONS.nothing,
  "\uD83D\uDCB0",
  "\uD83D\uDD25",
]);

const TIER_LABELS = Object.freeze({
  common: "",
  small: "Petit gain",
  rare: "Rare",
  legendary: "Legendaire",
  custom: "Test",
});

const NOTHING_MESSAGES = Object.freeze([
  "Le coffre etait rempli d'air premium. Tres rare, mais invendable.",
  "Tu trouves un coupon -100% de gain. Il a expire hier.",
  "Le coffre s'ouvre... puis fait semblant de ne pas te connaitre.",
  "Un bruit epique, une lumiere divine, et absolument rien.",
  "Inventaire plein de vibes. Solde: zero.",
]);

const TEST_REWARD_AMOUNTS = Object.freeze({
  pops: { small: 15, rare: 150 },
  exp: { small: 15, rare: 150 },
  quest_bonus: { small: 1, legendary: 10 },
});

const RARE_EXTRA_QUEST_BONUS_AMOUNT = 1;
const LEGENDARY_EXTRA_POPS_AMOUNT = 250;
const LEGENDARY_EXTRA_EXP_AMOUNT = 200;

const REWARD_TABLE = Object.freeze([
  { type: "nothing", tier: "common", weight: 34, min: 0, max: 0 },
  { type: "pops", tier: "small", weight: 28, min: 5, max: 25 },
  { type: "exp", tier: "small", weight: 22, min: 5, max: 25 },
  { type: "quest_bonus", tier: "small", weight: 10, min: 1, max: 1 },
  { type: "pops", tier: "rare", weight: 4, min: 100, max: 250 },
  { type: "exp", tier: "rare", weight: 1.5, min: 100, max: 200 },
  { type: "quest_bonus", tier: "legendary", weight: 0.5, min: 10, max: 10 },
]);

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toSafeCount(value) {
  return Math.max(0, Math.floor(toNum(value)));
}

function clampPct(value) {
  return Math.max(0, Math.min(100, toNum(value)));
}

function normalizeRngValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(0.999999999, n));
}

function randomInt(min, max, rng = Math.random) {
  const low = Math.floor(toNum(min));
  const high = Math.floor(toNum(max));
  if (high <= low) return low;
  return low + Math.floor(normalizeRngValue(rng()) * (high - low + 1));
}

function pickRandom(list, rng = Math.random) {
  if (!Array.isArray(list) || !list.length) return "";
  return list[randomInt(0, list.length - 1, rng)];
}

function datePartsInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const byType = {};
  for (const part of parts) byType[part.type] = part.value;
  return {
    year: byType.year || "0000",
    month: byType.month || "00",
    day: byType.day || "00",
  };
}

function dayKeyInTimezone(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = datePartsInTimezone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthKeyInTimezone(date, timeZone = DEFAULT_TIMEZONE) {
  const parts = datePartsInTimezone(date, timeZone);
  return `${parts.year}-${parts.month}`;
}

function normalizePopsWallet(source = {}) {
  const wallet =
    source?.pops && typeof source.pops === "object" ? source.pops : source;
  const balance = toSafeCount(wallet?.balance);
  const lifetimeEarned = Math.max(balance, toSafeCount(wallet?.lifetimeEarned));

  return {
    balance,
    lifetimeEarned,
    schemaVersion: Number(wallet?.schemaVersion || POPS_SCHEMA_VERSION),
  };
}

function selectDailyChestReward({ rng = Math.random } = {}) {
  const totalWeight = REWARD_TABLE.reduce((sum, row) => sum + row.weight, 0);
  const roll = normalizeRngValue(rng()) * totalWeight;
  let cursor = 0;
  let selected = REWARD_TABLE[REWARD_TABLE.length - 1];

  for (const row of REWARD_TABLE) {
    cursor += row.weight;
    if (roll < cursor) {
      selected = row;
      break;
    }
  }

  const amount = randomInt(selected.min, selected.max, rng);
  const message =
    selected.type === "nothing" ? pickRandom(NOTHING_MESSAGES, rng) : "";

  return {
    type: selected.type,
    tier: selected.tier,
    amount,
    message,
  };
}

function normalizeReward(reward, rng = Math.random) {
  if (!reward || typeof reward !== "object") {
    return selectDailyChestReward({ rng });
  }

  const rawType = String(reward.type || reward.kind || "").trim();
  const type = rawType === "quest" ? "quest_bonus" : rawType;
  const amount = toSafeCount(reward.amount);
  return {
    type,
    tier: String(reward.tier || "custom"),
    amount: type === "nothing" ? 0 : amount,
    message:
      type === "nothing"
        ? String(reward.message || pickRandom(NOTHING_MESSAGES, rng))
        : "",
  };
}

function normalizeRewardList(rewards, rng = Math.random) {
  if (!Array.isArray(rewards)) return [];
  return rewards
    .filter((reward) => reward && typeof reward === "object")
    .map((reward) => normalizeReward(reward, rng));
}

function expandDailyChestRewards(reward, rng = Math.random) {
  const primary = normalizeReward(reward, rng);

  if (primary.tier === "legendary") {
    return [
      primary,
      normalizeReward(
        {
          type: "pops",
          tier: "legendary",
          amount: LEGENDARY_EXTRA_POPS_AMOUNT,
        },
        rng,
      ),
      normalizeReward(
        {
          type: "exp",
          tier: "legendary",
          amount: LEGENDARY_EXTRA_EXP_AMOUNT,
        },
        rng,
      ),
    ];
  }

  if (
    primary.tier === "rare" &&
    (primary.type === "pops" || primary.type === "exp")
  ) {
    return [
      primary,
      normalizeReward(
        {
          type: "quest_bonus",
          tier: "rare",
          amount: RARE_EXTRA_QUEST_BONUS_AMOUNT,
        },
        rng,
      ),
    ];
  }

  return [primary];
}

function normalizeTestToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_%-]+/g, " ")
    .trim();
}

function forcedDailyChestTestReward(input, rng = Math.random) {
  const normalized = normalizeTestToken(input);
  if (!normalized) return null;

  const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
  const hasAny = (...values) => values.some((value) => tokens.has(value));

  let type = "";
  if (hasAny("rien", "nothing", "vide", "air", "zero")) type = "nothing";
  if (hasAny("pops", "pop", "rubis", "ruby", "rubies")) type = "pops";
  if (hasAny("exp", "xp", "experience")) type = "exp";
  if (hasAny("chance", "quete", "quest", "bonus", "trefle", "luck")) {
    type = "quest_bonus";
  }

  let tier = "";
  if (hasAny("legendaire", "legendary", "legend", "leg")) tier = "legendary";
  if (hasAny("rare")) tier = "rare";
  if (hasAny("petit", "small")) tier = "small";
  if (hasAny("commun", "common")) tier = "common";

  if (!type && !tier) {
    throw new Error(
      "type de coffre inconnu. Exemples: pops, exp, chance, rien, rare, legendaire.",
    );
  }

  if (type === "nothing") {
    return normalizeReward(
      {
        type: "nothing",
        tier: "common",
        message: pickRandom(NOTHING_MESSAGES, rng),
      },
      rng,
    );
  }

  if (!type) {
    type = tier === "legendary" ? "quest_bonus" : "pops";
  }

  if (type === "quest_bonus") {
    tier = tier === "legendary" ? "legendary" : "small";
  } else {
    tier = tier === "rare" ? "rare" : "small";
  }

  const amount = TEST_REWARD_AMOUNTS[type]?.[tier] || 1;
  return normalizeReward({ type, tier, amount }, rng);
}

function profileDisplayName(data = {}, fallback = "Profil") {
  return (
    String(
      data.display_name ||
        data.displayName ||
        data.pseudo ||
        data.login ||
        fallback,
    ).trim() || fallback
  );
}

async function fetchProfileByDiscordId(db, discordId) {
  const safeDiscordId = String(discordId || "").trim();
  if (!safeDiscordId) return null;

  const snap = await db
    .collection("followers_all_time")
    .where("discord_id", "==", safeDiscordId)
    .limit(1)
    .get();

  if (snap.empty || !snap.docs?.length) return null;
  const doc = snap.docs[0];
  return {
    docId: doc.id,
    ref: doc.ref,
    data: doc.data() || {},
  };
}

function transactionIdForDay(dayKey) {
  return `daily_chest_${dayKey}`;
}

function dailyChestAllowedChannelIds(config = {}) {
  return Array.from(
    new Set(
      [
        config?.discord?.dailyChestChannelId || DEFAULT_DAILY_CHEST_CHANNEL_ID,
        config?.discord?.logChannelId,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function dailyChestChannelIdFromInteraction(interaction) {
  return String(interaction?.channelId || interaction?.channel?.id || "").trim();
}

function isDailyChestAllowedChannel(interaction, config = {}) {
  const channelId = dailyChestChannelIdFromInteraction(interaction);
  return dailyChestAllowedChannelIds(config).includes(channelId);
}

function dailyChestWrongChannelMessage(config = {}) {
  const allowed = dailyChestAllowedChannelIds(config)
    .map((id) => `<#${id}>`)
    .join(" ou ");
  return `\u274C Le coffre quotidien est disponible uniquement dans ${allowed}.`;
}

function rewardSummary(reward) {
  return {
    type: reward.type,
    tier: reward.tier || "",
    amount: toSafeCount(reward.amount),
    message: reward.type === "nothing" ? String(reward.message || "") : "",
  };
}

function rewardSummaries(rewards) {
  return normalizeRewardList(rewards).map((reward) => rewardSummary(reward));
}

function rewardsForDisplay(result) {
  return rewardsOrSingle(result?.rewards, result?.reward);
}

function rewardsOrSingle(rewards, reward) {
  if (Array.isArray(rewards) && rewards.length) return rewards;
  return reward ? [reward] : [];
}

function rewardTotals(rewards) {
  return normalizeRewardList(rewards).reduce(
    (totals, reward) => {
      if (reward.type === "pops") totals.pops += toSafeCount(reward.amount);
      if (reward.type === "exp") totals.exp += toSafeCount(reward.amount);
      if (reward.type === "quest_bonus") {
        totals.questBonus += toSafeCount(reward.amount);
      }
      return totals;
    },
    { pops: 0, exp: 0, questBonus: 0 },
  );
}

function rewardValueText(reward) {
  const amount = toSafeCount(reward?.amount);
  if (reward?.type === "pops") return `+${amount} ${REWARD_ICONS.pops} POPS`;
  if (reward?.type === "exp") return `+${amount} ${REWARD_ICONS.exp} EXP`;
  if (reward?.type === "quest_bonus") {
    return `+${amount}% ${REWARD_ICONS.quest_bonus}`;
  }
  return `${REWARD_ICONS.nothing} Rien`;
}

function rewardIcon(rewardOrType) {
  const type =
    typeof rewardOrType === "string" ? rewardOrType : rewardOrType?.type;
  return REWARD_ICONS[type] || REWARD_ICONS.chest;
}

function rewardTierLabel(reward) {
  if (Object.prototype.hasOwnProperty.call(TIER_LABELS, reward?.tier)) {
    return TIER_LABELS[reward.tier];
  }
  return TIER_LABELS.custom;
}

function padPanelCell(value, width) {
  const text = String(value || "");
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

function centerPanelText(value, width) {
  const text = String(value || "");
  if (text.length >= width) return text;
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function fullPanelRow(value) {
  return `|${centerPanelText(value, 30)}|`;
}

function splitPanelRow(label, value) {
  return `| ${padPanelCell(label, 12)} | ${padPanelCell(value, 13)} |`;
}

function rewardVisualTheme(reward) {
  const tier = String(reward?.tier || "custom");
  const base = {
    title: rewardPanelTitle(reward),
    color: "#9CA3AF",
    border: "-",
    divider: "-",
  };

  if (tier === "legendary") {
    return {
      title: "\uD83D\uDC51 COFFRE LEGENDAIRE \uD83D\uDC51",
      color: "#FACC15",
      border: "#",
      divider: "#",
    };
  }

  if (tier === "rare") {
    return {
      title: "\uD83D\uDC8E COFFRE RARE \uD83D\uDC8E",
      color: "#A78BFA",
      border: "*",
      divider: "*",
    };
  }

  if (tier === "small") {
    return {
      ...base,
      color: rewardTypeColor(reward),
      border: "=",
      divider: "=",
    };
  }

  return base;
}

function rewardPanelTitle(reward) {
  const tier = rewardTierLabel(reward);
  return tier ? `COFFRE ${tier.toUpperCase()}` : "COFFRE";
}

function panelBorder(char) {
  return `+${String(char || "-").repeat(30)}+`;
}

function panelDivider(char) {
  const fill = String(char || "-");
  return `+${fill.repeat(14)}+${fill.repeat(15)}+`;
}

function buildDailyChestResultPanel(reward, rewards = null) {
  const theme = rewardVisualTheme(reward);
  const displayRewards =
    Array.isArray(rewards) && rewards.length ? rewards : [reward];
  const lines = [
    "```text",
    panelBorder(theme.border),
    fullPanelRow(theme.title),
    panelDivider(theme.divider),
    ...displayRewards.map((entry) =>
      splitPanelRow("GAIN", rewardValueText(entry)),
    ),
    panelBorder(theme.border),
    "```",
  ];

  return lines.join("\n");
}

function applyRewardPatch({
  data,
  reward,
  rewards,
  dayKey,
  monthKey,
  now,
  nowMs,
  communityLevelConfig,
}) {
  const appliedRewards =
    Array.isArray(rewards) && rewards.length
      ? normalizeRewardList(rewards)
      : expandDailyChestRewards(reward);
  const primaryReward = appliedRewards[0] || normalizeReward(reward);
  const rewardListSummary = rewardSummaries(appliedRewards);
  const totals = rewardTotals(appliedRewards);
  const patch = {};
  const result = {
    reward: rewardSummary(primaryReward),
    rewards: rewardListSummary,
    transaction: null,
    participantPatch: null,
    levelResult: null,
    questBonus: null,
  };

  if (totals.pops > 0) {
    const amount = totals.pops;
    const wallet = normalizePopsWallet(data);
    const nextWallet = {
      balance: wallet.balance + amount,
      lifetimeEarned: wallet.lifetimeEarned + amount,
      schemaVersion: POPS_SCHEMA_VERSION,
    };

    patch["pops.balance"] = nextWallet.balance;
    patch["pops.lifetimeEarned"] = nextWallet.lifetimeEarned;
    patch["pops.updatedAt"] = now;
    patch["pops.schemaVersion"] = POPS_SCHEMA_VERSION;

    result.transaction = {
      type: DAILY_CHEST_TRANSACTION_TYPE,
      source: DAILY_CHEST_TRANSACTION_SOURCE,
      amount,
      dayKey,
      monthKey,
      reward: result.reward,
      rewards: rewardListSummary,
      balanceBefore: wallet.balance,
      balanceAfter: nextWallet.balance,
      createdAt: now,
      createdAtMs: nowMs,
      schemaVersion: POPS_SCHEMA_VERSION,
      serverAuthoritative: true,
    };
  }

  if (totals.exp > 0) {
    const levelResult = applyFlatCommunityLevelXp({
      data,
      awardXp: totals.exp,
      nowMs,
      rawConfig: communityLevelConfig,
      sourceLabel: DAILY_CHEST_TRANSACTION_SOURCE,
    });

    if (levelResult.awarded) {
      patch.communityLevel = levelResult.communityLevel;
      Object.assign(patch, levelResult.legacyFields || {});
      result.levelResult = levelResult;
    }
  }

  if (totals.questBonus > 0) {
    const amount = totals.questBonus;
    const before = clampPct(data?.live_presence?.[monthKey]?.progress_pct || 0);
    const after = clampPct(before + amount);
    patch[`live_presence.${monthKey}.progress_pct`] = after;
    result.questBonus = { before, after, amount };
    result.participantPatch = {
      progress_pct: after,
      quest_progress_pct: after,
      live_presence: {
        [monthKey]: {
          progress_pct: after,
        },
      },
    };
  }

  patch.dailyChest = {
    ...(data.dailyChest && typeof data.dailyChest === "object"
      ? data.dailyChest
      : {}),
    lastOpenedDay: dayKey,
    lastOpenedAt: now,
    lastOpenedAtMs: nowMs,
    lastReward: result.reward,
    lastRewards: rewardListSummary,
    totalOpenings: toSafeCount(data?.dailyChest?.totalOpenings) + 1,
    schemaVersion: DAILY_CHEST_SCHEMA_VERSION,
  };

  return { patch, result };
}

async function resolveCommunityLevelConfig(config = {}, getCommunityLevelConfig) {
  if (typeof getCommunityLevelConfig !== "function") {
    return config.communityLevel || {};
  }

  try {
    return await getCommunityLevelConfig();
  } catch (e) {
    console.warn("[daily-chest] community config fallback:", e?.message || e);
    return config.communityLevel || {};
  }
}

async function openDailyChest(
  db,
  {
    discordId,
    config = {},
    getCommunityLevelConfig,
    now = new Date(),
    reward,
    rng = Math.random,
  } = {},
) {
  if (!db) throw new Error("openDailyChest: missing db dependency");

  const profile = await fetchProfileByDiscordId(db, discordId);
  const timeZone = config.timezone || DEFAULT_TIMEZONE;
  const dayKey = dayKeyInTimezone(now, timeZone);
  const monthKey = monthKeyInTimezone(now, timeZone);
  if (!profile) {
    return { status: "profile_missing", dayKey, monthKey };
  }

  const plannedReward = normalizeReward(reward, rng);
  const plannedRewards = expandDailyChestRewards(plannedReward, rng);
  const communityLevelConfig =
    plannedRewards.some((entry) => entry.type === "exp")
      ? await resolveCommunityLevelConfig(config, getCommunityLevelConfig)
      : config.communityLevel || {};
  const claimRef = profile.ref.collection("daily_chest_claims").doc(dayKey);
  const participantRef = db.collection("participants").doc(profile.docId);
  const transactionRef = profile.ref
    .collection("pops_transactions")
    .doc(transactionIdForDay(dayKey));

  let txResult = null;

  await db.runTransaction(async (tx) => {
    const profileSnap = await tx.get(profile.ref);
    if (!profileSnap.exists) {
      txResult = { status: "profile_missing", dayKey, monthKey };
      return;
    }

    const claimSnap = await tx.get(claimRef);
    if (claimSnap.exists) {
      const claim = claimSnap.data() || {};
      txResult = {
        status: "already_opened",
        dayKey,
        monthKey,
        profile: {
          docId: profile.docId,
          displayName: profileDisplayName(profileSnap.data(), profile.docId),
        },
        claim,
        reward: claim.reward || null,
        rewards: rewardsOrSingle(claim.rewards, claim.reward),
      };
      return;
    }

    const data = profileSnap.data() || {};
    const rewardPatch = applyRewardPatch({
      data,
      reward: plannedReward,
      rewards: plannedRewards,
      dayKey,
      monthKey,
      now,
      nowMs: now.getTime(),
      communityLevelConfig,
    });
    const claimPayload = {
      dayKey,
      monthKey,
      discordId: String(discordId || ""),
      login: profile.docId,
      displayName: profileDisplayName(data, profile.docId),
      reward: rewardPatch.result.reward,
      rewards: rewardPatch.result.rewards,
      createdAt: now,
      createdAtMs: now.getTime(),
      schemaVersion: DAILY_CHEST_SCHEMA_VERSION,
      serverAuthoritative: true,
    };

    let participantSnap = null;
    if (rewardPatch.result.participantPatch) {
      participantSnap = await tx.get(participantRef);
    }

    tx.update(profile.ref, rewardPatch.patch);
    tx.set(claimRef, claimPayload);

    if (rewardPatch.result.transaction) {
      tx.set(transactionRef, rewardPatch.result.transaction);
    }

    if (participantSnap?.exists && rewardPatch.result.participantPatch) {
      tx.set(participantRef, rewardPatch.result.participantPatch, {
        merge: true,
      });
    }

    txResult = {
      status: "opened",
      dayKey,
      monthKey,
      profile: {
        docId: profile.docId,
        displayName: claimPayload.displayName,
      },
      claim: claimPayload,
      reward: rewardPatch.result.reward,
      rewards: rewardPatch.result.rewards,
      rewardResult: rewardPatch.result,
      participantSynced: !!participantSnap?.exists,
    };
  });

  return txResult || { status: "error", dayKey, monthKey };
}

function buildSlotLine(rng = Math.random, middleIcon = null) {
  const left = pickRandom(SLOT_SYMBOLS, rng);
  const middle = middleIcon || pickRandom(SLOT_SYMBOLS, rng);
  const right = pickRandom(SLOT_SYMBOLS, rng);
  return `|  ${left}  |  ${middle}  |  ${right}  |`;
}

function buildSlotPanel(lines) {
  return [
    "```text",
    "+----------------------+",
    ...lines,
    "+----------------------+",
    "```",
  ].join("\n");
}

function buildRandomSlotPanel(rng = Math.random, middleIcon = null) {
  return buildSlotPanel([
    buildSlotLine(rng),
    buildSlotLine(rng, middleIcon),
    buildSlotLine(rng),
  ]);
}

function buildDailyChestAnimationFrames({
  rng = Math.random,
  reward = null,
} = {}) {
  const lockedIcon = reward ? rewardIcon(reward) : pickRandom(SLOT_SYMBOLS, rng);
  return [
    `${REWARD_ICONS.slot} **Coffre quotidien**\n` +
      buildRandomSlotPanel(rng) +
      `\n${REWARD_ICONS.lock} Le coffre se charge...`,
    `${REWARD_ICONS.slot} **Coffre quotidien**\n` +
      buildRandomSlotPanel(rng) +
      `\n${REWARD_ICONS.spark} Les rouleaux accelerent.`,
    `${REWARD_ICONS.slot} **Coffre quotidien**\n` +
      buildRandomSlotPanel(rng, lockedIcon) +
      `\n${REWARD_ICONS.lock} Un symbole accroche...`,
    `${REWARD_ICONS.slot} **Coffre quotidien**\n` +
      buildSlotPanel([
        buildSlotLine(rng, lockedIcon),
        buildSlotLine(rng, lockedIcon),
        buildSlotLine(rng, lockedIcon),
      ]) +
      `\n${REWARD_ICONS.unlock} Le coffre s'ouvre.`,
    `${REWARD_ICONS.spark} **Resultat du coffre...**\n` +
      buildSlotPanel([
        `|      |  ${lockedIcon}  |      |`,
        `|  ${lockedIcon}  |  ${lockedIcon}  |  ${lockedIcon}  |`,
        `|      |  ${lockedIcon}  |      |`,
      ]),
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playDailyChestAnimation(
  interaction,
  {
    rng = Math.random,
    delayMs = DEFAULT_ANIMATION_DELAY_MS,
    reward = null,
  } = {},
) {
  const frames = buildDailyChestAnimationFrames({ rng, reward });
  for (const frame of frames) {
    await interaction.editReply({ content: frame, embeds: [] });
    if (delayMs > 0) await sleep(delayMs);
  }
}

function rewardTypeColor(reward) {
  if (reward?.type === "pops") return "#F6C85F";
  if (reward?.type === "exp") return "#7DD3FC";
  if (reward?.type === "quest_bonus") return "#6EE7B7";
  return "#9CA3AF";
}

function rewardColor(reward) {
  return rewardVisualTheme(reward).color;
}

async function replyDailyChestWrongChannel(interaction, config = {}) {
  const payload = {
    content: dailyChestWrongChannelMessage(config),
    ephemeral: true,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: payload.content, embeds: [] });
    return;
  }
  await interaction.reply(payload);
}

function buildDailyChestEmbed(result, user) {
  const reward = result?.reward || {};
  const lines = [buildDailyChestResultPanel(reward, rewardsForDisplay(result))];

  if (reward.type === "nothing" && reward.message) {
    lines.push(`${reward.message} ${REWARD_ICONS.laugh}`);
  }

  const embed = new EmbedBuilder()
    .setColor(rewardColor(reward))
    .setTitle(`${REWARD_ICONS.chest} Coffre ouvert !`)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Reset quotidien: ${result?.dayKey || "demain"}` });

  if (result?.testMode) {
    embed
      .setTitle("\uD83E\uDDEA Test coffre quotidien")
      .setFooter({ text: "Apercu test - aucun gain applique" });
  }

  return embed;
}

function alreadyOpenedMessage(result) {
  const displayName = result?.profile?.displayName || "profil";
  return (
    "\u23F3 **Coffre deja ouvert aujourd'hui.**\n" +
    `${displayName}, reviens apres le reset quotidien.`
  );
}

async function handleDailyChestInteraction(
  interaction,
  db,
  config = {},
  { getCommunityLevelConfig, rng = Math.random, animationDelayMs } = {},
) {
  try {
    if (!isDailyChestAllowedChannel(interaction, config)) {
      await replyDailyChestWrongChannel(interaction, config);
      return {
        status: "wrong_channel",
        allowedChannelIds: dailyChestAllowedChannelIds(config),
      };
    }

    await interaction.deferReply({ ephemeral: false });
    const result = await openDailyChest(db, {
      discordId: interaction.user?.id,
      config,
      getCommunityLevelConfig,
      rng,
    });

    if (result.status === "profile_missing") {
      await interaction.editReply(
        "\u274C Profil introuvable dans `followers_all_time`. " +
          "Il faut un profil Twitch/Discord lie pour ouvrir le coffre.",
      );
      return result;
    }

    if (result.status === "already_opened") {
      await interaction.editReply(alreadyOpenedMessage(result));
      return result;
    }

    if (result.status !== "opened") {
      await interaction.editReply(
        "\u274C Impossible d'ouvrir le coffre pour le moment.",
      );
      return result;
    }

    try {
      await playDailyChestAnimation(interaction, {
        rng,
        reward: result.reward,
        delayMs:
          animationDelayMs == null
            ? DEFAULT_ANIMATION_DELAY_MS
            : animationDelayMs,
      });
    } catch (e) {
      console.warn("[daily-chest] animation failed:", e?.message || e);
    }

    await interaction.editReply({
      content: "",
      embeds: [buildDailyChestEmbed(result, interaction.user)],
    });
    return result;
  } catch (err) {
    console.error("[daily-chest] interaction failed:", err?.message || err);
    const content =
      "\u274C Une erreur est survenue pendant l'ouverture du coffre.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: false }).catch(() => {});
    }
    return { status: "error", error: err };
  }
}

async function sendDailyChestTestMessage(
  message,
  {
    config = {},
    rng = Math.random,
    animationDelayMs = 250,
    now = new Date(),
    forceReward,
  } = {},
) {
  const timeZone = config.timezone || DEFAULT_TIMEZONE;
  const reward =
    forcedDailyChestTestReward(forceReward, rng) ||
    selectDailyChestReward({ rng });
  const rewards = expandDailyChestRewards(reward, rng);
  const totals = rewardTotals(rewards);
  const monthKey = monthKeyInTimezone(now, timeZone);
  const result = {
    status: "opened",
    testMode: true,
    dayKey: dayKeyInTimezone(now, timeZone),
    monthKey,
    profile: {
      docId: message.author?.id || "test",
      displayName:
        message.member?.displayName ||
        message.author?.globalName ||
        message.author?.username ||
        "Test",
    },
    reward: rewardSummary(reward),
    rewards: rewardSummaries(rewards),
    rewardResult: {
      reward: rewardSummary(reward),
      rewards: rewardSummaries(rewards),
      questBonus:
        rewards.some((entry) => entry.type === "quest_bonus")
          ? {
              before: 42,
              after: clampPct(42 + totals.questBonus),
              amount: totals.questBonus,
            }
          : null,
    },
  };

  const frames = buildDailyChestAnimationFrames({
    rng,
    reward,
  });
  const sent = await message.channel.send(frames[0]);
  for (const frame of frames.slice(1)) {
    if (animationDelayMs > 0) await sleep(animationDelayMs);
    await sent.edit({ content: frame, embeds: [] });
  }
  if (animationDelayMs > 0) await sleep(animationDelayMs);

  await sent.edit({
    content: "\uD83E\uDDEA Test du coffre quotidien - aucun gain applique.",
    embeds: [buildDailyChestEmbed(result, message.author)],
  });

  return result;
}

module.exports = {
  DAILY_CHEST_SCHEMA_VERSION,
  DAILY_CHEST_TRANSACTION_TYPE,
  DAILY_CHEST_TRANSACTION_SOURCE,
  REWARD_TABLE,
  dayKeyInTimezone,
  monthKeyInTimezone,
  normalizePopsWallet,
  selectDailyChestReward,
  forcedDailyChestTestReward,
  openDailyChest,
  buildDailyChestEmbed,
  buildDailyChestAnimationFrames,
  handleDailyChestInteraction,
  sendDailyChestTestMessage,
};
