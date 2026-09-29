# Harmony API

Harmony exposes a JSON HTTP API and a WebSocket gateway so you can build custom clients, bots
and integrations. This document is the reference for both.

The canonical definitions live in [`packages/shared/src`](../packages/shared/src): the TypeScript
types (`types.ts`, `api.ts`), the gateway protocol (`gateway.ts`), request schemas (`schemas.ts`)
and the permission bitfield (`permissions.ts`). If this document and the code ever disagree, the
code wins — please open an issue.

> Status: this covers everything in the 1.0 feature set. Some permission flags are defined but not
> yet enforced; those are marked as reserved below.

## Contents

- [Base URL and versioning](#base-url-and-versioning)
- [Authentication](#authentication)
- [Errors](#errors)
- [Permissions](#permissions)
- [Rate limits](#rate-limits)
- [Object shapes](#object-shapes)
- [REST reference](#rest-reference)
  - [Health and meta](#health-and-meta)
  - [Auth](#auth)
  - [Channels and categories](#channels-and-categories)
  - [Messages](#messages)
  - [Reactions](#reactions)
  - [Attachments](#attachments)
  - [Custom emoji](#custom-emoji)
  - [Users and avatars](#users-and-avatars)
  - [Roles](#roles)
  - [Members](#members)
  - [Invites](#invites)
  - [Server settings](#server-settings)
  - [Retention](#retention)
  - [Discord bridge](#discord-bridge)
- [The gateway (WebSocket)](#the-gateway-websocket)
- [Worked example](#worked-example)
- [Limitations](#limitations)

## Base URL and versioning

All REST routes live under `/api/v1`. Replace `HOST` with your instance's address:

```
https://chat.example.com/api/v1
```

The gateway is a WebSocket at `wss://chat.example.com/gateway` (note: **not** under `/api/v1`).
Use `wss://`/`https://` when the instance is served over TLS, and `ws://`/`http://` otherwise.

One Harmony instance is one server. There is no notion of multiple guilds, so no route carries a
server or guild id.

## Authentication

Harmony uses opaque session tokens. There is no OAuth and no email.

A token is returned by `POST /api/v1/auth/register` and `POST /api/v1/auth/login`. Send it on
every request in one of two ways:

- **Bearer header** — for bots, scripts and native clients:
  ```
  Authorization: Bearer <token>
  ```
- **Session cookie** — set automatically by register/login, for browser clients on the same
  origin. The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when the instance runs over TLS.

The first account ever registered becomes the server owner (`isOwner: true`) and is exempt from the
invite requirement. Every later registration may require a valid invite code, depending on the
instance's `requireInvite` setting (see `GET /api/v1/meta`).

Tokens expire after `HARMONY_SESSION_TTL_DAYS` (default 30 days) or when you logout.

## Errors

Every error response has the same shape:

```json
{ "error": { "code": "forbidden", "message": "You do not have permission to do that." } }
```

`code` is a stable, machine-readable string; `message` is human-readable and may change. Common
status codes and their codes:

| Status | Codes you may see |
| --- | --- |
| 400 | `validation_error`, `invalid_reply`, `invalid_emoji`, `invalid_attachment`, `invalid_upload`, `default_role`, `cannot_moderate_self`, `cannot_moderate_bot` |
| 401 | `unauthorized`, `invalid_credentials` |
| 403 | `forbidden`, `timed_out`, `account_banned`, `target_is_admin`, `invite_required`, `invalid_invite`, `invite_expired`, `invite_exhausted`, `immutable_role`, `permission_escalation` |
| 404 | `not_found`, `channel_not_found`, `message_not_found`, `role_not_found`, `user_not_found`, `emoji_not_found`, `attachment_not_found`, `avatar_not_found`, `not_banned` |
| 409 | `username_taken`, `emoji_exists`, `discord_channel_taken` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type`, `invalid_image` |
| 429 | `rate_limited` |
| 500 | `internal_error` |

`validation_error` means the body or query string failed schema validation; its `message` names the
offending field. A missing route returns `404` with `{ "error": { "code": "not_found", ... } }`.

## Permissions

Permissions are a bitfield, granted through roles. `Administrator` implies every other flag. The
implicit `@everyone` role grants every member `ViewChannels`, `SendMessages`, `AttachFiles`,
`AddReactions` and `CreateInvites` by default.

| Flag | Bit | Enforced by |
| --- | --- | --- |
| `ViewChannels` | `1 << 0` | Reading channels, messages, roles, emoji and attachments |
| `SendMessages` | `1 << 1` | Posting messages |
| `ManageMessages` | `1 << 2` | Deleting others' messages, clearing reactions |
| `AttachFiles` | `1 << 3` | Uploading attachments |
| `EmbedLinks` | `1 << 4` | *Reserved* — not enforced yet |
| `AddReactions` | `1 << 5` | Adding and removing your own reactions |
| `ManageChannels` | `1 << 6` | Creating, editing and deleting channels and categories |
| `ManageRoles` | `1 << 7` | Managing roles and members' roles |
| `ManageEmojis` | `1 << 8` | Uploading and deleting custom emoji |
| `ManageServer` | `1 << 9` | Server settings, retention and the Discord bridge |
| `KickMembers` | `1 << 10` | Ending a member's sessions |
| `BanMembers` | `1 << 11` | Banning and unbanning members |
| `CreateInvites` | `1 << 12` | Minting invite codes |
| `MentionEveryone` | `1 << 13` | *Reserved* — not enforced yet |
| `Administrator` | `1 << 14` | Implies every flag above |
| `ModerateMembers` | `1 << 15` | Putting members in a timeout |

Over the wire, permission bitfields are **decimal strings** (`"1"`, `"2081"`), never JSON numbers,
because JSON cannot carry a 64-bit integer. `GET /api/v1/auth/me` returns your effective
permissions; roles expose theirs via `GET /api/v1/roles`.

When creating or editing roles, you cannot grant a permission you do not hold yourself unless you
have `Administrator` (an anti-escalation guard); doing so returns `403 permission_escalation`.

## Rate limits

Only registration and login are rate limited: **10 requests per minute per IP**, after which the
instance replies `429 rate_limited`. The limiter is per-process and in-memory, which is fine for a
single-instance community.

## Object shapes

These appear across the API. Timestamps are ISO 8601 strings; ids are opaque strings.

```ts
type User = {
  id: string;
  username: string;
  displayName: string | null;   // falls back to username in the UI
  avatarHash: string | null;    // see "Users and avatars"
  roleColor: number | null;     // packed RGB integer, from the highest coloured role
  isBot: boolean;               // true for Discord stand-in accounts
  isOwner: boolean;
  createdAt: string;
  timedOutUntil: string | null; // end of an active timeout, else null
  showTyping: boolean;          // typing indicators on/off for this user
};

type Category = {
  id: string;
  name: string;
  position: number;
  requiredRoleId: string | null; // a role required to see it and its channels
};

type Channel = {
  id: string;
  name: string;
  topic: string | null;
  type: 'text';                 // only text channels exist in 1.0
  categoryId: string | null;    // null means "no category"
  position: number;
  createdAt: string;
  discordChannelId: string | null; // set when bridged
  requiredRoleId: string | null;   // its own lock, or null to inherit the category's
};

type Attachment = {
  id: string;
  messageId: string | null;     // null until attached to a message
  filename: string;
  contentType: string;
  size: number;                 // bytes
  width: number | null;
  height: number | null;
  hash: string;                 // content hash; blob is immutable
  createdAt: string;
};

type Reaction = {
  emoji: string;                // a unicode character, or ":name:" for a custom emoji
  emojiId: string | null;       // the custom emoji id when emoji is ":name:"
  count: number;
  me: boolean;                  // whether the requesting user reacted
};

type MessageReference = {
  id: string;
  author: User | null;
  content: string;              // "" when the parent was deleted
  deleted: boolean;
};

type Message = {
  id: string;
  channelId: string;
  author: User | null;          // null when the account was deleted
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachments: Attachment[];
  replyTo: MessageReference | null;
  reactions: Reaction[];
  embed: LinkEmbed | null;      // link preview, see "Link previews"
};

type LinkEmbed = {
  url: string;                  // the final URL after redirects
  title: string | null;
  description: string | null;
  siteName: string | null;      // og:site_name, or the host name
};

type Role = {
  id: string;
  name: string;
  color: number | null;         // packed RGB, or null for the default colour
  position: number;             // display/colour ordering only
  permissions: string;          // decimal bitfield string
  hoist: boolean;               // true gives the role its own member list group
  mentionable: boolean;
  isDefault: boolean;           // true only for @everyone
};

// The two colours an admin picks. Everything else is derived, see "Theming".
type ThemeSettings = {
  background: string | null;    // #rrggbb, or null for the built-in default
  accent: string | null;
};

type Emoji = { id: string; name: string; hash: string; animated: boolean };

type Invite = {
  code: string;
  createdAt: string;
  expiresAt: string | null;     // null = never expires
  maxUses: number | null;       // null = unlimited
  uses: number;
};

type Ban = {
  user: User;
  bannedBy: User | null;        // null if the moderator's account is gone
  reason: string | null;
  createdAt: string;
};
```

### Mentions

Mentions are written as `@username` in a message's `content`. Usernames are unique and contain
no spaces, so a mention is unambiguous; the lookbehind in the parser keeps an `@` inside an email
(`a@b.com`) from counting. `@everyone` and `@here` are reserved and never resolve.

The content keeps the **username**, not the display name, so a renaming display name never breaks
a mention. To render one, resolve the token against the `username` field of every entry in
[`GET /api/v1/members/directory`](#get-apiv1membersdirectory--viewchannels). A token that does not
match anyone is plain text. A client may also highlight a message whose mentions include its own
user id.

## REST reference

Unless stated otherwise, request bodies are JSON with `Content-Type: application/json`, and
responses are JSON.

### Health and meta

#### `GET /api/v1/health` — no auth

Liveness probe.

```json
{
  "status": "ok",
  "name": "Harmony",
  "apiVersion": "v1",
  "gatewayVersion": 1,
  "database": "ok",
  "uptimeSeconds": 1234
}
```

#### `GET /api/v1/meta` — no auth

Public instance information a client needs before signing in.

```json
{
  "name": "My Community",
  "apiVersion": "v1",
  "requireInvite": true,
  "theme": { "background": null, "accent": null },
  "maxUploadBytes": 10485760,
  "allowedImageTypes": ["image/png", "image/jpeg", "image/gif", "image/webp"],
  "limits": {
    "messageLength": 4000,
    "attachmentsPerMessage": 10,
    "channelNameMax": 64,
    "usernameMin": 2,
    "usernameMax": 32,
    "passwordMin": 8
  }
}
```

### Auth

#### `POST /api/v1/auth/register` — no auth, rate limited

```json
{ "username": "alice", "password": "hunter2hunter2", "inviteCode": "abc123" }
```

`username` is 2–32 characters from `A-Z a-z 0-9 . _ -`. `password` is 8–200 characters.
`inviteCode` is required only when the instance requires invites (`403 invite_required`) and is
ignored for the very first account. Returns an `AuthResponse`:

```json
{ "user": { "...": "..." }, "token": "harmony_session_token" }
```

Possibly errors: `409 username_taken`, `403 invite_required` / `invalid_invite` /
`invite_expired` / `invite_exhausted`.

#### `POST /api/v1/auth/login` — no auth, rate limited

```json
{ "username": "alice", "password": "hunter2hunter2" }
```

Returns `AuthResponse`. Errors: `401 invalid_credentials`.

#### `POST /api/v1/auth/logout` — auth

Invalidates the current session and clears the cookie. Returns `{ "ok": true }`.

#### `GET /api/v1/auth/me` — auth

```json
{ "user": { "...": "..." }, "permissions": "2081" }
```

### Channels and categories

#### `GET /api/v1/channels` — `ViewChannels`

```json
{ "categories": [ /* Category */ ], "channels": [ /* Channel */ ], "defaultChannelId": "..." }
```

`defaultChannelId` is the channel the server has configured to open on load, or `null` to fall back
to the first channel. It is read fresh on every request, so a client sees an admin's change on the
next load.

#### `POST /api/v1/channels` — `ManageChannels`

```json
{ "name": "general", "topic": null, "categoryId": null, "discordChannelId": null }
```

`topic`, `categoryId`, `discordChannelId` and `requiredRoleId` are optional. Linking a
`discordChannelId` requires a configured bridge and a Discord channel not already linked elsewhere
(`409 discord_channel_taken`). `requiredRoleId` must name a real role (`400 invalid_role`) and locks
the channel; see [Channel locking](#channel-locking). Returns the new `Channel` and fires
`CHANNEL_CREATE`.

#### `PATCH /api/v1/channels/:id` — `ManageChannels`

Any of `name`, `topic`, `categoryId`, `position`, `discordChannelId`, `requiredRoleId`. Returns the
updated `Channel` and fires `CHANNEL_UPDATE`. Changing `categoryId` appends the channel to the end of
the target category, unless `position` is given explicitly. `requiredRoleId: null` drops the
channel's own lock, so it falls back to its category's.

#### `POST /api/v1/channels/:id/move` — `ManageChannels`

```json
{ "direction": "up" }
```

`direction` is `up` or `down`. Swaps the channel with its neighbour inside its own category, so it
is a no-op at either end. Returns the moved `Channel` and fires `CHANNEL_UPDATE`.

#### `DELETE /api/v1/channels/:id` — `ManageChannels`

Returns `204`. Fires `CHANNEL_DELETE` with `{ "id": "..." }`. If the deleted channel was the
configured `defaultChannelId`, that preference is cleared.

#### `POST /api/v1/channels/:id/typing` — `SendMessages`

Announces that you are typing in a channel. Returns `204` and fires `TYPING_START`. It is best
effort: the server throttles it per user, a timed-out member is refused, and a member with
`showTyping` off broadcasts nothing. Call it at most every few seconds while typing.

#### `POST /api/v1/categories` — `ManageChannels`

```json
{ "name": "Text Channels", "requiredRoleId": null }
```

Returns the new `Category`, fires `CATEGORY_CREATE`. `requiredRoleId` must name a real role
(`400 invalid_role`) and locks the category and every channel inside it.

#### `PATCH /api/v1/categories/:id` — `ManageChannels`

`{ "name"?: string, "position"?: number, "requiredRoleId"?: string | null }`. Returns the
`Category`, fires `CATEGORY_UPDATE`.

#### `POST /api/v1/categories/:id/move` — `ManageChannels`

```json
{ "direction": "up" }
```

`direction` is `up` or `down`. Swaps the category with its neighbour in the sidebar order, so it is
a no-op at either end. Returns the moved `Category` and fires `CATEGORY_UPDATE`.

#### `DELETE /api/v1/categories/:id` — `ManageChannels`

Returns `204`, fires `CATEGORY_DELETE` with `{ "id": "..." }`. A category that still holds
channels cannot be deleted: the request is refused with `409 category_not_empty`. Move or delete its
channels first.

### Channel locking

A channel or category may require a single role. It is deliberately not a permission system: there is
one requirement per resource and no overwrites.

- A member sees a channel when they hold the role it requires.
- A channel with no role of its own inherits its category's, so locking a category covers everything
  inside it. A channel can tighten that further, but never loosen it: a channel whose category is
  hidden is hidden too.
- Anyone with `Administrator` — which includes the instance owner — bypasses every requirement.
- `GET /api/v1/channels` leaves out locked channels and categories a member cannot see, rather than
  listing them and refusing access.
- Reading, posting, editing, deleting, reacting and typing in a locked channel all fail with
  `403 channel_forbidden`.
- Gateway events are filtered per member too, so `MESSAGE_CREATE`, reactions and typing for a locked
  channel are never sent to someone who cannot see it.

One deliberate gap: an attachment's bytes are served by id to anyone with `ViewChannels`, because
attachment ids are unguessable capability URLs. Someone with access to a locked channel can therefore
hand out a working image link; treat that as sharing the file, not as a leak.

### Messages

#### `GET /api/v1/channels/:id/messages` — `ViewChannels`

Returns up to 100 messages in ascending order (oldest first).

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Return messages older than this timestamp |
| `beforeId` | string | — | Id of the message `before` came from |

```json
{ "messages": [ /* Message */ ] }
```

To page backwards, pass the `createdAt` **and** the `id` of the oldest message you already have as
`before` and `beforeId`. The id matters: `createdAt` only has millisecond precision, so a burst of
messages (a bridge history import, for instance) can share a timestamp, and a timestamp-only cursor
would skip the rest of that millisecond.

#### `POST /api/v1/channels/:id/messages` — `SendMessages`

```json
{ "content": "hello", "attachmentIds": ["..."], "replyToId": null }
```

At least one of `content` or `attachmentIds` is required. `attachmentIds` must reference uploads
you own that are not already attached (see [Attachments](#attachments)). `replyToId` must point at
a visible message in the same channel, else `400 invalid_reply`. Returns the new `Message` and
fires `MESSAGE_CREATE`.

#### `PATCH /api/v1/messages/:id` — auth (author only)

```json
{ "content": "edited text" }
```

Only the author may edit; anyone else, including administrators, gets `403 forbidden`. Returns the
updated `Message` (with `editedAt` set) and fires `MESSAGE_UPDATE`.

#### `DELETE /api/v1/messages/:id` — auth (author or `ManageMessages`)

Returns `204` and fires `MESSAGE_DELETE`. Deletion is a soft delete: replies to the message keep a
stub, and the bridge mirrors the removal to Discord.

#### Link previews

When `embedsEnabled` is on, the server takes the first link a message contains and, if it can reach
it, attaches a small `embed` and fires a second `MESSAGE_UPDATE` carrying it. Only the first link is
used, and only text is extracted — no remote images are fetched or stored.

Links inside code, masked links (`[text](url)`) and angle-bracket links (`<url>`) are never
unfurled. The fetch is guarded: `http` and `https` only, the host must resolve to a public address,
and redirects are limited and re-checked at each hop. Editing a message drops its old preview and
resolves the new text. Turn previews off instance-wide with `embedsEnabled` in the server settings.

### Reactions

An emoji is either a unicode character (send it verbatim, e.g. `"👍"`) or a custom emoji shortcode
`":name:"` paired with its `emojiId`.

#### `POST /api/v1/messages/:id/reactions` — `AddReactions`

```json
{ "emoji": "👍" }
{ "emoji": ":YES:", "emojiId": "6b1f..." }
```

Toggles your own reaction: adds it if absent, removes it if present. Returns the updated `Message`
and fires `MESSAGE_REACTION_ADD` or `MESSAGE_REACTION_REMOVE`.

#### `DELETE /api/v1/messages/:id/reactions` — `ManageMessages`

| Query | Type |
| --- | --- |
| `emoji` | required, the unicode character or `:name:` |
| `emojiId` | the custom emoji id, when applicable |

Clears **everyone's** reactions for that emoji. Returns the updated `Message` and fires
`MESSAGE_REACTIONS_CLEAR`.

### Attachments

Uploads are two steps: upload the bytes, then attach the returned id to a message.

#### `POST /api/v1/attachments` — `AttachFiles`

`multipart/form-data` with a single `file` field. The image type must be one of the instance's
`allowedImageTypes`, and the size must be within `maxUploadBytes` (else `413` / `415`). Returns an
`Attachment` whose `messageId` is `null`.

#### `GET /api/v1/attachments/:id` — `ViewChannels`

Serves the image bytes with a long-lived immutable cache header. Uploads that are never attached
to a message are eventually removed by [retention](#retention).

#### `DELETE /api/v1/attachments/:id` — `ManageServer`

Deletes a stored attachment; the message stays, minus the image. Storage is content-addressed, so
the bytes are only removed once no attachment, emoji or avatar still points at them. Returns `204`,
or `404 attachment_not_found`.

### Media gallery

The admin gallery lists every stored image in one place.

#### `GET /api/v1/media` — `ManageServer`

A page of stored media, **newest first**.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Older than this timestamp |
| `beforeId` | string | — | The attachment id `before` came from |

The cursor works exactly like message history's: send the oldest item's `createdAt` and `id`
together.

```json
{
  "media": [
    {
      "attachment": { "...": "..." },
      "uploader": { "...": "..." },
      "channelId": "...",
      "channelName": "general"
    }
  ]
}
```

`uploader`, `channelId` and `channelName` are `null` for an upload that was never attached to a
message.

### Custom emoji

#### `GET /api/v1/emojis` — `ViewChannels`

```json
{ "emojis": [ /* Emoji */ ] }
```

#### `POST /api/v1/emojis` — `ManageEmojis`

`multipart/form-data` with a `name` field and a `file` field. Names use 2–32 characters from
`A-Z a-z 0-9 _` and are unique (`409 emoji_exists`). Returns the new `Emoji` and fires
`EMOJI_CREATE`. In messages, write a custom emoji as `:name:`.

#### `GET /api/v1/emojis/:id` — `ViewChannels`

Serves the emoji image with an immutable cache header.

#### `DELETE /api/v1/emojis/:id` — `ManageEmojis`

Returns `204` and fires `EMOJI_DELETE` with `{ "id": "..." }`.

### Users and avatars

#### `PATCH /api/v1/users/@me` — auth

```json
{ "displayName": "Alice the Great", "showTyping": true }
```

`displayName` and `showTyping` are both optional, but at least one is required. `displayName` may be
up to 32 characters; `null` or `""` clears it. `showTyping` turns typing indicators off entirely for
the user: they neither send nor see them. Returns `MeResponse`.

#### `PUT /api/v1/users/@me/avatar` — auth

`multipart/form-data` with a single `file` field (an image). The picture is normalised server-side
to a 256×256 WebP. Returns `MeResponse`.

#### `DELETE /api/v1/users/@me/avatar` — auth

Clears your picture and returns `MeResponse`.

#### `GET /api/v1/users/:id/avatar`

Serves a user's picture as WebP. Normally requires `ViewChannels`, but you may pass a capability
query parameter to fetch it without a session:

```
GET /api/v1/users/<id>/avatar?v=<avatarHash>
```

If `v` matches the user's current `avatarHash` the request is allowed anonymously, otherwise the
normal `ViewChannels` check applies. This exists so Discord's servers can fetch avatars for
mirrored messages; the hash is already public in every avatar URL. Returns `404 avatar_not_found`
when the user has no picture.

### Roles

#### `GET /api/v1/roles` — `ViewChannels`

```json
{ "roles": [ /* Role */ ] }
```

#### `POST /api/v1/roles` — `ManageRoles`

```json
{ "name": "Moderator", "color": 5793266, "permissions": "3", "hoist": false, "mentionable": true }
```

`color` is a packed RGB integer or `null`. `permissions` is a decimal bitfield string. Returns the
new `Role` and fires `ROLE_CREATE`. Granting a permission you lack is rejected with
`403 permission_escalation`.

#### `PATCH /api/v1/roles/:id` — `ManageRoles`

Any of `name`, `color`, `permissions`, `hoist`, `mentionable`. The `@everyone` role cannot be
renamed (`403 immutable_role`). Returns the `Role` and fires `ROLE_UPDATE`.

#### `POST /api/v1/roles/:id/move` — `ManageRoles`

```json
{ "direction": "up" }
```

`direction` is `"up"` or `"down"`. Role positions affect only display, including which role's
colour is shown for a user (the highest-positioned coloured role wins). The `@everyone` role cannot
be reordered. Returns the full `{ "roles": [...] }` list.

#### `DELETE /api/v1/roles/:id` — `ManageRoles`

Returns `204`, fires `ROLE_DELETE` with `{ "id": "..." }`. The `@everyone` role cannot be deleted.

### Members

#### `GET /api/v1/members` — `ManageRoles`

```json
{
  "members": [
    { "user": { "...": "..." }, "roleIds": ["..."], "permissions": "2081" }
  ]
}
```

#### `GET /api/v1/members/directory` — `ViewChannels`

```json
{ "users": [ /* User */ ] }
```

Every member's public profile, with no roles or permissions. This is what clients
use to resolve and autocomplete `@username` mentions (see
[Mentions](#mentions)), so unlike the management view above it is readable by
anyone with `ViewChannels`.

#### `GET /api/v1/members/roster` — `ViewChannels`

```json
{
  "members": [
    { "user": { "...": "..." }, "roleIds": ["..."], "online": true }
  ]
}
```

The member list sidebar. Like the directory it is readable by anyone with
`ViewChannels`, but it adds each member's role ids and a live `online` flag, and
leaves out permissions. Group members by their highest hoisted role to match how
the server orders them; a `Role.hoist` of `true` gives a role its own section,
ordered by `Role.position` from highest to lowest.

Presence is not stored: a member is online while they hold at least one live
gateway connection. Clients keep it current with `PRESENCE_UPDATE` rather than
refetching this endpoint.

#### `PUT /api/v1/members/:userId/roles/:roleId` — `ManageRoles`

Assigns a role. Returns `204` and fires `MEMBER_UPDATE` with `{ "userId": "..." }`. The `@everyone`
role is implicit and cannot be assigned (`400 default_role`).

#### `DELETE /api/v1/members/:userId/roles/:roleId` — `ManageRoles`

Removes a role. Returns `204` and fires `MEMBER_UPDATE`.

### Moderation

Timeouts, kicks and bans share one rule set, deliberately without a role hierarchy: **nobody may
moderate themselves, a Discord stand-in account, or anyone holding `Administrator`** (which
includes the instance owner). Those targets return `400 cannot_moderate_self`,
`400 cannot_moderate_bot` and `403 target_is_admin`. The permission check runs first, so a member
without the flag simply gets `403 forbidden`.

#### `PUT /api/v1/members/:userId/timeout` — `ModerateMembers`

```json
{ "durationMinutes": 10 }
```

Puts the member in a timeout of 1 minute up to 28 days. A timed out member keeps read access but
cannot post messages, edit them, react or upload attachments — each of those returns
`403 timed_out`. Returns `204` and fires `MEMBER_UPDATE`.

#### `DELETE /api/v1/members/:userId/timeout` — `ModerateMembers`

Lifts the timeout. Returns `204` and fires `MEMBER_UPDATE`.

#### `POST /api/v1/members/:userId/kick` — `KickMembers`

Ends every session the member has and closes their gateway connections (close code `4005`). They
may sign in again. Returns `204` and fires `MEMBER_UPDATE`.

#### `PUT /api/v1/members/:userId/ban` — `BanMembers`

```json
{ "reason": "spamming" }
```

`reason` is optional (up to 300 characters). Bans the member: their sessions end, their connections
close, and every future login fails with `403 account_banned`. They disappear from the member list
and the directory. Returns `204` and fires `MEMBER_UPDATE`.

#### `DELETE /api/v1/members/:userId/ban` — `BanMembers`

Lifts the ban (`404 not_banned` when there was none). Returns `204` and fires `MEMBER_UPDATE`.

#### `GET /api/v1/bans` — `BanMembers`

```json
{ "bans": [ /* Ban */ ] }
```

### Invites

#### `GET /api/v1/invites` — `ManageServer`

```json
{ "invites": [ /* Invite */ ] }
```

#### `POST /api/v1/invites` — `CreateInvites`

```json
{ "maxUses": 10, "expiresInHours": 24 }
```

Both fields are optional and independent; omit or pass `null` for unlimited / never-expiring.
Returns the new `Invite`. Note `CreateInvites` is granted to `@everyone` by default, so any member
can mint codes unless an administrator changes that role.

#### `DELETE /api/v1/invites/:code` — `ManageServer`

Returns `204`.

### Server settings

#### `GET /api/v1/settings` — `ManageServer`

```json
{
  "serverName": "My Community",
  "requireInvite": true,
  "defaultChannelId": null,
  "embedsEnabled": true,
  "theme": { "background": "#1e1b2e", "accent": "#eb459e" }
}
```

#### `PATCH /api/v1/settings` — `ManageServer`

`{ "serverName"?: string, "requireInvite"?: boolean, "defaultChannelId"?: string | null,
"embedsEnabled"?: boolean, "theme"?: { "background"?: string | null, "accent"?: string | null } }`.
Returns the updated settings. `serverName` and `theme` changing also update `GET /api/v1/meta`.
`defaultChannelId` must reference an existing channel, or `400 invalid_default_channel`; `null`
clears the preference. `embedsEnabled` turns link previews on or off for the whole instance.

### Theming

An instance is themed with just two colours, both `#rrggbb` or `null` for the built-in default:

```ts
type ThemeSettings = { background: string | null; accent: string | null };
```

Everything else the client renders with is derived from those two, so an admin never has to reason
about contrast. In short: the panel surfaces step away from the background, the text is mixed
towards the opposite end so it stays readable on both dark and light backgrounds, the translucent
hover and active overlays flip from white to black with the theme, and the colour placed on top of
accent surfaces switches between black and white depending on how bright the accent is.

The tokens a client should set are `--h-bg`, `--h-bg-elevated`, `--h-bg-deep`, `--h-text`,
`--h-text-muted`, `--h-accent`, `--h-on-accent`, `--h-hover` and `--h-active`, each from the matching
field of `deriveTheme`, plus `color-scheme` from its `scheme`. The server itself computes none of
this: it stores the two colours and hands them to clients, which may use the exported `deriveTheme`
from this package or simply read the tokens a Harmony client already publishes.

### Retention

Retention automatically prunes old content and can cap total storage. Any rule set to `null` is
switched off.

```ts
type RetentionSettings = {
  imageRetentionDays: number | null;
  messageRetentionDays: number | null;
  storageLimitBytes: number | null;
  storageTargetBytes: number | null;
};

type RetentionUsage = { blobBytes: number; attachmentCount: number; messageCount: number };

type PruneSummary = {
  ranAt: string;
  deletedAttachments: number;
  deletedMessages: number;
  deletedBlobs: number;
  freedBytes: number;
};
```

#### `GET /api/v1/retention` — `ManageServer`

Returns `{ settings, usage, lastRun }`, where `lastRun` is a `PruneSummary` or `null`.

#### `PATCH /api/v1/retention` — `ManageServer`

Any subset of `imageRetentionDays`, `messageRetentionDays`, `storageLimitBytes`,
`storageTargetBytes`; `null` disables a rule. Returns the same shape as `GET`.

#### `POST /api/v1/retention/run` — `ManageServer`

Runs the pruner immediately and returns `{ summary, usage }`. Fires `RETENTION_APPLIED`.

### Discord bridge

#### `GET /api/v1/bridge` — `ManageServer`

```ts
type BridgeResponse = {
  configured: boolean;      // whether a bot token is saved
  enabled: boolean;
  publicBaseUrl: string | null;
  status: { ready: boolean; botTag: string | null; guildName: string | null; error: string | null };
};
```

The token itself is never returned.

#### `PATCH /api/v1/bridge` — `ManageServer`

```json
{ "token": "MTIz...", "enabled": true, "publicBaseUrl": "https://chat.example.com" }
```

The token and public base URL are optional; an empty-string token clears the saved one, and an
empty public base URL disables outbound avatars. `publicBaseUrl` must be an `http(s)` address (else
`400`). Returns `BridgeResponse`.

#### `GET /api/v1/bridge/channels` — `ManageServer`

```json
{ "guildName": "My Discord", "channels": [ { "id": "123", "name": "general" } ] }
```

Discord text channels the bot can see, for linking to a Harmony channel.

#### `POST /api/v1/bridge/test` — `ManageServer`

```json
{ "channelId": "<harmony channel id>" }
```

Sends a test message to the linked Discord channel so an administrator can verify the setup.
Returns `{ "ok": true }`, or `502 bridge_test_failed` with Discord's own error message.

#### `POST /api/v1/bridge/import` — `ManageServer`

```json
{ "channelId": "<harmony channel id>", "limit": 50 }
```

Pulls the most recent Discord messages into a bridged channel, oldest first, keeping their original
timestamps, authors, attachments, replies and mentions. Linking a channel already triggers this,
and the bridge backfills every bridged channel when it connects, so this endpoint is for pulling
history again on demand. `limit` defaults to 50 (1–100). Messages already imported are recognised
by their Discord id and skipped, so it is safe to call repeatedly. Returns
`{ "imported": 2 }` with how many new messages landed.

Note that imported messages carry their original (possibly old) timestamps, so a retention rule that
deletes old messages will apply to them.

## The gateway (WebSocket)

Connect to `ws(s)://<host>/gateway`. The gateway pushes realtime events; writes still go through
REST.

The protocol mirrors Discord's framing: every message is a JSON object `{ op, t?, d? }`.

### Handshake

1. The server immediately sends **HELLO** (`op: 10`):
   ```json
   { "op": 10, "d": { "heartbeat_interval": 45000, "gateway_version": 1 } }
   ```
2. The client sends **IDENTIFY** (`op: 2`). External clients pass their session token:
   ```json
   { "op": 2, "d": { "token": "harmony_session_token" } }
   ```
   Browser clients on the same origin may send `{ "op": 2, "d": {} }` and rely on the session
   cookie sent with the WebSocket handshake.
3. On success the server sends **READY** (`op: 0`, `t: "READY"`):
   ```json
   { "op": 0, "t": "READY", "d": { "user": { "...": "..." }, "gateway_version": 1 } }
   ```
   On failure it closes the socket with code **4004**.

### Heartbeat

Send `{ "op": 1, "d": null }` every `heartbeat_interval` milliseconds; the server replies with
`{ "op": 11, "d": null }`. Heartbeats are optional but recommended to detect dead connections.

### Dispatch events

Dispatched frames use `op: 0` with a `t` name and `d` payload:

| Event | Payload |
| --- | --- |
| `READY` | `{ user, gateway_version }` |
| `MESSAGE_CREATE` | `Message` |
| `MESSAGE_UPDATE` | `Message` (edits, link previews, and bridged edits) |
| `MESSAGE_DELETE` | `{ id, channelId }` |
| `MESSAGE_REACTION_ADD` | `ReactionUpdatePayload` |
| `MESSAGE_REACTION_REMOVE` | `ReactionUpdatePayload` |
| `MESSAGE_REACTIONS_CLEAR` | `ReactionsClearPayload` |
| `TYPING_START` | `TypingStartPayload` |
| `PRESENCE_UPDATE` | `PresenceUpdatePayload` |
| `CHANNEL_CREATE` / `CHANNEL_UPDATE` | `Channel` |
| `CHANNEL_DELETE` | `{ id }` |
| `CATEGORY_CREATE` / `CATEGORY_UPDATE` | `Category` |
| `CATEGORY_DELETE` | `{ id }` |
| `ROLE_CREATE` | `Role` |
| `ROLE_UPDATE` | `Role`, or `{ id }` after a reorder |
| `ROLE_DELETE` | `{ id }` |
| `MEMBER_UPDATE` | `{ userId }` |
| `EMOJI_CREATE` | `Emoji` |
| `EMOJI_DELETE` | `{ id }` |
| `RETENTION_APPLIED` | `PruneSummary` |

`MEMBER_UPDATE` also fires for timeouts, kicks and bans, so a client should refetch the roster (and
its own profile) whenever it sees one.

`ReactionUpdatePayload` carries the reacting user so each client can decide whether the `me` flag
applies to itself; the server broadcasts one payload to everyone:

```ts
type ReactionUpdatePayload = {
  messageId: string;
  channelId: string;
  emoji: string;
  emojiId: string | null;
  userId: string;   // who reacted or un-reacted
  count: number;    // total for this emoji after the change
};

type ReactionsClearPayload = {
  messageId: string;
  channelId: string;
  emoji: string;
  emojiId: string | null;
};
```

`TYPING_START` is sent when someone announces they are typing, via `POST /channels/:id/typing`. It
is not a promise the message will be sent, and a client should expire a notice after roughly eight
seconds without a refresh:

```ts
type TypingStartPayload = {
  channelId: string;
  user: User;
};
```

The server broadcasts one payload to everyone; a client hides its own typing and the whole feature
when `user.showTyping` is false.

`PRESENCE_UPDATE` is sent when a member's first gateway connection identifies and when their last one
closes. It is derived from live connections and never stored, so a restart begins with everyone
offline:

```ts
type PresenceUpdatePayload = {
  user: User;
  online: boolean;
};
```

### Close codes

| Code | Meaning |
| --- | --- |
| `4004` | The session was rejected. Re-authenticate instead of retrying. |
| `4005` | The session was ended by moderation (a kick or ban). |

### Reconnecting

The gateway has no sequence numbers and no resume support. On reconnect, re-identify and refetch
the state you care about (`GET /api/v1/channels`, the open channel's history). Do not reconnect
after a `4004` or `4005` close: re-authenticate first.

Events are broadcast to every authenticated client. There is no per-channel filtering, which is
fine because Harmony's permissions are server-wide rather than per-channel.

## Worked example

Register, post a message, and stream events:

```bash
# 1. Create a session (the first account on a fresh instance becomes the owner).
TOKEN=$(curl -s -X POST https://chat.example.com/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2hunter2"}' | jq -r .token)

# 2. Find a channel to post in.
CHANNEL=$(curl -s https://chat.example.com/api/v1/channels \
  -H "Authorization: Bearer $TOKEN" | jq -r '.channels[0].id')

# 3. Post a message.
curl -s -X POST "https://chat.example.com/api/v1/channels/$CHANNEL/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello from the API"}'
```

```js
// A minimal bot that logs every new message.
const token = process.env.HARMONY_TOKEN;
const ws = new WebSocket('wss://chat.example.com/gateway');

ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.op === 10) {
    ws.send(JSON.stringify({ op: 2, d: { token } }));
    return;
  }
  if (frame.op === 0 && frame.t === 'MESSAGE_CREATE') {
    console.log(`${frame.d.author?.username}: ${frame.d.content}`);
  }
};
```

## Limitations

- **No CORS.** The server sends no `Access-Control-Allow-Origin` header, so a browser client must
  be served from the same origin as the API. Bots and native clients are unaffected. Configurable
  CORS could be added later.
- **One server per instance.** There are no guilds, DMs, friend lists, voice or video.
- **Text channels only.** `Channel.type` is always `"text"`.
- **No resume on the gateway.** Reconnect and refetch.
- **Reserved permissions.** `EmbedLinks` and `MentionEveryone` are defined in the bitfield but not
  enforced by any endpoint yet.
- **Bridged content is best-effort.** Discord's webhooks cannot post real replies or reactions, so
  replies are mirrored as quotes and reactions are placed by the bot. See the README's bridge
  section for the full picture.
