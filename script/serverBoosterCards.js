"use strict";

const { commitBatchWithRetry } = require("../helper/firestoreRetry");

const SERVER_BOOSTER_CARD_ID = "discord_server_booster";
const SERVER_BOOSTER_GRANTED_FIELD = "isAlreadyWinDiscordServerBooster";
const SERVER_BOOSTER_CARD_SOURCE = "discord_server_booster";

const SERVER_BOOSTER_CARD_TEMPLATE = Object.freeze({
  id: SERVER_BOOSTER_CARD_ID,
  title: "Booster Discord",
  section: "Discord",
  subMenu: "Booster",
  position: 5,
  imgUrl: "images/cards-collection/discord_server_booster.png",
  isFullImage: true,
  missingDescription:
    "Booste le serveur Discord Erwayr pour débloquer cette carte.",
});

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function asCardsArray(cardsLike) {
  if (Array.isArray(cardsLike)) return cardsLike;
  if (cardsLike && typeof cardsLike === "object") return Object.values(cardsLike);
  return [];
}

function hasNativeServerBoosterRole(member) {
  if (!member?.roles) return false;
  if (member.roles.premiumSubscriberRole) return true;
  if (typeof member.roles.cache?.some === "function") {
    return member.roles.cache.some((role) => role?.tags?.premiumSubscriberRole);
  }
  if (typeof member.roles.cache?.values === "function") {
    return [...member.roles.cache.values()].some(
      (role) => role?.tags?.premiumSubscriberRole,
    );
  }
  return false;
}

function isServerBoosterMember(member) {
  if (!member || member.user?.bot) return false;
  return Boolean(
    member.premiumSinceTimestamp ||
      member.premiumSince ||
      hasNativeServerBoosterRole(member),
  );
}

function getServerBoosterStartedAt(member) {
  const timestamp = Number(member?.premiumSinceTimestamp || 0);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return new Date(timestamp).toISOString();
  }

  const premiumSince = member?.premiumSince;
  if (premiumSince instanceof Date && !Number.isNaN(premiumSince.getTime())) {
    return premiumSince.toISOString();
  }

  return null;
}

function hasServerBoosterCard(userData = {}) {
  return asCardsArray(userData.cards_generated).some(
    (card) => norm(card?.id) === SERVER_BOOSTER_CARD_ID,
  );
}

function buildServerBoosterCard(template = {}, userData = {}, member = null) {
  const now = new Date().toISOString();
  const boostedAt = getServerBoosterStartedAt(member);
  const pseudo = String(
    userData?.pseudo || userData?.display_name || userData?.login || "",
  ).trim();

  const card = {
    ...SERVER_BOOSTER_CARD_TEMPLATE,
    ...template,
    id: SERVER_BOOSTER_CARD_ID,
    source: SERVER_BOOSTER_CARD_SOURCE,
    sentAt: now,
    autoGrantedAt: now,
    isAlreadyView: false,
  };

  if (pseudo) card.pseudo = pseudo;
  if (boostedAt) card.discordBoostedAt = boostedAt;

  return card;
}

async function ensureServerBoosterCardTemplate(db) {
  const ref = db.collection("cards_collections").doc(SERVER_BOOSTER_CARD_ID);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(SERVER_BOOSTER_CARD_TEMPLATE);
    console.log(`✅ Carte "${SERVER_BOOSTER_CARD_ID}" créée dans cards_collections.`);
    return { ...SERVER_BOOSTER_CARD_TEMPLATE };
  }
  return {
    ...SERVER_BOOSTER_CARD_TEMPLATE,
    ...(snap.data() || {}),
    id: SERVER_BOOSTER_CARD_ID,
  };
}

function buildServerBoosterUpdatePayload({
  userData = {},
  cardTemplate = {},
  member = null,
  fieldValue,
}) {
  const hasCard = hasServerBoosterCard(userData);
  if (hasCard && userData?.[SERVER_BOOSTER_GRANTED_FIELD] === true) {
    return null;
  }

  const payload = {
    [SERVER_BOOSTER_GRANTED_FIELD]: true,
  };

  if (!hasCard) {
    payload.cards_generated = fieldValue.arrayUnion(
      buildServerBoosterCard(cardTemplate, userData, member),
    );
  }

  return payload;
}

async function grantServerBoosterCardsByDiscordIds({
  db,
  admin,
  discordIds = [],
  cardTemplate = {},
  memberById = new Map(),
  batchSize = 10,
  label = "assign-server-booster-cards",
  onGrantedDoc = null,
} = {}) {
  const ids = [
    ...new Set(
      discordIds.map((id) => String(id || "").trim()).filter(Boolean),
    ),
  ];
  if (!ids.length) return { scanned: 0, matched: 0, updated: 0, missing: 0 };

  let matched = 0;
  let updated = 0;
  let missing = 0;
  const size = Math.max(1, Number(batchSize) || 10);

  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    const snap = await db
      .collection("followers_all_time")
      .where("discord_id", "in", chunk)
      .get();

    if (snap.empty) {
      missing += chunk.length;
      console.log(
        `ℹ️ [${label}] aucun profil lié pour ${chunk.length} booster(s) Discord.`,
      );
      continue;
    }

    const foundIds = new Set();
    const batch = db.batch();
    const grantedDocs = [];
    let writes = 0;

    snap.docs.forEach((doc) => {
      const data = doc.data() || {};
      const discordId = String(data.discord_id || "").trim();
      if (discordId) foundIds.add(discordId);
      matched += 1;

      const payload = buildServerBoosterUpdatePayload({
        userData: data,
        cardTemplate,
        member: memberById.get(discordId) || null,
        fieldValue: admin.firestore.FieldValue,
      });

      if (!payload) return;
      batch.update(doc.ref, payload);
      grantedDocs.push(doc);
      writes += 1;
    });

    missing += chunk.filter((id) => !foundIds.has(id)).length;
    if (writes > 0) {
      await commitBatchWithRetry(batch, { label });
      if (typeof onGrantedDoc === "function") {
        grantedDocs.forEach((doc) => onGrantedDoc(doc));
      }
      updated += writes;
      console.log(
        `🎉 [${label}] ${writes} carte(s) Booster Discord attribuée(s).`,
      );
    }
  }

  return { scanned: ids.length, matched, updated, missing };
}

module.exports = {
  SERVER_BOOSTER_CARD_ID,
  SERVER_BOOSTER_GRANTED_FIELD,
  SERVER_BOOSTER_CARD_SOURCE,
  SERVER_BOOSTER_CARD_TEMPLATE,
  buildServerBoosterCard,
  buildServerBoosterUpdatePayload,
  ensureServerBoosterCardTemplate,
  getServerBoosterStartedAt,
  grantServerBoosterCardsByDiscordIds,
  hasNativeServerBoosterRole,
  hasServerBoosterCard,
  isServerBoosterMember,
};
