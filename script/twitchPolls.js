"use strict";

const axios = require("axios");

const MANAGE_POLLS_SCOPE = "channel:manage:polls";
const MIN_DURATION_SECONDS = 15;
const MAX_DURATION_SECONDS = 1800;
const DEFAULT_DURATION_SECONDS = 300;
const MIN_CHOICES = 2;
const MAX_CHOICES = 5;
const MAX_TITLE_LENGTH = 60;
const MAX_CHOICE_LENGTH = 25;

function toInt(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function clampPollDurationSeconds(value, fallback = DEFAULT_DURATION_SECONDS) {
  const n = toInt(value, fallback);
  return Math.max(MIN_DURATION_SECONDS, Math.min(MAX_DURATION_SECONDS, n));
}

function normalizeExtraVoteCost(value) {
  return Math.max(0, toInt(value, 0));
}

function normalizeInputText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMatchText(value) {
  return normalizeInputText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019\u2018\u0060\u00b4]/g, "'")
    .toLowerCase();
}

function pollParseError(code, message) {
  return { ok: false, code, message };
}

function parseTwitchPollInput(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return pollParseError(
      "empty_input",
      "Format attendu: Question ? reponse1/reponse2",
    );
  }

  const questionMarkIndex = raw.indexOf("?");
  if (questionMarkIndex < 0) {
    return pollParseError(
      "missing_question_mark",
      "La question doit se terminer par un point d'interrogation.",
    );
  }

  const title = normalizeInputText(raw.slice(0, questionMarkIndex + 1));
  const answersText = raw.slice(questionMarkIndex + 1).trim();
  if (!title || title === "?") {
    return pollParseError("missing_question", "La question est obligatoire.");
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return pollParseError(
      "question_too_long",
      `La question doit faire ${MAX_TITLE_LENGTH} caracteres maximum.`,
    );
  }
  if (!answersText) {
    return pollParseError(
      "missing_choices",
      "Ajoute au moins deux reponses separees par des /.",
    );
  }

  const rawChoices = answersText.split("/").map(normalizeInputText);
  if (rawChoices.some((choice) => !choice)) {
    return pollParseError(
      "empty_choice",
      "Les reponses vides ne sont pas autorisees.",
    );
  }
  if (rawChoices.length < MIN_CHOICES) {
    return pollParseError(
      "not_enough_choices",
      `Twitch demande au moins ${MIN_CHOICES} reponses.`,
    );
  }
  if (rawChoices.length > MAX_CHOICES) {
    return pollParseError(
      "too_many_choices",
      `Twitch accepte ${MAX_CHOICES} reponses maximum.`,
    );
  }

  const seen = new Set();
  const choices = [];
  for (const choice of rawChoices) {
    if (choice.length > MAX_CHOICE_LENGTH) {
      return pollParseError(
        "choice_too_long",
        `Chaque reponse doit faire ${MAX_CHOICE_LENGTH} caracteres maximum.`,
      );
    }
    const key = normalizeMatchText(choice);
    if (seen.has(key)) {
      return pollParseError(
        "duplicate_choice",
        "Les reponses en double ne sont pas autorisees.",
      );
    }
    seen.add(key);
    choices.push({ title: choice });
  }

  return {
    ok: true,
    title,
    choices,
  };
}

function isTwitchPollRedemption(redemption, pollConfig = {}) {
  const reward = redemption?.reward || {};
  const rewardId = String(reward.id || "").trim();
  const expectedId = String(pollConfig.rewardId || "").trim();
  if (expectedId) return rewardId === expectedId;

  const expectedTitle = normalizeMatchText(
    pollConfig.rewardTitle || "Faire un sondage",
  );
  const rewardTitle = normalizeMatchText(reward.title || "");
  return !!expectedTitle && rewardTitle === expectedTitle;
}

function normalizeScopes(scopeValue) {
  if (Array.isArray(scopeValue)) return scopeValue.map(String).filter(Boolean);
  if (typeof scopeValue === "string") {
    return scopeValue.split(/\s+/).map(String).filter(Boolean);
  }
  return [];
}

function hasManagePollsScope(scopeValue) {
  return normalizeScopes(scopeValue).includes(MANAGE_POLLS_SCOPE);
}

async function readStoredTokenScopes(db, tokenDocPath) {
  if (!db?.doc || !tokenDocPath) return [];
  const snap = await db.doc(tokenDocPath).get();
  return snap.exists ? normalizeScopes(snap.data()?.scopes) : [];
}

async function assertManagePollsScope({ db, tokenDocPath }) {
  const scopes = await readStoredTokenScopes(db, tokenDocPath);
  if (hasManagePollsScope(scopes)) return scopes;
  const error = new Error(
    "Le token Twitch doit inclure channel:manage:polls. Relance /auth/twitch/start?set=broad&force=1.",
  );
  error.code = "missing_poll_scope";
  error.scopes = scopes;
  throw error;
}

async function createTwitchPoll({
  accessToken,
  clientId,
  broadcasterId,
  title,
  choices,
  durationSeconds,
  channelPointsPerExtraVote = 0,
  pollsUrl = "https://api.twitch.tv/helix/polls",
  axiosClient = axios,
}) {
  if (!accessToken) throw new Error("accessToken missing");
  if (!clientId) throw new Error("clientId missing");
  if (!broadcasterId) throw new Error("broadcasterId missing");

  const extraVoteCost = normalizeExtraVoteCost(channelPointsPerExtraVote);
  const payload = {
    broadcaster_id: String(broadcasterId),
    title,
    choices,
    duration: clampPollDurationSeconds(durationSeconds),
  };
  if (extraVoteCost > 0) {
    payload.channel_points_voting_enabled = true;
    payload.channel_points_per_vote = extraVoteCost;
  }

  const res = await axiosClient.post(pollsUrl, payload, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  return res.data?.data?.[0] || null;
}

function classifyTwitchPollError(error) {
  const status = error?.response?.status || error?.response?.data?.status;
  const message = String(
    error?.response?.data?.message ||
      error?.response?.data?.error_description ||
      error?.message ||
      "",
  ).toLowerCase();

  if (error?.code === "missing_poll_scope") return "missing_poll_scope";
  if (status === 401 || status === 403) return "poll_auth_failed";
  if (status === 400 && /active|already|one poll/i.test(message)) {
    return "poll_already_active";
  }
  return "poll_api_failed";
}

function pollFailureMessage(code) {
  switch (code) {
    case "not_live":
      return "Le sondage Twitch ne peut etre lance que pendant un live.";
    case "missing_poll_scope":
      return "Le bot doit etre relie a Twitch avec le scope channel:manage:polls.";
    case "poll_auth_failed":
      return "Le bot n'a pas l'autorisation Twitch pour creer un sondage.";
    case "poll_already_active":
      return "Un sondage Twitch est deja actif.";
    case "empty_input":
    case "missing_question_mark":
    case "missing_question":
    case "missing_choices":
    case "empty_choice":
    case "not_enough_choices":
    case "too_many_choices":
    case "question_too_long":
    case "choice_too_long":
    case "duplicate_choice":
      return "Format attendu: Question ? reponse1/reponse2 (2 a 5 reponses).";
    default:
      return "Le sondage Twitch n'a pas pu etre cree.";
  }
}

function buildPollFailureChatMessage(redemption, code) {
  const login = String(redemption?.user_login || redemption?.user_name || "")
    .trim()
    .replace(/^@+/, "");
  const mention = login ? `@${login} ` : "";
  return `${mention}${pollFailureMessage(code)} Aucun sondage n'a ete lance.`;
}

async function sendFailureChatMessage({
  redemption,
  code,
  sendTwitchChatMessage,
}) {
  if (typeof sendTwitchChatMessage !== "function") return false;
  await sendTwitchChatMessage(buildPollFailureChatMessage(redemption, code));
  return true;
}

async function processTwitchPollRedemption({
  db,
  config,
  tokenManager,
  redemption,
  livePresenceTick,
  sendTwitchChatMessage,
  createPollFn = createTwitchPoll,
}) {
  if (!redemption?.id || !redemption?.reward?.id) {
    throw new Error("payload poll redemption invalide");
  }
  if (!tokenManager?.getAccessToken) {
    throw new Error("tokenManager missing");
  }

  const pollConfig = config.twitchPoll || {};
  const streamState = livePresenceTick?.getLiveStreamState?.() || {};
  const parsed = parseTwitchPollInput(redemption.user_input);

  let status = "REJECTED";
  let reason = null;
  let poll = null;
  let accessToken = null;

  const reject = async (code) => {
    status = "REJECTED";
    reason = code;
    try {
      await sendFailureChatMessage({
        redemption,
        code,
        sendTwitchChatMessage,
      });
    } catch (e) {
      console.warn("poll failure chat message failed:", e?.message || e);
    }
    return {
      handled: true,
      status,
      reason,
      poll,
    };
  };

  if (!streamState.streamId) return reject("not_live");
  if (!parsed.ok) return reject(parsed.code);

  try {
    await assertManagePollsScope({
      db,
      tokenDocPath: config.twitch.tokenDocPath,
    });
    accessToken = await tokenManager.getAccessToken();
    poll = await createPollFn({
      accessToken,
      clientId: config.twitch.clientId,
      broadcasterId: config.twitch.channelId,
      title: parsed.title,
      choices: parsed.choices,
      durationSeconds: pollConfig.durationSeconds,
      channelPointsPerExtraVote: pollConfig.channelPointsPerExtraVote,
      pollsUrl: config.urls?.helixPolls,
    });
  } catch (e) {
    return reject(classifyTwitchPollError(e));
  }

  return {
    handled: true,
    status: "CREATED",
    reason: null,
    poll,
  };
}

module.exports = {
  MANAGE_POLLS_SCOPE,
  clampPollDurationSeconds,
  normalizeExtraVoteCost,
  parseTwitchPollInput,
  isTwitchPollRedemption,
  hasManagePollsScope,
  createTwitchPoll,
  classifyTwitchPollError,
  pollFailureMessage,
  buildPollFailureChatMessage,
  processTwitchPollRedemption,
};
