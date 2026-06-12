# Discord Bot Codex Guide

This is the fast entry point for Codex when working in `discord-bot`.

Before broad exploration, read:

- `../ErwayrWebSite/docs/DISCORD_BOT_CONTEXT.md`
- `../ErwayrWebSite/docs/FIRESTORE_CONTRACTS.md`
- `../ErwayrWebSite/docs/CODEX_CONTEXT.md`

## Project Shape

- Plain Node.js CommonJS service, not a frontend app.
- Entry point: `index.js`.
- `app/` contains composition modules for config, Discord events, Firebase Admin, HTTP routes, cron jobs, Firestore listeners, Twitch chat and Twitch EventSub.
- `script/` contains business handlers for auth/tokens, quests, community levels, weekly recap, weekly planning, elections, redemptions, profiles, birthdays, cards and Discord/Twitch activity.
- `helper/` contains Firestore retry, excluded users and Helix helpers.
- `test/` uses the Node test runner.

## Commands

- Install/update deps: `npm install`
- Start real bot/server: `npm start`
- Syntax check entry: `node --check index.js`
- Run all bot tests: `node --test`
- Run one test file: `node --test test\questStorage.test.js`

`npm start` connects to Discord/Twitch and can trigger Firestore writes through startup jobs and listeners. Do not run it unless the needed env vars are present and real side effects are intended.

## Editing Rules

- Keep CommonJS/plain JS style.
- Do not edit `node_modules/` or secrets.
- Keep `.env`, `FIREBASE_KEY_JSON`, Discord tokens, Twitch OAuth tokens and refresh tokens private.
- Preserve existing encoding. Several files contain mojibake; do not mass-rewrite text unless the task is about encoding.
- Before changing Firestore fields, search both repos:
  - `rg "field_or_collection" .`
  - `rg "field_or_collection" ..\ErwayrWebSite`
- POPS writes must update wallet and `pops_transactions` together, and must stay idempotent.
- For `participants` writes, check mirrors in `followers_all_time`.

## Fast Navigation

- App wiring: `index.js`
- Env/config: `app/config.js`
- Firebase Admin: `app/firebase.js`
- Discord events and commands: `app/discordEvents.js`
- HTTP routes and Twitch auth endpoints: `app/httpRoutes.js`, `script/authTwitch.js`, `script/tokenManager.js`
- Twitch EventSub: `app/twitchEventSub.js`
- Twitch chat/TMI: `app/twitchChat.js`, `script/twitchChatCommands.js`
- Live quest storage: `script/questStorage.js`
- Community levels: `script/communityLevel.js`
- Jobs/cron: `app/jobs.js`
- Firestore listeners: `app/firestoreListeners.js`
- Weekly recap rewards: `script/weeklyFollowersRecap.js`
- Weekly planning publication: `script/weeklyPlanningPublisher.js`
- Birthdays: `app/birthdays.js`
- Discord booster cards: `script/serverBoosterCards.js`
- Discord profile command: `script/profileHandler.js`

## Verification

- Small JS change: `node --check path\to\file.js`
- Bot behavior change: `node --check index.js` and `node --test`
- Targeted behavior change: run the matching `test\*.test.js` file.

There is no `npm test` script in this repo.
