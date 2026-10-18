# BAP: working without Azure or GitHub access

BAP runs in a private Azure environment. Only the user's assigned laptop on the VPN can reach Azure, the cluster, the Terraform state, and GitHub (`gh`).

- Do not run anything that needs that access: `az`, `kubectl`, `kubelogin`, `helm` against a cluster, `make plan/apply/destroy`, `terraform init` with a backend, `gh`, or `git fetch/pull/push`.
- Offline work is fine: `make fmt-check validate lint`, mocked `terraform test` (`init -backend=false`), `platform-services/scripts/render.sh`, reading code and docs.
- When the task needs live data or a live check, write the exact commands for the user to run on the laptop (read-only first, purpose of each, what output to send back) in the result file, then report `blocked` or `ready_for_review` as fits. Never guess at live state.
