# auto-retro (automatic end-of-session retro)

One user-level omp extension. When a main-session turn ends and the work looks finished, it runs the `retro` skill once on the cheap smol model chain and appends the result to `~/.omp/agent/retros/YYYY-MM-DD.md`. It never blocks, loops or edits config; every failure means "no retro".

Files: `index.ts` (omp entry: smol-chain generation, the `/retro` command), `register.ts` (hooks), `core.ts` (gates, Jev question, git/PR checks, prompt, file append), `test.ts` (mocked harness). The rubric lives in `~/.omp/agent/skills/retro/SKILL.md`, also usable by hand as `/retro`; the extension reads that file as the system prompt, so there is one source of truth.

## When it fires

Hook: `agent_end`. It is notification-only and fires after the session settles to idle, so nothing waits on it. The work runs detached, aborts the moment a new turn starts, and a failure is one log line.

`session_stop` was not used: it runs before settle, and its continuation would run the retro on the main model.

Checks, in order. Everything above the Jev line costs no model call.

| Gate | Skips when |
| --- | --- |
| kill switch | `OMP_AUTO_RETRO=0` (also `off`, `false`, `no`) or `config.json` `enabled: false` |
| who | not the main session (`ctx.agent.kind !== "main"`: task, scout, reviewer, /tan clones) |
| mode | not `tui` or `rpc` (print and json runs are skipped) |
| settle | `willContinue` is set, the agent is busy, or messages are queued |
| plan | session mode is anything but `none` (plan, plan_paused, goal, vibe) |
| once | a retro message exists on the branch, a manual `/retro` or `/skill:retro` ran (a `skill-prompt` entry for `retro`), or one already ran this session |
| size | fewer than 3 tool calls |
| last turn | final message is not from the assistant, did not end with `stop`, is empty, or ends with a question (one of the last two prose lines ends in `?`) |
| repeat | this exact stop was already judged (a dead Jev is hit once per stop, not once per notification) |
| **Jev** | verdict is not `finished`, or confidence < 0.75 |
| work repo | origin contains `your-work-org/` and the tree is dirty, or there is no open draft PR whose head is the current commit (`gh pr view`, read-only). When the session cwd is not itself a repo, direct-child repos whose directory name appears in the session's tool calls get the same rule |

Jev gets the last 8 messages (redacted), tool-call and error counts, and git state (branch, uncommitted file count, work repo or not). Choices: `finished`, `blocked_on_user`, `mid_task`, `abandoned`.

## Interruptions

A new turn, `/new`, `/resume`, `/fork` or `/tree` aborts a retro in flight and drops it, so a retro can never land in a different session. A follow-up stop that arrives while an earlier check is still on Jev or `gh` is judged after that check settles, not dropped.

## Manual use

`/retro [focus]` (registered by this extension) and `/skill:retro` hand the skill to the main agent as a normal message. Either one marks the session as done, so no automatic retro follows.

## Model use

- Jev: jev-tier's native judge (`jev-tier/judge.ts`): same `judge` role, same key (`TYPESAFE_API_KEY` or `/login typesafe`), same shared judgment cache, same usage journal, same 3s cap. Purpose `auto-retro:session_state`.
- Retro: `@smol`, then `retry.fallbackChains.smol` (luna, haiku, composer here) at low effort where the model has an effort control. 25s per candidate, 60s total, 2000 output tokens, no tools.
- omp's unexpected-stop classifier (`features.unexpectedStopDetection: smart`) journals a `model_usage` entry with purpose `unexpected-stop`. If one sits after the final assistant message, its result (omp ruled the stop deliberate) is passed into the Jev state instead of being re-derived. omp does not expose that verdict on any event, so it cannot short-circuit the Jev question, which also has to separate finished from blocked or abandoned. In this setup unexpected-stop detection is `mechanical`, which makes no model call. `advisor.judgeGate` does not exist in omp 18.8.0.

## Output

The day file gets a header (time, repo, branch, session id, models used, retro model) and the report. The same text is appended to the session as a `retro` message (no turn is started), which also marks the session as done.

## Log

`~/.omp/agent/logs/auto-retro.log`, mode 0600, one line per agent end that got past the kill switch: session prefix, verdict, confidence, `action=ran|skipped`, reason. Nothing is shown in the UI on a skip or an error.

## Turn it off

- Per run: `OMP_AUTO_RETRO=0 omp`.
- Persistent: `~/.omp/agent/extensions/auto-retro/config.json`, `{"enabled": false}`. Tuning keys: `timeoutMs` (1-3000), `minConfidence` (0.75), `messages` (1-20, default 8), `minToolCalls` (3), `generateTimeoutMs` (1000-300000).

## Test

`cd ~/.omp/agent/extensions/auto-retro && bun test.ts`. Scripted Jev, generator, git and gh; writes only under a temp dir.

## New extensions

Any new extension folder must be un-ignored in `~/.omp/agent/.gitignore` (`!/extensions/<name>/`), or omp's discovery, which respects `.gitignore`, won't find it.
