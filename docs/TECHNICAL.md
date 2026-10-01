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
| `npm run smoke:text` | Check the client's pure logic: the markdown and link parser, catching up after being away, and what the emoji picker offers |

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
2. Enable the **Message Content** and **Presence** intents on the Bot page. Both
   are privileged: the toggles work right away for a bot in fewer than 100
   servers, and need Discord's approval beyond that. Message Content is what makes
   message text readable. Presence is what tells Harmony who on the Discord side is
   online, for the member list of a bridged channel.
3. Invite the bot with at least **View Channels**, **Send Messages**, **Read
   Message History**, **Add Reactions** and **Manage Webhooks**.

Intents are read when the bot connects, so restart Harmony after changing them. If
an intent is requested that has not been enabled, Discord refuses the connection
outright (close code 4014) rather than degrading, and the bridge reports the failure
in **Admin → Bridge**.

Then paste the token into **Admin → Bridge**, enable it, and pick a Discord channel
when creating or editing a Harmony channel. Only bridged channels sync. The setup
wizard walks through the same steps on a new instance.

Harmony users are mirrored to Discord as webhook messages, so they carry the
author's display name; Discord always marks webhook messages with an "APP" tag.
Discord users appear in Harmony as stand-in accounts created automatically the
first time they post.

A stand-in account has no way to sign in, so its presence is never Harmony's own.
It is borrowed from Discord instead: the bridge keeps the guild's presences in
memory and marks a stand-in online or offline as its owner's status changes, with
the status sent on connect filling in everyone before anybody moves. None of it is
stored, so stopping the bridge or restarting Harmony simply drops the stand-ins back
to offline. Only accounts that already have a stand-in are announced — presence
covers every member of the Discord server, and creating an account for each of them
would bury the real members. An account created later still starts out online if its
owner was already around.

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

## Emoji

The picker offers two tabs. **Server** holds the instance's own uploaded emoji and
is the default, since those are the ones a member came here for. **Unicode** holds
the full set, grouped the way Unicode groups it. Search filters whichever tab is
open, matching names case-insensitively; while a search is running the group
headings and the row of common shortcuts step aside, because a handful of results
split across nine headings reads worse than one plain list.

The unicode set comes from the `unicode-emoji-json` package (MIT): the RGI subset,
the emoji likely to render everywhere, with skin tone variants collapsed onto the
emoji they belong to rather than listed as separate entries. It is roughly 277 kB
of JSON, fetched through a dynamic import only when a picker is first opened — so
it is code-split into its own chunk, about 30 kB over the wire, and a session that
never reacts to anything never pays for it. The package ships no types for the
grouped file, so the shape the picker relies on is asserted by the text smoke test
against the package itself, which is what would catch an upgrade changing it into
an empty list with no error anywhere.

## Notification sounds

Two sounds ship with the client, in `apps/web/public/sounds`: a louder one for a
message that mentions the member, by reply or by name, and a quieter one for the
rest. Each member can silence either from **Notifications** in their profile.
Both are on by default.

There is no push and no device notification anywhere in the project. Nothing leaves
the page: no service worker involvement, no permission prompt, no server doing any
delivery. That keeps the feature small and keeps a self-hosted instance from
needing certificate or vendor setup to nudge anybody, at the cost of only working
while a client is open. The server therefore stores two booleans and nothing else —
what the sound actually is, and when it plays, is the client's business.

Which messages count as a mention is decided by the same parser that renders them,
so a name inside a backtick block is a quotation rather than a summons.

## Links and media

A message's first link is resolved, and a small card is stored on the message. A link that points
straight at a picture is different: the bytes are fetched once and kept as an attachment of that
message, with the link it came from in the attachment's `source_url` column.

That column is what makes the rest work. It marks the attachment as having come from the text rather
than from the sender, which is how an edit knows to take the picture away again when the link goes,
how the bridge knows not to hand Discord a file for a link Discord can unfurl itself, and how a
resolution is skipped when the link has not actually changed. Anything with a null `source_url` was
uploaded by a person and belongs to the message; anything else is a copy of somebody else's file and
follows the text.

A message whose whole text is that link shows the picture and nothing else, the way Discord does: the
address is behind the picture for anyone who wants it, and printing it above would only be noise. A
message with anything else in it keeps its text, link and all. The picture itself links back to where
it came from, so the original is one right-click away.

The page half of this has one wrinkle worth knowing. A page may offer several preview images and they
are not equal — Giphy and Klipy both list a still WebP first and the animated GIF second — so the
animated one is preferred, recognised either from the `og:image:type` that follows it or from the
address itself. A reader that takes the first one gets a frozen picture, which is most of why a gif
link used to preview badly.

Giphy is handled a step earlier still. Its pages are not scraped at all: `giphy.com/gifs/…` and
`giphy.com/embed/…` are handed to Giphy's keyless oEmbed endpoint, which answers with the address of
the file itself. That address is then fetched by the ordinary guarded path, so a gif page behaves
exactly like a link straight at a gif and is kept as an attachment with no card. No account and no
key is involved, which is the rule this project holds to for every provider it recognises.

Tenor and Klipy have no such endpoint, so their pages are read instead: both name the gif in their own
preview metadata, and that address is fetched by the same guarded path and kept the same way. The two
differ only in access — Tenor serves its pages to anyone, while Klipy puts them behind a Cloudflare
challenge and hands them over to a recognised crawler name alone. That is precisely what the opt-in
`previewUserAgent` setting is for, and why Klipy page links preview only once it is set.

A Discord attachment link needs a different trick again, because the address itself is the problem:
Discord signs it and the signature expires, so a link copied out of the client usually arrives already
dead. Discord has an endpoint of its own for exactly this — the one its clients call to renew an
address — and when the bridge is connected the server asks it for a live address, which the ordinary
guarded path then fetches and keeps. It signs any attachment address, including one in a channel or a
server the bot has no access to, so nothing about where the file lives matters. Nothing is stored
when the bridge is off, which is why the feature costs an instance with no Discord presence nothing.

One detail is behind a surprising amount of the earlier unreliability: the fetch says it wants an
image first and only falls back to a page (`Accept: image/*, text/html;q=0.9`), rather than the other
way round. Giphy serves its media host by content negotiation on a single address — ask for `image/*`
and it returns the gif, ask for HTML and it returns a web page — so a client that asks for HTML first
is told about the gif it wanted and then wraps it in a card instead of showing it. Asking for the
picture first costs nothing when the answer really is a page, since that is still read exactly as
before.

It also makes the second and later postings of the same link free. Blobs are content-addressed, so
the bytes were only ever stored once; the row is what is per-message, and a row is a few hundred
bytes. What the column adds is the ability to notice before fetching that this instance already holds
the file, so a gif posted every morning is downloaded on the first morning and copied from the shelf
on every morning after. The trade is that a link is assumed to keep pointing at what it pointed at
the first time, which is how Discord, Slack and every other client treats them too.

The two also differ in what happens when they cannot be had. An image too large for the instance's
owner-configured upload limit is left as a card pointing at it through the proxy, rather than being
stored; a page's preview image is always only a reference. Nothing is kept that an upload of the same
file would have been refused.

## Saved gifs

A saved gif is held by content hash, in its own table, rather than by an attachment row. That is the
whole point: an attachment belongs to its message and is deleted along with it, and a saved gif has to
outlive the message it was found in. Keeping the hash instead means the bytes are shared with every
other copy of the same gif on the instance — saving one costs a row and nothing else.

It is also what keeps the bytes alive. The sweep deletes a blob only once nothing references it, and
that list of references now includes saved gifs alongside attachments, emoji, avatars and the
instance icon. So the image and message rules can take the attachment and the message away and the
blob stays, because a saved gif is still pointing at it.

That leaves the question of what eventually clears a saved gif up, and the answer is deliberately
one rule and no other: `favoriteRetentionDays`, counted from `used_at`, which moves whenever the gif
is saved or sent. `null` keeps them forever, which is the default — an instance that never turns the
rule on never loses one. Everything else the owner might set, including emergency pruning, leaves
them alone.

Picking a gif out of the picker is not a copy and not a fetch. It writes one attachment row pointing
at bytes that are already stored, owned by the person picking, and the message then claims it exactly
as it would an upload. That keeps a picked gif the same kind of thing as everything else in a message
— retention, the media gallery and the bridge already understand it — and makes picking instant.

The picker's other tab, This server, is a listing rather than a store: it reads recent gif
attachments, keeps one per content hash, and drops any channel the caller cannot see, through the
same role-aware helper the sidebar uses. The read is deliberately bounded to a few times the page
size, because the same handful of gifs get sent again and again and the rows far outnumber the
pictures — a bounded scan still fills a page with distinct gifs. What counts as a gif lives in one
place, the shared package's GIF_CONTENT_TYPES, and decides the listing, the hearts and what may be
saved alike; a screenshot is stored and shown like anything else but never turns up in a picker.

The hosted tab is the one part of the picker that talks to somebody else, and it only appears when
the instance has a key for it. Its search is asked for by the server and never by the browser,
because the key is part of the request path and would otherwise be readable by anyone who opens
their network tab. Nothing is stored until a gif is saved or picked, at which point the address is
fetched through the same guarded path a link preview uses and kept like anything else — so a hosted
gif becomes ours rather than a link that can expire under it. Only the service's own addresses are
accepted, which keeps the picker from becoming a way to make the server fetch arbitrary pages, and
one size is used for both the tile and the kept copy, so what somebody picks is what they were
looking at.

## Versioning

The release number lives in one place, `HARMONY_VERSION` in
`packages/shared/src/constants.ts`, and is what the About panel shows when a member
clicks the server name. It is deliberately not read from a `package.json`: nothing
in this repository is published to a registry, so a second number that has to be
kept in step would only be a way for the two to disagree.

Patch versions are for fixes, minor versions for features. The major number is the
owner's to raise, because it is the one that signals a break to people running an
instance.

The number is compiled into the web bundle, so an installed app that has not
reloaded since an update reports the version it was built with. The service worker
caches nothing, so one reload corrects it.

## License

Harmony is free software, licensed under the
[GNU Affero General Public License v3.0 or later](../LICENSE).
