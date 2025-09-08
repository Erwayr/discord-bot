// script/electionHandler.js
const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const fetch = require("node-fetch"); // npm install node-fetch@2
const { FieldValue } = require("firebase-admin").firestore; // ← ajout

// Durée avant clôture automatique (en millisecondes) : 4 jours
const AUTO_CLOSE_DELAY = 2 * 24 * 60 * 60 * 1000;

/**
 * Handle election commands and auto-close after 4 days
 * @param {Message} message
 * @param {FirebaseFirestore.Firestore} db
 */
module.exports = async function electionHandler(message, db, channelId) {
  const [cmd, sub] = message.content.trim().split(/ +/);

  if (cmd !== "!election") return;

  // Vérification permissions
  if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return message.reply(
      "❌ Tu n'as pas la permission pour gérer les élections."
    );
  }
  const monthId = new Date().toISOString().slice(0, 7); // ex: "2025-07"
  const electionDoc = db.collection("elections").doc(monthId);
  const guild = message.guild;
  const channel = await guild.channels.fetch(channelId);

  async function finishElection(explicitWinnerId, isAuto = false) {
    const snap = await electionDoc.get();
    if (snap.data().endedAt) return;

    const voterIds = snap.data().voters || [];
    if (voterIds.length === 0) {
      // Pas de votant
      await electionDoc.update({ endedAt: new Date() });
      return channel.send("Aucun participant, élection annulée.");
    }

    // Choix du gagnant (paramètre ou tirage aléatoire)
    const winnerId =
      explicitWinnerId || voterIds[Math.floor(Math.random() * voterIds.length)];

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
    batch.update(userDoc.ref, {
      cards_generated: newCards,
      guardianWins: FieldValue.increment(1),
      guardianWonMonths: FieldValue.arrayUnion(monthId),
      guardianLastWonAt: endedAt,
    });

    // 3. Exécuter batch + opérations Discord + envoi de message en parallèle
    const memberPromise = guild.members.fetch(winnerId);
    const batchCommit = batch.commit();
    const sendMessage = channel.send(
      `🏆 ${
        isAuto ? "(clôture automatique) " : ""
      } @${pseudo} est le nouveau Gardien du Stream pour ${monthId} !`
    );
    const sendMessageRole = channel.send(
      `Tu as été élu Gardien du Stream ! Tu peux maintenant profiter de ton rôle spécial.`
    );

    // Attribution du rôle
    const rolePromise = memberPromise.then((member) => {
      const role = guild.roles.cache.find((r) => r.name === "🛡️ Gardien");
      if (role)
        return member.roles.add(
          role,
          "Gagnant de l’élection Gardien du Stream"
        );
    });

    // Attendre que tout soit terminé
    await Promise.all([batchCommit, rolePromise, sendMessage, sendMessageRole]);
  }

  // ─── Démarrer l'élection ───
  if (sub === "start") {
    const snap = await electionDoc.get();
    if (snap.exists && !snap.data().endedAt) {
      return message.reply("Une élection est déjà en cours ce mois-ci !");
    }

    // Initialise l’élection avec tableau vide
    await electionDoc.set({
      startedAt: new Date(),
      winnerId: null,
      endedAt: null,
      pollMessageId: null,
      voters: [],
    });

    const embed = new EmbedBuilder()
      .setTitle(`📊 Élection du Gardien du Stream – ${monthId}`)
      .setDescription(
        "Réagis avec 👍 pour participer et tenter de devenir le prochain Gardien du Stream !"
      )
      .setFooter({ text: "Fin des votes dans 2 jours" });

    const poll = await channel.send({ embeds: [embed] });
    await poll.react("👍");
    await electionDoc.update({ pollMessageId: poll.id });

    // Auto‐close après 4 jours
    setTimeout(async () => {
      const doc = await electionDoc.get();
      if (!doc.exists || doc.data().endedAt) return;
      const votes = doc.data().voters || [];
      if (votes.length > 0) {
        await finishElection(
          votes[Math.floor(Math.random() * votes.length)],
          true
        );
      } else {
        await channel.send(
          "Aucun participant, élection annulée automatiquement."
        );
        await electionDoc.update({ endedAt: new Date() });
      }
    }, AUTO_CLOSE_DELAY);

    return channel.send("✅ Élection lancée : réaction 👍 pour participer !");
  }

  // ─── End ───
  if (sub === "end") {
    const snap = await electionDoc.get();
    if (!snap.exists || snap.data().endedAt) {
      return message.reply("Pas d’élection en cours à terminer.");
    }
    const voterIds = snap.data().voters || [];
    if (voterIds.length === 0) {
      await channel.send("Aucun participant, élection annulée.");
      await electionDoc.update({ endedAt: new Date() });
      return;
    }
    await finishElection(
      voterIds[Math.floor(Math.random() * voterIds.length)],
      false
    );
    return;
  }
  return message.reply(
    "Usage : `!election start` pour lancer ou `!election end` pour terminer."
  );
};
