---
name: stack-review
description: Use when the user says "review this stack", "re-review this entire stack", "review <PR URL>", or pastes a "Review this stack (bottom to top)" list. Reviews bottom-to-top with verdicts per PR, reports in chat, then (when told) comments + requests changes on PRs with blockers and approves the rest.
---

# Stack review

Mechanics (worktree, `gt get --no-restack`, per-parent diffs, subagent limits, rubric, output format) come from the `graphite` skill §2. This skill adds the verdict threshold and the follow-up the user asks for every time.

## 1. Review (read-only)
- Bottom-to-top, each branch diffed against its own parent.
- Report in chat first. Do NOT post anything on GitHub until the user says so ("Don't leave any comments yourself, just tell me in the chat" is the default).

## 2. Severity threshold (state it in the report)
- **blocker**: wrong behaviour vs ticket/PR intent, data loss or security risk, broken build/tests, migration risk, Clean Architecture layer inversion, change in the wrong branch of the stack.
- **major**: real bug risk or missing meaningful test, but not ship-stopping.
- **minor/nit**: style, naming, small clean-ups.
- Verdict: any blocker → **changes requested**. Majors only → **approve with comments**. Minors only → **approve**.
- Conventions: only call something a convention violation if you can cite the rule file (`.cursor/rules/*.mdc` or AGENTS.md) AND it matches current code. Check whether existing code already does the same thing (e.g. Refit in Application); if it does, downgrade and say so. the user challenges uncited "conventions".

## 2b. Second-model review (risky PRs only, token-strict)
Default is single-model review. Add ONE second reviewer only when a PR touches DB migrations, auth/permissions/security code, or has >500 changed lines excluding generated files (e.g. `<api-project>/src/generated/**`, `swagger.json`, migration designer/snapshot files) and lockfiles.
- Reviewer: one read-only `task` subagent on `openai-codex/gpt-6.1-sol`.
- Input: ONLY that PR's diff vs its parent (`git diff <parent>...<branch>`) plus the PR title/body. No repo exploration beyond files in the diff. No other PRs.
- Ask for at most ~15 findings, each `severity | file:line | issue | fix`. One pass. No arena, fan-out or re-runs.
- You (lead) merge both sets into **Act on** (would block), **Consider**, **Noted**, **Dismissed** (one-line reason), tagging each with the model(s) that raised it. A finding both models raised is stronger evidence; one only the second model raised needs your own check before it becomes a blocker.
- Say which PRs got the second review and why.

## 3. Follow-up (only when the user says to act)
Default action when he says "do it" / "leave comments and approve the rest":
1. PRs with blockers: inline comments for each blocker (file:line, issue, suggested fix) + `gh pr review <n> --request-changes -b "<summary>"`.
2. PRs with majors only: comment on the majors, then `gh pr review <n> --approve`.
3. Everything else: `gh pr review <n> --approve`.
Never approve or request changes on your own (the user's) PRs if GitHub disallows it; report instead.

## 4. Clean-up
Remove the review worktree. Report: per PR verdict, what was posted, link.
