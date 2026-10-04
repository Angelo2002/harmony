# Push notifications (design)

> **Status: proposed — not implemented.** Everything below is a design for a
> feature that does not exist yet. The other docs in this folder describe what
> ships today; this one describes what we intend to build and the contract custom
> clients can plan against. Treat endpoint and type names here as proposals.

This covers **system push**: an OS-level notification raised while the app is not
running (or is suspended). It is separate from the in-app notification *sounds*,
which the web client already plays.

## Why this is needed

The WebSocket gateway reaches a client only while it is connected, and it has no
resume: a reconnect gets a fresh `READY` and re-syncs over REST rather than
replaying what it missed (`packages/shared/src/gateway.ts`). So a client that is
closed, or that the OS has suspended, learns about a mention only the next time it
is opened.

- A **desktop** client rarely needs push. If it is running it can hold a gateway
  connection, and Electron can raise a native notification itself.
- A **mobile** client does. A background socket is suspended or killed by Android
  and iOS, so real push is the only reliable delivery while the app is not in the
  foreground.

## Goals and non-goals

**Goals**

- Deliver a notification for a mention or reply to a member who is not currently
  connected, on Android and iOS.
- Respect the same per-channel mute and notification level the inbox and the
  in-app sound already respect.
- Stay opt-in and self-hostable: an instance that configures nothing sends no push,
  and one path (UnifiedPush/ntfy) needs no Apple or Google account.
- Fit a client that is signed into **many** instances at once.

**Non-goals (for now)**

- Delivery receipts, read receipts, or "notification dismissed" state.
- Per-message notification settings beyond the existing channel level.
- Push as an email/SMS fallback, or any non-OS delivery channel.
- Guaranteed delivery or ordering. Push is best-effort, like the sound.

## The client is a shell over many instances

Both clients aim to be one app for every Harmony instance a member uses. The
desktop client already does this: each server is an Electron `<webview>` loaded
from that server's own URL under a persistent session partition, with a server
rail and an add-server flow that validates an address against `GET /api/v1/meta`.

Two things follow for push:

1. **One endpoint per install, registered per instance.** The push endpoint
   belongs to the app install, but each Harmony instance stores its own
   `{user, device}` record. The client registers the same endpoint with every
   instance it is signed into, and removes it when the server is removed or the
   session ends.
2. **A notification must say which instance it came from.** One distributor
   delivers for many servers, so the payload carries a stable instance id the
   client can route on.

## What already exists (reuse it, do not rebuild it)

| Piece | Where | What push can reuse |
| --- | --- | --- |
| Mention/reply recipients | `apps/server/src/db/mentions.ts`, written from `recordMentions` / `recordNameMentions` in `apps/server/src/messages/service.ts` | The exact set of members who should be told about a message. Bots and stand-ins are already excluded. |
| Per-channel mute + level | `apps/server/src/db/channel_settings.ts` | The suppression rule: `muted`, `level` (`default` / `mentions` / `nothing`), channel-or-category. |
| Notification level, resolved with inheritance | `apps/web/src/lib/channel-settings.svelte.ts` (`resolve`) | The client's own semantics, which the server should mirror. |
| Presence | `apps/server/src/realtime/hub.ts` | Whether a member is connected *right now*, to skip pushing to an app that is already open. |
| Auth | Bearer tokens and session cookies (`docs/API.md`) | Native clients can already call the API. |
| Instance metadata | `apps/server/src/routes/meta.ts` (`GET /api/v1/meta`) | Where the client discovers that an instance supports push and how. |

## Server design

### 1. Instance identity

A client that talks to many servers needs to tell them apart by something stable.
The instance name can change, so add a generated, immutable id.

- Store a UUID in `server_settings` (a new `KEY_INSTANCE_ID`, alongside the keys in
  `apps/server/src/settings/service.ts`), generated once on first read.
- Surface it as `instanceId` in `GET /api/v1/meta` and in every push payload.
- It is not a secret; it identifies an instance, not a member.

### 2. Advertising support in `GET /api/v1/meta`

The add-server flow already reads `meta`. Extend it so a client can adapt per
instance, since some self-hosted instances will have push on and others not:

```ts
// Added to InstanceMeta, all optional so old servers and old clients still agree.
interface InstanceMeta {
  // ...existing fields...
  instanceId: string;
  push?: {
    supported: boolean;
    /** Any of these the client may use, best first. */
    providers: Array<'unifiedpush' | 'webpush' | 'fcm' | 'apns'>;
    /** Present only when 'webpush' is offered. */
    vapidPublicKey?: string;
  };
}
```

An absent `push` block means "not configured" — the client simply does not offer
notifications for that server.

### 3. Device registry

One row per app install per member. Repeated registration of the same endpoint
updates the row rather than duplicating it.

```sql
-- Appended after the current latest migration (25). Never edit a shipped one.
CREATE TABLE push_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,             -- 'unifiedpush' | 'webpush' | 'fcm' | 'apns'
  endpoint      TEXT NOT NULL,             -- capability URL, or a device token
  keys          TEXT,                      -- JSON; Web Push p256dh/auth, else null
  label         TEXT,                      -- device name shown in settings, may be null
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,             -- updated on each registration
  last_error_at TEXT,
  last_error    TEXT
);
CREATE UNIQUE INDEX idx_push_devices_endpoint ON push_devices(user_id, endpoint);
CREATE INDEX idx_push_devices_user ON push_devices(user_id);
```

Endpoints (`ViewChannels` is enough; a member manages only their own):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/users/@me/push-devices` | List this member's devices. |
| `PUT` | `/api/v1/users/@me/push-devices` | Upsert by `endpoint`: `{ provider, endpoint, keys?, label? }`. Returns the stored record. |
| `DELETE` | `/api/v1/users/@me/push-devices/:id` | Remove one device. |
| `DELETE` | `/api/v1/users/@me/push-devices` | Remove all of this member's devices ("turn notifications off", and on logout). |

Registration is rate limited, and the number of devices per member is capped
(suggest 10). The `endpoint` is a **capability**: whoever holds it can push to the
device. Store it, never log it, and return it only to its owner.

### 4. When to notify

Mirror the client's `#notify` (`apps/web/src/lib/chat.svelte.ts`) exactly, so the
sound and the push can never disagree:

1. Never for the author's own message; never for a bot/stand-in (already excluded
   from the mention rows).
2. Resolve the member's settings for the channel: the channel's own row, else its
   category's, else defaults.
3. If `muted` or `level === 'nothing'` → **no push** (this suppresses mentions too,
   matching the sound).
4. If `level === 'mentions'` → push only for `kind` `mention` or `reply`.
5. If `level === 'default'` → v1 pushes only for `mention` or `reply`, which is the
   same set the inbox holds. (Pushing every message in every unmuted channel is a
   possible later option, not a v1 behavior.)
6. Skip if the member currently has a live gateway connection — the hub already
   knows this, and it means a desktop app that is running is not also pushed.
7. Fire on **creation only**, never on edit. An edit re-records name mentions; a
   notification for a message that was already announced would be a duplicate.

Coalesce: at most one notification per member per message, fanned out to that
member's devices. (Sending to every device is fine at these counts; a future
option is to send to the most recently seen device only.)

### 5. Where the fan-out runs

The recipients are the `mentions` rows for the message. The trigger must be a
"live message created" signal — not an edit, and **not** a history backfill.

There is a trap here. `MessageService.onMessageCreated`
(`apps/server/src/messages/service.ts`) is documented as *local messages only*, and
`createBridged` deliberately does not announce (to avoid mirroring straight back to
Discord). A mention that arrives **from Discord** into a bridged channel would
therefore be missed if the hook used that listener. Add a live-only seam instead:

- Notify a new set of listeners from both places that already mean "this message
  really arrived": `create()`'s `announce()` and the non-`silent` branch of
  `createBridged()`.
- The `silent` branch (history import) must stay silent — never push.

The fan-out itself must be best-effort and off the request path: it runs after the
message is persisted and broadcast, never blocks or fails the send, and logs
delivery failures the way other background work does.

### 6. The notification payload

Minimal, because it travels through a third party, and bounded, because providers
cap payload size (about 4 KB on FCM, APNs and Web Push alike).

```ts
interface PushPayload {
  instanceId: string;      // route to the right server
  instanceName: string;    // so a shared notification tray is legible
  iconUrl: string | null;  // the instance icon
  channelId: string;
  channelName: string;
  messageId: string;
  kind: 'mention' | 'reply';
  authorName: string;
  /** Short preview, or null when the instance keeps previews out of payloads. */
  snippet: string | null;
}
```

- Never include tokens, session data, or a full message body.
- The `snippet` is a privacy choice: a self-hosted instance may prefer to send ids
  only and let the client fetch the text on open. Make it an admin setting, default
  to a short snippet (about 80 characters) or to ids only — decide before shipping.
- The client deep-links from `instanceId` → `channelId` → `messageId` and fetches
  the rest over the normal API.

### 7. Providers

Behind one interface, so the contract never mentions a specific service:

```ts
interface PushNotification {
  title: string;
  body: string;
  data: PushPayload;         // provider-specific encodings derive from this
}

type PushSendResult =
  | { ok: true }
  | { ok: false; retry: boolean; gone?: boolean; error: string };

interface PushSender {
  readonly provider: PushProvider;
  send(device: PushDevice, notification: PushNotification): Promise<PushSendResult>;
}
```

Adapters, in the order they are worth building:

1. **UnifiedPush / ntfy** — the reference adapter, and the best fit for this
   project. The device `endpoint` is an HTTP URL a local distributor (the ntfy app)
   hands the client; the server `POST`s the payload to it with the capability in
   `keys`. No Apple or Google account, works sideloaded, self-hostable.
2. **Web Push (VAPID)** — for browser/PWA and Electron. Needs a server VAPID
   keypair (admin setting; the public half is in `meta.push.vapidPublicKey`) and the
   client's `keys.p256dh` / `keys.auth`. No third-party account either.
3. **FCM** — Android. Works for a sideloaded APK, but needs a Firebase project
   (a Google account) and `google-services.json` in the client.
4. **APNs** — iOS. Needs a paid Apple Developer account for the push entitlement;
   a free-signed sideload cannot use it.

An instance enables exactly one provider at a time (admin setting), or none. Push
is **off by default** and configured per instance.

### 8. Housekeeping

- **Prune on provider feedback.** A `410 Gone` / `404` (or FCM's
  `UNREGISTERED`) means the token is dead: delete the row (`gone: true`).
- **Backoff.** A transient failure sets `last_error_at`/`last_error` and is retried
  later, not in a tight loop.
- **Cascade.** Deleting a member removes their devices (`ON DELETE CASCADE`).
- **Cap and rate limit** registration and sends, and coalesce per message as above.

## Client contract

- **Obtain one endpoint per install** (via the distributor, or an FCM/APNs token),
  then `PUT` it to each signed-in instance. Re-register if the OS rotates the
  token. `DELETE` it when the server is removed or the session ends.
- **Route by `instanceId`.** Ignore a notification whose instance the app does not
  know. Trust the id, not the display name.
- **Title** should name the instance (`#general · Yuuki Cult` or similar) so a
  single tray makes sense across servers.
- **Desktop (shell):** no server push is required. Consume the gateway you already
  have and raise a native `Notification`, respecting mute/level and the member's
  `notifyMajor`. The shell already aggregates unread-mention badges across
  servers over IPC; notification routing can extend that same channel. Web Push
  (option 2 above) can cover the "app fully closed" case later if wanted.
- **Mobile:** the shell owns the OS subscription, registers it per server, and
  routes an incoming notification into the right server view.

## Security and privacy

- Registration requires authentication and is scoped to the caller (`@me`).
- The endpoint is a secret-equivalent capability: store it, never log it, and
  return it only to the member who registered it.
- Payloads traverse a third party. Keep them minimal, make the snippet optional,
  and document this clearly for the instance owner.
- A single endpoint registered with many servers means each of those servers can
  push to it. The client validates `instanceId` and can unregister per server.
- Presence-based skipping means a push is not sent to a member who is already
  connected *to that instance*; it does not leak who is online to any third party.

## Compatibility

The whole feature is additive:

- New tables via an appended migration; no shipped migration edited.
- New endpoints that older clients never call.
- New `meta` fields; clients that do not know them ignore them, and an old server
  simply omits `push`.
- The gateway protocol is unchanged.

An instance with push unconfigured behaves exactly as today.

## Rollout

1. **Registry and identity.** Migration, `instanceId`, `meta.push`, and the
   `/users/@me/push-devices` endpoints. No sending yet; cover with smoke.
2. **UnifiedPush/ntfy sender + fan-out.** The decision logic, the live-only seam,
   and a fake sender in the smoke tests.
3. **Web Push (VAPID)** and the admin settings UI.
4. **FCM / APNs** adapters for those who want them.
5. **Client integration**, mobile first.

## Open questions

- Default for `level === 'default'`: mentions/replies only, or (later) every
  message in an unmuted channel?
- Snippet in the payload vs ids only — which should the default be?
- One push per device, or the most recently seen device only?
- Where the member's push master switch lives: implied by having a registered
  device, or its own field alongside `notifyMajor` / `notifyMinor`?
- Do we need to cap pushes per member per minute for a busy channel?

## File map

- `apps/server/src/routes/meta.ts` — add `instanceId` and `push`.
- `apps/server/src/settings/service.ts` — instance id and push provider settings.
- `apps/server/src/db/migrations.ts` — append the `push_devices` migration.
- `apps/server/src/db/push_devices.ts` — new, the registry queries.
- `apps/server/src/routes/push-devices.ts` — new, the endpoints.
- `apps/server/src/push/service.ts` — new, the decision + fan-out.
- `apps/server/src/push/providers/*` — new, one adapter each (UnifiedPush first).
- `apps/server/src/messages/service.ts` — the live-only notify seam.
- `apps/server/src/realtime/hub.ts` — "is this member connected" for skipping.
- `packages/shared/src/types.ts`, `api.ts`, `schemas.ts` — device and payload types.
- `docs/API.md` — document the endpoints once they exist.
- `apps/server/scripts/smoke.mjs` — registry, decision, and a fake sender.
