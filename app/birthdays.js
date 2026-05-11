"use strict";

const { commitBatchWithRetry } = require("../helper/firestoreRetry");

function createBirthdayService({ db, admin, config }) {
  const birthdayConfig = config.birthdays;
  let birthdayToday = new Map();
  let birthdayCongratulated = new Set();
  let birthdayDateKey = "";
  let birthdayFollowerState = new Map();
  let birthdayFollowerSeeded = false;
  const birthdaySyncQueues = new Map();

  function getWarsawParts(date) {
    const fmt = new Intl.DateTimeFormat("fr-FR", {
      timeZone: config.timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    const parts = fmt.formatToParts(date);
    const out = { year: 0, month: 0, day: 0 };
    for (const p of parts) {
      if (p.type === "year") out.year = parseInt(p.value, 10);
      if (p.type === "month") out.month = parseInt(p.value, 10);
      if (p.type === "day") out.day = parseInt(p.value, 10);
    }
    return out;
  }

  function warsawDateKey(date = new Date()) {
    const p = getWarsawParts(date);
    const mm = String(p.month).padStart(2, "0");
    const dd = String(p.day).padStart(2, "0");
    return `${p.year}-${mm}-${dd}`;
  }

  function parseBirthday(value) {
    if (!value) return null;

    if (typeof value === "object" && typeof value.toDate === "function") {
      const d = value.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        const p = getWarsawParts(d);
        return { month: p.month, day: p.day };
      }
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const p = getWarsawParts(value);
      return { month: p.month, day: p.day };
    }

    if (typeof value === "string") {
      const s = value.trim();
      if (!s) return null;

      let m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
      if (m) return { month: parseInt(m[2], 10), day: parseInt(m[3], 10) };

      m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
      if (m) return { month: parseInt(m[2], 10), day: parseInt(m[1], 10) };

      m = s.match(/^(\d{1,2})[\/.-](\d{1,2})$/);
      if (m) return { month: parseInt(m[2], 10), day: parseInt(m[1], 10) };

      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        const p = getWarsawParts(d);
        return { month: p.month, day: p.day };
      }
    }

    return null;
  }

  function pickDisplayNameFromDoc(docId, data) {
    return data?.display_name || data?.displayName || data?.pseudo || docId;
  }

  function birthdayFollowersQuery() {
    const fields = Array.from(
      new Set([birthdayConfig.field, ...birthdayConfig.displayFields]),
    );
    return db.collection("followers_all_time").select(...fields);
  }

  function monthDayKeyFromParts(month, day) {
    const mm = String(month || "").padStart(2, "0");
    const dd = String(day || "").padStart(2, "0");
    return `${mm}-${dd}`;
  }

  function toMillisMaybe(value) {
    if (!value) return 0;
    if (value instanceof Date) {
      const ms = value.getTime();
      return Number.isNaN(ms) ? 0 : ms;
    }
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? 0 : ms;
    }
    if (typeof value === "object" && typeof value.toDate === "function") {
      const d = value.toDate();
      if (!(d instanceof Date)) return 0;
      const ms = d.getTime();
      return Number.isNaN(ms) ? 0 : ms;
    }
    return 0;
  }

  function birthdayStateFromDoc(docId, data) {
    const login = String(docId || "").toLowerCase();
    const display = String(pickDisplayNameFromDoc(docId, data) || login);
    const bd = parseBirthday(data?.[birthdayConfig.field]);
    if (!bd) return { dayKey: "", display };
    const dayKey = monthDayKeyFromParts(bd.month, bd.day);
    if (!dayKey || dayKey === "00-00") return { dayKey: "", display };
    return { dayKey, display };
  }

  function isSameBirthdayState(a, b) {
    return (
      String(a?.dayKey || "") === String(b?.dayKey || "") &&
      String(a?.display || "") === String(b?.display || "")
    );
  }

  function removeBirthdayListEntry(list, login) {
    return list.filter(
      (entry) => String(entry?.login || "").toLowerCase() !== login,
    );
  }

  function upsertBirthdayListEntry(list, login, display) {
    const next = removeBirthdayListEntry(list, login);
    next.push({ login, display });
    return next;
  }

  async function syncBirthdayIndexEntry(login, prevState, nextState) {
    if (!login) return;
    if (isSameBirthdayState(prevState, nextState)) return;

    const oldDayKey = String(prevState?.dayKey || "");
    const newDayKey = String(nextState?.dayKey || "");
    const newDisplay = String(nextState?.display || login);
    if (!oldDayKey && !newDayKey) return;

    await db.runTransaction(async (tx) => {
      const touchedDayKeys = Array.from(
        new Set([oldDayKey, newDayKey].filter(Boolean)),
      );
      const refs = new Map();
      const lists = new Map();

      for (const dayKey of touchedDayKeys) {
        const ref = db.collection(birthdayConfig.indexCollection).doc(dayKey);
        refs.set(dayKey, ref);
        const snap = await tx.get(ref);
        const list = Array.isArray(snap.data()?.list) ? snap.data().list : [];
        lists.set(dayKey, list);
      }

      if (oldDayKey) {
        lists.set(
          oldDayKey,
          removeBirthdayListEntry(lists.get(oldDayKey) || [], login),
        );
      }
      if (newDayKey) {
        lists.set(
          newDayKey,
          upsertBirthdayListEntry(lists.get(newDayKey) || [], login, newDisplay),
        );
      }

      for (const dayKey of touchedDayKeys) {
        tx.set(
          refs.get(dayKey),
          {
            list: lists.get(dayKey) || [],
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    });

    const todayParts = getWarsawParts(new Date());
    const todayDayKey = monthDayKeyFromParts(todayParts.month, todayParts.day);
    if (oldDayKey === todayDayKey && newDayKey !== todayDayKey) {
      birthdayToday.delete(login);
    }
    if (newDayKey === todayDayKey) {
      birthdayToday.set(login, newDisplay);
    }
  }

  function enqueueBirthdayIndexSync(login, prevState, nextState) {
    const chain = (birthdaySyncQueues.get(login) || Promise.resolve())
      .then(() => syncBirthdayIndexEntry(login, prevState, nextState))
      .catch((e) =>
        console.warn("[birthday] incremental sync failed:", e?.message || e),
      )
      .finally(() => {
        if (birthdaySyncQueues.get(login) === chain) {
          birthdaySyncQueues.delete(login);
        }
      });
    birthdaySyncQueues.set(login, chain);
  }

  function handleBirthdayFollowerChange(change, { skipAdded = false } = {}) {
    const login = String(change?.doc?.id || "").toLowerCase();
    if (!login) return;

    const prevState = birthdayFollowerState.get(login) || null;
    let nextState = null;

    if (change.type !== "removed") {
      const data = change.doc.data() || {};
      nextState = birthdayStateFromDoc(change.doc.id, data);
      birthdayFollowerState.set(login, nextState);
    } else {
      birthdayFollowerState.delete(login);
    }

    if (skipAdded && change.type === "added") return;
    enqueueBirthdayIndexSync(login, prevState, nextState);
  }

  function handleFollowerChanges(changes) {
    const skipAdded = !birthdayFollowerSeeded;
    changes.forEach((change) => {
      handleBirthdayFollowerChange(change, { skipAdded });
    });
    if (!birthdayFollowerSeeded) birthdayFollowerSeeded = true;
  }

  async function buildBirthdayIndex() {
    console.log("[birthday] build index...");

    const snap = await birthdayFollowersQuery().get();
    const index = new Map();

    snap.forEach((doc) => {
      const data = doc.data() || {};
      const bd = parseBirthday(data[birthdayConfig.field]);
      if (!bd) return;

      const login = String(doc.id || "").toLowerCase();
      if (!login) return;

      const display = String(pickDisplayNameFromDoc(doc.id, data) || login);
      const dayKey = monthDayKeyFromParts(bd.month, bd.day);
      if (!dayKey || dayKey === "00-00") return;

      const arr = index.get(dayKey) || [];
      arr.push({ login, display });
      index.set(dayKey, arr);
    });

    let batch = db.batch();
    let ops = 0;

    for (const [dayKey, list] of index) {
      const ref = db.collection(birthdayConfig.indexCollection).doc(dayKey);
      batch.set(
        ref,
        { list, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      ops += 1;
      if (ops >= 400) {
        await commitBatchWithRetry(batch, { label: "birthday-index" });
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) {
      await commitBatchWithRetry(batch, { label: "birthday-index" });
    }

    await db.doc(birthdayConfig.indexMetaDoc).set(
      {
        builtAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        days: index.size,
        version: birthdayConfig.indexVersion,
      },
      { merge: true },
    );

    console.log(`[birthday] index built (${index.size} days)`);
  }

  async function refreshTodayBirthdays() {
    const now = new Date();
    const dk = warsawDateKey(now);
    const { month, day } = getWarsawParts(now);
    const dayKey = monthDayKeyFromParts(month, day);

    birthdayDateKey = dk;
    birthdayToday = new Map();

    let usedFallback = false;
    let needsRebuild = true;

    try {
      const metaSnap = await db.doc(birthdayConfig.indexMetaDoc).get();
      if (metaSnap.exists) {
        const meta = metaSnap.data() || {};
        const version = Number(meta.version || 0);
        if (version >= birthdayConfig.indexVersion) {
          needsRebuild = false;
          if (birthdayConfig.indexMaxAgeHours > 0) {
            const lastTs =
              toMillisMaybe(meta.updatedAt) || toMillisMaybe(meta.builtAt);
            if (lastTs) {
              const maxAgeMs =
                birthdayConfig.indexMaxAgeHours * 60 * 60 * 1000;
              if (Date.now() - lastTs > maxAgeMs) needsRebuild = true;
            }
          }
        }
      }
    } catch (e) {
      console.warn("[birthday] index meta read failed:", e?.message || e);
    }

    if (needsRebuild) {
      try {
        await buildBirthdayIndex();
      } catch (e) {
        console.warn("[birthday] index build failed:", e?.message || e);
        if (birthdayConfig.indexFallbackScan) {
          const snap = await birthdayFollowersQuery().get();
          snap.forEach((doc) => {
            const data = doc.data() || {};
            const bd = parseBirthday(data[birthdayConfig.field]);
            if (!bd) return;
            if (bd.month !== month || bd.day !== day) return;

            const login = String(doc.id || "").toLowerCase();
            if (!login) return;

            const display = String(pickDisplayNameFromDoc(doc.id, data) || login);
            birthdayToday.set(login, display);
          });
          usedFallback = true;
        } else {
          console.warn(
            "[birthday] fallback scan disabled; birthdays list may be empty",
          );
        }
      }
    }

    if (!usedFallback) {
      try {
        const daySnap = await db
          .collection(birthdayConfig.indexCollection)
          .doc(dayKey)
          .get();
        const list = daySnap.exists ? daySnap.data()?.list : null;
        if (Array.isArray(list)) {
          list.forEach((entry) => {
            const login = String(entry?.login || "").toLowerCase();
            if (!login) return;
            const display = String(entry?.display || login);
            birthdayToday.set(login, display);
          });
        }
      } catch (e) {
        console.warn("[birthday] index day read failed:", e?.message || e);
      }
    }

    console.log(`[birthday] Birthdays today (${dk}) = ${birthdayToday.size}`);
  }

  function buildBirthdayMessage(login, display) {
    return `🎂 Joyeux anniversaire @${login} ! Profite à fond de ta journée ✨`;
  }

  async function maybeSendBirthdayCongrats(login, sendTwitchChatMessage) {
    const dk = warsawDateKey(new Date());
    if (dk !== birthdayDateKey) {
      await refreshTodayBirthdays().catch((e) =>
        console.warn("refreshTodayBirthdays failed:", e?.message || e),
      );
    }

    if (!birthdayToday.has(login)) return;

    const key = `${dk}|${login}`;
    if (birthdayCongratulated.has(key)) return;

    const display = birthdayToday.get(login) || login;
    const msg = buildBirthdayMessage(login, display);

    await sendTwitchChatMessage(msg);
    birthdayCongratulated.add(key);
  }

  return {
    refreshTodayBirthdays,
    buildBirthdayIndex,
    handleFollowerChanges,
    maybeSendBirthdayCongrats,
  };
}

module.exports = { createBirthdayService };
