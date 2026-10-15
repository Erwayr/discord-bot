"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGuardianLive } = require("../script/guardianLive");
const { createMemoryFirestore } = require("./helpers/live-chest-firestore.cjs");
const { buildTwitchHelpResponse } = require("../script/twitchChatCommands");
const {
  chatReaction,
  chatMessageText,
  actionDuration,
  ARRIVAL_MS,
  TRAVEL_MS,
} = require("../script/guardian-actions.shared.cjs");
const {
  publishGuardianChat,
  pollGuardianLive,
  readElectedGuardian,
} = require("../script/guardian-live.store.cjs");
const {
  freshState,
  cleanState,
  applyGuardianChat,
  guardianChatPresentation,
  APPEARANCE_MS,
  COOLDOWN_MS,
} = require("../script/guardian-live.shared.cjs");
test("new facial cosmetics survive a viewer passage and retain its prepared snapshot", async () => {
  const {
    DEFAULT_CHARACTER,
  } = require("../script/guardian-character.shared.cjs");
  const {
    enqueueGuardianViewer,
  } = require("../script/guardian-live.store.cjs");
  const now = 1000000,
    db = createMemoryFirestore();
  const character = {
    ...DEFAULT_CHARACTER,
    body: "feminine",
    face: "heart",
    eyes: "upturned",
    nose: "aquiline",
    mouth: "full",
    eyebrows: "arched",
    ears: "elf",
    facialHair: "goatee",
    freckles: "dense",
    scar: "cheek",
    facePaint: "runes",
    facePaintColor: "teal",
  };
  db.documents.set("followers_all_time/viewer", {
    twitch_id: "42",
    pseudo: "Viewer",
    communityLevel: { level: 0 },
    currentGuardian: { title: "minimoys", character },
  });
  db.documents.set("guardian_live_channels/123", {
    ...freshState("live", now),
    initialized: true,
    guardianUntilMs: now,
    liveUntilMs: now + 90000,
    liveCheckedAtMs: now,
  });
  assert.equal(
    (
      await enqueueGuardianViewer({
        db,
        channelId: "123",
        streamId: "live",
        now,
        request: {
          requestId: "face",
          userId: "42",
          login: "viewer",
          displayName: "Viewer",
        },
      })
    ).accepted,
    true,
  );
  assert.deepEqual(
    (await pollGuardianLive({ db, channelId: "123", now })).viewer.character,
    character,
  );
  assert.equal(
    (await pollGuardianLive({ db, channelId: "123", now })).viewer.level,
    0,
  );
  db.documents.get("followers_all_time/viewer").currentGuardian.character = {
    ...DEFAULT_CHARACTER,
  };
  db.documents.get("followers_all_time/viewer").communityLevel.level = 200;
  assert.deepEqual(
    (await pollGuardianLive({ db, channelId: "123", now: now + 5000 })).viewer
      .character,
    character,
  );
  assert.equal(
    (await pollGuardianLive({ db, channelId: "123", now: now + 5000 })).viewer
      .level,
    0,
    "prepared level is held until the viewer leaves",
  );
});
test("Pops forms come from canonical progress and prepared !perso forms survive upgrades", async () => {
  const { db, app } = chatFixture();
  const profile = db.documents.get("followers_all_time/renamed");
  profile.communityLevel = { level: 200 };
  profile.currentGuardian = {
    character: { weapon: "staff", weaponSkin: "staff-royal" },
  };
  profile.popsShop = {
    weaponSkins: {
      owned: { "staff-royal": { id: "staff-royal", price: 2500 } },
      progress: {},
    },
  };
  assert.equal(
    (await readElectedGuardian({ db })).weaponForm,
    1,
    "legacy skins do not evolve with community level",
  );
  const progress = {
    schemaVersion: 1,
    form: 2,
    invested: 100,
    target: 5000,
    totalInvested: 2600,
    revision: 2,
  };
  profile.popsShop.weaponSkins.progress["staff-royal"] = progress;
  profile.communityLevel.level = 0;
  assert.equal((await readElectedGuardian({ db })).weaponForm, 2);
  await app.tick();
  await pollGuardianLive({ db, channelId: "123", now: 1000000 });
  const {
    enqueueGuardianViewer,
  } = require("../script/guardian-live.store.cjs");
  await enqueueGuardianViewer({
    db,
    channelId: "123",
    streamId: "live",
    now: 1000000,
    request: {
      requestId: "paid-form",
      userId: "42",
      login: "renamed",
      displayName: "Viewer",
    },
  });
  const started = await pollGuardianLive({
    db,
    channelId: "123",
    now: 1006000,
  });
  assert.equal(started.viewer.weaponForm, 2);
  profile.popsShop.weaponSkins.progress["staff-royal"] = {
    ...progress,
    form: 4,
    invested: 0,
    target: null,
    totalInvested: 17500,
    revision: 4,
  };
  assert.equal((await readElectedGuardian({ db })).weaponForm, 4);
  const resumed = await pollGuardianLive({
    db,
    channelId: "123",
    now: 1007000,
  });
  assert.equal(resumed.viewer.weaponForm, 2);
  assert.deepEqual(resumed.viewer, started.viewer);
  assert(!JSON.stringify(resumed).includes("totalInvested"));
});

test("chosen lower forms are used by the elected guardian and prepared viewer passages", async () => {
  const { db, app } = chatFixture();
  const profile = db.documents.get("followers_all_time/renamed");
  profile.currentGuardian = {
    character: { weapon: "staff", weaponSkin: "staff-royal" },
    weaponForm: 1,
  };
  profile.popsShop = {
    weaponSkins: {
      owned: { "staff-royal": { id: "staff-royal" } },
      progress: {
        "staff-royal": {
          schemaVersion: 1,
          form: 4,
          invested: 0,
          target: null,
          totalInvested: 17500,
          revision: 3,
        },
      },
    },
  };
  assert.equal((await readElectedGuardian({ db })).weaponForm, 1);
  await app.tick();
  await pollGuardianLive({ db, channelId: "123", now: 1000000 });
  const {
    enqueueGuardianViewer,
  } = require("../script/guardian-live.store.cjs");
  await enqueueGuardianViewer({
    db,
    channelId: "123",
    streamId: "live",
    now: 1000000,
    request: {
      requestId: "chosen-form",
      userId: "42",
      login: "renamed",
      displayName: "Viewer",
    },
  });
  const started = await pollGuardianLive({
    db,
    channelId: "123",
    now: 1006000,
  });
  assert.equal(started.viewer.weaponForm, 1);
  profile.currentGuardian.weaponForm = 3;
  assert.equal((await readElectedGuardian({ db })).weaponForm, 3);
  assert.equal(
    (await pollGuardianLive({ db, channelId: "123", now: 1007000 })).viewer
      .weaponForm,
    1,
    "an active passage keeps its prepared form",
  );
  assert(!JSON.stringify(started.viewer).includes("totalInvested"));
});

test("!perso accepts the Twitch author, resolves canonical login and is listed in help", async () => {
  const db = createMemoryFirestore();
  const messages = [];
  const app = createGuardianLive({
    db,
    channelId: "123",
    now: () => 1000000,
    getLiveState: async () => ({ streamId: "live" }),
    resolveTwitchIdentity: async ({ twitchUserId, login }) => {
      assert.equal(twitchUserId, "42");
      assert.equal(login, "newname");
      return { login: "canonical" };
    },
    sendMessage: async (message) => messages.push(message),
  });
  assert.equal(
    (await app.handleMessage({ message: "hello", login: "viewer" })).handled,
    false,
  );
  assert.equal(
    (await app.handleMessage({ message: "!perso other_user", login: "viewer" }))
      .handled,
    false,
  );
  const result = await app.handleMessage({
    message: " !PeRsO ",
    login: "newname",
    displayName: "NewName",
    tags: { "user-id": "42", id: "message42" },
  });
  assert.equal(result.accepted, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /position 1/);
  assert.match(
    messages[0],
    /1 min 30 \(hors animations d’entrée et de sortie\)/u,
  );
  assert.equal(
    db.documents.get("guardian_live_channels/123").queue[0].login,
    "canonical",
  );
  assert.match(
    buildTwitchHelpResponse(),
    /!perso[^|]*1 min 30 hors animations d’entrée et de sortie, toutes les 10 min/u,
  );
});

test("!perso keeps 90 seconds between arrival and departure, survives lease refreshes and retains its ten-minute cooldown", async () => {
  const initial = 1000000,
    db = createMemoryFirestore();
  let time = initial;
  db.documents.set("guardian_live_channels/123", {
    ...freshState("live", initial),
    initialized: true,
    guardianUntilMs: initial,
  });
  const app = createGuardianLive({
    db,
    channelId: "123",
    now: () => time,
    getLiveState: async () => ({ streamId: "live" }),
    sendMessage: async () => {},
  });
  const summon = (id) =>
    app.handleMessage({
      message: "!perso",
      login: "viewer",
      tags: { "user-id": "42", id },
    });
  const poll = () => pollGuardianLive({ db, channelId: "123", now: time });

  assert.equal((await summon("first")).accepted, true);
  const started = await poll();
  assert.equal(started.kind, "viewer");
  assert.equal(
    started.startsAtMs,
    initial + TRAVEL_MS,
    "the previous Guardian leaves before the viewer enters",
  );
  assert.equal(started.endsAtMs - started.startsAtMs, 97000);
  const settledAt = started.startsAtMs + ARRIVAL_MS;
  const departureAt = started.endsAtMs - TRAVEL_MS;
  assert.equal(
    departureAt - settledAt,
    90000,
    "entry and exit do not consume the ninety-second stay",
  );
  const initialLease = db.documents.get(
    "guardian_live_channels/123",
  ).liveUntilMs;

  for (const elapsed of [30000, 60000, 90000]) {
    time = initial + elapsed;
    await app.tick();
    const ongoing = await poll();
    assert.equal(ongoing.kind, "viewer");
    assert.equal(ongoing.appearanceId, started.appearanceId);
    assert.equal(
      ongoing.endsAtMs,
      started.endsAtMs,
      "heartbeats preserve the scheduled end",
    );
  }
  time = initialLease + 1;
  assert.equal(
    (await poll()).kind,
    "viewer",
    "the active passage survives beyond its original live lease",
  );
  assert.ok(db.documents.get("guardian_live_channels/123").liveUntilMs > time);
  time = departureAt - 1;
  assert.equal((await poll()).kind, "viewer");
  time = started.endsAtMs - 1;
  assert.equal(
    (await poll()).kind,
    "viewer",
    "the viewer remains active through the exit animation",
  );
  time = started.endsAtMs;
  assert.equal((await poll()).kind, "guardian");

  assert.equal(COOLDOWN_MS, 600000);
  time = initial + 599999;
  const refused = await summon("too-soon");
  assert.equal(refused.reason, "cooldown");
  assert.equal(refused.retryAfterMs, 1);
  assert.equal(
    db.documents.get("guardian_live_channels/123/viewers/42").lastAcceptedAtMs,
    initial,
  );
  time = initial + 600000;
  assert.equal((await summon("ready")).accepted, true);
});
test("offline calls are rejected without consuming cooldown, missing Twitch identity does not enqueue", async () => {
  const db = createMemoryFirestore();
  const messages = [];
  const app = createGuardianLive({
    db,
    channelId: "123",
    now: () => 1000000,
    getLiveState: async () => ({}),
    sendMessage: async (m) => messages.push(m),
  });
  assert.equal(
    (await app.handleMessage({ message: "!perso", login: "viewer", tags: {} }))
      .reason,
    "identity_missing",
  );
  assert.equal(
    (
      await app.handleMessage({
        message: "!perso",
        login: "viewer",
        tags: { "user-id": "42" },
      })
    ).reason,
    "offline",
  );
  assert.equal(db.writes.length, 0);
  assert.match(messages[0], /pendant les lives/);
});

test("a delayed identity lookup cannot re-open the previous stream", async () => {
  const db = createMemoryFirestore();
  let time = 1000000;
  let streamId = "old";
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const app = createGuardianLive({
    db,
    channelId: "123",
    now: () => time,
    getLiveState: async () => ({ streamId }),
    sendMessage: async () => {},
    resolveTwitchIdentity: async () => {
      await gate;
      return { login: "viewer" };
    },
  });
  const pending = app.handleMessage({
    message: "!perso",
    login: "viewer",
    tags: { "user-id": "42" },
  });
  await Promise.resolve();
  time += 1000;
  streamId = "new";
  await app.tick();
  release();
  assert.equal((await pending).reason, "offline");
  assert.equal(db.documents.get("guardian_live_channels/123").streamId, "new");
  assert.equal(
    db.documents.has("guardian_live_channels/123/viewers/42"),
    false,
  );
});

test("a temporary service failure receives an explanation without spending cooldown", async () => {
  const db = createMemoryFirestore();
  const messages = [];
  const app = createGuardianLive({
    db,
    channelId: "123",
    now: () => 1000000,
    getLiveState: async () => {
      throw new Error("network_unavailable");
    },
    sendMessage: async (m) => messages.push(m),
    logger: { warn() {} },
  });
  assert.equal(
    (
      await app.handleMessage({
        message: "!perso",
        login: "viewer",
        tags: { "user-id": "42" },
      })
    ).reason,
    "unavailable",
  );
  assert.equal(db.writes.length, 0);
  assert.match(messages[0], /indisponible/);
});

function chatFixture() {
  const db = createMemoryFirestore({
    "elections/winner": {
      endedAt: 999000,
      winnerId: "discord42",
      winnerInfo: { pseudo: "oldname", twitch_id: "42" },
    },
    "twitch_identities/42": { currentLogin: "renamed", status: "active" },
    "followers_all_time/renamed": { twitch_id: "42", discord_id: "discord42" },
  });
  let time = 1000000;
  const messages = [],
    warnings = [];
  const app = createGuardianLive({
    db,
    channelId: "123",
    now: () => time,
    getLiveState: async () => ({ streamId: "live" }),
    sendMessage: async (text) => messages.push(text),
    logger: { warn: (...args) => warnings.push(args) },
  });
  const chat = (userId, id, sentAt = time, message = "Je suis là !") =>
    app.handleMessage({
      message,
      login: "same_display_name",
      tags: { "user-id": userId, id, "tmi-sent-ts": String(sentAt) },
    });
  return {
    db,
    app,
    chat,
    messages,
    warnings,
    advance: (value) => {
      time += value;
    },
  };
}

test("weapon skins survive elected Guardian reads, queued appearances and reconnects without exposing purchases", async () => {
  const { db, app } = chatFixture();
  const profile = db.documents.get("followers_all_time/renamed");
  profile.communityLevel = { level: 0 };
  profile.currentGuardian = {
    character: { weapon: "staff", weaponSkin: "staff-royal" },
  };
  profile.popsShop = {
    weaponSkins: {
      owned: { "staff-royal": { id: "staff-royal", price: 2500 } },
    },
  };
  const guardian = await readElectedGuardian({ db });
  assert.equal(guardian.character.weaponSkin, "staff-royal");
  assert.equal(guardian.level, 0);
  for (const level of [49, 50, 99, 100, 199, 200, 250, 0]) {
    profile.communityLevel.level = level;
    assert.equal(
      (await readElectedGuardian({ db })).level,
      level,
      "Elected Guardian level follows the canonical profile",
    );
  }
  assert.equal(guardian.popsShop, undefined);
  await app.tick();
  await pollGuardianLive({ db, channelId: "123", now: 1000000 });
  const {
    enqueueGuardianViewer,
  } = require("../script/guardian-live.store.cjs");
  const queued = await enqueueGuardianViewer({
    db,
    channelId: "123",
    streamId: "live",
    now: 1000000,
    request: {
      requestId: "skin-preview",
      userId: "42",
      login: "renamed",
      displayName: "Viewer",
    },
  });
  assert.equal(queued.accepted, true);
  const started = await pollGuardianLive({
    db,
    channelId: "123",
    now: 1006000,
  });
  assert.equal(started.viewer.character.weaponSkin, "staff-royal");
  const resumed = await pollGuardianLive({
    db,
    channelId: "123",
    now: 1007000,
  });
  assert.deepEqual(resumed.viewer, started.viewer);
  assert.equal(resumed.startsAtMs, started.startsAtMs);
  assert(!JSON.stringify(resumed).includes("owned"));
});

test("all sixty acquired skins remain visible at level zero after purchase tier changes", async () => {
  const {
    WEAPON_SKINS,
  } = require("../script/guardian-weapon-skins.shared.cjs");
  const additions = WEAPON_SKINS.filter((skin) => skin.variant !== undefined);
  assert.equal(additions.length, 60);
  for (const skin of additions) {
    const { db } = chatFixture();
    const profile = db.documents.get("followers_all_time/renamed");
    profile.communityLevel = { level: 0 };
    profile.currentGuardian = {
      character: { weapon: skin.weapon, weaponSkin: skin.id },
    };
    profile.popsShop = {
      weaponSkins: { owned: { [skin.id]: { id: skin.id, price: 2500 } } },
    };
    const guardian = await readElectedGuardian({ db });
    assert.equal(guardian.character.weaponSkin, skin.id);
    assert.equal(guardian.character.weapon, skin.weapon);
    assert.equal(guardian.popsShop, undefined);
  }
});

test("all four classic weapon types remain visible in public Guardian reads at level zero", async () => {
  for (const weapon of ["sword", "bow", "hammer", "staff"]) {
    const { db } = chatFixture(),
      profile = db.documents.get("followers_all_time/renamed");
    profile.communityLevel = { level: 0 };
    profile.currentGuardian = { character: { weapon, weaponSkin: "classic" } };
    const guardian = await readElectedGuardian({ db });
    assert.equal(guardian.character.weapon, weapon);
    assert.equal(guardian.character.weaponSkin, "classic");
  }
});

test("regular Guardian messages greet by stable Twitch ID without swallowing chat or sending a bot reply", async () => {
  const { db, app, chat, messages, advance } = chatFixture();
  await app.tick();
  const writes = db.writes.length;
  assert.equal((await chat("99", "impostor")).handled, false);
  assert.equal(db.writes.length, writes);
  assert.equal((await chat("42", "greeting")).handled, false);
  const first = structuredClone(
    db.documents.get("guardian_live_channels/123").chatAction,
  );
  assert.equal(first.type, "greet");
  assert.equal(first.endsAtMs - first.startsAtMs, 4000);
  await chat("42", "greeting");
  advance(1000);
  await chat("42", "burst");
  assert.deepEqual(
    db.documents.get("guardian_live_channels/123").chatAction,
    first,
  );
  advance(4000);
  await chat("42", "next-greeting");
  assert.equal(
    db.documents.get("guardian_live_channels/123").chatAction.id,
    "next-greeting",
  );
  assert.deepEqual(messages, []);
  assert.ok(
    db.writes.every(
      (path) =>
        path === "guardian_live_channels/123" ||
        path === "overlay_state_signals/guardian",
    ),
  );
});

test("delayed or replayed Twitch messages do not produce greetings after reconnect", async () => {
  const { db, app, chat } = chatFixture();
  await app.tick();
  const writes = db.writes.length;
  await chat("42", "old-message", 991999);
  await chat("42", "future-message", 1003000);
  await chat("", "anonymous");
  assert.equal(db.writes.length, writes);
  await chat("42", "current-message", 999000);
  assert.equal(
    db.documents.get("guardian_live_channels/123").chatAction.id,
    "current-message",
  );
});

test("cached Guardian identity never authorizes a greeting after a new election", async () => {
  const { db, app, chat, advance } = chatFixture();
  await app.tick();
  await chat("42", "first");
  advance(5000);
  db.documents.set("elections/new", {
    endedAt: 1001000,
    winnerId: "discord99",
    winnerInfo: { twitch_id: "99", pseudo: "successor" },
  });
  const writes = db.writes.length;
  await chat("42", "former-guardian");
  assert.equal(
    db.writes.length,
    writes,
    "The transaction revalidates the election despite the bot cache",
  );
  advance(10001);
  await chat("99", "successor");
  assert.equal(
    db.documents.get("guardian_live_channels/123").chatAction.id,
    "successor",
  );
});

test("greeting service errors leave normal chat available", async () => {
  const { db, app, chat, warnings } = chatFixture();
  await app.tick();
  db.collection = () => {
    throw new Error("unavailable");
  };
  assert.equal((await chat("42", "message")).handled, false);
  assert.equal(warnings.length, 1);
});

test("chat keywords match whole Unicode words in message order, excluding commands", () => {
  for (const [text, action] of [
    ["SALUT !", "greet"],
    ["« Coucou »", "greet"],
    ["bonjour…", "greet"],
    ["GG 👏 bravo", "victory"],
    ["Bravo!", "victory"],
    ["Une DANSE ?", "dance"],
    ["party 🎉", "dance"],
    ["Attaque !", "attack"],
    ["à la charge", "attack"],
    ["gg, puis danse et salut", "victory"],
    ["danse, gg", "dance"],
  ])
    assert.equal(chatReaction(text), action, text);
  for (const text of [
    "décharge",
    "surcharge",
    "ggwp",
    "salut",
    "bonjouré",
    "_gg",
    "!danse",
    " /me charge",
    "!perso bravo",
    "constructeur",
  ]) {
    assert.equal(chatReaction(text), null, text);
  }
  const text = chatMessageText("😀".repeat(201));
  assert.equal(Array.from(text).length, 200);
  assert.ok(text.endsWith("…"));
  assert.equal(chatMessageText("  bonjour\n le\tchat  "), "bonjour le chat");
  assert.equal(
    chatMessageText("<img src=x onerror=alert(1)>"),
    "<img src=x onerror=alert(1)>",
  );
});

test("all viewers trigger the visible avatar, with a five-second cooldown and no pending reactions", async () => {
  const { db, app, chat, advance, messages } = chatFixture();
  await app.tick();
  await chat("99", "gg", undefined, "GG !");
  const read = () => db.documents.get("guardian_live_channels/123");
  assert.equal(read().chatAction.type, "victory");
  assert.equal(read().chatBubble, null);
  advance(3300);
  await chat("99", "too-soon", undefined, "attaque");
  assert.equal(read().chatAction, null);
  advance(1700);
  await chat("99", "too-soon", undefined, "attaque");
  assert.equal(
    read().chatAction,
    null,
    "a suppressed message cannot be replayed after cooldown",
  );
  await chat("99", "dance", undefined, "party");
  assert.equal(read().chatAction.type, "dance");
  advance(5000);
  await chat("99", "busy", undefined, "attaque");
  assert.equal(
    read().chatAction.id,
    "dance",
    "a ten-second dance cannot be interrupted after five seconds",
  );
  advance(5000);
  await chat("99", "attack", undefined, "charge");
  assert.equal(read().chatAction.type, "attack");
  assert.equal(
    read().chatAction.endsAtMs - read().chatAction.startsAtMs,
    actionDuration("attack"),
  );
  assert.deepEqual(messages, []);
});

test("concurrent Guardian speech appends during an action, survives transaction retries, and keeps only three lines", async () => {
  const { db, app, chat, advance } = chatFixture();
  await app.tick();
  await chat("99", "dance", undefined, "danse");
  const original = structuredClone(
    db.documents.get("guardian_live_channels/123"),
  );
  db.retryNext(2);
  await Promise.all([
    chat("42", "line1", undefined, "Salut"),
    chat("42", "line2", undefined, "Ça va ?"),
  ]);
  let state = db.documents.get("guardian_live_channels/123");
  assert.deepEqual(
    state.chatBubble.messages.map((item) => item.text),
    ["Salut", "Ça va ?"],
  );
  assert.deepEqual(state.chatAction, original.chatAction);
  advance(1000);
  await chat("42", "line3", undefined, "🎉".repeat(201));
  await chat("42", "line4", undefined, "<img src=x onerror=alert(1)>");
  await chat("42", "line4", undefined, "duplicate");
  state = db.documents.get("guardian_live_channels/123");
  assert.deepEqual(
    state.chatBubble.messages.map((item) => item.id),
    ["line2", "line3", "line4"],
  );
  assert.equal(Array.from(state.chatBubble.messages[1].text).length, 200);
  assert.equal(state.chatBubble.endsAtMs, 1009000);
  assert.equal(state.liveUntilMs, original.liveUntilMs);
  assert.deepEqual(state.queue, original.queue);
  assert.equal(cleanState(state, 1009000).chatBubble, null);
  assert.ok(
    db.writes.every(
      (path) =>
        path === "guardian_live_channels/123" ||
        path === "overlay_state_signals/guardian",
    ),
  );
});

test("a viewer passage reacts to everyone while Guardian speech is dropped through transitions and absence", async () => {
  const { db, app, chat, advance } = chatFixture();
  await app.tick();
  const ref = "guardian_live_channels/123";
  const active = {
    requestId: "visit",
    userId: "99",
    streamId: "live",
    startsAtMs: 1002000,
    endsAtMs: 1002000 + APPEARANCE_MS,
    viewer: { pseudo: "Viewer" },
  };
  db.documents.set(ref, {
    ...db.documents.get(ref),
    initialized: true,
    active,
  });
  await chat("42", "outgoing", undefined, "Bonjour");
  advance(3000);
  await chat("42", "incoming", undefined, "Coucou");
  assert.equal(db.documents.get(ref).chatBubble, null);
  assert.equal(db.documents.get(ref).chatAction, null);
  advance(4000);
  await chat("42", "absent", undefined, "Je suis là !");
  assert.equal(db.documents.get(ref).chatBubble, null);
  await chat("88", "visitor-action", undefined, "bravo");
  const state = db.documents.get(ref);
  assert.equal(state.chatAction.appearanceId, "visit");
  assert.equal(state.chatAction.userId, "99");
  assert.deepEqual(state.active, active);
  const guardian = await readElectedGuardian({ db });
  assert.equal(
    guardianChatPresentation(state, guardian, 1007000).action.type,
    "victory",
  );
  advance(active.endsAtMs - TRAVEL_MS - 1007000);
  await app.tick();
  await chat("42", "leaving", undefined, "GG");
  assert.deepEqual(
    guardianChatPresentation(
      db.documents.get(ref),
      guardian,
      active.endsAtMs - TRAVEL_MS,
    ),
    { action: null, bubble: null },
  );
  const returned = await pollGuardianLive({
    db,
    channelId: "123",
    guardian,
    now: active.endsAtMs,
  });
  assert.equal(returned.kind, "guardian");
  assert.equal(returned.bubble, null);
  assert.equal(returned.action, null);
});

test("late transactions never shorten the bubble deadline and equal timestamps preserve arrival order", async () => {
  const { db, app } = chatFixture();
  await app.tick();
  const post = (messageId, message, time) =>
    publishGuardianChat({
      db,
      channelId: "123",
      streamId: "live",
      userId: "42",
      messageId,
      message,
      now: time,
    });
  await post("z-newer", "Le dernier message", 1002000);
  await post("older", "Le premier message", 1001000);
  await post("a-newer", "Le suivant", 1002000);
  const bubble = db.documents.get("guardian_live_channels/123").chatBubble;
  assert.equal(bubble.endsAtMs, 1010000);
  assert.deepEqual(
    bubble.messages.map((item) => item.id),
    ["older", "z-newer", "a-newer"],
  );
});

test("public cues are synchronized and sanitized, including legacy greetings and a Guardian using !perso", async () => {
  const { db, app, chat } = chatFixture();
  await app.tick();
  await chat("42", "speech", undefined, "bonjour");
  const guardian = await readElectedGuardian({ db });
  const [a, b] = await Promise.all(
    [1, 2].map(() =>
      pollGuardianLive({ db, channelId: "123", guardian, now: 1001000 }),
    ),
  );
  assert.deepEqual(a, b);
  assert.deepEqual(a.bubble, {
    messages: [{ id: "speech", text: "bonjour" }],
    endsAtMs: 1008000,
  });
  assert.deepEqual(Object.keys(a.action).sort(), [
    "endsAtMs",
    "id",
    "startsAtMs",
    "type",
  ]);
  assert.doesNotMatch(
    JSON.stringify({ action: a.action, bubble: a.bubble }),
    /userId|electionId|streamId/,
  );
  const state = db.documents.get("guardian_live_channels/123");
  const legacy = {
    ...state,
    chatGreeting: state.chatAction,
    chatAction: null,
    chatBubble: null,
  };
  assert.equal(
    guardianChatPresentation(legacy, guardian, 1001000).action.type,
    "greet",
  );
  assert.equal(
    guardianChatPresentation(
      legacy,
      { ...guardian, electionId: "successor" },
      1001000,
    ).action,
    null,
  );
  const visiting = {
    ...freshState("live"),
    liveUntilMs: 1090000,
    active: {
      userId: "42",
      requestId: "guardian-visit",
      streamId: "live",
      startsAtMs: 990000,
      endsAtMs: 1050000,
    },
  };
  const result = applyGuardianChat(visiting, {
    guardian,
    streamId: "live",
    userId: "42",
    messageId: "visitor-speech",
    message: "Je suis là",
    now: 1000000,
  });
  assert.equal(
    guardianChatPresentation(result.state, guardian, 1000000).bubble.messages[0]
      .text,
    "Je suis là",
  );
});

test("offline, expired, excluded command and old-election events cannot leak speech into another live", async () => {
  const { db, app, chat, advance } = chatFixture();
  await app.tick();
  await chat("42", "speech");
  const ref = "guardian_live_channels/123";
  const before = structuredClone(db.documents.get(ref));
  await chat("42", "command", undefined, "!lvl bravo");
  assert.deepEqual(db.documents.get(ref), before);
  const guardian = await readElectedGuardian({ db });
  assert.equal(
    guardianChatPresentation(
      before,
      { ...guardian, userId: "99", electionId: "new" },
      1000000,
    ).bubble,
    null,
  );
  assert.equal(
    cleanState({ ...before, liveUntilMs: 1000000 }, 1000000).chatBubble,
    null,
  );
  advance(10000);
  await app.tick();
  assert.equal(
    db.documents.get(ref).chatBubble,
    null,
    "heartbeat cleans expired speech even without an OBS poll",
  );
  const result = await publishGuardianChat({
    db,
    channelId: "123",
    streamId: "old-live",
    userId: "42",
    messageId: "old-live-message",
    message: "bonjour",
    now: 1010000,
  });
  assert.equal(result.reason, "offline");
  assert.equal(db.documents.get(ref).chatBubble, null);
});
