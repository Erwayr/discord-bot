"use strict";
const { ACTIONS, actionDuration, TRAVEL_MS } = require("./guardian-action-definitions.shared.cjs");

const ACTION_PRODUCT_SKU = "guardian_action_10";
const ACTION_COST_BITS = 10;
const ACTION_VERSION = 1;
const INTENT_MS = 300_000;
const ACTION_QUEUE_MS = 20 * 60_000;
const SOURCE_MS = 45_000;
const LEASE_MS = 30_000;
const PAID_ACTIONS = Object.freeze(ACTIONS.filter(action => action.id !== "rest"));
const isPaidAction = event => event?.type === "paid_action";
const paidAction = id => PAID_ACTIONS.find(action => action.id === id) || null;
const paidDuration = id => paidAction(id) ? 2 * TRAVEL_MS + actionDuration(id) : 0;
const actionReservations = (raw, now, streamId) => Object.fromEntries(Object.entries(raw?.actionReservations || {})
  .filter(([, value]) => value && value.expiresAtMs > now && value.streamId === streamId));
const ordinaryDepth = (queue = []) => queue.filter(event => event.type !== "subscription").length;
const reservedDepth = (raw, now, streamId) => Object.keys(actionReservations(raw, now, streamId)).length;

// The dedicated timeline does not include the ordinary arrival attack.
function paidTimeline(event, offset = 0) {
  return { appearanceId: event.eventId || event.requestId, appearanceType: "paid_action", paidActionId: event.actionId,
    startsAtMs: event.startsAtMs - offset, endsAtMs: event.endsAtMs - offset };
}
module.exports = { ACTION_PRODUCT_SKU, ACTION_COST_BITS, ACTION_VERSION, INTENT_MS, ACTION_QUEUE_MS,
  SOURCE_MS, LEASE_MS, PAID_ACTIONS, isPaidAction, paidAction, paidDuration, actionReservations,
  ordinaryDepth, reservedDepth, paidTimeline };
