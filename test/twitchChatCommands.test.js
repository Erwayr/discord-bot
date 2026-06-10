"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildTwitchCommandResponse,
  createTwitchChatCommands,
  parseTwitchChatCommand,
} = require("../script/twitchChatCommands");

class FakeSnapshot {
  constructor(data) {
    this._data = data;
    this.exists = !!data;
  }

  data() {
    return this._data;
  }
}

class FakeDb {
  constructor(docs = {}) {
    this.docs = docs;
    this.reads = [];
  }

  collection(name) {
    assert.equal(name, "followers_all_time");
    return {
      doc: (id) => ({
        get: async () => {
          this.reads.push(id);
          return new FakeSnapshot(this.docs[id] || null);
        },
      }),
    };
  }
}

test("parses Twitch community command aliases", () => {
  const cases = [
    ["!lvl", "level"],
    ["!level", "level"],
    ["!niveau", "level"],
    ["!rank", "rank"],
    ["!rang", "rank"],
    ["!uptime", "uptime"],
    ["!watchtime", "uptime"],
    [" !Lvl ignored-target ", "level"],
  ];

  for (const [message, type] of cases) {
    assert.equal(parseTwitchChatCommand(message)?.type, type);
  }
  assert.equal(parseTwitchChatCommand("hello !lvl"), null);
});

test("formats level command from communityLevel data first", async () => {
  const db = new FakeDb({
    alice: {
      communityLevel: {
        level: 42,
        rank: 12,
        rankName: "Maitre du cosmos",
        xpTotal: 1234,
        xpInLevel: 34,
        xpForNext: 200,
      },
      wizebotLevel: 10,
      wizebotRankName: "Legacy",
      wizebotExp: 99,
    },
  });

  const response = await buildTwitchCommandResponse({
    db,
    login: "alice",
    displayName: "Alice",
    type: "level",
  });

  assert.match(response, /^@Alice Niveau 42 - Maitre du cosmos - XP /);
  assert.match(response, /1.?234/);
  assert.match(response, /\(34\/200\)$/);
});

test("falls back to legacy wizebot fields", async () => {
  const db = new FakeDb({
    alice: {
      wizebotLevel: 12,
      wizebotRank: 3,
      wizebotRankName: "Ancien rang",
      wizebotExp: 999,
    },
  });

  const levelResponse = await buildTwitchCommandResponse({
    db,
    login: "alice",
    displayName: "Alice",
    type: "level",
  });
  const rankResponse = await buildTwitchCommandResponse({
    db,
    login: "alice",
    displayName: "Alice",
    type: "rank",
  });

  assert.match(levelResponse, /^@Alice Niveau 12 - Ancien rang - XP 999/);
  assert.equal(rankResponse, "@Alice #3 au classement communautaire - Niveau 12");
});

test("formats uptime from communityLevel before legacy fallback", async () => {
  const db = new FakeDb({
    alice: {
      communityLevel: { uptimeText: "120h", uptimeMinutes: 60 },
      wizebotUptime: "2h",
    },
    bob: {
      wizebotUptime: "45h",
    },
    charlie: {
      communityLevel: { uptimeMinutes: 95 },
    },
  });

  assert.equal(
    await buildTwitchCommandResponse({
      db,
      login: "alice",
      displayName: "Alice",
      type: "uptime",
    }),
    "@Alice Uptime communautaire: 120h",
  );
  assert.equal(
    await buildTwitchCommandResponse({
      db,
      login: "bob",
      displayName: "Bob",
      type: "uptime",
    }),
    "@Bob Uptime communautaire: 45h",
  );
  assert.equal(
    await buildTwitchCommandResponse({
      db,
      login: "charlie",
      displayName: "Charlie",
      type: "uptime",
    }),
    "@Charlie Uptime communautaire: 1h 35m",
  );
});

test("returns missing profile and missing value messages", async () => {
  const db = new FakeDb({
    bob: { communityLevel: { level: 4 } },
  });

  assert.equal(
    await buildTwitchCommandResponse({
      db,
      login: "alice",
      displayName: "Alice",
      type: "level",
    }),
    "@Alice Profil introuvable pour le moment.",
  );
  assert.equal(
    await buildTwitchCommandResponse({
      db,
      login: "bob",
      displayName: "Bob",
      type: "uptime",
    }),
    "@Bob Uptime non disponible pour le moment.",
  );
});

test("applies per-user and global Twitch command cooldowns", async () => {
  const db = new FakeDb({
    alice: { communityLevel: { level: 1, rank: 1, xpTotal: 5 } },
    bob: { communityLevel: { level: 2, rank: 2, xpTotal: 10 } },
  });
  const sent = [];
  let now = 1000;
  const commands = createTwitchChatCommands({
    db,
    config: { userCooldownMs: 10_000, globalCooldownMs: 2_000 },
    sendTwitchChatMessage: async (message) => sent.push(message),
    now: () => now,
  });

  assert.equal(
    (await commands.handleMessage({
      login: "alice",
      displayName: "Alice",
      message: "!lvl",
    })).responded,
    true,
  );
  assert.equal(
    (await commands.handleMessage({
      login: "alice",
      displayName: "Alice",
      message: "!lvl",
    })).reason,
    "user_cooldown",
  );

  now = 2500;
  assert.equal(
    (await commands.handleMessage({
      login: "bob",
      displayName: "Bob",
      message: "!rank",
    })).reason,
    "global_cooldown",
  );

  now = 11_001;
  assert.equal(
    (await commands.handleMessage({
      login: "alice",
      displayName: "Alice",
      message: "!lvl",
    })).responded,
    true,
  );
  assert.equal(sent.length, 2);
});

test("ignores target arguments and reads only the sender profile", async () => {
  const db = new FakeDb({
    alice: { communityLevel: { level: 42, xpTotal: 1234 } },
    bob: { communityLevel: { level: 1, xpTotal: 1 } },
  });
  const sent = [];
  const commands = createTwitchChatCommands({
    db,
    config: { userCooldownMs: 0, globalCooldownMs: 0 },
    sendTwitchChatMessage: async (message) => sent.push(message),
    now: () => 1000,
  });

  await commands.handleMessage({
    login: "alice",
    displayName: "Alice",
    message: "!lvl bob",
  });

  assert.deepEqual(db.reads, ["alice"]);
  assert.match(sent[0], /^@Alice Niveau 42/);
});
