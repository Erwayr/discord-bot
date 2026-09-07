# discord-bot

## Subscription overlay tests

In Twitch chat, broadcasters, moderators and configured allowed users can run:

```text
!testsub erwayr 5
!testsub erwayr 6
!testsub erwayr 24 Merci pour le live !
```

Syntax: `!testsub [login] [months] [message]`. Months must be a positive integer.
Omit months to use the profile's subscription tenure; omit the login to target
yourself. To specify months, include the login. The optional message remains
supported with or without months. Aliases: `!testsubcard`, `!testcarteabo`,
`!testsubcarte`.

The chosen month count is written only to the test event's `subMonths` field in
the configured overlay event collection (`overlay_events` by default). It changes
the preview artwork, music and animation without updating `participants` or
`followers_all_time`. Live and Chatting use water from 6 months onward.

## Firestore live-read controls

To avoid reading every `followers_all_time` profile during Twitch lives, rank
refreshes are bounded to live start and live end:

```env
COMMUNITY_LEVEL_RANK_REFRESH_ON_LIVE_START=true
COMMUNITY_LEVEL_RANK_REFRESH_ON_LIVE_END=true
```

`CRON_COMMUNITY_LEVEL_RANKS` is kept as config but is not scheduled during
Twitch lives.
