"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  buildFinalResultEmbed,
  buildPublicCommunityPollSnapshot,
  queuePublicCommunityPollSync,
  registerCommunityPollEvents,
  syncPublicCommunityPollSnapshot,
} = require("../script/communityPoll");

class FakeSnapshot {
  constructor(ref, data, exists) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = exists;
    this._data = data;
  }

  data() {
    return this.exists ? this._data : undefined;
  }
}

class FakeDocRef {
  constructor(db, pathValue) {
    this.db = db;
    this.path = pathValue;
    this.id = pathValue.split("/").pop();
  }

  collection(name) {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
  }

  async get() {
    const exists = this.db.store.has(this.path);
    return new FakeSnapshot(this, this.db.store.get(this.path), exists);
  }

  async set(payload, options = {}) {
    if (this.path === "site_config/community_poll") {
      this.db.publicSetAttempts += 1;
      if (this.db.publicSetFailures > 0) {
        this.db.publicSetFailures -= 1;
        const error = new Error("unavailable");
        error.code = 14;
        throw error;
      }
      if (this.db.beforePublicSet) await this.db.beforePublicSet(payload);
      this.db.publicSetHistory.push(payload);
    }
    this.db.store.set(
      this.path,
      options.merge ? { ...this.db.store.get(this.path), ...payload } : payload,
    );
  }

  async update(payload) {
    if (this.db.beforeUpdate) await this.db.beforeUpdate(this, payload);
    assert.ok(this.db.store.has(this.path), `missing fake doc ${this.path}`);
    this.db.store.set(this.path, { ...this.db.store.get(this.path), ...payload });
  }
}

class FakeCollectionRef {
  constructor(db, pathValue) {
    this.db = db;
    this.path = pathValue;
  }

  doc(id) {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [];
    for (const [key, value] of this.db.store.entries()) {
      if (!key.startsWith(prefix)) continue;
      const relative = key.slice(prefix.length);
      if (!relative || relative.includes("/")) continue;
      docs.push(new FakeSnapshot(new FakeDocRef(this.db, key), value, true));
    }
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

class FakeDb {
  constructor(initialDocs = {}) {
    this.store = new Map(Object.entries(initialDocs));
    this.publicSetAttempts = 0;
    this.publicSetFailures = 0;
    this.publicSetHistory = [];
    this.beforePublicSet = null;
    this.beforeUpdate = null;
    this.transactionQueue = Promise.resolve();
  }

  collection(name) {
    return new FakeCollectionRef(this, name);
  }

  runTransaction(callback) {
    const pending = this.transactionQueue.then(async () => {
      const writes = [];
      const result = await callback({
        get: (ref) => ref.get(),
        update: (ref, payload) => writes.push({ ref, payload, merge: true }),
        set: (ref, payload, options = {}) => writes.push({ ref, payload, ...options }),
      });
      for (const { ref, payload, merge } of writes) {
        this.store.set(ref.path, merge ? { ...this.store.get(ref.path), ...payload } : payload);
      }
      return result;
    });
    this.transactionQueue = pending.catch(() => {});
    return pending;
  }
}

const proposalDoc = (id, data) => ({ id, data: () => data });
const createdAt = (millis) => ({ toMillis: () => millis });

function activeStore(guildId, voteCount = 1) {
  return {
    [`discord_community_poll_state/${guildId}`]: {
      activePollId: "poll-1",
    },
    "discord_community_polls/poll-1": {
      active: true,
      title: "Quel jeu pour le prochain live ?",
      description: "La communauté choisit.",
      guildId,
      channelId: "123456789012345678",
      messageId: "223456789012345678",
    },
    "discord_community_polls/poll-1/proposals/one": {
      name: "Minecraft",
      voteCount,
      authorId: "private-author",
      createdAt: createdAt(1),
    },
  };
}

function discordError(code) {
  return Object.assign(new Error(`Discord error ${code}`), { code });
}

function payloadData(payload) {
  return {
    ...payload,
    embeds: payload.embeds?.map((embed) => embed.toJSON()),
    components: payload.components?.map((row) => row.toJSON?.() || row),
  };
}

class FakePollMessage {
  constructor(channel, id) {
    this.channel = channel;
    this.id = id;
    this.pinned = false;
    this.payload = { components: [{ components: [{ disabled: false }] }] };
    channel.messageStore.set(id, this);
  }

  async delete() {
    this.channel.calls.push({ action: "delete", id: this.id });
    if (this.deleteError?.code === 10008) this.channel.messageStore.delete(this.id);
    if (this.deleteError) throw this.deleteError;
    this.channel.messageStore.delete(this.id);
  }

  async edit(payload) {
    this.channel.calls.push({ action: "edit", id: this.id });
    if (this.editError) throw this.editError;
    this.payload = payloadData(payload);
  }

  async pin() {
    this.channel.calls.push({ action: "pin", id: this.id });
    if (this.pinError) throw this.pinError;
    this.pinned = true;
  }

  async unpin() {
    this.channel.calls.push({ action: "unpin", id: this.id });
    if (this.unpinError) throw this.unpinError;
    this.pinned = false;
  }
}

class FakePollChannel {
  constructor(id, calls) {
    this.id = id;
    this.calls = calls;
    this.messageStore = new Map();
    this.fetchErrors = new Map();
    this.sent = [];
    this.messages = {
      fetch: async (messageId) => {
        if (this.fetchErrors.has(messageId)) throw this.fetchErrors.get(messageId);
        const message = this.messageStore.get(messageId);
        if (!message) throw discordError(10008);
        return message;
      },
    };
  }

  isTextBased() {
    return true;
  }

  async send(payload) {
    this.calls.push({ action: "send", channelId: this.id });
    if (this.beforeSend) await this.beforeSend();
    if (this.sendError) throw this.sendError;
    const message = new FakePollMessage(this, `result-${this.sent.length + 1}`);
    message.payload = payloadData(payload);
    message.pinError = this.resultPinError;
    this.sent.push(message);
    return message;
  }
}

async function closureFixture() {
  const guildId = "guild-closure";
  const pollPath = "discord_community_polls/poll-1";
  const db = new FakeDb(activeStore(guildId, 5));
  const poll = db.store.get(pollPath);
  poll.pinned = true;
  const calls = [];
  const channel = new FakePollChannel(poll.channelId, calls);
  const commandChannel = new FakePollChannel("other-channel", calls);
  const main = new FakePollMessage(channel, poll.messageId);
  main.pinned = true;
  const proposalMessages = [];
  for (const [index, id] of ["one", "two", "three"].entries()) {
    db.store.set(`${pollPath}/proposals/${id}`, {
      name: ["Minecraft", "Phasmophobia", "Stardew Valley"][index],
      voteCount: [5, 3, 1][index],
      createdAt: createdAt(index + 1),
      channelId: channel.id,
      messageId: `proposal-${id}`,
    });
    proposalMessages.push(new FakePollMessage(channel, `proposal-${id}`));
  }
  db.store.set(`${pollPath}/votes/member`, { proposalIds: ["one"] });
  db.store.set("discord_community_polls/archived", { active: false, messageId: "archived" });
  const unrelated = new FakePollMessage(channel, "discussion");
  const archived = new FakePollMessage(channel, "archived");
  archived.pinned = true;
  const handlers = [];
  const client = {
    on: (event, handler) => handlers.push(handler),
    channels: {
      fetch: async (id) => [channel, commandChannel].find((item) => item.id === id),
    },
  };
  await registerCommunityPollEvents({ client, guildId, db });
  const makeInteraction = (currentChannel = channel) => ({
    commandName: "sondage",
    isChatInputCommand: () => true,
    options: { getSubcommand: () => "cloturer" },
    guildId,
    channelId: currentChannel.id,
    channel: currentChannel,
    user: { id: "moderator" },
    client,
    async deferReply(options) {
      this.deferOptions = options;
      this.deferred = true;
    },
    async editReply(reply) {
      this.reply = reply;
      this.replied = true;
    },
  });
  return {
    db, pollPath, calls, channel, commandChannel, main, proposalMessages,
    unrelated, archived, client, makeInteraction,
    async close(interaction = makeInteraction()) {
      await handlers[0](interaction);
      return interaction;
    },
  };
}

test("builds a sanitized top-five public snapshot with stable tie ordering", () => {
  const proposals = [
    proposalDoc("late", {
      name: "Late tie",
      description: "private detail",
      authorId: "private-author",
      voteCount: 8,
      createdAt: createdAt(20),
    }),
    proposalDoc("winner", {
      name: "Winner",
      authorName: "private name",
      voteCount: 12,
      createdAt: createdAt(30),
    }),
    proposalDoc("early", {
      name: "Early tie",
      voteCount: 8,
      createdAt: createdAt(10),
    }),
    proposalDoc("four", { name: "Fourth", voteCount: 7, createdAt: createdAt(1) }),
    proposalDoc("five", { name: "Fifth", voteCount: 6, createdAt: createdAt(1) }),
    proposalDoc("six", { name: "Sixth", voteCount: 5, createdAt: createdAt(1) }),
  ];

  const payload = buildPublicCommunityPollSnapshot(
    {
      active: true,
      title: "  Prochain live  ",
      description: "  Choisissez votre jeu.  ",
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      messageId: "323456789012345678",
    },
    proposals,
  );

  assert.deepEqual(
    payload.proposals.map((proposal) => proposal.name),
    ["Winner", "Early tie", "Late tie", "Fourth", "Fifth"],
  );
  assert.equal(payload.title, "Prochain live");
  assert.equal(payload.description, "Choisissez votre jeu.");
  assert.equal(payload.proposals.length, 5);
  assert.doesNotMatch(JSON.stringify(payload), /author|private detail|Sixth/);
  assert.deepEqual(Object.keys(payload.proposals[0]).sort(), ["name", "voteCount"]);
});

test("uses the minimal inactive shape for closed or incomplete polls", () => {
  assert.deepEqual(buildPublicCommunityPollSnapshot({ active: false }), {
    active: false,
  });
  assert.deepEqual(
    buildPublicCommunityPollSnapshot({
      active: true,
      title: "Incomplete",
      guildId: "1",
      channelId: "2",
    }),
    { active: false },
  );
});

test("reconciles active and inactive state and retries transient writes", async () => {
  const activeDb = new FakeDb(activeStore("guild-retry", 4));
  activeDb.publicSetFailures = 1;
  const active = await syncPublicCommunityPollSnapshot(activeDb, "guild-retry", {
    maxAttempts: 2,
    baseDelayMs: 0,
  });

  assert.equal(active.active, true);
  assert.equal(active.proposals[0].voteCount, 4);
  assert.equal(activeDb.publicSetAttempts, 2);

  const inactiveDb = new FakeDb();
  const inactive = await syncPublicCommunityPollSnapshot(
    inactiveDb,
    "guild-inactive",
  );
  assert.deepEqual(inactive, { active: false });
  assert.deepEqual(inactiveDb.store.get("site_config/community_poll"), {
    active: false,
  });
});

test("serializes concurrent publications so the newest ranking wins", async () => {
  const guildId = "guild-queue";
  const db = new FakeDb(activeStore(guildId, 1));
  let releaseFirstSet;
  let markFirstSetStarted;
  const firstSetStarted = new Promise((resolve) => {
    markFirstSetStarted = resolve;
  });
  const firstSetGate = new Promise((resolve) => {
    releaseFirstSet = resolve;
  });
  let setIndex = 0;
  db.beforePublicSet = async () => {
    setIndex += 1;
    if (setIndex !== 1) return;
    markFirstSetStarted();
    await firstSetGate;
  };

  const first = queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  await firstSetStarted;
  db.store.get("discord_community_polls/poll-1/proposals/one").voteCount = 9;
  const second = queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  releaseFirstSet();
  await Promise.all([first, second]);

  assert.deepEqual(
    db.publicSetHistory.map((payload) => payload.proposals[0].voteCount),
    [1, 9],
  );
  assert.equal(
    db.store.get("site_config/community_poll").proposals[0].voteCount,
    9,
  );
});

test("mirrors the create, auto-vote, vote move, removal and close lifecycle", async () => {
  const guildId = "guild-lifecycle";
  const db = new FakeDb({
    [`discord_community_poll_state/${guildId}`]: {
      activePollId: "poll-1",
    },
    "discord_community_polls/poll-1": {
      active: true,
      title: "Prochain live",
      description: "Votez sur Discord.",
      guildId,
      channelId: "123456789012345678",
      messageId: "223456789012345678",
    },
  });

  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(db.publicSetHistory.at(-1).proposals, []);

  db.store.set("discord_community_polls/poll-1/proposals/one", {
    name: "Minecraft",
    voteCount: 1,
    authorId: "private-author",
    createdAt: createdAt(1),
  });
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(db.publicSetHistory.at(-1).proposals, [
    { name: "Minecraft", voteCount: 1 },
  ]);

  db.store.get("discord_community_polls/poll-1/proposals/one").voteCount = 0;
  db.store.set("discord_community_polls/poll-1/proposals/two", {
    name: "Phasmophobia",
    voteCount: 2,
    createdAt: createdAt(2),
  });
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(
    db.publicSetHistory.at(-1).proposals.map(({ name, voteCount }) => [
      name,
      voteCount,
    ]),
    [
      ["Phasmophobia", 2],
      ["Minecraft", 0],
    ],
  );

  db.store.get("discord_community_polls/poll-1/proposals/two").voteCount = 1;
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.equal(db.publicSetHistory.at(-1).proposals[0].voteCount, 1);

  db.store.get(`discord_community_poll_state/${guildId}`).activePollId = null;
  db.store.get("discord_community_polls/poll-1").active = false;
  await queuePublicCommunityPollSync(db, guildId, { baseDelayMs: 0 });
  assert.deepEqual(db.publicSetHistory.at(-1), { active: false });
});

test("event registration performs startup reconciliation", async () => {
  const guildId = "guild-startup";
  const db = new FakeDb(activeStore(guildId, 3));
  const client = {
    listeners: [],
    on(event, handler) {
      this.listeners.push({ event, handler });
    },
  };

  await registerCommunityPollEvents({ client, guildId, db });

  assert.equal(client.listeners.length, 1);
  assert.equal(db.store.get("site_config/community_poll").active, true);
  assert.equal(
    db.store.get("site_config/community_poll").proposals[0].voteCount,
    3,
  );
});

test("all authoritative poll mutations publish the public mirror", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../script/communityPoll.js"),
    "utf8",
  );

  for (const context of [
    "after create",
    "after proposal",
    "after vote",
    "after close",
    "startup",
  ]) {
    assert.match(source, new RegExp(`publishPublicCommunityPollBestEffort\\([\\s\\S]*?${context}`));
  }
});

test("publishes and records the final result before deleting poll messages, then pins it", async () => {
  const f = await closureFixture();
  f.channel.beforeSend = () => {
    assert.equal(f.db.store.get(f.pollPath).active, false);
    assert.equal(f.channel.messageStore.has(f.main.id), true);
    assert.equal(f.channel.messageStore.has(f.proposalMessages[0].id), true);
  };
  f.db.beforeUpdate = (ref, fields) => {
    if (fields.resultMessageId) assert.equal(f.channel.messageStore.has(f.main.id), true);
  };

  const interaction = await f.close();
  const result = f.channel.sent[0];
  const poll = f.db.store.get(f.pollPath);
  assert.deepEqual(interaction.deferOptions, { ephemeral: true });
  assert.equal(f.channel.sent.length, 1);
  assert.equal(result.payload.embeds[0].color, 0xf1c40f);
  assert.match(result.payload.embeds[0].title, /Résultats.*Quel jeu/);
  assert.match(result.payload.embeds[0].description, /\*\*Minecraft\*\*[\s\S]*\*\*5 votes\*\*/);
  assert.match(result.payload.embeds[0].fields[0].value, /🥇.*Minecraft[\s\S]*🥈.*Phasmophobia[\s\S]*🥉.*Stardew Valley/);
  assert.deepEqual(result.payload.components, []);
  assert.deepEqual(result.payload.allowedMentions, { parse: [] });
  assert.equal(result.pinned, true);
  assert.equal(poll.active, false);
  assert.equal(poll.status, "closed");
  assert.equal(poll.closedBy, "moderator");
  assert.equal(poll.resultMessageId, result.id);
  assert.ok(poll.resultPublishedAt instanceof Date);
  assert.equal(poll.resultPinned, true);
  assert.equal(poll.messageId, f.main.id);
  assert.equal(poll.pinned, false);
  assert.ok(poll.messageDeletedAt instanceof Date);
  assert.equal(f.channel.messageStore.has(f.main.id), false);
  assert.deepEqual(
    f.calls.filter((call) => call.action === "delete").map((call) => call.id),
    [f.main.id, ...f.proposalMessages.map((message) => message.id)],
  );
  assert.equal(f.calls[0].action, "send");
  assert.deepEqual(f.calls.at(-1), { action: "pin", id: result.id });
  assert.equal(f.channel.messageStore.has(f.unrelated.id), true);
  assert.equal(f.archived.pinned, true);
  assert.deepEqual(f.db.store.get("discord_community_polls/archived"), {
    active: false, messageId: "archived",
  });
  assert.deepEqual(f.db.store.get(`${f.pollPath}/votes/member`), { proposalIds: ["one"] });
  assert.equal(f.db.store.get(`${f.pollPath}/proposals/one`).voteCount, 5);
  assert.equal(f.db.store.get(`${f.pollPath}/proposals/one`).messageId, null);
  assert.ok(f.db.store.get(`${f.pollPath}/proposals/one`).messageDeletedAt instanceof Date);
  assert.deepEqual(f.db.store.get("site_config/community_poll"), { active: false });
  assert.equal(f.db.store.get("discord_community_poll_state/guild-closure").activePollId, null);
  assert.equal(f.db.store.get("discord_community_poll_state/guild-closure").lastPollId, "poll-1");
  assert.match(interaction.reply, new RegExp(`https://discord.com/channels/guild-closure/${f.channel.id}/${result.id}`));
  assert.match(interaction.reply, /résultat est épinglé/);
  assert.doesNotMatch(interaction.reply, /⚠️/);
});

test("closing from another channel still publishes in the original poll channel", async () => {
  const f = await closureFixture();
  await f.close(f.makeInteraction(f.commandChannel));
  assert.equal(f.channel.sent.length, 1);
  assert.equal(f.commandChannel.sent.length, 0);
  assert.equal(f.channel.sent[0].pinned, true);
});

test("shows tied leaders fairly with stable ordering and shared podium ranks", () => {
  const embed = buildFinalResultEmbed({ title: "Prochain live" }, [
    proposalDoc("late", { name: "Late tie", voteCount: 8, createdAt: createdAt(20) }),
    proposalDoc("third", { name: "Third", voteCount: 3, createdAt: createdAt(1) }),
    proposalDoc("early", { name: "Early tie", voteCount: 8, createdAt: createdAt(10) }),
  ]).toJSON();
  assert.match(embed.description, /Égalité en tête — 2 propositions/);
  assert.match(embed.description, /8 votes chacune/);
  assert.match(embed.description, /Early tie[\s\S]*Late tie/);
  assert.doesNotMatch(embed.description, /Proposition gagnante/);
  assert.match(embed.fields[0].value, /🥇.*Early tie.*\n🥇.*Late tie.*\n🥉.*Third/);
});

test("publishes a clear pinned result when no proposals were added", async () => {
  const f = await closureFixture();
  for (const id of ["one", "two", "three"]) f.db.store.delete(`${f.pollPath}/proposals/${id}`);
  await f.close();
  const result = f.channel.sent[0];
  assert.equal(result.pinned, true);
  assert.match(result.payload.embeds[0].description, /Aucune proposition n'a été ajoutée/);
  assert.equal(result.payload.embeds[0].fields, undefined);
  assert.doesNotMatch(result.payload.embeds[0].description, /premier à participer/);
});

test("does not declare a winner when every proposal has zero votes", () => {
  const embed = buildFinalResultEmbed({}, [
    proposalDoc("one", { name: "No votes", voteCount: 0 }),
    proposalDoc("two", { name: "Also no votes", voteCount: 0 }),
  ]).toJSON();
  assert.match(embed.description, /Aucun vote n'a été enregistré/);
  assert.doesNotMatch(embed.description, /gagnante|Égalité/);
  assert.match(embed.fields[0].value, /No votes/);
});

test("limits long results to ten entries while respecting every Discord embed length", () => {
  const proposals = Array.from({ length: 25 }, (_, index) => proposalDoc(String(index), {
    name: `Choice ${String(index).padStart(2, "0")} **\n${"*_".repeat(150)}`,
    voteCount: 9,
    createdAt: createdAt(index + 1),
  }));
  const embed = buildFinalResultEmbed({ title: "Title ".repeat(100) }, proposals).toJSON();
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.fields.every((field) => field.value.length <= 1024));
  assert.ok(embed.fields.length > 1);
  const ranking = embed.fields.map((field) => field.value).join("\n");
  assert.equal(ranking.split("\n").length, 10);
  assert.match(ranking, /Choice 09/);
  assert.doesNotMatch(ranking, /Choice 10/);
  assert.match(embed.description, /Égalité en tête — 25 propositions/);
  assert.match(embed.description, /15 autres propositions ex æquo/);
  assert.match(ranking, /\\\*/);
  const totalLength = embed.title.length + embed.description.length + embed.footer.text.length
    + embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  assert.ok(totalLength <= 6000);
});

test("keeps and closes the old message if public result publication fails", async () => {
  const f = await closureFixture();
  f.channel.sendError = discordError(50013);
  const interaction = await f.close();
  assert.equal(f.channel.sent.length, 0);
  assert.equal(f.channel.messageStore.has(f.main.id), true);
  assert.equal(f.main.pinned, false);
  assert.deepEqual(f.main.payload.components, []);
  assert.match(f.main.payload.embeds[0].description, /Proposition gagnante/);
  assert.equal(f.db.store.get(f.pollPath).active, false);
  assert.equal(f.db.store.get(f.pollPath).resultMessageId, undefined);
  assert.equal(f.db.store.get(f.pollPath).messageDeletedAt, undefined);
  assert.ok(f.proposalMessages.every((message) => !f.channel.messageStore.has(message.id)));
  assert.match(interaction.reply, /résultat n'a pas pu être publié/);
  assert.doesNotMatch(interaction.reply, /Voir le résultat/);
});

test("reports fallback edit failures and rejects votes after a failed publication", async () => {
  const f = await closureFixture();
  f.channel.sendError = discordError(50013);
  f.main.editError = discordError(50013);
  const interaction = await f.close();
  assert.match(interaction.reply, /boutons peuvent rester visibles/);
  assert.equal(f.channel.messageStore.has(f.main.id), true);
  const voteInteraction = f.makeInteraction();
  voteInteraction.isChatInputCommand = () => false;
  voteInteraction.isButton = () => true;
  voteInteraction.customId = "community_poll:vote:poll-1:one";
  await f.close(voteInteraction);
  assert.match(voteInteraction.reply, /déjà terminé/);
  assert.equal(f.db.store.get(`${f.pollPath}/proposals/one`).voteCount, 5);
});

test("closes and unpins the original message when its deletion is refused", async () => {
  const f = await closureFixture();
  f.main.deleteError = discordError(50013);
  const interaction = await f.close();
  assert.equal(f.channel.messageStore.has(f.main.id), true);
  assert.equal(f.main.pinned, false);
  assert.deepEqual(f.main.payload.components, []);
  assert.equal(f.channel.sent[0].pinned, true);
  assert.equal(f.db.store.get(f.pollPath).messageDeletedAt, undefined);
  assert.match(interaction.reply, /ancien message du sondage n'a pas pu être supprimé/);
});

test("disables proposal buttons when a proposal cannot be deleted", async () => {
  const f = await closureFixture();
  const remaining = f.proposalMessages[0];
  remaining.deleteError = discordError(50013);
  const interaction = await f.close();
  assert.equal(f.channel.messageStore.has(remaining.id), true);
  assert.equal(remaining.payload.components[0].components[0].disabled, true);
  assert.match(remaining.payload.embeds[0].footer.text, /Vote terminé/);
  assert.equal(f.channel.sent[0].pinned, true);
  assert.match(interaction.reply, /1 message de proposition n'a pas pu être supprimé/);
});

test("accepts already missing original and proposal messages without cleanup warnings", async () => {
  const f = await closureFixture();
  f.channel.messageStore.delete(f.main.id);
  f.channel.messageStore.delete(f.proposalMessages[0].id);
  const interaction = await f.close();
  assert.ok(f.db.store.get(f.pollPath).messageDeletedAt instanceof Date);
  assert.equal(f.db.store.get(`${f.pollPath}/proposals/one`).messageId, null);
  assert.equal(f.channel.sent[0].pinned, true);
  assert.doesNotMatch(interaction.reply, /⚠️/);
});

test("treats messages disappearing during deletion as successful cleanup", async () => {
  const f = await closureFixture();
  f.main.deleteError = discordError(10008);
  f.proposalMessages[0].deleteError = discordError(10008);
  const interaction = await f.close();
  assert.ok(f.db.store.get(f.pollPath).messageDeletedAt instanceof Date);
  assert.equal(f.db.store.get(`${f.pollPath}/proposals/one`).messageId, null);
  assert.doesNotMatch(interaction.reply, /⚠️/);
});

test("does not mark inaccessible messages as deleted", async () => {
  const f = await closureFixture();
  f.channel.fetchErrors.set(f.main.id, discordError(50013));
  f.channel.fetchErrors.set(f.proposalMessages[0].id, discordError(50013));
  const interaction = await f.close();
  assert.equal(f.db.store.get(f.pollPath).messageDeletedAt, undefined);
  assert.equal(f.db.store.get(`${f.pollPath}/proposals/one`).messageId, f.proposalMessages[0].id);
  assert.equal(f.channel.messageStore.has(f.main.id), true);
  assert.match(interaction.reply, /ancien message du sondage n'a pas pu être supprimé/);
  assert.match(interaction.reply, /1 message de proposition n'a pas pu être supprimé/);
  assert.equal(f.channel.sent[0].pinned, true);
});

test("keeps the public result and its link when pinning fails", async () => {
  const f = await closureFixture();
  f.channel.resultPinError = discordError(50013);
  const interaction = await f.close();
  const result = f.channel.sent[0];
  assert.equal(f.channel.messageStore.has(result.id), true);
  assert.equal(result.pinned, false);
  assert.equal(f.db.store.get(f.pollPath).resultMessageId, result.id);
  assert.equal(f.db.store.get(f.pollPath).resultPinned, false);
  assert.match(interaction.reply, /Voir le résultat/);
  assert.match(interaction.reply, /résultat est publié, mais je n'ai pas pu l'épingler/);
  assert.doesNotMatch(interaction.reply, /résultat est épinglé/);
});

test("simultaneous and repeated closures only publish one result", async () => {
  const f = await closureFixture();
  const replies = await Promise.all([f.close(), f.close()]);
  await f.close();
  assert.equal(f.channel.sent.length, 1);
  assert.equal(f.calls.filter((call) => call.action === "delete").length, 4);
  assert.equal(replies.filter((interaction) => /Voir le résultat/.test(interaction.reply)).length, 1);
  assert.ok(replies.some((interaction) => /déjà terminé|Aucun sondage/.test(interaction.reply)));
});

test("does not republish or modify previously closed polls", async () => {
  const f = await closureFixture();
  const poll = f.db.store.get(f.pollPath);
  poll.active = false;
  poll.status = "closed";
  f.db.store.get("discord_community_poll_state/guild-closure").activePollId = null;
  const interaction = await f.close();
  assert.equal(f.channel.sent.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.main.pinned, true);
  assert.equal(f.db.store.get(f.pollPath).resultMessageId, undefined);
  assert.match(interaction.reply, /Aucun sondage communautaire n'est actuellement actif/);
});

test("keeps the original if the new result reference cannot be persisted", async () => {
  const f = await closureFixture();
  f.db.beforeUpdate = (ref, fields) => {
    if (fields.resultMessageId) throw new Error("metadata unavailable");
  };
  const interaction = await f.close();
  assert.equal(f.channel.sent.length, 1);
  assert.equal(f.channel.sent[0].pinned, true);
  assert.equal(f.channel.messageStore.has(f.main.id), true);
  assert.deepEqual(f.main.payload.components, []);
  assert.equal(f.db.store.get(f.pollPath).messageDeletedAt, undefined);
  assert.match(interaction.reply, /informations.*n'ont pas pu être enregistrées/);
});

test("reports audit failures after deleting the old message without losing the result", async () => {
  const f = await closureFixture();
  f.db.beforeUpdate = (ref, fields) => {
    if (ref.path === f.pollPath && fields.messageDeletedAt) throw new Error("metadata unavailable");
  };
  const interaction = await f.close();
  assert.equal(f.channel.messageStore.has(f.main.id), false);
  assert.equal(f.db.store.get(f.pollPath).resultPinned, true);
  assert.equal(f.db.store.get(f.pollPath).resultMessageId, f.channel.sent[0].id);
  assert.match(interaction.reply, /informations.*n'ont pas pu être enregistrées/);
});

test("a vote refresh delayed until after closure cannot reactivate remaining controls", async () => {
  const f = await closureFixture();
  f.main.deleteError = discordError(50013);
  f.proposalMessages[0].deleteError = discordError(50013);
  let markVoteCommitted;
  let releaseVote;
  const committed = new Promise((resolve) => { markVoteCommitted = resolve; });
  const gate = new Promise((resolve) => { releaseVote = resolve; });
  const runTransaction = f.db.runTransaction.bind(f.db);
  let pauseNextTransaction = true;
  f.db.runTransaction = async (callback) => {
    const result = await runTransaction(callback);
    if (pauseNextTransaction) {
      pauseNextTransaction = false;
      markVoteCommitted();
      await gate;
    }
    return result;
  };
  const voteInteraction = f.makeInteraction();
  voteInteraction.isChatInputCommand = () => false;
  voteInteraction.isButton = () => true;
  voteInteraction.customId = "community_poll:vote:poll-1:one";
  const pendingVote = f.close(voteInteraction);
  await committed;
  try {
    await f.close();
  } finally {
    releaseVote();
  }
  await pendingVote;
  assert.deepEqual(f.main.payload.components, []);
  assert.match(f.main.payload.embeds[0].description, /Proposition gagnante/);
  assert.equal(f.proposalMessages[0].payload.components[0].components[0].disabled, true);
  assert.equal(f.db.store.get(`${f.pollPath}/proposals/one`).voteCount, 6);
  assert.match(f.channel.sent[0].payload.embeds[0].description, /6 votes/);
  assert.deepEqual(f.db.store.get("site_config/community_poll"), { active: false });
});

test("an inaccessible poll channel leaves existing messages and closes the poll", async () => {
  const f = await closureFixture();
  f.client.channels.fetch = async () => null;
  const interaction = await f.close(f.makeInteraction(f.commandChannel));
  assert.equal(f.channel.sent.length, 0);
  assert.equal(f.commandChannel.sent.length, 0);
  assert.equal(f.db.store.get(f.pollPath).active, false);
  assert.equal(f.channel.messageStore.has(f.main.id), true);
  assert.equal(f.db.store.get(f.pollPath).messageDeletedAt, undefined);
  assert.match(interaction.reply, /résultat n'a pas pu être publié/);
  assert.match(interaction.reply, /3 messages de proposition n'ont pas pu être supprimés/);
});
