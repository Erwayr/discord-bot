let CLIPS_SEEN_THIS_STREAM = new Set();

async function pollClipsTick() {
  const { streamId, startedAt } = livePresenceTick.getLiveStreamState();
  if (!streamId || !startedAt) {
    // reset si on n’est plus en live
    if (CLIPS_SEEN_THIS_STREAM.size) CLIPS_SEEN_THIS_STREAM.clear();
    return;
  }

  try {
    const accessToken = await tokenManager.getAccessToken();
    const headers = {
      "Client-ID": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
    };

    // Récupère tous les clips sur la fenêtre du stream
    const newClips = [];
    let cursor = null,
      guard = 0;
    do {
      const { data } = await axios.get("https://api.twitch.tv/helix/clips", {
        headers,
        params: cursor
          ? {
              broadcaster_id: process.env.TWITCH_CHANNEL_ID,
              started_at: startedAt.toISOString(),
              ended_at: new Date().toISOString(),
              first: 100,
              after: cursor,
            }
          : {
              broadcaster_id: process.env.TWITCH_CHANNEL_ID,
              started_at: startedAt.toISOString(),
              ended_at: new Date().toISOString(),
              first: 100,
            },
      });
      const arr = data?.data || [];
      for (const c of arr) {
        if (!CLIPS_SEEN_THIS_STREAM.has(c.id)) {
          CLIPS_SEEN_THIS_STREAM.add(c.id);
          newClips.push(c);
        }
      }
      cursor = data?.pagination?.cursor || null;
    } while (cursor && ++guard < 10);

    if (!newClips.length) return;

    // Map creator_id -> [clipIds]
    const byCreator = new Map();
    for (const c of newClips) {
      if (!c.creator_id) continue;
      if (!byCreator.has(c.creator_id)) byCreator.set(c.creator_id, []);
      byCreator.get(c.creator_id).push(c.id);
    }

    // Résoudre login à partir de creator_id (batch /users?id=…)
    const creatorIds = [...byCreator.keys()];
    const logins = new Map(); // id -> login
    for (let i = 0; i < creatorIds.length; i += 100) {
      const slice = creatorIds.slice(i, i + 100);
      const url = new URL("https://api.twitch.tv/helix/users");
      slice.forEach((id) => url.searchParams.append("id", id));
      const { data } = await axios.get(url.toString(), { headers });
      (data?.data || []).forEach((u) =>
        logins.set(u.id, (u.login || "").toLowerCase())
      );
    }

    // Créditer chaque créateur
    for (const [creatorId, clipIds] of byCreator.entries()) {
      const login = logins.get(creatorId);
      if (!login) continue;
      for (const clipId of clipIds) {
        await questStore.noteClipCreated(login, streamId, clipId);
      }
    }

    console.log(`🎬 Clips crédités: ${newClips.length} (stream ${streamId}).`);
  } catch (e) {
    console.warn("pollClipsTick error:", e?.response?.data || e.message);
  }
}
module.exports = { pollClipsTick };
