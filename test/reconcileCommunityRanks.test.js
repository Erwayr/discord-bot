"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseOptions, reconcileCommunityRanks } = require("../scripts/reconcile-community-ranks");
const { CommunityRankDb } = require("./helpers/communityRankDb");

const fixture = () => new CommunityRankDb({
  erwayr: { communityLevel: { level: 10, xpTotal: 1000, rank: 1 } },
  lazizy: { communityLevel: { level: 5, xpTotal: 500, rank: 2 }, "communityLevel.rank": 99 },
}, { lazizy: { communityLevel: { level: 5, xpTotal: 500, rank: 2 } } });

test("repair command defaults to dry-run and requires a new audit path for apply", () => {
  assert.equal(parseOptions([]).apply, false);
  assert.throws(() => parseOptions(["--apply"]), /requires --report/);
  assert.throws(() => parseOptions(["--force"]), /Unknown option/);
  assert.equal(parseOptions(["--apply", "--report", "audit.json"]).apply, true);
});

test("dry-run reports only ranking metadata, performs no writes and leaves artifacts for review", async () => {
  const db = fixture();
  const before = structuredClone(db.tables);
  const report = await reconcileCommunityRanks({ db });
  assert.equal(report.status, "dry-run");
  assert.equal(report.changes.length, 3);
  assert.equal(report.changes.find(change => change.path === "followers_all_time/lazizy").rank, 1);
  assert.equal(report.changes.some(change => Object.keys(change.patch).some(field => /xp|pops|cards/i.test(field))), false);
  assert.deepEqual(db.tables, before);
  assert.equal(db.cacheWrites, 0);
});

test("apply saves the proposed changes first, reads them back and is idempotent", async () => {
  const db = fixture();
  const reports = [];
  const saveReport = async report => {
    if (!reports.length) assert.equal(db.commits, 0);
    reports.push(structuredClone(report));
  };
  const report = await reconcileCommunityRanks({ db, apply: true, saveReport });
  assert.equal(reports[0].status, "planned");
  assert.equal(report.status, "verified");
  assert.equal(report.verified, true);
  assert.equal(db.tables.followers_all_time.lazizy.communityLevel.rank, 1);
  assert.equal(db.tables.participants.lazizy.communityLevel.rank, 1);
  assert.equal(Object.hasOwn(db.tables.followers_all_time.lazizy, "communityLevel.rank"), false);
  assert.deepEqual(report.remainingPaths, []);
  assert.equal((await reconcileCommunityRanks({ db, apply: true })).changes.length, 0);
  assert.equal(db.cacheWrites, 1);
});

test("an audit write failure prevents the repair from starting", async () => {
  const db = fixture();
  await assert.rejects(reconcileCommunityRanks({ db, apply: true,
    saveReport: async () => { throw new Error("audit_unavailable"); } }), /audit_unavailable/);
  assert.equal(db.commits, 0);
});
