# Harmony, technically

The internals, the development setup and the full reference for the Discord
bridge. For running a real instance, see [DEPLOYMENT.md](DEPLOYMENT.md); for the
API, see [API.md](API.md). The friendly overview lives in the
[README](../README.md).

## How it is built

- **TypeScript** across the server, the web client and a shared package.
- **Fastify** for the HTTP API, plus a **WebSocket gateway** for realtime, on plain
  Node — no build step for the server, which runs its `.ts` files directly.
- **SQLite** through Node's built-in `node:sqlite`: one file, no database server to
  run and no database driver to install. Schema changes are hand-written,
  append-only migrations.
- **Svelte 5 + Vite** for the web client, a single-page app.

A production instance is a single process: the server serves the built client, the
API and the gateway on one origin, so there is nothing else to run and no CORS to
configure.

## Requirements

- **Node.js 24 or newer.** The project relies on Node stripping TypeScript types
  itself and on the built-in SQLite module.

## Repository layout

```
apps/
  server/   Fastify API, WebSocket gateway and SQLite storage
  web/      Svelte 5 single-page client
packages/
  shared/   Types, permission bitfield, gateway protocol and zod schemas
docs/
  API.md          HTTP and gateway reference for custom clients and bots
  DEPLOYMENT.md   Running a real instance: TLS, settings, backups
  TECHNICAL.md    This file
```

## Running it

### Development

```sh
npm install
npm run dev
```

- Web client: <http://127.0.0.1:5173>
- API and gateway: <http://127.0.0.1:8787>

Both bind to loopback only, so the instance is not reachable from other devices by
default. To open it to your local network — a phone on the same Wi-Fi, say — run
`npm run dev:lan` instead. It starts the same pair but lets the web client listen
on every interface and prints a `Network:` URL to open on the other device. The
API and gateway stay on loopback and are reached through the web client's proxy, so
no other port needs opening.

Configuration is read from environment variables; copy `.env.example` to `.env` to
override the defaults. Environment values only supply the **initial** defaults —
settings an admin can change at runtime (server name, theme, upload limits,
retention, the bridge) live in the database and are edited in the admin panel.

### Tests

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check every workspace (`tsc` for the server and shared package, `svelte-check` for the web client) |
| `npm run smoke` | Boot a throwaway server and exercise the API end to end |
| `npm run smoke:bridge` | Exercise the Discord bridge against a fake transport |
| `npm run smoke:text` | Check the markdown and link parser |

### Production

```sh
npm ci
npm run build:web
npm start
```

`npm start` is `node apps/server/src/index.ts`, which serves the built client from
`apps/web/dist` when it is there (override with `HARMONY_WEB_DIR`). Without a
build it serves the API only and says so on startup.

Other scripts: `npm run dev:server` and `npm run dev:web` run one side on its own,
and `npm run dev:web:lan` is the LAN variant of the client.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the environment-variable table, TLS, a
reverse proxy, backups and a systemd unit.

## Data and storage

Everything that matters lives in `data/` (override with `HARMONY_DATA_DIR`): the
SQLite database `harmony.db` and the uploaded blobs in `uploads/`.

Uploaded files are **content-addressed**: named by the SHA-256 of their bytes and
sharded into subdirectories by the first byte, so identical files are stored once
however many times they are posted. The database rows reference blobs by hash, and
retention pruning removes any blob nothing references any more. Backing up the
database and the `uploads/` folder together is therefore enough.

## Search

Message search is a case-insensitive substring match (`LIKE`) over the text, rather than a full-text
index. That is a deliberate trade for a server this size: the query reads the real table, so it can
never disagree with what is actually stored — no index to keep in step with edits, soft deletes or
retention pruning — at the cost of a scan that is imperceptible at the message counts one community
produces. The channels a searcher may see are resolved first and passed into the query, so a locked
channel cannot leak through a result.

If a very large instance ever needed ranking or word matching, SQLite's FTS5 is available in the
bundled build and would slot in behind the same endpoint.

## The Discord bridge

The bridge mirrors messages both ways. On the Discord side you need to:

1. Create an application and a bot at <https://discord.com/developers/applications>.
2. Enable the **Message Content** intent on the Bot page. This is a privileged
   intent, so the toggle only works for apps that Discord has approved for it.
3. Invite the bot with at least **View Channels**, **Send Messages**, **Read
   Message History**, **Add Reactions** and **Manage Webhooks**.

Then paste the token into **Admin → Bridge**, enable it, and pick a Discord channel
when creating or editing a Harmony channel. Only bridged channels sync. The setup
wizard walks through the same steps on a new instance.

Harmony users are mirrored to Discord as webhook messages, so they carry the
author's display name; Discord always marks webhook messages with an "APP" tag.
Discord users appear in Harmony as stand-in accounts created automatically the
first time they post.

Text, images, videos, avatars, replies, reactions, edits and deletes are all
mirrored in both directions. Images and clips are transferred between the two
systems, and anything that cannot be mirrored (an unsupported file type, or one
above the instance's upload limit) is preserved as a link instead of being dropped.
Discord's 2000 character message limit means longer Harmony messages are truncated
when mirrored out.

Custom emoji are matched by name: a Harmony `:YES:` is sent to Discord as its
`<:YES:id>` tag, and a Discord `<:YES:id>` tag is turned back into `:YES:` on the
way in, rendering the Harmony emoji of the same name. Reactions work both ways too.
Mentions sync as well: a Discord `<@id>` becomes a Harmony `@username` (creating a
stand-in account if needed), and mentioning a bridged user in Harmony pings them on
Discord — only bridged users can ever be pinged, so no stray notification escapes.
Linking a channel, or starting the bridge, backfills the Discord channel's recent
history (bounded, idempotent, oldest first); there is also an **Admin → Bridge**
button to pull it again on demand.

Two limitations come from mirroring through a single app account: Discord webhooks
cannot post real replies, so a Harmony reply is mirrored as a quoted line, and
Discord has no webhook reaction route at all, so the bot places reactions itself —
they appear as the bot, and one reaction stands in for however many Harmony users
reacted.

Display names and profile pictures are mirrored to Discord automatically (they
become the webhook username and avatar). A Discord user's name and picture are
imported into Harmony the first time they post. Since Discord fetches avatars
directly from this instance, outbound avatars need a **Public base URL** set in
**Admin → Bridge** — the address people use to reach the instance from the
internet. A `localhost` address will not work. Leave it blank to send names only.

## License

Harmony is free software, licensed under the
[GNU Affero General Public License v3.0 or later](../LICENSE).
