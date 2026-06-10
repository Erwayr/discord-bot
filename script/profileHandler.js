"use strict";

const { EmbedBuilder } = require("discord.js");
const { normalizeCommunityLevel } = require("./communityLevel");

const NUMBER_FMT = new Intl.NumberFormat("fr-FR");

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(value) {
  return NUMBER_FMT.format(toNum(value));
}

function formatPct(value) {
  const n = Math.max(0, Math.min(100, toNum(value)));
  return `${Math.round(n)}%`;
}

function formatProgressBar(value, size = 10) {
  const pct = Math.max(0, Math.min(100, toNum(value)));
  const filled = Math.round((pct / 100) * size);
  return "▰".repeat(filled) + "▱".repeat(Math.max(0, size - filled));
}

function formatMonthLabel(monthKey) {
  const [year, month] = String(monthKey || "").split("-");
  const date = new Date(Number(year), Number(month || 1) - 1, 1);
  if (Number.isNaN(date.getTime())) return monthKey || "ce mois";
  const label = new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric",
  }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function valueOrDash(value) {
  if (value == null || value === "") return "—";
  return String(value);
}

function normalizeLogin(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function currentMonthKey(timeZone = "Europe/Warsaw", now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);

  const year = parts.find((p) => p.type === "year")?.value || "0000";
  const month = parts.find((p) => p.type === "month")?.value || "00";
  return `${year}-${month}`;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return toNum(value.toMillis());
  if (typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  }
  if (typeof value === "number") {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof value === "object" && value.seconds != null) {
    const sec = toNum(value.seconds);
    const nano = toNum(value.nanoseconds || 0);
    return Math.floor(sec * 1000 + nano / 1e6);
  }
  return 0;
}

function formatDate(value) {
  const ms = toMillis(value);
  if (!ms) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
}

function cardsArray(data) {
  if (Array.isArray(data?.cards_generated)) return data.cards_generated;
  if (data?.cards_generated && typeof data.cards_generated === "object") {
    return Object.values(data.cards_generated);
  }
  return [];
}

function resolveQuestProgress(data, monthKey) {
  const monthNode = data?.live_presence?.[monthKey] || {};
  const candidates = [
    monthNode?.progress_pct,
    monthNode?.quest_progress_pct,
    data?.quest_progress_pct,
    data?.progress_pct,
  ];

  for (const value of candidates) {
    if (value == null) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
  }

  return 0;
}

function topGameFromHistory(gamesHistory) {
  if (!Array.isArray(gamesHistory) || !gamesHistory.length) return null;
  let best = null;
  for (const entry of gamesHistory) {
    const name = String(entry?.name || "").trim();
    const count = Math.max(0, Math.floor(toNum(entry?.count || 0)));
    if (!name) continue;
    if (!best || count > best.count) best = { name, count };
  }
  return best;
}

function displayNameFromData(data, fallbackUser) {
  return (
    data?.display_name ||
    data?.displayName ||
    data?.pseudo ||
    fallbackUser?.globalName ||
    fallbackUser?.username ||
    "Profil"
  );
}

function avatarFromData(data, fallbackUser) {
  return (
    data?.avatar ||
    data?.profile_image_url ||
    data?.avatar_url ||
    fallbackUser?.displayAvatarURL?.({ size: 256 }) ||
    null
  );
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

async function fetchProfileByDiscordId(db, discordId) {
  const snap = await db
    .collection("followers_all_time")
    .where("discord_id", "==", discordId)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return {
    docId: snap.docs[0].id,
    ref: snap.docs[0].ref,
    data: snap.docs[0].data() || {},
  };
}

function rewardSortValue(reward) {
  return Math.max(
    toMillis(reward?.createdAt),
    toMillis(reward?.announce?.requestedAt),
    toMillis(reward?.announce?.sentAt),
    toMillis(reward?.sentAt),
    toMillis(reward?.date),
    toMillis(reward?.timestamp),
  );
}

async function fetchLatestReward(db, profile) {
  const data = profile?.data || {};
  const keys = new Set(
    [
      profile?.docId,
      data?.pseudo,
      data?.login,
      data?.display_name,
      data?.displayName,
    ]
      .map(normalizeLogin)
      .filter(Boolean),
  );
  if (!keys.size) return null;

  const snap = await db.collection("gagnants").get();
  const matches = [];
  snap.forEach((doc) => {
    const reward = doc.data() || {};
    if (!keys.has(normalizeLogin(reward?.pseudo))) return;
    matches.push({ id: doc.id, ...reward, __sort: rewardSortValue(reward) });
  });

  matches.sort((a, b) => b.__sort - a.__sort || String(b.id).localeCompare(a.id));
  return matches[0] || null;
}

function formatReward(reward) {
  if (!reward) return "—";
  const prize = valueOrDash(reward.prix);
  const meta = [reward.mois, reward.typeConcours].filter(Boolean).join(" • ");
  const date = formatDate(
    reward.createdAt ||
      reward?.announce?.requestedAt ||
      reward?.announce?.sentAt ||
      reward.sentAt,
  );
  return [prize, meta || null, date !== "—" ? date : null]
    .filter(Boolean)
    .join("\n");
}

function subLabel(data) {
  const months = Math.max(0, Math.floor(toNum(data?.subMonths || 0)));
  if (!data?.isStillSub && months <= 0) return "—";
  const status = data?.isStillSub ? "Actif" : "Ancien";
  const tier = data?.subTier ? ` • ${data.subTier}` : "";
  const duration = months > 0 ? `${months} mois` : "Durée non connue";
  const last = data?.lastSubAt ? `\nDernier sub: ${formatDate(data.lastSubAt)}` : "";
  return `**${status}**${tier}\n${duration}${last}`;
}

async function buildProfileEmbed({ db, config, targetUser, requestedBy }) {
  const profile = await fetchProfileByDiscordId(db, targetUser.id);
  if (!profile) return null;

  const data = profile.data;
  const totalCardsSnap = await db.collection("cards_collections").get();
  const latestReward = await fetchLatestReward(db, profile);

  const monthKey = currentMonthKey(config?.timezone || "Europe/Warsaw");
  const questProgress = resolveQuestProgress(data, monthKey);
  const topGame = topGameFromHistory(data?.games_history);
  const ownedCards = cardsArray(data).length;
  const displayName = displayNameFromData(data, targetUser);
  const avatar = avatarFromData(data, targetUser);
  const communityLevel = normalizeCommunityLevel(data);
  const rank = Number(communityLevel.rank || 0);
  const level = Number(communityLevel.level || 0);
  const rankName = data?.customRankName || communityLevel.rankName || "—";
  const totalWins = Math.max(
    toNum(data?.totalWinLotterie || 0),
    data?.isAlreadyWinLottery ? 1 : 0,
  );

  const embed = new EmbedBuilder()
    .setColor("#F6C85F")
    .setTitle("🌟 Profil communautaire")
    .setDescription(
      [
        `**${displayName}**`,
        `${rank > 0 ? `🏆 **#${rank}** au classement` : "🏆 Classement **—**"}`,
        rankName && rankName !== "—" ? `✨ ${rankName}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .addFields(
      {
        name: "🏆 Rang",
        value:
          `Niveau **${formatNumber(level)}**\n` +
          `EXP **${formatNumber(communityLevel.xpTotal || 0)}**`,
        inline: true,
      },
      {
        name: "🃏 Collection",
        value:
          `**${formatNumber(ownedCards)} / ${formatNumber(
            totalCardsSnap.size,
          )}** cartes\n` + `**${formatNumber(totalWins)}** victoires`,
        inline: true,
      },
      {
        name: `🎯 Quêtes • ${formatMonthLabel(monthKey)}`,
        value:
          `${formatProgressBar(questProgress)} **${formatPct(questProgress)}**`,
        inline: false,
      },
      {
        name: "💬 Discord",
        value:
          `**${formatNumber(data?.discord_count_message || 0)}** messages\n` +
          `Jeu favori: **${
            topGame
              ? `${topGame.name} (${formatNumber(topGame.count)})`
              : "—"
          }**`,
        inline: true,
      },
      {
        name: "⭐ Abonnement",
        value: subLabel(data),
        inline: true,
      },
      {
        name: "🎁 Dernière récompense",
        value: formatReward(latestReward),
        inline: false,
      },
    )
    .setFooter({
      text: `Demandé par ${requestedBy?.username || "Discord"}`,
    });

  if (isHttpUrl(avatar)) embed.setThumbnail(avatar);

  return embed;
}

async function handleProfileMessage(message, db, config = {}) {
  try {
    const embed = await buildProfileEmbed({
      db,
      config,
      targetUser: message.author,
      requestedBy: message.author,
    });
    if (!embed) {
      await message.reply("❌ Profil introuvable dans `followers_all_time`.");
      return;
    }
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error("Erreur dans profileHandler:", err);
    await message.reply(
      "❌ Une erreur est survenue lors de la récupération du profil.",
    );
  }
}

async function handleProfileInteraction(interaction, db, config = {}) {
  const targetUser =
    interaction.options.getUser("membre", false) || interaction.user;

  try {
    await interaction.deferReply({ ephemeral: false });
    const embed = await buildProfileEmbed({
      db,
      config,
      targetUser,
      requestedBy: interaction.user,
    });
    if (!embed) {
      await interaction.editReply(
        `❌ Profil introuvable pour ${targetUser.username} dans \`followers_all_time\`.`,
      );
      return;
    }
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("Erreur dans profileHandler interaction:", err);
    const content =
      "❌ Une erreur est survenue lors de la récupération du profil.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => {});
    } else {
      await interaction.reply({ content, ephemeral: false }).catch(() => {});
    }
  }
}

module.exports = {
  buildProfileEmbed,
  handleProfileMessage,
  handleProfileInteraction,
};
