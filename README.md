# harmony

Selfhosted discord alternative, aimed to make migration painless

## Status

Playable end to end: username/password auth with optional invites, channels and
categories, realtime messaging with replies and emoji reactions, image
attachments, custom emoji with role-coloured usernames, profile pictures and
display names, configurable storage retention, a two-way Discord bridge
(messages, images, replies, reactions, edits and deletes, with custom emoji
matched by name), and an admin panel covering settings, roles, members, channels,
emoji, retention, the bridge and invites. Still to come: the public API docs.

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

Configuration is read from environment variables. Copy `.env.example` to `.env`
to override the defaults.

Other useful scripts:

- `npm run dev:server` / `npm run dev:web` — run one side only
- `npm run build:web` — production build of the web client
- `npm run typecheck` — type-check every workspace
- `npm run smoke` — boot a throwaway server and exercise the auth API end to end

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

Text, images, avatars, replies, reactions, edits and deletes are all mirrored in both directions.
Images are transferred between the two systems, and anything that cannot be mirrored (a
non-image, or a file above Discord's 8 MB upload limit) is preserved as a link instead of being
dropped. Discord's 2000 character message limit means longer Harmony messages are truncated when
mirrored out.

Custom emoji are matched by name: a Harmony `:YES:` is sent to Discord as its `<:YES:id>` tag,
and a Discord `<:YES:id>` tag is turned back into `:YES:` on the way in, rendering the Harmony
emoji of the same name. Reactions work both ways too. Two limitations come from mirroring
through a single app account: Discord webhooks cannot post real replies, so a Harmony reply is
mirrored as a quoted line, and Discord has no webhook reaction route at all, so the bot places
reactions itself — they appear as the bot, and one reaction stands in for however many Harmony
users reacted.

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
```

Runtime data — the SQLite database and uploaded files — lives in `data/` and is
git-ignored.
