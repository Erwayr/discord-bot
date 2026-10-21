"use strict";

// Lightweight animation contract: pages showing a Guardian do not need the
// Twitch chat parser. The server/chat contract re-exports these same values.
const ACTIONS = Object.freeze([
  { id: "rest", clip: "rest", label: "Normale", durationMs: 0 },
  { id: "greet", clip: "wave", label: "Salut", durationMs: 4000 },
  { id: "attack", clip: "attack", label: "Attaque", durationMs: 2400 },
  { id: "victory", clip: "victory", label: "Victoire", durationMs: 3200 },
  { id: "facepalm", clip: "facepalm", label: "Facepalm", durationMs: 4000 },
  { id: "dance", clip: "dance", label: "Danse", durationMs: 10000 },
  { id: "walk", clip: "walk", label: "Marche", durationMs: 4000 },
]);
const GREETING_MS = ACTIONS.find(action => action.id === "greet").durationMs;
const TRAVEL_MS = 2000;
const EQUIP_MS = 600;
const ARRIVAL_MS = TRAVEL_MS + ACTIONS.find(action => action.id === "attack").durationMs + EQUIP_MS;
const actionById = id => ACTIONS.find(action => action.id === (id === "guard" ? "rest" : id)) || null;
const actionDuration = id => {
  const action = actionById(id);
  return action ? action.durationMs + (action.id === "attack" ? 2 * EQUIP_MS : 0) : 0;
};

module.exports = { ACTIONS, GREETING_MS, TRAVEL_MS, EQUIP_MS, ARRIVAL_MS, actionById, actionDuration };
