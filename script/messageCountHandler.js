// script/messageCountHandler.js
module.exports = async function messageCountHandler(message, db) {
  try {
    const discordId = message.author.id;

    // Chercher le document où "discord_id" == message.author.id
    const snap = await db
      .collection("followers_all_time")
      .where("discord_id", "==", discordId)
      .limit(1)
      .get();

    if (snap.empty) {
      // Optionnel : log si le membre n'existe pas encore dans la collection
      console.warn(`⚠️ Aucun document trouvé pour discord_id = ${discordId}`);
      return;
    }

    const doc = snap.docs[0];
    const data = doc.data();

    const currentCount = data.discord_count_message || 0;

    await doc.ref.update({
      discord_count_message: currentCount + 1,
    });
  } catch (err) {
    console.error("❌ Erreur messageCountHandler:", err);
  }
};
