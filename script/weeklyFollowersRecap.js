"use strict";

const {
  EXCLUDED_USER_NAMES,
  isExcludedLogin,
  isExcludedUserLike,
} = require("../helper/excludedUsers");

const SCORE_WEIGHTS = Object.freeze({
  presence: 10,
  chatMessage: 5,
  emote: 1,
  channelPoints: 2,
  clips: 8,
  raid: 4,
  chatMessageCapPerStream: 10,
  emoteCapPerStream: 5,
  channelPointsCapPerStream: 10,
  clipsCapPerStream: 5,
});

const DEFAULT_STATE_DOC_PATH = "settings/weekly_recap_state";
const POPS_SCHEMA_VERSION = 1;
const WEEKLY_RECAP_POPS_TRANSACTION_TYPE = "weekly_recap_winner";
const WEEKLY_RECAP_POPS_TRANSACTION_SOURCE = "weekly_recap";
const WEEK_RANGE_CURRENT = "current";
const WEEK_RANGE_PREVIOUS = "previous";
const DEFAULT_RANK_REWARDS = Object.freeze([
  { rank: 1, bonusPct: 10, popsReward: 100 },
  { rank: 2, bonusPct: 5, popsReward: 50 },
  { rank: 3, bonusPct: 2, popsReward: 25 },
]);

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toSafeCount(value) {
  return Math.max(0, Math.floor(toNum(value)));
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

function weeklyRecapPopsTransactionId(weekKey, rank) {
  const safeRank = Math.max(1, Math.floor(toNum(rank) || 1));
  return `weekly_recap_${String(weekKey || "").trim()}_rank_${safeRank}`;
}

function normalizeLogin(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function toMillis(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return toNum(value.toMillis());
  }

  if (typeof value.toDate === "function") {
    const d = value.toDate();
    if (!(d instanceof Date)) return 0;
    const ms = d.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }

  if (typeof value === "number") {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }

  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }

  if (typeof value === "object" && value.seconds != null) {
    const sec = toNum(value.seconds);
    const nano = toNum(value.nanoseconds || 0);
    return Math.floor(sec * 1000 + nano / 1e6);
  }

  return 0;
}

function normalizeStreams(streams) {
  if (Array.isArray(streams)) return streams;

  if (streams && typeof streams === "object") {
    return Object.keys(streams)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => streams[k])
      .filter((v) => v && typeof v === "object");
  }

  return [];
}

function streamTimestamp(stream) {
  const candidates = [
    stream?.presence?.last_at,
    stream?.chat_message?.last_at,
    stream?.emote?.last_at,
    stream?.channel_points?.last_at,
    stream?.raid?.at,
    stream?.started_at,
    stream?.ended_at,
    stream?.at,
    stream?.date,
    stream?.timestamp,
  ];

  let best = 0;
  for (const c of candidates) {
    const ms = toMillis(c);
    if (ms > best) best = ms;
  }
  return best;
}

function dayKeyInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  let year = "0000";
  let month = "00";
  let day = "00";

  for (const p of parts) {
    if (p.type === "year") year = p.value;
    if (p.type === "month") month = p.value;
    if (p.type === "day") day = p.value;
  }

  return `${year}-${month}-${day}`;
}

function monthKeyInTimezone(date, timeZone) {
  return dayKeyInTimezone(date, timeZone).slice(0, 7);
}

function weekdayInTimezone(date, timeZone) {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  const map = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return map[short] ?? date.getUTCDay();
}

function addUtcDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function getPreviousWeekRange(timeZone, now = new Date()) {
  const weekday = weekdayInTimezone(now, timeZone); // Sun=0 .. Sat=6
  const daysSinceMonday = (weekday + 6) % 7; // Mon -> 0, Sun -> 6
  const currentWeekAnchor = addUtcDays(now, -daysSinceMonday);

  const startDate = addUtcDays(currentWeekAnchor, -7);
  const endDate = addUtcDays(currentWeekAnchor, -1);

  return {
    startDate,
    endDate,
    startKey: dayKeyInTimezone(startDate, timeZone),
    endKey: dayKeyInTimezone(endDate, timeZone),
    startLabel: formatDateLabel(startDate, timeZone),
    endLabel: formatDateLabel(endDate, timeZone),
  };
}

function getWeeklyRange(timeZone, mode = WEEK_RANGE_PREVIOUS, now = new Date()) {
  const rangeMode = mode === WEEK_RANGE_CURRENT ? WEEK_RANGE_CURRENT : WEEK_RANGE_PREVIOUS;
  const weekday = weekdayInTimezone(now, timeZone); // Sun=0 .. Sat=6
  const daysSinceMonday = (weekday + 6) % 7; // Mon -> 0, Sun -> 6
  const currentWeekAnchor = addUtcDays(now, -daysSinceMonday);
  const startDate =
    rangeMode === WEEK_RANGE_CURRENT
      ? currentWeekAnchor
      : addUtcDays(currentWeekAnchor, -7);
  const endDate =
    rangeMode === WEEK_RANGE_CURRENT ? now : addUtcDays(currentWeekAnchor, -1);

  return {
    mode: rangeMode,
    startDate,
    endDate,
    startKey: dayKeyInTimezone(startDate, timeZone),
    endKey: dayKeyInTimezone(endDate, timeZone),
    startLabel: formatDateLabel(startDate, timeZone),
    endLabel: formatDateLabel(endDate, timeZone),
  };
}

function streamDayKey(stream, timeZone) {
  const ts = streamTimestamp(stream);
  if (ts > 0) return dayKeyInTimezone(new Date(ts), timeZone);

  const fallback = String(stream?.day_key || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(fallback)) return fallback;
  return "";
}

function streamMetrics(stream) {
  const presence = stream?.presence?.seen ? 1 : 0;
  const chatMessages = Math.max(
    0,
    Math.floor(
      toNum(
        stream?.chat_message?.count || (stream?.chat_message?.sent ? 1 : 0),
      ),
    ),
  );

  const emote = Math.max(0, Math.floor(toNum(stream?.emote?.count || 0)));

  let channelPoints = Math.max(
    0,
    Math.floor(
      toNum(
        stream?.channel_points?.redemptions ||
          stream?.channel_points?.count ||
          0,
      ),
    ),
  );
  if (!channelPoints && stream?.channel_points?.used) channelPoints = 1;

  const clips = Math.max(0, Math.floor(toNum(stream?.clips?.count || 0)));
  const raids = stream?.raid?.participated ? 1 : 0;

  return { presence, chatMessages, emote, channelPoints, clips, raids };
}

function scoreFromMetrics(m) {
  const chatEff = Math.min(
    m.chatMessages,
    SCORE_WEIGHTS.chatMessageCapPerStream,
  );
  const emoteEff = Math.min(m.emote, SCORE_WEIGHTS.emoteCapPerStream);
  const pointsEff = Math.min(
    m.channelPoints,
    SCORE_WEIGHTS.channelPointsCapPerStream,
  );
  const clipsEff = Math.min(m.clips, SCORE_WEIGHTS.clipsCapPerStream);

  return (
    m.presence * SCORE_WEIGHTS.presence +
    chatEff * SCORE_WEIGHTS.chatMessage +
    emoteEff * SCORE_WEIGHTS.emote +
    pointsEff * SCORE_WEIGHTS.channelPoints +
    clipsEff * SCORE_WEIGHTS.clips +
    m.raids * SCORE_WEIGHTS.raid
  );
}

function sumActivity(m) {
  return (
    m.presence + m.chatMessages + m.emote + m.channelPoints + m.clips + m.raids
  );
}

function asDiscordId(value) {
  const v = String(value || "").trim();
  return /^\d{6,30}$/.test(v) ? v : "";
}

function winnerMention(row) {
  const id = asDiscordId(row?.discordId);
  if (id) return `<@${id}>`;
  return `@${row?.pseudo || "gagnant"}`;
}

function rankingMentionIds(ranking) {
  const ids = [];
  const seen = new Set();

  for (const row of Array.isArray(ranking) ? ranking : []) {
    const id = asDiscordId(row?.discordId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function rankBadge(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return "🐺";
}

function normalizeRankRewards(rankRewards, fallbackBonusPct = 10) {
  const source = Array.isArray(rankRewards) && rankRewards.length
    ? rankRewards
    : DEFAULT_RANK_REWARDS;
  return source
    .map((reward, index) => ({
      rank: Math.max(1, Math.floor(toNum(reward?.rank || index + 1))),
      bonusPct: toSafeCount(
        reward?.bonusPct ?? (index === 0 ? fallbackBonusPct : 0),
      ),
      popsReward: toSafeCount(reward?.popsReward),
    }))
    .filter((reward) => reward.rank > 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
}

function rewardForRank(rank, rankRewards) {
  return rankRewards.find((reward) => reward.rank === rank) || null;
}

function formatRewardParts(reward) {
  const parts = [];
  const bonusPct = toSafeCount(reward?.bonusPct);
  const popsReward = toSafeCount(reward?.popsReward);
  if (bonusPct > 0) parts.push(`+${bonusPct}% quetes`);
  if (popsReward > 0) parts.push(`+${popsReward} ♦️`);
  return parts.join(", ");
}

function formatRecapRewardsBlock(rewardResult) {
  const rewards = Array.isArray(rewardResult?.rewards)
    ? rewardResult.rewards
    : [];
  const visibleRewards = rewards.filter((reward) => formatRewardParts(reward));
  if (!visibleRewards.length) return [];

  const lines = [];
  if (rewardResult?.reason === "MANUAL_PREVIEW") {
    lines.push("🧪 Apercu manuel - gains non appliques");
  } else if (rewardResult?.reason === "ALREADY_AWARDED") {
    lines.push("🎁 Gains deja attribues cette semaine");
  } else if (!rewardResult?.applied) {
    lines.push("🎁 Gains non appliques");
  }

  return lines.concat(
    visibleRewards.map((reward) => {
      const rankIndex = Math.max(0, toSafeCount(reward.rank) - 1);
      return `${rankBadge(rankIndex)} ${winnerMention(reward.row || reward)}: ${formatRewardParts(reward)}`;
    }),
  );
}

function formatHeaderText(headerText, range) {
  const text = String(headerText || "✨ Meilleurs Loulou de la semaine passee ✨");
  if (range?.mode !== WEEK_RANGE_CURRENT) return text;
  return text
    .replace("semaine passee", "semaine en cours")
    .replace("semaine passée", "semaine en cours");
}

function formatRecapMessage({ ranking, headerText, range, rewardResult }) {
  const lines = [];
  lines.push(formatHeaderText(headerText, range));
  if (range?.startLabel && range?.endLabel) {
    lines.push(`📅 Periode: ${range.startLabel} au ${range.endLabel}`);
  }
  lines.push("");

  if (!ranking.length) {
    lines.push("Top 0:");
    lines.push(
      "Personne n'a score cette semaine, on repart plus fort lundi prochain 💪",
    );
    return lines.join("\n");
  }

  lines.push("🏆 Voici les Gagnants :");
  const rewardLines = formatRecapRewardsBlock(rewardResult);
  if (rewardLines.length) {
    lines.push(...rewardLines);
  }
  lines.push("");

  lines.push(`Top ${ranking.length}:`);

  ranking.forEach((row, idx) => {
    lines.push(`${rankBadge(idx)} ${winnerMention(row)} - ${row.score} pts`);
  });

  lines.push("");
  lines.push("Merci a tous pour votre energie cette semaine ❤️");

  return lines.join("\n");
}

async function computeWeeklyRanking(
  db,
  { timeZone, limit, excludedLogins = [], rangeMode = WEEK_RANGE_PREVIOUS },
) {
  const range = getWeeklyRange(timeZone, rangeMode);
  const snap = await db.collection("followers_all_time").get();
  const allRows = [];
  const excludedSet = new Set(
    (Array.isArray(excludedLogins) ? excludedLogins : [])
      .map(normalizeLogin)
      .filter(Boolean),
  );

  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (isExcludedLogin(doc.id) || isExcludedUserLike(data)) return;
    const login = normalizeLogin(
      data.login ||
        data.pseudo ||
        data.display_name ||
        data.displayName ||
        doc.id,
    );
    if (!login || excludedSet.has(login)) return;

    const livePresence = data.live_presence;
    if (!livePresence || typeof livePresence !== "object") return;

    const totals = {
      presence: 0,
      chatMessages: 0,
      emote: 0,
      channelPoints: 0,
      clips: 0,
      raids: 0,
      score: 0,
    };

    for (const monthNode of Object.values(livePresence)) {
      const streams = normalizeStreams(monthNode?.streams);
      if (!streams.length) continue;

      streams.forEach((stream) => {
        const dayKey = streamDayKey(stream, timeZone);
        if (!dayKey) return;
        if (dayKey < range.startKey || dayKey > range.endKey) return;

        const m = streamMetrics(stream);
        if (sumActivity(m) <= 0) return;

        totals.presence += m.presence;
        totals.chatMessages += m.chatMessages;
        totals.emote += m.emote;
        totals.channelPoints += m.channelPoints;
        totals.clips += m.clips;
        totals.raids += m.raids;
        totals.score += scoreFromMetrics(m);
      });
    }

    if (totals.score <= 0) return;

    const pseudo = String(
      data.pseudo || data.display_name || data.displayName || doc.id,
    ).trim();
    if (!pseudo) return;

    allRows.push({
      docId: doc.id,
      login,
      pseudo,
      discordId: asDiscordId(data.discord_id),
      ...totals,
    });
  });

  allRows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.presence !== a.presence) return b.presence - a.presence;
    if (b.clips !== a.clips) return b.clips - a.clips;
    if (b.chatMessages !== a.chatMessages)
      return b.chatMessages - a.chatMessages;
    if (b.channelPoints !== a.channelPoints)
      return b.channelPoints - a.channelPoints;
    if (b.emote !== a.emote) return b.emote - a.emote;
    return a.pseudo.localeCompare(b.pseudo, "fr", { sensitivity: "base" });
  });

  return {
    range,
    ranking: allRows.slice(0, limit),
    totalActiveFollowers: allRows.length,
    winner: allRows[0] || null,
  };
}

function buildPlannedRankRewards({
  ranking,
  range,
  timeZone,
  rankRewards,
  reason = "MANUAL_PREVIEW",
}) {
  const weekKey = range ? `${range.startKey}_${range.endKey}` : "";
  const monthKey = monthKeyInTimezone(new Date(), timeZone);
  return (Array.isArray(ranking) ? ranking : [])
    .slice(0, 3)
    .map((row, index) => {
      const rank = index + 1;
      const reward = rewardForRank(rank, rankRewards);
      if (!reward) return null;
      return {
        row,
        rank,
        applied: false,
        reason,
        bonusPct: reward.bonusPct,
        popsReward: reward.popsReward,
        winnerLogin: row?.login || row?.docId || "",
        winnerPseudo: row?.pseudo || row?.docId || "",
        docId: row?.docId || "",
        discordId: row?.discordId || "",
        weekKey,
        monthKey,
        before: null,
        after: null,
        popsBefore: null,
        popsAfter: null,
        transactionId: weeklyRecapPopsTransactionId(weekKey, rank),
      };
    })
    .filter(Boolean);
}

function cleanRewardForState(reward) {
  return {
    rank: reward.rank,
    winner_login: reward.winnerLogin,
    winner_pseudo: reward.winnerPseudo,
    bonus_pct: reward.bonusPct,
    pops_reward: reward.popsReward,
    before_progress_pct: reward.before,
    after_progress_pct: reward.after,
    pops_before: reward.popsBefore,
    pops_after: reward.popsAfter,
    transaction_id: reward.transactionId || null,
  };
}

function getAwardedWeek(stateSnap, weekKey) {
  if (!stateSnap?.exists) return null;
  const fieldPath = `awardedWeeks.${weekKey}`;
  const fromGetter =
    typeof stateSnap.get === "function" ? stateSnap.get(fieldPath) : null;
  if (fromGetter) return fromGetter;

  const data = typeof stateSnap.data === "function" ? stateSnap.data() : {};
  return data?.awardedWeeks?.[weekKey] || data?.[fieldPath] || null;
}

async function applyWeeklyRankRewards(
  db,
  { ranking, range, timeZone, rankRewards, stateDocPath = DEFAULT_STATE_DOC_PATH },
) {
  const plannedRewards = buildPlannedRankRewards({
    ranking,
    range,
    timeZone,
    rankRewards,
    reason: "APPLIED",
  });

  const weekKey = range ? `${range.startKey}_${range.endKey}` : "";
  const monthKey = monthKeyInTimezone(new Date(), timeZone);
  if (!plannedRewards.length) {
    return {
      applied: false,
      reason: "NO_WINNERS",
      weekKey,
      monthKey,
      rewards: [],
    };
  }

  const stateRef = db.doc(stateDocPath);
  let alreadyAwarded = false;
  let rewards = plannedRewards;

  await db.runTransaction(async (tx) => {
    const stateSnap = await tx.get(stateRef);
    const already = getAwardedWeek(stateSnap, weekKey);

    if (already && typeof already === "object") {
      alreadyAwarded = true;
      return;
    }

    const followerReads = [];
    for (const planned of plannedRewards) {
      const winnerRef = db.collection("followers_all_time").doc(planned.docId);
      const winnerSnap = await tx.get(winnerRef);
      if (!winnerSnap.exists) {
        throw new Error(`weekly bonus winner doc missing: ${planned.docId}`);
      }
      followerReads.push({ planned, winnerRef, winnerSnap });
    }

    const appliedAt = new Date();
    const appliedAtMs = Date.now();
    const appliedRewards = [];

    for (const { planned, winnerRef, winnerSnap } of followerReads) {
      const data = winnerSnap.data() || {};
      const before = toNum(data?.live_presence?.[monthKey]?.progress_pct || 0);
      const after = Math.min(100, Math.max(0, before + planned.bonusPct));
      const currentWallet = normalizePopsWallet(data);
      const nextWallet = {
        balance: currentWallet.balance + planned.popsReward,
        lifetimeEarned: currentWallet.lifetimeEarned + planned.popsReward,
        schemaVersion: POPS_SCHEMA_VERSION,
      };
      const appliedReward = {
        ...planned,
        applied: true,
        reason: "APPLIED",
        before,
        after,
        popsBefore: currentWallet.balance,
        popsAfter: nextWallet.balance,
      };

      tx.update(winnerRef, {
        [`live_presence.${monthKey}.progress_pct`]: after,
        "pops.balance": nextWallet.balance,
        "pops.lifetimeEarned": nextWallet.lifetimeEarned,
        "pops.updatedAt": appliedAt,
        "pops.schemaVersion": POPS_SCHEMA_VERSION,
      });

      if (planned.popsReward > 0) {
        tx.set(
          winnerRef
            .collection("pops_transactions")
            .doc(planned.transactionId),
          {
            type: WEEKLY_RECAP_POPS_TRANSACTION_TYPE,
            amount: planned.popsReward,
            rank: planned.rank,
            bonusPct: planned.bonusPct,
            weekKey,
            rangeStart: range.startKey,
            rangeEnd: range.endKey,
            monthKey,
            createdAt: appliedAt,
            source: WEEKLY_RECAP_POPS_TRANSACTION_SOURCE,
            schemaVersion: POPS_SCHEMA_VERSION,
            serverAuthoritative: true,
          },
        );
      }

      appliedRewards.push(appliedReward);
    }

    rewards = appliedRewards;
    tx.set(
      stateRef,
      {
        awardedWeeks: {
          [weekKey]: {
            range_start: range.startKey,
            range_end: range.endKey,
            month_key: monthKey,
            applied_at_ms: appliedAtMs,
            schema_version: POPS_SCHEMA_VERSION,
            rewards: appliedRewards.map(cleanRewardForState),
          },
        },
      },
      { merge: true },
    );
  });

  if (alreadyAwarded) {
    return {
      applied: false,
      reason: "ALREADY_AWARDED",
      weekKey,
      monthKey,
      rewards: plannedRewards.map((reward) => ({
        ...reward,
        applied: false,
        reason: "ALREADY_AWARDED",
      })),
    };
  }

  return {
    applied: true,
    reason: "APPLIED",
    weekKey,
    monthKey,
    rewards,
  };
}

function createManualPreviewRewardResult({ ranking, range, timeZone, rankRewards }) {
  return {
    applied: false,
    reason: "MANUAL_PREVIEW",
    weekKey: range ? `${range.startKey}_${range.endKey}` : "",
    monthKey: monthKeyInTimezone(new Date(), timeZone),
    rewards: buildPlannedRankRewards({
      ranking,
      range,
      timeZone,
      rankRewards,
      reason: "MANUAL_PREVIEW",
    }),
  };
}

async function syncWeeklyRewardToParticipants(db, { reward }) {
  const winnerLogin = normalizeLogin(
    reward?.winnerLogin || reward?.row?.login || reward?.docId,
  );
  if (!winnerLogin || isExcludedLogin(winnerLogin)) {
    return { synced: false, reason: "NO_WINNER_LOGIN" };
  }

  const participantRef = db.collection("participants").doc(winnerLogin);
  const participantSnap = await participantRef.get();
  if (!participantSnap.exists) {
    return {
      synced: false,
      reason: "PARTICIPANT_NOT_FOUND",
      winnerLogin,
    };
  }

  const monthKey = String(reward?.monthKey || "").trim();
  const hasAfter = Number.isFinite(Number(reward?.after));
  const after = hasAfter
    ? Math.max(0, Math.min(100, toNum(reward.after)))
    : null;

  const payload = {
    weekly_recap_bonus: {
      winner_login: winnerLogin,
      winner_pseudo:
        String(reward?.winnerPseudo || reward?.row?.pseudo || winnerLogin).trim() ||
        winnerLogin,
      rank: Math.max(1, Math.floor(toNum(reward?.rank) || 1)),
      week_key: String(reward?.weekKey || ""),
      month_key: monthKey,
      bonus_pct: Math.max(0, Math.floor(toNum(reward?.bonusPct))),
      pops_reward: Math.max(0, Math.floor(toNum(reward?.popsReward))),
      applied: !!reward?.applied,
      reason: String(reward?.reason || ""),
      before_progress_pct: toNum(reward?.before),
      after_progress_pct: hasAfter ? after : null,
      transaction_id: String(reward?.transactionId || ""),
      synced_at_ms: Date.now(),
    },
  };

  if (hasAfter) {
    payload.progress_pct = after;
    payload.quest_progress_pct = after;
    if (monthKey) {
      payload[`live_presence.${monthKey}.progress_pct`] = after;
    }
  }

  await participantRef.set(payload, { merge: true });
  return {
    synced: true,
    winnerLogin,
    monthKey: monthKey || null,
    after,
  };
}

function createWeeklyFollowersRecap({
  db,
  client,
  defaultChannelId,
  timeZone = "Europe/Warsaw",
  limit = 10,
  excludedLogins = [],
  questBonusPct = 10,
  rankRewards = DEFAULT_RANK_REWARDS,
  stateDocPath = DEFAULT_STATE_DOC_PATH,
  headerText = "Meilleurs Loulou de la semaine passee",
}) {
  if (!db || !client) {
    throw new Error("createWeeklyFollowersRecap: missing db/client dependency");
  }

  const safeLimit = Math.max(1, Math.floor(toNum(limit) || 10));
  const safeBonusPct = Math.max(0, Math.floor(toNum(questBonusPct)));
  const safeRankRewards = normalizeRankRewards(rankRewards, safeBonusPct);
  const safeExcluded = (Array.isArray(excludedLogins) ? excludedLogins : [])
    .map(normalizeLogin)
    .filter(Boolean)
    .concat(EXCLUDED_USER_NAMES)
    .filter((value, index, arr) => arr.indexOf(value) === index);

  return async function sendWeeklyFollowersRecap({
    channelId = defaultChannelId,
    applyRewards = true,
    rangeMode = WEEK_RANGE_PREVIOUS,
  } = {}) {
    if (!channelId) {
      throw new Error("weekly recap target channel is missing");
    }

    const result = await computeWeeklyRanking(db, {
      timeZone,
      limit: safeLimit,
      excludedLogins: safeExcluded,
      rangeMode,
    });

    const shouldApplyRewards = applyRewards !== false;
    let rewardResult = createManualPreviewRewardResult({
      ranking: result.ranking,
      range: result.range,
      timeZone,
      rankRewards: safeRankRewards,
    });
    let participantsSync = [];

    if (shouldApplyRewards) {
      rewardResult = await applyWeeklyRankRewards(db, {
        ranking: result.ranking,
        range: result.range,
        timeZone,
        rankRewards: safeRankRewards,
        stateDocPath,
      });

      if (rewardResult.applied) {
        for (const reward of rewardResult.rewards) {
          try {
            participantsSync.push(
              await syncWeeklyRewardToParticipants(db, { reward }),
            );
          } catch (e) {
            console.warn(
              "[weekly-recap] participants sync failed:",
              e?.message || e,
            );
          }
        }
      } else {
        participantsSync = [{ synced: false, reason: rewardResult.reason }];
      }
    } else {
      participantsSync = [{ synced: false, reason: "REWARDS_DISABLED" }];
    }

    const content = formatRecapMessage({
      ranking: result.ranking,
      headerText,
      range: result.range,
      rewardResult,
    });

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`weekly recap target channel is invalid: ${channelId}`);
    }

    const mentionIds = rankingMentionIds(result.ranking);
    await channel.send({
      content,
      allowedMentions: mentionIds.length
        ? { parse: [], users: mentionIds }
        : { parse: [] },
    });

    return {
      ...result,
      bonus: rewardResult,
      rewardResult,
      participantsSync,
    };
  };
}

module.exports = { createWeeklyFollowersRecap };
