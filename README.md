# omp-workflow

My day-to-day setup for [omp](https://github.com/can1357/oh-my-pi), the coding-agent CLI: global agent rules, skills, extensions and an example model config. Work-specific skills are not included.

## What's here

| Path | What it is |
| --- | --- |
| `AGENTS.md` | Global rules: classify the repo (work vs personal), Graphite and draft-PR-only flow for work repos, credential hygiene, finish checklist, delegation to subagents, safe-edit rules, QA screenshots. |
| `skills/` | `csharp`, `typescript-react`, `graphite`, `handover`, `jira`, `overnight`, `pr-address-comments`, `pr-babysit`, `retro`, `stack-review`. |
| `extensions/auto-retro/` | Writes a short retro when a session finishes, after cheap gates and a Jev "is this really finished?" check. Needs `omp-jev-tier` (below). |
| `config/config.example.yml` | Model roles and per-role fallback chains (one vendor per step, paid models only). |
| `config/mcp.example.json` | MCP servers I use (Figma, Playwright). |

## Install

```sh
git clone git@github.com:charliemartin0/omp-workflow.git
cd omp-workflow
mkdir -p ~/.omp/agent/skills ~/.omp/agent/extensions
cp AGENTS.md ~/.omp/agent/AGENTS.md            # back up your own first
cp -r skills/* ~/.omp/agent/skills/
cp -r extensions/auto-retro ~/.omp/agent/extensions/
cp config/config.example.yml ~/.omp/agent/config.yml   # or merge by hand
cp config/mcp.example.json ~/.omp/agent/mcp.json
```

Then set these for your environment:

- `OMP_WORK_ORG`: the GitHub org that holds your work repos. `AGENTS.md`, the `graphite` skill and `auto-retro` treat a remote containing `your-work-org/` as a work repo, so replace `your-work-org` with your org.
- `OMP_NIGHTSHIFT_HOME`: path to your omp-nightshift checkout (used by the `overnight` skill).
- `jira` skill: replace `PROJ`, `<BOARD>` and `<your-site>` with your Jira project key, board and site.
- `auto-retro` imports `../jev-tier/core`, so install omp-jev-tier into `~/.omp/agent/extensions/jev-tier`. Test it with `cd ~/.omp/agent/extensions/auto-retro && bun test.ts`.

## Related repos (not copied here)

| Repo | What it is |
| --- | --- |
| [omp-nightshift](https://github.com/charliemartin0/omp-nightshift) | Overnight runner: plans a backlog into chunks and runs them unattended, with retries and draft PRs. Used by the `overnight` skill. |
| [omp-jev-tier](https://github.com/charliemartin0/omp-jev-tier) | omp extension for Jev-based subagent model tiering and automatic plan mode. |
| [testscope](https://github.com/charliemartin0/testscope) | Generic e2e test router: picks which tests to run for a change. |
| [tern-graphite](https://github.com/charliemartin0/tern-graphite) | Tern plugin: Graphite stack view. |
| [tern-jira](https://github.com/charliemartin0/tern-jira) | Tern plugin: Jira tickets. |
| [tern-pr-tour](https://github.com/charliemartin0/tern-pr-tour) | Tern plugin: PR walkthrough. |
| [tern-dir-blocks](https://github.com/charliemartin0/tern-dir-blocks) | Tern plugin: directory blocks. |
| [tern-overnight](https://github.com/charliemartin0/tern-overnight) | Tern plugin: overnight-run panel. |

## License

MIT
