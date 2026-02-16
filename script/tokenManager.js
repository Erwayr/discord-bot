const axios = require("axios");
const { FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

function sha256(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

function createTokenManager(
  db,
  {
    docPath = "settings/twitch_moderator",
    clientId = process.env.TWITCH_CLIENT_ID,
    clientSecret = process.env.TWITCH_CLIENT_SECRET,
    expirySkewMs = 60_000,
  } = {},
) {
  const ref = db.doc(docPath);
  let inFlight = null;

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

  async function invalidateAccessToken() {
    await writeDoc({ access_token_expires_at: 0 });
  }

  async function doRefresh(refreshToken) {
    const expectedSha = sha256(refreshToken);
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

      const rotatedRefresh = newRefresh || refreshToken;
      const access_token_expires_at =
        Date.now() + Math.max(1, (expires_in ?? 3600) * 1000 - expirySkewMs);

      await writeDoc({
        access_token,
        access_token_expires_at,
        token_type,
        issuer_client_id: clientId,

        refresh_token: rotatedRefresh,
        refresh_token_sha256: sha256(rotatedRefresh),
        prev_refresh_token_sha256: expectedSha,
        refresh_rotation_count: FieldValue.increment(1),

        scopes: scope,
        rotated_at: FieldValue.serverTimestamp(),
        oauth_error: null,
      });

      return access_token;
    } catch (e) {
      const status = e?.response?.data?.status || e?.response?.status;
      const message =
        e?.response?.data?.message ||
        e?.response?.data?.error_description ||
        e?.message ||
        "Refresh failed";

      if (status === 400 && /invalid refresh token/i.test(message)) {
        const latest = await readDoc();
        if (
          latest.refresh_token &&
          latest.refresh_token_sha256 &&
          latest.refresh_token_sha256 !== expectedSha
        ) {
          return doRefresh(latest.refresh_token);
        }

        await writeDoc({
          access_token: null,
          refresh_token: null,
          access_token_expires_at: 0,
          oauth_error: { at: Date.now(), status, message },
        });
        throw asTypedError(
          "Invalid refresh token - reconsent required.",
          "INVALID_REFRESH_TOKEN",
          { status, message },
        );
      }

      throw asTypedError(
        `Refresh failed: ${message}`,
        "REFRESH_FAILED",
        e?.response?.data || { message },
      );
    }
  }

  async function getAccessToken() {
    const initial = await readDoc();
    const now = Date.now();

    if (
      initial.access_token &&
      initial.access_token_expires_at &&
      now < initial.access_token_expires_at - expirySkewMs
    ) {
      return initial.access_token;
    }

    if (!initial.refresh_token) {
      throw asTypedError(
        "No refresh_token stored - run OAuth consent.",
        "NO_REFRESH_TOKEN",
      );
    }

    if (!inFlight) {
      inFlight = (async () => {
        const fresh = await readDoc();
        const refreshToken = fresh.refresh_token;
        if (!refreshToken) {
          throw asTypedError(
            "No refresh_token stored - run OAuth consent.",
            "NO_REFRESH_TOKEN",
          );
        }
        return doRefresh(refreshToken);
      })().finally(() => {
        inFlight = null;
      });
    }

    return inFlight;
  }

  return { getAccessToken, invalidateAccessToken };
}

module.exports = { createTokenManager };
