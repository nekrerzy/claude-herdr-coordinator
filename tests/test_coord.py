"""Tests for bin/coord using a fake herdr binary (no model calls, no live Herdr)."""

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

FAKE_HERDR = r"""#!/usr/bin/env python3
import json, os, sys
state = json.load(open(os.environ["FAKE_HERDR_STATE"]))
args = sys.argv[1:]
def err(code):
    print(json.dumps({"error": {"code": code, "message": code}}), file=sys.stderr); sys.exit(1)
if args[:2] == ["agent", "list"]:
    print(json.dumps({"result": {"agents": state["agents"]}}))
elif args[:2] == ["pane", "get"]:
    if args[2] in state["panes"]:
        print(json.dumps({"result": {"pane": {"pane_id": args[2]}}}))
    else:
        err("pane_not_found")
elif args[:2] == ["notification", "show"]:
    print(json.dumps({"result": {"shown": False}}))
else:
    err("unsupported_in_fake")
"""


@pytest.fixture
def coord(tmp_path, monkeypatch):
    loader = importlib.machinery.SourceFileLoader("coord_mod", str(ROOT / "bin" / "coord"))
    spec = importlib.util.spec_from_loader("coord_mod", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    home = tmp_path / "home"
    fake = tmp_path / "herdr"
    fake.write_text(FAKE_HERDR)
    fake.chmod(0o755)
    state = tmp_path / "herdr-state.json"
    monkeypatch.setattr(mod, "HOME", home)
    monkeypatch.setattr(mod, "HERDR", str(fake))
    monkeypatch.setattr(mod, "CLAUDE_PROJECTS", tmp_path / "projects")
    monkeypatch.setenv("FAKE_HERDR_STATE", str(state))
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.delenv("COORD_ROLE", raising=False)
    mod.cmd_init(None)
    atomic = mod.atomic_write
    atomic(home / "policy.json", json.dumps({"watch": {"poll_seconds": 1, "idle_confirm_seconds": 0,
                                                       "toast": False},
                                             "worktree_root": str(tmp_path / "worktrees")}))

    def set_herdr(agents, panes=None):
        state.write_text(json.dumps({"agents": agents, "panes": panes or [a["pane_id"] for a in agents]}))

    set_herdr([])
    mod.set_herdr = set_herdr
    mod.tmp = tmp_path
    return mod


def make_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True)
    (path / "a.txt").write_text("one\n")
    (path / "uv.lock").write_text("lock\n")
    subprocess.run(["git", "-C", str(path), "add", "."], check=True)
    subprocess.run(["git", "-C", str(path), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
                   check=True)
    return path


def run(coord, *argv):
    assert coord.main(list(argv)) == 0


def add_running_task(coord, title="demo", pane="w1:p9", session="s-1"):
    run(coord, "repo", "add", "r", str(make_repo(coord.tmp / f"repo-{title}")))
    run(coord, "task", "add", "--title", title, "--repo", "r")
    with coord.registry_edit() as reg:
        tid = next(iter(t for t in reg["tasks"] if title in t))
        task = reg["tasks"][tid]
        task["worker"] = {"agent_name": "w001", "pane_id": pane, "session_id": session, "launched": "x",
                          "status": "prompted", "prompted": "x", "model": task["model"], "effort": task["effort"]}
        coord.set_state(task, "running")
    return tid


def agent(pane, status, seq, session="s-1"):
    return {"pane_id": pane, "agent": "claude", "agent_status": status, "state_change_seq": seq,
            "agent_session": {"value": session}}


def inbox(coord):
    return coord.read_jsonl(coord.HOME / "inbox.jsonl")


def test_paths_overlap(coord):
    assert coord.paths_overlap(["packages/a"], ["packages/a/src"])
    assert not coord.paths_overlap(["packages/a"], ["packages/ab"])
    assert coord.paths_overlap([], ["x"])  # undeclared = whole repo


def test_resolve_model_rejects_unsupported(coord):
    policy = coord.load_policy()
    assert coord.resolve_model(policy, "complex", None, None)["model"] == "claude-opus-5-5"
    assert coord.resolve_model(policy, "exceptional", None, None) == {
        "tier": "exceptional", "model": "claude-fable-5-1", "effort": "high", "source": "tier:exceptional"}
    with pytest.raises(coord.CoordError):
        coord.resolve_model(policy, "routine", None, "ultra")
    with pytest.raises(coord.CoordError):
        coord.resolve_model(policy, "routine", "gpt-5", None)


def test_report_notifies_once_and_survives_watcher_restart(coord, monkeypatch):
    tid = add_running_task(coord)
    coord.set_herdr([agent("w1:p9", "working", 1)])
    coord.Watcher().reconcile()
    assert inbox(coord) == []
    monkeypatch.setenv("COORD_TASK_ID", tid)
    run(coord, "report", "--state", "ready_for_review", "--summary", "done")
    coord.set_herdr([agent("w1:p9", "idle", 2)])
    coord.Watcher().reconcile()
    w2 = coord.Watcher()  # restart: state reloaded from disk
    w2.reconcile()
    w2.reconcile()
    kinds = [e["kind"] for e in inbox(coord)]
    assert kinds == ["ready_for_review"]  # no duplicate, no spurious idle_no_report


def test_idle_without_report_blocked_and_exit(coord):
    add_running_task(coord)
    w = coord.Watcher()
    coord.set_herdr([agent("w1:p9", "working", 1)])
    w.reconcile()
    coord.set_herdr([agent("w1:p9", "idle", 2)])
    w.reconcile()
    w.reconcile()  # idle confirmed on a later pass
    coord.set_herdr([agent("w1:p9", "blocked", 3)])
    w.reconcile()
    coord.set_herdr([], panes=[])  # pane closed
    w.reconcile()
    assert [e["kind"] for e in inbox(coord)] == ["idle_no_report", "blocked_dialog", "exited"]


def test_missed_completion_is_recovered_after_restart(coord):
    add_running_task(coord)
    coord.set_herdr([agent("w1:p9", "working", 1)])
    coord.Watcher().reconcile()  # watcher saw it working, then stopped
    coord.set_herdr([agent("w1:p9", "done", 5)])  # finished while watcher was down
    w = coord.Watcher()
    w.reconcile()
    w.reconcile()
    assert [e["kind"] for e in inbox(coord)] == ["idle_no_report"]


def test_inbox_cursor(coord, capsys):
    add_running_task(coord)
    coord.set_herdr([agent("w1:p9", "blocked", 1)])
    coord.Watcher().reconcile()
    run(coord, "inbox")
    assert "blocked_dialog" in capsys.readouterr().out
    run(coord, "inbox")
    assert "no unread" in capsys.readouterr().out


def test_dry_run_pins_model_effort_and_disables_advisor(coord, capsys):
    run(coord, "repo", "add", "r", str(make_repo(coord.tmp / "repo")))
    run(coord, "task", "add", "--title", "hard question", "--repo", "r", "--tier", "exceptional")
    capsys.readouterr()
    run(coord, "launch", "t001", "--dry-run")
    plan = json.loads(capsys.readouterr().out)
    cmd = plan["command"]
    assert cmd[cmd.index("--model") + 1] == "claude-fable-5-1"
    assert cmd[cmd.index("--effort") + 1] == "high"
    assert plan["env"]["CLAUDE_CODE_EFFORT_LEVEL"] == "high"
    assert plan["env"]["CLAUDE_CODE_DISABLE_ADVISOR_TOOL"] == "1"
    assert not Path(plan["repos"][0]["worktree"]).exists()  # dry run has no side effects


def test_worktree_preserves_uncommitted_source_changes(coord):
    src = make_repo(coord.tmp / "repo")
    (src / "a.txt").write_text("user edit\n")
    (src / "notes.txt").write_text("untracked\n")
    run(coord, "repo", "add", "r", str(src))
    run(coord, "task", "add", "--title", "x", "--repo", "r")
    reg = coord.load_registry()
    plan = coord.plan_repos(reg, reg["tasks"]["t001-x"], coord.load_policy())
    coord.ensure_worktree(plan[0])
    coord.ensure_worktree(plan[0])  # idempotent
    wt = Path(plan[0]["worktree"])
    assert (wt / "a.txt").read_text() == "one\n"
    assert not (wt / "notes.txt").exists()
    assert (src / "a.txt").read_text() == "user edit\n" and (src / "notes.txt").exists()
    assert len(plan[0]["source_dirty"]) == 2


def test_overlap_detection_and_worker_guard(coord, monkeypatch):
    run(coord, "repo", "add", "m", str(make_repo(coord.tmp / "mono")), "--kind", "monorepo")
    assert coord.load_registry()["repos"]["m"]["shared_paths"] == ["uv.lock"]
    run(coord, "task", "add", "--title", "a", "--repo", "m", "--paths", "packages/a")
    run(coord, "task", "add", "--title", "b", "--repo", "m", "--paths", "packages/b")
    run(coord, "task", "add", "--title", "c", "--repo", "m", "--paths", "packages/a/sub")
    with coord.registry_edit() as reg:
        coord.set_state(reg["tasks"]["t001-a"], "running")
    reg = coord.load_registry()
    assert coord.check_conflicts(reg, reg["tasks"]["t002-b"], {}) == []
    assert coord.check_conflicts(reg, reg["tasks"]["t003-c"], {})
    monkeypatch.setenv("COORD_ROLE", "worker")
    assert coord.main(["launch", "t002"]) == 1


def test_cli_runs_with_system_python():
    out = subprocess.run([sys.executable, str(ROOT / "bin" / "coord"), "--help"], capture_output=True, text=True,
                         env={**os.environ, "COORD_HOME": "/nonexistent"})
    assert out.returncode == 0 and "relaunch" in out.stdout



def test_idle_before_kickoff_is_not_a_completion(coord):
    add_running_task(coord)
    with coord.registry_edit() as reg:
        reg["tasks"]["t001-demo"]["worker"].pop("prompted", None)
    w = coord.Watcher()
    coord.set_herdr([agent("w1:p9", "blocked", 1)])  # e.g. trust dialog at startup
    w.reconcile()
    coord.set_herdr([agent("w1:p9", "idle", 2)])
    w.reconcile()
    w.reconcile()
    assert [e["kind"] for e in inbox(coord)] == ["blocked_dialog"]


def test_ids_cannot_escape_coord_home(coord):
    run(coord, "repo", "add", "r", str(make_repo(coord.tmp / "repo")))
    assert coord.main(["task", "add", "--title", "a", "--repo", "r", "--id", "../../escaped"]) == 1
    assert coord.main(["repo", "add", "../x", str(coord.tmp / "repo")]) == 1
    assert coord.main(["initiative", "add", "a/b", "--title", "t"]) == 1
    assert not (coord.HOME.parent.parent / "escaped").exists()


def test_worker_cannot_report_for_another_task(coord, monkeypatch):
    tid = add_running_task(coord)
    run(coord, "task", "add", "--title", "victim", "--repo", "r")
    monkeypatch.setenv("COORD_ROLE", "worker")
    monkeypatch.setenv("COORD_TASK_ID", tid)
    assert coord.main(["report", "--task", "t002-victim", "--state", "ready_for_review", "--summary", "x"]) == 1
    assert coord.read_report("t002-victim") is None
    run(coord, "report", "--state", "running", "--summary", "own task ok")


def test_watcher_ids_never_fall_below_inbox(coord):
    coord.append_line(coord.HOME / "inbox.jsonl", {"id": 7, "task": "x", "kind": "k", "text": "", "ts": "t"})
    coord.atomic_write(coord.HOME / "inbox.cursor", "7")
    add_running_task(coord)
    coord.set_herdr([agent("w1:p9", "blocked", 1)])
    coord.Watcher().reconcile()  # no watcher-state.json existed
    assert [e["id"] for e in coord.unread_inbox()] == [8]


def test_worker_deny_list_in_launch_command(coord, capsys):
    run(coord, "repo", "add", "r", str(make_repo(coord.tmp / "repo")))
    run(coord, "task", "add", "--title", "x", "--repo", "r")
    capsys.readouterr()
    run(coord, "launch", "t001", "--dry-run")
    cmd = json.loads(capsys.readouterr().out)["command"]
    deny = cmd[cmd.index("--disallowedTools") + 1]
    assert "Bash(coord launch *)" in deny and "Bash(herdr *)" in deny and "registry.json" in deny
