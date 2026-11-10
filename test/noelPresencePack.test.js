"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createGuardianCostumeGrants, JOURNAL_FILE } = require("../script/guardianCostumeGrants");
const { createLivePresenceTicker } = require("../script/livePresenceTracker");
const { createQuestStorage } = require("../script/questStorage");
const { NOEL_2026_EVENT: EVENT, HALLOWEEN_2026_EVENT: HALLOWEEN, hasHalloween2026Grant, hasSeasonalCosmeticGrant } = require("../script/seasonal-cosmetics.shared.cjs");
const { ownsCostume } = require("../script/guardian-costumes.shared.cjs");

const copy = value => value === undefined ? undefined : structuredClone(value);
const plain = value => value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
function merge(target = {}, source = {}) {
  const output = copy(target);
  for (const [key, value] of Object.entries(source)) output[key] = plain(value) ? merge(plain(output[key]) ? output[key] : {}, value) : copy(value);
  return output;
}
function update(target, changes) {
  const output = copy(target);
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split(".");
    let node = output;
    for (const key of keys.slice(0, -1)) node = node[key] ||= {};
    node[keys.at(-1)] = copy(value);
  }
  return output;
}
function database(initial = {}) {
  const docs = new Map(Object.entries(copy(initial))), calls = [], commits = [];
  let failCreate = false, failTransaction = false;
  const snapshot = key => ({ exists: docs.has(key), data: () => copy(docs.get(key)) });
  const db = {
    docs, calls, commits,
    failCreate: value => { failCreate = value; },
    failTransaction: value => { failTransaction = value; },
    collection(name) {
      return { doc(id) {
        const key = `${name}/${id}`;
        return { path: key, id, get: async () => snapshot(key), async create(data) {
          calls.push({ path: key, data: copy(data) });
          if (failCreate) throw Object.assign(new Error("private failure"), { code: "unavailable" });
          if (docs.has(key)) throw Object.assign(new Error("exists"), { code: 6 });
          docs.set(key, copy(data));
        } };
      } };
    },
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        get: async ref => { assert.equal(writes.length, 0, "Firestore reads must precede writes"); return snapshot(ref.path); },
        update: (ref, changes) => {
          const keys = Object.keys(changes);
          assert(!keys.some(parent => keys.some(child => child.startsWith(`${parent}.`))), "Firestore update paths must not overlap");
          writes.push({ type: "update", path: ref.path, changes: copy(changes) });
        },
        set: (ref, data, options = {}) => writes.push({ type: "set", path: ref.path, changes: copy(data), merge: options.merge }),
      });
      if (failTransaction && writes.length) throw new Error("transaction unavailable");
      const pending = new Map(docs);
      for (const write of writes) {
        if (write.type === "update") {
          assert(pending.has(write.path), "update must not create a follower");
          pending.set(write.path, update(pending.get(write.path), write.changes));
        } else pending.set(write.path, write.merge ? merge(pending.get(write.path), write.changes) : write.changes);
      }
      for (const [key, value] of pending) docs.set(key, value);
      if (writes.length) commits.push(writes);
      return result;
    },
  };
  return db;
}
const follower = (id = "123") => ({
  twitch_id: id, pops: { balance: 765 }, customProfileFrameId: "old-frame", customExperienceBarId: "old-bar",
  currentGuardian: { character: { costume: "none", face: "oval" } },
  popsShop: { profileFrames: { activeId: "old-frame", owned: { old: { id: "old" } } },
    experienceBars: { activeId: "old-bar", owned: { old: { id: "old" } } }, weaponSkins: { owned: { other: { id: "other" } } } },
  guardianCosmetics: { costumes: { owned: { other: { costumeId: "other" } } } },
});
const observation = (overrides = {}) => ({ login: "viewer", twitchUserId: "123", observedAtMs: EVENT.startsAtMs, streamId: "noel-live", ...overrides });
const receipt = (overrides = {}) => ({ costumeId: EVENT.costumeId, twitchUserId: "123", observedAtMs: EVENT.startsAtMs,
  streamId: "noel-live", unlockedAt: new Date(EVENT.endsAtMs + 1000), ...overrides });
function fixture(t, { db = database({ "followers_all_time/viewer": follower() }), resolver } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "noel-presence-pack-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identities = [], warnings = [];
  const options = { db, persistenceDir: directory, serverTimestamp: () => new Date(EVENT.endsAtMs + 1000),
    resolveTwitchIdentity: async input => { identities.push(input); return resolver ? resolver(input) : { login: input.login, twitchUserId: input.twitchUserId, status: "active" }; },
    logger: { warn: text => warnings.push(text) }, setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {} };
  return { db, directory, identities, warnings, options, service: createGuardianCostumeGrants(options) };
}
function assertTrio(profile) {
  assert(hasSeasonalCosmeticGrant(profile, EVENT.frameId));
  assert(hasSeasonalCosmeticGrant(profile, EVENT.barId));
  assert(ownsCostume(profile, EVENT.costumeId));
}
async function at(now, action) {
  const before = Date.now;
  Date.now = () => now;
  try { return await action(); } finally { Date.now = before; }
}

test("Noël grants the trio from December 1 through December 31 Warsaw only", async t => {
  const f = fixture(t);
  const local = ms => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw", dateStyle: "short", timeStyle: "medium" }).format(ms);
  assert.equal(local(EVENT.startsAtMs), "2026-12-01 00:00:00");
  assert.equal(local(EVENT.endsAtMs), "2027-01-01 00:00:00");
  for (const observedAtMs of [EVENT.startsAtMs - 1, EVENT.endsAtMs, Date.parse("2027-12-15T12:00:00Z")]) {
    assert.deepEqual(await f.service.observePresence(observation({ observedAtMs })), { skipped: true });
  }
  await f.service.observePresence(observation({ observedAtMs: EVENT.endsAtMs - 1 }));
  assertTrio(f.db.docs.get("followers_all_time/viewer"));
  assert.equal(f.db.calls.length, 1);
  assert.deepEqual(Object.keys(f.db.calls[0].data).sort(), ["costumeId", "observedAtMs", "streamId", "twitchUserId", "unlockedAt"]);
  assert(f.identities.every(input => input.allowCreate === false));
});

test("one follower transaction projects all three without changing wallet, equipment or other owned entries", async t => {
  const original = follower(), f = fixture(t);
  await Promise.all(Array.from({ length: 15 }, () => f.service.observePresence(observation())));
  const saved = f.db.docs.get("followers_all_time/viewer");
  assertTrio(saved);
  assert.equal(f.db.calls.length, 1);
  assert.equal(f.db.commits.length, 1);
  assert.deepEqual(Object.keys(f.db.commits[0][0].changes).sort(), ["guardianCosmetics.costumes.owned", "popsShop.experienceBars.owned", "popsShop.profileFrames.owned"]);
  for (const key of ["pops", "customProfileFrameId", "customExperienceBarId", "currentGuardian"]) assert.deepEqual(saved[key], original[key]);
  assert.deepEqual(saved.popsShop.weaponSkins, original.popsShop.weaponSkins);
  assert.deepEqual(saved.popsShop.profileFrames.owned.old, original.popsShop.profileFrames.owned.old);
  assert.deepEqual(saved.guardianCosmetics.costumes.owned.other, original.guardianCosmetics.costumes.owned.other);
  assert(![...f.db.docs.keys()].some(key => key.startsWith("participants/")));
});

test("a duplicate receipt retains its immutable metadata and repairs all three projections", async t => {
  const proof = receipt({ streamId: "original-stream" });
  const db = database({ "followers_all_time/viewer": follower(), "guardian_costume_grants/123_noel-2026": proof });
  const f = fixture(t, { db });
  await f.service.observePresence(observation({ streamId: "later-stream" }));
  assert.deepEqual(db.docs.get("guardian_costume_grants/123_noel-2026"), proof);
  assertTrio(db.docs.get("followers_all_time/viewer"));
  assert.equal(f.service.pendingSize(), 0);
});

test("failed atomic projection remains pending and replays after the event without partial rights", async t => {
  const f = fixture(t);
  f.db.failTransaction(true);
  await f.service.observePresence(observation());
  assert.equal(f.service.pendingSize(), 1);
  assert.deepEqual(f.db.docs.get("followers_all_time/viewer"), follower());
  const rows = fs.readFileSync(path.join(f.directory, JOURNAL_FILE), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1); assert.equal(rows[0].login, "viewer");
  f.db.failTransaction(false);
  const restarted = createGuardianCostumeGrants(f.options);
  await at(EVENT.endsAtMs + 86400_000, () => restarted.start());
  assertTrio(f.db.docs.get("followers_all_time/viewer"));
  assert.equal(restarted.pendingSize(), 0);
  await restarted.stop();
  const afterDone = createGuardianCostumeGrants(f.options);
  const before = f.db.calls.length;
  await afterDone.observePresence(observation());
  assert.equal(f.db.calls.length, before, "Noël completion record survives restart");
  assert(!f.warnings.join(" ").includes("private"));
});

test("a missing follower retains its receipt and pending journal without bypassing profile creation", async t => {
  const f = fixture(t, { db: database() });
  const result = await f.service.observePresence(observation());
  assert.equal(result.deferred, true);
  assert.equal(f.service.pendingSize(), 1);
  assert.equal(f.db.docs.size, 1);
  assert(f.db.docs.has("guardian_costume_grants/123_noel-2026"));
  await f.service.flush();
  assert.equal(f.db.docs.size, 1);
});

test("ordinary ten-minute profile creation atomically replays the earlier receipt after closure", async t => {
  const f = fixture(t, { db: database() });
  await f.service.observePresence(observation());
  const store = createQuestStorage(f.db, { minNewProfilePresenceMs: 600_000,
    resolveTwitchIdentity: f.options.resolveTwitchIdentity });
  const activity = { startedAt: new Date(EVENT.startsAtMs), twitchUserId: "123", flushId: "new-profile",
    presenceFirstSeenAtMs: EVENT.startsAtMs, presenceLastSeenAtMs: EVENT.startsAtMs + 600_000,
    observedPresenceMs: 599_999, uptimeMs: 0 };
  await at(EVENT.endsAtMs + 1000, async () => {
    const early = await store.noteLiveActivity("viewer", "noel-live", activity);
    assert.equal(early.reason, "new_profile_presence_below_threshold");
    assert(!f.db.docs.has("followers_all_time/viewer"));
    const created = await store.noteLiveActivity("viewer", "noel-live", { ...activity, observedPresenceMs: 600_000 });
    assert.equal(created.applied, true);
  });
  assertTrio(f.db.docs.get("followers_all_time/viewer"));
  const creation = f.db.commits.flat().find(write => write.type === "set" && write.path === "followers_all_time/viewer");
  assertTrio(creation.changes);
  assert(!Object.keys(creation.changes).some(key => key.includes(".")), "new profile uses nested maps, not literal dotted fields");
  await f.service.flush();
  assert.equal(f.service.pendingSize(), 0);
});

test("renamed viewers project only to their canonical existing follower", async t => {
  const f = fixture(t, { db: database({ "followers_all_time/oldlogin": follower() }),
    resolver: input => ({ login: "oldlogin", twitchUserId: input.twitchUserId, status: "rename_pending" }) });
  await f.service.observePresence(observation({ login: "renamed" }));
  assertTrio(f.db.docs.get("followers_all_time/oldlogin"));
  assert(!f.db.docs.has("followers_all_time/renamed"));
});

test("a delayed Halloween activity patch and Noël receipt compose without overlapping Firestore update paths", async t => {
  const proof = receipt(), f = fixture(t, { db: database({
    "followers_all_time/viewer": follower(), "guardian_costume_grants/123_noel-2026": proof,
  }) });
  const store = createQuestStorage(f.db);
  await at(EVENT.endsAtMs + 1000, () => store.noteLiveActivity("viewer", "delayed-live", {
    twitchUserId: "123", startedAt: new Date(HALLOWEEN.startsAtMs),
    presenceFirstSeenAtMs: HALLOWEEN.startsAtMs, presenceLastSeenAtMs: HALLOWEEN.startsAtMs,
    seasonalPresenceAtMs: HALLOWEEN.startsAtMs, observedPresenceMs: 600_000, flushId: "delayed-halloween",
  }));
  const saved = f.db.docs.get("followers_all_time/viewer");
  assertTrio(saved);
  assert(hasHalloween2026Grant(saved, "profile-frame"));
  assert(hasHalloween2026Grant(saved, "experience-bar"));
  assert.deepEqual(saved.popsShop.profileFrames.owned.old, { id: "old" });
});

test("identity conflicts preserve receipt and follower while keeping the projection pending", async t => {
  const profile = follower("999"), f = fixture(t, { db: database({ "followers_all_time/viewer": profile }) });
  await f.service.observePresence(observation());
  assert.deepEqual(f.db.docs.get("followers_all_time/viewer"), profile);
  assert.equal(f.db.commits.length, 0);
  assert.equal(f.service.pendingSize(), 1);
  assert(f.db.docs.has("guardian_costume_grants/123_noel-2026"));
});

test("invalid existing receipts cannot produce rights or be overwritten", async t => {
  const proof = receipt({ twitchUserId: "999" });
  const f = fixture(t, { db: database({ "followers_all_time/viewer": follower(), "guardian_costume_grants/123_noel-2026": proof }) });
  await f.service.observePresence(observation());
  assert.deepEqual(f.db.docs.get("followers_all_time/viewer"), follower());
  assert.deepEqual(f.db.docs.get("guardian_costume_grants/123_noel-2026"), proof);
  assert.equal(f.service.pendingSize(), 1);
});

test("service accounts and malformed observed identity never create Noël receipts", async t => {
  const f = fixture(t);
  for (const overrides of [{ login: "StreamElements" }, { login: "wzbot" }, { login: "streamstickers" },
    { twitchUserId: "not-an-id" }, { twitchUserId: "" }, { login: "" }, { streamId: "" }]) {
    await f.service.observePresence(observation(overrides));
  }
  assert.equal(f.db.calls.length, 0);
});

test("a real Noël tick after opening grants a viewer already deduplicated for the live", async t => {
  const f = fixture(t);
  let now = EVENT.startsAtMs - 1;
  const ordinary = [];
  const ticker = createLivePresenceTicker({ db: {}, tokenManager: {}, clientId: "test", broadcasterId: "123", moderatorId: "123",
    now: () => now, questStore: { notePresence: async (...args) => ordinary.push(args) },
    helixClient: async ({ url }) => ({ data: { data: url.endsWith("/streams")
      ? [{ id: "noel-live", started_at: new Date(EVENT.startsAtMs - 60_000).toISOString() }]
      : [{ user_id: "123", user_login: "viewer" }] } }) });
  ticker.setPresenceObservedHandler(f.service.observePresence);
  await ticker();
  assert.equal(f.db.calls.length, 0);
  now = EVENT.startsAtMs;
  await ticker();
  assertTrio(f.db.docs.get("followers_all_time/viewer"));
  assert.equal(ordinary.length, 1);
});

test("portable Noël and costume contracts exactly match canonical site sources", () => {
  for (const file of ["noel-pack.shared.cjs", "seasonal-cosmetics.shared.cjs", "guardian-costumes.shared.cjs", "guardian-character.shared.cjs"]) {
    const canonical = path.resolve(__dirname, "../../ErwayrWebSite/functions", file);
    if (!fs.existsSync(canonical)) continue;
    assert.equal(fs.readFileSync(path.resolve(__dirname, "../script", file), "utf8").replace(/\r\n/g, "\n"),
      fs.readFileSync(canonical, "utf8").replace(/\r\n/g, "\n"), file);
  }
});

test("legacy journal observations without costumeId still replay the original Halloween grant", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.directory, JOURNAL_FILE), `${JSON.stringify({
    twitchUserId: "123", streamId: "old-halloween-live", observedAtMs: HALLOWEEN.startsAtMs,
  })}\n`);
  const restarted = createGuardianCostumeGrants(f.options);
  await restarted.start();
  assert(f.db.docs.has("guardian_costume_grants/123_halloween-2026"));
  assert(!f.db.docs.has("guardian_costume_grants/123_noel-2026"));
  assert.equal(f.identities.length, 0, "legacy Halloween receipt does not require follower resolution");
  assert.equal(restarted.pendingSize(), 0);
  await restarted.stop();
});
