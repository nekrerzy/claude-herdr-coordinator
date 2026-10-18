# <repo>: access rules for workers (example)

Repo notes are extra instructions coord adds to every brief that touches a repository. Use them for rules
that are not in the repo's own CLAUDE.md or AGENTS.md, typically access limits on your machine.
They are personal: keep them in `$COORD_HOME/repo-notes/` (default `~/.local/share/coord/repo-notes/`),
never in the toolkit repo. Attach one when registering the repo:

    mkdir -p ~/.local/share/coord/repo-notes
    cp examples/repo-notes.example.md ~/.local/share/coord/repo-notes/<repo>.md   # then edit it
    coord repo add <repo> ~/src/<repo> --instructions ~/.local/share/coord/repo-notes/<repo>.md

Example content for a repo whose cloud environment is reachable only from another machine:

---

<repo> deploys to a private cloud environment. Only <the machine or network that has access> can reach the
cloud account, the cluster, the Terraform state and the Git remote.

- Do not run anything that needs that access: cloud CLIs, `kubectl` or `helm` against a cluster,
  `terraform plan/apply` with a remote backend, or `git fetch/pull/push`.
- Offline work is fine: formatting, validation, linting, unit tests, `terraform init -backend=false`,
  reading code and docs.
- When the task needs live data or a live check, write the exact commands for the user to run where the
  access is (read-only first, the purpose of each, what output to send back) in the result file, then report
  `blocked` or `ready_for_review` as fits. Never guess at live state.
