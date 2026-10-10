// Integration: the plugin's hooks against the engine's test kit. Every noun
// that would touch the machine (fs, process, env, clock) is answered by the
// test's own hooks from fixtures: no real registry, /proc or licence picker.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PROBE_SCRIPT, REGISTER_SCRIPT } from '../hooks/core'

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
  TASK_NOTIFICATION_KILLED,
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

function world(on: On, pickStdout = '/fixture/lic/a\n', promptFileExists = true, registryText = REGISTRY_TEXT): World {
  const w: World = { bash: [], spawned: false, writes: [], toasts: [], runs: [], registered: [], tools: [], clock: mock.clock(on, { now: NOW_MS }) }
  mock.env(on, { HOME })
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
    if (MISSING.has(e.path) || LATE.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    if (UNREADABLE.has(e.path)) throw new Error(`EFBIG ${e.path}`)
    if (e.path === REGISTRY_PATH) return { value: registryText }
    if (e.path === '/work/orch/CLAUDE.md') return { value: '# Role: Session Orchestrator\n' }
    if (e.path === '/work/new/thin.md') return { value: 'Just do the work.' }
    if (e.path === `${ORCH_DIR}/task-queue.json`) return { value: QUEUE_TEXT }
    if (e.path === `${ORCH_DIR}/open-points.json`) return { value: OPEN_POINTS_TEXT }
    if (e.path === '/fixture/results/limit.json') return { value: RESULTS.limit }
    if (e.path === '/fixture/lic/a/sessions/7001.json') return { value: JSON.stringify({ sessionId: 'abcdabcd-0000-4000-8000-000000000001', procStart: '123' }) }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  // A path the read above refuses is missing, unless it is one that cannot be read.
  on('fs.exists', ($, e) => ({ value: UNREADABLE.has(e.path) }))
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
    if (e.argv[0] === 'sh' && e.argv[2] === PROBE_SCRIPT) {
      const worker = w.spawned
        ? `\nP\t7001\tclaude\t3\t/work/new\t/fixture/lic/a\tclaude -p --model opus --dangerously-skip-permissions --output-format json -- prompt\n`
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
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
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
const lastRegistry = (w: World) => JSON.parse(w.writes.filter(one => one.path === REGISTRY_PATH).at(-1)?.text ?? '[]') as Record<string, unknown>[]
const PANE_PROPS = { title: 'Session control', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 36 } }

const stubPanel = (on: On) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
}
const mountPane = ($: Parameters<Parameters<typeof test>[2]>[0]) =>
  $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })

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
    expect(w.toasts.filter(text => text.startsWith('session-control:')).length).toBe(1)
    await $.command.run({ command: 'session-control', args: '' } as never)
    expect(w.toasts.filter(text => text.startsWith('session-control:')).length).toBe(1)
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
    expect(w.toasts).toEqual(['session-control: limited worker: limit: rate limit hit'])
    await w.clock.advance(5000)
    expect(regWrites().length).toBe(1)
    expect(w.writes.some(one => one.path.includes('/backups/headless-sessions-before-completion-'))).toBe(true)
  })

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

  test('without a licence picker command a fresh launch uses the default config directory and runs no picker', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
    const w = world(on, '')
    await $.session.start(start(ORCH_DIR))
    const out = await $.tool.call({ tool: TOOL, ...args } as never)
    expect(JSON.stringify(out)).not.toContain('deny')
    expect(w.runs.some(argv => argv[0] === '/fixture/bin/pick')).toBe(false)
    expect(String(w.bash[0]?.command)).toContain(`CLAUDE_CONFIG_DIR='${HOME}/.claude'`)
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
