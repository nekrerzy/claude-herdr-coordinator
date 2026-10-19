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
elif args == ["--version"]:
    print("herdr 0.9.1")
elif args[:2] == ["notification", "show"]:
    print(json.dumps({"result": {"shown": False}}))
else:
    err("unsupported_in_fake")
"""


def load_coord():
    loader = importlib.machinery.SourceFileLoader("coord_mod", str(ROOT / "bin" / "coord"))
    spec = importlib.util.spec_from_loader("coord_mod", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture
def coord(tmp_path, monkeypatch):
    mod = load_coord()
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
    atomic(
        home / "policy.json",
        json.dumps(
            {
                "watch": {"poll_seconds": 1, "idle_confirm_seconds": 0, "toast": False},
                "worktree_root": str(tmp_path / "worktrees"),
            }
        ),
    )

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
    subprocess.run(
        ["git", "-C", str(path), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], check=True
    )
    return path


def run(coord, *argv):
    assert coord.main(list(argv)) == 0


def add_running_task(coord, title="demo", pane="w1:p9", session="s-1"):
    run(coord, "repo", "add", "r", str(make_repo(coord.tmp / f"repo-{title}")))
    run(coord, "task", "add", "--title", title, "--repo", "r")
    with coord.registry_edit() as reg:
        tid = next(iter(t for t in reg["tasks"] if title in t))
        task = reg["tasks"][tid]
        task["worker"] = {
            "agent_name": "w001",
            "pane_id": pane,
            "session_id": session,
            "launched": "x",
            "status": "prompted",
            "prompted": "x",
            "model": task["model"],
            "effort": task["effort"],
        }
        coord.set_state(task, "running")
    return tid


def agent(pane, status, seq, session="s-1"):
    return {
        "pane_id": pane,
        "agent": "claude",
        "agent_status": status,
        "state_change_seq": seq,
        "agent_session": {"value": session},
    }


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
        "tier": "exceptional",
        "model": "claude-fable-5-1",
        "effort": "high",
        "source": "tier:exceptional",
    }
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
    out = subprocess.run(
        [sys.executable, str(ROOT / "bin" / "coord"), "--help"],
        capture_output=True,
        text=True,
        env={**os.environ, "COORD_HOME": "/nonexistent"},
    )
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
    assert cmd[cmd.index("--plugin-dir") + 1] == str(ROOT / "plugins" / "coord-ui")


def test_coordinator_launcher_loads_mod_and_sets_role(tmp_path):
    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    (fakebin / "claude").write_text('#!/bin/sh\necho "role=$COORD_ROLE"\nprintf "%s\\n" "$@"\n')
    (fakebin / "claude").chmod(0o755)
    env = {**os.environ, "HERDR_ENV": "1", "PATH": f"{fakebin}:{os.environ['PATH']}"}
    out = subprocess.run(
        [str(ROOT / "bin" / "coord-coordinator"), "--continue"], capture_output=True, text=True, env=env
    )
    lines = out.stdout.splitlines()
    assert out.returncode == 0 and lines[0] == "role=coordinator"
    assert lines[lines.index("--plugin-dir") + 1] == str(ROOT / "plugins" / "coord-ui")
    assert lines[-1] == "--continue"


def make_fakebin(path: Path, claude="2.1.302 (Claude Code)", herdr="herdr 0.9.1", uv="uv 0.12.5") -> Path:
    path.mkdir()
    for name, version in (("claude", claude), ("herdr", herdr), ("uv", uv)):
        if version:
            (path / name).write_text(f"#!/bin/sh\necho '{version}'\n")
            (path / name).chmod(0o755)
    return path


def test_moved_repo_notes_resolve_and_resume_migrates(coord, monkeypatch, capsys):
    repo = make_repo(coord.tmp / "repo")
    kept = coord.tmp / "kept-notes" / "repo-notes" / "kept.md"
    kept.parent.mkdir(parents=True)
    kept.write_text("still here\n")
    old = coord.tmp / "old-clone" / "repo-notes" / "secret.md"  # pre-portable path; the file is gone
    (coord.HOME / "repo-notes").mkdir()
    (coord.HOME / "repo-notes" / "secret.md").write_text("rules\n")
    run(coord, "repo", "add", "r", str(repo), "--instructions", str(old), "--instructions", str(kept))
    run(coord, "task", "add", "--title", "x", "--repo", "r")
    reg = coord.load_registry()
    brief = coord.render_brief(reg, reg["tasks"]["t001-x"], coord.plan_repos(reg, reg["tasks"]["t001-x"], {}))
    assert str(coord.HOME / "repo-notes" / "secret.md") in brief and str(old) not in brief
    monkeypatch.setattr(coord, "watcher_pid", lambda: 4242)  # do not start a real watcher
    run(coord, "resume")
    assert "r: instructions ->" in capsys.readouterr().out
    instructions = coord.load_registry()["repos"]["r"]["instructions"]
    assert instructions[-2:] == [str(coord.HOME / "repo-notes" / "secret.md"), str(kept)]
    run(coord, "resume")  # idempotent
    assert "instructions ->" not in capsys.readouterr().out


def test_worktree_root_and_claude_dir_overrides(coord, monkeypatch, tmp_path):
    monkeypatch.delenv("COORD_WORKTREE_ROOT", raising=False)
    assert coord.worktree_root({"worktree_root": None}) == coord.HOME / "worktrees"
    assert coord.worktree_root({"worktree_root": "~/wt"}) == Path("~/wt").expanduser()
    monkeypatch.setenv("COORD_WORKTREE_ROOT", str(tmp_path / "env-wt"))
    assert coord.worktree_root({"worktree_root": "~/wt"}) == tmp_path / "env-wt"
    assert coord.DEFAULT_POLICY["worktree_root"] is None  # no user path baked into the default
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-cfg"))
    monkeypatch.setenv("COORD_HOME", str(tmp_path / "ch"))
    fresh = load_coord()
    assert fresh.CLAUDE_PROJECTS == tmp_path / "claude-cfg" / "projects"
    assert fresh.HOME == tmp_path / "ch"


def test_doctor_with_fakes(coord, monkeypatch, capsys):
    fakebin = make_fakebin(coord.tmp / "fakebin")
    git_dir = str(Path(subprocess.run(["which", "git"], capture_output=True, text=True).stdout.strip()).parent)
    monkeypatch.setenv("PATH", f"{fakebin}:{git_dir}")
    monkeypatch.setitem(coord.PREREQS, "herdr", ([coord.HERDR, "--version"], (0, 9, 1), "panes", True))
    sock = coord.tmp / "herdr.sock"
    sock.touch()
    monkeypatch.setenv("HERDR_SOCKET_PATH", str(sock))
    run(coord, "repo", "add", "good", str(make_repo(coord.tmp / "good")))
    gone = make_repo(coord.tmp / "gone")
    run(coord, "repo", "add", "gone", str(gone))
    subprocess.run(["rm", "-rf", str(gone)], check=True)
    capsys.readouterr()
    assert coord.main(["doctor"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  repo gone" in out and "ok    repo good" in out
    assert "ok    claude" in out and "ok    herdr" in out and "ok    herdr socket" in out
    assert "warn  watcher" in out and "ok    policy tier complex" in out
    with coord.registry_edit() as reg:
        del reg["repos"]["gone"]
    run(coord, "doctor")
    (fakebin / "claude").write_text("#!/bin/sh\necho '2.0.1 (Claude Code)'\n")
    coord.atomic_write(coord.HOME / "policy.json", json.dumps({"tiers": {"routine": {"model": "gpt-x"}}}))
    capsys.readouterr()
    assert coord.main(["doctor"]) == 1
    out = capsys.readouterr().out
    assert "FAIL  claude" in out and "older than 2.1.300" in out and "FAIL  policy tier routine" in out


def install_env(tmp_path: Path) -> dict:
    fakebin = tmp_path / "fakebin"
    if not fakebin.exists():
        make_fakebin(fakebin)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("COORD_", "HERDR_", "CLAUDE_CONFIG"))}
    env.update(HOME=str(tmp_path / "fakehome"), PATH=f"{fakebin}:{os.environ['PATH']}")
    return env


def install(tmp_path: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(ROOT / "scripts" / "install.sh"), *args], capture_output=True, text=True, env=install_env(tmp_path)
    )


def test_installer_dry_run_touches_nothing(tmp_path):
    (tmp_path / "fakehome").mkdir()
    out = install(tmp_path, "--dry-run")
    assert out.returncode == 0, out.stderr
    fakehome = tmp_path / "fakehome"
    assert f"would link {fakehome}/.local/bin/coord -> {ROOT}/bin/coord" in out.stdout
    assert "would create in COORD_HOME=" in out.stdout and "is not on PATH" in out.stdout
    assert list(fakehome.iterdir()) == []


def test_installer_is_idempotent_and_uninstall_keeps_state(tmp_path):
    fakehome = tmp_path / "fakehome"
    fakehome.mkdir()
    out = install(tmp_path, "--no-sync")
    assert out.returncode == 0, out.stdout + out.stderr
    link = fakehome / ".local" / "bin" / "coord"
    assert link.resolve() == (ROOT / "bin" / "coord").resolve()
    policy = fakehome / ".local" / "share" / "coord" / "policy.json"
    assert json.loads(policy.read_text())["max_active_workers"] == 3
    policy.write_text('{"max_active_workers": 1}\n')  # user edits survive a re-install
    out = install(tmp_path, "--no-sync")
    assert out.returncode == 0 and f"ok    {link}" in out.stdout and "already initialized" in out.stdout
    assert policy.read_text() == '{"max_active_workers": 1}\n'
    other = fakehome / ".local" / "bin" / "coord-coordinator"
    other.unlink()
    other.symlink_to(tmp_path / "another-clone")
    out = install(tmp_path, "--no-sync")
    assert out.returncode == 1 and "pass --force" in out.stderr
    assert install(tmp_path, "--no-sync", "--force").returncode == 0
    out = install(tmp_path, "--uninstall")
    assert out.returncode == 0 and not link.exists() and not other.is_symlink()
    assert policy.exists()  # state is never removed


def test_installer_refuses_missing_prerequisite(tmp_path):
    (tmp_path / "fakehome").mkdir()
    fakebin = make_fakebin(tmp_path / "fakebin", claude=None)
    env = install_env(tmp_path)
    env["PATH"] = f"{fakebin}:" + ":".join(
        d for d in os.environ["PATH"].split(":") if not (Path(d) / "claude").exists()
    )
    out = subprocess.run(
        ["bash", str(ROOT / "scripts" / "install.sh"), "--no-sync"], capture_output=True, text=True, env=env
    )
    assert out.returncode == 1 and "FAIL  claude" in out.stdout and "claude" in out.stderr
    assert not (tmp_path / "fakehome" / ".local").exists()
