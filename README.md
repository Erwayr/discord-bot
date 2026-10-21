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

The command starts the complete saved-character attack and subscription-card
reveal in the Guardian OBS source, including when the channel is offline. It
uses one private expiring test reservation and the Guardian wake signal, with
no parallel legacy card event. The optional month count changes only the test
card's artwork and music, without updating `participants`, `followers_all_time`,
rewards or real subscription deduplication. An active appearance gives a busy
reply; real requests take priority over a test.

Deploy `overlayGuardianLiveState` and the site, update this bot together with
the synchronized Guardian contracts, restart the bot, then refresh the Guardian
browser source in OBS. The command's confirmation now names the Guardian and
subscription card.

## Firestore live-read controls

To avoid reading every `followers_all_time` profile during Twitch lives, rank
refreshes are bounded to live start and live end:

```env
COMMUNITY_LEVEL_RANK_REFRESH_ON_LIVE_START=true
COMMUNITY_LEVEL_RANK_REFRESH_ON_LIVE_END=true
```

`CRON_COMMUNITY_LEVEL_RANKS` is kept as config but is not scheduled during
Twitch lives.
