import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { attention, statusText } from '../hooks/workers'
import type { WorkerRow } from '../types'

const COORDINATOR = { HERDR_ENV: '1', COORD_ROLE: 'coordinator', HOME: '/home/u' }

function row(over: Partial<WorkerRow>): WorkerRow {
  return {
    task: 't',
    repos: 'ai-pro',
    worker: 'w001-x@w1:p2',
    model: 'opus-5-5 ✓',
    effort: 'high ✓',
    state: 'running',
    live: 'working',
    report: 'running',
    next: 'wait (watcher will notify)',
    ...over,
  }
}

const NORMAL = [row({ task: 'coord-ui' }), row({ task: 'docs', state: 'planned', live: 'none', model: 'sonnet-5-5', effort: 'medium', report: '-', next: 'launch' })]
const NEEDS_YOU = [
  row({ task: 'dialog', live: 'blocked' }),
  row({ task: 'review', state: 'ready_for_review', live: 'idle', report: 'ready_for_review' }),
  row({ task: 'quiet', live: 'idle' }),
  row({ task: 'gone', live: 'exited' }),
  row({ task: 'wrong', model: 'opus-5-5 ≠sonnet-5-5!' }),
  row({ task: 'fresh', model: 'opus-5-5', effort: 'high' }),
  row({ task: 'fine' }),
]

/** coord answers from fixtures; returns the status lines the plugin set. */
function fakeCoord(on: On, status: { stdout?: string; exitCode?: number; stderr?: string }, watcher = 'watcher running pid 42; unread=0\n') {
  const lines: (string | undefined)[] = []
  on('process.run', ($, e) => {
    const isWatch = e.argv[1] === 'watch'
    return {
      value: {
        exitCode: isWatch ? 0 : (status.exitCode ?? 0),
        stdout: isWatch ? watcher : (status.stdout ?? ''),
        stderr: isWatch ? '' : (status.stderr ?? ''),
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  return lines
}

const PANE_PROPS = {
  title: 'Workers',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

describe('rows that need the user', () => {
  test('markers name the reason in text', () => {
    expect(NEEDS_YOU.map(r => attention(r).join(' '))).toEqual([
      'DIALOG',
      'REVIEW',
      'IDLE-NO-REPORT',
      'EXITED',
      'MISMATCH',
      'UNVERIFIED',
      '',
    ])
    expect(NORMAL.map(r => attention(r))).toEqual([[], []])
  })
  test('status line text', () => {
    expect(statusText([])).toBe(undefined)
    expect(statusText(NORMAL)).toBe('coord: 1 running · 0 need you')
    expect(statusText(NEEDS_YOU)).toBe('coord: 6 running · 6 need you')
  })
})

describe('Workers pane', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`empty list on ${surface}`, async ($, on) => {
      mock.env(on, COORDINATOR)
      mock.clock(on)
      const lines = fakeCoord(on, { stdout: '[]' })
      await $.command.run({ command: 'workers', args: '' } as never)
      const ui = await $.ui.mount({ plugin: 'coord-ui', surface, component: 'Pane', requestId: 'workers', props: PANE_PROPS })
      expect(await ui.find({ text: 'no active tasks' })).toBeDefined()
      expect(await ui.find({ text: 'watcher: running' })).toBeDefined()
      expect(lines.at(-1)).toBe(undefined)
      await ui.unmount()
    })

    test(`normal rows on ${surface}`, async ($, on) => {
      mock.env(on, COORDINATOR)
      mock.clock(on)
      const lines = fakeCoord(on, { stdout: JSON.stringify(NORMAL) })
      await $.command.run({ command: 'workers', args: '' } as never)
      const ui = await $.ui.mount({ plugin: 'coord-ui', surface, component: 'Pane', requestId: 'workers', props: PANE_PROPS })
      expect(await ui.find({ key: 'row:coord-ui' })).toBeDefined()
      expect(await ui.find({ text: /coord-ui ✓ running · report running/ })).toBeDefined()
      expect(await ui.find({ text: /docs · running|docs · planned|docs/ })).toBeDefined()
      expect(await ui.find({ text: /▲/ })).toBe(undefined)
      expect(lines.at(-1)).toBe('coord: 1 running · 0 need you')
      await ui.unmount()
    })

    test(`needs-you rows are marked in text on ${surface}`, async ($, on) => {
      mock.env(on, COORDINATOR)
      mock.clock(on)
      fakeCoord(on, { stdout: JSON.stringify(NEEDS_YOU) }, 'watcher stopped; unread=3\n')
      await $.command.run({ command: 'workers', args: '' } as never)
      const ui = await $.ui.mount({ plugin: 'coord-ui', surface, component: 'Pane', requestId: 'workers', props: PANE_PROPS })
      expect(await ui.find({ text: /▲ DIALOG/ })).toBeDefined()
      expect(await ui.find({ text: /▲ MISMATCH/ })).toBeDefined()
      expect(await ui.find({ text: /▲ UNVERIFIED/ })).toBeDefined()
      expect(await ui.find({ text: /watcher: STOPPED/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('a failing coord shows its error and clears the status line', async ($, on) => {
    mock.env(on, COORDINATOR)
    mock.clock(on)
    const lines = fakeCoord(on, { exitCode: 1, stderr: 'coord: registry locked' })
    await $.command.run({ command: 'workers', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'coord-ui', surface: 'terminal', component: 'Pane', requestId: 'workers', props: PANE_PROPS })
    expect(await ui.find({ text: /coord status failed: coord: registry locked/ })).toBeDefined()
    expect(lines.at(-1)).toBe(undefined)
    await ui.unmount()
  })

  test('the pane refreshes every 5 s while open and stops when closed', async ($, on) => {
    mock.env(on, COORDINATOR)
    const clock = mock.clock(on)
    let calls = 0
    on('process.run', ($, e) => {
      if (e.argv[1] === 'status') calls++
      const stdout = e.argv[1] === 'status' ? '[]' : 'watcher running pid 1'
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    let isOpen = true
    on('ui.panes', () => ({
      value: isOpen ? [{ id: 'workers', title: 'Workers', isShown: true, isFocused: false, isPlaced: true }] : [],
    }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true as const } }))
    await $.command.run({ command: 'workers', args: '' } as never)
    expect(calls).toBe(1)
    await clock.advance(5000)
    expect(calls).toBe(2)
    isOpen = false // the person closed it
    await clock.advance(5000)
    await clock.advance(5000)
    expect(calls).toBe(2)
  })
})


describe('roles', () => {
  for (const [role, isCoordinator] of [['coordinator', true], ['worker', false]] as const) {
    test(`session start as ${role}`, async ($, on) => {
      mock.env(on, { HERDR_ENV: '1', COORD_ROLE: role })
      const clock = mock.clock(on)
      const registered: string[] = []
      let calls = 0
      on('command.register', ($, e) => {
        registered.push(e.name)
        return { value: { command: e.name } }
      })
      on('process.run', () => {
        calls++
        const value = { exitCode: 0, stdout: JSON.stringify(NORMAL), stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        return { value }
      })
      const lines: (string | undefined)[] = []
      on('ui.status', ($, e) => {
        lines.push(e.text)
        return { value: undefined }
      })
      on('ui.panes', () => ({ value: [] }))
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
      await clock.settle()
      await clock.advance(10000)
      expect(registered).toEqual(isCoordinator ? ['workers'] : [])
      expect(calls).toBe(isCoordinator ? 2 : 0)
      expect(lines.at(-1)).toBe(isCoordinator ? 'coord: 1 running · 0 need you' : undefined)
    })
  }
})

describe('coordinator fallback: no COORD_ROLE, the session coord recorded', () => {
  const REGISTRY = JSON.stringify({ version: 1, tasks: {}, coordinator: { session_id: 'sess-coord', pane_id: 'w1:p1' } })
  for (const [sessionId, isCoordinator] of [['sess-coord', true], ['sess-other', false]] as const) {
    test(`session ${sessionId} ${isCoordinator ? 'is' : 'is not'} the coordinator`, async ($, on) => {
      mock.env(on, { HERDR_ENV: '1', HOME: '/home/u' })
      const clock = mock.clock(on)
      const read: string[] = []
      on('fs.read', ($, e) => {
        read.push(e.path)
        return { value: REGISTRY }
      })
      on('session.id', () => ({ value: sessionId }))
      const registered: string[] = []
      on('command.register', ($, e) => {
        registered.push(e.name)
        return { value: { command: e.name } }
      })
      const lines = fakeCoord(on, { stdout: JSON.stringify(NORMAL) })
      on('ui.panes', () => ({ value: [] }))
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
      await clock.settle()
      expect(read).toEqual(['/home/u/.local/share/coord/registry.json'])
      expect(registered).toEqual(isCoordinator ? ['workers'] : [])
      expect(lines.at(-1)).toBe(isCoordinator ? 'coord: 1 running · 0 need you' : undefined)
    })
  }

  test('COORD_ROLE=worker decides without reading the registry', async ($, on) => {
    mock.env(on, { HERDR_ENV: '1', COORD_ROLE: 'worker', HOME: '/home/u' })
    let reads = 0
    on('fs.read', () => {
      reads++
      return { value: REGISTRY }
    })
    on('session.id', () => ({ value: 'sess-coord' }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    expect(reads).toBe(0)
  })

  test('COORD_HOME is honoured and a missing registry means not the coordinator', async ($, on) => {
    mock.env(on, { HERDR_ENV: '1', HOME: '/home/u', COORD_HOME: '/srv/coord' })
    const read: string[] = []
    on('fs.read', ($, e) => {
      read.push(e.path)
      return { deny: 'ENOENT' }
    })
    on('session.id', () => ({ value: 'sess-coord' }))
    const registered: string[] = []
    on('command.register', ($, e) => {
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    expect(read).toEqual(['/srv/coord/registry.json'])
    expect(registered).toEqual([])
  })
})
