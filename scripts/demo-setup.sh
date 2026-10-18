#!/usr/bin/env bash
# Create disposable demo repos and a separate demo COORD_HOME. Idempotent: existing repos are left alone.
# Usage: scripts/demo-setup.sh   then   export COORD_HOME=~/.local/share/coord-demo
# Demo repos and worktrees go in $COORD_DEMO_DIR (default ~/coord-demo).
set -euo pipefail
coord() { python3 "$(dirname "${BASH_SOURCE[0]}")/../bin/coord" "$@"; }
export DEMO="${COORD_DEMO_DIR:-$HOME/coord-demo}"
export COORD_HOME=~/.local/share/coord-demo
mkdir -p "$DEMO/repos"

commit() { git -C "$1" add -A && git -C "$1" -c user.name=demo -c user.email=demo@local commit -qm "$2"; }

if [ ! -d "$DEMO/repos/mono/.git" ]; then
  r="$DEMO/repos/mono"; mkdir -p "$r/packages/strings" "$r/packages/mathx"
  git init -q -b main "$r"
  cat >"$r/CLAUDE.md" <<'EOF'
Demo monorepo. Python stdlib only. Test a package with:
python3 -m unittest discover -s packages/<pkg> -p 'test_*.py'
EOF
  echo "# demo monorepo" >"$r/README.md"
  echo "lockfile-v1" >"$r/uv.lock"
  cat >"$r/packages/strings/strings.py" <<'EOF'
def slugify(text: str) -> str:
    return "-".join(text.lower().split())
EOF
  cat >"$r/packages/strings/test_strings.py" <<'EOF'
import unittest
from strings import slugify

class T(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(slugify("Hello World"), "hello-world")
EOF
  cat >"$r/packages/mathx/mathx.py" <<'EOF'
def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))
EOF
  cat >"$r/packages/mathx/test_mathx.py" <<'EOF'
import unittest
from mathx import clamp

class T(unittest.TestCase):
    def test_clamp(self):
        self.assertEqual(clamp(5, 0, 3), 3)
EOF
  commit "$r" "initial"
  # Unrelated uncommitted user work that must survive untouched.
  echo "WIP: user notes, not committed" >>"$r/README.md"
  mkdir -p "$r/scratch" && echo "user scratch file" >"$r/scratch/notes.txt"
fi

if [ ! -d "$DEMO/repos/api/.git" ]; then
  r="$DEMO/repos/api"; mkdir -p "$r"; git init -q -b main "$r"
  cat >"$r/users.py" <<'EOF'
USERS = {1: {"id": 1, "first": "Ada", "last": "Lovelace"}}

def get_user(uid: int) -> dict:
    return dict(USERS[uid])
EOF
  cat >"$r/test_users.py" <<'EOF'
import unittest
from users import get_user

class T(unittest.TestCase):
    def test_get_user(self):
        self.assertEqual(get_user(1)["first"], "Ada")
EOF
  echo "Test: python3 -m unittest -v" >"$r/CLAUDE.md"
  commit "$r" "initial"
fi

if [ ! -d "$DEMO/repos/web/.git" ]; then
  r="$DEMO/repos/web"; mkdir -p "$r"; git init -q -b main "$r"
  cat >"$r/greeting.py" <<'EOF'
def greeting(user: dict) -> str:
    return f"Hello, {user['first']}!"
EOF
  cat >"$r/test_greeting.py" <<'EOF'
import unittest
from greeting import greeting

class T(unittest.TestCase):
    def test_greeting(self):
        self.assertEqual(greeting({"first": "Ada", "last": "Lovelace"}), "Hello, Ada!")
EOF
  cat >"$r/check_integration.py" <<'EOF'
"""Combined check: API_PATH points at an api checkout; asserts the web greeting uses its contract."""
import os, sys
sys.path.insert(0, os.environ["API_PATH"])
from users import get_user
from greeting import greeting
assert greeting(get_user(1)) == "Hello, Ada Lovelace!", greeting(get_user(1))
print("integration OK")
EOF
  echo "Test: python3 -m unittest -v ; integration: API_PATH=<api checkout> python3 check_integration.py" >"$r/CLAUDE.md"
  commit "$r" "initial"
fi

coord init
python3 - <<'EOF'
import json, os, pathlib
p = pathlib.Path(os.environ["COORD_HOME"]) / "policy.json"
pol = json.loads(p.read_text())
pol.update(agent_prefix="d", workers_tab_label="coord-demo", worktree_root=os.environ["DEMO"] + "/worktrees")
p.write_text(json.dumps(pol, indent=2) + "\n")
EOF
coord repo add mono "$DEMO/repos/mono" --kind monorepo
coord repo add api "$DEMO/repos/api"
coord repo add web "$DEMO/repos/web"
echo "demo ready: export COORD_HOME=$COORD_HOME"
