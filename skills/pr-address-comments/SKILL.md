---
name: pr-address-comments
description: Use when the user says "action comments", "address comments", "validate/verify comments", "returned to me with comments", or "check if you agree and action" on a work-repo PR or stack, or asks to action every "Returned to you" PR. Verifies each review comment, fixes or replies, submits with gt, replies on each thread, and requests re-review.
---

# Address PR review comments

Uses the `graphite` skill for gt mechanics and `repo verification` for checks.

## 1. Collect
1. `gh pr view <n> --json number,headRefName,baseRefName,reviews,comments,author` and the inline threads: `gh api repos/{owner}/{repo}/pulls/<n>/comments` (include Graphite bot comments).
2. Skip resolved/outdated threads. List every open comment with an id.
3. Check out the branch in your own worktree (`gt get <n> --no-interactive`, then `gt checkout`).

## 2. Verify each claim BEFORE acting
the user's standing instruction: "Don't assume the comment is correct. Verify first."
For each comment: read the code, reproduce or reason it through, check the repo conventions (`.cursor/rules/*.mdc`, AGENTS.md). Classify:
- **valid** → fix.
- **partly valid** → fix the valid part, explain the rest.
- **invalid / out of scope** → no code change; draft a short, polite reply with the evidence.
- **needs a product decision** → ask the user (AskQuestion with options), don't guess.

## 3. Fix
- Smallest change that addresses the comment, on the correct branch in the stack (`gt modify --into <branch>` if it belongs lower).
- Run the relevant checks, then `gt submit --no-interactive` (stack if needed). If there are merge conflicts, resolve them too (see `pr-babysit` §2) and confirm GitHub shows MERGEABLE.

## 4. Reply and re-request
Only after the push is confirmed:
1. Reply on each thread: what changed (with commit SHA) or why not. `gh api repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies -f body=...`.
2. Optionally one summary PR comment listing all items.
3. Re-request review from the original reviewer(s): `gh pr edit <n> --add-reviewer <login>`.
Do steps 4.1-4.3 by default once fixes are pushed; the user routinely asks for them ("leave a comment saying what's been addressed and request re-review").

## 5. Report
Table: comment → verdict (valid/invalid/decision) → action (commit SHA or reply) ; checks run; re-review requested from whom.
