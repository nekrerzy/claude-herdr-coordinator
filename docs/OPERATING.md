# Operating guide: Herdr coordinator + Claude workers

Toolkit: wherever you cloned it; `scripts/install.sh` links `coord` and `coord-coordinator` into `~/.local/bin` (see `README.md`).
State: `~/.local/share/coord` (override with `COORD_HOME`; the demo uses `~/.local/share/coord-demo`).
Health check: `coord doctor` (read-only: prerequisites, links, policy, registered repos, watcher, Herdr socket).

## Start the coordinator (Opus 5.5, medium effort)
In a Herdr pane (`HERDR_ENV=1`):
```bash
coord-coordinator                 # claude --model claude-opus-5-5 --effort medium, advisor disabled
coord-coordinator --resume <id>   # resume a previous coordinator session (or --continue)
```
The launcher uses `--effort` (session-scoped) and never edits your global `modelSettings`. To raise effort temporarily: `/effort`, pick `high`, press `s` (this session only); return to medium the same way.
If you are not in Herdr: open a terminal, run `herdr`, then run `coord-coordinator` in that pane.

In a new coordinator session, the coordinator runs `coord coordinator`, `coord resume`, and arms `coord inbox --wait` as a background task (see `prompts/coordinator.md`). You just talk to it.

## Register repositories and plan work
```bash
coord repo add api ~/src/api                             # lockfiles become shared paths; CLAUDE.md/AGENTS.md recorded
coord repo add mono ~/src/mono --kind monorepo --shared packages/contracts
coord repo add infra ~/src/infra --instructions $COORD_HOME/repo-notes/infra.md   # personal repo notes
coord initiative add rename --title "..." --repos api web --order api,web --interface "GET /u returns display_name"
coord task add --title "..." --repo mono --paths packages/a --objective "..." \
  --accept "..." --validate "pytest packages/a"          # routine tier by default
coord task add --title "..." --repo api --tier complex --initiative rename ...
coord task add --title "..." --repo web --repo api:read --depends-on t003 ...
coord task add --title "survey X" --repo api --readonly  # research; shares the checkout
coord launch <task> [--dry-run]                           # worktree + pane + worker + kickoff
```
Repo notes (extra per-repo rules such as access limits) are personal: keep them in `$COORD_HOME/repo-notes/`, never in the toolkit repo; `examples/repo-notes.example.md` shows the format.
`launch` refuses: a duplicate live worker, unmet dependencies, more than 3 active workers, overlapping paths in the same repo, or calls from a worker.

## Status and inspection
```bash
coord status [--all|--json]   # task, repos, worker@pane, model/effort (✓ = verified from transcript), state, live, report, next
coord show <task>             # brief/progress/result, commits + diffstat per worktree, events, token usage
coord peek <task>             # the worker's terminal
coord verify [task]           # requested vs actual model/effort/advisor, recorded vs Herdr session id
coord inbox [--all]           # notifications (the coordinator's background `coord inbox --wait` normally consumes these)
```
States: `planned → running ⇄ blocked → ready_for_review → validated`, plus `failed`, `cancelled`. Only the coordinator sets `validated` (`coord set <t> --state validated --evidence "..."`). Idle or exited is never success.

## Model and effort
Tiers in `policy.json`: routine = Sonnet 5.5 / medium, complex = Opus 5.5 / high, exceptional = Fable 5.1 / high.
```bash
coord task add ... --tier complex | --model claude-opus-5-5 --effort high
coord task set <task> --effort xhigh --reason "..."        # before launch (or applies at next relaunch)
coord relaunch <task> --model claude-opus-5-5 --effort high --stop --reason "..."  # same session, new model
```
Every worker gets `--model`, `--effort`, `CLAUDE_CODE_EFFORT_LEVEL` (highest precedence), and `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`.
Workers also get `--disallowedTools` denying coordinator-only `coord` subcommands, `herdr`, and edits to `registry.json`, so worker management stays with the coordinator. This is enforced by Claude permissions; it is not an OS sandbox.

## Escalate a hard question
```bash
coord escalate <task> --question "..." --context "what was tried / completed"   # Fable 5.1 / high, read-only
coord launch <escalation-task>
```
Then feed the answer back with `coord prompt <task> "..."` instead of restarting the work. On some plans, the first Fable use needs your one-time usage-credit consent (`/model fable` in any session); until then a Fable worker stops at startup and `coord launch` reports it.

## Redirect, cancel, close, resume
```bash
coord prompt <task> "new instruction"   # refused by Herdr if the worker is at a dialog
coord cancel <task> [--reason ...]      # stops the worker, closes its pane, keeps worktree + branch
coord close <task>                      # after review: stop a finished worker to free a slot
coord relaunch <task> [--fresh]         # resume the same Claude session in a new pane
coord kick <task>                       # send the kickoff prompt if launch stopped at a startup dialog
coord cleanup <task> --yes              # remove finished worktrees (refuses if dirty; branches kept)
```

## Watcher and resume
```bash
coord watch start|stop|status|log   # daemon; pid in $COORD_HOME/watcher.pid; log in the coord-workers tab
coord resume                        # reconcile registry vs panes, Git, result files; starts the watcher if stopped
                                    # also rewrites registry paths to repo notes moved to $COORD_HOME/repo-notes
```
The watcher subscribes to Herdr events and re-reads state every 10 s as a fallback. It writes `events.jsonl` and `inbox.jsonl` and shows Herdr toasts. It never types into a pane. Restarting it does not repeat notifications, and completions it missed while stopped are reported once.

## Folder trust
Claude Code asks once per **repository** (worktrees inherit the main repo's trust). A worker of a not-yet-trusted repo stops at the dialog: `coord launch` reports it, the watcher notifies, and **you** accept it in the worker pane, then run `coord kick <task>`. coord never answers that dialog.

## Files
`$COORD_HOME/registry.json` (coordinator-owned), `policy.json`, `tasks/<id>/{brief.md,progress.md,result.md,status.json,tmp/}`, `events.jsonl`, `inbox.jsonl`, `watcher.log`. Worktrees: `<worktree_root>/<repo>/<task>` on branch `coord/<task>`; `worktree_root` is `COORD_WORKTREE_ROOT`, else `policy.json`, else `$COORD_HOME/worktrees`. Worktrees isolate files only; they are not a security sandbox.

## Demo
`scripts/demo-setup.sh` creates disposable repos in `$COORD_DEMO_DIR` (default `~/coord-demo`) and `COORD_HOME=~/.local/share/coord-demo`. Remove the demo when done (after `coord watch stop` with that COORD_HOME): close the `coord-demo` Herdr tab, then delete the demo dir and `~/.local/share/coord-demo`.
