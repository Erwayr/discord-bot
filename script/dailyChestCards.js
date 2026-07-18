"use strict";

const DAILY_CHEST_CARD_SOURCE = "discord_daily_chest_openings";
const DAILY_CHEST_AUTO_GRANT_TYPE = "daily_chest_openings_min";

const DAILY_CHEST_CARD_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "discord_chest_opener",
    title: "Ouvre-boîte",
    section: "Discord",
    subMenu: "Coffres",
    position: 6,
    imgUrl: "images/cards-collection/discord_chest_opener.png",
    isFullImage: true,
    missingDescription: "Ouvre 7 coffres quotidiens sur Discord.",
    autoGrant: Object.freeze({
      type: DAILY_CHEST_AUTO_GRANT_TYPE,
      threshold: 7,
    }),
  }),
  Object.freeze({
    id: "discord_chest_addict",
    title: "Accro au coffre",
    section: "Discord",
    subMenu: "Coffres",
    position: 7,
    imgUrl: "images/cards-collection/discord_chest_addict.png",
    isFullImage: true,
    missingDescription: "Ouvre 30 coffres quotidiens sur Discord.",
    autoGrant: Object.freeze({
      type: DAILY_CHEST_AUTO_GRANT_TYPE,
      threshold: 30,
    }),
  }),
  Object.freeze({
    id: "discord_living_vault",
    title: "Coffre-fort vivant",
    section: "Discord",
    subMenu: "Coffres",
    position: 8,
    imgUrl: "images/cards-collection/discord_living_vault.png",
    isFullImage: true,
    missingDescription: "Ouvre 100 coffres quotidiens sur Discord.",
    autoGrant: Object.freeze({
      type: DAILY_CHEST_AUTO_GRANT_TYPE,
      threshold: 100,
    }),
  }),
]);

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function toSafeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function asCardsArray(cardsLike) {
  if (Array.isArray(cardsLike)) return cardsLike;
  if (cardsLike && typeof cardsLike === "object") {
    return Object.values(cardsLike);
  }
  return [];
}

function hasCard(cards, template) {
  const wantedId = norm(template?.id);
  const wantedSection = norm(template?.section);
  const wantedTitle = norm(template?.title);

  return cards.some((card) => {
    if (wantedId && norm(card?.id) === wantedId) return true;
    return (
      wantedSection &&
      wantedTitle &&
      norm(card?.section) === wantedSection &&
      norm(card?.title) === wantedTitle
    );
  });
}

function buildDailyChestCardUnlocks({
  userData = {},
  totalOpenings = 0,
  now = new Date(),
} = {}) {
  const existingCards = asCardsArray(userData?.cards_generated);
  const nextCards = existingCards.slice();
  const grantedCards = [];
  const safeTotalOpenings = toSafeCount(totalOpenings);
  const timestamp =
    now instanceof Date && !Number.isNaN(now.getTime())
      ? now.toISOString()
      : new Date().toISOString();
  const pseudo = String(
    userData?.pseudo || userData?.display_name || userData?.login || "",
  ).trim();

  for (const template of DAILY_CHEST_CARD_TEMPLATES) {
    const threshold = toSafeCount(template?.autoGrant?.threshold);
    if (safeTotalOpenings < threshold || hasCard(nextCards, template)) continue;

    const card = {
      ...template,
      autoGrant: { ...template.autoGrant },
      source: DAILY_CHEST_CARD_SOURCE,
      sentAt: timestamp,
      autoGrantedAt: timestamp,
      isAlreadyView: false,
    };
    if (pseudo) card.pseudo = pseudo;

    nextCards.push(card);
    grantedCards.push(card);
  }

  return { cards: nextCards, grantedCards };
}

function isAlreadyExistsError(error) {
  const code = String(error?.code ?? "").trim().toLowerCase();
  return (
    code === "6" ||
    code === "already-exists" ||
    code === "already_exists" ||
    /already exists/i.test(String(error?.message || ""))
  );
}

async function ensureDailyChestCardTemplates(db) {
  if (!db) throw new Error("ensureDailyChestCardTemplates: missing db dependency");

  const refs = DAILY_CHEST_CARD_TEMPLATES.map((template) =>
    db.collection("cards_collections").doc(template.id),
  );
  const snapshots = await Promise.all(refs.map((ref) => ref.get()));
  const missing = snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .filter(({ snapshot }) => !snapshot.exists);

  if (!missing.length) {
    return {
      checked: DAILY_CHEST_CARD_TEMPLATES.length,
      created: 0,
      existing: DAILY_CHEST_CARD_TEMPLATES.length,
    };
  }

  const batch = db.batch();
  missing.forEach(({ index }) => {
    const template = DAILY_CHEST_CARD_TEMPLATES[index];
    batch.create(refs[index], {
      ...template,
      autoGrant: { ...template.autoGrant },
    });
  });
  try {
    await batch.commit();
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return ensureDailyChestCardTemplates(db);
    }
    throw error;
  }

  return {
    checked: DAILY_CHEST_CARD_TEMPLATES.length,
    created: missing.length,
    existing: DAILY_CHEST_CARD_TEMPLATES.length - missing.length,
  };
}

module.exports = {
  DAILY_CHEST_AUTO_GRANT_TYPE,
  DAILY_CHEST_CARD_SOURCE,
  DAILY_CHEST_CARD_TEMPLATES,
  buildDailyChestCardUnlocks,
  ensureDailyChestCardTemplates,
};
