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
| 400 | `validation_error`, `invalid_reply`, `invalid_emoji`, `invalid_attachment`, `invalid_upload`, `default_role` |
| 401 | `unauthorized`, `invalid_credentials` |
| 403 | `forbidden`, `invite_required`, `invalid_invite`, `invite_expired`, `invite_exhausted`, `immutable_role`, `permission_escalation` |
| 404 | `not_found`, `channel_not_found`, `message_not_found`, `role_not_found`, `user_not_found`, `emoji_not_found`, `attachment_not_found`, `avatar_not_found` |
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
| `KickMembers` | `1 << 10` | *Reserved* — not enforced yet |
| `BanMembers` | `1 << 11` | *Reserved* — not enforced yet |
| `CreateInvites` | `1 << 12` | Minting invite codes |
| `MentionEveryone` | `1 << 13` | *Reserved* — not enforced yet |
| `Administrator` | `1 << 14` | Implies every flag above |

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
};

type Category = { id: string; name: string; position: number };

type Channel = {
  id: string;
  name: string;
  topic: string | null;
  type: 'text';                 // only text channels exist in 1.0
  categoryId: string | null;    // null means "no category"
  position: number;
  createdAt: string;
  discordChannelId: string | null; // set when bridged
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
};

type Role = {
  id: string;
  name: string;
  color: number | null;         // packed RGB, or null for the default colour
  position: number;             // display/colour ordering only
  permissions: string;          // decimal bitfield string
  hoist: boolean;
  mentionable: boolean;
  isDefault: boolean;           // true only for @everyone
};

type Emoji = { id: string; name: string; hash: string; animated: boolean };

type Invite = {
  code: string;
  createdAt: string;
  expiresAt: string | null;     // null = never expires
  maxUses: number | null;       // null = unlimited
  uses: number;
};
```

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
{ "categories": [ /* Category */ ], "channels": [ /* Channel */ ] }
```

#### `POST /api/v1/channels` — `ManageChannels`

```json
{ "name": "general", "topic": null, "categoryId": null, "discordChannelId": null }
```

`topic`, `categoryId` and `discordChannelId` are optional. Linking a `discordChannelId` requires a
configured bridge and a Discord channel not already linked elsewhere (`409 discord_channel_taken`).
Returns the new `Channel` and fires `CHANNEL_CREATE`.

#### `PATCH /api/v1/channels/:id` — `ManageChannels`

Any of `name`, `topic`, `categoryId`, `position`, `discordChannelId`. Returns the updated
`Channel` and fires `CHANNEL_UPDATE`.

#### `DELETE /api/v1/channels/:id` — `ManageChannels`

Returns `204`. Fires `CHANNEL_DELETE` with `{ "id": "..." }`.

#### `POST /api/v1/categories` — `ManageChannels`

```json
{ "name": "Text Channels" }
```

Returns the new `Category`, fires `CATEGORY_CREATE`.

#### `PATCH /api/v1/categories/:id` — `ManageChannels`

`{ "name"?: string, "position"?: number }`. Returns the `Category`, fires `CATEGORY_UPDATE`.

#### `DELETE /api/v1/categories/:id` — `ManageChannels`

Returns `204`, fires `CATEGORY_DELETE` with `{ "id": "..." }`. Channels in the category become
uncategorised.

### Messages

#### `GET /api/v1/channels/:id/messages` — `ViewChannels`

Returns up to 100 messages in ascending order (oldest first).

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | |
| `before` | ISO 8601 string | — | Return messages created strictly before this time |

```json
{ "messages": [ /* Message */ ] }
```

`before` is how you page backwards: pass the `createdAt` of the oldest message you have.

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
{ "displayName": "Alice the Great" }
```

`displayName` may be up to 32 characters; `null` or `""` clears it. Returns `MeResponse`.

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

#### `PUT /api/v1/members/:userId/roles/:roleId` — `ManageRoles`

Assigns a role. Returns `204` and fires `MEMBER_UPDATE` with `{ "userId": "..." }`. The `@everyone`
role is implicit and cannot be assigned (`400 default_role`).

#### `DELETE /api/v1/members/:userId/roles/:roleId` — `ManageRoles`

Removes a role. Returns `204` and fires `MEMBER_UPDATE`.

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
{ "serverName": "My Community", "requireInvite": true }
```

#### `PATCH /api/v1/settings` — `ManageServer`

`{ "serverName"?: string, "requireInvite"?: boolean }`. Returns the updated settings. `serverName`
changing also updates `GET /api/v1/meta`.

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
| `MESSAGE_UPDATE` | `Message` (edits, and bridged edits) |
| `MESSAGE_DELETE` | `{ id, channelId }` |
| `MESSAGE_REACTION_ADD` | `ReactionUpdatePayload` |
| `MESSAGE_REACTION_REMOVE` | `ReactionUpdatePayload` |
| `MESSAGE_REACTIONS_CLEAR` | `ReactionsClearPayload` |
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

`TYPING_START` is defined in the protocol but is **not emitted yet** — reserved for a future
release.

### Reconnecting

The gateway has no sequence numbers and no resume support. On reconnect, re-identify and refetch
the state you care about (`GET /api/v1/channels`, the open channel's history). A `4004` close means
your session is invalid; re-authenticate before retrying instead of reconnecting blindly.

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
- **Reserved permissions.** `EmbedLinks`, `KickMembers`, `BanMembers` and `MentionEveryone` are
  defined in the bitfield but not enforced by any endpoint yet.
- **Bridged content is best-effort.** Discord's webhooks cannot post real replies or reactions, so
  replies are mirrored as quotes and reactions are placed by the bot. See the README's bridge
  section for the full picture.
