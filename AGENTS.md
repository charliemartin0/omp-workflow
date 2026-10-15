# Global rules

Hard rules. If a repo AGENTS.md, skill, template, or hook conflicts with them, these win.

## 1. Classify the repo first
Run `git remote get-url origin` before any git or PR action.
- Contains `your-work-org/` → WORK repo: Graphite, always draft PRs. Load the `graphite` skill for stack, submit, and review mechanics.
- Anything else, or no remote → PERSONAL repo: plain git. Local branch + `git commit`; `git merge` locally only when the user says so. No `gt`, no PRs, no `git push` unless the user asks.

## 2. WORK repos: Graphite only, always draft
- Commit with `gt create -m "<msg>"` (new branch on top of current) or `gt modify` (amend, or `-c` for a new commit). No plain `git commit` on stack branches. Before `gt create`, decide the base: if the ticket doesn't continue an existing stack, run `gt sync`, then `gt checkout main`, first. Stack on the current branch only when the work depends on it.
- Create/update PRs only with `gt submit --draft` or `gt ss --draft` (= `gt submit --stack --draft`). Never without `--draft`. Never `--publish`/`-p`, never `--force`/`-f`. Before `gt submit`, run `gt parent` (or `gt log short`) and state the base branch in the final message. Never plain `git push` or `git push --force*` on Graphite branches; use `gt submit --draft`, and ask before any force push.
- Allowed `gh` PR commands, and nothing else: `gh pr view` (read-only), `gh pr ready --undo`, `gh pr edit <n> --body-file <f>`, `gh pr edit <n> --attach <file>`.
- Never `gh pr create`. Never `gh pr ready` without `--undo`. Never publish or mark ready, even if a repo skill says to.
- Ticket belongs to an existing stack → continue it (`gt checkout <branch>`, then `gt create` on top). Never start a parallel stack.
- Agent work ends with a draft PR pushed via `gt submit --draft` after checks and review pass, not just a local commit.
- Ask the user first for: merges (`gt merge`, GitHub merge), force-push, `git reset --hard`, and any history rewrite outside gt's normal modify/restack/submit flow on your own stack (`git rebase`/`git push --force`, `gt fold`/`squash`/`split`/`move`/`reorder`/`delete` on submitted branches).

## 3. Accounts and credentials
- Use only the active account's credentials. Work repos use `<work-account>` via the SSH host alias `github.com-work` (already in origin).
- Before using another account's credentials, ask the user with the account, action, and reason, then wait. That covers `gh auth token --user`, `gh auth switch`, other SSH host aliases or keys, `GH_TOKEN`/`GITHUB_TOKEN`/`GIT_ASKPASS`/credential-helper injection, and other API tokens.
- Push/fetch/`gt submit` fails because of the wrong account → stop and ask. Don't work around it.
- Never print tokens. Jira: use the `jira` CLI (token is in env as `JIRA_API_TOKEN`).

## 4. Finishing a task
- Run cheap relevant checks before handing off: affected tests, type-check/build, architecture rules.
- Commit before saying done. Never call work done with a dirty worktree (`git status --porcelain` clean, except intentional untracked install dirs).
- Report: branch, commit SHA(s), checks run with results; in work repos also the draft PR number(s).

## 5. Code quality
- Clean Architecture + DDD: dependencies point inward (Domain ← Application ← Infrastructure/API). Any layer inversion (Domain/Application referencing Infrastructure, API, EF, HTTP) is a blocker: stop and report it.
- Refactor only when the change maps to a named technique from https://refactoring.guru/refactoring/catalog (e.g. Extract Method, Move Method). Name the technique in the commit/PR. No rewrites, framework swaps, or style churn.
- Stay in scope. Touch only what the task needs.

## 6. QA screenshots (frontend changes in WORK repos)
After `gt submit --draft`:
1. Capture each changed view with the Playwright MCP (`browser_navigate` → `browser_take_screenshot`) at a 1920x1080 viewport. No `fullPage`.
2. `identify <file>.png` must report 1920x1080. Otherwise retake.
3. `md5sum` all shots and drop duplicates. Never attach two identical images.
4. Write `![<view> 1920x1080](./<file>.png)` into a body file, then `gh pr edit <n> --body-file <f> --attach './<file>.png#<alt>'` (gh swaps in the uploaded URL). Don't commit screenshots.
5. The PR stays draft.
- Playwright MCP missing or broken → report a precise blocker. Never fake or reuse a screenshot.
- Personal repos: no PR; report screenshot paths and md5s.

## 7. the user and other agents
- Ask the user questions with the `ask` tool and clickable options (mark the recommended one), not free-text questions in prose.
- Never kill or disturb the user's or other agents' sessions, terminals, windows, workspaces, or worktrees. Verify ownership before acting; never use the active window as an implicit QA target.
- Never force-push or rewrite pushed history (the only exception is gt's own modify/restack/submit flow on your own work-repo stack).

## 8. Delegation (subagents)
For any plan with more than one independent part, delegate rather than doing it all in the main session:
1. Explore with `scout` subagents first (read-only, cheap) when you don't already know the code.
2. Split implementation into independent units and run them as `task` subagents in parallel, one unit each, with explicit paths, done-when, and checks. Use isolated worktrees when parallel tasks touch the same repo. Keep dependent units sequential.
3. Use `sonic` only for purely mechanical edits (renames, bulk replacements, data collection).
4. Before calling the work done, run a `reviewer` subagent on the combined diff. Fix P0/P1 findings and re-review; list any P2/P3 you left.
5. The main session coordinates, integrates, runs the final checks, and does the §4 finish. Don't delegate trivial single-file changes.
6. Size check: if a task looks likely to need more than ~150 tool calls (multi-area changes, big refactors, "continue" loops), don't grind it out in one session. Write a short plan first, then run each part as a `task` subagent with its own done-when, and keep the main session to coordination. If a session is already past ~150 tool calls, stop at the next safe point and offer a `handover`.

## 9. Safe edits
- New files: use `write`, not shell redirection or `edit`.
- Existing files: after any stale-tag or failed edit, re-read first, then edit with exact current anchors/ranges. Never reuse old line numbers or tags.
- Re-read a file after writing to it, or after any failed edit, before editing it again. Never edit from a stale read.
- Use one hunk per unique anchor. If an anchor isn't unique, widen it instead of guessing.
- Validate shell quoting separately (e.g. echo the argument or dry-run it) before re-running a failed command.
- Read CLI help and installed-version docs before guessing commands or flags. A failed command is not permission to try another mutating syntax; verify its arguments and explicit target first.
- Hashline patches: use the exact file path and latest displayed tag/lines. Operation headers (`PUT`, `CUT`, etc.) are bare; only replacement-content rows start with `+`. Never put an operation header inside a `+` body row.
- Read PNG/JPEG screenshots with their bare path. `:img` is for rasterizing SVG/SVGZ, not for reading PNG.
- Launch long-lived QA apps through a named service with a readiness condition. Do not rely on shell `&`/`nohup` surviving the tool call.
- Scope `find`/`grep`/`glob` to the repo root or a known directory (e.g. `<projects-dir>/<repo>`, `~/.config/<tool>`). Never search `/tmp` or your whole home directory; it times out. Unknown location: `ls` likely parents (`<projects-dir>`, `~/.config/<tool>/plugins`) first.
- Run verification only after the mutating steps it checks (delete, push, fetch/prune, merge) have finished and returned. Never put verification in the same parallel tool-call batch as the mutation; parallel calls run concurrently and report pre-change state.

## 10. GitHub branch protection changes
1. Verify repo owner/name and default branch, the active `gh` account, and its permission on the repo (admin needed).
2. Before mutating, query existing classic protection and rulesets (`branches/<b>/protection`, `rulesets`).
3. Interpret 404 carefully: unprotected branch vs wrong repo/branch vs missing permission. Check which before acting.
4. Apply only a policy the user explicitly approved. Don't invent settings.
5. Re-query afterward and verify the exact effective settings match the approved policy; report them.


## 11. Tern plugin verification and cleanup
- Check `tern --version` and `tern help dev` first. Reference plugins establish style and patterns, not authoritative facts about the installed SDK or CLI.
- Use a private `TERN_CONFIG_DIR`, `TERN_DAEMON_SOCKET`, `STENCIL_LOG_DIR`, and unique control socket for QA. Do not modify the user's plugin links or reload unrelated plugins just to test a package.
- Cleanup only owned QA resources. Do not unlink a plugin the user needs to use after delivery. If activating it in the normal config, `tern plugin link <dir>` reloads the daemon and windows watch the folder change; a restart is not normally needed. Changed auth env vars require restarting the host daemon, but never restart the user's daemon without explicit approval: it may disrupt live panes. Restart only private QA daemons you own.
- Regenerate `tern.d.luau` with `tern plugin types <dir>`; never hand-edit generated declarations to make checks pass. Compilation, type-checking, simulated API regressions, and actual Tern UI smoke are separate evidence; never call fixtures a live API test.
- For luau-lsp, use an absolute definitions path. If the generated SDK requires a missing opaque primitive (e.g. `userdata`), supply only that primitive in a separate temporary definition file. Keep the generated file unchanged, do not filter diagnostics or replace types with `any`, and report the compatibility workaround.
- Exercise the actual block with `tern --control <owned-sock>`, `tern ctl --control <owned-sock> plugins run plugin.<id>.<command>`, and `tern ctl --control <owned-sock> plugins expect '"rendered text"'` (the inner quotes must survive shell parsing). Inspect the rendered text before choosing expectations; span boundaries can affect matching.
- Capture screenshots with `tern ctl --control <owned-sock> shot <name>`, never a desktop grab. Float and size only the owned window; physical size = logical content size × display scale (1536×864 at 1.25 → 1920×1080). Verify with `identify`, visually inspect with `read`, and report paths/hashes.

## 12. Hyprland QA window targeting
- Discover the running instance and owned window PID first. Target every window mutation with `window = "pid:<owned-pid>"`; title/class alone may match the user's window.
- Hyprland Lua syntax: `hyprctl dispatch 'hl.dsp.window.float({window="pid:<owned-pid>", action="set"})'`; resize with `hl.dsp.window.resize({window="pid:<owned-pid>", x=1536, y=864})`. Check installed help/docs before using these on another version.
- `hyprctl dispatch` wraps the expression in `hl.dispatch(...)`: do not wrap it again. Resize uses `x`/`y`, not `width`/`height`. Never omit the selector or switch workspace/focus as a workaround for targeting failures.
