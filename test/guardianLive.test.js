"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGuardianLive } = require("../script/guardianLive");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");
const { buildTwitchHelpResponse } = require("../script/twitchChatCommands");
test("!perso accepts the Twitch author, resolves canonical login and is listed in help", async () => {
  const db = createMemoryFirestore(); const messages = [];
  const app = createGuardianLive({ db, channelId: "123", now: () => 1000000,
    getLiveState: async () => ({ streamId: "live" }),
    resolveTwitchIdentity: async ({ twitchUserId, login }) => { assert.equal(twitchUserId, "42"); assert.equal(login, "newname"); return { login: "canonical" }; },
    sendMessage: async (message) => messages.push(message),
  });
  assert.equal((await app.handleMessage({ message: "hello", login: "viewer" })).handled, false);
  assert.equal((await app.handleMessage({ message: "!perso other_user", login: "viewer" })).handled, false);
  const result = await app.handleMessage({ message: " !PeRsO ", login: "newname", displayName: "NewName", tags: { "user-id": "42", id: "message42" } });
  assert.equal(result.accepted, true); assert.equal(messages.length, 1);
  assert.match(messages[0], /position 1/);
  assert.equal(db.documents.get("guardian_live_channels/123").queue[0].login, "canonical");
  assert.match(buildTwitchHelpResponse(), /!perso/);
});
test("offline calls are rejected without consuming cooldown, missing Twitch identity does not enqueue", async () => {
  const db = createMemoryFirestore(); const messages = [];
  const app = createGuardianLive({ db, channelId: "123", now: () => 1000000, getLiveState: async () => ({}), sendMessage: async (m) => messages.push(m) });
  assert.equal((await app.handleMessage({ message: "!perso", login: "viewer", tags: {} })).reason, "identity_missing");
  assert.equal((await app.handleMessage({ message: "!perso", login: "viewer", tags: { "user-id": "42" } })).reason, "offline");
  assert.equal(db.writes.length, 0); assert.match(messages[0], /pendant les lives/);
});

test("a delayed identity lookup cannot re-open the previous stream", async () => {
  const db=createMemoryFirestore(); let time=1000000; let streamId="old"; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const app=createGuardianLive({db,channelId:"123",now:()=>time,getLiveState:async()=>({streamId}),sendMessage:async()=>{},
    resolveTwitchIdentity:async()=>{await gate;return {login:"viewer"};}});
  const pending=app.handleMessage({message:"!perso",login:"viewer",tags:{"user-id":"42"}});
  await Promise.resolve(); time+=1000; streamId="new"; await app.tick(); release();
  assert.equal((await pending).reason,"offline");
  assert.equal(db.documents.get("guardian_live_channels/123").streamId,"new");
  assert.equal(db.documents.has("guardian_live_channels/123/viewers/42"),false);
});

test("a temporary service failure receives an explanation without spending cooldown",async()=>{
  const db=createMemoryFirestore();const messages=[];
  const app=createGuardianLive({db,channelId:"123",now:()=>1000000,getLiveState:async()=>{throw new Error("network_unavailable");},sendMessage:async m=>messages.push(m),logger:{warn(){}}});
  assert.equal((await app.handleMessage({message:"!perso",login:"viewer",tags:{"user-id":"42"}})).reason,"unavailable");
  assert.equal(db.writes.length,0);assert.match(messages[0],/indisponible/);
});

function chatFixture() {
  const db = createMemoryFirestore({
    "elections/winner": { endedAt: 999000, winnerId: "discord42", winnerInfo: { pseudo: "oldname", twitch_id: "42" } },
    "twitch_identities/42": { currentLogin: "renamed", status: "active" },
    "followers_all_time/renamed": { twitch_id: "42", discord_id: "discord42" },
  });
  let time = 1000000; const messages = [], warnings = [];
  const app = createGuardianLive({ db, channelId: "123", now: () => time, getLiveState: async () => ({ streamId: "live" }),
    sendMessage: async text => messages.push(text), logger: { warn: (...args) => warnings.push(args) } });
  const chat = (userId, id, sentAt = time) => app.handleMessage({ message: "Bonjour le chat !", login: "same_display_name", tags: { "user-id": userId, id, "tmi-sent-ts": String(sentAt) } });
  return { db, app, chat, messages, warnings, advance: value => { time += value; } };
}

test("regular Guardian messages greet by stable Twitch ID without swallowing chat or sending a bot reply", async () => {
  const { db, app, chat, messages, advance } = chatFixture();
  await app.tick();
  const writes = db.writes.length;
  assert.equal((await chat("99", "impostor")).handled, false);
  assert.equal(db.writes.length, writes);
  assert.equal((await chat("42", "greeting")).handled, false);
  const first = structuredClone(db.documents.get("guardian_live_channels/123").chatGreeting);
  assert.equal(first.type, "greet"); assert.equal(first.endsAtMs - first.startsAtMs, 4000);
  await chat("42", "greeting"); advance(1000); await chat("42", "burst");
  assert.deepEqual(db.documents.get("guardian_live_channels/123").chatGreeting, first);
  advance(3001); await chat("42", "next-greeting");
  assert.equal(db.documents.get("guardian_live_channels/123").chatGreeting.id, "next-greeting");
  assert.deepEqual(messages, []);
  assert.ok(db.writes.every(path => path === "guardian_live_channels/123"));
});

test("delayed or replayed Twitch messages do not produce greetings after reconnect", async () => {
  const { db, app, chat } = chatFixture(); await app.tick();
  const writes = db.writes.length;
  await chat("42", "old-message", 991999);
  await chat("42", "future-message", 1003000);
  await chat("", "anonymous");
  assert.equal(db.writes.length, writes);
  await chat("42", "current-message", 999000);
  assert.equal(db.documents.get("guardian_live_channels/123").chatGreeting.id, "current-message");
});

test("cached Guardian identity never authorizes a greeting after a new election", async () => {
  const { db, app, chat, advance } = chatFixture(); await app.tick();
  await chat("42", "first"); advance(5000);
  db.documents.set("elections/new", { endedAt: 1001000, winnerId: "discord99", winnerInfo: { twitch_id: "99", pseudo: "successor" } });
  const writes = db.writes.length;
  await chat("42", "former-guardian");
  assert.equal(db.writes.length, writes, "The transaction revalidates the election despite the bot cache");
  advance(10001); await chat("99", "successor");
  assert.equal(db.documents.get("guardian_live_channels/123").chatGreeting.id, "successor");
});

test("greeting service errors leave normal chat available", async () => {
  const { db, app, chat, warnings } = chatFixture(); await app.tick();
  db.collection = () => { throw new Error("unavailable"); };
  assert.equal((await chat("42", "message")).handled, false);
  assert.equal(warnings.length, 1);
});
