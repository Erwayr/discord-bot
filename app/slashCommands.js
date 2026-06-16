"use strict";

const { SlashCommandBuilder } = require("discord.js");

const PROFILE_COMMAND_NAME = "profil";
const DAILY_CHEST_COMMAND_NAME = "coffre";

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

function dailyChestCommandData() {
  return new SlashCommandBuilder()
    .setName(DAILY_CHEST_COMMAND_NAME)
    .setDescription("Ouvre ton coffre quotidien.")
    .toJSON();
}

function slashCommandPayloads() {
  return [profileCommandData(), dailyChestCommandData()];
}

async function registerSlashCommands({ client, config }) {
  const guildId = config?.discord?.guildId;
  if (!guildId) {
    console.warn(
      "[slash] DISCORD_GUILD_ID manquant: commandes slash non enregistrees, !rank reste disponible.",
    );
    return null;
  }

  const guild = await client.guilds.fetch(guildId);
  const commands = await guild.commands.fetch();
  const registered = {};

  for (const payload of slashCommandPayloads()) {
    const existing = commands.find((cmd) => cmd.name === payload.name);

    if (existing) {
      await guild.commands.edit(existing.id, payload);
      console.log(`[slash] /${payload.name} mis a jour (${guild.name})`);
      registered[payload.name] = existing.id;
      continue;
    }

    const created = await guild.commands.create(payload);
    console.log(`[slash] /${payload.name} cree (${guild.name})`);
    registered[payload.name] = created.id;
  }

  return registered;
}

async function registerProfileSlashCommand(options) {
  const registered = await registerSlashCommands(options);
  return registered?.[PROFILE_COMMAND_NAME] || null;
}

module.exports = {
  PROFILE_COMMAND_NAME,
  DAILY_CHEST_COMMAND_NAME,
  dailyChestCommandData,
  registerSlashCommands,
  registerProfileSlashCommand,
};
