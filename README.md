# discord-bot

## Firestore live-read controls

To avoid reading every `followers_all_time` profile during Twitch lives, rank
refreshes are bounded to live start and live end:

```env
COMMUNITY_LEVEL_RANK_REFRESH_ON_LIVE_START=true
COMMUNITY_LEVEL_RANK_REFRESH_ON_LIVE_END=true
```

`CRON_COMMUNITY_LEVEL_RANKS` is kept as config but is not scheduled during
Twitch lives.
