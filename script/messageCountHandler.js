const userDocRefs = new Map();
const admin = require("firebase-admin");
module.exports = async function messageCountHandler(message, db) {
  try {
    const discordId = message.author.id;
    let userRef = userDocRefs.get(discordId);

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
      userDocRefs.set(discordId, userRef);
    }
    await userRef.update({
      discord_count_message: admin.firestore.FieldValue.increment(1),
    });
  } catch (err) {
    console.error("❌ Erreur messageCountHandler:", err);
  }
};
