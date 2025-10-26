// welcomeHandler.js
const { EmbedBuilder } = require("discord.js");

/**
 * Accueille un nouveau membre avec DM, rôle, message public, et Firestore.
 * @param {GuildMember} member - Le nouveau membre Discord
 * @param {FirebaseFirestore.Firestore} db - Instance Firestore
 * @param {Object} config - Configuration personnalisée
 */
module.exports = async function welcomeHandler(member, db, config = {}) {
  try {
    const pseudo = member.user.username.toLowerCase();
    const discord_id = member.user.id;
    const avatar = member.user.displayAvatarURL({ size: 512 });
    const joinedAt = new Date().toISOString();

    // Enregistrement dans Firestore
    const docRef = db.collection("NewUser").doc(pseudo);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      await docRef.set({
        discord_id,
        pseudo,
        avatar,
        origin: "discord",
        joinedAt,
      });
      console.log(`👤 Nouveau membre enregistré : ${pseudo} (${discord_id})`);
    } else {
      console.log(`ℹ️ ${pseudo} est déjà enregistré.`);
    }

    // Envoi du message privé (DM)
    if (config.enableDM) {
      await member.send({
        content: `👋 Yo ${member.user.username} !  
Moi c’est **Booty**, fidèle serviteur, guide galactique, et distributeur semi-officiel de cookies 🍪.  
Bienvenue à bord du vaisseau **Erwayr** ! Prépare-toi à vivre une aventure communautaire incroyable 💫`,
        embeds: [
          new EmbedBuilder()
            .setTitle("🎉 Bienvenue dans la communauté Erwayr !")
            .setDescription(
              `🚀 Tu peux commencer l'exploration par notre hub :\n🌐 [**Accéder au site communautaire**](https://erwayr.online/)\n\n🔧 Besoin d'aide ? N'hésite pas à crier \`!aide\` (ou demander gentiment à un modo 😇)`
            )
            .setColor(0xff69b4)
            .setThumbnail(avatar)
            .setFooter({
              text: "✨ Booty veille sur toi depuis les étoiles ✨",
            }),
        ],
      });
    }

    const welcomeMessages = [
      `🎉 Bienvenue à <@${member.user.id}> ! Attache ta ceinture, le voyage commence maintenant 🚀`,
      `👋 Ohhh regardez qui vient d'arriver… <@${member.user.id}> entre dans la légende ✨`,
      `🎊 <@${member.user.id}> a spawn sur le serveur ! Que les festivités commencent !`,
      `🎮 <@${member.user.id}> vient de drop dans le lobby. Ready ? GO !`,
      `🍕 Un nouveau membre affamé vient d’arriver : <@${member.user.id}>. Bienvenue chez nous !`,
    ];

    // Choisit un message au hasard
    const randomMessage =
      welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];

    // Envoi dans un salon public
    if (config.welcomeChannelId) {
      const channel = member.guild.channels.cache.get(config.welcomeChannelId);
      if (channel && channel.isTextBased()) {
        await channel.send(randomMessage);
      }
    }

    // Attribution automatique d’un rôle
    if (config.autoRoleName) {
      const role = member.guild.roles.cache.find(
        (r) => r.name === config.autoRoleName
      );
      if (role) {
        await member.roles.add(role);
        console.log(`🔖 Rôle '${config.autoRoleName}' attribué à ${pseudo}`);
      }
    }
  } catch (err) {
    console.error("❌ Erreur dans welcomeHandler :", err);
  }
};
