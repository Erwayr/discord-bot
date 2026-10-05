"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createMonthlyPodiumRewards } = require("../script/monthlyPodiumRewards");
const { monthlyPodiumRewardForRank, monthlyPodiumRange, duePodiumMonths } = require("../script/monthly-podium-rewards.shared.cjs");
const { buildActivityRankings } = require("../script/podium-activity.shared.cjs");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");

const FIRST_PAYOUT = Date.parse("2026-10-01T07:00:00Z");
const user = (rank, extra = {}) => ({ pseudo: `Viewer ${String(rank).padStart(2, "0")}`, twitch_id: `id${rank}`,
  pops: { balance: 10, lifetimeEarned: 20 },
  live_presence: { "2026-09": { streams: [{ day_key: "2026-09-30", chat_message: { count: 1 } }] } }, ...extra });
function fixture(size = 3, options = {}) {
  const initial = Object.fromEntries(Array.from({ length: size }, (_, i) => [`followers_all_time/viewer${i + 1}`, user(i + 1)]));
  const db = createMemoryFirestore({ ...initial, ...options.initial });
  let time = options.now ?? FIRST_PAYOUT, ready = true;
  let saves = 0;
  const settings = { db, now: () => time, logger: { log() {}, warn() {}, error() {} },
    ensureActivitySaved: async () => { saves++; return ready; } };
  return { db, service: () => createMonthlyPodiumRewards(settings),
    setNow: value => { time = Date.parse(value); }, setReady: value => { ready = value; },
    get saves() { return saves; }, profile: login => db.documents.get(`followers_all_time/${login}`),
    run: month => db.documents.get(`monthly_podium_rewards/${month || "2026-09"}`) };
}

test("tier boundaries limit chests to rank 20 and rubies to rank 50", () => {
  for (const [rank, pops, type] of [[1,1000,"legendary"],[2,750,"epic"],[3,500,"epic"],
    [4,300,"runic"],[10,300,"runic"],[11,200,"runic"],[20,200,"runic"],
    [21,200,null],[25,200,null],[26,100,null],[50,100,null]]) {
    const reward = monthlyPodiumRewardForRank(rank);
    assert.equal(reward.pops, pops); assert.equal(reward.chestType, type);
  }
  for (const rank of [0, -1, 51, 2.5, "1", NaN]) assert.equal(monthlyPodiumRewardForRank(rank), null);
});

test("calendar payout starts at 09:00 Brussels, handles DST, years and leap months", () => {
  assert.deepEqual(duePodiumMonths(new Date("2026-10-01T06:59:59Z")), []);
  assert.deepEqual(duePodiumMonths(new Date(FIRST_PAYOUT)), ["2026-09"]);
  assert.deepEqual(duePodiumMonths(new Date("2026-11-01T07:59:59Z")), ["2026-09"]);
  assert.deepEqual(duePodiumMonths(new Date("2026-11-01T08:00:00Z")), ["2026-09", "2026-10"]);
  assert.deepEqual(duePodiumMonths(new Date("2027-01-01T08:00:00Z"), "2026-12"), ["2026-12"]);
  assert.deepEqual(duePodiumMonths(new Date("2026-09-30T12:00:00Z")), []);
  assert.deepEqual(monthlyPodiumRange("2028-02"), { startKey: "2028-02-01", endKey: "2028-02-29" });
});

test("51 ranked viewers receive exactly 9850 rubies and 20 chests with immutable snapshots", async () => {
  const f = fixture(51);
  await f.service().runDue();
  assert.deepEqual(f.run().totals, { winners: 50, awarded: 50, skipped: 0, pops: 9850, chests: 20 });
  assert.equal(f.profile("viewer51").pops.balance, 10);
  assert.equal(f.profile("viewer1").pops.balance, 1010);
  assert.equal(f.profile("viewer1").pops.lifetimeEarned, 1020);
  const chest = f.db.documents.get("followers_all_time/viewer1/quest_chests/monthly_podium_2026-09");
  assert.equal(chest.source, "monthly_podium"); assert.equal(chest.chestType, "legendary");
  assert.equal(chest.status, "available"); assert.equal(chest.rewardSnapshot.popsMin, 600);
  assert.equal(f.profile("viewer1").questChestSummary.pendingCount, 1);
  assert.equal(f.profile("viewer1").questChestSummary.pendingByType.legendary, 1);
  assert.ok(!f.db.writes.some(path => path.startsWith("participants/")));
  assert.equal(f.db.documents.get("followers_all_time/viewer1/pops_transactions/monthly_podium_2026-09").amount, 1000);
  for (let rank = 4; rank <= 50; rank++) {
    const grantedChest = f.db.documents.get(`followers_all_time/viewer${rank}/quest_chests/monthly_podium_2026-09`);
    const receipt = f.db.documents.get(`monthly_podium_rewards/2026-09/awards/${rank}`);
    assert.equal(Boolean(grantedChest), rank <= 20);
    assert.equal(receipt.chestType, rank <= 20 ? "runic" : null);
    assert.equal(receipt.chestId, rank <= 20 ? "monthly_podium_2026-09" : null);
    assert.equal(receipt.pops, rank <= 10 ? 300 : rank <= 25 ? 200 : 100);
  }
});

test("rubies-only grants preserve inventory and cannot pay twice after concurrent retries", async () => {
  const summary = { pendingCount: 1, pendingByType: { runic: 1 }, totalEarned: 4, totalOpened: 3,
    schemaVersion: 1, lastGrantedAt: "before", updatedAt: "before" };
  const f = fixture(26, { initial: {
    "followers_all_time/viewer21": user(21, { questChestSummary: summary }),
    "followers_all_time/viewer21/quest_chests/older": { status: "available", chestType: "runic" },
  } });
  f.db.retryNext(2);
  await Promise.all([f.service().runDue(), f.service().runDue()]);
  const writes = f.db.writes.length;
  await f.service().runDue();
  assert.equal(f.db.writes.length, writes);
  assert.equal(f.profile("viewer21").pops.balance, 210);
  assert.equal(f.profile("viewer26").pops.balance, 110);
  assert.deepEqual(f.profile("viewer21").questChestSummary, summary);
  assert.equal(f.profile("viewer26").questChestSummary, undefined);
  assert.equal(f.run().winners[20].rewardSnapshot, null);
  assert.equal(f.db.documents.get("followers_all_time/viewer21/pops_transactions/monthly_podium_2026-09").amount, 200);
});

test("duplicate workers, transaction retries and restarts cannot pay twice", async () => {
  const f = fixture(); f.db.retryNext(2);
  await Promise.all([f.service().runDue(), f.service().runDue()]);
  const writes = f.db.writes.length;
  await f.service().runDue();
  assert.equal(f.db.writes.length, writes);
  assert.equal(f.profile("viewer1").pops.balance, 1010);
  assert.equal(f.profile("viewer1").questChestSummary.totalEarned, 1);
});

test("legacy wallets retain the existing balance and normalize missing lifetime earned", async () => {
  const f = fixture(1, { initial: { "followers_all_time/viewer1": user(1, { pops: { balance: 100 } }) } });
  await f.service().runDue();
  assert.equal(f.profile("viewer1").pops.balance, 1100);
  assert.equal(f.profile("viewer1").pops.lifetimeEarned, 1100);
});

test("nothing is written before the first payout or when live activity has not been saved", async () => {
  const f = fixture(1, { now: FIRST_PAYOUT - 1 });
  assert.equal((await f.service().runDue()).status, "not_due");
  f.setNow("2026-10-01T07:00:00Z"); f.setReady(false);
  assert.equal((await f.service().runDue()).status, "deferred_activity");
  assert.equal(f.db.writes.length, 0);
  f.setReady(true); await f.service().runDue();
  assert.equal(f.run().status, "completed");
});

test("a partial failure resumes frozen awards without changing ranks or chest contents", async () => {
  const f = fixture(2);
  const transaction = f.db.runTransaction;
  let blocked = true;
  f.db.runTransaction = callback => transaction(async tx => callback({ ...tx, update(ref, data) {
    if (blocked && ref.path === "followers_all_time/viewer2") throw new Error("temporary_failure");
    tx.update(ref, data);
  } }));
  assert.equal((await f.service().runDue()).status, "pending");
  assert.equal(f.profile("viewer1").pops.balance, 1010);
  assert.equal(f.profile("viewer2").pops.balance, 10);
  assert.equal(f.db.documents.has("followers_all_time/viewer2/quest_chests/monthly_podium_2026-09"), false);
  f.profile("viewer2").live_presence = {};
  f.db.documents.set("site_config/quests", { questMilestones: { slots: [{ id: "epic", popsMin: 999, popsMax: 1000 }] } });
  blocked = false; f.setReady(false);
  await f.service().runDue();
  assert.equal(f.run().status, "completed");
  assert.equal(f.profile("viewer1").pops.balance, 1010);
  assert.equal(f.profile("viewer2").pops.balance, 760);
  assert.equal(f.db.documents.get("followers_all_time/viewer2/quest_chests/monthly_podium_2026-09").rewardSnapshot.popsMin, 300);
});

test("renames resolve to canonical profiles; deleted winners are skipped without replacing them", async () => {
  const f = fixture(3, { initial: { "twitch_identities/id1": { status: "migrating", currentLogin: "viewer1" },
    "twitch_identities/id2": { status: "migrating", currentLogin: "viewer2" } } });
  await f.service().runDue();
  f.db.documents.set("followers_all_time/newname", f.profile("viewer1"));
  f.db.documents.delete("followers_all_time/viewer1");
  f.db.documents.set("twitch_identities/id1", { status: "active", currentLogin: "newname" });
  f.db.documents.delete("followers_all_time/viewer2");
  f.db.documents.delete("twitch_identities/id2");
  await f.service().runDue();
  assert.equal(f.profile("newname").pops.balance, 1010);
  assert.equal(f.run().totals.skipped, 1);
  assert.equal(f.run().totals.pops, 1500);
  assert.equal(f.profile("viewer2"), undefined);
  assert.equal(f.profile("viewer3").pops.balance, 510);
});

test("identity conflicts and an existing monthly receipt block unsafe credits", async () => {
  for (const initial of [
    { "twitch_identities/id1": { status: "conflict", currentLogin: "viewer1" } },
    { "twitch_identities/id1": { currentLogin: "someoneelse" }, "followers_all_time/someoneelse": user(7, { live_presence: {} }) },
    { "followers_all_time/viewer1/pops_transactions/monthly_podium_2026-09": { amount: 1000 } },
  ]) {
    const f = fixture(1, { initial });
    assert.equal((await f.service().runDue()).status, "pending");
    assert.equal(f.profile("viewer1").pops.balance, 10);
  }
});

test("no activity, excluded accounts and fewer than 50 members preserve ranking eligibility", async () => {
  const empty = fixture(0); await empty.service().runDue();
  assert.equal(empty.run().totals.awarded, 0);
  const f = fixture(1, { initial: { "followers_all_time/erwayr": user(0),
    "followers_all_time/bot_alias": user(0, { login: "StreamElements" }),
    "followers_all_time/inactive": user(0, { live_presence: {} }) } });
  await f.service().runDue();
  assert.equal(f.run().winners.length, 1); assert.equal(f.run().winners[0].login, "viewer1");
  const rows = buildActivityRankings([
    { id: "chat", data: user(1, { live_presence: { m: { streams: [{ day_key: "2026-09-30", chat_message: { count: 2 } }] } } }) },
    { id: "presence", data: user(2, { live_presence: { m: { streams: [{ day_key: "2026-09-30", presence: { seen: true } }] } } }) },
  ], { month: monthlyPodiumRange("2026-09") }).month;
  assert.deepEqual(rows.map(row => row.id), ["presence", "chat"]);
});

test("chest and rubies-only grants preserve a concurrent chest opening", async () => {
  for (const rank of [1, 21]) {
    const login = `viewer${rank}`;
    const path = `followers_all_time/${login}/quest_chests/older`;
    const f = fixture(rank, { initial: { [path]: { status: "available", chestType: "runic" } } });
    f.profile(login).questChestSummary = { pendingCount: 1, totalEarned: 1, totalOpened: 0 };
    const grant = f.service().runDue();
    const opening = f.db.runTransaction(async tx => {
      const ref = f.db.collection("followers_all_time").doc(login);
      const profile = (await tx.get(ref)).data();
      const chest = ref.collection("quest_chests").doc("older"); await tx.get(chest);
      tx.update(chest, { status: "opened" });
      tx.update(ref, { "questChestSummary.totalOpened": 1,
        "questChestSummary.pendingCount": Math.max(0, profile.questChestSummary.pendingCount - 1) });
    });
    await Promise.all([grant, opening]);
    assert.equal(f.profile(login).questChestSummary.totalOpened, 1);
    assert.equal(f.profile(login).questChestSummary.totalEarned, rank === 1 ? 2 : 1);
    assert.equal(f.profile(login).questChestSummary.pendingCount, rank === 1 ? 1 : 0);
    assert.equal(f.profile(login).pops.balance, rank === 1 ? 1010 : 210);
    if (rank === 1) assert.equal(f.profile(login).questChestSummary.pendingByType.legendary, 1);
  }
});

test("catch-up processes every closed month since September, and never the current month", async () => {
  const f = fixture(1, { now: Date.parse("2026-12-05T12:00:00Z") });
  await f.service().runDue();
  for (const month of ["2026-09", "2026-10", "2026-11"]) assert.equal(f.run(month).status, "completed");
  assert.equal(f.run("2026-08"), undefined); assert.equal(f.run("2026-12"), undefined);
  assert.equal(f.db.documents.get("monthly_podium_rewards/_state").nextMonth, "2026-12");
});
