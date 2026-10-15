---
name: handover
description: Use when the user says "handover", "handover prompt", "give me a prompt for a new session", or when the session is getting long (roughly 150+ tool calls, repeated "continue", or context near its limit). Writes a self-contained handover prompt with goal, repo/branch/PR, done, next, gotchas and the resume command.
---

# Handover

## When
- the user asks ("create me a handover prompt so i can run this in a new session").
- Proactively offer it when the session has passed ~150 tool calls, the user has typed "continue" 2+ times, or context is heavy. Offer; don't stop work unilaterally.

## Gather (facts, not memory)
- `git rev-parse --show-toplevel`, `git branch --show-current`, `git status --short`, `gt log short` (work repos), last commit SHA.
- PR numbers + URLs and draft state (`gh pr view --json number,url,isDraft,baseRefName`).
- Session id for resume (shown in the session header / `omp --resume` picker).
- Checks last run and their results.

## Write
Save to `local://handover-<short-topic>.md` and print it in chat. Format:

```md
# Handover: <topic>
Resume full history: `omp --resume <session-id-prefix>` (or start fresh with this prompt)

## Goal
<one paragraph, what "done" means>

## Where
- Repo: <path> (cd there first)  Branch: <branch>  Base: <parent>
- PR(s): #<n> <url> (draft)
- Worktree: <path, if not the main checkout>

## Done
- <bullets with commit SHAs>

## Next
1. <ordered, concrete steps with done-when>

## Gotchas / decisions already made
- <the user's corrections and rules from this session, e.g. "base on main not #123", "run yarn generate yourself">

## Checks
- <exact commands> → <last result>
```
Keep it under ~60 lines. No secrets, tokens or passwords; point to where they live instead.
