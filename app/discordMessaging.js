"use strict";

function sanitizeDiscordText(value, fallback = "") {
  return String(value || fallback)
    .trim()
    .replace(/@/g, "@\u200b");
}

function formatClipDiscordMessage(clip) {
  const title = sanitizeDiscordText(clip?.title, "Nouveau clip");
  const creator = sanitizeDiscordText(
    clip?.creator_name || clip?.creator_login,
    "un viewer",
  );
  const game = sanitizeDiscordText(clip?.game_name, "");
  const views =
    Number.isFinite(Number(clip?.view_count)) && Number(clip?.view_count) >= 0
      ? Number(clip.view_count)
      : null;
  const fallbackUrl = clip?.id ? `https://clips.twitch.tv/${clip.id}` : "";
  const url = String(clip?.url || fallbackUrl).trim();

  const details = [
    game ? `jeu: **${game}**` : null,
    views !== null ? `vues: **${views}**` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  return [
    "🎬 **Nouveau clip sur la chaine !**",
    `**${title}**`,
    `par **${creator}**`,
    details,
    url,
  ]
    .filter(Boolean)
    .join("\n");
}

function createDiscordMessaging({ client, logChannelId }) {
  async function postDiscord(channelId, text) {
    if (!channelId) return;
    const ch = await client.channels.fetch(channelId);
    if (ch?.isTextBased() && text) await ch.send(text);
  }

  async function sendDMOrFallback(discordId, text) {
    let user = null;
    try {
      user = await client.users.fetch(discordId);
      await user.send(text);
      return true;
    } catch (err) {
      const reason =
        err?.code === 50007
          ? "DMs fermés par l’utilisateur (Discord 50007)"
          : `${err?.name || "Erreur"}${err?.code ? ` [${err.code}]` : ""}`;
      console.warn(`⚠️ DM vers ${discordId} impossible : ${reason}`);

      try {
        const logCh = await client.channels.fetch(logChannelId);
        if (logCh?.isTextBased()) {
          await logCh.send({
            content:
              `🛑 **Fallback DM**\n` +
              `• **Destinataire :** ${
                user ? `${user.tag} (${discordId})` : `ID ${discordId}`
              }\n` +
              `• **Raison :** ${reason}\n` +
              `• **Message d’origine :**\n${text}`,
            allowedMentions: { parse: [] },
          });
        }
      } catch (e) {
        console.warn("⚠️ Fallback log-channel impossible :", e.message);
      }
      return false;
    }
  }

  return { postDiscord, sendDMOrFallback };
}

module.exports = {
  createDiscordMessaging,
  sanitizeDiscordText,
  formatClipDiscordMessage,
};
