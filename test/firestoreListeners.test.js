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
