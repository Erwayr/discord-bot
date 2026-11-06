"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { recalculateCommunityLevelRanks, normalizeCommunityLevel } = require("../script/communityLevel");
const { CommunityRankDb } = require("./helpers/communityRankDb");

const member = (level, xpTotal, rank = 0) => ({
  communityLevel: { level, xpTotal, rank, rankName: "minimoys", xpInLevel: 25, chatMessages: 17 },
  pops: { balance: 999 }, cards_generated: [{ id: "earned-card" }],
});

test("rank refresh skips current metadata, including mirrors", async () => {
  const alice = member(5, 500, 1), bob = member(1, 100, 2);
  const db = new CommunityRankDb({ alice, bob }, { alice });
  assert.deepEqual(await recalculateCommunityLevelRanks(db), { updated: 0, skipped: false });
  assert.equal(db.commits, 0);
  assert.equal(db.cacheWrites, 0);
});

test("Erwayr and service accounts never shift Lazizy's rank, by ID or pseudo and case", async () => {
  const excluded = { ErWaYr: member(9, 900, 1), alias: { ...member(9, 900, 2), pseudo: " ERWAYR " },
    WzBoT: member(9, 900, 3), botAlias: { ...member(9, 900, 4), pseudo: "StreamElements" },
    streamstickers: member(9, 900, 5) };
  const db = new CommunityRankDb({ ...excluded, lazizy: member(5, 500, 6), second: member(4, 400, 7) },
    { lazizy: member(5, 500, 6), ErWaYr: member(9, 900, 1) });
  await recalculateCommunityLevelRanks(db);
  assert.equal(db.tables.followers_all_time.lazizy.communityLevel.rank, 1);
  assert.equal(db.tables.participants.lazizy.communityLevel.rank, 1);
  assert.equal(db.tables.followers_all_time.second.communityLevel.rank, 2);
  for (const id of Object.keys(excluded)) assert.equal(db.tables.followers_all_time[id].communityLevel.rank, 0, id);
  assert.equal(db.tables.participants.ErWaYr.communityLevel.rank, 0);
});

test("ranks use descending level, descending XP and alphabetical pseudo", async () => {
  const db = new CommunityRankDb({ z: { ...member(5, 500), pseudo: "Alpha" },
    a: { ...member(5, 500), pseudo: "Zulu" }, xp: member(5, 600), highest: member(6, 1),
    inactive: member(0, 0, 1), unknown: { pseudo: "unknown" } });
  await recalculateCommunityLevelRanks(db);
  for (const [id, rank] of [["highest", 1], ["xp", 2], ["z", 3], ["a", 4], ["inactive", 0]]) {
    assert.equal(db.tables.followers_all_time[id].communityLevel.rank, rank, id);
  }
  assert.equal(db.tables.followers_all_time.unknown.communityLevel, undefined);
});

test("nested writes preserve progression and are idempotent; literal artifacts alone are deleted", async () => {
  const original = { ...member(5, 500, 2), "communityLevel.rank": 99,
    "communityLevel.rankName": "wrong", "communityLevel.updatedAt": 3, "communityLevel.unrelated": "keep" };
  const db = new CommunityRankDb({ alice: original });
  assert.deepEqual(await recalculateCommunityLevelRanks(db), { updated: 1, skipped: false });
  const result = db.tables.followers_all_time.alice;
  assert.equal(result.communityLevel.rank, 1);
  assert.equal(typeof result.communityLevel.updatedAt, "number");
  for (const field of ["level", "xpTotal", "xpInLevel", "chatMessages"]) {
    assert.equal(result.communityLevel[field], original.communityLevel[field]);
  }
  assert.deepEqual(result.pops, original.pops);
  assert.deepEqual(result.cards_generated, original.cards_generated);
  for (const field of ["rank", "rankName", "updatedAt"]) assert.equal(Object.hasOwn(result, `communityLevel.${field}`), false);
  assert.equal(result["communityLevel.unrelated"], "keep");
  const revision = db.tables.function_cache.public_home_followers_v1.revision;
  assert.notEqual(revision, "before");
  assert.equal(db.tables.function_cache.public_home_followers_v1.leaseOwner, "active");
  assert.equal(db.tables.function_cache.public_home_followers_v1.leaseExpiresAtMs, 123);
  assert.deepEqual(await recalculateCommunityLevelRanks(db), { updated: 0, skipped: false });
  assert.equal(db.cacheWrites, 1);
  assert.equal(db.commits, 1);
});

test("a stale participant is repaired even when its follower is current; no participant is created", async () => {
  const db = new CommunityRankDb({ alice: member(5, 500, 1), bob: member(1, 100, 2) },
    { alice: { ...member(3, 200, 9), hasRedemption: true } });
  assert.deepEqual(await recalculateCommunityLevelRanks(db), { updated: 1, skipped: false });
  assert.equal(db.updates[0].ref.path, "participants/alice");
  assert.equal(db.tables.participants.alice.communityLevel.rank, 1);
  assert.equal(db.tables.participants.alice.communityLevel.level, 3);
  assert.equal(db.tables.participants.alice.hasRedemption, true);
  assert.equal(db.tables.participants.bob, undefined);
});

test("legacy normalization and optional double writes remain compatible", async () => {
  const db = new CommunityRankDb({ alice: { wizebotLevel: 5, wizebotExp: 500, wizebotRank: 9 },
    erwayr: { wizebotLevel: 9, wizebotExp: 900, wizebotRank: 1 } });
  await recalculateCommunityLevelRanks(db, { legacyDoubleWrite: true });
  assert.equal(db.tables.followers_all_time.alice.wizebotRank, 1);
  assert.equal(db.tables.followers_all_time.erwayr.wizebotRank, 0);
  const normalized = normalizeCommunityLevel(db.tables.followers_all_time.alice);
  assert.equal(normalized.level, 5);
  assert.equal(normalized.xpTotal, 500);
  assert.equal(normalized.rank, 1);
  assert.deepEqual(await recalculateCommunityLevelRanks(db, { legacyDoubleWrite: true }), { updated: 0, skipped: false });
});

test("dry-run presents the same repair plan without writes or invalidation", async () => {
  const db = new CommunityRankDb({ alice: { ...member(5, 500, 2), "communityLevel.rank": 1 } });
  const before = structuredClone(db.tables);
  let plan;
  const result = await recalculateCommunityLevelRanks(db, {}, { dryRun: true, onPlan: changes => { plan = changes; } });
  assert.deepEqual(result, { updated: 1, skipped: false });
  assert.equal(plan[0].patch["communityLevel.rank"], 1);
  assert.deepEqual(plan[0].deleteFields, ["communityLevel.rank"]);
  assert.deepEqual(db.tables, before);
  assert.equal(db.commits, 0);
  assert.equal(db.cacheWrites, 0);
});

test("batched repairs invalidate the public cache even after a partial failure", async () => {
  const db = new CommunityRankDb({ alice: member(5, 500, 2), bob: member(1, 100, 3) });
  db.failCommitAt = 2;
  await assert.rejects(recalculateCommunityLevelRanks(db, { rankBatchSize: 1 }), /simulated_commit_failure/);
  assert.equal(db.commits, 1);
  assert.equal(db.cacheWrites, 1);
  assert.equal(db.tables.followers_all_time.alice.communityLevel.rank, 1);
  assert.equal(db.tables.followers_all_time.bob.communityLevel.rank, 3);
});
