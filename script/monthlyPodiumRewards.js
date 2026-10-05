"use strict";

const { Timestamp } = require("firebase-admin/firestore");
const { buildActivityRankings } = require("./podium-activity.shared.cjs");
const { PODIUM_TIMEZONE } = require("./podium-periods.shared.cjs");
const { MONTHLY_PODIUM_FIRST_MONTH, MONTHLY_PODIUM_SOURCE, monthlyPodiumRewardForRank,
  monthlyPodiumRange, duePodiumMonths, nextPodiumMonth } = require("./monthly-podium-rewards.shared.cjs");
const { normalizeQuestMilestones, buildChestSnapshot, countAvailableQuestChestsByType } = require("./questChests.shared.cjs");

const ID_FIELDS = ["twitch_id", "twitchId", "twitchUserId", "user_id"];
const loginOf = value => String(value || "").trim().toLowerCase();
const idsOf = data => [...new Set(ID_FIELDS.map(key => String(data?.[key] || "").trim()).filter(Boolean))];
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;

function createMonthlyPodiumRewards({ db, ensureActivitySaved, now = Date.now, logger = console }) {
  const runs = db.collection("monthly_podium_rewards");
  const cursorRef = runs.doc("_state");
  let inFlight = null;

  async function freezeMonth(month, ref) {
    const existing = await ref.get();
    if (existing.exists) return existing.data();
    // Never settle against the public cache or an unflushed end-of-live buffer.
    if (typeof ensureActivitySaved !== "function" || await ensureActivitySaved() !== true) return null;
    const [followers, quests] = await Promise.all([
      db.collection("followers_all_time").get(), db.collection("site_config").doc("quests").get(),
    ]);
    const docs = followers.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    const byId = new Map(docs.map(doc => [doc.id, doc.data]));
    const range = monthlyPodiumRange(month);
    const slots = normalizeQuestMilestones(quests.data()?.questMilestones).slots;
    const ranking = buildActivityRankings(docs, { month: range }).month.slice(0, 50);
    const winners = ranking.map((row, index) => {
      const rank = index + 1;
      const reward = monthlyPodiumRewardForRank(rank);
      const slot = reward.chestType
        ? slots.find(item => item.kind === "chest" && item.chestType === reward.chestType) : null;
      const ids = idsOf(byId.get(row.id));
      return { rank, login: row.id, pseudo: row.pseudo, score: row.score,
        twitchUserId: ids.length === 1 ? ids[0] : "", identityConflict: ids.length > 1,
        pops: reward.pops, chestType: reward.chestType, label: slot?.label || null, aura: slot?.aura || null,
        rewardSnapshot: slot ? buildChestSnapshot(slot) : null };
    });
    const snapshot = { month, ...range, timezone: PODIUM_TIMEZONE, schemaVersion: 1,
      status: "pending", winners, frozenAt: Timestamp.fromMillis(now()) };
    return db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (current.exists) return current.data();
      tx.set(ref, snapshot);
      return snapshot;
    });
  }

  async function awardWinner(runRef, run, winner) {
    const receiptRef = runRef.collection("awards").doc(String(winner.rank));
    return db.runTransaction(async tx => {
      const receipt = await tx.get(receiptRef);
      if (receipt.exists) return receipt.data();
      if (winner.identityConflict) throw new Error("monthly_podium_identity_conflict");
      const identity = winner.twitchUserId
        ? (await tx.get(db.collection("twitch_identities").doc(winner.twitchUserId))).data() : null;
      if (["conflict", "migrating"].includes(identity?.status)) throw new Error("monthly_podium_identity_pending");
      const login = loginOf(identity?.currentLogin || winner.login);
      const followerRef = db.collection("followers_all_time").doc(login);
      const profile = await tx.get(followerRef);
      const at = Timestamp.fromMillis(now());
      if (!profile.exists) {
        const skipped = { status: "skipped_missing_profile", rank: winner.rank, login, at };
        tx.set(receiptRef, skipped);
        return skipped;
      }
      const data = profile.data();
      const ids = idsOf(data);
      if (ids.length > 1 || (winner.twitchUserId && ids.length && ids[0] !== winner.twitchUserId)) {
        throw new Error("monthly_podium_identity_mismatch");
      }
      const rewardId = `monthly_podium_${run.month}`;
      const ledgerRef = followerRef.collection("pops_transactions").doc(rewardId);
      const chestRef = followerRef.collection("quest_chests").doc(rewardId);
      const hasChest = Boolean(winner.chestType);
      const [ledger, chest, pending] = await Promise.all([
        tx.get(ledgerRef), tx.get(chestRef),
        hasChest ? tx.get(followerRef.collection("quest_chests").where("status", "==", "available")) : null,
      ]);
      // A duplicate identity or a partial manual repair must not pay twice.
      if (ledger.exists || chest.exists) throw new Error("monthly_podium_receipt_conflict");
      const wallet = data.pops && typeof data.pops === "object" ? data.pops : data;
      const balanceBefore = count(wallet.balance);
      const balanceAfter = balanceBefore + winner.pops;
      const profileUpdate = {
        "pops.balance": balanceAfter, "pops.lifetimeEarned": Math.max(balanceBefore, count(wallet.lifetimeEarned)) + winner.pops,
        "pops.schemaVersion": 1, "pops.updatedAt": at,
      };
      if (hasChest) {
        const pendingChests = [...pending.docs.map(doc => doc.data()), { status: "available", chestType: winner.chestType }];
        const summary = data.questChestSummary || {};
        Object.assign(profileUpdate, {
          "questChestSummary.pendingCount": pendingChests.length,
          "questChestSummary.pendingByType": countAvailableQuestChestsByType(pendingChests),
          "questChestSummary.totalEarned": Math.max(count(summary.totalEarned), pending.size + count(summary.totalOpened)) + 1,
          "questChestSummary.totalOpened": count(summary.totalOpened),
          "questChestSummary.lastGrantedAt": at, "questChestSummary.updatedAt": at, "questChestSummary.schemaVersion": 1,
        });
      }
      tx.update(followerRef, profileUpdate);
      tx.set(ledgerRef, { type: "monthly_podium_winner", source: MONTHLY_PODIUM_SOURCE,
        amount: winner.pops, balanceBefore, balanceAfter, rank: winner.rank, monthKey: run.month,
        rangeStart: run.startKey, rangeEnd: run.endKey, createdAt: at, schemaVersion: 1, serverAuthoritative: true });
      if (hasChest) tx.set(chestRef, { id: rewardId, source: MONTHLY_PODIUM_SOURCE, month: run.month, rank: winner.rank,
        slotId: winner.chestType, progressPct: 0, chestType: winner.chestType, label: winner.label, aura: winner.aura,
        status: "available", rewardSnapshot: winner.rewardSnapshot, createdAt: at, schemaVersion: 1, serverAuthoritative: true });
      const applied = { status: "applied", rank: winner.rank, login, twitchUserId: winner.twitchUserId,
        pops: winner.pops, chestId: hasChest ? rewardId : null, chestType: winner.chestType, at };
      tx.set(receiptRef, applied);
      return applied;
    });
  }

  async function finishAttempt(ref, run, issues) {
    return db.runTransaction(async tx => {
      const [latest, awards, cursor] = await Promise.all([
        tx.get(ref), tx.get(ref.collection("awards")), tx.get(cursorRef),
      ]);
      if (latest.data()?.status === "completed") return latest.data();
      const receipts = awards.docs.map(doc => doc.data());
      const applied = receipts.filter(receipt => receipt.status === "applied");
      const skipped = receipts.filter(receipt => receipt.status === "skipped_missing_profile");
      const completed = applied.length + skipped.length === run.winners.length;
      const result = { status: completed ? "completed" : "pending", lastAttemptAt: Timestamp.fromMillis(now()),
        totals: { winners: run.winners.length, awarded: applied.length, skipped: skipped.length,
          pops: applied.reduce((sum, receipt) => sum + receipt.pops, 0),
          chests: applied.filter(receipt => receipt.chestId).length }, issues };
      if (completed) {
        result.completedAt = result.lastAttemptAt;
        const nextMonth = nextPodiumMonth(run.month);
        if (!cursor.data()?.nextMonth || cursor.data().nextMonth < nextMonth) tx.set(cursorRef, { nextMonth });
      }
      tx.update(ref, result);
      return result;
    });
  }

  async function processDue() {
    if (!duePodiumMonths(new Date(now())).length) return { status: "not_due" };
    const cursor = await cursorRef.get();
    const due = duePodiumMonths(new Date(now()), cursor.data()?.nextMonth || MONTHLY_PODIUM_FIRST_MONTH);
    const results = [];
    for (const month of due) {
      const ref = runs.doc(month);
      const run = await freezeMonth(month, ref);
      if (!run) return { status: "deferred_activity", results };
      const issues = [];
      for (const winner of run.winners) {
        try {
          const receipt = await awardWinner(ref, run, winner);
          if (receipt.status !== "applied") logger.warn("[monthly-podium] skipped", { month, rank: winner.rank, reason: receipt.status });
        } catch (error) {
          const code = String(error.code || error.message || "award_failed").slice(0, 100);
          issues.push({ rank: winner.rank, code });
          logger.error("[monthly-podium] award failed", { month, rank: winner.rank, code });
        }
      }
      const result = await finishAttempt(ref, run, issues);
      results.push({ month, ...result });
      logger.log("[monthly-podium] settlement", { month, status: result.status, ...result.totals });
      if (result.status !== "completed") return { status: "pending", results };
    }
    return { status: "completed", results };
  }

  return { runDue() {
    if (!inFlight) inFlight = processDue().finally(() => { inFlight = null; });
    return inFlight;
  } };
}

module.exports = { createMonthlyPodiumRewards };
