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
const { FieldValue,Timestamp} = require("firebase-admin").firestore;

const welcomeHandler = require("./script/welcomeHandler");
const rankHandler = require("./script/rankHandler");
const presenceHandler = require("./script/presenceHandler");
const electionHandler = require("./script/electionHandler");

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
//const GENERAL_CHANNEL_ID = "797077170974490645";
const GENERAL_CHANNEL_ID = "1377870229153120257";

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

const processingQueues = new Map();

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);

  // ─── Pré-chargement des membres pour que presenceUpdate soit bien émis ───
  for (const guild of client.guilds.cache.values()) {
    await guild.members.fetch();
    console.log(`🔄 Membres chargés pour la guilde : ${guild.name}`);
  }
  db.collection("followers_all_time")
    .onSnapshot(snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== "modified") continue;

        const docId = change.doc.id;
        const prev = processingQueues.get(docId) || Promise.resolve();
        const next = prev.then(() => handleChange(change));
        processingQueues.set(docId, next);
        next.catch(console.error);
      }
    });

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
    welcomeChannelId: GENERAL_CHANNEL_ID,
    autoRoleName: "Nouveau",
  });
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;

  await electionHandler(message, db, GENERAL_CHANNEL_ID);
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

async function handleChange(change) {
  const docRef = change.doc.ref;
  const data = change.doc.data();

  if (!data.discord_id) return;
  const cards = Array.isArray(data.cards_generated) ? data.cards_generated : [];

  const generalChannel = await client.channels.fetch(GENERAL_CHANNEL_ID);
  const collectionLink = `[votre collection](https://erwayr.github.io/ErwayrWebSite/index.html)`;

 // 1️⃣ Préparez vos listes de remove / union
 const toRemove = [];
 const toAdd    = [];
 const now      = Timestamp.now();
    for (const card of cards) {
    if (!card.notifiedAt) {
    const mention = `<@${data.discord_id}>`;
    const baseMsg = card.title
      ? `🎉 ${mention} vient de gagner la carte **${card.title}** !`
      : `🎉 ${mention} vient de gagner une nouvelle carte !`;
    
      generalChannel.send(
      `${baseMsg}\n👉 Check en te connectant ${collectionLink}`
    );
          await docRef.update({
        cards_generated: FieldValue.arrayRemove(card)
      });

           // On prépare la suppression de l’ancienne carte…
     toRemove.push(card);
     // …et la réinsertion avec un vrai timestamp
     toAdd.push({
       ...card,
       notifiedAt: now
     });
  }
  }

  // 2️⃣ Si on a des cartes à updater, on fait deux update() groupés
 if (toRemove.length > 0) {
   // retire toutes vos cartes « brutes »
   await docRef.update({
     cards_generated: FieldValue.arrayRemove(...toRemove)
   });
   // rajoute exactement les mêmes + notifiedAt: Timestamp
   await docRef.update({
     cards_generated: FieldValue.arrayUnion(...toAdd)
   });
 }
  // UN SEUL update(), qui ne touche qu'aux champs .notifiedAt ciblés
}

client.login(process.env.DISCORD_BOT_TOKEN);
