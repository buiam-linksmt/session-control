// Pure functions of session-control: no `$`, no I/O. Everything they need is passed
// in (registry text, /proc facts as text, result-file text, clock), so tests
// run them on fixtures alone.

import type {
  SessionEntry,
  SessionOutcome,
  SessionOutcomeKind,
  SessionRow,
  SessionRowStatus,
} from '../types'

// ---------------------------------------------------------------- registry

export type RegistryParse = { ok: true; entries: SessionEntry[] } | { ok: false; error: string }

/** Parses the registry file's text: a JSON array of objects. Empty text is an empty registry. */
export function parseRegistry(text: string): RegistryParse {
  if (text.trim() === '') return { ok: true, entries: [] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `registry is not JSON: ${String(err).slice(0, 120)}` }
  }
  if (!Array.isArray(value)) return { ok: false, error: 'registry is not a JSON array' }
  const entries = value.filter(
    (one): one is SessionEntry => typeof one === 'object' && one !== null && !Array.isArray(one),
  )
  return { ok: true, entries }
}

// ---------------------------------------------------------------- /proc facts

export type ProcFact = {
  pid: number
  comm: string
  elapsedSec?: number
  cwd: string
  configDir: string
  cmdline: string
}

export type ProcFacts = {
  /** Every process named `claude` the probe saw. */
  claude: ProcFact[]
  /** comm of each registry pid that still exists (any name). */
  pidComm: Map<number, string>
  /**
   * Abort-check evidence per registry pid: /proc stat field 22 and the sessions file's own claim; on Linux also the
   * process state letter (field 3: `Z` a zombie), absent on Windows and from an older probe.
   */
  pidProof: Map<number, { startTicks: string; fileStart: string; fileSid: string; state?: string }>
  /** Newest transcript mtime (epoch seconds) per session id. */
  transcriptMtime: Map<string, number>
  /** Where the system temporary directory is (isE2eRunDir); set by the plugin's probe, absent: Linux with `/tmp` only. */
  temp?: TempPlaces
}

/** The system temporary directory: on Linux the paths in `dirs` (`/tmp` and `$TMPDIR`); on Windows any folder named `Temp`. */
export type TempPlaces = { isWindows: boolean; dirs: readonly string[] }

const LINUX_TEMP: TempPlaces = { isWindows: false, dirs: ['/tmp'] }

/** The probe's arguments for a registry: each recorded pid, each session's transcript. */
export function probeArgs(entries: readonly SessionEntry[]): string[] {
  const args: string[] = []
  for (const entry of entries) {
    if (typeof entry.pid === 'number') {
      const cfg = typeof entry.config_dir === 'string' && entry.config_dir !== '' ? entry.config_dir : '~'
      args.push(`pid:${entry.pid}|${cfg}`)
    }
    if (typeof entry.session_id === 'string' && typeof entry.config_dir === 'string') {
      args.push(`t:${entry.session_id}|${entry.config_dir}`)
    }
  }
  return args
}

/** Parses the probe's stdout; unknown or short lines are skipped. */
export function parseProcFacts(stdout: string): ProcFacts {
  const facts: ProcFacts = { claude: [], pidComm: new Map(), pidProof: new Map(), transcriptMtime: new Map() }
  for (const line of stdout.split('\n')) {
    const cols = line.split('\t')
    const tag = cols[0]
    if (tag === 'P' && cols.length >= 7) {
      const pid = Number(cols[1])
      if (!Number.isInteger(pid)) continue
      const elapsed = Number(cols[3])
      facts.claude.push({
        pid,
        comm: cols[2] ?? '',
        elapsedSec: cols[3] !== '' && Number.isFinite(elapsed) ? elapsed : undefined,
        cwd: cols[4] ?? '',
        configDir: cols[5] ?? '',
        cmdline: cols.slice(6).join(' ').trim(),
      })
    } else if (tag === 'A' && cols.length >= 3) {
      const pid = Number(cols[1])
      if (Number.isInteger(pid)) {
        facts.pidComm.set(pid, cols[2] ?? '')
        facts.pidProof.set(pid, { startTicks: cols[3] ?? '', fileStart: cols[4] ?? '', fileSid: cols[5] ?? '', ...(cols[6] === undefined || cols[6] === '' ? {} : { state: cols[6] }) })
      }
    } else if (tag === 'T' && cols.length >= 3) {
      const mtime = Number(cols[2])
      if (cols[1] && Number.isFinite(mtime)) facts.transcriptMtime.set(cols[1], mtime)
    }
  }
  return facts
}

/** Whether a command line is a headless worker (`claude -p` / `--print`). */
export function isHeadless(cmdline: string): boolean {
  return /(^|\s)(-p|--print)(\s|$)/.test(cmdline)
}

/** The prompts of the licence daemon's own headless runs: its usage probe and its token wake. */
const LICENCE_PROMPTS = new Set(['/usage', 'ok'])

/**
 * Whether a command line is one of the licence daemon's own short runs, `claude -p /usage --output-format json
 * --no-session-persistence` (the usage probe) or `claude -p ok --dangerously-skip-permissions` (the token wake), on
 * Linux (the probe joins the arguments with spaces) or Windows (`"C:\...\claude.exe" -p ok`). Read by the argument
 * structure: the word after `-p` is the whole prompt, and only options and their values follow it. A worker's prompt
 * that merely holds those words (`claude -p --model haiku ... -- <prompt>`, or a prompt that starts with them and goes
 * on with more words) is not one.
 */
export function isLicenceRun(cmdline: string): boolean {
  // The program goes first, a quoted Windows path whole; a word's own quotes are dropped.
  const words = cmdline
    .trim()
    .replace(/^"[^"]*"|^\S+/, '')
    .split(/\s+/)
    .filter(word => word !== '')
    .map(word => word.replace(/^(["'])(.*)\1$/, '$2'))
  const at = words.findIndex(word => word === '-p' || word === '--print')
  if (at < 0 || !LICENCE_PROMPTS.has(words[at + 1] ?? '')) return false
  // After the prompt: options, each with at most one value; `--` would start a prompt of its own.
  return words.slice(at + 2).every((word, i, rest) => word !== '--' && (word.startsWith('-') || (rest[i - 1] ?? '').startsWith('--')))
}

/** The scratch directory of an e2e script of the mod: `scratch(<prefix>)` in tests/lib/e2e.mjs names it `<prefix>.<random>`. */
const E2E_SCRATCH = /^session-control-e2e[-A-Za-z0-9_.]*$/

/**
 * Whether a cwd is the orchestrator or worker directory of one of the mod's own e2e runs: `<temp>/<scratch>/orch` or
 * `<temp>/<scratch>/work`, where `<scratch>` matches E2E_SCRATCH and `<temp>` is the system temporary directory (on
 * Linux exactly one of `temp.dirs`; on Windows a path whose last folder is `Temp` in any case, `\` and `/` both
 * separators). A cwd with a `.` or `..` folder in it is never one.
 */
export function isE2eRunDir(cwd: string, temp: TempPlaces = LINUX_TEMP): boolean {
  const sep = temp.isWindows ? /[\\/]+/ : /\/+/
  const parts = cwd.split(sep)
  if (parts.length > 1 && parts.at(-1) === '') parts.pop()
  if (parts.some(part => part === '.' || part === '..')) return false
  const [scratch, leaf] = parts.slice(-2)
  if (parts.length < 4 || (leaf !== 'orch' && leaf !== 'work') || !E2E_SCRATCH.test(scratch ?? '')) return false
  const above = parts.slice(0, -2)
  if (temp.isWindows) return above.at(-1)?.toLowerCase() === 'temp'
  const tidy = (dir: string) => dir.replace(/\/+/g, '/').replace(/\/+$/, '')
  return temp.dirs.some(dir => dir.startsWith('/') && tidy(dir) === above.join('/'))
}

// ---------------------------------------------------------------- rows

/**
 * Whether the entry's recorded pid is its live claude process: the Abort check,
 * `<config_dir>/sessions/<pid>.json` (sessionId, procStart) against /proc/<pid>/stat
 * field 22. `comm` is never the proof (it can be a version string). Without a
 * sessions file the pid is unverifiable and counts as not alive.
 */
export function isPidAlive(entry: SessionEntry, facts: ProcFacts): boolean {
  if (typeof entry.pid !== 'number') return false
  const proof = facts.pidProof.get(entry.pid)
  if (proof === undefined || proof.startTicks === '' || proof.fileStart === '') return false
  if (proof.fileStart !== proof.startTicks) return false
  return typeof entry.session_id !== 'string' || proof.fileSid === entry.session_id
}

export function rowStatus(entry: SessionEntry, facts: ProcFacts): SessionRowStatus {
  if (typeof entry.pid === 'number') return isPidAlive(entry, facts) ? 'alive' : 'dead'
  if (typeof entry.session_id !== 'string' || entry.session_id === '') return 'queued'
  if (entry.reported === false) return 'unreported'
  return 'done'
}

const STATUS_ORDER: Record<SessionRowStatus, number> = {
  alive: 0,
  dead: 1,
  orphan: 2,
  unreported: 3,
  queued: 4,
  done: 5,
}

/**
 * The orphans: each live headless claude process no registry entry claims (by its recorded pid) that is not one of the
 * licence daemon's own runs and does not run in an e2e script's scratch directory (isE2eRunDir). The one predicate of
 * the orphan rows, list_sessions and the orphan notice (notices.ts).
 */
export function orphanProcs(entries: readonly SessionEntry[], facts: ProcFacts): ProcFact[] {
  const claimed = new Set(entries.map(entry => entry.pid).filter((pid): pid is number => typeof pid === 'number'))
  return facts.claude.filter(
    proc => !claimed.has(proc.pid) && isHeadless(proc.cmdline) && !isLicenceRun(proc.cmdline) && !isE2eRunDir(proc.cwd, facts.temp),
  )
}

/** One row per registry entry, plus one per orphan (orphanProcs). */
export function buildRows(
  entries: readonly SessionEntry[],
  facts: ProcFacts,
  nowSec: number,
): SessionRow[] {
  const rows: SessionRow[] = []
  for (const entry of entries) {
    const sid = typeof entry.session_id === 'string' ? entry.session_id : ''
    const status = rowStatus(entry, facts)
    const proc = facts.claude.find(one => one.pid === entry.pid)
    const mtime = sid ? facts.transcriptMtime.get(sid) : undefined
    const outcome = entry.outcome as { costUsd?: unknown } | undefined
    rows.push({
      title: typeof entry.title === 'string' ? entry.title : '(untitled)',
      sid: sid === '' ? undefined : sid,
      sid8: sid.slice(0, 8),
      model: typeof entry.model === 'string' ? entry.model : '?',
      effort: typeof entry.effort === 'string' ? entry.effort : '?',
      configDir: typeof entry.config_dir === 'string' ? entry.config_dir : '?',
      status,
      pid: typeof entry.pid === 'number' ? entry.pid : undefined,
      elapsedSec: status === 'alive' ? proc?.elapsedSec : undefined,
      ...(typeof entry.started_at === 'number' ? { startedAt: entry.started_at } : {}),
      ...(typeof entry.ended_at === 'number' ? { endedAt: entry.ended_at } : {}),
      transcriptAgeSec: mtime === undefined ? undefined : Math.max(0, nowSec - mtime),
      costUsd: typeof outcome?.costUsd === 'number' ? outcome.costUsd : undefined,
    })
  }
  for (const proc of orphanProcs(entries, facts)) {
    rows.push({
      title: `(no entry) ${proc.cwd}`,
      sid8: '',
      model: '?',
      effort: '?',
      configDir: proc.configDir || '?',
      status: 'orphan',
      pid: proc.pid,
      elapsedSec: proc.elapsedSec,
    })
  }
  return rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
}

/** An elapsed time: `42s` under a minute, `5m12s` under an hour, `1h05m` from an hour up. */
export function formatAge(sec: number): string {
  const whole = Math.max(0, Math.floor(sec))
  const two = (n: number) => String(n).padStart(2, '0')
  if (whole < 60) return `${whole}s`
  if (whole < 3600) return `${Math.floor(whole / 60)}m${two(whole % 60)}s`
  return `${Math.floor(whole / 3600)}h${two(Math.floor((whole % 3600) / 60))}m`
}

/** The display clock of the elapsed column: now, and when the rows' probe ran (epoch seconds). */
export type ElapsedClock = { nowSec: number; probedSec: number }

/**
 * A row's elapsed seconds at the display clock: a running entry's time since its `started_at`; a finished entry's run,
 * `ended_at` less `started_at`; otherwise (an orphan, an entry from before `started_at`) the process age the probe
 * read, plus the time since that probe. Undefined when there is nothing to tell (a finished entry without both
 * times). Without a clock: the values as the probe left them.
 */
export function elapsedSeconds(row: SessionRow, clock?: ElapsedClock): number | undefined {
  if (row.status === 'alive' && row.startedAt !== undefined && clock !== undefined) return Math.max(0, clock.nowSec - row.startedAt)
  const isFinished = row.status === 'dead' || row.status === 'unreported' || row.status === 'done'
  if (isFinished && row.startedAt !== undefined && row.endedAt !== undefined) return Math.max(0, row.endedAt - row.startedAt)
  if (row.elapsedSec === undefined) return undefined
  return row.elapsedSec + (clock === undefined ? 0 : Math.max(0, clock.nowSec - clock.probedSec))
}

/** The words shown for each status. */
export function statusLabel(status: SessionRowStatus): string {
  if (status === 'alive') return 'running'
  if (status === 'dead') return 'finished-unharvested'
  if (status === 'unreported') return 'finished-unreported'
  if (status === 'done') return 'finished'
  return status
}

const GAP = '   '

export type PaneWidths = { title: number; sid: number; status: number; model: number; effort: number }

function elapsedText(row: SessionRow, clock?: ElapsedClock): string {
  const sec = elapsedSeconds(row, clock)
  return sec === undefined ? '-' : formatAge(sec)
}

/** Column widths from the content, so the columns sit close; the title takes what is left. */
export function paneWidths(rows: readonly SessionRow[], columns: number, clock?: ElapsedClock): PaneWidths {
  const widest = (header: string, cell: (row: SessionRow) => string) =>
    Math.max(header.length, ...rows.map(row => cell(row).length))
  const sid = widest('sid', row => row.sid8 || '-')
  const status = widest('status', row => statusLabel(row.status))
  const model = widest('model', row => row.model)
  const effort = widest('effort', row => row.effort)
  const elapsed = widest('elapsed', row => elapsedText(row, clock))
  const rest = sid + status + model + effort + elapsed + GAP.length * 5
  const wanted = widest('title', row => row.title)
  return { title: Math.max(12, Math.min(wanted, columns - rest)), sid, status, model, effort }
}

function fit(text: string, width: number): string {
  return text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text.padEnd(width)
}

function cut(line: string, columns: number): string {
  return line.length > columns ? line.slice(0, Math.max(1, columns - 1)) + '…' : line
}

/** One pane line for a row: title, status, model, effort, elapsed at the display clock; cut to `columns`. */
export function formatRow(row: SessionRow, columns: number, widths: PaneWidths = paneWidths([row], columns), clock?: ElapsedClock): string {
  return cut(
    [
      fit(row.title, widths.title),
      fit(row.sid8 || '-', widths.sid),
      fit(statusLabel(row.status), widths.status),
      fit(row.model, widths.model),
      fit(row.effort, widths.effort),
      elapsedText(row, clock),
    ].join(GAP),
    columns,
  )
}

/** The pane's column header, aligned with formatRow. */
export function formatHeader(columns: number, widths: PaneWidths): string {
  return cut(
    [fit('title', widths.title), fit('sid', widths.sid), fit('status', widths.status), fit('model', widths.model), fit('effort', widths.effort), 'elapsed'].join(GAP),
    columns,
  )
}

/** What separates the cells of a row on a surface that draws text in a proportional font (desktopRowText). */
const DESKTOP_SEP = ' \u00B7 '

/**
 * One pane line for a row on the desktop surface: formatRow's cells in its order (title, session id, status, model,
 * effort, elapsed at the display clock), whole, joined by ` · `, with no padding and no cut. The desktop draws text in a
 * proportional font, collapses runs of blanks and reports a width in cells that is not its own, so fixed cell widths
 * there cut the row; the surface wraps this text in the room it has.
 */
export function desktopRowText(row: SessionRow, clock?: ElapsedClock): string {
  return [row.title, row.sid8 || '-', statusLabel(row.status), row.model, row.effort, elapsedText(row, clock)].join(DESKTOP_SEP)
}

/** The column header of desktopRowText's rows. */
export const DESKTOP_HEADER = ['title', 'sid', 'status', 'model', 'effort', 'elapsed'].join(DESKTOP_SEP)

function shortDir(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || dir
}

// ---------------------------------------------------------------- completion

/** The notification type a toast shows as its title: a completion by its outcome, the mod's other events by name. */
export const TOAST_TITLES = {
  clean: 'Session finished',
  limit: 'Usage limit reached',
  login: 'Login needed',
  killed: 'Session killed',
  error: 'Session failed',
  chatter: 'Session ended without a report',
  tracking: 'Tracking problem',
  trace: 'Debug trace failed',
  helper: 'Node helper',
  // The poll-based notices (notices.ts), one title per kind.
  orphan: 'Unregistered session',
  stall: 'Session stalled',
  'queue-ready': 'Queued task ready',
  'unit-complete': 'Queue empty',
  'compliance-due': 'Compliance check due',
  'open-point-age': 'Open point waiting',
  'retire-due': 'Housekeeping due',
  'repo-state': 'Repository state',
  'lock-holder': 'Dead lock holder',
  'registry-unreadable': 'Registry unreadable',
  'mod-drift': 'Mod out of date',
  'secret-in-result': 'Secret in a result',
  // The one summary toast of the notices past the toast cap of a refresh.
  moreNotices: 'More notices',
} as const satisfies Record<
  | SessionOutcomeKind
  | 'tracking'
  | 'trace'
  | 'helper'
  | 'orphan'
  | 'stall'
  | 'queue-ready'
  | 'unit-complete'
  | 'compliance-due'
  | 'open-point-age'
  | 'retire-due'
  | 'repo-state'
  | 'lock-holder'
  | 'registry-unreadable'
  | 'mod-drift'
  | 'secret-in-result'
  | 'moreNotices',
  string
>

/**
 * A toast's text: the title, a separator, then the message. A toast is one line of text (the engine draws a line break
 * in it as U+FFFD and wraps the rest), so the title leads the line rather than sitting on a line of its own.
 */
export function toastText(title: string, message: string): string {
  return `${title} \u00B7 ${message}`
}

/** An engine message that a usage limit stopped the run. */
const LIMIT_TEXT = /hit your (session |usage |weekly )?limit|usage limit reached/i
/** An engine message that the licence's login is gone: expired or refused credentials. */
const LOGIN_TEXT = /please run \/login|invalid api key|oauth (token|session) (has )?expired|failed to authenticate|not logged in|authentication_failed/i
/** A message that the process was killed for memory. */
const MEMORY_TEXT = /low on memory|out of memory|oom-?kill/i

/**
 * Classifies a finished worker from its `--output-format json` result file's text (may be empty or truncated), the
 * background task's status when known (`completed`, `failed`, `killed`) and its error file's text when there is one.
 * `limit`, `login` and a memory kill come only from reliable signals: the API error status (429, 401), the result
 * text and `errors` of a run that failed (`is_error` true or a subtype other than `success`), a result that is not
 * JSON, and the error file. A run whose result is a success is clean whatever its error file says (stderr may hold a
 * benign "usage limit reached, retrying"): the error file counts only when the result is not a success. The words of
 * a normal report never count: a report may quote those messages.
 */
export function classifyResult(resultText: string, taskStatus?: string, errText = ''): SessionOutcome {
  let parsed: Record<string, unknown> | undefined
  try {
    const value: unknown = JSON.parse(resultText)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    parsed = undefined
  }
  const text = typeof parsed?.result === 'string' ? parsed.result : ''
  const isError = parsed?.is_error === true
  const subtype = typeof parsed?.subtype === 'string' ? parsed.subtype : undefined
  const isFailed = isError || (subtype !== undefined && subtype !== 'success')
  const apiStatus = typeof parsed?.api_error_status === 'number' ? parsed.api_error_status : undefined
  const isSuccess = parsed?.is_error === false && subtype === 'success' && apiStatus !== 429 && apiStatus !== 401
  const costUsd = typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined
  const sessionId = typeof parsed?.session_id === 'string' ? parsed.session_id : undefined
  const make = (kind: SessionOutcomeKind, why: string): SessionOutcome => ({
    kind,
    summary: `${kind}: ${why}`,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(sessionId === undefined ? {} : { sessionId }),
  })
  // A failed run may carry its message only in `errors` (an array of strings) or `error` instead of `result`.
  const failure = [
    text,
    ...(Array.isArray(parsed?.errors) ? parsed.errors.filter((one): one is string => typeof one === 'string') : []),
    typeof parsed?.error === 'string' ? parsed.error : '',
  ].join('\n')
  // The engine sets `is_error` on a real failure, so a success carrying limit words is a report that quotes them.
  const signal = [isSuccess ? '' : errText, parsed === undefined ? resultText : '', isFailed ? failure : ''].join('\n')
  if (apiStatus === 429 || LIMIT_TEXT.test(signal)) return make('limit', 'rate limit hit')
  if (apiStatus === 401 || LOGIN_TEXT.test(signal)) return make('login', 'licence needs a re-login')
  if (taskStatus === 'killed' || MEMORY_TEXT.test(signal)) {
    return make('killed', taskStatus === 'killed' ? 'background task killed' : 'killed (memory)')
  }
  if (parsed === undefined) {
    return make('killed', resultText.trim() === '' ? 'no result written' : 'result not JSON (cut off?)')
  }
  if (isError) return make('error', firstLine(text) || 'is_error with no text')
  if (isFailed) return make('error', firstLine(text) || subtype || 'failed with no text')
  if (text.trim() === '') return make('chatter', 'empty result')
  if (text.trim().length < 40) {
    // A short answer is chatter only after real work: a long run, many turns or a real cost.
    const durationMs = typeof parsed.duration_ms === 'number' ? parsed.duration_ms : 0
    const turns = typeof parsed.num_turns === 'number' ? parsed.num_turns : 0
    const substantial = durationMs >= 60_000 || turns >= 5 || (costUsd ?? 0) >= 0.5
    if (substantial) return make('chatter', `short result "${text.trim()}" after a substantial run`)
  }
  return make('clean', firstLine(text))
}

/** The report a result file holds: its `result` text, or empty when it has none or is not JSON. */
export function resultReport(resultText: string): string {
  try {
    const value = JSON.parse(resultText) as { result?: unknown } | null
    return typeof value?.result === 'string' ? value.result : ''
  } catch {
    return ''
  }
}

const GIT_STATUS = /git\s+status\s+-sb\b/gi
const GIT_LOG = /git\s+log\s+--oneline\s+@\{(?:u|upstream)\}\.\.HEAD/gi
/** Either command named: where one command's text ends and the next begins. */
const GIT_COMMAND = /git\s+(?:status\s+-sb|log\s+--oneline)/i
/**
 * An exit code as reports write it: `exit 0`, `exit=0`, `exit code: 0`, `exit status 0`, `exited 0`, `rc=0`, `→ 0`,
 * `-> 0`, `=> 0`; the number may stand in backticks or asterisks (`exit code: \`0\``).
 */
const EXIT_CODE = /(?:\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*|\brc\s*[:=]?\s*|(?:→|->|=>)\s*)[`*]*(\d+)(?!\w|\.\d)/i
/** A `git status -sb` branch line: `## main...origin/main [ahead 1]`, `## HEAD (no branch)`; or the same in backticks inside a sentence. */
const BRANCH_LINE = /^[\s>]*(?:[-*]\s+)?`?##\s+\S|`##\s+\S/m
/** A branch line at the start of a line (in a block): its own line. */
const BRANCH_START = /^[\s>]*`?##\s+\S/
/** A `git status -sb` file line: two status letters (or blanks), a blank, a path. */
const STATUS_FILE_LINE = /^[\s>]*[ MADRCUT?!]{2} \S/
/** A `git log --oneline` line: an abbreviated sha holding a digit, then the subject; a list mark or backticks may lead. */
const COMMIT_LINE = /^[\s>]*(?:[-*]\s+)?`?(?=[0-9a-f]*\d)[0-9a-f]{7,40}`?\s+\S/m
/** Lines that end a command's output block: a heading, the next command, a code fence, a line opening with an exit marker. */
const HEADING_LINE = /^[\s>]*#{1,6}\s/
const COMMAND_LINE = /^[\s>]*(?:[-*]\s+)?[`$]*\s*git\s/i
const FENCE_LINE = /^[\s>]*```/
/** A line that opens with an exit marker (`exit 0`, `(exit 0)`, `- **exit code:** 0`, `-> 0`, `=> 0`), or is a number alone (`0`, `` `0` ``). */
const EXIT_LINE = /^[\s>]*(?:[-*]\s+)?[*_`]*[([]?\s*(?:exit|exited|rc\b|→|->|=>)|^[\s>]*[*_`(]*\d{1,3}[*_`)]*\s*$/i
/** A line that is an exit code alone: the number, maybe in backticks, asterisks or parentheses. */
const BARE_EXIT = /^[\s>]*[*_`(]*(\d{1,3})[*_`)]*\s*$/
/** How many lines after the end of an output block an exit line may follow. */
const EXIT_LINES_AFTER = 2

/** The exit code a line carries: an exit marker with its number, or a number alone. */
const exitOf = (line: string): string | undefined => EXIT_CODE.exec(line)?.[1] ?? BARE_EXIT.exec(line)?.[1]

/** The text after a command mention up to the next mention of either command, at most `max` characters. */
function after(text: string, end: number, max: number): string {
  const rest = text.slice(end, end + max)
  const next = rest.search(GIT_COMMAND)
  return next < 0 ? rest : rest.slice(0, next)
}

/** Whether the position sits inside a code fence: an odd number of fence lines before its line. */
function isInFence(report: string, at: number): boolean {
  const before = report.slice(0, report.lastIndexOf('\n', at - 1) + 1)
  return before.split('\n').filter(line => FENCE_LINE.test(line)).length % 2 === 1
}

/**
 * The exit code of a command named in a Markdown table row: the row's cell in the column whose header says exit, rc or
 * code (`| Command | Exit | Output |`), when that cell is a number.
 */
function tableExit(report: string, at: number): string | undefined {
  const lines = report.split('\n')
  let index = report.slice(0, at).split('\n').length - 1
  if (!(lines[index] ?? '').trim().startsWith('|')) return undefined
  const row = lines[index] ?? ''
  while (index > 0 && (lines[index - 1] ?? '').trim().startsWith('|')) index--
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(one => one.trim())
  const column = cells(lines[index] ?? '').findIndex(cell => /\b(?:exit|rc|code)\b/i.test(cell))
  if (column < 0 || lines[index] === row) return undefined
  return /^`?(\d+)`?$/.exec(cells(row)[column] ?? '')?.[1]
}

/** The exit code on one of the next EXIT_LINES_AFTER non-blank lines from `from`, when one of them is an exit line; a heading, a command or a fence stops. */
function exitBelow(lines: readonly string[], from: number): string | undefined {
  let seen = 0
  for (let at = from; at < lines.length && seen < EXIT_LINES_AFTER; at++) {
    const line = lines[at] ?? ''
    if (line.trim() === '') continue
    seen++
    if (HEADING_LINE.test(line) || COMMAND_LINE.test(line) || FENCE_LINE.test(line)) return undefined
    if (EXIT_LINE.test(line)) return exitOf(line)
  }
  return undefined
}

/** Past the status output at the head of a block the two commands share: its branch line, its file lines and its own exit line. */
function pastStatus(lines: readonly string[], from: number): number {
  let at = from
  while (at < lines.length && !BRANCH_START.test(lines[at] ?? '')) {
    if ((lines[at] ?? '').trim() === '' || FENCE_LINE.test(lines[at] ?? '')) return from
    at++
  }
  if (at >= lines.length) return from
  const hasExit = EXIT_CODE.test(lines[at] ?? '')
  at++
  while (at < lines.length && STATUS_FILE_LINE.test(lines[at] ?? '')) at++
  if (!hasExit && EXIT_LINE.test(lines[at] ?? '')) at++
  return at
}

/**
 * The exit code and the number of commits of the `git log` read that ends at `end`: the rest of its line, then the
 * output block below it (an opening fence right below a command outside a fence holds it), which stops at a blank line,
 * a code-fence end, an exit marker, the next command or a heading. The exit code sits on the command's line, in the
 * block (a number alone counts), on the exit marker that ends it, or on an exit line within EXIT_LINES_AFTER non-blank
 * lines after a blank line or the fence that ends it; an `exit 0` further on in the report is not this log's. In a table
 * row it is the row's exit cell. When the line named `git status -sb` before it (`isShared`), the status output at the
 * head of the block is passed over first.
 */
function logRead(report: string, end: number, isShared = false): { exit?: string; commits: number } {
  const lines = report.slice(end).split('\n')
  const first = lines.shift() ?? ''
  const next = first.search(GIT_COMMAND)
  let exit = EXIT_CODE.exec(next < 0 ? first : first.slice(0, next))?.[1] ?? tableExit(report, end)
  let commits = 0
  if (next >= 0) return exit === undefined ? { commits } : { exit, commits }
  let at = !isInFence(report, end) && FENCE_LINE.test(lines[0] ?? '') ? 1 : 0
  if (isShared) at = pastStatus(lines, at)
  for (; at < lines.length; at++) {
    const line = lines[at] ?? ''
    if (line.trim() === '' || FENCE_LINE.test(line)) {
      exit ??= exitBelow(lines, at + 1)
      break
    }
    if (HEADING_LINE.test(line) || COMMAND_LINE.test(line)) break
    if (EXIT_LINE.test(line)) {
      exit ??= exitOf(line)
      break
    }
    if (COMMIT_LINE.test(line)) commits += 1
    else exit ??= EXIT_CODE.exec(line)?.[1]
  }
  return exit === undefined ? { commits } : { exit, commits }
}

/**
 * Whether the `git status -sb` read that ends at `end` carries its branch line and its exit code: in the text up to the
 * next mention of either command (600 characters at most: an exit marker or a number alone on its line, and a branch
 * line, also one in backticks inside a sentence; or the row's exit cell in a table); or, when that next mention is on
 * the same line (both commands named above one block), in the block below: its first branch line, with the exit code on
 * it or on an exit line within EXIT_LINES_AFTER lines after its file lines.
 */
function statusRead(report: string, end: number): boolean {
  const window = after(report, end, 600)
  const isExit = EXIT_CODE.test(window) || window.split('\n').some(line => BARE_EXIT.test(line)) || tableExit(report, end) !== undefined
  if (isExit && BRANCH_LINE.test(window)) return true
  if (window.includes('\n')) return false
  const lines = report.slice(end).split('\n').slice(1)
  let at = !isInFence(report, end) && FENCE_LINE.test(lines[0] ?? '') ? 1 : 0
  for (; at < lines.length && !BRANCH_START.test(lines[at] ?? ''); at++) if ((lines[at] ?? '').trim() === '' || FENCE_LINE.test(lines[at] ?? '')) return false
  if (at >= lines.length) return false
  if (EXIT_CODE.test(lines[at] ?? '')) return true
  let below = at + 1
  while (below < lines.length && STATUS_FILE_LINE.test(lines[below] ?? '')) below++
  return exitBelow(lines, below) !== undefined
}

/**
 * The worker-report check: whether a final report carries the output of `git status -sb` and of
 * `git log --oneline @{u}..HEAD`, each with its exit code, as the worker prompts demand, and whether that log lists
 * commits that are not pushed (counted only in the log's own output block). Tolerant of case, code fences, `$ `
 * prompts, the spellings EXIT_CODE takes, an exit line within two lines after the output, a number alone as the exit
 * code, a table with an exit column, and both commands named on one line above one block.
 * Undefined when the report is in order; else one short line. It is a note only: it never changes the outcome.
 */
export function reportCheck(report: string): string | undefined {
  let isStatus = false
  for (const match of report.matchAll(GIT_STATUS)) if (statusRead(report, (match.index ?? 0) + match[0].length)) isStatus = true
  let isLog = false
  let commits = 0
  const failed: string[] = []
  for (const match of report.matchAll(GIT_LOG)) {
    const lineStart = report.lastIndexOf('\n', match.index ?? 0) + 1
    const isShared = /git\s+status\s+-sb\b/i.test(report.slice(lineStart, match.index ?? 0))
    const read = logRead(report, (match.index ?? 0) + match[0].length, isShared)
    if (read.exit === undefined) continue
    isLog = true
    if (read.exit !== '0') failed.push(read.exit)
    commits += read.commits
  }
  const lacks = [isStatus ? '' : 'git status -sb', isLog ? '' : 'git log --oneline @{u}..HEAD'].filter(one => one !== '')
  const notes: string[] = []
  if (lacks.length > 0) notes.push(`report lacks ${lacks.join(' and ')} with ${lacks.length > 1 ? 'their exit codes' : 'its exit code'}`)
  if (failed.length > 0) notes.push(`git log @{u}..HEAD exited ${failed.join(', ')}`)
  if (commits > 0) notes.push(`git log @{u}..HEAD lists ${commits} unpushed commit${commits > 1 ? 's' : ''}`)
  return notes.length === 0 ? undefined : notes.join('; ')
}

function firstLine(text: string): string {
  // The first line that holds words: a bare heading like "**Summary**" says nothing.
  const lines = text.split('\n').map(one => one.trim())
  const line = lines.find(one => one.replace(/[^A-Za-z0-9]/g, '').length > 12 && !one.startsWith('#') && !/^[*_\- ]+[^.]{0,20}[*_]*$/.test(one)) ?? lines.find(one => one !== '') ?? ''
  return line.length > 100 ? line.slice(0, 99) + '…' : line
}

export type MergeResult =
  | { changed: true; text: string; entry: SessionEntry }
  | { changed: false; reason: string }

/**
 * Merges a completion into the registry text IN PLACE: the entry with that
 * session id keeps every field it has (the licence daemon's `resume` object
 * among them), loses `pid`, gains `reported: false`, `outcome` and `ended_at`
 * (`endedSec`, the harvest time in epoch seconds). Every other
 * entry is left as parsed. Refuses when the entry is gone or no longer has a
 * pid (someone else already harvested it).
 */
export function mergeCompletion(registryText: string, sessionId: string, outcome: SessionOutcome, endedSec: number): MergeResult {
  let value: unknown
  try {
    value = JSON.parse(registryText)
  } catch {
    return { changed: false, reason: 'registry is not JSON' }
  }
  if (!Array.isArray(value)) return { changed: false, reason: 'registry is not a JSON array' }
  const entry = value.find(
    (one): one is SessionEntry =>
      typeof one === 'object' && one !== null && (one as SessionEntry).session_id === sessionId,
  )
  if (entry === undefined) return { changed: false, reason: `no entry for ${sessionId}` }
  if (typeof entry.pid !== 'number') return { changed: false, reason: `${sessionId} already harvested` }
  delete entry.pid
  entry.reported = false
  entry.outcome = { kind: outcome.kind, summary: outcome.summary, ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }) }
  entry.ended_at = endedSec
  return { changed: true, text: JSON.stringify(value, null, 2) + '\n', entry }
}

/** Parses the background-task notification text the session receives. */
export function parseTaskNotification(text: string): { taskId?: string; status?: string; outputFile?: string } {
  const tag = (name: string) => {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
    return match?.[1]?.trim()
  }
  return { taskId: tag('task-id'), status: tag('status'), outputFile: tag('output-file') }
}

// ---------------------------------------------------------------- launch guard

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type LaunchArgs = {
  dir: string
  prompt_file: string
  model: string
  effort: string
  title: string
  need?: number
  resume_sid?: string
  /** Bash background time limit for the worker, in minutes (default 180, 5 to 600). */
  timeout_minutes?: number
}

/**
 * What launch_worker is given: LaunchArgs with every field optional, and the prompt as text instead of a file. A
 * resume fills `dir`, `model`, `effort` and `title` from its registry entry (fillFromEntry); the mod writes an inline
 * prompt, or a prompt it extends, to a file of its own (composePrompt) and launches with that path.
 */
export type LaunchInput = Partial<LaunchArgs> & {
  /** The prompt as text; exactly one of `prompt` and `prompt_file`. */
  prompt?: string
  /** A section of agreed-decisions.md whose text is appended as binding. */
  section?: string
  /** Whether the standard rules block is appended when the prompt lacks the guard's items (RULES_DEFAULT). */
  rules?: boolean
  /** A discovered licence (licences.ts) the launch runs under instead of the picker's choice: its config_dir or name. */
  config_dir?: string
}

export type LaunchFacts = {
  home: string
  orchestratorDir: string
  entries: readonly SessionEntry[]
  /** Pids alive as claude (the probe's `A` lines). */
  facts: ProcFacts
  /** The licence picker's outcome; required for a fresh launch, ignored for a resume. */
  pick?: { exitCode: number; stdout: string; stderr?: string }
  /** For a resume: whether `<config_dir>/projects/<any>/<sid>.jsonl` exists. */
  transcriptExists?: boolean
  /** Whether the prompt file exists and is non-empty; `false` refuses the launch. */
  promptFileOk?: boolean
  /** `test -d` on args.dir; undefined when not checked. */
  dirOk?: boolean
  /** Checklist items the prompt file lacks; undefined when not checked. */
  missingItems?: readonly string[]
  /** Native Windows: paths are compared and checked as Windows ones (dir and prompt_file already in native form). */
  isWindows?: boolean
  /** On Windows, the prompt's length in characters; undefined when it could not be read. */
  promptChars?: number
  /** On Windows, the prompt's first characters; undefined when it could not be read. */
  promptLead?: string
}

export type LaunchVerdict =
  | { ok: true; configDir: string; resumeSid?: string }
  | { ok: false; reason: string }

/**
 * The tool's JSON schema: what the model may give. Nothing is required by the schema (a resume takes dir, model,
 * effort and title from its entry, and the prompt comes as a file or as text); the guard refuses what is missing.
 * The first eight properties are those of the schema before `prompt`, `section` and `rules`, word for word but for
 * the descriptions of dir, model, effort and title, which say what a resume fills in, and of prompt_file, which says
 * that it and prompt exclude each other.
 */
export const LAUNCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dir: { type: 'string', description: 'Absolute working directory of the worker. Never the orchestrator dir nor $HOME. A resume without it takes the entry\'s cwd.', pattern: '^/' },
    prompt_file: { type: 'string', description: 'Absolute path of the file holding the worker prompt. Exactly one of prompt_file and prompt.', pattern: '^/' },
    model: { type: 'string', minLength: 1, description: 'Model alias or id, e.g. opus, sonnet. A resume without it takes the entry\'s model.' },
    effort: { type: 'string', enum: [...EFFORTS], description: 'CLAUDE_CODE_EFFORT_LEVEL for the worker. A resume without it takes the entry\'s effort.' },
    title: { type: 'string', minLength: 1, maxLength: 120, description: 'Registry title of the worker. A resume without it takes the entry\'s title.' },
    need: { type: 'integer', minimum: 1, maximum: 100, description: 'Licence headroom percent to pass to the licence picker command, when one is configured (default 40).' },
    resume_sid: { type: 'string', pattern: '^[0-9a-f-]{36}$', description: 'Session id to resume; it runs under the config dir that created it.' },
    timeout_minutes: { type: 'integer', minimum: 5, maximum: 600, description: 'Background time limit of the worker in minutes (default 180).' },
    prompt: {
      type: 'string',
      minLength: 1,
      description: 'The worker prompt as text, instead of prompt_file (exactly one of the two): the mod writes it to a prompt file of its own in the runs directory, outside any repo, and launches with that file.',
    },
    section: {
      type: 'string',
      minLength: 1,
      description: 'A section heading of agreed-decisions.md, without "## ": its text is appended to the prompt as a block titled "Binding decisions (section <heading>)". Refused when the file has no such section.',
    },
    rules: {
      type: 'boolean',
      description:
        'Append the standard rules block (no AI attribution, no human answers, no credentials, foreground waits, never end the turn on a live run, the report with git status -sb and git log --oneline @{u}..HEAD and their exit codes) when the prompt lacks what the launch guard checks. Default true with prompt or section, false for a prompt_file given alone (that file is launched as it is). A prompt that already carries the items, or a skill test, gets no block.',
    },
    config_dir: {
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      description:
        'A discovered licence (list_licences), by its config_dir or name: a fresh launch runs under it and the licence picker is not run (no refusal for licence room; a warning when a probe of the last 60 s showed it over 90%). Refused when it is not a discovered licence. A resume runs under its entry\'s own config_dir: another one is refused. Absent: the picker when one is configured, else the default directory.',
    },
  },
} as const

/** Whether the rules block is wanted when `rules` is not given: when the mod writes the prompt (inline text or a section appended). */
export function rulesWanted(input: LaunchInput): boolean {
  return input.rules ?? (input.prompt !== undefined || input.section !== undefined)
}

/**
 * The standard rules block a launch appends (rules), the items of the worker prompt CLAUDE.md lists: no attribution,
 * no human answers, no credentials, foreground waits, the report. It carries each phrase the launch guard looks for
 * (missingPromptItems: "foreground", "git status -sb", "attribution"), so a prompt with the block passes the guard.
 */
export const RULES_BLOCK = [
  '## Standard rules (session-control)',
  '',
  '1. Commit messages follow the repo\'s rules, carry no AI attribution trailer (no Co-Authored-By or similar) and never mention an agent; nothing else you write mentions one either. Never stage `.claude.json*`, `projects/`, `memory/`, `.env` or key files.',
  '2. No human answers during the run. Look up what you do not know (docs, issue trackers, config, official examples) before trial and error; then take a documented default and report it, never for a sign-off item; with none, write the question in the report and stop that part. Never invent an answer.',
  '3. Never read, print or pass a credential; report, without quoting it, any secret seen in output.',
  '4. Start a long run with `run_in_background: true`, an explicit `timeout` and output to a log, then wait in repeated foreground calls under ten minutes each (`until <check>; do sleep 30; done`, with the Bash `timeout` under 600000). Never end the turn while a run, watcher or lock of yours is live.',
  '5. The report, as your last message: commits (sha, subject, branch); the output of `git status -sb` and of `git log --oneline @{u}..HEAD`, run last, each followed on the next line by its exit code; what was exercised, where, with what result; what was skipped; files written outside the repo; processes or locks left running; questions for the user.',
].join('\n')

/** The title line of the block a `section` appends. */
export function sectionBlockTitle(section: string): string {
  return `## Binding decisions (section ${section})`
}

export type ComposedPrompt = { text: string; isSectionAdded: boolean; isRulesAdded: boolean }

/**
 * The prompt a launch runs with: the text given (inline, or read from prompt_file), then the section's block when one
 * is given (its title line, then the section's lines as the file holds them), then the rules block when wanted and the
 * text so far lacks an item the launch guard checks (a skill test lacks none). Blocks are set off by a blank line.
 */
export function composePrompt(text: string, section: { heading: string; body: string } | undefined, isRulesWanted: boolean): ComposedPrompt {
  const join = (head: string, block: string) => `${head.replace(/\s+$/, '')}\n\n${block.replace(/\s+$/, '')}\n`
  let out = text
  if (section !== undefined) out = join(out, `${sectionBlockTitle(section.heading)}\n\n${section.body}`)
  const isRulesAdded = isRulesWanted && missingPromptItems(out).length > 0
  if (isRulesAdded) out = join(out, RULES_BLOCK)
  return { text: out, isSectionAdded: section !== undefined, isRulesAdded }
}

/** Why the prompt source is refused: launch_worker takes exactly one of `prompt` and `prompt_file`. */
export function promptSourceRefusal(input: LaunchInput): string | undefined {
  const hasText = input.prompt !== undefined
  const hasFile = input.prompt_file !== undefined
  if (hasText && hasFile) return 'refused: give exactly one of prompt and prompt_file, not both'
  if (!hasText && !hasFile) return 'refused: give exactly one of prompt and prompt_file'
  if (hasText && (typeof input.prompt !== 'string' || input.prompt.trim() === '')) return 'refused: prompt is empty'
  return undefined
}

/**
 * A resume's missing dir, model, effort and title taken from its registry entry (its cwd, model, effort, title); a
 * value given wins. A fresh launch, or a resume of an id no entry has, comes back as given (checkLaunch refuses it).
 */
export function fillFromEntry(input: LaunchInput, entries: readonly SessionEntry[]): LaunchInput {
  if (input.resume_sid === undefined) return input
  const entry = entries.find(one => one.session_id === input.resume_sid)
  if (entry === undefined) return input
  const own = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)
  const filled: LaunchInput = { ...input }
  if (filled.dir === undefined && own(entry.cwd) !== undefined) filled.dir = own(entry.cwd)
  if (filled.model === undefined && own(entry.model) !== undefined) filled.model = own(entry.model)
  if (filled.effort === undefined && own(entry.effort) !== undefined) filled.effort = own(entry.effort)
  if (filled.title === undefined && own(entry.title) !== undefined) filled.title = own(entry.title)
  return filled
}

/** Which of dir, model, effort and title a resume took from its entry, in that order. */
export function filledFields(input: LaunchInput, filled: LaunchInput): string[] {
  return (['dir', 'model', 'effort', 'title'] as const).filter(key => input[key] === undefined && filled[key] !== undefined)
}

/** The launch's arguments once the prompt file is known: a field still missing is empty, which checkLaunch refuses. */
export function launchArgsOf(input: LaunchInput, promptFile: string): LaunchArgs {
  const { prompt: _prompt, section: _section, rules: _rules, config_dir: _configDir, ...rest } = input
  return { ...rest, dir: input.dir ?? '', prompt_file: promptFile, model: input.model ?? '', effort: input.effort ?? '', title: input.title ?? '' }
}

function normalize(path: string): string {
  const cut = path.replace(/\/+$/, '')
  return cut === '' ? '/' : cut
}

/**
 * The longest prompt a Windows launch passes, in characters: the prompt goes on claude.exe's command line, which
 * Windows caps at 32767 characters, and Git Bash's argument conversion of it is untested.
 */
export const WINDOWS_PROMPT_MAX_CHARS = 30_000

/**
 * A prompt Git Bash would rewrite on its way to claude.exe: it turns an argument that starts like a POSIX path into
 * a Windows one (`/c/x` and `/tmp/x` to C:/..., `-I/x`, a first word `NAME=/x`, lists `/a:/b`), and the prompt is one
 * argument. Leading white space, a heading or a word first, `//x`, `x:/y`, URLs and C:/ paths pass untouched
 * (tests/windows-selftest.mjs runs the MSYS_PROMPTS cases of tests/fixtures.ts through Git Bash).
 */
export const MSYS_REWRITTEN = /^(\/(?!\/)|-[^\s/=]*\/|\S*=\/)/

/** Pure guard of launch_worker. */
export function checkLaunch(args: LaunchArgs, ctx: LaunchFacts): LaunchVerdict {
  const isWin = ctx.isWindows === true
  const isAbsolute = (path: string) => (isWin ? isWinAbsolute(path) : path.startsWith('/'))
  const onWindows = isWin ? ' (on Windows /c/... or C:/...)' : ''
  if (typeof args.model !== 'string' || args.model.trim() === '') return { ok: false, reason: 'model is required' }
  if (!(EFFORTS as readonly string[]).includes(args.effort)) {
    return { ok: false, reason: `effort is required, one of ${EFFORTS.join('|')}` }
  }
  if (typeof args.title !== 'string' || args.title.trim() === '') return { ok: false, reason: 'title is required' }
  if (typeof args.dir !== 'string' || !isAbsolute(args.dir)) return { ok: false, reason: `dir must be absolute${onWindows}` }
  if (typeof args.prompt_file !== 'string' || !isAbsolute(args.prompt_file)) {
    return { ok: false, reason: `prompt_file must be absolute${onWindows}` }
  }
  if (ctx.promptFileOk === false) return { ok: false, reason: `refused: prompt file ${args.prompt_file} is missing or empty` }
  if (isWin && ctx.promptChars !== undefined && ctx.promptChars > WINDOWS_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      reason: `refused: on Windows the prompt goes on a command line of at most 32767 characters; it has ${ctx.promptChars}, the limit is ${WINDOWS_PROMPT_MAX_CHARS}: shorten it or move detail into files the worker reads`,
    }
  }
  if (isWin && ctx.promptLead !== undefined && MSYS_REWRITTEN.test(ctx.promptLead)) {
    return {
      ok: false,
      reason: 'refused: on Windows Git Bash rewrites an argument that starts like a POSIX path (/x, -I/x, NAME=/x) into a Windows path, and the prompt is one argument: start it with a word or a heading',
    }
  }
  if (ctx.missingItems !== undefined && ctx.missingItems.length > 0) {
    return { ok: false, reason: `refused: the prompt lacks: ${ctx.missingItems.join('; ')}` }
  }
  if (ctx.dirOk === false) return { ok: false, reason: `refused: directory ${args.dir} does not exist` }
  const isSame = (a: string, b: string) => (isWin ? isSameWinPath(a, b) : normalize(a) === normalize(b))
  if (isSame(args.dir, ctx.orchestratorDir)) return { ok: false, reason: 'refused: cwd is the orchestrator dir' }
  if (isSame(args.dir, ctx.home)) return { ok: false, reason: 'refused: cwd is $HOME' }

  if (args.resume_sid !== undefined) {
    const entry = ctx.entries.find(one => one.session_id === args.resume_sid)
    if (entry === undefined) return { ok: false, reason: `no registry entry for ${args.resume_sid}` }
    if (typeof entry.config_dir !== 'string' || entry.config_dir === '') {
      return { ok: false, reason: 'entry has no config_dir: a resume cannot pick a licence' }
    }
    if (isPidAlive(entry, ctx.facts)) return { ok: false, reason: `refused: pid ${entry.pid} of that session is alive` }
    if (ctx.transcriptExists !== true) {
      return { ok: false, reason: `transcript of ${args.resume_sid} not under ${entry.config_dir}` }
    }
    return { ok: true, configDir: entry.config_dir, resumeSid: args.resume_sid }
  }

  const pick = ctx.pick
  if (pick === undefined) return { ok: false, reason: 'no licence pick was made' }
  const configDir = pick.stdout.trim()
  if (pick.exitCode === 3) return { ok: false, reason: `no licence has room: ${(pick.stderr ?? pick.stdout).trim().slice(0, 200)}` }
  if (pick.exitCode !== 0 || configDir === '') {
    return { ok: false, reason: `the licence picker gave nothing usable (exit ${pick.exitCode})` }
  }
  if (!isAbsolute(configDir) || configDir.includes('\n')) {
    return { ok: false, reason: `the licence picker answered an unexpected value: ${configDir.slice(0, 80)}` }
  }
  return { ok: true, configDir: isWin ? winPath(configDir) : configDir }
}

/** On Windows the licence picker command starts with its executable's absolute path: what a bare name finds there is unknown. */
export function windowsPickerRefusal(argv: readonly string[]): string | undefined {
  const exe = argv[0] ?? ''
  if (isWinAbsolute(exe)) return undefined
  return `refused: on Windows the licence picker command must start with the absolute path of an executable (C:/.../picker.exe), not "${exe.slice(0, 80)}"`
}

/** The licence picker command as an argv: split on blanks, `{need}` replaced, a leading `~/` expanded. */
export function pickArgv(command: string, need: number, home: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map(part => (part.startsWith('~/') ? `${home}/${part.slice(2)}` : part).replace(/\{need\}/g, String(need)))
}

/**
 * The settings every worker gets through `--settings`: messages from other sessions on this machine are accepted, so
 * the orchestrator can reach a running worker by its name. Inline JSON with no blank and no single quote: shq quotes
 * it as one argument for bash on Linux and for Git Bash on Windows, which passes it to claude.exe unchanged.
 */
export const WORKER_SETTINGS = '{"crossSessionInbound":"accept"}'

/** A worker's session name: `w-`, a slug of the title, the launch time; letters, digits and dashes only. */
export const WORKER_NAME = /^w-[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * The name a launch generates, whole: `w-`, a slug (lower-case letters, digits and dashes, maybe empty), the launch time
 * as twelve digits (yyMMddHHmmss) and the `-2`, `-3` ... suffix a taken name gets. Without the twelve-digit stamp a
 * name is not one the mod generated.
 */
export const GENERATED_NAME = /^w-[a-z0-9-]*-\d{12}(-\d+)?$/

/** The most characters of a generated name that is shown as it is: a name is `w-`, 24 slug characters, the stamp and a suffix. */
export const GENERATED_NAME_MAX = 64

/** Whether a value is a name of the generated form (GENERATED_NAME) and at most GENERATED_NAME_MAX characters. */
export const isGeneratedName = (value: string): boolean => value.length <= GENERATED_NAME_MAX && GENERATED_NAME.test(value)

/**
 * The unique session name of a launch: `w-<slug of the title, up to 24>-<yyMMddHHmmss UTC>` (at most 39 characters),
 * with `-2`, `-3`... appended while the name is in `taken` (names in the registry or given out by this session).
 */
export function workerName(title: string, nowMs: number, taken: ReadonlySet<string> = new Set()): string {
  const slug = slugify(title).slice(0, 24).replace(/-+$/, '')
  const stamp = new Date(nowMs).toISOString().replace(/[-:T]/g, '').slice(2, 14)
  const base = `w-${slug}-${stamp}`
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  return name
}

/**
 * The name a launch passes with `-n`. A resume keeps the entry's own name when it has a valid one, so the session
 * answers to the same name across resumes (its earlier process is dead: checkLaunch refuses a live one); an entry
 * without one (launched before names existed) gets a fresh unique name, as a fresh launch does.
 */
export function launchName(title: string, nowMs: number, entries: readonly SessionEntry[], resumeSid?: string, issued: ReadonlySet<string> = new Set()): string {
  const own = resumeSid === undefined ? undefined : entries.find(one => one.session_id === resumeSid)?.name
  if (typeof own === 'string' && WORKER_NAME.test(own) && own.length <= 64) return own
  const taken = new Set(issued)
  for (const one of entries) if (typeof one.name === 'string') taken.add(one.name)
  return workerName(title, nowMs, taken)
}

/**
 * The argv the launch runs: result and error go to files the caller names (never inside the repo). A worker that
 * inherits the machine's default configuration (`isConfigInherited`) gets no CLAUDE_CONFIG_DIR: Claude Code then
 * reads its global config where it always does (~/.claude.json), not inside the config directory. Every worker gets
 * its session name (`-n`) and WORKER_SETTINGS (`--settings`), a resume too.
 */
export function buildLaunchArgv(
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string; isConfigInherited?: boolean; name: string },
  resultFile: string,
  errFile?: string,
): string[] {
  const resume = verdict.resumeSid ? ` --resume ${shq(verdict.resumeSid)}` : ''
  const err = errFile === undefined ? '' : ` 2> ${shq(errFile)}`
  const config = verdict.isConfigInherited === true ? '' : `CLAUDE_CONFIG_DIR=${shq(verdict.configDir)} `
  const script =
    `cd ${shq(args.dir)} && ${config}CLAUDE_CODE_EFFORT_LEVEL=${shq(args.effort)} ` +
    `claude -p --model ${shq(args.model)}${resume} -n ${shq(verdict.name)} --settings ${shq(WORKER_SETTINGS)} ` +
    `--dangerously-skip-permissions --output-format json ` +
    `-- "$(cat ${shq(args.prompt_file)})" > ${shq(resultFile)}${err}`
  return ['sh', '-c', script]
}

/**
 * The config directory a worker without a licence picker runs under: the orchestrator's own CLAUDE_CONFIG_DIR, which
 * the worker inherits, when it has one; else <home>/.claude. On Windows in the native form.
 */
export function defaultConfigDir(home: string, own: string | undefined, isWindows = false): string {
  if (own !== undefined && own !== '') return isWindows ? winPath(own) : own
  return `${home}/.claude`
}

/** Whether a config directory is that default one, compared as the platform compares paths. */
export function isDefaultConfigDir(dir: string, defaultDir: string, isWindows = false): boolean {
  return isWindows ? isSameWinPath(dir, defaultDir) : normalize(dir) === normalize(defaultDir)
}

/** The Bash background limit in milliseconds for a launch (default 180 minutes, 5 to 600). */
export function launchTimeoutMs(args: LaunchArgs): number {
  const minutes = Math.min(600, Math.max(5, Math.round(args.timeout_minutes ?? 180)))
  return minutes * 60_000
}

/** A filesystem-safe slug of a title. */
export function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug === '' ? 'worker' : slug
}

/**
 * The new `claude -p` worker a launch started: a headless claude in the launch dir under the launch's
 * config dir, with the launch's model, that was not there before. Undefined while it has not appeared.
 */
export function findNewWorker(
  facts: ProcFacts,
  want: { dir: string; configDir: string; model: string },
  known: ReadonlySet<number>,
): ProcFact | undefined {
  const dir = want.dir.replace(/\/+$/, '')
  return facts.claude.find(
    one =>
      !known.has(one.pid) &&
      isHeadless(one.cmdline) &&
      one.cwd.replace(/\/+$/, '') === dir &&
      one.configDir === want.configDir &&
      one.cmdline.includes(`--model ${want.model}`),
  )
}

/**
 * findNewWorker on native Windows: the same match, with paths compared as Windows compares them. A claude.exe whose
 * sessions file the probe found nowhere (no cwd, no config dir) still counts when it is headless, has the launch's
 * model and is younger than the launch; its session id is then read from the launch's config dir.
 */
export function findNewWindowsWorker(
  facts: ProcFacts,
  want: { dir: string; configDir: string; model: string },
  known: ReadonlySet<number>,
  launchedSecAgo: number,
): ProcFact | undefined {
  const fresh = facts.claude.filter(one => !known.has(one.pid) && isHeadless(one.cmdline) && one.cmdline.includes(`--model ${want.model}`))
  return (
    fresh.find(one => one.cwd !== '' && isSameWinPath(one.cwd, want.dir) && isSameWinPath(one.configDir, want.configDir)) ??
    fresh.find(one => one.cwd === '' && one.configDir === '' && one.elapsedSec !== undefined && one.elapsedSec <= launchedSecAgo + 1)
  )
}

/**
 * What the mod reads from a worker's `<config_dir>/sessions/<pid>.json`: its session id, its session name and the
 * socket other sessions message it through (`messagingSocketPath`). A field that is missing or not a non-empty string
 * (a file not written yet, an older claude without the inbox) is undefined.
 */
export function sessionFileFacts(text: string): { sessionId?: string; name?: string; socketPath?: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const file = value as Record<string, unknown>
  const field = (key: string) => (typeof file[key] === 'string' && file[key] !== '' ? (file[key] as string) : undefined)
  const facts: { sessionId?: string; name?: string; socketPath?: string } = {}
  const sessionId = field('sessionId')
  const name = field('name')
  const socketPath = field('messagingSocketPath')
  if (sessionId !== undefined) facts.sessionId = sessionId
  if (name !== undefined) facts.name = name
  if (socketPath !== undefined) facts.socketPath = socketPath
  return facts
}

/** The pid in a launch's pid file (`Set-Content -Encoding Ascii`: the digits and a line end); undefined for anything else. */
export function pidFromFile(text: string): number | undefined {
  const digits = text.trim()
  return /^[1-9][0-9]{0,9}$/.test(digits) ? Number(digits) : undefined
}

/**
 * The registry entry for a launch (a resume merges it over the existing entry in place). `name` is the session name
 * (the sessions file's, else the one the launch passed); `socket_path` is the sessions file's `messagingSocketPath`,
 * valid while the pid lives. Without one a fresh entry has no `socket_path` and a resume writes null, so the dead
 * socket of the earlier run is not kept. `started_at` is `startedSec`, when the launch started this run (epoch seconds).
 * `prompt` names the prompt file the mod wrote for the run and the decisions section it appended, when it did: the
 * entry then records `prompt_file` (deleted with the run's other files at a clean retire) and `section`.
 */
export function newRegistryEntry(
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string },
  pid: number,
  sessionId: string,
  files: { result: string; err: string },
  inbox: { name: string; socketPath?: string },
  startedSec: number,
  prompt: { promptFile?: string; section?: string } = {},
): SessionEntry {
  const socket = inbox.socketPath !== undefined ? { socket_path: inbox.socketPath } : verdict.resumeSid ? { socket_path: null } : {}
  return {
    title: args.title,
    pid,
    session_id: sessionId,
    name: inbox.name,
    ...socket,
    config_dir: verdict.configDir,
    cwd: args.dir.replace(/\/+$/, ''),
    model: args.model,
    effort: args.effort,
    result_file: files.result,
    err_file: files.err,
    started_at: startedSec,
    ...(prompt.promptFile === undefined ? {} : { prompt_file: prompt.promptFile }),
    ...(prompt.section === undefined ? {} : { section: prompt.section }),
  }
}

/**
 * Appends (mode `new`) or updates in place (mode `resume`: the entry with that session id gets the
 * fields, `reported`, the previous `outcome` and the previous run's `ended_at` are dropped) one registry entry, through a temp file and `mv` so a reader never
 * sees half a file. Args: registry path, entry JSON, mode. Fields it does not know stay.
 */
export const REGISTER_SCRIPT = String.raw`R=$1; E=$2; M=$3
[ -f "$R" ] || echo '[]' > "$R"
tmp="$R.tmp.$$"
if [ "$M" = resume ]; then
  jq --argjson e "$E" 'map(if .session_id == $e.session_id then (. + $e) | del(.reported, .outcome, .ended_at) else . end)' "$R" > "$tmp"
else
  jq --argjson e "$E" '. + [$e]' "$R" > "$tmp"
fi && mv "$tmp" "$R"`

/**
 * Registry removal script: args are the registry path, the cleared-log path, then the session ids to remove.
 * The removed entries are appended to the log first; the write goes through a temp file and mv.
 */
export const CLEAR_SCRIPT = String.raw`R=$1; L=$2; shift 2
[ $# -gt 0 ] && [ -f "$R" ] || exit 0
ids=$(printf '%s\n' "$@" | jq -R . | jq -s .)
jq -c --argjson ids "$ids" '.[] | select(.session_id as $s | $ids | index($s))' "$R" >> "$L"
tmp="$R.tmp.$$"
jq --argjson ids "$ids" '[.[] | select((.session_id as $s | $ids | index($s)) | not)]' "$R" > "$tmp" && mv "$tmp" "$R"`

const sessionIds = (description: string) => ({
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: { type: 'string', minLength: 8 },
  description,
})

export const RETIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session_ids'],
  properties: {
    session_ids: sessionIds('Session ids (full, or the first 8 characters) of finished workers whose work is acknowledged and that are not needed any more.'),
    reviewed: {
      type: 'object',
      maxProperties: 50,
      additionalProperties: { type: 'string', minLength: 1 },
      description:
        'Optional. Maps a session id (full, or the first 8 characters) to the reason the orchestrator gives after reading its transcript: the stored outcome label is wrong or the work was deliberately abandoned. For that session the outcome check is skipped; every other refusal stays. The original outcome and the reason are logged in cleared.jsonl.',
    },
  },
} as const

export const ACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session_ids'],
  properties: {
    session_ids: sessionIds('Session ids (full, or the first 8 characters) of finished workers whose result the orchestrator has acknowledged.'),
    keep: {
      type: 'boolean',
      description: 'true when the session is still needed for a resume or as context of new work: it is then marked keep and shows as finished instead of finished-unreported. false (default) acknowledges it and clears any keep mark, so retire_workers can remove it.',
    },
  },
} as const

/** Registry script: args are the registry path, `keep` or `plain`, then the session ids to acknowledge (reported true; keep set when asked, cleared otherwise: the session is no longer needed). */
export const ACK_SCRIPT = String.raw`R=$1; K=$2; shift 2
[ $# -gt 0 ] && [ -f "$R" ] || exit 0
ids=$(printf '%s\n' "$@" | jq -R . | jq -s .)
tmp="$R.tmp.$$"
jq --argjson ids "$ids" --arg k "$K" 'map(if (.session_id as $s | $ids | index($s)) then (.reported = true) | (if $k == "keep" then .keep = true else del(.keep) end) else . end)' "$R" > "$tmp" && mv "$tmp" "$R"`

// The three registry scripts above as pure functions of the registry text. On the registry the mod writes they
// give what jq 1.7 writes, byte for byte (the differential cases REGISTRY_GOLDEN in tests/fixtures.ts, run
// against the scripts by tests/probe-selftest.mjs). On purpose they differ in two places: registering into an
// empty file keeps the entry (jq writes an empty file), and a text JSON.parse refuses is refused, never rewritten.
// A number jq keeps as written (1.0, 1E+2) comes out as JavaScript writes it, the same value, as mergeCompletion
// writes it already.

export type RegistryEdit = { ok: true; text: string } | { ok: false; error: string }

type Rec = Record<string, unknown>

/** jq's layout of a value: JSON.stringify's, with DEL escaped as jq escapes it. */
function jqText(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(/\x7f/g, '\\u007f')
}

/** Strings as jq reads them: a lone low surrogate becomes U+FFFD; undefined for a lone high one, which jq refuses. */
function jqStrings(value: unknown): unknown {
  let isRefused = false
  const fix = (text: string) =>
    text.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, unit => {
      if (unit.length === 2) return unit
      if (unit <= '\udbff') isRefused = true
      return '�'
    })
  const walk = (one: unknown): unknown => {
    if (typeof one === 'string') return fix(one)
    if (Array.isArray(one)) return one.map(walk)
    if (one !== null && typeof one === 'object') {
      const out: Rec = {}
      // defineProperty: an assignment to "__proto__" would set the prototype instead of keeping the key.
      for (const [key, part] of Object.entries(one)) Object.defineProperty(out, fix(key), { value: walk(part), enumerable: true, writable: true, configurable: true })
      return out
    }
    return one
  }
  const fixed = walk(value)
  return isRefused ? undefined : fixed
}

/** jq's `==`: deep, object keys in any order, a missing value is null. */
function jqEqual(a: unknown, b: unknown): boolean {
  const x = a ?? null
  const y = b ?? null
  if (Array.isArray(x) || Array.isArray(y)) {
    return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((one, i) => jqEqual(one, y[i]))
  }
  if (x !== null && y !== null && typeof x === 'object' && typeof y === 'object') {
    const keys = Object.keys(x)
    return keys.length === Object.keys(y).length && keys.every(key => Object.prototype.hasOwnProperty.call(y, key) && jqEqual((x as Rec)[key], (y as Rec)[key]))
  }
  return x === y
}

/** jq's `$ids | index($s)` as a test: a string is one of the ids, an array a run of consecutive ids. */
function jqIndexed(ids: readonly string[], sid: unknown): boolean {
  if (Array.isArray(sid)) {
    if (sid.length === 0) return false
    for (let at = 0; at + sid.length <= ids.length; at++) if (sid.every((one, k) => jqEqual(one, ids[at + k]))) return true
    return false
  }
  return typeof sid === 'string' && ids.includes(sid)
}

/** The registry as the scripts read it: the parsed array, its strings as jq reads them. */
function registryList(text: string): { ok: true; list: unknown[] } | { ok: false; error: string } {
  const parsed = parseRegistry(text)
  if (!parsed.ok) return parsed
  if (text.trim() === '') return { ok: true, list: [] }
  const list = jqStrings(JSON.parse(text))
  if (list === undefined) return { ok: false, error: 'registry holds an unpaired \\u surrogate escape' }
  return { ok: true, list: list as unknown[] }
}

/** jq stops on `.session_id` of anything but an object or null, so the scripts change nothing then. */
const NOT_AN_ENTRY = { ok: false, error: 'registry holds an item that is not an object' } as const

const isEntryOrNull = (one: unknown) => one === null || (typeof one === 'object' && !Array.isArray(one))

/** The ids as the scripts take them: one per line of their arguments. */
const idLines = (ids: readonly string[]) => ids.flatMap(id => id.split('\n'))

/** REGISTER_SCRIPT: `new` appends the entry; `resume` merges it over every entry with its session id, dropping `reported`, `outcome` and `ended_at`. */
export function registerEntry(text: string, entry: SessionEntry, mode: 'new' | 'resume'): RegistryEdit {
  if (mode === 'resume' && text.trim() === '') return { ok: true, text: '' }
  const read = registryList(text)
  if (!read.ok) return read
  const fresh = jqStrings(entry) as Rec | undefined
  if (fresh === undefined) return { ok: false, error: 'the entry holds an unpaired surrogate' }
  if (mode === 'new') return { ok: true, text: jqText([...read.list, fresh], 2) + '\n' }
  if (!read.list.every(isEntryOrNull)) return NOT_AN_ENTRY
  const list = read.list.map(one => {
    if (!jqEqual((one as Rec | null)?.session_id, fresh.session_id)) return one
    const merged: Rec = { ...(one as Rec | null), ...fresh }
    delete merged.reported
    delete merged.outcome
    delete merged.ended_at
    return merged
  })
  return { ok: true, text: jqText(list, 2) + '\n' }
}

/** CLEAR_SCRIPT: the registry without the named sessions, and the removed entries as the log lines it appends. */
export function removeEntries(text: string, ids: readonly string[]): (RegistryEdit & { ok: true; removed: string }) | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, text: '', removed: '' }
  const read = registryList(text)
  if (!read.ok) return read
  if (!read.list.every(isEntryOrNull)) return NOT_AN_ENTRY
  const named = idLines(ids)
  const isNamed = (one: unknown) => jqIndexed(named, (one as Rec | null)?.session_id)
  const removed = read.list.filter(isNamed).map(one => jqText(one) + '\n').join('')
  return { ok: true, text: jqText(read.list.filter(one => !isNamed(one)), 2) + '\n', removed }
}

/** ACK_SCRIPT: the named sessions get `reported: true`, and `keep: true` when kept, no `keep` otherwise. */
export function ackEntries(text: string, ids: readonly string[], keep: boolean): RegistryEdit {
  if (text.trim() === '') return { ok: true, text: '' }
  const read = registryList(text)
  if (!read.ok) return read
  if (!read.list.every(isEntryOrNull)) return NOT_AN_ENTRY
  const named = idLines(ids)
  const list = read.list.map(one => {
    if (!jqIndexed(named, (one as Rec | null)?.session_id)) return one
    const acked: Rec = { ...(one as Rec) }
    acked.reported = true
    if (keep) acked.keep = true
    else delete acked.keep
    return acked
  })
  return { ok: true, text: jqText(list, 2) + '\n' }
}

export type RetireReview = { session_id: string; was: string; reason: string }
export type RetireVerdict = { removable: string[]; refused: { id: string; reason: string }[]; reviewed?: RetireReview[] }

/** The text of the queue file that counts: every task not marked done; a text that is not the queue JSON counts whole. */
export function activeQueueText(queueText: string): string {
  try {
    const tasks = (JSON.parse(queueText) as { tasks?: unknown }).tasks
    if (!Array.isArray(tasks)) return queueText
    return JSON.stringify(tasks.filter(t => String((t as { status?: unknown } | null)?.status) !== 'done'))
  } catch {
    return queueText
  }
}

/**
 * Which of the named sessions may leave the registry: finished (no live pid), a clean outcome (anything that
 * needs a resume stays), not marked `keep`, and not named by a task of the queue file. The orchestrator calls
 * this when the work is acknowledged and the session is not needed for a resume or for new work with its context.
 */
/** The entry a session id names: the full id or its first characters. */
export function findBySid(entries: readonly SessionEntry[], id: string): (SessionEntry & { session_id: string }) | undefined {
  return entries.find((one): one is SessionEntry & { session_id: string } => typeof one.session_id === 'string' && (one.session_id === id || one.session_id.startsWith(id)))
}

export function retireVerdict(
  entries: readonly SessionEntry[],
  facts: ProcFacts,
  rawQueueText: string,
  ids: readonly string[],
  reviewed: Readonly<Record<string, unknown>> = {},
): RetireVerdict {
  const queueText = activeQueueText(rawQueueText)
  const verdict: RetireVerdict = { removable: [], refused: [] }
  // A reviewed key names the session by the same rule as an id; it must name one of the listed sessions, with a reason.
  const listed = new Set(ids.map(id => findBySid(entries, id)?.session_id).filter((sid): sid is string => sid !== undefined))
  const reviewOf = (sid: string) => Object.keys(reviewed).find(key => key.length >= 8 && sid.startsWith(key))
  for (const key of Object.keys(reviewed)) {
    const entry = key.length >= 8 ? findBySid(entries, key) : undefined
    if (entry === undefined || !listed.has(entry.session_id)) verdict.refused.push({ id: key, reason: 'reviewed names no session of session_ids' })
  }
  for (const id of ids) {
    const entry = findBySid(entries, id)
    const sid = entry?.session_id
    if (entry === undefined || sid === undefined) {
      verdict.refused.push({ id, reason: 'no registry entry' })
      continue
    }
    const status = rowStatus(entry, facts)
    const outcome = entry.outcome as { kind?: unknown } | undefined
    const key = reviewOf(sid)
    const reason = key === undefined ? undefined : reviewed[key]
    const isReviewed = key !== undefined && outcome !== undefined && outcome.kind !== 'clean'
    if (key !== undefined && (typeof reason !== 'string' || reason.trim() === '')) {
      verdict.refused.push({ id, reason: 'reviewed needs a non-empty reason' })
      continue
    }
    if (status === 'alive') verdict.refused.push({ id, reason: 'its process is alive' })
    else if (status === 'dead') verdict.refused.push({ id, reason: 'its exit was not classified yet' })
    else if (entry.keep === true) verdict.refused.push({ id, reason: 'marked keep: a resume or follow-up is expected' })
    else if (outcome !== undefined && outcome.kind !== 'clean' && !isReviewed) verdict.refused.push({ id, reason: `outcome ${String(outcome.kind)} needs a resume` })
    else if (queueText.includes(sid) || queueText.includes(sid.slice(0, 8))) verdict.refused.push({ id, reason: 'a queued or running task names it' })
    else {
      verdict.removable.push(sid)
      if (isReviewed) (verdict.reviewed ??= []).push({ session_id: sid, was: String(outcome?.kind), reason: String(reason).trim() })
    }
  }
  return verdict
}

/** Cleared-log lines of removed entries: those of a reviewed retire get `reviewed_outcome` (the stored kind) and `reviewed_reason` at the end. */
export function annotateCleared(removed: string, reviews: readonly RetireReview[]): string {
  if (reviews.length === 0) return removed
  return removed
    .split('\n')
    .map(line => {
      if (line === '') return line
      const entry = JSON.parse(line) as Rec
      const review = reviews.find(one => one.session_id === entry.session_id)
      return review === undefined ? line : jqText({ ...entry, reviewed_outcome: review.was, reviewed_reason: review.reason })
    })
    .join('\n')
}

/** A retired run's figures from its result file: `total_cost_usd` and `duration_ms`, when they are numbers. */
export type RunFigures = { cost_usd?: number; duration_ms?: number }

/** The figures of a result file's text; empty when it is no JSON object or holds neither number. */
export function runFigures(resultText: string): RunFigures {
  try {
    const value = JSON.parse(resultText) as Rec | null
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return {
      ...(typeof value.total_cost_usd === 'number' ? { cost_usd: value.total_cost_usd } : {}),
      ...(typeof value.duration_ms === 'number' ? { duration_ms: value.duration_ms } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Cleared-log lines with the run's figures: a line whose session has figures gets `cost_usd` and `duration_ms` at the
 * end, each only when the line lacks it; every other line stays as it is.
 */
export function withRunFigures(lines: string, figures: ReadonlyMap<string, RunFigures>): string {
  if (figures.size === 0) return lines
  return lines
    .split('\n')
    .map(line => {
      if (line === '') return line
      const entry = JSON.parse(line) as Rec
      const found = typeof entry.session_id === 'string' ? figures.get(entry.session_id) : undefined
      if (found === undefined) return line
      const added = Object.fromEntries(Object.entries(found).filter(([key, value]) => value !== undefined && !(key in entry)))
      return Object.keys(added).length === 0 ? line : jqText({ ...entry, ...added })
    })
    .join('\n')
}

/** The run files of an entry the retire cleanup may delete: what it names, by kind. */
export type RunFile = { kind: 'result' | 'error' | 'pid' | 'prompt'; path: string }

/** A run file a retire will not delete, with the reason (a fixed text) and the entry field's kind. */
export type RunFileRefusal = { kind: RunFile['kind']; path: string; name: string; reason: string }

const lastSegment = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** Whether a path has a `.` or `..` segment (either slash). */
const hasDotSegment = (path: string) => path.split(/[\\/]/).some(segment => segment === '.' || segment === '..')

/**
 * Why a path under the runs directory is not a file that sits directly in it, or undefined when it is: the path with
 * its slashes normalised (and, on Windows, its case) minus the runs directory and a slash is one name, no further
 * segment. On Windows a name with a colon (a stream) or one ending in a dot or a blank is no plain file name either.
 * The caller has checked the path starts with the runs directory and has no `.` or `..` segment.
 */
export function runFileLocationProblem(path: string, runsDir: string, isWindows: boolean): string | undefined {
  const norm = (value: string) => (isWindows ? winPath(value).toLowerCase() : value).replace(/\/+$/, '')
  const base = norm(runsDir)
  const one = norm(path)
  const rest = base !== '' && one.startsWith(`${base}/`) ? one.slice(base.length + 1) : undefined
  if (rest === undefined || rest === '' || rest.includes('/')) return 'not directly in the runs folder'
  if (isWindows && /[:]|[. ]$/.test(rest)) return 'not a plain file name'
  return undefined
}

/**
 * The run files a retire deletes for a session it removed whose outcome is clean or whose retire was reviewed: its
 * result file, its error file, the pid file beside the result file (the PowerShell route's, `<result less .json>.pid`)
 * and the prompt file the mod wrote for it. Only a file that sits directly in the runs directory: the path under the
 * runs directory is one name, with no `.` or `..` segment and no further folder (runFileLocationProblem). Never a
 * transcript (`.jsonl`), never one that another registry entry names in any field. `isUnder` says whether a path is
 * plainly inside the runs directory (compared as the platform does): one that is not is no run file of the mod and
 * is left alone without a word, as before; a path with a `.` or `..` segment, or under the runs directory but not
 * directly in it, is refused with its reason. Whether a file is a symbolic link is for the host's removeRegularFile.
 */
export function planRunFiles(
  entry: SessionEntry,
  others: readonly SessionEntry[],
  runsDir: string,
  isUnder: (path: string, dir: string) => boolean,
  isWindows = false,
): { files: RunFile[]; refused: RunFileRefusal[] } {
  const key = (value: string) => (isWindows ? winPath(value).toLowerCase() : value)
  const named = new Set<string>()
  for (const other of others) for (const value of Object.values(other)) if (typeof value === 'string') named.add(key(value))
  const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)
  const result = str(entry.result_file)
  const candidates: RunFile[] = []
  if (result !== undefined) candidates.push({ kind: 'result', path: result })
  const err = str(entry.err_file)
  if (err !== undefined) candidates.push({ kind: 'error', path: err })
  if (result !== undefined && result.endsWith('.json')) candidates.push({ kind: 'pid', path: `${result.slice(0, -'.json'.length)}.pid` })
  const prompt = str(entry.prompt_file)
  if (prompt !== undefined) candidates.push({ kind: 'prompt', path: prompt })
  const files: RunFile[] = []
  const refused: RunFileRefusal[] = []
  for (const file of candidates) {
    const reason = hasDotSegment(file.path) ? 'the path has . or .. segments' : !isUnder(file.path, runsDir) ? undefined : runFileLocationProblem(file.path, runsDir, isWindows)
    if (reason !== undefined) refused.push({ ...file, name: lastSegment(file.path), reason })
    else if (isUnder(file.path, runsDir) && !file.path.endsWith('.jsonl') && !named.has(key(file.path))) files.push(file)
  }
  // The pid file beside a result file that was refused is no news of its own.
  const isResultRefused = refused.some(one => one.kind === 'result')
  return { files, refused: refused.filter(one => one.kind !== 'pid' || !isResultRefused) }
}

/** The files planRunFiles lets through (see there); `isUnder` as there, the platform POSIX. */
export function runFilesToDelete(entry: SessionEntry, others: readonly SessionEntry[], runsDir: string, isUnder: (path: string, dir: string) => boolean): RunFile[] {
  return planRunFiles(entry, others, runsDir, isUnder).files
}

export const CLOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session_ids'],
  properties: {
    session_ids: sessionIds('Session ids (full, or the first 8 characters) of finished workers whose result the orchestrator has reported.'),
    keep: {
      type: 'boolean',
      description: 'true: only acknowledge and keep (acknowledge_workers with keep true); nothing is retired. false (default): acknowledge, then retire (acknowledge_workers, then retire_workers, with their refusals).',
    },
    reviewed: RETIRE_SCHEMA.properties.reviewed,
  },
} as const

// ---------------------------------------------------------------- native Windows

// Native Windows (Claude Code on Windows, Git Bash as the Bash tool's shell) has no sh, jq, mv or /proc on the
// PATH a command starts with. The functions below serve the Windows adapter (host-windows.ts), which selectHost picks
// from the environment, and the Windows cases of the pure checks above, which only that adapter switches on; on
// Linux and WSL none of them runs.

/**
 * A Windows path in the one form the mod stores and passes on: drive letter upper case, `/` separators, no
 * trailing separator (a drive root keeps its own). Takes `C:\x`, `C:/x` and Git Bash's `/c/x`; a UNC path
 * (`\\host\share`) becomes `//host/share`. Any other path comes back with its separators turned only.
 */
export function winPath(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const isUnc = /^\/\/[^/]/.test(slashed)
  const msys = /^\/([A-Za-z])(\/|$)/.exec(slashed)
  const drive = msys ? `${(msys[1] ?? '').toUpperCase()}:/${slashed.slice(3)}` : slashed.replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`)
  const cut = ((isUnc ? '/' : '') + drive.replace(/\/{2,}/g, '/')).replace(/\/+$/, '')
  if (/^[A-Z]:$/.test(cut)) return `${cut}/`
  return cut === '' ? '/' : cut
}

/** Whether a path is absolute on Windows: a drive (`C:/x`, `C:\x`, `/c/x`) or a UNC share. */
export function isWinAbsolute(path: string): boolean {
  const native = winPath(path)
  return /^[A-Z]:\//.test(native) || /^\/\/[^/]+\/[^/]/.test(native)
}

/** Whether two paths name the same place on Windows, whose file names ignore case. */
export function isSameWinPath(a: string, b: string): boolean {
  return winPath(a).toLowerCase() === winPath(b).toLowerCase()
}

/** What `tail -n <count> | cut -c1-<width>` prints of a text: its last lines, each cut to the width. */
export function tailLines(text: string, count: number, width: number): string {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
    .slice(-count)
    .map(line => line.slice(0, width) + '\n')
    .join('')
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Expands a leading `~` against the home directory. */
export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}

// --- decision presenter -----------------------------------------------------

export type PresentedPoint = {
  id: string
  title: string
  detail: string
  recommendation: string
}

/** Open, not held points of open-points.json, in file order (raise order). */
export function parseOpenPoints(text: string): { ok: true; points: PresentedPoint[] } | { ok: false; error: string } {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { ok: false, error: 'open-points.json does not parse' }
  }
  const list = (doc as { points?: unknown } | null)?.points
  if (!Array.isArray(list)) return { ok: false, error: 'open-points.json has no points array' }
  const points: PresentedPoint[] = []
  for (const raw of list) {
    const one = raw as Record<string, unknown> | null
    if (one === null || typeof one !== 'object' || one.status !== 'open' || one.hold === true) continue
    const str = (value: unknown) => (typeof value === 'string' ? value : '')
    points.push({ id: str(one.id), title: str(one.title), detail: str(one.detail), recommendation: str(one.recommendation) })
  }
  return { ok: true, points }
}

// --- report linter ----------------------------------------------------------

export type LintContext = {
  /** Peers that were sent a task and have not acknowledged it. */
  unackedPeers?: readonly string[]
}

/** Findings about an orchestrator report; empty when it is clean. */
export function lintReport(answer: string, ctx: LintContext): string[] {
  const out: string[] = []
  const text = answer.replace(/```[\s\S]*?```/g, block => block.replace(/^```.*$/gm, '')) // keep fenced bodies
  for (const peer of ctx.unackedPeers ?? []) {
    const name = escapeRegExp(peer)
    const verb = '\\b(done|updated|written|completed|applied)\\b'
    const near = new RegExp(`${name}[^.\\n]{0,80}${verb}|${verb}[^.\\n]{0,80}${name}`, 'i')
    if (near.test(answer) && !/unacknowledged|not acknowledged|awaiting/i.test(answer)) out.push(`${peer} has not acknowledged, but the report says the task is done`)
  }
  if (/\b(decision|open point)\s+#?\d+\s+(in|of)\s+agreed-decisions/i.test(answer) || /\bdecisions?\s+\d+\s*(?:,|and|-)\s*\d+/i.test(text)) {
    out.push('decision numbers are shown to the user')
  }
  if (/\bnot\b[^.\n;]{1,60},\s*but\b/i.test(text) || /,\s*rather than\b/i.test(text)) out.push('contrastive phrasing ("not X, but Y" / "rather than")')
  return out
}

// --- worker prompt checklist ------------------------------------------------

const PROMPT_ITEMS: readonly { name: string; test: RegExp }[] = [
  { name: 'foreground wait (never end the turn on a background watcher)', test: /foreground/i },
  { name: 'final report with `git status -sb`', test: /git status -sb/i },
  { name: 'no AI attribution in commit messages', test: /attribution|co-authored|trailer/i },
]

/** Items the worker prompt must carry; a prompt that says it is a skill test is exempt. */
export function missingPromptItems(prompt: string): string[] {
  if (/skill[- ]test/i.test(prompt)) return []
  return PROMPT_ITEMS.filter(item => !item.test.test(prompt)).map(item => item.name)
}

// --- state digest after compaction -----------------------------------------

/** Facts from the files, handed to the model after its context was summarized. */
export function compactionDigest(rows: readonly SessionRow[], openPoints: readonly PresentedPoint[] | null, peers: readonly string[] = []): string {
  const live = rows.filter(row => row.status === 'alive')
  const unreported = rows.filter(row => row.status === 'unreported')
  const workers = live.length === 0 ? 'none running' : live.map(row => `${row.sid8} ${row.title} (pid ${row.pid ?? '?'})`).join('; ')
  const finished = unreported.length === 0 ? '' : ` Finished and not yet reported: ${unreported.map(row => `${row.sid8} ${row.title}`).join('; ')}.`
  const points = openPoints === null ? 'unreadable' : openPoints.length === 0 ? 'none' : openPoints.map((p, i) => `${i + 1}. ${p.title}`).join(' | ')
  return (
    'session-control, after compaction (state from the files, trust it over the summary): ' +
    `workers: ${workers}.${finished} Open points: ${points}.${peers.length === 0 ? '' : ` Peers that have not acknowledged their task: ${peers.join(', ')}.`} ` +
    'Re-read the registry, open-points and task-queue files and the orchestrator rules before the next action.'
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- peer-message ledger ----------------------------------------------------

export type PeerNote = { to: string; at: number; excerpt: string; isAcked: boolean }

export function addPeerNote(ledger: readonly PeerNote[], to: string, text: string, at: number): PeerNote[] {
  return [...ledger, { to, at, excerpt: text.replace(/\s+/g, ' ').slice(0, 80), isAcked: false }].slice(-30)
}

/**
 * A reply from a peer. The delivery carries no sender name, so it clears the
 * entry whose peer the text names; with none named, and exactly one entry open,
 * that one.
 */
export function ackPeerNote(ledger: readonly PeerNote[], replyText: string): PeerNote[] {
  const open = ledger.filter(note => !note.isAcked)
  const lower = replyText.toLowerCase()
  const named = open.filter(note => lower.includes(note.to.toLowerCase()))
  const target = named.length > 0 ? named : open.length === 1 ? open : []
  return ledger.map(note => (target.includes(note) ? { ...note, isAcked: true } : note))
}

export function unackedPeers(ledger: readonly PeerNote[]): string[] {
  return [...new Set(ledger.filter(note => !note.isAcked).map(note => note.to))]
}

// --- live view of a worker -------------------------------------------------

/**
 * Where a worker's transcript lives: <config_dir>/projects/<cwd with every non-alphanumeric as ->/<sid>.jsonl. On
 * Windows the engine names the folder after its native cwd (C:\x\y is C--x-y), so the cwd is taken in that form.
 */
export function transcriptPath(entry: SessionEntry, isWindows = false): string | undefined {
  if (typeof entry.config_dir !== 'string' || typeof entry.cwd !== 'string' || typeof entry.session_id !== 'string') return undefined
  const cwd = isWindows ? winPath(entry.cwd) : entry.cwd
  return `${entry.config_dir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${entry.session_id}.jsonl`
}

/** Pick the entry a /session-control watch argument names: sid prefix or title fragment; none given = the first running one. */
export function pickWatched(rows: readonly SessionRow[], arg: string): SessionRow | undefined {
  const key = arg.trim().toLowerCase()
  if (key === '') return rows.find(row => row.status === 'alive')
  return rows.find(row => row.sid8 !== '' && row.sid8.toLowerCase().startsWith(key)) ?? rows.find(row => row.title.toLowerCase().includes(key))
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function toolSummary(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'description', 'prompt', 'query', 'url']) {
    if (typeof obj[key] === 'string') return oneLine(obj[key] as string, 140)
  }
  return ''
}

/** The last `maxLines` readable lines of a transcript's tail: assistant text, tool calls, short tool results. */
export function summarizeTranscript(tail: string, maxLines: number): string[] {
  const out: string[] = []
  for (const raw of tail.split('\n')) {
    if (raw.trim() === '') continue
    let row: { type?: string; message?: { content?: unknown } }
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    const content = row.message?.content
    if (row.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') out.push(oneLine(block.text, 400))
        else if (block.type === 'tool_use') out.push(`> ${String(block.name)} ${toolSummary(block.input)}`.trimEnd())
      }
    } else if (row.type === 'user' && Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'tool_result') continue
        const body = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
        out.push(`  < ${block.is_error === true ? 'ERROR ' : ''}${oneLine(body, 120)}`)
      }
    }
  }
  return out.slice(-maxLines)
}

// --- queued work ------------------------------------------------------------

export type QueuedTask = { title: string }

/** Tasks of task-queue.json whose status is exactly queued, in file order: running work is a session, not queued work. */
export function parseQueuedWork(text: string): QueuedTask[] | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const list = (doc as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(list)) return null
  return list
    .filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null && (one as { status?: unknown }).status === 'queued')
    .map(one => ({ title: typeof one.title === 'string' ? one.title : '(untitled)' }))
}

/** Lines hidden below the window after a wheel move, kept inside the history. */
export function nextBack(back: number, by: number, lines: number, visible: number): number {
  return Math.max(0, Math.min(back - by, Math.max(0, lines - visible)))
}

/** Where the pane window stays when a wheel tick belongs to the output box: its offset before the move, as a whole row. */
export function holdOffset(offset: number, by: number, contentRows: number, bodyRows: number): number {
  const max = Math.max(0, Math.floor(contentRows - bodyRows))
  if (by < 0 && offset <= 0) return 0
  if (by > 0 && offset >= max) return max
  return Math.min(max, Math.max(0, Math.round(offset - by)))
}

// --- panel layout: fixed sections, own scrolling, scrollbars ---------------

/** Word-wrap `text` into lines of at most `width` characters; a word longer than the width is cut. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, width)
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (let word of para.split(/\s+/).filter(x => x !== '')) {
      while (word.length > w) {
        if (line !== '') {
          out.push(line)
          line = ''
        }
        out.push(word.slice(0, w))
        word = word.slice(w)
      }
      if (line === '') line = word
      else if (line.length + 1 + word.length <= w) line += ' ' + word
      else {
        out.push(line)
        line = word
      }
    }
    out.push(line)
  }
  return out.length === 0 ? [''] : out
}

export function clampOffset(offset: number, total: number, visible: number): number {
  return Math.max(0, Math.min(Math.round(offset), Math.max(0, total - visible)))
}

/** One character per visible row: the thumb where the window sits, a thin track elsewhere. */
export function scrollbar(total: number, visible: number, offset: number): string[] {
  const rows = Math.max(1, visible)
  if (total <= visible) return Array.from({ length: rows }, () => ' ')
  const thumb = Math.max(1, Math.round((visible * visible) / total))
  const room = rows - thumb
  const top = Math.round((clampOffset(offset, total, visible) / (total - visible)) * room)
  return Array.from({ length: rows }, (_, i) => (i >= top && i < top + thumb ? '\u2503' : '\u2502'))
}

export type SectionId = 'sessions' | 'queue' | 'points' | 'log'
/** A box in the panel body; `isHeader` marks a collapsed section drawn as its one-line header. */
export type SectionBox = { id: SectionId; top: number; height: number; isHeader?: true }

/** Smallest box: two borders, the title, and three rows of content (the sessions box also holds a header row). */
export const MIN_BOX = 6
export const MIN_SESSIONS_BOX = 7

/** The sections a header icon expands to the whole panel body. */
export type ExpandableId = 'sessions' | 'queue' | 'points'

/** The sections in their order down the panel. */
export const SECTION_ORDER: readonly ExpandableId[] = ['sessions', 'queue', 'points']

/**
 * Heights of the boxes in the panel body: three equal thirds, or (log open) sessions one third and the log two thirds,
 * or (one section expanded, no log open) that section over the body less one row for each of the other two, which
 * stay in their order as one-line headers; never below three content rows.
 */
export function sectionBoxes(bodyRows: number, isLogOpen: boolean, expanded: ExpandableId | null = null): SectionBox[] {
  const third = Math.max(MIN_SESSIONS_BOX, Math.floor(bodyRows / 3))
  if (expanded !== null && !isLogOpen) {
    const height = Math.max(expanded === 'sessions' ? MIN_SESSIONS_BOX : MIN_BOX, bodyRows - (SECTION_ORDER.length - 1))
    let top = 0
    return SECTION_ORDER.map(id => {
      const box: SectionBox = id === expanded ? { id, top, height } : { id, top, height: 1, isHeader: true }
      top += box.height
      return box
    })
  }
  if (isLogOpen) {
    return [
      { id: 'sessions', top: 0, height: third },
      { id: 'log', top: third, height: Math.max(MIN_BOX + 2, bodyRows - third) },
    ]
  }
  const mid = Math.max(MIN_BOX, Math.floor(bodyRows / 3))
  return [
    { id: 'sessions', top: 0, height: third },
    { id: 'queue', top: third, height: mid },
    { id: 'points', top: third + mid, height: Math.max(MIN_BOX, bodyRows - third - mid) },
  ]
}

/** Which box a body row falls in. */
export function boxAt(boxes: readonly SectionBox[], row: number): SectionBox | undefined {
  return boxes.find(box => row >= box.top && row < box.top + box.height)
}
