# Andromeda (GCP): live access rules

`gcloud` works from this machine with the user's credentials. The login expires every so often and only the user can renew it.

- Read-only `gcloud` / `kubectl get|describe` / `terraform plan` are allowed when the task needs live data. Both projects are production-grade: treat them as production.
- Never run mutating commands (`terraform apply/destroy/import/state`, `gcloud ... create|update|delete|deploy`, `kubectl apply|delete|patch`). Write them in the result file for the user to review and run.
- On an auth error (expired token, reauth required), stop: report `blocked` with "gcloud auth needs renewal" and the command that failed. Do not try to log in.
- No `git fetch/pull/push` or `gh` writes: the user does those.

Kubeconfig
- The contexts (also listed by `kubectx`) may be out of date, and no current-context is set. Always pass `--context <name>` (and `-n <ns>`) explicitly. Never switch with `kubectx <name>`, `kubens <ns>` or `kubectl config use-context`: they rewrite the shared ~/.kube/config, which every worker and the user use. Listing with plain `kubectx` is fine.
- Before trusting a context, check that its cluster still exists (`gcloud container clusters list --project <project>`). If a context is missing or points at a cluster that is gone, report it with the `gcloud container clusters get-credentials ...` command that would fix it; don't rewrite the kubeconfig yourself.
