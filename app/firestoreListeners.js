"use strict";

const { asDiscordId, normalizeLogin, shortText } = require("./textUtils");

function formatWinnerDiscordMessage({ mention, prize, typeConcours }) {
  const safeMention = String(mention || "inconnu");
  const safePrize = String(prize || "cadeau");
  const safeType = String(typeConcours || "normal");
  return `🏆 Nouveau gagnant loterie: ${safeMention} - ${safePrize} (${safeType})`;
}

function formatWinnerTwitchMessage({ pseudo, prize }) {
  const safePseudo = String(pseudo || "inconnu");
  const safePrize = String(prize || "cadeau");
  return `🏆 Nouveau gagnant: ${safePseudo} ! GG pour ${safePrize}`;
}

function createFirestoreListeners({
  db,
  admin,
  config,
  birthdays,
  sendDMOrFallback,
  postDiscord,
  sendTwitchChatMessage,
}) {
  const winnerAnnouncementLocks = new Set();
  const processingQueues = new Map();

  async function resolveWinnerDiscordMention({ login, pseudo }) {
    const normalized = normalizeLogin(login || pseudo);
    const fallback = String(pseudo || login || "inconnu").trim() || "inconnu";
    if (!normalized) return fallback;

    try {
      const participantSnap = await db
        .collection("participants")
        .doc(normalized)
        .get();
      const participantDiscordId = asDiscordId(
        participantSnap.exists ? participantSnap.data()?.discord_id : null,
      );
      if (participantDiscordId) return `<@${participantDiscordId}>`;
    } catch (e) {
      console.warn(
        `[winner-announce] participants lookup failed (${normalized}):`,
        e?.message || e,
      );
    }

    try {
      const followerSnap = await db
        .collection("followers_all_time")
        .doc(normalized)
        .get();
      const followerDiscordId = asDiscordId(
        followerSnap.exists ? followerSnap.data()?.discord_id : null,
      );
      if (followerDiscordId) return `<@${followerDiscordId}>`;
    } catch (e) {
      console.warn(
        `[winner-announce] followers lookup failed (${normalized}):`,
        e?.message || e,
      );
    }

    return fallback;
  }

  async function tryClaimWinnerAnnouncement(docRef) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return { claimed: false, reason: "missing" };

      const data = snap.data() || {};
      const status = String(data?.announce?.status || "");
      if (status !== "pending") {
        return { claimed: false, reason: status || "unknown" };
      }

      tx.update(docRef, {
        "announce.status": "processing",
        "announce.processingAt": admin.firestore.FieldValue.serverTimestamp(),
        "announce.lastAttemptAt": admin.firestore.FieldValue.serverTimestamp(),
        "announce.tries": admin.firestore.FieldValue.increment(1),
        "announce.lastError": admin.firestore.FieldValue.delete(),
      });

      return { claimed: true };
    });
  }

  async function handleWinnerAnnouncementChange(change) {
    const docRef = change?.doc?.ref;
    const docId = change?.doc?.id;
    if (!docRef || !docId) return;
    if (winnerAnnouncementLocks.has(docId)) return;

    winnerAnnouncementLocks.add(docId);
    try {
      if (change.type === "removed") return;

      const current = change.doc.data() || {};
      const status = String(current?.announce?.status || "");
      if (status !== "pending") return;

      const claim = await tryClaimWinnerAnnouncement(docRef);
      if (!claim?.claimed) return;

      const freshSnap = await docRef.get();
      if (!freshSnap.exists) return;
      const data = freshSnap.data() || {};

      const pseudo = String(data?.pseudo || "").trim() || "Inconnu";
      const prize = String(data?.prix || "").trim() || "cadeau";
      const typeConcours = String(data?.typeConcours || "").trim() || "normal";
      const login = normalizeLogin(pseudo);
      const mention = await resolveWinnerDiscordMention({ login, pseudo });

      const discordMessage = formatWinnerDiscordMessage({
        mention,
        prize,
        typeConcours,
      });
      const twitchMessage = formatWinnerTwitchMessage({ pseudo, prize });

      const [discordResult, twitchResult] = await Promise.allSettled([
        postDiscord(config.discord.announcementChannelId, discordMessage),
        sendTwitchChatMessage(twitchMessage),
      ]);

      const discordSent = discordResult.status === "fulfilled";
      const twitchSent = twitchResult.status === "fulfilled";

      if (discordSent && twitchSent) {
        await docRef.update({
          "announce.status": "sent",
          "announce.sentAt": admin.firestore.FieldValue.serverTimestamp(),
          "announce.lastAttemptAt": admin.firestore.FieldValue.serverTimestamp(),
          "announce.errorAt": admin.firestore.FieldValue.delete(),
          "announce.lastError": admin.firestore.FieldValue.delete(),
          "announce.channels.discord": true,
          "announce.channels.twitch": true,
        });
        console.log(`[winner-announce] sent doc=${docId} pseudo=${pseudo}`);
        return;
      }

      const errors = [];
      if (!discordSent) {
        errors.push(
          `discord:${shortText(
            discordResult?.reason?.message || discordResult?.reason || "unknown",
            320,
          )}`,
        );
      }
      if (!twitchSent) {
        errors.push(
          `twitch:${shortText(
            twitchResult?.reason?.message || twitchResult?.reason || "unknown",
            320,
          )}`,
        );
      }

      await docRef.update({
        "announce.status": "error",
        "announce.errorAt": admin.firestore.FieldValue.serverTimestamp(),
        "announce.lastAttemptAt": admin.firestore.FieldValue.serverTimestamp(),
        "announce.lastError": shortText(errors.join(" | "), 1500),
        "announce.channels.discord": discordSent,
        "announce.channels.twitch": twitchSent,
      });
      console.warn(
        `[winner-announce] partial/failed doc=${docId} pseudo=${pseudo}: ${errors.join(
          " | ",
        )}`,
      );
    } catch (e) {
      const errText = shortText(e?.stack || e?.message || e, 1500);
      console.error(`[winner-announce] failed doc=${docId}:`, errText);
      try {
        await docRef.update({
          "announce.status": "error",
          "announce.errorAt": admin.firestore.FieldValue.serverTimestamp(),
          "announce.lastAttemptAt": admin.firestore.FieldValue.serverTimestamp(),
          "announce.lastError": errText,
        });
      } catch (updateErr) {
        console.error(
          `[winner-announce] failed to persist error doc=${docId}:`,
          shortText(updateErr?.stack || updateErr?.message || updateErr, 800),
        );
      }
    } finally {
      winnerAnnouncementLocks.delete(docId);
    }
  }

  function registerFirestoreListeners() {
    if (!config.firestore.enableListener) {
      console.warn(
        "[firestore] realtime listener disabled (FIRESTORE_ENABLE_LISTENER=0)",
      );
      return;
    }

    db.collection("followers_all_time").onSnapshot(
      (snapshot) => {
        const changes = snapshot.docChanges();
        birthdays.handleFollowerChanges(changes);

        changes.forEach((change) => {
          if (change.type !== "modified") return;

          const data = change.doc.data();
          if (!data.discord_id) return;

          const cards = Array.isArray(data.cards_generated)
            ? data.cards_generated
            : [];

          const newCards = cards.filter((c) => !c.notifiedAt);
          if (newCards.length === 0) return;

          for (const card of newCards) {
            const idSource =
              card.title != null && card.title !== "" && card.title !== undefined
                ? card.title
                : `${card.isSub}_${card.hasRedemption}`;
            const titleKey = `${idSource}${data.pseudo}`;
            if (processingQueues.has(titleKey)) continue;
            const prev = processingQueues.get(titleKey) || Promise.resolve();

            const next = prev.then(async () => {
              const collectionUrl = config.urls.collection;
              const baseMsg = card.title
                ? `🎉 Tu viens de gagner la carte **${card.title}** !`
                : `🎉 Tu viens de gagner une nouvelle carte !`;
              const dmMsg = `${baseMsg}\n👉 Ta collection : ${collectionUrl}`;
              console.log(
                `🃏 [Card] ${data.pseudo} won "${card.title || "unknown"}"`,
              );

              await sendDMOrFallback(data.discord_id, dmMsg);

              card.notifiedAt = new Date().toISOString();
              if (!card.isAlreadyView) card.isAlreadyView = false;
              await change.doc.ref.update({ cards_generated: cards });
            });

            processingQueues.set(titleKey, next);
            next.catch(console.error);
          }
        });
      },
      (err) => console.error("Listener Firestore error:", err),
    );

    db.collection("gagnants").onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") return;
          const status = String(change.doc.data()?.announce?.status || "");
          if (status !== "pending") return;
          handleWinnerAnnouncementChange(change).catch((e) =>
            console.error(
              "[winner-announce] unhandled handler error:",
              e?.message || e,
            ),
          );
        });
      },
      (err) => console.error("[winner-announce] listener error:", err),
    );
  }

  return {
    registerFirestoreListeners,
    handleWinnerAnnouncementChange,
  };
}

module.exports = { createFirestoreListeners };
