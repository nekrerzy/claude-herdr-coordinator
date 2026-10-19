// coord-ui: guardrails for the coordinator and every worker, and for the
// coordinator a /workers pane and a status line fed by `coord status --json`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { WorkerSnapshot } from '../types'
import { judge } from './guard'
import { attention, liveMark, parseRows, recordedCoordinator, statusText, watcherState } from './workers'

const PANE = 'workers'
const PANE_MS = 5000
const STATUS_MS = 10000
const snapshot = atom({ plugin: 'coord-ui', key: 'snapshot' } as const, null)

type $ = EngineInterface

/**
 * COORD_ROLE decides when set (coord-coordinator sets `coordinator`, workers get `worker`).
 * Unset, as in a coordinator started some other way: this session is the one coord
 * recorded (`coord coordinator`) in $COORD_HOME/registry.json. A match is kept for the
 * module's life; a miss is asked again, since `coord coordinator` may run after start.
 */
async function isCoordinator($: $): Promise<boolean> {
  if ((await $.env.get('HERDR_ENV')) !== '1') return false
  const role = await $.env.get('COORD_ROLE')
  if (role !== undefined) return role === 'coordinator'
  isRecordedCoordinator ||= await isRecordedSession($)
  return isRecordedCoordinator
}

async function isRecordedSession($: $): Promise<boolean> {
  try {
    const home = await $.env.get('HOME')
    const coordHome = (await $.env.get('COORD_HOME')) ?? '~/.local/share/coord'
    const dir = coordHome === '~' || coordHome.startsWith('~/') ? `${home}${coordHome.slice(1)}` : coordHome
    const recorded = recordedCoordinator(await $.fs.read(`${dir}/registry.json`))
    return recorded !== undefined && recorded === (await $.session.id())
  } catch {
    return false
  }
}

/** Runs `coord status` (and, for the pane, `coord watch status`); never throws. */
async function refresh($: $, withWatcher: boolean): Promise<void> {
  let next: WorkerSnapshot
  try {
    const status = await $.process.run(['coord', 'status', '--json', '--no-sync'], { timeoutMs: 20000 })
    if (status.exitCode !== 0) {
      throw new Error(status.stderr.trim() || status.stdout.trim() || `coord status exited ${status.exitCode}`)
    }
    next = { rows: parseRows(status.stdout), at: await $.clock.now() }
    if (withWatcher) {
      const watch = await $.process.run(['coord', 'watch', 'status'], { timeoutMs: 10000 }).catch(() => undefined)
      next.watcher = watch ? watcherState(watch.stdout) : 'unknown'
    }
  } catch (err) {
    next = { rows: [], error: err instanceof Error ? err.message : String(err), at: Date.now() }
  }
  $.ui.status(next.error === undefined ? statusText(next.rows) : undefined)
  await update($, snapshot, () => next)
}

// Module state: a hot reload drops it with the timers; the next prompt re-arms them.
let isRegistered = false
let isRecordedCoordinator = false
let statusTimer: Timer | undefined
let paneTimer: Timer | undefined
let busy = false

function tick($: $, withWatcher: boolean): void {
  if (busy) return
  busy = true
  void refresh($, withWatcher).finally(() => {
    busy = false
  })
}

async function isPaneOpen($: $): Promise<boolean> {
  return (await $.ui.panes()).some(p => p.id === PANE)
}

/** Refreshes the pane every 5 s; the timer ends itself once the pane is closed. */
async function paneTick($: $): Promise<void> {
  if (await isPaneOpen($)) return tick($, true)
  paneTimer?.cancel()
  paneTimer = undefined
}

/** Coordinator only: registers /workers and starts the timers that are not running. */
async function arm($: $): Promise<void> {
  if (!(await isCoordinator($))) return
  if (!isRegistered) {
    await $.command.register({ name: 'workers', description: 'Show coord workers in a live pane' })
    isRegistered = true
  }
  statusTimer ??= $.clock.every(STATUS_MS, () => tick($, false))
  if (paneTimer === undefined && (await isPaneOpen($))) paneTimer = $.clock.every(PANE_MS, () => void paneTick($))
}

/** The deny text for a shell command the rules refuse, else undefined. */
async function guard($: $, command: string | undefined): Promise<string | undefined> {
  if (!command) return undefined
  const verdict = await judge(command, {
    readFile: path => $.fs.read(path),
    home: () => $.env.get('HOME'),
    kubeconfigEnv: () => $.env.get('KUBECONFIG'),
  })
  if (verdict === undefined) return undefined
  if (await isCoordinator($)) $.ui.toast(`coord-ui blocked ${verdict.rule.id}`)
  const shown = verdict.command.length > 120 ? `${verdict.command.slice(0, 117)}...` : verdict.command
  return `coord-ui blocked \`${shown}\` (${verdict.rule.id}): ${verdict.rule.reason}`
}

const FAILED = { deny: 'coord-ui: the command guard failed, so the call is refused. Simplify the command.' }

export const register: Register = on => {
  // ---------------------------------------------------------------- guardrails

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await guard($, e.command)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : FAILED))

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const deny = await guard($, e.command)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : FAILED))

  // ------------------------------------------------- coordinator: pane, status

  on('session.start', async ($, e, next) => {
    if (await isCoordinator($)) {
      await arm($)
      tick($, false)
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await arm($)
    return next(e)
  })

  on('command.run', { command: 'workers' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Workers' })
    await refresh($, true)
    paneTimer ??= $.clock.every(PANE_MS, () => void paneTick($))
    return { text: opened.isPlaced ? 'Workers pane opened.' : `Workers pane not shown: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const width = Math.max(20, e.props.bodyColumns)
    if (snap === null) return <Text dimColor>Reading coord status...</Text>
    const watcherOk = snap.watcher === undefined || snap.watcher === 'running'
    return (
      <Box flexDirection="column" width={width}>
        <Text color={watcherOk ? 'subtle' : 'warning'}>
          watcher: {snap.watcher ?? '?'}
          {watcherOk ? '' : ' (!) coord resume'}
        </Text>
        {snap.error !== undefined && <Text color="error">coord status failed: {snap.error}</Text>}
        {snap.error === undefined && snap.rows.length === 0 && <Text dimColor>no active tasks</Text>}
        {snap.rows.map(row => {
          const marks = attention(row)
          const flag = marks.length > 0
          return (
            <Box key={`row:${row.task}`} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={flag ? 'warning' : 'success'} bold={flag}>
                  {flag ? `▲ ${marks.join(' ')} ` : '· '}
                </Text>
                <Text bold>{row.task}</Text> {liveMark(row.live)} {row.state} · report {row.report}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {row.repos} · {row.model} / {row.effort} · {row.next}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
