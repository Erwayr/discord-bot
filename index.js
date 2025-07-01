// index.js
console.log("🟢 Démarrage du bot...");

const {
  Client,
  GatewayIntentBits,
  ActivityType,
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

// ID du salon de logs
const LOG_CHANNEL_ID = "1377870229153120257";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences, // ← nécessaire pour presenceUpdate
  ],
  partials: ["CHANNEL"],
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  // ─── Pré-chargement des membres pour que presenceUpdate soit bien émis ───
  for (const guild of client.guilds.cache.values()) {
    await guild.members.fetch();
    console.log(`🔄 Membres chargés pour la guilde : ${guild.name}`);
  }

  const processedCards = new Map();

  db.collection("followers_all_time").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type !== "modified") return;

        const docId = change.doc.id;
        const data = change.doc.data();
        if (!data.discord_id) return;

        const cards = Array.isArray(data.cards_generated)
          ? data.cards_generated
          : [];

        // Récupère la Set locale, ou en crée une
        let seen = processedCards.get(docId);
        if (!seen) {
          seen = new Set();
          processedCards.set(docId, seen);
        }

        // Filtre les cartes sans notifiedAt ET non déjà traitées
        const newCards = cards.filter((c) => {
          const key = c.title ? c.title : JSON.stringify(c); // ou c.id si vous en avez un
          return !c.notifiedAt && !seen.has(key);
        });

        if (newCards.length === 0) return;

        const generalChannel = await client.channels.fetch(
          "797077170974490645"
        );
        const collectionLink = `[votre collection](https://erwayr.github.io/ErwayrWebSite/index.html)`;

        for (const card of newCards) {
          const mention = `<@${data.discord_id}>`;
          const baseMsg = card.title
            ? `🎉 ${mention} vient de gagner la carte **${card.title}** !`
            : `🎉 ${mention} vient de gagner une nouvelle carte !`;
          await generalChannel.send(
            `${baseMsg}\n👉 Check en te connectant ${collectionLink}`
          );

          // On marque la carte comme traitée localement
          const key = card.title ? card.title : JSON.stringify(card);
          seen.add(key);

          // On marque en base
          card.notifiedAt = new Date().toISOString();
        }

        // Mise à jour Firestore
        await change.doc.ref.update({ cards_generated: cards });
      });
    },
    (err) => console.error("Listener Firestore error:", err)
  );
});

// Log des DM bruts comme avant
client.on("raw", async (packet) => {
  if (packet.t !== "MESSAGE_CREATE") return;
  const data = packet.d;
  if (!data.guild_id) {
    if (data.author.id === client.user.id) return;
    try {
      const user = await client.users.fetch(data.author.id);
      const content = data.content;
      console.log(`[DM RAW] ${user.tag} : ${content}`);
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

// Welcome et rank handlers
client.on(Events.GuildMemberAdd, async (member) => {
  await welcomeHandler(member, db, {
    enableDM: true,
    welcomeChannelId: "797077170974490645",
    autoRoleName: "Nouveau",
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  if (message.content.trim() === "!rank") {
    await rankHandler(message, db);
  }
});

// PresenceUpdate : mise à jour Firestore + log en salon
client.on(Events.PresenceUpdate, async (oldP, newP) => {
  // 1️⃣ Mise à jour Firestore
  await presenceHandler(oldP, newP, db);

  // 2️⃣ Envoi du log de la présence detectée
  const playing = newP.activities.find(
    (act) => act.type === ActivityType.Playing
  );
  if (!playing) return;
});

client.login(process.env.DISCORD_BOT_TOKEN);
