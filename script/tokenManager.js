// ./script/tokenManager.js
const axios = require("axios");
const { FieldValue } = require("firebase-admin/firestore");

/**
 * Gestion centralisée de l'access_token (user) + refresh (rotatif) pour Twitch.
 * - Stocke { access_token, refresh_token, access_token_expires_at, rotated_at, scopes, issuer_client_id }
 * - Sérialise le refresh pour éviter les courses (inFlight)
 * - Traite le cas "Invalid refresh token" (400) : purge + erreur typée -> reconsent
 */
function createTokenManager(
  db,
  {
    docPath = "settings/twitch_moderator",
    clientId = process.env.TWITCH_CLIENT_ID,
    clientSecret = process.env.TWITCH_CLIENT_SECRET,
    // marge de sécurité avant l’expiration (ms)
    expirySkewMs = 60_000,
  } = {}
) {
  const ref = db.doc(docPath);
  let inFlight = null; // Promise en cours (mutex soft)

  function asTypedError(message, code, extra) {
    const err = new Error(message);
    err.code = code;
    if (extra) err.extra = extra;
    return err;
  }

  async function readDoc() {
    const snap = await ref.get();
    return snap.exists ? snap.data() : {};
  }

  async function writeDoc(patch) {
    await ref.set(patch, { merge: true });
  }

  async function doRefresh(refreshToken) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    try {
      const res = await axios.post("https://id.twitch.tv/oauth2/token", body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      const {
        access_token,
        refresh_token: newRefresh,
        expires_in,
        scope,
        token_type,
      } = res.data;

      const access_token_expires_at =
        Date.now() + Math.max(1, (expires_in ?? 3600) * 1000 - expirySkewMs);

      await writeDoc({
        access_token,
        refresh_token: newRefresh, // rotation
        access_token_expires_at,
        rotated_at: FieldValue.serverTimestamp(),
        scopes: scope,
        token_type,
        issuer_client_id: clientId,
        oauth_error: null, // reset éventuelle d’une erreur précédente
      });

      return access_token;
    } catch (e) {
      const status = e?.response?.data?.status || e?.response?.status;
      const message =
        e?.response?.data?.message ||
        e?.response?.data?.error_description ||
        e?.message ||
        "Refresh failed";

      // Cas classique : token de refresh invalide/consommé/révoqué
      if (status === 400 && /invalid refresh token/i.test(message)) {
        await writeDoc({
          access_token: null,
          refresh_token: null,
          access_token_expires_at: 0,
          oauth_error: {
            at: Date.now(),
            status,
            message,
          },
        });
        throw asTypedError(
          "Invalid refresh token — reconsent required.",
          "INVALID_REFRESH_TOKEN",
          { status, message }
        );
      }

      // Autres erreurs réseau/API
      throw asTypedError(
        `Refresh failed: ${message}`,
        "REFRESH_FAILED",
        e?.response?.data || { message }
      );
    }
  }

  async function getAccessToken() {
    const initial = await readDoc();
    const now = Date.now();

    // 1) Token présent et encore valable ?
    if (
      initial.access_token &&
      initial.access_token_expires_at &&
      now < initial.access_token_expires_at - expirySkewMs
    ) {
      return initial.access_token;
    }

    // 2) Pas de refresh_token : nécessite re-consentement
    if (!initial.refresh_token) {
      throw asTypedError(
        "No refresh_token stored — run OAuth consent.",
        "NO_REFRESH_TOKEN"
      );
    }

    // 3) Sérialiser le refresh pour éviter les courses
    if (!inFlight) {
      inFlight = (async () => {
        // Re-lire au dernier moment pour prendre en compte une éventuelle mise à jour
        const fresh = await readDoc();
        const r = fresh.refresh_token;
        if (!r) {
          throw asTypedError(
            "No refresh_token stored — run OAuth consent.",
            "NO_REFRESH_TOKEN"
          );
        }
        return await doRefresh(r);
      })().finally(() => {
        // libérer le mutex quoi qu'il arrive
        inFlight = null;
      });
    }

    return await inFlight;
  }

  return { getAccessToken };
}

module.exports = { createTokenManager };
