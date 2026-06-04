"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

class FakeEmbedBuilder {
  constructor() {
    this.data = {};
  }

  setColor(value) {
    this.data.color = value;
    return this;
  }

  setTitle(value) {
    this.data.title = value;
    return this;
  }

  setDescription(value) {
    this.data.description = value;
    return this;
  }

  addFields(...fields) {
    this.data.fields = fields.flat();
    return this;
  }

  setFooter(value) {
    this.data.footer = value;
    return this;
  }

  setTimestamp(value) {
    this.data.timestamp = value;
    return this;
  }

  setImage(value) {
    this.data.image = { url: value };
    return this;
  }
}

const originalLoad = Module._load;
Module._load = function loadWithDiscordStub(request, parent, isMain) {
  if (request === "discord.js") {
    return { EmbedBuilder: FakeEmbedBuilder };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { buildDiscordBirthdayPayload } = require("../app/birthdays");

test("buildDiscordBirthdayPayload attaches birthday banner when asset exists", () => {
  const payload = buildDiscordBirthdayPayload({
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
    ],
  });

  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, "birthday-banner.png");
  assert.match(payload.files[0].attachment, /assets\/birthday-banner\.png$/);
  assert.equal(
    payload.embeds[0].data.image.url,
    "attachment://birthday-banner.png",
  );
  assert.match(payload.content, /QUÊTE ANNIVERSAIRE DÉBLOQUÉE/);
  assert.match(payload.embeds[0].data.description, /Récompense légendaire/);
});

test("buildDiscordBirthdayPayload falls back cleanly without banner", () => {
  const payload = buildDiscordBirthdayPayload({
    bannerPath: path.join(__dirname, "missing-birthday-banner.png"),
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
    ],
  });

  assert.equal(payload.files, undefined);
  assert.equal(payload.embeds[0].data.image, undefined);
  assert.match(payload.content, /<@111111111111111111>/);
});

test("buildDiscordBirthdayPayload keeps test mentions inactive", () => {
  const payload = buildDiscordBirthdayPayload({
    test: true,
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
    ],
  });

  assert.match(payload.content, /TEST - non publié/);
  assert.match(payload.content, /<@111111111111111111>/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test("buildDiscordBirthdayPayload groups multiple birthdays in one payload", () => {
  const payload = buildDiscordBirthdayPayload({
    birthdays: [
      {
        login: "alice",
        display: "Alice",
        discord_id: "111111111111111111",
      },
      {
        login: "bob",
        display: "Bob",
        discord_id: "222222222222222222",
      },
    ],
  });

  assert.match(payload.content, /double tournée de bougies/);
  assert.match(payload.content, /ANNIVERSAIRE COMMUNAUTÉ/);
  assert.equal(payload.embeds.length, 1);
  assert.match(payload.embeds[0].data.fields[0].value, /111111111111111111/);
  assert.match(payload.embeds[0].data.fields[0].value, /222222222222222222/);
  assert.deepEqual(payload.allowedMentions, {
    parse: [],
    users: ["111111111111111111", "222222222222222222"],
  });
});
