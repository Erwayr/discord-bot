// script/presenceHandler.js
const admin = require("firebase-admin"); // <- pour Timestamp
const { ActivityType } = require("discord.js");

const ONE_HOUR_MS = 60 * 60 * 1000;

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Met a jour followers_all_time.games_history[] avec:
 *  - { name, count, lastPlayedAt }
 *  - lastPlayedAt est ecrase a chaque fois que l'utilisateur rejoue a ce jeu.
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

  // timestamp serveur Firestore (precision seconde)
  const now = admin.firestore.Timestamp.now();

  // cherche le jeu par name (exact, sensible a la casse)
  const idx = gamesHistory.findIndex((e) => e && e.name === playing.name);

  if (idx >= 0) {
    const current = gamesHistory[idx];
    const lastPlayedMs = toMillis(current?.lastPlayedAt);

    // n'ajoute pas ce jeu s'il a deja ete ajoute dans la derniere heure
    if (lastPlayedMs != null && now.toMillis() - lastPlayedMs < ONE_HOUR_MS) {
      return;
    }

    // jeu existant -> incremente et ecrase la date
    gamesHistory[idx] = {
      ...current,
      name: playing.name,
      count: (Number(current.count) || 0) + 1,
      lastPlayedAt: now,
    };
  } else {
    // nouveau jeu -> cree l'entree avec date initiale
    gamesHistory.push({
      name: playing.name,
      count: 1,
      lastPlayedAt: now,
    });
  }

  await userRef.update({ games_history: gamesHistory });

  const count = gamesHistory[idx >= 0 ? idx : gamesHistory.length - 1].count;
  console.log(
    `[Presence] ${newPresence.user?.tag || discordId} -> ${
      playing.name
    } (count=${count})`
  );
}

module.exports = presenceHandler;
