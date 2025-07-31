// script/messageCountHandler.js
const userDocRefs = new Map(); // discord_id -> ref Firestore

module.exports = async function messageCountHandler(message, db) {
  try {
    const discordId = message.author.id;

    let userRef = userDocRefs.get(discordId);

    // Si on n'a pas déjà la référence du doc Firestore
    if (!userRef) {
      const snap = await db
        .collection("followers_all_time")
        .where("discord_id", "==", discordId)
        .limit(1)
        .get();

      if (snap.empty) {
        console.warn(`⚠️ Aucun document trouvé pour discord_id = ${discordId}`);
        return;
      }

      userRef = snap.docs[0].ref;
      userDocRefs.set(discordId, userRef); // on garde juste la ref
    }

    // Évite la lecture Firestore, on utilise FieldValue.increment
    await userRef.update({
      discord_count_message: admin.firestore.FieldValue.increment(1),
    });
  } catch (err) {
    console.error("❌ Erreur messageCountHandler:", err);
  }
};
