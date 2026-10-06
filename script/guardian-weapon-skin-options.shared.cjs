"use strict";
// Lightweight validation contract for public avatars and profile normalization.
const BASE_WEAPON_SKIN = "classic";
const THEMES = Object.freeze(["frost","solar","lunar","dragon","abyss","verdant","thunder","coral","clockwork","desert","bone","blood","astral","runic","royal"]);
const WEAPONS = ["sword","bow","hammer","staff"];
const WEAPON_SKIN_OPTIONS = Object.freeze([
  ["sword-embers","sword",0], ["bow-thorns","bow",0], ["hammer-storm","hammer",0], ["staff-void","staff",0],
  ...THEMES.flatMap((theme,index)=>WEAPONS.map(weapon=>[`${weapon}-${theme}`,weapon,(index+1)*10])),
].map(([id,weapon,minLevel])=>Object.freeze({id,weapon,minLevel})));
const getWeaponSkinOption = id => WEAPON_SKIN_OPTIONS.find(skin=>skin.id===id)||null;
function ownsWeaponSkin(profile,id) {
  return id===BASE_WEAPON_SKIN || Boolean(getWeaponSkinOption(id) && profile?.popsShop?.weaponSkins?.owned?.[id]?.id===id);
}
module.exports = { BASE_WEAPON_SKIN, WEAPON_SKIN_OPTIONS, getWeaponSkinOption, ownsWeaponSkin };
