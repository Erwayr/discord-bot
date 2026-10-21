"use strict";

// Actions are previews/visual reactions, never inventory or combat commands.
const { ACTIONS, GREETING_MS, TRAVEL_MS, EQUIP_MS, ARRIVAL_MS, actionById, actionDuration } = require("./guardian-action-definitions.shared.cjs");
const CHAT_MAX_AGE_MS = 8000;
const CHAT_REACTION_COOLDOWN_MS = 5000;
const CHAT_BUBBLE_MS = 8000;
const CHAT_BUBBLE_LIMIT = 3;
const CHAT_MESSAGE_LIMIT = 200;
const CHAT_KEYWORDS = Object.freeze({
  salut: "greet",
  coucou: "greet",
  bonjour: "greet",
  gg: "victory",
  bravo: "victory",
  danse: "dance",
  party: "dance",
  attaque: "attack",
  charge: "attack",
});
const isChatMessage = (message) =>
  Boolean(String(message || "").trim()) &&
  !/^[!/]/.test(String(message).trim());
const isChatAction = (type) =>
  ["greet", "victory", "dance", "attack", "facepalm"].includes(type);
const CRITICISM_WORDS = new Set([
  "null", "nulls", "nul", "nulle", "nuls", "nulles",
  "mauvais", "mauvaise", "mauvaises", "zero", "zeros", "naze", "nazes",
  "pourri", "pourrie", "pourris", "pourries", "bidon", "bidons",
  "eclate", "eclatee", "eclates", "eclatees",
]);
// Keep the established Unicode word boundaries. Accent folding applies only
// to criticism and its immediate negation, leaving existing keywords intact.
const foldAccents = word => word.normalize("NFD").replace(/\p{M}/gu, "");
const NEGATED_CRITICISM = /(?:^| )(?:pas|jamais|rien de|loin d etre)(?: (?:si|aussi|vraiment|tellement|trop|du tout))*$/u;
function chatReaction(message) {
  if (!isChatMessage(message)) return null;
  const text = String(message).normalize("NFKC").toLowerCase();
  let preceding = [];
  let end = 0;
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
    if (/[.!?,;:\n\r]/u.test(text.slice(end, match.index))) preceding = [];
    const word = match[0], folded = foldAccents(word);
    if (Object.hasOwn(CHAT_KEYWORDS, word)) return CHAT_KEYWORDS[word];
    if (CRITICISM_WORDS.has(folded) && !NEGATED_CRITICISM.test(preceding.join(" "))) return "facepalm";
    preceding.push(folded);
    if (preceding.length > 12) preceding.shift();
    end = match.index + word.length;
  }
  return null;
}
function chatMessageText(message) {
  const text = String(message || "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(text);
  return characters.length > CHAT_MESSAGE_LIMIT
    ? characters.slice(0, CHAT_MESSAGE_LIMIT - 1).join("") + "…"
    : text;
}
module.exports = {
  ACTIONS,
  GREETING_MS,
  CHAT_MAX_AGE_MS,
  TRAVEL_MS,
  EQUIP_MS,
  ARRIVAL_MS,
  CHAT_REACTION_COOLDOWN_MS,
  CHAT_BUBBLE_MS,
  CHAT_BUBBLE_LIMIT,
  CHAT_MESSAGE_LIMIT,
  CHAT_KEYWORDS,
  isChatMessage,
  isChatAction,
  chatReaction,
  chatMessageText,
  actionById,
  actionDuration,
};
