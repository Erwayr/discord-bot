// index.js
console.log("🟢 Démarrage du bot...");

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  Events,
  Partials
} = require("discord.js");
require("dotenv").config();

const admin = require("firebase-admin");
const axios = require("axios");
const express     = require("express");
const bodyParser  = require("body-parser");
const crypto      = require("crypto");
const welcomeHandler = require("./script/welcomeHandler");
const rankHandler = require("./script/rankHandler");
const presenceHandler = require("./script/presenceHandler");
const electionHandler = require("./script/electionHandler");
const handleVoteChange = require("./script/handleVoteChange");
const cron = require("node-cron");


process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

let key;
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
const GENERAL_CHANNEL_ID = "797077170974490645";
//const GENERAL_CHANNEL_ID = "1377870229153120257";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences
  ],
  partials: [
    Partials.Channel,
   Partials.Message,        // ← pour récupérer les vieux messages
   Partials.Reaction  ],
});

const app = express();
app.use(bodyParser.json()); // pour parser les JSON Twitch

const TWITCH_SECRET = process.env.WEBHOOK_SECRET; 
// le "secret" que tu donnes à Twitch lors de la création de la webhook

// Fonction utilitaire pour vérifier la signature Twitch
function verifyTwitchSignature(req) {
  const messageId    = req.header("Twitch-Eventsub-Message-Id");
  const timestamp    = req.header("Twitch-Eventsub-Message-Timestamp");
  const signature    = req.header("Twitch-Eventsub-Message-Signature");
  const body         = JSON.stringify(req.body);
  const hmac         = crypto.createHmac("sha256", TWITCH_SECRET);
  hmac.update(messageId + timestamp + body);
  const expectedSig  = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(
    Buffer.from(expectedSig), 
    Buffer.from(signature)
  );
}

// Route de callback pour Twitch EventSub
app.post("/twitch-callback", async (req, res) => {
    console.log("📬 /twitch-callback headers:", req.headers);
  console.log("📬 /twitch-callback body:", JSON.stringify(req.body));
  // 1) Lors de l'enregistrement, Twitch envoie un challenge
  console.log("➡️ Received challenge:", req.body.challenge);

  if (req.body.challenge) {
    return res.status(200).send(req.body.challenge);
  }

  // 2) Sécurité : refuser si signature invalide
  if (!verifyTwitchSignature(req)) {
    return res.status(403).send("Invalid signature");
  }

  const { subscription, event } = req.body;
  if (subscription.type === "channel.follow") {
    const login     = event.user_login;    // pseudo Twitch
    const userId    = event.user_id;       // id numérique
    const followedAt= new Date(event.followed_at);

    const ref = db.collection("followers_all_time").doc(login.tolowerCase());
    const snap = await ref.get();

    if (snap.exists) {
      // optionnel : mettre à jour la date du dernier follow
      await ref.update({ lastFollowed: followedAt });
    } else {
      // création du doc pour ce nouveau follower
      await ref.set({
        pseudo: login.tolowerCase(),
        twitchId: userId,
        followDate: followedAt,
        cards_generated: [],
      });
    }
    console.log(`⚡ Nouveau follow détecté : ${login}`);
  }

  // 3) Toujours répondre 2xx pour acknowledge
  res.sendStatus(200);
});

// Démarre Express sur le port fourni par Railway ou 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Express server listening on port ${PORT}`);
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  await subscribeToFollows().catch(console.error);

  // ─── Pré-chargement des membres pour que presenceUpdate soit bien émis ───
  for (const guild of client.guilds.cache.values()) {
    await guild.members.fetch();
    console.log(`🔄 Membres chargés pour la guilde : ${guild.name}`);
  }

  await assignOldMemberCards(db).catch(console.error);

  // Planification quotidienne à minuit
  cron.schedule("0 0 * * *", () =>
    assignOldMemberCards(db).catch(console.error)
  );

  cron.schedule("0 */4 * * *", () => {
  refreshModeratorToken(db).catch(console.error);
});

const processingQueues = new Map();

db.collection("followers_all_time").onSnapshot(
  (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== "modified") return;

      const data = change.doc.data();
      if (!data.discord_id) return;

      const cards = Array.isArray(data.cards_generated)
        ? data.cards_generated
        : [];

      // ne garder que les cartes sans notifiedAt
      const newCards = cards.filter((c) => !c.notifiedAt);
      if (newCards.length === 0) return;

      for (const card of newCards) {
        // clé de queue = titre de la carte
      const idSource = card.title != null && card.title !== "" && card.title !== undefined
        ? card.title
        : `${card.isSub}_${card.hasRedemption}`;
      const titleKey = `${idSource}${data.pseudo}`;
        if (processingQueues.has(titleKey)) continue;
        const prev     = processingQueues.get(titleKey) || Promise.resolve();

        const next = prev.then(async () => {
          const generalChannel = await client.channels.fetch(GENERAL_CHANNEL_ID);
          const collectionLink = `[collection](https://erwayr.github.io/ErwayrWebSite/index.html)`;

          const mention = `<@${data.discord_id}>`;
          const baseMsg = card.title
            ? `🎉 ${mention} vient de gagner la carte **${card.title}** !`
            : `🎉 ${mention} vient de gagner une nouvelle carte !`;
          await generalChannel.send(
            `${baseMsg}\n👉 Check ta ${collectionLink}`
          );

          // marque en base
          card.notifiedAt = new Date().toISOString();
          if(!card.isAlreadyView) card.isAlreadyView = false;
          await change.doc.ref.update({ cards_generated: cards });
        });

        processingQueues.set(titleKey, next);
        next.catch(console.error);
      }
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
    welcomeChannelId: GENERAL_CHANNEL_ID,
    autoRoleName: "Nouveau",
  });
});

client.on(Events.MessageReactionAdd, (r, u) => handleVoteChange(r, u, true,db));
client.on(Events.MessageReactionRemove, (r, u) => handleVoteChange(r, u, false,db));

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

// Fonction pour échanger un refresh_token contre un nouvel access_token
async function refreshModeratorToken(db) {
  const ref = db.doc("settings/twitch_moderator");
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Pas de refresh_token en base !");
  const oldRefresh = snap.data().refresh_token;

  // Appel pour rafraîchir
  const res = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    null,
    {
      params: {
        grant_type:    "refresh_token",
        refresh_token: oldRefresh,
        client_id:     process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
      }
    }
  );

  const { access_token, refresh_token: newRefresh } = res.data;

  // Sauvegarde le nouveau refresh_token
  await ref.update({ refresh_token: newRefresh });

  console.log("🔄 Moderator token refreshed");
  return access_token;
}


client.login(process.env.DISCORD_BOT_TOKEN);


const BATCH_SIZE = 10;

async function assignOldMemberCards(db) {
  // 1️⃣ Récupérer la carte
  const cardSnap = await db
    .collection('cards_collections')
    .doc('discord_old_member')
    .get();
  if (!cardSnap.exists) {
    console.error('❌ Carte "discord_old_member" introuvable');
    return;
  }
  const oldMemberCard = { id: cardSnap.id, ...cardSnap.data() };

  // 2️⃣ Collecter tous les IDs Discord éligibles (>1 an)
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const eligibleIds = [];
  for (const guild of client.guilds.cache.values()) {
    const members = await guild.members.fetch();
    members.forEach(m => {
      if (
        !m.user.bot &&
        m.joinedTimestamp &&
        m.joinedTimestamp < oneYearAgo
      ) eligibleIds.push(m.id);
    });
  }
  if (eligibleIds.length === 0) return;

  // 3️⃣ Chunker par 10 pour la requête 'in'
  for (let i = 0; i < eligibleIds.length; i += BATCH_SIZE) {
    const chunk = eligibleIds.slice(i, i + BATCH_SIZE);
    const snap = await db
      .collection('followers_all_time')
      .where('discord_id', 'in', chunk)
      .get();
    if (snap.empty) continue;

    const batch = db.batch();

    snap.docs.forEach(doc => {
      const data = doc.data();

      // 4️⃣ Vérifier la propriété isAlreadyWinDiscordOldMember
      if (data.isAlreadyWinDiscordOldMember) {
        // déjà passé, on skip
        return;
      }

      // 5️⃣ On ajoute la carte ET on positionne le flag
      batch.update(doc.ref, {
        cards_generated: admin.firestore.FieldValue.arrayUnion(oldMemberCard),
        isAlreadyWinDiscordOldMember: true
      });
      console.log(`🎉 Carte "discord_old_member" attribuée à ${data.discord_id}`);
    });

    await batch.commit();
    console.log(`✅ Batch de ${chunk.length} membres traité.`);
  }
}

async function subscribeToFollows() {

  const endpoint = "https://api.twitch.tv/helix/eventsub/subscriptions";

  await refreshModeratorToken(db);


// 1️⃣ Récupère l’App Access Token (client_credentials)
  const { data: appData } = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    null,
    {
      params: {
        client_id:     process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type:    "client_credentials",
      }
    }
  );
  const appToken = appData.access_token;

  const headers = {
    "Client-ID":     process.env.TWITCH_CLIENT_ID,
    "Authorization": `Bearer ${appToken}`,
    "Content-Type":  "application/json",
  };

  // 2️⃣ Liste les souscriptions existantes pour éviter le duplicate
  const listRes = await axios.get(endpoint, { headers });
  const existing = listRes.data.data.find(sub =>
    sub.type === "channel.follow" &&
    sub.version === "2" &&
    sub.condition.broadcaster_user_id === process.env.TWITCH_CHANNEL_ID &&
    sub.condition.moderator_user_id   === process.env.TWITCH_CHANNEL_ID
  );
  if (existing) {
    console.log("ℹ️ Subscription channel.follow v2 déjà existante, ID =", existing.id);
    return;
  }

  let callbackUrl = "https://discord-bot-production-95c5.up.railway.app/twitch-callback";
// et enlève à nouveau tout ; ou espace qui traînerait
callbackUrl = callbackUrl.replace(/[;\s]+$/, "");
console.log("🔍 Final callbackUrl:", callbackUrl);

  // 4️⃣ Monte le payload en version 2
  let payload = {
    type:    "channel.follow",
    version: "2",
    condition: {
      broadcaster_user_id: process.env.TWITCH_CHANNEL_ID,
      moderator_user_id:   process.env.TWITCH_CHANNEL_ID
    },
    transport: {
      method:   "webhook",
      callback: callbackUrl,
      secret:   process.env.WEBHOOK_SECRET,
    }
  };

  payload = stripSemicolons(payload);

console.log("🛠 Payload sanitized:", JSON.stringify(payload, null, 2));
  // 5️⃣ Envoi la création
  try {
    const createRes = await axios.post(endpoint, payload, { headers });
    console.log("✅ Subscription channel.follow v2 créée, ID =", createRes.data.data[0].id);
  } catch (err) {
    console.error("Twitch subscription error status:", err.response?.status);
    console.error("Twitch subscription error body:", err.response?.data);
    throw err;
  }
}

function stripSemicolons(obj) {
  if (typeof obj === "string") {
    return obj.replace(/;/g, "");
  }
  if (Array.isArray(obj)) {
    return obj.map(stripSemicolons);
  }
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, stripSemicolons(v)])
    );
  }
  return obj;
}
