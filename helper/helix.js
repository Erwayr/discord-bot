const axios = require("axios");

const RECONSENT_URL =
  process.env.TWITCH_RECONSENT_URL ||
  "https://discord-bot-production-95c5.up.railway.app/auth/twitch/start";

function isRecoverableTokenError(error) {
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

function makeHelix({ tokenManager, clientId }) {
  return async function helix({ url, method = "get", params, data }) {
    let token = await tokenManager.getAccessToken();

    try {
      return await axios({
        url,
        method,
        params,
        data,
        headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
    } catch (error) {
      if (!isRecoverableTokenError(error)) throw error;

      console.warn(
        "401 token Twitch invalide/expire -> refresh force + retry unique",
      );

      try {
        await tokenManager.invalidateAccessToken();
        token = await tokenManager.getAccessToken();
      } catch (refreshError) {
        const code = refreshError?.code;
        if (code === "NO_REFRESH_TOKEN" || code === "INVALID_REFRESH_TOKEN") {
          console.error(
            `[oauth] reconsent requis. Ouvre: ${RECONSENT_URL} (code=${code})`,
          );
        }
        throw refreshError;
      }

      return axios({
        url,
        method,
        params,
        data,
        headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
    }
  };
}

module.exports = { makeHelix };
