# Security baseline

The dated record of the security and privacy baseline pass over Harmony's
high-risk surfaces. This is a summary only: the concrete findings, evidence, and
proposed fixes are tracked privately as issues and are deliberately **not**
reproduced here until they are remediated. See `docs/SECURITY_REVIEW.md` for the
gate and its verdict format.

## 2026-10-12 — initial baseline

First structured pass, run as part of standing up the security-review gate. The
reviewer is Ghislaine, the Cyber Security Consultant.

### Surfaces reviewed

- Session and account authentication — `apps/server/src/auth/**`,
  `apps/server/src/routes/auth.ts`, `routes/discord.ts`, `http/cookies.ts`.
- Permission resolution and channel access — `apps/server/src/access/service.ts`,
  `apps/server/src/auth/permissions.ts`, `apps/server/src/auth/guards.ts`, and the
  route handlers that consult them.
- The Discord bridge — `apps/server/src/bridge/**`, account linking and stand-in
  adoption in `apps/server/src/users/service.ts` and `apps/server/src/db/users.ts`.
- Content-addressed uploads — `apps/server/src/attachments/**`,
  `apps/server/src/storage/blobs.ts`, the attachment and media routes.
- Bot tokens and slash commands — `apps/server/src/bots/**`,
  `apps/server/src/commands/service.ts`, `apps/server/src/db/bot_tokens.ts`.
- User PII in DTOs, gateway broadcasts, and the profile routes.
- Outbound fetching (link previews, avatar import, push) for server-side request
  forgery.

### Result

Six findings were recorded, spanning broken object-level authorization, PII
minimization, authentication throttling, and hardening gaps (gateway origin
validation, SSRF DNS-rebinding, and an account-link edge case). Severity is
recorded on each issue. None was assessed as actively exploited. The highest
severity item concerns object-level authorization on a fetch-by-id route and is
being remediated by the server owner.

Full findings, evidence, proposed fixes, and residual risk: company issue
tracker (child issues of the security-review gate onboarding task). They are
withheld from this repository by the disclosure rule in
`docs/SECURITY_REVIEW.md`.

### What is already solid

Recorded so a later pass does not re-litigate it: sessions are stored as SHA-256
hashes of a 256-bit random token with a ban check on every resolve; passwords use
scrypt with a per-hash salt and a timing-safe compare, and unknown usernames are
compared against a dummy hash to avoid a timing oracle; the session cookie is
`HttpOnly`, `SameSite=Lax`, and `Secure` when configured; a strict CSP, `nosniff`,
and HSTS-on-TLS are sent; uploads are content-addressed and re-validated (sharp
for images, an MP4 signature check for video); bot tokens are stored hashed;
permission grants are bounded by an anti-escalation guard; and outbound preview
fetches already apply a private-address guard, an image type allowlist, an SVG
refusal, a redirect limit, and a size cap.
