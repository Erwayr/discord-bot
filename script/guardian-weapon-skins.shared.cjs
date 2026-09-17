"use strict";

// Canonical, credential-free catalog; copied to the bot by guardian:sync.
const BASE_WEAPON_SKIN = "classic";
const WEAPON_SKINS = Object.freeze([
  ["sword-embers", "sword", "Lame des Braises", 0, "#ff853c", "Métal volcanique, fissures lumineuses et traînée de feu."],
  ["bow-thorns", "bow", "Ronce Éternelle", 10, "#8ce9a1", "Bois sculpté, feuillage précieux et flèche de nature."],
  ["hammer-storm", "hammer", "Fracas de l’Orage", 20, "#79ceff", "Acier sombre, cristaux bleus et éclairs à l’impact."],
  ["staff-void", "staff", "Sceptre du Néant", 30, "#be93ff", "Cristal violet, runes anciennes et magie du néant."],
].map(([id, weapon, title, minLevel, color, description]) => Object.freeze({
  id, weapon, title, minLevel, color, description, rarity: "epic", basePrice: 2500,
  model: `assets/guardian/weapon-skins/${id}.glb`,
  thumbnail: `assets/guardian/weapon-skins/${id}.webp`,
})));
function getWeaponSkin(id) { return WEAPON_SKINS.find(skin => skin.id === id) || null; }
function weaponSkinWallet(profile = {}) {
  const source = profile?.pops || profile || {};
  const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  return { balance: integer(source.balance), lifetimeEarned: integer(source.lifetimeEarned), schemaVersion: 1 };
}
function weaponSkinPrice(profile = {}) {
  const balance = weaponSkinWallet(profile).balance;
  return 2500 + (balance > 10000 ? Math.ceil(balance * .05) : 0);
}
function ownsWeaponSkin(profile, id) {
  return id === BASE_WEAPON_SKIN || Boolean(getWeaponSkin(id) && profile?.popsShop?.weaponSkins?.owned?.[id]?.id === id);
}
module.exports = { BASE_WEAPON_SKIN, WEAPON_SKINS, getWeaponSkin, weaponSkinWallet, weaponSkinPrice, ownsWeaponSkin };
