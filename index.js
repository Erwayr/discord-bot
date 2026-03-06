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
const { createWeeklyFollowersRecap } = require("./script/weeklyFollowersRecap");
const cron = require("node-cron");

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1377870229153120257";
const GENERAL_CHANNEL_ID =
  process.env.GENERAL_CHANNEL_ID || "797077170974490645";
const BOOTY_CHANNEL_ID = process.env.BOOTY_CHANNEL_ID || "948504568969449513";
const ANNOUNCEMENT_CHANNEL_ID =
  process.env.ANNOUNCEMENT_CHANNEL_ID || "827682574024966194";

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_CHANNEL_ID = process.env.TWITCH_CHANNEL_ID;
const TWITCH_MODERATOR_ID =
  process.env.TWITCH_MODERATOR_ID || TWITCH_CHANNEL_ID;
const TWITCH_CHANNEL_LOGIN = process.env.TWITCH_CHANNEL_LOGIN || "erwayr";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const TWITCH_TOKEN_DOC_PATH = "settings/twitch_moderator";
const TWITCH_EVENTSUB_CALLBACK =
  process.env.TWITCH_EVENTSUB_CALLBACK ||
  "https://discord-bot-production-95c5.up.railway.app/twitch-callback";
const TWITCH_OAUTH_REDIRECT =
  process.env.TWITCH_OAUTH_REDIRECT ||
  "https://discord-bot-production-95c5.up.railway.app/auth/twitch/callback";
const COLLECTION_URL = process.env.COLLECTION_URL || "https://erwayr.online";

const TIMEZONE = process.env.TIMEZONE || "Europe/Warsaw";
const BIRTHDAY_FIELD = process.env.BIRTHDAY_FIELD || "birthday";
const BIRTHDAY_INDEX_COLLECTION =
  process.env.BIRTHDAY_INDEX_COLLECTION || "birthdays_index";
const BIRTHDAY_INDEX_META_DOC =
  process.env.BIRTHDAY_INDEX_META_DOC || "settings/birthday_index_meta";
const BIRTHDAY_INDEX_MAX_AGE_HOURS = Number(
  process.env.BIRTHDAY_INDEX_MAX_AGE_HOURS || 0,
);
const BIRTHDAY_INDEX_FALLBACK_SCAN =
  process.env.BIRTHDAY_INDEX_FALLBACK_SCAN === "1";
const BIRTHDAY_DISPLAY_FIELDS = ["display_name", "displayName", "pseudo"];
const BIRTHDAY_INDEX_VERSION = 2;

const EVENTSUB_ENDPOINT = "https://api.twitch.tv/helix/eventsub/subscriptions";
const OAUTH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const OAUTH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const HELIX_CHATTERS_URL = "https://api.twitch.tv/helix/chat/chatters";
const HELIX_CHAT_MESSAGES_URL = "https://api.twitch.tv/helix/chat/messages";
const HELIX_EMOTES_URL = "https://api.twitch.tv/helix/chat/emotes";

const CRON_POLL_CLIPS = "*/5 * * * *";
const CRON_TOKEN_KEEPALIVE = "*/15 * * * *";
const CRON_LIVE_PRESENCE = "*/2 * * * *";
const CRON_BIRTHDAY_REFRESH = "0 0 * * *";
const CRON_ASSIGN_OLD_MEMBER_CARDS = "0 0 * * *";
const CRON_EMOTE_REFRESH = "0 */6 * * *";
const CRON_WEEKLY_RECAP = process.env.CRON_WEEKLY_RECAP || "0 9 * * 1";
const WEEKLY_RECAP_EXCLUDED_LOGINS = String(
  process.env.WEEKLY_RECAP_EXCLUDED_LOGINS || "erwayr",
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const WEEKLY_RECAP_BONUS_PCT = Number(process.env.WEEKLY_RECAP_BONUS_PCT || 10);

const EMOTE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
const LIVE_STATE_REFRESH_MIN_INTERVAL_MS = 60_000;
const LIVE_STATE_CACHE_MS = 2 * 60 * 1000;

const SUB_DEBOUNCE_MS = 3500;
const SUB_COOLDOWN_MS = 10_000;
const OFFLINE_CONFIRM_TICKS = 2;
const BATCH_SIZE = 10;

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
  docPath: TWITCH_TOKEN_DOC_PATH,
});
const helix = makeHelix({
  tokenManager,
  clientId: TWITCH_CLIENT_ID,
});

// ---- ensuite seulement le livePresenceTicker (on lui passe questStore) ----
const livePresenceTick = createLivePresenceTicker({
  db,
  tokenManager,
  clientId: TWITCH_CLIENT_ID,
  broadcasterId: TWITCH_CHANNEL_ID,
  moderatorId: TWITCH_MODERATOR_ID,
  questStore, // ✅ maintenant défini
});

// ---- puis le clip poller qui dépend de questStore ET du ticker ----
const pollClipsTick = createClipPoller({
  tokenManager,
  questStore,
  livePresenceTick,
  clientId: TWITCH_CLIENT_ID,
  broadcasterId: TWITCH_CHANNEL_ID,
});

cron.schedule(CRON_POLL_CLIPS, pollClipsTick);

cron.schedule(CRON_TOKEN_KEEPALIVE, async () => {
  try {
    const snap = await db.doc("settings/twitch_moderator").get();
    const s = snap.exists ? snap.data() : null;
    if (s?.issuer_client_id && s.issuer_client_id !== TWITCH_CLIENT_ID) {
      console.error(
        "❌ Client-ID mismatch: token lié à",
        s.issuer_client_id,
        "mais env TWITCH_CLIENT_ID =",
        TWITCH_CLIENT_ID,
        "→ refais /auth/twitch/start avec le bon client ou corrige l'env.",
      );
    }
    await ensureValidUserAccessToken({ source: "cron:token_keepalive" });
  } catch (e) {
    if (e.code === "NO_REFRESH_TOKEN") {
      console.log("⏭️ [keepalive] no refresh_token yet");
    } else {
      console.warn("⚠️ token keep-alive:", e?.response?.data || e.message || e);
      await notifyAuthIssueToLog({
        source: "cron:token_keepalive",
        code: e?.code || "KEEPALIVE_FAILED",
        status: e?.response?.status || null,
        details: shortText(e?.response?.data || e?.stack || e?.message || e),
      });
    }
  }
});

let announcedStreamId = null;
let announcedStartedAt = null;
let offlineStreak = 0;

cron.schedule(CRON_LIVE_PRESENCE, async () => {
  try {
    await livePresenceTick();
  } catch (e) {
    console.warn(
      "⚠️ [livePresenceTick] failed:",
      e?.response?.data || e.message || e,
    );
    return;
  }

  const { streamId, startedAt } = livePresenceTick.getLiveStreamState();
  const currentId = streamId || null;

  if (currentId) {
    offlineStreak = 0;

    if (announcedStreamId !== currentId) {
      // 1er tick live OU nouveau streamId
      announcedStreamId = currentId;
      announcedStartedAt = startedAt || null;

      console.log(
        `🟢 [LIVE] start (streamId=${announcedStreamId}, startedAt=${
          announcedStartedAt ? announcedStartedAt.toISOString() : "-"
        })`,
      );
    }
    return;
  }

  // offline
  offlineStreak += 1;
  if (announcedStreamId && offlineStreak === OFFLINE_CONFIRM_TICKS) {
    console.log(
      `🔴 [LIVE] end (streamId=${announcedStreamId}, startedAt=${
        announcedStartedAt ? announcedStartedAt.toISOString() : "-"
      })`,
    );
    announcedStreamId = null;
    announcedStartedAt = null;
  }
});

// ID du salon de logs

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

const sendWeeklyFollowersRecap = createWeeklyFollowersRecap({
  db,
  client,
  defaultChannelId: ANNOUNCEMENT_CHANNEL_ID,
  timeZone: TIMEZONE,
  limit: 10,
  excludedLogins: WEEKLY_RECAP_EXCLUDED_LOGINS,
  questBonusPct: WEEKLY_RECAP_BONUS_PCT,
  headerText: "✨ Meilleurs Loulou de la semaine passee ✨",
});

const app = express();
app.use(bodyParser.json()); // pour parser les JSON Twitch

// Monte les routes d'auth
mountTwitchAuth(app, db, {
  docPath: TWITCH_TOKEN_DOC_PATH,
  clientId: TWITCH_CLIENT_ID,
  clientSecret: TWITCH_CLIENT_SECRET,
  redirectUri: TWITCH_OAUTH_REDIRECT,
});

const TWITCH_SECRET = WEBHOOK_SECRET;

const seenDeliveries = new Map(); // messageId -> ts (TTL court)
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
      await postDiscord(BOOTY_CHANNEL_ID, text);
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
  await postDiscord(BOOTY_CHANNEL_ID, text);
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
    Buffer.from(signature),
  );
}

async function fetchAppAccessToken() {
  const { data } = await axios.post(OAUTH_TOKEN_URL, null, {
    params: {
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    },
  });
  return data.access_token;
}

function buildTwitchHeaders(accessToken, { includeContentType = true } = {}) {
  const headers = {
    "Client-ID": TWITCH_CLIENT_ID,
    Authorization: `Bearer ${accessToken}`,
  };
  if (includeContentType) headers["Content-Type"] = "application/json";
  return headers;
}

function shortText(value, max = 1200) {
  return String(value || "").trim().slice(0, max);
}

function isRecoverableInvalidTokenError(error) {
  const status = error?.response?.status;
  if (status !== 401) return false;

  const msg = String(error?.response?.data?.message || "");
  const header = String(error?.response?.headers?.["www-authenticate"] || "");
  const text = `${header} ${msg}`.toLowerCase();
  return (
    /invalid[_\s-]?token/.test(text) ||
    /invalid\s+oauth\s+token/.test(text) ||
    /token.*expired/.test(text)
  );
}

async function notifyAuthIssueToLog({
  source = "unknown",
  code = "TWITCH_AUTH_ISSUE",
  status = null,
  details = "",
  level = "error",
} = {}) {
  const icon = level === "warning" ? "⚠️" : "🚨";
  const body =
    `${icon} **Twitch auth issue**\n` +
    `• **Source:** ${shortText(source, 120)}\n` +
    `• **Code:** ${shortText(code, 80)}\n` +
    `• **Status:** ${status ?? "-"}\n` +
    `• **At:** ${new Date().toISOString()}\n` +
    `• **Details:** ${shortText(details || "n/a", 1500)}`;

  try {
    if (!client?.isReady?.()) {
      console.warn("[auth-alert] discord client not ready:", body);
      return false;
    }
    await postDiscord(LOG_CHANNEL_ID, body);
    return true;
  } catch (e) {
    console.warn(
      "[auth-alert] log-channel send failed:",
      e?.response?.data || e.message || e,
    );
    return false;
  }
}

async function validateUserAccessToken(accessToken) {
  await axios.get(OAUTH_VALIDATE_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
    timeout: 10000,
  });
}

async function ensureValidUserAccessToken({ source = "internal" } = {}) {
  let accessToken = await tokenManager.getAccessToken();
  try {
    await validateUserAccessToken(accessToken);
    return accessToken;
  } catch (err) {
    if (!isRecoverableInvalidTokenError(err)) throw err;

    console.warn(
      "[oauth] token invalide/expire detecte -> invalidate + refresh + revalidate",
    );
    await tokenManager.invalidateAccessToken();
    accessToken = await tokenManager.getAccessToken();
    await validateUserAccessToken(accessToken);
    await notifyAuthIssueToLog({
      source,
      code: "TWITCH_TOKEN_RECOVERED",
      status: 401,
      details: "Token invalide detecte puis regenere automatiquement.",
      level: "warning",
    });
    return accessToken;
  }
}

app.get("/internal/twitch/access-token", async (req, res) => {
  if (req.header("x-api-key") !== INTERNAL_API_KEY) {
    return res.status(403).send("Forbidden");
  }
  try {
    const accessToken = await ensureValidUserAccessToken({
      source: "internal/twitch/access-token",
    });
    res.json({ access_token: accessToken });
  } catch (e) {
    await notifyAuthIssueToLog({
      source: "internal/twitch/access-token",
      code: e?.code || "TOKEN_ENDPOINT_FAILED",
      status: e?.response?.status || null,
      details: shortText(e?.response?.data || e?.stack || e?.message || e),
    });
    res.status(500).json({ error: e.code || "ERROR", message: e.message });
  }
});

app.post("/internal/alerts/twitch-auth", async (req, res) => {
  if (req.header("x-api-key") !== INTERNAL_API_KEY) {
    return res.status(403).send("Forbidden");
  }
  const payload = req.body || {};
  await notifyAuthIssueToLog({
    source: payload.source || "external",
    code: payload.code || "TWITCH_AUTH_ALERT",
    status:
      Number.isFinite(Number(payload.status)) && payload.status !== null
        ? Number(payload.status)
        : null,
    details: payload.details || "",
    level: payload.level || "error",
  });
  return res.json({ ok: true });
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
      `🎯 Redemption: user=${r.user_login} rewardId=${r.reward?.id} title="${r.reward?.title}" isTicket=${isTicket}`,
    );

    // 2) Si c’est le ticket → on fait le fulfill + upserts
    if (isTicket) {
      try {
        const accessToken = await tokenManager.getAccessToken();
        await updateRedemptionStatus({
          broadcasterId: TWITCH_CHANNEL_ID,
          rewardId: r.reward.id,
          redemptionIds: [r.id],
          status: "FULFILLED",
          accessToken,
        });
        await upsertParticipantFromRedemption(db, r);
        try {
          const generalChannel = await client.channels.fetch(BOOTY_CHANNEL_ID);
          if (generalChannel?.isTextBased()) {
            await generalChannel.send(
              `📜 Note prise : participation de ${r.user_name} confirmée — **${r.reward.title}** 🎟️`,
            );
          }
        } catch (e) {
          console.warn("Discord notify failed:", e.message);
        }
      } catch (e) {
        console.error(
          "Fulfill+participant error:",
          e.response?.data || e.message,
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
          `⏭️ ChannelPoints ignoré (login=${login} streamId=${streamId || "-"})`,
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
        `⭐ Sub enregistré pour ${event.user_login || event.user?.login}`,
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
        `🔁 Resub enregistré pour ${event.user_login || event.user?.login}`,
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
      const headers = buildTwitchHeaders(accessToken, {
        includeContentType: false,
      });

      const logins = [];
      let after = null,
        guard = 0;
      do {
        const { data } = await axios.get(HELIX_CHATTERS_URL, {
          headers,
          params: after
            ? {
                broadcaster_id: TWITCH_CHANNEL_ID,
                moderator_id: TWITCH_MODERATOR_ID,
                first: 1000,
                after,
              }
            : {
                broadcaster_id: TWITCH_CHANNEL_ID,
                moderator_id: TWITCH_MODERATOR_ID,
                first: 1000,
              },
        });
        (data?.data || []).forEach(
          (c) => c?.user_login && logins.push(c.user_login.toLowerCase()),
        );
        after = data?.pagination?.cursor || null;
      } while (after && ++guard < 5);

      await Promise.all(
        logins.map((login) =>
          questStore.noteRaidParticipation(login, streamId),
        ),
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
    try {
      await guild.members.fetch({ withPresences: false, time: 300_000 });
      console.log(`🔄 Membres chargés pour la guilde : ${guild.name}`);
    } catch (e) {
      console.warn(
        `⚠️ guild.members.fetch timeout pour ${guild.name}:`,
        e?.code || e?.message || e,
      );
    }
  }

  await assignOldMemberCards(db).catch(console.error);

  // Planification quotidienne à minuit
  cron.schedule(CRON_ASSIGN_OLD_MEMBER_CARDS, () =>
    assignOldMemberCards(db).catch(console.error),
  );
  cron.schedule(
    CRON_WEEKLY_RECAP,
    () =>
      sendWeeklyFollowersRecap({ channelId: LOG_CHANNEL_ID }).catch((e) =>
        console.error("[weekly-recap] cron failed:", e?.message || e),
      ),
    { timezone: TIMEZONE },
  );
  console.log(
    `[weekly-recap] scheduled (${CRON_WEEKLY_RECAP}, tz=${TIMEZONE}) -> ${LOG_CHANNEL_ID}`,
  );

  const processingQueues = new Map();

  db.collection("followers_all_time").onSnapshot(
    (snapshot) => {
      const skipAddedForBirthday = !birthdayFollowerSeeded;
      snapshot.docChanges().forEach((change) => {
        handleBirthdayFollowerChange(change, {
          skipAdded: skipAddedForBirthday,
        });

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
            const collectionUrl = COLLECTION_URL;
            const baseMsg = card.title
              ? `🎉 Tu viens de gagner la carte **${card.title}** !`
              : `🎉 Tu viens de gagner une nouvelle carte !`;
            const dmMsg = `${baseMsg}\n👉 Ta collection : ${collectionUrl}`;
            console.log(
              `🃏 [Card] ${data.pseudo} won "${card.title || "unknown"}"`,
            );

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
      if (!birthdayFollowerSeeded) birthdayFollowerSeeded = true;
    },
    (err) => console.error("Listener Firestore error:", err),
  );
});

const tmi = require("tmi.js");

let CHANNEL_EMOTE_IDS = new Set();
let CHANNEL_EMOTE_NAMES = new Set();
let lastEmoteRefreshAt = 0;
let lastLiveStateFetchAt = 0;
let liveStreamStateCache = { streamId: null, startedAt: null, cachedAt: 0 }; // 👈 nouveau

async function refreshChannelEmotes() {
  try {
    const { data } = await helix({
      url: HELIX_EMOTES_URL,
      params: { broadcaster_id: TWITCH_CHANNEL_ID },
    });
    const list = data?.data || [];
    CHANNEL_EMOTE_IDS = new Set(list.map((e) => String(e.id)));
    CHANNEL_EMOTE_NAMES = new Set(list.map((e) => e.name));
    const sample = list
      .slice(0, 5)
      .map((e) => e.name)
      .join(", ");
    console.log(
      `🎭 Emotes de chaîne chargées: ${CHANNEL_EMOTE_IDS.size} (sample: ${
        sample || "—"
      })`,
    );
  } catch (e) {
    console.warn("⚠️ refreshChannelEmotes:", e?.response?.data || e.message);
  }
}

async function refreshChannelEmotesThrottled() {
  const now = Date.now();
  if (now - lastEmoteRefreshAt < EMOTE_REFRESH_MIN_INTERVAL_MS) return;
  lastEmoteRefreshAt = now;
  await refreshChannelEmotes();
}

// TMI en anonyme (lecture seule)
const tmiClient = new tmi.Client({
  options: { debug: false },
  connection: { reconnect: true, secure: true },
  channels: [TWITCH_CHANNEL_LOGIN], // ex: "erwayr"
});
let birthdayToday = new Map(); // login -> displayName
let birthdayCongratulated = new Set(); // "YYYY-MM-DD|login"
let birthdayDateKey = "";
let birthdayFollowerState = new Map(); // login -> { dayKey, display }
let birthdayFollowerSeeded = false;
const birthdaySyncQueues = new Map();
tmiClient.connect().catch(console.error);
refreshTodayBirthdays().catch(console.error);
cron.schedule(
  CRON_BIRTHDAY_REFRESH,
  () => refreshTodayBirthdays().catch(console.error),
  { timezone: TIMEZONE },
);
//
tmiClient.on("connected", async () => {
  await refreshChannelEmotesThrottled();
});

cron.schedule(CRON_EMOTE_REFRESH, () =>
  refreshChannelEmotesThrottled().catch(console.error),
);

async function fetchLiveStreamState() {
  const { data } = await helix({
    url: "https://api.twitch.tv/helix/streams",
    params: { user_id: TWITCH_CHANNEL_ID, first: 1 },
  });
  const s = data?.data?.[0];
  const now = Date.now();

  if (!s) {
    liveStreamStateCache = { streamId: null, startedAt: null, cachedAt: now };
    return null;
  }

  const startedAt = s.started_at ? new Date(s.started_at) : null;
  liveStreamStateCache = { streamId: s.id, startedAt, cachedAt: now };
  return { streamId: s.id, startedAt };
}

async function getLiveStreamStateForEmotes() {
  const state = livePresenceTick.getLiveStreamState();
  if (state.streamId) {
    liveStreamStateCache = {
      streamId: state.streamId,
      startedAt: state.startedAt || null,
      cachedAt: Date.now(),
    };
    return state;
  }

  const now = Date.now();
  if (
    liveStreamStateCache.streamId &&
    now - liveStreamStateCache.cachedAt < LIVE_STATE_CACHE_MS
  ) {
    return {
      streamId: liveStreamStateCache.streamId,
      startedAt: liveStreamStateCache.startedAt,
    };
  }

  if (now - lastLiveStateFetchAt < LIVE_STATE_REFRESH_MIN_INTERVAL_MS) {
    return { streamId: null, startedAt: null };
  }

  lastLiveStateFetchAt = now;

  try {
    return (
      (await fetchLiveStreamState()) || {
        streamId: null,
        startedAt: null,
      }
    );
  } catch (e) {
    if (process.env.DEBUG_EMOTES) {
      console.warn(
        "[emotes] live stream fetch failed:",
        e?.response?.data || e?.message || e,
      );
    }
    return { streamId: null, startedAt: null };
  }
}

/* =======================
   Birthday → Twitch Chat
======================= */

// Date (Warsaw) -> YYYY-MM-DD
function getWarsawParts(date) {
  const fmt = new Intl.DateTimeFormat("fr-FR", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const parts = fmt.formatToParts(date);
  const out = { year: 0, month: 0, day: 0 };
  for (const p of parts) {
    if (p.type === "year") out.year = parseInt(p.value, 10);
    if (p.type === "month") out.month = parseInt(p.value, 10);
    if (p.type === "day") out.day = parseInt(p.value, 10);
  }
  return out;
}

function warsawDateKey(date = new Date()) {
  const p = getWarsawParts(date);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

function parseBirthday(value) {
  if (!value) return null;

  // Firestore Timestamp (admin) => toDate()
  if (typeof value === "object" && typeof value.toDate === "function") {
    const d = value.toDate();
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      const p = getWarsawParts(d);
      return { month: p.month, day: p.day };
    }
  }

  // Date
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const p = getWarsawParts(value);
    return { month: p.month, day: p.day };
  }

  // string YYYY-MM-DD / DD-MM-YYYY / DD-MM (comme ton overlay)
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;

    let m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
    if (m) return { month: parseInt(m[2], 10), day: parseInt(m[3], 10) };

    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) return { month: parseInt(m[2], 10), day: parseInt(m[1], 10) };

    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})$/);
    if (m) return { month: parseInt(m[2], 10), day: parseInt(m[1], 10) };

    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const p = getWarsawParts(d);
      return { month: p.month, day: p.day };
    }
  }

  return null;
}

function pickDisplayNameFromDoc(docId, data) {
  return data?.display_name || data?.displayName || data?.pseudo || docId;
}

function birthdayFollowersQuery() {
  const fields = Array.from(
    new Set([BIRTHDAY_FIELD, ...BIRTHDAY_DISPLAY_FIELDS]),
  );
  return db.collection("followers_all_time").select(...fields);
}

function monthDayKeyFromParts(month, day) {
  const mm = String(month || "").padStart(2, "0");
  const dd = String(day || "").padStart(2, "0");
  return `${mm}-${dd}`;
}

function toMillisMaybe(value) {
  if (!value) return 0;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof value === "object" && typeof value.toDate === "function") {
    const d = value.toDate();
    if (!(d instanceof Date)) return 0;
    const ms = d.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

function birthdayStateFromDoc(docId, data) {
  const login = String(docId || "").toLowerCase();
  const display = String(pickDisplayNameFromDoc(docId, data) || login);
  const bd = parseBirthday(data?.[BIRTHDAY_FIELD]);
  if (!bd) return { dayKey: "", display };
  const dayKey = monthDayKeyFromParts(bd.month, bd.day);
  if (!dayKey || dayKey === "00-00") return { dayKey: "", display };
  return { dayKey, display };
}

function isSameBirthdayState(a, b) {
  return (
    String(a?.dayKey || "") === String(b?.dayKey || "") &&
    String(a?.display || "") === String(b?.display || "")
  );
}

function removeBirthdayListEntry(list, login) {
  return list.filter(
    (entry) => String(entry?.login || "").toLowerCase() !== login,
  );
}

function upsertBirthdayListEntry(list, login, display) {
  const next = removeBirthdayListEntry(list, login);
  next.push({ login, display });
  return next;
}

async function syncBirthdayIndexEntry(login, prevState, nextState) {
  if (!login) return;
  if (isSameBirthdayState(prevState, nextState)) return;

  const oldDayKey = String(prevState?.dayKey || "");
  const newDayKey = String(nextState?.dayKey || "");
  const newDisplay = String(nextState?.display || login);
  if (!oldDayKey && !newDayKey) return;

  await db.runTransaction(async (tx) => {
    const touchedDayKeys = Array.from(
      new Set([oldDayKey, newDayKey].filter(Boolean)),
    );
    const refs = new Map();
    const lists = new Map();

    for (const dayKey of touchedDayKeys) {
      const ref = db.collection(BIRTHDAY_INDEX_COLLECTION).doc(dayKey);
      refs.set(dayKey, ref);
      const snap = await tx.get(ref);
      const list = Array.isArray(snap.data()?.list) ? snap.data().list : [];
      lists.set(dayKey, list);
    }

    if (oldDayKey) {
      lists.set(
        oldDayKey,
        removeBirthdayListEntry(lists.get(oldDayKey) || [], login),
      );
    }
    if (newDayKey) {
      lists.set(
        newDayKey,
        upsertBirthdayListEntry(lists.get(newDayKey) || [], login, newDisplay),
      );
    }

    for (const dayKey of touchedDayKeys) {
      tx.set(
        refs.get(dayKey),
        {
          list: lists.get(dayKey) || [],
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  });

  const todayParts = getWarsawParts(new Date());
  const todayDayKey = monthDayKeyFromParts(todayParts.month, todayParts.day);
  if (oldDayKey === todayDayKey && newDayKey !== todayDayKey) {
    birthdayToday.delete(login);
  }
  if (newDayKey === todayDayKey) {
    birthdayToday.set(login, newDisplay);
  }
}

function enqueueBirthdayIndexSync(login, prevState, nextState) {
  const chain = (birthdaySyncQueues.get(login) || Promise.resolve())
    .then(() => syncBirthdayIndexEntry(login, prevState, nextState))
    .catch((e) =>
      console.warn("[birthday] incremental sync failed:", e?.message || e),
    )
    .finally(() => {
      if (birthdaySyncQueues.get(login) === chain) {
        birthdaySyncQueues.delete(login);
      }
    });
  birthdaySyncQueues.set(login, chain);
}

function handleBirthdayFollowerChange(change, { skipAdded = false } = {}) {
  const login = String(change?.doc?.id || "").toLowerCase();
  if (!login) return;

  const prevState = birthdayFollowerState.get(login) || null;
  let nextState = null;

  if (change.type !== "removed") {
    const data = change.doc.data() || {};
    nextState = birthdayStateFromDoc(change.doc.id, data);
    birthdayFollowerState.set(login, nextState);
  } else {
    birthdayFollowerState.delete(login);
  }

  if (skipAdded && change.type === "added") return;
  enqueueBirthdayIndexSync(login, prevState, nextState);
}

async function buildBirthdayIndex() {
  console.log("[birthday] build index...");

  const snap = await birthdayFollowersQuery().get();
  const index = new Map();

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const bd = parseBirthday(data[BIRTHDAY_FIELD]);
    if (!bd) return;

    const login = String(doc.id || "").toLowerCase();
    if (!login) return;

    const display = String(pickDisplayNameFromDoc(doc.id, data) || login);
    const dayKey = monthDayKeyFromParts(bd.month, bd.day);
    if (!dayKey || dayKey === "00-00") return;

    const arr = index.get(dayKey) || [];
    arr.push({ login, display });
    index.set(dayKey, arr);
  });

  let batch = db.batch();
  let ops = 0;
  const commits = [];

  for (const [dayKey, list] of index) {
    const ref = db.collection(BIRTHDAY_INDEX_COLLECTION).doc(dayKey);
    batch.set(
      ref,
      { list, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
    ops += 1;
    if (ops >= 400) {
      commits.push(batch.commit());
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) commits.push(batch.commit());
  await Promise.all(commits);

  await db.doc(BIRTHDAY_INDEX_META_DOC).set(
    {
      builtAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      days: index.size,
      version: BIRTHDAY_INDEX_VERSION,
    },
    { merge: true },
  );

  console.log(`[birthday] index built (${index.size} days)`);
}

// Envoi message Twitch via Helix
async function sendTwitchChatMessage(message) {
  const accessToken = await tokenManager.getAccessToken();

  const broadcasterId = TWITCH_CHANNEL_ID;
  const senderId = TWITCH_MODERATOR_ID; // doit matcher le user du token

  const { data } = await axios.post(
    HELIX_CHAT_MESSAGES_URL,
    {
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message,
    },
    {
      headers: buildTwitchHeaders(accessToken),
    },
  );

  const r = data?.data?.[0];
  if (!r?.is_sent) {
    console.warn("⚠️ Chat message dropped:", r?.drop_reason || r);
  }
}

// Recharge la liste “anniversaire aujourd’hui” (Warsaw)
async function refreshTodayBirthdays() {
  const now = new Date();
  const dk = warsawDateKey(now);
  const { month, day } = getWarsawParts(now);
  const dayKey = monthDayKeyFromParts(month, day);

  birthdayDateKey = dk;
  birthdayToday = new Map();

  let usedFallback = false;
  let needsRebuild = true;

  try {
    const metaSnap = await db.doc(BIRTHDAY_INDEX_META_DOC).get();
    if (metaSnap.exists) {
      const meta = metaSnap.data() || {};
      const version = Number(meta.version || 0);
      if (version >= BIRTHDAY_INDEX_VERSION) {
        needsRebuild = false;
        if (BIRTHDAY_INDEX_MAX_AGE_HOURS > 0) {
          const lastTs =
            toMillisMaybe(meta.updatedAt) || toMillisMaybe(meta.builtAt);
          if (lastTs) {
            const maxAgeMs = BIRTHDAY_INDEX_MAX_AGE_HOURS * 60 * 60 * 1000;
            if (Date.now() - lastTs > maxAgeMs) needsRebuild = true;
          }
        }
      }
    }
  } catch (e) {
    console.warn("[birthday] index meta read failed:", e?.message || e);
  }

  if (needsRebuild) {
    try {
      await buildBirthdayIndex();
    } catch (e) {
      console.warn("[birthday] index build failed:", e?.message || e);
      if (BIRTHDAY_INDEX_FALLBACK_SCAN) {
        const snap = await birthdayFollowersQuery().get();
        snap.forEach((doc) => {
          const data = doc.data() || {};
          const bd = parseBirthday(data[BIRTHDAY_FIELD]);
          if (!bd) return;
          if (bd.month !== month || bd.day !== day) return;

          const login = String(doc.id || "").toLowerCase();
          if (!login) return;

          const display = String(pickDisplayNameFromDoc(doc.id, data) || login);
          birthdayToday.set(login, display);
        });
        usedFallback = true;
      } else {
        console.warn(
          "[birthday] fallback scan disabled; birthdays list may be empty",
        );
      }
    }
  }

  if (!usedFallback) {
    try {
      const daySnap = await db
        .collection(BIRTHDAY_INDEX_COLLECTION)
        .doc(dayKey)
        .get();
      const list = daySnap.exists ? daySnap.data()?.list : null;
      if (Array.isArray(list)) {
        list.forEach((entry) => {
          const login = String(entry?.login || "").toLowerCase();
          if (!login) return;
          const display = String(entry?.display || login);
          birthdayToday.set(login, display);
        });
      }
    } catch (e) {
      console.warn("[birthday] index day read failed:", e?.message || e);
    }
  }

  console.log(`[birthday] Birthdays today (${dk}) = ${birthdayToday.size}`);
}

function buildBirthdayMessage(login, display) {
  // Personnalise ici
  return `🎂 Joyeux anniversaire @${login} ! Profite à fond de ta journée ✨`;
}

async function maybeSendBirthdayCongrats(login) {
  const dk = warsawDateKey(new Date());
  if (dk !== birthdayDateKey) {
    await refreshTodayBirthdays().catch((e) =>
      console.warn("refreshTodayBirthdays failed:", e?.message || e),
    );
  }

  if (!birthdayToday.has(login)) return;

  const key = `${dk}|${login}`;
  if (birthdayCongratulated.has(key)) return;

  const display = birthdayToday.get(login) || login;
  const msg = buildBirthdayMessage(login, display);

  await sendTwitchChatMessage(msg);
  birthdayCongratulated.add(key);
}

tmiClient.on("message", async (channel, tags, msg, self) => {
  if (self) return;
  const login = (tags.username || "").toLowerCase();
  if (!login) return;

  maybeSendBirthdayCongrats(login).catch((e) =>
    console.warn("birthday congrats failed:", e?.message || e),
  );

  if (!CHANNEL_EMOTE_IDS.size && !CHANNEL_EMOTE_NAMES.size) {
    await refreshChannelEmotesThrottled();
  }

  const liveState = await getLiveStreamStateForEmotes();
  const streamId = liveState.streamId;
  if (!streamId) {
    if (process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:skip] no live streamId | from=${login} msg="${msg.slice(0, 80)}"`,
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
        80,
      )}"`,
    );
    if (emotesObj) {
      const keys = Object.keys(emotesObj);
      console.log(`  keys=${keys.join(",") || "(none)"}`);
      keys.slice(0, 8).forEach((id) => {
        const tag = CHANNEL_EMOTE_IDS.has(String(id)) ? "mine" : "other";
        console.log(
          `  └ id=${id} tag=${tag} count=${emotesObj[id]?.length || 0}`,
        );
      });
    }
    if (CHANNEL_EMOTE_IDS.size === 0) {
      console.log(
        "⚠️ CHANNEL_EMOTE_IDS est vide — refreshChannelEmotes n'a peut-être pas marché.",
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
          80,
        )}"`,
      );
      try {
        await questStore.noteEmoteUsage(login, streamId, incByName);
        console.log(
          `[emotes→DB] OK fallback-name | ${login} +${incByName} stream=${streamId}`,
        );
      } catch (e) {
        console.error(
          `[emotes→DB] FAIL fallback-name | ${login} +${incByName} stream=${streamId}`,
        );
        console.error(e?.stack || e?.message || e);
      }
    } else if (process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:skip] no twitch emote & no fallback-name match | from=${login}`,
      );
    }
    return;
  }

  // --- Cas 2: TMI a reconnu des émotes Twitch ---
  const idsInMsg = Object.keys(emotesObj);
  const hasChannelList = CHANNEL_EMOTE_IDS.size > 0;
  const matchedIds = hasChannelList
    ? idsInMsg.filter((id) => CHANNEL_EMOTE_IDS.has(String(id)))
    : idsInMsg;
  let inc = matchedIds.reduce(
    (sum, id) => sum + (emotesObj[id]?.length || 0),
    0,
  );

  if (!hasChannelList && inc > 0 && process.env.DEBUG_EMOTES) {
    console.log(
      `[emotes:unfiltered] ${login} +${inc} ids=${matchedIds.join(",")}`,
    );
  }

  // Fallback par NOM si inc==0
  if (inc === 0 && CHANNEL_EMOTE_NAMES.size) {
    for (const token of msg.split(/\s+/)) {
      if (CHANNEL_EMOTE_NAMES.has(token)) inc += 1;
    }
    if (inc > 0) {
      console.log(
        `[emotes:fallback-name] ${login} +${inc} msg="${msg.slice(0, 80)}"`,
      );
    }
  }

  if (inc <= 0) {
    if (process.env.DEBUG_EMOTES) {
      console.log(
        `[emotes:skip] detected emotes but none are YOUR channel emotes | from=${login}`,
      );
    }
    return;
  }

  const idsLabel =
    matchedIds.join(",") || (hasChannelList ? "-" : "unfiltered");
  console.log(
    `[emotes] ${login} +${inc} (ids=${idsLabel}) msg="${msg.slice(0, 80)}"`,
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
  const endpoint = EVENTSUB_ENDPOINT;
  const appToken = await fetchAppAccessToken();
  const headers = buildTwitchHeaders(appToken);

  const list = await axios.get(endpoint, { headers });
  const exists = list.data.data.find(
    (s) =>
      s.type === "channel.raid" &&
      s.condition?.from_broadcaster_user_id === TWITCH_CHANNEL_ID,
  );
  if (exists) return;

  await axios.post(
    endpoint,
    {
      type: "channel.raid",
      version: "1",
      condition: { from_broadcaster_user_id: TWITCH_CHANNEL_ID },
      transport: {
        method: "webhook",
        callback: TWITCH_EVENTSUB_CALLBACK,
        secret: WEBHOOK_SECRET,
      },
    },
    { headers },
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
          `📩 **DM de ${user.tag}** à <t:${now}:F> :\n> ${content}`,
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
  handleVoteChange(r, u, true, db),
);
client.on(Events.MessageReactionRemove, (r, u) =>
  handleVoteChange(r, u, false, db),
);

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;

  await messageCountHandler(message, db); // 🔄 Mise à jour du compteur

  await electionHandler(message, db, GENERAL_CHANNEL_ID);
  if (message.content.trim() === "!weeklyrecap") {
    const canRun = message.member?.permissions?.has("ManageGuild");
    if (!canRun) {
      await message.reply(
        "❌ Tu n'as pas la permission pour lancer le recap hebdo.",
      );
      return;
    }

    try {
      await sendWeeklyFollowersRecap({
        channelId: LOG_CHANNEL_ID,
      });
      await message.react("\u2705").catch(() => {});
    } catch (e) {
      console.error("[weekly-recap] manual run failed:", e?.message || e);
      await message.reply("❌ Impossible de générer le recap hebdo.");
    }
    return;
  }

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
    (act) => act.type === ActivityType.Playing,
  );
  if (!playing) return;
});

client.login(DISCORD_BOT_TOKEN);

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
    let members;
    try {
      members = await guild.members.fetch({
        withPresences: false,
        time: 300_000,
      });
    } catch (e) {
      console.warn(
        `⚠️ members.fetch (assignOldMemberCards) a échoué, fallback cache:`,
        e?.code || e?.message || e,
      );
      members = guild.members.cache;
    }

    members.forEach((m) => {
      if (!m.user.bot && m.joinedTimestamp && m.joinedTimestamp < oneYearAgo) {
        eligibleIds.push(m.id);
      }
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
        `🎉 Carte "discord_old_member" attribuée à ${data.discord_id}`,
      );
    });

    await batch.commit();
    console.log(`✅ Batch de ${chunk.length} membres traité.`);
  }
}

async function subscribeToFollows() {
  const endpoint = EVENTSUB_ENDPOINT;

  const appToken = await fetchAppAccessToken();
  const headers = buildTwitchHeaders(appToken);

  const listRes = await axios.get(endpoint, { headers });
  const existing = listRes.data.data.find(
    (sub) =>
      sub.type === "channel.follow" &&
      sub.version === "2" &&
      sub.condition.broadcaster_user_id === TWITCH_CHANNEL_ID &&
      sub.condition.moderator_user_id === TWITCH_CHANNEL_ID,
  );
  if (existing) {
    return;
  }

  const payload = {
    type: "channel.follow",
    version: "2",
    condition: {
      broadcaster_user_id: TWITCH_CHANNEL_ID,
      moderator_user_id: TWITCH_CHANNEL_ID,
    },
    transport: {
      callback: TWITCH_EVENTSUB_CALLBACK,
      method: "webhook",
      secret: WEBHOOK_SECRET,
    },
  };

  await axios.post(endpoint, payload, { headers });
}

async function subscribeToRedemptions() {
  const endpoint = EVENTSUB_ENDPOINT;

  const appToken = await fetchAppAccessToken();
  const headers = buildTwitchHeaders(appToken);

  // (debug) lister ce qui existe deja
  const list = await axios.get(endpoint, { headers });
  const exists = list.data.data.find(
    (s) =>
      s.type === "channel.channel_points_custom_reward_redemption.add" &&
      s.condition?.broadcaster_user_id === TWITCH_CHANNEL_ID,
  );
  if (exists) {
    console.log("? EventSub redemption.add d?j? pr?sent:", exists.id);
    return;
  }

  const payload = {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    transport: {
      method: "webhook",
      callback: TWITCH_EVENTSUB_CALLBACK,
      secret: WEBHOOK_SECRET,
    },
  };

  const created = await axios.post(endpoint, payload, { headers });
  console.log("? EventSub redemption.add cr??:", created.data.data?.[0]?.id);
}

// AJOUTE ça dans index.js (à côté des autres subscribeTo*)
async function subscribeToSubs() {
  const endpoint = EVENTSUB_ENDPOINT;
  const appToken = await fetchAppAccessToken();
  const headers = buildTwitchHeaders(appToken);

  const list = await axios.get(endpoint, { headers });
  const ensure = async (type) => {
    const exists = list.data.data.find(
      (s) =>
        s.type === type &&
        s.condition?.broadcaster_user_id === TWITCH_CHANNEL_ID,
    );
    if (exists) return;
    await axios.post(
      endpoint,
      {
        type,
        version: "1",
        condition: { broadcaster_user_id: TWITCH_CHANNEL_ID },
        transport: {
          method: "webhook",
          callback: TWITCH_EVENTSUB_CALLBACK,
          secret: WEBHOOK_SECRET,
        },
      },
      { headers },
    );
  };

  await ensure("channel.subscribe");
  await ensure("channel.subscription.message");
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
