// script/rankHandler.js
const { EmbedBuilder } = require("discord.js");

/**
 * Gère la commande !rank
 * @param {import('discord.js').Message} message
 * @param {import('firebase-admin').firestore.Firestore} db
 */
module.exports = async function rankHandler(message, db) {
  try {
    const userId = message.author.id;

    // 1) Récupérer les infos utilisateur dans followers_all_time
    const userSnap = await db
      .collection("followers_all_time")
      .where("discord_id", "==", userId)
      .limit(1)
      .get();

    if (userSnap.empty) {
      return message.reply({
        content: "❌ Profil introuvable dans `followers_all_time`.",
        ephemeral: true,
      });
    }

    const data = userSnap.docs[0].data();
    const level = data.wizebotLevel ?? 0;
    const rank = data.wizebotRank ?? 0;
    const lotteriesWon = data.isAlreadyWinLottery ? 1 : 0;
    // → Remplacez 'cardsCount' par le champ réel qui contient le nombre de cartes possédées
    const ownedCount = Array.isArray(data.cards_generated)
      ? data.cards_generated.length
      : 0;

    // 2) Récupérer le total des cartes dans card_collection
    const totalSnap = await db.collection("cards_collections").get();
    const totalCount = totalSnap.size;

    // 3) Construire l'embed
    const embed = new EmbedBuilder()
      .setColor("#FFD700")
      .setTitle(`🎖️ Tu est classé: ${rank}`)
      .addFields(
        {
          name: "Niveau",
          value: `Lvl ${level}`,
          inline: false,
        },
        {
          name: "🃏 Cartes possédées",
          value: `${ownedCount} / ${totalCount}`,
          inline: true,
        },
        { name: "🥇 Lotteries gagnées", value: `${lotteriesWon}`, inline: true }
      )
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error("Erreur dans rankHandler:", err);
    message.reply(
      "❌ Une erreur est survenue lors de la récupération de ton classement."
    );
  }
};
