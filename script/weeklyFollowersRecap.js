"use strict";

const SCORE_WEIGHTS = Object.freeze({
  presence: 5,
  emote: 1,
  channelPoints: 2,
  clips: 8,
  raid: 4,
  emoteCapPerStream: 20,
  channelPointsCapPerStream: 10,
  clipsCapPerStream: 5,
});

const DEFAULT_STATE_DOC_PATH = "settings/weekly_recap_state";

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeLogin(value) {
  return String(value || "").trim().toLowerCase();
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

function streamDayKey(stream, timeZone) {
  const ts = streamTimestamp(stream);
  if (ts > 0) return dayKeyInTimezone(new Date(ts), timeZone);

  const fallback = String(stream?.day_key || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(fallback)) return fallback;
  return "";
}

function streamMetrics(stream) {
  const presence = stream?.presence?.seen ? 1 : 0;

  const emote = Math.max(0, Math.floor(toNum(stream?.emote?.count || 0)));

  let channelPoints = Math.max(
    0,
    Math.floor(
      toNum(
        stream?.channel_points?.redemptions || stream?.channel_points?.count || 0
      )
    )
  );
  if (!channelPoints && stream?.channel_points?.used) channelPoints = 1;

  const clips = Math.max(0, Math.floor(toNum(stream?.clips?.count || 0)));
  const raids = stream?.raid?.participated ? 1 : 0;

  return { presence, emote, channelPoints, clips, raids };
}

function scoreFromMetrics(m) {
  const emoteEff = Math.min(m.emote, SCORE_WEIGHTS.emoteCapPerStream);
  const pointsEff = Math.min(
    m.channelPoints,
    SCORE_WEIGHTS.channelPointsCapPerStream
  );
  const clipsEff = Math.min(m.clips, SCORE_WEIGHTS.clipsCapPerStream);

  return (
    m.presence * SCORE_WEIGHTS.presence +
    emoteEff * SCORE_WEIGHTS.emote +
    pointsEff * SCORE_WEIGHTS.channelPoints +
    clipsEff * SCORE_WEIGHTS.clips +
    m.raids * SCORE_WEIGHTS.raid
  );
}

function sumActivity(m) {
  return m.presence + m.emote + m.channelPoints + m.clips + m.raids;
}

function formatRecapMessage({ ranking, headerText }) {
  const lines = [];
  lines.push(String(headerText || "Meilleurs Loulou de la semaine passee"));
  lines.push("");

  if (!ranking.length) {
    lines.push("Top 0:");
    return lines.join("\n");
  }

  lines.push(`Top ${ranking.length}:`);

  ranking.forEach((row) => {
    lines.push(`${row.pseudo} - ${row.score} pts`);
  });

  return lines.join("\n");
}

async function computeWeeklyRanking(
  db,
  { timeZone, limit, excludedLogins = [] }
) {
  const range = getPreviousWeekRange(timeZone);
  const snap = await db.collection("followers_all_time").get();
  const allRows = [];
  const excludedSet = new Set(
    (Array.isArray(excludedLogins) ? excludedLogins : [])
      .map(normalizeLogin)
      .filter(Boolean)
  );

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const login = normalizeLogin(
      data.login || data.pseudo || data.display_name || data.displayName || doc.id
    );
    if (!login || excludedSet.has(login)) return;

    const livePresence = data.live_presence;
    if (!livePresence || typeof livePresence !== "object") return;

    const totals = {
      presence: 0,
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
        totals.emote += m.emote;
        totals.channelPoints += m.channelPoints;
        totals.clips += m.clips;
        totals.raids += m.raids;
        totals.score += scoreFromMetrics(m);
      });
    }

    if (totals.score <= 0) return;

    const pseudo = String(
      data.pseudo || data.display_name || data.displayName || doc.id
    ).trim();
    if (!pseudo) return;

    allRows.push({ docId: doc.id, login, pseudo, ...totals });
  });

  allRows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.presence !== a.presence) return b.presence - a.presence;
    if (b.clips !== a.clips) return b.clips - a.clips;
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

async function applyWinnerQuestBonus(
  db,
  {
    winner,
    range,
    timeZone,
    bonusPct,
    stateDocPath = DEFAULT_STATE_DOC_PATH,
  }
) {
  if (!winner?.docId) {
    return {
      applied: false,
      reason: "NO_WINNER",
      bonusPct: 0,
    };
  }

  const safeBonusPct = Math.max(0, Math.floor(toNum(bonusPct)));
  if (safeBonusPct <= 0) {
    return {
      applied: false,
      reason: "BONUS_DISABLED",
      bonusPct: 0,
      winnerLogin: winner.login,
      winnerPseudo: winner.pseudo,
    };
  }

  const weekKey = `${range.startKey}_${range.endKey}`;
  const now = new Date();
  const monthKey = monthKeyInTimezone(now, timeZone);
  const stateRef = db.doc(stateDocPath);
  const winnerRef = db.collection("followers_all_time").doc(winner.docId);

  let alreadyAwarded = false;
  let before = 0;
  let after = 0;

  await db.runTransaction(async (tx) => {
    const bonusFieldPath = `awardedWeeks.${weekKey}`;
    const stateSnap = await tx.get(stateRef);
    const already = stateSnap.exists ? stateSnap.get(bonusFieldPath) : null;

    if (already && typeof already === "object") {
      alreadyAwarded = true;
      before = toNum(already.before_progress_pct);
      after = toNum(already.after_progress_pct);
      return;
    }

    const winnerSnap = await tx.get(winnerRef);
    if (!winnerSnap.exists) {
      throw new Error(`weekly bonus winner doc missing: ${winner.docId}`);
    }

    const data = winnerSnap.data() || {};
    before = toNum(data?.live_presence?.[monthKey]?.progress_pct || 0);
    after = Math.min(100, Math.max(0, before + safeBonusPct));

    tx.update(winnerRef, {
      [`live_presence.${monthKey}.progress_pct`]: after,
    });

    tx.set(
      stateRef,
      {
        [bonusFieldPath]: {
          winner_login: winner.login || winner.docId,
          winner_pseudo: winner.pseudo || winner.docId,
          range_start: range.startKey,
          range_end: range.endKey,
          bonus_pct: safeBonusPct,
          month_key: monthKey,
          before_progress_pct: before,
          after_progress_pct: after,
          applied_at_ms: Date.now(),
        },
      },
      { merge: true }
    );
  });

  if (alreadyAwarded) {
    return {
      applied: false,
      reason: "ALREADY_AWARDED",
      bonusPct: safeBonusPct,
      winnerLogin: winner.login,
      winnerPseudo: winner.pseudo,
      weekKey,
      monthKey,
      before,
      after,
    };
  }

  return {
    applied: true,
    reason: "APPLIED",
    bonusPct: safeBonusPct,
    winnerLogin: winner.login,
    winnerPseudo: winner.pseudo,
    weekKey,
    monthKey,
    before,
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
  stateDocPath = DEFAULT_STATE_DOC_PATH,
  headerText = "Meilleurs Loulou de la semaine passee",
}) {
  if (!db || !client) {
    throw new Error("createWeeklyFollowersRecap: missing db/client dependency");
  }

  const safeLimit = Math.max(1, Math.floor(toNum(limit) || 10));
  const safeBonusPct = Math.max(0, Math.floor(toNum(questBonusPct)));
  const safeExcluded = (Array.isArray(excludedLogins) ? excludedLogins : [])
    .map(normalizeLogin)
    .filter(Boolean);

  return async function sendWeeklyFollowersRecap({
    channelId = defaultChannelId,
  } = {}) {
    if (!channelId) {
      throw new Error("weekly recap target channel is missing");
    }

    const result = await computeWeeklyRanking(db, {
      timeZone,
      limit: safeLimit,
      excludedLogins: safeExcluded,
    });

    const bonus = await applyWinnerQuestBonus(db, {
      winner: result.winner,
      range: result.range,
      timeZone,
      bonusPct: safeBonusPct,
      stateDocPath,
    });

    const content = formatRecapMessage({
      ranking: result.ranking,
      headerText,
    });

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`weekly recap target channel is invalid: ${channelId}`);
    }

    await channel.send({
      content,
      allowedMentions: { parse: [] },
    });

    return { ...result, bonus };
  };
}

module.exports = { createWeeklyFollowersRecap };
