# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Harmony is a self-hosted, single-community Discord alternative with a two-way Discord bridge. Deeper docs: `docs/TECHNICAL.md` (internals, bridge), `docs/API.md` (HTTP/WebSocket), `docs/DEPLOYMENT.md`.

## Commands

Requires Node >= 24 (the server runs `.ts` directly via Node's type stripping and uses built-in `node:sqlite`; there is no server build step).

```sh
npm install
npm run dev            # server (http://127.0.0.1:8787) + web (http://127.0.0.1:5173) together
npm run dev:server     # server only (node --watch)
npm run dev:web        # Vite only
npm run dev:lan        # same, but web client listens on all interfaces
npm run build:web      # build client into apps/web/dist (server serves it in production)
npm start              # production: node apps/server/src/index.ts
npm run typecheck      # tsc for server/shared, svelte-check for web
npm run smoke          # boots a throwaway server, exercises API end to end
npm run smoke:bridge   # Discord bridge against a fake transport
npm run smoke:text     # web client pure logic (markdown/link parser, emoji picker, catch-up)
```

There is no linter and no test framework: verification is `typecheck` plus the three smoke scripts (plain node scripts in `apps/*/scripts/`). To run one, invoke it directly, e.g. `node apps/server/scripts/bridge-smoke.mjs`. The first registered account becomes the owner. Config comes from env vars (see `.env.example`) but only supplies initial defaults; runtime settings (name, theme, upload limits, retention, bridge) live in the DB and are edited in the admin panel.

## Architecture

npm workspaces monorepo; all packages are ESM TypeScript.

- `packages/shared` (`@harmony/shared`) — the contract between server and client: types, the permission bitfield (`permissions.ts`), gateway protocol (`gateway.ts`), zod schemas (`schemas.ts`), mention/embed/slowmode helpers, and `theme.ts`. Change shared types first, then both sides.
- `apps/server` — Fastify HTTP API + WebSocket gateway + SQLite. Local imports use explicit `.ts` extensions (required by Node's type stripping), so keep that style and avoid TS-only syntax that needs transformation (enums, parameter properties).
  - Layered by feature: `routes/*` (HTTP handlers) → domain folders (`messages/`, `channels/`, `moderation/`, `access/`, `bridge/`, ...) → `db/*` (one file per table group, raw SQL). `access/service.ts` is where permission checks resolve.
  - Schema changes: append a new entry to `db/migrations.ts`. Never edit a shipped migration.
  - Realtime: `gateway/index.ts` handles WebSocket connections; `realtime/hub.ts` broadcasts events to connected clients.
  - Uploads are content-addressed by SHA-256 under `data/uploads/` (default data dir `data/`, override `HARMONY_DATA_DIR`); DB rows reference blobs by hash and retention prunes unreferenced ones.
  - Discord bridge (`bridge/`): `service.ts` holds the sync logic against an abstract `transport.ts`; `discordjs.ts` is the real discord.js transport, which is why the bridge smoke test can run on a fake. Discord users appear as stand-in accounts; imported backfill history is never broadcast live. Linking a Discord ID to a member merges the stand-in via `mergeUsers` in one transaction. Signing in with Discord (`AuthService.signInWithDiscord`) creates a passwordless account (`password_hash = NO_PASSWORD` sentinel from `auth/passwords.ts`, exposed as `User.hasPassword`) and adopts any stand-in the same way; such accounts cannot unlink Discord until they set a password.
  - Search is a deliberate `LIKE` substring scan over visible channels (no FTS index).
- `apps/web` — Svelte 5 + Vite SPA. State lives in `src/lib/*.svelte.ts` rune stores (`chat`, `members`, `session`, `ui`, ...); `lib/api.ts` and `lib/gateway.ts` talk to the server (Vite proxies to the loopback API in dev). Theming: the client derives all colors from two admin-chosen colors via `packages/shared/src/theme.ts` and writes them as `--h-*` CSS custom properties on `:root`; stylesheets reference only those tokens (hardcoded values in `app.css` are first-paint fallbacks). Status colors are intentionally not derived.

In production one process serves the built client, API and gateway on one origin (no CORS).
