---
name: retro
description: Use for /retro, or when a session's work is finished and you want a short retro. Writes what went well, even better if, friction (repeated corrections, tool failures, retries, model or effort escalations) and proposed durable fixes, then appends it to ~/.omp/agent/retros/YYYY-MM-DD.md. Proposes only; never edits AGENTS.md, skills, config.yml or jev-tier.
---

# Retro

Short. Specific. Under 250 words. Name the thing, skip the story.

## Report

Two sections, nothing else. Friction and fixes live inside them.

```md
### What went well
- <thing that worked, and why it mattered>

### Even better if
- <friction or gap: what happened, once> -> **fix** `[tag]` <one-line change>
```

## Friction goes in "Even better if"

Look for:

- Corrections I had to repeat. Same instruction twice means a rule is missing.
- Tool failures and retries. Same call failing, then succeeding, means a wrong default.
- Wrong model or effort, then an escalation. Heavy work on a quick model, or the reverse.

One bullet per cause, not per occurrence. No friction? Write `- none`.

## Fix tags

Tag every fix with exactly one:

| Tag | Use when |
| --- | --- |
| `AGENTS.md` | A standing rule or convention is missing or wrong |
| `skill` | A repeatable procedure needs a new or sharper skill |
| `config.yml` | A setting, model role or fallback chain is wrong |
| `jev-tier` | Model-tier or plan-mode routing picked badly |

A fix is one line: file or skill name, and the change. A friction item with no durable fix gets no tag.

## Rules

- Propose only. Never edit AGENTS.md, a skill, config.yml or jev-tier. I apply fixes.
- No mail. No PR. No commit.
- Don't pad. Skip a section's bullet before you invent one.

## Save it

Append to `~/.omp/agent/retros/YYYY-MM-DD.md` (today, local date). Create the directory and file if missing. Never overwrite.

```md
## HH:MM

- repo: <git remote get-url origin, else cwd>
- branch: <git branch --show-current>
- session: <session id>
- models: <every provider/model used, comma separated>

<the report>

---
```

Session id: the uuid in the newest file name under `~/.omp/agent/sessions/<cwd-slug>/`. Models: from the session's assistant messages.

If the harness says it writes the file, output only the report. No header, no tools.
