---
name: jira
description: Use for any Jira work via the `jira` CLI (ankitpokhrel/jira-cli): "make/create a Jira ticket", "refine PROJ-xxxx", "make a plan for PROJ-xxxx", "create an epic and tasks", "update the ticket", "assign it to me". Defaults: project PROJ, current sprint, assigned to the user, questions go to the user via AskQuestion, refinement as Jira comments.
---

# Jira (CLI)

Tool: `jira` CLI, already configured (project `PROJ`, board `<BOARD>` id `<BOARD_ID>`, Jira Cloud). Check `jira me` once if unsure it's authenticated. Never print the config's token/server details. Always pass `--no-input` on create/edit/comment so it never prompts.

## Defaults (unless the user says otherwise)
- Project: PROJ (your default project key).
- Assignee: the user (`-a "$(jira me)"`).
- Sprint: current active sprint. Find it: `jira sprint list --state active --table --plain` → take the ID, then `jira sprint add <SPRINT_ID> <KEY>` after creating. If the user says "don't move it to the current sprint", skip this.
- Component: only what the user names via `-C "<Component>"`. If they don't name one and it matters, ask.
- Never @mention or tag other people and never direct questions at them. All open questions go to the user via the AskQuestion tool with concrete options.

## Commands
- View: `jira issue view PROJ-123 --plain --comments 20` (or `--raw` for JSON).
- Search: `jira issue list -q "<JQL>" --plain`, `jira sprint list --current --plain`.
- Create: write the description to a file first, then
  `jira issue create --no-input -t Task -s "<summary>" -T <body.md> -a "$(jira me)" [-C "<component>"] [-P <EPIC-KEY>] [-l <label>]`
  Types: Task, Bug, Story, Epic (epic: `-t Epic`). Child of epic: `-P <EPIC-KEY>`.
- Edit: `jira issue edit PROJ-123 --no-input [-s ...] [-b ...] [-C ...]`.
- Comment: `jira issue comment add PROJ-123 --no-input -T <comment.md>`.
- Status: `jira issue move PROJ-123 "<Status>"`.
- Assign: `jira issue assign PROJ-123 "$(jira me)"`.

## Flows
**Create ticket(s):** draft summary + description (problem, acceptance criteria, notes) → show the user for multi-ticket/epic work ("do the research first, show me the plan, only create tickets after") → create → sprint add → report keys + links.
**Refine a ticket:** read it and comments → investigate the code → list unresolved questions → ask the user via AskQuestion (with options) → post the refinement (decisions, AC, open risks) as a Jira **comment**, not by rewriting the description, unless he says "update the ticket".
**Plan from a ticket:** read ticket + refinement comments → produce the plan in chat/plan mode; don't write to Jira unless asked.
**Epic + children:** research → proposed list for review (the user may add e.g. design tickets) → create epic → create children with `-P` → walk him through top-down if he asks to refine.

Report: keys, summaries, sprint, assignee, component, links (`https://<your-site>.atlassian.net/browse/<KEY>`).
