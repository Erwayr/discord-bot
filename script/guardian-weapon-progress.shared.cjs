"use strict";

// Credential-free contract shared by the shop, public projections and bot.
const { WEAPON_SKIN_OPTIONS, getWeaponSkinOption, ownsWeaponSkin } = require("./guardian-weapon-skin-options.shared.cjs");
const { normalizeWeaponForm } = require("./guardian-character.shared.cjs");
const WEAPONS = Object.freeze(["sword", "bow", "hammer", "staff"]);
const FORM_COSTS = Object.freeze([2500, 5000, 10000]);
const WEAPON_KEYS = Object.freeze([...WEAPONS.map(weapon => `classic-${weapon}`), ...WEAPON_SKIN_OPTIONS.map(skin => skin.id)]);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function getWeaponProgressDefinition(key) {
  const skin = getWeaponSkinOption(key);
  if (skin) return { ...skin, key: skin.id, skinId: skin.id, classic: false };
  const weapon = WEAPONS.find(value => key === `classic-${value}`);
  return weapon ? { key, weapon, skinId: "classic", minLevel: 0, classic: true } : null;
}
function weaponProgressKey(weapon = "sword", skinId = "classic") {
  if (!WEAPONS.includes(weapon)) weapon = "sword";
  const skin = getWeaponSkinOption(skinId);
  return skin?.weapon === weapon ? skin.id : `classic-${weapon}`;
}
function ownsWeaponProgress(profile, key) {
  const definition = getWeaponProgressDefinition(key);
  return Boolean(definition && (definition.classic || ownsWeaponSkin(profile, definition.skinId)));
}
function emptyWeaponProgress() {
  return { schemaVersion: 1, form: 1, invested: 0, target: null, totalInvested: 0, revision: 0 };
}
function validWeaponProgress(value) {
  return Boolean(value && value.schemaVersion === 1 && [1, 2, 3, 4].includes(value.form)
    && [value.invested, value.totalInvested, value.revision].every(number => Number.isSafeInteger(number) && number >= 0)
    && value.totalInvested >= value.invested
    && (value.form === 4 ? value.invested === 0 && value.target === null
      : value.target === null ? value.invested === 0
        : Number.isSafeInteger(value.target) && value.target >= FORM_COSTS[value.form - 1] && value.invested < value.target));
}
function weaponProgress(profile = {}, key) {
  const value = profile?.popsShop?.weaponSkins?.progress?.[key];
  if (!ownsWeaponProgress(profile, key) || !validWeaponProgress(value)) return emptyWeaponProgress();
  return { ...value };
}
function weaponProgressTarget(form, balance) {
  const base = FORM_COSTS[normalizeWeaponForm(form) - 1] || 0;
  const safeBalance = integer(Number(balance));
  return base ? base + (safeBalance > 10000 ? Math.ceil(safeBalance * .05) : 0) : 0;
}
function weaponProgressView(profile = {}, key) {
  const progress = weaponProgress(profile, key);
  const goal = progress.form === 4 ? 0 : progress.target ?? weaponProgressTarget(progress.form, profile?.pops?.balance);
  return { ...progress, owned: ownsWeaponProgress(profile, key), goal, targetLocked: progress.target !== null,
    remaining: Math.max(0, goal - progress.invested), percent: goal ? progress.invested / goal * 100 : 100 };
}
function weaponFormForProfile(profile = {}, character = profile.currentGuardian?.character || {}) {
  return weaponProgress(profile, weaponProgressKey(character.weapon, character.weaponSkin)).form;
}
// Participants only contain the server-written display projection, never Pops.
function publicWeaponForm(profile = {}) {
  return profile?.popsShop?.weaponSkins?.progress
    ? weaponFormForProfile(profile) : normalizeWeaponForm(profile.currentGuardian?.weaponForm);
}
function mergeWeaponProgressMaps(oldMap = {}, newMap = {}) {
  const result = {};
  for (const key of new Set([...Object.keys(oldMap), ...Object.keys(newMap)])) {
    const old = oldMap[key], fresh = newMap[key];
    // A target and its invested amount are one snapshot. Never overlay fields
    // from two profiles or let an empty destination regress an acquired form.
    let chosen = validWeaponProgress(fresh) ? fresh : old;
    if (validWeaponProgress(old) && validWeaponProgress(fresh)) {
      for (const field of ["form", "totalInvested", "revision"]) {
        if (old[field] === fresh[field]) continue;
        chosen = old[field] > fresh[field] ? old : fresh; break;
      }
    }
    if (chosen != null) result[key] = { ...chosen };
  }
  return result;
}
module.exports = { FORM_COSTS, WEAPON_KEYS, normalizeWeaponForm, getWeaponProgressDefinition, weaponProgressKey,
  ownsWeaponProgress, emptyWeaponProgress, validWeaponProgress, weaponProgress, weaponProgressTarget,
  weaponProgressView, weaponFormForProfile, publicWeaponForm, mergeWeaponProgressMaps };
