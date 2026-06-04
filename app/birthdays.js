"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { EmbedBuilder } = require("discord.js");
const { commitBatchWithRetry } = require("../helper/firestoreRetry");
const { asDiscordId } = require("./textUtils");

const BIRTHDAY_BANNER_FILENAME = "birthday-banner.png";
const BIRTHDAY_BANNER_ATTACHMENT_URL = `attachment://${BIRTHDAY_BANNER_FILENAME}`;
const BIRTHDAY_RUBY_REWARD_AMOUNT = 500;
const BIRTHDAY_RUBY_EMOJI = "♦️";
const BIRTHDAY_RUBY_TRANSACTION_TYPE = "birthday_reward";
const BIRTHDAY_RUBY_TRANSACTION_SOURCE = "birthday_discord_announcement";
const POPS_SCHEMA_VERSION = 1;
const DEFAULT_BIRTHDAY_BANNER_PATH = path.join(
  __dirname,
  "..",
  "assets",
  BIRTHDAY_BANNER_FILENAME,
);

function safeDiscordText(value, fallback = "") {
  return String(value || fallback)
    .trim()
    .replace(/@/g, "@\u200b");
}

function normalizeBirthdayLogin(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeBirthdayEntry(entry = {}) {
  const login = normalizeBirthdayLogin(entry.login || entry.pseudo || entry.id);
  const display = safeDiscordText(
    entry.display ||
      entry.display_name ||
      entry.displayName ||
      entry.globalName ||
      entry.username ||
      login,
    login || "membre",
  );
  const discordId = asDiscordId(
    entry.discord_id || entry.discordId || entry.discordID,
  );

  return {
    login: login || display.toLowerCase(),
    display,
    discord_id: discordId || "",
  };
}

function pickDisplayNameFromDoc(docId, data) {
  return data?.display_name || data?.displayName || data?.pseudo || docId;
}

function birthdayEntryFromDoc(docId, data = {}) {
  return normalizeBirthdayEntry({
    login: docId,
    display: pickDisplayNameFromDoc(docId, data),
    discord_id: data?.discord_id,
  });
}

function uniqueBirthdayEntries(birthdays = []) {
  const seen = new Set();
  return birthdays
    .map(normalizeBirthdayEntry)
    .filter((entry) => {
      const key = entry.discord_id || entry.login || entry.display;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function mentionOrDisplay(entry, { mention = true } = {}) {
  const normalized = normalizeBirthdayEntry(entry);
  if (mention && normalized.discord_id) return `<@${normalized.discord_id}>`;
  return `**${normalized.display}**`;
}

function formatBirthdayNameList(entries, { mention = true } = {}) {
  const names = entries.map((entry) => mentionOrDisplay(entry, { mention }));
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} et ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
}

function birthdayCountLabel(count) {
  if (count === 2) return "double";
  if (count === 3) return "triple";
  return `${count}x`;
}

function toSafeCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function normalizePopsWallet(source = {}) {
  const wallet =
    source?.pops && typeof source.pops === "object" ? source.pops : source;
  const balance = toSafeCount(wallet?.balance);
  const lifetimeEarned = Math.max(balance, toSafeCount(wallet?.lifetimeEarned));

  return {
    balance,
    lifetimeEarned,
    schemaVersion: Number(wallet?.schemaVersion || POPS_SCHEMA_VERSION),
  };
}

function birthdayPopsTransactionId(dateKey, login) {
  const safeDateKey = String(dateKey || "").replace(/[^0-9A-Za-z_-]/g, "_");
  const safeLogin = normalizeBirthdayLogin(login).replace(/[^0-9a-z_-]/g, "_");
  return `birthday_${safeDateKey}_${safeLogin || "unknown"}`;
}

function resolveBirthdayBannerAttachment(
  bannerPath = DEFAULT_BIRTHDAY_BANNER_PATH,
) {
  const attachmentPath = String(bannerPath || "").trim();
  if (!attachmentPath || !fs.existsSync(attachmentPath)) return null;

  return {
    attachment: attachmentPath,
    name: BIRTHDAY_BANNER_FILENAME,
  };
}

function buildDiscordBirthdayPayload({
  birthdays = [],
  test = false,
  bannerPath = DEFAULT_BIRTHDAY_BANNER_PATH,
} = {}) {
  const entries = uniqueBirthdayEntries(birthdays);
  if (!entries.length) return null;

  const mentionIds = entries
    .map((entry) => entry.discord_id)
    .filter(Boolean);
  const names = formatBirthdayNameList(entries, { mention: true });
  const count = entries.length;
  const grouped = count > 1;
  const prefix = test ? "🧪 TEST - non publié\n" : "";
  const content = grouped
    ? `${prefix}**ANNIVERSAIRE COMMUNAUTÉ** ✨🎉\n- Aujourd'hui, ${birthdayCountLabel(
        count,
      )} tournée de bougies pour ${names} ! Sortez les confettis et le loot légendaire 🎂`
    : `${prefix}**QUÊTE ANNIVERSAIRE DÉBLOQUÉE** ✨🎉\n- Tout le monde, on fait du bruit pour ${names} 🎂`;

  const title = grouped
    ? `${test ? "TEST - " : ""}Raid de bougies débloqué ! 🎂`
    : `${test ? "TEST - " : ""}Joyeux anniversaire ${entries[0].display} ! 🎂`;
  const description = grouped
    ? [
        `- **Événement rare :** ${birthdayCountLabel(
          count,
      )} anniversaire dans la communauté Erwayr 🎮`,
        `- ${names} partagent la scène du jour et lancent une party pleine de bougies 🏆`,
        `- **Récompense légendaire :** Une pluie de rubis pour les plus beaux des joyaux : +${BIRTHDAY_RUBY_REWARD_AMOUNT} ${BIRTHDAY_RUBY_EMOJI} chacun ${BIRTHDAY_RUBY_EMOJI}`,
      ].join("\n")
    : [
        `- **Héros du jour :** ${mentionOrDisplay(entries[0], {
          mention: true,
        })} 🏆`,
        "- **Quête spéciale :** souffler ses bougies avec toute la communauté des loulous 🎮",
        `- **Récompense légendaire :** Une pluie de rubis pour le plus beau des joyaux : +${BIRTHDAY_RUBY_REWARD_AMOUNT} ${BIRTHDAY_RUBY_EMOJI} ${BIRTHDAY_RUBY_EMOJI}`,
      ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(test ? 0xffa726 : 0xff3d8b)
    .setTitle(title)
    .setDescription(description)
    .addFields({
      name: "Mission du serveur ✨",
      value: grouped
        ? "- Envoyer une vague de vœux, de GG et de bonnes ondes à toute l'équipe anniversaire ✨"
        : "- Remplir le général de vœux, de GG et de petites étincelles de bonne humeur ✨",
      inline: false,
    })
    .setFooter({
      text: test
        ? "Erwayr • Preview anniversaire"
        : "Erwayr • Anniversaire du jour",
    })
    .setTimestamp(new Date());

  const bannerAttachment = resolveBirthdayBannerAttachment(bannerPath);
  if (bannerAttachment) {
    embed.setImage(BIRTHDAY_BANNER_ATTACHMENT_URL);
  }

  const payload = {
    content,
    embeds: [embed],
    allowedMentions:
      !test && mentionIds.length
        ? { parse: [], users: mentionIds }
        : { parse: [] },
  };

  if (bannerAttachment) payload.files = [bannerAttachment];

  return payload;
}

function discordEntryFromMember(member) {
  const user = member?.user || member || {};
  const discordId = asDiscordId(member?.id || user?.id);
  const display =
    member?.displayName ||
    member?.nickname ||
    user?.globalName ||
    user?.username ||
    "membre";
  return normalizeBirthdayEntry({
    login: discordId || display,
    display,
    discord_id: discordId,
  });
}

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

  function birthdayFollowersQuery() {
    const fields = Array.from(
      new Set([birthdayConfig.field, ...birthdayConfig.displayFields, "discord_id"]),
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
    const entry = birthdayEntryFromDoc(docId, data);
    const display = entry.display;
    const bd = parseBirthday(data?.[birthdayConfig.field]);
    if (!bd) return { dayKey: "", display, discord_id: entry.discord_id };
    const dayKey = monthDayKeyFromParts(bd.month, bd.day);
    if (!dayKey || dayKey === "00-00") {
      return { dayKey: "", display, discord_id: entry.discord_id };
    }
    return { dayKey, display, discord_id: entry.discord_id };
  }

  function isSameBirthdayState(a, b) {
    return (
      String(a?.dayKey || "") === String(b?.dayKey || "") &&
      String(a?.display || "") === String(b?.display || "") &&
      String(a?.discord_id || "") === String(b?.discord_id || "")
    );
  }

  function removeBirthdayListEntry(list, login) {
    return list.filter(
      (entry) => String(entry?.login || "").toLowerCase() !== login,
    );
  }

  function upsertBirthdayListEntry(list, login, display, discordId) {
    const next = removeBirthdayListEntry(list, login);
    next.push({ login, display, discord_id: asDiscordId(discordId) || "" });
    return next;
  }

  async function syncBirthdayIndexEntry(login, prevState, nextState) {
    if (!login) return;
    if (isSameBirthdayState(prevState, nextState)) return;

    const oldDayKey = String(prevState?.dayKey || "");
    const newDayKey = String(nextState?.dayKey || "");
    const newDisplay = String(nextState?.display || login);
    const newDiscordId = asDiscordId(nextState?.discord_id) || "";
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
          upsertBirthdayListEntry(
            lists.get(newDayKey) || [],
            login,
            newDisplay,
            newDiscordId,
          ),
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
      birthdayToday.set(
        login,
        normalizeBirthdayEntry({
          login,
          display: newDisplay,
          discord_id: newDiscordId,
        }),
      );
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

      const entry = birthdayEntryFromDoc(doc.id, data);
      const dayKey = monthDayKeyFromParts(bd.month, bd.day);
      if (!dayKey || dayKey === "00-00") return;

      const arr = index.get(dayKey) || [];
      arr.push(entry);
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

            birthdayToday.set(login, birthdayEntryFromDoc(doc.id, data));
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
            birthdayToday.set(login, normalizeBirthdayEntry({ ...entry, login }));
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

    const entry = normalizeBirthdayEntry(birthdayToday.get(login) || { login });
    const display = entry.display || login;
    const msg = buildBirthdayMessage(login, display);

    await sendTwitchChatMessage(msg);
    birthdayCongratulated.add(key);
  }

  function birthdayEntriesForDiscord() {
    return uniqueBirthdayEntries(Array.from(birthdayToday.values()));
  }

  function discordAnnouncementCollection() {
    return (
      birthdayConfig.discordAnnouncementCollection ||
      "birthday_discord_announcements"
    );
  }

  function nowServerTimestamp() {
    return admin.firestore.FieldValue.serverTimestamp();
  }

  function compactBirthdayEntries(entries) {
    return entries.map((entry) => ({
      login: entry.login,
      display: entry.display,
      discord_id: entry.discord_id || "",
    }));
  }

  async function awardBirthdayRubyReward(dateKey, entry) {
    const birthdayEntry = normalizeBirthdayEntry(entry);
    const login = normalizeBirthdayLogin(birthdayEntry.login);
    if (!login) {
      return { awarded: false, reason: "NO_LOGIN", amount: 0 };
    }

    const followerRef = db.collection("followers_all_time").doc(login);
    const transactionId = birthdayPopsTransactionId(dateKey, login);
    const transactionRef = followerRef
      .collection("pops_transactions")
      .doc(transactionId);

    if (typeof db.runTransaction === "function") {
      return db.runTransaction(async (tx) => {
        const [followerSnap, transactionSnap] = await Promise.all([
          tx.get(followerRef),
          tx.get(transactionRef),
        ]);

        if (!followerSnap.exists) {
          return {
            awarded: false,
            reason: "FOLLOWER_NOT_FOUND",
            login,
            amount: 0,
            transactionId,
          };
        }
        if (transactionSnap.exists) {
          return {
            awarded: false,
            reason: "ALREADY_AWARDED",
            login,
            amount: 0,
            transactionId,
          };
        }

        const currentWallet = normalizePopsWallet(followerSnap.data() || {});
        const nextWallet = {
          balance: currentWallet.balance + BIRTHDAY_RUBY_REWARD_AMOUNT,
          lifetimeEarned:
            currentWallet.lifetimeEarned + BIRTHDAY_RUBY_REWARD_AMOUNT,
          schemaVersion: POPS_SCHEMA_VERSION,
        };
        const awardedAt = new Date();

        tx.update(followerRef, {
          "pops.balance": nextWallet.balance,
          "pops.lifetimeEarned": nextWallet.lifetimeEarned,
          "pops.updatedAt": awardedAt,
          "pops.schemaVersion": POPS_SCHEMA_VERSION,
        });
        tx.set(transactionRef, {
          type: BIRTHDAY_RUBY_TRANSACTION_TYPE,
          source: BIRTHDAY_RUBY_TRANSACTION_SOURCE,
          amount: BIRTHDAY_RUBY_REWARD_AMOUNT,
          dateKey,
          login,
          display: birthdayEntry.display,
          createdAt: awardedAt,
          schemaVersion: POPS_SCHEMA_VERSION,
          serverAuthoritative: true,
        });

        return {
          awarded: true,
          reason: "AWARDED",
          login,
          amount: BIRTHDAY_RUBY_REWARD_AMOUNT,
          before: currentWallet.balance,
          after: nextWallet.balance,
          transactionId,
        };
      });
    }

    const transactionSnap = await transactionRef.get();
    if (transactionSnap.exists) {
      return {
        awarded: false,
        reason: "ALREADY_AWARDED",
        login,
        amount: 0,
        transactionId,
      };
    }

    const followerSnap = await followerRef.get();
    if (!followerSnap.exists) {
      return {
        awarded: false,
        reason: "FOLLOWER_NOT_FOUND",
        login,
        amount: 0,
        transactionId,
      };
    }

    const currentWallet = normalizePopsWallet(followerSnap.data() || {});
    const nextWallet = {
      balance: currentWallet.balance + BIRTHDAY_RUBY_REWARD_AMOUNT,
      lifetimeEarned:
        currentWallet.lifetimeEarned + BIRTHDAY_RUBY_REWARD_AMOUNT,
      schemaVersion: POPS_SCHEMA_VERSION,
    };
    const awardedAt = new Date();

    await followerRef.update({
      "pops.balance": nextWallet.balance,
      "pops.lifetimeEarned": nextWallet.lifetimeEarned,
      "pops.updatedAt": awardedAt,
      "pops.schemaVersion": POPS_SCHEMA_VERSION,
    });
    await transactionRef.set({
      type: BIRTHDAY_RUBY_TRANSACTION_TYPE,
      source: BIRTHDAY_RUBY_TRANSACTION_SOURCE,
      amount: BIRTHDAY_RUBY_REWARD_AMOUNT,
      dateKey,
      login,
      display: birthdayEntry.display,
      createdAt: awardedAt,
      schemaVersion: POPS_SCHEMA_VERSION,
      serverAuthoritative: true,
    });

    return {
      awarded: true,
      reason: "AWARDED",
      login,
      amount: BIRTHDAY_RUBY_REWARD_AMOUNT,
      before: currentWallet.balance,
      after: nextWallet.balance,
      transactionId,
    };
  }

  async function awardBirthdayRubyRewards(dateKey, entries) {
    const rewards = [];
    for (const entry of entries) {
      rewards.push(await awardBirthdayRubyReward(dateKey, entry));
    }
    return rewards;
  }

  async function claimDiscordBirthdayAnnouncement(dateKey, entries) {
    const ref = db.collection(discordAnnouncementCollection()).doc(dateKey);
    const payload = {
      dateKey,
      status: "processing",
      count: entries.length,
      birthdays: compactBirthdayEntries(entries),
      updatedAt: nowServerTimestamp(),
    };

    if (typeof db.runTransaction === "function") {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const status = String(snap.exists ? snap.data()?.status || "" : "");
        if (status === "sent") return null;
        tx.set(
          ref,
          {
            ...payload,
            processingAt: nowServerTimestamp(),
          },
          { merge: true },
        );
        return ref;
      });
    }

    const snap = await ref.get();
    const status = String(snap.exists ? snap.data()?.status || "" : "");
    if (status === "sent") return null;
    await ref.set(
      {
        ...payload,
        processingAt: nowServerTimestamp(),
      },
      { merge: true },
    );
    return ref;
  }

  async function fetchDiscordTextChannel(client, channelId) {
    if (!channelId) throw new Error("Canal Discord anniversaire manquant.");
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased?.()) {
      throw new Error(`Canal Discord anniversaire invalide: ${channelId}`);
    }
    return channel;
  }

  async function sendDiscordBirthdayAnnouncements({ client, channelId } = {}) {
    const dateKey = warsawDateKey(new Date());
    if (dateKey !== birthdayDateKey) {
      await refreshTodayBirthdays();
    }

    const entries = birthdayEntriesForDiscord();
    if (!entries.length) {
      return { sent: false, skipped: true, reason: "NO_BIRTHDAY", count: 0 };
    }

    const ref = await claimDiscordBirthdayAnnouncement(dateKey, entries);
    if (!ref) {
      return {
        sent: false,
        skipped: true,
        reason: "ALREADY_SENT",
        count: entries.length,
      };
    }

    try {
      const payload = buildDiscordBirthdayPayload({ birthdays: entries });
      const rewardResults = await awardBirthdayRubyRewards(dateKey, entries);
      const channel = await fetchDiscordTextChannel(client, channelId);
      const message = await channel.send(payload);
      await ref.set(
        {
          status: "sent",
          sentAt: nowServerTimestamp(),
          updatedAt: nowServerTimestamp(),
          channelId,
          messageId: message?.id || "",
          rubyRewardAmount: BIRTHDAY_RUBY_REWARD_AMOUNT,
          rubyRewards: rewardResults,
        },
        { merge: true },
      );
      return {
        sent: true,
        skipped: false,
        count: entries.length,
        messageId: message?.id || "",
        rubyRewards: rewardResults,
      };
    } catch (e) {
      await ref.set(
        {
          status: "error",
          errorAt: nowServerTimestamp(),
          updatedAt: nowServerTimestamp(),
          lastError: String(e?.message || e).slice(0, 1200),
        },
        { merge: true },
      );
      throw e;
    }
  }

  async function sendDiscordBirthdayTest({
    client,
    channelId,
    members = [],
  } = {}) {
    const entries = uniqueBirthdayEntries(members.map(discordEntryFromMember));
    const payload = buildDiscordBirthdayPayload({ birthdays: entries, test: true });
    if (!payload) {
      return { sent: false, skipped: true, reason: "NO_MEMBER", count: 0 };
    }

    const channel = await fetchDiscordTextChannel(client, channelId);
    const message = await channel.send(payload);
    return {
      sent: true,
      skipped: false,
      count: entries.length,
      messageId: message?.id || "",
    };
  }

  return {
    refreshTodayBirthdays,
    buildBirthdayIndex,
    handleFollowerChanges,
    maybeSendBirthdayCongrats,
    sendDiscordBirthdayAnnouncements,
    sendDiscordBirthdayTest,
  };
}

module.exports = {
  buildDiscordBirthdayPayload,
  createBirthdayService,
};
