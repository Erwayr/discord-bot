"use strict";

const { ActivityType, Events } = require("discord.js");
const welcomeHandler = require("../script/welcomeHandler");
const messageCountHandler = require("../script/messageCountHandler");
const presenceHandler = require("../script/presenceHandler");
const electionHandler = require("../script/electionHandler");
const handleVoteChange = require("../script/handleVoteChange");
const {
  handleProfileInteraction,
  handleProfileMessage,
} = require("../script/profileHandler");
const {
  handleDailyChestInteraction,
  handleDailyChestStatsInteraction,
  sendDailyChestTestMessage,
} = require("../script/dailyChest");
const {
  DAILY_CHEST_COMMAND_NAME,
  DAILY_CHEST_STATS_COMMAND_NAME,
  PROFILE_COMMAND_NAME,
  registerSlashCommands,
} = require("./slashCommands");
const {
  isPlanningApprover,
  parsePlanningButtonCustomId,
} = require("../script/weeklyPlanningPublisher");

function registerDiscordEvents({
  client,
  db,
  config,
  tokenManager,
  twitchEventSub,
  jobs,
  firestoreListeners,
  sendWeeklyFollowersRecap,
  weeklyPlanningPublisher,
  birthdays,
  getCommunityLevelConfig,
}) {
  client.once(Events.ClientReady, async () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);
    try {
      await tokenManager.getAccessToken();
    } catch (e) {
      console.warn("⚠️ Pré-chauffe token a échoué :", e.message || e);
    }

    await twitchEventSub.subscribeAll();
    await registerSlashCommands({ client, config }).catch((e) =>
      console.error("[slash] registration failed:", e?.message || e),
    );

    for (const guild of client.guilds.cache.values()) {
      try {
        await guild.members.fetch({ withPresences: false, time: 300_000 });
        console.log(`🔄 Membres chargés pour la guilde : ${guild.name}`);
      } catch (e) {
        console.warn(
          `⚠️ guild.members.fetch timeout pour ${guild.name}:`,
          e?.code || e?.message || e,
        );
      }
    }

    await jobs.runClientReadyJobs();
    firestoreListeners.registerFirestoreListeners();
  });

  client.on("raw", async (packet) => {
    if (packet.t !== "MESSAGE_CREATE") return;
    const data = packet.d;
    if (!data.guild_id) {
      if (data.author.id === client.user.id) return;
      try {
        const user = await client.users.fetch(data.author.id);
        const content = data.content;
        console.log(`[DM RAW] ${user.tag} : ${content}`);
        const logChannel = await client.channels.fetch(
          config.discord.logChannelId,
        );
        if (logChannel && logChannel.isTextBased()) {
          const now = Math.floor(Date.now() / 1000);
          await logChannel.send(
            `📩 **DM de ${user.tag}** à <t:${now}:F> :\n> ${content}`,
          );
        }
      } catch (err) {
        console.error("❌ Erreur lors de l'envoi dans le salon :", err);
      }
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    await welcomeHandler(member, db, {
      enableDM: true,
      welcomeChannelId: config.discord.generalChannelId,
      autoRoleName: "Nouveau",
    });
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    await jobs
      .assignServerBoosterCardForMember(newMember, {
        previousMember: oldMember,
      })
      .catch((err) => {
        console.error(
          "[discord] assignServerBoosterCardForMember failed:",
          err,
        );
      });
  });

  client.on(Events.MessageReactionAdd, (r, u) =>
    handleVoteChange(r, u, true, db),
  );
  client.on(Events.MessageReactionRemove, (r, u) =>
    handleVoteChange(r, u, false, db),
  );

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton?.()) {
      const planningAction = parsePlanningButtonCustomId(interaction.customId);
      if (!planningAction) return;

      if (
        !isPlanningApprover(interaction.member, interaction.user?.id, config)
      ) {
        await interaction.reply({
          content: "❌ Tu n'as pas la permission pour valider le planning.",
          ephemeral: true,
        });
        return;
      }

      if (!weeklyPlanningPublisher) {
        await interaction.reply({
          content: "❌ Le module planning n'est pas disponible.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      try {
        if (planningAction.action === "approve") {
          await weeklyPlanningPublisher.approvePlanning({
            weekKey: planningAction.weekKey,
            planningHash: planningAction.planningHash,
            approvedBy: interaction.user?.id,
          });
          await interaction.message?.edit({ components: [] }).catch(() => {});
          await interaction.editReply(
            "✅ Planning validé et publié dans le canal annonces.",
          );
          return;
        }

        await weeklyPlanningPublisher.rejectPlanning({
          weekKey: planningAction.weekKey,
          planningHash: planningAction.planningHash,
          rejectedBy: interaction.user?.id,
        });
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply("✅ Brouillon planning refusé.");
      } catch (e) {
        console.error("[weekly-planning] button failed:", e?.message || e);
        await interaction.editReply(
          `❌ ${e?.message || "Impossible de traiter le planning."}`,
        );
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === PROFILE_COMMAND_NAME) {
      await handleProfileInteraction(interaction, db, config);
      return;
    }

    if (interaction.commandName === DAILY_CHEST_COMMAND_NAME) {
      await handleDailyChestInteraction(interaction, db, config, {
        getCommunityLevelConfig,
      });
      return;
    }

    if (interaction.commandName === DAILY_CHEST_STATS_COMMAND_NAME) {
      await handleDailyChestStatsInteraction(interaction, db, config);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || message.author.bot) return;

    await messageCountHandler(message, db).catch((err) => {
      console.error("[discord] messageCountHandler failed:", err);
    });

    await electionHandler(message, db, config.discord.generalChannelId).catch(
      (err) => {
        console.error("[discord] electionHandler failed:", err);
      },
    );

    const content = message.content.trim();
    const command = content.split(/\s+/)[0]?.toLowerCase() || "";

    if (command === "!weeklyrecap") {
      const canRun = message.member?.permissions?.has("ManageGuild");
      if (!canRun) {
        await message.reply(
          "❌ Tu n'as pas la permission pour lancer le recap hebdo.",
        );
        return;
      }

      try {
        await sendWeeklyFollowersRecap({
          channelId: config.discord.logChannelId,
          applyRewards: false,
          rangeMode: "current",
        });
        await message.react("\u2705").catch(() => {});
      } catch (e) {
        console.error("[weekly-recap] manual run failed:", e?.message || e);
        await message.reply("❌ Impossible de générer le recap hebdo.");
      }
      return;
    }

    if (command === "!planningtest" || command === "!planningpreview") {
      const canRun = isPlanningApprover(message.member, message.author.id, config);
      if (!canRun) {
        await message.reply(
          "❌ Tu n'as pas la permission pour tester le planning.",
        );
        return;
      }
      if (!weeklyPlanningPublisher) {
        await message.reply("❌ Le module planning n'est pas disponible.");
        return;
      }

      try {
        if (command === "!planningtest") {
          await weeklyPlanningPublisher.sendPlanningTest({
            channelId: config.discord.logChannelId,
          });
          await message.react("\u2705").catch(() => {});
          return;
        }

        const result = await weeklyPlanningPublisher.createPlanningPreview({
          channelId: config.planning.reviewChannelId,
          requestedBy: message.author.id,
          source: "manual",
        });
        if (result?.skipped) {
          await message.reply(
            "ℹ️ Un brouillon identique existe déjà pour cette semaine.",
          );
        } else {
          await message.react("\u2705").catch(() => {});
        }
      } catch (e) {
        console.error("[weekly-planning] command failed:", e?.message || e);
        await message.reply(
          `❌ Impossible de générer le planning: ${
            e?.message || "erreur inconnue"
          }`,
        );
      }
      return;
    }

    if (command === "!annivtest" || command === "!birthdaytest") {
      if (message.channelId !== config.discord.logChannelId) {
        await message.reply(
          "❌ Cette commande de test est disponible uniquement dans le salon logs.",
        );
        return;
      }

      const canRun = message.member?.permissions?.has("ManageGuild");
      if (!canRun) {
        await message.reply(
          "❌ Tu n'as pas la permission pour tester les anniversaires.",
        );
        return;
      }

      if (!birthdays?.sendDiscordBirthdayTest) {
        await message.reply(
          "❌ Le module anniversaire Discord n'est pas disponible.",
        );
        return;
      }

      const mentionedMembers = message.mentions?.members
        ? Array.from(message.mentions.members.values())
        : [];
      const members = mentionedMembers.length
        ? mentionedMembers
        : [message.member].filter(Boolean);

      try {
        await birthdays.sendDiscordBirthdayTest({
          client,
          channelId: config.discord.logChannelId,
          members,
        });
        await message.react("\u2705").catch(() => {});
      } catch (e) {
        console.error("[birthday-discord] test command failed:", e?.message || e);
        await message.reply(
          `❌ Impossible de générer le test anniversaire: ${
            e?.message || "erreur inconnue"
          }`,
        );
      }
      return;
    }

    if (command === "!coffretest" || command === "!chesttest") {
      if (message.channelId !== config.discord.logChannelId) {
        await message.reply(
          "âŒ Cette commande de test est disponible uniquement dans le salon logs.",
        );
        return;
      }

      const canRun = message.member?.permissions?.has("ManageGuild");
      if (!canRun) {
        await message.reply(
          "âŒ Tu n'as pas la permission pour tester le coffre.",
        );
        return;
      }

      try {
        await sendDailyChestTestMessage(message, {
          config,
          forceReward: content.slice(command.length).trim(),
        });
        await message.react("\u2705").catch(() => {});
      } catch (e) {
        console.error("[daily-chest] test command failed:", e?.message || e);
        await message.reply(
          `âŒ Impossible de generer le test coffre: ${
            e?.message || "erreur inconnue"
          }`,
        );
      }
      return;
    }

    if (command === "!rank") {
      await handleProfileMessage(message, db, config);
    }
  });

  client.on(Events.PresenceUpdate, async (oldP, newP) => {
    await presenceHandler(oldP, newP, db);

    const playing = newP.activities.find(
      (act) => act.type === ActivityType.Playing,
    );
    if (!playing) return;
  });
}

function loginDiscordClient({ client, token }) {
  return client.login(token);
}

module.exports = { registerDiscordEvents, loginDiscordClient };
