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

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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

function escapeMdInline(value = "") {
  return String(value).replace(/[\\`*_~|>]/g, "\\$&");
}

function formatRecapMessage({
  ranking,
  totalActiveFollowers,
  range,
  timeZone,
  limit,
}) {
  const lines = [];
  lines.push("📊 **Recap hebdo - Top followers**");
  lines.push(
    `Periode: **${range.startLabel}** -> **${range.endLabel}** (${timeZone})`
  );

  if (!ranking.length) {
    lines.push("");
    lines.push("Aucune activite follower detectee sur cette periode.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Top ${Math.min(limit, ranking.length)}:`);

  ranking.forEach((row, i) => {
    lines.push(
      `${i + 1}. **${escapeMdInline(row.pseudo)}** - **${row.score} pts** ` +
        `(presence:${row.presence} emotes:${row.emote} points:${row.channelPoints} clips:${row.clips} raids:${row.raids})`
    );
  });

  lines.push("");
  lines.push(`Followers classes: **${totalActiveFollowers}**`);
  return lines.join("\n");
}

async function computeWeeklyRanking(db, { timeZone, limit }) {
  const range = getPreviousWeekRange(timeZone);
  const snap = await db.collection("followers_all_time").get();
  const allRows = [];

  snap.forEach((doc) => {
    const data = doc.data() || {};
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

    allRows.push({ pseudo, ...totals });
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
  };
}

function createWeeklyFollowersRecap({
  db,
  client,
  defaultChannelId,
  timeZone = "Europe/Warsaw",
  limit = 10,
}) {
  if (!db || !client) {
    throw new Error("createWeeklyFollowersRecap: missing db/client dependency");
  }

  return async function sendWeeklyFollowersRecap({
    channelId = defaultChannelId,
  } = {}) {
    if (!channelId) {
      throw new Error("weekly recap target channel is missing");
    }

    const result = await computeWeeklyRanking(db, { timeZone, limit });
    const content = formatRecapMessage({
      ranking: result.ranking,
      totalActiveFollowers: result.totalActiveFollowers,
      range: result.range,
      timeZone,
      limit,
    });

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`weekly recap target channel is invalid: ${channelId}`);
    }

    await channel.send({
      content,
      allowedMentions: { parse: [] },
    });

    return result;
  };
}

module.exports = { createWeeklyFollowersRecap };

