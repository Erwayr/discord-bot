// ./script/manageRedemption.js
const axios = require("axios");
const { FieldValue } = require("firebase-admin/firestore");

const MAX_IDS = 50;

/** PATCH Twitch: FULFILLED/CANCELED pour 1..n redemptions */
async function updateRedemptionStatus({
  broadcasterId,
  rewardId,
  redemptionIds,
  status,
  accessToken,
}) {
  if (!Array.isArray(redemptionIds) || redemptionIds.length === 0) return;
  for (let i = 0; i < redemptionIds.length; i += MAX_IDS) {
    const chunk = redemptionIds.slice(i, i + MAX_IDS);
    const q = chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    const url =
      `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?` +
      `broadcaster_id=${broadcasterId}&reward_id=${rewardId}&${q}`;

    await axios.patch(
      url,
      { status },
      {
        headers: {
          "Client-ID": process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${accessToken}`, // user token avec channel:manage:redemptions
          "Content-Type": "application/json",
        },
      }
    );
  }
}

/** Upsert participants/{login} à partir d’un event redemption.add */
async function upsertParticipantFromRedemption(db, r) {
  if (!r || typeof r !== "object")
    throw new Error("payload redemption invalide");
  const login = (r.user_login || r.user?.login || "").toLowerCase();
  if (!login) return;

  const partRef = db.collection("participants").doc(login);
  const follRef = db.collection("followers_all_time").doc(login);

  await db.runTransaction(async (tx) => {
    const [partSnap, follSnap] = await Promise.all([
      tx.get(partRef),
      tx.get(follRef),
    ]);
    const existing = partSnap.exists ? partSnap.data() : {};
    const foll = follSnap.exists ? follSnap.data() : {};

    const nowISO = new Date().toISOString();
    const update = {
      pseudo: login,
      display_name: r.user_name ?? existing.display_name,
      twitch_id: r.user_id ?? existing.twitch_id,
      hasRedemption: true,
      fetched_at: nowISO,
    };

    const backfill = (key, ...cands) => {
      if (existing[key] != null) return;
      for (const c of cands) {
        if (foll[c] != null) {
          update[key] = foll[c];
          break;
        }
      }
    };
    backfill("avatar", "avatar", "avatar_url", "profile_image_url");
    backfill("discord_id", "discord_id");
    backfill("isSub", "isSub");
    backfill("subCheckedAt", "subCheckedAt");
    backfill("wizebotExp", "wizebotExp");
    backfill("wizebotLevel", "wizebotLevel");
    backfill("wizebotRank", "wizebotRank");
    backfill("wizebotRankName", "wizebotRankName");
    backfill("wizebotUptime", "wizebotUptime");
    backfill("wizebotUptimeRank", "wizebotUptimeRank");

    tx.set(partRef, update, { merge: true });
  });
}

module.exports = { updateRedemptionStatus, upsertParticipantFromRedemption };
