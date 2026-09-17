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
const actionById = id => ACTIONS.find(action => action.id === (id === "guard" ? "rest" : id)) || null;
const actionDuration = id => {
  const action = actionById(id);
  return action ? action.durationMs + (action.id === "attack" ? 2 * EQUIP_MS : 0) : 0;
};

module.exports = { ACTIONS, GREETING_MS, CHAT_MAX_AGE_MS, TRAVEL_MS, EQUIP_MS, actionById, actionDuration };
