"use strict";

const OVERLAY_SUB_CARD_TEST_ALIASES = Object.freeze([
  "!testsubcard",
  "!testsub",
  "!testcarteabo",
  "!testsubcarte",
]);

function normalizeLogin(value) {
  const text = String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(text) ? text : "";
}

function safeDocId(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140);
  return cleaned || `event_${Date.now()}`;
}

function parseOverlaySubCardTestCommand(message, senderLogin = "") {
  const parts = String(message || "").trim().split(/\s+/).filter(Boolean);
  const alias = String(parts[0] || "").toLowerCase();
  if (!OVERLAY_SUB_CARD_TEST_ALIASES.includes(alias)) return null;

  const targetLogin = normalizeLogin(parts[1] || senderLogin);
  const subMessage = parts.slice(2).join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
  return {
    alias,
    targetLogin,
    subMessage,
  };
}

function listFromCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => normalizeLogin(item))
    .filter(Boolean);
}

function hasBadge(tags = {}, badgeName = "") {
  const badges = tags.badges && typeof tags.badges === "object" ? tags.badges : {};
  if (badges[badgeName] != null) return true;
  const raw = String(tags["badges-raw"] || "");
  return raw.split(",").some((badge) => badge.split("/")[0] === badgeName);
}

function tagBool(value) {
  if (value === true || value === 1) return true;
  return ["1", "true", "yes"].includes(String(value || "").toLowerCase());
}

function canRunOverlaySubCardTestCommand({
  login = "",
  tags = {},
  channelLogin = "",
  allowedLogins = "",
} = {}) {
  const safeLogin = normalizeLogin(login);
  if (!safeLogin) return false;

  const channel = normalizeLogin(channelLogin);
  if (channel && safeLogin === channel) return true;
  if (hasBadge(tags, "broadcaster")) return true;
  if (hasBadge(tags, "moderator")) return true;
  if (tagBool(tags.mod)) return true;

  return listFromCsv(allowedLogins).includes(safeLogin);
}

async function publishOverlaySubCardTestEvent({
  db,
  config = {},
  targetLogin = "",
  targetDisplayName = "",
  requestedBy = "",
  subMessage = "",
  now = () => Date.now(),
} = {}) {
  const login = normalizeLogin(targetLogin);
  if (!login) {
    return { published: false, reason: "invalid_target" };
  }
  if (!db?.collection) {
    return { published: false, reason: "missing_db" };
  }

  const overlayConfig = config.overlay || {};
  const collectionName = overlayConfig.eventsCollection || "overlay_events";
  const eventType = overlayConfig.subCardEventType || "sub_card";
  const eventMs = Math.max(0, Math.floor(Number(now()) || Date.now()));
  const eventKey = safeDocId(`test_${login}_${eventMs}`);
  const docId = `${eventType}_${eventKey}`;
  const displayName = String(targetDisplayName || login).replace(/^@+/, "").trim() || login;
  const safeSubMessage = String(subMessage || "").replace(/\s+/g, " ").trim().slice(0, 500);

  await db.collection(collectionName).doc(docId).set(
    {
      type: eventType,
      eventMs,
      createdAtMs: eventMs,
      source: "twitch_chat_test",
      twitchEventType: "manual_test",
      login,
      displayName,
      test: true,
      requestedBy: normalizeLogin(requestedBy),
      subMessage: safeSubMessage,
    },
    { merge: true },
  );

  return {
    published: true,
    collectionName,
    docId,
    login,
    displayName,
    subMessage: safeSubMessage,
  };
}

async function handleOverlaySubCardTestCommand({
  db,
  config = {},
  login = "",
  displayName = "",
  message = "",
  tags = {},
  sendTwitchChatMessage,
  now,
} = {}) {
  const parsed = parseOverlaySubCardTestCommand(message, login);
  if (!parsed) return { handled: false };

  if (config.overlay?.subCardTestCommandEnabled === false) {
    return { handled: true, responded: false, reason: "disabled" };
  }

  const authorized = canRunOverlaySubCardTestCommand({
    login,
    tags,
    channelLogin: config.twitch?.channelLogin,
    allowedLogins: config.overlay?.subCardTestAllowedLogins,
  });
  if (!authorized) {
    return { handled: true, responded: false, reason: "unauthorized" };
  }

  const result = await publishOverlaySubCardTestEvent({
    db,
    config,
    targetLogin: parsed.targetLogin,
    targetDisplayName: parsed.targetLogin,
    requestedBy: login,
    subMessage: parsed.subMessage,
    now,
  });

  if (!result.published) {
    return { handled: true, responded: false, reason: result.reason };
  }

  if (typeof sendTwitchChatMessage === "function") {
    const mention = displayName ? `@${String(displayName).replace(/^@+/, "")}` : "@modo";
    await sendTwitchChatMessage(
      `${mention} test overlay sub card envoye pour @${result.login}.`,
    );
  }

  return {
    handled: true,
    responded: true,
    type: "overlay_sub_card_test",
    targetLogin: result.login,
    docId: result.docId,
  };
}

module.exports = {
  OVERLAY_SUB_CARD_TEST_ALIASES,
  canRunOverlaySubCardTestCommand,
  handleOverlaySubCardTestCommand,
  normalizeLogin,
  parseOverlaySubCardTestCommand,
  publishOverlaySubCardTestEvent,
};
