"use strict";
const { BASE_WEAPON_SKIN, getWeaponSkin } = require("./guardian-weapon-skins.shared.cjs");
const { BASE_COSTUME, COSTUMES, ownsCostume } = require("./guardian-costumes.shared.cjs");

// Canonical catalog: shared with the browser and copied byte-for-byte to the bot.
const SCHEMA_VERSION = 1;
const choices = (rows) => Object.freeze(rows.map(([id, label, color]) => Object.freeze({ id, label, ...(color ? { color } : {}) })));
const PALETTE = choices([
  ["ocean", "Océan", "#237eac"], ["forest", "Forêt", "#38794b"],
  ["wine", "Bordeaux", "#843f58"], ["violet", "Violet", "#74519e"],
  ["ember", "Braise", "#c1683b"], ["gold", "Or", "#c4a15a"],
  ["ivory", "Ivoire", "#eee0c6"], ["slate", "Ardoise", "#485364"],
  ["night", "Nuit", "#242736"], ["teal", "Jade", "#339b92"],
  ["rose", "Rose", "#c97c91"], ["leather", "Cuir", "#765039"],
]);
const OPTIONS = Object.freeze({
  body: choices([["masculine", "Masculine"], ["feminine", "Féminine"]]),
  face: choices([["oval", "Ovale"], ["round", "Rond"], ["angular", "Anguleux"]]),
  eyes: choices([["almond", "Amande"], ["round", "Ronds"], ["narrow", "Fins"]]),
  nose: choices([["fine", "Fin"], ["round", "Arrondi"], ["broad", "Large"]]),
  hair: choices([
    ["shaved", "Rasée"], ["cropped", "Courte"], ["bob", "Mi-longue"], ["tied", "Attachée"],
    ["fade", "Dégradé"], ["spiky", "Hérissée"], ["afro", "Afro"], ["curly", "Bouclée"],
    ["long", "Longue"], ["ponytail", "Queue-de-cheval"], ["braid", "Tresse"], ["bun", "Chignon"],
  ]),
  skin: choices([["porcelain", "Porcelaine", "#f2d2bc"], ["sand", "Sable", "#dcb18b"], ["honey", "Miel", "#c89466"], ["bronze", "Bronze", "#ad7753"], ["brown", "Brun", "#805337"], ["ebony", "Ébène", "#4f342a"]]),
  hairColor: choices([["black", "Noir", "#241f27"], ["brown", "Châtain", "#533426"], ["chestnut", "Châtaigne", "#835036"], ["blond", "Blond", "#d6b66c"], ["copper", "Cuivré", "#ae5633"], ["silver", "Argent", "#c3c9d2"], ["violet", "Prune", "#735495"], ["blue", "Bleu", "#397d9c"]]),
  eyeColor: choices([["brown", "Marron", "#5a3923"], ["hazel", "Noisette", "#998243"], ["green", "Vert", "#327b5a"], ["blue", "Bleu", "#4288b7"], ["grey", "Gris", "#8791a0"], ["violet", "Violet", "#8c60a8"]]),
  tunic: PALETTE, trousers: PALETTE, boots: PALETTE, bracers: PALETTE, details: PALETTE,
  costume: choices([[BASE_COSTUME, "Tenue classique"], ...COSTUMES.map(costume => [costume.id, costume.title])]),
  weapon: Object.freeze([
    { id: "sword", label: "Épée", minLevel: 0 }, { id: "bow", label: "Arc", minLevel: 10 },
    { id: "hammer", label: "Marteau", minLevel: 20 }, { id: "staff", label: "Bâton", minLevel: 30 },
  ].map(Object.freeze)),
  aura: Object.freeze([
    { id: "none", label: "Aucune", minLevel: 0 },
    { id: "white", label: "Blanche", minLevel: 100 },
    { id: "gold", label: "Dorée", minLevel: 200 },
  ].map(Object.freeze)),
});
const DEFAULT_CHARACTER = Object.freeze({ schemaVersion: SCHEMA_VERSION, body: "masculine", face: "oval", eyes: "almond", nose: "fine", hair: "cropped", skin: "sand", hairColor: "brown", eyeColor: "green", tunic: "ocean", trousers: "slate", boots: "leather", bracers: "leather", details: "gold", weapon: "sword", weaponSkin: BASE_WEAPON_SKIN, aura: "none", costume: BASE_COSTUME });

function characterError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function characterLevel(profile = {}) {
  for (const value of [profile.communityLevel?.level, profile.wizebotLevel, profile.level]) {
    if (value != null && Number.isFinite(Number(value))) return Math.max(0, Math.floor(Number(value)));
  }
  return 0;
}
function normalizeCharacter(input, { level = 0, strict = false } = {}) {
  const validObject = input && typeof input === "object" && !Array.isArray(input);
  if (strict && !validObject) throw characterError("guardian_character_invalid");
  const source = validObject ? input : {};
  if (strict && source.schemaVersion != null && source.schemaVersion !== SCHEMA_VERSION) throw characterError("guardian_character_version_invalid");
  if (strict && Object.keys(source).some((key) => !["schemaVersion", "weaponSkin"].includes(key) && !Object.hasOwn(OPTIONS, key))) throw characterError("guardian_character_option_invalid");
  const character = { ...DEFAULT_CHARACTER };
  for (const [key, options] of Object.entries(OPTIONS)) {
    const value = source[key];
    const option = options.find((entry) => entry.id === value);
    if (strict && value != null && !option) throw characterError("guardian_character_option_invalid");
    if (option) character[key] = option.id;
  }
  const weapon = OPTIONS.weapon.find((entry) => entry.id === character.weapon);
  if (Math.max(0, Number(level) || 0) < weapon.minLevel) {
    if (strict) throw characterError("guardian_character_weapon_locked", 403);
    character.weapon = DEFAULT_CHARACTER.weapon;
  }
  const aura = OPTIONS.aura.find((entry) => entry.id === character.aura);
  if (Math.max(0, Number(level) || 0) < aura.minLevel) {
    if (strict) throw characterError("guardian_character_aura_locked", 403);
    character.aura = DEFAULT_CHARACTER.aura;
  }
  const skin = getWeaponSkin(source.weaponSkin);
  if (strict && source.weaponSkin != null && source.weaponSkin !== BASE_WEAPON_SKIN && !skin) throw characterError("guardian_weapon_skin_invalid");
  if (skin && skin.weapon === character.weapon) character.weaponSkin = skin.id;
  else if (strict && skin) throw characterError("guardian_weapon_skin_incompatible");
  return character;
}
function characterForProfile(profile = {}) {
  const character = normalizeCharacter(profile.currentGuardian?.character, { level: characterLevel(profile) });
  if (!ownsCostume(profile, character.costume)) character.costume = BASE_COSTUME;
  return character;
}
module.exports = { SCHEMA_VERSION, OPTIONS, PALETTE, DEFAULT_CHARACTER, normalizeCharacter, characterForProfile, characterLevel };
