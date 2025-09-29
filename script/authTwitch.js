// ./script/authTwitch.js
const axios = require("axios");
const crypto = require("crypto");
const { FieldValue } = require("firebase-admin/firestore");

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

// Scopes larges — ne demander que ce dont tu as besoin.
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

  // Moderators & moderation
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
  "chat:edit",
  "user:read:chat",
  "user:write:chat",
  "user:manage:chat_color",

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

function normalizeScopes(scope) {
  if (Array.isArray(scope)) return scope;
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  return [];
}

function sha256(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

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

  // 1) /auth/twitch/start?set=core|broad&force=0|1  (default=broad, force=1)
  app.get("/auth/twitch/start", async (req, res) => {
    const set = (req.query.set || "broad").toLowerCase();
    const scopes = set === "core" ? CORE_SCOPES : BROAD_SCOPES;
    const force = String(req.query.force ?? "1") === "1" ? "true" : "false";

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
      scope: scopes.join(" "),
      state,
      force_verify: force, // par défaut "true", désactivable via ?force=0
    });

    const url = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
    return res.redirect(url);
  });

  // 2) /auth/twitch/callback?code=...&state=...
  app.get("/auth/twitch/callback", async (req, res) => {
    const settingsRef = db.doc(docPath);
    try {
      const { code, state } = req.query;
      if (!code || !state) return res.status(400).send("Missing code or state");

      const stateSnap = await statesRef.doc(state).get();
      if (!stateSnap.exists) return res.status(400).send("Invalid state");

      // Échange code ↔ token (x-www-form-urlencoded)
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
          timeout: 10000,
        }
      );

      const {
        access_token,
        refresh_token,
        expires_in, // TTL théorique (souvent 3600)
        scope,
        token_type,
      } = tokenResp.data;

      // Validation pour obtenir un expires_in "réel" et les métadonnées
      let validated = null;
      try {
        const validate = await axios.get(
          "https://id.twitch.tv/oauth2/validate",
          {
            headers: { Authorization: `OAuth ${access_token}` },
            timeout: 10000,
          }
        );
        validated = validate.data || null;
      } catch (_) {
        // si 401/timeout, on garde expires_in de la réponse précédente
      }

      const atTtl = validated?.expires_in ?? expires_in ?? 3600;
      const atExpAt = Date.now() + atTtl * 1000;

      // Récupère l'ancien doc pour l'audit (hash du refresh précédent, compteur)
      const prevSnap = await settingsRef.get();
      const prev = prevSnap.exists ? prevSnap.data() : {};
      const prevRefresh = prev?.refresh_token || null;
      const prevHash = prevRefresh ? sha256(prevRefresh) : null;
      const prevCount =
        typeof prev?.refresh_rotation_count === "number"
          ? prev.refresh_rotation_count
          : 0;

      // Sauvegarde en base (normalisation scopes + métadonnées)
      await settingsRef.set(
        {
          access_token,
          token_type: token_type || "bearer",
          refresh_token, // 🔁 très important: on stocke le NOUVEAU
          refresh_token_sha256: sha256(refresh_token),
          prev_refresh_token_sha256: prevHash,
          refresh_rotation_count: prevCount + 1,
          access_token_expires_at: atExpAt,
          access_token_obtained_at: FieldValue.serverTimestamp(),
          refresh_token_obtained_at: FieldValue.serverTimestamp(),
          scopes: normalizeScopes(scope),
          validated: validated
            ? {
                user_id: validated.user_id,
                login: validated.login,
                validatedClient: validated.client_id,
                atTtl: validated.expires_in,
              }
            : null,
          token_source: "authorization_code",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // On invalide le state pour éviter toute réutilisation
      try {
        await statesRef.doc(state).delete();
      } catch (_) {}

      const login = validated?.login || validated?.user_id || "inconnu";
      const scopesTxt = normalizeScopes(scope).join(", ");

      return res.status(200).send(
        `<html><body style="font-family:sans-serif">
           <h2>✅ Twitch lié</h2>
           <p>Utilisateur: <b>${login}</b></p>
           <p>Scopes: ${scopesTxt || "(aucun)"}</p>
           <p>Tu peux fermer cette page.</p>
         </body></html>`
      );
    } catch (e) {
      const msg = e?.response?.data || e.message;
      // On n'efface le state qu'en cas de succès; en cas d'erreur on le garde pour debug.
      return res.status(500).send("Auth error: " + JSON.stringify(msg));
    }
  });
}

module.exports = { mountTwitchAuth, CORE_SCOPES, BROAD_SCOPES };
