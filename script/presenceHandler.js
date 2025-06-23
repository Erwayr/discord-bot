// script/presenceHandler.js

const { ActivityType, Events } = require("discord.js");

/**
 * Gère les mises à jour de présence pour tenir à jour, dans Firestore,
 * un tableau games_history[] avec { name, count }.
 *
 * @param {import('discord.js').Presence} oldPresence
 * @param {import('discord.js').Presence} newPresence
 * @param {import('firebase-admin').firestore.Firestore} db
 */
async function presenceHandler(oldPresence, newPresence, db) {
  // 1️⃣ On ne s'intéresse qu'aux guildes et aux activités
  if (!newPresence.guild || !newPresence.activities.length) return;

  // 2️⃣ On ne gère que les activités de type "PLAYING"
  const playing = newPresence.activities.find(
    (act) => act.type === ActivityType.Playing
  );
  if (!playing) return;

  const discordId = newPresence.userId;
  const colRef = db.collection("followers_all_time");
  const querySnap = await colRef.where("discord_id", "==", discordId).get();
  if (querySnap.empty) return; // pas trouvé dans tes abonnés

  // On prend le premier document (idéalement, il n'y en a qu'un)
  const userDoc = querySnap.docs[0];
  const userRef = userDoc.ref;

  // 3️⃣ Lecture de l'historique actuel
  const data = snap.data();
  const gamesHistory = Array.isArray(data.games_history)
    ? data.games_history
    : [];

  // 4️⃣ Mise à jour du compteur
  const idx = gamesHistory.findIndex((e) => e.name === playing.name);
  if (idx >= 0) {
    // jeu déjà dans l'historique → on incrémente
    gamesHistory[idx].count += 1;
  } else {
    // nouveau jeu → on ajoute
    gamesHistory.push({ name: playing.name, count: 1 });
  }

  // 5️⃣ Écriture dans Firestore
  await userRef.update({
    games_history: gamesHistory,
  });

  console.log(
    `✅ [Présence] ${newPresence.user.tag} → ${playing.name} (` +
      `count=${gamesHistory[idx >= 0 ? idx : gamesHistory.length - 1].count})`
  );
}

module.exports = presenceHandler;
