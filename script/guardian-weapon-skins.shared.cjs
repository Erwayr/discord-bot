"use strict";

// Canonical, credential-free catalog; copied to the bot by guardian:sync.
const { BASE_WEAPON_SKIN, ownsWeaponSkin, getWeaponSkinOption } = require("./guardian-weapon-skin-options.shared.cjs");
const WEAPONS = ["sword", "bow", "hammer", "staff"];
// Fifteen additional designs per weapon. The original elemental IDs stay valid.
const THEMES = [
  ["frost", "#a8ebff", "Cristaux de givre, arêtes de glace et gravures argentées.", ["Lame du Givre", "Arc des Glaciers", "Maillet du Permafrost", "Sceptre de l’Hiver"]],
  ["solar", "#ffd36b", "Or solaire, rayons sculptés et cœur incandescent.", ["Aube Radieuse", "Arc du Zénith", "Marteau du Soleil", "Bâton de l’Aurore"]],
  ["lunar", "#cbd5ff", "Croissants d’argent, métal nocturne et pierres de lune.", ["Croissant de Minuit", "Arc de Sélène", "Éclipse d’Argent", "Sceptre Lunaire"]],
  ["dragon", "#ff6753", "Écailles de dragon, crocs forgés et rubis ardents.", ["Croc du Dragon", "Arc de la Vouivre", "Griffe du Wyrm", "Sceptre Draconique"]],
  ["abyss", "#bd82ff", "Obsidienne fendue, griffes sombres et noyau abyssal.", ["Déchirure Abyssale", "Arc des Profondeurs", "Briseur du Néant", "Œil de l’Abîme"]],
  ["verdant", "#95ee84", "Feuilles ciselées, bois vivant et gemmes de sève.", ["Feuille d’Émeraude", "Arc du Sylve", "Racine Ancestrale", "Bâton du Bosquet"]],
  ["thunder", "#85caff", "Pointes conductrices, éclats d’acier et lignes de foudre.", ["Éclair Fulgurant", "Arc du Tonnerre", "Tempête Azurée", "Sceptre de la Foudre"]],
  ["coral", "#6ce4db", "Corail sculpté, cuivre marin et perles des marées.", ["Lame des Marées", "Arc du Récif", "Brise-Lames", "Sceptre des Océans"]],
  ["clockwork", "#ffc57b", "Rouages de laiton, rivets et mécanismes gravés.", ["Lame Mécanique", "Arc de l’Horloger", "Maillet à Engrenages", "Bâton du Chronomancien"]],
  ["desert", "#f0b86b", "Laiton des dunes, courbes de sable et éclats d’ambre.", ["Cimeterre des Dunes", "Arc du Sirocco", "Marteau du Désert", "Sceptre de l’Oasis"]],
  ["bone", "#e9dfb4", "Os sculpté, ligatures sombres et reliques d’ivoire.", ["Lame d’Ivoire", "Arc Ossuaire", "Maillet du Fossile", "Bâton des Ancêtres"]],
  ["blood", "#ff7595", "Pointes écarlates, acier noir et cristaux carmin.", ["Serment Écarlate", "Arc du Crépuscule", "Briseur Carmin", "Sceptre du Rubis"]],
  ["astral", "#ac9aff", "Cristaux étoilés, anneaux orbitaux et facettes célestes.", ["Éclat Astral", "Arc des Constellations", "Météore Céleste", "Sceptre des Étoiles"]],
  ["runic", "#78efd2", "Métal gravé, plaques runiques et glyphes de jade.", ["Lame Runique", "Arc des Glyphes", "Marteau des Runes", "Bâton des Arcanes"]],
  ["royal", "#ffe095", "Or royal, fleurons sculptés et joyaux de la couronne.", ["Lame du Souverain", "Arc de la Couronne", "Maillet Impérial", "Sceptre du Royaume"]],
];
const WEAPON_SKINS = Object.freeze([
  ["sword-embers", "sword", "Lame des Braises", "#ff853c", "Métal volcanique, fissures lumineuses et traînée de feu."],
  ["bow-thorns", "bow", "Ronce Éternelle", "#8ce9a1", "Bois sculpté, feuillage précieux et flèche de nature."],
  ["hammer-storm", "hammer", "Fracas de l’Orage", "#79ceff", "Acier sombre, cristaux bleus et éclairs à l’impact."],
  ["staff-void", "staff", "Sceptre du Néant", "#be93ff", "Cristal violet, runes anciennes et magie du néant."],
  ...THEMES.flatMap(([theme, color, description, titles], variant) => WEAPONS.map((weapon, index) =>
    [`${weapon}-${theme}`, weapon, titles[index], color, description, theme, variant])),
].map(([id, weapon, title, color, description, theme, variant]) => Object.freeze({
  id, weapon, title, minLevel: getWeaponSkinOption(id).minLevel, color, description, rarity: "epic", basePrice: 0,
  ...(theme ? { theme, variant } : {}),
  model: `assets/guardian/weapon-skins/${id}.glb`,
  thumbnail: `assets/guardian/weapon-skins/${id}.webp`,
})));
function getWeaponSkin(id) { return WEAPON_SKINS.find(skin => skin.id === id) || null; }
function weaponSkinWallet(profile = {}) {
  const source = profile?.pops || profile || {};
  const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  return { balance: integer(source.balance), lifetimeEarned: integer(source.lifetimeEarned), schemaVersion: 1 };
}
// Acquisition is now a free, permanent community-level unlock.
function weaponSkinPrice() { return 0; }
module.exports = { BASE_WEAPON_SKIN, WEAPON_SKINS, getWeaponSkin, weaponSkinWallet, weaponSkinPrice, ownsWeaponSkin };
