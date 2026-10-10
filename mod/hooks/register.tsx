import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunInit, ProcessRunResult, Register } from 'claude-code'

import type { SessionEntry, SessionOutcome } from '../types'
import { DECISION_SCHEMA, POINT_SCHEMA, QUEUE_SCHEMA, appendDecision, editOpenPoints, editQueue } from './bookkeeping'
import type { Edit } from './bookkeeping'
import { backupName, dirOf, freshText, localDate, tmpPath } from './store'
import {
  ROTATE_SCRIPT,
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
import {
  APPEND_SCRIPT,
  FILES_PS1,
  LAUNCH_SCHEMA,
  PROBE_PS1,
  PROBE_SCRIPT,
  findNewWindowsWorker,
  isSameWinPath,
  windowsPickerRefusal,
  isWinAbsolute,
  tailLines,
  winPath,
  ACK_SCHEMA,
  RETIRE_SCHEMA,
  ackEntries,
  registerEntry,
  removeEntries,
  retireVerdict,
  buildLaunchArgv,
  defaultConfigDir,
  isDefaultConfigDir,
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
  launchName,
  sessionFileFacts,
  reportCheck,
  resultReport,
} from './core'
import type { ExpandableId, LaunchArgs, PresentedPoint, ProcFacts, RegistryEdit, SectionBox, SectionId } from './core'

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
    if (needsRotation((await $.fs.stat(path).catch(() => undefined))?.size ?? 0, adding)) await rotateTrace($, path, adding)
    let problem = await appendLog($, path, chunk, true)
    // Outside the orchestrator directory nothing may have made the runs directory yet (Windows' append makes it).
    if (problem !== undefined && !(await isWindows($))) {
      await $.process.run(['mkdir', '-p', dirOf(path)], { timeoutMs: 5_000 })
      problem = await appendLog($, path, chunk, true)
    }
    if (problem !== undefined) return problem
  }
  return undefined
}

/**
 * Rotates the trace: ROTATE_SCRIPT on Linux, which checks the size again itself; on Windows each rename of
 * rotationMoves by the file script, where a file another session moved meanwhile is no failure.
 */
async function rotateTrace($: EngineInterface, path: string, adding: number): Promise<void> {
  if (!(await isWindows($))) {
    const argv = ['sh', '-c', ROTATE_SCRIPT, 'session-trace', path, String(TRACE_KEEP - 1), String(TRACE_MAX_BYTES), String(adding)]
    const ran = await $.process.run(argv, { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) throw new Error(`rotation failed (exit ${ran.exitCode}): ${ran.stderr.slice(0, 100)}`)
    return
  }
  for (const [from, to] of rotationMoves(path)) {
    if (!(await $.fs.exists(from).catch(() => false))) continue
    const ran = await runScript($, 'files.ps1', FILES_PS1, ['move', from, to], 10_000, true)
    if (ran.exitCode !== 0 && (await $.fs.exists(from).catch(() => true))) throw new Error(`rotation failed (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 100)}`)
  }
}

/** Runs a hook's work and then writes the trace lines it made. */
async function traced<T>($: EngineInterface, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } finally {
    await flushTrace($)
  }
}

// Native Windows takes its own branch of each machine call below; anything else, WSL included, takes the Linux one,
// whose commands stay what they were.

/** Native Windows, told by positive signs only: OS is Windows_NT and USERPROFILE a drive-letter path. Anything else is Linux. */
async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT' && /^[A-Za-z]:[\\/]/.test((await $.env.get('USERPROFILE')) ?? '')
}

/** Windows PowerShell 5.1 by absolute path: on Windows `bash` is the WSL launcher, and sh, mv and pwsh are not on the PATH a command gets. */
async function powershell($: EngineInterface): Promise<string> {
  const root = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
  return `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** One of the mod's PowerShell scripts in the runs directory, written when it is not there as it should be (which makes the directory). */
async function ensureScript($: EngineInterface, name: string, text: string, isQuiet = false): Promise<string> {
  const path = `${await runsPath($)}/${name}`
  if ((await $.fs.read(path).catch(() => undefined)) !== text) await write($, path, text, isQuiet)
  return path
}

/** Runs one of the mod's PowerShell scripts with -File: its text never crosses a command line. */
async function runScript($: EngineInterface, name: string, text: string, args: readonly string[], timeoutMs = 10_000, isQuiet = false) {
  const path = await ensureScript($, name, text, isQuiet)
  return run($, [await powershell($), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args], { timeoutMs }, isQuiet)
}

async function homeDir($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  if (!(await isWindows($))) return home ?? '/root'
  // Git Bash hands on HOME as /c/Users/...; without a usable one the profile folder is home. Native form either way.
  return winPath(home !== undefined && isWinAbsolute(home) ? home : ((await $.env.get('USERPROFILE')) ?? ''))
}

/** A path from the settings with `~` expanded; on Windows in the native form the mod stores. */
async function settingPath($: EngineInterface, setting: string): Promise<string> {
  const path = expandHome(setting, await homeDir($))
  return (await isWindows($)) ? winPath(path) : path
}

async function registryPath($: EngineInterface): Promise<string> {
  return settingPath($, config.registrySetting)
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
  await write($, tmp, text)
  if (expected !== undefined && (await $.fs.read(path).catch(() => undefined)) !== expected) {
    await removeFile($, tmp)
    return false
  }
  await renameOver($, tmp, path, text)
  return true
}

/** Removes a file: `rm -f` on Linux; on Windows the file script, best effort. Answers whether it went. */
async function removeFile($: EngineInterface, path: string, isQuiet = false): Promise<boolean> {
  if (await isWindows($)) {
    const ran = await runScript($, 'files.ps1', FILES_PS1, ['remove', path], 10_000, isQuiet).catch((err: unknown) => {
      if (!isQuiet) traceError($, 'remove', err)
      return undefined
    })
    return ran?.exitCode === 0
  }
  await run($, ['rm', '-f', path], { timeoutMs: 5_000 }, isQuiet)
  return true
}

/**
 * Puts the temp file in the file's place: `mv -f` on Linux. On Windows the file script; when it cannot run or fails,
 * the text is written over the file directly (the caller has checked it is still the one expected), and that write,
 * which a reader can see half done, is reported once.
 */
async function renameOver($: EngineInterface, tmp: string, path: string, text: string): Promise<void> {
  if (!(await isWindows($))) {
    const ran = await run($, ['mv', '-f', tmp, path], { timeoutMs: 5_000 })
    if (ran.exitCode !== 0) throw new Error(`rename failed (exit ${ran.exitCode}): ${ran.stderr.slice(0, 100)}`)
    return
  }
  const ran = await runScript($, 'files.ps1', FILES_PS1, ['move', tmp, path]).catch((err: unknown) => {
    traceError($, 'rename', err)
    return { exitCode: -1, stderr: String(err) }
  })
  if (ran.exitCode === 0) return
  await write($, path, text)
  // The script's own remove; when that cannot run either, $.fs (which cannot remove) empties the temp file instead.
  const isRemoved = await removeFile($, tmp)
  if (!isRemoved) await write($, tmp, '')
  if (!isDirectWriteNoted) {
    isDirectWriteNoted = true
    const leftover = isRemoved ? '' : `; the temp file ${tmp} could not be removed and was emptied`
    $.ui.toast(toastText(TOAST_TITLES.directWrite, `the rename failed (${ran.stderr.trim().slice(0, 100)}); ${path} was written directly, not atomically${leftover}`), { timeoutMs: 10000 })
  }
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

/**
 * Appends lines to a log file without reading it, so a log of any size takes them: APPEND_SCRIPT on Linux; on
 * Windows the lines go to a file of their own, which the file script appends and removes. Answers what went wrong.
 */
async function appendLog($: EngineInterface, path: string, lines: readonly string[], isQuiet = false): Promise<string | undefined> {
  const traceAppend = (exitCode: number) => {
    if (isTracing && !isQuiet) trace($, 'fs.append', { path, bytes: utf8Bytes(lines.join('\n')) + 1, lines: lines.length, exitCode })
  }
  if (!(await isWindows($))) {
    const ran = await run($, ['sh', '-c', APPEND_SCRIPT, 'session-log', lines.join('\n'), path], { timeoutMs: 10_000 }, isQuiet)
    traceAppend(ran.exitCode)
    return ran.exitCode === 0 ? undefined : `${path} cannot be appended to (exit ${ran.exitCode}): ${ran.stderr.slice(0, 100)}`
  }
  const added = `${path}.add.${await $.clock.now()}`
  await write($, added, lines.map(line => `${line}\n`).join(''), isQuiet)
  const ran = await runScript($, 'files.ps1', FILES_PS1, ['append', added, path], 10_000, isQuiet).catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
  traceAppend(ran.exitCode)
  if (ran.exitCode === 0) return undefined
  await removeFile($, added, isQuiet)
  return `${path} cannot be appended to (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 100)}`
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
  if (await isWindows($)) {
    // $.fs.write makes the directories; a file that is there but cannot be read is left alone.
    if (!(await $.fs.exists(path).catch(() => true))) await write($, path, initial)
    return
  }
  if ((await run($, ['test', '-e', path], { timeoutMs: 5_000 })).exitCode === 0) return
  await run($, ['mkdir', '-p', dirOf(path)], { timeoutMs: 5_000 })
  await write($, path, initial)
}

/** Fresh environment: the helper files, the backup directory and the runs directory exist before anything reads them. */
async function ensureHelperFiles($: EngineInterface): Promise<void> {
  for (const file of ['open-points.json', 'task-queue.json', 'agreed-decisions.md', 'open-points-archive.md']) {
    await ensureFile($, orchPath(file), file)
  }
  await ensureFile($, await registryPath($), 'headless-sessions.json')
  // On Windows writing the file script makes the runs directory; the backups directory comes with the first backup.
  if (await isWindows($)) await ensureScript($, 'files.ps1', FILES_PS1)
  else await run($, ['mkdir', '-p', orchPath('backups'), await runsPath($)], { timeoutMs: 5_000 })
}

/**
 * The process facts: PROBE_SCRIPT under sh on Linux; on Windows PROBE_PS1, which also looks for sessions files under
 * `configDirs`. A Windows probe that fails is an error: read as no process at all it would mark every worker dead.
 */
async function probe($: EngineInterface, entries: readonly SessionEntry[], configDirs: readonly string[] = []): Promise<ProcFacts> {
  if (await isWindows($)) {
    const ran = await runScript($, 'probe.ps1', PROBE_PS1, [...probeArgs(entries), ...configDirs.map(dir => `c:${dir}`)], 20_000)
    if (ran.exitCode !== 0) throw new Error(`the process probe failed (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 160)}`)
    return parseProcFacts(ran.stdout.replace(/\r/g, ''))
  }
  const ran = await run($, ['sh', '-c', PROBE_SCRIPT, 'session-probe', ...probeArgs(entries)], {
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

/** Re-read the tail of the watched worker's transcript into the pane's atom. */
async function refreshWatch($: EngineInterface): Promise<void> {
  const sid = await read($, selected)
  if (!isActive || sid === null) return
  const parsed = parseRegistry(await readRegistryText($))
  const entry = parsed.ok ? parsed.entries.find(one => one.session_id === sid) : undefined
  const path = entry === undefined ? undefined : transcriptPath(entry, await isWindows($))
  const title = entry?.title ?? sid.slice(0, 8)
  if (path === undefined) {
    await update($, watch, () => ({ title, lines: ['no transcript path for this entry'] }))
    return
  }
  const tail = await transcriptTail($, path)
  const lines = tail === undefined ? [`cannot read ${path}`] : summarizeTranscript(tail, 300)
  const next = { title, lines }
  if (!isSame(await read($, watch), next)) await update($, watch, () => next)
}

/**
 * The last 600 lines of a transcript, each cut to 20000 characters, so one huge tool result cannot push the newest
 * rows out: tail and cut on Linux; on Windows a read, or the file script for a transcript over the read cap.
 */
async function transcriptTail($: EngineInterface, path: string): Promise<string | undefined> {
  if (!(await isWindows($))) {
    const ran = await run($, ['sh', '-c', 'tail -n 600 "$1" | cut -c1-20000', 'session-tail', path], { timeoutMs: 5_000 })
    return ran.exitCode === 0 ? ran.stdout : undefined
  }
  const text = await $.fs.read(path).catch(() => undefined)
  if (text !== undefined) return tailLines(text, 600, 20000)
  const ran = await runScript($, 'files.ps1', FILES_PS1, ['tail', path, '600', '20000']).catch((err: unknown) => {
    traceError($, 'transcript tail', err)
    return undefined
  })
  return ran?.exitCode === 0 ? ran.stdout : undefined
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
async function retire($: EngineInterface, ids: readonly string[]) {
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const queueText = await $.fs.read(orchPath('task-queue.json')).catch(() => '')
  const verdict = retireVerdict(reg.entries, reg.facts, queueText, ids)
  trace($, 'guard', { tool: 'retire_workers', removable: verdict.removable, refused: verdict.refused })
  if (verdict.removable.length > 0) {
    const log = `${await runsPath($)}/cleared.jsonl`
    // The removed entries are logged before the registry is written; a second attempt logs only what is new.
    const logged = new Set<string>()
    const failed = await editRegistry($, async text => {
      const edited = removeEntries(text, verdict.removable)
      if (!edited.ok) return edited
      const lines = edited.removed.split('\n').filter(line => line !== '' && !logged.has(line))
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
  return { result: `Retired: ${removed}.${refused}` }
}

async function launch($: EngineInterface, given: LaunchArgs) {
  const isWin = await isWindows($)
  // On Windows the schema's leading / is Git Bash's /c/...: from here on, and in the registry, the native C:/... form.
  const native = (path: unknown) => (typeof path === 'string' ? winPath(path) : path) as string
  const args = isWin ? { ...given, dir: native(given.dir), prompt_file: native(given.prompt_file) } : given
  const home = await homeDir($)
  const reg = await registryAndFacts($)
  if ('deny' in reg) return reg
  const { promptFileOk, dirOk } = await launchChecks($, args, isWin)
  const promptText = await $.fs.read(args.prompt_file).catch(() => undefined)
  const resumeSid = typeof args.resume_sid === 'string' ? args.resume_sid : undefined
  // Without a picker command a fresh launch inherits the machine's default configuration: the orchestrator's own
  // CLAUDE_CONFIG_DIR when it has one, else <home>/.claude, which is what the registry records.
  const picker = config.licencePickCommand.trim()
  const own = await ownConfigDir($)
  const defaultDir = defaultConfigDir(home, own, isWin)
  let pick: { exitCode: number; stdout: string; stderr?: string } | undefined
  if (resumeSid === undefined && picker === '') pick = { exitCode: 0, stdout: defaultDir }
  else if (resumeSid === undefined) {
    const argv = pickArgv(picker, args.need ?? 40, home)
    if (isWin) {
      const refusal = windowsPickerRefusal(argv)
      if (refusal !== undefined) {
        trace($, 'guard', { tool: 'launch_worker', isOk: false, ...messageFields(refusal, 'reason') })
        return { deny: `${PLUGIN}: ${refusal}` }
      }
      argv[0] = winPath(argv[0] ?? '')
    }
    pick = await run($, argv, { timeoutMs: 20_000 }, false, shownPicker(argv))
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
    ...(isWin ? { isWindows: true, promptChars: promptText?.length, promptLead: promptText?.slice(0, 200) } : {}),
  })
  trace($, 'guard', verdict.ok ? { tool: 'launch_worker', isOk: true, configDir: verdict.configDir, resumeSid: verdict.resumeSid } : { tool: 'launch_worker', isOk: false, ...messageFields(verdict.reason, 'reason') })
  if (!verdict.ok) return { deny: `${PLUGIN}: ${verdict.reason}` }
  // No CLAUDE_CONFIG_DIR on the line: a fresh launch without a picker, or a resume under the default directory.
  const isConfigInherited = picker === '' && (verdict.resumeSid === undefined || isDefaultConfigDir(verdict.configDir, defaultDir, isWin))
  return spawnWorker($, args, { ...verdict, isConfigInherited }, reg.entries, reg.facts, own)
}

/** Whether the prompt file is there and not empty, and the dir is a directory: `test -s` and `test -d` on Linux, $.fs.stat on Windows. */
async function launchChecks($: EngineInterface, args: LaunchArgs, isWin: boolean): Promise<{ promptFileOk: boolean; dirOk: boolean }> {
  if (isWin) {
    const prompt = await $.fs.stat(args.prompt_file).catch(() => undefined)
    const dir = await $.fs.stat(args.dir).catch(() => undefined)
    return { promptFileOk: prompt?.kind === 'file' && prompt.size > 0, dirOk: dir?.kind === 'dir' }
  }
  const promptCheck = await run($, ['test', '-s', args.prompt_file], { timeoutMs: 5_000 })
  const dirCheck = await run($, ['test', '-d', args.dir], { timeoutMs: 5_000 })
  return { promptFileOk: promptCheck.exitCode === 0, dirOk: dirCheck.exitCode === 0 }
}

/** Waits a few seconds: `sleep` on Linux, the engine's clock on Windows, which has no sleep to start. */
async function pause($: EngineInterface, seconds: number): Promise<void> {
  if (await isWindows($)) await $.clock.sleep(seconds * 1000)
  else await run($, ['sleep', String(seconds)], { timeoutMs: 5_000 })
}

/** Start the worker as a background Bash task, find its real pid and session, register it. */
async function spawnWorker(
  $: EngineInterface,
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string; isConfigInherited?: boolean },
  entries: readonly SessionEntry[],
  before: ProcFacts,
  own: string | undefined,
) {
  const isWin = await isWindows($)
  const runsDir = await runsPath($)
  // The launch's redirections need the runs directory: mkdir on Linux; on Windows writing the file script makes it.
  if (isWin) await ensureScript($, 'files.ps1', FILES_PS1)
  else await run($, ['mkdir', '-p', runsDir], { timeoutMs: 5_000 })
  const nowMs = await $.clock.now()
  const stamp = new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const base = `${runsDir}/${stamp}-${slugify(args.title)}`
  const files = { result: `${base}.json`, err: `${base}.err` }
  const name = launchName(args.title, nowMs, entries, verdict.resumeSid, issuedNames)
  issuedNames.add(name)
  const command = buildLaunchArgv(args, { ...verdict, name }, files.result, files.err)[2] ?? ''
  const known = new Set(before.claude.map(one => one.pid))
  const launchedAt = await $.clock.now()
  trace($, 'worker.start', { configDir: verdict.configDir, isConfigDirSet: verdict.isConfigInherited !== true, resultFile: files.result, errFile: files.err, timeoutMs: launchTimeoutMs(args) })
  // The engine's own background task: its exit notification reaches the session.
  try {
    await $.tool.call({
      tool: 'Bash',
      command,
      description: `session-control worker: ${args.title}`.slice(0, 100),
      run_in_background: true,
      timeout: launchTimeoutMs(args),
    })
  } catch (err) {
    // On Windows the engine offers the Bash tool only when it finds Git Bash, which it may miss for a per-user Git
    // whose mingw64 git.exe comes first on the PATH (a session started from Git Bash).
    const hint = isWin ? ' On Windows Claude Code offers the Bash tool only when it finds Git Bash: start the orchestrator with CLAUDE_CODE_GIT_BASH_PATH set to Git\\bin\\bash.exe.' : ''
    trace($, 'error', { where: 'worker.start', ...messageFields(errorText(err)) })
    return { deny: `${PLUGIN}: the worker could not be started through the Bash tool (${errorText(err).slice(0, 160)}); nothing was launched.${hint}` }
  }
  let worker: ReturnType<typeof findNewWorker>
  for (let attempt = 0; attempt < 15 && worker === undefined; attempt++) {
    await pause($, 2)
    const facts = await probe($, entries, [verdict.configDir])
    // On Linux the probe reads the worker's CLAUDE_CONFIG_DIR from its environment: an inherited one is the
    // orchestrator's own, or none. On Windows it reads where the worker's sessions file is: the config dir itself.
    const seen = verdict.isConfigInherited === true && !isWin ? (own ?? '') : verdict.configDir
    const want = { dir: args.dir, configDir: seen, model: args.model }
    worker = isWin ? findNewWindowsWorker(facts, want, known, ((await $.clock.now()) - launchedAt) / 1000) : findNewWorker(facts, want, known)
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
    await pause($, 1)
  }
  // The socket can follow the session id by a moment: a few more reads, then the entry goes without it.
  for (let attempt = 0; attempt < 3 && fromFile.sessionId !== undefined && fromFile.socketPath === undefined; attempt++) {
    await pause($, 1)
    const again = sessionFileFacts(await $.fs.read(sessionPath).catch(() => ''))
    if (again.sessionId === fromFile.sessionId) fromFile = again
  }
  trace($, 'worker.found', { pid: worker.pid, sessionId, isNamed: fromFile.name !== undefined, isSocketSeen: fromFile.socketPath !== undefined })
  if (sessionId === '') return { result: `Worker pid ${worker.pid} started but its session id could not be read; registry NOT written.` }
  const inbox = { name: fromFile.name ?? name, ...(fromFile.socketPath === undefined ? {} : { socketPath: fromFile.socketPath }) }
  const entry = newRegistryEntry(args, verdict, worker.pid, sessionId, files, inbox, Math.floor(launchedAt / 1000))
  // A missing registry starts as an empty one, as REGISTER_SCRIPT starts it.
  const failed = await editRegistry($, async text => registerEntry(text, entry, verdict.resumeSid ? 'resume' : 'new'), freshText('headless-sessions.json'))
  const note = failed === undefined ? 'registered' : writeFailed(failed)
  trace($, 'worker.registered', { pid: worker.pid, sessionId, isRegistered: failed === undefined, ...(failed === undefined ? {} : messageFields(failed, 'reason')) })
  await refresh($)
  return {
    result: `Launched pid ${worker.pid}, session ${sessionId}, config_dir ${verdict.configDir}, ${note}. Name: ${inbox.name}; socket: ${inbox.socketPath ?? 'none'}. Result: ${files.result}; errors: ${files.err}.`,
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

/** session.start: register the command; in the orchestrator directory turn the board on. */
async function startSession($: EngineInterface, sessionCwd: string): Promise<void> {
  // /session-control is registered everywhere; the board starts by itself only in the orchestrator dir.
  await $.command.register({
    name: 'session-control',
    description: 'Session-control panel: open or close the side panel (sessions, queued work, open points)',
  })
  // Without the option, the orchestrator directory is the one whose CLAUDE.md is the orchestrator's.
  // On Windows both are taken in the native form and compared as Windows compares paths.
  const isWin = await isWindows($)
  const cwd = isWin ? winPath(sessionCwd) : sessionCwd.replace(/\/+$/, '')
  if (config.orchestratorDir === '' && (await $.fs.read(`${cwd}/CLAUDE.md`).catch(() => '')).startsWith(ORCHESTRATOR_HEADING)) {
    config.orchestratorDir = cwd
  }
  if (isWin && config.orchestratorDir !== '') config.orchestratorDir = winPath(config.orchestratorDir)
  const isHere = isWin ? isSameWinPath(cwd, config.orchestratorDir) : cwd === config.orchestratorDir.replace(/\/+$/, '')
  if (isTraceWanted) {
    // The picker command is a command line of its own: the trace says only whether one is set.
    const { pollMs, registrySetting, licencePickCommand, ...rest } = config
    const options = { ...rest, registryPath: registrySetting, pollSeconds: pollMs / 1000, licencePickCommand: licencePickCommand.trim() === '' ? 'empty' : 'set' }
    traceStart = { cwd, platform: isWin ? 'windows' : 'linux', isOrchestratorDir: config.orchestratorDir !== '' && isHere, options }
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
 * the mod's own result text, as traceMessage keeps them), then the lines written.
 */
async function tracedTool<T extends object>($: EngineInterface, tool: string, e: unknown, fields: readonly string[], work: () => Promise<T>): Promise<T> {
  if (isTracing) trace($, 'tool.call', { tool, ...pickFields(e, fields) })
  return traced($, async () => {
    const answer = await work()
    if (isTracing) {
      const text = 'deny' in answer ? messageFields(String(answer.deny), 'deny') : 'result' in answer ? { result: traceMessage(String(answer.result), TRACE_MAX_STRING) } : {}
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
  config = {
    orchestratorDir: String(options.orchestratorDir ?? ''),
    registrySetting: String(options.registryPath ?? config.registrySetting),
    completionWrites: options.completionWrites === true,
    pollMs: Math.max(1, Number(options.pollSeconds ?? 5)) * 1000,
    runsDir: String(options.runsDir ?? config.runsDir),
    licencePickCommand: String(options.licencePickCommand ?? ''),
    debug: options.debug === true,
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
    const input = e as unknown as { session_ids?: unknown }
    return tracedTool($, 'retire_workers', e, ['session_ids'], () => retire($, (input.session_ids as string[] | undefined) ?? []))
  }).catch(($, e, next) => {
    traceError($, 'retire_workers', next.error?.message ?? next.error?.kind)
    return next.called ? next(e) : { deny: `${PLUGIN}: retire_workers failed` }
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
