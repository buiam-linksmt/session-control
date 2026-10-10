// Pure parts of the read-only inspection tools (list_sessions, read_result, worker_tail, session_writes,
// panel_snapshot): their schemas and the plain text each answers with. No `$`, no I/O: register.tsx reads the
// registry, the probe, the run files, the transcripts and the listing, and hands them here. Every text that comes from
// a file (titles, outcome summaries, reports, transcript lines, open points, file names) goes through `clean`: the
// debug trace's redaction (trace.ts), and no terminal control characters. The mod's own identifiers, a session id and
// a session name in the forms the engine and the launch give them, are shown as they are (shownSessionId, shownName).
// Every answer is bounded.

import type { SessionEntry, SessionRow, SessionRowStatus, SessionSnapshot } from '../types'
import { classifyResult, elapsedSeconds, formatAge, formatHeader, formatRow, isGeneratedName, paneWidths, statusLabel, rowStatus, winPath, wrapText } from './core'
import type { PresentedPoint, ProcFacts, QueuedTask } from './core'
import type { NewerFiles } from './host'
import { REDACTED, redact } from './trace'

// ---------------------------------------------------------------- schemas

const SESSION_ID = {
  type: 'string',
  minLength: 8,
  maxLength: 36,
  pattern: '^[0-9a-fA-F-]+$',
  description: 'Session id of a registry entry: the full id, or its first 8 characters.',
} as const

export const LIST_SESSIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    include_finished: { type: 'boolean', description: 'false leaves out the finished rows (finished, finished-unreported, finished-unharvested). Default true.' },
  },
} as const

export const READ_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session_id'],
  properties: {
    session_id: SESSION_ID,
    max_chars: { type: 'integer', minimum: 500, maximum: 50000, description: 'The most characters of the report returned; the head is kept (default 12000).' },
  },
} as const

export const WORKER_TAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session_id'],
  properties: {
    session_id: SESSION_ID,
    lines: { type: 'integer', minimum: 1, maximum: 200, description: 'How many summarised transcript lines (default 40, at most 200).' },
  },
} as const

export const SESSION_WRITES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session_id'],
  properties: { session_id: SESSION_ID },
} as const

export const PANEL_SNAPSHOT_SCHEMA = { type: 'object', additionalProperties: false, properties: {} } as const

/** read_result's default and its bounds. */
export const READ_RESULT_CHARS = { default: 12000, min: 500, max: 50000 } as const
/** worker_tail's default and its most lines. */
export const TAIL_LINES = { default: 40, max: 200 } as const
/** An assistant message at least this long (trimmed) is a report, not chatter. */
export const SUBSTANTIAL_CHARS = 200
/** The most rows list_sessions and panel_snapshot list per section. */
export const MAX_ROWS = 100
/** The most characters of any one answer: what passes is cut with a note. */
export const MAX_ANSWER_CHARS = 60000

// ---------------------------------------------------------------- text

/** ANSI escape sequences (CSI, OSC and two-character ones) and the other control characters but tab and line feed. */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g

/** Text with no terminal control: escape sequences go, any other control character but tab and line feed becomes a blank. */
export function plainText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ANSI, '').replace(CONTROL, ' ')
}

/** A text through the trace's redaction, with the number of replacements it made. */
export function redactCounted(text: string): { text: string; count: number } {
  const out = redact(text)
  return { text: out, count: Math.max(0, occurrences(out, REDACTED) - occurrences(text, REDACTED)) }
}

function occurrences(text: string, part: string): number {
  let count = 0
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count++
  return count
}

/** Free text from a file as an answer shows it: no terminal control, redacted. */
export function clean(text: string): string {
  return redact(plainText(text))
}

/** A free text on one line, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = clean(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A session id as the engine gives it: a UUID. */
const SESSION_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * A registry entry's session id as an answer shows it: a UUID as it is, never redacted (the engine made it); anything
 * else in the field is free text, cleaned and cut like a title.
 */
export function shownSessionId(value: string): string {
  return SESSION_UUID.test(value) ? value : oneLine(value, 80)
}

/**
 * A registry entry's session name as an answer shows it: a name of the form the launch generates, whole
 * (`w-<slug>-<yyMMddHHmmss>` with its `-2` suffix when taken: GENERATED_NAME, at most 64 characters) as it is, never
 * redacted: the redaction takes such a long run of letters and digits for a token. Anything else in the field, a name
 * without the generated stamp included, is free text, cleaned and cut.
 */
export function shownName(value: string): string {
  return isGeneratedName(value) ? value : oneLine(value, 300)
}

/** The head of a text: at most `max` characters, and how many were cut. */
export function headOf(text: string, max: number): { text: string; cut: number } {
  return text.length <= max ? { text, cut: 0 } : { text: text.slice(0, max), cut: text.length - max }
}

/** An answer held to MAX_ANSWER_CHARS: what passes is cut, and the cut is said. */
export function bounded(text: string, max = MAX_ANSWER_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[answer cut: ${text.length - max} more characters not shown]`
}

/** Epoch milliseconds as ISO 8601 UTC to the second. */
export function isoSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const money = (usd: number | undefined) => (usd === undefined ? '-' : `USD ${usd.toFixed(2)}`)

// ---------------------------------------------------------------- the session asked

export type SessionMatch = { entry: SessionEntry & { session_id: string } } | { error: string }

/**
 * The registry entry a session id names: the full id, or its first characters (at least 8). Two entries that both
 * start with the characters given are named by neither: the answer says so.
 */
export function matchSession(entries: readonly SessionEntry[], id: string): SessionMatch {
  const key = id.trim().toLowerCase()
  const hits = entries.filter(
    (one): one is SessionEntry & { session_id: string } => typeof one.session_id === 'string' && (one.session_id.toLowerCase() === key || one.session_id.toLowerCase().startsWith(key)),
  )
  const exact = hits.find(one => one.session_id.toLowerCase() === key)
  if (exact !== undefined) return { entry: exact }
  if (key.length < 8 || hits.length === 0) return { error: `no registry entry has the session id ${oneLine(id, 40)} (give the full id or its first 8 characters; list_sessions shows the registry)` }
  if (hits.length > 1) return { error: `${hits.length} registry entries start with ${oneLine(id, 40)}: give more of the id (${hits.map(one => shownSessionId(one.session_id)).join(', ')})` }
  return { entry: hits[0] as SessionEntry & { session_id: string } }
}

/** One line naming the session: its id and title. */
function heading(tool: string, entry: SessionEntry & { session_id: string }): string {
  return `${tool} for session ${shownSessionId(entry.session_id)} "${oneLine(typeof entry.title === 'string' ? entry.title : '(untitled)', 120)}"`
}

/** Whether the entry's recorded pid is its live process, said as a line. */
function processLine(entry: SessionEntry, facts: ProcFacts): string {
  const status = rowStatus(entry, facts)
  if (status === 'alive') return `process: alive, pid ${entry.pid}`
  if (typeof entry.pid === 'number') return `process: not alive (pid ${entry.pid} recorded, gone or another process now; the mod has not harvested its exit yet)`
  return 'process: not alive (no pid recorded: finished or never started)'
}

// ---------------------------------------------------------------- list_sessions

/**
 * The registry entry of each row of buildRows (undefined for an orphan). A row with a session id is its entry; the
 * rows without one keep the registry's order within their status (buildRows sorts by status only, stably), so they
 * are matched in that order to the entries without one of the same status.
 */
export function rowEntries(rows: readonly SessionRow[], entries: readonly SessionEntry[], facts: ProcFacts): (SessionEntry | undefined)[] {
  const bySid = new Map<string, SessionEntry>()
  for (const entry of entries) if (typeof entry.session_id === 'string' && entry.session_id !== '' && !bySid.has(entry.session_id)) bySid.set(entry.session_id, entry)
  const waiting = new Map<SessionRowStatus, SessionEntry[]>()
  for (const entry of entries) {
    if (typeof entry.session_id === 'string' && entry.session_id !== '') continue
    const status = rowStatus(entry, facts)
    waiting.set(status, [...(waiting.get(status) ?? []), entry])
  }
  return rows.map(row => (row.status === 'orphan' ? undefined : row.sid !== undefined ? bySid.get(row.sid) : waiting.get(row.status)?.shift()))
}

const FINISHED: readonly SessionRowStatus[] = ['dead', 'unreported', 'done']

/** The statuses in the order list_sessions counts them. */
const COUNT_ORDER: readonly SessionRowStatus[] = ['alive', 'dead', 'unreported', 'done', 'queued', 'orphan']

/**
 * list_sessions' answer: a count line, then one line per row of the panel's row builder, the registry entries with
 * their fields and the orphans (live headless claude processes no entry claims, licence probes left out) with their
 * process facts. `nowSec` is the probe's time.
 */
export function listSessionsText(rows: readonly SessionRow[], entries: readonly SessionEntry[], facts: ProcFacts, nowSec: number, includeFinished: boolean): string {
  const counts = COUNT_ORDER.map(status => [status, rows.filter(row => row.status === status).length] as const).filter(([, n]) => n > 0)
  const summary = counts.length === 0 ? 'no rows' : counts.map(([status, n]) => `${n} ${status === 'orphan' ? 'orphan' : statusLabel(status)}`).join(', ')
  const shown = includeFinished ? rows : rows.filter(row => !FINISHED.includes(row.status))
  const hidden = rows.length - shown.length
  const lines = [`${rows.length} session row${rows.length === 1 ? '' : 's'}: ${summary}.${hidden > 0 ? ` ${hidden} finished row${hidden === 1 ? '' : 's'} left out (include_finished false).` : ''}`]
  const owners = rowEntries(rows, entries, facts)
  const clock = { nowSec, probedSec: nowSec }
  shown.slice(0, MAX_ROWS).forEach(row => {
    const sec = elapsedSeconds(row, clock)
    const elapsed = sec === undefined ? '-' : formatAge(sec)
    if (row.status === 'orphan') {
      const proc = facts.claude.find(one => one.pid === row.pid)
      lines.push(`- orphan (no registry entry) | pid ${row.pid ?? '?'} | age ${elapsed} | cwd ${oneLine(proc?.cwd || '?', 300)} | config_dir ${oneLine(row.configDir, 300)}`)
      return
    }
    const entry = owners[rows.indexOf(row)] ?? {}
    const outcome = entry.outcome as { kind?: unknown; summary?: unknown } | undefined
    const outcomeText = outcome === undefined ? '-' : `${String(outcome.kind)}${typeof outcome.summary === 'string' ? ` (${oneLine(outcome.summary, 200)})` : ''}`
    const field = (value: unknown) => (typeof value === 'string' && value !== '' ? oneLine(value, 300) : '-')
    lines.push(
      [
        `- ${statusLabel(row.status)}`,
        oneLine(row.title, 120),
        `session_id ${row.sid === undefined ? '-' : shownSessionId(row.sid)}`,
        `name ${typeof entry.name === 'string' && entry.name !== '' ? shownName(entry.name) : '-'}`,
        `pid ${row.pid ?? '-'}`,
        `elapsed ${elapsed}`,
        `model ${oneLine(row.model, 40)}/${oneLine(row.effort, 20)}`,
        `cwd ${field(entry.cwd)}`,
        `config_dir ${oneLine(row.configDir, 300)}`,
        `outcome ${outcomeText}`,
        `cost ${money(row.costUsd)}`,
        ...(entry.keep === true ? ['keep'] : []),
      ].join(' | '),
    )
  })
  if (shown.length > MAX_ROWS) lines.push(`(${shown.length - MAX_ROWS} more rows not shown)`)
  return bounded(lines.join('\n'))
}

// ---------------------------------------------------------------- read_result

type TranscriptMessage = { text: string; at?: string }

/**
 * The assistant messages of a transcript's text (whole, or a tail whose first line may be cut and is then passed
 * over), in order: the text blocks of one API message (the rows sharing its message id) joined; a subagent's rows
 * (isSidechain) left out.
 */
export function assistantMessages(transcript: string): TranscriptMessage[] {
  const out: (TranscriptMessage & { id?: string })[] = []
  for (const raw of transcript.split('\n')) {
    if (raw.trim() === '') continue
    let row: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { id?: unknown; content?: unknown } }
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object' || row.type !== 'assistant' || row.isSidechain === true) continue
    const content = row.message?.content
    const texts = Array.isArray(content)
      ? content.filter((block): block is { type: string; text: string } => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string').map(block => block.text)
      : typeof content === 'string'
        ? [content]
        : []
    if (texts.length === 0) continue
    const id = typeof row.message?.id === 'string' ? row.message.id : undefined
    const at = typeof row.timestamp === 'string' ? row.timestamp : undefined
    const last = out.at(-1)
    if (id !== undefined && last?.id === id) last.text = `${last.text}\n\n${texts.join('\n\n')}`
    else out.push({ id, text: texts.join('\n\n'), ...(at === undefined ? {} : { at }) })
  }
  return out.map(({ text, at }) => (at === undefined ? { text } : { text, at }))
}

/** The last substantial assistant message (SUBSTANTIAL_CHARS or more), and how many shorter ones came after it. */
export function lastReport(transcript: string): { message: TranscriptMessage; after: number } | undefined {
  const messages = assistantMessages(transcript)
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at] as TranscriptMessage
    if (message.text.trim().length >= SUBSTANTIAL_CHARS) return { message: { ...message, text: message.text.trim() }, after: messages.length - 1 - at }
  }
  return undefined
}

/** What register.tsx read for read_result. */
export type ResultFacts = {
  entry: SessionEntry & { session_id: string }
  facts: ProcFacts
  /** The result file's text; undefined when the entry names none or it cannot be read. */
  resultText?: string
  /** Why there is no result text, when there is none. */
  resultMissing?: string
  errText: string
  /** The transcript's text (whole, or its tail), and which; undefined when it cannot be read. */
  transcript?: { text: string; isWhole: boolean }
  /** Why there is no transcript text, when there is none. */
  transcriptMissing?: string
  maxChars: number
}

/** The fields of a result file read for the answer; undefined when it is no JSON object. */
function resultFields(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * read_result's answer: the worker's final report from the result file's `.result`; when that is chatter (the label
 * classifyResult gives an empty or short result after a substantial run) or there is no result to read, the last
 * substantial assistant message of the transcript. It says the source, the outcome, the run's figures, how many
 * replacements the redaction made and what the cut left out; the report is redacted, then its head kept.
 */
export function readResultText(input: ResultFacts): string {
  const { entry } = input
  const fields = input.resultText === undefined ? undefined : resultFields(input.resultText)
  const outcome = input.resultText === undefined || input.resultText.trim() === '' ? undefined : classifyResult(input.resultText, undefined, input.errText)
  const stored = entry.outcome as { kind?: unknown; summary?: unknown } | undefined
  const result = typeof fields?.result === 'string' ? fields.result : undefined
  const isChatter = outcome?.kind === 'chatter'
  const lines = [heading('read_result', entry), processLine(entry, input.facts)]
  // The source: the stored report, unless it is chatter or missing; then the transcript's last substantial message.
  let report: string | undefined
  let source: string
  const noResult = input.resultText === undefined ? (input.resultMissing ?? 'no result file') : fields === undefined ? 'the result file is no JSON (cut off, or empty)' : result === undefined ? 'the result file has no .result text' : undefined
  if (!isChatter && noResult === undefined && result !== undefined) {
    report = result
    source = 'source: the result file .result'
  } else {
    const why = isChatter ? `the result file .result is chatter (${oneLine(result ?? '', 80) || 'empty'})` : (noResult ?? 'no result')
    const found = input.transcript === undefined ? undefined : lastReport(input.transcript.text)
    if (found !== undefined) {
      report = found.message.text
      const where = input.transcript?.isWhole === true ? 'the transcript' : "the transcript's tail"
      const when = found.message.at === undefined ? '' : `, written ${oneLine(found.message.at, 40)}`
      const later = found.after === 0 ? '' : `; ${found.after} shorter assistant message${found.after === 1 ? '' : 's'} came after it`
      source = `source: ${where}, its last substantial assistant message (${SUBSTANTIAL_CHARS} characters or more${when}${later}), because ${why}`
    } else if (result !== undefined && result.trim() !== '') {
      report = result
      source = `source: the result file .result, though ${why}: ${input.transcript === undefined ? `the transcript cannot be read (${input.transcriptMissing ?? 'no path'})` : 'the transcript has no substantial assistant message'}`
    } else {
      source = `source: none: ${why}, and ${input.transcript === undefined ? `the transcript cannot be read (${input.transcriptMissing ?? 'no path'})` : 'the transcript has no substantial assistant message'}`
    }
  }
  lines.push(source)
  const storedText = stored === undefined ? '' : ` (registry: ${String(stored.kind)})`
  lines.push(outcome === undefined ? `outcome: ${stored === undefined ? 'none yet' : `${String(stored.kind)} (registry)`}` : `outcome: ${oneLine(outcome.summary, 200)}${stored !== undefined && stored.kind !== outcome.kind ? storedText : ''}`)
  if (fields !== undefined) {
    const num = (key: string) => (typeof fields[key] === 'number' ? (fields[key] as number) : undefined)
    const duration = num('duration_ms')
    const run = [
      `cost ${money(num('total_cost_usd'))}`,
      `duration ${duration === undefined ? '-' : formatAge(duration / 1000)}`,
      `turns ${num('num_turns') ?? '-'}`,
      `is_error ${typeof fields.is_error === 'boolean' ? String(fields.is_error) : '-'}`,
      `subtype ${typeof fields.subtype === 'string' ? oneLine(fields.subtype, 40) : '-'}`,
    ]
    lines.push(`run: ${run.join(', ')}`)
  }
  if (report === undefined) return bounded(lines.join('\n'))
  const redacted = redactCounted(plainText(report))
  const head = headOf(redacted.text, input.maxChars)
  lines.push(`redaction: ${redacted.count} replacement${redacted.count === 1 ? '' : 's'} (each shows as ${REDACTED})`)
  lines.push(head.cut === 0 ? `truncated: no (${redacted.text.length} characters)` : `truncated: yes, the first ${input.maxChars} of ${redacted.text.length} characters kept, ${head.cut} cut`)
  lines.push('--- report ---', head.text, '--- end of report ---')
  return lines.join('\n')
}

// ---------------------------------------------------------------- worker_tail

/** worker_tail's answer: the process, the transcript's age, and its last lines as the log pane summarises them, redacted. */
export function workerTailText(input: {
  entry: SessionEntry & { session_id: string }
  facts: ProcFacts
  path?: string
  /** Seconds since the transcript was last written; undefined when unknown. */
  ageSec?: number
  /** summarizeTranscript's lines; undefined when the transcript cannot be read. */
  lines?: readonly string[]
  wanted: number
}): string {
  const out = [heading('worker_tail', input.entry), processLine(input.entry, input.facts)]
  if (input.path === undefined) {
    out.push('transcript: the entry lacks the config_dir, cwd or session_id that place it')
    return out.join('\n')
  }
  const sec = input.ageSec === undefined ? undefined : Math.floor(input.ageSec)
  const age = sec === undefined ? 'last write unknown' : `last written ${sec} s ago${sec >= 60 ? ` (${formatAge(sec)})` : ''}`
  out.push(`transcript: ${oneLine(input.path, 400)}, ${age}`)
  if (input.lines === undefined) {
    out.push('the transcript cannot be read')
    return out.join('\n')
  }
  let count = 0
  const shown = input.lines.map(line => {
    const one = redactCounted(plainText(line))
    count += one.count
    return one.text
  })
  out.push(`last ${shown.length} line${shown.length === 1 ? '' : 's'} (of ${input.wanted} asked), summarised as the panel's log shows them; redaction: ${count} replacement${count === 1 ? '' : 's'}:`)
  out.push(...(shown.length === 0 ? ['(no readable assistant text, tool call or tool result in the tail)'] : shown))
  return bounded(out.join('\n'))
}

// ---------------------------------------------------------------- session_writes

/** The first `timestamp` of a transcript's rows, in epoch milliseconds; undefined when none parses. */
export function firstTimestamp(transcript: string): number | undefined {
  for (const raw of transcript.split('\n')) {
    if (raw.trim() === '') continue
    let row: { timestamp?: unknown }
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    const ms = typeof row?.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

/** Whether a path is the directory or under it, compared as the platform compares paths. */
export function isUnder(path: string, dir: string, isWindows: boolean): boolean {
  const norm = (p: string) => (isWindows ? winPath(p).toLowerCase() : p).replace(/\/+$/, '')
  const base = norm(dir)
  const one = norm(path)
  return base !== '' && (one === base || one.startsWith(`${base}/`))
}

/** Whether two paths name the same file, compared as the platform compares paths. */
export function isSamePath(a: string, b: string, isWindows: boolean): boolean {
  return isWindows ? winPath(a).toLowerCase() === winPath(b).toLowerCase() : a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/** The file tools whose `file_path` is a write. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The transcript's tool calls that write the registry or under the orchestrator directory (Write, Edit, MultiEdit,
 * NotebookEdit by their file_path), and the Bash or PowerShell commands that name either: one line each, at most 20.
 */
export function transcriptWrites(transcript: string, orchestratorDir: string, registryPath: string, isWindows: boolean): string[] {
  const out: string[] = []
  const names = (text: string) => {
    const lower = isWindows ? text.replace(/\\/g, '/').toLowerCase() : text
    const want = (p: string) => (isWindows ? winPath(p).toLowerCase() : p)
    return (orchestratorDir !== '' && lower.includes(want(orchestratorDir))) || lower.includes(want(registryPath))
  }
  for (const raw of transcript.split('\n')) {
    if (out.length >= 20 || !raw.includes('tool_use')) continue
    let row: { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } }
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    if (row?.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    for (const block of row.message.content as Record<string, unknown>[]) {
      if (block?.type !== 'tool_use') continue
      const input = (block.input ?? {}) as Record<string, unknown>
      const name = String(block.name)
      const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
      if (WRITE_TOOLS.has(name) && file !== undefined && (isSamePath(file, registryPath, isWindows) || (orchestratorDir !== '' && isUnder(file, orchestratorDir, isWindows)))) {
        out.push(`- ${name} of ${oneLine(file, 300)}${row.isSidechain === true ? ' (by a subagent)' : ''}`)
      } else if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string' && names(input.command)) {
        out.push(`- ${name} command naming it: ${oneLine(input.command, 240)}`)
      }
    }
  }
  return out
}

/** session_writes' answer: the start, the listing with its flags, the transcript's writes there. */
export function sessionWritesText(input: {
  entry: SessionEntry & { session_id: string }
  /** The start in epoch ms and where it came from. */
  start: { ms: number; source: string }
  listing: NewerFiles | undefined
  orchestratorDir: string
  registryPath: string
  isWindows: boolean
  /** The transcript's text and which part; undefined when it cannot be read. */
  transcript?: { text: string; isWhole: boolean }
}): string {
  const { entry, listing } = input
  const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
  const out = [heading('session_writes', entry), `cwd: ${oneLine(cwd, 400)}`, `since: ${isoSecond(input.start.ms)} (${input.start.source}; fractional seconds dropped)`]
  if (listing === undefined) {
    out.push(`the files under ${oneLine(cwd, 400)} cannot be listed (the directory is not there, or the listing failed)`)
  } else {
    const flags = (path: string) => [
      ...(input.orchestratorDir !== '' && isUnder(path, input.orchestratorDir, input.isWindows) ? ['ORCHESTRATOR DIR'] : []),
      ...(isSamePath(path, input.registryPath, input.isWindows) ? ['REGISTRY'] : []),
    ]
    const rows = listing.files.map(file => ({ file, flags: flags(file.path) }))
    const flagged = rows.filter(row => row.flags.length > 0)
    const shown = listing.total > listing.files.length ? `, the newest ${listing.files.length} shown` : ''
    out.push(`${listing.total} file${listing.total === 1 ? '' : 's'} under the cwd written since then${shown}, newest first; .git and symbolic links left out. By mtime: a write by any other process in that tree shows too.`)
    const orch = input.orchestratorDir === '' ? 'no orchestrator directory set' : `${flagged.filter(row => row.flags.includes('ORCHESTRATOR DIR')).length} under the orchestrator directory ${oneLine(input.orchestratorDir, 300)}`
    out.push(`flagged among those shown: ${orch}; ${flagged.filter(row => row.flags.includes('REGISTRY')).length} the registry file ${oneLine(input.registryPath, 300)}`)
    for (const row of rows) out.push(`${isoSecond(row.file.mtimeMs)}  ${oneLine(row.file.path, 400)}${row.flags.length === 0 ? '' : `  [${row.flags.join(', ')}]`}`)
  }
  if (input.transcript === undefined) {
    out.push('transcript: cannot be read, so its writes outside the cwd are not checked')
  } else {
    const writes = transcriptWrites(input.transcript.text, input.orchestratorDir, input.registryPath, input.isWindows)
    const part = input.transcript.isWhole ? 'the whole transcript' : "the transcript's last 600 lines"
    out.push(writes.length === 0 ? `transcript (${part}): no write to the registry or under the orchestrator directory, and no command naming either` : `transcript (${part}): ${writes.length} call${writes.length === 1 ? '' : 's'} writing the registry or under the orchestrator directory, or naming either:`)
    out.push(...writes)
  }
  return bounded(out.join('\n'))
}

// ---------------------------------------------------------------- panel_snapshot

/** The panel's width this text is drawn at. */
export const SNAPSHOT_COLUMNS = 120

/** panel_snapshot's answer: the text of the three sections (and the open log), from the panel's own atoms and row builders. */
export function panelSnapshotText(input: {
  snap: SessionSnapshot | null
  queue: readonly QueuedTask[] | null
  points: readonly PresentedPoint[] | null
  selectedPoint: string | null
  /** The open log: the selected session's title and lines; null when none is open. */
  log: { title: string; lines: readonly string[] } | null
  expanded: string | null
  nowMs: number
}): string {
  const { snap } = input
  if (snap === null) return 'panel_snapshot: the panel has no rows yet (the board has not gathered once).'
  const width = SNAPSHOT_COLUMNS - 4
  const ago = Math.max(0, Math.round((input.nowMs - snap.at) / 1000))
  const out = [`panel_snapshot: the panel's text as of its last poll ${ago} s ago, at ${SNAPSHOT_COLUMNS} columns${input.expanded === null ? '' : `; the ${input.expanded} section is expanded`}${input.log === null ? '' : '; a log is open'}.`, '']
  const clock = { nowSec: Math.floor(input.nowMs / 1000), probedSec: Math.floor(snap.at / 1000) }
  const rows = snap.rows.map(row => ({ ...row, title: oneLine(row.title, 200) }))
  const widths = paneWidths(rows, width - 2, clock)
  out.push('SESSIONS')
  if (snap.error !== undefined) out.push(wrapText(`! session-control: ${oneLine(snap.error, 400)}`, width)[0] ?? '')
  out.push(`  ${formatHeader(width - 2, widths)}`)
  if (rows.length === 0) out.push('No workers in the registry.')
  for (const row of rows.slice(0, MAX_ROWS)) out.push(`  ${formatRow(row, width - 2, widths, clock)}`)
  if (rows.length > MAX_ROWS) out.push(`  (${rows.length - MAX_ROWS} more rows not shown)`)
  if (input.log !== null) {
    out.push('', `LOG ${oneLine(input.log.title, 100)}`)
    const lines = input.log.lines.slice(-40).flatMap(line => wrapText(clean(line), width).slice(0, 2))
    out.push(...(lines.length === 0 ? ['Waiting for output.'] : lines))
  }
  out.push('', 'QUEUED WORK')
  if (input.queue === null) out.push('task queue unreadable.')
  else if (input.queue.length === 0) out.push('none')
  else for (const task of input.queue.slice(0, MAX_ROWS)) wrapText(clean(task.running === true ? `${task.title} (running)` : task.title), width - 2).forEach((text, i) => out.push((i === 0 ? '• ' : '  ') + text))
  out.push('', 'OPEN POINTS')
  if (input.points === null) out.push('open points unreadable.')
  else if (input.points.length === 0) out.push('none')
  else {
    input.points.slice(0, MAX_ROWS).forEach((point, index) => {
      if (point.id === '' || point.id !== input.selectedPoint) {
        const row = `  ${index + 1}. ${clean(point.title)}`
        out.push(row.length > width ? `${row.slice(0, width - 1)}…` : row)
        return
      }
      wrapText(`${index + 1}. ${clean(point.title)}`, width - 2).forEach((text, i) => out.push((i === 0 ? '▸ ' : '  ') + text))
      if (point.detail !== '') wrapText(clean(point.detail), width - 4).forEach(text => out.push(`    ${text}`))
      if (point.recommendation !== '') wrapText(clean(`Recommendation: ${point.recommendation}`), width - 4).forEach(text => out.push(`    ${text}`))
    })
  }
  return bounded(out.join('\n'))
}
