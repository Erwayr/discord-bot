// script/presenceHandler.js
const admin = require("firebase-admin"); // <- pour Timestamp
const { ActivityType } = require("discord.js");

/**
 * Met à jour followers_all_time.games_history[] avec:
 *  - { name, count, lastPlayedAt }
 *  - lastPlayedAt est écrasé à chaque fois que l'utilisateur rejoue à ce jeu.
 */
async function presenceHandler(oldPresence, newPresence, db) {
  if (!newPresence?.guild || !newPresence.activities?.length) return;

  const playing = newPresence.activities.find(
    (a) => a.type === ActivityType.Playing
  );
  if (!playing || !playing.name) return;

  const discordId = newPresence.userId;
  const colRef = db.collection("followers_all_time");
  const snap = await colRef.where("discord_id", "==", discordId).get();
  if (snap.empty) return;

  const userDoc = snap.docs[0];
  const userRef = userDoc.ref;

  const data = userDoc.data() || {};
  const gamesHistory = Array.isArray(data.games_history)
    ? data.games_history.slice()
    : [];

  // timestamp serveur Firestore (précision seconde) ; sinon new Date() marche aussi
  const now = admin.firestore.Timestamp.now();

  // cherche le jeu par name (exact, sensible à la casse — adapte si besoin)
  const idx = gamesHistory.findIndex((e) => e && e.name === playing.name);

  if (idx >= 0) {
    // jeu existant -> incrémente et écrase la date
    const current = gamesHistory[idx];
    gamesHistory[idx] = {
      ...current,
      name: playing.name,
      count: (Number(current.count) || 0) + 1,
      lastPlayedAt: now,
    };
  } else {
    // nouveau jeu -> crée l'entrée avec date initiale
    gamesHistory.push({
      name: playing.name,
      count: 1,
      lastPlayedAt: now,
    });
  }

  await userRef.update({ games_history: gamesHistory });

  const count = gamesHistory[idx >= 0 ? idx : gamesHistory.length - 1].count;
  console.log(
    `✅ [Presence] ${newPresence.user?.tag || discordId} → ${
      playing.name
    } (count=${count})`
  );
}

module.exports = presenceHandler;
