"use strict";

const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const SCHEMA_VERSION = 1;
const CHECKPOINT_MS = 60_000;
const LEASE_MS = 180_000;
const MAX_OBSERVATION_GAP_MS = 120_000;

// Keep selection identity aligned with functions/games-history.shared.cjs.
function normalizeGameName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toLowerCase().replace(/\s+/g, " ");
}

function playingGame(presence, currentName = null) {
  if (!["online", "idle", "dnd"].includes(presence?.status)) return null;
  const names = (presence.activities || []).filter((entry) => entry?.type === 0)
    .map((entry) => String(entry.name || "").trim()).filter(Boolean);
  const key = normalizeGameName;
  if (currentName && names.some((name) => key(name) === key(currentName))) return currentName;
  names.sort((a, b) => key(a).localeCompare(key(b), "en") || a.localeCompare(b, "en"));
  return names[0] || null;
}

function duration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
}

// count is a historical observation score. It must never receive duration data.
function addObservedGames(history, contributions, timestamp) {
  const next = Array.isArray(history) ? history.map((entry) => ({ ...entry })) : [];
  for (const part of contributions) {
    let index = next.findIndex((entry) => normalizeGameName(entry.name) === normalizeGameName(part.name));
    if (index < 0) {
      index = next.length;
      next.push({ name: part.name, count: 0 });
    }
    const current = next[index];
    next[index] = {
      ...current,
      trackedDurationMs: Math.min(Number.MAX_SAFE_INTEGER, duration(current.trackedDurationMs) + duration(part.durationMs)),
      trackingStartedAt: current.trackingStartedAt || timestamp(part.firstAtMs),
      lastPlayedAt: timestamp(part.lastAtMs),
    };
  }
  return next;
}

function createDiscordGameTracker({
  db, admin, client, config = {}, logger = console,
  now = Date.now, monotonicNow = () => performance.now(),
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  createId = randomUUID,
}) {
  const enabled = config.discordGameTracking?.enabled !== false;
  const timestamp = (value) => admin.firestore.Timestamp.fromMillis(Math.floor(value));
  const records = new Map();
  const followerRefs = new Map();
  let observed = new Map();
  let pendingSnapshot = null;
  let generation = 0;
  let guild = null;
  let timer = null;
  let started = false;
  let ready = false;
  let closing = false;
  let refreshing = null;
  let refreshGeneration = null;
  let tickRunning = false;

  const sample = (game) => ({ game, atMs: now(), monoMs: Math.floor(monotonicNow()), generation });
  const warn = (message, error) => logger.warn?.(`[discord-games] ${message}`, error?.message || error || "");

  function resolveGuild() {
    const configuredId = String(config.discord?.guildId || "").trim();
    if (configuredId) return client.guilds.cache.get(configuredId) || null;
    const channelId = config.discord?.generalChannelId;
    const ids = new Set();
    const channel = client.channels?.cache?.get(channelId);
    if (channel?.guildId || channel?.guild?.id) ids.add(channel.guildId || channel.guild.id);
    for (const candidate of client.guilds.cache.values()) {
      if (candidate.channels?.cache?.has(channelId)) ids.add(candidate.id);
    }
    return ids.size === 1 ? client.guilds.cache.get([...ids][0]) || null : null;
  }

  function isCurrent(record) {
    return record.generation === generation && ready;
  }

  async function followerRef(discordId) {
    const cached = followerRefs.get(discordId);
    if (cached) return cached;
    const snap = await db.collection("followers_all_time").where("discord_id", "==", discordId).limit(2).get();
    if (snap.docs.length !== 1) return null;
    followerRefs.set(discordId, snap.docs[0].ref);
    return snap.docs[0].ref;
  }

  function contribute(record, name, milliseconds, atMs) {
    if (!name) return;
    const current = record.pending.get(name);
    record.pending.set(name, {
      name,
      durationMs: (current?.durationMs || 0) + milliseconds,
      firstAtMs: current?.firstAtMs ?? atMs,
      lastAtMs: Math.max(current?.lastAtMs || 0, atMs),
    });
  }

  function loseOwnership(record) {
    record.owned = false;
    record.token = null;
    record.frame = null;
    record.pending.clear();
    record.game = null;
    record.lastMonoMs = null;
  }

  async function acquire(record, observation) {
    const ref = await followerRef(record.discordId);
    if (!ref || !isCurrent(record)) return false;
    record.ref = ref;
    record.token ||= createId();
    const token = record.token;
    const result = await db.runTransaction(async (tx) => {
      const [lockSnap, profileSnap] = await Promise.all([tx.get(record.lockRef), tx.get(ref)]);
      if (!isCurrent(record) || !profileSnap.exists || profileSnap.data().discord_id !== record.discordId) return null;
      const lock = lockSnap.data() || {};
      const time = now();
      if (lock.ownerId !== token && lock.leaseUntilMs > time) return null;
      // A response can be lost after a successful claim. Reusing the token is safe.
      const sequence = lock.ownerId === token ? duration(lock.lastSequence) : 0;
      const leaseUntilMs = time + LEASE_MS;
      tx.set(record.lockRef, {
        schemaVersion: SCHEMA_VERSION, ownerId: token, guildId: guild.id,
        leaseUntilMs, lastSequence: sequence, activeGame: observation.game,
        updatedAt: timestamp(time),
      });
      tx.update(ref, { games_history: addObservedGames(profileSnap.data().games_history, [{
        name: observation.game, durationMs: 0, firstAtMs: observation.atMs, lastAtMs: observation.atMs,
      }], timestamp) });
      return { sequence, leaseUntilMs };
    });
    if (!result || !isCurrent(record)) {
      followerRefs.delete(record.discordId);
      loseOwnership(record);
      return false;
    }
    record.owned = true;
    record.sequence = result.sequence;
    record.leaseUntilMs = result.leaseUntilMs;
    record.game = observation.game;
    // Never claim time before ownership was confirmed, including bot downtime.
    record.lastMonoMs = Math.max(observation.monoMs, Math.floor(monotonicNow()));
    return true;
  }

  async function flush(record, close = false) {
    while (record.owned && isCurrent(record)) {
      if (!record.frame) {
        record.frame = {
          sequence: record.sequence + 1,
          parts: [...record.pending.values()],
          close,
          game: record.game,
        };
        record.pending.clear();
      }
      const frame = record.frame;
      const result = await db.runTransaction(async (tx) => {
        const [lockSnap, profileSnap] = await Promise.all([tx.get(record.lockRef), tx.get(record.ref)]);
        const lock = lockSnap.data() || {};
        if (!isCurrent(record) || lock.ownerId !== record.token) return null;
        // Check the durable cursor before lease expiry: this frame may have
        // committed, including a release, despite an ambiguous transport error.
        if (duration(lock.lastSequence) >= frame.sequence) return { leaseUntilMs: lock.leaseUntilMs, closed: !lock.activeGame };
        const time = now();
        if (lock.leaseUntilMs <= time || !profileSnap.exists || profileSnap.data().discord_id !== record.discordId) return null;
        if (duration(lock.lastSequence) + 1 !== frame.sequence) throw new Error("checkpoint_sequence_gap");
        const leaseUntilMs = frame.close ? 0 : time + LEASE_MS;
        if (frame.parts.length) tx.update(record.ref, {
          games_history: addObservedGames(profileSnap.data().games_history, frame.parts, timestamp),
        });
        tx.update(record.lockRef, {
          lastSequence: frame.sequence, leaseUntilMs,
          activeGame: frame.close ? null : frame.game,
          updatedAt: timestamp(time),
        });
        return { leaseUntilMs, closed: frame.close };
      });
      if (!result) {
        followerRefs.delete(record.discordId);
        loseOwnership(record);
        return false;
      }
      record.sequence = frame.sequence;
      record.leaseUntilMs = result.leaseUntilMs;
      record.frame = null;
      if (result.closed) {
        loseOwnership(record);
        return true;
      }
      // Retry an older immutable frame first, then flush newly observed slices.
      if (!record.pending.size && (!close || frame.close)) return true;
    }
    return false;
  }

  async function processObservation(record, observation, checkpoint, stop) {
    if (!isCurrent(record) || observation.generation !== generation) return;
    if (!record.owned) {
      if (observation.game && !stop) await acquire(record, observation);
      return;
    }
    // Replay a frame with an uncertain commit before deciding ownership expired.
    if (record.frame) {
      await flush(record);
      if (!record.owned) return;
    }
    if (observation.atMs >= record.leaseUntilMs) {
      loseOwnership(record);
      if (observation.game && !stop) await acquire(record, observation);
      return;
    }
    const previousGame = record.game;
    const delta = observation.monoMs - record.lastMonoMs;
    // Large unobserved gaps (sleep, event-loop stall) are discarded, never capped
    // into fabricated playtime. A backwards wall clock cannot affect duration.
    if (delta >= 0 && delta <= MAX_OBSERVATION_GAP_MS) contribute(record, previousGame, delta, observation.atMs);
    record.lastMonoMs = Math.max(record.lastMonoMs, observation.monoMs);
    record.game = stop ? null : observation.game;
    if (record.game && record.game !== previousGame) contribute(record, record.game, 0, observation.atMs);
    if (checkpoint || previousGame !== record.game || stop) await flush(record, !record.game);
  }

  function enqueue(discordId, observation, checkpoint = false, stop = false) {
    let record = records.get(discordId);
    if (!record && !observation.game) return Promise.resolve();
    if (!record) {
      record = {
        discordId, generation, owned: false, token: null, sequence: 0,
        game: null, lastMonoMs: null, leaseUntilMs: 0,
        pending: new Map(), frame: null, tail: Promise.resolve(),
        lockRef: db.collection("discord_game_tracking").doc(discordId),
      };
      records.set(discordId, record);
    }
    record.tail = record.tail.then(() => processObservation(record, observation, checkpoint, stop)).catch((error) => {
      warn(`checkpoint failed for ${discordId}`, error);
    });
    return record.tail;
  }

  function onPresence(_oldPresence, presence) {
    if (!enabled || closing || presence?.guild?.id !== guild?.id) return Promise.resolve();
    const discordId = presence.userId || presence.user?.id;
    if (!discordId || presence.user?.bot) return Promise.resolve();
    const game = playingGame(presence, observed.get(discordId) || pendingSnapshot?.overrides.get(discordId) || pendingSnapshot?.values.get(discordId));
    if (pendingSnapshot) pendingSnapshot.overrides.set(discordId, game);
    if (!ready) return Promise.resolve();
    observed.set(discordId, game);
    return enqueue(discordId, sample(game));
  }

  async function tick() {
    if (!ready || closing || tickRunning) return;
    tickRunning = true;
    try {
      const ids = new Set([...observed.keys(), ...records.keys()]);
      await Promise.all([...ids].map((id) => enqueue(id, sample(observed.get(id) || null), true)));
    } finally { tickRunning = false; }
  }

  async function release(record) {
    if (!record.token) return;
    const token = record.token;
    await record.tail;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(record.lockRef);
      if (snap.data()?.ownerId !== token) return;
      tx.update(record.lockRef, { leaseUntilMs: 0, activeGame: null, updatedAt: timestamp(now()) });
    }).catch((error) => warn("lease release failed; it will expire", error));
  }

  function suspend(reason = "disconnected") {
    ready = false;
    generation += 1;
    pendingSnapshot = null;
    observed = new Map();
    if (timer) clearIntervalFn(timer);
    timer = null;
    const previous = [...records.values()];
    records.clear();
    logger.info?.(`[discord-games] suspended: ${reason}`);
    return Promise.all(previous.map(release));
  }

  async function refresh() {
    if (!enabled || !started || closing) return;
    if (refreshing && refreshGeneration === generation) return refreshing;
    guild = resolveGuild();
    if (!guild || guild.available === false) {
      warn("tracking disabled until the configured guild can be resolved unambiguously");
      return;
    }
    const run = (async () => {
      const released = suspend("refreshing presences");
      const currentGeneration = generation;
      refreshGeneration = currentGeneration;
      await released;
      if (closing || generation !== currentGeneration) return;
      const nonce = createId().replace(/-/g, "").slice(0, 32);
      const snapshot = { nonce, values: new Map(), overrides: new Map(), received: false };
      pendingSnapshot = snapshot;
      const onRaw = (packet) => {
        if (pendingSnapshot !== snapshot || packet.t !== "GUILD_MEMBERS_CHUNK") return;
        const data = packet.d;
        if (data.guild_id !== guild.id || data.nonce !== nonce) return;
        snapshot.received = true;
        for (const presence of data.presences || []) {
          if (presence.user?.id && !presence.user.bot) snapshot.values.set(presence.user.id, playingGame(presence));
        }
      };
      client.on("raw", onRaw);
      try {
        await guild.members.fetch({ withPresences: true, time: 300_000, nonce });
        if (closing || generation !== currentGeneration || pendingSnapshot !== snapshot) return;
        if (!snapshot.received) throw new Error("fresh_presence_snapshot_missing");
        // Live changes during the request outrank snapshot chunks, including a
        // stop event received before a late chunk still reporting the old game.
        observed = new Map([...snapshot.values, ...snapshot.overrides]);
        pendingSnapshot = null;
        ready = true;
        logger.info?.(`[discord-games] schema=${SCHEMA_VERSION} ready guild=${guild.id} checkpointMs=${CHECKPOINT_MS}`);
        timer = setIntervalFn(() => { void tick().catch((error) => warn("tick failed", error)); }, CHECKPOINT_MS);
        timer?.unref?.();
        await tick();
      } catch (error) {
        if (generation === currentGeneration) await suspend("presence refresh failed");
        warn("fresh presence snapshot failed; no time will be credited", error);
      } finally {
        client.off("raw", onRaw);
        if (pendingSnapshot === snapshot) pendingSnapshot = null;
      }
    })();
    refreshing = run;
    try { await run; } finally { if (refreshing === run) refreshing = null; }
  }

  async function start() {
    if (started) return;
    started = true;
    if (!enabled) {
      logger.info?.(`[discord-games] schema=${SCHEMA_VERSION} disabled by DISCORD_GAME_TRACKING_ENABLED`);
      return;
    }
    await refresh();
  }

  async function resumeShard(shardId) {
    if (!guild || guild.shardId === shardId) await refresh();
  }

  function suspendShard(shardId) {
    return !guild || guild.shardId === shardId ? suspend("shard disconnected") : Promise.resolve();
  }

  async function stop() {
    closing = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    if (ready) await Promise.all([...records.keys()].map((id) => enqueue(id, sample(null), true, true)));
    await suspend("shutdown");
  }

  return {
    start, stop, refresh, tick, onPresence, suspend, resumeShard, suspendShard,
    isTrackingGuild: (id) => enabled && (guild?.id || config.discord?.guildId || resolveGuild()?.id) === id,
  };
}

module.exports = {
  createDiscordGameTracker, playingGame, addObservedGames,
  SCHEMA_VERSION, CHECKPOINT_MS, LEASE_MS, MAX_OBSERVATION_GAP_MS,
};
