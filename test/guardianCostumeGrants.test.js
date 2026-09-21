"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createGuardianCostumeGrants, JOURNAL_FILE } = require("../script/guardianCostumeGrants");
const { HALLOWEEN_COSTUME_ID } = require("../script/guardian-costumes.shared.cjs");
const { createLivePresenceTicker } = require("../script/livePresenceTracker");

const START = Date.parse("2026-10-23T22:00:00.000Z");
const END = Date.parse("2026-11-07T23:00:00.000Z");
const timestamp = { serverTimestamp: true };
const observation = (twitchUserId = "12345", overrides = {}) => ({
  login: "newviewer", twitchUserId, costumeId: HALLOWEEN_COSTUME_ID,
  observedAtMs: START, streamId: "stream-1", ...overrides,
});

function fixture(t, { db, fileSystem = fs } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-costume-grants-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], documents = new Map(), warnings = [], timers = [];
  let fail = false;
  const database = db || {
    collection(name) {
      assert.equal(name, "guardian_costume_grants", "must never read/create a follower or participant");
      return { doc(key) { return { async create(data) {
        calls.push({ key, data });
        if (fail) throw Object.assign(new Error("PRIVATE_TOKEN_NOT_TO_BE_LOGGED"), { code: "unavailable" });
        if (documents.has(key)) throw Object.assign(new Error("already exists"), { code: 6 });
        documents.set(key, data);
      } }; } };
    },
  };
  const options = {
    db: database, persistenceDir: directory, fileSystem,
    serverTimestamp: () => timestamp,
    logger: { warn: message => warnings.push(message) },
    setIntervalFn(fn, ms) { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearIntervalFn(timer) { timer.cleared = true; },
  };
  const service = createGuardianCostumeGrants(options);
  return { service, options, directory, calls, documents, warnings, timers, setFail: value => { fail = value; } };
}

test("Warsaw event boundaries grant immediate presence with no profile lookup or minimum", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.service.observePresence(observation("1", { observedAtMs: START - 1 })), { skipped: true });
  await f.service.observePresence(observation("2"));
  await f.service.observePresence(observation("3", { observedAtMs: END - 1 }));
  assert.deepEqual(await f.service.observePresence(observation("4", { observedAtMs: END })), { skipped: true });
  await f.service.observePresence(observation("5", { observedAtMs: Date.parse("2026-10-25T01:30:00Z") }));
  assert.deepEqual([...f.documents.keys()], ["2_halloween-2026", "3_halloween-2026", "5_halloween-2026"]);
  assert.deepEqual(f.documents.get("2_halloween-2026"), {
    twitchUserId: "2", costumeId: HALLOWEEN_COSTUME_ID, observedAtMs: START,
    streamId: "stream-1", unlockedAt: timestamp,
  });
});

test("excluded service users and invalid stable IDs cannot receive costumes", async t => {
  const f = fixture(t);
  for (const login of ["wzbot", "StreamElements", "streamstickers"]) {
    await f.service.observePresence(observation("123", { login }));
  }
  for (const twitchUserId of ["", "viewerlogin", "1/2", "-5", "1".repeat(26)]) {
    await f.service.observePresence(observation(twitchUserId));
  }
  await f.service.observePresence(observation("123", { observedAtMs: NaN }));
  await f.service.observePresence(observation("123", { costumeId: "unknown" }));
  await f.service.observePresence(observation("123", { streamId: "" }));
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.pendingSize(), 0);
});

test("concurrent observations and login changes use one grant and a persistent success cache", async t => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    f.service.observePresence(observation("123", { login: `login${index}`, streamId: `stream-${index}` }))));
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.pendingSize(), 0);
  const restarted = createGuardianCostumeGrants(f.options);
  await restarted.start();
  await restarted.observePresence(observation("123", { login: "renamed", streamId: "new-stream" }));
  assert.equal(f.calls.length, 1);
  await restarted.stop();
});

test("failed grants are durably replayed on restart after the window with original observation", async t => {
  const f = fixture(t);
  f.setFail(true);
  await f.service.observePresence(observation("900", { observedAtMs: END - 1 }));
  assert.equal(f.service.pendingSize(), 1);
  const journal = fs.readFileSync(path.join(f.directory, JOURNAL_FILE), "utf8");
  assert.deepEqual(JSON.parse(journal.trim()), {
    twitchUserId: "900", costumeId: HALLOWEEN_COSTUME_ID,
    observedAtMs: END - 1, streamId: "stream-1",
  });
  assert(!f.warnings.join(" ").includes("PRIVATE_TOKEN"));
  f.setFail(false);
  const realNow = Date.now;
  Date.now = () => END + 30 * 86400_000;
  try {
    const restarted = createGuardianCostumeGrants(f.options);
    await restarted.start();
    assert.equal(restarted.pendingSize(), 0);
    assert.equal(f.documents.get("900_halloween-2026").observedAtMs, END - 1);
    await restarted.stop();
  } finally { Date.now = realNow; }
});

test("retry timer and shutdown flush recover errors independently of presence ticks", async t => {
  const f = fixture(t);
  await f.service.start();
  f.setFail(true);
  await f.service.observePresence(observation("10"));
  f.setFail(false);
  f.timers[0].fn();
  await f.service.flush();
  assert(f.documents.has("10_halloween-2026"));
  f.setFail(true);
  await f.service.observePresence(observation("11"));
  f.setFail(false);
  await f.service.stop();
  assert(f.documents.has("11_halloween-2026"));
  assert.equal(f.timers[0].cleared, true);
  assert.deepEqual(await f.service.observePresence(observation("12")), { skipped: true });
});

test("atomic create is idempotent across independent bot instances and preserves existing metadata", async t => {
  const f = fixture(t);
  const other = fixture(t, { db: f.options.db });
  await Promise.all([
    f.service.observePresence(observation("80", { streamId: "first" })),
    other.service.observePresence(observation("80", { streamId: "second", observedAtMs: START + 1000 })),
  ]);
  assert.equal(f.documents.size, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.documents.get("80_halloween-2026").streamId, "first");
  assert.equal(other.service.pendingSize(), 0);
  await other.service.observePresence(observation("80"));
  assert.equal(f.calls.length, 2);
});

test("an unavailable journal keeps evidence in memory and prevents unjournaled remote grants", async t => {
  let failing = true;
  const fileSystem = { ...fs, openSync(...args) {
    if (failing) throw Object.assign(new Error("disk unavailable"), { code: "EACCES" });
    return fs.openSync(...args);
  } };
  const f = fixture(t, { fileSystem });
  await f.service.observePresence(observation("50"));
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.pendingSize(), 1);
  failing = false;
  await f.service.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.pendingSize(), 0);
});

test("failed success acknowledgement retries the journal without another Firestore write", async t => {
  let failing = true;
  const fileSystem = { ...fs, writeSync(descriptor, text) {
    if (failing && text.includes('"done":true')) throw new Error("disk unavailable");
    return fs.writeSync(descriptor, text);
  } };
  const f = fixture(t, { fileSystem });
  await f.service.observePresence(observation("60"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.pendingSize(), 1);
  failing = false;
  await f.service.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.pendingSize(), 0);
});

test("partial trailing journal records do not swallow subsequent observations", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, JOURNAL_FILE), '{"twitchUserId":');
  const restarted = createGuardianCostumeGrants(f.options);
  await restarted.observePresence(observation("70"));
  const again = createGuardianCostumeGrants(f.options);
  await again.start();
  await again.observePresence(observation("70"));
  assert.equal(f.calls.length, 1);
  await again.stop();
});

test("an already present viewer receives the costume when a later real tick crosses opening", async t => {
  const f = fixture(t);
  let nowMs = START - 1;
  const ordinary = [], observed = [];
  const tick = createLivePresenceTicker({
    db: {}, tokenManager: {}, clientId: "test", broadcasterId: "123", moderatorId: "123",
    now: () => nowMs,
    helixClient: async ({ url }) => ({ data: { data: url.endsWith("/streams")
      ? [{ id: "stream-1", started_at: "2026-10-23T20:00:00Z" }]
      : [{ user_id: "99", user_login: "existingviewer" }, { user_id: "88", user_login: "wzbot" }] } }),
    questStore: { notePresence: async (...args) => ordinary.push(args) },
  });
  tick.setPresenceObservedHandler(async entry => { observed.push(entry); return f.service.observePresence(entry); });
  await tick();
  assert.equal(ordinary.length, 1);
  assert.equal(f.calls.length, 0);
  nowMs = START;
  await tick();
  assert.equal(observed.length, 2, "event hook runs before the presence shortcut");
  assert.equal(observed[1].twitchUserId, "99");
  assert.equal(observed[1].observedAtMs, START);
  assert.equal(f.documents.get("99_halloween-2026").observedAtMs, START);
  const processedAtOpening = ordinary.length;
  nowMs = START + 1000;
  await tick();
  assert.equal(ordinary.length, processedAtOpening, "ordinary presence remains deduplicated after seasonal processing");
  assert.equal(observed.length, 3, "costume hook continues even after every presence shortcut applies");
  assert.equal(f.calls.length, 1, "successful costume grant stays cached");
});

test("a costume hook failure does not block ordinary presence or other viewers", async () => {
  const ordinary = [], observed = [];
  const tick = createLivePresenceTicker({
    db: {}, tokenManager: {}, clientId: "test", broadcasterId: "123", moderatorId: "123",
    now: () => START,
    helixClient: async ({ url }) => ({ data: { data: url.endsWith("/streams")
      ? [{ id: "stream-2", started_at: "2026-10-24T20:00:00Z" }]
      : [{ user_id: "10", user_login: "alice" }, { user_id: "11", user_login: "bob" }] } }),
    onPresenceObserved: async entry => { observed.push(entry.login); if (entry.login === "alice") throw new Error("private"); },
    questStore: { notePresence: async login => ordinary.push(login) },
  });
  await tick();
  assert.deepEqual(observed, ["alice", "bob"]);
  assert.deepEqual(ordinary, ["alice", "bob"]);
});
