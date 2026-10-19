// What the Workers pane and the status line make of `coord status --json`.

import type { WorkerRow } from '../types'

const ALIVE = new Set(['working', 'idle', 'blocked', 'done', 'unknown'])
const GONE = new Set(['exited', 'gone', 'replaced'])
const ACTIVE = new Set(['running', 'blocked'])

/** Why a row needs the user, as text markers (empty when it does not). */
export function attention(row: WorkerRow): string[] {
  const marks: string[] = []
  if (row.live === 'blocked') marks.push('DIALOG')
  if (row.state === 'blocked' || row.report === 'blocked') marks.push('BLOCKED')
  if (row.state === 'ready_for_review') marks.push('REVIEW')
  if (row.state === 'running' && (row.live === 'idle' || row.live === 'done')) marks.push('IDLE-NO-REPORT')
  if (GONE.has(row.live) && ACTIVE.has(row.state)) marks.push('EXITED')
  if (row.model.includes('≠') || row.effort.includes('≠')) marks.push('MISMATCH')
  else if (ALIVE.has(row.live) && !(row.model.includes('✓') && row.effort.includes('✓'))) marks.push('UNVERIFIED')
  return marks
}

/** ✓ for a live worker, ✗ for one that exited or is gone, · before launch. */
export function liveMark(live: string): string {
  if (ALIVE.has(live)) return '✓'
  if (GONE.has(live)) return '✗'
  return '·'
}

/** The status line, or undefined when there is nothing to say. */
export function statusText(rows: readonly WorkerRow[]): string | undefined {
  if (rows.length === 0) return undefined
  const running = rows.filter(r => r.state === 'running').length
  const needs = rows.filter(r => attention(r).length > 0).length
  return `coord: ${running} running · ${needs} need you`
}

/** Rows from `coord status --json` output; throws on anything else. */
export function parseRows(stdout: string): WorkerRow[] {
  const data: unknown = JSON.parse(stdout)
  if (!Array.isArray(data)) throw new Error('coord status --json did not print a list')
  return data.map(item => {
    const r = (item ?? {}) as Record<string, unknown>
    const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '-')
    return {
      task: s('task'),
      repos: s('repos'),
      worker: s('worker'),
      model: s('model'),
      effort: s('effort'),
      state: s('state'),
      live: s('live'),
      report: s('report'),
      next: s('next'),
    }
  })
}

/** `running` or `STOPPED` from `coord watch status`, else its first line. */
export function watcherState(stdout: string): string {
  const m = stdout.match(/watcher (running|stopped|not running)/)
  if (m) return m[1] === 'running' ? 'running' : 'STOPPED'
  return stdout.trim().split('\n')[0] || 'unknown'
}

/** The coordinator session id coord recorded in registry.json, if any. */
export function recordedCoordinator(registryText: string): string | undefined {
  const reg: unknown = JSON.parse(registryText)
  const coordinator = (reg as { coordinator?: { session_id?: unknown } } | null)?.coordinator
  return typeof coordinator?.session_id === 'string' && coordinator.session_id !== '' ? coordinator.session_id : undefined
}
