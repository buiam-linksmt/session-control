import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionEntry, SessionOutcome } from '../types'
import { DECISION_SCHEMA, POINT_SCHEMA, QUEUE_SCHEMA, appendDecision, editOpenPoints, editQueue } from './bookkeeping'
import type { Edit } from './bookkeeping'
import { backupName, dirOf, freshText, localDate, tmpPath } from './store'
import {
  LAUNCH_SCHEMA,
  PROBE_SCRIPT,
  REGISTER_SCRIPT,
  ACK_SCHEMA,
  ACK_SCRIPT,
  CLEAR_SCRIPT,
  RETIRE_SCHEMA,
  retireVerdict,
  buildLaunchArgv,
  ackPeerNote,
  addPeerNote,
  buildRows,
  compactionDigest,
  checkLaunch,
  classifyResult,
  expandHome,
  findBySid,
  findNewWorker,
  lintReport,
  formatHeader,
  boxAt,
  MIN_BOX,
  MIN_SESSIONS_BOX,
  clampOffset,
  holdOffset,
  nextBack,
  scrollbar,
  sectionBoxes,
  wrapText,
  formatRow,
  paneWidths,
  launchTimeoutMs,
  mergeCompletion,
  missingPromptItems,
  parseOpenPoints,
  parseQueuedWork,
  newRegistryEntry,
  parseProcFacts,
  parseRegistry,
  parseTaskNotification,
  pickArgv,
  pickWatched,
  summarizeTranscript,
  transcriptPath,
  unackedPeers,
  probeArgs,
  rowStatus,
  slugify,
} from './core'
import type { LaunchArgs, PresentedPoint, ProcFacts, SectionBox, SectionId } from './core'

const PLUGIN = 'session-control'
const PANE = 'session-control'
const ORCHESTRATOR_HEADING = '# Role: Session Orchestrator'
const TOOL = 'mcp__session-control__launch_worker'
const RETIRE_TOOL = 'mcp__session-control__retire_workers'
const ACK_TOOL = 'mcp__session-control__acknowledge_workers'
const POINT_TOOL = 'mcp__session-control__open_point'
const QUEUE_TOOL = 'mcp__session-control__queue_task'
const DECISION_TOOL = 'mcp__session-control__record_decision'

const snapshot = atom({ plugin: 'session-control', key: 'snapshot' } as const, null)
const pendingNotes = atom({ plugin: 'session-control', key: 'pendingNotes' } as const, [])
const ledger = atom({ plugin: 'session-control', key: 'ledger' } as const, [])
const watch = atom({ plugin: 'session-control', key: 'watch' } as const, null)
const queued = atom({ plugin: 'session-control', key: 'queued' } as const, null)
const boxBack = atom({ plugin: 'session-control', key: 'boxBack' } as const, 0)
const selectedPoint = atom({ plugin: 'session-control', key: 'selectedPoint' } as const, null)
const offsets = atom({ plugin: 'session-control', key: 'offsets' } as const, { sessions: 0, queue: 0, points: 0 })
const tab = atom({ plugin: 'session-control', key: 'tab' } as const, 'sessions')
const selected = atom({ plugin: 'session-control', key: 'selected' } as const, null)
const points = atom({ plugin: 'session-control', key: 'points' } as const, null)

type Config = {
  orchestratorDir: string
  registrySetting: string
  completionWrites: boolean
  pollMs: number
  runsDir: string
  licencePickCommand: string
}

// Per load: a hot reload evaluates the module afresh and session.start re-arms.
let config: Config = {
  orchestratorDir: '',
  registrySetting: '~/.claude/headless-sessions.json',
  completionWrites: false,
  pollMs: 5000,
  runsDir: '~/.claude/session-control/runs',
  licencePickCommand: '',
}
let isActive = false
// What the pane drew last, so the scroll hook knows which box a wheel tick is over.
let layout: { boxes: SectionBox[]; totals: Partial<Record<SectionId, { total: number; visible: number }>> } = { boxes: [], totals: {} }
let isAfterCompact = false
let isBusy = false
let isArmed = false
let isPolling = false
let lastError: string | undefined
const harvested = new Set<string>()

// The validator requires `$` to be handed only to functions declared at the
// top of the file, so every helper that touches `$` lives here.

/** A helper file of the orchestrator directory. */
function orchPath(file: string): string {
  return `${config.orchestratorDir.replace(/\/+$/, '')}/${file}`
}

/** True when two values serialise alike, ignoring one key: the poll skips a redraw for an unchanged value. */
function isSame(a: unknown, b: unknown, ignore?: string): boolean {
  const key = (value: unknown) => JSON.stringify(value, (name, part) => (name === ignore ? undefined : part))
  return key(a) === key(b)
}

/** A tool call's input as a plain record. */
const plain = (e: unknown) => e as Record<string, unknown>

async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? '/root'
}

async function registryPath($: EngineInterface): Promise<string> {
  return expandHome(config.registrySetting, await homeDir($))
}

async function readRegistryText($: EngineInterface): Promise<string> {
  const path = await registryPath($)
  return $.fs.read(path).catch(() => '')
}

/**
 * Write a file through a temporary sibling and a rename, so a reader never sees half a file. When `expected` is
 * given the file is read again just before the rename: if another writer changed it meanwhile nothing is
 * written and false is returned.
 */
async function writeAtomic($: EngineInterface, path: string, text: string, expected?: string): Promise<boolean> {
  const tmp = tmpPath(path, await $.clock.now())
  await $.fs.write(tmp, text)
  if (expected !== undefined && (await $.fs.read(path).catch(() => undefined)) !== expected) {
    await $.process.run(['rm', '-f', tmp], { timeoutMs: 5_000 })
    return false
  }
  const ran = await $.process.run(['mv', '-f', tmp, path], { timeoutMs: 5_000 })
  if (ran.exitCode !== 0) throw new Error(`rename failed (exit ${ran.exitCode}): ${ran.stderr.slice(0, 100)}`)
  return true
}

/** Backups are written once per file, tool and day, before the first change of that day. */
async function backupOnce($: EngineInterface, file: string, tool: string, today: string, text: string): Promise<void> {
  const backup = orchPath(`backups/${backupName(file, tool, today)}`)
  if ((await $.fs.read(backup).catch(() => undefined)) === undefined) await $.fs.write(backup, text)
}

/** A missing helper file is created from scratch, with its directory; an existing file is never touched. */
async function ensureFile($: EngineInterface, path: string, file: string): Promise<void> {
  const initial = freshText(file)
  if (initial === undefined) return
  if ((await $.fs.read(path).catch(() => undefined)) !== undefined) return
  if ((await $.process.run(['test', '-e', path], { timeoutMs: 5_000 })).exitCode === 0) return
  await $.process.run(['mkdir', '-p', dirOf(path)], { timeoutMs: 5_000 })
  await $.fs.write(path, initial)
}

/** Fresh environment: the helper files, the backup directory and the runs directory exist before anything reads them. */
async function ensureHelperFiles($: EngineInterface): Promise<void> {
  for (const file of ['open-points.json', 'task-queue.json', 'agreed-decisions.md', 'open-points-archive.md']) {
    await ensureFile($, orchPath(file), file)
  }
  await ensureFile($, await registryPath($), 'headless-sessions.json')
  await $.process.run(['mkdir', '-p', orchPath('backups'), await runsPath($)], { timeoutMs: 5_000 })
}

async function probe($: EngineInterface, entries: readonly SessionEntry[]): Promise<ProcFacts> {
  const ran = await $.process.run(['sh', '-c', PROBE_SCRIPT, 'session-probe', ...probeArgs(entries)], {
    timeoutMs: 10_000,
  })
  return parseProcFacts(ran.stdout)
}

/** The registry entries with the live process facts, or the refusal when the registry cannot be read. */
async function registryAndFacts($: EngineInterface): Promise<{ entries: SessionEntry[]; facts: ProcFacts } | { deny: string }> {
  const parsed = parseRegistry(await readRegistryText($))
  if (!parsed.ok) return { deny: `${PLUGIN}: ${parsed.error}` }
  return { entries: parsed.entries, facts: await probe($, parsed.entries) }
}

/** The runs directory (worker results, errors and the cleared log). */
async function runsPath($: EngineInterface): Promise<string> {
  return expandHome(config.runsDir, await homeDir($))
}

const shortIds = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map(id => id.slice(0, 8)).join(', '))

const writeFailed = (ran: { exitCode: number; stderr: string }) => `registry write FAILED (exit ${ran.exitCode}): ${ran.stderr.slice(0, 120)}`

/** A worker whose recorded pid is gone: classify, maybe merge into the registry, toast. */
async function complete($: EngineInterface, entry: SessionEntry, taskStatus: string | undefined): Promise<void> {
  const sid = entry.session_id
  if (typeof sid !== 'string') return
  // Keyed by session and pid: a resumed session finishes again under a new pid.
  const key = `${sid}:${entry.pid}`
  if (harvested.has(key)) return
  if (typeof entry.result_file !== 'string') return
  const resultText = await $.fs.read(entry.result_file).catch(() => '')
  const outcome: SessionOutcome = classifyResult(resultText, taskStatus)
  harvested.add(key)
  const label = `${entry.title ?? sid.slice(0, 8)}: ${outcome.summary}`
  if (config.completionWrites) {
    // Read again right before writing, so the window against the licence
    // daemon's own writes is as short as this API allows (no lock, no rename).
    const path = await registryPath($)
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await readRegistryText($)
      const merged = mergeCompletion(fresh, sid, outcome)
      if (!merged.changed) break
      await backupOnce($, 'headless-sessions.json', 'completion', localDate(await $.clock.now()), fresh)
      if (await writeAtomic($, path, merged.text, fresh)) break
    }
  }
  $.ui.toast(`session-control: ${label}`, { timeoutMs: 8000 })
  await update($, pendingNotes, list => [...list, label].slice(-20))
}

/** Reads the points and the queue into the panel's atoms; answers the first problem with those files. */
async function loadPoints($: EngineInterface): Promise<string | undefined> {
  const text = await $.fs.read(orchPath('open-points.json')).catch(() => undefined)
  const parsed = text === undefined ? ({ ok: true, points: [] } as const) : parseOpenPoints(text)
  const list: PresentedPoint[] | null = parsed.ok ? parsed.points : null
  if (!isSame(await read($, points), list)) await update($, points, () => list)
  const queueText = await $.fs.read(orchPath('task-queue.json')).catch(() => '')
  const queue = parseQueuedWork(queueText)
  if (!isSame(await read($, queued), queue)) await update($, queued, () => queue)
  return parsed.ok ? undefined : parsed.error
}

async function gather($: EngineInterface, taskStatus: string | undefined): Promise<void> {
  const problem = await loadPoints($)
  const parsed = parseRegistry(await readRegistryText($))
  const now = await $.clock.now()
  if (!parsed.ok) {
    // The last good rows stay on screen under the warning.
    await showError($, problem === undefined ? parsed.error : `${parsed.error}; ${problem}`, now)
    return
  }
  const facts = await probe($, parsed.entries)
  for (const entry of parsed.entries) {
    if (rowStatus(entry, facts) === 'dead') await complete($, entry, taskStatus)
  }
  const rows = buildRows(parsed.entries, facts, Math.floor(now / 1000))
  const next = problem === undefined ? { at: now, rows } : { at: now, rows, error: problem }
  noteError($, next.error)
  if (!isSame(await read($, snapshot), next, 'at')) await update($, snapshot, () => next)
}

/** A problem is toasted once, when it first appears or changes. */
function noteError($: EngineInterface, error: string | undefined): void {
  if (error === lastError) return
  lastError = error
  if (error !== undefined) $.ui.toast(`session-control: ${error}`, { timeoutMs: 10000 })
}

async function showError($: EngineInterface, error: string, now: number): Promise<void> {
  noteError($, error)
  await update($, snapshot, prev => ({ at: now, rows: prev?.rows ?? [], error }))
}

async function refresh($: EngineInterface, taskStatus?: string): Promise<void> {
  if (!isActive || isBusy) return
  isBusy = true
  try {
    await gather($, taskStatus)
  } catch (err) {
    await showError($, String(err).slice(0, 200), await $.clock.now())
  } finally {
    isBusy = false
  }
}

/** Re-read the tail of the watched worker's transcript into the pane's atom. */
async function refreshWatch($: EngineInterface): Promise<void> {
  const sid = await read($, selected)
  if (!isActive || sid === null) return
  const parsed = parseRegistry(await readRegistryText($))
  const entry = parsed.ok ? parsed.entries.find(one => one.session_id === sid) : undefined
  const path = entry === undefined ? undefined : transcriptPath(entry)
  const title = entry?.title ?? sid.slice(0, 8)
  if (path === undefined) {
    await update($, watch, () => ({ title, lines: ['no transcript path for this entry'] }))
    return
  }
  // Cap each line: one huge tool result must not push the newest rows out of the output.
  const ran = await $.process.run(['sh', '-c', 'tail -n 600 "$1" | cut -c1-20000', 'session-tail', path], { timeoutMs: 5_000 })
  const lines = ran.exitCode === 0 ? summarizeTranscript(ran.stdout, 300) : [`cannot read ${path}`]
  const next = { title, lines }
  if (!isSame(await read($, watch), next)) await update($, watch, () => next)
}

function tick($: EngineInterface): void {
  void refresh($)
  void refreshWatch($)
}

/** One edit of a helper file: read, back up once per day, write; open points also rotate into the archive. */
async function editHelper(
  $: EngineInterface,
  file: string,
  tool: string,
  edit: (text: string, today: string) => Edit,
): Promise<{ result: string } | { deny: string }> {
  const path = orchPath(file)
  await ensureFile($, path, file)
  const today = localDate(await $.clock.now())
  // One retry when another writer changed the file between the read and the rename.
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text === undefined) return { deny: `${PLUGIN}: ${file} cannot be read` }
    const edited = edit(text, today)
    if (!edited.ok) return { deny: `${PLUGIN}: ${edited.error}` }
    await backupOnce($, file, tool, today, text)
    // The archive first: a failure after it duplicates an entry, a failure before it loses none.
    if (edited.archive !== undefined) {
      const archive = orchPath('open-points-archive.md')
      await ensureFile($, archive, 'open-points-archive.md')
      const old = await $.fs.read(archive).catch(() => undefined)
      if (old === undefined) return { deny: `${PLUGIN}: open-points-archive.md cannot be read; nothing written` }
      await $.fs.write(archive, old + edited.archive)
    }
    if (await writeAtomic($, path, edited.text, text)) {
      await refresh($)
      return { result: `${file}: ${edited.note}.` }
    }
  }
  return { deny: `${PLUGIN}: ${file} changed while it was being edited; nothing written, try again` }
}

/** The orchestrator has acknowledged finished workers' results: they show as finished; with keep they also stay for a resume. */
async function acknowledge($: EngineInterface, ids: readonly string[], keep: boolean) {
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const done: string[] = []
  const refused: string[] = []
  for (const id of ids) {
    const entry = findBySid(reg.entries, id)
    if (entry === undefined) refused.push(`${id.slice(0, 8)} (no registry entry)`)
    else if (rowStatus(entry, reg.facts) === 'alive') refused.push(`${id.slice(0, 8)} (its process is alive)`)
    else done.push(entry.session_id)
  }
  if (done.length > 0) {
    const ran = await $.process.run(['sh', '-c', ACK_SCRIPT, 'session-ack', await registryPath($), keep ? 'keep' : 'plain', ...done], { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) return { deny: `${PLUGIN}: ${writeFailed(ran)}` }
    await refresh($)
  }
  return { result: `Acknowledged${keep ? ' and kept' : ''}: ${shortIds(done)}.${refused.length === 0 ? '' : ` Refused: ${refused.join('; ')}.`}` }
}

/** The orchestrator retires finished workers it no longer needs; the guards keep any that could still be resumed. */
async function retire($: EngineInterface, ids: readonly string[]) {
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const queueText = await $.fs.read(orchPath('task-queue.json')).catch(() => '')
  const verdict = retireVerdict(reg.entries, reg.facts, queueText, ids)
  if (verdict.removable.length > 0) {
    const ran = await $.process.run(
      ['sh', '-c', CLEAR_SCRIPT, 'session-clear', await registryPath($), `${await runsPath($)}/cleared.jsonl`, ...verdict.removable],
      { timeoutMs: 10_000 },
    )
    if (ran.exitCode !== 0) return { deny: `${PLUGIN}: ${writeFailed(ran)}` }
    await refresh($)
  }
  const removed = shortIds(verdict.removable)
  const refused = verdict.refused.length === 0 ? '' : ` Refused: ${verdict.refused.map(one => `${one.id.slice(0, 8)} (${one.reason})`).join('; ')}.`
  return { result: `Retired: ${removed}.${refused}` }
}

async function launch($: EngineInterface, args: LaunchArgs) {
  const home = await homeDir($)
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const promptCheck = await $.process.run(['test', '-s', args.prompt_file], { timeoutMs: 5_000 })
  const dirCheck = await $.process.run(['test', '-d', args.dir], { timeoutMs: 5_000 })
  const promptText = await $.fs.read(args.prompt_file).catch(() => undefined)
  const resumeSid = typeof args.resume_sid === 'string' ? args.resume_sid : undefined
  // Without a picker command a fresh launch uses the machine's default config directory.
  const picker = config.licencePickCommand.trim()
  const pick =
    resumeSid !== undefined
      ? undefined
      : picker === ''
        ? { exitCode: 0, stdout: `${home}/.claude` }
        : await $.process.run(pickArgv(picker, args.need ?? 40, home), { timeoutMs: 20_000 })
  const verdict = checkLaunch(args, {
    home,
    orchestratorDir: config.orchestratorDir,
    entries: reg.entries,
    facts: reg.facts,
    pick,
    transcriptExists: resumeSid === undefined ? undefined : reg.facts.transcriptMtime.has(resumeSid),
    promptFileOk: promptCheck.exitCode === 0,
    dirOk: dirCheck.exitCode === 0,
    missingItems: promptText === undefined ? undefined : missingPromptItems(promptText),
  })
  if (!verdict.ok) return { deny: `${PLUGIN}: ${verdict.reason}` }
  return spawnWorker($, args, verdict, reg.entries, reg.facts)
}

/** Start the worker as a background Bash task, find its real pid and session, register it. */
async function spawnWorker(
  $: EngineInterface,
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string },
  entries: readonly SessionEntry[],
  before: ProcFacts,
) {
  const runsDir = await runsPath($)
  await $.process.run(['mkdir', '-p', runsDir], { timeoutMs: 5_000 })
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const base = `${runsDir}/${stamp}-${slugify(args.title)}`
  const files = { result: `${base}.json`, err: `${base}.err` }
  const command = buildLaunchArgv(args, verdict, files.result, files.err)[2] ?? ''
  const known = new Set(before.claude.map(one => one.pid))
  // The engine's own background task: its exit notification reaches the session.
  await $.tool.call({
    tool: 'Bash',
    command,
    description: `session-control worker: ${args.title}`.slice(0, 100),
    run_in_background: true,
    timeout: launchTimeoutMs(args),
  })
  let worker: ReturnType<typeof findNewWorker>
  for (let attempt = 0; attempt < 15 && worker === undefined; attempt++) {
    await $.process.run(['sleep', '2'], { timeoutMs: 5_000 })
    worker = findNewWorker(await probe($, entries), { dir: args.dir, configDir: verdict.configDir, model: args.model }, known)
  }
  if (worker === undefined) {
    return { result: `Started in the background but no claude process appeared within 30 s; check ${files.err}. Not registered.` }
  }
  // The engine writes the session file shortly after the process starts: read it again until it is there.
  let sessionId = verdict.resumeSid ?? ''
  for (let attempt = 0; attempt < 10; attempt++) {
    const sessionFile = await $.fs.read(`${verdict.configDir}/sessions/${worker.pid}.json`).catch(() => '')
    try {
      const fromFile = (JSON.parse(sessionFile) as { sessionId?: unknown }).sessionId
      if (typeof fromFile === 'string' && fromFile !== '') {
        sessionId = fromFile
        break
      }
    } catch {
      // not written yet
    }
    if (sessionId !== '') break
    await $.process.run(['sleep', '1'], { timeoutMs: 5_000 })
  }
  if (sessionId === '') return { result: `Worker pid ${worker.pid} started but its session id could not be read; registry NOT written.` }
  const entry = newRegistryEntry(args, verdict, worker.pid, sessionId, files)
  const registered = await $.process.run(
    ['sh', '-c', REGISTER_SCRIPT, 'session-register', await registryPath($), JSON.stringify(entry), verdict.resumeSid ? 'resume' : 'new'],
    { timeoutMs: 10_000 },
  )
  const note = registered.exitCode === 0 ? 'registered' : writeFailed(registered)
  await refresh($)
  return {
    result: `Launched pid ${worker.pid}, session ${sessionId}, config_dir ${verdict.configDir}, ${note}. Result: ${files.result}; errors: ${files.err}.`,
  }
}

/** Turn the board on: register the launch tool, start the poll once, gather. */
async function activate($: EngineInterface): Promise<void> {
  isActive = true
  // A failure here (a read-only home, say) must not stop the board: the panel then shows what it can read.
  await ensureHelperFiles($).catch(err => noteError($, `helper files: ${String(err).slice(0, 120)}`))
  if (!isArmed) {
    isArmed = true
    await $.tool.register({
      name: 'launch_worker',
      description:
        'Launch (or resume) a headless claude -p worker with licence pick, cwd and resume guards. ' +
        'Runs it as a background task, finds the real pid and session id and registers the worker.',
      inputSchema: LAUNCH_SCHEMA as unknown as Record<string, unknown>,
    })
    await $.tool.register({
      name: 'acknowledge_workers',
      description:
        'Mark finished workers as acknowledged once their result is reported: they show as finished instead of ' +
        'finished-unreported. Use keep=true when the session is still needed for a resume or as context of new work.',
      inputSchema: ACK_SCHEMA as unknown as Record<string, unknown>,
    })
    await $.tool.register({
      name: 'retire_workers',
      description:
        'Remove finished workers from the registry once their work is acknowledged and they are not needed for a resume ' +
        'or for new work with their context. Refuses a live session, one marked keep, one with an outcome that needs a resume ' +
        'and one named in the task queue; removed entries are logged first.',
      inputSchema: RETIRE_SCHEMA as unknown as Record<string, unknown>,
    })
    for (const [name, description, schema] of [
      ['open_point', 'Add, answer, close, hold or release an open point in open-points.json; settled entries older than 7 days rotate into the archive; the file is backed up once per day.', POINT_SCHEMA],
      ['queue_task', 'Add, update or remove a task in task-queue.json; the file is backed up once per day.', QUEUE_SCHEMA],
      ['record_decision', 'Append one numbered line to a unit section of agreed-decisions.md (the section is created when missing); backed up once per day.', DECISION_SCHEMA],
    ] as const) {
      await $.tool.register({ name, description, inputSchema: schema as unknown as Record<string, unknown> })
    }
  }
  if (!isPolling) {
    isPolling = true
    $.clock.every(config.pollMs, () => tick($))
  }
  await refresh($)
}

export const register: Register = (on, options) => {
  config = {
    orchestratorDir: String(options.orchestratorDir ?? ''),
    registrySetting: String(options.registryPath ?? config.registrySetting),
    completionWrites: options.completionWrites === true,
    pollMs: Math.max(1, Number(options.pollSeconds ?? 5)) * 1000,
    runsDir: String(options.runsDir ?? config.runsDir),
    licencePickCommand: String(options.licencePickCommand ?? ''),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // /session-control is registered everywhere; the board starts by itself only in the orchestrator dir.
    await $.command.register({
      name: 'session-control',
      description: 'Session-control panel: open or close the side panel (sessions, queued work, open points)',
    })
    // Without the option, the orchestrator directory is the one whose CLAUDE.md is the orchestrator's.
    const cwd = e.cwd.replace(/\/+$/, '')
    if (config.orchestratorDir === '' && (await $.fs.read(`${cwd}/CLAUDE.md`).catch(() => '')).startsWith(ORCHESTRATOR_HEADING)) {
      config.orchestratorDir = cwd
    }
    if (config.orchestratorDir !== '' && cwd === config.orchestratorDir.replace(/\/+$/, '')) await activate($)
    return started
  })

  // /session-control shows or hides the panel. Either way the board is on (activate is idempotent): hiding the panel
  // stops no tracking, the report check or the poll.
  on('command.run', { command: 'session-control' }, async ($) => {
    if (config.orchestratorDir === '') {
      return { text: `session-control: this directory is not an orchestrator directory (its CLAUDE.md does not start with "${ORCHESTRATOR_HEADING}") and no orchestratorDir option is set.` }
    }
    await activate($)
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      await update($, selected, () => null)
      return { text: 'Session-control panel hidden, session-control stays on.' }
    }
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Session control' })
    return { text: opened.isPlaced ? 'Session-control panel opened.' : `Session-control panel waits: ${opened.reason}` }
  })

  // Completion: a background task's notification reaches the session.
  // After a compaction the summary replaces what the model knew: the next prompt
  // carries the state read from the files.
  on('classic.PostCompact', async ($, e, next) => {
    isAfterCompact = true
    return next(e)
  })

  // Peer ledger: tasks sent to a peer stay open until a peer reply arrives.
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (isActive && e.origin.kind === 'model' && e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, ledger, list => addPeerNote(list, e.to, e.text, now))
    }
    return sent
  })

  on('session.receive', async ($, e, next) => {
    if (isActive && (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message')) {
      await update($, ledger, list => ackPeerNote(list, e.text))
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isActive) return next(e)
    const extra: string[] = []
    if (e.origin.kind === 'task-notification') {
      await refresh($, parseTaskNotification(e.text).status)
      const notes = await read($, pendingNotes)
      if (notes.length > 0) {
        await update($, pendingNotes, () => [])
        extra.push(`session-control completions: ${notes.join('; ')}`)
      }
    }
    if (isAfterCompact) {
      isAfterCompact = false
      await refresh($)
      const [snap, list] = await Promise.all([read($, snapshot), read($, points)])
      extra.push(compactionDigest(snap?.rows ?? [], list, unackedPeers(await read($, ledger))))
    }
    if (extra.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  // Report check, for my own use: a report that breaks the rules is sent back
  // once (stop_hook_active stops a second block) so the model corrects it.
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    const answer = e.last_assistant_message ?? ''
    if (!isActive || e.stop_hook_active || answer === '') return done
    const findings = lintReport(answer, { unackedPeers: unackedPeers(await read($, ledger)) })
    if (findings.length === 0) return done
    return { ...done, block: `Report check failed: ${findings.join('; ')}. Resend the corrected report; say nothing about this check.` }
  })

  on('tool.call', { tool: POINT_TOOL }, ($, e) =>
    editHelper($, 'open-points.json', 'open-point', (text, today) => editOpenPoints(text, plain(e), today)),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: open_point failed` }))

  on('tool.call', { tool: QUEUE_TOOL }, ($, e) =>
    editHelper($, 'task-queue.json', 'queue-task', text => editQueue(text, plain(e))),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: queue_task failed` }))

  on('tool.call', { tool: DECISION_TOOL }, ($, e) =>
    editHelper($, 'agreed-decisions.md', 'record-decision', text => appendDecision(text, plain(e))),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: record_decision failed` }))

  on('tool.call', { tool: ACK_TOOL }, ($, e) => {
    const input = e as unknown as { session_ids?: unknown; keep?: unknown }
    return acknowledge($, (input.session_ids as string[] | undefined) ?? [], input.keep === true)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: acknowledge_workers failed` }))

  on('tool.call', { tool: RETIRE_TOOL }, ($, e) => {
    const input = e as unknown as { session_ids?: unknown }
    return retire($, (input.session_ids as string[] | undefined) ?? [])
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: retire_workers failed` }))

  on('tool.call', { tool: TOOL }, ($, e) => launch($, e as unknown as LaunchArgs)).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: launch_worker guard failed` }))

  // A wheel tick over a box that has more rows scrolls that box. The panel itself scrolls only when the room is
  // too small to hold the three boxes at their minimum height (a pane seated low, inline).
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const fits = e.contentRows <= e.bodyRows
    const box = e.pointer === undefined ? undefined : boxAt(layout.boxes, e.pointer.row + (fits ? 0 : e.offset - e.by))
    const t = box === undefined ? undefined : layout.totals[box.id]
    if (box !== undefined && t !== undefined && t.total > t.visible) {
      if (box.id === 'log') await update($, boxBack, current => nextBack(current, e.by, t.total, t.visible))
      else {
        const id = box.id
        await update($, offsets, current => ({ ...current, [id]: clampOffset((current[id] ?? 0) + e.by, t.total, t.visible) }))
      }
      return next({ ...e, offset: holdOffset(e.offset, e.by, e.contentRows, e.bodyRows) })
    }
    return fits ? next({ ...e, offset: 0 }) : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const columns = e.props.bodyColumns
    if (snap === null) return <Text dimColor>session-control is idle here (not the orchestrator dir).</Text>
    const [view, sel, queue, list, back, pointSel, offs, activeTab] = await Promise.all([
      read($, watch),
      read($, selected),
      read($, queued),
      read($, points),
      read($, boxBack),
      read($, selectedPoint),
      read($, offsets),
      read($, tab),
    ])
    const width = Math.max(20, columns - 4)
    const isLogOpen = sel !== null && view !== null
    // Docked: three boxes, never below three content rows each. Seated low (inline): one box at a time behind a tab
    // strip, at most 11 rows, so the panel can never push the chat input off the screen.
    const isCompact = e.props.placement === 'inline'
    // Never more than the room the engine offers: forcing a minimum pushed the status line and the mode off the screen.
    const compactRows = Math.max(3, Math.min(7, e.props.scroll.bodyRows))
    const activeId: SectionId = isLogOpen ? 'log' : (activeTab as SectionId)
    const bodyRows = isCompact ? compactRows : Math.max(MIN_SESSIONS_BOX + 2 * MIN_BOX, e.props.scroll.bodyRows)
    const boxes: SectionBox[] = isCompact ? [{ id: activeId, top: 1, height: compactRows - 1 }] : sectionBoxes(bodyRows, isLogOpen)
    layout = { boxes, totals: {} }
    type PRow = { text: string; key?: string; group?: string; press?: () => unknown; dim?: boolean; bold?: boolean; color?: 'warning' }
    const widths = paneWidths(snap.rows, width - 2)
    const toggle = (sid: string) => async () => {
      await update($, selected, current => (current === sid ? null : sid))
      await update($, boxBack, () => 0)
      await refreshWatch($)
    }
    const togglePoint = (id: string) => () => update($, selectedPoint, current => (current === id ? null : id))
    const rowEl = (r: PRow) =>
      r.press === undefined ? (
        <Text bold={r.bold} dimColor={r.dim} color={r.color}>
          {r.text}
        </Text>
      ) : (
        <Button
          key={r.key}
          label={r.text === '' ? ' ' : r.text}
          plain
          dimColor={r.dim}
          hover={r.group === undefined ? undefined : { scope: r.group, inverse: true }}
          onPress={r.press}
        />
      )
    const block = (id: SectionId, title: string, fixed: PRow[], body: PRow[], offset: number, isTail = false, isPlain = false) => {
      const box = boxes.find(one => one.id === id) as SectionBox
      const visible = Math.max(1, box.height - (isPlain ? 0 : 3) - fixed.length)
      const total = body.length
      layout.totals[id] = { total, visible }
      const from = isTail ? Math.max(0, total - visible - back) : clampOffset(offset, total, visible)
      const bar = scrollbar(total, visible, from)
      const rows = (
        <Box flexDirection="row" height={visible}>
          <Box flexDirection="column" flexGrow={1}>
            {body.slice(from, from + visible).map(rowEl)}
          </Box>
          <Box flexDirection="column" width={1}>
            {bar.map(ch => (
              <Text dimColor>{ch}</Text>
            ))}
          </Box>
        </Box>
      )
      // Compact (inline) panel: no border and no title, the tab strip names the box; every row counts.
      if (isPlain) {
        return (
          <Box flexDirection="column" height={box.height} overflow="hidden">
            {fixed.map(rowEl)}
            {rows}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" height={box.height} overflow="hidden" borderStyle="round" borderDimColor>
          <Text bold>{title}</Text>
          {fixed.map(rowEl)}
          {rows}
        </Box>
      )
    }
    const sessionRows: PRow[] = snap.rows.length === 0 ? [{ text: 'No workers in the registry.', dim: true }] : snap.rows.map(row => {
      const sid = row.sid
      const text = (sid !== undefined && sid === sel ? '\u25B8 ' : '  ') + formatRow(row, width - 2, widths)
      if (sid === undefined) return { text, dim: row.status === 'done', color: row.status === 'dead' || row.status === 'orphan' ? ('warning' as const) : undefined }
      return { text, key: `s:${sid}`, press: toggle(sid), dim: row.status === 'done' }
    })
    const pick = (id: 'sessions' | 'queue' | 'points') => async () => {
      await update($, tab, () => id)
      await update($, selected, () => null)
    }
    const queueCount = queue?.length ?? 0
    const pointCount = list?.length ?? 0
    const tabButton = (id: 'sessions' | 'queue' | 'points', label: string) => (
      <Button key={`tab:${id}`} label={activeId === id || (isLogOpen && id === 'sessions') ? `[ ${label} ]` : `  ${label}  `} plain dimColor={!(activeId === id || (isLogOpen && id === 'sessions'))} onPress={pick(id)} />
    )
    const compactView = (inner: ReturnType<typeof block>) => (
      <Box flexDirection="column" height={bodyRows} overflow="hidden">
        <Box flexDirection="row">
          {tabButton('sessions', `Sessions ${snap.rows.length}`)}
          {tabButton('queue', `Queued ${queueCount}`)}
          {tabButton('points', `Open points ${pointCount}`)}
        </Box>
        {inner}
      </Box>
    )
    const sessionsBlock = (isPlain = false) => block('sessions', 'SESSIONS', [...(snap.error === undefined ? [] : [{ text: wrapText(`! session-control: ${snap.error}`, width)[0] ?? '', dim: false }]), { text: '  ' + formatHeader(width - 2, widths), dim: true }], sessionRows, offs.sessions, false, isPlain)
    if (isLogOpen && view !== null) {
      const logRows: PRow[] = view.lines.flatMap(line => {
        const wrapped = wrapText(line, width).slice(0, 2)
        return wrapped.map(text => ({ text, dim: line.startsWith('  <') || line.startsWith('>') }))
      })
      if (logRows.length === 0) logRows.push({ text: 'Waiting for output.', dim: true })
      if (isCompact) return compactView(block('log', `LOG ${view.title}`, [], logRows, 0, true, true))
      return (
        <Box flexDirection="column" height={bodyRows} overflow="hidden">
          {sessionsBlock()}
          {block('log', `LOG ${view.title}`, [], logRows, 0, true)}
        </Box>
      )
    }
    const queueRows: PRow[] =
      queue === null
        ? [{ text: 'task queue unreadable.', dim: true }]
        : queue.length === 0
          ? [{ text: 'none', dim: true }]
          : queue.flatMap(task =>
              wrapText(task.running === true ? `${task.title} (running)` : task.title, width - 2).map((text, i) => ({ text: (i === 0 ? '\u2022 ' : '  ') + text })),
            )
    const pointRows: PRow[] =
      list === null
        ? [{ text: 'open points unreadable.', dim: true }]
        : list.length === 0
          ? [{ text: 'none', dim: true }]
          : list.flatMap((point, index) => {
              const id = point.id || String(index)
              const press = togglePoint(point.id)
              if (point.id === '' || point.id !== pointSel) {
                const row = `  ${index + 1}. ${point.title}`
                return [{ text: row.length > width ? row.slice(0, width - 1) + '\u2026' : row, key: `p:${id}:0`, press }]
              }
              // Rows of one block share a hover scope: hovering any row lights every row of the block together.
              const lines: PRow[] = []
              wrapText(`${index + 1}. ${point.title}`, width - 2).forEach((text, i) =>
                lines.push({ text: (i === 0 ? '\u25B8 ' : '  ') + text, key: `p:${id}:t:${i}`, group: `p:${id}:t`, press, bold: true }),
              )
              const body = [
                ...(point.detail === '' ? [] : wrapText(point.detail, width - 4)),
                ...(point.recommendation === '' ? [] : wrapText('Recommendation: ' + point.recommendation, width - 4)),
              ]
              body.forEach(text => lines.push({ text: '    ' + text, dim: true }))
              return lines
            })
    if (isCompact) {
      return compactView(
        activeId === 'queue'
          ? block('queue', 'QUEUED WORK', [], queueRows, offs.queue, false, true)
          : activeId === 'points'
            ? block('points', 'OPEN POINTS', [], pointRows, offs.points, false, true)
            : sessionsBlock(true),
      )
    }
    return (
      <Box flexDirection="column" height={bodyRows} overflow="hidden">
        {sessionsBlock()}
        {block('queue', 'QUEUED WORK', [], queueRows, offs.queue)}
        {block('points', 'OPEN POINTS', [], pointRows, offs.points)}
      </Box>
    )
  })
}
