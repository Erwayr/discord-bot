// ./script/tokenManager.js
const axios = require("axios");
const { FieldValue } = require("firebase-admin/firestore");

/** Gestion centralisée de l'access_token + refresh (rotatif).
 *  - Stocke { access_token, refresh_token, access_token_expires_at }
 *  - Sérialise le refresh pour éviter les courses
 *  - Utilise le flow officiel Twitch (POST form-urlencoded)  */
function createTokenManager(
  db,
  {
    docPath = "settings/twitch_moderator",
    clientId = process.env.TWITCH_CLIENT_ID,
    clientSecret = process.env.TWITCH_CLIENT_SECRET,
  } = {}
) {
  const ref = db.doc(docPath);
  let inFlight = null;

  async function getAccessToken() {
    const snap = await ref.get();
    const data = snap.data() || {};
    const now = Date.now();

    if (
      data.access_token &&
      data.access_token_expires_at &&
      now < data.access_token_expires_at - 60_000
    ) {
      return data.access_token;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const freshSnap = await ref.get();
      const fresh = freshSnap.data() || {};
      const oldRefresh = fresh.refresh_token;
      if (!oldRefresh)
        throw new Error(
          "Aucun refresh_token en base (settings/twitch_moderator.refresh_token)"
        );

      // Twitch recommande de rafraîchir REACTIVEMENT (sur 401), mais ce call est OK si besoin ponctuellement. :contentReference[oaicite:1]{index=1}
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: oldRefresh, // IMPORTANT: encodé via URLSearchParams. :contentReference[oaicite:2]{index=2}
      });

      const res = await axios
        .post("https://id.twitch.tv/oauth2/token", body, {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
        .catch((e) => {
          const msg = e.response?.data || e.message;
          throw new Error("Refresh failed: " + JSON.stringify(msg));
        });

      const {
        access_token,
        refresh_token: newRefresh,
        expires_in,
        scope,
      } = res.data;

      await ref.set(
        {
          access_token,
          refresh_token: newRefresh, // rotation
          access_token_expires_at: Date.now() + expires_in * 1000,
          rotated_at: FieldValue.serverTimestamp(),
          scopes: scope, // tableau de scopes retournés
          issuer_client_id: clientId,
        },
        { merge: true }
      );

      return access_token;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  return { getAccessToken };
}

module.exports = { createTokenManager };
