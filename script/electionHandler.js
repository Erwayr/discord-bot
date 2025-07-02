// script/electionHandler.js
const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const fetch = require("node-fetch"); // npm install node-fetch@2

// ID du salon spécifique pour les annonces
// Durée avant clôture automatique (en millisecondes) : 4 jours
const AUTO_CLOSE_DELAY = 4 * 24 * 60 * 60 * 1000;

/**
 * Handle election commands and auto-close after 4 days
 * @param {Message} message
 * @param {FirebaseFirestore.Firestore} db
 */
module.exports = async function electionHandler(message, db, channelId) {
  const args = message.content.trim().split(/ +/);
  const cmd = args[0];
  if (cmd !== "!election") return;

  // Vérification permissions
  if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return message.reply(
      "❌ Tu n'as pas la permission pour gérer les élections."
    );
  }

  const sub = args[1]; // 'start' ou 'end'
  const monthId = new Date().toISOString().slice(0, 7); // ex: "2025-07"
  const electionsColl = db.collection("elections");
  const electionDoc = electionsColl.doc(monthId);
  const guild = message.guild;
  const channel = await guild.channels.fetch(channelId);

  async function finishElection(winnerId, isAuto = false) {
    const snap = await electionDoc.get();
    if (snap.data().endedAt) return; // déjà clôturée

    // 1. Récupérer en parallèle la carte de base et les infos de l’utilisateur
    const [followersSnap, cardDoc] = await Promise.all([
      db
        .collection("followers_all_time")
        .where("discord_id", "==", winnerId)
        .limit(1)
        .get(),
      db.collection("cards_collections").doc("guardian").get(),
    ]);

    if (followersSnap.empty) {
      console.warn(`Aucun follower trouvé pour ${winnerId}`);
      return;
    }

    if (!cardDoc.exists) {
      throw new Error("cards_collections/guardian missing!");
    }

    const userDoc = followersSnap.docs[0];
    const userData = userDoc.data();

    // Construire userInfo sans champs sensibles
    const { cards_generated = [], ...rest } = userData;
    const userInfo = { ...rest };

    // Préparer la nouvelle carte
    const endedAt = new Date();
    const pseudo =
      userData.pseudo || (await guild.members.fetch(winnerId)).user.username;
    const baseCard = cardDoc.data();
    const guardianCard = {
      ...baseCard,
      pseudo,
      month: monthId,
      sentAt: endedAt.toISOString(),
    };

    // Mettre à jour ou ajouter la carte dans cards_generated
    const newCards = [...cards_generated];
    const idx = newCards.findIndex(
      (c) =>
        c.title === guardianCard.title && c.section === guardianCard.section
    );
    if (idx === -1) newCards.push(guardianCard);
    else newCards[idx] = { ...newCards[idx], ...guardianCard };

    // 2. Créer un batch pour les écritures Firestore
    const batch = db.batch();
    batch.update(electionDoc, {
      winnerId,
      endedAt,
      winnerInfo: userInfo,
    });
    batch.update(userDoc.ref, { cards_generated: newCards });

    // 3. Exécuter batch + opérations Discord + envoi de message en parallèle
    const memberPromise = guild.members.fetch(winnerId);
    const batchCommit = batch.commit();
    const sendMessage = channel.send(
      `🏆 ${
        isAuto ? "(clôture automatique) " : ""
      }<@${winnerId}> est le nouveau Gardien du Stream pour ${monthId} !`
    );

    // Attribution du rôle
    const rolePromise = memberPromise.then((member) => {
      const role = guild.roles.cache.find((r) => r.name === "Gardien");
      if (role)
        return member.roles.add(
          role,
          "Gagnant de l’élection Gardien du Stream"
        );
    });

    // Attendre que tout soit terminé
    await Promise.all([batchCommit, rolePromise, sendMessage]);
  }

  // ─── Démarrer l'élection ───
  if (sub === "start") {
    const snap = await electionDoc.get();
    if (snap.exists && !snap.data().endedAt) {
      return message.reply("Une élection est déjà en cours ce mois-ci !");
    }

    await electionDoc.set({
      startedAt: new Date(),
      winnerId: null,
      endedAt: null,
      pollMessageId: null,
    });

    const embed = new EmbedBuilder()
      .setTitle(`📊 Élection du Gardien du Stream – ${monthId}`)
      .setDescription(
        "Réagis avec 👍 pour participer et tenter de devenir le prochain Gardien du Stream !\n\n" +
          "Le gagnant recevra un nouveau rôle sur Discord, une carte à collectionner ainsi que d'autres récompenses surprises !"
      )
      .setFooter({
        text: "Fin des vote dans 4 jours",
      });

    const poll = await channel.send({ embeds: [embed] });
    await poll.react("👍");
    await electionDoc.update({ pollMessageId: poll.id });
    await poll.pin();

    setTimeout(async () => {
      const doc = await electionDoc.get();
      if (!doc.exists || doc.data().endedAt) return;
      const pollMsgId = doc.data().pollMessageId;
      const pollMsg = await channel.messages.fetch(pollMsgId);
      const reaction = pollMsg.reactions.cache.get("👍");
      const users = reaction
        ? (await reaction.users.fetch()).filter((u) => !u.bot).map((u) => u.id)
        : [];
      if (users.length > 0) {
        const winnerId = users[Math.floor(Math.random() * users.length)];
        await finishElection(winnerId, true);
      } else {
        await channel.send(
          "Aucun participant, élection annulée automatiquement."
        );
        await electionDoc.update({ endedAt: new Date() });
      }
    }, AUTO_CLOSE_DELAY);

    return channel.send(`✅ Élection lancée : réaction 👍 pour participer !`);
  }

  // ─── Terminer l'élection manuellement ───
  if (sub === "end") {
    const snap = await electionDoc.get();
    if (!snap.exists || snap.data().endedAt) {
      return message.reply("Pas d’élection en cours à terminer.");
    }
    const { pollMessageId } = snap.data();
    const poll = await channel.messages.fetch(pollMessageId);
    const reaction = poll.reactions.cache.get("👍");
    const users = reaction
      ? (await reaction.users.fetch()).filter((u) => !u.bot).map((u) => u.id)
      : [];
    if (users.length === 0) {
      await channel.send("Aucun participant, élection annulée.");
      await electionDoc.update({ endedAt: new Date() });
      return;
    }

    const winnerId = users[Math.floor(Math.random() * users.length)];
    await finishElection(winnerId, false);
    return;
  }

  return message.reply(
    "Usage : `!election start` pour lancer ou `!election end` pour terminer."
  );
};
