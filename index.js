// index.js
console.log("🟢 Démarrage du bot...");

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  Events,
  Partials,
} = require("discord.js");
require("dotenv").config();

const admin = require("firebase-admin");
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { makeHelix } = require("./helper/helix");
// --- tes handlers ---
const welcomeHandler = require("./script/welcomeHandler");
const rankHandler = require("./script/rankHandler");
const messageCountHandler = require("./script/messageCountHandler");
const presenceHandler = require("./script/presenceHandler");
const electionHandler = require("./script/electionHandler");
const handleVoteChange = require("./script/handleVoteChange");

// --- factories ---
const { createLivePresenceTicker } = require("./script/livePresenceTracker");
const { createClipPoller } = require("./script/clipPoller");
const { mountTwitchAuth } = require("./script/authTwitch");
const { createTokenManager } = require("./script/tokenManager");
const cron = require("node-cron");

// (optionnel) autres helpers
const {
  updateRedemptionStatus,
  upsertParticipantFromRedemption,
  upsertParticipantFromSubscription,
  upsertFollowerMonthsFromSub,
} = require("./script/manageRedemption");

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

admin.initializeApp({ credential: admin.credential.cert(key) });

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// ---- instancie d'abord questStore (APRES db) ----
const { createQuestStorage } = require("./script/questStorage");
const questStore = createQuestStorage(db);

// ---- puis le token manager ----
const tokenManager = createTokenManager(db, {
  docPath: "settings/twitch_moderator",
});
const helix = makeHelix({
  tokenManager,
  clientId: process.env.TWITCH_CLIENT_ID,
});

// ---- ensuite seulement le livePresenceTicker (on lui passe questStore) ----
const livePresenceTick = createLivePresenceTicker({
  db,
  tokenManager,
  clientId: process.env.TWITCH_CLIENT_ID,
  broadcasterId: process.env.TWITCH_CHANNEL_ID,
  moderatorId: process.env.TWITCH_MODERATOR_ID || process.env.TWITCH_CHANNEL_ID,
  questStore, // ✅ maintenant défini
});

// ---- puis le clip poller qui dépend de questStore ET du ticker ----
const pollClipsTick = createClipPoller({
  tokenManager,
  questStore,
  livePresenceTick,
  clientId: process.env.TWITCH_CLIENT_ID,
  broadcasterId: process.env.TWITCH_CHANNEL_ID,
});

cron.schedule("*/5 * * * *", pollClipsTick);

cron.schedule("*/15 * * * *", async () => {
  try {
    const snap = await db.doc("settings/twitch_moderator").get();
    const s = snap.exists ? snap.data() : null;
    if (
      s?.issuer_client_id &&
      s.issuer_client_id !== process.env.TWITCH_CLIENT_ID
    ) {
      console.error(
        "❌ Client-ID mismatch: token lié à",
        s.issuer_client_id,
        "mais env TWITCH_CLIENT_ID =",
        process.env.TWITCH_CLIENT_ID,
        "→ refais /auth/twitch/start avec le bon client ou corrige l'env."
      );
    }
  } catch (e) {
    if (e.code === "NO_REFRESH_TOKEN") {
      console.log("⏭️ [keepalive] no refresh_token yet");
    } else {
      console.warn("⚠️ token keep-alive:", e?.response?.data || e.message || e);
    }
  }
});

cron.schedule("*/2 * * * *", async () => {
  console.log("⏱️ [CRON] livePresenceTick → start");
  try {
    await livePresenceTick();
  } catch (e) {
    console.warn(
      "⚠️ [CRON] livePresenceTick failed:",
      e?.response?.data || e.message || e
    );
  }
  const { streamId, startedAt } = livePresenceTick.getLiveStreamState();
  console.log(
    `⏱️ [CRON] livePresenceTick → end (streamId=${
      streamId || "offline"
    }, startedAt=${startedAt ? startedAt.toISOString() : "-"})`
  );
});

// ID du salon de logs
const LOG_CHANNEL_ID = "1377870229153120257";
const GENERAL_CHANNEL_ID = "797077170974490645";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [
    Partials.Channel,
    Partials.Message, // ← pour récupérer les vieux messages
    Partials.Reaction,
  ],
});

const app = express();
app.use(bodyParser.json()); // pour parser les JSON Twitch

// Monte les routes d'auth
mountTwitchAuth(app, db, {
  docPath: "settings/twitch_moderator",
  clientId: process.env.TWITCH_CLIENT_ID,
  clientSecret: process.env.TWITCH_CLIENT_SECRET,
  redirectUri:
    "https://discord-bot-production-95c5.up.railway.app/auth/twitch/callback",
});

const TWITCH_SECRET = process.env.WEBHOOK_SECRET;

const seenDeliveries = new Map(); // messageId -> ts (TTL court)
const SUB_DEBOUNCE_MS = 3500; // attente d’un éventuel "subscription.message"
const SUB_COOLDOWN_MS = 10_000; // évite de spammer pour le même user
const subTimers = new Map(); // login -> { timer, startedAt }
const lastSubNotified = new Map(); // login -> ts

function cleanupSeenDeliveries() {
  const now = Date.now();
  for (const [k, ts] of seenDeliveries) {
    if (now - ts > 5 * 60_000) seenDeliveries.delete(k); // TTL 5 min
  }
}

function isDuplicateDelivery(req) {
  const id = req.header("Twitch-Eventsub-Message-Id");
  if (!id) return false;
  if (seenDeliveries.has(id)) return true;
  seenDeliveries.set(id, Date.now());
  if (seenDeliveries.size > 2000) cleanupSeenDeliveries();
  return false;
}

async function postDiscord(channelId, text) {
  const ch = await client.channels.fetch(channelId);
  if (ch?.isTextBased() && text) await ch.send(text);
}

async function sendDMOrFallback(discordId, text) {
  let user = null;
  try {
    user = await client.users.fetch(discordId);
    await user.send(text);
    return true;
  } catch (err) {
    const reason =
      err?.code === 50007
        ? "DMs fermés par l’utilisateur (Discord 50007)"
        : `${err?.name || "Erreur"}${err?.code ? ` [${err.code}]` : ""}`;
    console.warn(`⚠️ DM vers ${discordId} impossible : ${reason}`);

    try {
      const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
      if (logCh?.isTextBased()) {
        await logCh.send({
          content:
            `🛑 **Fallback DM**\n` +
            `• **Destinataire :** ${
              user ? `${user.tag} (${discordId})` : `ID ${discordId}`
            }\n` +
            `• **Raison :** ${reason}\n` +
            `• **Message d’origine :**\n${text}`,
          // évite toute mention accidentelle dans le salon de logs
          allowedMentions: { parse: [] },
        });
      }
    } catch (e) {
      console.warn("⚠️ Fallback log-channel impossible :", e.message);
    }
    return false;
  }
}

function shouldSuppressNow(login) {
  const now = Date.now();
  const last = lastSubNotified.get(login) || 0;
  if (now - last < SUB_COOLDOWN_MS) return true;
  lastSubNotified.set(login, now);
  return false;
}

// Programme l’envoi d’un message "subscribe" avec debounce.
// buildText est une fonction async qui renvoie le texte final.
function scheduleSubscribeNotice(login, buildText) {
  // si un timer existe déjà, on repart à zéro (dernier événement gagne)
  if (subTimers.has(login)) clearTimeout(subTimers.get(login).timer);

  const timer = setTimeout(async () => {
    subTimers.delete(login);
    if (shouldSuppressNow(login)) return; // déjà un msg récent → on n'envoie pas
    try {
      const text = await buildText();
      await postDiscord(GENERAL_CHANNEL_ID, text);
      lastSubNotified.set(login, Date.now());
    } catch (e) {
      console.warn("subscribe notice failed:", e.message);
    }
  }, SUB_DEBOUNCE_MS);

  subTimers.set(login, { timer, startedAt: Date.now() });
}

// Envoie immédiatement le message "resub" et annule un éventuel "subscribe" programmé.
async function sendResubNow(login, buildText) {
  const t = subTimers.get(login);
  if (t) {
    clearTimeout(t.timer);
    subTimers.delete(login);
  }
  if (shouldSuppressNow(login)) return;
  const text = await buildText();
  await postDiscord(GENERAL_CHANNEL_ID, text);
  lastSubNotified.set(login, Date.now());
}

// Helpers de login/affichage
function getLoginFromEvent(e) {
  return (e?.user_login || e?.user?.login || "").toLowerCase();
}
function getDisplayFromEvent(e, fallbackLogin) {
  return e?.user_name || e?.user?.name || fallbackLogin;
}
// le "secret" que tu donnes à Twitch lors de la création de la webhook

// Fonction utilitaire pour vérifier la signature Twitch
function verifyTwitchSignature(req) {
  const messageId = req.header("Twitch-Eventsub-Message-Id");
  const timestamp = req.header("Twitch-Eventsub-Message-Timestamp");
  const signature = req.header("Twitch-Eventsub-Message-Signature");
  const body = JSON.stringify(req.body);
  const hmac = crypto.createHmac("sha256", TWITCH_SECRET);
  hmac.update(messageId + timestamp + body);
  const expectedSig = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(
    Buffer.from(expectedSig),
    Buffer.from(signature)
  );
}

app.get("/internal/twitch/access-token", async (req, res) => {
  if (req.header("x-api-key") !== process.env.INTERNAL_API_KEY) {
    return res.status(403).send("Forbidden");
  }
  try {
    const accessToken = await tokenManager.getAccessToken();
    res.json({ access_token: accessToken });
  } catch (e) {
    res.status(500).json({ error: e.code || "ERROR", message: e.message });
  }
});

// Route de callback pour Twitch EventSub
app.post("/twitch-callback", async (req, res) => {
  if (req.body.challenge) return res.status(200).send(req.body.challenge);
  if (!verifyTwitchSignature(req))
    return res.status(403).send("Invalid signature");
  // ⛔️ Twitch peut renvoyer la même livraison: on ignore si déjà vue
  if (isDuplicateDelivery(req)) return res.sendStatus(200);
  const { subscription, event } = req.body;
  console.log("🔔 Événement Twitch reçu:", subscription.type);
  if (
    subscription.type === "channel.channel_points_custom_reward_redemption.add"
  ) {
    const r = event;

    // 1) Est-ce le ticket d’or ? (pour FULFILL + upsert participant)
    const WANTED_REWARD_ID = process.env.TICKET_REWARD_ID || null;
    const isTicket = WANTED_REWARD_ID
      ? r.reward?.id === WANTED_REWARD_ID
      : /ticket d'or/i.test(r.reward?.title || "");

    // (log utile)
    console.log(
      `🎯 Redemption: user=${r.user_login} rewardId=${r.reward?.id} title="${r.reward?.title}" isTicket=${isTicket}`
    );

    // 2) Si c’est le ticket → on fait le fulfill + upserts
    if (isTicket) {
      try {
        const accessToken = await tokenManager.getAccessToken();
        await updateRedemptionStatus({
          broadcasterId: process.env.TWITCH_CHANNEL_ID,
          rewardId: r.reward.id,
          redemptionIds: [r.id],
          status: "FULFILLED",
          accessToken,
        });
        await upsertParticipantFromRedemption(db, r);
        try {
          const generalChannel = await client.channels.fetch(
            GENERAL_CHANNEL_ID
          );
          if (generalChannel?.isTextBased()) {
            await generalChannel.send(
              `📜 Note prise : participation de ${r.user_name} confirmée — **${r.reward.title}** 🎟️`
            );
          }
        } catch (e) {
          console.warn("Discord notify failed:", e.message);
        }
      } catch (e) {
        console.error(
          "Fulfill+participant error:",
          e.response?.data || e.message
        );
      }
    }

    // 3) ⚠️ Toujours compter la rédemption pour la quête "points de chaîne"
    try {
      const login = (r.user_login || r.user_name || "").toLowerCase();
      const { streamId } = livePresenceTick.getLiveStreamState();
      if (login && streamId) {
        await questStore.noteChannelPoints(login, streamId, 1);
        console.log(`✅ ChannelPoints +1 → ${login} (stream ${streamId})`);
      } else {
        console.log(
          `⏭️ ChannelPoints ignoré (login=${login} streamId=${streamId || "-"})`
        );
      }
    } catch (e) {
      console.warn("noteChannelPoints failed:", e?.message || e);
    }

    return res.sendStatus(200);
  }
  if (subscription.type === "channel.follow") {
    const login = event.user_login; // pseudo Twitch
    const userId = event.user_id; // id numérique
    const followedAt = new Date(event.followed_at);

    const ref = db.collection("followers_all_time").doc(login.toLowerCase());
    const snap = await ref.get();

    if (snap.exists) {
      // optionnel : mettre à jour la date du dernier follow
      await ref.update({ lastFollowed: followedAt });
    } else {
      // création du doc pour ce nouveau follower
      await ref.set({
        pseudo: login.toLowerCase(),
        twitchId: userId,
        followDate: followedAt,
        cards_generated: [],
      });
    }
    console.log(`⚡ Nouveau follow détecté : ${login}`);
  }
  if (subscription.type === "channel.subscribe") {
    try {
      // upserts idempotents en DB
      await upsertParticipantFromSubscription(db, event);
      await upsertFollowerMonthsFromSub(db, event);

      // coalescing: message "subscribe" retardé, annulé si un "subscription.message" arrive
      const login = getLoginFromEvent(event);
      const display = getDisplayFromEvent(event, login);
      scheduleSubscribeNotice(login, async () => {
        const mention = await buildSubMention(db, login, display);
        return formatSubDiscordMessage(event, {
          type: "channel.subscribe",
          mention,
        });
      });

      console.log(
        `⭐ Sub enregistré pour ${event.user_login || event.user?.login}`
      );
    } catch (e) {
      console.error("Sub upsert error:", e.response?.data || e.message);
    }
    return res.sendStatus(200);
  }
  if (subscription.type === "channel.subscription.message") {
    try {
      // upserts idempotents en DB (mêmes fonctions, ça ne double pas les données)
      await upsertParticipantFromSubscription(db, event);
      await upsertFollowerMonthsFromSub(db, event);

      const login = getLoginFromEvent(event);
      const display = getDisplayFromEvent(event, login);
      await sendResubNow(login, async () => {
        const mention = await buildSubMention(db, login, display);
        return formatSubDiscordMessage(event, {
          type: "channel.subscription.message",
          mention,
        });
      });

      console.log(
        `🔁 Resub enregistré pour ${event.user_login || event.user?.login}`
      );
    } catch (e) {
      console.error("Resub upsert error:", e.response?.data || e.message);
    }
    return res.sendStatus(200);
  }
  if (subscription.type === "channel.raid") {
    try {
      const { streamId } = livePresenceTick.getLiveStreamState();
      if (!streamId) return res.sendStatus(200);

      // récupère les chatters actuels
      const accessToken = await tokenManager.getAccessToken();
      const headers = {
        "Client-ID": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${accessToken}`,
      };

      const logins = [];
      let after = null,
        guard = 0;
      do {
        const { data } = await axios.get(
          "https://api.twitch.tv/helix/chat/chatters",
          {
            headers,
            params: after
              ? {
                  broadcaster_id: process.env.TWITCH_CHANNEL_ID,
                  moderator_id:
                    process.env.TWITCH_MODERATOR_ID ||
                    process.env.TWITCH_CHANNEL_ID,
                  first: 1000,
                  after,
                }
              : {
                  broadcaster_id: process.env.TWITCH_CHANNEL_ID,
                  moderator_id:
                    process.env.TWITCH_MODERATOR_ID ||
                    process.env.TWITCH_CHANNEL_ID,
                  first: 1000,
                },
          }
        );
        (data?.data || []).forEach(
          (c) => c?.user_login && logins.push(c.user_login.toLowerCase())
        );
        after = data?.pagination?.cursor || null;
      } while (after && ++guard < 5);

      await Promise.all(
        logins.map((login) => questStore.noteRaidParticipation(login, streamId))
      );
    } catch (e) {
      console.warn("raid handler failed:", e?.response?.data || e.message);
    }
    return res.sendStatus(200);
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
  try {
    await tokenManager.getAccessToken();
  } catch (e) {
    console.warn("⚠️ Pré-chauffe token a échoué :", e.message || e);
  }
  await subscribeToFollows().catch(console.error);
  await subscribeToRedemptions().catch(console.error);
  await subscribeToSubs().catch(console.error);
  await subscribeToRaids().catch(console.error);

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
          const idSource =
            card.title != null && card.title !== "" && card.title !== undefined
              ? card.title
              : `${card.isSub}_${card.hasRedemption}`;
          const titleKey = `${idSource}${data.pseudo}`;
          if (processingQueues.has(titleKey)) continue;
          const prev = processingQueues.get(titleKey) || Promise.resolve();

          const next = prev.then(async () => {
            const collectionUrl =
              "https://erwayr.github.io/ErwayrWebSite/index.html";
            const baseMsg = card.title
              ? `🎉 Tu viens de gagner la carte **${card.title}** !`
              : `🎉 Tu viens de gagner une nouvelle carte !`;
            const dmMsg = `${baseMsg}\n👉 Ta collection : ${collectionUrl}`;

            await sendDMOrFallback(data.discord_id, dmMsg);

            // marque en base
            card.notifiedAt = new Date().toISOString();
            if (!card.isAlreadyView) card.isAlreadyView = false;
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

const tmi = require("tmi.js");

let CHANNEL_EMOTE_IDS = new Set();
let CHANNEL_EMOTE_NAMES = new Set(); // 👈 nouveau

async function refreshChannelEmotes() {
  try {
    const { data } = await helix({
      url: "https://api.twitch.tv/helix/chat/emotes",
      params: { broadcaster_id: process.env.TWITCH_CHANNEL_ID },
    });
    const list = data?.data || [];
    CHANNEL_EMOTE_IDS = new Set(list.map((e) => String(e.id)));
    CHANNEL_EMOTE_NAMES = new Set(list.map((e) => e.name));
    const sample = list.slice(0, 5).map((e) => e.name).join(", ");
    console.log(`🎭 Emotes de chaîne chargées: ${CHANNEL_EMOTE_IDS.size} (sample: ${sample || "—"})`);
  } catch (e) {
    console.warn("⚠️ refreshChannelEmotes:", e?.response?.data || e.message);
  }
}
// TMI en anonyme (lecture seule)
const tmiClient = new tmi.Client({
  options: { debug: false },
  connection: { reconnect: true, secure: true },
  channels: ['erwayr'], // ex: "erwayr"
});
tmiClient.connect().catch(console.error);
//
tmiClient.on("connected", async () => {
  await refreshChannelEmotes();
});

tmiClient.on("message", async (channel, tags, msg, self) => {
  console.log('message CHat',msg)
  if (self) return;
    console.log(' Self')

  const login = (tags.username || "").toLowerCase();
    console.log('lohin', login)

  if (!login) return;

  const { streamId } = livePresenceTick.getLiveStreamState();
  if (!streamId) {
    if (process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:skip] stream offline | from=${login} msg="${msg.slice(0, 80)}"`
      );
    }
    return;
  }

  const emotesObj = tags.emotes || null;

  // Log brut utile pour savoir ce que TMI te donne réellement
  if (process.env.DEBUG_EMOTES) {
    console.log(
      `[emotes:raw] from=${login} stream=${streamId} hasEmotes=${!!emotesObj} msg="${msg.slice(
        0,
        80
      )}"`
    );
    if (emotesObj) {
      const keys = Object.keys(emotesObj);
      console.log(`  keys=${keys.join(",") || "(none)"}`);
      keys.slice(0, 8).forEach((id) => {
        const tag = CHANNEL_EMOTE_IDS.has(String(id)) ? "mine" : "other";
        console.log(
          `  └ id=${id} tag=${tag} count=${emotesObj[id]?.length || 0}`
        );
      });
    }
    if (CHANNEL_EMOTE_IDS.size === 0) {
      console.log(
        "⚠️ CHANNEL_EMOTE_IDS est vide — refreshChannelEmotes n'a peut-être pas marché."
      );
    }
  }

  // --- Cas 1: TMI n'a rien reconnu comme émote Twitch (souvent 7TV/BTTV/FFZ) ---
  if (!emotesObj) {
    let incByName = 0;
    if (CHANNEL_EMOTE_NAMES.size) {
      for (const token of msg.split(/\s+/)) {
        if (CHANNEL_EMOTE_NAMES.has(token)) incByName += 1;
      }
    }
    if (incByName > 0) {
      console.log(
        `[emotes:fallback-name] ${login} +${incByName} msg="${msg.slice(
          0,
          80
        )}"`
      );
      try {
        await questStore.noteEmoteUsage(login, streamId, incByName);
        console.log(
          `[emotes→DB] OK fallback-name | ${login} +${incByName} stream=${streamId}`
        );
      } catch (e) {
        console.error(
          `[emotes→DB] FAIL fallback-name | ${login} +${incByName} stream=${streamId}`
        );
        console.error(e?.stack || e?.message || e);
      }
    } else if (process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:skip] no twitch emote & no fallback-name match | from=${login}`
      );
    }
    return;
  }

  // --- Cas 2: TMI a reconnu des émotes Twitch ---
  const idsInMsg = Object.keys(emotesObj);
  const myIds = idsInMsg.filter((id) => CHANNEL_EMOTE_IDS.has(String(id)));
  let inc = myIds.reduce((sum, id) => sum + (emotesObj[id]?.length || 0), 0);

  // Fallback par NOM si inc==0
  if (inc === 0 && CHANNEL_EMOTE_NAMES.size) {
    for (const token of msg.split(/\s+/)) {
      if (CHANNEL_EMOTE_NAMES.has(token)) inc += 1;
    }
    if (inc > 0) {
      console.log(
        `[emotes:fallback-name] ${login} +${inc} msg="${msg.slice(0, 80)}"`
      );
    }
  }

  if (inc <= 0) {
    if (process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:skip] detected emotes but none are YOUR channel emotes | from=${login}`
      );
    }
    return;
  }

  console.log(
    `[emotes] ${login} +${inc} (ids=${myIds.join(",")}) msg="${msg.slice(
      0,
      80
    )}"`
  );
  try {
    await questStore.noteEmoteUsage(login, streamId, inc);
    console.log(`[emotes→DB] OK | ${login} +${inc} stream=${streamId}`);
  } catch (e) {
    console.error(`[emotes→DB] FAIL | ${login} +${inc} stream=${streamId}`);
    console.error(e?.stack || e?.message || e);
  }
});

async function subscribeToRaids() {
  const endpoint = "https://api.twitch.tv/helix/eventsub/subscriptions";
  const { data: appData } = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    null,
    {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials",
      },
    }
  );
  const headers = {
    "Client-ID": process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${appData.access_token}`,
    "Content-Type": "application/json",
  };

  const list = await axios.get(endpoint, { headers });
  const exists = list.data.data.find(
    (s) =>
      s.type === "channel.raid" &&
      s.condition?.from_broadcaster_user_id === process.env.TWITCH_CHANNEL_ID
  );
  if (exists) return;

  await axios.post(
    endpoint,
    {
      type: "channel.raid",
      version: "1",
      condition: { from_broadcaster_user_id: process.env.TWITCH_CHANNEL_ID },
      transport: {
        method: "webhook",
        callback:
          "https://discord-bot-production-95c5.up.railway.app/twitch-callback",
        secret: process.env.WEBHOOK_SECRET,
      },
    },
    { headers }
  );
}

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

client.on(Events.MessageReactionAdd, (r, u) =>
  handleVoteChange(r, u, true, db)
);
client.on(Events.MessageReactionRemove, (r, u) =>
  handleVoteChange(r, u, false, db)
);

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;

  await messageCountHandler(message, db); // 🔄 Mise à jour du compteur

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

client.login(process.env.DISCORD_BOT_TOKEN);

const BATCH_SIZE = 10;

async function assignOldMemberCards(db) {
  // 1️⃣ Récupérer la carte
  const cardSnap = await db
    .collection("cards_collections")
    .doc("discord_old_member")
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
    members.forEach((m) => {
      if (!m.user.bot && m.joinedTimestamp && m.joinedTimestamp < oneYearAgo)
        eligibleIds.push(m.id);
    });
  }
  if (eligibleIds.length === 0) return;

  // 3️⃣ Chunker par 10 pour la requête 'in'
  for (let i = 0; i < eligibleIds.length; i += BATCH_SIZE) {
    const chunk = eligibleIds.slice(i, i + BATCH_SIZE);
    const snap = await db
      .collection("followers_all_time")
      .where("discord_id", "in", chunk)
      .get();
    if (snap.empty) continue;

    const batch = db.batch();

    snap.docs.forEach((doc) => {
      const data = doc.data();

      // 4️⃣ Vérifier la propriété isAlreadyWinDiscordOldMember
      if (data.isAlreadyWinDiscordOldMember) {
        // déjà passé, on skip
        return;
      }

      // 5️⃣ On ajoute la carte ET on positionne le flag
      batch.update(doc.ref, {
        cards_generated: admin.firestore.FieldValue.arrayUnion(oldMemberCard),
        isAlreadyWinDiscordOldMember: true,
      });
      console.log(
        `🎉 Carte "discord_old_member" attribuée à ${data.discord_id}`
      );
    });

    await batch.commit();
    console.log(`✅ Batch de ${chunk.length} membres traité.`);
  }
}

async function subscribeToFollows() {
  const endpoint = "https://api.twitch.tv/helix/eventsub/subscriptions";

  // 1️⃣ Récupère l’App Access Token (client_credentials)
  const { data: appData } = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    null,
    {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials",
      },
    }
  );
  const appToken = appData.access_token;

  const headers = {
    "Client-ID": process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${appToken}`,
    "Content-Type": "application/json",
  };

  // 2️⃣ Liste les souscriptions existantes pour éviter le duplicate
  const listRes = await axios.get(endpoint, { headers });
  const existing = listRes.data.data.find(
    (sub) =>
      sub.type === "channel.follow" &&
      sub.version === "2" &&
      sub.condition.broadcaster_user_id === process.env.TWITCH_CHANNEL_ID &&
      sub.condition.moderator_user_id === process.env.TWITCH_CHANNEL_ID
  );
  if (existing) {
    return;
  }

  // 4️⃣ Monte le payload en version 2
  let payload = {
    type: "channel.follow",
    version: "2",
    condition: {
      broadcaster_user_id: process.env.TWITCH_CHANNEL_ID,
      moderator_user_id: process.env.TWITCH_CHANNEL_ID,
    },
    transport: {
      callback:
        "https://discord-bot-production-95c5.up.railway.app/twitch-callback",
      method: "webhook",
      secret: process.env.WEBHOOK_SECRET,
    },
  };

  // 5️⃣ Envoi la création
  try {
    const createRes = await axios.post(endpoint, payload, { headers });
  } catch (err) {
    throw err;
  }
}

async function subscribeToRedemptions() {
  const endpoint = "https://api.twitch.tv/helix/eventsub/subscriptions";

  // App Access Token (client_credentials) — pas besoin de scopes user ici
  const { data: appData } = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    null,
    {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials",
      },
    }
  );
  const appToken = appData.access_token;

  const headers = {
    "Client-ID": process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${appToken}`,
    "Content-Type": "application/json",
  };

  // (debug) lister ce qui existe déjà
  const list = await axios.get(endpoint, { headers });
  const exists = list.data.data.find(
    (s) =>
      s.type === "channel.channel_points_custom_reward_redemption.add" &&
      s.condition?.broadcaster_user_id === process.env.TWITCH_CHANNEL_ID
  );
  if (exists) {
    console.log("✅ EventSub redemption.add déjà présent:", exists.id);
    return;
  }

  // condition obligatoire
  const condition = { broadcaster_user_id: process.env.TWITCH_CHANNEL_ID };

  const payload = {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    transport: {
      method: "webhook",
      callback:
        "https://discord-bot-production-95c5.up.railway.app/twitch-callback",
      secret: process.env.WEBHOOK_SECRET,
    },
  };

  const created = await axios.post(endpoint, payload, { headers });
  console.log("✅ EventSub redemption.add créé:", created.data.data?.[0]?.id);
}

// AJOUTE ça dans index.js (à côté des autres subscribeTo*)
async function subscribeToSubs() {
  const endpoint = "https://api.twitch.tv/helix/eventsub/subscriptions";
  const { data: appData } = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    null,
    {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials",
      },
    }
  );
  const appToken = appData.access_token;
  const headers = {
    "Client-ID": process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${appToken}`,
    "Content-Type": "application/json",
  };

  const list = await axios.get(endpoint, { headers });
  const ensure = async (type) => {
    const exists = list.data.data.find(
      (s) =>
        s.type === type &&
        s.condition?.broadcaster_user_id === process.env.TWITCH_CHANNEL_ID
    );
    if (exists) return;
    await axios.post(
      endpoint,
      {
        type,
        version: "1",
        condition: { broadcaster_user_id: process.env.TWITCH_CHANNEL_ID },
        transport: {
          method: "webhook",
          callback:
            "https://discord-bot-production-95c5.up.railway.app/twitch-callback",
          secret: process.env.WEBHOOK_SECRET,
        },
      },
      { headers }
    );
  };

  await ensure("channel.subscribe"); // nouveaux abonnements (incl. gifts destinataire)
  await ensure("channel.subscription.message"); // resub / share sub
}

async function buildSubMention(db, login, display) {
  try {
    const snap = await db.collection("participants").doc(login).get();
    const discordId = snap.exists ? snap.data()?.discord_id : null;
    return discordId ? `<@${discordId}>` : display || login;
  } catch {
    return display || login;
  }
}

function formatSubDiscordMessage(e, { type, mention }) {
  const isGift = !!e?.is_gift;
  const gifter = e?.gifter_user_name || e?.gifter_user_login;

  if (type === "channel.subscription.message") {
    const months =
      e?.cumulative_months ?? e?.duration_months ?? e?.streak_months;
    let line =
      isGift && gifter
        ? `🎁 ${mention} a reçu un sub offert par **${gifter}** — merci !`
        : `⭐ ${mention} s'est réabonné (${months ? ` • ${months} mois` : ""})`;
    return line;
  }

  // channel.subscribe
  if (isGift && gifter) {
    return `🎁 ${mention} a reçu un sub  offert par **${gifter}**`;
  }
  return `⭐ Merci pour le nouvel abonnement mon ${mention} !`;
}
