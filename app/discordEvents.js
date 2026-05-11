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
  PROFILE_COMMAND_NAME,
  registerProfileSlashCommand,
} = require("./slashCommands");

function registerDiscordEvents({
  client,
  db,
  config,
  tokenManager,
  twitchEventSub,
  jobs,
  firestoreListeners,
  sendWeeklyFollowersRecap,
}) {
  client.once(Events.ClientReady, async () => {
    console.log(`✅ Connecté en tant que ${client.user.tag}`);
    try {
      await tokenManager.getAccessToken();
    } catch (e) {
      console.warn("⚠️ Pré-chauffe token a échoué :", e.message || e);
    }

    await twitchEventSub.subscribeAll();
    await registerProfileSlashCommand({ client, config }).catch((e) =>
      console.error("[slash] /profil registration failed:", e?.message || e),
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

  client.on(Events.MessageReactionAdd, (r, u) =>
    handleVoteChange(r, u, true, db),
  );
  client.on(Events.MessageReactionRemove, (r, u) =>
    handleVoteChange(r, u, false, db),
  );

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== PROFILE_COMMAND_NAME) return;
    await handleProfileInteraction(interaction, db, config);
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

    if (message.content.trim() === "!weeklyrecap") {
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
        });
        await message.react("\u2705").catch(() => {});
      } catch (e) {
        console.error("[weekly-recap] manual run failed:", e?.message || e);
        await message.reply("❌ Impossible de générer le recap hebdo.");
      }
      return;
    }

    if (message.content.trim() === "!rank") {
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
