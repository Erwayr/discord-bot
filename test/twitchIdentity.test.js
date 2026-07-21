"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TwitchIdentityConflictError,
  createTwitchIdentityResolver,
} = require("../script/twitchIdentity");

function createFakeDb(seed = {}) {
  const values = new Map(Object.entries(seed));

  function snapshot(path, id) {
    const exists = values.has(path);
    return {
      id,
      exists,
      data: () => (exists ? values.get(path) : undefined),
      ref: docRef(path),
    };
  }

  function docRef(path) {
    const id = path.split("/").at(-1);
    return {
      id,
      path,
      get: async () => snapshot(path, id),
      set: async (data, options = {}) => {
        values.set(path, options.merge ? { ...(values.get(path) || {}), ...data } : data);
      },
    };
  }

  function collection(name) {
    return {
      doc: (id) => docRef(`${name}/${id}`),
      where: (field, op, expected) => ({
        get: async () => {
          assert.equal(op, "==");
          const docs = [];
          for (const [path, data] of values.entries()) {
            if (!path.startsWith(`${name}/`) || path.split("/").length !== 2) continue;
            if (data?.[field] === expected) docs.push(snapshot(path, path.split("/")[1]));
          }
          return { docs, empty: docs.length === 0, size: docs.length };
        },
      }),
    };
  }

  return {
    collection,
    value: (path) => values.get(path),
    has: (path) => values.has(path),
  };
}

test("chat/presence writes keep using the canonical profile during a rename", async () => {
  const db = createFakeDb({
    "followers_all_time/old_login": {
      pseudo: "old_login",
      twitch_id: "stable-1",
    },
  });
  const resolve = createTwitchIdentityResolver(db, { logger: { warn() {} } });
  const result = await resolve({
    login: "new_login",
    twitchUserId: "stable-1",
    allowCreate: true,
  });

  assert.equal(result.login, "old_login");
  assert.equal(result.status, "rename_pending");
  assert.equal(db.has("followers_all_time/new_login"), false);
  assert.deepEqual(
    {
      currentLogin: db.value("twitch_identities/stable-1").currentLogin,
      observedLogin: db.value("twitch_identities/stable-1").observedLogin,
      status: db.value("twitch_identities/stable-1").status,
    },
    {
      currentLogin: "old_login",
      observedLogin: "new_login",
      status: "rename_pending",
    },
  );
});

test("an active registry returns the current login without creating a duplicate", async () => {
  const db = createFakeDb({
    "followers_all_time/current_login": {
      pseudo: "current_login",
      twitch_id: "stable-2",
    },
    "twitch_identities/stable-2": {
      twitchUserId: "stable-2",
      currentLogin: "current_login",
      observedLogin: "current_login",
      previousLogins: ["old_login"],
      status: "active",
      createdAt: 1,
    },
  });
  const resolve = createTwitchIdentityResolver(db);
  const result = await resolve({ login: "current_login", twitchUserId: "stable-2" });
  assert.equal(result.login, "current_login");
  assert.equal(result.status, "active");
  assert.equal(db.has("followers_all_time/old_login"), false);
});

test("ambiguous histories are marked conflict and blocked", async () => {
  const db = createFakeDb({
    "followers_all_time/login_a": { twitch_id: "stable-3" },
    "followers_all_time/login_b": { twitch_id: "stable-3" },
    "followers_all_time/login_c": { twitch_id: "stable-3" },
  });
  const resolve = createTwitchIdentityResolver(db);
  await assert.rejects(
    resolve({ login: "login_c", twitchUserId: "stable-3" }),
    (error) => error instanceof TwitchIdentityConflictError &&
      error.code === "ambiguous_twitch_identity",
  );
  assert.equal(db.value("twitch_identities/stable-3").status, "conflict");
});
