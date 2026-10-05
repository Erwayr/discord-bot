"use strict";

const { PODIUM_TIMEZONE, podiumDayKey } = require("./podium-periods.shared.cjs");
const MONTHLY_PODIUM_FIRST_MONTH = "2026-09";
const MONTHLY_PODIUM_SOURCE = "monthly_podium";
const MONTHLY_PODIUM_REWARDS = Object.freeze([
  { minRank: 1, maxRank: 1, pops: 1000, chestType: "legendary", chestLabel: "Coffre légendaire" },
  { minRank: 2, maxRank: 2, pops: 750, chestType: "epic", chestLabel: "Coffre épique" },
  { minRank: 3, maxRank: 3, pops: 500, chestType: "epic", chestLabel: "Coffre épique" },
  { minRank: 4, maxRank: 10, pops: 300, chestType: "runic", chestLabel: "Coffre runique" },
  { minRank: 11, maxRank: 20, pops: 200, chestType: "runic", chestLabel: "Coffre runique" },
  { minRank: 21, maxRank: 25, pops: 200, chestType: null, chestLabel: null },
  { minRank: 26, maxRank: 50, pops: 100, chestType: null, chestLabel: null },
].map(Object.freeze));

function monthlyPodiumRewardForRank(rank) {
  if (!Number.isInteger(rank)) return null;
  return MONTHLY_PODIUM_REWARDS.find(tier => rank >= tier.minRank && rank <= tier.maxRank) || null;
}

function nextPodiumMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("invalid_podium_month");
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

function monthlyPodiumRange(month) {
  const date = new Date(`${nextPodiumMonth(month)}-01T12:00:00Z`);
  date.setUTCDate(0);
  return { startKey: `${month}-01`, endKey: date.toISOString().slice(0, 10) };
}

function duePodiumMonths(now = new Date(), firstMonth = MONTHLY_PODIUM_FIRST_MONTH) {
  const day = podiumDayKey(now);
  const currentMonth = day.slice(0, 7);
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: PODIUM_TIMEZONE, hour: "2-digit", hourCycle: "h23",
  }).format(now));
  const months = [];
  for (let month = firstMonth; month < currentMonth; month = nextPodiumMonth(month)) {
    if (month < MONTHLY_PODIUM_FIRST_MONTH) continue;
    if (nextPodiumMonth(month) === currentMonth && day.endsWith("-01") && hour < 9) break;
    months.push(month);
  }
  return months;
}

module.exports = { MONTHLY_PODIUM_FIRST_MONTH, MONTHLY_PODIUM_SOURCE, MONTHLY_PODIUM_REWARDS,
  monthlyPodiumRewardForRank, monthlyPodiumRange, duePodiumMonths, nextPodiumMonth };
