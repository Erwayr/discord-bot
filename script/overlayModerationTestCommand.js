"use strict";

const {
  canRunOverlaySubCardTestCommand,
  normalizeLogin,
} = require("./overlaySubCardTestCommand");

const OVERLAY_MODERATION_TEST_ALIASES = Object.freeze({
  "!testban": "ban",
  "!testtimeout": "timeout",
});

function safeDocId(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140);
  return cleaned || `event_${Date.now()}`;
}

function parseOverlayModerationTestCommand(message, senderLogin = "") {
  const parts = String(message || "").trim().split(/\s+/).filter(Boolean);
  const alias = String(parts[0] || "").toLowerCase();
  const sanctionType = OVERLAY_MODERATION_TEST_ALIASES[alias];
  if (!sanctionType) return null;
  return {
    alias,
    sanctionType,
    targetLogin: normalizeLogin(parts[1] || senderLogin),
  };
}

async function publishOverlayModerationTestEvent({
  db,
  config = {},
  targetLogin = "",
  targetDisplayName = "",
  requestedBy = "",
  sanctionType = "ban",
  now = () => Date.now(),
} = {}) {
  const login = normalizeLogin(targetLogin);
  if (!login) return { published: false, reason: "invalid_target" };
  if (!db?.collection) return { published: false, reason: "missing_db" };

  const safeSanctionType = sanctionType === "timeout" ? "timeout" : "ban";
  const overlayConfig = config.overlay || {};
  const collectionName = overlayConfig.eventsCollection || "overlay_events";
  const eventType = overlayConfig.moderationEventType || "moderation_trash";
  const eventMs = Math.max(0, Math.floor(Number(now()) || Date.now()));
  const eventKey = safeDocId(
    `test_${safeSanctionType}_${login}_${eventMs}`,
  );
  const docId = `${eventType}_${eventKey}`;
  const displayName =
    String(targetDisplayName || login).replace(/^@+/, "").trim() || login;

  await db.collection(collectionName).doc(docId).set(
    {
      type: eventType,
      eventMs,
      createdAtMs: eventMs,
      source: "twitch_chat_test",
      twitchEventType: "manual_test",
      login,
      displayName,
      isPermanent: safeSanctionType === "ban",
      endsAt:
        safeSanctionType === "timeout"
          ? new Date(eventMs + 10 * 60_000).toISOString()
          : null,
      test: true,
      requestedBy: normalizeLogin(requestedBy),
    },
    { merge: true },
  );

  return {
    published: true,
    collectionName,
    docId,
    login,
    displayName,
    sanctionType: safeSanctionType,
  };
}

async function handleOverlayModerationTestCommand({
  db,
  config = {},
  login = "",
  displayName = "",
  message = "",
  tags = {},
  sendTwitchChatMessage,
  now,
} = {}) {
  const parsed = parseOverlayModerationTestCommand(message, login);
  if (!parsed) return { handled: false };
  if (config.overlay?.moderationTestCommandEnabled === false) {
    return { handled: true, responded: false, reason: "disabled" };
  }

  const authorized = canRunOverlaySubCardTestCommand({
    login,
    tags,
    channelLogin: config.twitch?.channelLogin,
    allowedLogins: config.overlay?.moderationTestAllowedLogins,
  });
  if (!authorized) {
    return { handled: true, responded: false, reason: "unauthorized" };
  }

  const result = await publishOverlayModerationTestEvent({
    db,
    config,
    targetLogin: parsed.targetLogin,
    targetDisplayName: parsed.targetLogin,
    requestedBy: login,
    sanctionType: parsed.sanctionType,
    now,
  });
  if (!result.published) {
    return { handled: true, responded: false, reason: result.reason };
  }

  if (typeof sendTwitchChatMessage === "function") {
    const mention = displayName
      ? `@${String(displayName).replace(/^@+/, "")}`
      : "@modo";
    await sendTwitchChatMessage(
      `${mention} test overlay ${result.sanctionType} envoye pour @${result.login}.`,
    );
  }

  return {
    handled: true,
    responded: true,
    type: "overlay_moderation_test",
    sanctionType: result.sanctionType,
    targetLogin: result.login,
    docId: result.docId,
  };
}

module.exports = {
  OVERLAY_MODERATION_TEST_ALIASES,
  handleOverlayModerationTestCommand,
  parseOverlayModerationTestCommand,
  publishOverlayModerationTestEvent,
};
