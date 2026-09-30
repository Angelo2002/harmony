# harmony

Selfhosted discord alternative, aimed to make migration painless

## Status

Playable end to end: username/password auth with optional invites, channels and
categories, realtime messaging with replies, emoji reactions, and `:emoji:` and
`@mention` autocomplete, per-channel slowmode, image and video attachments, custom
emoji with role-coloured usernames, profile pictures and display names, moderation
(timeouts, kicks and bans), configurable storage retention, a two-way Discord
bridge (messages, images and videos, replies, reactions, mentions, edits and
deletes, with custom emoji matched by name), and an admin panel covering settings,
roles, members, channels, emoji, media, retention, the bridge, invites and bans.
Members can change their own password, and an administrator can edit any account's
username, display name, picture and password — which doubles as the password
reset, since there is no email. On the owner's first sign-in a setup wizard walks
through naming and theming the instance, storage retention, the Discord bridge,
and choosing which channels and emoji to import. It is a Progressive Web App, so
it installs to a phone or desktop home screen and runs without browser chrome.
The full HTTP and gateway API for custom clients and bots is documented in
[`docs/API.md`](docs/API.md).

## Tech stack

- **TypeScript** across the server, web client and (later) the Discord bridge
- **Fastify** HTTP API plus a **WebSocket gateway** on Node.js
- **SQLite** via Node's built-in `node:sqlite` — a single file, no native modules
- **Svelte 5 + Vite** single-page web client

## Requirements

- **Node.js 24 or newer** (relies on built-in SQLite and TypeScript type stripping)

## Getting started

```sh
npm install
npm run dev
```

- Web client: <http://127.0.0.1:5173>
- API and gateway: <http://127.0.0.1:8787>

Both bind to loopback only, so the instance is not reachable from other devices by default. To open
it to your local network — a phone on the same Wi-Fi, say — run `npm run dev:lan` instead. It starts
the same pair but lets the web client listen on every interface and prints a `Network:` URL to open
on the other device. The API and gateway stay on loopback and are reached through the web client's
proxy, so no other port needs opening.

Configuration is read from environment variables. Copy `.env.example` to `.env`
to override the defaults.

### Running it for real

In production a single process serves the built client, the API and the gateway
on one origin. Build the client once, then start the server:

```sh
npm ci
npm run build:web
npm start
```

Put a reverse proxy in front for TLS, and set `HARMONY_COOKIE_SECURE` and
`HARMONY_TRUST_PROXY` to match. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) has the
full walkthrough: the environment variables, Caddy and nginx examples, the
first-run checklist, backups and a systemd unit.

Other useful scripts:

- `npm run dev:server` / `npm run dev:web` — run one side only
- `npm run dev:lan` — like `npm run dev`, but the web client is reachable from other devices
- `npm run build:web` — production build of the web client
- `npm run typecheck` — type-check every workspace (`tsc` for the server and shared package,
  `svelte-check` for the web client)
- `npm run smoke` — boot a throwaway server and exercise the API end to end
- `npm run smoke:bridge` — exercise the Discord bridge against a fake transport

## Discord bridge

The bridge mirrors messages both ways. On the Discord side you need to:

1. Create an application and a bot at <https://discord.com/developers/applications>.
2. Enable the **Message Content** intent on the Bot page. This is a privileged intent, so the
   toggle only works for apps that Discord has approved for it.
3. Invite the bot with at least **View Channels**, **Send Messages**, **Read Message History**,
   **Add Reactions** and **Manage Webhooks**.

Then paste the token into **Admin → Bridge**, enable it, and pick a Discord channel when
creating or editing a Harmony channel. Only bridged channels sync.

Harmony users are mirrored to Discord as webhook messages, so they carry the author's display
name; Discord always marks webhook messages with an "APP" tag. Discord users appear in Harmony
as stand-in accounts created automatically the first time they post.

Text, images, videos, avatars, replies, reactions, edits and deletes are all mirrored in both
directions. Images and clips are transferred between the two systems, and anything that cannot be
mirrored (an unsupported file type, or one above the instance's upload limit) is preserved as a
link instead of being dropped. Discord's 2000 character message limit means longer Harmony messages
are truncated when mirrored out.

Custom emoji are matched by name: a Harmony `:YES:` is sent to Discord as its `<:YES:id>` tag,
and a Discord `<:YES:id>` tag is turned back into `:YES:` on the way in, rendering the Harmony
emoji of the same name. Reactions work both ways too. Mentions sync as well: a Discord `<@id>`
becomes a Harmony `@username` (creating a stand-in account if needed), and mentioning a bridged
user in Harmony pings them on Discord — only bridged users can ever be pinged, so no stray
notification escapes. Linking a channel, or starting the bridge, backfills the Discord channel's
recent history (bounded, idempotent, oldest first); there is also an **Admin → Bridge** button to
pull it again on demand. Two limitations come from mirroring through a single app account: Discord
webhooks cannot post real replies, so a Harmony reply is mirrored as a quoted line, and Discord
has no webhook reaction route at all, so the bot places reactions itself — they appear as the
bot, and one reaction stands in for however many Harmony users reacted.

Display names and profile pictures are mirrored to Discord automatically (they become the
webhook username and avatar). A Discord user's name and picture are imported into Harmony the
first time they post.

Discord fetches avatars directly from this instance, so outbound avatars need a **Public base
URL** set in **Admin → Bridge** — the address people use to reach the instance from the
internet. A `localhost` address will not work. Leave it blank to send names only.

## Project layout

```
apps/
  server/   Fastify API, WebSocket gateway and SQLite storage
  web/      Svelte 5 single-page client
packages/
  shared/   Types, permission bitfield, gateway protocol and zod schemas
docs/
  API.md          HTTP and gateway reference for custom clients and bots
  DEPLOYMENT.md   Running a real instance: TLS, settings, backups
```

Runtime data — the SQLite database and uploaded files — lives in `data/` and is
git-ignored.
