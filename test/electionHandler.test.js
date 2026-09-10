"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const electionHandler = require("../script/electionHandler");

function fixture() {
  const actions = [];
  let data;
  const ref = {
    id: new Date().toISOString().slice(0, 7),
    async get() { return { exists: !!data, data: () => data }; },
    async set(value) { data = { ...value }; actions.push("create"); },
    async update(value) { Object.assign(data, value); actions.push("update"); },
  };
  const poll = {
    id: "323456789012345678",
    async react(emoji) { actions.push(`react:${emoji}`); },
  };
  const channel = {
    id: "223456789012345678",
    async send(content) {
      actions.push(typeof content === "string" ? content : "publish");
      return poll;
    },
  };
  const message = {
    content: "!election start",
    channelId: "923456789012345678",
    member: { permissions: { has: () => true } },
    guild: {
      id: "123456789012345678",
      channels: {
        async fetch(id) { assert.equal(id, channel.id); return channel; },
      },
    },
    async reply(content) { actions.push(content); },
  };
  const db = {
    collection(name) {
      assert.equal(name, "elections", "starting an election must not write follower mirrors");
      return {
        doc(id) { assert.equal(id, ref.id); return ref; },
        where(field, operator, value) {
          assert.deepEqual([field, operator, value], ["endedAt", "==", null]);
          return { async get() { return { empty: true, docs: [] }; } };
        },
      };
    },
  };
  return { actions, ref, message, channel, poll, db, data: () => data };
}

test("start records publication coordinates and saves the message after adding thumbs-up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = fixture();
  await electionHandler(ctx.message, ctx.db, ctx.channel.id);
  const data = ctx.data();
  assert.equal(data.guildId, ctx.message.guild.id);
  assert.equal(data.channelId, ctx.channel.id);
  assert.notEqual(data.channelId, ctx.message.channelId);
  assert.equal(data.pollMessageId, ctx.poll.id);
  assert.ok(data.startedAt instanceof Date);
  assert.equal(data.endedAt, null);
  assert.equal(data.winnerId, null);
  assert.deepEqual(data.voters, []);
  assert.deepEqual(ctx.actions.slice(0, 4), ["create", "publish", "react:👍", "update"]);

  await electionHandler(ctx.message, ctx.db, ctx.channel.id);
  assert.equal(ctx.actions.filter((action) => action === "create").length, 1);
  assert.match(ctx.actions.at(-1), /en cours/);
});

test("closing an empty election preserves its Discord coordinates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = fixture();
  await electionHandler(ctx.message, ctx.db, ctx.channel.id);
  ctx.message.content = "!election end";
  await electionHandler(ctx.message, ctx.db, ctx.channel.id);
  assert.ok(ctx.data().endedAt instanceof Date);
  assert.equal(ctx.data().guildId, ctx.message.guild.id);
  assert.equal(ctx.data().channelId, ctx.channel.id);
  assert.equal(ctx.data().pollMessageId, ctx.poll.id);
  assert.match(ctx.actions.at(-1), /Aucun participant/);
});
