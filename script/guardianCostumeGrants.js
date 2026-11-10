"use strict";

const fs = require("fs");
const path = require("path");
const { FieldValue } = require("firebase-admin/firestore");
const { isExcludedLogin } = require("../helper/excludedUsers");
const {
  HALLOWEEN_COSTUME_ID,
  NOEL_COSTUME_ID,
  COSTUMES,
  isCostumePresenceEligible,
  costumeGrantId,
} = require("./guardian-costumes.shared.cjs");
const { normalizeNoelPackGrant, prepareNoelPackReconciliation } = require("./noel-pack.shared.cjs");

const JOURNAL_FILE = "guardian-costume-grants.jsonl";
const RETRY_INTERVAL_MS = 60_000;

function normalizeRecord(source) {
  const twitchUserId = String(source?.twitchUserId || "").trim();
  const costumeId = source?.costumeId || HALLOWEEN_COSTUME_ID;
  const observedAtMs = Number(source?.observedAtMs);
  const streamId = String(source?.streamId || "").trim();
  const login = String(source?.login || "").trim().toLowerCase();
  if (!/^\d{1,25}$/.test(twitchUserId) || !/^[A-Za-z0-9_-]{1,128}$/.test(streamId)
    || !Number.isSafeInteger(observedAtMs)
    || !isCostumePresenceEligible(costumeId, observedAtMs)
    || costumeId === NOEL_COSTUME_ID && !/^[a-z0-9_]{1,25}$/.test(login)) return null;
  // Login is journal-only routing context. The immutable receipt stays bound
  // exclusively to the stable Twitch ID and the actual observation.
  return { twitchUserId, costumeId, observedAtMs, streamId,
    ...(costumeId === NOEL_COSTUME_ID ? { login } : {}) };
}

function isAlreadyExists(error) {
  return [6, "6", "already-exists", "ALREADY_EXISTS"].includes(error?.code);
}

function createGuardianCostumeGrants({
  db,
  persistenceDir = ".runtime/live-activity",
  retryIntervalMs = RETRY_INTERVAL_MS,
  serverTimestamp = () => FieldValue.serverTimestamp(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
  fileSystem = fs,
  resolveTwitchIdentity,
} = {}) {
  if (!db || typeof db.collection !== "function") {
    throw new Error("createGuardianCostumeGrants: Firestore Admin required");
  }
  const journalPath = path.join(path.resolve(persistenceDir || ".runtime/live-activity"), JOURNAL_FILE);
  const pending = new Map();
  const completed = new Set();
  const receipted = new Set();
  const inFlight = new Map();
  let loaded = false;
  let needsNewline = false;
  let timer = null;
  let stopped = false;

  // Never include SDK response bodies, request headers or arbitrary error text.
  function warn(reason) { logger.warn?.(`[guardian-costumes] ${reason}; pending grants will retry`); }

  function loadJournal() {
    if (loaded) return true;
    let text;
    try { text = fileSystem.readFileSync(journalPath, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") { loaded = true; return true; }
      warn("journal unavailable"); return false;
    }
    needsNewline = !!text && !text.endsWith("\n");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); }
      catch { warn("incomplete journal record ignored"); continue; }
      if (row.done === true) {
        const twitchUserId = String(row.twitchUserId || "");
        if (!/^\d{1,25}$/.test(twitchUserId)
          || !COSTUMES.some(costume => costume.id === row.costumeId
            && [HALLOWEEN_COSTUME_ID, NOEL_COSTUME_ID].includes(costume.id))) continue;
        const key = costumeGrantId(twitchUserId, row.costumeId);
        completed.add(key); pending.delete(key);
        continue;
      }
      const entry = normalizeRecord(row);
      if (!entry) continue;
      const key = costumeGrantId(entry.twitchUserId, entry.costumeId);
      if (!completed.has(key)) pending.set(key, { entry, durable: true });
    }
    loaded = true;
    return true;
  }

  async function projectNoelPack(entry, key) {
    if (typeof resolveTwitchIdentity !== "function") throw new Error("noel_identity_resolver_required");
    const identity = await resolveTwitchIdentity({
      login: entry.login, twitchUserId: entry.twitchUserId, allowCreate: false,
    });
    const login = String(identity?.login || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login) || identity?.status === "conflict"
      || identity?.twitchUserId && String(identity.twitchUserId) !== entry.twitchUserId) {
      throw new Error("noel_identity_conflict");
    }
    return db.runTransaction(async tx => {
      const followerRef = db.collection("followers_all_time").doc(login);
      const receiptRef = db.collection("guardian_costume_grants").doc(key);
      const [follower, receipt] = await Promise.all([tx.get(followerRef), tx.get(receiptRef)]);
      if (!follower.exists) return false;
      if (!receipt.exists) throw new Error("noel_receipt_missing");
      const grant = normalizeNoelPackGrant(receipt.data(), entry.twitchUserId);
      if (!grant) throw new Error("noel_receipt_invalid");
      const prepared = prepareNoelPackReconciliation({
        profile: follower.data() || {}, twitchUserId: entry.twitchUserId, grant,
      });
      if (Object.keys(prepared.update).length) tx.update(followerRef, prepared.update);
      return true;
    });
  }

  function appendJournal(record) {
    if (!loadJournal()) return false;
    let descriptor;
    try {
      fileSystem.mkdirSync(path.dirname(journalPath), { recursive: true });
      descriptor = fileSystem.openSync(journalPath, "a");
      const text = `${needsNewline ? "\n" : ""}${JSON.stringify(record)}\n`;
      if (fileSystem.writeSync(descriptor, text) !== Buffer.byteLength(text)) throw new Error("incomplete journal write");
      fileSystem.fsyncSync(descriptor);
      needsNewline = false;
      return true;
    } catch { needsNewline = true; warn("journal write failed"); return false; }
    finally { if (descriptor !== undefined) { try { fileSystem.closeSync(descriptor); } catch {} } }
  }

  function attempt(key) {
    if (inFlight.has(key)) return inFlight.get(key);
    const job = Promise.resolve().then(async () => {
      if (!loadJournal()) return { pending: true };
      const state = pending.get(key);
      if (!state) return { skipped: true };
      if (!state.durable) {
        state.durable = appendJournal(state.entry);
        if (!state.durable) return { pending: true };
      }
      const { entry } = state;
      let created = false;
      if (!completed.has(key) && !receipted.has(key)) {
        try {
          // Atomic create makes multiple bot instances and restarts idempotent.
          // No follower lookup or creation: presence alone is sufficient.
          const { login, ...receipt } = entry;
          await db.collection("guardian_costume_grants").doc(key).create({
            ...receipt,
            unlockedAt: serverTimestamp(),
          });
          created = true;
        } catch (error) {
          if (!isAlreadyExists(error)) { warn("grant write failed"); return { pending: true }; }
        }
        receipted.add(key);
      }
      if (!completed.has(key)) {
        if (entry.costumeId === NOEL_COSTUME_ID) {
          try {
            if (!await projectNoelPack(entry, key)) return { granted: created, owned: true, deferred: true, pending: true };
          } catch { warn("pack projection deferred"); return { granted: created, owned: true, pending: true }; }
        }
        completed.add(key);
      }
      if (appendJournal({ done: true, twitchUserId: entry.twitchUserId, costumeId: entry.costumeId })) {
        pending.delete(key);
      }
      return { granted: created, owned: true, pending: pending.has(key) };
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  }

  function observeCostume(source = {}) {
    if (stopped || isExcludedLogin(source.login)) return Promise.resolve({ skipped: true });
    const entry = normalizeRecord(source);
    if (!entry) return Promise.resolve({ skipped: true });
    const journalAvailable = loadJournal();
    const key = costumeGrantId(entry.twitchUserId, entry.costumeId);
    if (completed.has(key) && !pending.has(key)) return Promise.resolve({ owned: true });
    if (!pending.has(key)) {
      // Persist the actual observation before attempting any remote write.
      pending.set(key, { entry, durable: false });
    }
    const state = pending.get(key);
    if (journalAvailable && !state.durable) state.durable = appendJournal(state.entry);
    return attempt(key);
  }

  function observePresence(source = {}) {
    if (source.costumeId) return observeCostume(source);
    const eligible = COSTUMES.filter(costume => isCostumePresenceEligible(costume.id, Number(source.observedAtMs)));
    if (!eligible.length) return Promise.resolve({ skipped: true });
    if (eligible.length === 1) return observeCostume({ ...source, costumeId: eligible[0].id });
    return Promise.all(eligible.map(costume => observeCostume({ ...source, costumeId: costume.id })));
  }

  async function flush() {
    if (!loadJournal()) return { pending: pending.size };
    const keys = [...pending.keys()];
    for (let index = 0; index < keys.length; index += 25) {
      await Promise.all(keys.slice(index, index + 25).map(attempt));
    }
    return { pending: pending.size };
  }

  function start() {
    stopped = false;
    if (!timer) {
      const interval = Number(retryIntervalMs);
      timer = setIntervalFn(() => { void flush().catch(() => warn("retry failed")); },
        Number.isFinite(interval) && interval > 0 ? interval : RETRY_INTERVAL_MS);
      timer.unref?.();
    }
    // Replays the saved observation time, including after the event has ended.
    return flush();
  }

  async function stop() {
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    return flush();
  }

  loadJournal();
  return { observePresence, start, stop, flush, pendingSize: () => pending.size };
}

module.exports = { createGuardianCostumeGrants, JOURNAL_FILE, RETRY_INTERVAL_MS };
