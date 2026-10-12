# Security review gate

Harmony is self-hosted by the people who run it: an account takeover, a permission
bypass, or a privacy leak is not a bug a vendor can patch for them, it is a
compromise of their private community. So every change that ships code passes an
independent security review before it is opened against `upstream/main`.

This document defines the gate. `docs/GIT_WORKFLOW.md` describes where it sits in
the branch and pull-request flow; this file is the protocol the reviewer runs.

## Who reviews

**Ghislaine**, the Cyber Security Consultant. She reviews independently: she
reports to the CEO, not to the engineer who wrote the change, and her sign-off is
a requirement rather than advice. If she is asked to approve a change she believes
is insecure, she escalates to the CEO rather than waving it through.

## What needs a review

- **Everything that changes code.** Any diff under `apps/**`, `packages/**`, root
  tooling or config, or anything that changes runtime behavior — the server, the
  web client, the shared contract, the Discord bridge, migrations, scripts.
- **Documentation skips the gate.** A branch that touches only Markdown
  (`*.md`, `docs/**`, `README.md`, `AGENTS.md`, `LICENSE`) needs no verdict. Say
  so in the pull request body: `Docs-only: security gate not required.`

The surfaces that always get a close look, because a defect in one of them is
rarely contained:

- session and account authentication (`apps/server/src/auth/**`, `routes/auth.ts`);
- permission resolution and channel access (`apps/server/src/access/service.ts`,
  the permission bitfield in `packages/shared`);
- the Discord bridge, account linking, and stand-in adoption (`bridge/`);
- content-addressed uploads under `HARMONY_DATA_DIR` (attachments, emoji,
  stickers, avatars, icons);
- bot tokens and slash commands; and
- anything that touches message content, moderation actions, audit records, or
  user PII.

## How a branch reaches the gate

The gate sits between "branch pushed to the fork" and "pull request opened". It
never weakens the rules in `docs/GIT_WORKFLOW.md`: main is only advanced by a
merge upstream, and branches are only ever pushed to the company fork.

1. **Finish and push the branch.** Commit on the branch, run `npm run typecheck`
   plus the relevant smoke, and push it to the fork (`git push -u origin
   <branch>`). Do **not** open the pull request yet.
2. **Open a security-review issue** — a child of the task, assigned to Ghislaine.
   It must be self-contained, since she may not be able to read the author's
   task. Provide exactly:
   - the branch name, and its base (`upstream/main`) and head commit SHA;
   - `git diff --stat upstream/main...<branch>`;
   - a short summary of what changed and why;
   - the high-risk surfaces touched (from the list above);
   - the verification already run and its result;
   - the pull request title and body the author intends to open.
3. **Block the authoring task** on the review issue (`blockedByIssueIds`) and wait
   for the verdict.
4. **Open the pull request only on APPROVE**, recording the verdict in the body:

   ```md
   Security review: <review-issue> — approved by Ghislaine (<head-sha>).
   ```

   On **BLOCK**, fix the findings on the same branch. Any new commit changes the
   diff the verdict covered, so request a fresh verdict before opening the pull
   request.

## Verdict format

The verdict is the deliverable, and it is exactly one of two outcomes.

- **APPROVE** — no blocking findings. Non-blocking observations or follow-ups, if
  any, are named with a suggested owner.
- **BLOCK** — one or more findings that must be fixed before the pull request is
  opened.

A "looks fine" review is not a review. Every finding names all of the following:

- **Vulnerability class**, from a named taxonomy — for example "IDOR / Broken
  Object-Level Authorization on `GET /channels/:id/messages`", not "authorization
  issue". Where useful, cite the security lens (OWASP Top 10, OWASP API Top 10,
  STRIDE, Saltzer & Schroeder principle) so the reasoning is traceable.
- **Evidence / the attack** — a proof-of-concept request, payload, or the exact
  code path. If a working PoC is not possible, say so and explain why the finding
  is still believed exploitable.
- **Blast radius** — what an attacker gains, whose data, at what privilege, and
  whether they can pivot.
- **Concrete fix** — the change to make, not a direction. "Add a
  channel-visibility check in `access/service.ts` before the message query" beats
  "enforce access control."
- **Severity vs. exploitability** — scored separately. A critical defect behind
  strong authentication can rank below a medium one on an unauthenticated
  endpoint.
- **Residual risk** — what remains after the proposed fix, and any follow-up that
  belongs in its own ticket.

A review with adverse findings is still complete: the review issue is closed
`done` with the verdict, and the fixes are handed to the owning engineer (or the
CTO). Findings are never left in limbo.

### Severity

| Severity | Meaning |
| --- | --- |
| Critical | Actively exploitable in production; account takeover, auth bypass, or PII exposure at scale. |
| High | Exploitable with realistic preconditions; privilege escalation or access to data the actor should not have. |
| Medium | Real defect with limited reach or weakened defenses; should be fixed but is not an emergency. |
| Low | Hardening, defense-in-depth, or a latent flaw not reachable today. |

## Service-level expectations

The gate defaults to on-demand review, so the clock starts when the review issue
is ready and assigned.

- **Acknowledge within one business day**, with a verdict or a request for the
  missing information.
- **Authentication, permissions, cryptography, and actively exploitable findings
  are expedited** — the same day, with the CEO copied if production data is at
  risk.
- If a review is taking longer than a day without a verdict, the author should
  ping Ghislaine on the review issue; if she is unavailable, escalate to the CTO.

## Disclosure discipline

Unpatched vulnerability details stay on the company board, in the review issue.
No proof-of-concept, reproduction, or live user data goes into a commit, a public
channel, or a pull-request body. Where a fix is not ready, the finding is
described by class and tracked as its own issue rather than published.

## Baseline

The initial security and privacy pass over the high-risk surfaces is recorded in
`docs/SECURITY_BASELINE.md`. Its detailed findings — with evidence and proposed
fixes — are tracked privately as issues and are intentionally not reproduced in
this repository until they are remediated.
