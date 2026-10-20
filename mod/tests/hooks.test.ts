// Integration: the plugin's hooks against the engine's test kit. Every noun
// that would touch the machine (fs, process, env, clock) is answered by the
// test's own hooks from fixtures: no real registry, /proc or licence picker.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RULES_BLOCK, missingPromptItems, parseProcFacts, parseRegistry, probeArgs, rowStatus } from '../hooks/core'
import { auditFindings } from '../hooks/audit'
import { isRegistrySound } from '../hooks/notices'
import { TRACE_MAX_BYTES, localIso } from '../hooks/trace'

import {
  HOME,
  NOW_MS,
  ORCH_DIR,
  PROBE_STDOUT,
  REGISTRY,
  REGISTRY_PATH,
  REGISTRY_TEXT,
  RESULTS,
  REAL_RESULTS,
  SID_ALIVE,
  SID_DEAD,
  SID_DONE,
  SID_UNREPORTED,
  TASK_NOTIFICATION_KILLED,
  WIN_PROBE_STDOUT,
} from './fixtures'
import { echoPrompt } from './notice-kit'

const PICKER = '/fixture/bin/pick --need {need}'
const OPTIONS = { orchestratorDir: ORCH_DIR, registryPath: '~/.claude/headless-sessions.json', completionWrites: true, licencePickCommand: PICKER }
const TOOL = 'mcp__session-control__launch_worker'
const QUEUE_TEXT = JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: 'Queued one' }, { id: 'q2', status: 'done', title: 'Finished' }] })
// The task queue the fixture serves; a test that serves another puts QUEUE_TEXT back.
const QUEUE = { text: QUEUE_TEXT }
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
  /** PowerShell calls of the same kind (the launchRoute option at powershell, on Windows). */
  powershell: { command?: string; description?: string; run_in_background?: boolean; timeout?: number }[]
  /** Set once the fake worker "started": later probes show its process. */
  spawned: boolean
  writes: { path: string; text: string }[]
  /** Paths the plugin read through $.fs.read, in order. */
  reads: string[]
  toasts: string[]
  runs: string[][]
  /** Each call of the Node helper, its operation and its request, in order. */
  calls: { op: string; request: Record<string, unknown> }[]
  registered: string[]
  tools: { name: string; description: unknown; inputSchema: unknown }[]
  clock: ReturnType<typeof mock.clock>
}

const MISSING = new Set<string>()
// Paths that read as missing until the first sleep, like a session file the engine writes a moment late.
const LATE = new Set<string>()
// Paths that are there but cannot be read (over the read cap, say).
const UNREADABLE = new Set<string>()
// Reads a test holds until it releases them: the transcript tail of the alive worker; every append (the trace's too);
// every Linux probe; every read of the launched worker's sessions file (sessions, with heldSessions told when one waits).
/** The transcript rows a test puts in place of the fixture's (undefined: the fixture's two rows). */
const TAIL: { rows: object[] | undefined } = { rows: undefined }
const HELD: { tail: Promise<unknown> | undefined; append?: Promise<unknown>; probe?: Promise<unknown>; sessions?: Promise<unknown>; heldSessions?: () => void } = { tail: undefined }
// The Linux probes running now and the most that ran at once (reset by world()).
const PROBES = { inFlight: 0, max: 0 }
// The CLAUDE_CONFIG_DIR the Linux probe reads from the new worker's environment ('' when it has none).
// isInboxless: the Linux worker's sessions file has no name and no messagingSocketPath, as an older claude writes it.
// sid: the session id the Linux worker's sessions file names (a resume keeps the resumed one).
// isPowerShellMissing: the session offers no PowerShell tool.
// bashAnswer: what the Bash tool answers the launch instead of running it (a refusal or an error); undefined: it runs it.
// isAnsweredAfterRun: the Bash tool runs the launch and then answers bashAnswer (another plugin withholding the result,
// an interruption): the worker runs.
// resultText: what the launch's result file in the runs directory holds (undefined: there is none).
const WORKER = {
  linuxConfigDir: '/fixture/lic/a',
  isBashMissing: false,
  isPowerShellMissing: false,
  isInboxless: false,
  sid: 'abcdabcd-0000-4000-8000-000000000001',
  bashAnswer: undefined as Record<string, unknown> | undefined,
  isAnsweredAfterRun: false,
  resultText: undefined as string | undefined,
}
/** The inbox fields of the Linux worker's sessions file. */
const inboxFields = () => (WORKER.isInboxless ? {} : { name: 'w-new-260921141320', messagingSocketPath: '/run/user/1000/cc-socks/7001.sock' })
// Knobs of the Windows fixture: a failing registry write (the helper's writeAtomic) or probe; the config dir the probe
// finds the new worker's sessions file in, or none (unplaced); what the PowerShell route's pid file holds (undefined:
// there is none).
// probeMs: how long each Windows probe takes on the fixture's clock (0: no time). probeLateMs: each probe answers only
// once the test has moved the fixture's clock that far (0: at once). isAliveGone: the alive worker 4101 has exited.
const WINDOWS = { isMoveBroken: false, isProbeBroken: false, workerConfigDir: 'C:\\fixture\\home\\.claude', isWorkerUnplaced: false, pidFileText: '7001\r\n' as string | undefined, isWorkerHidden: false, probeMs: 0, probeLateMs: 0, isAliveGone: false }
// Knobs of the Linux fixture: a probe that cannot run; an append that fails.
// A trace.log of traceSize bytes is there (0: none).
// isWorkerHidden (both fixtures): the probe does not show the launched worker yet. isAliveGone, probeMs, probeLateMs: as
// in WINDOWS; isOrphanGone: the unregistered headless claude 4999 has exited too.
const LINUX_FIXTURE = { isProbeBroken: false, isAppendBroken: false, traceSize: 0, isWorkerHidden: false, isAliveGone: false, isOrphanGone: false, probeMs: 0, probeLateMs: 0 }
// The registry as a real file (both fixtures): with isCurrent a read answers the text the plugin last wrote there (the
// seed the test gave until its first write), and the probe asked for the launched worker's pid (7001, while it runs)
// answers its A line from its sessions file, as the helper's probe and PROBE_PS1 do. Off, every read answers the seed and
// 7001 has no A line: the older tests rely on that.
const REGISTRY_READS = { isCurrent: false }
/** The pause a task notification's prompt races its harvest against (PROMPT_HARVEST_SEC of register.tsx), in seconds. */
const PROMPT_HARVEST_SEC = 3
// The orchestrator's agreed-decisions.md, when a test serves one (undefined: the file is missing).
const DECISIONS: { text: string | undefined } = { text: undefined }
const BIG_PROMPT = `Wait in the foreground; report git status -sb; no attribution. ${'x'.repeat(30_000)}`
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

function world(on: On, pickStdout = '/fixture/lic/a\n', promptFileExists = true, registryText: string | (() => string | Promise<string>) = REGISTRY_TEXT, env: Record<string, string> = { HOME }, isEnvOwn = false): World {
  const w: World = { bash: [], powershell: [], spawned: false, writes: [], reads: [], toasts: [], runs: [], calls: [], registered: [], tools: [], clock: mock.clock(on, { now: NOW_MS }) }
  // The session name the worker's command line carries: the one the last launch that ran passed with -n.
  let launchedName = 'w-new-260921141320'
  const noteName = (command: unknown) => {
    launchedName = /\s-n '?([^'\s]+)'?/.exec(String(command ?? ''))?.[1] ?? launchedName
  }
  PROBES.inFlight = 0
  PROBES.max = 0
  // A test that answers env.get itself says so.
  if (!isEnvOwn) mock.env(on, env)
  // The engine keeps a plugin's own store (the notices' state, notices.ts): an empty one in memory.
  mock.store(on)
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
  /** The fixture's text at a path the plugin gave, as fs.read answers it: undefined when missing; EFBIG thrown for one over the cap. */
  const fixtureText = (given: string): string | Promise<string> | undefined => {
    const path = fixture(seen(given))
    if (MISSING.has(path) || LATE.has(path)) return undefined
    if (UNREADABLE.has(path)) throw new Error(`EFBIG ${given}`)
    // A test may hold the registry read (a promise) while something else happens.
    if (path === REGISTRY_PATH) {
      const written = REGISTRY_READS.isCurrent ? w.writes.filter(one => fixture(one.path) === REGISTRY_PATH).at(-1) : undefined
      if (written !== undefined) return written.text
      return typeof registryText === 'function' ? registryText() : registryText
    }
    if (path === '/work/orch/CLAUDE.md') return '# Role: Session Orchestrator\n'
    if (path === '/work/new/thin.md') return 'Just do the work.'
    if (path === `${ORCH_DIR}/task-queue.json`) return QUEUE.text
    if (path === `${ORCH_DIR}/open-points.json`) return OPEN_POINTS_TEXT
    if (path === `${ORCH_DIR}/agreed-decisions.md` && DECISIONS.text !== undefined) return DECISIONS.text
    const result = /^\/fixture\/results\/(\w+)\.json$/.exec(path)?.[1]
    if (result !== undefined && result in RESULTS) return RESULTS[result as keyof typeof RESULTS]
    if (result !== undefined && result in REAL_RESULTS) return REAL_RESULTS[result as keyof typeof REAL_RESULTS]
    if (path === '/fixture/results/login.err') return 'Error: Invalid API key · Please run /login\n'
    if (['/fixture/home/.claude/sessions/7001.json', '/fixture/lic/own/sessions/7001.json'].includes(path) && !isWin) return JSON.stringify({ sessionId: 'abcdabcd-0000-4000-8000-000000000001', procStart: '123', ...inboxFields() })
    if (path === '/fixture/lic/a/sessions/7001.json') return JSON.stringify({ sessionId: WORKER.sid, procStart: '123', ...inboxFields() })
    if (seen(given) === 'C:/fixture/home/.claude/sessions/7001.json') return JSON.stringify({ pid: 7001, sessionId: 'abcdabcd-0000-4000-8000-000000000001', startedAt: NOW_MS })
    if (path === '/work/new/big.md') return BIG_PROMPT
    if (WORKER.resultText !== undefined && /\/session-control\/runs\/\d{14}-new\.json$/.test(path)) return WORKER.resultText
    // The pid file a PowerShell launch writes beside its result file.
    if (isWin && path.endsWith('.pid') && WINDOWS.pidFileText !== undefined) return WINDOWS.pidFileText
    // The mod's own scripts read back as written.
    return w.writes.filter(one => one.path === seen(given) && one.path.endsWith('.ps1')).at(-1)?.text
  }
  on('fs.read', ($, e) => {
    w.reads.push(seen(e.path))
    const answer = (text: string | undefined) => {
      if (text === undefined) throw new Error(`ENOENT ${e.path}`)
      return { value: text }
    }
    if (HELD.sessions !== undefined && seen(e.path).endsWith('/sessions/7001.json')) {
      HELD.heldSessions?.()
      return HELD.sessions.then(() => fixtureText(e.path)).then(answer)
    }
    const text = fixtureText(e.path)
    return typeof text === 'string' || text === undefined ? answer(text) : text.then(answer)
  })
  /** The transcript rows the tail answers: the alive worker's may be held by a test. */
  const tailRows = (path: string) => {
    const held = HELD.tail !== undefined && path.includes(SID_ALIVE) ? HELD.tail : undefined
    const rows = TAIL.rows ?? [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the suite files.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status -sb' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: '## develop...origin/develop' }] } },
    ]
    const text = rows.map(r => JSON.stringify(r)).join('\n')
    return held === undefined ? text : held.then(() => text)
  }
  /**
   * The A line of the launched worker 7001 when the probe is asked for its pid (REGISTRY_READS.isCurrent): its start and
   * its sessions file's start and session id, the start and the file's equal as for a live pid (`startMark`: the Linux
   * clock ticks, or on Windows the creation time in ms the file's startedAt matches).
   */
  const workerProof = async (args: readonly string[], startMark: string, fileStart: (file: Record<string, unknown>) => unknown, state = ''): Promise<string> => {
    const arg = REGISTRY_READS.isCurrent ? args.find(one => one.startsWith('pid:7001|')) : undefined
    if (arg === undefined) return ''
    let file: Record<string, unknown> = {}
    try {
      file = JSON.parse((await fixtureText(`${arg.slice('pid:7001|'.length)}/sessions/7001.json`)) ?? '{}') as Record<string, unknown>
    } catch {
      file = {}
    }
    return ['A', 7001, 'claude', startMark, String(fileStart(file) ?? ''), String(file.sessionId ?? ''), ...(state === '' ? [] : [state])].join('\t') + '\n'
  }
  /** One operation of the Node helper over the fixture: its answer's fields, or the fixed code it fails with. */
  const helperStep = async (op: string, request: Record<string, unknown>): Promise<Record<string, unknown> | string> => {
    const path = String(request.path ?? '')
    if (op === 'probe') {
      PROBES.inFlight++
      PROBES.max = Math.max(PROBES.max, PROBES.inFlight)
      try {
        if (HELD.probe !== undefined) await HELD.probe
        if (LINUX_FIXTURE.probeMs > 0) await w.clock.advance(LINUX_FIXTURE.probeMs)
        if (LINUX_FIXTURE.probeLateMs > 0) await w.clock.sleep(LINUX_FIXTURE.probeLateMs)
      } finally {
        PROBES.inFlight--
      }
      if (LINUX_FIXTURE.isProbeBroken) return 'IO'
      const worker = w.spawned && !LINUX_FIXTURE.isWorkerHidden
        ? `\nP\t7001\tclaude\t3\t/work/new\t${WORKER.linuxConfigDir}\tclaude -p --model opus -n ${launchedName} --settings {"crossSessionInbound":"accept"} --dangerously-skip-permissions --output-format json -- prompt\n`
        : ''
      const gone = [...(LINUX_FIXTURE.isAliveGone ? ['\t4101\t'] : []), ...(LINUX_FIXTURE.isOrphanGone ? ['\t4999\t'] : [])]
      const proof = w.spawned && !LINUX_FIXTURE.isWorkerHidden ? await workerProof((request.args as string[] | undefined) ?? [], '123', file => file.procStart, 'S') : ''
      return { out: PROBE_STDOUT.split('\n').filter(line => !gone.some(pid => line.includes(pid))).join('\n') + worker + proof }
    }
    // A write is recorded as what it puts in place; with `expected`, only while the fixture still holds that text.
    if (op === 'writeAtomic') {
      if (WINDOWS.isMoveBroken && isWin) return 'ACCESS'
      if (request.expected !== undefined && (await fixtureText(path)) !== request.expected) return { written: false }
      w.writes.push({ path: seen(path), text: String(request.text) })
      return { written: true }
    }
    if (op === 'renameOver') {
      const text = w.writes.filter(one => one.path === seen(String(request.from))).at(-1)?.text
      if (text !== undefined) w.writes.push({ path: seen(String(request.to)), text })
      return {}
    }
    if (op === 'removeFile') return { removed: true }
    // An append is recorded as a write of what it adds.
    if (op === 'append') {
      if (HELD.append !== undefined) await HELD.append
      if (LINUX_FIXTURE.isAppendBroken) return 'READ_ONLY'
      w.writes.push({ path: seen(path), text: String(request.text) })
      return { bytes: String(request.text).length }
    }
    // A rotation moves the trace away: it is empty from then on.
    if (op === 'rotate') {
      LINUX_FIXTURE.traceSize = 0
      return { rotated: true }
    }
    if (op === 'tail') return { text: await tailRows(path), dropped: 0 }
    // The bound of a task notification's prompt on its harvest: it ends when the test's clock gets there, as a real
    // pause takes its time.
    if (op === 'pause' && request.ms === PROMPT_HARVEST_SEC * 1000) {
      await w.clock.sleep(PROMPT_HARVEST_SEC * 1000)
      return {}
    }
    // The wait between discovery checks on Windows: the time it waits passes on the fixture's clock, and a session file
    // the engine writes late is there after it, as after a sleep.
    if (op === 'pause') {
      await w.clock.advance(Number(request.ms))
      LATE.clear()
      return {}
    }
    if (op === 'filesNewerThan') return { files: [], total: 0 }
    if (op === 'hashTree') return 'NOT_FOUND'
    return 'BAD_OP'
  }
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
  on('process.run', async ($, e) => {
    w.runs.push([...e.argv])
    const ok = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    // Node 24 and its helper, one operation per call (a batch: its steps in order, the first failure ends it).
    if (e.argv[0] === 'node' && e.argv[1] === '--version') return { value: { ...ok, stdout: 'v24.14.0\n' } }
    if (e.argv[0] === 'node' && String(e.argv[1]).endsWith('/helper/host.mjs')) {
      const op = String(e.argv[2])
      const request = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
      w.calls.push({ op, request })
      const answer = (fields: Record<string, unknown>) => ({ value: { ...ok, stdout: JSON.stringify({ ok: true, ...fields }) } })
      const refuse = (fields: Record<string, unknown>) => ({ value: { ...ok, exitCode: 1, stdout: JSON.stringify({ ok: false, ...fields }) } })
      if (op !== 'batch') {
        const done = await helperStep(op, request)
        return typeof done === 'string' ? refuse({ code: done }) : answer(done)
      }
      const results: Record<string, unknown>[] = []
      for (const [at, one] of (request.ops as Record<string, unknown>[]).entries()) {
        const done = await helperStep(String(one.op), one)
        if (typeof done === 'string') return refuse({ code: done, at, results })
        results.push({ ok: true, ...done })
      }
      return answer({ results })
    }
    // The bound of a task notification's prompt on its harvest (Linux): it ends when the test's clock gets there.
    if (e.argv[0] === 'sleep' && e.argv[1] === String(PROMPT_HARVEST_SEC)) {
      await w.clock.sleep(PROMPT_HARVEST_SEC * 1000)
      return { value: { ...ok, stdout: '' } }
    }
    if (e.argv[0] === 'sleep') LATE.clear()
    if (e.argv[0] === 'mkdir' || e.argv[0] === 'sleep') return { value: { ...ok, stdout: '' } }
    if (e.argv[0] === 'test' && e.argv[1] === '-e') return { value: { ...ok, stdout: '', exitCode: 1 } }
    if (e.argv[0] === 'test') return { value: { ...ok, stdout: '', exitCode: promptFileExists ? 0 : 1 } }
    if (e.argv[0] === '/fixture/bin/pick') return { value: { ...ok, stdout: pickStdout, exitCode: pickStdout ? 0 : 3 } }
    if (e.argv[0] === POWERSHELL && String(e.argv[6]).endsWith('/probe.ps1')) {
      PROBES.inFlight++
      PROBES.max = Math.max(PROBES.max, PROBES.inFlight)
      try {
        if (WINDOWS.probeMs > 0) await w.clock.advance(WINDOWS.probeMs)
        if (WINDOWS.probeLateMs > 0) await w.clock.sleep(WINDOWS.probeLateMs)
      } finally {
        PROBES.inFlight--
      }
      if (WINDOWS.isProbeBroken) return { value: { ...ok, stdout: '', exitCode: 1, stderr: 'Invalid class' } }
      const placed = WINDOWS.isWorkerUnplaced ? ['', ''] : ['C:\\work\\new', WINDOWS.workerConfigDir]
      const worker = w.spawned && !WINDOWS.isWorkerHidden
        ? ['P', 7001, 'claude', 3, ...placed, `"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus -n ${launchedName} --settings "{\\"crossSessionInbound\\":\\"accept\\"}" --dangerously-skip-permissions --output-format json -- prompt`].join('\t') + '\n'
        : ''
      // PowerShell's own line ends.
      const probed = WINDOWS.isAliveGone ? WIN_PROBE_STDOUT.split('\n').filter(line => !line.includes('\t4101\t')).join('\n') : WIN_PROBE_STDOUT
      const proof = w.spawned && !WINDOWS.isWorkerHidden ? await workerProof(e.argv.slice(7).map(String), String(NOW_MS), file => file.startedAt) : ''
      return { value: { ...ok, stdout: (probed + worker + proof).replace(/\n/g, '\r\n') } }
    }
    if (e.argv[0] === 'C:/fixture/bin/pick.exe') {
      return { value: { ...ok, stdout: pickStdout.replace(/^\/fixture/, 'C:\\fixture').replace(/\//g, '\\').replace(/\n$/, '\r\n'), exitCode: pickStdout ? 0 : 3 } }
    }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    if (WORKER.isBashMissing) throw new Error('no tool named "Bash" in this session')
    if (WORKER.bashAnswer !== undefined && !WORKER.isAnsweredAfterRun) return WORKER.bashAnswer as never
    w.bash.push(e as never)
    w.spawned = true
    noteName((e as { command?: unknown }).command)
    if (WORKER.bashAnswer !== undefined) return WORKER.bashAnswer as never
    return { result: 'Command running in background with ID: fixture' }
  })
  // The engine on Windows has the PowerShell tool; this build's tool table does not, hence the name as a string.
  on('tool.call', { tool: 'PowerShell' } as never, (($: unknown, e: unknown) => {
    if (WORKER.isPowerShellMissing) throw new Error('no tool named "PowerShell" in this session')
    w.powershell.push(e as never)
    w.spawned = true
    noteName((e as { command?: unknown }).command)
    return { result: 'Command running in background with ID: fixture' }
  }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

const start = (cwd: string, isInteractive = true) => ({ cwd, surface: null, isInteractive })
/** The session started in `cwd` (the orchestrator's directory by default). */
const boot = ($: Engine, cwd = ORCH_DIR) => $.session.start(start(cwd))
/** A launch_worker call with `input` after the tool's name. */
const launchTool = ($: Engine, input: object) => $.tool.call({ tool: TOOL, ...input } as never)
/** The /session-control command with `args`. */
const runCommand = ($: Engine, args: string) => $.command.run({ command: 'session-control', args } as never)
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
/** A write of the trace (the helper's batch of a rotation and an append, or the append alone): what the trace adds to what the mod runs. */
const isTraceRun = (argv: readonly string[]) => argv[0] === 'node' && (String(argv[1]).endsWith('/helper/host.mjs') || argv[1] === '<helper>') && argv[2] === 'batch'
/** A command as the pins below write it: the helper in the plugin's folder as `<helper>`. */
const pinned = (argv: readonly string[]) => argv.map(one => (one.endsWith('/helper/host.mjs') ? '<helper>' : one))

describe('scope', () => {
  test('a no-op outside the orchestrator dir', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($, '/work/elsewhere')
    expect(w.runs.length).toBe(0)
    expect(w.registered).toEqual(['/session-control'])
  })

  test('without the orchestratorDir option the board starts where CLAUDE.md is the orchestrator, and the command refuses elsewhere', { options: { registryPath: '~/.claude/headless-sessions.json', completionWrites: true } }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($, '/work/elsewhere')
    expect(w.registered).toEqual(['/session-control'])
    const refused = await runCommand($, '')
    expect(refused.text).toContain('not an orchestrator directory')
    await boot($, '/work/orch/')
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
    await boot($)
    // The first six as they were; later tools come after them.
    expect(w.tools.slice(0, 6).map(tool => tool.name)).toEqual(['launch_worker', 'acknowledge_workers', 'retire_workers', 'open_point', 'queue_task', 'record_decision'])
    // The whole tool surface in one pin: it moves only on purpose (each past move and its old value is in git log).
    expect(fingerprint(JSON.stringify(w.tools))).toBe('19042:69ab2361')
  })

  test('the open_point and queue_task descriptions say the list action does not redact', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    for (const name of ['open_point', 'queue_task']) {
      const tool = w.tools.find(one => one.name === name)
      expect(JSON.stringify(tool)).toContain('The list action does not redact secrets; ids, session ids and paths stay readable.')
    }
  })
})

describe('fresh environment', () => {
  test('missing helper files are created from scratch, nothing warns, and the tools work on them', { options: OPTIONS }, async ($, on) => {
    for (const file of ['open-points.json', 'task-queue.json']) MISSING.add(`${ORCH_DIR}/${file}`)
    const w = world(on)
    try {
      await boot($)
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
    await boot($)
    expect(w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 ')).length).toBe(1)
    await runCommand($, '')
    expect(w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 ')).length).toBe(1)
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
    await boot($, ORCH_DIR + '/')
    // The command and the first six tools; the later ones are pinned by 'tool surface > the six tools keep their names, descriptions and schemas'.
    expect(w.registered.slice(0, 7)).toEqual(['/session-control', 'launch_worker', 'acknowledge_workers', 'retire_workers', 'open_point', 'queue_task', 'record_decision'])
    const probes = w.calls.filter(one => one.op === 'probe')
    expect(probes.length).toBe(1)
    expect(probes[0]?.request.args).toContain(`pid:4101|/fixture/lic/a`)
  })

  test('/session-control side opens one panel: sessions, queued work, open points, in that order', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await boot($)
    const ran = await runCommand($, 'side')
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
})

describe('completion', () => {
  test('a dead worker is classified, merged in place once, and toasted', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const regWrites = () => w.writes.filter(one => one.path === REGISTRY_PATH)
    expect(regWrites().length).toBe(1)
    const after = JSON.parse(regWrites()[0]!.text) as Record<string, unknown>[]
    const entry = after.find(one => one.session_id === SID_DEAD)!
    expect('pid' in entry).toBe(false)
    expect(entry.reported).toBe(false)
    expect(entry.resume).toEqual({ parked_until: '2026-10-06T12:00:00Z', strikes: 2, escalated: true })
    expect(w.toasts).toEqual(['Usage limit reached \u00B7 limited worker: limit: rate limit hit'])
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
      await boot($)
      expect(w.toasts).toEqual([`${title} \u00B7 limited worker: ${summary}`])
    })
  }

  test('a clean report quoting the login message is clean; the err file is read and a login there is a login', { options: OPTIONS }, async ($, on) => {
    const quoting = REGISTRY_TEXT.replace('/fixture/results/limit.json', '/fixture/results/designReport.json')
    const w = world(on, '/fixture/lic/a\n', true, quoting)
    await boot($)
    expect(w.toasts[0]).toStartWith('Session finished · limited worker: clean: ')
    expect(w.reads).not.toContain('/fixture/results/login.err')
  })
  test('the err file of the entry decides a login when the run did not succeed', { options: OPTIONS }, async ($, on) => {
    const withErr = REGISTRY_TEXT.replace('"result_file": "/fixture/results/limit.json"', '"result_file": "/fixture/results/maxTurns.json",\n    "err_file": "/fixture/results/login.err"')
    const w = world(on, '/fixture/lic/a\n', true, withErr)
    await boot($)
    expect(w.reads).toContain('/fixture/results/login.err')
    expect(w.toasts).toEqual(['Login needed · limited worker: login: licence needs a re-login'])
  })
  test('the err file of the entry does not turn a successful run into a login', { options: OPTIONS }, async ($, on) => {
    const withErr = REGISTRY_TEXT.replace('"result_file": "/fixture/results/limit.json"', '"result_file": "/fixture/results/designReport.json",\n    "err_file": "/fixture/results/login.err"')
    const w = world(on, '/fixture/lic/a\n', true, withErr)
    await boot($)
    expect(w.toasts[0]).toStartWith('Session finished · limited worker: clean: ')
    const entry = lastRegistry(w).find(one => one.session_id === SID_DEAD)
    expect((entry?.outcome as { kind?: string }).kind).toBe('clean')
    // The harvest time, in epoch seconds, ends the run's duration.
    expect(entry?.ended_at).toBe(NOW_MS / 1000)
  })

  test('a real report with both reads gets no report-check line', { options: OPTIONS }, async ($, on) => {
    world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT.replace('/fixture/results/limit.json', '/fixture/results/probeReport.json'))
    echoPrompt(on)
    await boot($)
    const sent = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(sent.context?.length).toBe(1)
    expect(String(sent.context?.[0])).not.toContain('report check')
  })

  test('with completionWrites off nothing is written, the toast still shows', { options: { ...OPTIONS, completionWrites: false } }, async ($, on) => {
    const w = world(on)
    await boot($)
    expect(w.writes.filter(one => one.path === REGISTRY_PATH).length).toBe(0)
    expect(w.toasts.length).toBe(1)
  })

  test('a task notification carries the pending completion to the model once', { options: OPTIONS }, async ($, on) => {
    world(on)
    echoPrompt(on)
    await boot($)
    const first = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(first.context).toEqual(['session-control completions: limited worker: limit: rate limit hit'])
    const second = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(second.context).toBeUndefined()
  })
})

describe('launch_worker', () => {
  const args = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }

  test('every launch has a unique session name and accepts messages from other sessions', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    await launchTool($, args)
    expect(String(w.bash[0]?.command)).toContain(`claude -p --model 'opus' -n 'w-new-260921141320' --settings '{"crossSessionInbound":"accept"}' --dangerously-skip-permissions`)
    // A second launch in the same second gets another name.
    await launchTool($, { ...args, dir: '/work/new' })
    expect(String(w.bash[1]?.command)).toContain(`-n 'w-new-260921141320-2' --settings`)
  })

  test('the registry records the session name and the messaging socket from the worker sessions file', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, args)
    expect(String(out.result)).toContain('registered. Name: w-new-260921141320; socket: /run/user/1000/cc-socks/7001.sock. Result: ')
    expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, name: 'w-new-260921141320', socket_path: '/run/user/1000/cc-socks/7001.sock', started_at: NOW_MS / 1000 })
  })

  test('an older claude whose sessions file has no inbox fields: the launch name, no socket_path, still registered', { options: OPTIONS }, async ($, on) => {
    WORKER.isInboxless = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('registered. Name: w-new-260921141320; socket: none.')
      const entry = lastRegistry(w).at(-1) as Record<string, unknown>
      expect(entry).toMatchObject({ pid: 7001, session_id: 'abcdabcd-0000-4000-8000-000000000001', name: 'w-new-260921141320' })
      expect('socket_path' in entry).toBe(false)
      // Three more reads of the sessions file, a second apart, before it goes without the socket.
      expect(w.runs.filter(argv => argv.join(' ') === 'sleep 1').length).toBe(3)
    } finally {
      WORKER.isInboxless = false
    }
  })

  test('without a picker, an orchestrator with its own CLAUDE_CONFIG_DIR: the worker inherits it, and the registry records it', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
    WORKER.linuxConfigDir = '/fixture/lic/own'
    try {
      const w = world(on, '', true, REGISTRY_TEXT, { HOME, CLAUDE_CONFIG_DIR: '/fixture/lic/own' })
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('config_dir /fixture/lic/own, registered.')
      expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, config_dir: '/fixture/lic/own' })
    } finally {
      WORKER.linuxConfigDir = '/fixture/lic/a'
    }
  })

  /** The text after the reason in the answer to a refused launch: nothing ran, and how a person allows it. */
  const ALLOW_HINT =
    '; the worker was not started and nothing was registered. The launch runs claude -p with --dangerously-skip-permissions through the shell, ' +
    "which a permission mode can refuse (the Auto mode of Claude Desktop's Code tab among them): allow that Bash command when you are asked, or with a permission rule, then launch again."

  test('a launch the Bash tool answers with an error: said with its text, nothing registered, nothing looked for', { options: OPTIONS }, async ($, on) => {
    WORKER.bashAnswer = { isError: true, result: 'Error: spawn failed', text: 'Error: spawn failed' }
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.deny)).toBe(`session-control: the Bash tool answered the launch with an error: Error: spawn failed${ALLOW_HINT}`)
      expect(w.runs.some(argv => argv[0] === 'sleep')).toBe(false)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
    } finally {
      WORKER.bashAnswer = undefined
    }
  })

  // A refusal or an error can come after the command ran (another plugin withholding the result, an interruption): one
  // probe, never repeated, looks for a worker with the launch's name.
  describe('the one probe after a refusal or an error of the launch tool', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: args, configDir: '/fixture/lic/a', runs: `${HOME}/.claude/session-control/runs`, socket: '/run/user/1000/cc-socks/7001.sock' },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        configDir: 'C:/fixture/home/.claude',
        runs: `C:${HOME}/.claude/session-control/runs`,
        socket: 'none',
      },
    ] as const
    /** The process probes so far (the helper's on Linux, PROBE_PS1 runs on Windows) and the waits of a search (2 s each). */
    const probes = (w: World) => w.calls.filter(one => one.op === 'probe').length + w.runs.filter(argv => argv[0] === POWERSHELL && String(argv[6]).endsWith('/probe.ps1')).length
    const searchWaits = (w: World) => w.runs.filter(argv => argv.join(' ') === 'sleep 2').length + w.calls.filter(one => one.op === 'pause' && one.request.ms === 2000).length
    const reset = () => {
      WORKER.bashAnswer = undefined
      WORKER.isAnsweredAfterRun = false
    }

    for (const host of hosts) {
      for (const [what, answer, said] of [
        ['a refusal (another plugin withheld the result)', { deny: 'a plugin withheld the result' }, 'refused the launch (a plugin withheld the result)'],
        ['an error (an interruption)', { isError: true, result: 'Interrupted by user', text: 'Interrupted by user' }, 'answered the launch with an error (Interrupted by user)'],
      ] as const) {
        test(`${host.name}, ${what} after the command ran: the one probe finds the worker by its name; registered, answered as started, with what the tool answered`, { options: host.options }, async ($, on) => {
          WORKER.bashAnswer = answer
          WORKER.isAnsweredAfterRun = true
          try {
            const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
            await boot($, host.dir)
            const before = probes(w)
            const out = await launchTool($, host.launch)
            expect(out.deny).toBeUndefined()
            expect(String(out.result)).toBe(
              `Launched pid 7001, session ${SID_NEW}, config_dir ${host.configDir}, registered. Name: w-new-260921141320; socket: ${host.socket}. ` +
                `Result: ${host.runs}/20260921141320-new.json; errors: ${host.runs}/20260921141320-new.err. The Bash tool ${said}, although the worker started.`,
            )
            expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, session_id: SID_NEW, result_file: `${host.runs}/20260921141320-new.json` })
            // The launch's own check before the call, the one probe after it, and the refresh after the registration: no search.
            expect(probes(w) - before).toBe(3)
            expect(searchWaits(w)).toBe(0)
          } finally {
            reset()
          }
        })
      }
    }
  })

  // A signoff block (lint.ts, README Sign-off guard): checked against the orchestrator's agreed-decisions.md on either
  // host, read only for a prompt that holds one; its lines are launched with a WARNING line; the rest stays refused.
  describe('a signoff block, on both hosts', () => {
    const BLOCK_DECISIONS = '# Agreed decisions\n\n## Standing\nscratch-delete-go. [signoff:delete-branch] User: delete merged scratch branches; never main.\nscratch-lease-go. [signoff:force-push] User: push main to origin with --force-with-lease once.\n'
    const HEAD = 'Wait in the foreground; report git status -sb; no attribution.'
    const LINES = ['git push origin --delete refs/heads/feature/a', 'git push origin :refs/heads/feature/b']
    const BLOCK = `${HEAD}\n\`\`\`signoff scratch-delete-go\n${LINES.join('\n')}\n\`\`\``
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: { dir: '/work/new', model: 'opus', effort: 'high', title: 'new' } },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { dir: '/c/work/new', model: 'opus', effort: 'high', title: 'new' },
      },
    ] as const

    for (const host of hosts) {
      test(`${host.name}: a valid block is launched with the WARNING line; the old citation, a stray deletion, another class, a bad line and a decisions file not there or unreadable are refused and nothing runs`, { options: host.options }, async ($, on) => {
        DECISIONS.text = BLOCK_DECISIONS
        try {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          await boot($, host.dir)
          const decisionReads = () => w.reads.filter(path => fixture(path) === `${ORCH_DIR}/agreed-decisions.md`).length
          const readsBefore = decisionReads()
          const launch = (prompt: string) => launchTool($, { ...host.launch, prompt })
          const DELETION = 'refused by the sign-off guard: the prompt instructs a remote branch or tag deletion'
          for (const [prompt, start] of [
            [`${HEAD}\n${LINES.join('\n')}`, `${DELETION} on line 2, a remote branch or tag deletion on line 3 as a step for the worker;`],
            [`${HEAD}\nPer scratch-delete-go:\n${LINES.join('\n')}`, `${DELETION} on line 3, a remote branch or tag deletion on line 4 as a step for the worker;`],
            [`${BLOCK}\nThen git push origin --delete main.`, `${DELETION} on line 6 as a step for the worker;`],
            [BLOCK.replace('signoff scratch-delete-go', 'signoff scratch-lease-go'), 'refused by the sign-off guard: the signoff block on line 2 (signoff scratch-lease-go): its line 1 (line 3 of the prompt) is a delete-branch command, and scratch-lease-go covers force-push;'],
            [BLOCK.replace('refs/heads/feature/b', 'refs/heads/feature/b "develop"'), 'refused by the sign-off guard: the signoff block on line 2 (signoff scratch-delete-go): its line 2 (line 4 of the prompt) is not one command in a form of the delete-branch class;'],
          ] as const) {
            const deny = String((await launch(prompt)).deny)
            expect({ start, deny: deny.slice(0, 'session-control: '.length + start.length) }).toEqual({ start, deny: `session-control: ${start}` })
            expect({ start, end: deny.endsWith('; nothing was launched') }).toEqual({ start, end: true })
          }
          // A refusal of the check outside the blocks ends with how a block is written when a block could cover the action,
          // then the detail: the command shape and its line, and the ways out.
          const SHAPE_WAYS = 'is refused wherever it stands, a describe block included; the ways out are a negation in its sentence (never, do not, stop before) or, for a class the user has recorded a Standing go-ahead for (a remote branch deletion, a leased push), its commands in a signoff block; nothing was launched'
          expect(String((await launch(`${HEAD}\n${LINES[0]}`)).deny)).toEndWith(`write its commands, one per line, in a fenced block whose info line is signoff <id>. The command shape \`git push origin --delete\` on line 2 ${SHAPE_WAYS}`)
          expect(String((await launch(`${HEAD}\ngit reset --hard`)).deny)).toEndWith('(never, do not, stop before) passes. The command shape `git reset --hard` on line 2 is refused wherever it stands, a describe block included; the ways out are a negation in its sentence (never, do not, stop before), a quoted example after an introducing word (for example, such as), or leaving the step out; no signoff block covers it; nothing was launched')
          expect([w.bash.length, w.powershell.length]).toEqual([0, 0])
          // The decisions file is read for each prompt that holds a well-formed block, and for no other: three of them so far.
          expect(decisionReads() - readsBefore).toBe(3)
          const out = await launch(BLOCK)
          expect(out.deny).toBeUndefined()
          expect(String(out.result)).toContain('Launched pid 7001')
          expect(String(out.result)).toEndWith(`\nWARNING: sign-off allowed by scratch-delete-go: delete-branch: ${LINES.join('; ')}`)
          expect(decisionReads() - readsBefore).toBe(4)
          const path = host.name === 'Windows' ? `C:${ORCH_DIR}/agreed-decisions.md` : `${ORCH_DIR}/agreed-decisions.md`
          DECISIONS.text = undefined
          expect(String((await launch(BLOCK)).deny)).toBe(`session-control: refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: ${path} is not there; nothing was launched`)
          UNREADABLE.add(`${ORCH_DIR}/agreed-decisions.md`)
          try {
            expect(String((await launch(BLOCK)).deny)).toBe(`session-control: refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: ${path} is there but its read and its stat both failed; nothing was launched`)
          } finally {
            UNREADABLE.delete(`${ORCH_DIR}/agreed-decisions.md`)
          }
          expect(w.bash.length + w.powershell.length).toBe(1)
        } finally {
          DECISIONS.text = undefined
        }
      })
    }
  })

  test('a settings hook that denies the Bash call (classic PreToolUse) is a refusal of the launch too', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    // Its input is the call's envelope (the tool and its arguments), as a settings hook's PreToolUse sees it.
    on('classic.PreToolUse', ($, e) => (String((e as { tool?: unknown }).tool) === 'Bash' ? { deny: 'blocked by a PreToolUse hook' } : {}))
    await boot($)
    const out = await launchTool($, args)
    expect(String(out.deny)).toBe(`session-control: the Bash tool refused the launch: blocked by a PreToolUse hook${ALLOW_HINT}`)
    expect(w.bash.length).toBe(0)
    expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
  })

  test('a refusal reason past 500 characters is cut there; an empty one is said as none given', { options: OPTIONS }, async ($, on) => {
    WORKER.bashAnswer = { deny: `x${'y'.repeat(700)}` }
    try {
      world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.deny)).toBe(`session-control: the Bash tool refused the launch: x${'y'.repeat(499)}${ALLOW_HINT}`)
      WORKER.bashAnswer = { deny: '  ' }
      const empty = await launchTool($, args)
      expect(String(empty.deny)).toBe(`session-control: the Bash tool refused the launch: no reason given${ALLOW_HINT}`)
    } finally {
      WORKER.bashAnswer = undefined
    }
  })

  test('a Bash tool the session does not offer is a clear refusal, and nothing is registered', { options: OPTIONS }, async ($, on) => {
    WORKER.isBashMissing = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
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
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
        expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}'`)
      } finally {
        WORKER.linuxConfigDir = '/fixture/lic/a'
      }
    })
    test('without a picker, of an entry under another directory, sets it', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
      const w = world(on, '')
      await boot($)
      expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
      expect(String(w.bash[0]?.command)).toContain(`CLAUDE_CONFIG_DIR='/fixture/lic/a' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --resume '${SID_UNREPORTED}'`)
    })
    test('keeps the entry name; an entry without one gets a fresh name', { options: OPTIONS }, async ($, on) => {
      const named = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? { ...one, name: 'w-first-run-260901080000' } : one)))
      const w = world(on, '/fixture/lic/a\n', true, named)
      await boot($)
      expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
      expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}' -n 'w-first-run-260901080000' --settings '{"crossSessionInbound":"accept"}' --dangerously`)
    })
    const stale = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? { ...one, name: 'w-first-run-260901080000', socket_path: '/run/user/1000/cc-socks/1.sock' } : one)))
    test('records the new socket over the old one', { options: OPTIONS }, async ($, on) => {
      WORKER.sid = SID_UNREPORTED
      try {
        const w = world(on, '/fixture/lic/a\n', true, stale)
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        // The name is the one the sessions file holds (the engine's own), the fixture's here.
        expect(lastRegistry(w).find(one => one.session_id === SID_UNREPORTED)).toMatchObject({ pid: 7001, name: 'w-new-260921141320', socket_path: '/run/user/1000/cc-socks/7001.sock' })
      } finally {
        WORKER.sid = 'abcdabcd-0000-4000-8000-000000000001'
      }
    })
    test('a sessions file without a socket writes socket_path null over the dead one, the kept name stays', { options: OPTIONS }, async ($, on) => {
      WORKER.sid = SID_UNREPORTED
      WORKER.isInboxless = true
      try {
        const w = world(on, '/fixture/lic/a\n', true, stale)
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        expect(lastRegistry(w).find(one => one.session_id === SID_UNREPORTED)).toMatchObject({ pid: 7001, name: 'w-first-run-260901080000', socket_path: null })
      } finally {
        WORKER.isInboxless = false
        WORKER.sid = 'abcdabcd-0000-4000-8000-000000000001'
      }
    })
    test('of an entry without a name: a fresh unique name', { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n')
      await boot($)
      expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
      expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}' -n 'w-new-260921141320' --settings`)
    })
    test('with a picker, of an entry under the default directory, sets it as before', { options: OPTIONS }, async ($, on) => {
      WORKER.linuxConfigDir = `${HOME}/.claude`
      try {
        const w = world(on, '/fixture/lic/a\n', true, underHome)
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        expect(String(w.bash[0]?.command)).toContain(`CLAUDE_CONFIG_DIR='${HOME}/.claude'`)
        expect(w.runs.some(argv => argv[0] === '/fixture/bin/pick')).toBe(false)
      } finally {
        WORKER.linuxConfigDir = '/fixture/lic/a'
      }
    })
  })

  test('a session file that appears late is still read, and the worker is registered', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    LATE.add('/fixture/lic/a/sessions/7001.json')
    try {
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('Launched pid 7001')
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(true)
    } finally {
      LATE.clear()
    }
  })

  const LAUNCH_RUNS = `${HOME}/.claude/session-control/runs`
  test('a worker that appears only after the 30 s of the launch: answered as started and not registered yet, then registered by the poll that finds it', { options: OPTIONS }, async ($, on) => {
    LINUX_FIXTURE.isWorkerHidden = true
    try {
      const w = world(on)
      await boot($)
      const before = lastRegistry(w).length
      const out = await launchTool($, args)
      expect(String(out.result)).toBe(
        'Started in the background, but no claude process for it appeared within 30 s: it is not registered yet. ' +
          "Check it with list_sessions: while it runs unregistered it is an orphan row (cwd /work/new); the mod's poll registers it as soon as it finds it " +
          '(up to 10 min after the launch), and its entry then takes the orphan row\'s place. ' +
          `If neither row appears, it did not start: read ${LAUNCH_RUNS}/20260921141320-new.err. Result: ${LAUNCH_RUNS}/20260921141320-new.json.`,
      )
      // Fifteen checks at most, each after a `sleep 2` process: the Linux wait as it was.
      expect(w.runs.filter(argv => argv.join(' ') === 'sleep 2').length).toBe(15)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
      // The worker shows up: the next poll registers it with what the launch would have written.
      LINUX_FIXTURE.isWorkerHidden = false
      await w.clock.advance(5000)
      const after = lastRegistry(w)
      expect(after.length).toBe(before + 1)
      expect(after.at(-1)).toMatchObject({
        title: 'new',
        pid: 7001,
        session_id: 'abcdabcd-0000-4000-8000-000000000001',
        name: 'w-new-260921141320',
        socket_path: '/run/user/1000/cc-socks/7001.sock',
        config_dir: '/fixture/lic/a',
        cwd: '/work/new',
        model: 'opus',
        effort: 'high',
        result_file: `${LAUNCH_RUNS}/20260921141320-new.json`,
        err_file: `${LAUNCH_RUNS}/20260921141320-new.err`,
        started_at: NOW_MS / 1000,
      })
      // Registered once: later polls leave it as it is.
      await w.clock.advance(5000)
      expect(lastRegistry(w).filter(one => one.pid === 7001).length).toBe(1)
    } finally {
      LINUX_FIXTURE.isWorkerHidden = false
    }
  })

  test('a worker still not seen 10 minutes after its launch is no longer looked for', { options: OPTIONS }, async ($, on) => {
    LINUX_FIXTURE.isWorkerHidden = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('it is not registered yet')
      for (let step = 0; step < 121; step++) await w.clock.advance(5000)
      LINUX_FIXTURE.isWorkerHidden = false
      await w.clock.advance(5000)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
    } finally {
      LINUX_FIXTURE.isWorkerHidden = false
    }
  })

  // The registry read back as the plugin wrote it (REGISTRY_READS): the poll that registers a late worker reads its own
  // entry back, and its probe ran before that entry existed.
  describe('a worker the poll registers after the launch\'s 30 s, with the registry read back as written', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const PONG = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', duration_ms: 1300, num_turns: 1, total_cost_usd: 0.0025, session_id: SID_NEW })
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: args, runs: LAUNCH_RUNS, knobs: LINUX_FIXTURE },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        runs: `C:${LAUNCH_RUNS}`,
        knobs: WINDOWS,
      },
    ] as const
    const completions = async ($: { prompt: { submit: (e: never) => Promise<{ context?: readonly unknown[] }> } }) =>
      ((await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)).context ?? []).filter(line => String(line).startsWith('session-control completions: '))

    for (const host of hosts) {
      test(`${host.name}: the poll that registers it does not judge it; it stays registered with its pid while it runs, no toast, no note; when it ends it is harvested once, with its outcome`, { options: host.options }, async ($, on) => {
        REGISTRY_READS.isCurrent = true
        host.knobs.isWorkerHidden = true
        try {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          echoPrompt(on)
          await boot($, host.dir)
          // The start's harvest (the limited worker) rides on a first prompt.
          await completions($ as never)
          const out = await launchTool($, host.launch)
          expect(String(out.result)).toStartWith('Started in the background, but no claude process for it appeared within 30 s: it is not registered yet.')
          const mine = () => lastRegistry(w).filter(one => one.session_id === SID_NEW)
          const told = () => w.toasts.filter(one => one.includes(' \u00B7 new: '))
          // The worker shows and runs on: the next poll registers it and leaves it as it is.
          host.knobs.isWorkerHidden = false
          await w.clock.advance(5000)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001, result_file: `${host.runs}/20260921141320-new.json` })] as never)
          expect(mine().some(one => 'outcome' in one || 'reported' in one)).toBe(false)
          expect(told()).toEqual([])
          expect(await completions($ as never)).toEqual([])
          // The polls after it judge it by its own proof of life: running, still registered with its pid.
          await w.clock.advance(5000)
          await w.clock.advance(5000)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001 })] as never)
          expect(mine().some(one => 'outcome' in one)).toBe(false)
          expect(told()).toEqual([])
          // It ends with its report: harvested once, by the next poll, with the outcome its result file holds.
          WORKER.resultText = PONG
          host.knobs.isWorkerHidden = true
          await w.clock.advance(5000)
          expect(mine()).toEqual([expect.objectContaining({ reported: false, outcome: { kind: 'clean', summary: 'clean: PONG', costUsd: 0.0025 } })] as never)
          expect(mine().some(one => 'pid' in one)).toBe(false)
          await w.clock.advance(5000)
          expect(told()).toEqual(['Session finished \u00B7 new: clean: PONG'])
          const notes = await completions($ as never)
          expect(notes.length).toBe(1)
          expect(String(notes[0])).toStartWith('session-control completions: new: clean: PONG')
          expect(await completions($ as never)).toEqual([])
        } finally {
          REGISTRY_READS.isCurrent = false
          host.knobs.isWorkerHidden = false
          WORKER.resultText = undefined
        }
      })
    }
  })

  // Two launches of the same dir, config dir and model: the first one's worker never appears, so the first launch is on
  // the late list while the second launch reads its own worker's sessions file and a poll comes.
  describe('a launch on the late list and a later launch of the same dir, config dir and model', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const hosts = [
      { name: 'Linux', options: { ...OPTIONS, debug: true }, env: { HOME }, dir: ORCH_DIR, launch: args, configDir: '/fixture/lic/a', trace: `${LAUNCH_RUNS}/trace.log`, knobs: LINUX_FIXTURE },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '', debug: true },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        configDir: 'C:/fixture/home/.claude',
        trace: `C:${LAUNCH_RUNS}/trace.log`,
        knobs: WINDOWS,
      },
    ] as const
    const resultOf = (answer: string) => /Result: (\S+\.json)/.exec(answer)?.[1]

    for (const host of hosts) {
      test(`${host.name}: the later launch's worker is registered once, for the later launch; the first launch never claims it and is dropped after its 10 minutes`, { options: host.options }, async ($, on) => {
        REGISTRY_READS.isCurrent = true
        host.knobs.isWorkerHidden = true
        let release = () => {}
        try {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          await boot($, host.dir)
          const firstAt = w.clock.now()
          const first = String((await launchTool($, host.launch)).result)
          expect(first).toStartWith('Started in the background, but no claude process for it appeared within 30 s: it is not registered yet.')
          await w.clock.advance(5000)
          await w.clock.advance(5000)
          // The first launch's worker never ran. The second launch's worker runs; its launch is held at its sessions file
          // while a poll comes.
          w.spawned = false
          host.knobs.isWorkerHidden = false
          let isHeld = false
          HELD.sessions = new Promise(resolve => {
            release = () => resolve(undefined)
          })
          HELD.heldSessions = () => {
            isHeld = true
          }
          const pending = launchTool($, host.launch)
          for (let step = 0; step < 100 && !isHeld; step++) await w.clock.settle()
          expect(isHeld).toBe(true)
          const polled = w.clock.advance(5000)
          await w.clock.settle()
          release()
          HELD.sessions = undefined
          await polled
          const second = String((await pending).result)
          expect(second).toStartWith(`Launched pid 7001, session ${SID_NEW}, config_dir ${host.configDir}, registered.`)
          const [firstResult, secondResult] = [resultOf(first), resultOf(second)]
          expect(firstResult === undefined || secondResult === undefined || firstResult === secondResult).toBe(false)
          const mine = () => lastRegistry(w).filter(one => one.session_id === SID_NEW || one.pid === 7001)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001, session_id: SID_NEW, result_file: secondResult })] as never)
          expect(lastRegistry(w).some(one => one.result_file === firstResult)).toBe(false)
          expect(traceOf(w, host.trace).filter(line => line.event === 'worker.registered' && line.isLate === true)).toEqual([])
          // The first launch stays looked for until 10 minutes after it, then is dropped; nothing more is registered.
          const dropped = () => traceOf(w, host.trace).filter(line => line.event === 'worker.missing' && line.isLookedFor === false).length
          while (w.clock.now() < firstAt + 595_000) await w.clock.advance(5000)
          expect(dropped()).toBe(0)
          for (let step = 0; step < 3; step++) await w.clock.advance(5000)
          expect(dropped()).toBe(1)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001, session_id: SID_NEW, result_file: secondResult })] as never)
          expect(lastRegistry(w).some(one => one.result_file === firstResult)).toBe(false)
        } finally {
          release()
          HELD.sessions = undefined
          HELD.heldSessions = undefined
          REGISTRY_READS.isCurrent = false
          host.knobs.isWorkerHidden = false
        }
      })
    }
  })

  describe('a worker that ends before its sessions file is read', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    /** The result file of a run that finished: the engine's `--output-format json` line with the session id. */
    const FINISHED = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', duration_ms: 1300, num_turns: 1, total_cost_usd: 0.0025, session_id: SID_NEW })
    const NOTE = 'session-control completions: new: clean: PONG; new: report check: report lacks git status -sb and git log --oneline @{u}..HEAD with their exit codes'
    const TOAST = 'Session finished \u00B7 new: clean: PONG'
    const RUNS_DIR = `${HOME}/.claude/session-control/runs`
    const hosts = [
      {
        name: 'Linux',
        options: OPTIONS,
        env: { HOME },
        dir: ORCH_DIR,
        launch: args,
        cwd: '/work/new',
        configDir: '/fixture/lic/a',
        sessions: '/fixture/lic/a/sessions/7001.json',
        sessionsShown: '/fixture/lic/a/sessions/7001.json',
        runs: RUNS_DIR,
        socket: '/run/user/1000/cc-socks/7001.sock',
        knobs: LINUX_FIXTURE,
      },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        cwd: 'C:/work/new',
        configDir: 'C:/fixture/home/.claude',
        sessions: '/fixture/home/.claude/sessions/7001.json',
        sessionsShown: 'C:/fixture/home/.claude/sessions/7001.json',
        runs: `C:${RUNS_DIR}`,
        socket: undefined,
        knobs: WINDOWS,
      },
    ] as const
    const userPrompt = async ($: { prompt: { submit: (e: never) => Promise<{ context?: readonly unknown[] }> } }) => (await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)).context ?? []
    const reset = (host: (typeof hosts)[number]) => {
      MISSING.clear()
      WORKER.resultText = undefined
      host.knobs.isWorkerHidden = false
    }

    for (const host of hosts) {
      const result = `${host.runs}/20260921141320-new.json`
      const err = `${host.runs}/20260921141320-new.err`
      /** The entry the launch writes for a worker registered from its result file, ended at `endedSec`. */
      const finishedEntry = (endedSec: number) => ({
        title: 'new',
        session_id: SID_NEW,
        name: 'w-new-260921141320',
        config_dir: host.configDir,
        cwd: host.cwd,
        model: 'opus',
        effort: 'high',
        result_file: result,
        err_file: err,
        started_at: NOW_MS / 1000,
        reported: false,
        outcome: { kind: 'clean', summary: 'clean: PONG', costUsd: 0.0025 },
        ended_at: endedSec,
      })

      test(`${host.name}: its result file holds the session id: registered at once as a finished entry, harvested once, one completion note, sound and audited as any finished worker`, { options: host.options }, async ($, on) => {
        const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
        echoPrompt(on)
        await boot($, host.dir)
        // The start's harvest (the limited worker) rides on a first prompt.
        await userPrompt($ as never)
        MISSING.add(host.sessions)
        WORKER.resultText = FINISHED
        try {
          const out = await launchTool($, host.launch)
          const endedSec = Math.floor(w.clock.now() / 1000)
          expect(String(out.result)).toBe(
            `Worker pid 7001 started and ended before its sessions file could be read: session ${SID_NEW} (from its result file), config_dir ${host.configDir}, registered as finished, outcome clean. ` +
              `Name: w-new-260921141320; socket: none. Result: ${result}; errors: ${err}.`,
          )
          // The process has gone: later probes do not show it.
          host.knobs.isWorkerHidden = true
          const entries = lastRegistry(w).filter(one => one.session_id === SID_NEW)
          expect(entries).toEqual([finishedEntry(endedSec)])
          expect(w.toasts.filter(one => one === TOAST).length).toBe(1)
          // The next polls neither register it again nor harvest it again.
          await w.clock.advance(5000)
          await w.clock.advance(5000)
          expect(lastRegistry(w).filter(one => one.session_id === SID_NEW)).toEqual([finishedEntry(endedSec)])
          expect(w.toasts.filter(one => one === TOAST).length).toBe(1)
          // One completion note, on the next prompt, and on none after it.
          const completions = (context: readonly unknown[]) => context.filter(line => String(line).startsWith('session-control completions: '))
          expect(completions(await userPrompt($ as never))).toEqual([NOTE])
          expect(completions(await userPrompt($ as never))).toEqual([])
          // The registry is sound; the entry is a finished one not yet reported, and the audit finds of it only what it
          // finds of any finished worker not acknowledged (its run files named by the entry, so no loose file).
          const text = w.writes.filter(one => fixture(one.path) === REGISTRY_PATH).at(-1)?.text
          expect(isRegistrySound(text)).toBe(true)
          const parsed = parseRegistry(text ?? '')
          const entry = (parsed.ok ? parsed.entries : []).find(one => one.session_id === SID_NEW)
          expect(entry === undefined ? undefined : rowStatus(entry, parseProcFacts(''))).toBe('unreported')
          const runFile = (name: string) => ({ name, kind: 'file' as const, size: 10, mtimeMs: NOW_MS })
          const findings = auditFindings({ entries: entry === undefined ? [] : [entry], facts: parseProcFacts(''), nowMs: w.clock.now(), runs: [runFile('20260921141320-new.json'), runFile('20260921141320-new.err')] })
          expect(findings.map(one => [one.kind, one.subject])).toEqual([['unacknowledged', 'session abcdabcd "new"']])
        } finally {
          reset(host)
        }
      })

      for (const [what, text] of [
        ['no result file', undefined],
        ['a result file without a session id', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG' })],
        ['a result file that is not JSON', '{"type":"result","is_error":false,"sess'],
      ] as const) {
        test(`${host.name}: ${what}: not registered, the answer names both files and what the poll does; the poll registers it once a file holds the session id`, { options: host.options }, async ($, on) => {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          await boot($, host.dir)
          MISSING.add(host.sessions)
          WORKER.resultText = text
          try {
            const out = await launchTool($, host.launch)
            expect(String(out.result)).toBe(
              'Worker pid 7001 started but its session id could not be read; registry NOT written. ' +
                `Neither its sessions file (${host.sessionsShown}) nor its result file (${result}) holds a session id yet. ` +
                "The mod's poll reads them again and registers the worker as soon as one of them holds it (up to 10 min after the launch): " +
                `from the sessions file while it runs, from the result file once it has ended. Until then it is not registered: while it runs it is an orphan row in list_sessions (cwd ${host.cwd}). ` +
                `Errors: ${err}.`,
            )
            expect(lastRegistry(w).some(one => one.cwd === host.cwd)).toBe(false)
            // A poll while neither file holds it registers nothing.
            await w.clock.advance(5000)
            expect(lastRegistry(w).some(one => one.cwd === host.cwd)).toBe(false)
            if (text === undefined) {
              // The sessions file shows while the worker runs: registered with its pid, as the launch registers a worker.
              MISSING.clear()
              await w.clock.advance(5000)
              expect(lastRegistry(w).filter(one => one.cwd === host.cwd)).toEqual([
                expect.objectContaining({ pid: 7001, session_id: SID_NEW, name: 'w-new-260921141320', ...(host.socket === undefined ? {} : { socket_path: host.socket }), result_file: result }),
              ] as never)
            } else {
              // The worker ends and its result file holds the session id: registered as a finished entry, harvested once.
              host.knobs.isWorkerHidden = true
              WORKER.resultText = FINISHED
              const polledSec = Math.floor(w.clock.now() / 1000)
              await w.clock.advance(5000)
              const entries = lastRegistry(w).filter(one => one.cwd === host.cwd)
              // Ended when the poll registered it, within the 5 s the clock moved.
              const endedSec = Number(entries[0]?.ended_at)
              expect(endedSec >= polledSec && endedSec <= Math.floor(w.clock.now() / 1000)).toBe(true)
              expect(entries).toEqual([finishedEntry(endedSec)])
              await w.clock.advance(5000)
              expect(lastRegistry(w).filter(one => one.cwd === host.cwd)).toEqual(entries)
              expect(w.toasts.filter(one => one === TOAST).length).toBe(1)
            }
          } finally {
            reset(host)
          }
        })
      }
    }
  })

  test('a missing registry is registered into as an empty one', { options: OPTIONS }, async ($, on) => {
    MISSING.add(REGISTRY_PATH)
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
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
      await boot($)
      // The fixture's `test -e` answers every file as missing, so activation's own helper-file creation is not counted.
      const before = w.writes.length
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('registry write FAILED: the registry cannot be read')
      expect(w.writes.slice(before).some(one => one.path.startsWith(REGISTRY_PATH))).toBe(false)
    } finally {
      UNREADABLE.clear()
    }
  })

  for (const [name, pick, input, denied] of <[string, string | undefined, object, string][]>[
    ['refuses the orchestrator dir as cwd', undefined, { ...args, dir: ORCH_DIR }, 'orchestrator dir'],
    ['refuses an empty licence pick', '', args, 'no licence has room'],
    ['refuses a resume of a live session', undefined, { ...args, resume_sid: SID_ALIVE }, 'pid 4101'],
  ]) {
    test(name, { options: OPTIONS }, async ($, on) => {
      world(on, pick)
      await boot($)
      const ran = await launchTool($, input)
      expect(String(ran.deny)).toContain(denied)
    })
  }

  test('the report check sends a faulty report back once, and passes a clean one', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.Stop', () => ({}))
    await boot($)
    const stop = (answer: string, again = false) =>
      ({ hook_event_name: 'Stop', stop_hook_active: again, last_assistant_message: answer, session_id: 's', transcript_path: '/t', cwd: ORCH_DIR }) as never
    const bad = await $.classic.Stop(stop('It is not a bug, but a feature.'))
    expect(bad.block).toContain('Report check failed')
    expect((await $.classic.Stop(stop('It is not a bug, but a feature.', true))).block).toBeUndefined()
    expect((await $.classic.Stop(stop('The worker finished: 3 files changed.'))).block).toBeUndefined()
  })

  test('launch_worker refuses a prompt without the checklist items', { options: OPTIONS }, async ($, on) => {
    world(on)
    await boot($)
    const out = await launchTool($, { ...args, prompt_file: '/work/new/thin.md' })
    expect(JSON.stringify(out)).toContain('the prompt lacks')
  })

  // A task notification's prompt runs the harvest it ran before decision mod-28's prompt fix, bounded: it waits at most
  // PROMPT_HARVEST_SEC (a pause in a process: `sleep` on Linux, the helper's pause on Windows) for that harvest.
  describe('a task notification\'s prompt and the harvest it starts', () => {
    const ALIVE_RESULT = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_ALIVE ? { ...one, result_file: '/fixture/results/alive.json' } : one)))
    const NOTE = 'session-control completions: alive worker: killed: background task killed'
    const KILLED_TOAST = 'Session killed \u00B7 alive worker: killed: background task killed'
    const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' }
    const hosts = [
      { name: 'Linux', options: { ...OPTIONS, debug: true }, dir: ORCH_DIR, env: { HOME }, knobs: LINUX_FIXTURE },
      { name: 'Windows', options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' }, dir: `C:${ORCH_DIR}`, env: WIN_ENV, knobs: WINDOWS },
    ] as const
    /** A prompt submitted and not awaited: whether it has returned yet, and its answer. */
    const submitted = ($: { prompt: { submit: (e: never) => Promise<{ context?: readonly unknown[] }> } }, text: string, kind: string) => {
      const state: { isDone: boolean; sent: Promise<{ context?: readonly unknown[] }> } = { isDone: false, sent: Promise.resolve({}) }
      state.sent = $.prompt.submit({ text, wait: false, origin: { kind } } as never).then(sent => {
        state.isDone = true
        return sent
      })
      return state
    }

    for (const host of hosts) {
      test(`${host.name}: a slow harvest holds the task notification's prompt for its 3 s bound and no longer; the prompt goes on without the note, which rides on the next prompt`, { options: host.options }, async ($, on) => {
        const w = world(on, '/fixture/lic/a\n', true, ALIVE_RESULT, host.env)
        echoPrompt(on)
        await boot($, host.dir)
        await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } } as never)
        host.knobs.isAliveGone = true
        // The harvest's probe answers only 8 s on.
        host.knobs.probeLateMs = 8000
        try {
          const at = w.clock.now()
          const prompt = submitted($ as never, TASK_NOTIFICATION_KILLED, 'task-notification')
          await w.clock.advance(PROMPT_HARVEST_SEC * 1000 - 1)
          expect(prompt.isDone).toBe(false)
          await w.clock.advance(1)
          // Back at the bound, 3000 ms on the clock, without the note: the harvest has not ended.
          expect(prompt.isDone).toBe(true)
          expect(w.clock.now() - at).toBe(PROMPT_HARVEST_SEC * 1000)
          expect((await prompt.sent).context).toBeUndefined()
          expect(w.toasts).not.toContain(KILLED_TOAST)
          if (host.name === 'Linux') expect(traceOf(w).filter(line => line.event === 'prompt.harvest').map(line => [line.isInTime, line.ms])).toEqual([[false, PROMPT_HARVEST_SEC * 1000]])
          // The harvest goes on behind the prompt and ends with its probe; its note rides on the next prompt of any origin.
          host.knobs.probeLateMs = 0
          await w.clock.advance(5000)
          expect(w.toasts).toContain(KILLED_TOAST)
          expect((await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)).context?.[0]).toBe(NOTE)
        } finally {
          host.knobs.isAliveGone = false
          host.knobs.probeLateMs = 0
        }
      })
    }

    test('a prompt of any other origin starts no harvest and waits for nothing: no probe, no bound', { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, ALIVE_RESULT)
      echoPrompt(on)
      await boot($)
      LINUX_FIXTURE.isAliveGone = true
      try {
        const [calls, runs] = [w.calls.length, w.runs.length]
        for (const kind of ['user', 'composer', 'peer']) await $.prompt.submit({ text: 'hello', wait: false, origin: { kind } } as never)
        expect(w.calls.slice(calls).filter(one => one.op === 'probe')).toEqual([])
        expect(w.runs.slice(runs).filter(argv => argv[0] === 'sleep')).toEqual([])
        expect(w.toasts).not.toContain(KILLED_TOAST)
      } finally {
        LINUX_FIXTURE.isAliveGone = false
      }
    })
  })

  // The registry read back as written (REGISTRY_READS): the worker launched here runs as pid 7001 and its launch's
  // background task is `fixture` (the fixture's Bash answer); the alive worker 4101 is given a result file per test.
  describe('a task notification\'s status and the worker it names', () => {
    const notification = (taskId: string) =>
      `<task-notification>\n<task-id>${taskId}</task-id>\n<output-file>/tmp/tasks/${taskId}.output</output-file>\n<status>killed</status>\n<summary>Background command was killed</summary>\n</task-notification>`
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const aliveWith = (resultFile: string) => JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_ALIVE ? { ...one, result_file: resultFile } : one)))
    const ALIVE_UNWRITTEN = aliveWith('/fixture/results/alive.json')
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: args, knobs: LINUX_FIXTURE },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        knobs: WINDOWS,
      },
    ] as const
    const outcomeOf = (w: World, sid: string) => (lastRegistry(w).find(one => one.session_id === sid)?.outcome as { kind?: string; summary?: string } | undefined)?.summary
    const reset = (host: (typeof hosts)[number]) => {
      REGISTRY_READS.isCurrent = false
      WORKER.resultText = undefined
      host.knobs.isProbeBroken = false
      host.knobs.isWorkerHidden = false
      host.knobs.isAliveGone = false
    }

    for (const host of hosts) {
      test(`${host.name}: a notification that names a launch of this load: its status goes to that worker alone`, { options: host.options }, async ($, on) => {
        REGISTRY_READS.isCurrent = true
        try {
          // The alive worker has no result written either: only the status tells the two apart.
          const w = world(on, '/fixture/lic/a\n', true, ALIVE_UNWRITTEN, host.env)
          echoPrompt(on)
          await boot($, host.dir)
          expect(String((await launchTool($, host.launch)).result)).toStartWith('Launched pid 7001')
          await w.clock.advance(5000)
          // Both workers end; the notification names the launch's task: killed, with no result written.
          host.knobs.isAliveGone = true
          host.knobs.isWorkerHidden = true
          await $.prompt.submit({ text: notification('fixture'), wait: false, origin: { kind: 'task-notification' } })
          expect(outcomeOf(w, SID_NEW)).toBe('killed: background task killed')
          expect(outcomeOf(w, SID_ALIVE)).toBe('killed: no result written')
          expect(w.toasts).toContain('Session killed \u00B7 new: killed: background task killed')
        } finally {
          reset(host)
        }
      })

      for (const [what, resultText, summary] of [
        ['a success', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: SID_NEW }), 'clean: PONG'],
        ['an error', JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Stopped at the turn limit', session_id: SID_NEW }), 'error: Stopped at the turn limit'],
      ] as const) {
        test(`${host.name}: a killed notification for a launch whose result file holds a finished run, ${what}: the run's outcome`, { options: host.options }, async ($, on) => {
          REGISTRY_READS.isCurrent = true
          try {
            const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
            echoPrompt(on)
            await boot($, host.dir)
            expect(String((await launchTool($, host.launch)).result)).toStartWith('Launched pid 7001')
            await w.clock.advance(5000)
            WORKER.resultText = resultText
            host.knobs.isWorkerHidden = true
            await $.prompt.submit({ text: notification('fixture'), wait: false, origin: { kind: 'task-notification' } })
            expect(outcomeOf(w, SID_NEW)).toBe(summary)
          } finally {
            reset(host)
          }
        })
      }
    }
  })

  test('the first prompt after a compaction carries the state digest, once', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.PostCompact', () => ({}))
    echoPrompt(on)
    await boot($)
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
    echoPrompt(on)
    on('session.send', () => ({ isDelivered: true }) as never)
    on('session.receive', (_$, e) => ({ text: e.text }))
    await boot($)
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
    await boot($)
    await runCommand($, 'side')
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
    await boot($)
    await runCommand($, 'side')
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /^\u2022 Queued one$/ })).toBeDefined()
  })

  describe('retire_workers with reviewed', () => {
    const stuck = (n: number, kind: string, extra: object = {}) => ({ title: `stuck ${kind}`, session_id: `5757575${n}-0000-4000-8000-00000000000${n}`, config_dir: '/fixture/lic/a', reported: true, outcome: { kind, summary: `${kind}: old label` }, ...extra })
    const login = stuck(1, 'login')
    const limit = stuck(2, 'limit')
    const killed = stuck(3, 'killed')
    const kept = stuck(4, 'login', { keep: true })
    // The first eight characters of a queued task's title name this session.
    const queued = { ...stuck(5, 'limit'), session_id: 'Queued o-0000-4000-8000-000000000005' }
    const setup = async (on: Parameters<typeof world>[0], $: Parameters<Parameters<typeof test>[2]>[0]) => {
      const w = world(on, '/fixture/lic/a\n', true, JSON.stringify([...JSON.parse(REGISTRY_TEXT), login, limit, killed, kept, queued]))
      await boot($)
      return w
    }
    const retire = async ($: Parameters<Parameters<typeof test>[2]>[0], input: object) =>
      String((await $.tool.call({ tool: 'mcp__session-control__retire_workers', ...input } as never)).result)
    const clears = (w: World) => w.writes.filter(one => one.path.endsWith('/cleared.jsonl'))

    test('login, limit and killed outcomes are retired on a reason; the log and the answer carry the original outcome and the reason', { options: OPTIONS }, async ($, on) => {
      const w = await setup(on, $)
      const out = await retire($, {
        session_ids: [login.session_id.slice(0, 8), limit.session_id, killed.session_id.slice(0, 8)],
        reviewed: { [login.session_id.slice(0, 8)]: 'run succeeded, label from the old classifier', [limit.session_id]: 'work done, limit text was quoted', [killed.session_id.slice(0, 8)]: 'abandoned on purpose' },
      })
      expect(out).toBe('Retired: 57575751, 57575752, 57575753. Retired with review: 57575751 (was login: run succeeded, label from the old classifier); 57575752 (was limit: work done, limit text was quoted); 57575753 (was killed: abandoned on purpose).')
      expect(clears(w).length).toBe(1)
      const lines = clears(w)[0]?.text.trimEnd().split('\n').map(line => JSON.parse(line)) ?? []
      expect(lines.map(one => [one.session_id, one.outcome.kind, one.reviewed_outcome, one.reviewed_reason])).toEqual([
        [login.session_id, 'login', 'login', 'run succeeded, label from the old classifier'],
        [limit.session_id, 'limit', 'limit', 'work done, limit text was quoted'],
        [killed.session_id, 'killed', 'killed', 'abandoned on purpose'],
      ])
      // The entry is logged as it was, with the two fields appended last.
      expect(Object.keys(lines[0]).slice(-2)).toEqual(['reviewed_outcome', 'reviewed_reason'])
      expect(Object.keys(lines[0]).slice(0, -2)).toEqual(Object.keys(login))
      const left = lastRegistry(w).map(one => one.session_id)
      for (const gone of [login, limit, killed]) expect(left).not.toContain(gone.session_id)
      expect(left).toContain(kept.session_id)
    })
  })

  test('open_point and record_decision edit the helper files, back them up first, and report a refusal', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const added = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'add', id: 'fresh', title: 'T', detail: 'D', recommendation: 'R' } as never)
    expect(String(added.result)).toContain('open-points.json: added fresh.')
    const backup = w.writes.find(one => one.path.includes('/backups/open-points-before-open-point-'))
    expect(backup?.text).toBe(OPEN_POINTS_TEXT)
    const written = w.writes.find(one => one.path === `${ORCH_DIR}/open-points.json`)
    expect(JSON.parse(written?.text ?? '{}').points.some((p: { id: string }) => p.id === 'fresh')).toBe(true)
    const refused = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'close', id: 'nope', resolution: 'x' } as never)
    expect(JSON.stringify(refused)).toContain('no open point nope')
  })

  test('open_point list and queue_task list read the helper files without a write, a backup or a refresh, and the panel shows the same points and tasks', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($)
    const before = w.writes.length
    const all = (await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list' } as never)) as { result?: string }
    expect(all.result?.split('\n')[0]).toBe('open-points.json: 3 points (open and held)')
    expect([...String(all.result).matchAll(/^open point (\S+)$/gm)].map(one => one[1])).toEqual(['a', 'c', 'd'])
    expect(all.result).toContain('  held: yes\n  title: Held')
    const open = (await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list', status: 'open' } as never)) as { result?: string }
    const bad = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list', status: 'archived' } as never)
    expect(JSON.stringify(bad)).toContain('unknown status archived')
    const queue = (await $.tool.call({ tool: 'mcp__session-control__queue_task', action: 'list' } as never)) as { result?: string }
    expect(queue.result).toBe('task-queue.json: 2 tasks\n\ntask q1\n  title: Queued one\n  status: queued\n\ntask q2\n  title: Finished\n  status: done')
    // Nothing was written: no helper file, no backup, no archive.
    expect(w.writes.length).toBe(before)
    // The panel's open points and queued work are what the same readers give.
    const snapshot = String(((await $.tool.call({ tool: 'mcp__session-control__panel_snapshot' } as never)) as { result?: string }).result)
    const titles = (text: string) => [...text.matchAll(/^ {2}title: (.*)$/gm)].map(one => one[1])
    const panel = snapshot.slice(snapshot.indexOf('OPEN POINTS')).split('\n').filter(line => /^ {2}\d+\. /.test(line)).map(line => line.replace(/^ {2}\d+\. /, ''))
    expect(panel).toEqual(titles(String(open.result)))
    expect(snapshot).toContain('QUEUED WORK\n\u2022 Queued one\n')
  })

  test('open_point list and queue_task list on missing helper files answer empty and create nothing', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    for (const file of ['open-points.json', 'task-queue.json']) MISSING.add(`${ORCH_DIR}/${file}`)
    try {
      const before = w.writes.length
      const points = (await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list' } as never)) as { result?: string }
      expect(points.result).toBe('open-points.json: 0 points (open and held)')
      const queue = (await $.tool.call({ tool: 'mcp__session-control__queue_task', action: 'list' } as never)) as { result?: string }
      expect(queue.result).toBe('task-queue.json: 0 tasks')
      expect(w.writes.length).toBe(before)
    } finally {
      MISSING.clear()
    }
  })

  test('seated inline the panel is one box behind tabs, at most 11 rows, and a tab switches the box', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
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
    await boot($)
    await runCommand($, 'side')
    return mountPane($)
  }

  test('the panel starts with three equal boxes, each header holding an expand icon, and no one-line header', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on)
    expect(await layoutOf(ui)).toEqual(THREE)
    expect(await headersOf(ui)).toEqual([])
    for (const id of ['sessions', 'queue', 'points']) expect((await ui.find({ key: `x:${id}` }))?.props.label).toBe('[+]')
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
    await boot($)
    await runCommand($, 'side')
    const ui = await mountPane($)
    await ui.press({ key: 'x:points' })
    expect(await layoutOf(ui)).toEqual(EXPANDED.points)
    expect((await runCommand($, 'side')).text).toBe('Session-control panel hidden, session-control stays on.')
    await ui.unmount()
    isUp = false
    await runCommand($, 'side')
    const again = await mountPane($)
    expect(await layoutOf(again)).toEqual(THREE)
    await again.press({ key: 'x:queue' })
    // The engine's close mark closes the pane without the command: the next show still starts collapsed.
    await again.unmount()
    isUp = false
    await runCommand($, 'side')
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
    await boot($)
    await runCommand($, 'side')
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
  /** A launch, an acknowledgement and a retirement, the helper shown as <helper>. */
  const flow = async ($: Parameters<Parameters<typeof test>[2]>[0], w: World) => {
    await boot($)
    expect(String((await launchTool($, args)).result)).toContain('Launched pid 7001')
    expect(String((await $.tool.call({ tool: 'mcp__session-control__acknowledge_workers', session_ids: ['cccccccc'] } as never)).result)).toContain('Acknowledged: cccccccc.')
    expect(String((await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['dddddddd'] } as never)).result)).toContain('Retired: dddddddd.')
    return w.runs.map(pinned)
  }
  // The helper's operations, each one process: the probe, the registry's atomic write, the cleared log's append.
  const probe = ['node', '<helper>', 'probe']
  const rename = ['node', '<helper>', 'writeAtomic']
  /** The Node helper's one lookup, made when the board goes on, before anything that needs it. */
  const NODE_LOOKUP = ['node', '--version']
  const RUNS = `${HOME}/.claude/session-control/runs`
  /**
   * The commands the Linux flow runs (the jq calls aside): the lookup of Node first, then the probe, the registry's
   * rename and the cleared log's append through the helper.
   */
  const LINUX = [
    NODE_LOOKUP,
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
    ['node', '<helper>', 'append'],
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
  const recorded: { off?: { runs: string[][]; writes: World['writes']; reads: string[]; bash: World['bash'] } } = {}
  test('Linux, the trace off: a launch, an acknowledgement and a retirement, recorded', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    expect(await flow($, w)).toEqual(LINUX)
    recorded.off = { runs: w.runs, writes: w.writes, reads: w.reads, bash: w.bash }
  })

  // The PowerShell route is native Windows' own: on Linux, and on WSL with Windows values in its environment, the
  // option changes nothing, down to the Bash tool's input.
  for (const [name, env] of [linuxLike[0], linuxLike[1]] as [string, Record<string, string>][]) {
    test(`Linux, launchRoute powershell: the same commands, writes, reads and Bash call as recorded without it (${name})`, { options: { ...OPTIONS, launchRoute: 'powershell' } }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, env)
      expect(await flow($, w)).toEqual(LINUX)
      expect(recorded.off).toBeDefined()
      expect(w.runs).toEqual(recorded.off?.runs ?? [])
      expect(w.writes).toEqual(recorded.off?.writes ?? [])
      expect(w.reads).toEqual(recorded.off?.reads ?? [])
      // The engine gives every call a tool_use_id of its own; the rest of the Bash tool's input is the same.
      const input = (calls: World['bash']) => calls.map(({ tool_use_id: _id, ...rest }: Record<string, unknown>) => rest)
      expect(input(w.bash)).toEqual(input(recorded.off?.bash ?? []))
      expect(w.bash.length).toBe(1)
      expect(w.powershell).toEqual([])
    })
  }

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
  /** The Windows machine of the fixture, with `pick` the licence picker's output. */
  const winWorld = (on: On, pick = '/fixture/lic/a\n') => world(on, pick, true, REGISTRY_TEXT, WINDOWS_ENV)
  const WIN_OPTIONS = { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}` }
  const WIN_REGISTRY = `C:${REGISTRY_PATH}`
  const WIN_RUNS = `C:${RUNS}`

  test('Windows, the trace on: a poll tick with a failing probe writes its lines through the helper', { options: { ...WIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = winWorld(on)
    await boot($, `C:${ORCH_DIR}`)
    const trace = `${WIN_RUNS}/trace.log`
    expect(traceOf(w, trace)[0]).toMatchObject({ event: 'session.start', platform: 'windows' })
    WINDOWS.isProbeBroken = true
    try {
      const before = traceOf(w, trace).length
      await w.clock.advance(5000)
      // The probe's stderr is output: the trace has its size, and the error that quotes it has … in its place.
      const message = 'the process probe failed (exit 1): \u2026'
      const probe = [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/probe.ps1`, ...probeArgs(JSON.parse(REGISTRY_TEXT)), 'c:C:/fixture/home/.claude']
      expect(bare(traceOf(w, trace)).slice(before)).toEqual([
        { event: 'poll.tick' },
        { event: 'process.run', argv: probe, exitCode: 1, ms: 0, stderrBytes: 'Invalid class'.length },
        { event: 'error', where: 'refresh', kind: 'exit-1', message },
        { event: 'error', where: 'panel', kind: 'exit-1', message: `Error: ${message}` },
      ])
      expect(w.writes.filter(one => one.path === trace).some(one => one.text.includes('Invalid class'))).toBe(false)
      // Each flush is one helper batch, its append to the trace in the stored C:/ form.
      const flushes = w.calls.filter(one => one.op === 'batch')
      expect(flushes.length).toBeGreaterThan(1)
      expect(flushes.every(one => (one.request.ops as { op: string; path: string }[]).every(step => step.op === 'append' && step.path === trace))).toBe(true)
    } finally {
      WINDOWS.isProbeBroken = false
    }
  })

  test('Windows: a probe that fails is an error on the panel, and no worker is taken for dead', { options: WIN_OPTIONS }, async ($, on) => {
    WINDOWS.isProbeBroken = true
    try {
      const w = winWorld(on)
      await boot($, `C:${ORCH_DIR}`)
      expect(w.toasts).toEqual(['Tracking problem \u00B7 Error: the process probe failed (exit 1): Invalid class'])
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

  test('Windows: the waits between the discovery checks are the helper\'s pause, never the engine\'s clock; a worker not seen in 30 s is answered as started, and the poll registers it when it shows', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.isWorkerHidden = true
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const before = w.calls.length
      // No settled(): nothing in the launch waits on the mocked clock.
      const out = await launchTool($, winArgs)
      expect(String(out.result)).toBe(
        'Started in the background, but no claude process for it appeared within 30 s: it is not registered yet. ' +
          "Check it with list_sessions: while it runs unregistered it is an orphan row (cwd C:/work/new); the mod's poll registers it as soon as it finds it " +
          '(up to 10 min after the launch), and its entry then takes the orphan row\'s place. ' +
          `If neither row appears, it did not start: read ${WIN_RUNS}/20260921141320-new.err. Result: ${WIN_RUNS}/20260921141320-new.json.`,
      )
      expect(w.calls.slice(before).filter(one => one.op === 'pause').map(one => one.request)).toEqual(Array.from({ length: 15 }, () => ({ ms: 2000 })))
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
      WINDOWS.isWorkerHidden = false
      await w.clock.advance(5000)
      // The poll looks in the launch's config dir too, and registers the worker as the launch would have.
      expect(w.runs.some(argv => String(argv[6]).endsWith('/probe.ps1') && argv.includes(`c:${WIN_HOME_CLAUDE}`))).toBe(true)
      expect(lastRegistry(w).at(-1)).toEqual({
        title: 'new',
        pid: 7001,
        session_id: 'abcdabcd-0000-4000-8000-000000000001',
        name: 'w-new-260921141320',
        config_dir: WIN_HOME_CLAUDE,
        cwd: 'C:/work/new',
        model: 'opus',
        effort: 'high',
        result_file: `${WIN_RUNS}/20260921141320-new.json`,
        err_file: `${WIN_RUNS}/20260921141320-new.err`,
        started_at: NOW_MS / 1000,
      })
    } finally {
      WINDOWS.isWorkerHidden = false
    }
  })

  test('Windows: an orchestrator with its own CLAUDE_CONFIG_DIR: no variable on the line, its dir in native form in the registry', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\a'
    try {
      const w = world(on, '', true, REGISTRY_TEXT, { ...WINDOWS_ENV, CLAUDE_CONFIG_DIR: 'C:\\fixture\\lic\\a\\' })
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
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
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await launchTool($, winArgs)
      expect(String(out.deny)).toContain('nothing was launched. On Windows Claude Code offers the Bash tool only when it finds Git Bash: start the orchestrator with CLAUDE_CODE_GIT_BASH_PATH set to Git\\bin\\bash.exe.')
      expect(w.bash.length).toBe(0)
    } finally {
      WORKER.isBashMissing = false
    }
  })

  // ---- the PowerShell launch route (the launchRoute option at powershell)
  const PS_OPTIONS = { ...NO_PICKER, launchRoute: 'powershell' }
  /** The PowerShell route's command for the fixture launch: its config line (none when inherited), arguments and files. */
  const psCommand = (config: string | undefined, argumentList: string, base: string, dir = 'C:/work/new', prompt = 'C:/work/new/prompt.md') =>
    [
      '$env:PSModulePath = "$PSHOME\\Modules"',
      "$ErrorActionPreference = 'Stop'",
      "$env:CLAUDE_CODE_EFFORT_LEVEL = 'high'",
      ...(config === undefined ? [] : [config]),
      '$exe = (Get-Command claude.exe -ErrorAction Stop).Source',
      `$p = Start-Process -FilePath $exe -ArgumentList '${argumentList}' -WorkingDirectory '${dir}' -RedirectStandardInput '${prompt}' ` +
        `-RedirectStandardOutput '${base}.json' -RedirectStandardError '${base}.err' -NoNewWindow -PassThru`,
      '$null = $p.Handle',
      `Set-Content -LiteralPath '${base}.pid' -Value $p.Id -Encoding Ascii`,
      '$p.WaitForExit()',
      'exit $p.ExitCode',
    ].join('\n')
  const PS_SETTINGS = '--settings "{\\"crossSessionInbound\\":\\"accept\\"}" --dangerously-skip-permissions --output-format json'

  test('Windows, launchRoute powershell: the worker starts through the PowerShell tool, Start-Process with the prompt on standard input; found and registered as by the Bash route', { options: PS_OPTIONS }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const out = await settled(w, launchTool($, winArgs))
    expect(String(out.result)).toBe(
      `Launched pid 7001, session abcdabcd-0000-4000-8000-000000000001, config_dir ${WIN_HOME_CLAUDE}, registered. ` +
        `Name: w-new-260921141320; socket: none. ` +
        `Result: ${WIN_RUNS}/20260921141320-new.json; errors: ${WIN_RUNS}/20260921141320-new.err.`,
    )
    expect(w.bash).toEqual([])
    expect(w.powershell.length).toBe(1)
    expect(w.powershell[0]).toMatchObject({ description: 'session-control worker: new', run_in_background: true, timeout: 180 * 60_000 })
    // No picker: the worker inherits the config dir, so no CLAUDE_CONFIG_DIR line.
    expect(w.powershell[0]?.command).toBe(psCommand(undefined, `-p --model opus -n w-new-260921141320 ${PS_SETTINGS}`, `${WIN_RUNS}/20260921141320-new`))
    expect(lastRegistry(w).at(-1)).toEqual({
      title: 'new',
      pid: 7001,
      session_id: 'abcdabcd-0000-4000-8000-000000000001',
      name: 'w-new-260921141320',
      config_dir: WIN_HOME_CLAUDE,
      cwd: 'C:/work/new',
      model: 'opus',
      effort: 'high',
      result_file: `${WIN_RUNS}/20260921141320-new.json`,
      err_file: `${WIN_RUNS}/20260921141320-new.err`,
      started_at: NOW_MS / 1000,
    })
    // The pid came from the probe, and the pid file was read beside it; every command is still one of the mod's scripts.
    expect(w.reads).toContain(`${WIN_RUNS}/20260921141320-new.pid`)
    expect(w.runs.every(argv => argv[0] === 'node' || (argv[0] === POWERSHELL && /\/(probe|files)\.ps1$/.test(String(argv[6]))))).toBe(true)
  })

  test('Windows, launchRoute powershell: a resume passes --resume after the model and sets the entry\'s config dir', { options: PS_OPTIONS }, async ($, on) => {
    const registry = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_DEAD ? { ...one, config_dir: 'C:/fixture/lic/b' } : one)))
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\b'
    try {
      const w = world(on, '', true, registry, WINDOWS_ENV)
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, { ...winArgs, resume_sid: SID_DEAD }))
      expect(String(out.result)).toContain(`Launched pid 7001, session ${SID_DEAD}, config_dir C:/fixture/lic/b`)
      expect(w.powershell[0]?.command).toBe(psCommand("$env:CLAUDE_CONFIG_DIR = 'C:/fixture/lic/b'", `-p --model opus --resume ${SID_DEAD} -n w-new-260921141320 ${PS_SETTINGS}`, `${WIN_RUNS}/20260921141320-new`))
    } finally {
      WINDOWS.workerConfigDir = 'C:\\fixture\\home\\.claude'
    }
  })

  test('Windows: an inline prompt that starts like a POSIX path is refused, as a prompt file would be, and nothing is written', { options: NO_PICKER }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const { prompt_file: _file, ...inline } = winArgs
    const out = await launchTool($, { ...inline, prompt: '/c/work/x: wait in the foreground, git status -sb, no attribution' })
    expect(String(out.deny)).toContain('Git Bash rewrites an argument that starts like a POSIX path')
    expect(w.writes.some(one => one.path.endsWith('.prompt.md'))).toBe(false)
  })

  test('Windows, launchRoute powershell: an inline prompt goes to standard input from the prompt file of the mod', { options: PS_OPTIONS }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const { prompt_file: _file, ...inline } = winArgs
    const out = await settled(w, launchTool($, { ...inline, prompt: 'Goal: x. Wait in the foreground. Report git status -sb. No attribution.' }))
    const own = `${WIN_RUNS}/w-new-260921141320.prompt.md`
    expect(String(out.result)).toContain(`Prompt: ${own} (written by the mod).`)
    expect(w.powershell[0]?.command).toBe(psCommand(undefined, `-p --model opus -n w-new-260921141320 ${PS_SETTINGS}`, `${WIN_RUNS}/20260921141320-new`, 'C:/work/new', own))
  })

  test('Windows, launchRoute powershell: a runs directory with brackets is refused too; the Bash route takes it', { options: { ...PS_OPTIONS, runsDir: 'C:/fixture/runs [old]' } }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const out = await launchTool($, winArgs)
    expect(String(out.deny)).toContain('cannot both be given a path with [, ] or a backtick: the runs directory C:/fixture/runs [old]; move it')
    expect(w.powershell.length).toBe(0)
  })

  test('Windows, launchRoute powershell: a pid file naming another pid is said in the answer; the probe\'s pid is the one registered', { options: PS_OPTIONS }, async ($, on) => {
    WINDOWS.pidFileText = '7002\r\n'
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
      expect(String(out.result)).toEndWith(`errors: ${WIN_RUNS}/20260921141320-new.err. The launch's pid file names pid 7002, not the one the probe found.`)
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001 })
    } finally {
      WINDOWS.pidFileText = '7001\r\n'
    }
  })

  test('Windows, launchRoute powershell: no pid file (not written yet, or unreadable) changes nothing', { options: PS_OPTIONS }, async ($, on) => {
    WINDOWS.pidFileText = undefined
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
      expect(String(out.result)).toEndWith(`errors: ${WIN_RUNS}/20260921141320-new.err.`)
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001 })
    } finally {
      WINDOWS.pidFileText = '7001\r\n'
    }
  })

  test('Windows, launchRoute powershell, the trace on: the start names the route; the worker line says whether the pid file agrees', { options: { ...PS_OPTIONS, debug: true } }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    await settled(w, launchTool($, winArgs))
    const lines = traceOf(w, `${WIN_RUNS}/trace.log`)
    expect((lines.find(line => line.event === 'session.start') as { options?: Record<string, unknown> }).options?.launchRoute).toBe('powershell')
    expect(lines.find(line => line.event === 'worker.found')).toMatchObject({ pid: 7001, pidFile: 'same' })
  })

  test('Windows: a launchRoute other than powershell is the Bash route', { options: { ...NO_PICKER, launchRoute: 'pwsh' } }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    await settled(w, launchTool($, winArgs))
    expect(w.powershell).toEqual([])
    expect(String(w.bash[0]?.command)).toStartWith(`cd 'C:/work/new' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' `)
    expect(w.reads.some(path => path.endsWith('.pid'))).toBe(false)
  })

  test('Windows: a new claude.exe whose sessions file the probe found nowhere is still the worker', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.isWorkerUnplaced = true
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
      expect(String(out.result)).toContain('Launched pid 7001, session abcdabcd-0000-4000-8000-000000000001')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, cwd: 'C:/work/new', config_dir: WIN_HOME_CLAUDE })
    } finally {
      WINDOWS.isWorkerUnplaced = false
    }
  })

  test('Windows: a picker named by absolute path runs, and its answer is taken in native form', { options: { ...WIN_OPTIONS, licencePickCommand: 'C:/fixture/bin/pick.exe --need {need}' } }, async ($, on) => {
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\a'
    try {
      const w = winWorld(on)
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, { ...winArgs, need: 25 }))
      expect(w.runs).toContainEqual(['C:/fixture/bin/pick.exe', '--need', '25'])
      expect(String(out.result)).toContain('config_dir C:/fixture/lic/a, registered')
      expect(String(w.bash[0]?.command)).toContain("CLAUDE_CONFIG_DIR='C:/fixture/lic/a'")
    } finally {
      WINDOWS.workerConfigDir = 'C:\\fixture\\home\\.claude'
    }
  })

  test('Windows: a picker by bare name is refused before anything runs', { options: { ...WIN_OPTIONS, licencePickCommand: 'pick --need {need}' } }, async ($, on) => {
    const w = winWorld(on)
    await boot($, `C:${ORCH_DIR}`)
    const out = await launchTool($, winArgs)
    expect(String(out.deny)).toBe('session-control: refused: on Windows the licence picker command must start with the absolute path of an executable (C:/.../picker.exe), not "pick"')
    expect(w.runs.some(argv => argv[0] === 'pick')).toBe(false)
    expect(w.bash.length).toBe(0)
  })

  test('Windows: a prompt too long for the command line is refused, a POSIX path too', { options: NO_PICKER }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const big = await launchTool($, { ...winArgs, prompt_file: '/c/work/new/big.md' })
    expect(String(big.deny)).toContain(`it has ${BIG_PROMPT.length}, the limit is 30000`)
    const posix = await launchTool($, { ...winArgs, dir: '/tmp/new' })
    expect(String(posix.deny)).toBe('session-control: dir must be absolute (on Windows /c/... or C:/...)')
    const gone = await launchTool($, { ...winArgs, dir: '/c/work/gone' })
    expect(String(gone.deny)).toBe('session-control: refused: directory C:/work/gone does not exist')
    expect(w.bash.length).toBe(0)
  })

  test('Windows: an empty prompt file is told by $.fs.stat', { options: NO_PICKER }, async ($, on) => {
    const w = world(on, '', false, REGISTRY_TEXT, WINDOWS_ENV)
    await boot($, `C:${ORCH_DIR}`)
    expect(String((await launchTool($, winArgs)).deny)).toBe('session-control: refused: prompt file C:/work/new/prompt.md is missing or empty')
    expect(w.bash.length).toBe(0)
  })

  test('Windows: a session\'s output box reads its transcript through the helper', { options: WIN_OPTIONS }, async ($, on) => {
    const w = winWorld(on)
    stubPanel(on)
    await boot($, `C:${ORCH_DIR}`)
    await runCommand($, '')
    const ui = await mountPane($)
    await ui.press({ key: `s:${SID_ALIVE}` })
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    expect(w.calls).toContainEqual({ op: 'tail', request: { path: `/fixture/lic/a/projects/-work-a/${SID_ALIVE}.jsonl`, lines: 600, width: 20000 } })
  })

  test('Windows: a HOME that Git Bash handed on (/c/...) is home, in native form', { options: WIN_OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { ...WINDOWS_ENV, USERPROFILE: 'C:\\Users\\other', HOME: '/c/fixture/home' })
    await boot($, `C:${ORCH_DIR}`)
    expect(w.calls.some(one => one.op === 'writeAtomic' && one.request.path === WIN_REGISTRY)).toBe(true)
  })

  test('Windows: a registry write the helper fails is said in the answer, and nothing writes the registry another way', { options: WIN_OPTIONS }, async ($, on) => {
    const w = winWorld(on)
    await boot($, `C:${ORCH_DIR}`)
    WINDOWS.isMoveBroken = true
    try {
      const before = w.writes.length
      const out = await $.tool.call({ tool: 'mcp__session-control__acknowledge_workers', session_ids: ['cccccccc'] } as never)
      expect(JSON.stringify(out)).toContain(`${WIN_REGISTRY} could not be written (ACCESS)`)
      expect(w.writes.slice(before).filter(one => fixture(one.path).startsWith(REGISTRY_PATH))).toEqual([])
      expect(w.toasts.filter(text => text.includes('not atomically'))).toEqual([])
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
  const ran = (argv: string[], exitCode = 0) => ({ event: 'process.run', argv, exitCode, ms: 0 })
  /** A helper call as the trace shows it: the operation and the fields the call names, never the request. */
  const helper = (op: string, fields: Record<string, unknown>, exitCode = 0) => ({ event: 'process.run', helper: op, ...fields, exitCode, ms: 0 })
  const PROBE = helper('probe', { args: probeArgs(JSON.parse(REGISTRY_TEXT)).length })
  const REGISTRY_WRITE = helper('writeAtomic', { path: REGISTRY_PATH })

  test('a launch: the call, the probe, the checks, the verdict, the worker and its registration, the answer', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, args)
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
      { event: 'worker.found', pid: 7001, sessionId: sid, isNamed: true, isSocketSeen: true },
      REGISTRY_WRITE,
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
      await boot($)
      await launchTool($, args)
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
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SECRET_THING: ['sk', 'should-never-appear-1234'].join('-') })
    await boot($)
    const [first] = bare(traceOf(w))
    expect(first).toEqual({
      event: 'session.start',
      cwd: ORCH_DIR,
      platform: 'linux',
      isOrchestratorDir: true,
      options: {
        orchestratorDir: ORCH_DIR,
        registryPath: '~/.claude/headless-sessions.json',
        completionWrites: true,
        pollSeconds: 5,
        runsDir: '~/.claude/session-control/runs',
        licencePickCommand: 'set',
        debug: true,
        nodePath: '',
        launchRoute: 'bash',
        notices: 'on',
      },
    })
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('sk-should') || one.text.includes(HOME + '"') || one.text.includes('/fixture/bin/pick'))).toBe(false)
  })

  test('a refused launch: the verdict with its reason, and the refusal the model gets', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    await launchTool($, { ...args, dir: ORCH_DIR })
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
    await boot($)
    await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['dddddddd'] } as never)
    const doneLine = JSON.stringify(JSON.parse(REGISTRY_TEXT).find((one: { session_id?: string }) => one.session_id === SID_DONE))
    expect(from(bare(traceOf(w)), 'tool.call')).toEqual([
      { event: 'tool.call', tool: 'retire_workers', session_ids: ['dddddddd'] },
      PROBE,
      { event: 'guard', tool: 'retire_workers', removable: [SID_DONE], refused: [] },
      helper('append', { path: `${RUNS}/cleared.jsonl` }),
      { event: 'fs.append', path: `${RUNS}/cleared.jsonl`, bytes: doneLine.length + 1, lines: 1, exitCode: 0 },
      REGISTRY_WRITE,
      PROBE,
      { event: 'tool.result', tool: 'retire_workers', result: 'Retired: dddddddd.' },
    ])
    // The entry's content is in the cleared log, never in the trace.
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('done worker'))).toBe(false)
  })

  test('the write-side tools in the trace: an inline prompt, a section heading and archived headings never reach it', { options: TRACED }, async ($, on) => {
    DECISIONS.text = '# Agreed decisions\n\n## Secret unit heading\nsu-1. x\n'
    try {
      const w = world(on)
      await boot($)
      await launchTool($, { dir: '/work/new', model: 'opus', effort: 'high', title: 'new', prompt: 'Reply PONG about the zebra-canary.', section: 'Secret unit heading', rules: true })
      await $.tool.call({ tool: 'mcp__session-control__archive_decisions', sections: ['Secret unit heading'] } as never)
      await $.tool.call({ tool: 'mcp__session-control__close_worker', session_ids: ['dddddddd'], keep: true } as never)
      const lines = from(bare(traceOf(w)), 'tool.call')
      const calls = lines.filter(line => line.event === 'tool.call')
      expect(calls).toEqual([
        { event: 'tool.call', tool: 'launch_worker', dir: '/work/new', model: 'opus', effort: 'high', rules: true },
        { event: 'tool.call', tool: 'archive_decisions' },
        { event: 'tool.call', tool: 'close_worker', session_ids: ['dddddddd'], keep: true },
      ])
      expect(lines).toContainEqual({ event: 'launch.prompt', promptFile: `${HOME}/.claude/session-control/runs/w-new-260921141320.prompt.md`, chars: expect.any(Number), isInline: true, isSectionAdded: true, isRulesAdded: true } as never)
      const text = w.writes.filter(one => one.path === TRACE).map(one => one.text).join('')
      expect(text).not.toContain('zebra-canary')
      expect(text).not.toContain('Secret unit heading')
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('a reviewed retire: the guard line names the original outcome and the reason, the call line keeps free text out', { options: TRACED }, async ($, on) => {
    const login = { title: 'stuck login', session_id: '57575751-0000-4000-8000-000000000001', config_dir: '/fixture/lic/a', reported: true, outcome: { kind: 'login', summary: 'login: old label' } }
    const w = world(on, '/fixture/lic/a\n', true, JSON.stringify([...JSON.parse(REGISTRY_TEXT), login]))
    await boot($)
    await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['57575751'], reviewed: { '57575751': 'wrong label' } } as never)
    const events = from(bare(traceOf(w)), 'tool.call')
    expect(events[0]).toEqual({ event: 'tool.call', tool: 'retire_workers', session_ids: ['57575751'] })
    expect(events).toContainEqual({ event: 'guard', tool: 'retire_workers', removable: [login.session_id], refused: [], reviewed: [{ session_id: login.session_id, was: 'login', reason: 'wrong label' }] })
    expect(events.at(-1)).toEqual({ event: 'tool.result', tool: 'retire_workers', result: 'Retired: 57575751. Retired with review: 57575751 (was login: wrong label).' })
  })

  test('a poll tick with a failing probe: the tick, the failed run, the error caught, the warning; renders are counted', { options: TRACED }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, '')
    const ui = await mountPane($)
    await ui.findAll({})
    LINUX_FIXTURE.isProbeBroken = true
    try {
      const before = traceOf(w).length
      await w.clock.advance(5000)
      const tick = bare(traceOf(w)).slice(before)
      // The helper's probe answers a fixed code; the mod says the probe failed, never what the system said.
      const message = 'the process probe failed (IO)'
      expect(tick).toEqual([
        { event: 'ui.render', count: 1 },
        { event: 'poll.tick' },
        { ...PROBE, exitCode: 1 },
        { event: 'helper.failed', op: 'probe', code: 'IO' },
        { event: 'error', where: 'refresh', message },
        { event: 'error', where: 'panel', message: `Error: ${message}` },
      ])
    } finally {
      LINUX_FIXTURE.isProbeBroken = false
    }
  })

  test('SESSION_CONTROL_DEBUG=1 switches it on; otherwise nothing is written and no trace command runs', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SESSION_CONTROL_DEBUG: '1' })
    await boot($)
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
    await boot($)
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
      await boot($, '/work/new')
      expect(w.runs).toEqual([])
      expect(w.writes).toEqual([])
      expect(w.registered).toEqual(['/session-control'])
    })
  }

  test('/session-control turns the board on elsewhere: the trace starts there, with the start line', { options: TRACED }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($, '/work/elsewhere')
    expect(w.writes.some(one => one.path === TRACE)).toBe(false)
    await runCommand($, '')
    const [first, second] = bare(traceOf(w))
    expect(first).toMatchObject({ event: 'session.start', cwd: '/work/elsewhere', isOrchestratorDir: false })
    expect(second).toEqual({ event: 'command.run', command: 'session-control' })
  })

  test('off by default: no trace file, no trace command', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SESSION_CONTROL_DEBUG: '0' })
    await boot($)
    await launchTool($, args)
    expect(w.writes.some(one => one.path.includes('trace.log'))).toBe(false)
    expect(w.runs.some(isTraceRun)).toBe(false)
  })

  test('a trace that cannot be written breaks nothing and is toasted once', { options: TRACED }, async ($, on) => {
    LINUX_FIXTURE.isAppendBroken = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('Launched pid 7001')
      expect(w.toasts.filter(text => text.includes('debug trace cannot be written'))).toEqual([
        'Debug trace failed \u00B7 the debug trace cannot be written (/fixture/home/.claude/session-control/runs/trace.log cannot be appended to (READ_ONLY)); the mod goes on without it',
      ])
    } finally {
      LINUX_FIXTURE.isAppendBroken = false
    }
  })

  test('a trace near 2 MiB is rotated once before the next append', { options: TRACED }, async ($, on) => {
    LINUX_FIXTURE.traceSize = TRACE_MAX_BYTES - 10
    try {
      const w = world(on)
      await boot($)
      await launchTool($, args)
      const steps = (one: { request: Record<string, unknown> }) => one.request.ops as Record<string, unknown>[]
      const rotations = w.calls.filter(one => one.op === 'batch' && steps(one).some(step => step.op === 'rotate'))
      // The helper reads the size again itself: it gets the limit and the bytes about to go in, then the append follows
      // in the same batch.
      expect(rotations.length).toBe(1)
      const [rotate, append] = steps(rotations[0] ?? { request: {} })
      expect(rotate).toMatchObject({ op: 'rotate', path: TRACE, maxBytes: TRACE_MAX_BYTES, moves: [[`${TRACE}.1`, `${TRACE}.2`], [TRACE, `${TRACE}.1`]] })
      expect(Number(rotate?.adding)).toBeGreaterThan(10)
      expect(append).toMatchObject({ op: 'append', path: TRACE })
    } finally {
      LINUX_FIXTURE.traceSize = 0
    }
  })
})

describe('seconds tick', () => {
  // started_at 42 s before the fixture clock for the running entry; a finished run of 5m12s.
  const TIMED = JSON.stringify(
    JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) =>
      one.session_id === SID_ALIVE ? { ...one, started_at: NOW_MS / 1000 - 42 } : one.session_id === SID_UNREPORTED ? { ...one, started_at: NOW_MS / 1000 - 4000, ended_at: NOW_MS / 1000 - 3688 } : one,
    ),
  )
  type Ui = Awaited<ReturnType<typeof mountPane>>
  /** The elapsed text at the end of a session row. */
  const elapsedOf = async (ui: Ui, sid: string) => String((await ui.find({ key: `s:${sid}` }))?.props.label).trimEnd().split(/\s+/).at(-1)
  const setup = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On) => {
    const w = world(on, '/fixture/lic/a\n', true, TIMED)
    const pane = { isUp: false, isShown: true, asked: 0 }
    on('ui.open', () => {
      pane.isUp = true
      return { value: { isPlaced: true } } as never
    })
    on('ui.panes', () => {
      pane.asked++
      return { value: pane.isUp ? [{ id: 'session-control', title: 'Session control', isShown: pane.isShown, isFocused: false, isPlaced: true }] : [] } as never
    })
    await boot($)
    await runCommand($, '')
    return { w, pane, ui: await mountPane($) }
  }

  test('the tick stops when the command hides the panel, and comes back with the panel', { options: OPTIONS }, async ($, on) => {
    const { w, pane, ui } = await setup($, on)
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('43s')
    await runCommand($, '')
    pane.isUp = false
    const asked = pane.asked
    await w.clock.advance(3000)
    // No tick asked for the panes after the hide (the poll at 5 s has not come).
    expect(pane.asked).toBe(asked)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('43s')
    await runCommand($, '')
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('47s')
  })

  test('closed by the engine\'s close mark or hidden behind another pane, the tick ends itself; the poll brings it back once the panel shows', { options: OPTIONS }, async ($, on) => {
    const { w, pane, ui } = await setup($, on)
    await w.clock.advance(1000)
    pane.isShown = false
    await w.clock.advance(1000)
    const asked = pane.asked
    await w.clock.advance(2000)
    expect(pane.asked).toBe(asked)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('43s')
    pane.isShown = true
    // The poll (every 5 s) sees the panel shown again and arms the tick.
    await w.clock.advance(1000)
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('48s')
    pane.isUp = false
    await w.clock.advance(1000)
    const gone = pane.asked
    await w.clock.advance(2000)
    expect(pane.asked).toBe(gone)
  })

  /** The pane's renders the trace counted, one number per poll tick that had any. */
  const renderCounts = (w: World) => traceOf(w).filter(line => line.event === 'ui.render').map(line => Number(line.count))
  /** The panel opened with the trace on over `registry`; the first poll tick counts the renders of the opening. */
  const traced = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On, registry: string) => {
    const w = world(on, '/fixture/lic/a\n', true, registry)
    const pane = { asked: 0 }
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.panes', () => {
      pane.asked++
      return { value: [{ id: 'session-control', title: 'Session control', isShown: true, isFocused: false, isPlaced: true }] } as never
    })
    await boot($)
    await runCommand($, '')
    const ui = await mountPane($)
    await w.clock.advance(5000)
    return { w, pane, ui }
  }
  // The running entry started 2 h and 10 s before the fixture clock: its elapsed text moves once a minute.
  const HOURS = JSON.stringify(JSON.parse(TIMED).map((one: { session_id?: string }) => (one.session_id === SID_ALIVE ? { ...one, started_at: NOW_MS / 1000 - 7210 } : one)))

  test('the tick draws the pane again only when the elapsed text of a row in view changes: a row of an hour or more once a minute, the poll not at all when nothing drawn changed', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    // No orphan row (its age under an hour would count each second): every row's text is still within its minute.
    LINUX_FIXTURE.isOrphanGone = true
    try {
      const { w, ui } = await traced($, on, HOURS)
      expect(await elapsedOf(ui, SID_ALIVE)).toBe('2h00m')
      const counted = renderCounts(w)
      // Ten seconds of ticks and two polls inside the minute: nothing redrawn, so no render line.
      for (let step = 0; step < 10; step++) await w.clock.advance(1000)
      expect(renderCounts(w)).toEqual(counted)
      expect(await elapsedOf(ui, SID_ALIVE)).toBe('2h00m')
      // The minute turns at 2h01m (7260 s): one redraw.
      for (let step = 0; step < 40; step++) await w.clock.advance(1000)
      expect(await elapsedOf(ui, SID_ALIVE)).toBe('2h01m')
      expect(renderCounts(w).slice(counted.length).reduce((sum, n) => sum + n, 0)).toBe(1)
    } finally {
      LINUX_FIXTURE.isOrphanGone = false
    }
  })

  test('a running row under an hour: one redraw a second, as before', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const { w, ui } = await traced($, on, TIMED)
    const counted = renderCounts(w).length
    for (let step = 0; step < 5; step++) await w.clock.advance(1000)
    expect(renderCounts(w).slice(counted)).toEqual([5])
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('52s')
  })

  test('with no session row in view the tick stops; the poll brings it back once one is', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const { w, pane, ui } = await traced($, on, TIMED)
    await ui.press({ key: 'x:points' })
    await w.clock.advance(1000)
    const [asked, counted] = [pane.asked, renderCounts(w).length]
    for (let step = 0; step < 3; step++) await w.clock.advance(1000)
    // No tick asks for the panes and nothing is redrawn (the poll at 10 s has not come).
    expect(pane.asked).toBe(asked)
    expect(renderCounts(w).length).toBe(counted)
    await ui.press({ key: 'x:points' })
    // The poll at 10 s arms the tick again; its first step a second later draws 53 s.
    await w.clock.advance(1000)
    await w.clock.advance(1000)
    expect(await elapsedOf(ui, SID_ALIVE)).toBe('53s')
  })

  test('an expanded section and a selected point stay as they are across ticks', { options: OPTIONS }, async ($, on) => {
    const { w, ui } = await setup($, on)
    await ui.press({ key: 'x:points' })
    await ui.press({ key: 'p:a:0' })
    for (let step = 0; step < 3; step++) await w.clock.advance(1000)
    expect((await ui.find({ key: 'x:points' }))?.props.label).toBe('[-]')
    expect(String(((await ui.findAll({}))[0] as { text?: string }).text)).toContain('Detail one')
  })
})

describe('a log whose session leaves the registry', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const SID = SID_ALIVE
  const without = (...gone: string[]) => JSON.stringify(REGISTRY.filter(one => !gone.includes(one.session_id ?? '')), null, 2) + '\n'
  const boxesOf = async (ui: Ui) =>
    (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round').map(box => /^(SESSIONS|QUEUED WORK|OPEN POINTS|LOG)/.exec(box.text)?.[1])
  const THREE = ['SESSIONS', 'QUEUED WORK', 'OPEN POINTS']
  const setup = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On) => {
    // `hold`: while it is set, every read of the registry waits for it and answers the text it found.
    const reg: { text: string; hold: Promise<void> | undefined } = { text: REGISTRY_TEXT, hold: undefined }
    const w = world(on, '/fixture/lic/a\n', true, () => {
      const text = reg.text
      return reg.hold === undefined ? text : reg.hold.then(() => text)
    })
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = await mountPane($)
    await ui.press({ key: `s:${SID}` })
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    return { w, reg, ui }
  }

  test('an expanded section state is cleared with the closed log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    // The sessions icon closes the log and expands SESSIONS (the other two are one-line headers); the row opens the log again.
    await ui.press({ key: 'x:sessions' })
    expect(await boxesOf(ui)).toEqual(['SESSIONS'])
    await ui.press({ key: `s:${SID}` })
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    reg.text = without(SID)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(THREE)
  })

  test('an unreadable or unparsable registry keeps the log as it is', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = '{ not json'
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    UNREADABLE.add(REGISTRY_PATH)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    UNREADABLE.clear()
    reg.text = REGISTRY_TEXT
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
  })

  test('a still-present entry keeps its log, also when another entry is retired or the same id is registered again', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = without(SID_DONE)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    // Removed and registered again between two polls: the entry is there at the poll, the log stays.
    reg.text = REGISTRY_TEXT
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
  })

  test('with a different session selected, retiring a third one keeps the open log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = without(SID_UNREPORTED)
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
  })

  // The done worker has a working directory here, so it has a transcript of its own to show.
  const B = SID_DONE
  const withB = (...gone: string[]) =>
    JSON.stringify(REGISTRY.filter(one => !gone.includes(one.session_id ?? '')).map(one => (one.session_id === B ? { ...one, cwd: '/work/d' } : one)), null, 2) + '\n'
  const logTitle = async (ui: Ui) => (await ui.findAll({ type: 'Box' })).map(box => /^LOG [a-z ]+/.exec(box.text)?.[0]).find(one => one !== undefined)
  const holdUp = () => {
    let release = () => {}
    const hold = new Promise<void>(resolve => (release = resolve))
    return { hold, release }
  }

  test('a row pressed while the registry is read for the retired session stays selected and shows its log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = withB(SID)
    const { hold, release } = holdUp()
    reg.hold = hold
    // The poll reads the registry for the alive worker's log, which is retired; the press of the other row lands meanwhile.
    await w.clock.advance(5000)
    const pressed = ui.press({ key: `s:${B}` })
    release()
    await pressed
    reg.hold = undefined
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await logTitle(ui)).toBe('LOG done worker')
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    expect(await logTitle(ui)).toBe('LOG done worker')
    expect((await ui.findAll({ type: 'Button' })).some(one => String(one.props.label).startsWith('\u25B8') && String(one.props.label).includes('done worker'))).toBe(true)
  })

  test('a log read for a session the selection has left is dropped, not shown over the new one', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = withB()
    const { hold, release } = holdUp()
    HELD.tail = hold
    try {
      // The poll reads the alive worker's transcript, held; the other row is pressed and shows its own log meanwhile.
      await w.clock.advance(5000)
      await ui.press({ key: `s:${B}` })
      expect(await logTitle(ui)).toBe('LOG done worker')
      release()
      await w.clock.advance(1000)
      expect(await logTitle(ui)).toBe('LOG done worker')
      await w.clock.advance(5000)
      expect(await logTitle(ui)).toBe('LOG done worker')
      expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    } finally {
      HELD.tail = undefined
    }
  })

  test('an empty or whitespace-only registry text is a read in progress: the log stays; the text [] is a registry without entries and closes it', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    for (const text of ['', '   \n\t\n']) {
      reg.text = text
      await w.clock.advance(5000)
      await w.clock.advance(5000)
      expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
      expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
      reg.text = REGISTRY_TEXT
      await w.clock.advance(5000)
      expect(await boxesOf(ui)).toEqual(['SESSIONS', 'LOG'])
    }
    reg.text = '[]\n'
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(THREE)
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeUndefined()
    await w.clock.advance(10000)
    expect(await boxesOf(ui)).toEqual(THREE)
  })

  test('a registry with entries, none of them the selected one, closes the log', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    reg.text = JSON.stringify([REGISTRY.find(one => one.session_id === SID_DONE)])
    await w.clock.advance(5000)
    expect(await boxesOf(ui)).toEqual(THREE)
  })

  test('a session retired while the panel is hidden leaves nothing selected when the panel is shown again', { options: OPTIONS }, async ($, on) => {
    const { w, reg, ui } = await setup($, on)
    await runCommand($, 'side')
    await ui.unmount()
    reg.text = without(SID)
    await w.clock.advance(5000)
    await runCommand($, 'side')
    expect(await boxesOf(await mountPane($))).toEqual(THREE)
  })
})

describe('launch_worker: inline prompt, decisions section, rules block, resume fill', () => {
  const RUNS = `${HOME}/.claude/session-control/runs`
  // The prompt file is named by the launch's unique session name (a resume adds its launch time).
  const OWN = `${RUNS}/w-new-260921141320.prompt.md`
  const fresh = { dir: '/work/new', model: 'opus', effort: 'high', title: 'new' }
  /** A prompt that carries the three items the launch guard checks. */
  const FULL = 'Goal: tidy the parser. Wait in the foreground. Report git status -sb. No AI attribution in commits.'
  const DECISIONS_TEXT = [
    '# Agreed decisions',
    '',
    'Intro.',
    '',
    '## Parser unit (user, 2026-10-11)',
    'parser-1. Keep the grammar.',
    'parser-2. No new dependency.',
    '',
    '## Standing',
    'push-x. Pushes need no go-ahead.',
    '',
  ].join('\n')
  /** What the mod wrote to its own prompt file, if anything. */
  const ownPrompt = (w: World) => w.writes.filter(one => one.path === OWN).at(-1)?.text

  test('an inline prompt that lacks the items gets the rules block once, and then passes the guard', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, { ...fresh, prompt: 'Reply PONG.' })
    expect(String(out.result)).toEndWith(`Prompt: ${OWN} (written by the mod; rules block appended).`)
    expect(ownPrompt(w)).toBe(`Reply PONG.\n\n${RULES_BLOCK}\n`)
    expect(missingPromptItems(ownPrompt(w) ?? '')).toEqual([])
    // Each item of the block, as CLAUDE.md's worker prompt lists them.
    for (const phrase of ['no AI attribution trailer', 'never mention an agent', 'No human answers during the run', 'never for a sign-off item', 'Never read, print or pass a credential', '`run_in_background: true`', 'explicit `timeout`', 'until <check>; do sleep 30; done', 'under ten minutes', 'Never end the turn while a run', '`git status -sb`', '`git log --oneline @{u}..HEAD`', 'exit code']) {
      expect(RULES_BLOCK).toContain(phrase)
    }
  })

  test('rules false: an inline prompt that lacks the items is refused as a prompt file would be, and nothing is written', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, { ...fresh, prompt: 'Reply PONG.', rules: false })
    expect(String(out.deny)).toContain('the prompt lacks: foreground wait')
    expect(ownPrompt(w)).toBeUndefined()
    expect(w.bash.length).toBe(0)
  })

  test('a skill test gets no rules block, as the guard exempts it', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, { ...fresh, prompt: 'skill test: run the procedure and report.' })
    expect(String(out.result)).toEndWith(`Prompt: ${OWN} (written by the mod).`)
    expect(ownPrompt(w)).toBe('skill test: run the procedure and report.')
  })

  test('section: the section text appended as binding, the entry records it; with a full prompt no rules block', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, { ...fresh, prompt: FULL, section: 'Parser unit (user, 2026-10-11)' })
      expect(String(out.result)).toEndWith(`Prompt: ${OWN} (written by the mod; section "Parser unit (user, 2026-10-11)" appended).`)
      expect(ownPrompt(w)).toBe(`${FULL}\n\n## Binding decisions (section Parser unit (user, 2026-10-11))\n\nparser-1. Keep the grammar.\nparser-2. No new dependency.\n`)
      expect(lastRegistry(w).at(-1)).toMatchObject({ prompt_file: OWN, section: 'Parser unit (user, 2026-10-11)' })
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('section with a prompt file: a copy of the file with the section and, as the file lacks the items, the rules block; the file itself untouched', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, { ...fresh, prompt_file: '/work/new/thin.md', section: 'Parser unit (user, 2026-10-11)' })
      expect(String(out.result)).toEndWith(`(written by the mod; section "Parser unit (user, 2026-10-11)" appended; rules block appended).`)
      expect(ownPrompt(w)).toBe(`Just do the work.\n\n## Binding decisions (section Parser unit (user, 2026-10-11))\n\nparser-1. Keep the grammar.\nparser-2. No new dependency.\n\n${RULES_BLOCK}\n`)
      expect(String(w.bash[0]?.command)).toContain(`"$(cat '${OWN}')"`)
      expect(w.writes.some(one => one.path === '/work/new/thin.md')).toBe(false)
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('section refusals: a heading the file lacks, a missing decisions file, a prompt file that cannot be read; nothing written or started', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    DECISIONS.text = DECISIONS_TEXT
    try {
      const unknown = await launchTool($, { ...fresh, prompt: FULL, section: 'Parser unit' })
      expect(String(unknown.deny)).toBe('session-control: refused: agreed-decisions.md has no section "Parser unit"; nothing was launched')
      const unread = await launchTool($, { ...fresh, prompt_file: '/work/new/prompt.md', section: 'Parser unit (user, 2026-10-11)' })
      expect(String(unread.deny)).toBe('session-control: refused: the prompt file /work/new/prompt.md cannot be read, so the section cannot be appended; nothing was launched')
    } finally {
      DECISIONS.text = undefined
    }
    const missing = await launchTool($, { ...fresh, prompt: FULL, section: 'Parser unit (user, 2026-10-11)' })
    expect(String(missing.deny)).toBe('session-control: refused: agreed-decisions.md cannot be read; nothing was launched')
    expect(w.writes.some(one => one.path.endsWith('.prompt.md'))).toBe(false)
    expect(w.bash.length).toBe(0)
  })

  test('exactly one of prompt and prompt_file: both, or neither, is refused before anything runs', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const runs = w.runs.length
    const both = await launchTool($, { ...fresh, prompt: FULL, prompt_file: '/work/new/prompt.md' })
    expect(String(both.deny)).toBe('session-control: refused: give exactly one of prompt and prompt_file, not both')
    const neither = await launchTool($, fresh)
    expect(String(neither.deny)).toBe('session-control: refused: give exactly one of prompt and prompt_file')
    const blank = await launchTool($, { ...fresh, prompt: '   ' })
    expect(String(blank.deny)).toBe('session-control: refused: prompt is empty')
    expect(w.runs.length).toBe(runs)
  })

  test('a fresh launch without model, effort, title or dir is refused as before', { options: OPTIONS }, async ($, on) => {
    world(on)
    await boot($)
    expect(String((await launchTool($, { dir: '/work/new', prompt: FULL, effort: 'high', title: 't' })).deny)).toBe('session-control: model is required')
    expect(String((await launchTool($, { dir: '/work/new', prompt: FULL, model: 'opus', title: 't' })).deny)).toContain('effort is required')
    expect(String((await launchTool($, { dir: '/work/new', prompt: FULL, model: 'opus', effort: 'high' })).deny)).toBe('session-control: title is required')
    expect(String((await launchTool($, { prompt: FULL, model: 'opus', effort: 'high', title: 't' })).deny)).toBe('session-control: dir must be absolute')
  })

  describe('a resume', () => {
    // Its cwd and model are those of the fixture's new worker process, so the launch finds it.
    const entry = { title: 'parser work', session_id: SID_UNREPORTED, name: 'w-parser-work-260920100000', config_dir: '/fixture/lic/a', cwd: '/work/new', model: 'opus', effort: 'medium', reported: false }
    const registry = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? entry : one)))
    test('takes dir, model, effort and title from its entry, and says so', { options: OPTIONS }, async ($, on) => {
      WORKER.sid = SID_UNREPORTED
      try {
        const w = world(on, '/fixture/lic/a\n', true, registry)
        await boot($)
        const out = await launchTool($, { resume_sid: SID_UNREPORTED, prompt: `${FULL} Continue.` })
        expect(String(out.result)).toEndWith('From the entry: dir, model, effort, title.')
        expect(String(w.bash[0]?.command)).toStartWith(`cd '/work/new' && CLAUDE_CONFIG_DIR='/fixture/lic/a' CLAUDE_CODE_EFFORT_LEVEL='medium' claude -p --model 'opus' --resume '${SID_UNREPORTED}' -n 'w-parser-work-260920100000'`)
        expect(lastRegistry(w).find(one => one.session_id === SID_UNREPORTED)).toMatchObject({ title: 'parser work', cwd: '/work/new', model: 'opus', effort: 'medium', pid: 7001 })
        expect(String(w.bash[0]?.command)).toContain(`"$(cat '${RUNS}/w-parser-work-260920100000-260921141320.prompt.md')"`)
        expect(w.runs.some(argv => argv[0] === '/fixture/bin/pick')).toBe(false)
      } finally {
        WORKER.sid = 'abcdabcd-0000-4000-8000-000000000001'
      }
    })
    test('of an entry without those fields, or of an unknown id, is refused as before', { options: OPTIONS }, async ($, on) => {
      world(on)
      await boot($)
      // The fixture's unreported entry has no cwd, model or effort.
      expect(String((await launchTool($, { resume_sid: SID_UNREPORTED, prompt: FULL })).deny)).toBe('session-control: model is required')
      const unknown = await launchTool($, { resume_sid: '99999999-0000-4000-8000-000000000009', prompt: FULL, dir: '/work/new', model: 'opus', effort: 'high', title: 't' })
      expect(String(unknown.deny)).toBe('session-control: no registry entry for 99999999-0000-4000-8000-000000000009')
    })
  })
})

describe('close_worker', () => {
  const CLOSE = 'mcp__session-control__close_worker'
  const finished = { title: 'finished clean', session_id: 'f1f1f1f1-0000-4000-8000-000000000001', config_dir: '/fixture/lic/a', reported: false, outcome: { kind: 'clean', summary: 'clean: done' } }
  const login = { title: 'stuck login', session_id: '57575751-0000-4000-8000-000000000001', config_dir: '/fixture/lic/a', reported: false, outcome: { kind: 'login', summary: 'login: old label' } }
  const kept = { title: 'kept clean', session_id: 'c3c3c3c3-0000-4000-8000-000000000003', config_dir: '/fixture/lic/a', reported: true, keep: true, outcome: { kind: 'clean', summary: 'clean: ok' } }
  const registry = JSON.stringify([...JSON.parse(REGISTRY_TEXT), finished, login, kept])
  const ids = ['f1f1f1f1', '57575751', 'c3c3c3c3', SID_ALIVE, '12345678']
  const reviewed = { '57575751': 'the transcript shows the run succeeded' }

  // The fixture's registry text does not change when the mod writes it: each call reads the fixture's entries, so the
  // kept entry stays kept for the retire here (host.test.ts runs the same on a machine whose files do change).
  const ACK = 'mcp__session-control__acknowledge_workers'
  const RETIRE = 'mcp__session-control__retire_workers'
  const EXPECTED =
    'Acknowledged: f1f1f1f1, 57575751, c3c3c3c3. Refused: aaaaaaaa (its process is alive); 12345678 (no registry entry). ' +
    'Retired: f1f1f1f1, 57575751. Retired with review: 57575751 (was login: the transcript shows the run succeeded). ' +
    'Refused: c3c3c3c3 (marked keep: a resume or follow-up is expected); aaaaaaaa (its process is alive); 12345678 (no registry entry).'

  test('keep false is acknowledge_workers then retire_workers: their answers one after the other, their writes', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, registry)
    await boot($)
    const out = await $.tool.call({ tool: CLOSE, session_ids: ids, reviewed } as never)
    expect(String(out.result)).toBe(EXPECTED)
    const after = lastRegistry(w)
    expect(after.some(one => [finished.session_id, login.session_id].includes(String(one.session_id)))).toBe(false)
    expect(after.some(one => one.session_id === SID_ALIVE)).toBe(true)
    const cleared = w.writes.filter(one => one.path.endsWith('/cleared.jsonl')).map(one => one.text).join('')
    expect(cleared).toContain('"reviewed_outcome":"login","reviewed_reason":"the transcript shows the run succeeded"')
  })

  test('the same two calls made one by one answer the same text', { options: OPTIONS }, async ($, on) => {
    world(on, '/fixture/lic/a\n', true, registry)
    await boot($)
    const acked = await $.tool.call({ tool: ACK, session_ids: ids } as never)
    const retired = await $.tool.call({ tool: RETIRE, session_ids: ids, reviewed } as never)
    expect(`${String(acked.result)} ${String(retired.result)}`).toBe(EXPECTED)
  })

  test('keep true only acknowledges and keeps; reviewed is then not used, and said so', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, registry)
    await boot($)
    const out = await $.tool.call({ tool: CLOSE, session_ids: ['f1f1f1f1'], keep: true } as never)
    expect(String(out.result)).toBe('Acknowledged and kept: f1f1f1f1.')
    expect(lastRegistry(w).find(one => one.session_id === finished.session_id)).toMatchObject({ reported: true, keep: true })
    expect(w.writes.some(one => one.path.endsWith('/cleared.jsonl'))).toBe(false)
    const noted = await $.tool.call({ tool: CLOSE, session_ids: ['f1f1f1f1'], keep: true, reviewed: { f1f1f1f1: 'x' } } as never)
    expect(String(noted.result)).toBe('Acknowledged and kept: f1f1f1f1. reviewed was not used: keep true retires nothing.')
  })

  test('the retire refusals stay: an outcome that needs a resume without reviewed; the acknowledgement still happens', { options: OPTIONS }, async ($, on) => {
    world(on, '/fixture/lic/a\n', true, registry)
    await boot($)
    const out = await $.tool.call({ tool: CLOSE, session_ids: ['57575751'] } as never)
    expect(String(out.result)).toBe('Acknowledged: 57575751. Retired: none. Refused: 57575751 (outcome login needs a resume).')
  })
})

// ---------------------------------------------------------------- the panel on the desktop surface (decision mod-28)

describe('the panel on the desktop surface', () => {
  type Ui = Awaited<ReturnType<typeof mountPane>>
  const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
  // Claude Desktop reported a pane width in cells far below what its proportional font fits: rows the mod padded and cut
  // to that width came out as "desktop toa... 0d5c7a11 ...", the status and elapsed columns gone.
  const NARROW = { ...PANE_PROPS, bodyColumns: 30 }
  const LONG_TASK = 'Queued task with a title long enough to pass any narrow width the pane reports'
  const open = async ($: Parameters<Parameters<typeof test>[2]>[0], on: On, surface: 'terminal' | 'desktop', props: Record<string, unknown> = NARROW) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    return $.ui.mount({ plugin: 'session-control', surface, component: 'Pane', requestId: 'session-control', props: props as never })
  }
  /** Every Text drawn, with its wrap prop. */
  const textsOf = async (ui: Ui | Awaited<ReturnType<typeof open>>) => (await ui.findAll({ type: 'Text' })).map(one => ({ text: one.text, wrap: one.props.wrap }))

  test('desktop: each session row is its whole text, title to elapsed, with no padding and no cut of the mod; the header names the cells', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on, 'desktop')
    // The title is the pressable line (Desktop draws a Button on one line, cut at the box's edge); the cells follow on a
    // Text the surface wraps, so the status and the elapsed time always show.
    expect(String((await ui.find({ key: `s:${SID}` }))?.props.label)).toBe('alive worker')
    const texts = await textsOf(ui)
    const cells = texts.find(one => /^aaaaaaaa · running · opus · high · \d+m\d\ds$/.test(one.text))
    expect(cells?.wrap).toBe('wrap')
    expect(texts).toContainEqual({ text: 'title', wrap: 'wrap' })
    expect(texts).toContainEqual({ text: 'sid · status · model · effort · elapsed', wrap: 'wrap' })
    // No row of any box is cut, padded or wrapped by the mod: the surface does that in its own room.
    for (const label of (await ui.findAll({ type: 'Button' })).map(one => String(one.props.label))) {
      expect(label).not.toContain('…')
      expect(label).toBe(label.trim())
    }
    for (const one of texts) expect(one.text).not.toContain('…')
    // A press on the row still opens its log, the row then marked.
    await ui.press({ key: `s:${SID}` })
    expect(String((await ui.find({ key: `s:${SID}` }))?.props.label)).toBe('\u25B8 alive worker')
  })

  test('the terminal keeps its columns at the same width: padded cells, cut with an ellipsis', { options: OPTIONS }, async ($, on) => {
    const ui = await open($, on, 'terminal')
    const row = String((await ui.find({ key: `s:${SID}` }))?.props.label)
    expect(row).toContain('…')
    expect(row).not.toContain('·')
    expect((await textsOf(ui)).every(one => one.wrap === undefined)).toBe(true)
  })

  test('desktop: queued work and open points are whole texts, a selected point with its detail and recommendation; log lines end at the surface\'s width', { options: OPTIONS }, async ($, on) => {
    QUEUE.text = JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: LONG_TASK }] })
    try {
      const ui = await open($, on, 'desktop')
      expect(await textsOf(ui)).toContainEqual({ text: `• ${LONG_TASK}`, wrap: 'wrap' })
      expect(String((await ui.find({ key: 'p:a:0' }))?.props.label)).toBe('1. First question')
      await ui.press({ key: 'p:a:0' })
      expect(String((await ui.find({ key: 'p:a:t:0' }))?.props.label)).toBe('▸ 1. First question')
      const texts = await textsOf(ui)
      expect(texts).toContainEqual({ text: 'Detail one', wrap: 'wrap' })
      expect(texts).toContainEqual({ text: 'Recommendation: Do A', wrap: 'wrap' })
      await ui.press({ key: `s:${SID}` })
      const log = (await textsOf(ui)).filter(one => /Reading the suite files|> Bash git status -sb/.test(one.text))
      expect(log.length).toBe(2)
      expect(log.every(one => one.wrap === 'truncate-end')).toBe(true)
      // The terminal at the same width wraps the long title into rows of its own (the log closed first).
      await ui.press({ key: `s:${SID}` })
      await ui.unmount()
      const term = await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: NARROW as never })
      const rows = (await textsOf(term)).filter(one => one.text.startsWith('• ') || (one.text.startsWith('  ') && LONG_TASK.includes(one.text.trim())))
      expect(rows.length).toBeGreaterThan(1)
    } finally {
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('a wrapped log line hangs on the terminal: a call\'s and a result\'s continuation lines two columns in, the worker\'s text at column 0; the desktop ends each line whole, as before (decision mod-30)', { options: OPTIONS }, async ($, on) => {
    const SAID = 'Reading the wrapper in core.ts and the two callers that draw the log box before the change.'
    const COMMAND = 'git log --oneline origin/main..HEAD && git status -sb && git diff --stat HEAD~1'
    const RESULT = '## feature/x...origin/feature/x [ahead 1] then the changed files: M mod/hooks/core.ts M mod/hooks/inspect.ts'
    TAIL.rows = [
      { type: 'assistant', message: { content: [{ type: 'text', text: SAID }, { type: 'tool_use', name: 'Bash', input: { command: COMMAND } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: RESULT }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status -sb' } }] } },
    ]
    try {
      // 60 columns: the log's lines wrap at 56.
      const ui = await open($, on, 'terminal', { ...PANE_PROPS, bodyColumns: 60 })
      await ui.press({ key: `s:${SID}` })
      const texts = (await textsOf(ui)).map(one => one.text)
      const from = texts.indexOf('Reading the wrapper in core.ts and the two callers that')
      expect(texts.slice(from, from + 7)).toEqual([
        'Reading the wrapper in core.ts and the two callers that',
        'draw the log box before the change.',
        '> Bash git log --oneline origin/main..HEAD && git status',
        '  -sb && git diff --stat HEAD~1',
        '< ## feature/x...origin/feature/x [ahead 1] then the',
        '  changed files: M mod/hooks/core.ts M',
        '> Bash git status -sb',
      ])
      await ui.unmount()
      const desk = await $.ui.mount({ plugin: 'session-control', surface: 'desktop', component: 'Pane', requestId: 'session-control', props: { ...PANE_PROPS, bodyColumns: 60 } as never })
      const log = (await textsOf(desk)).filter(one => one.wrap === 'truncate-end')
      expect(log).toEqual([
        { text: SAID, wrap: 'truncate-end' },
        { text: `> Bash ${COMMAND}`, wrap: 'truncate-end' },
        { text: `  < ${RESULT}`, wrap: 'truncate-end' },
        { text: '> Bash git status -sb', wrap: 'truncate-end' },
      ])
    } finally {
      TAIL.rows = undefined
    }
  })
})

// ---------------------------------------------------------------- the probe's limits on a slow machine (decision mod-28)

describe('one probe at a time, the poll\'s rest and the tracking toast per episode', () => {
  const LIST = 'mcp__session-control__list_sessions'
  const TRACED = { ...OPTIONS, debug: true }
  const probes = (w: World) => w.calls.filter(one => one.op === 'probe').length

  test('a poll tick during a probe skips its refresh', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    let release = () => {}
    HELD.probe = new Promise<void>(resolve => {
      release = resolve
    })
    try {
      const before = probes(w)
      const first = $.tool.call({ tool: LIST } as never)
      await w.clock.advance(5000)
      expect(probes(w)).toBe(before + 1)
      expect(traceOf(w).filter(line => line.event === 'poll.skip').map(line => line.isProbing)).toContain(true)
      release()
      HELD.probe = undefined
      expect(String(((await first) as { result?: unknown }).result)).toStartWith('7 session rows: 1 running, ')
      expect(PROBES.max).toBe(1)
    } finally {
      release()
      HELD.probe = undefined
    }
  })

  test('Windows: two tools at once probe one after the other, the second waiting in the helper\'s short pauses: never two probes at once', { options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}` } }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' })
    await boot($, `C:${ORCH_DIR}`)
    WINDOWS.probeMs = 3000
    try {
      const before = w.calls.length
      const answers = await Promise.all([$.tool.call({ tool: LIST } as never), $.tool.call({ tool: LIST } as never)])
      for (const one of answers) expect(String((one as { result?: unknown }).result)).toMatch(/^\d+ session rows: /)
      expect(PROBES.max).toBe(1)
      expect(w.calls.slice(before).some(one => one.op === 'pause' && one.request.ms === 250)).toBe(true)
    } finally {
      WINDOWS.probeMs = 0
    }
  })

  test('after a probe longer than the poll interval the poll rests as long again from its end; then it probes as before', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    LINUX_FIXTURE.probeMs = 12_000
    try {
      const before = probes(w)
      await w.clock.advance(5000)
      LINUX_FIXTURE.probeMs = 0
      expect(probes(w)).toBe(before + 1)
      const rested = traceOf(w).filter(line => line.event === 'poll.skip' && Number(line.restMs) > 0)
      for (let step = 0; step < 2; step++) await w.clock.advance(5000)
      expect(traceOf(w).filter(line => line.event === 'poll.skip' && Number(line.restMs) > 0).length).toBeGreaterThan(rested.length)
      const atRestEnd = probes(w)
      expect(atRestEnd).toBe(before + 1)
      for (let step = 0; step < 4; step++) await w.clock.advance(5000)
      expect(probes(w)).toBeGreaterThan(atRestEnd)
    } finally {
      LINUX_FIXTURE.probeMs = 0
    }
  })

  test('a probe that fails now and then is one episode, one tracking toast; the same problem again after 10 minutes without it is toasted again', { options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}` } }, async ($, on) => {
    const tracking = (w: World) => w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 '))
    WINDOWS.isProbeBroken = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' })
      await boot($, `C:${ORCH_DIR}`)
      expect(tracking(w)).toEqual(['Tracking problem \u00B7 Error: the process probe failed (exit 1): Invalid class'])
      WINDOWS.isProbeBroken = false
      await w.clock.advance(5000)
      WINDOWS.isProbeBroken = true
      await w.clock.advance(5000)
      WINDOWS.isProbeBroken = false
      await w.clock.advance(5000)
      WINDOWS.isProbeBroken = true
      await w.clock.advance(5000)
      expect(tracking(w).length).toBe(1)
      // Ten minutes and more without it: a new episode.
      WINDOWS.isProbeBroken = false
      for (let step = 0; step < 122; step++) await w.clock.advance(5000)
      WINDOWS.isProbeBroken = true
      await w.clock.advance(5000)
      expect(tracking(w).length).toBe(2)
    } finally {
      WINDOWS.isProbeBroken = false
    }
  })
})
