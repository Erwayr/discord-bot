// script/electionHandler.js
const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const fetch = require("node-fetch"); // npm install node-fetch@2
const { FieldValue } = require("firebase-admin").firestore; // ← ajout

// Durée avant clôture automatique (en millisecondes) : 2 jours
const AUTO_CLOSE_DELAY = 2 * 24 * 60 * 60 * 1000;

/**
 * Handle election commands and auto-close after 2 days
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

  function shuffleArray(input) {
    const arr = [...input];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function pickEligibleWinner(voterIds, preferredId) {
    const unique = Array.from(new Set(voterIds)).filter(Boolean);
    if (unique.length === 0) return null;

    const rest = preferredId ? unique.filter((id) => id !== preferredId) : unique;
    const candidates = preferredId
      ? [preferredId, ...shuffleArray(rest)]
      : shuffleArray(rest);

    for (const id of candidates) {
      const snap = await db
        .collection("followers_all_time")
        .where("discord_id", "==", id)
        .limit(1)
        .get();
      if (!snap.empty) return { winnerId: id, userDoc: snap.docs[0] };
    }
    return null;
  }

  async function getActiveElectionDoc() {
    const currentSnap = await electionDoc.get();
    if (currentSnap.exists && !currentSnap.data()?.endedAt) {
      return {
        docRef: electionDoc,
        docId: electionDoc.id,
        data: currentSnap.data(),
      };
    }

    const activeSnap = await db
      .collection("elections")
      .where("endedAt", "==", null)
      .get();
    if (activeSnap.empty) return null;

    let bestDoc = activeSnap.docs[0];
    let bestTs = 0;

    const toMillis = (value) => {
      if (!value) return 0;
      if (typeof value.toMillis === "function") return value.toMillis();
      if (value instanceof Date) return value.getTime();
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    };

    bestTs = toMillis(bestDoc.data()?.startedAt);
    for (const doc of activeSnap.docs.slice(1)) {
      const ts = toMillis(doc.data()?.startedAt);
      if (ts > bestTs) {
        bestDoc = doc;
        bestTs = ts;
      }
    }

    return { docRef: bestDoc.ref, docId: bestDoc.id, data: bestDoc.data() };
  }



  async function finishElection(electionCtx, explicitWinnerId, isAuto = false) {
    if (!electionCtx || !electionCtx.docRef) return;
    const { docRef, docId } = electionCtx;

    const snap = await docRef.get();
    if (!snap.exists) return;
    const electionData = snap.data() || {};
    if (electionData.endedAt) return;

    const voterIds = electionData.voters || [];
    if (voterIds.length === 0) {
      // Pas de votant
      await docRef.update({ endedAt: new Date() });
      return channel.send(
        isAuto
          ? "Aucun participant, élection annulée automatiquement."
          : "Aucun participant, élection annulée."
      );
    }

    const winnerPick = await pickEligibleWinner(voterIds, explicitWinnerId);
    if (!winnerPick) {
      console.warn("Aucun participant eligible (profil follower manquant).");
      await docRef.update({ endedAt: new Date(), winnerId: null });
      return channel.send(
        "Aucun participant eligible (profil follower manquant) - election annulee."
      );
    }

    const { winnerId, userDoc } = winnerPick;

    const cardDoc = await db
      .collection("cards_collections")
      .doc("guardian")
      .get();
    if (!cardDoc.exists) {
      throw new Error("cards_collections/guardian missing!");
    }

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
      month: docId,
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
    batch.update(docRef, {
      winnerId,
      endedAt,
      winnerInfo: userInfo,
    });
    batch.update(userDoc.ref, {
      cards_generated: newCards,
      guardianWins: FieldValue.increment(1),
      guardianWonMonths: FieldValue.arrayUnion(docId),
      guardianLastWonAt: endedAt,
    });

    // 3. Exécuter batch + opérations Discord + envoi de message en paralléle
    const memberPromise = guild.members.fetch(winnerId);
    const batchCommit = batch.commit();
    const sendMessage = channel.send(
      `🏆 ${
        isAuto ? "(clôture automatique) " : ""
      } @${pseudo} est le nouveau Gardien du Stream pour ${docId} !`
    );
    const sendMessageRole = channel.send(
      `Tu as été élu Gardien du Stream ! Tu peux maintenant profiter de ton rôle spécial.`    );

    // Attribution du rôle
    const rolePromise = memberPromise.then((member) => {
      const role = guild.roles.cache.find((r) => r.name === "🛡️ Gardien");
      if (role)
        return member.roles.add(
          role,
          "Gagnant de l'élection Gardien du Stream"
        );
    });

    // Attendre que tout soit termin?
    await Promise.all([batchCommit, rolePromise, sendMessage, sendMessageRole]);
  }


  // ─── Démarrer l'élection ───
  if (sub === "start") {
    const activeElection = await getActiveElectionDoc();
    if (activeElection) {
      return message.reply(
        `Une élection est déja en cours (${activeElection.docId}).`
      );
    }

    // Initialise l'élection avec tableau vide
    await electionDoc.set({
      startedAt: new Date(),
      winnerId: null,
      endedAt: null,
      pollMessageId: null,
      voters: [],
    });

    const embed = new EmbedBuilder()
      .setTitle(`📊 Élection du Gardien du Stream ? ${monthId}`)
      .setDescription(
        "Réagis avec 👍 pour participer et tenter de devenir le prochain Gardien du Stream !"
      )
      .setFooter({ text: "Fin des votes dans 2 jours" });

    const poll = await channel.send({ embeds: [embed] });
    await poll.react("👍");
    await electionDoc.update({ pollMessageId: poll.id });

    // Auto-close apres 2 jours
    const electionCtx = { docRef: electionDoc, docId: monthId };
    setTimeout(async () => {
      const doc = await electionCtx.docRef.get();
      if (!doc.exists || doc.data().endedAt) return;
      await finishElection(electionCtx, null, true);
    }, AUTO_CLOSE_DELAY);

    return channel.send("✅ Élection lancée : réaction 👍 pour participer !");
  }


  // ─── End ───
  if (sub === "end") {
    const activeElection = await getActiveElectionDoc();
    if (!activeElection) {
      return message.reply("Pas d'election en cours a terminer.");
    }
    await finishElection(activeElection, null, false);
    return;
  }

  return message.reply(
    "Usage : `!election start` pour lancer ou `!election end` pour terminer."
  );
};
