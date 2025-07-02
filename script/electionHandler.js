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

  // Fonction de fin d'élection
  async function finishElection(winnerId, isAuto = false) {
    const snap = await electionDoc.get();
    if (snap.data().endedAt) return; // déjà clôturée
    await electionDoc.update({
      winnerId,
      endedAt: new Date(),
    });

    // Attribution du rôle Discord
    const member = await guild.members.fetch(winnerId);
    const role = guild.roles.cache.find((r) => r.name === "Gardien");
    if (role) {
      await member.roles.add(role, "Gagnant de l’élection Gardien du Stream");
    }

    // Envoi de l'annonce
    const autoText = isAuto ? "(clôture automatique) " : "";
    await channel.send(
      `🏆 ${autoText}<@${winnerId}> est le nouveau Gardien du Stream pour ${monthId} !`
    );

    // Appel API pour mise à jour du site
    await fetch("https://erwayr.github.io/ErwayrWebSite/api/gardien", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: winnerId,
        username: member.user.username,
        month: monthId,
      }),
    });

    // --- Création de la carte Gardien dans Firestore ---
    try {
      // Récupérer la carte de base 'guardian'
      const cardDoc = await db
        .collection("cards_collections")
        .doc("guardian")
        .get();
      if (!cardDoc.exists)
        throw new Error("cards_collections/guardian missing!");
      const baseCard = cardDoc.data();
      // Construire la carte personnalisée
      const guardianCard = {
        ...baseCard,
        pseudo: member.user.username,
        month: monthId,
        sentAt: new Date().toISOString(),
      };
      // Trouver l'utilisateur dans followers_all_time
      const followersSnap = await db
        .collection("followers_all_time")
        .where("discord_id", "==", winnerId)
        .get();
      if (!followersSnap.empty) {
        const userDoc = followersSnap.docs[0];
        const userRef = userDoc.ref;
        const data = userDoc.data();
        const cards = Array.isArray(data.cards_generated)
          ? data.cards_generated
          : [];
        // Vérifier présence
        const existsIndex = cards.findIndex(
          (c) =>
            c.title === guardianCard.title && c.section === guardianCard.section
        );
        if (existsIndex === -1) {
          cards.push(guardianCard);
        } else {
          // Mettre à jour si nécessaire
          cards[existsIndex] = { ...cards[existsIndex], ...guardianCard };
        }
        await userRef.update({ cards_generated: cards });
      }
    } catch (err) {
      console.error("Erreur création carte Gardien :", err);
    }
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
          "Le gagnant recevra un nouveau rôle exclusif sur Discord, une carte à collectionner personnalisée ainsi que d'autres récompenses surprises !"
      )
      .setFooter({
        text: "Clôture automatique dans 4 jours ou via `!election end`",
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
