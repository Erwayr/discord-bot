"use strict";

console.log("🟢 Démarrage du bot...");

require("dotenv").config();

const express = require("express");
const { makeHelix } = require("./helper/helix");
const { createClipPoller } = require("./script/clipPoller");
const { createLivePresenceTicker } = require("./script/livePresenceTracker");
const { createQuestStorage } = require("./script/questStorage");
const { createTokenManager } = require("./script/tokenManager");
const { createWeeklyFollowersRecap } = require("./script/weeklyFollowersRecap");
const {
  createWeeklyPlanningPublisher,
} = require("./script/weeklyPlanningPublisher");
const { createBirthdayService } = require("./app/birthdays");
const config = require("./app/config");
const { createDiscordClient } = require("./app/discordClient");
const {
  createDiscordMessaging,
  formatClipDiscordMessage,
} = require("./app/discordMessaging");
const {
  loginDiscordClient,
  registerDiscordEvents,
} = require("./app/discordEvents");
const { createFirebase } = require("./app/firebase");
const { createFirestoreListeners } = require("./app/firestoreListeners");
const { createAuthHealth, mountHttpRoutes } = require("./app/httpRoutes");
const { createJobs } = require("./app/jobs");
const { createTwitchChat } = require("./app/twitchChat");
const { createTwitchEventSub } = require("./app/twitchEventSub");

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

const { admin, db } = createFirebase({
  preferRest: config.firestore.preferRest,
});

const client = createDiscordClient();
const { postDiscord, sendDMOrFallback } = createDiscordMessaging({
  client,
  logChannelId: config.discord.logChannelId,
});

const questStore = createQuestStorage(db);
const tokenManager = createTokenManager(db, {
  docPath: config.twitch.tokenDocPath,
});
const helix = makeHelix({
  tokenManager,
  clientId: config.twitch.clientId,
});

const livePresenceTick = createLivePresenceTicker({
  db,
  tokenManager,
  clientId: config.twitch.clientId,
  broadcasterId: config.twitch.channelId,
  moderatorId: config.twitch.moderatorId,
  questStore,
});

const pollClipsTick = createClipPoller({
  tokenManager,
  questStore,
  livePresenceTick,
  clientId: config.twitch.clientId,
  broadcasterId: config.twitch.channelId,
  onNewClip: async (clip) => {
    const message = formatClipDiscordMessage(clip);
    await postDiscord(config.discord.clipChannelId, message);
  },
});

const sendWeeklyFollowersRecap = createWeeklyFollowersRecap({
  db,
  client,
  defaultChannelId: config.discord.announcementChannelId,
  timeZone: config.timezone,
  limit: 10,
  excludedLogins: config.weeklyRecap.excludedLogins,
  questBonusPct: config.weeklyRecap.bonusPct,
  rankRewards: config.weeklyRecap.rankRewards,
  headerText: "✨ Meilleurs Loulou de la semaine passee ✨",
});

const weeklyPlanningPublisher = createWeeklyPlanningPublisher({
  db,
  admin,
  client,
  config,
  defaultReviewChannelId: config.planning.reviewChannelId,
  defaultPublicChannelId: config.planning.publicChannelId,
  timeZone: config.timezone,
});

const birthdays = createBirthdayService({ db, admin, config });
const twitchChat = createTwitchChat({
  config,
  helix,
  tokenManager,
  questStore,
  livePresenceTick,
  birthdays,
});

const authHealth = createAuthHealth({
  client,
  tokenManager,
  config,
  postDiscord,
});

const twitchEventSub = createTwitchEventSub({
  db,
  client,
  config,
  tokenManager,
  questStore,
  livePresenceTick,
  postDiscord,
});

const jobs = createJobs({
  db,
  admin,
  client,
  config,
  livePresenceTick,
  pollClipsTick,
  sendWeeklyFollowersRecap,
  weeklyPlanningPublisher,
  authHealth,
  birthdays,
  twitchChat,
});

const firestoreListeners = createFirestoreListeners({
  db,
  admin,
  config,
  birthdays,
  sendDMOrFallback,
  postDiscord,
  sendTwitchChatMessage: twitchChat.sendTwitchChatMessage,
});

const app = express();
mountHttpRoutes({
  app,
  db,
  config,
  authHealth,
  twitchEventSub,
});

registerDiscordEvents({
  client,
  db,
  config,
  tokenManager,
  twitchEventSub,
  jobs,
  firestoreListeners,
  sendWeeklyFollowersRecap,
  weeklyPlanningPublisher,
  birthdays,
});

jobs.scheduleCoreJobs();
twitchChat.start();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Express server listening on port ${PORT}`);
});

loginDiscordClient({
  client,
  token: config.discord.botToken,
});
