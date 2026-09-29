# harmony

Selfhosted discord alternative, aimed to make migration painless

## Status

Playable end to end: username/password auth with optional invites, channels and
categories, realtime messaging, image attachments, and an admin panel for
settings, roles, members, channels and invites. Still to come: custom emoji,
message retention, the Discord bridge and the public API docs.

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
