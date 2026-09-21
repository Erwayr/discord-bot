"use strict";

const fs = require("fs");
const path = require("path");
const { FieldValue } = require("firebase-admin/firestore");
const { isExcludedLogin } = require("../helper/excludedUsers");
const {
  HALLOWEEN_COSTUME_ID,
  isCostumePresenceEligible,
  costumeGrantId,
} = require("./guardian-costumes.shared.cjs");

const JOURNAL_FILE = "guardian-costume-grants.jsonl";
const RETRY_INTERVAL_MS = 60_000;

function normalizeRecord(source) {
  const twitchUserId = String(source?.twitchUserId || "").trim();
  const costumeId = source?.costumeId || HALLOWEEN_COSTUME_ID;
  const observedAtMs = Number(source?.observedAtMs);
  const streamId = String(source?.streamId || "").trim();
  if (!/^\d{1,25}$/.test(twitchUserId) || !/^[A-Za-z0-9_-]{1,128}$/.test(streamId)
    || !Number.isSafeInteger(observedAtMs)
    || !isCostumePresenceEligible(costumeId, observedAtMs)) return null;
  return { twitchUserId, costumeId, observedAtMs, streamId };
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
} = {}) {
  if (!db || typeof db.collection !== "function") {
    throw new Error("createGuardianCostumeGrants: Firestore Admin required");
  }
  const journalPath = path.join(path.resolve(persistenceDir || ".runtime/live-activity"), JOURNAL_FILE);
  const pending = new Map();
  const completed = new Set();
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
        if (!/^\d{1,25}$/.test(twitchUserId) || row.costumeId !== HALLOWEEN_COSTUME_ID) continue;
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
      if (!completed.has(key)) {
        try {
          // Atomic create makes multiple bot instances and restarts idempotent.
          // No follower lookup or creation: presence alone is sufficient.
          await db.collection("guardian_costume_grants").doc(key).create({
            ...entry,
            unlockedAt: serverTimestamp(),
          });
          created = true;
        } catch (error) {
          if (!isAlreadyExists(error)) { warn("grant write failed"); return { pending: true }; }
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

  function observePresence(source = {}) {
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
