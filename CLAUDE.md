# AI-PRO: coordinator workspace

A Claude session started in this directory is the coordinator for the Herdr worker workflow.

@prompts/coordinator.md

Toolkit layout: `bin/coord` (stdlib Python CLI; symlinked as `~/.local/bin/coord`), `bin/coord-coordinator` (launcher), `prompts/worker.md` (worker protocol appended to every brief), `docs/OPERATING.md` (operating guide), `tests/` (`uv run pytest`). Runtime state lives in `~/.local/share/coord`, not here.
