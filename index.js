const {
  Client,
  GatewayIntentBits,
  ChannelType,
  Events,
} = require("discord.js");
require("dotenv").config();

const LOG_CHANNEL_ID = "1377870229153120257";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages, // << AJOUT OBLIGATOIRE !
    GatewayIntentBits.MessageContent,
  ],
  partials: ["CHANNEL"],
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
});

client.on("raw", async (packet) => {
  if (packet.t !== "MESSAGE_CREATE") return;

  const data = packet.d;

  // DM uniquement (pas de guild_id)
  if (!data.guild_id) {
    try {
      const user = await client.users.fetch(data.author.id);
      const content = data.content;

      console.log(`[DM RAW] ${user.tag} : ${content}`);

      // Envoi dans le salon
      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (logChannel && logChannel.isTextBased()) {
        const now = Math.floor(Date.now() / 1000);
        await logChannel.send(
          `📩 **DM de ${user.tag}** à <t:${now}:F> :\n> ${content}`
        );
      }
    } catch (err) {
      console.error("❌ Erreur lors de l'envoi dans le salon :", err);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
