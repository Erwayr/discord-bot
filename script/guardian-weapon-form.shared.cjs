"use strict";

const normalizeWeaponForm = value => [1, 2, 3, 4].includes(Number(value)) ? Number(value) : 1;

module.exports = { normalizeWeaponForm };
