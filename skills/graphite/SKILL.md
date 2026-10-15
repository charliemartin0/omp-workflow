---
name: graphite
description: Use for any git, branch, commit, PR, or stack work in a your-work-org work repo (origin contains `your-work-org/`), and whenever reviewing a Graphite stack or work-repo PR. Covers gt create/modify, gt submit --draft, continuing existing stacks, sync/restack, and read-only bottom-up stack review.
---

# Graphite (gt 1.8.6)

## 0. Preconditions
- `git remote get-url origin` contains `your-work-org/`. If not, this skill does not apply: personal repos use plain git and no gt (see §3).
- Auth: `test -f ~/.config/graphite/auth`. Never infer auth from `~/.config/graphite/user_config`. `gt auth` has no status subcommand (it only stores a token), so don't run it. If auth is missing, stop and ask the user.
- Pass `--no-interactive` to gt commands that can prompt (`create`, `modify`, `submit`, `get`, `checkout`, `sync`). Stage explicitly (`git add <paths>`, or `-a`/`-u`).
- Aliases: `gt ls` = `gt log short`, `gt ss` = `gt submit --stack`.

## 1. Worker flow
1. Map the stack: `gt log short`. If the ticket continues an existing stack, `gt checkout --no-interactive <branch-to-build-on>` (usually the top) and stack on it. Never start a parallel stack from trunk. If it doesn't continue an existing stack, run `gt sync --no-interactive`, then `gt checkout --no-interactive main`, before `gt create`. Stack on the current branch only when the work depends on it.
2. New branch + commit: `git add <paths>` → `gt create --no-interactive -m "<msg>" [branch-name]`. (`--onto <parent>` creates the branch on top of a different parent; `--insert` puts it between the current branch and its child.)
3. More work or review feedback on the current branch: `gt modify --no-interactive -a` (amend) or `gt modify --no-interactive -c -m "<msg>"` (new commit). Descendants restack automatically. To change a lower branch: `gt modify --into <downstack-branch>`, or check it out first.
4. Run checks (tests, type-check/build, arch rules) before submitting.
5. Submit: `gt submit --draft --no-interactive` (current branch + downstack) or `gt ss --draft --no-interactive` (whole stack, including descendants). Use `--dry-run` to preview. Never omit `--draft`; never `--publish` or `--force`. Before submitting, run `gt parent` (or `gt log short`) and state the base branch in the final message.
   - `gt submit` pushes with force-with-lease by design. That is the sanctioned push path. Never plain `git push` or `git push --force*` on Graphite branches; ask before any force push.
   - `--draft` only affects newly created PRs. Confirm with `gh pr view <n> --json isDraft`. If a PR you created came out ready, run `gh pr ready --undo <n>`.
6. PR body: write it to a file, then `gh pr edit <n> --body-file <f>`. Template, a one-minute brief for a reviewer who has the diff (1-3 lines per section, no SHAs or rebase history):
   `## Why` / `## What changed` / `## Scope` (covers + deliberately leaves out) / `## Blast radius` (what it touches, why safe or risky) / `## Verification` (real commands and results).
   PRs stay draft via `gt submit --draft`. Frontend screenshots: follow the global AGENTS.md QA screenshot rules.
7. Sync/restack only when needed (trunk moved, conflicts, or submit refuses because branches need restacking): `gt sync --no-interactive` (no `--force`/`--delete-all` unless the user asks), then `gt restack` if anything is left. Only in your own checkout/worktree, never in someone else's. On conflicts: resolve, `git add`, `gt continue`, or bail out with `gt abort`.
8. Report: branch(es), commit SHA(s), draft PR number(s), checks run with results.

Ask the user first for: `gt merge`, `gt submit --publish`/`--force`, `gt sync --force`, `gt delete`, `gt undo`, and `gt fold`/`squash`/`split`/`move`/`reorder` on submitted branches.

## 2. Reviewer flow (read-only)
Never edit product files, commit, push, or change PR state.
1. Work in a separate worktree, never the main checkout (`gt get` checks out branches and moves local refs): `git worktree add --detach <path>`, then `cd <path>`.
2. `gt get <PR-number|head-branch> --no-restack --no-interactive` (add `--downstack` to skip syncing local upstack branches). Always pass `--no-restack`.
3. Map the stack: `gt log short` / `gt log`. An empty log means the stack isn't tracked locally, so run step 2 first.
4. Review bottom-up. For each branch, get its parent from `gt log`, or from `gt checkout --no-interactive <branch>` + `gt parent`. Diff with `git diff <parent>...<branch>` (or `gt info --diff --branch <branch>`). Never diff against main/trunk, except for the bottom branch whose parent is trunk.
5. PR context via `gh` only: `gh pr view <n> --json title,body,comments` or `gh pr view <n> --comments`. Never `gh pr diff`, `gh pr list`, or `gh api graphql` to discover stacks, walk bases, or get diffs.
6. Never run `gt submit`, `gt modify`, `gt restack`, `gt sync`, `gt move`, or anything else that rewrites or pushes.
7. Stack PRs may lack CI: run the relevant local tests/type-checks for changed paths in the review worktree. Report commands and results.
8. Compare each branch with its PR title/body and the ticket. Flag out-of-scope changes, changes in the wrong branch or layer, and hidden dependencies on lower branches.
9. Remove your review worktree when done (`git worktree remove <path>`).

Stack reviews: run at most 3 reviewer subagents at once; queue the rest bottom-up. Reviewers use the medium/default role (Sonnet), not slow/Opus. Use Opus only for the single riskiest branch (migrations, auth, payments, or over ~500 changed lines), and say when you did.

Rubric: (1) correctness vs ticket/PR intent; (2) Clean Architecture/DDD, where a layer inversion is a BLOCKER; (3) tests present and meaningful; (4) unnecessary complexity; (5) rule compliance (draft PRs via gt, 1920x1080 screenshots for frontend, named refactorings only).

Output:
```
MODE: stack <bottom>..<top> (N branches, via gt)     # or: MODE: single-PR <n> vs <base>
## <branch> (#<pr>) vs <parent>
- blocker: path/to/file.cs:42 — <issue + fix>
- major: ...
- minor: ...
Checks: <commands> → <result>
Verdict: approve | changes requested | blocked
```
For stacks, list findings per branch.

## 3. Personal repos (no gt)
- Work: local branch + `git commit`; merge locally only when the user says so. No PRs or push unless asked.
- Review: `gh pr view <n> --json baseRefName,headRefName,isDraft` + `gh pr diff <n>`, or `git diff <base>...HEAD`. For chained PRs, follow `baseRefName`.
