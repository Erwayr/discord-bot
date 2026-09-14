"use strict";

const crypto = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { isExcludedLogin } = require("../helper/excludedUsers");
const { normalizeQuestMilestones, buildChestSnapshot, countAvailableQuestChestsByType } = require("./questChests.shared.cjs");
const { normalizeConfig, chooseWinners, makeDemo, LABELS, ROLL_MS, WINNER_MS, SUMMARY_MS, TEST_COOLDOWN_MS } = require("./liveChestDraws.shared.cjs");
const { SCHEDULE_VERSION, SCHEDULE_GRACE_MS, TICK_MS, scheduleTimingKey, drawDurationMs, createScheduleWindow } = require("./liveChestDraws.shared.cjs");

const SITE = "https://erwayr.online/coffres.html";
const loginOf = (value) => String(value || "").trim().toLowerCase();
const safeId = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 90);

function createLiveChestDraws({ db, config, resolveTwitchIdentity, sendMessage, getLiveState,
  now = Date.now, randomInt = crypto.randomInt, logger = console }) {
  const runtimeRef = db.collection("settings").doc("live_chest_draws");
  const configRef = db.collection("site_config").doc("live_chest_draws");
  const draws = db.collection("live_chest_draws");
  const demos = db.collection("live_chest_draw_tests");
  let cachedConfig;
  let configAt = -Infinity;
  let running = false;
  let initialized = false;
  let timer;
  let hasWork = true;
  const replyTimes = new Map();
  let globalReplyAt = -Infinity;

  async function readConfig() {
    if (!cachedConfig || now() - configAt >= 15000) {
      const snap = await configRef.get();
      cachedConfig = normalizeConfig(snap.data() || {}, { strict: true });
      configAt = now();
    }
    return cachedConfig;
  }

  async function reply(userId, text) {
    const time = now();
    if (time - (replyTimes.get(userId) ?? -Infinity) < 60000 || time - globalReplyAt < 2000) return;
    replyTimes.set(userId, time);
    globalReplyAt = time;
    for (const [id, at] of replyTimes) if (time - at > 60000) replyTimes.delete(id);
    await sendMessage(text);
  }

  // A durable lease prevents concurrent senders; receipts/errors survive restart.
  // An ambiguous network failure may still repeat a chat message, never a reward.
  async function announce(ref, key, message) {
    const time = now();
    const leaseId = crypto.randomUUID();
    const acquired = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const receipt = snap.data().announcements?.[key] || {};
      if (receipt.sentAtMs || receipt.leaseUntilMs > time || receipt.attempts >= 3) return false;
      tx.update(ref, { [`announcements.${key}`]: { leaseId, leaseUntilMs: time + 30000, attempts: (receipt.attempts || 0) + 1 } });
      return true;
    });
    if (!acquired) return;
    let error = null;
    let messageId = null;
    try {
      const result = await sendMessage(message);
      if (result?.is_sent !== true) throw new Error("chat_message_not_sent");
      messageId = result.message_id || null;
    } catch (failure) {
      error = String(failure.code || "chat_delivery_failed").slice(0, 100);
      logger.warn("[live-chests] chat delivery failed", { key, error });
    }
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const receipt = snap.data()?.announcements?.[key];
      if (receipt?.leaseId !== leaseId) return;
      tx.update(ref, { [`announcements.${key}`]: {
        ...receipt, leaseUntilMs: error ? now() + 5000 : 0, error,
        sentAtMs: error ? null : now(), messageId,
      } });
    });
  }

  async function cancel(ref, reason) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.status !== "open") return;
      tx.update(ref, { status: "cancelled", cancelReason: reason, expiresAtMs: now() });
    });
  }

  async function settle(ref) {
    const closed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const draw = snap.data();
      if (!draw || draw.test || !["open", "drawing"].includes(draw.status)) return null;
      if (draw.status === "open" && now() < draw.closesAtMs) return null;
      if (draw.status === "open") tx.update(ref, { status: "drawing" });
      return draw;
    });
    if (!closed) return;
    const entries = (await ref.collection("entries").get()).docs.map((snap) => snap.data());
    const selected = chooseWinners(entries, closed.config, randomInt);
    const time = now();
    // Freeze the random choices outside the retryable transaction.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.status !== "drawing") return;
      const prepared = await Promise.all(selected.map(async (winner) => {
        const identity = (await tx.get(db.collection("twitch_identities").doc(winner.userId))).data();
        const canonicalLogin = loginOf(identity?.currentLogin || winner.login);
        const follower = db.collection("followers_all_time").doc(canonicalLogin);
        const chestId = `live_${closed.id}`;
        const chest = follower.collection("quest_chests").doc(chestId);
        const [profile, existingChest, pending] = await Promise.all([
          tx.get(follower), tx.get(chest), tx.get(follower.collection("quest_chests").where("status", "==", "available")),
        ]);
        return { winner: { ...winner, login: canonicalLogin }, identity, follower, chest, chestId, profile, existingChest, pending };
      }));
      const winners = [];
      for (const item of prepared) {
        if (!item.profile.exists || ["conflict", "migrating"].includes(item.identity?.status)) continue;
        const { winner, follower, chest, chestId, profile, existingChest, pending } = item;
        const slot = closed.chestSlots.find((candidate) => candidate.chestType === winner.chestType);
        const data = profile.data();
        if (["twitch_id", "twitchId", "twitchUserId", "user_id"].some((field) => data[field] && String(data[field]) !== winner.userId)) continue;
        if (!existingChest.exists) {
          tx.set(chest, {
            id: chestId, source: "live_draw", drawId: closed.id, month: closed.month,
            slotId: slot.id, progressPct: slot.progressPct, chestType: slot.chestType,
            label: slot.label, aura: slot.aura, status: "available", schemaVersion: 1,
            rewardSnapshot: buildChestSnapshot(slot), createdAt: Timestamp.fromMillis(time), serverAuthoritative: true,
          });
          const pendingChests = [...pending.docs.map((doc) => doc.data()), { status: "available", chestType: winner.chestType }];
          const summary = data.questChestSummary || {};
          tx.update(follower, {
            "questChestSummary.pendingCount": pendingChests.length,
            "questChestSummary.pendingByType": countAvailableQuestChestsByType(pendingChests),
            "questChestSummary.totalEarned": Math.max(Number(summary.totalEarned) || 0, pending.size + (Number(summary.totalOpened) || 0)) + 1,
            "questChestSummary.totalOpened": Math.max(0, Number(summary.totalOpened) || 0),
            "questChestSummary.lastGrantedAt": Timestamp.fromMillis(time),
            "questChestSummary.updatedAt": Timestamp.fromMillis(time), "questChestSummary.schemaVersion": 1,
          });
        }
        winners.push({ ...winner, chestId });
      }
      const expiresAtMs = time + ROLL_MS + winners.length * WINNER_MS + SUMMARY_MS;
      tx.update(ref, { status: "completed", winners, revealAtMs: time, expiresAtMs,
        completedAtMs: time, candidates: entries.slice(0, 40).map((entry) => entry.displayName) });
    });
  }

  async function planSchedule(live, time) {
    // Cache candidates outside the retryable transaction, including across retries.
    const candidates = new Map();
    return db.runTransaction(async (tx) => {
      const [snap, configSnap] = await Promise.all([tx.get(runtimeRef), tx.get(configRef)]);
      const current = snap.data() || {};
      const settings = normalizeConfig(configSnap.data(), { strict: true });
      const persist = (patch) => {
        const result = { ...current, ...patch };
        tx.set(runtimeRef, result);
        return result;
      };
      if (!settings.enabled || !live?.streamId) {
        const status = settings.enabled ? "offline" : "disabled";
        if (!current.nextOpenAtMs && current.scheduleStatus === status) return current;
        return persist({ nextOpenAtMs: null, scheduleStatus: status, scheduleIssue: null });
      }
      const startedAtMs = typeof live.startedAt === "string" ? new Date(live.startedAt).getTime() : NaN;
      if (!Number.isFinite(startedAtMs) || startedAtMs > time) {
        if (current.scheduleIssue === "invalid_live_start") return current;
        return persist({ nextOpenAtMs: null, scheduleStatus: "skipped", scheduleIssue: "invalid_live_start" });
      }
      const intervalMs = settings.intervalMinutes * 60000;
      const currentIndex = Math.floor((time - startedAtMs) / intervalMs);
      const sameStream = current.streamId === live.streamId;
      const sameSchedule = sameStream && current.scheduleVersion === SCHEDULE_VERSION;
      let index = currentIndex;
      if (sameStream && !sameSchedule) {
        // An installed hourly schedule is migrated at the next boundary.
        index++;
      } else if (sameSchedule && current.scheduleTimingKey !== scheduleTimingKey(settings)) {
        // Timing changes take effect after the current old/new windows; visual edits do not enter this branch.
        const oldIntervalMs = current.scheduleIntervalMinutes * 60000;
        const oldEnd = startedAtMs + (Math.floor((time - startedAtMs) / oldIntervalMs) + 1) * oldIntervalMs;
        index = Math.max(currentIndex + 1, Math.ceil((oldEnd - startedAtMs) / intervalMs));
      } else if (sameSchedule) {
        if (current.scheduleStatus === "scheduled") {
          const fits = time + drawDurationMs(settings) + TICK_MS <= current.scheduleWindowEndAtMs;
          if (time < current.nextOpenAtMs || (time - current.nextOpenAtMs <= SCHEDULE_GRACE_MS && fits)) return current;
          // A missed appointment never gets a second random choice in this window.
          index = Math.max(current.scheduleWindowIndex + 1, currentIndex + 1);
        } else if (current.scheduleStatus === "skipped" && current.scheduleIssue === "window_too_short") {
          if (time < current.scheduleWindowEndAtMs) return current;
        } else {
          index = Math.max(current.scheduleWindowIndex + 1, currentIndex);
        }
      }
      const key = `${live.streamId}/${scheduleTimingKey(settings)}/${index}`;
      if (!candidates.has(key)) candidates.set(key, createScheduleWindow(startedAtMs, index, settings, time, randomInt));
      return persist({ ...candidates.get(key), streamId: live.streamId });
    });
  }

  async function startDraw(runtime) {
    const questSnap = await db.collection("site_config").doc("quests").get();
    const questConfig = questSnap.data() || {};
    const chestSlots = normalizeQuestMilestones(questConfig.questMilestones).slots.filter((slot) => slot.kind === "chest");
    const id = `${safeId(runtime.streamId)}_v2_${runtime.scheduleWindowStartAtMs}`;
    const ref = draws.doc(id);
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: questConfig.timezone || "Europe/Brussels", year: "numeric", month: "2-digit" }).format(new Date(now()));
    const created = await db.runTransaction(async (tx) => {
      const [current, existing, latestConfig] = await Promise.all([tx.get(runtimeRef), tx.get(ref), tx.get(configRef)]);
      const time = now();
      const settings = normalizeConfig(latestConfig.data(), { strict: true });
      const state = current.data();
      if (!settings.enabled || existing.exists || state?.activeDrawId || state?.scheduleStatus !== "scheduled"
        || state?.nextOpenAtMs !== runtime.nextOpenAtMs || state?.streamId !== runtime.streamId
        || state?.scheduleWindowStartAtMs !== runtime.scheduleWindowStartAtMs
        || state?.scheduleTimingKey !== scheduleTimingKey(settings)
        || time < state.nextOpenAtMs || time - state.nextOpenAtMs > SCHEDULE_GRACE_MS
        || time + drawDurationMs(settings) + TICK_MS > state.scheduleWindowEndAtMs) return false;
      tx.set(ref, {
        id, streamId: runtime.streamId, test: false, status: "open", config: settings, month, chestSlots,
        scheduleVersion: SCHEDULE_VERSION, scheduledAtMs: state.nextOpenAtMs,
        scheduleWindowStartAtMs: state.scheduleWindowStartAtMs, scheduleWindowEndAtMs: state.scheduleWindowEndAtMs,
        createdAtMs: time, opensAtMs: time, closesAtMs: time + settings.registrationSeconds * 1000,
        expiresAtMs: time + settings.registrationSeconds * 1000 + 3600000, entrantCount: 0, winners: [],
      });
      tx.set(runtimeRef, { ...state, activeDrawId: id, displayDrawId: id,
        demoId: null, nextOpenAtMs: null, scheduleStatus: "opened" });
      return true;
    });
    if (created) {
      const draw = (await ref.get()).data();
      const settings = draw.config;
      await announce(ref, "open", `🎁 Tirage de ${settings.winnerCount} coffre${settings.winnerCount > 1 ? "s" : ""} ! Écris !coffre dans les ${settings.registrationSeconds} prochaines secondes pour participer. Profil sur erwayr.online requis.`);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const settings = await readConfig();
      if (initialized && !settings.enabled && !hasWork) return;
      let runtime = (await runtimeRef.get()).data() || {};
      const time = now();
      let live = null;
      if (settings.enabled) live = await getLiveState(); // Errors defer work, not a false offline signal.
      let active = runtime.activeDrawId ? (await draws.doc(runtime.activeDrawId).get()).data() : null;
      if (active?.status === "open" && (!settings.enabled || !live?.streamId || live.streamId !== active.streamId || (!initialized && time >= active.closesAtMs))) {
        const reason = !settings.enabled ? "disabled" : !initialized && time >= active.closesAtMs ? "restart_expired" : "stream_ended";
        await cancel(draws.doc(active.id), reason);
        active = { ...active, status: "cancelled" };
        await announce(draws.doc(active.id), "cancel", "🎁 Tirage de coffres annulé. Les récompenses déjà gagnées restent dans vos inventaires.");
      }
      initialized = true;
      if (active?.status === "open") {
        const ref = draws.doc(active.id);
        if (time < active.closesAtMs) {
          await announce(ref, "open", `🎁 Tirage de ${active.config.winnerCount} coffres ! Écris !coffre avant la fin du compte à rebours. Profil sur erwayr.online requis.`);
          if (time >= active.closesAtMs - 30000) await announce(ref, "reminder", "🎁 Plus que 30 secondes pour participer au tirage : !coffre");
        } else {
          await announce(ref, "start", "🎲 Inscriptions fermées : tirage des coffres en cours !");
          await settle(ref);
          active = (await ref.get()).data();
        }
      } else if (active?.status === "drawing") {
        await settle(draws.doc(active.id));
        active = (await draws.doc(active.id).get()).data();
      }
      if (active?.status === "completed") {
        const revealEnd = active.revealAtMs + ROLL_MS + active.winners.length * WINNER_MS;
        if (time >= revealEnd) {
          const winners = active.winners.map((winner) => `@${winner.displayName} (${LABELS[winner.chestType]})`).join(" · ");
          await announce(draws.doc(active.id), "result", winners ? `🎉 ${winners} ! Ouvrez vos coffres sur ${SITE}` : "🎁 Aucun participant éligible cette fois. Rendez-vous au prochain tirage !");
        }
        const receipt = (await draws.doc(active.id).get()).data()?.announcements?.result;
        // Keep the pointer until the result is delivered or all retries are recorded.
        if (time >= active.expiresAtMs && (receipt?.sentAtMs || receipt?.attempts >= 3)) active = null;
      }
      if (active?.status === "cancelled") active = null;
      if (runtime.activeDrawId && !active) {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(runtimeRef);
          if (snap.data()?.activeDrawId === runtime.activeDrawId) tx.update(runtimeRef, { activeDrawId: null });
        });
        runtime.activeDrawId = null;
      }
      if (runtime.demoId) {
        const ref = demos.doc(runtime.demoId);
        const demo = (await ref.get()).data();
        if (demo && time < demo.expiresAtMs && !runtime.activeDrawId) {
          await announce(ref, "open", "🧪 TEST — Démonstration du tirage de 2 coffres. Aucune récompense réelle.");
        } else {
          let finished = true;
          if (demo && time < demo.expiresAtMs + 60000) {
            await announce(ref, "end", "🧪 TEST — Démonstration terminée. Aucun coffre réel n’a été distribué.");
            const receipt = (await ref.get()).data()?.announcements?.end;
            finished = Boolean(receipt?.sentAtMs || receipt?.attempts >= 3);
          }
          if (finished) {
            await db.runTransaction(async (tx) => {
              const snap = await tx.get(runtimeRef);
              if (snap.data()?.demoId === runtime.demoId) tx.update(runtimeRef, { demoId: null });
            });
            runtime.demoId = null;
          }
        }
      }
      runtime = await planSchedule(live, time);
      if (settings.enabled && live?.streamId && !runtime.activeDrawId && runtime.nextOpenAtMs && time >= runtime.nextOpenAtMs) await startDraw(runtime);
      hasWork = Boolean(active || runtime.demoId || settings.enabled);
    } finally { running = false; }
  }

  async function handleMessage({ message, login, displayName, tags = {}, channel }) {
    const command = String(message || "").trim().toLowerCase();
    if (!["!coffre", "!coffretest"].includes(command)) return { handled: false };
    const userId = String(tags["user-id"] || "");
    const broadcasterId = String(config.twitch.channelId || "");
    if (!/^\d+$/.test(userId) || !broadcasterId || (channel && loginOf(channel.replace(/^#/, "")) !== loginOf(config.twitch.channelLogin))
      || (tags["source-room-id"] && String(tags["source-room-id"]) !== broadcasterId)) return { handled: true };
    const settings = await readConfig();
    if (command === "!coffretest") {
      if (userId !== broadcasterId) return { handled: true, reason: "unauthorized" };
      const time = now();
      const id = `test_${safeId(tags.id || crypto.randomUUID())}`;
      // Let an idle OBS poll discover the event before its ten-second countdown.
      const demo = makeDemo(id, time, settings, 12000);
      const reason = await db.runTransaction(async (tx) => {
        const snap = await tx.get(runtimeRef);
        const runtime = snap.data() || {};
        const real = runtime.activeDrawId ? (await tx.get(draws.doc(runtime.activeDrawId))).data() : null;
        if (real && real.status !== "cancelled" && (real.status !== "completed" || time < real.expiresAtMs)) return "busy";
        if (time - (runtime.lastTestAtMs ?? -Infinity) < TEST_COOLDOWN_MS) return "cooldown";
        tx.set(demos.doc(id), { ...demo, expiresAt: Timestamp.fromMillis(demo.expiresAtMs) });
        tx.set(runtimeRef, { ...runtime, demoId: id, lastTestAtMs: time });
        return null;
      });
      if (reason) await reply(userId, reason === "busy" ? "🧪 Un tirage réel est en cours. Attends sa fin pour lancer !coffretest." : "🧪 Attends une minute entre deux tests de coffres.");
      else {
        hasWork = true;
        await announce(demos.doc(id), "open", "🧪 TEST — Démonstration du tirage de 2 coffres. Aucune récompense réelle.");
      }
      return { handled: true, reason: reason || "test_started" };
    }
    if (!settings.enabled || userId === broadcasterId || userId === String(config.twitch.moderatorId) || isExcludedLogin(login)) return { handled: true, reason: "excluded" };
    const runtime = (await runtimeRef.get()).data() || {};
    const ref = runtime.activeDrawId ? draws.doc(runtime.activeDrawId) : null;
    const active = ref ? (await ref.get()).data() : null;
    if (!active || active.status !== "open" || now() >= active.closesAtMs) {
      await reply(userId, "🎁 Les inscriptions sont fermées. Attends l’annonce du prochain tirage !");
      return { handled: true, reason: "closed" };
    }
    const identity = await resolveTwitchIdentity({ login, twitchUserId: userId, allowCreate: false });
    if (!identity?.login || ["conflict", "migrating"].includes(identity.status)) return { handled: true, reason: "identity_conflict" };
    const follower = db.collection("followers_all_time").doc(identity.login);
    const entry = ref.collection("entries").doc(userId);
    const result = await db.runTransaction(async (tx) => {
      const [drawSnap, entrySnap, profile, latestConfig] = await Promise.all([tx.get(ref), tx.get(entry), tx.get(follower), tx.get(configRef)]);
      const draw = drawSnap.data();
      if (!normalizeConfig(latestConfig.data()).enabled || draw?.status !== "open" || now() >= draw.closesAtMs) return "closed";
      if (!profile.exists) return "missing_profile";
      if (entrySnap.exists) return "duplicate";
      const profileId = ["twitch_id", "twitchId", "twitchUserId", "user_id"].map((key) => profile.data()[key]).find(Boolean);
      if (profileId && String(profileId) !== userId) return "identity_conflict";
      tx.set(entry, { userId, login: identity.login, displayName: String(displayName || login).slice(0, 25), joinedAtMs: now() });
      tx.update(ref, { entrantCount: (draw.entrantCount || 0) + 1 });
      return "joined";
    });
    if (result === "missing_profile") await reply(userId, `@${displayName || login} crée ton profil sur https://erwayr.online puis renvoie !coffre avant la fin des inscriptions.`);
    return { handled: true, reason: result };
  }

  function start() {
    if (timer) return;
    const run = () => tick().catch((error) => logger.warn("[live-chests] tick failed", error.code || error.message));
    void run();
    timer = setInterval(run, TICK_MS);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }
  return { start, stop, tick, handleMessage, settle };
}

module.exports = { createLiveChestDraws };
