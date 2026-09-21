"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { HALLOWEEN_2026_EVENT: event, hasHalloween2026Grant } = require("../script/seasonal-cosmetics.shared.cjs");
const { qualifyingPresenceMs, buildHalloweenPresencePatch } = require("../script/seasonalPresenceRewards");
const { createLivePresenceTicker } = require("../script/livePresenceTracker");
const { createLiveActivityBuffer } = require("../script/liveActivityBuffer");

test("Halloween 2026 uses Paris midnight boundaries across the DST change", () => {
  assert.equal(qualifyingPresenceMs(Date.parse("2026-10-23T21:59:59.999Z")), 0);
  assert.equal(qualifyingPresenceMs(Date.parse("2026-10-23T22:00:00.000Z")), event.startsAtMs);
  assert.equal(qualifyingPresenceMs(Date.parse("2026-11-07T22:59:59.999Z")), event.endsAtMs - 1);
  assert.equal(qualifyingPresenceMs(Date.parse("2026-11-07T23:00:00.000Z")), 0);
  assert.equal(qualifyingPresenceMs(Date.parse("2025-10-31T12:00:00.000Z")), 0);
  assert.equal(qualifyingPresenceMs(Date.parse("2027-10-31T12:00:00.000Z")), 0);
});

test("permanent Halloween grant adds both possessions without replacing wallet or equipment", () => {
  const profile = {
    pops: { balance: 999 },
    customProfileFrameClass: "old-frame",
    popsShop: {
      weaponSkins: { owned: { sword: { id: "sword" } } },
      profileFrames: { activeId: "old-frame", owned: { old: { id: "old" } } },
      experienceBars: { activeId: "old-bar", owned: { old: { id: "old" } } },
    },
  };
  const before = JSON.stringify(profile);
  const patch = buildHalloweenPresencePatch(profile, event.startsAtMs, event.endsAtMs + 1);
  assert.equal(JSON.stringify(profile), before);
  const granted = { ...profile, ...patch };
  assert.ok(hasHalloween2026Grant(granted, "profile-frame"));
  assert.ok(hasHalloween2026Grant(granted, "experience-bar"));
  assert.equal(granted.pops.balance, 999);
  assert.equal(granted.popsShop.profileFrames.activeId, "old-frame");
  assert.equal(granted.popsShop.experienceBars.activeId, "old-bar");
  assert.deepEqual(granted.popsShop.weaponSkins, profile.popsShop.weaponSkins);
  assert.deepEqual(granted.popsShop.profileFrames.owned.old, { id: "old" });
  assert.deepEqual(buildHalloweenPresencePatch(granted, event.startsAtMs + 1, event.endsAtMs + 2), {});
  assert.deepEqual(buildHalloweenPresencePatch(profile, event.endsAtMs, event.endsAtMs + 2), {});
});

test("seasonal contract matches the canonical site module when both checkouts exist", (t) => {
  const canonical = path.resolve(__dirname, "../../ErwayrWebSite/functions/seasonal-cosmetics.shared.cjs");
  if (!fs.existsSync(canonical)) return t.skip("standalone bot checkout; canonical site module unavailable");
  assert.equal(fs.readFileSync(path.resolve(__dirname, "../script/seasonal-cosmetics.shared.cjs"), "utf8"), fs.readFileSync(canonical, "utf8"));
});

test("ticker journals a later in-window tick while ordinary presence remains deduplicated", async () => {
  let nowMs = event.startsAtMs - 1;
  const directCalls = [];
  const flushCalls = [];
  const questStore = {
    notePresence: async (...args) => directCalls.push(args),
    noteLiveActivity: async (...args) => { flushCalls.push(args); return { applied: true }; },
  };
  const ticker = createLivePresenceTicker({
    db: {}, tokenManager: {}, clientId: "client", broadcasterId: "channel", moderatorId: "mod",
    questStore, deferPresenceWrites: false, now: () => nowMs,
    helixClient: async ({ url }) => ({ data: { data: url.endsWith("/streams")
      ? [{ id: "crossing", started_at: new Date(event.startsAtMs - 60_000).toISOString() }]
      : [{ user_login: "alice", user_id: "123" }] } }),
  });
  const buffer = createLiveActivityBuffer({ questStore, flushMode: "interval" });
  ticker.setPresenceObservationHandler(buffer.notePresenceObservation);
  await ticker();
  assert.equal(buffer.pendingSize(), 0);
  nowMs = event.startsAtMs + 1;
  await ticker();
  assert.equal(directCalls.length, 1);
  assert.equal(buffer.pendingSnapshot()[0].seasonalPresenceAtMs, nowMs);
  nowMs = event.endsAtMs + 1;
  await buffer.flush({ reason: "delayed-interval" });
  assert.equal(flushCalls[0][2].seasonalPresenceAtMs, event.startsAtMs + 1);
  assert.equal(flushCalls[0][2].uptimeMs, 0);
});
