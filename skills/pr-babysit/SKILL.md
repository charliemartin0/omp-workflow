---
name: pr-babysit
description: Use when the user says "babysit", "get it merged", "fix merge conflicts on <PR>", "add to merge queue", "restack", or "keep trying until merged" for a your-work-org work-repo PR or stack. Syncs, restacks, resolves conflicts, submits with gt, adds to the Graphite merge queue, and polls until merged.
---

# PR babysit (work repos, Graphite)

Follows the `graphite` skill for all gt mechanics (`--no-interactive`, `gt submit` is the only push path, never plain `git push`). This skill adds the loop the user keeps asking for: "fix conflicts, add to merge queue, monitor, keep trying until merged".

## 0. Setup
1. Resolve the PR(s): number from the Graphite/GitHub URL. `gh pr view <n> --json number,headRefName,baseRefName,isDraft,mergeable,mergeStateStatus,state`.
2. Work in your own worktree for that branch, never someone else's checkout or a runner worktree.
3. Map the stack: `gt get <n> --no-interactive` then `gt log short`.

## 1. Correct base (check every time)
- Base must be `main` unless the PR genuinely depends on a lower branch in the stack. the user has had to correct "it should be based off main not <other PR>" more than once.
- Check both: `gt parent` locally AND `gh pr view <n> --json baseRefName` remotely. They must agree. If the parent is wrong: `gt move --onto main` (ask first if already submitted, per graphite skill), then `gt submit`.
- After any restack, re-check the remote base on GitHub/Graphite. A local restack that was never submitted is the #1 "still not stacked properly" failure.

## 1b. Discipline (applies to every loop below)
- **Frontier first.** Work only the lowest unmerged PR in the stack until it merges or is queued. Read upstack threads and note them, but don't fix them at the cost of restarting the frontier's checks.
- **One batched push, in this order:** conflicts, then review threads, then CI fixes. Collect every known fix, then one `gt submit`. Don't push per fix (each push restarts CI).
- **Classify a CI failure before re-running.** Read the failing job log first. Flake/infra (network, runner, timeout with no code link) gets exactly ONE re-run. An identical second failure is real: read the logs and fix it. Never loop re-runs.
- **Pin what you verified.** When a PR passes your checks, record its head SHA, base SHA and `git diff <base>...<head> | git patch-id --stable`. Before landing (queueing/merging), recompute; if the patch-id changed, re-verify that PR first. A SHA change with the same patch-id is fine.
- Restacking and resolving conflicts yourself is allowed here.

## 2. Sync, restack, conflicts
1. `gt sync --no-interactive` then `gt restack` if needed.
2. On conflicts: read both sides, keep both sides' intent (don't blindly take ours/theirs), `git add`, `gt continue`. Generated files (API client): regenerate per repo rules rather than hand-merging.
3. Run the repo verification checks for the touched paths.
4. `gt submit --no-interactive` (add `--stack` when the stack moved).
5. VERIFY, don't assume: `gh pr view <n> --json mergeable,mergeStateStatus,headRefOid` must show `MERGEABLE` and the head SHA you just pushed. If GitHub still says CONFLICTING, main moved again (the user merges a lot at once): go back to step 1.

## 3. Merge queue
1. Only once mergeable and required checks are passing or pending. Add to the Graphite merge queue (Graphite UI action or `gt merge` — ask the user before the first `gt merge` in a session unless he already said "get it merged"/"add to merge queue", which counts as approval for that PR/stack).
2. Confirm it is actually queued (the user: "its not even in the merge queue"). Check PR state/labels/comments from the Graphite bot.

## 4. Poll until done
- Poll every ~3-5 min with `gh pr view <n> --json state,mergeStateStatus` and `gh pr checks <n>`.
- Merged: report and move to the next PR in the stack (bottom-up).
- Dequeued / failed: read why (`gh pr checks`, failing job log). Conflict → §2. Flaky check → re-run once. Real failure → fix minimally, submit, re-queue.
- Stop and report after 3 failed queue attempts for the same reason, or if a fix needs a product decision.

## 5. Report
Per PR: final state (merged/queued/blocked), base branch, head SHA, conflicts resolved (files), checks, and anything left.
