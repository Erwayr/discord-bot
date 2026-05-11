"use strict";

function shortText(value, max = 1200) {
  return String(value || "").trim().slice(0, max);
}

function normalizeLogin(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function asDiscordId(value) {
  const id = String(value || "").trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

module.exports = { shortText, normalizeLogin, asDiscordId };
