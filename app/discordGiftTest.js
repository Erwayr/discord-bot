"use strict";

const { createHash } = require("node:crypto");
const bodyParser = require("body-parser");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const MAX_GIF_BYTES = 8 * 1024 * 1024;
const TEST_PATH = "/admin/discord/gift-test";
const REQUIRED_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
const snowflake = (value) => typeof value === "string" && /^\d{17,20}$/.test(value);
const testError = (code, status) => Object.assign(new Error(code), { code, status });

async function authenticateGiftAdmin(req, config, fetchImpl) {
  const token = req.header("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) throw testError("missing_twitch_token", 401);
  let response;
  try {
    response = await fetchImpl("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(8000),
    });
  } catch { throw testError("twitch_validation_unavailable", 503); }
  if (response.status >= 500 || response.status === 429) throw testError("twitch_validation_unavailable", 503);
  if (!response.ok) throw testError("invalid_twitch_token", 401);
  const identity = await response.json();
  if (identity.client_id !== config.admin.twitchClientId) throw testError("wrong_twitch_client", 401);
  if (!identity.user_id || !config.admin.twitchIds.includes(String(identity.user_id))) throw testError("admin_forbidden", 403);
  return String(identity.user_id);
}

function createDiscordGiftTestService({ client, config, now = Date.now }) {
  const deliveries = new Map();
  const guildAllowed = (guild) => Boolean(guild && client.guilds.cache.has(guild.id)
    && (!config.discord.guildId || guild.id === config.discord.guildId));
  const channelAllowed = (channel, member) => Boolean(channel && guildAllowed(channel.guild)
    && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    && channel.permissionsFor(member)?.has(REQUIRED_PERMISSIONS));

  function ready() {
    if (!client?.isReady()) throw testError("discord_not_ready", 503);
  }

  async function listChannels() {
    ready();
    const channels = [];
    for (const guild of client.guilds.cache.values()) {
      if (!guildAllowed(guild)) continue;
      const [available, member] = await Promise.all([guild.channels.fetch(), guild.members.fetchMe({ force: true })]);
      for (const channel of available.values()) {
        if (!channelAllowed(channel, member)) continue;
        channels.push({ id: channel.id, name: channel.name, guildId: guild.id, guildName: guild.name,
          categoryName: channel.parent?.name || "", position: channel.rawPosition });
      }
    }
    return channels.sort((a, b) => a.guildName.localeCompare(b.guildName, "fr") || a.position - b.position || a.name.localeCompare(b.name, "fr"));
  }

  async function sendPreview({ adminId, channelId, requestId, filename, buffer }) {
    ready();
    if (!snowflake(channelId)) throw testError("invalid_discord_channel", 400);
    if (typeof requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId)) throw testError("invalid_test_request", 400);
    if (typeof filename !== "string" || !/^[a-z0-9_]{1,25}\.gif$/.test(filename)) throw testError("invalid_gif_filename", 400);
    if (!Buffer.isBuffer(buffer) || buffer.length < 13 || !/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) throw testError("invalid_gif_file", 400);
    if (buffer.length > MAX_GIF_BYTES) throw testError("gif_too_large", 413);
    for (const [key, entry] of deliveries) {
      if (entry.completedAt && now() - entry.completedAt > 30 * 60_000) deliveries.delete(key);
    }
    const key = `${adminId}:${requestId}`;
    const signature = createHash("sha256").update(`${channelId}:${filename}:`).update(buffer).digest("hex");
    const previous = deliveries.get(key);
    if (previous) {
      if (previous.signature !== signature) throw testError("test_request_conflict", 409);
      return previous.promise;
    }
    if (deliveries.size >= 100) throw testError("discord_test_busy", 429);
    const entry = { signature, completedAt: null };
    entry.promise = (async () => {
      const channel = await client.channels.fetch(channelId, { force: true });
      if (!guildAllowed(channel?.guild)) throw testError("invalid_discord_channel", 403);
      const member = await channel.guild.members.fetchMe({ force: true });
      if (!channelAllowed(channel, member)) throw testError("discord_channel_forbidden", 403);
      const message = await channel.send({
        content: `🧪 **Test cadeau Discord**\nMerci de ta fidelite, ${filename.slice(0, -4)} !`,
        files: [{ attachment: buffer, name: filename }],
        allowedMentions: { parse: [] },
        nonce: createHash("sha256").update(key).digest("hex").slice(0, 24), enforceNonce: true,
      });
      return { requestId, channelId, channelName: channel.name, guildId: channel.guild.id, messageId: message.id };
    })();
    deliveries.set(key, entry);
    try {
      const result = await entry.promise;
      entry.completedAt = now();
      return result;
    } catch (error) {
      deliveries.delete(key);
      throw error;
    }
  }
  return { listChannels, sendPreview };
}

function mountDiscordGiftTestRoutes({ app, client, config, fetchImpl = fetch, logger = console }) {
  const service = createDiscordGiftTestService({ client, config });
  function failure(res, error) {
    let code = error.code, status = error.status;
    if ([50001, 50013].includes(Number(code))) { code = "discord_channel_forbidden"; status = 403; }
    else if (Number(code) === 10003) { code = "invalid_discord_channel"; status = 404; }
    else if (error.type === "entity.too.large") { code = "gif_too_large"; status = 413; }
    else if (!Number.isInteger(status) || typeof code !== "string") { code = "discord_test_unconfirmed"; status = 502; }
    logger.warn("[discord-gift-test] request failed", { code, status });
    if (!res.destroyed) res.status(status).json({ ok: false, error: code });
  }
  app.use(TEST_PATH, (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Origin");
    const origin = req.header("origin");
    if (origin && !config.admin.allowedOrigins.includes(origin)) return res.status(403).json({ ok: false, error: "origin_forbidden" });
    if (origin) res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  const authenticate = async (req, res, next) => {
    try { req.giftAdminId = await authenticateGiftAdmin(req, config, fetchImpl); next(); }
    catch (error) { failure(res, error); }
  };
  app.get(`${TEST_PATH}/channels`, authenticate, async (req, res) => {
    try { res.json({ ok: true, channels: await service.listChannels() }); }
    catch (error) { failure(res, error); }
  });
  app.post(`${TEST_PATH}/send`, authenticate, (req, res, next) => {
    if (!req.is("image/gif")) return failure(res, testError("invalid_gif_type", 415));
    next();
  }, bodyParser.raw({ type: "image/gif", limit: MAX_GIF_BYTES, inflate: false }), async (req, res) => {
    try {
      const delivery = await service.sendPreview({ adminId: req.giftAdminId, channelId: req.query.channelId,
        requestId: req.query.requestId, filename: req.query.filename, buffer: req.body });
      res.json({ ok: true, ...delivery });
    } catch (error) { failure(res, error); }
  });
  app.use(TEST_PATH, (error, req, res, next) => failure(res, error));
}

module.exports = { MAX_GIF_BYTES, createDiscordGiftTestService, mountDiscordGiftTestRoutes };
