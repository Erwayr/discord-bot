"use strict";

const { handleProfileMessage } = require("./profileHandler");

/**
 * Alias historique de !rank vers le profil enrichi.
 * @param {import('discord.js').Message} message
 * @param {import('firebase-admin').firestore.Firestore} db
 */
module.exports = async function rankHandler(message, db, config = {}) {
  return handleProfileMessage(message, db, config);
};
