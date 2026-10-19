import { describe, expect, mock, test } from 'claude-code/testing'

import { judge } from '../hooks/guard'
import type { GuardIO } from '../hooks/guard'
import { parse } from '../hooks/shell'

const FILES: Record<string, string> = {
  'msg-bad.txt': 'fix: thing\n\nCo-Authored-By: Bot <bot@example.com>\n',
  'msg-ok.txt': 'fix: thing\n\nplain body\n',
  'repo/msg-bad.txt': 'x\n\nClaude-Session: https://example.invalid/s\n',
  '/home/u/.kube/config': 'apiVersion: v1\ncurrent-context: aks-bap-dev-eus2\n',
  'lab/kubeconfig': 'apiVersion: v1\ncurrent-context: kind-auth-lab\n',
}

function io(files: Record<string, string> = FILES, kubeconfigEnv?: string): GuardIO {
  return {
    readFile: async path => {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    home: async () => '/home/u',
    kubeconfigEnv: async () => kubeconfigEnv,
  }
}

async function ruleOf(command: string, files?: Record<string, string>): Promise<string | undefined> {
  return (await judge(command, io(files)))?.rule.id
}

const BLOCKED: [string, string][] = [
  ['git push', 'git-push'],
  ['git push --force origin main', 'git-push'],
  ['git -C /repo push', 'git-push'],
  ['cd /repo && git push -u origin feat', 'git-push'],
  ['env GIT_SSH_COMMAND=ssh git push', 'git-push'],
  ['FOO=1 /usr/bin/git push', 'git-push'],
  ['git status; git push', 'git-push'],
  ['(cd x && git push)', 'git-push'],
  ['echo "$(git push)"', 'git-push'],
  ['bash -c "git push origin"', 'git-push'],
  ['timeout 30 git push', 'git-push'],
  ['sudo -u me git push', 'git-push'],
  ['xargs -n1 git push < remotes', 'git-push'],
  ['if true; then git push; fi', 'git-push'],
  ['{ git push; }', 'git-push'],
  ['ls\ngit push', 'git-push'],
  ['echo `gh auth status`', 'gh'],
  ['nohup gh run list &', 'gh'],
  ['gh pr create --fill', 'gh'],
  ['ls | gh api /user', 'gh'],
  ['az account show', 'az'],
  ['terraform apply -auto-approve', 'terraform'],
  ['terraform -chdir=infra destroy', 'terraform'],
  ['terraform import a.b id', 'terraform'],
  ['terraform state rm a.b', 'terraform'],
  ['terraform state mv a b', 'terraform'],
  ['make apply', 'make-apply'],
  ['make -C infra apply', 'make-apply'],
  ['kubectl --context aks-bap-dev-eus2 get pods', 'kube-aks'],
  ['kubectl get pods --context=my-aks', 'kube-aks'],
  ['helm --kube-context aks-dev upgrade x ./chart', 'kube-aks'],
  ['kubectl -n bap get pods', 'kube-aks'], // current-context in ~/.kube/config is AKS
  ['helm status x -n aks-bap', 'kube-aks'],
  ['git commit -m "fix" -m "Co-Authored-By: Bot <b@x>"', 'commit-trailers'],
  ['git commit -am "fix\n\nclaude-session: abc"', 'commit-trailers'],
  ['git commit --trailer "Co-authored-by: Bot <b@x>" -m fix', 'commit-trailers'],
  ['git commit --amend -m "x\n\nGenerated with [Claude Code](https://claude.com/claude-code)"', 'commit-trailers'],
  ['git commit -F msg-bad.txt', 'commit-trailers'],
  ['git -C repo commit -F msg-bad.txt', 'commit-trailers'],
  ["git commit -m \"$(cat <<'EOF'\nfix: x\n\nCo-Authored-By: Bot <b@x>\nEOF\n)\"", 'commit-trailers'],
  ["git commit -F - <<'EOF'\nfix\n\nCo-Authored-By: Bot <b@x>\nEOF", 'commit-trailers'],
  ["cat > /tmp/m <<'EOF'\nfix\nCo-Authored-By: Bot\nEOF\ngit commit -F /tmp/m", 'commit-trailers'],
  ["printf 'x\\n\\nCo-Authored-By: y' | git commit -F -", 'commit-trailers'],
  ['git commit -m "$(printf \'x\\nClaude-Session: y\')"', 'commit-trailers'],
  ['git reset --hard', 'git-discard'],
  ['git reset --hard origin/main', 'git-discard'],
  ['git clean -fdx', 'git-discard'],
  ['git clean --force', 'git-discard'],
  ['git checkout -- .', 'git-discard'],
  ['git checkout .', 'git-discard'],
  ['git restore .', 'git-discard'],
  ['git restore --staged --worktree .', 'git-discard'],
]

const ALLOWED: string[] = [
  'git commit -m "docs: never run git push here"',
  "git commit -m 'gh and az are for the user'",
  'git log --grep push',
  'git log -S "git push" --oneline',
  "echo 'kubectl --context aks-bap-dev get pods'",
  'git commit -m "Co-Authored-By is banned here"',
  'git log --oneline origin/main..HEAD',
  'git status && git diff --stat',
  'git commit -m "fix"',
  'git commit',
  'git commit --amend --no-edit',
  'git commit -F msg-ok.txt',
  'git commit -F missing.txt',
  'echo "git push" | grep push',
  'grep -rn "gh pr" docs/',
  'kubectl kustomize deploy/overlays/dev',
  'helm template x ./chart',
  'kubectl --context kind-auth-lab get pods',
  'KUBECONFIG=lab/kubeconfig kubectl get pods',
  'kubectl --kubeconfig lab/kubeconfig get pods',
  'export KUBECONFIG=lab/kubeconfig && kubectl apply -f x.yaml',
  'kubectl version --client',
  'kubectl config get-contexts',
  'make test',
  'terraform plan',
  'terraform validate && terraform fmt -check',
  'git reset HEAD file.txt',
  'git clean -n',
  'git clean -fdn',
  'git checkout main',
  'git checkout -- src/one.py',
  'git restore --staged .',
  'command -v gh',
  'coord status --json',
  'ls -la; cat README.md',
  "cat <<'EOF'\ngit push\ngh pr create\nEOF",
  '# git push\nls',
]

describe('deny rules', () => {
  for (const [command, rule] of BLOCKED) {
    test(`blocks ${JSON.stringify(command)} as ${rule}`, async () => {
      expect(await ruleOf(command)).toBe(rule)
    })
  }
  for (const command of ALLOWED) {
    test(`allows ${JSON.stringify(command)}`, async () => {
      expect(await ruleOf(command)).toBe(undefined)
    })
  }
  test('no kubeconfig anywhere: plain kubectl is allowed', async () => {
    expect(await ruleOf('kubectl get pods', {})).toBe(undefined)
  })
  test('KUBECONFIG from the environment decides the context', async () => {
    expect((await judge('kubectl get pods', io(FILES, 'lab/kubeconfig')))?.rule.id).toBe(undefined)
  })
})

describe('tokenizer', () => {
  test('splits on operators and keeps quoted words whole', () => {
    const cmds = parse('cd a && git commit -m "x; y" | tee out 2>&1; echo $(date)')
    expect(cmds.map(c => c.argv)).toEqual([
      ['cd', 'a'],
      ['git', 'commit', '-m', 'x; y'],
      ['tee', 'out'],
      ['date'],
      ['echo', '$(date)'],
    ])
    expect(cmds[1]?.cwd).toBe('a')
    expect(cmds[2]?.pipedFrom).toBe('git commit -m "x; y"')
  })
  test('heredoc bodies are stdin, not commands', () => {
    const cmds = parse("cat <<-EOF > f\n\tgit push\n\tEOF\nls")
    expect(cmds.map(c => c.argv)).toEqual([['cat'], ['ls']])
    expect(cmds[0]?.stdin).toEqual(['\tgit push'])
  })
})

describe('through the Bash tool', () => {
  test('a denied call never reaches the tool and says what to do', async ($, on) => {
    mock.env(on, { HOME: '/home/u' })
    let ran = 0
    on('tool.call', { tool: 'Bash' }, () => {
      ran++
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })
    const denied = await $.tool.call({ tool: 'Bash', command: 'git -C /repo push origin HEAD' })
    expect(denied.deny).toContain('The user pushes (SSH passphrase). Hand them the exact push command.')
    expect(ran).toBe(0)
    await $.tool.call({ tool: 'Bash', command: 'git log --grep push' })
    expect(ran).toBe(1)
  })
  test('the trailer check reads a -F file through $.fs', async ($, on) => {
    mock.env(on, { HOME: '/home/u' })
    on('fs.read', () => ({ value: 'subject\n\nCo-Authored-By: Bot <b@x>\n' }))
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    const denied = await $.tool.call({ tool: 'Bash', command: 'git commit -F .git/MSG' })
    expect(denied.deny).toContain('Commits carry no AI attribution trailers or links (user rule).')
  })
  test('the Monitor tool is guarded too', async ($, on) => {
    mock.env(on, {})
    on('tool.call', { tool: 'Monitor' }, () => ({ result: {} as never }))
    const denied = await $.tool.call({ tool: 'Monitor', description: 'x', timeout_ms: 1000, command: 'gh run watch' })
    expect(denied.deny).toContain('gh only works from the user')
  })
})
