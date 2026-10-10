// Integration: the plugin's hooks against the engine's test kit. Every noun
// that would touch the machine (fs, process, env, clock) is answered by the
// test's own hooks from fixtures: no real registry, /proc or licence picker.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { APPEND_SCRIPT, FILES_PS1, PROBE_PS1, PROBE_SCRIPT, REGISTER_SCRIPT, probeArgs } from '../hooks/core'
import { ROTATE_SCRIPT, TRACE_MAX_BYTES, localIso } from '../hooks/trace'

import {
  HOME,
  NOW_MS,
  ORCH_DIR,
  PROBE_STDOUT,
  REGISTRY_PATH,
  REGISTRY_TEXT,
  RESULTS,
  SID_ALIVE,
  SID_DEAD,
  SID_DONE,
  SID_UNREPORTED,
  TASK_NOTIFICATION_KILLED,
  WIN_PROBE_STDOUT,
} from './fixtures'

const PICKER = '/fixture/bin/pick --need {need}'
const OPTIONS = { orchestratorDir: ORCH_DIR, registryPath: '~/.claude/headless-sessions.json', completionWrites: true, licencePickCommand: PICKER }
const TOOL = 'mcp__session-control__launch_worker'
const QUEUE_TEXT = JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: 'Queued one' }, { id: 'q2', status: 'done', title: 'Finished' }] })
const OPEN_POINTS_TEXT = JSON.stringify({
  points: [
    { id: 'a', status: 'open', title: 'First question', detail: 'Detail one', recommendation: 'Do A' },
    { id: 'b', status: 'closed', title: 'Settled', detail: '', recommendation: '' },
    { id: 'c', status: 'open', hold: true, title: 'Held', detail: '', recommendation: '' },
    { id: 'd', status: 'open', title: 'Second question', detail: 'Detail two', recommendation: 'Do B' },
  ],
})

type World = {
  /** Bash calls the plugin's own launch made through $.tool.call. */
  bash: { command?: string; run_in_background?: boolean; timeout?: number }[]
  /** Set once the fake worker "started": later probes show its process. */
  spawned: boolean
  writes: { path: string; text: string }[]
  /** Paths the plugin read through $.fs.read, in order. */
  reads: string[]
  toasts: string[]
  runs: string[][]
  registered: string[]
  tools: { name: string; description: unknown; inputSchema: unknown }[]
  clock: ReturnType<typeof mock.clock>
}

const MISSING = new Set<string>()
// Paths that read as missing until the first sleep, like a session file the engine writes a moment late.
const LATE = new Set<string>()
// Paths that are there but cannot be read (over the read cap, say).
const UNREADABLE = new Set<string>()
// The CLAUDE_CONFIG_DIR the Linux probe reads from the new worker's environment ('' when it has none).
const WORKER = { linuxConfigDir: '/fixture/lic/a', isBashMissing: false }
// Knobs of the Windows fixture: a failing move or probe; the config dir the probe finds the new worker's sessions
// file in, or none (unplaced).
const WINDOWS = { isMoveBroken: false, isScriptBroken: false, isProbeBroken: false, workerConfigDir: 'C:\\fixture\\home\\.claude', isWorkerUnplaced: false }
// Knobs of the Linux fixture: a probe that cannot run; an append that fails.
// A trace.log of traceSize bytes is there (0: none).
const LINUX_FIXTURE = { isProbeBroken: false, isAppendBroken: false, traceSize: 0 }
const BIG_PROMPT = `Wait in the foreground; report git status -sb; no attribution. ${'x'.repeat(30_000)}`
/** The rows of the transcript tail the fixture serves. */
const TAIL = [
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the suite files.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status -sb' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: '## develop...origin/develop' }] } },
]
  .map(row => JSON.stringify(row))
  .join('\n')

/** Windows PowerShell as the mod runs it when SystemRoot is unset. */
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** The fixture on Windows: C:/fixture/... and C:/work/... are the fixture's /fixture/... and /work/... */
const fixture = (path: string) => path.replace(/^C:(?=\/(fixture|work)\/)/, '')

/**
 * A path as the plugin gave it to $.fs, from the one the fs hooks see, which the kit resolves first: on a Windows
 * host /x becomes C:\x; on a Linux host C:/x is a relative path, after the session's directory. The fixture's
 * Linux paths come back as /x, its Windows ones as C:/x, on either host.
 */
const given = (path: string, isWin: boolean) => {
  const slashed = path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')
  return isWin ? slashed : slashed.replace(/^[A-Za-z]:(?=\/)/, '')
}

function world(on: On, pickStdout = '/fixture/lic/a\n', promptFileExists = true, registryText = REGISTRY_TEXT, env: Record<string, string> = { HOME }, isEnvOwn = false): World {
  const w: World = { bash: [], spawned: false, writes: [], reads: [], toasts: [], runs: [], registered: [], tools: [], clock: mock.clock(on, { now: NOW_MS }) }
  // A test that answers env.get itself says so.
  if (!isEnvOwn) mock.env(on, env)
  const isWin = env.OS === 'Windows_NT' && /^[A-Za-z]:[\\/]/.test(env.USERPROFILE ?? '')
  const seen = (path: string) => given(path, isWin)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    w.registered.push(`/${e.name}`)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    w.registered.push(e.name)
    w.tools.push({ name: e.name, description: e.description, inputSchema: e.inputSchema })
    return { value: { tool: `mcp__session-control__${e.name}` } }
  })
  on('fs.read', ($, e) => {
    const path = fixture(seen(e.path))
    w.reads.push(seen(e.path))
    if (MISSING.has(path) || LATE.has(path)) throw new Error(`ENOENT ${e.path}`)
    if (UNREADABLE.has(path)) throw new Error(`EFBIG ${e.path}`)
    if (path === REGISTRY_PATH) return { value: registryText }
    if (path === '/work/orch/CLAUDE.md') return { value: '# Role: Session Orchestrator\n' }
    if (path === '/work/new/thin.md') return { value: 'Just do the work.' }
    if (path === `${ORCH_DIR}/task-queue.json`) return { value: QUEUE_TEXT }
    if (path === `${ORCH_DIR}/open-points.json`) return { value: OPEN_POINTS_TEXT }
    const result = /^\/fixture\/results\/(\w+)\.json$/.exec(path)?.[1]
    if (result !== undefined && result in RESULTS) return { value: RESULTS[result as keyof typeof RESULTS] }
    if (['/fixture/home/.claude/sessions/7001.json', '/fixture/lic/own/sessions/7001.json'].includes(path) && !isWin) return { value: JSON.stringify({ sessionId: 'abcdabcd-0000-4000-8000-000000000001', procStart: '123' }) }
    if (path === '/fixture/lic/a/sessions/7001.json') return { value: JSON.stringify({ sessionId: 'abcdabcd-0000-4000-8000-000000000001', procStart: '123' }) }
    if (seen(e.path) === 'C:/fixture/home/.claude/sessions/7001.json') return { value: JSON.stringify({ pid: 7001, sessionId: 'abcdabcd-0000-4000-8000-000000000001', startedAt: NOW_MS }) }
    if (path === '/work/new/big.md') return { value: BIG_PROMPT }
    // The mod's own scripts read back as written.
    const written = w.writes.filter(one => one.path === seen(e.path) && one.path.endsWith('.ps1')).at(-1)
    if (written !== undefined) return { value: written.text }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.write', ($, e) => {
    w.writes.push({ path: seen(e.path), text: e.text })
    return { value: undefined }
  })
  // A path the read above refuses is missing, unless it is one that cannot be read.
  on('fs.exists', ($, e) => ({ value: UNREADABLE.has(fixture(seen(e.path))) }))
  on('fs.stat', ($, e) => {
    const path = fixture(seen(e.path))
    const stat = { size: 0, mtimeMs: NOW_MS, isLink: false }
    if (path.endsWith('/trace.log') && LINUX_FIXTURE.traceSize > 0) return { value: { ...stat, kind: 'file', size: LINUX_FIXTURE.traceSize } }
    if (['/work/new/prompt.md', '/work/new/big.md'].includes(path)) return { value: { ...stat, kind: 'file', size: promptFileExists ? 100 : 0 } }
    if (['/work/new', '/work/orch', ORCH_DIR].includes(path)) return { value: { ...stat, kind: 'dir' } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('process.run', ($, e) => {
    w.runs.push([...e.argv])
    const ok = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === 'sh' && String(e.argv[2]).startsWith('tail ')) {
      const rows = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the suite files.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status -sb' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: '## develop...origin/develop' }] } },
      ]
      return { value: { ...ok, stdout: rows.map(r => JSON.stringify(r)).join('\n') } }
    }
    if (e.argv[0] === 'sh' && e.argv[2] === REGISTER_SCRIPT) return { value: { ...ok, stdout: '' } }
    // An append is recorded as a write of what it adds.
    if (e.argv[0] === 'sh' && e.argv[2] === APPEND_SCRIPT) {
      if (LINUX_FIXTURE.isAppendBroken) return { value: { ...ok, stdout: '', exitCode: 1, stderr: 'sh: cannot create: Read-only file system' } }
      w.writes.push({ path: String(e.argv[5]), text: `${e.argv[4]}\n` })
      return { value: { ...ok, stdout: '' } }
    }
    // A rotation moves the trace away: it is empty from then on.
    if (e.argv[0] === 'sh' && e.argv[2] === ROTATE_SCRIPT) {
      LINUX_FIXTURE.traceSize = 0
      return { value: { ...ok, stdout: '' } }
    }
    if (e.argv[0] === 'sh' && e.argv[2] === PROBE_SCRIPT) {
      if (LINUX_FIXTURE.isProbeBroken) throw new Error('the probe timed out')
      const worker = w.spawned
        ? `\nP\t7001\tclaude\t3\t/work/new\t${WORKER.linuxConfigDir}\tclaude -p --model opus --dangerously-skip-permissions --output-format json -- prompt\n`
        : ''
      return { value: { ...ok, stdout: PROBE_STDOUT + worker } }
    }
    if (e.argv[0] === 'sh') return { value: { ...ok, stdout: PROBE_STDOUT } }
    if (e.argv[0] === 'sleep') LATE.clear()
    if (e.argv[0] === 'mkdir' || e.argv[0] === 'sleep' || e.argv[0] === 'rm') return { value: { ...ok, stdout: '' } }
    if (e.argv[0] === 'mv') {
      // The newest write of that name: the mocked clock stands still, so temp names repeat.
      const text = w.writes.filter(one => one.path === e.argv[2]).at(-1)?.text
      if (text !== undefined) w.writes.push({ path: String(e.argv[3]), text })
      return { value: { ...ok, stdout: '' } }
    }
    if (e.argv[0] === 'test' && e.argv[1] === '-e') return { value: { ...ok, stdout: '', exitCode: 1 } }
    if (e.argv[0] === 'test') return { value: { ...ok, stdout: '', exitCode: promptFileExists ? 0 : 1 } }
    if (e.argv[0] === '/fixture/bin/pick') return { value: { ...ok, stdout: pickStdout, exitCode: pickStdout ? 0 : 3 } }
    if (e.argv[0] === POWERSHELL && String(e.argv[6]).endsWith('/probe.ps1')) {
      if (WINDOWS.isProbeBroken) return { value: { ...ok, stdout: '', exitCode: 1, stderr: 'Invalid class' } }
      const placed = WINDOWS.isWorkerUnplaced ? ['', ''] : ['C:\\work\\new', WINDOWS.workerConfigDir]
      const worker = w.spawned
        ? ['P', 7001, 'claude', 3, ...placed, '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus --dangerously-skip-permissions --output-format json -- prompt'].join('\t') + '\n'
        : ''
      // PowerShell's own line ends.
      return { value: { ...ok, stdout: (WIN_PROBE_STDOUT + worker).replace(/\n/g, '\r\n') } }
    }
    if (e.argv[0] === POWERSHELL && String(e.argv[6]).endsWith('/files.ps1')) {
      const [op, from, to] = e.argv.slice(7).map(String)
      if (WINDOWS.isScriptBroken || (op === 'move' && WINDOWS.isMoveBroken)) return { value: { ...ok, stdout: '', exitCode: 1, stderr: 'Access denied.' } }
      if (op === 'move' || op === 'append') {
        const text = w.writes.filter(one => fixture(one.path) === fixture(String(from))).at(-1)?.text
        if (text !== undefined) w.writes.push({ path: String(to), text })
      }
      return { value: { ...ok, stdout: op === 'tail' ? TAIL : '' } }
    }
    if (e.argv[0] === 'C:/fixture/bin/pick.exe') {
      return { value: { ...ok, stdout: pickStdout.replace(/^\/fixture/, 'C:\\fixture').replace(/\//g, '\\').replace(/\n$/, '\r\n'), exitCode: pickStdout ? 0 : 3 } }
    }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    if (WORKER.isBashMissing) throw new Error('no tool named "Bash" in this session')
    w.bash.push(e as never)
    w.spawned = true
    return { result: 'Command running in background with ID: fixture' }
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

const start = (cwd: string, isInteractive = true) => ({ cwd, surface: null, isInteractive })
/** The registry as the plugin last wrote it. */
const lastRegistry = (w: World) => JSON.parse(w.writes.filter(one => fixture(one.path) === REGISTRY_PATH).at(-1)?.text ?? '[]') as Record<string, unknown>[]
const PANE_PROPS = { title: 'Session control', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 36 } }

const stubPanel = (on: On) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
}
const mountPane = ($: Parameters<Parameters<typeof test>[2]>[0]) =>
  $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })

const TRACE = `${HOME}/.claude/session-control/runs/trace.log`
type TraceLine = Record<string, unknown>
/** The trace lines the plugin appended to a trace file, parsed. */
const traceOf = (w: World, path = TRACE): TraceLine[] =>
  w.writes.filter(one => one.path === path).flatMap(one => one.text.trimEnd().split('\n')).map(line => JSON.parse(line) as TraceLine)
/** Lines without their time and number (checked by themselves): each time is the fixture clock's at the line, the numbers count up from 1. */
const bare = (lines: TraceLine[]): TraceLine[] => {
  expect(lines.every(line => [0, 5000].some(later => line.ts === localIso(NOW_MS + later)))).toBe(true)
  expect(lines.map(line => line.seq)).toEqual(lines.map((_, at) => at + 1))
  return lines.map(line => Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'ts' && key !== 'seq')))
}
/** The lines from the first one of an event on. */
const from = (lines: TraceLine[], event: string) => lines.slice(lines.findIndex(line => line.event === event))
/** A trace append or rotation: the commands the trace adds to what the mod runs. */
const isTraceRun = (argv: readonly string[]) =>
  (argv[2] === APPEND_SCRIPT && String(argv[5]).endsWith('/trace.log')) || argv[2] === ROTATE_SCRIPT || (argv[7] === 'append' && String(argv[9]).endsWith('/trace.log'))

describe('scope', () => {
  test('a no-op outside the orchestrator dir', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await $.session.start(start('/work/elsewhere'))
    expect(w.runs.length).toBe(0)
    expect(w.registered).toEqual(['/session-control'])
  })

  test('/session-control starts the board where it is off and shows the panel; again it hides the panel and the board stays on', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    let isUp = false
    on('ui.open', () => {
      isUp = true
      return { value: { isPlaced: true } } as never
    })
    on('ui.panes', () => ({ value: isUp ? [{ id: 'session-control' }] : [] }) as never)
    await $.session.start(start('/work/elsewhere'))
    expect(w.runs.length).toBe(0)
    const opened = await $.command.run({ command: 'session-control', args: '' } as never)
    expect(opened.text).toBe('Session-control panel opened.')
    expect(w.registered).toContain('launch_worker')
    const runs = w.runs.length
    const hidden = await $.command.run({ command: 'session-control', args: '' } as never)
    expect(hidden.text).toBe('Session-control panel hidden, session-control stays on.')
    // Still on: the board's tools stay registered once and a prompt notification would still be handled.
    expect(w.registered.filter(name => name === 'launch_worker').length).toBe(1)
    expect(w.runs.length).toBeGreaterThanOrEqual(runs)
    isUp = false
    const again = await $.command.run({ command: 'session-control', args: '' } as never)
    expect(again.text).toBe('Session-control panel opened.')
    expect(w.registered.filter(name => name === 'launch_worker').length).toBe(1)
  })
  test('without the orchestratorDir option the board starts where CLAUDE.md is the orchestrator, and the command refuses elsewhere', { options: { registryPath: '~/.claude/headless-sessions.json', completionWrites: true } }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await $.session.start(start('/work/elsewhere'))
    expect(w.registered).toEqual(['/session-control'])
    const refused = await $.command.run({ command: 'session-control', args: '' } as never)
    expect(refused.text).toContain('not an orchestrator directory')
    await $.session.start(start('/work/orch/'))
    expect(w.registered).toContain('launch_worker')
    expect(w.writes.some(one => one.path === '/work/orch/open-points.json')).toBe(true)
  })
})

/** Checksum of the tool surface (names, descriptions, schemas): the engine caches these across reloads, so they must not drift. */
function fingerprint(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0
  return `${text.length}:${hash.toString(16)}`
}

describe('tool surface', () => {
  test('the six tools keep their names, descriptions and schemas', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    expect(w.tools.map(tool => tool.name)).toEqual(['launch_worker', 'acknowledge_workers', 'retire_workers', 'open_point', 'queue_task', 'record_decision'])
    expect(fingerprint(JSON.stringify(w.tools))).toBe('5222:a22910df')
  })
})

describe('fresh environment', () => {
  test('missing helper files are created from scratch, nothing warns, and the tools work on them', { options: OPTIONS }, async ($, on) => {
    for (const file of ['open-points.json', 'task-queue.json']) MISSING.add(`${ORCH_DIR}/${file}`)
    const w = world(on)
    try {
      await $.session.start(start(ORCH_DIR))
      const created = (file: string) => w.writes.find(one => one.path === `${ORCH_DIR}/${file}`)?.text
      expect(JSON.parse(created('open-points.json') ?? '{}')).toMatchObject({ points: [] })
      expect(JSON.parse(created('task-queue.json') ?? '{}')).toEqual({ tasks: [] })
      expect(created('agreed-decisions.md')).toBe('# Agreed decisions\n')
      expect(created('open-points-archive.md')).toBe('# Open points archive\n')
      expect(w.runs.some(argv => argv[0] === 'mkdir' && argv.includes(`${ORCH_DIR}/backups`))).toBe(true)
      expect(w.toasts.every(text => text.includes('limited worker'))).toBe(true)
    } finally {
      MISSING.clear()
    }
  })
})

describe('errors', () => {
  test('an unreadable registry is toasted once and the panel shows the warning in the sessions box', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, 'not json')
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    expect(w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 session-control: ')).length).toBe(1)
    await $.command.run({ command: 'session-control', args: '' } as never)
    expect(w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 session-control: ')).length).toBe(1)
    const ui = await mountPane($)
    const all = String(((await ui.findAll({}))[0] as { text?: string }).text ?? '')
    expect(all).toContain('! session-control:')
    expect(all).toContain('SESSIONS')
    expect(all).toContain('QUEUED WORK')
  })
})

describe('session-control board', () => {
  test('session.start registers, gathers with one probe call, gathers the rows', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR + '/'))
    expect(w.registered).toEqual(['/session-control', 'launch_worker', 'acknowledge_workers', 'retire_workers', 'open_point', 'queue_task', 'record_decision'])
    const probes = w.runs.filter(argv => argv[0] === 'sh')
    expect(probes.length).toBe(1)
    expect(probes[0]).toContain(`pid:4101|/fixture/lic/a`)
  })

  test('/session-control side opens one panel: sessions, queued work, open points, in that order', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    const ran = await $.command.run({ command: 'session-control', args: 'side' } as never)
    expect(ran.text).toBe('Session-control panel opened.')
    const ui = await $.ui.mount({
      plugin: 'session-control',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'session-control',
      props: PANE_PROPS as never,
    })
    const all = String(((await ui.findAll({}))[0] as { text?: string }).text ?? '')
    const at = (needle: string) => all.indexOf(needle)
    expect(at('SESSIONS')).toBe(0)
    expect(at('SESSIONS')).toBeLessThan(at('alive worker'))
    expect(at('alive worker')).toBeLessThan(at('QUEUED WORK'))
    expect(at('QUEUED WORK')).toBeLessThan(at('Queued one'))
    expect(at('Queued one')).toBeLessThan(at('OPEN POINTS'))
    expect(at('OPEN POINTS')).toBeLessThan(at('1. First question'))
    expect(at('1. First question')).toBeLessThan(at('2. Second question'))
    expect(/Held|Settled/.test(all)).toBe(false)
    expect(/CURRENT STATUS|FINAL STATE|IN FLIGHT/.test(all)).toBe(false)
  })

  test('clicking a session opens its output box, clicking it again closes it', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeUndefined()
    await ui.press({ key: 's:aaaaaaaa-1111-4111-8111-111111111111' })
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /> Bash git status -sb/ })).toBeDefined()
    await ui.press({ key: 's:aaaaaaaa-1111-4111-8111-111111111111' })
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeUndefined()
  })
})

describe('completion', () => {
  test('a dead worker is classified, merged in place once, and toasted', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    const regWrites = () => w.writes.filter(one => one.path === REGISTRY_PATH)
    expect(regWrites().length).toBe(1)
    const after = JSON.parse(regWrites()[0]!.text) as Record<string, unknown>[]
    const entry = after.find(one => one.session_id === SID_DEAD)!
    expect('pid' in entry).toBe(false)
    expect(entry.reported).toBe(false)
    expect(entry.resume).toEqual({ parked_until: '2026-10-06T12:00:00Z', strikes: 2, escalated: true })
    expect(w.toasts).toEqual(['Usage limit reached \u00B7 session-control: limited worker: limit: rate limit hit'])
    await w.clock.advance(5000)
    expect(regWrites().length).toBe(1)
    expect(w.writes.some(one => one.path.includes('/backups/headless-sessions-before-completion-'))).toBe(true)
  })

  // The toast leads with the notification type, then the message as before.
  for (const [result, title, summary] of [
    ['clean', 'Session finished', 'clean: Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.'],
    ['limit', 'Usage limit reached', 'limit: rate limit hit'],
    ['login', 'Login needed', 'login: licence needs a re-login'],
    ['oom', 'Session killed', 'killed: killed (memory)'],
    ['error', 'Session failed', 'error: Tool execution failed: ENOSPC while writing the output.'],
    ['chatter', 'Session ended without a report', 'chatter: short result "Let me look at that." after a substantial run'],
  ] as const) {
    test(`a completion toast carries its type as the title: ${title}`, { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT.replace('/fixture/results/limit.json', `/fixture/results/${result}.json`))
      await $.session.start(start(ORCH_DIR))
      expect(w.toasts).toEqual([`${title} \u00B7 session-control: limited worker: ${summary}`])
    })
  }

  test('with completionWrites off nothing is written, the toast still shows', { options: { ...OPTIONS, completionWrites: false } }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    expect(w.writes.filter(one => one.path === REGISTRY_PATH).length).toBe(0)
    expect(w.toasts.length).toBe(1)
  })

  test('a task notification carries the pending completion to the model once', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.session.start(start(ORCH_DIR))
    const first = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(first.context).toEqual(['session-control completions: limited worker: limit: rate limit hit'])
    const second = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(second.context).toBeUndefined()
  })
})

describe('launch_worker', () => {
  const args = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }

  test('passes the guards, runs the worker in the background, finds its pid and registers it', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    const ran = await $.tool.call({ tool: TOOL, ...args } as never)
    expect(String(ran.result)).toContain('Launched pid 7001')
    expect(String(ran.result)).toContain('session abcdabcd-0000-4000-8000-000000000001')
    expect(w.bash.length).toBe(1)
    const bash = w.bash[0]
    expect(bash?.run_in_background).toBe(true)
    expect(bash?.timeout).toBe(180 * 60_000)
    expect(String(bash?.command)).toContain("CLAUDE_CONFIG_DIR='/fixture/lic/a'")
    expect(String(bash?.command)).toContain('/.claude/session-control/runs/')
    expect(String(bash?.command)).not.toContain("'/work/new/result.json'")
    expect(String(bash?.command)).toContain('2>')
    // Registered as new: appended to the registry it read, with the real pid and the launch dir.
    const after = lastRegistry(w)
    expect(after.length).toBe(JSON.parse(REGISTRY_TEXT).length + 1)
    expect(after.at(-1)).toMatchObject({ pid: 7001, session_id: 'abcdabcd-0000-4000-8000-000000000001', cwd: '/work/new' })
    expect(w.runs.some(argv => argv.join(' ') === '/fixture/bin/pick --need 40')).toBe(true)
  })

  test('without a licence picker command a fresh launch runs no picker, sets no CLAUDE_CONFIG_DIR and records <home>/.claude', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
    WORKER.linuxConfigDir = ''
    try {
      const w = world(on, '')
      await $.session.start(start(ORCH_DIR))
      const out = await $.tool.call({ tool: TOOL, ...args } as never)
      expect(String(out.result)).toContain(`Launched pid 7001, session abcdabcd-0000-4000-8000-000000000001, config_dir ${HOME}/.claude, registered.`)
      expect(w.runs.some(argv => argv[0] === '/fixture/bin/pick')).toBe(false)
      expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
      expect(String(w.bash[0]?.command)).toStartWith("cd '/work/new' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' ")
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, config_dir: `${HOME}/.claude`, cwd: '/work/new' })
    } finally {
      WORKER.linuxConfigDir = '/fixture/lic/a'
    }
  })

  test('without a picker, an orchestrator with its own CLAUDE_CONFIG_DIR: the worker inherits it, and the registry records it', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
    WORKER.linuxConfigDir = '/fixture/lic/own'
    try {
      const w = world(on, '', true, REGISTRY_TEXT, { HOME, CLAUDE_CONFIG_DIR: '/fixture/lic/own' })
      await $.session.start(start(ORCH_DIR))
      const out = await $.tool.call({ tool: TOOL, ...args } as never)
      expect(String(out.result)).toContain('config_dir /fixture/lic/own, registered.')
      expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, config_dir: '/fixture/lic/own' })
    } finally {
      WORKER.linuxConfigDir = '/fixture/lic/a'
    }
  })

  test('a Bash tool the session does not offer is a clear refusal, and nothing is registered', { options: OPTIONS }, async ($, on) => {
    WORKER.isBashMissing = true
    try {
      const w = world(on)
      await $.session.start(start(ORCH_DIR))
      const out = await $.tool.call({ tool: TOOL, ...args } as never)
      expect(String(out.deny)).toStartWith('session-control: the worker could not be started through the Bash tool (')
      // The engine's reason in the brackets (the kit's own wording for a failed call).
      expect(String(out.deny)).toMatch(/Bash tool \(.+\); nothing/)
      expect(String(out.deny)).toEndWith('nothing was launched.')
      expect(w.bash.length).toBe(0)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
    } finally {
      WORKER.isBashMissing = false
    }
  })

  describe('a resume', () => {
    // The unreported entry: no pid, its transcript seen by the probe.
    const underHome = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? { ...one, config_dir: `${HOME}/.claude` } : one)))
    const resume = { ...args, resume_sid: SID_UNREPORTED }
    test('without a picker, of an entry under the default directory, sets no CLAUDE_CONFIG_DIR', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
      WORKER.linuxConfigDir = ''
      try {
        const w = world(on, '', true, underHome)
        await $.session.start(start(ORCH_DIR))
        expect(String((await $.tool.call({ tool: TOOL, ...resume } as never)).result)).toContain('Launched pid 7001')
        expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
        expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}'`)
      } finally {
        WORKER.linuxConfigDir = '/fixture/lic/a'
      }
    })
    test('without a picker, of an entry under another directory, sets it', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
      const w = world(on, '')
      await $.session.start(start(ORCH_DIR))
      expect(String((await $.tool.call({ tool: TOOL, ...resume } as never)).result)).toContain('Launched pid 7001')
      expect(String(w.bash[0]?.command)).toContain(`CLAUDE_CONFIG_DIR='/fixture/lic/a' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --resume '${SID_UNREPORTED}'`)
    })
    test('with a picker, of an entry under the default directory, sets it as before', { options: OPTIONS }, async ($, on) => {
      WORKER.linuxConfigDir = `${HOME}/.claude`
      try {
        const w = world(on, '/fixture/lic/a\n', true, underHome)
        await $.session.start(start(ORCH_DIR))
        expect(String((await $.tool.call({ tool: TOOL, ...resume } as never)).result)).toContain('Launched pid 7001')
        expect(String(w.bash[0]?.command)).toContain(`CLAUDE_CONFIG_DIR='${HOME}/.claude'`)
        expect(w.runs.some(argv => argv[0] === '/fixture/bin/pick')).toBe(false)
      } finally {
        WORKER.linuxConfigDir = '/fixture/lic/a'
      }
    })
  })

  test('a session file that appears late is still read, and the worker is registered', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    LATE.add('/fixture/lic/a/sessions/7001.json')
    try {
      const out = await $.tool.call({ tool: TOOL, ...args } as never)
      expect(String(out.result)).toContain('Launched pid 7001')
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(true)
    } finally {
      LATE.clear()
    }
  })

  test('a missing registry is registered into as an empty one', { options: OPTIONS }, async ($, on) => {
    MISSING.add(REGISTRY_PATH)
    try {
      const w = world(on)
      await $.session.start(start(ORCH_DIR))
      const out = await $.tool.call({ tool: TOOL, ...args } as never)
      expect(String(out.result)).toContain('registered')
      expect(lastRegistry(w)).toEqual([expect.objectContaining({ pid: 7001, cwd: '/work/new' })] as never)
    } finally {
      MISSING.clear()
    }
  })

  test('a registry that is there but cannot be read is never overwritten', { options: OPTIONS }, async ($, on) => {
    UNREADABLE.add(REGISTRY_PATH)
    try {
      const w = world(on)
      await $.session.start(start(ORCH_DIR))
      // The fixture's `test -e` answers every file as missing, so activation's own helper-file creation is not counted.
      const before = w.writes.length
      const out = await $.tool.call({ tool: TOOL, ...args } as never)
      expect(String(out.result)).toContain('registry write FAILED: the registry cannot be read')
      expect(w.writes.slice(before).some(one => one.path.startsWith(REGISTRY_PATH))).toBe(false)
    } finally {
      UNREADABLE.clear()
    }
  })

  test('refuses the orchestrator dir as cwd', { options: OPTIONS }, async ($, on) => {
    world(on)
    await $.session.start(start(ORCH_DIR))
    const ran = await $.tool.call({ tool: TOOL, ...args, dir: ORCH_DIR } as never)
    expect(String(ran.deny)).toContain('orchestrator dir')
  })

  test('refuses an empty licence pick', { options: OPTIONS }, async ($, on) => {
    world(on, '')
    await $.session.start(start(ORCH_DIR))
    const ran = await $.tool.call({ tool: TOOL, ...args } as never)
    expect(String(ran.deny)).toContain('no licence has room')
  })

  test('refuses a resume of a live session', { options: OPTIONS }, async ($, on) => {
    world(on)
    await $.session.start(start(ORCH_DIR))
    const ran = await $.tool.call({ tool: TOOL, ...args, resume_sid: SID_ALIVE } as never)
    expect(String(ran.deny)).toContain('pid 4101')
  })

  test('the report check sends a faulty report back once, and passes a clean one', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.Stop', () => ({}))
    await $.session.start(start(ORCH_DIR))
    const stop = (answer: string, again = false) =>
      ({ hook_event_name: 'Stop', stop_hook_active: again, last_assistant_message: answer, session_id: 's', transcript_path: '/t', cwd: ORCH_DIR }) as never
    const bad = await $.classic.Stop(stop('It is not a bug, but a feature.'))
    expect(bad.block).toContain('Report check failed')
    expect((await $.classic.Stop(stop('It is not a bug, but a feature.', true))).block).toBeUndefined()
    expect((await $.classic.Stop(stop('The worker finished: 3 files changed.'))).block).toBeUndefined()
  })

  test('launch_worker refuses a prompt without the checklist items', { options: OPTIONS }, async ($, on) => {
    world(on)
    await $.session.start(start(ORCH_DIR))
    const out = await $.tool.call({ tool: TOOL, ...args, prompt_file: '/work/new/thin.md' } as never)
    expect(JSON.stringify(out)).toContain('the prompt lacks')
  })

  test('the first prompt after a compaction carries the state digest, once', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.PostCompact', () => ({}))
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.session.start(start(ORCH_DIR))
    const stop = { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 's', session_id: 's', transcript_path: '/t', cwd: ORCH_DIR }
    await $.classic.PostCompact(stop as never)
    const first = await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)
    expect(JSON.stringify(first.context)).toContain('after compaction')
    expect(JSON.stringify(first.context)).toContain('1. First question')
    const second = await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'user' } } as never)
    expect(second.context).toBeUndefined()
  })

  test('the ledger opens on a model send to a peer and closes on its reply', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.PostCompact', () => ({}))
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    on('session.send', () => ({ isDelivered: true }) as never)
    on('session.receive', (_$, e) => ({ text: e.text }))
    await $.session.start(start(ORCH_DIR))
    await $.session.send({ to: 'obsidian-manager', text: 'Update the note', origin: { kind: 'model' } } as never)
    await $.classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 's', session_id: 's', transcript_path: '/t', cwd: ORCH_DIR } as never)
    const open = await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'user' } } as never)
    expect(JSON.stringify(open.context)).toContain('have not acknowledged their task: obsidian-manager')
    await $.session.receive({ text: 'obsidian-manager: done', origin: { kind: 'peer' } } as never)
    await $.classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 's', session_id: 's', transcript_path: '/t', cwd: ORCH_DIR } as never)
    const closed = await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'user' } } as never)
    expect(JSON.stringify(closed.context)).not.toContain('not acknowledged')
  })


  test('clicking an open point shows its description; clicking the title hides it; the description is not clickable', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    const ui = await mountPane($)
    const all = async () => String(((await ui.findAll({}))[0] as { text?: string }).text)
    expect(await all()).not.toContain('Detail one')
    await ui.press({ key: 'p:a:0' })
    expect(await all()).toContain('\u25B8 1. First question')
    expect(await all()).toContain('Detail one')
    expect(await all()).toContain('Recommendation: Do A')
    expect(await all()).not.toContain('Detail two')
    await expect(ui.press({ key: 'p:a:d:0' })).rejects.toThrow()
    expect(await all()).toContain('Detail one')
    await ui.press({ key: 'p:a:t:0' })
    expect(await all()).not.toContain('Detail one')
    await ui.press({ key: 'p:a:0' })
    await ui.press({ key: 'p:a:t:0' })
    expect(await all()).not.toContain('Detail one')
  })

  test('queued work is a bullet list', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^\u2022 Queued one$/ })).toBeDefined()
  })

  test('retire_workers removes a finished clean session on request and refuses the rest; typing a prompt removes nothing', { options: OPTIONS }, async ($, on) => {
    const finished = { title: 'finished clean', session_id: 'f1f1f1f1-0000-4000-8000-000000000001', config_dir: '/fixture/lic/a', reported: false, outcome: { kind: 'clean', summary: 'clean: done' } }
    const w = world(on, '/fixture/lic/a\n', true, JSON.stringify([...JSON.parse(REGISTRY_TEXT), finished]))
    on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
    await $.session.start(start(ORCH_DIR))
    // The cleared log is written before the registry, so a log write marks a removal.
    const clears = () => w.writes.filter(one => one.path.endsWith('/cleared.jsonl'))
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } } as never)
    expect(clears().length).toBe(0)
    const out = await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: [finished.session_id.slice(0, 8), 'aaaaaaaa'] } as never)
    expect(String(out.result)).toContain('Retired: f1f1f1f1.')
    expect(String(out.result)).toContain('its process is alive')
    expect(clears().length).toBe(1)
    expect(clears()[0]?.text.trimEnd().split('\n').map(line => JSON.parse(line).session_id)).toEqual([finished.session_id])
    expect(clears()[0]?.path).toBe(`${HOME}/.claude/session-control/runs/cleared.jsonl`)
    expect(lastRegistry(w).some(one => one.session_id === finished.session_id)).toBe(false)
    expect(lastRegistry(w).some(one => one.session_id === SID_ALIVE)).toBe(true)
  })

  test('open_point and record_decision edit the helper files, back them up first, and report a refusal', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    const added = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'add', id: 'fresh', title: 'T', detail: 'D', recommendation: 'R' } as never)
    expect(String(added.result)).toContain('open-points.json: added fresh.')
    const backup = w.writes.find(one => one.path.includes('/backups/open-points-before-open-point-'))
    expect(backup?.text).toBe(OPEN_POINTS_TEXT)
    const written = w.writes.find(one => one.path === `${ORCH_DIR}/open-points.json`)
    expect(JSON.parse(written?.text ?? '{}').points.some((p: { id: string }) => p.id === 'fresh')).toBe(true)
    const refused = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'close', id: 'nope', resolution: 'x' } as never)
    expect(JSON.stringify(refused)).toContain('no open point nope')
  })

  test('acknowledge_workers marks a finished session acknowledged, kept on request, and refuses a live one', { options: OPTIONS }, async ($, on) => {
    const finished = { title: 'finished clean', session_id: 'f2f2f2f2-0000-4000-8000-000000000002', config_dir: '/fixture/lic/a', reported: false, outcome: { kind: 'clean', summary: 'clean: done' } }
    const w = world(on, '/fixture/lic/a\n', true, JSON.stringify([...JSON.parse(REGISTRY_TEXT), finished]))
    await $.session.start(start(ORCH_DIR))
    const acks = () => w.writes.filter(one => one.path === REGISTRY_PATH)
    const before = acks().length
    const out = await $.tool.call({ tool: 'mcp__session-control__acknowledge_workers', session_ids: ['f2f2f2f2', 'aaaaaaaa'], keep: true } as never)
    expect(String(out.result)).toContain('Acknowledged and kept: f2f2f2f2.')
    expect(String(out.result)).toContain('its process is alive')
    expect(acks().length).toBe(before + 1)
    const after = lastRegistry(w)
    expect(after.find(one => one.session_id === finished.session_id)).toMatchObject({ reported: true, keep: true })
    expect(after.filter(one => one.reported === true && one.keep === true).map(one => one.session_id)).toEqual([finished.session_id])
  })

  test('seated inline the panel is one box behind tabs, at most 11 rows, and a tab switches the box', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    const ui = await $.ui.mount({
      plugin: 'session-control',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'session-control',
      props: { ...PANE_PROPS, placement: 'inline', scroll: { offset: 0, bodyRows: 40 } } as never,
    })
    const all = async () => String(((await ui.findAll({}))[0] as { text?: string }).text)
    expect(await all()).toContain('[ Sessions 7 ]')
    expect(await all()).toContain('Queued 1')
    expect(await all()).toContain('Open points 2')
    expect(await all()).toContain('alive worker')
    expect(await all()).not.toContain('QUEUED WORK')
    await ui.press({ key: 'tab:points' })
    expect(await all()).toContain('1. First question')
    expect(await all()).not.toContain('alive worker')
    await ui.press({ key: 'tab:queue' })
    expect(await all()).toContain('Queued one')
    // A session log opens in the same box; the Sessions tab closes it.
    await ui.press({ key: 'tab:sessions' })
    await ui.press({ key: 's:aaaaaaaa-1111-4111-8111-111111111111' })
    expect(await all()).toContain('Reading the suite files')
    expect(await all()).not.toContain('alive worker')
    await ui.press({ key: 'tab:sessions' })
    expect(await all()).not.toContain('Reading the suite files')
    expect(await all()).toContain('alive worker')
  })
})

describe('expanding a section', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  /** The sections as drawn, top to bottom: a bordered box by its title and height, a one-line header by its title and 1. */
  const layoutOf = async (ui: Ui) =>
    (await ui.findAll({ type: 'Box' }))
      .filter(box => box.props.borderStyle === 'round' || box.key?.startsWith('h:') === true)
      .map(box => [/^(SESSIONS|QUEUED WORK|OPEN POINTS|LOG)/.exec(box.text)?.[1], box.props.height])
  /** The one-line headers drawn: each one's whole text (title and icon). */
  const headersOf = async (ui: Ui) => (await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('h:') === true).map(box => box.text)
  const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
  const THREE = [['SESSIONS', 12], ['QUEUED WORK', 12], ['OPEN POINTS', 12]]
  const EXPANDED = {
    sessions: [['SESSIONS', 34], ['QUEUED WORK', 1], ['OPEN POINTS', 1]],
    queue: [['SESSIONS', 1], ['QUEUED WORK', 34], ['OPEN POINTS', 1]],
    points: [['SESSIONS', 1], ['QUEUED WORK', 1], ['OPEN POINTS', 34]],
  }
  const open = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On) => {
    world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    return mountPane($)
  }

  test('the panel starts with three equal boxes, each header holding an expand icon, and no one-line header', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    expect(await layoutOf(ui)).toEqual(THREE)
    expect(await headersOf(ui)).toEqual([])
    for (const id of ['sessions', 'queue', 'points']) expect((await ui.find({ key: `x:${id}` }))?.props.label).toBe('[+]')
  })

  test('each icon expands its section, the other two stay in order as one-line headers with their icons; pressed again it restores the three boxes', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    for (const [id, title] of [['sessions', 'SESSIONS'], ['queue', 'QUEUED WORK'], ['points', 'OPEN POINTS']] as const) {
      await ui.press({ key: `x:${id}` })
      expect(await layoutOf(ui)).toEqual(EXPANDED[id])
      expect((await ui.find({ key: `x:${id}` }))?.props.label).toBe('[-]')
      const others = THREE.map(one => one[0] as string).filter(one => one !== title)
      expect(await headersOf(ui)).toEqual(others.map(other => `${other}[+]`))
      for (const other of (['sessions', 'queue', 'points'] as const).filter(one => one !== id)) {
        expect((await ui.find({ key: `x:${other}` }))?.props.label).toBe('[+]')
      }
      await ui.press({ key: `x:${id}` })
      expect(await layoutOf(ui)).toEqual(THREE)
      expect(await headersOf(ui)).toEqual([])
    }
  })

  test('a header icon expands its section directly: the expanded one collapses to its header, one section at a time', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'x:sessions' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.sessions)
    await ui.press({ key: 'x:queue' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.queue)
    expect((await ui.find({ key: 'x:queue' }))?.props.label).toBe('[-]')
    expect((await ui.find({ key: 'x:sessions' }))?.props.label).toBe('[+]')
    await ui.press({ key: 'x:points' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.points)
    await ui.press({ key: 'x:sessions' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.sessions)
    expect(await ui.findAll({ type: 'Button', text: '[-]' })).toHaveLength(1)
    await ui.press({ key: 'x:sessions' })
    expect(await layoutOf(ui)).toEqual(THREE)
  })

  test('opening a session log from the expanded sessions box resets to sessions one third, log two thirds', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: 'x:sessions' })
    await ui.press({ key: `s:${SID}` })
    expect(await layoutOf(ui)).toEqual([['SESSIONS', 12], ['LOG', 24]])
    expect(await headersOf(ui)).toEqual([])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    expect((await ui.find({ key: 'x:sessions' }))?.props.label).toBe('[+]')
    // The expanded state is cleared: closing the log shows the three boxes again.
    await ui.press({ key: `s:${SID}` })
    expect(await layoutOf(ui)).toEqual(THREE)
  })

  test('the sessions icon in the log view closes the log and expands the sessions; the open-point click still works expanded', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    await ui.press({ key: `s:${SID}` })
    expect(await layoutOf(ui)).toEqual([['SESSIONS', 12], ['LOG', 24]])
    await ui.press({ key: 'x:sessions' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.sessions)
    await ui.press({ key: 'x:points' })
    await ui.press({ key: 'p:a:0' })
    expect(String(((await ui.findAll({}))[0] as { text?: string }).text)).toContain('Detail one')
  })

  test('a panel shown again, after the command hid it or the close mark closed it, starts with no section expanded', { options: OPTIONS }, async ($, on) => {
    world(on)
    let isUp = false
    on('ui.open', () => {
      isUp = true
      return { value: { isPlaced: true } } as never
    })
    on('ui.panes', () => ({ value: isUp ? [{ id: 'session-control' }] : [] }) as never)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    const ui = await mountPane($)
    await ui.press({ key: 'x:points' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.points)
    expect((await $.command.run({ command: 'session-control', args: 'side' } as never)).text).toBe('Session-control panel hidden, session-control stays on.')
    await ui.unmount()
    isUp = false
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    const again = await mountPane($)
    expect(await layoutOf(again)).toEqual(THREE)
    await again.press({ key: 'x:queue' })
    // The engine's close mark closes the pane without the command: the next show still starts collapsed.
    await again.unmount()
    isUp = false
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    expect(await layoutOf(await mountPane($))).toEqual(THREE)
  })
})

describe('row hover', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
  /**
   * Every pressable row of the sessions and open points: its label fills the rows' column, the box's inner width
   * less the scroll bar, so the light under the pointer spans the row and not only its text. (The mock leaves out
   * `hover`: the scroll-bar cell lit with its row is seen in the real engine only.)
   */
  const expectFullRows = async (ui: Ui, fill: number) => {
    const rows = (await ui.findAll({ type: 'Button' })).filter(one => /^[sp]:/.test(one.key ?? ''))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect([row.key, String(row.props.label).length]).toEqual([row.key, fill])
    return rows
  }
  const open = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On, props = PANE_PROPS) => {
    world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: 'side' } as never)
    return $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: props as never })
  }

  test('docked, every pressable row spans its box to the scroll bar, in the three boxes, each expanded section and the log view', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    // 120 body columns: the box's two borders and the scroll bar leave 117 for the rows.
    const keys = (await expectFullRows(ui, 117)).map(one => one.key)
    expect(keys).toContain(`s:${SID}`)
    expect(keys).toContain('p:a:0')
    await ui.press({ key: 'p:a:0' })
    expect((await expectFullRows(ui, 117)).some(one => /^p:a:t:/.test(one.key ?? ''))).toBe(true)
    for (const id of ['sessions', 'points']) {
      await ui.press({ key: `x:${id}` })
      await expectFullRows(ui, 117)
      await ui.press({ key: `x:${id}` })
    }
    await ui.press({ key: `s:${SID}` })
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    await expectFullRows(ui, 117)
    // The padding is trailing: the row still reads and presses as before.
    expect(String((await ui.find({ key: `s:${SID}` }))?.props.label)).toMatch(/^\u25B8 alive worker/)
  })

  test('seated inline, with no border, a pressable row spans the body to the scroll bar', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on, { ...PANE_PROPS, placement: 'inline', scroll: { offset: 0, bodyRows: 40 } })
    await expectFullRows(ui, 119)
    await ui.press({ key: 'tab:points' })
    await expectFullRows(ui, 119)
  })
})

describe('platform', () => {
  const args = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  /** A launch, an acknowledgement and a retirement, the probe text shown as <probe>. */
  const flow = async ($: Parameters<Parameters<typeof test>[2]>[0], w: World) => {
    await $.session.start(start(ORCH_DIR))
    expect(String((await $.tool.call({ tool: TOOL, ...args } as never)).result)).toContain('Launched pid 7001')
    expect(String((await $.tool.call({ tool: 'mcp__session-control__acknowledge_workers', session_ids: ['cccccccc'] } as never)).result)).toContain('Acknowledged: cccccccc.')
    expect(String((await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['dddddddd'] } as never)).result)).toContain('Retired: dddddddd.')
    return w.runs.map(argv => argv.map(one => (one === PROBE_SCRIPT ? '<probe>' : one)))
  }
  const probe = ['sh', '-c', '<probe>', 'session-probe', ...probeArgs(JSON.parse(REGISTRY_TEXT))]
  const rename = ['mv', '-f', `${REGISTRY_PATH}.tmp.${NOW_MS}`, REGISTRY_PATH]
  const RUNS = `${HOME}/.claude/session-control/runs`
  /** The commands the Linux flow runs, as recorded before the Windows branches existed (the jq calls aside). */
  const LINUX = [
    ['test', '-e', `${ORCH_DIR}/agreed-decisions.md`],
    ['mkdir', '-p', ORCH_DIR],
    ['test', '-e', `${ORCH_DIR}/open-points-archive.md`],
    ['mkdir', '-p', ORCH_DIR],
    ['mkdir', '-p', `${ORCH_DIR}/backups`, RUNS],
    probe,
    rename,
    probe,
    ['test', '-s', '/work/new/prompt.md'],
    ['test', '-d', '/work/new'],
    ['/fixture/bin/pick', '--need', '40'],
    ['mkdir', '-p', RUNS],
    ['sleep', '2'],
    probe,
    rename,
    probe,
    probe,
    rename,
    probe,
    probe,
    ['sh', '-c', APPEND_SCRIPT, 'session-log', JSON.stringify(JSON.parse(REGISTRY_TEXT).find((one: { session_id?: string }) => one.session_id === SID_DONE)), `${RUNS}/cleared.jsonl`],
    rename,
    probe,
  ]
  const linuxLike: [string, Record<string, string>][] = [
    ['HOME only', { HOME }],
    ['HOME and a Windows USERPROFILE (WSL)', { HOME, USERPROFILE: 'C:\\Users\\u' }],
    ['OS=Windows_NT without USERPROFILE', { HOME, OS: 'Windows_NT' }],
    ['OS=Windows_NT with a USERPROFILE that is no drive path', { HOME, OS: 'Windows_NT', USERPROFILE: '/mnt/c/Users/u' }],
  ]
  for (const [name, env] of linuxLike) {
    test(`Linux commands, unchanged: ${name}`, { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, env)
      expect(await flow($, w)).toEqual(LINUX)
    })
  }

  // The flow recorded with the trace off, for the test after it.
  const recorded: { off?: { runs: string[][]; writes: World['writes']; reads: string[] } } = {}
  test('Linux, the trace off: a launch, an acknowledgement and a retirement, recorded', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    expect(await flow($, w)).toEqual(LINUX)
    recorded.off = { runs: w.runs, writes: w.writes, reads: w.reads }
  })

  test('Linux, the trace on: the same commands, writes and reads as with it off, less the trace appends', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on)
    const runs = await flow($, w)
    expect(runs.filter(isTraceRun).length).toBeGreaterThan(0)
    expect(runs.filter(argv => !isTraceRun(argv))).toEqual(LINUX)
    expect(recorded.off).toBeDefined()
    expect(w.runs.filter(argv => !isTraceRun(argv))).toEqual(recorded.off?.runs ?? [])
    expect(w.writes.filter(one => !one.path.endsWith('/trace.log'))).toEqual(recorded.off?.writes ?? [])
    expect(w.reads).toEqual(recorded.off?.reads ?? [])
  })

  const WINDOWS_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' }
  const WIN_OPTIONS = { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}` }
  const WIN_REGISTRY = `C:${REGISTRY_PATH}`
  const WIN_RUNS = `C:${RUNS}`

  test('Windows: home is the profile folder in native form, and a rename runs the file script', { options: WIN_OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
    await $.session.start(start(`C:${ORCH_DIR}`))
    expect(w.runs).toContainEqual([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/files.ps1`, 'move', `${WIN_REGISTRY}.tmp.${NOW_MS}`, WIN_REGISTRY])
    expect(w.writes.find(one => one.path.endsWith(`${WIN_RUNS}/files.ps1`))?.text).toBe(FILES_PS1)
    expect(lastRegistry(w).find(one => one.session_id === SID_DEAD)?.reported).toBe(false)
    // No POSIX tool is started for the files: they are written through $.fs, which makes their directories.
    expect(w.runs.filter(argv => ['mv', 'rm', 'test', 'mkdir'].includes(String(argv[0])))).toEqual([])
    expect(w.writes.some(one => one.path.endsWith(`C:${ORCH_DIR}/agreed-decisions.md`))).toBe(true)
  })

  test('Windows: the probe is PROBE_PS1 run as a file, with the registry\'s pids and transcripts', { options: WIN_OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
    stubPanel(on)
    await $.session.start(start(`C:${ORCH_DIR}`))
    expect(w.runs[0]).toEqual([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/probe.ps1`, ...probeArgs(JSON.parse(REGISTRY_TEXT))])
    expect(w.writes.find(one => one.path.endsWith(`${WIN_RUNS}/probe.ps1`))?.text).toBe(PROBE_PS1)
    expect(w.runs.filter(argv => argv[0] === 'sh')).toEqual([])
    // The dead worker is harvested, the live one shows as running with its elapsed time.
    expect(w.toasts).toEqual(['Usage limit reached \u00B7 session-control: limited worker: limit: rate limit hit'])
    await $.command.run({ command: 'session-control', args: '' } as never)
    const all = String(((await (await mountPane($)).findAll({}))[0] as { text?: string }).text ?? '')
    expect(all).toMatch(/alive worker\s+aaaaaaaa\s+running\s+opus\s+high\s+2m/)
  })

  test('Windows, the trace on: a poll tick with a failing probe writes its lines through the file script', { options: { ...WIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
    await $.session.start(start(`C:${ORCH_DIR}`))
    const trace = `${WIN_RUNS}/trace.log`
    expect(traceOf(w, trace)[0]).toMatchObject({ event: 'session.start', platform: 'windows' })
    WINDOWS.isProbeBroken = true
    try {
      const before = traceOf(w, trace).length
      await w.clock.advance(5000)
      // The probe's stderr is output: the trace has its size, and the error that quotes it has … in its place.
      const message = 'the process probe failed (exit 1): \u2026'
      const probe = [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/probe.ps1`, ...probeArgs(JSON.parse(REGISTRY_TEXT))]
      expect(bare(traceOf(w, trace)).slice(before)).toEqual([
        { event: 'poll.tick' },
        { event: 'process.run', argv: probe, exitCode: 1, ms: 0, stderrBytes: 'Invalid class'.length },
        { event: 'error', where: 'refresh', kind: 'exit-1', message },
        { event: 'error', where: 'panel', kind: 'exit-1', message: `Error: ${message}` },
      ])
      expect(w.writes.filter(one => one.path === trace).some(one => one.text.includes('Invalid class'))).toBe(false)
      // Each flush is one append of the file script, from a file of its own.
      expect(w.runs.filter(isTraceRun).every(argv => String(argv[8]).startsWith(`${trace}.add.`))).toBe(true)
    } finally {
      WINDOWS.isProbeBroken = false
    }
  })

  test('Windows: a probe that fails is an error on the panel, and no worker is taken for dead', { options: WIN_OPTIONS }, async ($, on) => {
    WINDOWS.isProbeBroken = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      expect(w.toasts).toEqual(['Tracking problem \u00B7 session-control: Error: the process probe failed (exit 1): Invalid class'])
      expect(w.writes.some(one => fixture(one.path).startsWith(REGISTRY_PATH))).toBe(false)
    } finally {
      WINDOWS.isProbeBroken = false
    }
  })

  /** A call that waits on $.clock.sleep: the mocked clock is moved on until it settles. */
  const settled = async <T>(w: World, pending: Promise<T>): Promise<T> => {
    let isDone = false
    void pending.then(
      () => (isDone = true),
      () => (isDone = true),
    )
    for (let step = 0; step < 90 && !isDone; step++) await w.clock.advance(1000)
    return pending
  }
  const winArgs = { dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  const WIN_HOME_CLAUDE = 'C:/fixture/home/.claude'
  const NO_PICKER = { ...WIN_OPTIONS, licencePickCommand: '' }

  test('Windows: a launch given /c/ paths runs native paths, no POSIX tool, finds the worker and registers it', { options: NO_PICKER }, async ($, on) => {
    const w = world(on, '', true, REGISTRY_TEXT, WINDOWS_ENV)
    await $.session.start(start(`C:${ORCH_DIR}`))
    const out = await settled(w, $.tool.call({ tool: TOOL, ...winArgs } as never))
    expect(String(out.result)).toBe(
      `Launched pid 7001, session abcdabcd-0000-4000-8000-000000000001, config_dir ${WIN_HOME_CLAUDE}, registered. ` +
        `Result: ${WIN_RUNS}/20260921141320-new.json; errors: ${WIN_RUNS}/20260921141320-new.err.`,
    )
    expect(w.bash[0]?.command).toBe(
      `cd 'C:/work/new' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --dangerously-skip-permissions --output-format json ` +
        `-- "$(cat 'C:/work/new/prompt.md')" > '${WIN_RUNS}/20260921141320-new.json' 2> '${WIN_RUNS}/20260921141320-new.err'`,
    )
    expect(lastRegistry(w).at(-1)).toEqual({
      title: 'new',
      pid: 7001,
      session_id: 'abcdabcd-0000-4000-8000-000000000001',
      config_dir: WIN_HOME_CLAUDE,
      cwd: 'C:/work/new',
      model: 'opus',
      effort: 'high',
      result_file: `${WIN_RUNS}/20260921141320-new.json`,
      err_file: `${WIN_RUNS}/20260921141320-new.err`,
    })
    // Every command is Windows PowerShell running one of the mod's scripts; the launch's probes also search its config dir.
    expect(w.runs.every(argv => argv[0] === POWERSHELL && /\/(probe|files)\.ps1$/.test(String(argv[6])))).toBe(true)
    expect(w.runs.some(argv => String(argv[6]).endsWith('/probe.ps1') && argv.at(-1) === `c:${WIN_HOME_CLAUDE}`)).toBe(true)
  })

  test('Windows: an orchestrator with its own CLAUDE_CONFIG_DIR: no variable on the line, its dir in native form in the registry', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\a'
    try {
      const w = world(on, '', true, REGISTRY_TEXT, { ...WINDOWS_ENV, CLAUDE_CONFIG_DIR: 'C:\\fixture\\lic\\a\\' })
      await $.session.start(start(`C:${ORCH_DIR}`))
      const out = await settled(w, $.tool.call({ tool: TOOL, ...winArgs } as never))
      expect(String(out.result)).toContain('config_dir C:/fixture/lic/a, registered.')
      expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, config_dir: 'C:/fixture/lic/a' })
    } finally {
      WINDOWS.workerConfigDir = 'C:\\fixture\\home\\.claude'
    }
  })

  test('Windows: without a Bash tool (Git Bash not found) the refusal says how to give the engine Git Bash', { options: NO_PICKER }, async ($, on) => {
    WORKER.isBashMissing = true
    try {
      const w = world(on, '', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      const out = await $.tool.call({ tool: TOOL, ...winArgs } as never)
      expect(String(out.deny)).toContain('nothing was launched. On Windows Claude Code offers the Bash tool only when it finds Git Bash: start the orchestrator with CLAUDE_CODE_GIT_BASH_PATH set to Git\\bin\\bash.exe.')
      expect(w.bash.length).toBe(0)
    } finally {
      WORKER.isBashMissing = false
    }
  })

  test('Windows: a new claude.exe whose sessions file the probe found nowhere is still the worker', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.isWorkerUnplaced = true
    try {
      const w = world(on, '', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      const out = await settled(w, $.tool.call({ tool: TOOL, ...winArgs } as never))
      expect(String(out.result)).toContain('Launched pid 7001, session abcdabcd-0000-4000-8000-000000000001')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, cwd: 'C:/work/new', config_dir: WIN_HOME_CLAUDE })
    } finally {
      WINDOWS.isWorkerUnplaced = false
    }
  })

  test('Windows: a picker named by absolute path runs, and its answer is taken in native form', { options: { ...WIN_OPTIONS, licencePickCommand: 'C:/fixture/bin/pick.exe --need {need}' } }, async ($, on) => {
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\a'
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      const out = await settled(w, $.tool.call({ tool: TOOL, ...winArgs, need: 25 } as never))
      expect(w.runs).toContainEqual(['C:/fixture/bin/pick.exe', '--need', '25'])
      expect(String(out.result)).toContain('config_dir C:/fixture/lic/a, registered')
      expect(String(w.bash[0]?.command)).toContain("CLAUDE_CONFIG_DIR='C:/fixture/lic/a'")
    } finally {
      WINDOWS.workerConfigDir = 'C:\\fixture\\home\\.claude'
    }
  })

  test('Windows: a picker by bare name is refused before anything runs', { options: { ...WIN_OPTIONS, licencePickCommand: 'pick --need {need}' } }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
    await $.session.start(start(`C:${ORCH_DIR}`))
    const out = await $.tool.call({ tool: TOOL, ...winArgs } as never)
    expect(String(out.deny)).toBe('session-control: refused: on Windows the licence picker command must start with the absolute path of an executable (C:/.../picker.exe), not "pick"')
    expect(w.runs.some(argv => argv[0] === 'pick')).toBe(false)
    expect(w.bash.length).toBe(0)
  })

  test('Windows: a prompt too long for the command line is refused, a POSIX path too', { options: NO_PICKER }, async ($, on) => {
    const w = world(on, '', true, REGISTRY_TEXT, WINDOWS_ENV)
    await $.session.start(start(`C:${ORCH_DIR}`))
    const big = await $.tool.call({ tool: TOOL, ...winArgs, prompt_file: '/c/work/new/big.md' } as never)
    expect(String(big.deny)).toContain(`it has ${BIG_PROMPT.length}, the limit is 30000`)
    const posix = await $.tool.call({ tool: TOOL, ...winArgs, dir: '/tmp/new' } as never)
    expect(String(posix.deny)).toBe('session-control: dir must be absolute (on Windows /c/... or C:/...)')
    const gone = await $.tool.call({ tool: TOOL, ...winArgs, dir: '/c/work/gone' } as never)
    expect(String(gone.deny)).toBe('session-control: refused: directory C:/work/gone does not exist')
    expect(w.bash.length).toBe(0)
  })

  test('Windows: an empty prompt file is told by $.fs.stat', { options: NO_PICKER }, async ($, on) => {
    const w = world(on, '', false, REGISTRY_TEXT, WINDOWS_ENV)
    await $.session.start(start(`C:${ORCH_DIR}`))
    expect(String((await $.tool.call({ tool: TOOL, ...winArgs } as never)).deny)).toBe('session-control: refused: prompt file C:/work/new/prompt.md is missing or empty')
    expect(w.bash.length).toBe(0)
  })

  test('Windows: a session\'s output box reads its transcript, past the read cap through the file script', { options: WIN_OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
    stubPanel(on)
    await $.session.start(start(`C:${ORCH_DIR}`))
    await $.command.run({ command: 'session-control', args: '' } as never)
    const ui = await mountPane($)
    await ui.press({ key: `s:${SID_ALIVE}` })
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    expect(w.runs).toContainEqual([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/files.ps1`, 'tail', `/fixture/lic/a/projects/-work-a/${SID_ALIVE}.jsonl`, '600', '20000'])
  })

  const retireDone = async ($: Parameters<Parameters<typeof test>[2]>[0]) =>
    String((await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['dddddddd'] } as never)).result)
  const doneLine = JSON.stringify(JSON.parse(REGISTRY_TEXT).find((one: { session_id?: string }) => one.session_id === SID_DONE))

  test('Linux: a retire appends to the cleared log in one append, and a log over the read cap does not stop it', { options: OPTIONS }, async ($, on) => {
    const log = `${RUNS}/cleared.jsonl`
    UNREADABLE.add(log)
    try {
      const w = world(on)
      await $.session.start(start(ORCH_DIR))
      expect(await retireDone($)).toBe('Retired: dddddddd.')
      expect(w.runs.filter(argv => argv[2] === APPEND_SCRIPT)).toEqual([['sh', '-c', APPEND_SCRIPT, 'session-log', doneLine, log]])
      expect(APPEND_SCRIPT).toBe(`printf '%s\\n' "$1" >> "$2"`)
      // Logged first, then the registry without the entry.
      const at = (match: (argv: string[]) => boolean) => w.runs.findIndex(match)
      expect(at(argv => argv[2] === APPEND_SCRIPT)).toBeLessThan(w.runs.findLastIndex(argv => argv[0] === 'mv'))
      expect(lastRegistry(w).some(one => one.session_id === SID_DONE)).toBe(false)
    } finally {
      UNREADABLE.clear()
    }
  })

  test('Windows: a retire appends through the file script, never reading the log, even one over the read cap', { options: WIN_OPTIONS }, async ($, on) => {
    const log = `${WIN_RUNS}/cleared.jsonl`
    UNREADABLE.add(fixture(log))
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      expect(await retireDone($)).toBe('Retired: dddddddd.')
      const added = `${log}.add.${NOW_MS}`
      expect(w.runs.filter(argv => argv[7] === 'append')).toEqual([[POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/files.ps1`, 'append', added, log]])
      expect(w.writes.find(one => one.path === added)?.text).toBe(`${doneLine}\n`)
      expect(w.writes.filter(one => one.path === log).map(one => one.text)).toEqual([`${doneLine}\n`])
      expect(lastRegistry(w).some(one => one.session_id === SID_DONE)).toBe(false)
    } finally {
      UNREADABLE.clear()
    }
  })

  test('Windows: after a failed rename the temp file is removed by the script\'s remove', { options: WIN_OPTIONS }, async ($, on) => {
    WINDOWS.isMoveBroken = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      const tmp = `${WIN_REGISTRY}.tmp.${NOW_MS}`
      expect(w.runs).toContainEqual([POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/files.ps1`, 'remove', tmp])
      expect(w.writes.filter(one => one.path === tmp).map(one => one.text === '')).toEqual([false])
    } finally {
      WINDOWS.isMoveBroken = false
    }
  })

  test('Windows: when the file script cannot run at all, the registry is written directly and the temp file emptied, and the toast says so', { options: WIN_OPTIONS }, async ($, on) => {
    WINDOWS.isScriptBroken = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      const tmp = `${WIN_REGISTRY}.tmp.${NOW_MS}`
      expect(lastRegistry(w).find(one => one.session_id === SID_DEAD)?.reported).toBe(false)
      const order = w.writes.map(one => (one.path === WIN_REGISTRY ? 'registry' : one.path === tmp ? (one.text === '' ? 'emptied' : 'temp') : '')).filter(Boolean)
      expect(order).toEqual(['temp', 'registry', 'emptied'])
      expect(w.toasts.filter(text => text.includes('not atomically'))).toEqual([
        `Write not atomic \u00B7 session-control: the rename failed (Access denied.); ${WIN_REGISTRY} was written directly, not atomically; the temp file ${tmp} could not be removed and was emptied`,
      ])
    } finally {
      WINDOWS.isScriptBroken = false
    }
  })

  test('Windows: a HOME that Git Bash handed on (/c/...) is home, in native form', { options: WIN_OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { ...WINDOWS_ENV, USERPROFILE: 'C:\\Users\\other', HOME: '/c/fixture/home' })
    await $.session.start(start(`C:${ORCH_DIR}`))
    expect(w.runs.some(argv => argv[0] === POWERSHELL && argv.at(-1) === WIN_REGISTRY)).toBe(true)
  })

  test('Windows: a rename that fails writes the file directly and says so once', { options: WIN_OPTIONS }, async ($, on) => {
    WINDOWS.isMoveBroken = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, WINDOWS_ENV)
      await $.session.start(start(`C:${ORCH_DIR}`))
      expect(w.writes.some(one => one.path.endsWith(WIN_REGISTRY))).toBe(true)
      expect(lastRegistry(w).find(one => one.session_id === SID_DEAD)?.reported).toBe(false)
      await $.tool.call({ tool: 'mcp__session-control__acknowledge_workers', session_ids: ['cccccccc'] } as never)
      expect(w.toasts.filter(text => text.includes('not atomically'))).toEqual([`Write not atomic \u00B7 session-control: the rename failed (Access denied.); ${WIN_REGISTRY} was written directly, not atomically`])
    } finally {
      WINDOWS.isMoveBroken = false
    }
  })
})

describe('debug trace', () => {
  const args = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  // The call's line: the title is free text and stays out.
  const { title: _title, ...called } = args
  const PICK = { event: 'process.run', picker: 'pick', args: 2, exitCode: 0, ms: 0 }
  const TRACED = { ...OPTIONS, debug: true }
  const RUNS = `${HOME}/.claude/session-control/runs`
  const tmp = `${REGISTRY_PATH}.tmp.${NOW_MS}`
  const ran = (argv: string[], exitCode = 0) => ({ event: 'process.run', argv, exitCode, ms: 0 })
  const PROBE = ran(['sh', '-c', '<PROBE_SCRIPT>', 'session-probe', ...probeArgs(JSON.parse(REGISTRY_TEXT))])
  const registryWrite = (w: World) => ({ event: 'fs.write', path: tmp, bytes: w.writes.filter(one => one.path === tmp).at(-1)?.text.length })

  test('a launch: the call, the probe, the checks, the verdict, the worker and its registration, the answer', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    const out = await $.tool.call({ tool: TOOL, ...args } as never)
    const stamp = new Date(NOW_MS).toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const sid = 'abcdabcd-0000-4000-8000-000000000001'
    expect(from(bare(traceOf(w)), 'tool.call')).toEqual([
      { event: 'tool.call', tool: 'launch_worker', ...called },
      PROBE,
      ran(['test', '-s', '/work/new/prompt.md']),
      ran(['test', '-d', '/work/new']),
      PICK,
      { event: 'guard', tool: 'launch_worker', isOk: true, configDir: '/fixture/lic/a' },
      ran(['mkdir', '-p', RUNS]),
      { event: 'worker.start', configDir: '/fixture/lic/a', isConfigDirSet: true, resultFile: `${RUNS}/${stamp}-new.json`, errFile: `${RUNS}/${stamp}-new.err`, timeoutMs: 180 * 60_000 },
      ran(['sleep', '2']),
      PROBE,
      { event: 'worker.found', pid: 7001, sessionId: sid },
      registryWrite(w),
      ran(['mv', '-f', tmp, REGISTRY_PATH]),
      { event: 'worker.registered', pid: 7001, sessionId: sid, isRegistered: true },
      PROBE,
      { event: 'tool.result', tool: 'launch_worker', result: String(out.result) },
    ])
    // The trace is written in one append per hook: session.start's and the launch's.
    expect(w.runs.filter(isTraceRun).length).toBe(2)
    // Neither the title nor the picker's command line is in it.
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('"title"') || one.text.includes('/fixture/bin/pick'))).toBe(false)
  })

  test('a launch without a picker: options say empty, the verdict names the default dir, the worker line sets no variable', { options: { ...TRACED, licencePickCommand: '' } }, async ($, on) => {
    WORKER.linuxConfigDir = ''
    try {
      const w = world(on, '')
      await $.session.start(start(ORCH_DIR))
      await $.tool.call({ tool: TOOL, ...args } as never)
      const lines = bare(traceOf(w))
      expect((lines.find(one => one.event === 'session.start') as { options?: { licencePickCommand?: string } }).options?.licencePickCommand).toBe('empty')
      expect(lines.find(one => one.event === 'tool.call')).toEqual({ event: 'tool.call', tool: 'launch_worker', ...called })
      expect(lines.find(one => one.event === 'guard')).toEqual({ event: 'guard', tool: 'launch_worker', isOk: true, configDir: `${HOME}/.claude` })
      expect(lines.find(one => one.event === 'worker.start')).toMatchObject({ event: 'worker.start', configDir: `${HOME}/.claude`, isConfigDirSet: false })
      expect(lines.some(one => one.event === 'process.run' && 'picker' in one)).toBe(false)
    } finally {
      WORKER.linuxConfigDir = '/fixture/lic/a'
    }
  })

  test('the start: platform, options and the activation, no environment', { options: TRACED }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SECRET_THING: 'sk-should-never-appear-1234' })
    await $.session.start(start(ORCH_DIR))
    const [first] = bare(traceOf(w))
    expect(first).toEqual({
      event: 'session.start',
      cwd: ORCH_DIR,
      platform: 'linux',
      isOrchestratorDir: true,
      options: { orchestratorDir: ORCH_DIR, registryPath: '~/.claude/headless-sessions.json', completionWrites: true, pollSeconds: 5, runsDir: '~/.claude/session-control/runs', licencePickCommand: 'set', debug: true },
    })
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('sk-should') || one.text.includes(HOME + '"') || one.text.includes('/fixture/bin/pick'))).toBe(false)
  })

  test('a refused launch: the verdict with its reason, and the refusal the model gets', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    await $.tool.call({ tool: TOOL, ...args, dir: ORCH_DIR } as never)
    expect(from(bare(traceOf(w)), 'tool.call')).toEqual([
      { event: 'tool.call', tool: 'launch_worker', ...called, dir: ORCH_DIR },
      PROBE,
      ran(['test', '-s', '/work/new/prompt.md']),
      ran(['test', '-d', ORCH_DIR]),
      PICK,
      { event: 'guard', tool: 'launch_worker', isOk: false, reason: 'refused: cwd is the orchestrator dir' },
      { event: 'tool.result', tool: 'launch_worker', deny: 'session-control: refused: cwd is the orchestrator dir' },
    ])
  })

  test('a retire: the verdict, the cleared-log append by size, the registry write, the answer', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await $.session.start(start(ORCH_DIR))
    await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['dddddddd'] } as never)
    const doneLine = JSON.stringify(JSON.parse(REGISTRY_TEXT).find((one: { session_id?: string }) => one.session_id === SID_DONE))
    expect(from(bare(traceOf(w)), 'tool.call')).toEqual([
      { event: 'tool.call', tool: 'retire_workers', session_ids: ['dddddddd'] },
      PROBE,
      { event: 'guard', tool: 'retire_workers', removable: [SID_DONE], refused: [] },
      ran(['sh', '-c', '<APPEND_SCRIPT>', 'session-log', `<${doneLine.length + 1} bytes>`, `${RUNS}/cleared.jsonl`]),
      { event: 'fs.append', path: `${RUNS}/cleared.jsonl`, bytes: doneLine.length + 1, lines: 1, exitCode: 0 },
      registryWrite(w),
      ran(['mv', '-f', tmp, REGISTRY_PATH]),
      PROBE,
      { event: 'tool.result', tool: 'retire_workers', result: 'Retired: dddddddd.' },
    ])
    // The entry's content is in the cleared log, never in the trace.
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('done worker'))).toBe(false)
  })

  test('a poll tick with a failing probe: the tick, the failed run, the error caught, the warning; renders are counted', { options: TRACED }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await $.session.start(start(ORCH_DIR))
    await $.command.run({ command: 'session-control', args: '' } as never)
    const ui = await mountPane($)
    await ui.findAll({})
    LINUX_FIXTURE.isProbeBroken = true
    try {
      const before = traceOf(w).length
      await w.clock.advance(5000)
      const tick = bare(traceOf(w)).slice(before)
      // The kit rejects the run of a fixture hook that throws as having no implementation: that is what the mod sees.
      const message = 'no implementation for process.run'
      expect(tick).toEqual([
        { event: 'ui.render', count: 1 },
        { event: 'poll.tick' },
        { event: 'process.run', argv: PROBE.argv, ms: 0, error: message },
        { event: 'error', where: 'refresh', message },
        { event: 'error', where: 'panel', message: `HooksError: ${message}` },
      ])
    } finally {
      LINUX_FIXTURE.isProbeBroken = false
    }
  })

  test('SESSION_CONTROL_DEBUG=1 switches it on; otherwise nothing is written and no trace command runs', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SESSION_CONTROL_DEBUG: '1' })
    await $.session.start(start(ORCH_DIR))
    expect(traceOf(w)[0]?.event).toBe('session.start')
  })

  test('an environment that cannot be read leaves the trace off and the start goes on', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME }, true)
    let isAsked = false
    on('env.get', ($, e) => {
      if (!JSON.stringify(e).includes('SESSION_CONTROL_DEBUG')) return { value: JSON.stringify(e).includes('"HOME"') ? HOME : undefined } as never
      isAsked = true
      throw new Error('the environment cannot be read')
    })
    await $.session.start(start(ORCH_DIR))
    expect(isAsked).toBe(true)
    expect(w.registered).toContain('launch_worker')
    expect(w.writes.some(one => one.path.includes('trace.log'))).toBe(false)
    expect(w.runs.some(isTraceRun)).toBe(false)
  })

  // A worker inherits SESSION_CONTROL_DEBUG; with the debug option on a machine the option is on for every session.
  for (const [name, options, env] of [
    ['SESSION_CONTROL_DEBUG=1', OPTIONS, { HOME, SESSION_CONTROL_DEBUG: '1' }],
    ['the debug option', TRACED, { HOME }],
    ['the debug option, no orchestratorDir option', { ...TRACED, orchestratorDir: '' }, { HOME }],
  ] as const) {
    test(`outside the orchestrator directory nothing is traced and no runs directory is made: ${name}`, { options }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, env)
      await $.session.start(start('/work/new'))
      expect(w.runs).toEqual([])
      expect(w.writes).toEqual([])
      expect(w.registered).toEqual(['/session-control'])
    })
  }

  test('/session-control turns the board on elsewhere: the trace starts there, with the start line', { options: TRACED }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await $.session.start(start('/work/elsewhere'))
    expect(w.writes.some(one => one.path === TRACE)).toBe(false)
    await $.command.run({ command: 'session-control', args: '' } as never)
    const [first, second] = bare(traceOf(w))
    expect(first).toMatchObject({ event: 'session.start', cwd: '/work/elsewhere', isOrchestratorDir: false })
    expect(second).toEqual({ event: 'command.run', command: 'session-control' })
  })

  test('off by default: no trace file, no trace command', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SESSION_CONTROL_DEBUG: '0' })
    await $.session.start(start(ORCH_DIR))
    await $.tool.call({ tool: TOOL, ...args } as never)
    expect(w.writes.some(one => one.path.includes('trace.log'))).toBe(false)
    expect(w.runs.some(isTraceRun)).toBe(false)
  })

  test('a trace that cannot be written breaks nothing and is toasted once', { options: TRACED }, async ($, on) => {
    LINUX_FIXTURE.isAppendBroken = true
    try {
      const w = world(on)
      await $.session.start(start(ORCH_DIR))
      const out = await $.tool.call({ tool: TOOL, ...args } as never)
      expect(String(out.result)).toContain('Launched pid 7001')
      expect(w.toasts.filter(text => text.includes('debug trace cannot be written'))).toEqual([
        'Debug trace failed \u00B7 session-control: the debug trace cannot be written (/fixture/home/.claude/session-control/runs/trace.log cannot be appended to (exit 1): sh: cannot create: Read-only file system); the mod goes on without it',
      ])
      // The runs directory is made once more before the second try of each append.
      expect(w.runs.filter(argv => argv[0] === 'mkdir' && argv[2] === RUNS).length).toBeGreaterThanOrEqual(2)
    } finally {
      LINUX_FIXTURE.isAppendBroken = false
    }
  })

  test('a trace near 2 MiB is rotated once before the next append', { options: TRACED }, async ($, on) => {
    LINUX_FIXTURE.traceSize = TRACE_MAX_BYTES - 10
    try {
      const w = world(on)
      await $.session.start(start(ORCH_DIR))
      await $.tool.call({ tool: TOOL, ...args } as never)
      const rotations = w.runs.filter(argv => argv[2] === ROTATE_SCRIPT)
      // The script reads the size again itself: it gets the limit and the bytes about to go in.
      expect(rotations.map(argv => argv.slice(0, 7))).toEqual([['sh', '-c', ROTATE_SCRIPT, 'session-trace', TRACE, '2', String(TRACE_MAX_BYTES)]])
      expect(Number(rotations[0]?.[7])).toBeGreaterThan(10)
      expect(w.runs.findIndex(argv => argv[2] === ROTATE_SCRIPT)).toBeLessThan(w.runs.findIndex(argv => argv[2] === APPEND_SCRIPT))
    } finally {
      LINUX_FIXTURE.traceSize = 0
    }
  })
})
