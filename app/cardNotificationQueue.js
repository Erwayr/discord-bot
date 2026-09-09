"use strict";

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function cardIdentity(card = {}) {
  if (card.id != null && card.id !== "") return `id:${card.id}`;
  if (card.title != null && card.title !== "") {
    return `title:${card.title}|section:${card.section || ""}`;
  }
  return `${card.isSub}_${card.hasRedemption}`;
}

function createCardNotificationQueue({
  db,
  config,
  sendDMOrFallback,
  now = () => new Date(),
  logger = console,
} = {}) {
  const processingQueues = new Map();

  async function processFollowerDocRef(docRef) {
    if (!docRef || typeof docRef.get !== "function") {
      return { processed: false, reason: "invalid_ref" };
    }

    const snap = await docRef.get();
    if (!snap.exists) return { processed: false, reason: "missing_doc" };

    const data = snap.data() || {};
    const discordId = String(data.discord_id || "").trim();
    if (!discordId) return { processed: false, reason: "missing_discord_id" };

    const cards = Array.isArray(data.cards_generated)
      ? data.cards_generated
      : [];
    const newCards = cards.filter((card) => card && !card.notifiedAt);
    if (!newCards.length) {
      return { processed: false, reason: "no_new_cards" };
    }

    const notifiedAt = now().toISOString();
    const collectionUrl = config?.urls?.collection || "https://erwayr.online";
    const sentKeys = new Set();

    for (const card of newCards) {
      const key = cardIdentity(card);
      if (sentKeys.has(key)) continue;
      sentKeys.add(key);

      const baseMsg = card.title
        ? `Tu viens de gagner la carte **${card.title}** !`
        : "Tu viens de gagner une nouvelle carte !";
      const dmMsg = `${baseMsg}\nTa collection : ${collectionUrl}`;
      await sendDMOrFallback(discordId, dmMsg);
      logger.log(
        `[Card] ${data.pseudo || snap.id} won "${card.title || "unknown"}"`,
      );
    }

    // Discord is called only above, never inside a retryable transaction.
    // Re-read the collection so grants, removals and views during delivery survive.
    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(docRef);
      if (!latest.exists) return;
      const latestCards = latest.data()?.cards_generated;
      if (!Array.isArray(latestCards)) return;
      let changed = false;
      const nextCards = latestCards.map((card) => {
        if (!card || card.notifiedAt || !sentKeys.has(cardIdentity(card))) return card;
        changed = true;
        return {
          ...card,
          notifiedAt,
          isAlreadyView: card.isAlreadyView ?? false,
        };
      });
      if (changed) transaction.update(docRef, { cards_generated: nextCards });
    });
    return { processed: true, notified: sentKeys.size };
  }

  function enqueueFollowerDoc(docRef) {
    const key = docRef?.path || docRef?.id || normalizeLogin(docRef);
    if (!key) return Promise.resolve({ processed: false, reason: "invalid_ref" });

    const chain = (processingQueues.get(key) || Promise.resolve())
      .then(() => processFollowerDocRef(docRef))
      .catch((e) => {
        logger.warn("[card-notify] failed:", e?.message || e);
        return { processed: false, reason: "error", error: e };
      })
      .finally(() => {
        if (processingQueues.get(key) === chain) {
          processingQueues.delete(key);
        }
      });

    processingQueues.set(key, chain);
    return chain;
  }

  return {
    enqueueFollowerDoc,
    processFollowerDocRef,
    pendingSize: () => processingQueues.size,
  };
}

module.exports = { createCardNotificationQueue };
