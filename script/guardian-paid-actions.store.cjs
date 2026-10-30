"use strict";
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const shared = require("./guardian-paid-actions.shared.cjs");
const { SOURCE_MS, ACTION_VERSION, actionReservations, isPaidAction } = shared;
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const id = () => crypto.randomBytes(20).toString("hex");
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const deliveryRef = (db, channelId, eventId) => db.collection("twitch_extension_channels").doc(channelId)
  .collection("guardian_action_deliveries").doc(eventId);

// Called only after the private Erwayr overlay token has been validated. All
// reads happen here, before the live scheduler persists any writes.
async function prepareErwayrActionPoll({ tx, db, previous, channelId, now, source, prepared, ack }) {
  const raw = { ...previous, queue: (previous.queue || []).map(event => ({ ...event })) };
  if (raw.active) raw.active = { ...raw.active };
  const events = [...raw.queue, ...(raw.active ? [raw.active] : [])].filter(isPaidAction);
  const sessions = Object.fromEntries(Object.entries(raw.actionSessions || {}).filter(([, seen]) => now - seen <= SOURCE_MS));
  if (!Object.keys(sessions).length) raw.queue = raw.queue.filter(event => !isPaidAction(event));
  const capable = source?.version === ACTION_VERSION && /^[A-Za-z0-9_-]{16,80}$/.test(source.sessionId || "");
  if (capable) {
    if (source.active === false) delete sessions[source.sessionId];
    else sessions[source.sessionId] = now;
  }
  if (capable || previous.actionSessions) raw.actionSessions = sessions;
  if (previous.actionReservations) raw.actionReservations = actionReservations(raw, now, raw.liveUntilMs > now ? raw.streamId : "");
  const documents = await Promise.all(events.map(async event => {
    const ref = deliveryRef(db, channelId, event.eventId);
    const value = (await tx.get(ref)).data();
    return { eventId: event.eventId, ref, value, original: value };
  }));
  const currentRecord = event => documents.find(record => record.eventId === event?.eventId);
  const eligible = capable && source.active !== false && raw.liveUntilMs > now;
  const own = event => eligible && event?.sourceSessionId === source.sessionId && event.leaseUntilMs > now;
  const subject = [raw.active, ...raw.queue].find(event => isPaidAction(event) && event.eventId === ack?.eventId);
  if (ack) {
    if (!subject || !own(subject) || subject.claimToken !== ack.claimToken) throw failure("guardian_overlay_lease_mismatch", 409);
    const record = currentRecord(subject);
    if (!record?.value) throw failure("guardian_event_not_found", 404);
    if (ack.outcome === "action_started") {
      if (raw.active !== subject || now < subject.startsAtMs + 2000 || now >= subject.endsAtMs - 2000) throw failure("guardian_action_not_started", 409);
      if (!record.value.actionStartedAtMs) {
        record.value = { ...record.value, actionStartedAtMs: now, status: "started" };
        subject.actionStartedAtMs = now;
      }
    } else if (ack.outcome === "failed") {
      if (raw.active === subject) raw.active = null;
      raw.queue = raw.queue.filter(event => event !== subject);
    } else throw failure("guardian_ack_invalid");
  }
  const active = raw.active;
  if (isPaidAction(active) && eligible && (!active.sourceSessionId || active.leaseUntilMs <= now || active.sourceSessionId === source.sessionId)) {
    const record = currentRecord(active);
    if (active.leaseUntilMs <= now && !record?.value?.actionStartedAtMs) raw.active = null;
    else {
      if (active.sourceSessionId !== source.sessionId) active.claimToken = id();
      active.sourceSessionId = source.sessionId; active.leaseUntilMs = now + shared.LEASE_MS;
    }
  }
  let preparation = null, ready = false;
  const head = raw.queue[0];
  if (!raw.active && isPaidAction(head) && head.expiresAtMs > now && head.streamId === raw.streamId && eligible
    && (!head.sourceSessionId || head.sourceSessionId === source.sessionId || head.leaseUntilMs <= now)) {
    if (head.sourceSessionId !== source.sessionId || head.leaseUntilMs <= now) head.claimToken = id();
    head.sourceSessionId = source.sessionId; head.leaseUntilMs = now + shared.LEASE_MS;
    const fingerprint = hash(JSON.stringify([head.eventId, head.snapshot, head.actionId, head.claimToken]));
    preparation = { appearanceId: head.eventId, fingerprint, viewer: head.snapshot, require3d: true,
      actionId: head.actionId, claimToken: head.claimToken };
    ready = prepared?.appearanceId === head.eventId && prepared.fingerprint === fingerprint;
  }
  return { raw, preparation, ready, own, documents };
}
function commitErwayrActionPoll(tx, context, state, now) {
  for (const record of context.documents) {
    if (!record.value) continue;
    const event = [...state.queue, ...(state.active ? [state.active] : [])].find(event => event.eventId === record.eventId);
    const started = Boolean(record.value.actionStartedAtMs);
    const active = state.active?.eventId === record.eventId ? state.active : null;
    const value = { ...record.value, ...(active ? { startsAtMs: active.startsAtMs, endsAtMs: active.endsAtMs } : {}),
      status: !event ? started ? "completed" : "retryable" : started ? "started" : "queued",
      finished: !event && started };
    if (!isDeepStrictEqual(record.original, value)) tx.set(record.ref, { ...value, updatedAtMs: now });
  }
}
module.exports = { ...shared, deliveryRef, prepareErwayrActionPoll, commitErwayrActionPoll };
