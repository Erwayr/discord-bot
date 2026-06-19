# discord-bot

## Firestore live-read controls

To avoid reading every `followers_all_time` profile during Twitch lives, keep
the live rank refresh cron disabled:

```env
CRON_COMMUNITY_LEVEL_RANKS=0
COMMUNITY_LEVEL_RANK_REFRESH_ON_LIVE_END=true
```

If a live rank refresh is needed later, prefer a sparse cron such as
`*/15 * * * *` instead of every minute.
