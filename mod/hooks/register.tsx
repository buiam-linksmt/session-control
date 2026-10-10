import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register } from 'claude-code'

import type { SessionEntry, SessionOutcome } from '../types'
import { ARCHIVE_SCHEMA, ARCHIVED_HEADING, DECISIONS_ARCHIVE, DECISION_SCHEMA, POINT_SCHEMA, QUEUE_SCHEMA, appendDecision, archiveDecisions, editOpenPoints, editQueue } from './bookkeeping'
import type { Edit } from './bookkeeping'
import { backupName, dirOf, freshText, localDate } from './store'
import {
  TRACE_FILE,
  TRACE_KEEP,
  TRACE_MAX_BYTES,
  TRACE_MAX_STRING,
  chunkLines,
  isTraceSwitch,
  messageFields,
  needsRotation,
  rotationMoves,
  shownArgv,
  shownPicker,
  traceLine,
  traceMessage,
  utf8Bytes,
} from './trace'
import { selectHost } from './host'
import type { Host, HostEnvName, HostPort, TailShape } from './host'
import { HELPER_SCRIPT, fallbackFields, fallbackToast, withHelper } from './host-helper'
import type { HelperNote } from './host-helper'
import { withPowerShellLaunch } from './host-powershell'
import { AUDIT_SCHEMA, auditText } from './audit'
import type { GitState, ListedFile } from './audit'
import {
  LIST_SESSIONS_SCHEMA,
  PANEL_SNAPSHOT_SCHEMA,
  READ_RESULT_CHARS,
  READ_RESULT_SCHEMA,
  SESSION_WRITES_SCHEMA,
  TAIL_LINES,
  WORKER_TAIL_SCHEMA,
  firstTimestamp,
  isUnder,
  listSessionsText,
  matchSession,
  panelSnapshotText,
  readResultText,
  sessionWritesText,
  workerTailText,
} from './inspect'
import {
  LAUNCH_SCHEMA,
  ACK_SCHEMA,
  RETIRE_SCHEMA,
  CLOSE_SCHEMA,
  runFigures,
  runFilesToDelete,
  withRunFigures,
  ackEntries,
  registerEntry,
  removeEntries,
  retireVerdict,
  annotateCleared,
  ackPeerNote,
  addPeerNote,
  buildRows,
  compactionDigest,
  checkLaunch,
  classifyResult,
  expandHome,
  findBySid,
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
  TOAST_TITLES,
  toastText,
  wrapText,
  formatRow,
  paneWidths,
  launchTimeoutMs,
  mergeCompletion,
  missingPromptItems,
  parseOpenPoints,
  parseQueuedWork,
  newRegistryEntry,
  parseRegistry,
  parseTaskNotification,
  pickArgv,
  pickWatched,
  summarizeTranscript,
  unackedPeers,
  rowStatus,
  slugify,
  launchName,
  sessionFileFacts,
  pidFromFile,
  reportCheck,
  resultReport,
} from './core'
import type { ExpandableId, LaunchArgs, PresentedPoint, ProcFact, ProcFacts, RegistryEdit, RunFigures, SectionBox, SectionId } from './core'

const PLUGIN = 'session-control'
const PANE = 'session-control'
const ORCHESTRATOR_HEADING = '# Role: Session Orchestrator'
const TOOL = 'mcp__session-control__launch_worker'
const RETIRE_TOOL = 'mcp__session-control__retire_workers'
const ACK_TOOL = 'mcp__session-control__acknowledge_workers'
const POINT_TOOL = 'mcp__session-control__open_point'
const QUEUE_TOOL = 'mcp__session-control__queue_task'
const DECISION_TOOL = 'mcp__session-control__record_decision'
const LIST_TOOL = 'mcp__session-control__list_sessions'
const RESULT_TOOL = 'mcp__session-control__read_result'
const TAIL_TOOL = 'mcp__session-control__worker_tail'
const WRITES_TOOL = 'mcp__session-control__session_writes'
const SNAPSHOT_TOOL = 'mcp__session-control__panel_snapshot'
const AUDIT_TOOL = 'mcp__session-control__audit_state'
const CLOSE_TOOL = 'mcp__session-control__close_worker'
const ARCHIVE_TOOL = 'mcp__session-control__archive_decisions'

/** How much of a transcript read_result reads when the whole is over the read cap: a final report can be one long row. */
const REPORT_TAIL: TailShape = { lines: 400, width: 400_000 }

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
const expanded = atom({ plugin: 'session-control', key: 'expanded' } as const, null)
const now = atom({ plugin: 'session-control', key: 'now' } as const, 0)

type Config = {
  orchestratorDir: string
  registrySetting: string
  completionWrites: boolean
  pollMs: number
  runsDir: string
  licencePickCommand: string
  debug: boolean
  /** `auto`: the Node helper runs the host's file operations (and the Linux probe) when Node 22+ is found; `off`: the adapters' own. */
  helper: 'auto' | 'off'
  /** The node executable; empty: `node` from the PATH. */
  nodePath: string
  /** `bash`: workers start through the Bash tool; `powershell`: on native Windows through the PowerShell tool (host-powershell.ts). */
  launchRoute: 'bash' | 'powershell'
}

// Per load: a hot reload evaluates the module afresh and session.start re-arms.
let config: Config = {
  orchestratorDir: '',
  registrySetting: '~/.claude/headless-sessions.json',
  completionWrites: false,
  pollMs: 5000,
  runsDir: '~/.claude/session-control/runs',
  licencePickCommand: '',
  debug: false,
  helper: 'auto',
  nodePath: '',
  launchRoute: 'bash',
}
let isActive = false
// What the pane drew last, so the scroll hook knows which box a wheel tick is over.
let layout: { boxes: SectionBox[]; totals: Partial<Record<SectionId, { total: number; visible: number }>> } = { boxes: [], totals: {} }
let isAfterCompact = false
let isBusy = false
let isArmed = false
let isPolling = false
/** The display tick of the elapsed column, while the panel is shown; undefined when none runs. */
let displayTick: { cancel: () => void } | undefined
/** The display tick's period: it only moves the `now` atom on, so the pane redraws its elapsed column. */
const DISPLAY_TICK_MS = 1000
let lastError: string | undefined
let isDirectWriteNoted = false
let isHelperFallbackNoted = false
/** The operations whose untraced fallback has been traced this load: once each, as each later line would be written by the write that failed. */
const quietFallbacksTraced = new Set<string>()
/** The host adapter of this load (hostOf); a hot reload, or a test's fresh register, chooses again. */
let host: Promise<Host> | undefined
const harvested = new Set<string>()
/** Session names this session gave to launches: two launches in the same second still get different names. */
const issuedNames = new Set<string>()

// The debug trace (the debug option or SESSION_CONTROL_DEBUG), written only once the board is on in this session: lines
// wait here until the hook that made them ends or the next poll tick, whichever comes first. Off, every trace call
// returns at its first check.
type TraceEntry = { seq: number; at?: number; stamp: Promise<void>; event: string; fields: Record<string, unknown> }
let isTraceWanted = false
let isTracing = false
let traceStart: Record<string, unknown> = {}
let traceSeq = 0
let traceRenders = 0
let traceFile: string | undefined
let isTraceFlushing = false
let isTraceFailNoted = false
const traceBuffer: TraceEntry[] = []

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

/** An error's message, for a trace line. */
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

/** Records one trace line; off, it returns at its first check. The time is asked now and waited for at the flush. */
function trace($: EngineInterface, event: string, fields: Record<string, unknown> = {}): void {
  if (!isTracing) return
  const entry: TraceEntry = { seq: ++traceSeq, event, fields, stamp: Promise.resolve() }
  try {
    entry.stamp = $.clock.now().then(
      ms => {
        entry.at = ms
      },
      () => undefined,
    )
  } catch {
    // the line keeps no time
  }
  traceBuffer.push(entry)
}

/** A caught error, traced with where it was caught: its kind when known and its message as traceMessage keeps it. */
function traceError($: EngineInterface, where: string, err: unknown): void {
  if (!isTracing) return
  trace($, 'error', { where, ...messageFields(errorText(err)) })
}

/** The trace starts when the board goes on, with the session's start line, once per load. */
function startTrace($: EngineInterface): void {
  if (!isTraceWanted || isTracing) return
  isTracing = true
  trace($, 'session.start', traceStart)
}

/**
 * `$.process.run`; with the trace on also a line: the command as `shown` gives it (else the argv as shownArgv shows
 * it), the exit code, the time taken and the size of stderr, never its text.
 */
async function run($: EngineInterface, argv: readonly string[], init?: ProcessRunInit, isQuiet = false, shown?: Record<string, unknown>): Promise<ProcessRunResult> {
  if (!isTracing || isQuiet) return $.process.run(argv, init)
  const command = shown ?? { argv: shownArgv(argv) }
  const now = () => $.clock.now().catch(() => 0)
  const startedAt = await now()
  try {
    const ran = await $.process.run(argv, init)
    const stderr = ran.stderr === '' ? {} : { stderrBytes: utf8Bytes(ran.stderr) }
    trace($, 'process.run', { ...command, exitCode: ran.exitCode, ms: (await now()) - startedAt, ...stderr })
    return ran
  } catch (err) {
    trace($, 'process.run', { ...command, ms: (await now()) - startedAt, error: traceMessage(errorText(err)) })
    throw err
  }
}

/** `$.fs.write`; with the trace on also a line with the path and the byte count. */
async function write($: EngineInterface, path: string, text: string, isQuiet = false): Promise<void> {
  if (!isTracing || isQuiet) return $.fs.write(path, text)
  try {
    await $.fs.write(path, text)
    trace($, 'fs.write', { path, bytes: utf8Bytes(text) })
  } catch (err) {
    trace($, 'fs.write', { path, bytes: utf8Bytes(text), error: traceMessage(errorText(err)) })
    throw err
  }
}

/**
 * Writes the buffered trace lines; a flush already running takes the lines that arrive meanwhile. A failure is
 * swallowed and toasted once: the trace never stops the mod.
 */
async function flushTrace($: EngineInterface): Promise<void> {
  if (!isTracing || isTraceFlushing || traceBuffer.length === 0) return
  isTraceFlushing = true
  try {
    while (traceBuffer.length > 0) {
      const entries = traceBuffer.splice(0)
      await Promise.all(entries.map(entry => entry.stamp))
      const lines = entries.map(entry => traceLine(entry.seq, entry.at ?? 0, entry.event, entry.fields))
      const problem = await writeTrace($, lines).catch((err: unknown) => errorText(err))
      if (problem !== undefined && !isTraceFailNoted) {
        isTraceFailNoted = true
        $.ui.toast(toastText(TOAST_TITLES.trace, `the debug trace cannot be written (${problem.slice(0, 200)}); the mod goes on without it`), { timeoutMs: 10000 })
      }
    }
  } catch {
    // never let the trace break a hook
  } finally {
    isTraceFlushing = false
  }
}

/**
 * Appends lines to trace.log in the runs directory, rotating it first when it would grow past its limit. The size is
 * read before each append: other sessions may write the same trace.
 */
async function writeTrace($: EngineInterface, lines: readonly string[]): Promise<string | undefined> {
  const path = traceFile ?? (traceFile = `${await runsPath($)}/${TRACE_FILE}`)
  for (const chunk of chunkLines(lines)) {
    const adding = utf8Bytes(chunk.join('\n')) + 1
    const isRotationDue = needsRotation((await $.fs.stat(path).catch(() => undefined))?.size ?? 0, adding)
    const rotation = isRotationDue ? { path, adding, keep: TRACE_KEEP, maxBytes: TRACE_MAX_BYTES, moves: rotationMoves(path) } : undefined
    let problem = await (await hostOf($)).rotateAndAppend(portOf($), path, chunk, rotation)
    // Outside the orchestrator directory nothing may have made the runs directory yet (Windows' append makes it).
    if (problem !== undefined && (await (await hostOf($)).makeDir(portOf($), dirOf(path)))) {
      problem = await appendLog($, path, chunk, true)
    }
    if (problem !== undefined) return problem
  }
  return undefined
}

/** Runs a hook's work and then writes the trace lines it made. */
async function traced<T>($: EngineInterface, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } finally {
    await flushTrace($)
  }
}

// Every machine call goes through the host adapter (host.ts): host-posix.ts on Linux and WSL, host-windows.ts on
// native Windows. hostOf is the one place the platform is chosen; nothing else here branches on it.

/**
 * The adapter of this load, chosen once by selectHost from OS and USERPROFILE at the first hook that needs it
 * (session.start); on native Windows with the launchRoute option `powershell` workers start through the PowerShell
 * tool (host-powershell.ts); with the helper option `auto` its file operations go through the Node helper
 * (host-helper.ts), which looks for Node at its first operation.
 */
async function hostOf($: EngineInterface): Promise<Host> {
  // A choice that failed (the environment unreadable) is made again by the next hook.
  host ??= chooseHost($).catch((err: unknown) => {
    host = undefined
    throw err
  })
  return host
}

async function chooseHost($: EngineInterface): Promise<Host> {
  const selected = selectHost({ OS: await $.env.get('OS'), USERPROFILE: await $.env.get('USERPROFILE') })
  // The PowerShell route is Windows' own: on Linux and WSL the option changes nothing.
  const base = config.launchRoute === 'powershell' && selected.platform === 'windows' ? withPowerShellLaunch(selected) : selected
  if (config.helper === 'off') return base
  const node = config.nodePath.trim() === '' ? 'node' : expandHome(config.nodePath.trim(), await base.homeDir(portOf($)))
  return withHelper(base, { node, script: `${$.plugin.root.replace(/[\\/]+$/, '')}/${HELPER_SCRIPT}` })
}

/** The engine facilities the adapter may use, over this hook's `$`: the adapter never holds `$` itself. */
function portOf($: EngineInterface): HostPort {
  return {
    run: (argv, init, isQuiet, shown) => run($, argv, init, isQuiet, shown),
    read: path => $.fs.read(path),
    write: (path, text, isQuiet) => write($, path, text, isQuiet),
    exists: path => $.fs.exists(path),
    stat: path => $.fs.stat(path),
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    env: name => hostEnv($, name),
    runsDir: () => runsPath($),
    traceError: (where, err) => traceError($, where, err),
    noteDirectWrite: text => noteDirectWrite($, text),
    noteHelper: note => noteHelper($, note),
  }
}

/** An environment variable the adapter reads, each by its literal name. */
async function hostEnv($: EngineInterface, name: HostEnvName): Promise<string | undefined> {
  if (name === 'HOME') return $.env.get('HOME')
  if (name === 'USERPROFILE') return $.env.get('USERPROFILE')
  return $.env.get('SystemRoot')
}

/** A file was written over directly, not through a rename (Windows, when its rename fails): said once per load. */
function noteDirectWrite($: EngineInterface, text: string): void {
  if (isDirectWriteNoted) return
  isDirectWriteNoted = true
  $.ui.toast(toastText(TOAST_TITLES.directWrite, text), { timeoutMs: 10000 })
}

/**
 * The Node helper's word: its detection is one trace line; a fallback is a trace line with the operation and the code
 * (and `isRepeated` false for an append that timed out and was not made again) and, once per load, a toast. The
 * fallback of an untraced operation (the trace's own write) is traced once per operation: a line for each would be
 * written by the write that failed, and the flush would never end.
 */
function noteHelper($: EngineInterface, note: HelperNote): void {
  if (note.kind === 'node') {
    const { kind, ...fields } = note
    trace($, 'helper', fields)
    return
  }
  if (!note.isQuiet || !quietFallbacksTraced.has(note.op)) trace($, 'helper.fallback', fallbackFields(note))
  if (note.isQuiet) quietFallbacksTraced.add(note.op)
  if (isHelperFallbackNoted) return
  isHelperFallbackNoted = true
  $.ui.toast(toastText(TOAST_TITLES.helper, fallbackToast(note)), { timeoutMs: 10000 })
}

async function homeDir($: EngineInterface): Promise<string> {
  return (await hostOf($)).homeDir(portOf($))
}

/** A path from the settings with `~` expanded, in the form the host stores. */
async function settingPath($: EngineInterface, setting: string): Promise<string> {
  const machine = await hostOf($)
  return machine.nativePath(expandHome(setting, await machine.homeDir(portOf($))))
}

async function registryPath($: EngineInterface): Promise<string> {
  return settingPath($, config.registrySetting)
}

async function readRegistryText($: EngineInterface): Promise<string> {
  const path = await registryPath($)
  return $.fs.read(path).catch(() => '')
}

/** Writes a file through a temporary sibling and a rename (host.writeAtomic); false when `expected` no longer holds. */
async function writeAtomic($: EngineInterface, path: string, text: string, expected?: string): Promise<boolean> {
  return (await hostOf($)).writeAtomic(portOf($), path, text, expected)
}

/**
 * One registry edit: read the text, edit it, write it through writeAtomic against the text read; when another
 * writer changed the file meanwhile, read and edit once more. A missing file is `missing` when given, else there is
 * nothing to edit; a file that is there but cannot be read is never written. Answers what went wrong, if anything.
 */
async function editRegistry($: EngineInterface, edit: (text: string) => Promise<RegistryEdit>, missing?: string): Promise<string | undefined> {
  const path = await registryPath($)
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text === undefined && (await $.fs.exists(path).catch(() => true))) return 'the registry cannot be read'
    const base = text ?? missing
    if (base === undefined) return undefined
    const edited = await edit(base)
    if (!edited.ok) return edited.error
    if (edited.text === text) return undefined
    try {
      if (await writeAtomic($, path, edited.text, text)) return undefined
    } catch (err) {
      traceError($, 'registry write', err)
      return String(err)
    }
  }
  return 'the registry changed while it was being edited; nothing written'
}

/** Appends lines to a log file without reading it, so a log of any size takes them (host.append). Answers what went wrong. */
async function appendLog($: EngineInterface, path: string, lines: readonly string[], isQuiet = false): Promise<string | undefined> {
  const traceAppend = (exitCode: number) => {
    if (isTracing && !isQuiet) trace($, 'fs.append', { path, bytes: utf8Bytes(lines.join('\n')) + 1, lines: lines.length, exitCode })
  }
  return (await hostOf($)).append(portOf($), path, lines, isQuiet, traceAppend)
}

/** Backups are written once per file, tool and day, before the first change of that day. */
async function backupOnce($: EngineInterface, file: string, tool: string, today: string, text: string): Promise<void> {
  const backup = orchPath(`backups/${backupName(file, tool, today)}`)
  if ((await $.fs.read(backup).catch(() => undefined)) === undefined) await write($, backup, text)
}

/** A missing helper file is created from scratch, with its directory; an existing file is never touched. */
async function ensureFile($: EngineInterface, path: string, file: string): Promise<void> {
  const initial = freshText(file)
  if (initial === undefined) return
  if ((await $.fs.read(path).catch(() => undefined)) !== undefined) return
  await (await hostOf($)).createFile(portOf($), path, initial)
}

/** Fresh environment: the helper files, the backup directory and the runs directory exist before anything reads them. */
async function ensureHelperFiles($: EngineInterface): Promise<void> {
  for (const file of ['open-points.json', 'task-queue.json', 'agreed-decisions.md', 'open-points-archive.md']) {
    await ensureFile($, orchPath(file), file)
  }
  await ensureFile($, await registryPath($), 'headless-sessions.json')
  await (await hostOf($)).prepareHelperDirs(portOf($), orchPath('backups'))
}

/** The process facts (host.probe); `configDirs` are where the probe may look for sessions files too. */
async function probe($: EngineInterface, entries: readonly SessionEntry[], configDirs: readonly string[] = []): Promise<ProcFacts> {
  return (await hostOf($)).probe(portOf($), entries, configDirs)
}

/** The registry entries with the live process facts, or the refusal when the registry cannot be read. */
async function registryAndFacts($: EngineInterface): Promise<{ entries: SessionEntry[]; facts: ProcFacts } | { deny: string }> {
  const parsed = parseRegistry(await readRegistryText($))
  if (!parsed.ok) return { deny: `${PLUGIN}: ${parsed.error}` }
  return { entries: parsed.entries, facts: await probe($, parsed.entries) }
}

/** The runs directory (worker results, errors and the cleared log). */
async function runsPath($: EngineInterface): Promise<string> {
  return settingPath($, config.runsDir)
}

const shortIds = (ids: readonly string[]) => (ids.length === 0 ? 'none' : ids.map(id => id.slice(0, 8)).join(', '))

const writeFailed = (why: string) => `registry write FAILED: ${why.slice(0, 120)}`

/** A worker whose recorded pid is gone: classify, maybe merge into the registry, toast. */
async function complete($: EngineInterface, entry: SessionEntry, taskStatus: string | undefined): Promise<void> {
  const sid = entry.session_id
  if (typeof sid !== 'string') return
  // Keyed by session and pid: a resumed session finishes again under a new pid.
  const key = `${sid}:${entry.pid}`
  if (harvested.has(key)) return
  if (typeof entry.result_file !== 'string') return
  const resultText = await $.fs.read(entry.result_file).catch(() => '')
  const errText = typeof entry.err_file === 'string' ? await $.fs.read(entry.err_file).catch(() => '') : ''
  const outcome: SessionOutcome = classifyResult(resultText, taskStatus, errText)
  // The report check reads a clean report only: the other outcomes have no report to check.
  const reportNote = outcome.kind === 'clean' ? reportCheck(resultReport(resultText)) : undefined
  harvested.add(key)
  trace($, 'completion', { session_id: sid, pid: entry.pid, outcome: outcome.kind, isWritten: config.completionWrites, isReportNoted: reportNote !== undefined })
  const who = entry.title ?? sid.slice(0, 8)
  const label = `${who}: ${outcome.summary}`
  if (config.completionWrites) {
    // Read again right before writing, so the window against the licence
    // daemon's own writes is as short as this API allows (no lock, no rename).
    const path = await registryPath($)
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await readRegistryText($)
      const merged = mergeCompletion(fresh, sid, outcome, Math.floor((await $.clock.now()) / 1000))
      if (!merged.changed) break
      await backupOnce($, 'headless-sessions.json', 'completion', localDate(await $.clock.now()), fresh)
      if (await writeAtomic($, path, merged.text, fresh)) break
    }
  }
  $.ui.toast(toastText(TOAST_TITLES[outcome.kind], `${label}`), { timeoutMs: 8000 })
  const notes = reportNote === undefined ? [label] : [label, `${who}: report check: ${reportNote}`]
  await update($, pendingNotes, list => [...list, ...notes].slice(-20))
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
  if (error !== undefined) trace($, 'error', { where: 'panel', ...messageFields(error) })
  if (error !== undefined) $.ui.toast(toastText(TOAST_TITLES.tracking, `${error}`), { timeoutMs: 10000 })
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
    traceError($, 'refresh', err)
    await showError($, String(err).slice(0, 200), await $.clock.now())
  } finally {
    isBusy = false
  }
}

/**
 * Closes the log of `sid` if it is still the open one. The selection clears by compare-and-set, and the watched view
 * and the expanded state go with it only when the selection was still `sid`: a row pressed meanwhile keeps its selection.
 */
async function closeLog($: EngineInterface, sid: string): Promise<void> {
  let wasOpen = false
  await update($, selected, current => {
    wasOpen = current === sid
    return wasOpen ? null : current
  })
  if (!wasOpen) return
  await update($, watch, current => (current?.sid === sid ? null : current))
  await update($, expanded, () => null)
}

/**
 * Shows the log read for `sid`, unless the selection has left it: a result for a session no longer selected is dropped.
 * The selection and the view are two atoms, so a press can still land between the check and the write; the check after
 * the write takes such a stale view back (the poll writes the new selection's view).
 */
async function showWatch($: EngineInterface, sid: string, view: { title: string; lines: string[] }): Promise<void> {
  const next = { sid, ...view }
  if ((await read($, selected)) !== sid || isSame(await read($, watch), next)) return
  await update($, watch, () => next)
  if ((await read($, selected)) !== sid) await update($, watch, current => (current?.sid === sid ? null : current))
}

/** Re-read the tail of the watched worker's transcript into the pane's atom. */
async function refreshWatch($: EngineInterface): Promise<void> {
  const sid = await read($, selected)
  if (!isActive || sid === null) return
  // A registry that cannot be read or parsed leaves the view as it is: a read error must not close the user's log.
  // Empty or whitespace-only text counts as unreadable (parseRegistry takes it for an empty registry): it is what a
  // read of a file being rewritten can return. The mod writes the registry as a JSON array, so a registry that
  // lost its last entry reads `[]`, never empty text: that one is a registry holding no entries and closes the log.
  const text = await $.fs.read(await registryPath($)).catch(() => undefined)
  if (text === undefined || text.trim() === '') return
  const parsed = parseRegistry(text)
  if (!parsed.ok) return
  const entry = parsed.entries.find(one => one.session_id === sid)
  if (entry === undefined) {
    // The session left the registry (retired): its log closes and the default three sections return, unless the
    // selection moved on while the registry was read.
    await closeLog($, sid)
    return
  }
  const path = (await hostOf($)).transcriptPath(entry)
  const title = entry.title ?? sid.slice(0, 8)
  if (path === undefined) {
    await showWatch($, sid, { title, lines: ['no transcript path for this entry'] })
    return
  }
  const tail = await transcriptTail($, path)
  await showWatch($, sid, { title, lines: tail === undefined ? [`cannot read ${path}`] : summarizeTranscript(tail, 300) })
}

/** The last 600 lines of a transcript, each cut to 20000 characters, so one huge tool result cannot push the newest rows out (host.tail). */
async function transcriptTail($: EngineInterface, path: string): Promise<string | undefined> {
  return (await hostOf($)).tail(portOf($), path)
}

function tick($: EngineInterface): void {
  // A panel shown again (after another pane in front of it, or a reload) gets its display tick back here.
  if (displayTick === undefined) void armDisplayTick($)
  if (!isTracing) {
    void refresh($)
    void refreshWatch($)
    return
  }
  void tracedTick($)
}

/** Starts the display tick when the panel is shown and none runs. */
async function armDisplayTick($: EngineInterface): Promise<void> {
  if (displayTick !== undefined || !(await isPanelShown($))) return
  // Checked again after the wait: the poll and the command may both have asked.
  if (displayTick !== undefined) return
  displayTick = $.clock.every(DISPLAY_TICK_MS, () => void displayStep($))
}

function stopDisplayTick(): void {
  displayTick?.cancel()
  displayTick = undefined
}

async function isPanelShown($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes().catch(() => [])).find(one => one.id === PANE)
  return pane !== undefined && pane.isShown !== false
}

/**
 * One display tick: no process and no file read, only the clock into the `now` atom the pane reads, so the elapsed
 * column redraws with the seconds; the tick ends itself once the panel is hidden or closed.
 */
async function displayStep($: EngineInterface): Promise<void> {
  if (!(await isPanelShown($))) {
    stopDisplayTick()
    return
  }
  const sec = Math.floor((await $.clock.now()) / 1000)
  await update($, now, () => sec)
}

/** A poll tick with the trace on: its line, the renders counted since the last one, then the lines the tick made. */
async function tracedTick($: EngineInterface): Promise<void> {
  if (traceRenders > 0) trace($, 'ui.render', { count: traceRenders })
  traceRenders = 0
  trace($, 'poll.tick')
  await Promise.allSettled([refresh($), refreshWatch($)])
  await flushTrace($)
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
      await write($, archive, old + edited.archive)
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
  trace($, 'guard', { tool: 'acknowledge_workers', done, refused, keep })
  if (done.length > 0) {
    const failed = await editRegistry($, async text => ackEntries(text, done, keep))
    if (failed !== undefined) return { deny: `${PLUGIN}: ${writeFailed(failed)}` }
    await refresh($)
  }
  return { result: `Acknowledged${keep ? ' and kept' : ''}: ${shortIds(done)}.${refused.length === 0 ? '' : ` Refused: ${refused.join('; ')}.`}` }
}

/** The orchestrator retires finished workers it no longer needs; the guards keep any that could still be resumed. */
async function retire($: EngineInterface, ids: readonly string[], reviewed: Readonly<Record<string, unknown>>) {
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const queueText = await $.fs.read(orchPath('task-queue.json')).catch(() => '')
  const verdict = retireVerdict(reg.entries, reg.facts, queueText, ids, reviewed)
  const reviews = verdict.reviewed ?? []
  trace($, 'guard', {
    tool: 'retire_workers',
    removable: verdict.removable,
    refused: verdict.refused,
    ...(reviews.length === 0 ? {} : { reviewed: reviews.map(one => ({ ...one, reason: traceMessage(one.reason, TRACE_MAX_STRING) })) }),
  })
  const runs = await runsPath($)
  // The figures of each removed run, from its result file before any file goes: the cleared log keeps them.
  const removedEntries = verdict.removable.map(sid => reg.entries.find(one => one.session_id === sid)).filter((one): one is SessionEntry => one !== undefined)
  const figures = new Map<string, RunFigures>()
  for (const entry of removedEntries) {
    const resultText = typeof entry.result_file === 'string' && entry.result_file !== '' ? await $.fs.read(entry.result_file).catch(() => undefined) : undefined
    const found = resultText === undefined ? {} : runFigures(resultText)
    if (Object.keys(found).length > 0) figures.set(String(entry.session_id), found)
  }
  if (verdict.removable.length > 0) {
    const log = `${runs}/cleared.jsonl`
    // The removed entries are logged before the registry is written; a second attempt logs only what is new.
    const logged = new Set<string>()
    const failed = await editRegistry($, async text => {
      const edited = removeEntries(text, verdict.removable)
      if (!edited.ok) return edited
      const lines = withRunFigures(annotateCleared(edited.removed, reviews), figures).split('\n').filter(line => line !== '' && !logged.has(line))
      if (lines.length > 0) {
        const problem = await appendLog($, log, lines)
        if (problem !== undefined) return { ok: false, error: `${problem}; nothing removed` }
        for (const line of lines) logged.add(line)
      }
      return edited
    })
    if (failed !== undefined) return { deny: `${PLUGIN}: ${writeFailed(failed)}` }
    await refresh($)
  }
  const removed = shortIds(verdict.removable)
  const refused = verdict.refused.length === 0 ? '' : ` Refused: ${verdict.refused.map(one => `${one.id.slice(0, 8)} (${one.reason})`).join('; ')}.`
  const review = reviews.length === 0 ? '' : ` Retired with review: ${reviews.map(one => `${one.session_id.slice(0, 8)} (was ${one.was}: ${one.reason})`).join('; ')}.`
  const cleanup = removedEntries.length === 0 ? '' : await cleanRunFiles($, removedEntries, reviews.map(one => one.session_id), runs)
  return { result: `Retired: ${removed}.${review}${refused}${cleanup}` }
}

/**
 * Deletes the run files of retired sessions whose outcome was clean or whose retire was reviewed: result, error and
 * pid files and the prompt file the mod wrote, inside the runs directory and named by no other registry entry
 * (runFilesToDelete); never a transcript. Answers the sentence the retire's answer ends with ('' when nothing was there
 * to delete). Nothing here refuses: a file that will not go is named.
 */
async function cleanRunFiles($: EngineInterface, removed: readonly SessionEntry[], reviewedSids: readonly string[], runs: string): Promise<string> {
  const eligible = removed.filter(entry => (entry.outcome as { kind?: unknown } | undefined)?.kind === 'clean' || reviewedSids.includes(String(entry.session_id)))
  if (eligible.length === 0) return ''
  const machine = await hostOf($)
  const isWindows = machine.platform === 'windows'
  const remaining = parseRegistry(await readRegistryText($))
  const left = remaining.ok ? remaining.entries : []
  const deleted: string[] = []
  const kept: string[] = []
  for (const entry of eligible) {
    const others = [...left, ...removed.filter(one => one !== entry)]
    const names: string[] = []
    const stuck: string[] = []
    for (const file of runFilesToDelete(entry, others, runs, (path, dir) => isUnder(path, dir, isWindows))) {
      if (!(await $.fs.exists(file.path).catch(() => false))) continue
      const isGone = await machine.removeFile(portOf($), file.path).catch(() => false)
      const name = file.path.slice(Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\')) + 1)
      if (isGone && !(await $.fs.exists(file.path).catch(() => false))) names.push(name)
      else stuck.push(name)
    }
    const sid = String(entry.session_id).slice(0, 8)
    if (names.length > 0) deleted.push(`${sid} (${names.join(', ')})`)
    if (stuck.length > 0) kept.push(`${sid} (${stuck.join(', ')})`)
  }
  if (deleted.length + kept.length > 0) trace($, 'retire.cleanup', { deleted: deleted.length, failed: kept.length })
  const gone = deleted.length === 0 ? '' : ` Run files deleted from ${runs}: ${deleted.join('; ')}.`
  const notGone = kept.length === 0 ? '' : ` Run files that could not be deleted: ${kept.join('; ')}.`
  return `${gone}${notGone}`
}

/** close_worker: acknowledge_workers, then (keep false) retire_workers, each as it answers on its own. */
async function close($: EngineInterface, ids: readonly string[], keep: boolean, reviewed: Readonly<Record<string, unknown>>, isReviewedGiven: boolean) {
  const acked = await acknowledge($, ids, keep)
  if ('deny' in acked) return acked
  if (keep) return { result: `${acked.result}${isReviewedGiven ? ' reviewed was not used: keep true retires nothing.' : ''}` }
  const retired = await retire($, ids, reviewed)
  if ('deny' in retired) return { deny: `${acked.result} ${String(retired.deny)}` }
  return { result: `${acked.result} ${retired.result}` }
}

/**
 * archive_decisions: whole sections of agreed-decisions.md go to agreed-decisions-archive.md (appended, under a dated
 * header line), one summary line each stays (archiveDecisions). The decisions file is backed up first; the archive is
 * written before the decisions file, each through writeAtomic against the text read.
 */
async function archiveSections($: EngineInterface, sections: unknown) {
  const headings = Array.isArray(sections) ? sections.filter((one): one is string => typeof one === 'string') : []
  if (headings.length === 0) return { deny: `${PLUGIN}: sections must name at least one section` }
  const file = 'agreed-decisions.md'
  const path = orchPath(file)
  const archivePath = orchPath(DECISIONS_ARCHIVE)
  const parsed = parseRegistry(await readRegistryText($))
  if (!parsed.ok) return { deny: `${PLUGIN}: ${parsed.error}: the running sessions cannot be told; nothing archived` }
  const facts = await probe($, parsed.entries)
  const running = parsed.entries.filter(entry => rowStatus(entry, facts) === 'alive')
  const [queueText, pointsText] = await Promise.all([$.fs.read(orchPath('task-queue.json')).catch(() => undefined), $.fs.read(orchPath('open-points.json')).catch(() => undefined)])
  const today = localDate(await $.clock.now())
  let appended: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text === undefined) return { deny: `${PLUGIN}: ${file} cannot be read` }
    const edited = archiveDecisions(text, headings, { queueText, pointsText, running }, today)
    if (!edited.ok) {
      trace($, 'guard', { tool: 'archive_decisions', isOk: false, ...messageFields(edited.error, 'reason') })
      return { deny: `${PLUGIN}: ${edited.error}` }
    }
    await backupOnce($, file, 'archive-decisions', today, text)
    // The archive first: a failure after it leaves the sections in both files, a failure before it loses none. A
    // second attempt does not append the same block again.
    if (appended !== edited.archive) {
      const old = await $.fs.read(archivePath).catch(() => undefined)
      if (old === undefined && (await $.fs.exists(archivePath).catch(() => true))) return { deny: `${PLUGIN}: ${DECISIONS_ARCHIVE} cannot be read; nothing written` }
      const head = old ?? freshText(DECISIONS_ARCHIVE) ?? ''
      const next = `${head}${head === '' || head.endsWith('\n') ? '' : '\n'}${edited.archive}`
      if (!(await writeAtomic($, archivePath, next, old))) return { deny: `${PLUGIN}: ${DECISIONS_ARCHIVE} changed while it was being written; nothing written, try again` }
      appended = edited.archive
    }
    if (await writeAtomic($, path, edited.text, text)) {
      trace($, 'guard', { tool: 'archive_decisions', isOk: true, sections: edited.archived.length })
      const lines = edited.archived.map(one => edited.text.split('\n').find(line => line.startsWith(`- ${one.heading} (`)) ?? one.heading)
      return { result: `${file}: ${edited.note}; the summary lines under "## ${ARCHIVED_HEADING}": ${lines.join(' | ')}. Backup: backups/${backupName(file, 'archive-decisions', today)} (once per day).` }
    }
  }
  return { deny: `${PLUGIN}: ${file} changed while it was being edited; ${DECISIONS_ARCHIVE} holds the sections, ${file} still does too: try again` }
}

async function launch($: EngineInterface, given: LaunchArgs) {
  const machine = await hostOf($)
  // The launch's paths in the form the host stores, from here on and in the registry (on Windows C:/..., never /c/...).
  const args = machine.launchArgs(given)
  const home = await homeDir($)
  // A path the launch route cannot pass on is refused before anything runs (the PowerShell route's wildcard paths).
  const routeRefusal = machine.launchRefusal(args, machine.nativePath(expandHome(config.runsDir, home)))
  if (routeRefusal !== undefined) {
    trace($, 'guard', { tool: 'launch_worker', isOk: false, ...messageFields(routeRefusal, 'reason') })
    return { deny: `${PLUGIN}: ${routeRefusal}` }
  }
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const { promptFileOk, dirOk } = await machine.launchChecks(portOf($), args)
  const promptText = await $.fs.read(args.prompt_file).catch(() => undefined)
  const resumeSid = typeof args.resume_sid === 'string' ? args.resume_sid : undefined
  // Without a picker command a fresh launch inherits the machine's default configuration: the orchestrator's own
  // CLAUDE_CONFIG_DIR when it has one, else <home>/.claude, which is what the registry records.
  const picker = config.licencePickCommand.trim()
  const own = await ownConfigDir($)
  const defaultDir = machine.defaultConfigDir(home, own)
  let pick: { exitCode: number; stdout: string; stderr?: string } | undefined
  if (resumeSid === undefined && picker === '') pick = { exitCode: 0, stdout: defaultDir }
  else if (resumeSid === undefined) {
    const picked = machine.pickerArgv(pickArgv(picker, args.need ?? 40, home))
    if ('refusal' in picked) {
      trace($, 'guard', { tool: 'launch_worker', isOk: false, ...messageFields(picked.refusal, 'reason') })
      return { deny: `${PLUGIN}: ${picked.refusal}` }
    }
    pick = await run($, picked.argv, { timeoutMs: 20_000 }, false, shownPicker(picked.argv))
  }
  const verdict = checkLaunch(args, {
    home,
    orchestratorDir: config.orchestratorDir,
    entries: reg.entries,
    facts: reg.facts,
    pick,
    transcriptExists: resumeSid === undefined ? undefined : reg.facts.transcriptMtime.has(resumeSid),
    promptFileOk,
    dirOk,
    missingItems: promptText === undefined ? undefined : missingPromptItems(promptText),
    ...machine.launchFacts(promptText),
  })
  trace($, 'guard', verdict.ok ? { tool: 'launch_worker', isOk: true, configDir: verdict.configDir, resumeSid: verdict.resumeSid } : { tool: 'launch_worker', isOk: false, ...messageFields(verdict.reason, 'reason') })
  if (!verdict.ok) return { deny: `${PLUGIN}: ${verdict.reason}` }
  // No CLAUDE_CONFIG_DIR on the line: a fresh launch without a picker, or a resume under the default directory.
  const isConfigInherited = picker === '' && (verdict.resumeSid === undefined || machine.isDefaultConfigDir(verdict.configDir, defaultDir))
  return spawnWorker($, args, { ...verdict, isConfigInherited }, reg.entries, reg.facts, own)
}

/** Start the worker as a background task of the host's launch tool, find its real pid and session, register it. */
async function spawnWorker(
  $: EngineInterface,
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string; isConfigInherited?: boolean },
  entries: readonly SessionEntry[],
  before: ProcFacts,
  own: string | undefined,
) {
  const machine = await hostOf($)
  const port = portOf($)
  const runsDir = await runsPath($)
  // The launch's redirections need the runs directory.
  await machine.prepareRunsDir(port, runsDir)
  const nowMs = await $.clock.now()
  const stamp = new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const base = `${runsDir}/${stamp}-${slugify(args.title)}`
  const files = { result: `${base}.json`, err: `${base}.err` }
  const name = launchName(args.title, nowMs, entries, verdict.resumeSid, issuedNames)
  issuedNames.add(name)
  const command = machine.launchCommand(args, { ...verdict, name }, files.result, files.err)
  const known = new Set(before.claude.map(one => one.pid))
  const launchedAt = await $.clock.now()
  trace($, 'worker.start', { configDir: verdict.configDir, isConfigDirSet: verdict.isConfigInherited !== true, resultFile: files.result, errFile: files.err, timeoutMs: launchTimeoutMs(args) })
  // The engine's own background task: its exit notification reaches the session.
  try {
    await $.tool.call({
      // The PowerShell tool takes the Bash tool's input; a build's tool table lists only the tools it registers on its
      // own machine (no PowerShell on Linux), so the name is typed as Bash's.
      tool: machine.launchTool as 'Bash',
      command,
      description: `session-control worker: ${args.title}`.slice(0, 100),
      run_in_background: true,
      timeout: launchTimeoutMs(args),
    })
  } catch (err) {
    const hint = machine.launchToolHint
    trace($, 'error', { where: 'worker.start', ...messageFields(errorText(err)) })
    return { deny: `${PLUGIN}: the worker could not be started through the ${machine.launchTool} tool (${errorText(err).slice(0, 160)}); nothing was launched.${hint}` }
  }
  let worker: ProcFact | undefined
  for (let attempt = 0; attempt < 15 && worker === undefined; attempt++) {
    await machine.pause(port, 2)
    const facts = await probe($, entries, [verdict.configDir])
    const want = { dir: args.dir, configDir: machine.workerConfigDir(verdict, own), model: args.model }
    worker = await machine.findNewWorker(port, facts, want, known, launchedAt)
  }
  if (worker === undefined) {
    trace($, 'worker.missing', { seconds: 30 })
    return { result: `Started in the background but no claude process appeared within 30 s; check ${files.err}. Not registered.` }
  }
  // The engine writes the session file shortly after the process starts: read it again until it is there. Its name
  // and messaging socket are taken from the same file; an older claude writes no socket, and the entry then has none.
  const sessionPath = `${verdict.configDir}/sessions/${worker.pid}.json`
  let sessionId = verdict.resumeSid ?? ''
  let fromFile: ReturnType<typeof sessionFileFacts> = {}
  for (let attempt = 0; attempt < 10; attempt++) {
    fromFile = sessionFileFacts(await $.fs.read(sessionPath).catch(() => ''))
    if (fromFile.sessionId !== undefined) {
      sessionId = fromFile.sessionId
      break
    }
    if (sessionId !== '') break
    await machine.pause(port, 1)
  }
  // The socket can follow the session id by a moment: a few more reads, then the entry goes without it.
  for (let attempt = 0; attempt < 3 && fromFile.sessionId !== undefined && fromFile.socketPath === undefined; attempt++) {
    await machine.pause(port, 1)
    const again = sessionFileFacts(await $.fs.read(sessionPath).catch(() => ''))
    if (again.sessionId === fromFile.sessionId) fromFile = again
  }
  // The pid file the PowerShell route writes is one more fact beside the probe, never the source of the pid.
  const pidFile = machine.launchPidFile(files.result)
  const filePid = pidFile === undefined ? undefined : pidFromFile(await $.fs.read(pidFile).catch(() => ''))
  const pidFileFact = pidFile === undefined ? {} : { pidFile: filePid === undefined ? 'unread' : filePid === worker.pid ? 'same' : 'differs' }
  trace($, 'worker.found', { pid: worker.pid, sessionId, isNamed: fromFile.name !== undefined, isSocketSeen: fromFile.socketPath !== undefined, ...pidFileFact })
  if (sessionId === '') return { result: `Worker pid ${worker.pid} started but its session id could not be read; registry NOT written.` }
  const inbox = { name: fromFile.name ?? name, ...(fromFile.socketPath === undefined ? {} : { socketPath: fromFile.socketPath }) }
  const entry = newRegistryEntry(args, verdict, worker.pid, sessionId, files, inbox, Math.floor(launchedAt / 1000))
  // A missing registry starts as an empty one, as REGISTER_SCRIPT starts it.
  const failed = await editRegistry($, async text => registerEntry(text, entry, verdict.resumeSid ? 'resume' : 'new'), freshText('headless-sessions.json'))
  const note = failed === undefined ? 'registered' : writeFailed(failed)
  trace($, 'worker.registered', { pid: worker.pid, sessionId, isRegistered: failed === undefined, ...(failed === undefined ? {} : messageFields(failed, 'reason')) })
  await refresh($)
  const pidNote = filePid !== undefined && filePid !== worker.pid ? ` The launch's pid file names pid ${filePid}, not the one the probe found.` : ''
  return {
    result: `Launched pid ${worker.pid}, session ${sessionId}, config_dir ${verdict.configDir}, ${note}. Name: ${inbox.name}; socket: ${inbox.socketPath ?? 'none'}. Result: ${files.result}; errors: ${files.err}.${pidNote}`,
  }
}

// ---------------------------------------------------------------- the read-only inspection tools (inspect.ts)
// They read the registry, the probe, run files, transcripts and directory listings; they write nothing, start no
// process but the probe, the transcript tail and the listing, and answer plain text that inspect.ts redacts and bounds.

/** The registry entry a tool names, with the registry and the probe; or the refusal (an unknown or ambiguous id among them). */
async function sessionAsked($: EngineInterface, id: unknown) {
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const found = matchSession(reg.entries, typeof id === 'string' ? id : '')
  if ('error' in found) return { deny: `${PLUGIN}: ${found.error}` }
  return { ...reg, entry: found.entry }
}

/**
 * A worker's transcript: the whole file when $.fs reads it (under 4 MiB), else its tail (host.tail, in `shape` when
 * given); or why it cannot be read.
 */
async function transcriptText($: EngineInterface, entry: SessionEntry, shape?: TailShape): Promise<{ text: string; isWhole: boolean; path: string } | { missing: string; path?: string }> {
  const machine = await hostOf($)
  const path = machine.transcriptPath(entry)
  if (path === undefined) return { missing: 'the entry lacks the config_dir, cwd or session_id that place it' }
  const whole = await $.fs.read(path).catch(() => undefined)
  if (whole !== undefined) return { text: whole, isWhole: true, path }
  const tail = await machine.tail(portOf($), path, shape)
  return tail === undefined ? { missing: `${path} cannot be read`, path } : { text: tail, isWhole: false, path }
}

/** list_sessions: the panel's rows from a fresh probe, finished ones too unless left out. */
async function listSessions($: EngineInterface, includeFinished: boolean) {
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const nowSec = Math.floor((await $.clock.now()) / 1000)
  return { result: listSessionsText(buildRows(reg.entries, reg.facts, nowSec), reg.entries, reg.facts, nowSec, includeFinished) }
}

/** read_result: the result file, its error file and, for the chatter fallback, the transcript. */
async function readResult($: EngineInterface, id: unknown, maxChars: unknown) {
  const asked = await sessionAsked($, id)
  if ('deny' in asked) return asked
  const { entry, facts } = asked
  const file = typeof entry.result_file === 'string' && entry.result_file !== '' ? entry.result_file : undefined
  const resultText = file === undefined ? undefined : await $.fs.read(file).catch(() => undefined)
  const isThere = file !== undefined && resultText === undefined ? await $.fs.exists(file).catch(() => false) : false
  const resultMissing =
    file === undefined ? 'the entry names no result file' : resultText !== undefined ? undefined : isThere ? 'the result file cannot be read (over the 4 MiB read cap?)' : 'the result file is not there (the run has not ended, or wrote none)'
  const errText = typeof entry.err_file === 'string' && entry.err_file !== '' ? await $.fs.read(entry.err_file).catch(() => '') : ''
  const transcript = await transcriptText($, entry, REPORT_TAIL)
  const chars = typeof maxChars === 'number' && Number.isFinite(maxChars) ? Math.min(READ_RESULT_CHARS.max, Math.max(READ_RESULT_CHARS.min, Math.floor(maxChars))) : READ_RESULT_CHARS.default
  return {
    result: readResultText({
      entry,
      facts,
      ...(resultText === undefined ? {} : { resultText }),
      ...(resultMissing === undefined ? {} : { resultMissing }),
      errText,
      ...('text' in transcript ? { transcript: { text: transcript.text, isWhole: transcript.isWhole } } : { transcriptMissing: transcript.missing }),
      maxChars: chars,
    }),
  }
}

/** worker_tail: the log pane's tail of the transcript, its age and the process. */
async function workerTail($: EngineInterface, id: unknown, lines: unknown) {
  const asked = await sessionAsked($, id)
  if ('deny' in asked) return asked
  const { entry, facts } = asked
  const wanted = typeof lines === 'number' && Number.isFinite(lines) ? Math.min(TAIL_LINES.max, Math.max(1, Math.floor(lines))) : TAIL_LINES.default
  const path = (await hostOf($)).transcriptPath(entry)
  const tail = path === undefined ? undefined : await transcriptTail($, path)
  const nowSec = (await $.clock.now()) / 1000
  const statSec = path === undefined ? undefined : await $.fs.stat(path).then(one => one.mtimeMs / 1000, () => undefined)
  const mtime = facts.transcriptMtime.get(entry.session_id) ?? statSec
  return {
    result: workerTailText({
      entry,
      facts,
      ...(path === undefined ? {} : { path }),
      ...(mtime === undefined ? {} : { ageSec: Math.max(0, nowSec - mtime) }),
      ...(tail === undefined ? {} : { lines: summarizeTranscript(tail, wanted) }),
      wanted,
    }),
  }
}

/** session_writes: the start from the transcript (or the entry), the listing under the cwd (host.filesNewerThan). */
async function sessionWrites($: EngineInterface, id: unknown) {
  const asked = await sessionAsked($, id)
  if ('deny' in asked) return asked
  const { entry } = asked
  if (typeof entry.cwd !== 'string' || entry.cwd === '') return { deny: `${PLUGIN}: the entry of ${entry.session_id} has no cwd to list` }
  const machine = await hostOf($)
  const transcript = await transcriptText($, entry)
  const first = 'text' in transcript && transcript.isWhole ? firstTimestamp(transcript.text) : undefined
  const startedMs = typeof entry.started_at === 'number' ? entry.started_at * 1000 : undefined
  const why = 'text' in transcript ? (transcript.isWhole ? 'the transcript has no timestamp' : 'the transcript is over the read cap, so its first timestamp cannot be read; a resumed session\'s earlier runs are not covered') : transcript.missing
  const start = first !== undefined ? { ms: first, source: "the transcript's first timestamp" } : startedMs !== undefined ? { ms: startedMs, source: `the entry's started_at, because ${why}` } : undefined
  if (start === undefined) return { deny: `${PLUGIN}: no start time for ${entry.session_id}: ${why}, and the entry has no started_at` }
  const listing = await machine.filesNewerThan(portOf($), machine.nativePath(entry.cwd), Math.floor(start.ms / 1000))
  return {
    result: sessionWritesText({
      entry,
      start,
      listing,
      orchestratorDir: config.orchestratorDir,
      registryPath: await registryPath($),
      isWindows: machine.platform === 'windows',
      ...('text' in transcript ? { transcript: { text: transcript.text, isWhole: transcript.isWhole } } : {}),
    }),
  }
}

/** panel_snapshot: the panel's own atoms, as the last poll left them, drawn as text; nothing gathered. */
async function panelSnapshot($: EngineInterface) {
  const [snap, queue, list, sel, view, pointSel, exp] = await Promise.all([read($, snapshot), read($, queued), read($, points), read($, selected), read($, watch), read($, selectedPoint), read($, expanded)])
  const log = sel !== null && view !== null ? { title: view.title, lines: view.lines } : null
  return { result: panelSnapshotText({ snap, queue, points: list, selectedPoint: pointSel, log, expanded: log === null ? exp : null, nowMs: await $.clock.now() }) }
}

/** A directory's entries ($.fs.list), a folder's mtime from $.fs.stat; undefined when it is not there. */
async function listed($: EngineInterface, dir: string): Promise<ListedFile[] | undefined> {
  const entries = await $.fs.list(dir).catch(() => undefined)
  if (entries === undefined) return undefined
  return Promise.all(
    entries.map(async one => ({
      name: one.name,
      kind: one.kind,
      size: one.size,
      mtimeMs: one.kind === 'dir' ? ((await $.fs.stat(`${dir}/${one.name}`).catch(() => undefined))?.mtimeMs ?? 0) : one.mtimeMs,
    })),
  )
}

/**
 * The orchestrator directory's git state, by git run as a process with read commands only (status without optional
 * locks, so the index is not refreshed); undefined when git cannot start or the directory is no repository.
 */
async function gitState($: EngineInterface, dir: string): Promise<GitState | undefined> {
  if (dir === '') return undefined
  const git = (args: readonly string[]) => run($, ['git', '--no-optional-locks', '-C', dir, ...args], { timeoutMs: 10_000 }).catch(() => undefined)
  const inside = await git(['rev-parse', '--is-inside-work-tree'])
  if (inside === undefined || inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return undefined
  const head = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
  const branch = head?.exitCode === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : undefined
  const origin = await git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
  let defaultBranch = origin?.exitCode === 0 && origin.stdout.trim() !== '' ? origin.stdout.trim().replace(/^origin\//, '') : undefined
  for (const name of ['main', 'master']) {
    if (defaultBranch !== undefined) break
    if ((await git(['show-ref', '--verify', '-q', `refs/heads/${name}`]))?.exitCode === 0) defaultBranch = name
  }
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=no'])
  const paths = status?.exitCode === 0 ? porcelainPaths(status.stdout) : []
  const top = await git(['rev-parse', '--show-toplevel'])
  const root = top?.exitCode === 0 && top.stdout.trim() !== '' ? (await hostOf($)).nativePath(top.stdout.trim()) : dir
  const changed = await Promise.all(paths.slice(0, 50).map(async path => ({ path, mtimeMs: (await $.fs.stat(`${root}/${path}`).catch(() => undefined))?.mtimeMs })))
  return { ...(branch === undefined ? {} : { branch }), ...(defaultBranch === undefined ? {} : { defaultBranch }), changed: changed.map(one => (one.mtimeMs === undefined ? { path: one.path } : { path: one.path, mtimeMs: one.mtimeMs })) }
}

/** The paths of `git status --porcelain=v1 -z`: each record `XY path`, a rename's source the record after it. */
function porcelainPaths(stdout: string): string[] {
  const records = stdout.split('\0')
  const paths: string[] = []
  for (let at = 0; at < records.length; at++) {
    const record = records[at] ?? ''
    if (record.length < 4) continue
    paths.push(record.slice(3))
    if (record[0] === 'R' || record[0] === 'C') at++
  }
  return paths
}

/** audit_state: everything the end-of-unit audit reads, read; the findings told; nothing changed. */
async function auditState($: EngineInterface) {
  const parsed = parseRegistry(await readRegistryText($))
  const entries = parsed.ok ? parsed.entries : []
  const facts = await probe($, entries)
  const runs = await runsPath($)
  const text = (path: string) => $.fs.read(path).catch(() => undefined)
  const [queueText, pointsText, decisionsText, clearedText] = await Promise.all([text(orchPath('task-queue.json')), text(orchPath('open-points.json')), text(orchPath('agreed-decisions.md')), text(`${runs}/cleared.jsonl`)])
  const retired = clearedText === undefined ? undefined : new Set([...clearedText.matchAll(/"session_id":\s*"([0-9a-fA-F-]{36})"/g)].map(found => (found[1] ?? '').toLowerCase()))
  const [backups, runFiles, reports] = await Promise.all([listed($, orchPath('backups')), listed($, runs), listed($, orchPath('reports'))])
  const git = await gitState($, config.orchestratorDir)
  return {
    result: auditText({
      entries,
      facts,
      ...(parsed.ok ? {} : { registryError: parsed.error }),
      nowMs: await $.clock.now(),
      ...(queueText === undefined ? {} : { queueText }),
      ...(pointsText === undefined ? {} : { pointsText }),
      ...(decisionsText === undefined ? {} : { decisionsText }),
      ...(retired === undefined ? {} : { retired }),
      ...(backups === undefined ? {} : { backups }),
      ...(runFiles === undefined ? {} : { runs: runFiles }),
      ...(reports === undefined ? {} : { reports }),
      ...(git === undefined ? {} : { git }),
    }),
  }
}

/** Turn the board on: register the launch tool, start the poll once, gather. */
async function activate($: EngineInterface): Promise<void> {
  isActive = true
  startTrace($)
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
        'and one named in the task queue; removed entries are logged first. When the stored outcome (login, limit, killed) ' +
        'is wrong because you read the transcript and the run succeeded, or the work was deliberately abandoned, pass ' +
        '`reviewed`: session id to a non-empty reason; the outcome check is skipped for that session only, and the ' +
        'original outcome and the reason are logged in cleared.jsonl. Not a way past a live, kept, unclassified or queue-named session.',
      inputSchema: RETIRE_SCHEMA as unknown as Record<string, unknown>,
    })
    for (const [name, description, schema] of [
      ['open_point', 'Add, answer, close, hold or release an open point in open-points.json; settled entries older than 7 days rotate into the archive; the file is backed up once per day.', POINT_SCHEMA],
      ['queue_task', 'Add, update or remove a task in task-queue.json; the file is backed up once per day.', QUEUE_SCHEMA],
      ['record_decision', 'Append one numbered line to a unit section of agreed-decisions.md (the section is created when missing); backed up once per day.', DECISION_SCHEMA],
    ] as const) {
      await $.tool.register({ name, description, inputSchema: schema as unknown as Record<string, unknown> })
    }
    // The read-only inspection tools: they change nothing and answer plain text, redacted and bounded.
    for (const [name, description, schema] of [
      [
        'list_sessions',
        'Read-only. Every worker registry row as the panel shows it (title, session id, name, cwd, config dir, model, effort, status, pid, elapsed, outcome, cost) and each live headless claude process no entry claims (orphan: pid, cwd, config dir, age; licence probes left out), after a count line.',
        LIST_SESSIONS_SCHEMA,
      ],
      [
        'read_result',
        "Read-only. A worker's final report: its result file's .result, or, when that is chatter or missing, the last substantial assistant message of its transcript; with the source used, the outcome, cost, duration, turns, is_error and subtype. Redacted as the debug trace is (the count said); the head kept up to max_chars, the cut said.",
        READ_RESULT_SCHEMA,
      ],
      [
        'worker_tail',
        "Read-only. The last lines of a worker's transcript, summarised as the panel's log shows them, with the seconds since the transcript was last written and whether its process is alive.",
        WORKER_TAIL_SCHEMA,
      ],
      [
        'session_writes',
        "Read-only. The files a session wrote under its cwd since its transcript's first timestamp (by mtime, .git left out, newest first, at most 200 with the true count), each one under the orchestrator directory or the registry flagged, and the transcript's own writes to either.",
        SESSION_WRITES_SCHEMA,
      ],
      ['panel_snapshot', 'Read-only. The text the side panel shows now: the sessions rows, the queued work and the open points (and the log, when one is open), as plain text.', PANEL_SNAPSHOT_SCHEMA],
      [
        'audit_state',
        'Read-only. The end-of-unit audit of the helper files as findings (kind, subject, evidence, suggested action), the most important first: queue statuses, running tasks with no live session, queued tasks waiting on a finished session, done tasks, sessions to retire or acknowledge, old kept sessions, held or old open points, spent backups, run files and reports, stale decision sections, and the orchestrator directory\'s git state. Changes nothing.',
        AUDIT_SCHEMA,
      ],
    ] as const) {
      await $.tool.register({ name, description, inputSchema: schema as unknown as Record<string, unknown> })
    }
    // The write-side tools after them: the registry and the decisions file, each through the code of the tools above.
    for (const [name, description, schema] of [
      [
        'close_worker',
        'Acknowledge and retire finished workers in one call: exactly acknowledge_workers, then retire_workers, with their refusals and their answers one after the other (reviewed as retire_workers takes it). keep=true only acknowledges and keeps (a resume or follow-up is expected); nothing is retired. A retire of a clean or reviewed session deletes its result, error, pid and mod-written prompt files in the runs directory, its cost and duration kept in cleared.jsonl.',
        CLOSE_SCHEMA,
      ],
      [
        'archive_decisions',
        'Move whole sections of agreed-decisions.md into agreed-decisions-archive.md (created when missing; appended, the text byte for byte under a dated header line) and leave one summary line each (heading, id range, date, archived) under "## Archived sections". Refuses a Standing section, an unknown heading and a section that a queue task not done, a running session or an open point still names (by its heading, a decision id or a branch or T-number of its heading), saying which; then nothing is archived. The file is backed up first.',
        ARCHIVE_SCHEMA,
      ],
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

/** session.start: register the command; in the orchestrator directory turn the board on. */
async function startSession($: EngineInterface, sessionCwd: string): Promise<void> {
  // /session-control is registered everywhere; the board starts by itself only in the orchestrator dir.
  await $.command.register({
    name: 'session-control',
    description: 'Session-control panel: open or close the side panel (sessions, queued work, open points)',
  })
  // Without the option, the orchestrator directory is the one whose CLAUDE.md is the orchestrator's.
  // Both are taken in the host's path form and compared as the host compares paths.
  const machine = await hostOf($)
  const cwd = machine.sessionDir(sessionCwd)
  if (config.orchestratorDir === '' && (await $.fs.read(`${cwd}/CLAUDE.md`).catch(() => '')).startsWith(ORCHESTRATOR_HEADING)) {
    config.orchestratorDir = cwd
  }
  if (config.orchestratorDir !== '') config.orchestratorDir = machine.nativePath(config.orchestratorDir)
  const isHere = machine.isSameDir(cwd, config.orchestratorDir)
  if (isTraceWanted) {
    // The picker command is a command line of its own: the trace says only whether one is set.
    const { pollMs, registrySetting, licencePickCommand, ...rest } = config
    const options = { ...rest, registryPath: registrySetting, pollSeconds: pollMs / 1000, licencePickCommand: licencePickCommand.trim() === '' ? 'empty' : 'set' }
    traceStart = { cwd, platform: machine.platform, isOrchestratorDir: config.orchestratorDir !== '' && isHere, options }
  }
  if (config.orchestratorDir !== '' && isHere) await activate($)
}

/** /session-control: refused outside an orchestrator directory; else the board on and the panel shown or hidden. */
async function togglePanel($: EngineInterface): Promise<{ text: string }> {
  if (config.orchestratorDir === '') {
    return { text: `session-control: this directory is not an orchestrator directory (its CLAUDE.md does not start with "${ORCHESTRATOR_HEADING}") and no orchestratorDir option is set.` }
  }
  startTrace($)
  trace($, 'command.run', { command: 'session-control' })
  await activate($)
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })
    stopDisplayTick()
    await update($, selected, () => null)
    await update($, expanded, () => null)
    trace($, 'panel', { isShown: false })
    return { text: 'Session-control panel hidden, session-control stays on.' }
  }
  await refresh($)
  // Each panel starts with no section expanded, also after the engine's close mark closed the last one.
  await update($, expanded, () => null)
  const opened = await $.ui.open({ id: PANE, title: 'Session control' })
  const shownSec = Math.floor((await $.clock.now()) / 1000)
  await update($, now, () => shownSec)
  await armDisplayTick($)
  trace($, 'panel', { isShown: true, isPlaced: opened.isPlaced })
  return { text: opened.isPlaced ? 'Session-control panel opened.' : `Session-control panel waits: ${opened.reason}` }
}

/**
 * A tool hook's work: the call's line with the named fields of its input, the work, the answer's line (the refusal or
 * the mod's own result text, as traceMessage keeps them; with `isResultText` only its length: an inspection tool's
 * answer quotes files and transcripts, which the trace never holds), then the lines written.
 */
async function tracedTool<T extends object>($: EngineInterface, tool: string, e: unknown, fields: readonly string[], work: () => Promise<T>, isResultText = false): Promise<T> {
  if (isTracing) trace($, 'tool.call', { tool, ...pickFields(e, fields) })
  return traced($, async () => {
    const answer = await work()
    if (isTracing) {
      const shown = (result: string) => (isResultText ? { resultChars: result.length } : { result: traceMessage(result, TRACE_MAX_STRING) })
      const text = 'deny' in answer ? messageFields(String(answer.deny), 'deny') : 'result' in answer ? shown(String(answer.result)) : {}
      trace($, 'tool.result', { tool, ...text })
    }
    return answer
  })
}

/** The orchestrator's own CLAUDE_CONFIG_DIR, which a worker launched without one inherits; undefined when unset or unreadable. */
async function ownConfigDir($: EngineInterface): Promise<string | undefined> {
  try {
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    return dir === '' ? undefined : dir
  } catch {
    return undefined
  }
}

/** SESSION_CONTROL_DEBUG, or undefined when the environment cannot be read. */
async function debugSwitch($: EngineInterface): Promise<string | undefined> {
  try {
    return await $.env.get('SESSION_CONTROL_DEBUG')
  } catch {
    return undefined
  }
}

/** The fields of a tool call the trace shows: the named ones that are set, never free text. */
function pickFields(e: unknown, names: readonly string[]): Record<string, unknown> {
  const input = plain(e)
  return Object.fromEntries(names.filter(name => input[name] !== undefined).map(name => [name, input[name]]))
}

export const register: Register = (on, options) => {
  isDirectWriteNoted = false
  isHelperFallbackNoted = false
  quietFallbacksTraced.clear()
  host = undefined
  config = {
    orchestratorDir: String(options.orchestratorDir ?? ''),
    registrySetting: String(options.registryPath ?? config.registrySetting),
    completionWrites: options.completionWrites === true,
    pollMs: Math.max(1, Number(options.pollSeconds ?? 5)) * 1000,
    runsDir: String(options.runsDir ?? config.runsDir),
    licencePickCommand: String(options.licencePickCommand ?? ''),
    debug: options.debug === true,
    helper: options.helper === 'off' ? 'off' : 'auto',
    nodePath: String(options.nodePath ?? ''),
    launchRoute: options.launchRoute === 'powershell' ? 'powershell' : 'bash',
  }
  isTraceWanted = config.debug
  isTracing = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The trace is wanted from the launch, by the debug option or by the environment (an environment that cannot be
    // read leaves it off); it is written once the board is on.
    if (!config.debug && isTraceSwitch(await debugSwitch($))) isTraceWanted = true
    await traced($, () => startSession($, e.cwd))
    return started
  })

  // /session-control shows or hides the panel. Either way the board is on (activate is idempotent): hiding the panel
  // stops no tracking, the report check or the poll.
  on('command.run', { command: 'session-control' }, async ($) => traced($, () => togglePanel($)))

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
    trace($, 'prompt.submit', { origin: e.origin.kind })
    if (!isActive) {
      await flushTrace($)
      return next(e)
    }
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
    await flushTrace($)
    if (extra.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  // Report check, for my own use: a report that breaks the rules is sent back
  // once (stop_hook_active stops a second block) so the model corrects it.
  on('classic.Stop', async ($, e, next) => {
    const done = await next(e)
    const answer = e.last_assistant_message ?? ''
    trace($, 'classic.Stop', { isChecked: isActive && !e.stop_hook_active && answer !== '' })
    if (!isActive || e.stop_hook_active || answer === '') {
      await flushTrace($)
      return done
    }
    const findings = lintReport(answer, { unackedPeers: unackedPeers(await read($, ledger)) })
    if (findings.length > 0) trace($, 'guard', { check: 'report', isOk: false, findings })
    await flushTrace($)
    if (findings.length === 0) return done
    return { ...done, block: `Report check failed: ${findings.join('; ')}. Resend the corrected report; say nothing about this check.` }
  })

  on('tool.call', { tool: POINT_TOOL }, ($, e) =>
    tracedTool($, 'open_point', e, ['action', 'id'], () => editHelper($, 'open-points.json', 'open-point', (text, today) => editOpenPoints(text, plain(e), today))),
  ).catch(($, e, next) => {
    traceError($, 'open_point', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: open_point failed` }
  })

  on('tool.call', { tool: QUEUE_TOOL }, ($, e) =>
    tracedTool($, 'queue_task', e, ['action', 'id', 'status'], () => editHelper($, 'task-queue.json', 'queue-task', text => editQueue(text, plain(e)))),
  ).catch(($, e, next) => {
    traceError($, 'queue_task', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: queue_task failed` }
  })

  on('tool.call', { tool: DECISION_TOOL }, ($, e) =>
    tracedTool($, 'record_decision', e, ['section', 'id'], () => editHelper($, 'agreed-decisions.md', 'record-decision', text => appendDecision(text, plain(e)))),
  ).catch(($, e, next) => {
    traceError($, 'record_decision', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: record_decision failed` }
  })

  on('tool.call', { tool: ACK_TOOL }, ($, e) => {
    const input = e as unknown as { session_ids?: unknown; keep?: unknown }
    return tracedTool($, 'acknowledge_workers', e, ['session_ids', 'keep'], () => acknowledge($, (input.session_ids as string[] | undefined) ?? [], input.keep === true))
  }).catch(($, e, next) => {
    traceError($, 'acknowledge_workers', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: acknowledge_workers failed` }
  })

  on('tool.call', { tool: RETIRE_TOOL }, ($, e) => {
    const input = e as unknown as { session_ids?: unknown; reviewed?: unknown }
    const reviewed = typeof input.reviewed === 'object' && input.reviewed !== null && !Array.isArray(input.reviewed) ? (input.reviewed as Record<string, unknown>) : {}
    return tracedTool($, 'retire_workers', e, ['session_ids'], () => retire($, (input.session_ids as string[] | undefined) ?? [], reviewed))
  }).catch(($, e, next) => {
    traceError($, 'retire_workers', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: retire_workers failed` }
  })

  on('tool.call', { tool: CLOSE_TOOL }, ($, e) => {
    const input = e as unknown as { session_ids?: unknown; keep?: unknown; reviewed?: unknown }
    const isReviewedGiven = typeof input.reviewed === 'object' && input.reviewed !== null && !Array.isArray(input.reviewed)
    const reviewed = isReviewedGiven ? (input.reviewed as Record<string, unknown>) : {}
    return tracedTool($, 'close_worker', e, ['session_ids', 'keep'], () => close($, (input.session_ids as string[] | undefined) ?? [], input.keep === true, reviewed, isReviewedGiven))
  }).catch(($, e, next) => {
    traceError($, 'close_worker', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: close_worker failed` }
  })

  // The section headings are the orchestrator's own free text: the trace keeps no call field and the answer's length only.
  on('tool.call', { tool: ARCHIVE_TOOL }, ($, e) => tracedTool($, 'archive_decisions', e, [], () => archiveSections($, plain(e).sections), true)).catch(($, e, next) => {
    traceError($, 'archive_decisions', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: archive_decisions failed` }
  })

  // The inspection tools: read-only; their answers reach the trace as a length only.
  on('tool.call', { tool: LIST_TOOL }, ($, e) => tracedTool($, 'list_sessions', e, ['include_finished'], () => listSessions($, plain(e).include_finished !== false), true)).catch(($, e, next) => {
    traceError($, 'list_sessions', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: list_sessions failed` }
  })

  on('tool.call', { tool: RESULT_TOOL }, ($, e) => tracedTool($, 'read_result', e, ['session_id', 'max_chars'], () => readResult($, plain(e).session_id, plain(e).max_chars), true)).catch(($, e, next) => {
    traceError($, 'read_result', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: read_result failed` }
  })

  on('tool.call', { tool: TAIL_TOOL }, ($, e) => tracedTool($, 'worker_tail', e, ['session_id', 'lines'], () => workerTail($, plain(e).session_id, plain(e).lines), true)).catch(($, e, next) => {
    traceError($, 'worker_tail', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: worker_tail failed` }
  })

  on('tool.call', { tool: WRITES_TOOL }, ($, e) => tracedTool($, 'session_writes', e, ['session_id'], () => sessionWrites($, plain(e).session_id), true)).catch(($, e, next) => {
    traceError($, 'session_writes', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: session_writes failed` }
  })

  on('tool.call', { tool: SNAPSHOT_TOOL }, ($, e) => tracedTool($, 'panel_snapshot', e, [], () => panelSnapshot($), true)).catch(($, e, next) => {
    traceError($, 'panel_snapshot', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: panel_snapshot failed` }
  })

  on('tool.call', { tool: AUDIT_TOOL }, ($, e) => tracedTool($, 'audit_state', e, [], () => auditState($), true)).catch(($, e, next) => {
    traceError($, 'audit_state', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: audit_state failed` }
  })

  // The launch's fields are paths, names and numbers; the title is free text and stays out (its slug is in the run's
  // file names); the prompt is in its file, which the trace never reads.
  const LAUNCH_FIELDS = ['dir', 'prompt_file', 'model', 'effort', 'need', 'resume_sid', 'timeout_minutes'] as const
  on('tool.call', { tool: TOOL }, ($, e) => tracedTool($, 'launch_worker', e, LAUNCH_FIELDS, () => launch($, e as unknown as LaunchArgs))).catch(($, e, next) => {
    traceError($, 'launch_worker', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: launch_worker guard failed` }
  })

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
    if (isTracing) traceRenders++
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const columns = e.props.bodyColumns
    if (snap === null) return <Text dimColor>session-control is idle here (not the orchestrator dir).</Text>
    const [view, sel, queue, list, back, pointSel, offs, activeTab, expandedState, nowSec] = await Promise.all([
      read($, watch),
      read($, selected),
      read($, queued),
      read($, points),
      read($, boxBack),
      read($, selectedPoint),
      read($, offsets),
      read($, tab),
      read($, expanded),
      read($, now),
    ])
    const width = Math.max(20, columns - 4)
    const isLogOpen = sel !== null && view !== null
    // Docked, a section expanded by its header icon takes the body, the other two kept as one-line headers; an open log wins over it.
    const expandedId: ExpandableId | null = isLogOpen ? null : expandedState
    // Docked: three boxes, never below three content rows each. Seated low (inline): one box at a time behind a tab
    // strip, at most 11 rows, so the panel can never push the chat input off the screen.
    const isCompact = e.props.placement === 'inline'
    // Never more than the room the engine offers: forcing a minimum pushed the status line and the mode off the screen.
    const compactRows = Math.max(3, Math.min(7, e.props.scroll.bodyRows))
    const activeId: SectionId = isLogOpen ? 'log' : (activeTab as SectionId)
    const bodyRows = isCompact ? compactRows : Math.max(MIN_SESSIONS_BOX + 2 * MIN_BOX, e.props.scroll.bodyRows)
    const boxes: SectionBox[] = isCompact ? [{ id: activeId, top: 1, height: compactRows - 1 }] : sectionBoxes(bodyRows, isLogOpen, expandedId)
    layout = { boxes, totals: {} }
    type PRow = { text: string; key?: string; group?: string; press?: () => unknown; dim?: boolean; bold?: boolean; color?: 'warning' }
    // The elapsed column at the display clock: the tick's time, never before the probe the rows come from.
    const probedSec = Math.floor(snap.at / 1000)
    const clock = { nowSec: Math.max(nowSec, probedSec), probedSec }
    const widths = paneWidths(snap.rows, width - 2, clock)
    const toggle = (sid: string) => async () => {
      await update($, expanded, () => null)
      await update($, selected, current => (current === sid ? null : sid))
      await update($, boxBack, () => 0)
      await refreshWatch($)
    }
    // The header icon: expands its section, or collapses it back to the three boxes; it closes an open log.
    const expand = (id: ExpandableId) => async () => {
      await update($, selected, () => null)
      await update($, expanded, current => (current === id ? null : id))
    }
    const togglePoint = (id: string) => () => update($, selectedPoint, current => (current === id ? null : id))
    // A pressable row's label is padded to `fill`, its column's width: the Button is as wide as its label, so the
    // pointer's light spans the row and not only its text.
    const rowEl = (r: PRow, fill = 0, scope?: string) =>
      r.press === undefined ? (
        <Text bold={r.bold} dimColor={r.dim} color={r.color}>
          {r.text}
        </Text>
      ) : (
        <Button
          key={r.key}
          label={(r.text === '' ? ' ' : r.text).padEnd(fill)}
          plain
          dimColor={r.dim}
          hover={scope === undefined ? undefined : { scope, inverse: true }}
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
      const shown = body.slice(from, from + visible)
      // The rows' column: the box's inner width less the scroll bar (no border in the compact panel).
      const fill = Math.max(1, columns - (isPlain ? 1 : 3))
      // A pressable row and its scroll-bar cell share a hover scope (a block's own when it has one), so the light
      // reaches the box's right edge as it starts at its left one; the cell lit at full strength, as the row is.
      const scopes = shown.map((r, i) => (r.press === undefined ? undefined : (r.group ?? `${id}:${from + i}`)))
      const rows = (
        <Box flexDirection="row" height={visible}>
          <Box flexDirection="column" flexGrow={1}>
            {shown.map((r, i) => rowEl(r, fill, scopes[i]))}
          </Box>
          <Box flexDirection="column" width={1}>
            {bar.map((ch, i) => (
              <Text dimColor hover={scopes[i] === undefined ? undefined : { scope: scopes[i], inverse: true, dimColor: false }}>
                {ch}
              </Text>
            ))}
          </Box>
        </Box>
      )
      // Compact (inline) panel: no border and no title, the tab strip names the box; every row counts.
      if (isPlain) {
        return (
          <Box flexDirection="column" height={box.height} overflow="hidden">
            {fixed.map(r => rowEl(r))}
            {rows}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" height={box.height} overflow="hidden" borderStyle="round" borderDimColor>
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Text bold>{title}</Text>
            </Box>
            {id !== 'log' && <Button key={`x:${id}`} label={expandedId === id ? '[-]' : '[+]'} plain dimColor onPress={expand(id)} />}
          </Box>
          {fixed.map(r => rowEl(r))}
          {rows}
        </Box>
      )
    }
    const sessionRows: PRow[] = snap.rows.length === 0 ? [{ text: 'No workers in the registry.', dim: true }] : snap.rows.map(row => {
      const sid = row.sid
      const text = (sid !== undefined && sid === sel ? '\u25B8 ' : '  ') + formatRow(row, width - 2, widths, clock)
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
    const sections: Record<ExpandableId, () => ReturnType<typeof block>> = {
      sessions: () => sessionsBlock(),
      queue: () => block('queue', 'QUEUED WORK', [], queueRows, offs.queue),
      points: () => block('points', 'OPEN POINTS', [], pointRows, offs.points),
    }
    const titles: Record<ExpandableId, string> = { sessions: 'SESSIONS', queue: 'QUEUED WORK', points: 'OPEN POINTS' }
    // A collapsed section while another is expanded: one row, its title and its icon in the columns the box draws them.
    const header = (id: ExpandableId) => (
      <Box key={`h:${id}`} flexDirection="row" height={1} paddingX={1}>
        <Box flexGrow={1}>
          <Text bold>{titles[id]}</Text>
        </Box>
        <Button key={`x:${id}`} label="[+]" plain dimColor onPress={expand(id)} />
      </Box>
    )
    return (
      <Box flexDirection="column" height={bodyRows} overflow="hidden">
        {boxes.map(one => (one.isHeader === true ? header(one.id as ExpandableId) : sections[one.id as ExpandableId]()))}
      </Box>
    )
  })
}
