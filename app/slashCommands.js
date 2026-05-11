"use strict";

const { SlashCommandBuilder } = require("discord.js");

const PROFILE_COMMAND_NAME = "profil";

function profileCommandData() {
  return new SlashCommandBuilder()
    .setName(PROFILE_COMMAND_NAME)
    .setDescription("Affiche le profil communautaire Twitch/Discord.")
    .addUserOption((option) =>
      option
        .setName("membre")
        .setDescription("Membre dont afficher le profil.")
        .setRequired(false),
    )
    .toJSON();
}

async function registerProfileSlashCommand({ client, config }) {
  const guildId = config?.discord?.guildId;
  if (!guildId) {
    console.warn(
      "[slash] DISCORD_GUILD_ID manquant: /profil non enregistré, !rank reste disponible.",
    );
    return null;
  }

  const guild = await client.guilds.fetch(guildId);
  const commands = await guild.commands.fetch();
  const existing = commands.find((cmd) => cmd.name === PROFILE_COMMAND_NAME);
  const payload = profileCommandData();

  if (existing) {
    await guild.commands.edit(existing.id, payload);
    console.log(`[slash] /${PROFILE_COMMAND_NAME} mis à jour (${guild.name})`);
    return existing.id;
  }

  const created = await guild.commands.create(payload);
  console.log(`[slash] /${PROFILE_COMMAND_NAME} créé (${guild.name})`);
  return created.id;
}

module.exports = {
  PROFILE_COMMAND_NAME,
  registerProfileSlashCommand,
};
