"use strict";

const cron = require("node-cron");
const { commitBatchWithRetry } = require("../helper/firestoreRetry");
const { recalculateCommunityLevelRanks } = require("../script/communityLevel");
const { shortText } = require("./textUtils");
const {
  ensureServerBoosterCardTemplate,
  grantServerBoosterCardsByDiscordIds,
  isServerBoosterMember,
} = require("../script/serverBoosterCards");

function createJobs({
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
  getCommunityLevelConfig,
  cardNotifications,
  githubActions,
}) {
  let announcedStreamId = null;
  let announcedStartedAt = null;
  let offlineStreak = 0;
  let communityLevelRankRefreshPromise = null;

  function isCommunityLevelRankLiveStartRefreshEnabled() {
    return (
      config.communityLevel?.enabled &&
      config.communityLevel?.rankRefreshOnLiveStart !== false
    );
  }

  function isCommunityLevelRankLiveEndRefreshEnabled() {
    return (
      config.communityLevel?.enabled &&
      config.communityLevel?.rankRefreshOnLiveEnd !== false
    );
  }

  async function runCommunityLevelRankRefresh(source) {
    if (!config.communityLevel?.enabled) return null;

    if (communityLevelRankRefreshPromise) {
      console.log(
        `[community-level] rank refresh déjà en cours, skip (${source})`,
      );
      return communityLevelRankRefreshPromise;
    }

    communityLevelRankRefreshPromise = (async () => {
      try {
        console.log(`[community-level] rank refresh run (${source})`);
        return await refreshCommunityLevelRanks();
      } catch (e) {
        console.error(
          "[community-level] rank refresh failed:",
          e?.message || e,
        );
        return null;
      } finally {
        communityLevelRankRefreshPromise = null;
      }
    })();

    return communityLevelRankRefreshPromise;
  }

  async function runCommunityLevelRankRefreshOnLiveStart(streamId) {
    if (!isCommunityLevelRankLiveStartRefreshEnabled()) return null;
    console.log(`[community-level] rank refresh live-start (${streamId})`);
    return runCommunityLevelRankRefresh("live-start");
  }

  async function runCommunityLevelRankRefreshOnLiveEnd(streamId) {
    if (communityLevelRankRefreshPromise) {
      console.log(
        "[community-level] waiting current rank refresh before final live-end run",
      );
      await communityLevelRankRefreshPromise.catch(() => null);
    }

    if (isCommunityLevelRankLiveEndRefreshEnabled()) {
      console.log(`[community-level] rank refresh live-end (${streamId})`);
      await runCommunityLevelRankRefresh("live-end-final");
    }
  }

  async function flushTwitchLiveActivity(reason, options = {}) {
    if (typeof twitchChat?.flushLiveActivity !== "function") return null;
    try {
      const result = await twitchChat.flushLiveActivity({ reason, ...options });
      if (
        Array.isArray(options.uptimeEntries) &&
        typeof livePresenceTick?.clearPendingUptime === "function" &&
        Array.isArray(result?.flushedEntries)
      ) {
        livePresenceTick.clearPendingUptime(result.flushedEntries);
      }
      return result;
    } catch (e) {
      console.error("[live-activity] flush failed:", e?.message || e);
      return null;
    }
  }

  async function flushRestoredStaleLiveActivity(currentStreamId) {
    if (typeof twitchChat?.getPendingLiveActivityStreams !== "function") return;
    const currentId = currentStreamId || "";
    const pendingStreams = twitchChat.getPendingLiveActivityStreams();
    const staleStreams = pendingStreams.filter((streamId) => streamId !== currentId);
    if (!staleStreams.length) return;
    await flushTwitchLiveActivity("stale-stream", { streamIds: staleStreams });
  }

  async function refreshCommunityLevelRanks() {
    const communityLevelConfig =
      typeof getCommunityLevelConfig === "function"
        ? await getCommunityLevelConfig({ refresh: true })
        : config.communityLevel;
    const result = await recalculateCommunityLevelRanks(db, communityLevelConfig);
    if (!result?.skipped) {
      console.log(`[community-level] ranks refreshed (${result.updated} profils)`);
    }
    return result;
  }

  async function dispatchLiveEndGithubActions(streamId) {
    if (typeof githubActions?.dispatchLiveEndWorkflows !== "function") {
      return null;
    }

    try {
      return await githubActions.dispatchLiveEndWorkflows({ streamId });
    } catch (e) {
      console.error(
        "[github-actions] live-end dispatch failed:",
        e?.message || e,
      );
      return null;
    }
  }

  async function assignOldMemberCards() {
    const cardSnap = await db
      .collection("cards_collections")
      .doc("discord_old_member")
      .get();
    if (!cardSnap.exists) {
      console.error('❌ Carte "discord_old_member" introuvable');
      return;
    }
    const oldMemberCard = { id: cardSnap.id, ...cardSnap.data() };

    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const eligibleIds = [];
    for (const guild of client.guilds.cache.values()) {
      let members;
      try {
        members = await guild.members.fetch({
          withPresences: false,
          time: 300_000,
        });
      } catch (e) {
        console.warn(
          `⚠️ members.fetch (assignOldMemberCards) a échoué, fallback cache:`,
          e?.code || e?.message || e,
        );
        members = guild.members.cache;
      }

      members.forEach((m) => {
        if (!m.user.bot && m.joinedTimestamp && m.joinedTimestamp < oneYearAgo) {
          eligibleIds.push(m.id);
        }
      });
    }
    if (eligibleIds.length === 0) return;

    for (let i = 0; i < eligibleIds.length; i += config.batchSize) {
      const chunk = eligibleIds.slice(i, i + config.batchSize);
      const snap = await db
        .collection("followers_all_time")
        .where("discord_id", "in", chunk)
        .get();
      if (snap.empty) continue;

      const batch = db.batch();
      const notifyRefs = [];

      snap.docs.forEach((doc) => {
        const data = doc.data();

        if (data.isAlreadyWinDiscordOldMember) {
          return;
        }

        batch.update(doc.ref, {
          cards_generated: admin.firestore.FieldValue.arrayUnion(oldMemberCard),
          isAlreadyWinDiscordOldMember: true,
        });
        notifyRefs.push(doc.ref);
        console.log(
          `🎉 Carte "discord_old_member" attribuée à ${data.discord_id}`,
        );
      });

      await commitBatchWithRetry(batch, { label: "assign-old-member-cards" });
      notifyRefs.forEach((ref) =>
        cardNotifications?.enqueueFollowerDoc(ref).catch(console.error),
      );
      console.log(`✅ Batch de ${chunk.length} membres traité.`);
    }
  }

  async function fetchGuildMembersForJob(guild, label) {
    try {
      return await guild.members.fetch({
        withPresences: false,
        time: 300_000,
      });
    } catch (e) {
      console.warn(
        `⚠️ members.fetch (${label}) a échoué, fallback cache:`,
        e?.code || e?.message || e,
      );
      return guild.members.cache;
    }
  }

  async function assignServerBoosterCards() {
    const cardTemplate = await ensureServerBoosterCardTemplate(db);
    const boosterMembersById = new Map();
    for (const guild of client.guilds.cache.values()) {
      let guildBoosterCount = 0;
      const members = await fetchGuildMembersForJob(
        guild,
        "assignServerBoosterCards",
      );
      members.forEach((member) => {
        if (isServerBoosterMember(member)) {
          boosterMembersById.set(member.id, member);
          guildBoosterCount += 1;
        }
      });
      console.log(
        `🔎 [assign-server-booster-cards] ${guild.name}: ${guildBoosterCount} booster(s) détecté(s) sur ${members.size} membre(s) chargé(s).`,
      );
    }

    if (boosterMembersById.size === 0) {
      console.log(
        "ℹ️ [assign-server-booster-cards] aucun booster Discord détecté.",
      );
      return;
    }

    const result = await grantServerBoosterCardsByDiscordIds({
      db,
      admin,
      discordIds: [...boosterMembersById.keys()],
      cardTemplate,
      memberById: boosterMembersById,
      batchSize: config.batchSize,
      label: "assign-server-booster-cards",
      onGrantedDoc: (doc) =>
        cardNotifications?.enqueueFollowerDoc(doc.ref).catch(console.error),
    });

    if (result.missing > 0) {
      console.log(
        `ℹ️ [assign-server-booster-cards] ${result.missing} booster(s) sans profil Twitch lié.`,
      );
    }
  }

  async function assignServerBoosterCardForMember(
    member,
    { previousMember = null } = {},
  ) {
    if (!isServerBoosterMember(member)) return;
    if (previousMember && isServerBoosterMember(previousMember)) return;

    const discordId = String(member?.id || "").trim();
    if (!discordId) return;

    const cardTemplate = await ensureServerBoosterCardTemplate(db);
    const result = await grantServerBoosterCardsByDiscordIds({
      db,
      admin,
      discordIds: [discordId],
      cardTemplate,
      memberById: new Map([[discordId, member]]),
      batchSize: 1,
      label: "guild-member-update-server-booster",
      onGrantedDoc: (doc) =>
        cardNotifications?.enqueueFollowerDoc(doc.ref).catch(console.error),
    });

    if (result.missing > 0) {
      console.log(
        `ℹ️ [guild-member-update-server-booster] aucun profil lié pour ${discordId}.`,
      );
    }
  }

  async function refreshAndSendBirthdayAnnouncements({ forceRebuild = false } = {}) {
    await birthdays.refreshTodayBirthdays({ forceRebuild });
    const result = await birthdays.sendDiscordBirthdayAnnouncements({
      client,
      channelId: config.discord.generalChannelId,
    });
    if (result?.sent) {
      console.log(
        `[birthday-discord] annonce envoyée (${result.count} anniversaire(s)) -> ${config.discord.generalChannelId}`,
      );
    }
  }

  function scheduleCoreJobs() {
    cron.schedule(config.cron.pollClips, pollClipsTick);

    cron.schedule(config.cron.tokenKeepalive, async () => {
      try {
        await authHealth.ensureValidUserAccessToken({
          source: "cron:token_keepalive",
        });
      } catch (e) {
        if (e.code === "NO_REFRESH_TOKEN") {
          console.log("⏭️ [keepalive] no refresh_token yet");
        } else {
          console.warn(
            "⚠️ token keep-alive:",
            e?.response?.data || e.message || e,
          );
          await authHealth.notifyAuthIssueToLog({
            source: "cron:token_keepalive",
            code: e?.code || "KEEPALIVE_FAILED",
            status: e?.response?.status || null,
            details: shortText(e?.response?.data || e?.stack || e?.message || e),
          });
        }
      }
    });

    cron.schedule(config.cron.livePresence, async () => {
      try {
        await livePresenceTick();
      } catch (e) {
        console.warn(
          "⚠️ [livePresenceTick] failed:",
          e?.response?.data || e.message || e,
        );
        return;
      }

      const { streamId, startedAt } = livePresenceTick.getLiveStreamState();
      const currentId = streamId || null;

      if (currentId) {
        offlineStreak = 0;
        await flushRestoredStaleLiveActivity(currentId);

        if (announcedStreamId !== currentId) {
          if (announcedStreamId) {
            await flushTwitchLiveActivity("stream-switch", {
              streamId: announcedStreamId,
            });
          }

          announcedStreamId = currentId;
          announcedStartedAt = startedAt || null;

          console.log(
            `🟢 [LIVE] start (streamId=${announcedStreamId}, startedAt=${
              announcedStartedAt ? announcedStartedAt.toISOString() : "-"
            })`,
          );

          await runCommunityLevelRankRefreshOnLiveStart(announcedStreamId).catch(
            (e) =>
              console.error(
                "[community-level] live-start rank refresh failed:",
                e?.message || e,
              ),
          );
        }

        return;
      }

      offlineStreak += 1;
      if (
        !announcedStreamId &&
        offlineStreak >= config.timing.offlineConfirmTicks &&
        typeof twitchChat?.getPendingLiveActivityStreams === "function" &&
        twitchChat.getPendingLiveActivityStreams().length > 0
      ) {
        await flushTwitchLiveActivity("startup-offline");
      }

      if (
        announcedStreamId &&
        offlineStreak === config.timing.offlineConfirmTicks
      ) {
        const endedStreamId = announcedStreamId;
        const endedStartedAt = announcedStartedAt;

        console.log(
          `🔴 [LIVE] end (streamId=${endedStreamId}, startedAt=${
            endedStartedAt ? endedStartedAt.toISOString() : "-"
          })`,
        );

        announcedStreamId = null;
        announcedStartedAt = null;

        const uptimeEntries =
          typeof livePresenceTick.getPendingUptime === "function"
            ? livePresenceTick.getPendingUptime(endedStreamId)
            : [];
        await flushTwitchLiveActivity("live-end", {
          streamId: endedStreamId,
          uptimeEntries,
        });

        if (typeof livePresenceTick.flushStreamUptime === "function") {
          await livePresenceTick
            .flushStreamUptime(endedStreamId, { reason: "live-end" })
            .catch((e) =>
              console.error(
                "[ticker] uptime live-end flush failed:",
                e?.message || e,
              ),
            );
        }

        await runCommunityLevelRankRefreshOnLiveEnd(endedStreamId).catch((e) =>
          console.error(
            "[community-level] final rank refresh failed:",
            e?.message || e,
          ),
        );

        await dispatchLiveEndGithubActions(endedStreamId);
      }
    });

    birthdays.refreshTodayBirthdays().catch(console.error);
    cron.schedule(
      config.cron.birthdayRefresh,
      () =>
        refreshAndSendBirthdayAnnouncements({ forceRebuild: true }).catch(
          console.error,
        ),
      { timezone: config.timezone },
    );

    cron.schedule(config.cron.emoteRefresh, () =>
      twitchChat.refreshChannelEmotesThrottled().catch(console.error),
    );
  }

  async function runClientReadyJobs() {
    await assignOldMemberCards().catch(console.error);
    await assignServerBoosterCards().catch(console.error);
    await refreshAndSendBirthdayAnnouncements().catch(console.error);

    cron.schedule(config.cron.assignOldMemberCards, () =>
      assignOldMemberCards().catch(console.error),
    );
    cron.schedule(config.cron.assignServerBoosterCards, () =>
      assignServerBoosterCards().catch(console.error),
    );

    cron.schedule(
      config.cron.weeklyRecap,
      () =>
        sendWeeklyFollowersRecap({
          channelId: config.discord.announcementChannelId,
          applyRewards: true,
          rangeMode: "previous",
        }).catch((e) =>
          console.error("[weekly-recap] cron failed:", e?.message || e),
        ),
      { timezone: config.timezone },
    );
    console.log(
      `[weekly-recap] scheduled (${config.cron.weeklyRecap}, tz=${config.timezone}) -> ${config.discord.logChannelId}`,
    );

    if (weeklyPlanningPublisher) {
      cron.schedule(
        config.cron.weeklyPlanning,
        () =>
          weeklyPlanningPublisher.schedulePlanningPreview().catch((e) =>
            console.error("[weekly-planning] cron failed:", e?.message || e),
          ),
        { timezone: config.timezone },
      );
      console.log(
        `[weekly-planning] scheduled (${config.cron.weeklyPlanning}, tz=${config.timezone}) -> ${config.planning.reviewChannelId}`,
      );
    }
  }

  return {
    scheduleCoreJobs,
    runClientReadyJobs,
    assignOldMemberCards,
    assignServerBoosterCards,
    assignServerBoosterCardForMember,
    refreshCommunityLevelRanks,
  };
}

module.exports = { createJobs };
