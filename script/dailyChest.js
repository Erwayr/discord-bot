"use strict";

const { EmbedBuilder } = require("discord.js");
const { applyFlatCommunityLevelXp } = require("./communityLevel");

const DAILY_CHEST_SCHEMA_VERSION = 1;
const POPS_SCHEMA_VERSION = 1;
const DAILY_CHEST_TRANSACTION_TYPE = "daily_chest";
const DAILY_CHEST_TRANSACTION_SOURCE = "discord_daily_chest";
const DEFAULT_TIMEZONE = "Europe/Warsaw";
const DEFAULT_ANIMATION_DELAY_MS = 650;

const SLOT_SYMBOLS = Object.freeze([
  "\uD83C\uDF81",
  "\uD83D\uDC8E",
  "\u2728",
  "\uD83C\uDF40",
  "\uD83D\uDCB0",
  "\uD83D\uDD25",
]);

const NOTHING_MESSAGES = Object.freeze([
  "Le coffre etait rempli d'air premium. Tres rare, mais invendable.",
  "Tu trouves un coupon -100% de gain. Il a expire hier.",
  "Le coffre s'ouvre... puis fait semblant de ne pas te connaitre.",
  "Un bruit epique, une lumiere divine, et absolument rien.",
  "Inventaire plein de vibes. Solde: zero.",
]);

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

function rewardSummary(reward) {
  return {
    type: reward.type,
    tier: reward.tier || "",
    amount: toSafeCount(reward.amount),
    message: reward.type === "nothing" ? String(reward.message || "") : "",
  };
}

function rewardValueText(reward) {
  const amount = toSafeCount(reward?.amount);
  if (reward?.type === "pops") return `+${amount} POPS`;
  if (reward?.type === "exp") return `+${amount} EXP`;
  if (reward?.type === "quest_bonus") return `+${amount}% quetes mensuelles`;
  return "Rien";
}

function applyRewardPatch({
  data,
  reward,
  dayKey,
  monthKey,
  now,
  nowMs,
  communityLevelConfig,
}) {
  const patch = {};
  const result = {
    reward: rewardSummary(reward),
    transaction: null,
    participantPatch: null,
    levelResult: null,
    questBonus: null,
  };

  if (reward.type === "pops") {
    const amount = toSafeCount(reward.amount);
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
      reward: rewardSummary(reward),
      balanceBefore: wallet.balance,
      balanceAfter: nextWallet.balance,
      createdAt: now,
      createdAtMs: nowMs,
      schemaVersion: POPS_SCHEMA_VERSION,
      serverAuthoritative: true,
    };
  }

  if (reward.type === "exp") {
    const levelResult = applyFlatCommunityLevelXp({
      data,
      awardXp: reward.amount,
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

  if (reward.type === "quest_bonus") {
    const amount = toSafeCount(reward.amount);
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
    lastReward: rewardSummary(reward),
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
  const communityLevelConfig =
    plannedReward.type === "exp"
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
      };
      return;
    }

    const data = profileSnap.data() || {};
    const rewardPatch = applyRewardPatch({
      data,
      reward: plannedReward,
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
      rewardResult: rewardPatch.result,
      participantSynced: !!participantSnap?.exists,
    };
  });

  return txResult || { status: "error", dayKey, monthKey };
}

function buildSlotLine(rng = Math.random) {
  return `[ ${pickRandom(SLOT_SYMBOLS, rng)} | ${pickRandom(
    SLOT_SYMBOLS,
    rng,
  )} | ${pickRandom(SLOT_SYMBOLS, rng)} ]`;
}

function buildDailyChestAnimationFrames({ rng = Math.random } = {}) {
  return [
    "\uD83C\uDFB0 **Coffre quotidien**\n```" +
      `\n${buildSlotLine(rng)}\n` +
      "```\nLe coffre se reveille...",
    "\uD83C\uDFB0 **Coffre quotidien**\n```" +
      `\n${buildSlotLine(rng)}\n${buildSlotLine(rng)}\n` +
      "```\nLes rouleaux chauffent.",
    "\uD83C\uDFB0 **Coffre quotidien**\n```" +
      `\n${buildSlotLine(rng)}\n${buildSlotLine(rng)}\n${buildSlotLine(rng)}\n` +
      "```\nPresque...",
    "\uD83C\uDFB0 **Coffre quotidien**\n```" +
      `\n${buildSlotLine(rng)}\n${buildSlotLine(rng)}\n${buildSlotLine(rng)}\n` +
      "```\nLe verrou saute.",
    "\u2728 **Resultat du coffre...**",
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playDailyChestAnimation(
  interaction,
  { rng = Math.random, delayMs = DEFAULT_ANIMATION_DELAY_MS } = {},
) {
  const frames = buildDailyChestAnimationFrames({ rng });
  for (const frame of frames) {
    await interaction.editReply({ content: frame, embeds: [] });
    if (delayMs > 0) await sleep(delayMs);
  }
}

function rewardColor(reward) {
  if (reward?.type === "pops") return "#F6C85F";
  if (reward?.type === "exp") return "#7DD3FC";
  if (reward?.type === "quest_bonus") return "#6EE7B7";
  return "#9CA3AF";
}

function buildDailyChestEmbed(result, user) {
  const reward = result?.reward || {};
  const displayName =
    result?.profile?.displayName || user?.globalName || user?.username || "Membre";
  const value = rewardValueText(reward);
  const lines = [
    `**${displayName}**`,
    "",
    "Tu gagnes :",
    `**${value}**`,
  ];

  if (reward.type === "nothing" && reward.message) {
    lines.push("", reward.message);
  }

  if (result?.rewardResult?.levelResult?.leveledUp) {
    lines.push(
      "",
      `Niveau atteint : **${result.rewardResult.levelResult.level}**`,
    );
  }

  if (result?.rewardResult?.questBonus) {
    lines.push(
      "",
      `Progression tirage : **${Math.round(
        result.rewardResult.questBonus.before,
      )}% -> ${Math.round(result.rewardResult.questBonus.after)}%**`,
    );
  }

  const embed = new EmbedBuilder()
    .setColor(rewardColor(reward))
    .setTitle("\uD83C\uDF81 Coffre ouvert !")
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
  { config = {}, rng = Math.random, animationDelayMs = 250, now = new Date() } = {},
) {
  const timeZone = config.timezone || DEFAULT_TIMEZONE;
  const reward = selectDailyChestReward({ rng });
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
    rewardResult: {
      reward: rewardSummary(reward),
      questBonus:
        reward.type === "quest_bonus"
          ? {
              before: 42,
              after: clampPct(42 + reward.amount),
              amount: reward.amount,
            }
          : null,
    },
  };

  const frames = buildDailyChestAnimationFrames({ rng });
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
  openDailyChest,
  buildDailyChestEmbed,
  buildDailyChestAnimationFrames,
  handleDailyChestInteraction,
  sendDailyChestTestMessage,
};
