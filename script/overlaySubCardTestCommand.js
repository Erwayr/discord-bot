"use strict";

const { randomUUID } = require("node:crypto");
const { publishGuardianSubscriptionTest } = require("./guardian-live.store.cjs");

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
  const monthToken = parts[2] || "";
  // Text after the login remains a message; a leading number selects test tenure.
  const hasMonths = /^[+-]?(?:\d|\.\d)/.test(monthToken);
  const subMonths = hasMonths ? Number(monthToken) : null;
  const invalidMonths = hasMonths && (!/^\d+$/.test(monthToken) || !Number.isSafeInteger(subMonths) || subMonths < 1);
  const subMessage = parts.slice(hasMonths ? 3 : 2).join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
  return {
    alias,
    targetLogin,
    subMessage,
    ...(invalidMonths ? { error: "invalid_months" } : hasMonths ? { subMonths } : {}),
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

// Explicit standalone compatibility path. The chat command uses the Guardian
// presentation below so OBS never receives a parallel independent card alert.
async function publishOverlaySubCardTestEvent({
  db,
  config = {},
  targetLogin = "",
  targetDisplayName = "",
  requestedBy = "",
  subMessage = "",
  subMonths,
  now = () => Date.now(),
} = {}) {
  const login = normalizeLogin(targetLogin);
  if (!login) {
    return { published: false, reason: "invalid_target" };
  }
  if (subMonths != null && (!Number.isSafeInteger(subMonths) || subMonths < 1)) {
    return { published: false, reason: "invalid_months" };
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
      ...(subMonths != null ? { subMonths } : {}),
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
    ...(subMonths != null ? { subMonths } : {}),
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
  now = Date.now,
  publishGuardianTest = publishGuardianSubscriptionTest,
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
  if (parsed.error) {
    const responded = typeof sendTwitchChatMessage === "function";
    if (responded) {
      await sendTwitchChatMessage("Nombre de mois invalide : utilise un entier positif. Exemple : !testsub erwayr 6 [message].");
    }
    return { handled: true, responded, reason: parsed.error };
  }

  if (!parsed.targetLogin) {
    const responded = typeof sendTwitchChatMessage === "function";
    if (responded) await sendTwitchChatMessage("Pseudo invalide. Exemple : !testsub erwayr 6 [message].");
    return { handled: true, responded, reason: "invalid_target" };
  }

  const requestId = `test_${safeDocId(tags.id || randomUUID())}`.slice(0, 128);
  const time = Number(now());
  let result;
  try {
    result = typeof publishGuardianTest === "function"
      ? await publishGuardianTest({ db, channelId: config.twitch?.channelId,
        login: parsed.targetLogin,
        displayName: parsed.targetLogin === normalizeLogin(login) ? displayName || parsed.targetLogin : parsed.targetLogin,
        subMonths: parsed.subMonths, subMessage: parsed.subMessage, requestId,
        nowMs: Number.isFinite(time) && time >= 0 ? Math.floor(time) : Date.now() })
      : { status: "error", reason: "unavailable" };
  } catch {
    result = { status: "error", reason: "unavailable" };
  }
  if (result?.deduped || result?.status === "deduped") {
    return { handled: true, responded: false, reason: "duplicate", requestId };
  }

  const accepted = result?.accepted === true || result?.status === "accepted";
  const responded = typeof sendTwitchChatMessage === "function";
  if (responded) {
    const mention = displayName ? `@${String(displayName).replace(/^@+/, "")}` : "@modo";
    const months = result?.subMonths ?? parsed.subMonths;
    const feedback = accepted
      ? `test Gardien + carte d'abonnement envoyé pour @${result.login || parsed.targetLogin}${months != null ? ` (${months} mois)` : ""}.`
      : result?.reason === "busy" || result?.status === "busy"
        ? "une apparition est déjà en cours. Attends la fin de la carte, puis relance !testsub."
        : result?.reason === "profile_not_found"
          ? `aucun profil enregistré pour @${parsed.targetLogin}.`
          : result?.reason === "identity_conflict"
            ? `l'identité de @${parsed.targetLogin} doit être vérifiée avant ce test.`
            : "test Gardien indisponible pour le moment. Réessaie après la mise à jour du bot et de la source OBS.";
    await sendTwitchChatMessage(`${mention} ${feedback}`);
  }

  return {
    handled: true,
    responded,
    type: "overlay_sub_card_test",
    reason: accepted ? null : result?.reason || result?.status || "unavailable",
    presentation: "guardian",
    targetLogin: result?.login || parsed.targetLogin,
    requestId: result?.requestId || requestId,
    ...((result?.subMonths ?? parsed.subMonths) != null ? { subMonths: result?.subMonths ?? parsed.subMonths } : {}),
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
