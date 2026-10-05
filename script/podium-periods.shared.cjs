"use strict";

const PODIUM_TIMEZONE = "Europe/Brussels";
const PODIUM_SCHEMA_VERSION = 4;
const PODIUM_COMPARISON_SCHEMA_VERSION = 2;
const PODIUM_ENTRIES_LIMIT = 100;
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: PODIUM_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function podiumDayKey(date) {
  const parts = Object.fromEntries(
    dayFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getPodiumPeriods(now = new Date()) {
  const endKey = podiumDayKey(now);
  // Work on calendar dates, not 24-hour offsets across a daylight-saving change.
  const monday = new Date(`${endKey}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return {
    week: { startKey: monday.toISOString().slice(0, 10), endKey },
    month: { startKey: `${endKey.slice(0, 7)}-01`, endKey },
  };
}

function shiftCalendarDay(key, days) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getPodiumComparisonPeriods(now = new Date()) {
  const current = getPodiumPeriods(now);
  const previousMonthEnd = shiftCalendarDay(current.month.startKey, -1);
  return {
    week: {
      startKey: shiftCalendarDay(current.week.startKey, -7),
      endKey: shiftCalendarDay(current.week.startKey, -1),
    },
    month: {
      startKey: `${previousMonthEnd.slice(0, 7)}-01`,
      endKey: previousMonthEnd,
    },
  };
}

function currentPodiumPeriods(podium, now = new Date()) {
  if (!podium || podium.timezone !== PODIUM_TIMEZONE) return null;
  const periods = getPodiumPeriods(now);
  const result = { timezone: PODIUM_TIMEZONE };
  if (Number.isInteger(podium.schemaVersion)) result.schemaVersion = podium.schemaVersion;
  for (const name of ["week", "month"]) {
    const value = podium[name];
    result[name] = value &&
      value.startKey === periods[name].startKey &&
      typeof value.endKey === "string" &&
      value.endKey >= value.startKey &&
      value.endKey <= periods[name].endKey &&
      Array.isArray(value.entries)
      ? value
      : null;
  }
  return result;
}

function hasCurrentPodiumPeriods(podium, now = new Date()) {
  const current = currentPodiumPeriods(podium, now);
  return Boolean(current?.week && current?.month);
}

function hasCurrentPodiumComparisons(podium, now = new Date()) {
  if (!Number.isInteger(podium?.schemaVersion) ||
    podium.schemaVersion < PODIUM_COMPARISON_SCHEMA_VERSION ||
    podium.schemaVersion > PODIUM_SCHEMA_VERSION ||
    !hasCurrentPodiumPeriods(podium, now)) return false;
  const expected = getPodiumComparisonPeriods(now);
  return ["week", "month"].every((name) => {
    const period = podium[name];
    return period.comparison?.startKey === expected[name].startKey &&
      period.comparison?.endKey === expected[name].endKey &&
      period.entries.every((entry) => entry && (entry.previousRank === null ||
        (Number.isInteger(entry.previousRank) && entry.previousRank > 0)));
  });
}

module.exports = {
  PODIUM_TIMEZONE,
  PODIUM_SCHEMA_VERSION,
  PODIUM_COMPARISON_SCHEMA_VERSION,
  PODIUM_ENTRIES_LIMIT,
  podiumDayKey,
  getPodiumPeriods,
  getPodiumComparisonPeriods,
  currentPodiumPeriods,
  hasCurrentPodiumPeriods,
  hasCurrentPodiumComparisons,
};
