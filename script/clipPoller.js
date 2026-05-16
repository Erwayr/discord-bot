let clipsSeenThisStream = new Set();
let activeStreamId = null;

const axios = require("axios");

function asString(value) {
  return String(value || "").trim();
}

function createClipPoller({
  tokenManager,
  questStore,
  livePresenceTick,
  clientId,
  broadcasterId,
  onNewClip,
  onNewClips,
}) {
  const resolvedClientId = asString(clientId) || asString(process.env.TWITCH_CLIENT_ID);
  const resolvedBroadcasterId =
    asString(broadcasterId) || asString(process.env.TWITCH_CHANNEL_ID);
  // keep 60s of tolerance for clock skew around process startup
  const announceCutoffMs = Date.now() - 60_000;

  return async function pollClipsTick() {
    const { streamId, startedAt } = livePresenceTick.getLiveStreamState();
    if (!streamId || !startedAt) {
      // reset when stream is offline
      if (clipsSeenThisStream.size) clipsSeenThisStream.clear();
      activeStreamId = null;
      return;
    }

    if (activeStreamId !== streamId) {
      clipsSeenThisStream.clear();
      activeStreamId = streamId;
    }

    if (!resolvedClientId || !resolvedBroadcasterId) {
      console.warn(
        "[clipPoller] missing Twitch env (TWITCH_CLIENT_ID or TWITCH_CHANNEL_ID)",
      );
      return;
    }

    try {
      const accessToken = await tokenManager.getAccessToken();
      const headers = {
        "Client-ID": resolvedClientId,
        Authorization: `Bearer ${accessToken}`,
      };

      // Fetch all clips created during this live stream window
      const newClips = [];
      let cursor = null;
      let guard = 0;
      do {
        const { data } = await axios.get("https://api.twitch.tv/helix/clips", {
          headers,
          params: cursor
            ? {
                broadcaster_id: resolvedBroadcasterId,
                started_at: startedAt.toISOString(),
                ended_at: new Date().toISOString(),
                first: 100,
                after: cursor,
              }
            : {
                broadcaster_id: resolvedBroadcasterId,
                started_at: startedAt.toISOString(),
                ended_at: new Date().toISOString(),
                first: 100,
              },
        });

        const clips = data?.data || [];
        for (const clip of clips) {
          if (!clip?.id) continue;
          if (clipsSeenThisStream.has(clip.id)) continue;
          clipsSeenThisStream.add(clip.id);
          newClips.push(clip);
        }

        cursor = data?.pagination?.cursor || null;
      } while (cursor && ++guard < 10);

      if (!newClips.length) return;

      // Map creator_id -> [clipIds]
      const byCreator = new Map();
      for (const clip of newClips) {
        if (!clip?.creator_id) continue;
        if (!byCreator.has(clip.creator_id)) byCreator.set(clip.creator_id, []);
        byCreator.get(clip.creator_id).push(clip.id);
      }

      // Resolve creator login from creator_id (batch /users?id=...)
      const creatorIds = [...byCreator.keys()];
      const logins = new Map(); // id -> login
      for (let i = 0; i < creatorIds.length; i += 100) {
        const slice = creatorIds.slice(i, i + 100);
        const url = new URL("https://api.twitch.tv/helix/users");
        slice.forEach((id) => url.searchParams.append("id", id));
        const { data } = await axios.get(url.toString(), { headers });
        (data?.data || []).forEach((user) =>
          logins.set(user.id, asString(user.login).toLowerCase()),
        );
      }

      // Credit clip creators in quest storage
      for (const [creatorId, clipIds] of byCreator.entries()) {
        const login = logins.get(creatorId);
        if (!login) continue;
        for (const clipId of clipIds) {
          await questStore.noteClipCreated(login, streamId, clipId, {
            startedAt,
          });
        }
      }

      const clipsToAnnounce = newClips.filter((clip) => {
        const createdMs = Date.parse(String(clip?.created_at || ""));
        if (Number.isNaN(createdMs)) return true;
        return createdMs >= announceCutoffMs;
      });

      if (typeof onNewClip === "function") {
        for (const clip of clipsToAnnounce) {
          try {
            await onNewClip(clip, { streamId, startedAt });
          } catch (e) {
            console.warn("[clipPoller] onNewClip failed:", e?.message || e);
          }
        }
      }

      if (typeof onNewClips === "function") {
        try {
          await onNewClips(clipsToAnnounce, { streamId, startedAt });
        } catch (e) {
          console.warn("[clipPoller] onNewClips failed:", e?.message || e);
        }
      }

      console.log(
        `[clipPoller] clips detected: ${newClips.length} (stream ${streamId}).`,
      );
    } catch (e) {
      console.warn("pollClipsTick error:", e?.response?.data || e.message);
    }
  };
}

module.exports = { createClipPoller };

