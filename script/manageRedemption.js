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

    const exists = partSnap.exists; // ← ajoute cette ligne
    const existing = exists ? partSnap.data() : {}; // ← utilise-la
    const foll = follSnap.exists ? follSnap.data() : {};

    const nowISO = new Date().toISOString();
    const update = {
      pseudo: login,
      display_name: r.user_name ?? existing.display_name,
      twitch_id: r.user_id ?? existing.twitch_id,
      hasRedemption: true,
      fetched_at: nowISO,
    };

    // ⚖️ logique isSub demandée
    if (!exists) {
      update.isSub = false; // ✅ nouveau participant → isSub=false
    }

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

async function upsertParticipantFromSubscription(db, e) {
  const login = (e.user_login || e.user?.login || "").toLowerCase();
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
      display_name: e.user_name ?? existing.display_name,
      twitch_id: e.user_id ?? existing.twitch_id,
      isSub: true, // ✅ impose sub=true
      subCheckedAt: nowISO,
      fetched_at: nowISO,
    };

    // backfill sans écraser ce qui existe
    const backfill = (key, ...cands) => {
      if (existing[key] != null) return;
      for (const c of cands)
        if (foll[c] != null) {
          update[key] = foll[c];
          break;
        }
    };
    backfill("avatar", "avatar", "avatar_url", "profile_image_url");
    backfill("discord_id", "discord_id");
    backfill("wizebotExp", "wizebotExp");
    backfill("wizebotLevel", "wizebotLevel");
    backfill("wizebotRank", "wizebotRank");
    backfill("wizebotRankName", "wizebotRankName");
    backfill("wizebotUptime", "wizebotUptime");
    backfill("wizebotUptimeRank", "wizebotUptimeRank");

    tx.set(partRef, update, { merge: true });
  });
}

async function upsertFollowerMonthsFromSub(db, e) {
  // e peut venir de "channel.subscribe" ou "channel.subscription.message"
  const login = (e.user_login || e.user?.login || "").toLowerCase();
  if (!login) return;

  // Mois cumulés / durée / série (selon le type d’event, tout n’est pas toujours présent)
  const monthsTotal = Number(
    e.cumulative_months ?? e.duration_months ?? e.streak_months ?? 1
  );
  const monthsStreak =
    e.streak_months != null ? Number(e.streak_months) : undefined;

  // Tier lisible
  const tierMap = { 1000: "Tier 1", 2000: "Tier 2", 3000: "Tier 3" };
  const isPrime = !!e.is_prime || e.tier === "Prime";
  const tierLabel = isPrime ? "Prime" : tierMap[String(e.tier)] || null;

  const ref = db.collection("followers_all_time").doc(login);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : {};

    // On évite de "réduire" la valeur si Twitch nous renvoie moins d’info
    const newTotal = Math.max(
      Number(existing.subMonths || 0),
      isNaN(monthsTotal) ? 0 : monthsTotal
    );

    const update = {
      // champs top-level pour rester homogène avec ta collection
      subMonths: newTotal,
      // si Twitch ne fournit pas streak, on garde l’ancienne valeur
      ...(monthsStreak != null ? { subMonthsStreak: monthsStreak } : {}),
      subTier: tierLabel,
      lastSubAt: new Date().toISOString(),
      lastSubIsGift: !!e.is_gift,
    };

    // Backfill léger s'il manque le pseudo/twitchId (optionnel)
    if (!existing.pseudo) update.pseudo = login;
    if (!existing.twitchId && e.user_id) update.twitchId = e.user_id;

    tx.set(ref, update, { merge: true });
  });
}

module.exports = {
  updateRedemptionStatus,
  upsertParticipantFromRedemption,
  upsertParticipantFromSubscription,
  upsertFollowerMonthsFromSub,
};
