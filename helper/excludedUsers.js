"use strict";

const EXCLUDED_USER_VALUES = new Set(["wzbot"]);

const DIRECT_USER_FIELDS = Object.freeze([
  "pseudo",
  "display_name",
  "displayName",
  "login",
  "user_login",
  "user_name",
  "user_display_name",
  "display",
  "creator_login",
  "creator_name",
  "__docId",
  "id",
]);

const NESTED_USER_FIELDS = Object.freeze(["winnerInfo"]);

function normalizeExcludedUserValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function collectUserCandidates(source, out = new Set()) {
  if (!source || typeof source !== "object") return out;

  DIRECT_USER_FIELDS.forEach((field) => {
    const normalized = normalizeExcludedUserValue(source[field]);
    if (normalized) out.add(normalized);
  });

  NESTED_USER_FIELDS.forEach((field) => {
    const nested = source[field];
    if (nested && typeof nested === "object") {
      collectUserCandidates(nested, out);
    }
  });

  return out;
}

function isExcludedLogin(value) {
  return EXCLUDED_USER_VALUES.has(normalizeExcludedUserValue(value));
}

function isExcludedDisplayName(value) {
  return isExcludedLogin(value);
}

function isExcludedUserLike(source) {
  if (!source) return false;
  if (typeof source === "string") return isExcludedLogin(source);

  const candidates = collectUserCandidates(source);
  for (const candidate of candidates) {
    if (EXCLUDED_USER_VALUES.has(candidate)) return true;
  }
  return false;
}

function filterExcludedUsers(items) {
  return Array.isArray(items)
    ? items.filter((item) => !isExcludedUserLike(item))
    : [];
}

module.exports = {
  EXCLUDED_USER_NAMES: Object.freeze(Array.from(EXCLUDED_USER_VALUES)),
  normalizeExcludedUserValue,
  isExcludedLogin,
  isExcludedDisplayName,
  isExcludedUserLike,
  filterExcludedUsers,
};
