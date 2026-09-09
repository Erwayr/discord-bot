"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { createFirestoreListeners } = require("../app/firestoreListeners");

test("registerFirestoreListeners does not listen to followers by default", () => {
  const listenedCollections = [];
  const db = {
    collection(name) {
      return {
        onSnapshot() {
          listenedCollections.push(name);
        },
      };
    },
  };

  const listeners = createFirestoreListeners({
    db,
    admin: { firestore: { FieldValue: {} } },
    config: {
      firestore: { enableListener: true },
      discord: { announcementChannelId: "announcements" },
    },
    postDiscord: async () => {},
    sendTwitchChatMessage: async () => {},
  });

  listeners.registerFirestoreListeners();
  assert.deepEqual(listenedCollections, ["gagnants"]);
});

test("the optional follower listener uses the shared transactional queue", () => {
  const callbacks = new Map();
  const queued = [];
  const followerRef = { path: "followers_all_time/alice" };
  const listeners = createFirestoreListeners({
    db: { collection: (name) => ({ onSnapshot: (callback) => callbacks.set(name, callback) }) },
    config: { firestore: { enableListener: true, enableFollowerListener: true } },
    birthdays: { handleFollowerChanges() {} },
    cardNotifications: { enqueueFollowerDoc: async (ref) => { queued.push(ref); } },
  });
  listeners.registerFirestoreListeners();
  callbacks.get("followers_all_time")({ docChanges: () => [{
    type: "modified",
    doc: { ref: followerRef, data: () => ({ discord_id: "123", cards_generated: [{ id: "a" }] }) },
  }] });
  assert.deepEqual(queued, [followerRef]);
});
