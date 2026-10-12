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
engineer who authored the change - and only a branch that touches Markdown
(`*.md`) files alone skips her review.

The gate sits between pushing the branch and opening the pull request:

1. **Finish and push the branch.** Commit on the branch (version bumped for
   user-facing work), run `npm run typecheck` plus the relevant smoke, and push
   it to the fork so the reviewer has a stable ref. Do **not** open the pull
   request yet:

   ```sh
   git push -u origin <branch>
   ```

2. **Open a security-review issue.** Create a child issue of the task you are
   working (`parentId` set) assigned to Ghislaine. Make it self-contained, since
   she may not be able to read your task: branch name and base (`upstream/main`),
   the head commit SHA, `git diff --stat upstream/main...<branch>`, a short
   summary of what changed, the high-risk surfaces touched (auth and sessions,
   `apps/server/src/access/service.ts`, `bridge/`, uploads, bot tokens, anything
   with user PII), the verification you already ran and its result, and the pull
   request title and body you intend to open. Block your task on that review
   issue (`blockedByIssueIds`).

3. **Wait for the verdict.** Ghislaine reviews on her issue and posts a verdict:
   **APPROVE**, or **BLOCK** with named findings (class, evidence, blast radius,
   concrete fix, residual risk). She marks the review issue `done` either way -
   the verdict is the deliverable. Her protocol and verdict format live in
   `docs/SECURITY_REVIEW.md`.

4. **Open the pull request on APPROVE.** Record the verdict in the body:

   ```md
   Security review: <review-issue> - approved by Ghislaine (<head-sha>).
   ```

   On **BLOCK**, fix the findings on the same branch. A new commit changes the
   diff the verdict covered, so request a fresh verdict before opening the pull
   request.

5. **Docs-only changes skip steps 2-4.** If the branch touches only `*.md`
   files, say so in the pull request body: `Docs-only: security gate not
   required.`

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
