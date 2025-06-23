console.log("🟢 Démarrage du bot...");
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  Events,
} = require("discord.js");
require("dotenv").config();

const admin = require("firebase-admin");
const welcomeHandler = require("./script/welcomeHandler");
const rankHandler = require("./script/rankHandler");
const presenceHandler = require("./script/presenceHandler");

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});
let key;

console.log("Clé JSON : ", process.env.FIREBASE_KEY_JSON);
try {
  key = JSON.parse(process.env.FIREBASE_KEY_JSON);
  console.log("✅ Clé Firebase parsée !");
} catch (e) {
  console.error("❌ Erreur de parsing FIREBASE_KEY_JSON :", e);
}

admin.initializeApp({
  credential: admin.credential.cert(key),
});

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const LOG_CHANNEL_ID = "1377870229153120257";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
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
  await welcomeHandler(member, db, {
    enableDM: true,
    welcomeChannelId: "797077170974490645", // (ex : "1234567890")
    autoRoleName: "Nouveau", // ou null pour désactiver
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;

  if (message.content.trim() === "!rank") {
    await rankHandler(message, db);
  }
});

client.on(Events.PresenceUpdate, (oldP, newP) =>
  presenceHandler(oldP, newP, db)
);

client.login(process.env.DISCORD_BOT_TOKEN);
