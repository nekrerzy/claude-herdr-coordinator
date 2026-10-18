# coord: a coordinator and Claude Code workers over Herdr

One Claude Code session (the **coordinator**) is your main conversation. It plans the work, splits it into
bounded tasks, and runs each task in its own Claude Code **worker**, in a Herdr pane, on its own git worktree
and branch. It then reviews each worker's diff and evidence and reports back to you. `coord` is the small
stdlib-Python CLI that does the bookkeeping.

This repository holds **only the toolkit**: the CLI, the prompts, the docs, the installer. Your repositories,
repo notes, tasks, results and memory stay on your machine and never go into this repo.

## The model

- **Coordinator**: started with `coord-coordinator` in a Herdr pane (Opus 5.5, medium effort, advisor off).
  It follows `prompts/coordinator.md`, which `CLAUDE.md` includes. It is the only agent that starts or
  stops workers.
- **Workers**: up to `max_active_workers` (default 3) interactive Claude Code sessions in a `coord-workers`
  Herdr tab. Each one gets a rendered brief plus `prompts/worker.md`, its own worktree, port range and TMPDIR.
  It reports through `coord report`.
- **Tiers** (`policy.json`): routine = Sonnet 5.5 / medium, complex = Opus 5.5 / high,
  exceptional = Fable 5.1 / high. The coordinator picks a tier per task. `coord verify` checks the model
  and effort the worker actually ran on against its transcript.
- **Watcher and inbox**: `coord watch` is a deterministic daemon. It follows Herdr events and worker
  reports and appends notifications to `inbox.jsonl`. A background `coord inbox --wait` in the coordinator
  session wakes it up. Nobody polls the workers.

`docs/OPERATING.md` is the command reference.

## Prerequisites

| Tool | Minimum | Why |
|---|---|---|
| Linux or macOS | | Linux is tested. macOS should work (stdlib only, no `/proc` dependency) but is untested |
| Python | 3.12, as `python3` on PATH | runs `bin/coord` (stdlib only) |
| git | 2.28 | worktrees, `git init -b` |
| Herdr (`herdr`) | 0.9.1 | panes, agent control, event stream |
| Claude Code `claude` | 2.1.300 | coordinator and workers, logged in |
| uv | any recent | only to run the tests (`uv run pytest`) |

The minimums are the oldest versions this toolkit was verified with. Older versions may work, but the
installer refuses them.

## Install

```bash
git clone <this repo> ~/src/coord && cd ~/src/coord
scripts/install.sh --dry-run     # show what would happen
scripts/install.sh               # check prerequisites, link coord + coord-coordinator into ~/.local/bin,
                                 # create ~/.local/share/coord with a default policy.json
coord doctor                     # read-only health check
```

The installer is idempotent. It never overwrites `policy.json` or `registry.json`, and it refuses to replace
a `coord` link that points to another clone unless you pass `--force`. Other options are `--bin-dir DIR` and
`--no-sync` (skips `uv sync`). `scripts/install.sh --uninstall` removes only the links that point to this
clone and never touches your state.

## First run

1. Start Herdr (`herdr`) and open a pane.
2. In that pane, run `coord-coordinator`. The first time, Claude Code asks you to trust the toolkit folder.
3. Talk to the coordinator. To try it on throwaway repos first, run `scripts/demo-setup.sh`, then start the
   coordinator with `COORD_HOME=~/.local/share/coord-demo coord-coordinator`. The demo repos go in
   `~/coord-demo` (override with `COORD_DEMO_DIR`).

## Your repositories and state

Each person registers their own repositories and keeps their own state:

```bash
coord repo add api ~/src/api                       # lockfiles become shared paths; CLAUDE.md/AGENTS.md recorded
coord repo add mono ~/src/mono --kind monorepo --shared packages/contracts
```

- **State** lives in `$COORD_HOME` (default `~/.local/share/coord`): the registry, policy, tasks, briefs,
  results, events and inbox.
- **Repo notes** are extra per-repo rules for workers, such as "this repo's cloud is only reachable from
  another machine". Keep them in `$COORD_HOME/repo-notes/` and attach them with
  `coord repo add <name> <path> --instructions $COORD_HOME/repo-notes/<name>.md`.
  `examples/repo-notes.example.md` shows the format. A `repo-notes/` folder in the toolkit clone is
  gitignored, so stray notes there are never committed.
- **Worktrees** go in `$COORD_HOME/worktrees/<repo>/<task>` by default. Set `worktree_root` in
  `policy.json`, or `COORD_WORKTREE_ROOT`, to put them elsewhere.
- **Coordinator memory**: Claude Code's auto-memory for the coordinator lives in
  `~/.claude/projects/<clone path with / replaced by ->/memory/`. It is personal and tied to where you
  cloned the toolkit. Cloning to a different path starts with an empty memory.

## Claude Code settings it relies on

Required:
- Claude Code installed and logged in, with access to the models in your `policy.json`. On some plans, Fable
  needs a one-time usage-credit consent (`/model fable` in any session). Until you give it, a Fable worker
  stops at startup.
- **Folder trust**: Claude Code asks once per repository, and worktrees inherit the main repo's trust. A
  worker in a repo you have not trusted yet stops at the dialog. The watcher notifies you, you accept it in
  the worker pane, and then you run `coord kick <task>`. coord never answers dialogs.

Set by coord, no global setting needed:
- Model and effort: workers get `--model`, `--effort` and `CLAUDE_CODE_EFFORT_LEVEL`. The coordinator gets
  `--effort` only, so `/effort` still works.
- Advisor off: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` while `policy.json` has `"advisor": "disabled"`.
- The worker deny list (`--disallowedTools`): workers cannot run coordinator-only `coord` commands or
  `herdr`. This is a Claude permission rule, not an OS sandbox.
- A per-task permission mode: `coord task add --permission-mode acceptEdits|auto|...`, or
  `default_permission_mode` in `policy.json`.

Preferences, not required:
- How often workers stop at permission prompts depends on your Claude Code permission settings
  (`permissions.allow` rules or a default mode such as auto). Every prompt shows up as a `blocked_dialog`
  notification that you answer. The toolkit author's preference is auto mode.
- Leave your global `modelSettings` alone. coord passes model and effort explicitly.

## Sharing with teammates

Share this repository. Each teammate clones it, runs `scripts/install.sh`, registers their own repos, and
writes their own repo notes. Never share:
- `$COORD_HOME` (registry, policy, tasks, briefs, results, runbooks, inbox);
- your repo notes;
- your coordinator memory (`~/.claude/projects/.../memory`).

Organisation-specific rules belong in each team's own repos (their `CLAUDE.md` or `AGENTS.md`, which coord
adds to briefs automatically) or in personal repo notes, not in this toolkit.

## Moving to a new machine

Install as above, then run `coord repo add` for each repository you clone there. If you want your old policy,
copy `policy.json` across. Task history is local and does not need to move. Finish or cancel the open tasks
first.

## Upgrading from an in-repo `repo-notes/` layout

Earlier versions kept repo notes in `repo-notes/` inside the toolkit. Before you pull this version (the
pull deletes them), copy them out:

```bash
mkdir -p ~/.local/share/coord/repo-notes && cp repo-notes/*.md ~/.local/share/coord/repo-notes/
```

Briefs then fall back to `$COORD_HOME/repo-notes/<file>` whenever a registered `.../repo-notes/<file>` path
is missing, and the next `coord resume` rewrites those registry paths.

## Configuration

| Setting | Where | Default |
|---|---|---|
| State directory | `COORD_HOME` | `~/.local/share/coord` |
| Worktree root | `COORD_WORKTREE_ROOT`, or `worktree_root` in `policy.json` | `$COORD_HOME/worktrees` |
| Worker cap, tiers, ports, watcher timing | `policy.json` | see `DEFAULT_POLICY` in `bin/coord` |
| Herdr binary and socket | `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH` | `herdr`, `~/.config/herdr/herdr.sock` |
| Claude config dir (transcripts) | `CLAUDE_CONFIG_DIR` | `~/.claude` |

## Development

```bash
uv run pytest -q
uv run ruff check && uv run ruff format --check
```
