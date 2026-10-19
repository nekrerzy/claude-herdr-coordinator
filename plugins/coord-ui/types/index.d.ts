/** One row of `coord status --json`. */
export type WorkerRow = {
  task: string
  repos: string
  worker: string
  model: string
  effort: string
  state: string
  live: string
  report: string
  next: string
}

/** The last `coord status` read: its rows, the watcher line, or the error. */
export type WorkerSnapshot = {
  rows: WorkerRow[]
  watcher?: string
  error?: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'coord-ui': { snapshot: WorkerSnapshot | null }
  }
}
