"use strict";

const cron = require("node-cron");
const { commitBatchWithRetry } = require("../helper/firestoreRetry");
const { shortText } = require("./textUtils");

function createJobs({
  db,
  admin,
  client,
  config,
  livePresenceTick,
  pollClipsTick,
  sendWeeklyFollowersRecap,
  authHealth,
  birthdays,
  twitchChat,
}) {
  let announcedStreamId = null;
  let announcedStartedAt = null;
  let offlineStreak = 0;

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

      snap.docs.forEach((doc) => {
        const data = doc.data();

        if (data.isAlreadyWinDiscordOldMember) {
          return;
        }

        batch.update(doc.ref, {
          cards_generated: admin.firestore.FieldValue.arrayUnion(oldMemberCard),
          isAlreadyWinDiscordOldMember: true,
        });
        console.log(
          `🎉 Carte "discord_old_member" attribuée à ${data.discord_id}`,
        );
      });

      await commitBatchWithRetry(batch, { label: "assign-old-member-cards" });
      console.log(`✅ Batch de ${chunk.length} membres traité.`);
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

        if (announcedStreamId !== currentId) {
          announcedStreamId = currentId;
          announcedStartedAt = startedAt || null;

          console.log(
            `🟢 [LIVE] start (streamId=${announcedStreamId}, startedAt=${
              announcedStartedAt ? announcedStartedAt.toISOString() : "-"
            })`,
          );
        }
        return;
      }

      offlineStreak += 1;
      if (
        announcedStreamId &&
        offlineStreak === config.timing.offlineConfirmTicks
      ) {
        console.log(
          `🔴 [LIVE] end (streamId=${announcedStreamId}, startedAt=${
            announcedStartedAt ? announcedStartedAt.toISOString() : "-"
          })`,
        );
        announcedStreamId = null;
        announcedStartedAt = null;
      }
    });

    birthdays.refreshTodayBirthdays().catch(console.error);
    cron.schedule(
      config.cron.birthdayRefresh,
      () => birthdays.refreshTodayBirthdays().catch(console.error),
      { timezone: config.timezone },
    );

    cron.schedule(config.cron.emoteRefresh, () =>
      twitchChat.refreshChannelEmotesThrottled().catch(console.error),
    );
  }

  async function runClientReadyJobs() {
    await assignOldMemberCards().catch(console.error);

    cron.schedule(config.cron.assignOldMemberCards, () =>
      assignOldMemberCards().catch(console.error),
    );

    cron.schedule(
      config.cron.weeklyRecap,
      () =>
        sendWeeklyFollowersRecap({
          channelId: config.discord.announcementChannelId,
        }).catch((e) =>
          console.error("[weekly-recap] cron failed:", e?.message || e),
        ),
      { timezone: config.timezone },
    );
    console.log(
      `[weekly-recap] scheduled (${config.cron.weeklyRecap}, tz=${config.timezone}) -> ${config.discord.logChannelId}`,
    );
  }

  return {
    scheduleCoreJobs,
    runClientReadyJobs,
    assignOldMemberCards,
  };
}

module.exports = { createJobs };
