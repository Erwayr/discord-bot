// tokenManager.js
const axios = require("axios");
const { FieldValue } = require("firebase-admin/firestore");

function createTokenManager(
  db,
  {
    docPath = "settings/twitch_broadcaster", // ou twitch_moderator si tu veux garder le nom
    clientId = process.env.TWITCH_CLIENT_ID,
    clientSecret = process.env.TWITCH_CLIENT_SECRET,
  } = {}
) {
  const ref = db.doc(docPath);
  let inFlight = null;

  async function getAccessToken() {
    // 1) lire l'état courant
    const snap = await ref.get();
    const data = snap.data() || {};
    const now = Date.now();
    if (
      data.access_token &&
      data.access_token_expires_at &&
      now < data.access_token_expires_at - 60_000
    ) {
      return data.access_token; // encore valide > 60s
    }

    // 2) éviter les refresh concurrents dans le même process
    if (inFlight) return inFlight;

    inFlight = (async () => {
      // re-lire pour être sûr d'avoir la dernière version (autre process ?)
      const freshSnap = await ref.get();
      const fresh = freshSnap.data() || {};
      const oldRefresh = fresh.refresh_token;
      if (!oldRefresh) throw new Error("Aucun refresh_token en base");

      // 3) rafraîchir une seule fois
      const res = await axios
        .post("https://id.twitch.tv/oauth2/token", null, {
          params: {
            grant_type: "refresh_token",
            refresh_token: oldRefresh,
            client_id: clientId,
            client_secret: clientSecret,
          },
        })
        .catch((e) => {
          // message plus clair en log
          const msg = e.response?.data || e.message;
          throw new Error("Refresh failed: " + JSON.stringify(msg));
        });

      const { access_token, refresh_token: newRefresh, expires_in } = res.data;

      await ref.set(
        {
          access_token,
          refresh_token: newRefresh, // 🔁 rotation !
          access_token_expires_at: Date.now() + expires_in * 1000,
          rotated_at: FieldValue.serverTimestamp(),
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
