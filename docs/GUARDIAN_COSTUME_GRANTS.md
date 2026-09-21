# Guardian Halloween costume grants

`script/guardianCostumeGrants.js` permanently grants the `halloween-2026`
costume on a real Helix live-presence tick from October 24 through November 7,
2026, inclusive, in `Europe/Warsaw`. The shared contract accounts for the autumn
time change: `2026-10-23T22:00:00Z <= observedAtMs < 2026-11-07T23:00:00Z`.
There is no minimum watch time and no requirement for an existing follower
profile. The usual excluded service accounts are filtered out.

The ticker invokes the costume callback for every current viewer, before its
ordinary once-per-stream presence shortcut. The callback receives the stable
Twitch user ID directly from the current Helix chatter response and the actual
tick timestamp. It never infers an in-window presence from a stream's start,
accumulated watch time, or the endpoints of an absence.

The service uses Firebase Admin `create()` on
`guardian_costume_grants/{twitchUserId}_halloween-2026`. Its only fields are
`costumeId`, `twitchUserId`, `observedAtMs`, `streamId`, and server timestamp
`unlockedAt`. It never reads or creates `followers_all_time` or `participants`.
Concurrent writers and replays use the same immutable document ID.

Before a remote write, the service appends and syncs the observation to
`guardian-costume-grants.jsonl` inside `TWITCH_LIVE_ACTIVITY_PERSIST_DIR`
(default `.runtime/live-activity`). This journal is distinct from live activity
and level announcements. Keep this directory on persistent storage. Failed
writes retry every minute, on startup, and on shutdown, using the original
observation even after November 7. Successful grants are cached in memory and
acknowledged in the journal to avoid repeating database calls after restarts.
An interrupted final journal record is ignored; complete earlier evidence is
preserved. Journal failures leave the pending observation in memory and prevent
remote writes until persistence succeeds. Unexpected process loss while storage
itself is unavailable can lose that unpersisted observation.

The service starts with Twitch chat and is awaited during the existing bot
shutdown flush. Retry logs use fixed messages and never print API errors or
credentials. No Twitch/Discord notification is sent.

Focused offline checks:

```powershell
node --test test/guardianCostumeGrants.test.js test/livePresenceTracker.test.js
node --check script/guardianCostumeGrants.js
node --check app/twitchChat.js
node --check index.js
```
