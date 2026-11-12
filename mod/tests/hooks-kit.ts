// What the hooks-*.test.ts files share: the fixture world the plugin's hooks run against (every noun that would
// touch the machine, fs, process, env and clock, answered from fixtures: no real registry, /proc or licence picker),
// its knobs, which a test sets and puts back, and the helpers the tests drive it with. Each test file runs in its own
// process, so each has its own copy of the knobs. Not a test file.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { localIso } from '../hooks/trace'

import {
  HOME,
  NOW_MS,
  ORCH_DIR,
  PROBE_STDOUT,
  REAL_RESULTS,
  REGISTRY_PATH,
  REGISTRY_TEXT,
  RESULTS,
  SID_ALIVE,
  WIN_PROBE_STDOUT,
} from './fixtures'

/**
 * A prompt's context without the finished-open notice lines, which every prompt carries while a fixture entry is finished
 * and not retired (notices.test.ts tests them); undefined when nothing else is left.
 */
export function withoutFinishedOpen(context: readonly unknown[] | undefined): unknown[] | undefined {
  const left = (context ?? [])
    .map(one => String(one).split('\n').filter(line => !line.startsWith('session-control notice: finished-open: ')).join('\n'))
    .filter(one => one !== '')
  return left.length === 0 ? undefined : left
}

export const PICKER = '/fixture/bin/pick --need {need}'
export const OPTIONS = { orchestratorDir: ORCH_DIR, registryPath: '~/.claude/headless-sessions.json', completionWrites: true, licencePickCommand: PICKER }
export const TOOL = 'mcp__session-control__launch_worker'
export const QUEUE_TEXT = JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: 'Queued one' }, { id: 'q2', status: 'done', title: 'Finished' }] })
// The task queue the fixture serves; a test that serves another puts QUEUE_TEXT back.
export const QUEUE = { text: QUEUE_TEXT }
export const OPEN_POINTS_TEXT = JSON.stringify({
  points: [
    { id: 'a', status: 'open', title: 'First question', detail: 'Detail one', recommendation: 'Do A' },
    { id: 'b', status: 'closed', title: 'Settled', detail: '', recommendation: '' },
    { id: 'c', status: 'open', hold: true, title: 'Held', detail: '', recommendation: '' },
    { id: 'd', status: 'open', title: 'Second question', detail: 'Detail two', recommendation: 'Do B' },
  ],
})
// The open points the fixture serves; a test that serves others puts OPEN_POINTS_TEXT back.
export const POINTS = { text: OPEN_POINTS_TEXT }

export type World = {
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

export const MISSING = new Set<string>()
// Paths that read as missing until the first sleep, like a session file the engine writes a moment late.
export const LATE = new Set<string>()
// Paths that are there but cannot be read (over the read cap, say).
export const UNREADABLE = new Set<string>()
// Reads a test holds until it releases them: the transcript tail of the alive worker; every append (the trace's too);
// every Linux probe; every read of the launched worker's sessions file (sessions, with heldSessions told when one waits).
/** The transcript rows a test puts in place of the fixture's (undefined: the fixture's two rows). */
export const TAIL: { rows: object[] | undefined } = { rows: undefined }
export const HELD: { tail: Promise<unknown> | undefined; append?: Promise<unknown>; probe?: Promise<unknown>; sessions?: Promise<unknown>; heldSessions?: () => void } = { tail: undefined }
// The Linux probes running now and the most that ran at once (reset by world()).
export const PROBES = { inFlight: 0, max: 0 }
// The CLAUDE_CONFIG_DIR the Linux probe reads from the new worker's environment ('' when it has none).
// isInboxless: the Linux worker's sessions file has no name and no messagingSocketPath, as an older claude writes it.
// sid: the session id the Linux worker's sessions file names (a resume keeps the resumed one).
// isPowerShellMissing: the session offers no PowerShell tool.
// bashAnswer: what the Bash tool answers the launch instead of running it (a refusal or an error); undefined: it runs it.
// isAnsweredAfterRun: the Bash tool runs the launch and then answers bashAnswer (another plugin withholding the result,
// an interruption): the worker runs.
// resultText: what the launch's result file in the runs directory holds (undefined: there is none).
export const WORKER = {
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
export const inboxFields = () => (WORKER.isInboxless ? {} : { name: 'w-new-260921141320', messagingSocketPath: '/run/user/1000/cc-socks/7001.sock' })
// Knobs of the Windows fixture: a failing registry write (the helper's writeAtomic) or probe; the config dir the probe
// finds the new worker's sessions file in, or none (unplaced); what the PowerShell route's pid file holds (undefined:
// there is none).
// probeMs: how long each Windows probe takes on the fixture's clock (0: no time). probeLateMs: each probe answers only
// once the test has moved the fixture's clock that far (0: at once). isAliveGone: the alive worker 4101 has exited.
export const WINDOWS = { isMoveBroken: false, isProbeBroken: false, workerConfigDir: 'C:\\fixture\\home\\.claude', isWorkerUnplaced: false, pidFileText: '7001\r\n' as string | undefined, isWorkerHidden: false, probeMs: 0, probeLateMs: 0, isAliveGone: false }
// Knobs of the Linux fixture: a probe that cannot run; an append that fails.
// A trace.log of traceSize bytes is there (0: none).
// isWorkerHidden (both fixtures): the probe does not show the launched worker yet. isAliveGone, probeMs, probeLateMs: as
// in WINDOWS; isOrphanGone: the unregistered headless claude 4999 has exited too.
export const LINUX_FIXTURE = { isProbeBroken: false, isAppendBroken: false, traceSize: 0, isWorkerHidden: false, isAliveGone: false, isOrphanGone: false, probeMs: 0, probeLateMs: 0 }
// The registry as a real file (both fixtures): with isCurrent a read answers the text the plugin last wrote there (the
// seed the test gave until its first write), and the probe asked for the launched worker's pid (7001, while it runs)
// answers its A line from its sessions file, as the helper's probe and PROBE_PS1 do. Off, every read answers the seed and
// 7001 has no A line: the older tests rely on that.
export const REGISTRY_READS = { isCurrent: false }
/** The pause a task notification's prompt races its harvest against (PROMPT_HARVEST_SEC of register.tsx), in seconds. */
export const PROMPT_HARVEST_SEC = 3
// The orchestrator's agreed-decisions.md, when a test serves one (undefined: the file is missing).
export const DECISIONS: { text: string | undefined } = { text: undefined }
export const BIG_PROMPT = `Wait in the foreground; report git status -sb; no attribution. ${'x'.repeat(30_000)}`
/** Windows PowerShell as the mod runs it when SystemRoot is unset. */
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/** The fixture on Windows: C:/fixture/... and C:/work/... are the fixture's /fixture/... and /work/... */
export const fixture = (path: string) => path.replace(/^C:(?=\/(fixture|work)\/)/, '')

/**
 * A path as the plugin gave it to $.fs, from the one the fs hooks see, which the kit resolves first: on a Windows
 * host /x becomes C:\x; on a Linux host C:/x is a relative path, after the session's directory. The fixture's
 * Linux paths come back as /x, its Windows ones as C:/x, on either host.
 */
export const given = (path: string, isWin: boolean) => {
  const slashed = path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')
  return isWin ? slashed : slashed.replace(/^[A-Za-z]:(?=\/)/, '')
}

export function world(on: On, pickStdout = '/fixture/lic/a\n', promptFileExists = true, registryText: string | (() => string | Promise<string>) = REGISTRY_TEXT, env: Record<string, string> = { HOME }, isEnvOwn = false): World {
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
    if (path === '/work/new/forced.md') return 'Goal: tidy the parser. Wait in the foreground. Report git status -sb. No AI attribution in commits.\nRebase on main, then force-push the branch.\n'
    if (path === `${ORCH_DIR}/task-queue.json`) return QUEUE.text
    // The queued-work groups' worktree folder (WORKSPACES): its .git is a file pointing into alpha's .git/worktrees.
    if (path === '/fixture/workspaces/alpha-panel-refine/.git') return 'gitdir: /fixture/workspaces/alpha/.git/worktrees/alpha-panel-refine\n'
    if (path === `${ORCH_DIR}/open-points.json`) return POINTS.text
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

export const start = (cwd: string, isInteractive = true) => ({ cwd, surface: null, isInteractive })
/** The session started in `cwd` (the orchestrator's directory by default). */
export const boot = ($: Engine, cwd = ORCH_DIR) => $.session.start(start(cwd))
/** A launch_worker call with `input` after the tool's name. */
export const launchTool = ($: Engine, input: object) => $.tool.call({ tool: TOOL, ...input } as never)
/** The /session-control command with `args`. */
export const runCommand = ($: Engine, args: string) => $.command.run({ command: 'session-control', args } as never)
/** The registry as the plugin last wrote it. */
export const lastRegistry = (w: World) => JSON.parse(w.writes.filter(one => fixture(one.path) === REGISTRY_PATH).at(-1)?.text ?? '[]') as Record<string, unknown>[]
/** A queued task's row `Task <n>` under its open group: on the desktop two no-break spaces in, on the terminal four blanks. */
export const TASK_ROW = /^(?:\u00A0\u00A0| {4})?\u2022 Task (\d+)$/
/** Opens the General group of the queued work (decision qg-3: groups start collapsed), when the queue draws one. */
export const expandGeneral = async (ui: { find: (q: { key: string }) => Promise<unknown>; press: (q: { key: string }) => Promise<unknown> }) => {
  if ((await ui.find({ key: 'q:General:0' })) !== undefined) await ui.press({ key: 'q:General:0' })
}
export const PANE_PROPS = { title: 'Session control', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 36 } }

export const stubPanel = (on: On) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
}
export const mountPane = ($: Parameters<Parameters<typeof test>[2]>[0]) =>
  $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: PANE_PROPS as never })

export const TRACE = `${HOME}/.claude/session-control/runs/trace.log`
export type TraceLine = Record<string, unknown>
/** The trace lines the plugin appended to a trace file, parsed. */
export const traceOf = (w: World, path = TRACE): TraceLine[] =>
  w.writes.filter(one => one.path === path).flatMap(one => one.text.trimEnd().split('\n')).map(line => JSON.parse(line) as TraceLine)
/** Lines without their time and number (checked by themselves): each time is the fixture clock's at the line, the numbers count up from 1. */
export const bare = (lines: TraceLine[]): TraceLine[] => {
  expect(lines.every(line => [0, 5000].some(later => line.ts === localIso(NOW_MS + later)))).toBe(true)
  expect(lines.map(line => line.seq)).toEqual(lines.map((_, at) => at + 1))
  return lines.map(line => Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'ts' && key !== 'seq')))
}
/** The lines from the first one of an event on. */
export const from = (lines: TraceLine[], event: string) => lines.slice(lines.findIndex(line => line.event === event))
/** A write of the trace (the helper's batch of a rotation and an append, or the append alone): what the trace adds to what the mod runs. */
export const isTraceRun = (argv: readonly string[]) => argv[0] === 'node' && (String(argv[1]).endsWith('/helper/host.mjs') || argv[1] === '<helper>') && argv[2] === 'batch'
/** A command as the pins below write it: the helper in the plugin's folder as `<helper>`. */
export const pinned = (argv: readonly string[]) => argv.map(one => (one.endsWith('/helper/host.mjs') ? '<helper>' : one))

/** Checksum of the tool surface (names, descriptions, schemas): the engine caches these across reloads, so they must not drift. */
export function fingerprint(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0
  return `${text.length}:${hash.toString(16)}`
}
