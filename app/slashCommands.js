"use strict";

const {
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const {
  COMMUNITY_POLL_COMMAND_NAME,
  registerCommunityPollEvents,
} = require("../script/communityPoll");

const PROFILE_COMMAND_NAME = "profil";
const DAILY_CHEST_COMMAND_NAME = "coffre";
const DAILY_CHEST_STATS_COMMAND_NAME = "coffrestats";
const DEPRECATED_SLASH_COMMANDS = ["skinsondage"];

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

function dailyChestStatsCommandData() {
  return new SlashCommandBuilder()
    .setName(DAILY_CHEST_STATS_COMMAND_NAME)
    .setDescription("Affiche les statistiques du coffre quotidien.")
    .addUserOption((option) =>
      option
        .setName("membre")
        .setDescription("Membre dont afficher les stats coffre.")
        .setRequired(false),
    )
    .toJSON();
}

function communityPollCommandData() {
  return new SlashCommandBuilder()
    .setName(COMMUNITY_POLL_COMMAND_NAME)
    .setDescription("Gère un sondage communautaire à propositions libres.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("creer")
        .setDescription("Crée un nouveau sondage communautaire.")
        .addStringOption((option) =>
          option
            .setName("titre")
            .setDescription("Question ou titre du sondage.")
            .setRequired(true)
            .setMaxLength(100),
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Contexte ou consigne facultative.")
            .setRequired(false)
            .setMaxLength(1000),
        )
        .addStringOption((option) =>
          option
            .setName("libelle")
            .setDescription(
              "Type de proposition : jeu, skin, défi, idée... (défaut : proposition).",
            )
            .setRequired(false)
            .setMaxLength(30),
        )
        .addIntegerOption((option) =>
          option
            .setName("max_propositions")
            .setDescription("Nombre maximum de propositions par membre.")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10),
        )
        .addIntegerOption((option) =>
          option
            .setName("max_votes")
            .setDescription("Nombre maximum de votes actifs par membre.")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(5),
        )
        .addChannelOption((option) =>
          option
            .setName("canal")
            .setDescription("Canal dans lequel publier le sondage.")
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("resultats")
        .setDescription("Affiche le classement actuel ou le dernier résultat."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("cloturer")
        .setDescription("Clôture le sondage actif et désactive les votes."),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON();
}

function slashCommandPayloads() {
  return [
    profileCommandData(),
    dailyChestCommandData(),
    dailyChestStatsCommandData(),
    communityPollCommandData(),
  ];
}

async function registerSlashCommands({ client, config }) {
  const guildId = config?.discord?.guildId;
  if (!guildId) {
    console.warn(
      "[slash] DISCORD_GUILD_ID manquant: commandes slash non enregistrees, !rank reste disponible.",
    );
    return null;
  }

  registerCommunityPollEvents({ client });

  const guild = await client.guilds.fetch(guildId);
  const commands = await guild.commands.fetch();
  const registered = {};

  for (const commandName of DEPRECATED_SLASH_COMMANDS) {
    const deprecated = commands.find((cmd) => cmd.name === commandName);
    if (!deprecated) continue;

    await guild.commands.delete(deprecated.id);
    console.log(`[slash] /${commandName} supprime (${guild.name})`);
    commands.delete(deprecated.id);
  }

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
  DAILY_CHEST_STATS_COMMAND_NAME,
  COMMUNITY_POLL_COMMAND_NAME,
  dailyChestCommandData,
  dailyChestStatsCommandData,
  communityPollCommandData,
  slashCommandPayloads,
  registerSlashCommands,
  registerProfileSlashCommand,
};
