"use strict";

const {
  normalizeCommunityLevel,
  resolveCommunityLevelConfig,
  xpRequiredForNextLevel,
} = require("./communityLevel");

const COMMAND_ALIASES = Object.freeze({
  "!lvl": "level",
  "!level": "level",
  "!niveau": "level",
  "!rank": "rank",
  "!rang": "rank",
  "!uptime": "uptime",
  "!watchtime": "uptime",
});

const DEFAULT_USER_COOLDOWN_MS = 10_000;
const DEFAULT_GLOBAL_COOLDOWN_MS = 2_000;

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function displayMention(value) {
  const clean = String(value || "")
    .trim()
    .replace(/^@+/, "");
  return `@${clean || "viewer"}`;
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(Math.floor(n));
}

function parseTwitchChatCommand(message) {
  const firstToken = String(message || "")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  const type = COMMAND_ALIASES[firstToken];
  return type ? { type, alias: firstToken } : null;
}

function resolveUptimeText(communityLevel) {
  const uptimeText = String(communityLevel?.uptimeText || "").trim();
  if (uptimeText) return uptimeText;
  const minutes = Number(communityLevel?.uptimeMinutes || 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  if (hours <= 0) return `${mins}m`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

async function loadCommunityLevelConfig(getCommunityLevelConfig) {
  if (typeof getCommunityLevelConfig !== "function") {
    return resolveCommunityLevelConfig({});
  }
  try {
    return resolveCommunityLevelConfig(await getCommunityLevelConfig());
  } catch (e) {
    console.warn("[twitch-commands] community config fallback:", e?.message || e);
    return resolveCommunityLevelConfig({});
  }
}

async function loadFollowerDoc(db, login) {
  const safeLogin = String(login || "")
    .trim()
    .toLowerCase();
  if (!safeLogin || !db) return null;
  const snap = await db.collection("followers_all_time").doc(safeLogin).get();
  return snap.exists ? snap.data() || {} : null;
}

async function buildTwitchCommandResponse({
  db,
  login,
  displayName,
  type,
  getCommunityLevelConfig,
}) {
  const mention = displayMention(displayName || login);
  const data = await loadFollowerDoc(db, login);
  if (!data) return `${mention} Profil introuvable pour le moment.`;

  const communityConfig = await loadCommunityLevelConfig(getCommunityLevelConfig);
  const communityLevel = normalizeCommunityLevel(data, communityConfig);
  const level = Math.max(0, Number(communityLevel.level || 0));

  if (type === "level") {
    const xpTotal = Math.max(0, Number(communityLevel.xpTotal || 0));
    const xpInLevel = Math.max(0, Number(communityLevel.xpInLevel || 0));
    const xpForNext = Math.max(
      0,
      Number(communityLevel.xpForNext || xpRequiredForNextLevel(level || 1, communityConfig)),
    );
    const rankName = String(communityLevel.rankName || "").trim();
    const titlePart = rankName ? ` - ${rankName}` : "";
    const progressPart = xpForNext > 0
      ? ` (${formatNumber(xpInLevel)}/${formatNumber(xpForNext)})`
      : "";
    return `${mention} Niveau ${formatNumber(level)}${titlePart} - XP ${formatNumber(xpTotal)}${progressPart}`;
  }

  if (type === "rank") {
    const rank = Math.max(0, Number(communityLevel.rank || 0));
    if (!rank) {
      return `${mention} Classement communautaire non disponible pour le moment.`;
    }
    return `${mention} #${formatNumber(rank)} au classement communautaire - Niveau ${formatNumber(level)}`;
  }

  if (type === "uptime") {
    const uptime = resolveUptimeText(communityLevel);
    if (!uptime) return `${mention} Uptime non disponible pour le moment.`;
    return `${mention} Uptime communautaire: ${uptime}`;
  }

  return null;
}

function createTwitchChatCommands({
  db,
  config = {},
  getCommunityLevelConfig,
  sendTwitchChatMessage,
  now = () => Date.now(),
} = {}) {
  const userCooldownMs = toPositiveNumber(
    config.userCooldownMs,
    DEFAULT_USER_COOLDOWN_MS,
  );
  const globalCooldownMs = toPositiveNumber(
    config.globalCooldownMs,
    DEFAULT_GLOBAL_COOLDOWN_MS,
  );
  const userCooldowns = new Map();
  let lastGlobalResponseAt = 0;

  async function handleMessage({ login, displayName, message } = {}) {
    const command = parseTwitchChatCommand(message);
    if (!command) return { handled: false };

    const currentTime = now();
    const safeLogin = String(login || "")
      .trim()
      .toLowerCase();
    const userKey = `${safeLogin}:${command.type}`;
    const lastUserResponseAt = userCooldowns.get(userKey) || 0;

    if (
      userCooldownMs > 0 &&
      lastUserResponseAt > 0 &&
      currentTime - lastUserResponseAt < userCooldownMs
    ) {
      return { handled: true, responded: false, reason: "user_cooldown" };
    }

    if (
      globalCooldownMs > 0 &&
      lastGlobalResponseAt > 0 &&
      currentTime - lastGlobalResponseAt < globalCooldownMs
    ) {
      return { handled: true, responded: false, reason: "global_cooldown" };
    }

    const response = await buildTwitchCommandResponse({
      db,
      login: safeLogin,
      displayName,
      type: command.type,
      getCommunityLevelConfig,
    });
    if (!response) return { handled: true, responded: false, reason: "empty" };

    await sendTwitchChatMessage(response);
    userCooldowns.set(userKey, currentTime);
    lastGlobalResponseAt = currentTime;
    return {
      handled: true,
      responded: true,
      type: command.type,
      response,
    };
  }

  return {
    handleMessage,
  };
}

module.exports = {
  COMMAND_ALIASES,
  parseTwitchChatCommand,
  buildTwitchCommandResponse,
  createTwitchChatCommands,
  resolveUptimeText,
};
