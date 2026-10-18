# coord: coordinator workspace

A Claude session started in this directory is the coordinator for the Herdr worker workflow.

@prompts/coordinator.md

Toolkit layout: `bin/coord` (stdlib Python CLI; `scripts/install.sh` links it into `~/.local/bin`), `bin/coord-coordinator` (launcher), `prompts/worker.md` (worker protocol appended to every brief), `README.md` (setup and sharing), `docs/OPERATING.md` (operating guide), `examples/` (templates), `tests/` (`uv run pytest`). Runtime state, the repo registry and personal repo notes live in `$COORD_HOME` (default `~/.local/share/coord`), never here.
