"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Evaluate only shutdown wiring; importing index.js would start the real bot.
const entry = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
const shutdownSource = entry.slice(entry.indexOf("let shuttingDown = false;"), entry.indexOf('process.once("SIGINT"'));

function fixture(stopGames) {
  const calls = [];
  const deadlines = [];
  const module = { exports: {} };
  vm.runInNewContext(`${shutdownSource}\nmodule.exports = shutdown;`, {
    module,
    console: { log() {}, error(...parts) { calls.push(["error", ...parts]); } },
    process: { exit: (code) => calls.push(["exit", code]) },
    setTimeout: (callback, ms) => { deadlines.push({ callback, ms }); return { unref() {} }; },
    server: { close(callback) { calls.push(["server-close"]); callback(); } },
    discordGameTracker: { stop() { calls.push(["games-flush"]); return stopGames(); } },
    twitchChat: {
      stopLiveChestDraws: () => calls.push(["chests-stop"]),
      stopGuardianLive: () => calls.push(["guardian-stop"]),
      stopLiveActivityBuffer: () => calls.push(["buffer-stop"]),
      shouldFlushLiveActivityOnShutdown: () => true,
      flushLiveActivity: () => calls.push(["twitch-flush"]),
    },
  });
  return { shutdown: module.exports, calls, deadlines };
}

test("a stalled game shutdown cannot delay stopping Twitch producers or its flush", async () => {
  let releaseGames;
  const f = fixture(() => new Promise((resolve) => { releaseGames = resolve; }));
  const pending = f.shutdown("SIGTERM");
  await Promise.resolve();
  assert.deepEqual(f.calls.map(([name]) => name), [
    "chests-stop", "guardian-stop", "buffer-stop", "games-flush", "twitch-flush",
  ]);
  assert.equal(f.deadlines[0].ms, 5000);
  assert.equal(f.calls.some(([name]) => name === "server-close"), false);
  releaseGames();
  await pending;
  assert.equal(f.calls.some(([name]) => name === "server-close"), true);
});

test("a rejected game flush does not skip Twitch flush or repeat shutdown", async () => {
  const f = fixture(() => { throw new Error("game persistence unavailable"); });
  await f.shutdown("SIGTERM");
  await f.shutdown("SIGINT");
  assert.equal(f.calls.filter(([name]) => name === "twitch-flush").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "server-close").length, 1);
  assert.ok(f.calls.some(([name, message]) => name === "error" && message.includes("Discord games")));
});
