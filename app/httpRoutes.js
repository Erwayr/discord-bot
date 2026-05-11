"use strict";

const axios = require("axios");
const bodyParser = require("body-parser");
const { mountTwitchAuth } = require("../script/authTwitch");
const { shortText } = require("./textUtils");

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

function createAuthHealth({ client, tokenManager, config, postDiscord }) {
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
      await postDiscord(config.discord.logChannelId, body);
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
    await axios.get(config.urls.oauthValidate, {
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

  return {
    notifyAuthIssueToLog,
    validateUserAccessToken,
    ensureValidUserAccessToken,
  };
}

function mountHttpRoutes({ app, db, config, authHealth, twitchEventSub }) {
  app.use(bodyParser.json());

  mountTwitchAuth(app, db, {
    docPath: config.twitch.tokenDocPath,
    clientId: config.twitch.clientId,
    clientSecret: config.twitch.clientSecret,
    redirectUri: config.twitch.oauthRedirect,
  });

  app.get("/internal/twitch/access-token", async (req, res) => {
    if (req.header("x-api-key") !== config.twitch.internalApiKey) {
      return res.status(403).send("Forbidden");
    }
    try {
      const accessToken = await authHealth.ensureValidUserAccessToken({
        source: "internal/twitch/access-token",
      });
      res.json({ access_token: accessToken });
    } catch (e) {
      await authHealth.notifyAuthIssueToLog({
        source: "internal/twitch/access-token",
        code: e?.code || "TOKEN_ENDPOINT_FAILED",
        status: e?.response?.status || null,
        details: shortText(e?.response?.data || e?.stack || e?.message || e),
      });
      res.status(500).json({ error: e.code || "ERROR", message: e.message });
    }
  });

  app.post("/internal/alerts/twitch-auth", async (req, res) => {
    if (req.header("x-api-key") !== config.twitch.internalApiKey) {
      return res.status(403).send("Forbidden");
    }
    const payload = req.body || {};
    await authHealth.notifyAuthIssueToLog({
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

  app.post("/twitch-callback", twitchEventSub.handleTwitchCallback);
}

module.exports = { createAuthHealth, mountHttpRoutes };
