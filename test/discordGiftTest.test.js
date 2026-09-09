"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { MAX_GIF_BYTES, createDiscordGiftTestService, mountDiscordGiftTestRoutes } = require("../app/discordGiftTest");

const GUILD = "123456789012345678", CHANNEL = "223456789012345678", MESSAGE = "323456789012345678";
const REQUEST_ID = "5c84ee36-6d4c-4bd5-8576-0d6f3f8c6975";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function fixture() {
  const calls = [], config = { discord: { guildId: GUILD }, admin: {
    twitchClientId: "site-client", twitchIds: ["480296446"], allowedOrigins: ["https://erwayr.online"],
  } };
  const channels = new Map();
  const guild = { id: GUILD, name: "La communauté", channels: { fetch: async () => channels },
    members: { fetchMe: async () => ({ id: "bot" }) } };
  function addChannel(id, changes = {}) {
    const channel = { id, name: "tests-cartes", guild, type: ChannelType.GuildText, rawPosition: 1,
      parent: { name: "Administration" }, allowed: true,
      permissionsFor() { return { has: (required) => this.allowed && required.includes(PermissionFlagsBits.AttachFiles) }; },
      send: async (payload) => { calls.push(payload); return { id: MESSAGE }; }, ...changes };
    channels.set(id, channel); return channel;
  }
  const channel = addChannel(CHANNEL);
  const client = { isReady: () => true, guilds: { cache: new Map([[GUILD, guild]]) },
    channels: { fetch: async (id, options) => { assert.equal(options.force, true); return channels.get(id); } } };
  const input = { adminId: "480296446", channelId: CHANNEL, requestId: REQUEST_ID, filename: "alice.gif", buffer: GIF };
  return { config, calls, channels, guild, channel, client, addChannel, input };
}

test("list only guild text/announcement channels where this bot can attach a file", async () => {
  const f = fixture();
  f.addChannel("423456789012345678", { allowed: false });
  f.addChannel("523456789012345678", { type: ChannelType.GuildVoice });
  f.addChannel("623456789012345678", { type: ChannelType.GuildForum });
  f.addChannel("723456789012345678", { type: ChannelType.PublicThread });
  f.addChannel("823456789012345678", { type: ChannelType.GuildAnnouncement });
  f.addChannel("923456789012345678", { guild: { id: "999999999999999999" } });
  const list = await createDiscordGiftTestService(f).listChannels();
  assert.deepEqual(list.map((item) => item.id), [CHANNEL, "823456789012345678"]);
  assert.equal(list[0].guildName, "La communauté"); assert.equal(f.calls.length, 0);
});

test("the chosen channel receives the identical GIF, with a test label and no mentions", async () => {
  const f = fixture();
  const receipt = await createDiscordGiftTestService(f).sendPreview(f.input);
  assert.equal(receipt.channelId, CHANNEL); assert.equal(receipt.messageId, MESSAGE);
  assert.equal(f.calls[0].files[0].attachment, GIF);
  assert.equal(f.calls[0].files[0].name, "alice.gif");
  assert.match(f.calls[0].content, /Test cadeau Discord/);
  assert.match(f.calls[0].content, /Merci de ta fidelite, alice !/);
  assert.deepEqual(f.calls[0].allowedMentions, { parse: [] });
  assert.equal(f.calls[0].enforceNonce, true); assert.equal(f.calls[0].nonce.length, 24);
});

test("duplicate in-flight requests and lost-response retries do not send twice", async () => {
  const f = fixture();
  let release;
  f.channel.send = async (payload) => { f.calls.push(payload); await new Promise((resolve) => { release = resolve; }); return { id: MESSAGE }; };
  const service = createDiscordGiftTestService(f);
  const first = service.sendPreview(f.input), duplicate = service.sendPreview(f.input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1); release();
  assert.deepEqual(await first, await duplicate);
  await service.sendPreview(f.input); assert.equal(f.calls.length, 1);
  await assert.rejects(service.sendPreview({ ...f.input, filename: "bob.gif" }), { code: "test_request_conflict" });
});

test("recheck permissions at send time; never fall back to a DM or another guild", async () => {
  const f = fixture(); const service = createDiscordGiftTestService(f);
  await service.listChannels(); f.channel.allowed = false;
  await assert.rejects(service.sendPreview(f.input), { code: "discord_channel_forbidden" });
  f.channel.allowed = true; f.channel.guild = { id: "999999999999999999" };
  await assert.rejects(service.sendPreview(f.input), { code: "invalid_discord_channel" });
  assert.equal(f.calls.length, 0);
});

test("reject malformed GIFs and request metadata before contacting Discord", async () => {
  const f = fixture(); const service = createDiscordGiftTestService(f);
  for (const changes of [{ channelId: "" }, { channelId: [CHANNEL] }, { requestId: "bad" }, { filename: "../alice.gif" }, { filename: "@everyone.gif" }, { buffer: Buffer.from("not a GIF") }]) {
    await assert.rejects(service.sendPreview({ ...f.input, ...changes }));
  }
  const large = Buffer.alloc(MAX_GIF_BYTES + 1); GIF.copy(large);
  await assert.rejects(service.sendPreview({ ...f.input, buffer: large }), { code: "gif_too_large" });
  assert.equal(f.calls.length, 0);
});

async function withHttp(t) {
  const f = fixture(); const app = express();
  const state = { identity: { client_id: "site-client", user_id: "480296446" }, authStatus: 200, validations: 0 };
  mountDiscordGiftTestRoutes({ ...f, app, logger: { warn() {} }, fetchImpl: async (url, options) => {
    state.validations++; assert.equal(url, "https://id.twitch.tv/oauth2/validate");
    assert.equal(options.headers.Authorization, "OAuth test-token");
    return { status: state.authStatus, ok: state.authStatus === 200, json: async () => state.identity };
  } });
  const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/admin/discord/gift-test`;
  const headers = { Origin: "https://erwayr.online", Authorization: "Bearer test-token" };
  const send = (changes = {}) => fetch(`${base}/send?${new URLSearchParams({ channelId: CHANNEL, requestId: REQUEST_ID, filename: "alice.gif" })}`, {
    method: "POST", headers: { ...headers, "Content-Type": "image/gif" }, body: GIF, ...changes,
  });
  return { ...f, state, base, headers, send };
}

test("HTTP blocks missing, expired, wrong-client and non-admin Twitch credentials", async (t) => {
  const f = await withHttp(t);
  assert.equal((await fetch(`${f.base}/channels`)).status, 401);
  assert.equal(f.state.validations, 0);
  f.state.authStatus = 401; assert.equal((await f.send()).status, 401);
  f.state.authStatus = 200; f.state.identity.user_id = "someone-else";
  assert.equal((await f.send()).status, 403);
  f.state.identity = { client_id: "other-app", user_id: "480296446" };
  assert.equal((await f.send()).status, 401); assert.equal(f.calls.length, 0);
});

test("HTTP CORS preflight is safe, unknown origins denied, and successful sends have receipts", async (t) => {
  const f = await withHttp(t);
  const preflight = await fetch(`${f.base}/send`, { method: "OPTIONS", headers: { Origin: f.headers.Origin } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), f.headers.Origin);
  assert.equal(f.state.validations, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.send({ headers: { ...f.headers, Origin: "https://unknown.example", "Content-Type": "image/gif" } })).status, 403);
  const channels = await fetch(`${f.base}/channels`, { headers: f.headers });
  assert.equal((await channels.json()).channels[0].id, CHANNEL);
  const response = await f.send(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, requestId: REQUEST_ID, channelId: CHANNEL, channelName: "tests-cartes", guildId: GUILD, messageId: MESSAGE });
  assert.equal(f.calls.length, 1);
});

test("HTTP rejects non-GIF and oversized uploads without sending; Discord errors never report success", async (t) => {
  const f = await withHttp(t);
  assert.equal((await f.send({ headers: { ...f.headers, "Content-Type": "application/json" }, body: "{}" })).status, 415);
  const large = Buffer.alloc(MAX_GIF_BYTES + 1); GIF.copy(large);
  const oversized = await f.send({ body: large }); assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, "gif_too_large"); assert.equal(f.calls.length, 0);
  f.channel.send = async () => { throw Object.assign(new Error("private Discord details"), { code: 50013 }); };
  const denied = await f.send(); assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { ok: false, error: "discord_channel_forbidden" });
  f.channel.send = async () => { throw new Error("network with private details"); };
  const unknown = await f.send(); assert.equal(unknown.status, 502);
  assert.deepEqual(await unknown.json(), { ok: false, error: "discord_test_unconfirmed" });
});
