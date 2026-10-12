# Git workflow: fork, branch, pull request

Harmony is developed through a company **fork** of the canonical repository. The
company account writes to the fork; the canonical repository is read-only. Every
change lands by pushing a branch to the fork and opening a pull request against
`upstream/main`.

This file records the account and the exact commands. `AGENTS.md` owns the
conventions; this is the reference they point at.

## The two repositories

| Role | Remote | Repository | Access |
| --- | --- | --- | --- |
| Company fork (push target) | `origin` | `https://github.com/hrmnychat-hue/harmony` | read + write |
| Canonical (read + PR base) | `upstream` | `https://github.com/YuukiEatsYou/harmony` | read only |

- Company GitHub account handle: **`hrmnychat-hue`**.
- Fork URL: `https://github.com/hrmnychat-hue/harmony`.
- The fork is a real GitHub fork of `YuukiEatsYou/harmony`, so GitHub accepts a
  pull request whose head is a branch on the fork and whose base is
  `upstream/main`.

## One-time setup

If you cloned the canonical repository directly, repoint the remotes once:

```sh
git remote rename origin upstream
git remote add origin https://github.com/hrmnychat-hue/harmony.git
git fetch upstream
git remote -v   # origin = fork, upstream = canonical
```

Authenticate `git` without persisting the token. The company account's token is
provided to agents as the environment variable `GITHUB_TOKEN`. Point a local
credential helper at that variable; it stores the helper command, never the
secret:

```sh
git config --local credential.helper \
  '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
```

Never put the token in a remote URL, a committed file, a comment, or a document.
The token is already present in the agent environment; nothing else is needed.

## Day-to-day

```sh
# 1. Start current, on a branch off the canonical main.
git fetch upstream
git switch -c <branch> upstream/main

# 2. Make the change and commit. For user-facing work, bump HARMONY_VERSION in
#    packages/shared/src/constants.ts in the same commit. See AGENTS.md.

# 3. Push the branch to the fork.
git push -u origin <branch>
```

Branch names: `v<version>` for user-facing work (for example `v2.5.0`); `docs/`
or `chore/<slug>` for a change that ships no version and no user-visible
behavior.

## Security review gate

Every pull request that changes code must carry a security verdict from
**Ghislaine**, the Cyber Security Consultant, before it is opened against
`upstream/main`. She is an independent gate - she reports to the CEO, not to the
engineer who authored the change - and only a branch whose changed paths are all
Markdown skips her review (the definition is in step 5).

The gate sits between pushing the branch and opening the pull request:

1. **Finish and push the branch.** Commit on the branch (version bumped for
   user-facing work), run `npm run typecheck` plus the relevant smoke, and push
   it to the fork so the reviewer has a stable ref. Do **not** open the pull
   request yet:

   ```sh
   git push -u origin <branch>
   ```

2. **Open a security-review issue.** Create a child issue of the task you are
   working (`parentId` set) assigned to Ghislaine. Make it self-contained - she
   may not be able to read your task - and give her both the base SHA at review
   time and the head SHA under review:

   ```sh
   git rev-parse upstream/main                  # base SHA at review time
   git rev-parse <branch>                       # head SHA under review
   git diff --stat      upstream/main...<branch>
   git diff --name-only upstream/main...<branch>
   ```

   Then include, in the review issue:

   - a short summary of what changed, and the pull request title and body you
     intend to open;
   - the verification you already ran and its result, plus a **not-verified**
     statement: what you did *not* exercise;
   - a **per-surface yes/no checklist** of the high-risk surfaces, one line of
     specifics for each yes:

     - auth / session / account linking;
     - `apps/server/src/access/service.ts` or the permission bitfield in
       `packages/shared`;
     - `bridge/` (account linking, stand-in adoption);
     - uploads under `HARMONY_DATA_DIR`;
     - bot tokens or slash commands;
     - message content, moderation actions, or audit records;
     - user PII (DTOs, gateway broadcasts, profile routes, logs);
     - outbound fetching (link previews, avatar import, push) - SSRF;

   - **dependency delta** - `package.json` / lockfile changes, new or bumped
     packages, or "none";
   - **route/permission delta** - new or changed HTTP routes, gateway events, or
     permission checks, and the authorization each one enforces;
   - **data/PII delta** - does the diff add, widen, or newly *log* user data,
     where is it stored, and for how long;
   - **secrets assertion** - an explicit "no tokens, credentials, or `.env`
     values in the diff". If any are present, stop and escalate to the CEO; that
     is an incident, not a review finding.

   Block your task on that review issue (`blockedByIssueIds`).

3. **Wait for the verdict.** Ghislaine reviews on her issue and posts a verdict:
   **APPROVE**, or **BLOCK** with named findings (class, evidence, blast radius,
   concrete fix, severity vs. exploitability, residual risk). She marks the
   review issue `done` either way - the verdict is the deliverable, and `done`
   on a BLOCK is what resolves the blocker edge and wakes you. Her protocol,
   verdict format and SLA live in `docs/SECURITY_REVIEW.md`.

4. **Open the pull request on APPROVE.** The verdict is bound to the head SHA it
   reviewed, so **do not rebase or force-push the branch while it is under
   review**: a rewrite moves `origin/<branch>` to a tree she never saw, and the
   pull request head at open must equal the SHA in the verdict. Record the
   verdict in the body with a **link to the review issue**, so the owner can
   check it against her comment rather than a self-written string:

   ```md
   Security review: <review-issue-link> - approved by Ghislaine (<head-sha>).
   ```

   On **BLOCK**, fix the findings as new commits on the same branch, then open a
   **fresh** review child issue for the new head SHA, with a new blocker edge. A
   review issue that already reached `done` will not wake you again, so do not
   reuse it. If `upstream/main` advances so the merge base changes before you
   open the pull request, note it on the review issue: a changed merge base
   makes the review stale and Ghislaine re-checks.

5. **Docs-only changes skip steps 2-4.** Skip the gate only when **every** path
   in `git diff --name-only upstream/main...<branch>` is a Markdown file
   (`*.md`) or `LICENSE`. State that file list as the evidence in the pull
   request body: `Docs-only (paths: <list>): security gate not required.` A
   change that also touches code is not docs-only.

The gate guards *opening the pull request*, not pushing a branch to the fork,
and it never weakens the rules above: main is only advanced by a merge upstream,
and we never push to `upstream`.

## Open the pull request

Base: `YuukiEatsYou/harmony:main`. Head: `hrmnychat-hue:<branch>`. Open it
through the API, because the company account cannot target the canonical repo
from the web UI:

```sh
curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/YuukiEatsYou/harmony/pulls \
  -d '{"title":"<title>","head":"hrmnychat-hue:<branch>","base":"main","body":"<body>"}'
```

Write the body for a reviewer who has not read the diff:

```md
## Summary
- What changed and why.

## Implementation notes
- Trade-offs, migration/config implications, anything non-obvious.

## Verification
- The exact commands you ran and their result.

## Risk and rollback
- What breaks on revert and how to revert cleanly.
```

The bundled `github-pr-workflow` skill has the full conventions (title shape,
verification evidence, replying to review comments).

## Review and merge

- The owner (`YuukiEatsYou`) reviews and merges pull requests into `upstream`
  `main`. The company account has pull-only access upstream, so agents cannot
  merge and cannot push upstream.
- Do not merge your own pull request. Push review fixes as new commits on the
  same branch, then re-request review.
- After a merge, delete the branch on the fork and locally, and rebuild local
  `main` from `upstream/main`:

  ```sh
  git fetch upstream
  git switch main
  git merge --ff-only upstream/main
  ```
