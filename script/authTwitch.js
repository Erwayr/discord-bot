// ./script/authTwitch.js
const axios = require("axios");
const crypto = require("crypto");
const { FieldValue } = require("firebase-admin/firestore");

// https://discord-bot-production-95c5.up.railway.app/auth/twitch/start?set=core A lancer sur railway

// Scopes minimaux pour ton use-case: FULFILL + lecture rédemptions + subscriptions + chat
const CORE_SCOPES = [
  "channel:manage:redemptions",
  "channel:read:redemptions",
  "channel:read:subscriptions",
  "chat:read",
  "chat:edit",
  "channel:manage:moderators",
  "moderation:read",
  "moderator:manage:announcements",
  "moderator:manage:automod",
  "moderator:read:automod_settings",
  "moderator:manage:automod_settings",
  "moderator:read:banned_users",
  "moderator:manage:banned_users",
  "moderator:read:blocked_terms",
  "moderator:manage:blocked_terms",
  "moderator:manage:chat_messages",
  "moderator:read:chat_settings",
  "moderator:manage:chat_settings",
  "moderator:read:chatters",
  "moderator:read:followers",
  "channel:read:subscriptions",
  "user:read:follows",
  "user:read:subscriptions",
];

// Scopes "très large" (BROAD) — la plupart des opérations de chaîne/modération
// ⚠️ Twitch dit de NE DEMANDER que ce dont tu as besoin. :contentReference[oaicite:3]{index=3}
const BROAD_SCOPES = [
  // Analytics/Bits/Ads
  "analytics:read:extensions",
  "analytics:read:games",
  "bits:read",
  "channel:manage:ads",
  "channel:read:ads",

  // Broadcast/Extensions/Commercial/Goals/Schedule/Videos/VIPs
  "channel:manage:broadcast",
  "channel:manage:extensions",
  "channel:edit:commercial",
  "channel:read:goals",
  "channel:manage:schedule",
  "channel:manage:videos",
  "channel:read:vips",
  "channel:manage:vips",

  // Guest Star / Hype Train
  "channel:read:guest_star",
  "channel:manage:guest_star",
  "channel:read:hype_train",

  // Moderators & moderation (modération large)
  "channel:manage:moderators",
  "moderation:read",
  "moderator:manage:announcements",
  "moderator:manage:automod",
  "moderator:read:automod_settings",
  "moderator:manage:automod_settings",
  "moderator:read:banned_users",
  "moderator:manage:banned_users",
  "moderator:read:blocked_terms",
  "moderator:manage:blocked_terms",
  "moderator:manage:chat_messages",
  "moderator:read:chat_settings",
  "moderator:manage:chat_settings",
  "moderator:read:chatters",
  "moderator:read:followers",
  "moderator:read:guest_star",
  "moderator:manage:guest_star",
  "moderator:read:moderators",
  "moderator:read:shield_mode",
  "moderator:manage:shield_mode",
  "moderator:read:shoutouts",
  "moderator:manage:shoutouts",
  "moderator:read:suspicious_users",
  "moderator:read:unban_requests",
  "moderator:manage:unban_requests",
  "moderator:read:vips",
  "moderator:read:warnings",
  "moderator:manage:warnings",

  // Polls/Predictions/Raids/Redemptions/Subs
  "channel:read:polls",
  "channel:manage:polls",
  "channel:read:predictions",
  "channel:manage:predictions",
  "channel:manage:raids",
  "channel:read:redemptions",
  "channel:manage:redemptions",
  "channel:read:subscriptions",

  // Stream key (lecture)
  "channel:read:stream_key",

  // Clips
  "clips:edit",

  // Chat (IRC & API Chat)
  "chat:read",
  "chat:edit", // IRC
  "user:read:chat",
  "user:write:chat",
  "user:manage:chat_color", // API Chat

  // User/email/follows/subs info
  "user:read:email",
  "user:read:follows",
  "user:read:subscriptions",
  "user:read:blocked_users",
  "user:manage:blocked_users",
  "user:read:broadcast",
  "user:edit:broadcast",
  "user:edit",

  // Whispers
  "user:read:whispers",
  "user:manage:whispers",
];

// NB: La liste BROAD est basée sur la doc “Twitch Access Token Scopes” et couvre
// la majorité des scopes API/EventSub/IRC/Chat pertinents. :contentReference[oaicite:4]{index=4}

function mountTwitchAuth(
  app,
  db,
  {
    docPath = "settings/twitch_moderator",
    clientId = process.env.TWITCH_CLIENT_ID,
    clientSecret = process.env.TWITCH_CLIENT_SECRET,
    redirectUri = process.env.TWITCH_REDIRECT_URI,
  } = {}
) {
  const statesRef = db.collection("oauth_states");

  // 1) /auth/twitch/start?set=core|broad  (default=broad)
  app.get("/auth/twitch/start", async (req, res) => {
    const set = (req.query.set || "broad").toLowerCase();
    const scopes = set === "core" ? CORE_SCOPES : BROAD_SCOPES;

    const state = crypto.randomBytes(16).toString("hex");
    await statesRef.doc(state).set(
      {
        createdAt: FieldValue.serverTimestamp(),
        set,
        scopes,
      },
      { merge: true }
    );

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "), // espace → URL encodé par URLSearchParams côté navigateur
      state,
      force_verify: "true", // force le consentement visuel si déjà accordé :contentReference[oaicite:5]{index=5}
    });

    const url = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
    return res.redirect(url);
  });

  // 2) /auth/twitch/callback?code=...&state=...
  app.get("/auth/twitch/callback", async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code || !state) return res.status(400).send("Missing code or state");

      const stateSnap = await statesRef.doc(state).get();
      if (!stateSnap.exists) return res.status(400).send("Invalid state");

      // Échange code ↔ token (body x-www-form-urlencoded) :contentReference[oaicite:6]{index=6}
      const tokenBody = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });

      const tokenResp = await axios.post(
        "https://id.twitch.tv/oauth2/token",
        tokenBody,
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );

      const { access_token, refresh_token, expires_in, scope } = tokenResp.data;

      // Validation → récup user_id, login, client_id, scopes :contentReference[oaicite:7]{index=7}
      const validate = await axios.get("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${access_token}` },
      });

      const {
        user_id,
        login,
        client_id: validatedClient,
        expires_in: atTtl,
      } = validate.data || {};

      // Sauvegarde en base
      await db.doc(docPath).set(
        {
          access_token,
          refresh_token, // 🔁 très important: on stocke le NOUVEAU
          access_token_expires_at: Date.now() + expires_in * 1000,
          scopes: scope,
          validated: {
            user_id,
            login,
            validatedClient,
            atTtl,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).send(
        `<html><body style="font-family:sans-serif">
             <h2>✅ Twitch lié</h2>
             <p>Utilisateur: <b>${login || user_id}</b></p>
             <p>Scopes: ${Array.isArray(scope) ? scope.join(", ") : scope}</p>
             <p>Tu peux fermer cette page.</p>
           </body></html>`
      );
    } catch (e) {
      const msg = e.response?.data || e.message;
      return res.status(500).send("Auth error: " + JSON.stringify(msg));
    }
  });
}

module.exports = { mountTwitchAuth, CORE_SCOPES, BROAD_SCOPES };
