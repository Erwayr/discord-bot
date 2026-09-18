"use strict";
const { randomUUID } = require("node:crypto");
const SIGNAL_IDS = Object.freeze(["guardian", "live_chests"]);
const SESSION_MS = 15 * 60_000;
const RENEW_MS = 12 * 60_000;
function signalRef(db, kind) {
  if (!SIGNAL_IDS.includes(kind)) throw Object.assign(new Error("overlay_signal_invalid"), { status: 400 });
  return db.collection("overlay_state_signals").doc(kind);
}
// Use the same batch/transaction as the visible change. Never put private state here.
function writeOverlaySignal(writer, db, kind, { configChanged = false, now = Date.now() } = {}) {
  const revision = randomUUID();
  writer.set(signalRef(db, kind), {
    schemaVersion: 1, revision, updatedAtMs: now, updatedAt: new Date(now),
    ...(configChanged ? { configRevision: revision } : {}),
  }, { merge: true });
}
async function createOverlayStateSession({ db, auth, kind, now = Date.now() }) {
  const ref = signalRef(db, kind);
  await db.runTransaction(async tx => {
    if (!(await tx.get(ref)).exists) writeOverlaySignal(tx, db, kind, { configChanged: true, now });
  });
  const expiresAtMs = now + SESSION_MS;
  const customToken = await auth.createCustomToken(`obs_state_${kind}`, {
    overlayStateSignal: true, overlaySignalId: kind, overlayExpiresAtMs: expiresAtMs,
  });
  return { ok: true, customToken, signalId: kind, expiresAtMs, renewAtMs: now + RENEW_MS };
}
module.exports = { SIGNAL_IDS, SESSION_MS, RENEW_MS, signalRef, writeOverlaySignal, createOverlayStateSession };
