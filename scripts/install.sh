#!/usr/bin/env bash
# Install coord from this clone: check prerequisites, link coord + coord-coordinator into ~/.local/bin,
# create COORD_HOME with a default policy. Idempotent; never overwrites state.
# Usage: scripts/install.sh [--bin-dir DIR] [--dry-run] [--uninstall] [--force] [--no-sync]
set -euo pipefail
TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "python3 not found: install Python >= 3.12 (or set PYTHON=/path/to/python3)" >&2
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 12))'; then
  echo "$("$PY" --version 2>&1) is too old: coord needs Python >= 3.12 as python3 on PATH" >&2
  exit 1
fi
exec "$PY" "$TOOL_DIR/bin/coord" install "$@"
