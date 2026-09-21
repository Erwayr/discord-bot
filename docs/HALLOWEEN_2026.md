# Halloween 2026 presence pack

The one-time 2026 edition is free and permanent. A real Helix chatter observation
while the configured Twitch channel is live qualifies from **24 October 2026
00:00 Europe/Paris** through **7 November 2026 inclusive**. The exact UTC window
is `[2026-10-23T22:00:00Z, 2026-11-07T23:00:00Z)`; it includes the DST change.
No previous/future edition, stream-start date, flush date or inferred interval
qualifies. Logged-in lurkers count. The existing service-account exclusions and
10-minute minimum for creating a new follower remain in force.

`script/livePresenceTracker.js` captures `seasonalPresenceAtMs` only from an
observed tick in the window, even when that stream was already observed before
the opening. Ordinary once-per-stream presence remains deduplicated.
`app/twitchChat.js` connects the observation callback to the local activity
journal. The journal preserves the qualifying timestamp and maximum observed
presence duration; it does not add uptime credits. Restore, failed flush retry
and merging with the final uptime snapshot keep that evidence.

`script/questStorage.js` grants both IDs in the same transaction as authoritative
presence: `popsShop.profileFrames.owned.card-frame-game-halloween-2026` and
`popsShop.experienceBars.owned.game-halloween-2026`. Each entry contains `id`,
`source: halloween_presence`, `eventId: halloween-2026`, `qualifiedAt`,
`grantedAt` (server milliseconds) and `schemaVersion: 1`. Existing valid grants
are immutable/idempotent. Wallet, previous ownership and active equipment are
preserved. Ownership is not mirrored to `participants`; existing equipped
visual selection continues to use its usual server-side mirror.

Default live-end mode grants after the confirmed end/flush. Interval mode also
supports direct presence and final uptime paths; a stream crossing the opening
uses its next normal buffered flush without repeating ordinary presence. A delayed/recovered flush
after 7 November still grants when its recorded observation qualifies. A site
visit alone cannot qualify.

The canonical event contract is the site's
`functions/seasonal-cosmetics.shared.cjs`. Copy it unchanged to the bot's
`script/seasonal-cosmetics.shared.cjs` whenever updating that contract:

```powershell
Copy-Item -LiteralPath '..\ErwayrWebSite\functions\seasonal-cosmetics.shared.cjs' -Destination 'script\seasonal-cosmetics.shared.cjs'
node --test test/seasonalPresenceRewards.test.js test/livePresenceTracker.test.js test/liveActivityBuffer.test.js test/questStorage.test.js
node --check index.js
```

The seasonal test checks exact source parity whenever the sibling site checkout
is available. Deploy the site's catalog and authority changes before or together
with this bot version, and deploy the bot before 24 October. No historical
backfill or Firestore migration is required; do not start the real bot for a
local test because startup connects and writes to production services.
