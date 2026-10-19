// The guardrail rules: the one place to edit what coord-ui blocks.
//
// A rule matches a simple command (after wrappers such as `env`, `sudo`,
// `timeout`, `xargs`, `bash -c` are unwrapped) whose program is one of
// `commands`, and, when `sub` is given, whose leading positional arguments
// (options skipped, see VALUE_OPTIONS) start with one of the listed paths.
// `check` names an extra test in guard.ts that must also hold. The first rule
// that matches denies the call with its `reason`, which the model reads.

export type CheckName = 'kubeAks' | 'commitTrailers' | 'gitDiscard' | 'makeTarget'

export type Rule = {
  id: string
  reason: string
  commands: readonly string[]
  sub?: readonly (readonly string[])[]
  check?: CheckName
}

const LIVE = 'Live Azure/Terraform changes are shown to the user, never run.'

export const RULES: readonly Rule[] = [
  {
    id: 'git-push',
    reason: 'The user pushes (SSH passphrase). Hand them the exact push command.',
    commands: ['git'],
    sub: [['push']],
  },
  {
    id: 'gh',
    reason: 'gh only works from the user\'s laptop. Hand them the command.',
    commands: ['gh'],
  },
  { id: 'az', reason: LIVE, commands: ['az'] },
  {
    id: 'terraform',
    reason: LIVE,
    commands: ['terraform'],
    sub: [['apply'], ['destroy'], ['import'], ['state', 'rm'], ['state', 'mv']],
  },
  { id: 'make-apply', reason: LIVE, commands: ['make'], check: 'makeTarget' },
  {
    id: 'kube-aks',
    reason:
      'kubectl/helm against AKS is shown to the user, never run. Use a kind-* context or an explicit lab --kubeconfig, or hand them the command.',
    commands: ['kubectl', 'helm'],
    check: 'kubeAks',
  },
  {
    id: 'commit-trailers',
    reason:
      'Commits carry no AI attribution trailers or links (user rule). Remove the Co-Authored-By/Claude-Session/Generated-with lines and commit again.',
    commands: ['git'],
    sub: [['commit']],
    check: 'commitTrailers',
  },
  {
    id: 'git-discard',
    reason:
      "Discarding uncommitted work needs the user's explicit confirmation first; ask, then they can run it with !",
    commands: ['git'],
    sub: [['reset'], ['clean'], ['checkout'], ['restore']],
    check: 'gitDiscard',
  },
]

/** Text that marks AI attribution in a commit message (matched case-insensitively). */
export const ATTRIBUTION_MARKERS: readonly string[] = [
  'Co-Authored-By:',
  'Claude-Session:',
  'Generated with [Claude Code]',
  'claude.com/claude-code',
]

/** `make` targets that change live infrastructure. */
export const MAKE_TARGETS: readonly string[] = ['apply']

/** A kube context naming AKS, and the kind contexts that are always local. */
export const AKS_CONTEXT = /aks/i
export const LOCAL_CONTEXT = /^kind-/
/** Text anywhere in a kubectl/helm command that means AKS. */
export const AKS_TEXT: readonly string[] = ['aks-bap']

/** Subcommands that render or inspect offline and never reach a cluster. */
export const OFFLINE_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  kubectl: ['kustomize', 'completion', 'plugin', 'config'],
  helm: [
    'template', 'lint', 'package', 'show', 'inspect', 'dependency', 'dep', 'repo',
    'search', 'version', 'completion', 'create', 'env', 'plugin', 'pull', 'verify',
  ],
}

/** Per program, the options that take the next word as their value. */
export const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'],
  make: ['-C', '-f', '-I', '-o', '-W', '--directory', '--file', '--makefile', '--include-dir'],
  kubectl: [
    '--context', '--kubeconfig', '-n', '--namespace', '--cluster', '--user', '-s', '--server',
    '--token', '--as', '--as-group', '--request-timeout', '--cache-dir',
  ],
  helm: [
    '--kube-context', '--kubeconfig', '-n', '--namespace', '--kube-apiserver', '--kube-token',
    '--kube-as-user', '--kube-as-group', '--registry-config', '--repository-cache',
    '--repository-config', '--burst-limit',
  ],
}
