import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register } from 'claude-code'

import type { SessionEntry, SessionOutcome } from '../types'
import { ARCHIVE_SCHEMA, ARCHIVED_HEADING, DECISIONS_ARCHIVE, DECISION_SCHEMA, POINT_SCHEMA, QUEUE_SCHEMA, appendDecision, archiveDecisions, editOpenPoints, editQueue, findDecisionSection } from './bookkeeping'
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
import type { Host, HostEnvName, HostPort, RemoveOutcome, TailShape } from './host'
import { HELPER_SCRIPT, fallbackFields, fallbackToast, withHelper } from './host-helper'
import type { HelperNote } from './host-helper'
import { withPowerShellLaunch } from './host-powershell'
import { AUDIT_SCHEMA, auditText, retiredIds } from './audit'
import {
  ORPHANS_SHOWN,
  TOASTS_PER_PASS,
  driftStep,
  harvestNotices,
  isRegistrySound,
  isRepoDue,
  isRetireDue,
  lockStep,
  markOrphan,
  moreToastText,
  noticeKeyDir,
  noticeLine,
  noticeStoreKey,
  openPointCount,
  orphanGroupNotice,
  orphanNotice,
  orphanStep,
  parseNoticeState,
  pendingWith,
  pointStep,
  pruneFreeWaits,
  pruneHarvested,
  queueTasks,
  registryStep,
  repoStep,
  retireStep,
  secretNotice,
  stallStep,
  unitStep,
} from './notices'
import type { LockSeen, Notice, NoticeState, RegistryWatch } from './notices'
import { DRIFT_EVERY_SEC, DRIFT_SPEC, changedFiles, driftBandText, driftEverySec, driftNoticeMessage, sourceModDir } from './drift'
import { HOLDER_FILES, LOCK_EVERY_SEC, holderState, lockCandidates, lockDirsOf, lockFingerprint, lockHolder } from './locks'
import { DIGEST_SCHEMA, digestKeyDir, digestStoreKey, digestText, lastCallOf, withEvent } from './digest'
import type { DigestEvent } from './digest'
import { STOP_SCHEMA, abortCheck, stopProofText } from './stop'
import { signoffDenyText, signoffVerdict } from './guard'
import { findSecrets, secretScanLine, tallyFromAnswer, tallyOf } from './secrets'
import { promptLint, signoffLint } from './lint'
import type { SecretTally } from './secrets'
import type { StopReport } from './host'
import type { GitState, ListedFile } from './audit'
import {
  LIST_SESSIONS_SCHEMA,
  PANEL_SNAPSHOT_SCHEMA,
  READ_RESULT_CHARS,
  READ_RESULT_SCHEMA,
  SESSION_WRITES_SCHEMA,
  TAIL_LINES,
  WORKER_TAIL_SCHEMA,
  clean,
  firstTimestamp,
  isUnder,
  listSessionsText,
  matchSession,
  panelSnapshotText,
  plainText,
  readResultText,
  sessionWritesText,
  workerTailText,
} from './inspect'
import {
  LAUNCH_SCHEMA,
  ACK_SCHEMA,
  CLOSE_SCHEMA,
  RETIRE_SCHEMA,
  composePrompt,
  fillFromEntry,
  filledFields,
  launchArgsOf,
  planRunFiles,
  promptSourceRefusal,
  rulesWanted,
  runFigures,
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
  isWinAbsolute,
} from './core'
import {
  LIST_LICENCES_SCHEMA,
  PROBE_USAGE_SCHEMA,
  SCAN_CACHE_MS,
  findLicence,
  hasProbeRoom,
  isUsageFresh,
  licenceCandidates,
  licenceDirsOf,
  licenceOf,
  listLicencesText,
  notDiscoveredText,
  probeUsageText,
  usageWarning,
} from './licences'
import type { Licence, LicenceScan, UsageRow, UsageSeen } from './licences'
import type { ComposedPrompt, ExpandableId, LaunchArgs, LaunchInput, PresentedPoint, ProcFact, ProcFacts, RegistryEdit, RunFigures, SectionBox, SectionId } from './core'

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
const STOP_TOOL = 'mcp__session-control__stop_worker'
const DIGEST_TOOL = 'mcp__session-control__turn_digest'
const LICENCES_TOOL = 'mcp__session-control__list_licences'
const USAGE_TOOL = 'mcp__session-control__probe_licence_usage'
/** The engine tools the sign-off guard looks at (guard.ts): Bash and PowerShell, by their command. */
const SIGNOFF_TOOLS = /^(Bash|PowerShell)$/

/** How much of a transcript read_result reads when the whole is over the read cap: a final report can be one long row. */
const REPORT_TAIL: TailShape = { lines: 400, width: 400_000 }

const snapshot = atom({ plugin: 'session-control', key: 'snapshot' } as const, null)
const pendingNotes = atom({ plugin: 'session-control', key: 'pendingNotes' } as const, [])
const pendingNotices = atom({ plugin: 'session-control', key: 'pendingNotices' } as const, [])
const driftBand = atom({ plugin: 'session-control', key: 'drift' } as const, null)
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
  /** `on`: the poll-based notices (notices.ts); `off`: none of them (the completion notes stay). */
  notices: 'on' | 'off'
  /** The source mod folder the loaded mod is compared with (drift.ts); empty: `<orchestrator directory>/mod`; `off`: no band. */
  modSource: string
  /** The lock folders of the lock-holder notice (locks.ts), comma separated; empty: off. */
  lockDirs: string
  /** More licence directories for the licence tools (licences.ts), comma separated absolute paths; empty: none. */
  licenceDirs: string
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
  notices: 'on',
  modSource: '',
  lockDirs: '',
  licenceDirs: '',
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
/**
 * Whether the sign-off guard checks this load's commands: set only when the session runs in the orchestrator directory
 * and the board is on there (startSession); else the guard passes every call.
 */
let isGuarded = false
/**
 * The notices' debounce state of this load (notices.ts), read from $.store at its first use under the orchestrator
 * directory's key and written back when it changes; `noticeSaved` is the text last written. A store that cannot be read
 * or written leaves the state in memory for the load.
 */
let noticeState: NoticeState | undefined
let noticeKey: string | undefined
let noticeSaved = ''
/** The notice passes run one after the other: each reads and changes the one state. */
let noticeChain: Promise<void> = Promise.resolve()
/** A $.store failure is traced once per load: a store that keeps failing would add a line at every change. */
let isStoreFailTraced = false
/** The registry-unreadable episode of this load (notices.ts, registryStep): in memory only. */
let registryWatch: RegistryWatch = {}
/** The drift check's interval (drift.ts, driftEverySec), when it last ran (epoch ms) and whether one runs now. */
let driftEvery = DRIFT_EVERY_SEC
let driftAt: number | undefined
let isDriftChecking = false
/** When the lock check last ran (epoch ms). */
let lockAt: number | undefined
/** turn_digest's ledger of this load (digest.ts): the events since the last call, how many were dropped, and the load's start. */
let digestEvents: DigestEvent[] = []
let digestDropped = 0
let loadedAt = 0
/** The licence tools' directory scan (licences.ts), kept SCAN_CACHE_MS in memory; `key` the home, default and option it was made for. */
let licenceScan: { key: string; scan: LicenceScan } | undefined
/** probe_licence_usage's answers per licence directory (licences.ts, isUsageFresh), in memory for the load. */
const usageSeen = new Map<string, UsageSeen>()
/**
 * Whether a call is probing now: at most one `claude -p /usage` runs at a time, across calls too. A call that finds one
 * running does not wait for it (a wait on another call's work would count against the hook's own 10 s budget): it
 * answers from memory and names the rest for the next call.
 */
let isUsageProbing = false

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
    readBytes: path => $.fs.read(path, { as: 'bytes' }),
    write: (path, text, isQuiet) => write($, path, text, isQuiet),
    exists: path => $.fs.exists(path),
    stat: path => $.fs.stat(path),
    list: path => $.fs.list(path),
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

/** The registry's text; a missing or unreadable file reads as empty (readRegistryFile tells them apart). */
async function readRegistryText($: EngineInterface): Promise<string> {
  return (await readRegistryFile($)) ?? ''
}

/** The registry's text, or undefined when the file is missing or cannot be read. */
async function readRegistryFile($: EngineInterface): Promise<string | undefined> {
  const path = await registryPath($)
  return $.fs.read(path).catch(() => undefined)
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
async function complete($: EngineInterface, entry: SessionEntry, taskStatus: string | undefined, toasts: ToastBudget): Promise<void> {
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
  // The note's free text (the entry's title, the outcome's summary from the result file) goes through the redaction the
  // tools and the notices use, before the toast and the note; the session id the engine made stays readable.
  const title: unknown = entry.title
  const who = title === undefined || title === null ? sid.slice(0, 8) : clean(String(title))
  const label = `${who}: ${clean(outcome.summary)}`
  // The secret scan of the worker's report (secrets.ts): the notes' last line and one secret-in-result notice per entry.
  const secrets = tallyOf(findSecrets(resultReport(resultText)))
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
  recordDigest({ at: await $.clock.now(), kind: 'completion', text: label, ...(secrets.count === 0 ? {} : { secrets }) })
  const notes = [label, ...(reportNote === undefined ? [] : [`${who}: report check: ${reportNote}`]), ...(secrets.count === 0 ? [] : [`${who}: ${secretScanLine(secrets)}`])]
  await update($, pendingNotes, list => [...list, ...notes].slice(-20))
  // The harvest's notices: queued tasks that waited for it, its compliance check, the queue maybe left empty, and the
  // secrets its report holds.
  const queueText = await $.fs.read(orchPath('task-queue.json')).catch(() => undefined)
  await withNotices($, state => [...harvestNotices(state, entry, outcome, queueText), ...unitStep(state, queueText, true), ...secretNotice(state, entry, secrets, 'result')], toasts, 'harvest')
}

// ---------------------------------------------------------------- the poll-based notices (notices.ts)
// Each is one line for the model (the next prompt carries it, whatever started that prompt), a toast titled by its kind
// and a trace line with its ids and counts. The debounce state lives in $.store, so a reload tells nothing again.

/** The notice state of the orchestrator directory: $.store's value at the first use of a load, then this load's copy. */
async function noticeStateOf($: EngineInterface): Promise<NoticeState> {
  const key = noticeStoreKey(config.orchestratorDir)
  if (noticeState !== undefined && noticeKey === key) return noticeState
  const stored = await $.store.get(key).catch((err: unknown) => {
    storeFailed($, err)
    return undefined
  })
  noticeKey = key
  noticeState = parseNoticeState(stored)
  noticeSaved = JSON.stringify(noticeState)
  await pruneNoticeKeys($, key)
  return noticeState
}

/**
 * Drops the notice state and the turn_digest time of an orchestrator directory that is no longer there (a scratch
 * directory removed), once per load.
 */
async function pruneNoticeKeys($: EngineInterface, own: string): Promise<void> {
  const keys = await $.store.keys().catch(() => [] as string[])
  for (const key of keys) {
    const dir = noticeKeyDir(key) ?? digestKeyDir(key)
    if (dir === undefined || key === own) continue
    if (!(await $.fs.exists(dir).catch(() => true))) await $.store.delete(key).catch(() => undefined)
  }
}

/** Writes the notice state back when it changed. */
async function saveNoticeState($: EngineInterface): Promise<void> {
  if (noticeState === undefined || noticeKey === undefined) return
  const text = JSON.stringify(noticeState)
  if (text === noticeSaved) return
  try {
    await $.store.set(noticeKey, noticeState)
    noticeSaved = text
  } catch (err) {
    storeFailed($, err)
  }
}

function storeFailed($: EngineInterface, err: unknown): void {
  if (isStoreFailTraced) return
  isStoreFailTraced = true
  traceError($, 'notices.store', err)
}

/**
 * One notice pass, after the passes before it: the work reads and changes the state and answers its notices; the state
 * is written back, then the notices go out. Nothing with the notices option off, or before the board is on.
 */
async function withNotices($: EngineInterface, work: (state: NoticeState) => Notice[] | Promise<Notice[]>, toasts: ToastBudget, source: ToastSource): Promise<void> {
  if (config.notices === 'off' || !isActive) return
  const pass = noticeChain.then(async () => {
    const state = await noticeStateOf($)
    const notices = await work(state)
    await saveNoticeState($)
    await deliver($, notices, toasts, source)
  })
  noticeChain = pass.catch((err: unknown) => traceError($, 'notices', err))
  await noticeChain
}

/** Where a notice pass comes from: the poll, the harvests of a refresh (all of them together), a queue change, a tool's answer. */
type ToastSource = 'poll' | 'harvest' | 'queue' | 'tool'

/**
 * The notice toasts of one refresh (decision mod-20): how many each source may still show (TOASTS_PER_PASS each) and
 * how many went past that; those are told by one summary toast at the end of the refresh (toastMore).
 */
type ToastBudget = { left: Record<ToastSource, number>; more: number }

const toastBudget = (): ToastBudget => ({ left: { poll: TOASTS_PER_PASS, harvest: TOASTS_PER_PASS, queue: TOASTS_PER_PASS, tool: TOASTS_PER_PASS }, more: 0 })

/** An inspection tool's answer that ends on the secret scan's line: one secret-in-result notice for its entry, once. */
async function secretsAnswered($: EngineInterface, entry: SessionEntry, answer: string, where: 'result' | 'transcript tail'): Promise<void> {
  const tally: SecretTally | undefined = tallyFromAnswer(answer)
  if (tally === undefined) return
  const toasts = toastBudget()
  await withNotices($, state => secretNotice(state, entry, tally, where), toasts, 'tool')
  toastMore($, toasts)
}

/** The one summary toast of the notices past their toast cap, when there were any. */
function toastMore($: EngineInterface, toasts: ToastBudget): void {
  if (toasts.more === 0) return
  $.ui.toast(toastText(TOAST_TITLES.moreNotices, moreToastText(toasts.more)), { timeoutMs: 10000 })
  toasts.more = 0
}

/**
 * A notice goes out three ways: a trace line (ids and counts), a toast titled by its kind while its source's toast cap
 * allows (else it counts for the summary toast), a line the next prompt carries (pendingWith: past the cap of the
 * waiting lines, the last says how many were not shown).
 */
async function deliver($: EngineInterface, notices: readonly Notice[], toasts: ToastBudget, source: ToastSource): Promise<void> {
  if (notices.length === 0) return
  const at = await $.clock.now().catch(() => 0)
  for (const notice of notices) {
    trace($, 'notice', { kind: notice.kind, ...notice.fields })
    recordDigest({ at, kind: notice.kind, text: notice.message })
    if (toasts.left[source] > 0) {
      toasts.left[source] -= 1
      $.ui.toast(toastText(TOAST_TITLES[notice.kind], notice.message), { timeoutMs: 10000 })
    } else {
      toasts.more += 1
    }
  }
  await update($, pendingNotices, list => pendingWith(list, notices.map(noticeLine)))
}

/**
 * An orphan's sessions file (under its config dir, or the default one when it has none): whether it names this
 * session's own id (the orchestrator's own process, when it runs headless, is never told), and the session id it names.
 */
async function orphanSession($: EngineInterface, proc: ProcFact): Promise<{ isOwn: boolean; sessionId?: string }> {
  const machine = await hostOf($)
  const dir = proc.configDir !== '' ? proc.configDir : machine.defaultConfigDir(await homeDir($), undefined)
  const file = sessionFileFacts(await $.fs.read(`${dir.replace(/[\\/]+$/, '')}/sessions/${proc.pid}.json`).catch(() => ''))
  const own = await $.session.id().catch(() => undefined)
  return { isOwn: own !== undefined && own !== '' && file.sessionId === own, ...(file.sessionId === undefined ? {} : { sessionId: file.sessionId }) }
}

/**
 * The notices of one poll, over what the poll read: orphans, stalls, the queue (re-arming unit-complete), the open
 * points; from the poll's timer only (`isTick`), retire-due (with the cleared log) and repo-state (git, with no worker
 * alive), each at most once per hour. A registry that was not sound at this poll (isRegistrySound: missing, unreadable,
 * empty or not an array) skips every step that reads it, pruning included: only the queue and the points are looked at.
 */
async function pollNotices(
  $: EngineInterface,
  entries: readonly SessionEntry[],
  facts: ProcFacts,
  nowMs: number,
  files: { queueText?: string; pointsText?: string },
  isTick: boolean,
  isRegistryOk: boolean,
  toasts: ToastBudget,
): Promise<void> {
  await withNotices($, async state => {
    const notices: Notice[] = []
    if (!isRegistryOk) return [...unitStep(state, files.queueText, false), ...pointStep(state, files.pointsText, nowMs)]
    // The first ORPHANS_SHOWN orphans of a poll are told one by one, the rest in one notice; every one is marked told.
    const grouped: number[] = []
    for (const proc of orphanStep(state, entries, facts, nowMs)) {
      const found = await orphanSession($, proc)
      markOrphan(state, proc.pid, found.isOwn ? 'own' : 'told')
      if (found.isOwn) continue
      if (notices.length < ORPHANS_SHOWN) notices.push(orphanNotice(proc, state, nowMs, found.sessionId))
      else grouped.push(proc.pid)
    }
    if (grouped.length > 0) notices.push(orphanGroupNotice(grouped))
    notices.push(...stallStep(state, entries, facts, nowMs))
    pruneHarvested(state, entries, files.queueText)
    pruneFreeWaits(state, files.queueText)
    notices.push(...unitStep(state, files.queueText, false))
    notices.push(...pointStep(state, files.pointsText, nowMs))
    if (isTick && isRetireDue(state, nowMs)) {
      const cleared = await $.fs.read(`${await runsPath($)}/cleared.jsonl`).catch(() => undefined)
      const retired = retiredIds(cleared)
      notices.push(...retireStep(state, { entries, facts, nowMs, ...(files.queueText === undefined ? {} : { queueText: files.queueText }), ...(retired === undefined ? {} : { retired }) }))
    }
    const aliveCount = entries.filter(entry => rowStatus(entry, facts) === 'alive').length
    if (isTick && isRepoDue(state, nowMs, aliveCount)) notices.push(...repoStep(state, await gitState($, config.orchestratorDir), nowMs))
    return notices
  }, toasts, 'poll')
}

/** After a queue_task change: unit-complete when no task is queued or running. */
async function queueChanged($: EngineInterface): Promise<void> {
  const queueText = await $.fs.read(orchPath('task-queue.json')).catch(() => undefined)
  const toasts = toastBudget()
  await withNotices($, state => unitStep(state, queueText, true), toasts, 'queue')
  toastMore($, toasts)
}

/**
 * The notices that do not read the registry, after the poll's own: registry-unreadable (every refresh) and, from the
 * poll's timer at most once per LOCK_EVERY_SEC with lockDirs set, lock-holder. Nothing with the notices option off: no
 * lock folder is read then.
 */
async function sideNotices($: EngineInterface, nowMs: number, isRegistryOk: boolean, isTick: boolean, toasts: ToastBudget, isRegistryMissing = false): Promise<void> {
  const isLockDue = isTick && config.lockDirs.trim() !== '' && (lockAt === undefined || nowMs - lockAt >= LOCK_EVERY_SEC * 1000)
  if (!isRegistryMissing) registryWatch.isSeen = true
  // Nothing to do (a sound registry with no episode open, no lock check due): no pass at all, the poll stays as cheap.
  if (isRegistryOk && registryWatch.since === undefined && !isLockDue) return
  await withNotices($, async state => {
    const notices = registryStep(registryWatch, isRegistryOk, nowMs, isRegistryMissing)
    const machine = await hostOf($)
    const dirs = lockDirsOf(config.lockDirs).map(dir => machine.nativePath(dir))
    if (isLockDue && dirs.length > 0) {
      lockAt = nowMs
      const read = await readLocks($, dirs)
      notices.push(...lockStep(state, read.seen, read.dirsRead))
    }
    return notices
  }, toasts, 'poll')
}

/**
 * The locks of the lock folders (locks.ts): each folder listed, each lock's holder file read, the holders' pids probed
 * at once. Read-only: nothing under a lock folder is written, moved or removed. A folder that cannot be listed is left
 * out of `dirsRead` (its locks are not forgotten); a probe that fails tells nothing.
 */
async function readLocks($: EngineInterface, dirs: readonly string[]): Promise<{ seen: LockSeen[]; dirsRead: string[] }> {
  const dirsRead: string[] = []
  const found: { lock: string; text: string; holder: NonNullable<ReturnType<typeof lockHolder>> }[] = []
  for (const dir of dirs) {
    const entries = await $.fs.list(dir).catch(() => undefined)
    if (entries === undefined) continue
    dirsRead.push(dir)
    for (const one of lockCandidates(dir, entries)) {
      let text: string | undefined
      if (one.isFolder) {
        for (const name of HOLDER_FILES) {
          text = await $.fs.read(`${one.lock}/${name}`).catch(() => undefined)
          if (text !== undefined) break
        }
      } else {
        text = await $.fs.read(one.lock).catch(() => undefined)
      }
      const holder = text === undefined ? undefined : lockHolder(text)
      if (text !== undefined && holder !== undefined) found.push({ lock: one.lock, text, holder })
    }
  }
  if (found.length === 0) return { seen: [], dirsRead }
  const facts = await probe($, found.map(one => ({ pid: one.holder.pid, config_dir: '' }))).catch((err: unknown) => {
    traceError($, 'locks.probe', err)
    return undefined
  })
  if (facts === undefined) return { seen: [], dirsRead: [] }
  const isLinux = (await hostOf($)).platform === 'linux'
  const seen = found.map(one => {
    const proof = facts.pidProof.get(one.holder.pid)
    const isAlive = facts.pidComm.has(one.holder.pid) || proof !== undefined
    const state = holderState(one.holder, { isAlive, ...(proof === undefined ? {} : { startTicks: proof.startTicks, ...(proof.state === undefined ? {} : { state: proof.state }) }) }, isLinux)
    return { lock: one.lock, fingerprint: lockFingerprint(one.text), pid: one.holder.pid, isJson: one.holder.isJson, isDead: state !== 'alive', ...(state === 'alive' ? {} : { why: state }) }
  })
  trace($, 'locks', { dirs: dirs.length, dirsRead: dirsRead.length, locks: seen.length, dead: seen.filter(one => one.isDead).length })
  return { seen, dirsRead }
}

/**
 * The loaded-mod drift check (drift.ts): at most once per driftEvery seconds (the start, then from the poll), the loaded
 * plugin's folder ($.plugin.root) and the source mod folder hashed by one host.hashTrees call; the band shows the
 * difference, and its first sight of a set of changed files is one mod-drift notice (with the notices option on). A
 * source that is off or not there, or a folder that cannot be read, shows nothing.
 */
async function driftCheck($: EngineInterface, nowMs: number): Promise<void> {
  if (!isActive || isDriftChecking) return
  if (driftAt !== undefined && nowMs - driftAt < driftEvery * 1000) return
  isDriftChecking = true
  driftAt = nowMs
  try {
    const found = await driftChanged($)
    const changed = found?.changed
    const text = found === undefined || changed === undefined || changed.length === 0 ? null : driftBandText(found.dir, changed)
    if ((await read($, driftBand))?.text !== text) await update($, driftBand, () => (text === null ? null : { text }))
    trace($, 'drift', { isSourceThere: found !== undefined, isCompared: changed !== undefined, changed: changed?.length ?? 0 })
    if (found !== undefined) {
      const toasts = toastBudget()
      await withNotices($, state => driftStep(state, changed, driftNoticeMessage(found.dir, changed ?? [])), toasts, 'poll')
      toastMore($, toasts)
    }
  } catch (err) {
    traceError($, 'drift', err)
  } finally {
    isDriftChecking = false
  }
}

/**
 * The source mod folder and the files that differ from the loaded mod's (changedFiles), or `changed` undefined when a
 * folder cannot be read; undefined when there is no source (modSource off, or the folder not there).
 */
async function driftChanged($: EngineInterface): Promise<{ dir: string; changed?: string[] } | undefined> {
  const source = sourceModDir(config.modSource, config.orchestratorDir)
  if (source === undefined) return undefined
  const machine = await hostOf($)
  const dir = machine.nativePath(expandHome(source, await homeDir($))).replace(/[\\/]+$/, '')
  if (!(await $.fs.exists(dir).catch(() => false))) return undefined
  const loaded = machine.nativePath($.plugin.root).replace(/[\\/]+$/, '')
  // The same folder (a session started with --plugin-dir on the source itself): nothing can differ.
  const [own, other] = await Promise.all([loaded, dir].map(path => $.fs.stat(path, { resolve: true }).then(one => one.realPath, () => undefined)))
  if (own !== undefined && own === other) return { dir, changed: [] }
  const trees = await machine.hashTrees(portOf($), [loaded, dir], DRIFT_SPEC)
  const [mine, theirs] = trees ?? []
  return mine === undefined || theirs === undefined ? { dir } : { dir, changed: changedFiles(mine, theirs) }
}

/** One event of turn_digest's ledger (digest.ts). */
function recordDigest(event: DigestEvent): void {
  const next = withEvent(digestEvents, digestDropped, event)
  digestEvents = next.events
  digestDropped = next.dropped
}

/**
 * turn_digest: the ledger since the last call, the peer ledger and the state line from a fresh read of the registry
 * (with the probe), the queue and the points; then the call's time goes to $.store and the ledger starts again. It
 * writes no file.
 */
async function turnDigest($: EngineInterface) {
  const nowMs = await $.clock.now()
  const key = digestStoreKey(config.orchestratorDir)
  const lastCallAt = lastCallOf(await $.store.get(key).catch(() => undefined))
  const registryText = await readRegistryFile($)
  const parsed = parseRegistry(registryText ?? '')
  const isRegistryRead = isRegistrySound(registryText) && parsed.ok
  const entries = isRegistryRead && parsed.ok ? parsed.entries : []
  const facts = isRegistryRead ? await probe($, entries) : undefined
  const statuses = facts === undefined ? [] : entries.map(entry => rowStatus(entry, facts))
  const [queueText, pointsText] = await Promise.all([$.fs.read(orchPath('task-queue.json')).catch(() => undefined), $.fs.read(orchPath('open-points.json')).catch(() => undefined)])
  const tasks = queueTasks(queueText) ?? []
  const text = digestText({
    events: digestEvents,
    dropped: digestDropped,
    nowMs,
    ...(lastCallAt === undefined ? {} : { lastCallAt }),
    loadedAt,
    isNoticesOff: config.notices === 'off',
    peers: await read($, ledger),
    counts: {
      alive: statuses.filter(one => one === 'alive').length,
      finished: statuses.filter(one => one === 'dead' || one === 'unreported' || one === 'done').length,
      queued: tasks.filter(task => task.status === 'queued').length,
      running: tasks.filter(task => task.status === 'running').length,
      openPoints: openPointCount(pointsText) ?? 0,
      isRegistryRead,
    },
  })
  trace($, 'digest', { events: digestEvents.length, dropped: digestDropped, isFirst: lastCallAt === undefined })
  digestEvents = []
  digestDropped = 0
  await $.store.set(key, { lastCallAt: nowMs }).catch((err: unknown) => storeFailed($, err))
  return { result: text }
}

/** Reads the points and the queue into the panel's atoms; answers the first problem with those files, and their text for the notices. */
async function loadPoints($: EngineInterface): Promise<{ problem?: string; queueText?: string; pointsText?: string }> {
  const text = await $.fs.read(orchPath('open-points.json')).catch(() => undefined)
  const parsed = text === undefined ? ({ ok: true, points: [] } as const) : parseOpenPoints(text)
  const list: PresentedPoint[] | null = parsed.ok ? parsed.points : null
  if (!isSame(await read($, points), list)) await update($, points, () => list)
  const queueRead = await $.fs.read(orchPath('task-queue.json')).catch(() => undefined)
  const queue = parseQueuedWork(queueRead ?? '')
  if (!isSame(await read($, queued), queue)) await update($, queued, () => queue)
  return { ...(parsed.ok ? {} : { problem: parsed.error }), ...(queueRead === undefined ? {} : { queueText: queueRead }), ...(text === undefined ? {} : { pointsText: text }) }
}

async function gather($: EngineInterface, taskStatus: string | undefined, isTick = false): Promise<void> {
  const files = await loadPoints($)
  const problem = files.problem
  const registryText = await readRegistryFile($)
  const parsed = parseRegistry(registryText ?? '')
  const toasts = toastBudget()
  const now = await $.clock.now()
  // A registry that cannot be read may be one that is not there (yet): registry-unreadable tells only one that is.
  const isRegistryMissing = registryText === undefined && !(await $.fs.exists(await registryPath($)).catch(() => true))
  if (!parsed.ok) {
    // The last good rows stay on screen under the warning.
    await showError($, problem === undefined ? parsed.error : `${parsed.error}; ${problem}`, now)
    await sideNotices($, now, false, isTick, toasts, isRegistryMissing)
    toastMore($, toasts)
    if (isTick) void driftCheck($, now)
    return
  }
  const facts = await probe($, parsed.entries)
  for (const entry of parsed.entries) {
    if (rowStatus(entry, facts) === 'dead') await complete($, entry, taskStatus, toasts)
  }
  const rows = buildRows(parsed.entries, facts, Math.floor(now / 1000))
  const next = problem === undefined ? { at: now, rows } : { at: now, rows, error: problem }
  noteError($, next.error)
  if (!isSame(await read($, snapshot), next, 'at')) await update($, snapshot, () => next)
  await pollNotices($, parsed.entries, facts, now, files, isTick, isRegistrySound(registryText), toasts)
  await sideNotices($, now, isRegistrySound(registryText), isTick, toasts, isRegistryMissing)
  toastMore($, toasts)
  // The drift check, at most once per its interval, from the poll's timer and on its own: a hash of the two folders
  // never holds the poll.
  if (isTick) void driftCheck($, now)
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

async function refresh($: EngineInterface, taskStatus?: string, isTick = false): Promise<void> {
  if (!isActive || isBusy) return
  isBusy = true
  try {
    await gather($, taskStatus, isTick)
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
    void refresh($, undefined, true)
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
  await Promise.allSettled([refresh($, undefined, true), refreshWatch($)])
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

/**
 * record_decision: one line appended to agreed-decisions.md, its id checked against the file and against the
 * decisions archive (archive_decisions moved those sections there; their ids stay taken). An archive that is there but
 * cannot be read refuses the write: the id cannot be checked.
 */
async function recordDecision($: EngineInterface, input: Record<string, unknown>): Promise<{ result: string } | { deny: string }> {
  const archivePath = orchPath(DECISIONS_ARCHIVE)
  const archive = await $.fs.read(archivePath).catch(() => undefined)
  if (archive === undefined && (await $.fs.exists(archivePath).catch(() => true))) {
    return { deny: `${PLUGIN}: ${DECISIONS_ARCHIVE} is there but cannot be read, so the id cannot be checked against the archived decisions; nothing written` }
  }
  return editHelper($, 'agreed-decisions.md', 'record-decision', text => appendDecision(text, input, archive))
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
 * pid files and the prompt file the mod wrote, only files that sit directly in the runs directory (planRunFiles) and
 * named by no other registry entry, and only regular files that are no symbolic link (the host's removeRegularFile,
 * which looks at the path without following a link); never a transcript. Answers the sentence the retire's answer ends
 * with ('' when nothing was there to delete). Nothing here refuses the retire: a path that is refused is named
 * (`not deleted: <name>: <reason>`), a file that will not go is named.
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
  const refusals: string[] = []
  const shown = (name: string) => plainText(name).slice(0, 120)
  for (const entry of eligible) {
    const others = [...left, ...removed.filter(one => one !== entry)]
    const names: string[] = []
    const stuck: string[] = []
    const plan = planRunFiles(entry, others, runs, (path, dir) => isUnder(path, dir, isWindows), isWindows)
    for (const one of plan.refused) refusals.push(`not deleted: ${shown(one.name)}: ${one.reason}`)
    for (const file of plan.files) {
      const outcome = await machine.removeRegularFile(portOf($), file.path).catch((): RemoveOutcome => 'failed')
      const name = file.path.slice(Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\')) + 1)
      if (outcome === 'removed') names.push(name)
      else if (outcome === 'symlink') refusals.push(`not deleted: ${shown(name)}: is a symbolic link`)
      else if (outcome === 'not-file') refusals.push(`not deleted: ${shown(name)}: is not a regular file`)
      else if (outcome === 'failed') stuck.push(name)
    }
    const sid = String(entry.session_id).slice(0, 8)
    if (names.length > 0) deleted.push(`${sid} (${names.join(', ')})`)
    if (stuck.length > 0) kept.push(`${sid} (${stuck.join(', ')})`)
  }
  if (deleted.length + kept.length + refusals.length > 0) trace($, 'retire.cleanup', { deleted: deleted.length, failed: kept.length, refused: refusals.length })
  const gone = deleted.length === 0 ? '' : ` Run files deleted from ${runs}: ${deleted.join('; ')}.`
  const notGone = kept.length === 0 ? '' : ` Run files that could not be deleted: ${kept.join('; ')}.`
  const notDeleted = refusals.length === 0 ? '' : ` (${refusals.join('; ')})`
  return `${gone}${notGone}${notDeleted}`
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

/** The prompt a launch built itself, and where it goes: an inline prompt, or a prompt_file the launch extended. */
type OwnPrompt = { path: string; composed: ComposedPrompt; section?: string }

async function launch($: EngineInterface, given: LaunchInput) {
  const machine = await hostOf($)
  // The launch's paths in the form the host stores, from here on and in the registry (on Windows C:/..., never /c/...).
  const input = machine.launchArgs(given)
  const home = await homeDir($)
  // A path the launch route cannot pass on is refused before anything runs (the PowerShell route's wildcard paths).
  const routeRefusal = machine.launchRefusal(input as LaunchArgs, machine.nativePath(expandHome(config.runsDir, home)))
  const sourceRefusal = routeRefusal ?? promptSourceRefusal(input)
  if (sourceRefusal !== undefined) {
    trace($, 'guard', { tool: 'launch_worker', isOk: false, ...messageFields(sourceRefusal, 'reason') })
    return { deny: `${PLUGIN}: ${sourceRefusal}` }
  }
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  // A resume takes what it is not given from its entry; a value given wins.
  const filled = fillFromEntry(input, reg.entries)
  const fromEntry = filledFields(input, filled)
  // The prompt: the file given, or the text given; a section's block and the rules block appended when asked.
  let section: { heading: string; body: string } | undefined
  if (filled.section !== undefined) {
    const decisions = await $.fs.read(orchPath('agreed-decisions.md')).catch(() => undefined)
    const found = decisions === undefined ? { error: 'agreed-decisions.md cannot be read' } : findDecisionSection(decisions, filled.section)
    if ('error' in found) {
      trace($, 'guard', { tool: 'launch_worker', isOk: false, ...messageFields(found.error, 'reason') })
      return { deny: `${PLUGIN}: refused: ${found.error}; nothing was launched` }
    }
    section = { heading: found.section.heading, body: found.section.body }
  }
  const sourceText = filled.prompt ?? (filled.prompt_file === undefined ? undefined : await $.fs.read(filled.prompt_file).catch(() => undefined))
  const composed = sourceText === undefined ? undefined : composePrompt(sourceText, section, rulesWanted(filled))
  // A file that cannot be read cannot be extended: launching it as it is would drop the section or the rules asked for.
  if (sourceText === undefined && (section !== undefined || filled.rules === true)) {
    const reason = `refused: the prompt file ${filled.prompt_file} cannot be read, so ${section !== undefined ? 'the section' : 'the rules block'} cannot be appended; nothing was launched`
    trace($, 'guard', { tool: 'launch_worker', isOk: false, ...messageFields(reason, 'reason') })
    return { deny: `${PLUGIN}: ${reason}` }
  }
  // The prompt lint (lint.ts): a likely secret or a prompt over the size cap is refused before anything runs, the
  // licence picker included; a missing branch or decision section is a warning in the answer.
  // The sign-off guard (lint.ts, README Sign-off guard) refuses a prompt that instructs a force-push, a remote deletion,
  // reset --hard, a forced clean or branch -D as a step, a skill test's too; it warns on a push to main or develop.
  const lint = composed === undefined ? { warnings: [] as string[] } : promptLint(composed.text)
  const signoff = composed === undefined ? { warnings: [] as string[] } : signoffLint(composed.text)
  const lintRefusal = lint.refusal ?? signoff.refusal
  if (lintRefusal !== undefined) {
    trace($, 'guard', { tool: 'launch_worker', isOk: false, check: lint.refusal === undefined ? 'sign-off' : 'prompt-lint', ...messageFields(lintRefusal, 'reason') })
    return { deny: `${PLUGIN}: ${lintRefusal}; nothing was launched` }
  }
  const runsDir = await runsPath($)
  const nowMs = await $.clock.now()
  const base = `${runsDir}/${new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${slugify(filled.title ?? '')}`
  // The session name of this launch, reserved now: it is unique per launch, and the prompt file the mod writes is named by it
  // (a title and a second are not unique). A resume keeps its entry's name, so its prompt file adds the launch time.
  const name = launchName(filled.title ?? '', nowMs, reg.entries, filled.resume_sid, issuedNames)
  issuedNames.add(name)
  const promptStem = filled.resume_sid === undefined ? name : `${name}-${new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(2, 14)}`
  const own: OwnPrompt | undefined =
    composed !== undefined && (filled.prompt !== undefined || composed.text !== sourceText) ? { path: `${runsDir}/${promptStem}.prompt.md`, composed, ...(section === undefined ? {} : { section: section.heading }) } : undefined
  const args = launchArgsOf(filled, own?.path ?? filled.prompt_file ?? '')
  const checks = await machine.launchChecks(portOf($), args)
  // The prompt file the mod writes is checked as text: it is written once the guards have passed.
  const promptFileOk = own === undefined ? checks.promptFileOk : own.composed.text.trim() !== ''
  const promptText = composed?.text
  const resumeSid = typeof args.resume_sid === 'string' ? args.resume_sid : undefined
  // Without a picker command a fresh launch inherits the machine's default configuration: the orchestrator's own
  // CLAUDE_CONFIG_DIR when it has one, else <home>/.claude, which is what the registry records.
  const picker = config.licencePickCommand.trim()
  const ownDir = await ownConfigDir($)
  const defaultDir = machine.defaultConfigDir(home, ownDir)
  // An explicit config_dir (licences.ts): a discovered licence only, which wins over the picker for a fresh launch; a
  // resume keeps its entry's own directory. No probe runs here: only a probe already made warns.
  let explicit: Licence | undefined
  if (filled.config_dir !== undefined) {
    const { scan } = await scanLicences($)
    const isSame = await sameDirOf($)
    explicit = typeof filled.config_dir === 'string' ? findLicence(scan.licences, filled.config_dir, isSame) : undefined
    const entryDir = resumeSid === undefined ? undefined : reg.entries.find(one => one.session_id === resumeSid)?.config_dir
    const refusal =
      explicit === undefined
        ? notDiscoveredText(scan.licences)
        : typeof entryDir === 'string' && entryDir !== '' && !isSame(entryDir, explicit.configDir)
          ? `refused: a resume runs under its entry's own config_dir (${entryDir}), not ${explicit.configDir}; nothing was launched`
          : undefined
    if (refusal !== undefined) {
      trace($, 'guard', { tool: 'launch_worker', isOk: false, check: 'config_dir', ...messageFields(refusal, 'reason') })
      return { deny: `${PLUGIN}: ${refusal}` }
    }
  }
  const explicitDir = explicit?.configDir
  let pick: { exitCode: number; stdout: string; stderr?: string } | undefined
  if (resumeSid === undefined && explicitDir !== undefined) pick = { exitCode: 0, stdout: explicitDir }
  else if (resumeSid === undefined && picker === '') pick = { exitCode: 0, stdout: defaultDir }
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
    dirOk: checks.dirOk,
    missingItems: promptText === undefined ? undefined : missingPromptItems(promptText),
    ...machine.launchFacts(promptText),
  })
  trace($, 'guard', verdict.ok ? { tool: 'launch_worker', isOk: true, configDir: verdict.configDir, resumeSid: verdict.resumeSid } : { tool: 'launch_worker', isOk: false, ...messageFields(verdict.reason, 'reason') })
  if (!verdict.ok) return { deny: `${PLUGIN}: ${verdict.reason}` }
  if (own !== undefined) {
    trace($, 'launch.prompt', { promptFile: own.path, chars: own.composed.text.length, isInline: filled.prompt !== undefined, isSectionAdded: own.composed.isSectionAdded, isRulesAdded: own.composed.isRulesAdded })
    try {
      await machine.prepareRunsDir(portOf($), runsDir)
      await write($, own.path, own.composed.text)
    } catch (err) {
      traceError($, 'launch.prompt', err)
      return { deny: `${PLUGIN}: the prompt file ${own.path} could not be written (${errorText(err).slice(0, 160)}); nothing was launched.` }
    }
  }
  // No CLAUDE_CONFIG_DIR on the line: a fresh launch without a picker, or a resume under the default directory; with an
  // explicit config_dir, a fresh launch under the default directory (as a launch without a picker runs there).
  const isExplicitFresh = explicit !== undefined && verdict.resumeSid === undefined
  const isConfigInherited = isExplicitFresh ? machine.isDefaultConfigDir(verdict.configDir, defaultDir) : picker === '' && (verdict.resumeSid === undefined || machine.isDefaultConfigDir(verdict.configDir, defaultDir))
  const usageWarned = explicit === undefined ? undefined : usageWarning(explicit, usageSeen.get(explicit.configDir), await $.clock.now())
  const warnings = [...lint.warnings, ...signoff.warnings, ...(usageWarned === undefined ? [] : [usageWarned])]
  const licenceNote = isExplicitFresh && explicit !== undefined ? ` Licence: ${explicit.name} (config_dir given; the licence picker was not run).` : undefined
  return spawnWorker($, args, { ...verdict, isConfigInherited }, reg.entries, reg.facts, ownDir, { base, name, own, fromEntry, warnings, ...(licenceNote === undefined ? {} : { licenceNote }) })
}

/** Start the worker as a background task of the host's launch tool, find its real pid and session, register it. */
async function spawnWorker(
  $: EngineInterface,
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string; isConfigInherited?: boolean },
  entries: readonly SessionEntry[],
  before: ProcFacts,
  own: string | undefined,
  launchRun: { base: string; name: string; own?: OwnPrompt; fromEntry: readonly string[]; warnings?: readonly string[]; licenceNote?: string },
) {
  const machine = await hostOf($)
  const port = portOf($)
  // The prompt lint's warnings, one line each after the answer; a launch with none answers as before.
  const warningLines = (launchRun.warnings ?? []).map(one => `\nWARNING: ${one}`).join('')
  // The launch's redirections need the runs directory.
  await machine.prepareRunsDir(port, await runsPath($))
  const files = { result: `${launchRun.base}.json`, err: `${launchRun.base}.err` }
  const { name } = launchRun
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
    return { result: `Started in the background but no claude process appeared within 30 s; check ${files.err}. Not registered.${warningLines}` }
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
  if (sessionId === '') return { result: `Worker pid ${worker.pid} started but its session id could not be read; registry NOT written.${warningLines}` }
  const inbox = { name: fromFile.name ?? name, ...(fromFile.socketPath === undefined ? {} : { socketPath: fromFile.socketPath }) }
  const prompt = launchRun.own === undefined ? {} : { promptFile: launchRun.own.path, ...(launchRun.own.section === undefined ? {} : { section: launchRun.own.section }) }
  const entry = newRegistryEntry(args, verdict, worker.pid, sessionId, files, inbox, Math.floor(launchedAt / 1000), prompt)
  // A missing registry starts as an empty one, as REGISTER_SCRIPT starts it.
  const failed = await editRegistry($, async text => registerEntry(text, entry, verdict.resumeSid ? 'resume' : 'new'), freshText('headless-sessions.json'))
  const note = failed === undefined ? 'registered' : writeFailed(failed)
  trace($, 'worker.registered', { pid: worker.pid, sessionId, isRegistered: failed === undefined, ...(failed === undefined ? {} : messageFields(failed, 'reason')) })
  await refresh($)
  const pidNote = filePid !== undefined && filePid !== worker.pid ? ` The launch's pid file names pid ${filePid}, not the one the probe found.` : ''
  // Said only when the launch's new parameters were used: an old launch's answer is as it was.
  const { own: ownPrompt, fromEntry } = launchRun
  const added = ownPrompt === undefined ? [] : [...(ownPrompt.composed.isSectionAdded ? [`section "${ownPrompt.section}" appended`] : []), ...(ownPrompt.composed.isRulesAdded ? ['rules block appended'] : [])]
  const promptNote = ownPrompt === undefined ? '' : ` Prompt: ${ownPrompt.path} (written by the mod${added.length === 0 ? '' : `; ${added.join('; ')}`}).`
  const entryNote = fromEntry.length === 0 ? '' : ` From the entry: ${fromEntry.join(', ')}.`
  return {
    result: `Launched pid ${worker.pid}, session ${sessionId}, config_dir ${verdict.configDir}, ${note}. Name: ${inbox.name}; socket: ${inbox.socketPath ?? 'none'}. Result: ${files.result}; errors: ${files.err}.${pidNote}${promptNote}${entryNote}${launchRun.licenceNote ?? ''}${warningLines}`,
  }
}

/**
 * stop_worker: CLAUDE.md step 6 by tool, for a registered worker only. The entry is the registry's (an orphan or a pid
 * no entry records is never reached); its pid must pass the Abort check (refused otherwise: a dead or reused pid is
 * never signalled); the host's stopProcessTree lists the tree, then stops the root and every descendant left, never
 * this session's own process or an ancestor of it; then the Abort check again, which decides the result whatever the
 * stop answered or if it failed. No registry field is written here: the exit notification and the probe record it.
 */
async function stopWorker($: EngineInterface, id: unknown, reason: unknown) {
  const asked = await sessionAsked($, id)
  if ('deny' in asked) return asked
  const { entry, facts } = asked
  const machine = await hostOf($)
  const isWindows = machine.platform === 'windows'
  const sid = entry.session_id
  if (typeof entry.pid !== 'number' || !Number.isSafeInteger(entry.pid) || entry.pid <= 1) {
    trace($, 'guard', { tool: 'stop_worker', isOk: false, reason: 'no-pid' })
    return { deny: `${PLUGIN}: refused: session ${sid} is not alive: its entry records no pid (a finished session, or one whose pid was dropped); nothing was signalled.` }
  }
  const pid = entry.pid
  const before = abortCheck(entry, facts, isWindows)
  if (!before.isAlive) {
    trace($, 'guard', { tool: 'stop_worker', isOk: false, reason: 'abort-check', pid })
    return { deny: `${PLUGIN}: refused: the Abort check before the stop does not prove pid ${pid} is the live process of session ${sid}: ${before.text}. A dead or reused pid is never signalled; nothing was signalled.` }
  }
  const start = facts.pidProof.get(pid)?.startTicks ?? ''
  let report: StopReport | undefined
  let failure: string | undefined
  try {
    report = await machine.stopProcessTree(portOf($), { pid, start })
  } catch (err) {
    traceError($, 'stop_worker', err)
    failure = errorText(err)
  }
  if (report?.steps.some(step => step.kind === 'skip' && step.pid === pid && step.reason === 'own') === true) {
    trace($, 'guard', { tool: 'stop_worker', isOk: false, reason: 'own', pid })
    return { deny: `${PLUGIN}: refused: pid ${pid} is this session's own process or one of its ancestors; nothing was signalled.` }
  }
  // The Abort check after the stop decides what is said, whatever the stop answered.
  const after = abortCheck(entry, await probe($, [entry]), isWindows)
  const signals = report?.steps.filter(step => step.kind === 'signal').length ?? 0
  const survivors = report?.final.filter(one => one.pid !== pid && one.status === 'alive').length ?? 0
  trace($, 'guard', { tool: 'stop_worker', isOk: true, pid, signals, isDeadAfter: !after.isAlive, survivors, ...(failure === undefined ? {} : { isFailed: true }) })
  const given = typeof reason === 'string' ? reason : undefined
  return { result: stopProofText({ entry, ...(given === undefined ? {} : { reason: given }), before, ...(report === undefined ? {} : { report }), ...(failure === undefined ? {} : { failure }), after, isWindows }) }
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
  const text = readResultText({
      entry,
      facts,
      ...(resultText === undefined ? {} : { resultText }),
      ...(resultMissing === undefined ? {} : { resultMissing }),
      errText,
      ...('text' in transcript ? { transcript: { text: transcript.text, isWhole: transcript.isWhole } } : { transcriptMissing: transcript.missing }),
      maxChars: chars,
    })
  await secretsAnswered($, entry, text, 'result')
  return { result: text }
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
  const text = workerTailText({
    entry,
    facts,
    ...(path === undefined ? {} : { path }),
    ...(mtime === undefined ? {} : { ageSec: Math.max(0, nowSec - mtime) }),
    ...(tail === undefined ? {} : { lines: summarizeTranscript(tail, wanted) }),
    wanted,
  })
  await secretsAnswered($, entry, text, 'transcript tail')
  return { result: text }
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

/**
 * The sign-off guard on the orchestrator's own Bash and PowerShell commands (guard.ts, README Sign-off guard): a git
 * force-push, remote deletion, reset --hard, forced clean or branch -D is refused; undefined lets the call on.
 */
function signoffRefusal($: EngineInterface, input: Record<string, unknown>): string | undefined {
  const tool = String(input.tool ?? '')
  if (tool !== 'Bash' && tool !== 'PowerShell') return undefined
  const hit = signoffVerdict(typeof input.command === 'string' ? input.command : '', tool === 'PowerShell' ? 'powershell' : 'bash')
  if (hit === undefined) return undefined
  trace($, 'guard', { check: 'sign-off', tool, action: hit.how, isOk: false })
  return signoffDenyText(tool, hit)
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
  const retired = retiredIds(clearedText)
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

// ---------------------------------------------------------------- the licence tools (licences.ts)
// A licence is a config directory holding both .credentials.json and .claude.json as regular files: the scan reads
// directory listings and asks $.fs.stat what kind each of those two paths is, nothing else; no file of a licence is ever
// opened.

/** Two config directories compared as the host compares them (the registry and the launch compare them so). */
async function sameDirOf($: EngineInterface): Promise<(a: string, b: string) => boolean> {
  const machine = await hostOf($)
  return (a, b) => machine.isDefaultConfigDir(a, b)
}

/**
 * The machine's licences (licences.ts): the default directory, <home>/.claude, <home>/.claude/<name>, <home>/.claude-<name>
 * and the licenceDirs option, by directory listings and the presence of the two files. Kept SCAN_CACHE_MS in memory;
 * a call after that, or with another home, default directory or option, scans again.
 */
async function scanLicences($: EngineInterface): Promise<{ scan: LicenceScan; isCached: boolean }> {
  const machine = await hostOf($)
  const home = await homeDir($)
  const defaultDir = machine.defaultConfigDir(home, await ownConfigDir($))
  const nowMs = await $.clock.now()
  const key = JSON.stringify([home, defaultDir, config.licenceDirs])
  const kept = licenceScan
  if (kept !== undefined && kept.key === key && nowMs >= kept.scan.scannedAt && nowMs - kept.scan.scannedAt < SCAN_CACHE_MS) return { scan: kept.scan, isCached: true }
  const isSame = await sameDirOf($)
  const listed = async (dir: string) => (await $.fs.list(dir).catch(() => [])).map(one => ({ name: one.name, kind: one.kind }))
  // A regular file, or a link that leads to one ($.fs.stat follows a link): a directory, a broken link or anything else
  // in the file's place does not count. A stat opens nothing.
  const isThere = (path: string) => $.fs.stat(path).then(one => one.kind === 'file', () => false)
  const isAbsolute = (path: string) => (machine.platform === 'windows' ? isWinAbsolute(path) : path.startsWith('/'))
  const explicit = licenceDirsOf(config.licenceDirs, home, isAbsolute)
  const found = licenceCandidates({ home, defaultDir, children: await listed(`${home}/.claude`), homeEntries: await listed(home), explicit: explicit.dirs.map(dir => machine.nativePath(dir)), isSame })
  const homeConfig = await isThere(`${home}/.claude.json`)
  const licences: Licence[] = []
  for (const candidate of found.candidates) {
    const credentials = await isThere(`${candidate.configDir}/.credentials.json`)
    const one = licenceOf(candidate, { credentials, config: credentials && (await isThere(`${candidate.configDir}/.claude.json`)), homeConfig })
    if (one !== undefined) licences.push(one)
  }
  const scan: LicenceScan = { licences, skipped: found.skipped, ignored: explicit.ignored, scannedAt: nowMs }
  licenceScan = { key, scan }
  trace($, 'licences.scan', { licences: licences.length, skipped: found.skipped, ignored: explicit.ignored })
  return { scan, isCached: false }
}

/** list_licences: the scan, and the registry's sessions per licence from a fresh probe (paths normalised, links not resolved). */
async function listLicences($: EngineInterface) {
  const { scan, isCached } = await scanLicences($)
  const parsed = parseRegistry(await readRegistryText($))
  const registry = parsed.ok ? { entries: parsed.entries, facts: await probe($, parsed.entries) } : undefined
  const isWindows = (await hostOf($)).platform === 'windows'
  return {
    result: listLicencesText({ scan, nowMs: await $.clock.now(), isCached, ...(registry === undefined ? {} : { registry }), ...(parsed.ok ? {} : { registryError: parsed.error }), isSame: await sameDirOf($), isWindows }),
  }
}

/**
 * probe_licence_usage: the discovered licences (or the one asked, by its config_dir or name; any other is refused),
 * each answered from memory while its probe is fresh, else probed by the host (host.probeUsage), one after the other. A
 * probe starts only while one more fits in USAGE_CALL_BUDGET_MS from the call's start and no other call is probing;
 * the licences left are named for the next call.
 */
async function probeLicenceUsage($: EngineInterface, asked: unknown) {
  const startedAt = await $.clock.now()
  const { scan } = await scanLicences($)
  let targets: readonly Licence[] = scan.licences
  if (asked !== undefined) {
    const one = typeof asked === 'string' ? findLicence(scan.licences, asked, await sameDirOf($)) : undefined
    if (one === undefined) {
      trace($, 'guard', { tool: 'probe_licence_usage', isOk: false, reason: 'not-discovered' })
      return { deny: `${PLUGIN}: not a discovered licence` }
    }
    targets = [one]
  }
  const isOwnUnset = (await ownConfigDir($)) === undefined
  const isElsewhere = isUsageProbing
  if (!isElsewhere) isUsageProbing = true
  try {
    const rows = await probeEach($, targets, isOwnUnset, startedAt, !isElsewhere)
    return { result: `${probeUsageText(rows, await $.clock.now())}${isElsewhere ? '\nAnother call was probing: this one probed nothing and answered from memory.' : ''}` }
  } finally {
    if (!isElsewhere) isUsageProbing = false
  }
}

/** The rows of probeLicenceUsage, in the licences' order; the default directory a launch inherits is probed without CLAUDE_CONFIG_DIR. */
async function probeEach($: EngineInterface, targets: readonly Licence[], isOwnUnset: boolean, startedAt: number, canProbe: boolean): Promise<UsageRow[]> {
  const machine = await hostOf($)
  const rows: UsageRow[] = []
  for (const licence of targets) {
    const nowMs = await $.clock.now()
    const kept = usageSeen.get(licence.configDir)
    if (kept !== undefined && isUsageFresh(kept, nowMs)) {
      rows.push({ licence, seen: kept, isCached: true })
      trace($, 'licences.usage', { configDir: licence.configDir, isCached: true, ...(kept.result.ok ? {} : { code: kept.result.code }) })
      continue
    }
    if (!canProbe || !hasProbeRoom(nowMs - startedAt)) {
      rows.push({ licence, isCached: false })
      continue
    }
    let result: UsageSeen['result']
    try {
      result = await machine.probeUsage(portOf($), licence.configDir, isOwnUnset && licence.source === 'default')
    } catch (err) {
      traceError($, 'probe_licence_usage', err)
      result = { ok: false, code: 'FAILED' }
    }
    const seen = { at: await $.clock.now(), result }
    usageSeen.set(licence.configDir, seen)
    rows.push({ licence, seen, isCached: false })
    trace($, 'licences.usage', { configDir: licence.configDir, isCached: false, ...(result.ok ? {} : { code: result.code }) })
  }
  return rows
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
        'Runs it as a background task, finds the real pid and session id and registers the worker. ' +
        'A fresh launch needs dir, model, effort, title and exactly one of prompt_file and prompt (inline text the mod writes to a prompt file of its own); ' +
        'a resume (resume_sid) takes dir, model, effort and title from its entry unless given. section appends a decisions section as binding; ' +
        'rules appends the standard rules block when the prompt lacks the items the guard checks. ' +
        'config_dir runs a fresh launch under a discovered licence (list_licences) instead of the licence picker.',
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
      [
        'stop_worker',
        "Stop a registered worker that is alive and prove it dead (CLAUDE.md step 6, Abort, by tool). Only a registry entry with a recorded pid that passes the Abort check (its sessions file names the session and its start is the process's own); never an orphan, an unregistered pid or this session's own process. Lists the worker's descendants first, then SIGTERM, re-checks every second for up to 10 s, SIGKILL (Windows: taskkill /T, then /T /F), then each descendant still alive the same way. Answers the proof: the Abort check before and after, each signal with its time, the descendants found and stopped, and any survivor. Changes no registry field.",
        STOP_SCHEMA,
      ],
    ] as const) {
      await $.tool.register({ name, description, inputSchema: schema as unknown as Record<string, unknown> })
    }
    // Registered last: every tool before it keeps its name, description, schema and place.
    await $.tool.register({
      name: 'turn_digest',
      description:
        "Read-only: writes no file (it keeps the time of the call in the mod's store). What changed since the previous call: worker completions harvested, " +
        'notices fired by kind and count, sessions that became orphans or stalled, queue tasks that became ready, open points that aged past 24 h, ' +
        'unacknowledged peer messages, then one state line (sessions alive and finished, queue queued and running, open points); everything is then ' +
        "marked seen. The first call reports from the mod's load. At most 40 lines, redacted, plain text.",
      inputSchema: DIGEST_SCHEMA as unknown as Record<string, unknown>,
    })
    // The licence tools after it: every tool before them keeps its name, description, schema and place.
    await $.tool.register({
      name: 'list_licences',
      description:
        'Read-only. The licences of this machine: config directories that hold both .credentials.json and .claude.json, a test of presence only (neither file is opened): ' +
        'the default directory a launch without a picker uses, ~/.claude, ~/.claude/<name>, ~/.claude-<name> and the licenceDirs option. Per licence: config_dir, name, ' +
        'source (default, home, child, dash, explicit), logged_in (the two files are there) and the registry sessions under it (live, in all). The directory scan is kept 60 s.',
      inputSchema: LIST_LICENCES_SCHEMA as unknown as Record<string, unknown>,
    })
    await $.tool.register({
      name: 'probe_licence_usage',
      description:
        "Read-only. The usage of the discovered licences (or of the one config_dir names, by its path or name): per licence the five-hour session window and the seven-day all-models window " +
        "(floored percent and reset, as the CLI's claude -p /usage shows them, no model turn), age_seconds and cached, or a fixed code (NO_CLAUDE, TIMEOUT, NOT_LOGGED_IN, PARSE, FAILED). " +
        'A probe is kept 60 s (a failed one 15 s); probes run one at a time and a call takes at most 40 s: licences left are named for the next call. No credential is read; the figures can be stale.',
      inputSchema: PROBE_USAGE_SCHEMA as unknown as Record<string, unknown>,
    })
  }
  if (!isPolling) {
    isPolling = true
    $.clock.every(config.pollMs, () => tick($))
  }
  await refresh($)
  await driftCheck($, await $.clock.now())
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
    // The picker command is a command line of its own: the trace says only whether one is set. modSource and lockDirs
    // are left to the drift and locks lines (whether a source is there, how many folders were read).
    const { pollMs, registrySetting, licencePickCommand, modSource, lockDirs, licenceDirs, ...rest } = config
    const options = { ...rest, registryPath: registrySetting, pollSeconds: pollMs / 1000, licencePickCommand: licencePickCommand.trim() === '' ? 'empty' : 'set' }
    traceStart = { cwd, platform: machine.platform, isOrchestratorDir: config.orchestratorDir !== '' && isHere, options }
  }
  if (config.orchestratorDir !== '' && isHere) {
    await activate($)
    isGuarded = true
  }
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

/**
 * The drift check's interval (drift.ts, driftEverySec): DRIFT_EVERY_SEC unless the test-only shortening is set, which
 * counts only with SESSION_CONTROL_TEST=1; an environment that cannot be read leaves the default.
 */
async function driftInterval($: EngineInterface): Promise<number> {
  try {
    return driftEverySec(await $.env.get('SESSION_CONTROL_TEST'), await $.env.get('SESSION_CONTROL_DRIFT_SECONDS'))
  } catch {
    return DRIFT_EVERY_SEC
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
  isGuarded = false
  noticeState = undefined
  noticeKey = undefined
  noticeSaved = ''
  noticeChain = Promise.resolve()
  isStoreFailTraced = false
  registryWatch = {}
  driftEvery = DRIFT_EVERY_SEC
  driftAt = undefined
  isDriftChecking = false
  lockAt = undefined
  digestEvents = []
  digestDropped = 0
  loadedAt = 0
  licenceScan = undefined
  usageSeen.clear()
  isUsageProbing = false
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
    notices: options.notices === 'off' ? 'off' : 'on',
    modSource: String(options.modSource ?? ''),
    lockDirs: String(options.lockDirs ?? ''),
    licenceDirs: String(options.licenceDirs ?? ''),
  }
  isTraceWanted = config.debug
  isTracing = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The trace is wanted from the launch, by the debug option or by the environment (an environment that cannot be
    // read leaves it off); it is written once the board is on.
    if (!config.debug && isTraceSwitch(await debugSwitch($))) isTraceWanted = true
    loadedAt = await $.clock.now()
    driftEvery = await driftInterval($)
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
    // The notices ride on the next prompt, whatever started it: one line each.
    let notices: string[] = []
    if ((await read($, pendingNotices)).length > 0) {
      await update($, pendingNotices, list => {
        notices = list
        return []
      })
    }
    if (notices.length > 0) extra.push(notices.join('\n'))
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
    tracedTool($, 'queue_task', e, ['action', 'id', 'status'], async () => {
      const answer = await editHelper($, 'task-queue.json', 'queue-task', text => editQueue(text, plain(e)))
      if ('result' in answer) await queueChanged($)
      return answer
    }),
  ).catch(($, e, next) => {
    traceError($, 'queue_task', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: queue_task failed` }
  })

  on('tool.call', { tool: DECISION_TOOL }, ($, e) =>
    tracedTool($, 'record_decision', e, ['section', 'id'], () => recordDecision($, plain(e))),
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

  // The reason is free text: the trace keeps the session id and the answer's length only.
  on('tool.call', { tool: STOP_TOOL }, ($, e) => tracedTool($, 'stop_worker', e, ['session_id'], () => stopWorker($, plain(e).session_id, plain(e).reason), true)).catch(($, e, next) => {
    traceError($, 'stop_worker', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: stop_worker failed` }
  })

  // The sign-off guard (guard.ts): in the orchestrator directory's own session only, a Bash or PowerShell command that
  // runs a git action of the sign-off list is refused. The mod's own calls (the launch's Bash) pass untouched. When the
  // hook cannot run (a re-entry) the handler decides on the call's text the same way.
  on('tool.call', { tool: SIGNOFF_TOOLS }, async ($, e, next) => {
    if (!isGuarded || next.origin.plugin === PLUGIN) return next(e)
    const refusal = signoffRefusal($, plain(e))
    return refusal === undefined ? next(e) : { deny: refusal }
  }).catch(($, e, next) => {
    if (next.called || !isGuarded) return next(e)
    const input = plain(e)
    const tool = String(input.tool ?? '')
    const hit = signoffVerdict(typeof input.command === 'string' ? input.command : '', tool === 'PowerShell' ? 'powershell' : 'bash')
    return hit === undefined ? next(e) : { deny: signoffDenyText(tool, hit) }
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

  on('tool.call', { tool: DIGEST_TOOL }, ($, e) => tracedTool($, 'turn_digest', e, [], () => turnDigest($), true)).catch(($, e, next) => {
    traceError($, 'turn_digest', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: turn_digest failed` }
  })

  // The licence tools: they read directory listings and file presence (and the usage probe's two figures); their
  // answers reach the trace as a length only.
  on('tool.call', { tool: LICENCES_TOOL }, ($, e) => tracedTool($, 'list_licences', e, [], () => listLicences($), true)).catch(($, e, next) => {
    traceError($, 'list_licences', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: list_licences failed` }
  })

  on('tool.call', { tool: USAGE_TOOL }, ($, e) => tracedTool($, 'probe_licence_usage', e, ['config_dir'], () => probeLicenceUsage($, plain(e).config_dir), true)).catch(($, e, next) => {
    traceError($, 'probe_licence_usage', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: probe_licence_usage failed` }
  })

  // The launch's fields are paths, names, numbers and switches; the title and the section are free text and stay out
  // (the title's slug is in the run's file names); the prompt, inline or in its file, never reaches the trace.
  const LAUNCH_FIELDS = ['dir', 'prompt_file', 'model', 'effort', 'need', 'resume_sid', 'timeout_minutes', 'rules', 'config_dir'] as const
  on('tool.call', { tool: TOOL }, ($, e) => tracedTool($, 'launch_worker', e, LAUNCH_FIELDS, () => launch($, e as unknown as LaunchInput))).catch(($, e, next) => {
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

  // The loaded-mod drift band (decision win-35): one dim line above the prompt while the loaded mod differs from the
  // source mod folder, as the engine's own "Update installed" line; a survey, or nothing to say, leaves the band to the
  // engine. It is no notice: the notices option does not switch it off (modSource off does). The line goes above what
  // the band would draw without it (`next(e)`: another plugin's band beneath, or the engine's own), which stays.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = await read($, driftBand)
    if (band === null || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>{band.text}</Text>
        {below}
      </Box>
    )
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
              wrapText(task.title, width - 2).map((text, i) => ({ text: (i === 0 ? '\u2022 ' : '  ') + text })),
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
