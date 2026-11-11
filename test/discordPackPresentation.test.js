"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const express = require("express");
const { ChannelType } = require("discord.js");
const { createDiscordGiftTestService, mountDiscordPackRoutes, MAX_GIF_BYTES } = require("../app/discordGiftTest");
const CHANNEL = "223456789012345678", GUILD = "123456789012345678", MESSAGE = "323456789012345678";
const REQUEST = "5c84ee36-6d4c-4bd5-8576-0d6f3f8c6975";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
function fixture() {
  const calls = [];
  const config = { discord: { guildId: GUILD }, admin: { twitchClientId: "site-client", twitchIds: ["480296446"], allowedOrigins: ["https://erwayr.online"] } };
  const guild = { id: GUILD, name: "Communauté", members: { fetchMe: async () => ({}) } };
  const channel = { id: CHANNEL, guild, name: "annonces", type: ChannelType.GuildAnnouncement, allowed: true,
    permissionsFor() { return { has: () => this.allowed }; }, send: async payload => { calls.push(payload); return { id: MESSAGE }; } };
  guild.channels = { fetch: async () => new Map([[CHANNEL, channel]]) };
  const client = { isReady: () => true, guilds: { cache: new Map([[GUILD, guild]]) }, channels: { fetch: async () => channel } };
  const body = { channelId: CHANNEL, requestId: REQUEST, packId: "noel-2026", filename: "pack-noel-2026.gif", content: "🎁 Noël arrive ! @everyone", gifBase64: GIF.toString("base64") };
  return { client, config, calls, channel, body, presentation: true };
}
test("pack announcements preserve exact bytes and caption, suppress mentions, deduplicate content and retries", async () => {
  const f = fixture(), service = createDiscordGiftTestService(f);
  const input = { ...f.body, adminId: "480296446", buffer: GIF };
  const [one, two] = await Promise.all([service.sendPreview(input), service.sendPreview(input)]);
  assert.deepEqual(one, two); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].files[0].attachment, GIF); assert.equal(f.calls[0].content, f.body.content);
  assert.deepEqual(f.calls[0].allowedMentions, { parse: [] }); assert.equal(f.calls[0].enforceNonce, true);
  await service.sendPreview(input); assert.equal(f.calls.length, 1);
  for (const change of [{ content: "modified" }, { buffer: Buffer.concat([GIF, Buffer.from("new")]) }, { channelId: "423456789012345678" }]) {
    await assert.rejects(service.sendPreview({ ...input, ...change }), { code: "test_request_conflict" });
  }
});
test("pack validation and permission changes are rejected before sending", async () => {
  const f = fixture(), service = createDiscordGiftTestService(f), input = { ...f.body, adminId: "480296446", buffer: GIF };
  for (const changes of [{ content: " " }, { content: "x".repeat(1501) }, { filename: "../pack.gif" }, { packId: "bad/path" }, { requestId: "invalid" }]) {
    await assert.rejects(service.sendPreview({ ...input, ...changes }));
  }
  await service.listChannels(); f.channel.allowed = false;
  await assert.rejects(service.sendPreview(input), { code: "discord_channel_forbidden" }); assert.equal(f.calls.length, 0);
});
async function httpFixture(t) {
  const f = fixture(), app = express(), state = { status: 200, userId: "480296446", clientId: "site-client" };
  mountDiscordPackRoutes({ ...f, app, logger: { warn() {} }, fetchImpl: async () => ({ status: state.status, ok: state.status === 200,
    json: async () => ({ client_id: state.clientId, user_id: state.userId }) }) });
  app.use(express.json()); // Match the production middleware order.
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/admin/discord/packs`;
  const headers = { Origin: "https://erwayr.online", Authorization: "Bearer test-token", "Content-Type": "application/json" };
  return { ...f, state, base, headers, send: (body = f.body, changes = {}) => fetch(`${base}/send`, { method: "POST", headers, body: JSON.stringify(body), ...changes }) };
}
test("HTTP pack routes enforce Twitch admin and CORS before accepting uploads", async t => {
  const f = await httpFixture(t);
  assert.equal((await fetch(`${f.base}/channels`)).status, 401);
  assert.equal((await f.send(undefined, { headers: { ...f.headers, Origin: "https://unknown.example" } })).status, 403);
  f.state.status = 401; assert.equal((await f.send()).status, 401);
  f.state.status = 200; f.state.userId = "42"; assert.equal((await f.send()).status, 403);
  f.state.userId = "480296446"; f.state.clientId = "other"; assert.equal((await f.send()).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(`${f.base}/send`, { method: "OPTIONS", headers: { Origin: f.headers.Origin } })).status, 204);
});
test("HTTP sends the exact preview as a genuine announcement and returns the confirmed link identifiers", async t => {
  const f = await httpFixture(t);
  const list = await fetch(`${f.base}/channels`, { headers: f.headers }); assert.equal((await list.json()).channels[0].id, CHANNEL);
  const response = await f.send(); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, requestId: REQUEST, channelId: CHANNEL, channelName: "annonces", guildId: GUILD, messageId: MESSAGE });
  assert.deepEqual(f.calls[0].files[0].attachment, GIF); assert.equal(f.calls[0].content, f.body.content);
  await f.send(); assert.equal(f.calls.length, 1);
});
test("HTTP rejects malformed, oversized and non-JSON uploads and safely reports uncertain Discord sends", async t => {
  const f = await httpFixture(t);
  for (const gifBase64 of [undefined, null, "not base64!", "data:image/gif;base64," + GIF.toString("base64"), Buffer.from("not a gif").toString("base64")]) {
    assert.equal((await f.send({ ...f.body, gifBase64 })).status, 400);
  }
  const large = Buffer.alloc(MAX_GIF_BYTES + 1); GIF.copy(large);
  assert.equal((await f.send({ ...f.body, gifBase64: large.toString("base64") })).status, 413);
  assert.equal((await f.send({ ...f.body, gifBase64: "A".repeat(12 * 1024 * 1024) })).status, 413);
  assert.equal((await f.send(undefined, { body: "{invalid" })).status, 400);
  assert.equal((await f.send(undefined, { headers: { ...f.headers, "Content-Type": "image/gif" }, body: GIF })).status, 415);
  assert.equal(f.calls.length, 0);
  f.channel.send = async () => { throw new Error("private network detail"); };
  const failed = await f.send(); assert.equal(failed.status, 502); assert.equal((await failed.json()).error, "discord_test_unconfirmed");
});
