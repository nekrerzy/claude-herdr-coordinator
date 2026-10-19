// Judges a shell command against RULES: parse, unwrap, match, check.

import {
  AKS_CONTEXT,
  AKS_TEXT,
  ATTRIBUTION_MARKERS,
  LOCAL_CONTEXT,
  MAKE_TARGETS,
  OFFLINE_SUBCOMMANDS,
  RULES,
  VALUE_OPTIONS,
} from './rules'
import type { CheckName, Rule } from './rules'
import { joinPath, parse } from './shell'
import type { Cmd } from './shell'

/** What the checks may read; every read may reject (treated as "unknown"). */
export type GuardIO = {
  readFile: (path: string) => Promise<string>
  home: () => Promise<string | undefined>
  kubeconfigEnv: () => Promise<string | undefined>
}

export type Verdict = { rule: Rule; command: string } | undefined

/** The first rule the script breaks, or undefined when it may run. */
export async function judge(script: string, io: GuardIO): Promise<Verdict> {
  for (const cmd of commandsOf(script)) {
    const program = basename(cmd.argv[0] ?? '')
    for (const rule of RULES) {
      if (!rule.commands.includes(program)) continue
      if (rule.sub && !rule.sub.some(path => startsWith(positionals(cmd.argv, program), path))) continue
      if (rule.check && !(await CHECKS[rule.check](cmd, { io, script }))) continue
      return { rule, command: cmd.raw }
    }
  }
  return undefined
}

/** Every simple command of the script with wrappers unwrapped, nested ones included. */
export function commandsOf(script: string, depth = 0): Cmd[] {
  const out: Cmd[] = []
  for (const cmd of parse(script)) {
    for (const c of unwrap(cmd)) {
      out.push(c)
      const shellArg = shellScript(c.argv)
      if (shellArg !== undefined && depth < 4) out.push(...commandsOf(shellArg, depth + 1))
    }
  }
  return out
}

const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'],
  doas: ['-u', '-C'],
  nohup: [],
  command: [],
  builtin: [],
  exec: ['-a'],
  time: [],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '-P', '-u'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  xargs: ['-I', '-i', '-d', '-E', '-e', '-L', '-l', '-n', '-P', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs'],
  watch: ['-n', '--interval', '-d'],
  flock: ['-w', '--timeout', '-E', '--conflict-exit-code'],
  'run-parts': [],
}

/** The command a wrapper runs (env, sudo, timeout 5, xargs -n1, ...), recursively. */
function unwrap(cmd: Cmd): Cmd[] {
  const program = basename(cmd.argv[0] ?? '')
  const valueOpts = WRAPPER_VALUE_OPTIONS[program]
  if (valueOpts === undefined) return [cmd]
  // `command -v git` only looks the name up
  if (program === 'command' && cmd.argv.some(a => a === '-v' || a === '-V')) return [cmd]
  const assigns = [...cmd.assigns]
  let i = 1
  while (i < cmd.argv.length) {
    const a = cmd.argv[i] as string
    if (a === '--') {
      i++
      break
    }
    if (a.startsWith('-') && a.length > 1) {
      i += valueOpts.includes(a) ? 2 : 1
      continue
    }
    if (program === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      assigns.push(a)
      i++
      continue
    }
    break
  }
  if (program === 'timeout' && i < cmd.argv.length) i++ // the duration
  if (program === 'flock' && i < cmd.argv.length) i++ // the lock file
  const argv = cmd.argv.slice(i)
  if (argv.length === 0) return [cmd]
  return unwrap({ ...cmd, argv, assigns })
}

/** The script of `bash -c '...'` / `sh -lc ...` / `eval ...`, if this is one. */
function shellScript(argv: readonly string[]): string | undefined {
  const program = basename(argv[0] ?? '')
  if (program === 'eval') return argv.slice(1).join(' ')
  if (!['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(program)) return undefined
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string
    if (!a.startsWith('-')) return undefined
    if (/^-[a-z]*c[a-z]*$/.test(a)) return argv[i + 1]
  }
  return undefined
}

/** The non-option words after the program, skipping each option's value. */
export function positionals(argv: readonly string[], program: string): string[] {
  const valueOpts = VALUE_OPTIONS[program] ?? []
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      out.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valueOpts.includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

function startsWith(words: readonly string[], path: readonly string[]): boolean {
  return path.every((p, i) => words[i] === p)
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/** The value of `--name value` or `--name=value`, the last one given. */
function optionValue(argv: readonly string[], names: readonly string[]): string | undefined {
  let value: string | undefined
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string
    for (const n of names) {
      if (a === n) value = argv[i + 1]
      else if (a.startsWith(`${n}=`)) value = a.slice(n.length + 1)
    }
  }
  return value
}

type CheckContext = { io: GuardIO; script: string }

const CHECKS: Record<CheckName, (cmd: Cmd, ctx: CheckContext) => Promise<boolean>> = {
  makeTarget: async cmd => positionals(cmd.argv, 'make').some(t => MAKE_TARGETS.includes(t)),
  kubeAks,
  commitTrailers,
  gitDiscard: async cmd => {
    const words = positionals(cmd.argv, 'git')
    const sub = words[0]
    const args = cmd.argv.slice(cmd.argv.indexOf(sub as string) + 1)
    const has = (...names: string[]) => args.some(a => names.includes(a))
    const short = (flag: string) => args.some(a => /^-[a-zA-Z]+$/.test(a) && a.includes(flag))
    const dotPath = words.slice(1).some(w => w === '.' || w === './' || w === ':/')
    if (sub === 'reset') return has('--hard')
    if (sub === 'clean') return (has('--force') || short('f')) && !(has('--dry-run') || short('n'))
    if (sub === 'checkout') return dotPath
    if (sub === 'restore') return dotPath && (!(has('--staged') || short('S')) || has('--worktree') || short('W'))
    return false
  },
}

async function kubeAks(cmd: Cmd, { io, script }: CheckContext): Promise<boolean> {
  const program = basename(cmd.argv[0] ?? '')
  const words = [...cmd.assigns, ...cmd.argv]
  if (words.some(w => AKS_TEXT.some(t => w.includes(t)))) return true
  const context = optionValue(cmd.argv, ['--context', '--kube-context'])
  if (context !== undefined) return isAks(context)
  const sub = positionals(cmd.argv, program)[0]
  if (sub !== undefined && (OFFLINE_SUBCOMMANDS[program] ?? []).includes(sub)) return false
  if (program === 'kubectl' && sub === 'version' && cmd.argv.includes('--client')) return false
  // No explicit context: the kubeconfig's current-context decides.
  const explicit =
    optionValue(cmd.argv, ['--kubeconfig']) ??
    [...cmd.assigns].reverse().find(a => a.startsWith('KUBECONFIG='))?.slice('KUBECONFIG='.length) ??
    exportedKubeconfig(script)
  const home = await io.home().catch(() => undefined)
  const files = (explicit ?? (await io.kubeconfigEnv().catch(() => undefined)) ?? '~/.kube/config')
    .split(':')
    .filter(f => f !== '')
  for (const file of files) {
    const text = await io.readFile(expand(file, home, cmd.cwd)).catch(() => undefined)
    const current = text?.match(/^current-context:\s*["']?([^"'\s#]+)/m)?.[1]
    if (current !== undefined) return isAks(current)
  }
  return false
}

/** The last `export KUBECONFIG=<file>` in the script (the Bash tool keeps no env between calls). */
function exportedKubeconfig(script: string): string | undefined {
  let found: string | undefined
  for (const c of parse(script)) {
    if (c.argv[0] !== 'export') continue
    for (const a of c.argv.slice(1)) if (a.startsWith('KUBECONFIG=')) found = a.slice('KUBECONFIG='.length)
  }
  return found
}

function isAks(context: string): boolean {
  return AKS_CONTEXT.test(context) && !LOCAL_CONTEXT.test(context)
}

function expand(path: string, home: string | undefined, cwd: string): string {
  if (path === '~' || path.startsWith('~/')) return home ? home + path.slice(1) : path
  return joinPath(cwd, path)
}

/** True when the commit's new message (or a trailer it adds) carries attribution. */
async function commitTrailers(cmd: Cmd, { io, script }: CheckContext): Promise<boolean> {
  const texts: string[] = []
  const files: string[] = []
  const commitAt = cmd.argv.indexOf('commit')
  const gitDir = optionValue(cmd.argv.slice(0, commitAt), ['-C'])
  const args = cmd.argv.slice(commitAt + 1)
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    const next = () => args[++i] ?? ''
    if (a === '--') break
    if (a === '-m' || a === '--message' || a === '--trailer') texts.push(next())
    else if (a.startsWith('--message=') || a.startsWith('--trailer=')) texts.push(a.slice(a.indexOf('=') + 1))
    else if (a === '-F' || a === '--file') files.push(next())
    else if (a.startsWith('--file=')) files.push(a.slice('--file='.length))
    else if (/^-[a-zA-Z]/.test(a) && !a.startsWith('--')) {
      // a cluster of short options: -am "msg", -mmsg, -Fmsg.txt, -c <commit>
      for (let j = 1; j < a.length; j++) {
        const flag = a[j]
        if (flag === 'm' || flag === 'F' || flag === 'c' || flag === 'C' || flag === 't') {
          const value = j + 1 < a.length ? a.slice(j + 1) : next()
          if (flag === 'm') texts.push(value)
          if (flag === 'F') files.push(value)
          break
        }
        if (flag === 'S' || flag === 'u') break // optional attached argument
      }
    }
  }
  let unknown = false
  const home = await io.home().catch(() => undefined)
  for (const f of files) {
    if (f === '-' || f === '/dev/stdin') {
      texts.push(...cmd.stdin)
      if (cmd.pipedFrom !== undefined) texts.push(cmd.pipedFrom)
      continue
    }
    const base = gitDir === undefined ? cmd.cwd : joinPath(cmd.cwd, gitDir)
    const text = await io.readFile(expand(f, home, base)).catch(() => undefined)
    if (text === undefined) unknown = true
    else texts.push(text)
  }
  // A message file this script writes first cannot be read yet: judge the script's own text.
  if (unknown) texts.push(script)
  return texts.some(hasAttribution)
}

export function hasAttribution(text: string): boolean {
  const lower = text.toLowerCase()
  return ATTRIBUTION_MARKERS.some(m => lower.includes(m.toLowerCase()))
}
