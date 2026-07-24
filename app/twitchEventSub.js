"use strict";

const axios = require("axios");
const crypto = require("crypto");
const {
  updateRedemptionStatus,
  upsertParticipantFromRedemption,
  upsertParticipantFromSubscription,
  upsertFollowerMonthsFromSub,
} = require("../script/manageRedemption");
const {
  buildCommunityLevelUpMessage,
} = require("../script/twitchLevelAnnouncements");
const {
  isTwitchPollRedemption,
  processTwitchPollRedemption,
} = require("../script/twitchPolls");
const { isExcludedLogin } = require("../helper/excludedUsers");

function normalizeRewardText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019\u2018\u0060\u00b4]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function safeOverlayEventDocId(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140);
  return cleaned || `event_${Date.now()}`;
}

function safeOverlayText(value, maxLength = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function subscriptionMessageTextFromEvent(event) {
  const message = event?.message;
  if (typeof message === "string") return safeOverlayText(message);
  if (message && typeof message === "object") {
    return safeOverlayText(message.text || message.body || message.message || "");
  }
  return safeOverlayText(event?.message_text || event?.messageText || "");
}

function redemptionEventMs(redemption) {
  const parsed = Date.parse(redemption?.redeemed_at || "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isOverlayCardRedemption(redemption, overlayConfig = {}) {
  const reward = redemption?.reward || {};
  const rewardId = String(reward.id || "").trim();
  const expectedId = String(overlayConfig.cardRewardId || "").trim();
  if (expectedId) return rewardId === expectedId;

  const expectedTitle = normalizeRewardText(
    overlayConfig.cardRewardTitle || "ma carte",
  );
  const rewardTitle = normalizeRewardText(reward.title || "");
  return !!expectedTitle && rewardTitle.includes(expectedTitle);
}

function buildOverlayCardRedemptionEvent(redemption, overlayConfig = {}) {
  const eventMs = redemptionEventMs(redemption);
  const login = String(
    redemption?.user_login || redemption?.user_name || "",
  ).toLowerCase();
  return {
    type: overlayConfig.cardEventType || "reward_ma_carte",
    eventMs,
    createdAtMs: Date.now(),
    redeemedAt: redemption?.redeemed_at || null,
    source: "twitch_eventsub",
    login,
    displayName: redemption?.user_name || login,
    rewardId: redemption?.reward?.id || "",
    rewardTitle: redemption?.reward?.title || "",
  };
}

function safePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function subscriptionMonthsFromEvent(event) {
  const months = Number(
    event?.cumulative_months ?? event?.duration_months ?? event?.streak_months,
  );
  return Number.isFinite(months) && months > 0 ? Math.floor(months) : 1;
}

function buildOverlaySubCardEvent(
  event,
  { overlayConfig = {}, twitchEventType = "", deliveryId = "" } = {},
) {
  const eventMs = Date.now();
  const login = String(
    event?.user_login || event?.user?.login || event?.user_name || "",
  ).toLowerCase();
  return {
    type: overlayConfig.subCardEventType || "sub_card",
    eventMs,
    createdAtMs: eventMs,
    source: "twitch_eventsub",
    twitchEventType,
    deliveryId: safeOverlayEventDocId(deliveryId || ""),
    login,
    displayName: event?.user_name || event?.user?.name || login,
    subTier: String(event?.tier || ""),
    isGift: !!event?.is_gift,
    subMonths: subscriptionMonthsFromEvent(event),
    subMessage: subscriptionMessageTextFromEvent(event),
  };
}

function buildOverlayModerationEvent(
  event,
  { overlayConfig = {}, deliveryId = "" } = {},
) {
  const eventMs = Date.now();
  const login = String(event?.user_login || event?.user_name || "").toLowerCase();
  return {
    type: overlayConfig.moderationEventType || "moderation_trash",
    eventMs,
    createdAtMs: eventMs,
    source: "twitch_eventsub",
    twitchEventType: "channel.ban",
    deliveryId: safeOverlayEventDocId(deliveryId || ""),
    login,
    displayName: event?.user_name || login,
    isPermanent: event?.is_permanent === true,
    endsAt: event?.is_permanent === true ? null : event?.ends_at || null,
  };
}

function buildChannelBanSubscriptionPayload(config) {
  return {
    type: "channel.ban",
    version: "1",
    condition: { broadcaster_user_id: config.twitch.channelId },
    transport: {
      method: "webhook",
      callback: config.twitch.eventsubCallback,
      secret: config.twitch.webhookSecret,
    },
  };
}

function createTwitchEventSub({
  db,
  client,
  config,
  tokenManager,
  questStore,
  livePresenceTick,
  postDiscord,
  sendTwitchChatMessage,
  bufferLiveChannelPoints,
  twitchExtensionStatsSync,
  resolveTwitchIdentity,
}) {
  const seenDeliveries = new Map();
  const subTimers = new Map();
  const lastSubNotified = new Map();
  const lastOverlaySubCardPublished = new Map();
  const pendingOverlaySubCards = new Map();

  function cleanupSeenDeliveries() {
    const now = Date.now();
    for (const [k, ts] of seenDeliveries) {
      if (now - ts > 5 * 60_000) seenDeliveries.delete(k);
    }
  }

  function isDuplicateDelivery(req) {
    const id = req.header("Twitch-Eventsub-Message-Id");
    if (!id) return false;
    if (seenDeliveries.has(id)) return true;
    seenDeliveries.set(id, Date.now());
    if (seenDeliveries.size > 2000) cleanupSeenDeliveries();
    return false;
  }

  function verifyTwitchSignature(req) {
    const messageId = req.header("Twitch-Eventsub-Message-Id");
    const timestamp = req.header("Twitch-Eventsub-Message-Timestamp");
    const signature = req.header("Twitch-Eventsub-Message-Signature");
    const body = JSON.stringify(req.body);
    const hmac = crypto.createHmac("sha256", config.twitch.webhookSecret);
    hmac.update(messageId + timestamp + body);
    const expectedSig = `sha256=${hmac.digest("hex")}`;
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig),
      Buffer.from(signature),
    );
  }

  async function fetchAppAccessToken() {
    const { data } = await axios.post(config.urls.oauthToken, null, {
      params: {
        client_id: config.twitch.clientId,
        client_secret: config.twitch.clientSecret,
        grant_type: "client_credentials",
      },
    });
    return data.access_token;
  }

  function buildTwitchHeaders(accessToken, { includeContentType = true } = {}) {
    const headers = {
      "Client-ID": config.twitch.clientId,
      Authorization: `Bearer ${accessToken}`,
    };
    if (includeContentType) headers["Content-Type"] = "application/json";
    return headers;
  }

  function shouldSuppressNow(login) {
    const now = Date.now();
    const last = lastSubNotified.get(login) || 0;
    if (now - last < config.timing.subCooldownMs) return true;
    lastSubNotified.set(login, now);
    return false;
  }

  function scheduleSubscribeNotice(login, buildText) {
    if (subTimers.has(login)) clearTimeout(subTimers.get(login).timer);

    const timer = setTimeout(async () => {
      subTimers.delete(login);
      if (shouldSuppressNow(login)) return;
      try {
        const text = await buildText();
        await postDiscord(config.discord.bootyChannelId, text);
        lastSubNotified.set(login, Date.now());
      } catch (e) {
        console.warn("subscribe notice failed:", e.message);
      }
    }, config.timing.subDebounceMs);

    subTimers.set(login, { timer, startedAt: Date.now() });
  }

  async function sendResubNow(login, buildText) {
    const t = subTimers.get(login);
    if (t) {
      clearTimeout(t.timer);
      subTimers.delete(login);
    }
    if (shouldSuppressNow(login)) return;
    const text = await buildText();
    await postDiscord(config.discord.bootyChannelId, text);
    lastSubNotified.set(login, Date.now());
  }

  function getLoginFromEvent(e) {
    return (e?.user_login || e?.user?.login || "").toLowerCase();
  }

  function getDisplayFromEvent(e, fallbackLogin) {
    return e?.user_name || e?.user?.name || fallbackLogin;
  }

  async function canonicalEvent(event, { allowCreate = false } = {}) {
    const login = getLoginFromEvent(event);
    const twitchUserId = String(event?.user_id || event?.user?.id || "").trim();
    if (!login || !twitchUserId || typeof resolveTwitchIdentity !== "function") {
      return event;
    }
    const identity = await resolveTwitchIdentity({
      login,
      twitchUserId,
      allowCreate,
    });
    return {
      ...event,
      user_login: identity.login,
      user: event?.user && typeof event.user === "object"
        ? { ...event.user, login: identity.login }
        : event?.user,
    };
  }

  function cleanupOverlaySubCardDedupe(dedupeMs) {
    const now = Date.now();
    const maxAge = Math.max(dedupeMs * 4, 5 * 60_000);
    for (const [correlationKey, ts] of lastOverlaySubCardPublished) {
      if (now - ts > maxAge) {
        lastOverlaySubCardPublished.delete(correlationKey);
      }
    }
  }

  function getOverlaySubCardDedupeMs() {
    return safePositiveNumber(
      config.overlay?.subCardDedupeMs,
      safePositiveNumber(config.timing?.overlaySubCardDedupeMs, 10 * 60_000),
    );
  }

  function getOverlaySubCardResubWaitMs() {
    return safePositiveNumber(config.overlay?.subCardResubWaitMs, 60_000);
  }

  function getOverlaySubCardCorrelationKey(event) {
    const twitchUserId = String(event?.user_id || event?.user?.id || "").trim();
    if (twitchUserId) return `id:${twitchUserId}`;
    const login = getLoginFromEvent(event);
    return login ? `login:${login}` : "";
  }

  function markOverlaySubCardForPublish(correlationKey) {
    const dedupeMs = getOverlaySubCardDedupeMs();
    if (!correlationKey || dedupeMs <= 0) return true;

    const now = Date.now();
    const last = lastOverlaySubCardPublished.get(correlationKey) || 0;
    if (now - last < dedupeMs) return false;

    lastOverlaySubCardPublished.set(correlationKey, now);
    if (lastOverlaySubCardPublished.size > 2000) {
      cleanupOverlaySubCardDedupe(dedupeMs);
    }
    return true;
  }

  async function publishOverlayCardRedemptionEvent(redemption) {
    const overlayConfig = config.overlay || {};
    if (!isOverlayCardRedemption(redemption, overlayConfig)) return false;

    const payload = buildOverlayCardRedemptionEvent(redemption, overlayConfig);
    if (!payload.login) return false;

    const collectionName = overlayConfig.eventsCollection || "overlay_events";
    const redemptionId = safeOverlayEventDocId(redemption?.id || "");
    const docId = `${payload.type}_${redemptionId}`;
    await db.collection(collectionName).doc(docId).set(payload, { merge: true });
    console.log(
      `[overlay] Ma carte event published: login=${payload.login} doc=${docId}`,
    );
    return true;
  }

  async function publishOverlaySubCardEvent(event, twitchEventType, deliveryId) {
    const overlayConfig = config.overlay || {};
    const payload = buildOverlaySubCardEvent(event, {
      overlayConfig,
      twitchEventType,
      deliveryId,
    });
    if (!payload.login) return false;
    const correlationKey =
      getOverlaySubCardCorrelationKey(event) || `login:${payload.login}`;
    if (!markOverlaySubCardForPublish(correlationKey)) {
      console.log(
        `[overlay] Sub card event deduped: login=${payload.login} type=${twitchEventType}`,
      );
      return false;
    }

    const collectionName = overlayConfig.eventsCollection || "overlay_events";
    const eventKey = safeOverlayEventDocId(
      deliveryId ||
        `${twitchEventType}_${payload.login}_${payload.eventMs}`,
    );
    const docId = `${payload.type}_${eventKey}`;
    try {
      await db.collection(collectionName).doc(docId).set(payload, { merge: true });
    } catch (error) {
      lastOverlaySubCardPublished.delete(correlationKey);
      throw error;
    }
    console.log(
      `[overlay] Sub card event published: login=${payload.login} doc=${docId}`,
    );
    return true;
  }

  function cancelPendingOverlaySubCard(correlationKey) {
    if (!correlationKey) return null;
    const pending = pendingOverlaySubCards.get(correlationKey) || null;
    if (!pending) return null;
    clearTimeout(pending.timer);
    pendingOverlaySubCards.delete(correlationKey);
    return pending;
  }

  async function scheduleOverlaySubCardEvent(
    event,
    twitchEventType,
    deliveryId,
  ) {
    const waitMs = getOverlaySubCardResubWaitMs();
    const correlationKey = getOverlaySubCardCorrelationKey(event);
    if (!correlationKey || waitMs <= 0) {
      return publishOverlaySubCardEvent(event, twitchEventType, deliveryId);
    }

    cancelPendingOverlaySubCard(correlationKey);
    const timer = setTimeout(() => {
      pendingOverlaySubCards.delete(correlationKey);
      publishOverlaySubCardEvent(event, twitchEventType, deliveryId).catch(
        (error) => {
          console.warn(
            "delayed overlay sub card publish failed:",
            error?.message || error,
          );
        },
      );
    }, waitMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingOverlaySubCards.set(correlationKey, {
      timer,
      startedAt: Date.now(),
      deliveryId,
    });
    console.log(
      `[overlay] Sub card event delayed: login=${getLoginFromEvent(event)} waitMs=${waitMs}`,
    );
    return true;
  }

  async function publishOverlayResubCardEvent(
    event,
    twitchEventType,
    deliveryId,
  ) {
    const correlationKey = getOverlaySubCardCorrelationKey(event);
    const pending = cancelPendingOverlaySubCard(correlationKey);
    if (pending) {
      console.log(
        `[overlay] Pending sub card replaced by resub: login=${getLoginFromEvent(event)}`,
      );
    }
    return publishOverlaySubCardEvent(event, twitchEventType, deliveryId);
  }

  async function publishOverlayModerationEvent(event, deliveryId) {
    const overlayConfig = config.overlay || {};
    const payload = buildOverlayModerationEvent(event, {
      overlayConfig,
      deliveryId,
    });
    if (!payload.login) return false;
    const collectionName = overlayConfig.eventsCollection || "overlay_events";
    const eventKey = safeOverlayEventDocId(
      deliveryId || `channel_ban_${payload.login}_${payload.eventMs}`,
    );
    const docId = `${payload.type}_${eventKey}`;
    await db.collection(collectionName).doc(docId).set(payload, { merge: true });
    console.log(
      `[overlay] Moderation event published: login=${payload.login} permanent=${payload.isPermanent} doc=${docId}`,
    );
    return true;
  }

  async function buildSubMention(login, display) {
    try {
      const snap = await db.collection("participants").doc(login).get();
      const discordId = snap.exists ? snap.data()?.discord_id : null;
      return discordId ? `<@${discordId}>` : display || login;
    } catch {
      return display || login;
    }
  }

  function formatSubDiscordMessage(e, { type, mention }) {
    const isGift = !!e?.is_gift;
    const gifter = e?.gifter_user_name || e?.gifter_user_login;

    if (type === "channel.subscription.message") {
      const months =
        e?.cumulative_months ?? e?.duration_months ?? e?.streak_months;
      let line =
        isGift && gifter
          ? `🎁 ${mention} a reçu un sub offert par **${gifter}** — merci !`
          : `⭐ ${mention} s'est réabonné (${months ? ` • ${months} mois` : ""})`;
      return line;
    }

    if (isGift && gifter) {
      return `🎁 ${mention} a reçu un sub  offert par **${gifter}**`;
    }
    return `⭐ Merci pour le nouvel abonnement mon ${mention} !`;
  }

  async function handleTwitchCallback(req, res) {
    if (req.body.challenge) return res.status(200).send(req.body.challenge);
    if (!verifyTwitchSignature(req)) {
      return res.status(403).send("Invalid signature");
    }
    if (isDuplicateDelivery(req)) return res.sendStatus(200);

    const { subscription, event } = req.body;

    if (subscription.type === "channel.ban") {
      try {
        await publishOverlayModerationEvent(
          event,
          req.header("Twitch-Eventsub-Message-Id"),
        );
      } catch (e) {
        console.warn("overlay moderation event publish failed:", e?.message || e);
      }
      return res.sendStatus(200);
    }
    console.log("🔔 Événement Twitch reçu:", subscription.type);

    const eventLogin = getLoginFromEvent(event);
    if (eventLogin && isExcludedLogin(eventLogin)) {
      console.log(
        `[twitch-eventsub] ignored excluded user ${eventLogin} (${subscription.type})`,
      );
      return res.sendStatus(200);
    }

    if (
      subscription.type === "channel.channel_points_custom_reward_redemption.add"
    ) {
      const r = await canonicalEvent(event, { allowCreate: true });
      const isTicket = config.twitch.ticketRewardId
        ? r.reward?.id === config.twitch.ticketRewardId
        : /ticket d'or/i.test(r.reward?.title || "");
      const isPoll = isTwitchPollRedemption(r, config.twitchPoll);
      let shouldNoteChannelPoints = true;

      console.log(
        `🎯 Redemption: user=${r.user_login} rewardId=${r.reward?.id} title="${r.reward?.title}" isTicket=${isTicket} isPoll=${isPoll}`,
      );

      if (isPoll) {
        try {
          const result = await processTwitchPollRedemption({
            db,
            config,
            tokenManager,
            redemption: r,
            livePresenceTick,
            sendTwitchChatMessage,
          });
          shouldNoteChannelPoints = result.status === "CREATED";
          console.log(
            `[poll] redemption handled user=${r.user_login} status=${result.status} reason=${result.reason || "-"} poll=${result.poll?.id || "-"}`,
          );
        } catch (e) {
          shouldNoteChannelPoints = false;
          console.error(
            "poll redemption error:",
            e?.response?.data || e?.message || e,
          );
        }
      }

      try {
        await publishOverlayCardRedemptionEvent(r);
      } catch (e) {
        console.warn("overlay card event publish failed:", e?.message || e);
      }

      if (isTicket) {
        try {
          const accessToken = await tokenManager.getAccessToken();
          await updateRedemptionStatus({
            broadcasterId: config.twitch.channelId,
            rewardId: r.reward.id,
            redemptionIds: [r.id],
            status: "FULFILLED",
            accessToken,
          });
          await upsertParticipantFromRedemption(db, r, { resolveTwitchIdentity });
          try {
            const generalChannel = await client.channels.fetch(
              config.discord.bootyChannelId,
            );
            if (generalChannel?.isTextBased()) {
              await generalChannel.send(
                `📜 Note prise : participation de ${r.user_name} confirmée — **${r.reward.title}** 🎟️`,
              );
            }
          } catch (e) {
            console.warn("Discord notify failed:", e.message);
          }
        } catch (e) {
          console.error(
            "Fulfill+participant error:",
            e.response?.data || e.message,
          );
        }
      }

      try {
        if (!shouldNoteChannelPoints) {
          console.log(
            `[poll] ChannelPoints skipped (invalid poll user=${r.user_login})`,
          );
          return res.sendStatus(200);
        }
        const login = (r.user_login || r.user_name || "").toLowerCase();
        const { streamId, startedAt } = livePresenceTick.getLiveStreamState();
        if (login && streamId) {
          const channelPointsProgress = await questStore.noteChannelPoints(
            login,
            streamId,
            1,
            {
              startedAt,
              createIfMissing: false,
              twitchUserId: r.user_id || "",
            },
          );
          if (channelPointsProgress?.reason === "missing_follower") {
            const buffered =
              typeof bufferLiveChannelPoints === "function"
                ? bufferLiveChannelPoints(login, streamId, 1, {
                    startedAt,
                    displayName: r.user_name || login,
                    twitchUserId: r.user_id || "",
                  })
                : null;
            if (buffered?.buffered) {
              console.log(
                `[live-activity] ChannelPoints buffered for new live profile ${login} (stream ${streamId})`,
              );
            } else {
              console.log(
                `[live-activity] ChannelPoints skipped for missing follower ${login} (no live buffer)`,
              );
            }
            return res.sendStatus(200);
          }
          if (typeof twitchExtensionStatsSync?.syncEntry === "function") {
            await twitchExtensionStatsSync
              .syncEntry({
                twitchUserId: r.user_id || "",
                login,
                displayName: r.user_name || login,
                channelPointsCount: 1,
              })
              .catch((e) =>
                console.warn(
                  "twitch extension channel point stats sync failed:",
                  e?.message || e,
                ),
              );
          }
          if (
            channelPointsProgress?.leveledUp &&
            typeof sendTwitchChatMessage === "function"
          ) {
            const levelUpMessage = buildCommunityLevelUpMessage({
              displayName: r.user_name || login,
              login,
              level: channelPointsProgress.level,
              rankName: channelPointsProgress.rankName,
            });
            if (levelUpMessage) {
              await sendTwitchChatMessage(levelUpMessage).catch((e) =>
                console.warn("level-up chat message failed:", e?.message || e),
              );
            }
          }
          console.log(`✅ ChannelPoints +1 → ${login} (stream ${streamId})`);
        } else {
          console.log(
            `⏭️ ChannelPoints ignoré (login=${login} streamId=${streamId || "-"})`,
          );
        }
      } catch (e) {
        console.warn("noteChannelPoints failed:", e?.message || e);
      }

      return res.sendStatus(200);
    }

    if (subscription.type === "channel.follow") {
      const canonical = await canonicalEvent(event, { allowCreate: true });
      const login = canonical.user_login;
      const userId = event.user_id;
      const followedAt = new Date(event.followed_at);

      const ref = db.collection("followers_all_time").doc(login.toLowerCase());
      const snap = await ref.get();

      if (snap.exists) {
        await ref.update({
          lastFollowed: followedAt,
          twitch_id: userId,
          twitchId: userId,
        });
      } else {
        await ref.set({
          pseudo: login.toLowerCase(),
          twitch_id: userId,
          twitchId: userId,
          followDate: followedAt,
          cards_generated: [],
        });
      }
      console.log(`⚡ Nouveau follow détecté : ${login}`);
    }

    if (subscription.type === "channel.subscribe") {
      try {
        const canonical = await canonicalEvent(event, { allowCreate: true });
        await upsertParticipantFromSubscription(db, canonical, { resolveTwitchIdentity });
        await upsertFollowerMonthsFromSub(db, canonical, { resolveTwitchIdentity });
        await scheduleOverlaySubCardEvent(
          canonical,
          subscription.type,
          req.header("Twitch-Eventsub-Message-Id"),
        );

        const login = getLoginFromEvent(canonical);
        const display = getDisplayFromEvent(canonical, login);
        scheduleSubscribeNotice(login, async () => {
          const mention = await buildSubMention(login, display);
          return formatSubDiscordMessage(canonical, {
            type: "channel.subscribe",
            mention,
          });
        });

        console.log(
          `⭐ Sub enregistré pour ${event.user_login || event.user?.login}`,
        );
      } catch (e) {
        console.error("Sub upsert error:", e.response?.data || e.message);
      }
      return res.sendStatus(200);
    }

    if (subscription.type === "channel.subscription.message") {
      try {
        const canonical = await canonicalEvent(event, { allowCreate: true });
        await upsertParticipantFromSubscription(db, canonical, { resolveTwitchIdentity });
        await upsertFollowerMonthsFromSub(db, canonical, { resolveTwitchIdentity });
        await publishOverlayResubCardEvent(
          canonical,
          subscription.type,
          req.header("Twitch-Eventsub-Message-Id"),
        );

        const login = getLoginFromEvent(canonical);
        const display = getDisplayFromEvent(canonical, login);
        await sendResubNow(login, async () => {
          const mention = await buildSubMention(login, display);
          return formatSubDiscordMessage(canonical, {
            type: "channel.subscription.message",
            mention,
          });
        });

        console.log(
          `🔁 Resub enregistré pour ${event.user_login || event.user?.login}`,
        );
      } catch (e) {
        console.error("Resub upsert error:", e.response?.data || e.message);
      }
      return res.sendStatus(200);
    }

    if (subscription.type === "channel.raid") {
      try {
        const { streamId, startedAt } = livePresenceTick.getLiveStreamState();
        if (!streamId) return res.sendStatus(200);

        const accessToken = await tokenManager.getAccessToken();
        const headers = buildTwitchHeaders(accessToken, {
          includeContentType: false,
        });

        const chatters = [];
        let after = null;
        let guard = 0;
        do {
          const { data } = await axios.get(config.urls.helixChatters, {
            headers,
            params: after
              ? {
                  broadcaster_id: config.twitch.channelId,
                  moderator_id: config.twitch.moderatorId,
                  first: 1000,
                  after,
                }
              : {
                  broadcaster_id: config.twitch.channelId,
                  moderator_id: config.twitch.moderatorId,
                  first: 1000,
                },
          });
          (data?.data || []).forEach((c) => {
            if (!c?.user_login) return;
            chatters.push({
              login: c.user_login.toLowerCase(),
              twitchUserId: c.user_id || "",
            });
          });
          after = data?.pagination?.cursor || null;
        } while (after && ++guard < 5);

        await Promise.all(
          chatters.map((chatter) =>
            questStore.noteRaidParticipation(chatter.login, streamId, {
              startedAt,
              twitchUserId: chatter.twitchUserId,
            }),
          ),
        );
      } catch (e) {
        console.warn("raid handler failed:", e?.response?.data || e.message);
      }
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  }

  async function subscribeToRaids() {
    const appToken = await fetchAppAccessToken();
    const headers = buildTwitchHeaders(appToken);

    const list = await axios.get(config.urls.eventsub, { headers });
    const exists = list.data.data.find(
      (s) =>
        s.type === "channel.raid" &&
        s.condition?.from_broadcaster_user_id === config.twitch.channelId,
    );
    if (exists) return;

    await axios.post(
      config.urls.eventsub,
      {
        type: "channel.raid",
        version: "1",
        condition: { from_broadcaster_user_id: config.twitch.channelId },
        transport: {
          method: "webhook",
          callback: config.twitch.eventsubCallback,
          secret: config.twitch.webhookSecret,
        },
      },
      { headers },
    );
  }

  async function subscribeToFollows() {
    const appToken = await fetchAppAccessToken();
    const headers = buildTwitchHeaders(appToken);

    const listRes = await axios.get(config.urls.eventsub, { headers });
    const existing = listRes.data.data.find(
      (sub) =>
        sub.type === "channel.follow" &&
        sub.version === "2" &&
        sub.condition.broadcaster_user_id === config.twitch.channelId &&
        sub.condition.moderator_user_id === config.twitch.channelId,
    );
    if (existing) {
      return;
    }

    const payload = {
      type: "channel.follow",
      version: "2",
      condition: {
        broadcaster_user_id: config.twitch.channelId,
        moderator_user_id: config.twitch.channelId,
      },
      transport: {
        callback: config.twitch.eventsubCallback,
        method: "webhook",
        secret: config.twitch.webhookSecret,
      },
    };

    await axios.post(config.urls.eventsub, payload, { headers });
  }

  async function subscribeToRedemptions() {
    const appToken = await fetchAppAccessToken();
    const headers = buildTwitchHeaders(appToken);

    const list = await axios.get(config.urls.eventsub, { headers });
    const exists = list.data.data.find(
      (s) =>
        s.type === "channel.channel_points_custom_reward_redemption.add" &&
        s.condition?.broadcaster_user_id === config.twitch.channelId,
    );
    if (exists) {
      console.log("? EventSub redemption.add d?j? pr?sent:", exists.id);
      return;
    }

    const payload = {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: config.twitch.channelId },
      transport: {
        method: "webhook",
        callback: config.twitch.eventsubCallback,
        secret: config.twitch.webhookSecret,
      },
    };

    const created = await axios.post(config.urls.eventsub, payload, {
      headers,
    });
    console.log("? EventSub redemption.add cr??:", created.data.data?.[0]?.id);
  }

  async function subscribeToSubs() {
    const appToken = await fetchAppAccessToken();
    const headers = buildTwitchHeaders(appToken);

    const list = await axios.get(config.urls.eventsub, { headers });
    const ensure = async (type) => {
      const exists = list.data.data.find(
        (s) =>
          s.type === type &&
          s.condition?.broadcaster_user_id === config.twitch.channelId,
      );
      if (exists) return;
      await axios.post(
        config.urls.eventsub,
        {
          type,
          version: "1",
          condition: { broadcaster_user_id: config.twitch.channelId },
          transport: {
            method: "webhook",
            callback: config.twitch.eventsubCallback,
            secret: config.twitch.webhookSecret,
          },
        },
        { headers },
      );
    };

    await ensure("channel.subscribe");
    await ensure("channel.subscription.message");
  }

  async function subscribeToBans() {
    const appToken = await fetchAppAccessToken();
    const headers = buildTwitchHeaders(appToken);
    const list = await axios.get(config.urls.eventsub, { headers });
    const exists = list.data.data.find(
      (subscription) =>
        subscription.type === "channel.ban" &&
        subscription.version === "1" &&
        subscription.condition?.broadcaster_user_id === config.twitch.channelId,
    );
    if (exists) return;
    await axios.post(
      config.urls.eventsub,
      buildChannelBanSubscriptionPayload(config),
      { headers },
    );
  }

  async function subscribeAll() {
    await subscribeToFollows().catch(console.error);
    await subscribeToRedemptions().catch(console.error);
    await subscribeToSubs().catch(console.error);
    await subscribeToBans().catch(console.error);
    await subscribeToRaids().catch(console.error);
  }

  return {
    handleTwitchCallback,
    subscribeToFollows,
    subscribeToRedemptions,
    subscribeToSubs,
    subscribeToBans,
    subscribeToRaids,
    subscribeAll,
    fetchAppAccessToken,
    buildTwitchHeaders,
  };
}

module.exports = {
  createTwitchEventSub,
  _test: {
    buildOverlayCardRedemptionEvent,
    buildOverlaySubCardEvent,
    buildOverlayModerationEvent,
    buildChannelBanSubscriptionPayload,
    isOverlayCardRedemption,
    normalizeRewardText,
    safeOverlayEventDocId,
  },
};
