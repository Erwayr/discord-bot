"use strict";

// Actions are previews/visual reactions, never inventory or combat commands.
const ACTIONS = Object.freeze([
  { id: "rest", clip: "rest", label: "Position normale", durationMs: 0 },
  { id: "greet", clip: "wave", label: "Salutation", durationMs: 4000 },
  { id: "attack", clip: "attack", label: "Attaque", durationMs: 2400 },
  { id: "victory", clip: "victory", label: "Victoire", durationMs: 3200 },
  { id: "dance", clip: "dance", label: "Danse", durationMs: 10000 },
  { id: "walk", clip: "walk", label: "Marche", durationMs: 4000 },
]);
const GREETING_MS = ACTIONS.find(action => action.id === "greet").durationMs;
const CHAT_MAX_AGE_MS = 8000;
const TRAVEL_MS = 2000;
const EQUIP_MS = 600;
const ARRIVAL_MS = TRAVEL_MS + ACTIONS.find(action => action.id === "attack").durationMs + EQUIP_MS;
const CHAT_REACTION_COOLDOWN_MS = 5000;
const CHAT_BUBBLE_MS = 8000;
const CHAT_BUBBLE_LIMIT = 3;
const CHAT_MESSAGE_LIMIT = 200;
const CHAT_KEYWORDS = Object.freeze({
  salut: "greet", coucou: "greet", bonjour: "greet",
  gg: "victory", bravo: "victory",
  danse: "dance", party: "dance",
  attaque: "attack", charge: "attack",
});
const isChatMessage = message => Boolean(String(message || "").trim()) && !/^[!/]/.test(String(message).trim());
const isChatAction = type => ["greet", "victory", "dance", "attack"].includes(type);
function chatReaction(message) {
  if (!isChatMessage(message)) return null;
  const words = String(message).normalize("NFKC").toLowerCase().match(/[\p{L}\p{M}\p{N}_]+/gu) || [];
  for (const word of words) if (Object.hasOwn(CHAT_KEYWORDS, word)) return CHAT_KEYWORDS[word];
  return null;
}
function chatMessageText(message) {
  const text = String(message || "").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  const characters = Array.from(text);
  return characters.length > CHAT_MESSAGE_LIMIT ? characters.slice(0, CHAT_MESSAGE_LIMIT - 1).join("") + "…" : text;
}
const actionById = id => ACTIONS.find(action => action.id === (id === "guard" ? "rest" : id)) || null;
const actionDuration = id => {
  const action = actionById(id);
  return action ? action.durationMs + (action.id === "attack" ? 2 * EQUIP_MS : 0) : 0;
};

module.exports = { ACTIONS, GREETING_MS, CHAT_MAX_AGE_MS, TRAVEL_MS, EQUIP_MS, ARRIVAL_MS,
  CHAT_REACTION_COOLDOWN_MS, CHAT_BUBBLE_MS, CHAT_BUBBLE_LIMIT, CHAT_MESSAGE_LIMIT, CHAT_KEYWORDS,
  isChatMessage, isChatAction, chatReaction, chatMessageText, actionById, actionDuration };
