const {
  Client,
  GatewayIntentBits,
  ChannelType,
  Events,
} = require("discord.js");
require("dotenv").config();

const firebaseConfig = {
  apiKey: "AIzaSyCTRl3JbgCVU079qCunBKdYfHk6Pnjppjk",
  authDomain: "cadeau-du-moi.firebaseapp.com",
  projectId: "cadeau-du-moi",
  storageBucket: "cadeau-du-moi.firebasestorage.app",
  messagingSenderId: "1078724131061",
  appId: "1:1078724131061:web:115d0e779c4cbdb8be6dbc",
  measurementId: "G-R3FLZZXMWK",
};

const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

const LOG_CHANNEL_ID = "1377870229153120257";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // 👈 à ajouter
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages, // << AJOUT OBLIGATOIRE !
    GatewayIntentBits.MessageContent,
  ],
  partials: ["CHANNEL"],
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on("raw", async (packet) => {
  if (packet.t !== "MESSAGE_CREATE") return;

  const data = packet.d;

  // DM uniquement (pas de guild_id)
  if (!data.guild_id) {
    // 🔒 Ignorer les messages envoyés par le bot lui-même
    if (data.author.id === client.user.id) return;

    try {
      const user = await client.users.fetch(data.author.id);
      const content = data.content;

      console.log(`[DM RAW] ${user.tag} : ${content}`);

      // Envoi dans le salon
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (logChannel && logChannel.isTextBased()) {
        const now = Math.floor(Date.now() / 1000);
        await logChannel.send(
          `📩 **DM de ${user.tag}** à <t:${now}:F> :\n> ${content}`
        );
      }
    } catch (err) {
      console.error("❌ Erreur lors de l'envoi dans le salon :", err);
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const pseudo = member.user.username.toLowerCase();
    const discord_id = member.user.id;

    const docRef = db.collection("NewUser").doc(pseudo);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      await docRef.set({
        discord_id,
        pseudo,
        joinedAt: new Date().toISOString(),
      });

      console.log(`👤 Nouveau membre enregistré : ${pseudo} (${discord_id})`);

      // Envoie un message de bienvenue en DM
      await member.send(
        `👋 Bienvenue sur le serveur, ${member.user.username} ! 🎉`
      );
    } else {
      console.log(`ℹ️ ${pseudo} est déjà enregistré.`);
    }
  } catch (err) {
    console.error("❌ Erreur lors du traitement d'un nouveau membre :", err);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
