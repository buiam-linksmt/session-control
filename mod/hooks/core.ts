// Pure functions of session-control: no `$`, no I/O. Everything they need is passed
// in (registry text, /proc facts as text, result-file text, clock), so tests
// run them on fixtures alone.

import type {
  SessionEntry,
  SessionOutcome,
  SessionOutcomeKind,
  SessionRow,
  SessionRowStatus,
  SessionSnapshot,
  SectionAnimation,
} from '../types'
import { readPointRecords, readTaskRecords, selectPoints } from './bookkeeping'

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

/**
 * Whether the entry's recorded pid is its worker still starting: the process lives (the probe read its start) and has
 * written no sessions file with a `procStart` yet (a resumed session's engine writes it only after loading the
 * transcript, which takes seconds), and the probe lists that pid as a headless claude whose command line carries the
 * entry's session name (`-n <name>`, which the launch passed) in the entry's cwd (any cwd when the probe read none, as
 * on Windows without the sessions file). Such a worker runs: it is never harvested as gone. It is no Abort-check proof:
 * stop_worker still refuses it until its sessions file proves it.
 */
export function isPidStarting(entry: SessionEntry, facts: ProcFacts): boolean {
  if (typeof entry.pid !== 'number' || typeof entry.name !== 'string' || entry.name === '') return false
  const proof = facts.pidProof.get(entry.pid)
  if (proof === undefined || proof.startTicks === '' || proof.fileStart !== '') return false
  const bare = (dir: string) => dir.replace(/[\\/]+$/, '')
  const cwd = typeof entry.cwd === 'string' ? bare(entry.cwd) : ''
  const name = entry.name
  return facts.claude.some(one => one.pid === entry.pid && isHeadless(one.cmdline) && hasSessionName(one.cmdline, name) && (one.cwd === '' || bare(one.cwd) === cwd))
}

export function rowStatus(entry: SessionEntry, facts: ProcFacts): SessionRowStatus {
  if (typeof entry.pid === 'number') return isPidAlive(entry, facts) || isPidStarting(entry, facts) ? 'alive' : 'dead'
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

/** Code points of East Asian wide or fullwidth characters a terminal draws in two cells (emoji aside: Emoji_Presentation). */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]
const ZERO_CELLS = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Emoji_Modifier}]$/u
const FLAG_HALF = /^\p{Regional_Indicator}$/u
const EMOJI = /^\p{Emoji_Presentation}$/u
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u
/** Printable ASCII only: one cell a character, no need to look at each. */
const PLAIN = /^[\x20-\x7e]*$/

/**
 * `text`'s code points, each with the cells a terminal gives it: two for a wide or fullwidth character, an emoji drawn
 * as one (a pictograph followed by the emoji variation selector too) and a flag (its first regional indicator); none
 * for a combining mark, a format or control character, a skin-tone modifier, a flag's second regional indicator and a
 * character a zero-width joiner joins to the one before; one for any other.
 */
function cellsOf(text: string): [string, number][] {
  const out: [string, number][] = []
  let isJoined = false
  let isFlagOpen = false
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    const isFlagHalf = FLAG_HALF.test(ch)
    let cells = 1
    if (isJoined || ZERO_CELLS.test(ch)) cells = 0
    else if (isFlagHalf) cells = isFlagOpen ? 0 : 2
    else if (EMOJI.test(ch) || WIDE_RANGES.some(([from, to]) => code >= from && code <= to)) cells = 2
    const last = out[out.length - 1]
    if (code === 0xfe0f && last !== undefined && last[1] === 1 && PICTOGRAPH.test(last[0])) last[1] = 2
    isFlagOpen = isFlagHalf && !isJoined && !isFlagOpen
    isJoined = code === 0x200d
    out.push([ch, cells])
  }
  return out
}

/** The width of `text` in terminal cells (cellsOf): a wide character or an emoji counts two, a combining mark none. */
export function cellWidth(text: string): number {
  if (PLAIN.test(text)) return text.length
  return cellsOf(text).reduce((sum, [, cells]) => sum + cells, 0)
}

/** The longest start of `text` that fits in `cells` cells; a character never splits from the marks that follow it. */
function headCells(text: string, cells: number): string {
  if (PLAIN.test(text)) return text.slice(0, Math.max(0, cells))
  let head = ''
  let used = 0
  for (const [ch, width] of cellsOf(text)) {
    if (used + width > cells) break
    head += ch
    used += width
  }
  return head
}

/** A row's elapsed column at the display clock: formatAge of elapsedSeconds, `-` when there is nothing to tell. */
export function elapsedText(row: SessionRow, clock?: ElapsedClock): string {
  const sec = elapsedSeconds(row, clock)
  return sec === undefined ? '-' : formatAge(sec)
}

/** The effort levels a worker launches with (launch_worker's effort). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The model family names the model column shows, per provider, with where each provider publishes its model names: an
 * entry's model is whatever launch_worker was given (`--model`: an alias or a full id, of Anthropic or of another
 * provider behind a compatible endpoint), and the column shows its family (modelFamily). The widest family sets the
 * column's width: `codestral`, `magistral`, `ministral` and `starcoder`, 9 cells.
 */
export const MODEL_FAMILIES: readonly { provider: string; source: string; families: readonly string[] }[] = [
  { provider: 'Anthropic', source: 'claude --help and the engine model list', families: ['fable', 'opus', 'sonnet', 'haiku'] },
  { provider: 'OpenAI', source: 'platform.openai.com/docs/models', families: ['gpt', 'codex', 'o1', 'o3', 'o4'] },
  { provider: 'Google', source: 'ai.google.dev/gemini-api/docs/models', families: ['gemini', 'gemma'] },
  { provider: 'DeepSeek', source: 'api-docs.deepseek.com', families: ['deepseek'] },
  { provider: 'Alibaba', source: 'Alibaba Cloud Model Studio (Qwen)', families: ['qwen', 'qwq'] },
  { provider: 'Moonshot AI', source: 'platform.moonshot.ai', families: ['kimi', 'moonshot'] },
  { provider: 'Zhipu AI', source: 'docs.z.ai', families: ['glm', 'chatglm', 'codegeex'] },
  { provider: 'Mistral AI', source: 'docs.mistral.ai/getting-started/models', families: ['mistral', 'mixtral', 'codestral', 'devstral', 'magistral', 'ministral', 'pixtral', 'voxtral'] },
  { provider: 'Meta', source: 'llama.com', families: ['llama'] },
  { provider: 'xAI', source: 'docs.x.ai', families: ['grok'] },
  { provider: 'MiniMax', source: 'platform.minimax.io', families: ['minimax'] },
  { provider: 'Cohere', source: 'docs.cohere.com', families: ['command', 'aya'] },
  { provider: 'Amazon', source: 'Amazon Bedrock model ids', families: ['nova', 'titan'] },
  { provider: 'Microsoft', source: 'Phi models on Azure AI Foundry', families: ['phi'] },
  { provider: 'Nvidia', source: 'build.nvidia.com', families: ['nemotron'] },
  { provider: 'IBM', source: 'ibm.com/granite', families: ['granite'] },
  { provider: 'AI21 Labs', source: 'docs.ai21.com', families: ['jamba'] },
  { provider: 'Baidu', source: 'ERNIE model list', families: ['ernie'] },
  { provider: 'Tencent', source: 'Hunyuan model list', families: ['hunyuan'] },
  { provider: 'ByteDance', source: 'Doubao and Seed model lists', families: ['doubao', 'seed'] },
  { provider: 'Perplexity', source: 'docs.perplexity.ai', families: ['sonar'] },
  { provider: 'BigCode', source: 'huggingface.co/bigcode', families: ['starcoder'] },
  { provider: '01.AI', source: 'Yi model list', families: ['yi'] },
  { provider: 'StepFun', source: 'Step model list', families: ['step'] },
  { provider: 'Shanghai AI Lab', source: 'InternLM model list', families: ['internlm'] },
  { provider: 'Baichuan', source: 'Baichuan model list', families: ['baichuan'] },
  { provider: 'TII', source: 'Falcon model list', families: ['falcon'] },
  { provider: 'Ai2', source: 'OLMo model list', families: ['olmo'] },
]
const FAMILY_NAMES = MODEL_FAMILIES.flatMap(one => one.families)

/**
 * The family a model value names, for the model column: the value in lower case is split at every character that is
 * not a letter or a digit, and the first part that is a family name, or a family name followed by a version number
 * (`qwen3`, `gpt4o`, `llama3`), gives the family. A vendor or brand part before it is passed over (`claude-opus-5-5[1m]`
 * opus, `us.anthropic.claude-sonnet-4-5-20250929-v1:0` sonnet, `moonshotai/kimi-k2` kimi, `deepseek-v3` deepseek).
 * A value that names no family (`opusplan`, `default`, `?`) is shown as it is, and cut by the column's width.
 */
export function modelFamily(model: string): string {
  for (const part of model.toLowerCase().split(/[^a-z0-9]+/)) {
    const family = FAMILY_NAMES.find(name => part === name || (part.startsWith(name) && /^\d/.test(part.slice(name.length))))
    if (family !== undefined) return family
  }
  return model
}
/** The elapsed column's fixed width holds every formatAge text below this many seconds (1000 hours, 41 days); a longer one is cut in its cell. */
export const ELAPSED_FIXED_SEC = 1000 * 3600

/** The width in cells of the widest of `texts`. */
function widestOf(texts: readonly string[]): number {
  return Math.max(...texts.map(cellWidth))
}

/**
 * The sessions rows' columns after the title, in their order: its header, a row's cell, and its fixed width in cells,
 * the widest text the column can hold, its header included, computed once: the session id 8 hex digits (`-` without
 * one), the status the widest label statusLabel gives, the model the widest family of MODEL_FAMILIES (modelFamily), the
 * effort the widest of EFFORTS (`?` for an entry without one), the elapsed the widest formatAge text below
 * ELAPSED_FIXED_SEC (`59m59s` under an hour, `999h59m`). The widths never depend on the rows: a longer value is cut in
 * its cell with an ellipsis. The terminal panel and panel_snapshot lay the cells out at these widths (paneWidths), the
 * desktop surface joins the same cells whole (desktopRowLines).
 */
export const SESSION_COLUMNS: readonly { id: 'sid' | 'status' | 'model' | 'effort' | 'elapsed'; header: string; cell: (row: SessionRow, clock?: ElapsedClock) => string; width: number }[] = [
  { id: 'sid', header: 'sid', cell: row => row.sid8 || '-', width: widestOf(['sid', '-', 'f'.repeat(8)]) },
  { id: 'status', header: 'status', cell: row => statusLabel(row.status), width: widestOf(['status', ...(Object.keys(STATUS_ORDER) as SessionRowStatus[]).map(statusLabel)]) },
  { id: 'model', header: 'model', cell: row => modelFamily(row.model), width: widestOf(['model', '?', ...FAMILY_NAMES]) },
  { id: 'effort', header: 'effort', cell: row => row.effort, width: widestOf(['effort', '?', ...EFFORTS]) },
  { id: 'elapsed', header: 'elapsed', cell: (row, clock) => elapsedText(row, clock), width: widestOf(['elapsed', '-', formatAge(59), formatAge(3599), formatAge(ELAPSED_FIXED_SEC - 1)]) },
]

/** The fewest cells the title column keeps however narrow the panel: the header `title`, or four cells of a title and the ellipsis. */
export const TITLE_MIN = 5
/** The title column's width when the panel has the room and no title is wider. */
const TITLE_FLOOR = 12

export type PaneWidths = { title: number; sid: number; status: number; model: number; effort: number; elapsed: number }

/**
 * The column widths for `rows` in `columns` cells: each column of SESSION_COLUMNS at its fixed width, whatever the rows
 * hold and however wide the panel, so the columns start at the same cells on every row and in every drawing. The title
 * takes the room left, up to its widest title (at least TITLE_FLOOR), and never less than TITLE_MIN: below that room
 * the row is cut at its right edge (formatRow). `_clock` is no longer read: no width depends on the elapsed text.
 */
export function paneWidths(rows: readonly SessionRow[], columns: number, _clock?: ElapsedClock): PaneWidths {
  const [sid, status, model, effort, elapsed] = SESSION_COLUMNS.map(column => column.width) as [number, number, number, number, number]
  const room = columns - (sid + status + model + effort + elapsed) - GAP.length * SESSION_COLUMNS.length
  const wanted = Math.max(TITLE_FLOOR, widestOf(['title', ...rows.map(row => row.title)]))
  return { title: Math.max(TITLE_MIN, Math.min(wanted, room)), sid, status, model, effort, elapsed }
}

/** `text` in exactly `width` cells: padded with blanks, or cut with an ellipsis (cellWidth). */
function fit(text: string, width: number): string {
  const head = cellWidth(text) > width ? headCells(text, Math.max(1, width - 1)) + '…' : text
  return head + ' '.repeat(Math.max(0, width - cellWidth(head)))
}

function cut(line: string, columns: number): string {
  return cellWidth(line) > columns ? headCells(line, Math.max(1, columns - 1)) + '…' : line
}

/** The last column's cell: unpadded, cut with an ellipsis when it is longer than its width. */
function fitLast(text: string, width: number): string {
  return cellWidth(text) > width ? fit(text, width) : text
}

/**
 * One pane line for a row: title, then the cells of SESSION_COLUMNS at `widths`, each cut in its cell when longer, the
 * last unpadded; cut to `columns`.
 */
export function formatRow(row: SessionRow, columns: number, widths: PaneWidths = paneWidths([row], columns), clock?: ElapsedClock): string {
  const cells = SESSION_COLUMNS.map((column, i) => (i === SESSION_COLUMNS.length - 1 ? fitLast(column.cell(row, clock), widths[column.id]) : fit(column.cell(row, clock), widths[column.id])))
  return cut([fit(row.title, widths.title), ...cells].join(GAP), columns)
}

/** The pane's column header, aligned with formatRow. */
export function formatHeader(columns: number, widths: PaneWidths): string {
  const cells = SESSION_COLUMNS.map((column, i) => (i === SESSION_COLUMNS.length - 1 ? column.header : fit(column.header, widths[column.id])))
  return cut([fit('title', widths.title), ...cells].join(GAP), columns)
}

/** What separates the cells of a row on a surface that draws text in a proportional font (desktopRowText). */
const DESKTOP_SEP = ' \u00B7 '

/**
 * A row's two lines on the desktop surface: its title, then formatRow's other cells in its order (session id, status,
 * model, effort, elapsed at the display clock), whole, joined by ` · `, with no padding and no cut. The desktop draws
 * text in a proportional font, collapses runs of blanks and reports a width in cells that is not its own, so fixed cell
 * widths there cut the row; and it draws a Button on one line, cut at the box's edge, so the cells go on a line of their
 * own. The panel wraps both lines at desktopLineChars.
 */
export function desktopRowLines(row: SessionRow, clock?: ElapsedClock): [string, string] {
  return [row.title, SESSION_COLUMNS.map(column => column.cell(row, clock)).join(DESKTOP_SEP)]
}

/** The column header of desktopRowLines' rows, its two lines. */
export const DESKTOP_HEADER: readonly [string, string] = ['title', SESSION_COLUMNS.map(column => column.header).join(DESKTOP_SEP)]

/**
 * Cells a bordered section of the desktop panel takes from the pane's width before its rows: Desktop draws the border as
 * 1 px a side and pads the box by its `pad.lg` a side (at most 1.25rem, 20 px, which is 2.8 cells at the smallest body
 * font, 12 px, whose cell is 0.604 em), and the scroll bar is one cell; 6.8, rounded up.
 */
export const DESKTOP_ROW_RESERVE = 7

/**
 * Cells a character of a desktop line is counted for. Desktop's cell is `1ch`, the width of `0` in the pane's font; in
 * anthropic-sans, regular and semibold, a line of the panel's own titles and details takes at most 0.95 cells a character
 * and a line of capitals 1.16, and DejaVu Sans, a Linux system font, no more; at 1.25 the widest of those lines still
 * fits, with 7 % to spare for capitals and 24 % for mixed text.
 */
export const DESKTOP_CELLS_PER_CHAR = 1.25

/**
 * The characters a line of the desktop panel holds in a pane `columns` cells wide (`bodyColumns`): the row column of a
 * bordered section (`isPlain` false) or of the compact panel's border-less box, less the reserve, counted at
 * DESKTOP_CELLS_PER_CHAR. The panel wraps its desktop rows to it with wrapText, so its rows are the lines shown.
 */
export function desktopLineChars(columns: number, isPlain = false): number {
  return Math.max(8, Math.floor((columns - (isPlain ? 2 : DESKTOP_ROW_RESERVE)) / DESKTOP_CELLS_PER_CHAR))
}

/**
 * Advance widths of Desktop's pane font, anthropic-sans, in hundredths of its `0` (the `1ch` cell `bodyColumns` counts):
 * U+0020 to U+007E, then U+00A0 to U+00FF, each the wider of its regular (400) and semibold (600) glyph, rounded up.
 * Read from the font file Desktop 4.4212.0 serves (cc27851ad-DDVos-BJ.woff2) with fontTools, kerning left out.
 */
const GLYPH_CELLS_ASCII = [
  36, 44, 78, 106, 90, 168, 120, 44, 69, 69, 81, 106, 44, 60, 44, 59, 102, 67, 99, 96, 105, 96, 97, 92, 96, 97, 44, 44, 106, 106, 106, 94, 146, 125, 110, 128, 125, 107, 100, 133, 125, 48, 93, 119,
  97, 159, 131, 136, 104, 136, 115, 102, 97, 121, 125, 173, 118, 117, 111, 69, 59, 69, 106, 83, 83, 94, 105, 95, 105, 99, 73, 98, 102, 45, 45, 99, 45, 149, 102, 99, 105, 105, 70, 88, 73, 100, 98, 141,
  103, 99, 86, 69, 52, 69, 106,
]
const GLYPH_CELLS_LATIN1 = [
  36, 44, 99, 106, 106, 106, 52, 106, 83, 106, 86, 78, 106, 60, 106, 83, 80, 106, 62, 60, 83, 103, 106, 44, 83, 54, 90, 78, 148, 146, 153, 94, 125, 125, 125, 125, 125, 125, 184, 128, 107, 107, 107,
  107, 48, 48, 48, 48, 140, 131, 136, 136, 136, 136, 136, 106, 136, 121, 121, 121, 121, 117, 104, 105, 94, 94, 94, 94, 94, 94, 151, 95, 99, 99, 99, 99, 45, 45, 45, 45, 99, 102, 99, 99, 99, 99, 99, 106,
  99, 100, 100, 100, 100, 99, 105, 99,
]

/** The same for the punctuation the panel and its texts use beyond Latin-1 (bullet, dashes, ellipsis, quotes, arrow). */
const GLYPH_CELLS_EXTRA: Readonly<Record<string, number>> = {
  '\u2022': 83,
  '\u2013': 83,
  '\u2014': 166,
  '\u2026': 166,
  '\u2018': 44,
  '\u2019': 44,
  '\u201C': 77,
  '\u201D': 77,
  '\u2192': 136,
}

/**
 * Cells a glyph outside the table is counted for: wider than any glyph in it (Æ, 1.84), and than an emoji or a CJK
 * character drawn at 1 to 1.25 em by a fallback font (1.66 to 2.07 cells of a `0` of 0.604 em).
 */
export const GLYPH_CELLS_DEFAULT = 2.1

/** The cells one character (a code point) takes in Desktop's pane font (the tables above), else GLYPH_CELLS_DEFAULT. */
export function glyphCells(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code >= 0x20 && code <= 0x7e) return (GLYPH_CELLS_ASCII[code - 0x20] as number) / 100
  if (code >= 0xa0 && code <= 0xff) return (GLYPH_CELLS_LATIN1[code - 0xa0] as number) / 100
  const extra = GLYPH_CELLS_EXTRA[ch]
  return extra === undefined ? GLYPH_CELLS_DEFAULT : extra / 100
}

/** The cells a text takes in Desktop's pane font: the sum of its glyphs (glyphCells). */
export function textCells(text: string): number {
  let sum = 0
  for (const ch of text) sum += glyphCells(ch)
  return sum
}

/**
 * Wraps text into lines of at most `room` cells by summed glyph widths (glyphCells), greedy at blanks as wrapText does:
 * each paragraph on its own, runs of blanks as one, the lines after the first `hang` blanks in (their cells counted),
 * a word wider than a line cut glyph by glyph, every piece at least one glyph.
 */
export function wrapCells(text: string, room: number, hang = 0): string[] {
  const pad = ' '.repeat(Math.max(0, Math.floor(hang)))
  const padCells = textCells(pad)
  const space = glyphCells(' ')
  const out: string[] = []
  const roomNow = () => Math.max(room - (out.length === 0 ? 0 : padCells), GLYPH_CELLS_DEFAULT)
  const push = (line: string) => out.push(out.length === 0 || line === '' ? line : pad + line)
  for (const para of text.split('\n')) {
    let line = ''
    let used = 0
    for (const word of para.split(/\s+/).filter(x => x !== '')) {
      const cells = textCells(word)
      if (line !== '' && used + space + cells <= roomNow()) {
        line += ' ' + word
        used += space + cells
        continue
      }
      if (line !== '') push(line)
      line = ''
      used = 0
      for (const ch of word) {
        const w = glyphCells(ch)
        if (line !== '' && used + w > roomNow()) {
          push(line)
          line = ''
          used = 0
        }
        line += ch
        used += w
      }
    }
    push(line)
  }
  return out.length === 0 ? [''] : out
}

/**
 * Cells a bordered section of the desktop panel's `sections` view takes from the pane's width before its rows: its 1 px
 * border and its `pad.lg` padding a side (at most 20 px, 2.8 cells at the smallest body font), 5.8 rounded up; it draws
 * no scroll bar, so no bar cell.
 */
export const SECTIONS_ROW_RESERVE = 6

/** The share of a `sections` line's room its glyphs may fill: 7 % kept free for kerning, hinting and a font fallback. */
export const SECTIONS_FILL = 0.93

/** The cells a line of the `sections` view may fill in a pane `columns` cells wide (`bodyColumns`). */
export function sectionsLineRoom(columns: number): number {
  return Math.max(8, (columns - SECTIONS_ROW_RESERVE) * SECTIONS_FILL)
}

/**
 * The `sections` view's splitter for desktopLines: a row's text wrapped by glyph widths into lines of sectionsLineRoom,
 * less the cells of an `indent` of that many blanks the lines are then drawn after.
 */
export function sectionsSplitter(columns: number): (text: string, hang: number, indent?: number) => string[] {
  const room = sectionsLineRoom(columns)
  return (text, hang, indent = 0) => wrapCells(text, room - textCells(' '.repeat(Math.max(0, Math.floor(indent)))), hang)
}

/** The blank a desktop row's `indent` is drawn with: a no-break space, which no surface collapses or wraps at. */
export const DESKTOP_INDENT = '\u00A0'

/** A row's text after its `indent` (DESKTOP_INDENT blanks), as the desktop draws it. */
export function indented(text: string, indent: number | undefined): string {
  return DESKTOP_INDENT.repeat(Math.max(0, Math.floor(indent ?? 0))) + text
}

/**
 * A row of the panel as desktopLines splits it; any other field is carried to each line. `indent`: blanks every line of
 * the row starts with (a queued task under its group), its text wrapped in the room left.
 */
export type DesktopRow = { text: string; key?: string; group?: string; press?: unknown; wrap?: 'wrap' | 'truncate-end'; hang?: number; indent?: number }

/**
 * A desktop row as the lines it takes in `chars` characters (wrapText, the row's `hang`), each drawn whole
 * (`truncate-end`): the line is within the width, so the surface never wraps it again, and one wider than the estimate is
 * ended with an ellipsis. A log or warning line (already `truncate-end`) stays one line. The lines of a pressable row
 * keep its press and share one hover scope (its group, else `<section>:<key>`); they are keyed as the terminal keys a
 * point's title lines: a key ending in `:0` counts on in its place, any other takes `:<line>`. `chars` is a count of
 * characters, or a splitter (sectionsSplitter) that wraps the text by the cells its glyphs take.
 */
export function desktopLines<R extends DesktopRow>(row: R, chars: number | ((text: string, hang: number, indent?: number) => string[]), section: string): R[] {
  if (row.wrap === 'truncate-end') return [row]
  const indent = Math.max(0, Math.floor(row.indent ?? 0))
  const texts = (typeof chars === 'number' ? wrapText(row.text, chars - indent, row.hang ?? 0) : chars(row.text, row.hang ?? 0, indent)).map(text => indented(text, indent))
  const key = row.key
  if (row.press === undefined || key === undefined || texts.length === 1) return texts.map(text => ({ ...row, text, wrap: 'truncate-end' as const }))
  const group = row.group ?? `${section}:${key}`
  const lineKey = (i: number) => (i === 0 ? key : key.endsWith(':0') ? `${key.slice(0, -1)}${i}` : `${key}:${i}`)
  return texts.map((text, i) => ({ ...row, text, wrap: 'truncate-end' as const, key: lineKey(i), group }))
}

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
  'finished-open': 'Finished session open',
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

/**
 * The id of the background task the Bash or PowerShell tool started (its answer `Command running in background with
 * ID: <id>. ...`), the `<task-id>` its task notification carries; undefined when the answer names none.
 */
export function backgroundTaskId(answer: string): string | undefined {
  return /\bbackground with ID: ([\w-]+)/.exec(answer)?.[1]
}

/**
 * Whether a result file holds a finished run: the engine's result object, a success or an error (`is_error` set either
 * way). A task notification's `killed` does not override such a run (complete).
 */
export function isFinishedRun(resultText: string): boolean {
  try {
    const value: unknown = JSON.parse(resultText)
    return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { is_error?: unknown }).is_error === 'boolean'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- launch guard

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
        'Append the standard rules block (no AI attribution, no human answers, no credentials, foreground waits, never end the turn on a live run, the report with git status -sb and git log --oneline @{u}..HEAD and their exit codes) when the prompt lacks what the launch guard checks. Default true with prompt or section, false for a prompt_file given alone (the worker runs on a mod-written copy of that file as read). A prompt that already carries the items, or a skill test, gets no block.',
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
 * text so far lacks an item the launch guard checks (a skill test lacks none, judged on the text given alone, so the
 * words in the section's lines make none). Blocks are set off by a blank line.
 */
export function composePrompt(text: string, section: { heading: string; body: string } | undefined, isRulesWanted: boolean): ComposedPrompt {
  const join = (head: string, block: string) => `${head.replace(/\s+$/, '')}\n\n${block.replace(/\s+$/, '')}\n`
  let out = text
  if (section !== undefined) out = join(out, `${sectionBlockTitle(section.heading)}\n\n${section.body}`)
  const isRulesAdded = isRulesWanted && missingPromptItems(out, /skill[- ]test/i.test(text)).length > 0
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
    if (isPidAlive(entry, ctx.facts) || isPidStarting(entry, ctx.facts)) return { ok: false, reason: `refused: pid ${entry.pid} of that session is alive` }
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
 * Whether a command line passes the session name `name` with `-n`: the word itself, or in the quotes Windows puts around
 * an argument with a blank. A launch's name is unique per launch (launchName), so it tells two launches of the same
 * dir, config dir and model apart.
 */
export function hasSessionName(cmdline: string, name: string): boolean {
  const word = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)-n\\s+(["']?)${word}\\2(\\s|$)`).test(cmdline)
}

/**
 * The new `claude -p` worker a launch started: a headless claude in the launch dir under the launch's
 * config dir, with the launch's model and, when `want.name` is given, the launch's session name (hasSessionName), that
 * was not there before. Undefined while it has not appeared.
 */
export function findNewWorker(
  facts: ProcFacts,
  want: { dir: string; configDir: string; model: string; name?: string },
  known: ReadonlySet<number>,
): ProcFact | undefined {
  const dir = want.dir.replace(/\/+$/, '')
  return facts.claude.find(
    one =>
      !known.has(one.pid) &&
      isHeadless(one.cmdline) &&
      one.cwd.replace(/\/+$/, '') === dir &&
      one.configDir === want.configDir &&
      one.cmdline.includes(`--model ${want.model}`) &&
      (want.name === undefined || hasSessionName(one.cmdline, want.name)),
  )
}

/**
 * findNewWorker on native Windows: the same match, with paths compared as Windows compares them. A claude.exe whose
 * sessions file the probe found nowhere (no cwd, no config dir) still counts when it is headless, has the launch's
 * model (and name, when given) and is younger than the launch; its session id is then read from the launch's config dir.
 */
export function findNewWindowsWorker(
  facts: ProcFacts,
  want: { dir: string; configDir: string; model: string; name?: string },
  known: ReadonlySet<number>,
  launchedSecAgo: number,
): ProcFact | undefined {
  const fresh = facts.claude.filter(
    one => !known.has(one.pid) && isHeadless(one.cmdline) && one.cmdline.includes(`--model ${want.model}`) && (want.name === undefined || hasSessionName(one.cmdline, want.name)),
  )
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
 * entry then records `prompt_file` (deleted with the run's other files at a clean retire) and `section`. Without a
 * `pid` (a worker registered from its result file, registerFinished) the entry has none.
 */
export function newRegistryEntry(
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string },
  pid: number | undefined,
  sessionId: string,
  files: { result: string; err: string },
  inbox: { name: string; socketPath?: string },
  startedSec: number,
  prompt: { promptFile?: string; section?: string } = {},
): SessionEntry {
  const socket = inbox.socketPath !== undefined ? { socket_path: inbox.socketPath } : verdict.resumeSid ? { socket_path: null } : {}
  return {
    title: args.title,
    ...(pid === undefined ? {} : { pid }),
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

/**
 * REGISTER_SCRIPT: `new` appends the entry; `resume` merges it over every entry with its session id, dropping `reported`,
 * `outcome` and `ended_at`. `new` refuses a session id an entry already holds (REGISTER_SCRIPT appends a second entry):
 * a registry holds one entry per session.
 */
export function registerEntry(text: string, entry: SessionEntry, mode: 'new' | 'resume'): RegistryEdit {
  if (mode === 'resume' && text.trim() === '') return { ok: true, text: '' }
  const read = registryList(text)
  if (!read.ok) return read
  const fresh = jqStrings(entry) as Rec | undefined
  if (fresh === undefined) return { ok: false, error: 'the entry holds an unpaired surrogate' }
  if (mode === 'new') {
    const sid = fresh.session_id
    if (typeof sid === 'string' && sid !== '' && read.list.some(one => typeof one === 'object' && one !== null && jqEqual((one as Rec).session_id, sid))) {
      return { ok: false, error: `the registry holds session ${sid} already` }
    }
    return { ok: true, text: jqText([...read.list, fresh], 2) + '\n' }
  }
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

/**
 * registerEntry for a worker that ended before the launch read its sessions file, registered from its result file: the
 * entry it wrote (`new`: the one appended; `resume`: each one with its session id) is then as the harvest leaves one
 * (mergeCompletion): no `pid`, `reported` false and, with `finished` (completionWrites on), the outcome and `ended_at`.
 */
export function registerFinished(text: string, entry: SessionEntry, mode: 'new' | 'resume', finished?: { outcome: SessionOutcome; endedSec: number }): RegistryEdit {
  const registered = registerEntry(text, entry, mode)
  if (!registered.ok || registered.text === '') return registered
  const read = registryList(registered.text)
  if (!read.ok) return read
  const ended = (one: unknown) => {
    const rec = one as Rec
    delete rec.pid
    rec.reported = false
    if (finished === undefined) return
    const { outcome } = finished
    rec.outcome = { kind: outcome.kind, summary: outcome.summary, ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }) }
    rec.ended_at = finished.endedSec
  }
  if (mode === 'new') ended(read.list.at(-1))
  else for (const one of read.list) if (one !== null && jqEqual((one as Rec).session_id, entry.session_id)) ended(one)
  return { ok: true, text: jqText(read.list, 2) + '\n' }
}

/**
 * The refusal of a resume's registry write when the registry holds no entry for its session any more (retired while the
 * launch ran): registerEntry would leave the registry as it is, and the launch would say registered.
 */
export function resumeGone(text: string, sessionId: string, mode: 'new' | 'resume'): RegistryEdit | undefined {
  if (mode !== 'resume') return undefined
  const parsed = parseRegistry(text)
  if (!parsed.ok || parsed.entries.some(one => one.session_id === sessionId)) return undefined
  return { ok: false, error: `the registry holds no entry for session ${sessionId} any more (retired while the launch ran); the worker runs unregistered` }
}

/**
 * The inbox a running worker's sessions file named after the launch registered it without one (a resume whose file came
 * late): `socket_path`, and `name` when given, set on each entry with that session id that still records that pid;
 * every other entry, and every other field, stays. Unchanged text when no entry matches (it was harvested or resumed
 * again meanwhile) or the values are there already.
 */
export function setInbox(text: string, sessionId: string, pid: number, inbox: { socketPath: string; name?: string }): RegistryEdit {
  const read = registryList(text)
  if (!read.ok) return read
  if (!read.list.every(isEntryOrNull)) return NOT_AN_ENTRY
  const fields = jqStrings({ socket_path: inbox.socketPath, ...(inbox.name === undefined ? {} : { name: inbox.name }) }) as Rec | undefined
  if (fields === undefined) return { ok: false, error: 'the inbox holds an unpaired surrogate' }
  let isChanged = false
  const list = read.list.map(one => {
    const rec = one as Rec | null
    if (rec === null || rec.session_id !== sessionId || rec.pid !== pid) return one
    if (Object.entries(fields).every(([key, value]) => rec[key] === value)) return one
    isChanged = true
    return { ...rec, ...fields }
  })
  return { ok: true, text: isChanged ? jqText(list, 2) + '\n' : text }
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

/** Whether a text names a session: its full id, its first 8 characters or its session name (the queue checks, the queue-ready notice). */
export function namesSession(text: string, entry: SessionEntry): boolean {
  const sid = typeof entry.session_id === 'string' ? entry.session_id : ''
  const name = typeof entry.name === 'string' ? entry.name : ''
  return (sid !== '' && (text.includes(sid) || text.includes(sid.slice(0, 8)))) || (name !== '' && text.includes(name))
}

/**
 * The one rule by which a task names a session, for retire_workers, audit_state and the finished-open notice: a task
 * not done (activeQueueText) holds the session's full id, its first 8 characters or its session name (namesSession).
 * `queueText` undefined is no queue file (no task names a session); null is a queue file that is there and cannot be
 * read, answered undefined: whether a task names a session is unknown, and each caller then retires or lists none.
 */
export function taskNamer(queueText: string | null | undefined): ((entry: SessionEntry) => boolean) | undefined {
  if (queueText === null) return undefined
  const active = activeQueueText(queueText ?? '')
  return entry => namesSession(active, entry)
}

/** retireVerdict's reason for a session it would retire while the queue file cannot be read. */
export const QUEUE_UNREADABLE_REASON = 'task-queue.json cannot be read, so a task may name it'

/** The entry a session id names: the full id or its first characters. */
export function findBySid(entries: readonly SessionEntry[], id: string): (SessionEntry & { session_id: string }) | undefined {
  return entries.find((one): one is SessionEntry & { session_id: string } => typeof one.session_id === 'string' && (one.session_id === id || one.session_id.startsWith(id)))
}

/**
 * Which of the named sessions may leave the registry: finished (no live pid), a clean outcome (anything that
 * needs a resume stays), not marked `keep`, and not named by a task of the queue file (taskNamer; `rawQueueText` null,
 * a queue file that cannot be read, retires none). The orchestrator calls this when the work is acknowledged and the
 * session is not needed for a resume or for new work with its context.
 */
export function retireVerdict(
  entries: readonly SessionEntry[],
  facts: ProcFacts,
  rawQueueText: string | null,
  ids: readonly string[],
  reviewed: Readonly<Record<string, unknown>> = {},
): RetireVerdict {
  const isNamedByTask = taskNamer(rawQueueText)
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
    else if (isNamedByTask === undefined) verdict.refused.push({ id, reason: QUEUE_UNREADABLE_REASON })
    else if (isNamedByTask(entry)) verdict.refused.push({ id, reason: 'a queued or running task names it' })
    else {
      verdict.removable.push(sid)
      if (isReviewed) (verdict.reviewed ??= []).push({ session_id: sid, was: String(outcome?.kind), reason: String(reason).trim() })
    }
  }
  return verdict
}

/** The keys a tool.call event carries beside the tool's own arguments (the engine's envelope). */
const CALL_ENVELOPE_KEYS: ReadonlySet<string> = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

/**
 * Why a call of acknowledge_workers, retire_workers or close_worker names no session: `session_ids` missing, not a
 * list of strings or empty (the engine hands the call on as given, a misspelt `session_id` included). The refusal names
 * what the call gave (its keys, never a value but a session id's first 8 characters) and the call to make instead;
 * undefined when the list is usable.
 */
export function sessionIdsProblem(tool: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const ids = input.session_ids
  if (Array.isArray(ids) && ids.length > 0 && ids.every(one => typeof one === 'string')) return undefined
  const keys = Object.keys(input).filter(key => !CALL_ENVELOPE_KEYS.has(key) && key !== 'session_ids')
  const single = typeof input.session_id === 'string' ? input.session_id.replace(/[^0-9a-fA-F-]/g, '').slice(0, 8) : ''
  const given = ids === undefined ? `no session_ids${keys.length === 0 ? '' : ` (it gave ${keys.join(', ')})`}` : Array.isArray(ids) ? (ids.length === 0 ? 'an empty session_ids' : 'a session_ids that is not a list of strings') : 'a session_ids that is not a list'
  return `${tool} needs session_ids, a non-empty list of session ids; the call gave ${given}, so nothing was acknowledged or retired. Call ${tool} with session_ids ["${single === '' ? '<session id>' : single}"]`
}

/**
 * close_worker's closing sentence for the sessions retire_workers refused (decision mod-51): per session its id's first 8
 * characters and the exact next call that disposes of it, by the refusal's reason; '' when nothing was refused. A `marked
 * keep` refusal never reaches it: close_worker's acknowledgement with keep false clears the mark before the retire.
 */
export function closeNextCalls(refused: readonly { id: string; reason: string }[]): string {
  if (refused.length === 0) return ''
  const next = refused.map(({ id, reason }) => {
    const id8 = id.slice(0, 8)
    const ids = `session_ids ["${id8}"]`
    if (reason === 'no registry entry') return `${id8}: no registry entry: list_sessions shows the registry, and a retired session is in cleared.jsonl; nothing to retire`
    if (reason === 'its process is alive') return `${id8}: not acknowledged, its process is alive: wait for its exit (stop_worker when it must end), then close_worker with ${ids} again`
    if (reason === 'its exit was not classified yet') return `${id8}: its exit is not classified yet: after the next poll's harvest (list_sessions shows it finished), close_worker with ${ids} again`
    if (/^outcome .* needs a resume$/.test(reason)) return `${id8}: ${reason}: resume it with launch_worker resume_sid when its work is unfinished; else, after reading its transcript, close_worker with ${ids} and reviewed {"${id8}": "<reason>"}`
    if (reason === 'a queued or running task names it') return `${id8}: a task not done names it: launch or finish that task, or correct it with queue_task; then retire_workers with ${ids}`
    if (reason === QUEUE_UNREADABLE_REASON) return `${id8}: ${reason}: raise an open point for the queue file; once it reads, retire_workers with ${ids}`
    if (reason === 'reviewed needs a non-empty reason') return `${id8}: give reviewed a non-empty reason for "${id8}"`
    if (reason === 'reviewed names no session of session_ids') return `${id8}: key reviewed by an id that session_ids lists`
    return `${id8}: ${reason}`
  })
  return ` Next: ${next.join('; ')}.`
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

/** Open, not held points of open-points.json, in file order (raise order); read and filtered as the open_point list action does. */
export function parseOpenPoints(text: string): { ok: true; points: PresentedPoint[] } | { ok: false; error: string } {
  const parsed = readPointRecords(text)
  if (!parsed.ok) return parsed
  return { ok: true, points: selectPoints(parsed.records, 'open').map(({ id, title, detail, recommendation }) => ({ id, title, detail, recommendation })) }
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

/**
 * Items the worker prompt must carry; a skill test is exempt. Whether it is one is judged on `isSkill`: by default the
 * prompt itself, at a launch the text the orchestrator wrote, never a block the mod appended to it.
 */
export function missingPromptItems(prompt: string, isSkill = /skill[- ]test/i.test(prompt)): string[] {
  if (isSkill) return []
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

/** A queued task as the panel draws it: its title and the project whose group it is listed under (projectOf). */
export type QueuedTask = { title: string; project: string }

/** The group of the queued tasks that name no project and whose dir lies under no project folder: drawn last. */
export const GENERAL_PROJECT = 'General'

/**
 * The workspaces directory (the parent of the orchestrator directory) and the names of the folders directly under it, as
 * a project of a task's dir is derived from them (projectFromDir); `home` expands a dir's leading `~`; `worktrees` maps a
 * folder that is a git worktree of another folder there to that folder (worktreeBase), for the folders read so far.
 */
export type Workspace = { root: string; folders: readonly string[]; home?: string; worktrees?: Readonly<Record<string, string>> }

/** The parent of a directory in its own path form (`/` or `\` separators), trailing separators aside; '' at a root. */
export function parentDir(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at <= 0 ? '' : trimmed.slice(0, at)
}

/** A workspace's root with `\\` read as `/` and no trailing separator, and how its paths compare (without case under a drive root). */
function workspaceRoot(workspace: Workspace): { root: string; same: (text: string) => string } {
  const root = workspace.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const isFolded = /^[A-Za-z]:\//.test(root)
  return { root, same: (text: string) => (isFolded ? text.toLowerCase() : text) }
}

/**
 * The first folder under the workspaces directory a dir lies in, as the dir spells it; undefined for a dir that is not
 * under it, the workspaces directory itself, or no workspace known. Paths compare with `\\` read as `/`, and without case
 * when the root is a drive path (Windows).
 */
export function workspaceFolder(dir: string, workspace: Workspace | undefined): string | undefined {
  if (workspace === undefined) return undefined
  const { root, same } = workspaceRoot(workspace)
  if (root === '') return undefined
  const expanded = workspace.home !== undefined && /^~([\\/]|$)/.test(dir) ? workspace.home + dir.slice(1) : dir
  const path = expanded.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!same(path).startsWith(same(root) + '/')) return undefined
  const first = path.slice(root.length + 1).split('/')[0] ?? ''
  return first === '' || first === '.' || first === '..' ? undefined : first
}

/**
 * The project a dir belongs to: the first folder under the workspaces directory (workspaceFolder), or, when that folder
 * is a git worktree of another folder there (its `.git` a file whose gitdir points into that folder's `.git/worktrees`,
 * as `worktrees` records it), that other folder. A folder with its own `.git` directory, with none, or no longer there
 * is its own project.
 */
export function projectFromDir(dir: string, workspace: Workspace | undefined): string | undefined {
  const first = workspaceFolder(dir, workspace)
  if (first === undefined || workspace === undefined) return undefined
  const { same } = workspaceRoot(workspace)
  const base = Object.entries(workspace.worktrees ?? {}).find(([name]) => same(name) === same(first))?.[1]
  return base ?? first
}

/**
 * The folder under the workspaces directory that `folder` is a git worktree of, from the text of `folder`'s `.git` file:
 * its first line `gitdir: <path>` (a relative path read from `folder`) must name `<root>/<base>/.git/worktrees/<name>`
 * where `<base>` is another folder of the listing; answered as the listing spells it. Undefined otherwise: a gitdir
 * outside the workspaces directory, into a folder not listed, or not under `.git/worktrees` (a submodule's).
 */
export function worktreeBase(gitFile: string, workspace: Workspace, folder: string): string | undefined {
  const { root, same } = workspaceRoot(workspace)
  if (root === '') return undefined
  const given = /^gitdir:(.*)$/.exec(gitFile.split(/\r?\n/)[0] ?? '')?.[1]?.trim().replace(/\\/g, '/') ?? ''
  if (given === '') return undefined
  const isAbsolute = given.startsWith('/') || /^[A-Za-z]:\//.test(given)
  const parts: string[] = []
  for (const part of (isAbsolute ? given : `${root}/${folder}/${given}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && !(part === '' && parts.length > 0)) parts.push(part)
  }
  const path = parts.join('/')
  if (!same(path).startsWith(same(root) + '/')) return undefined
  const [base = '', git, worktrees, name = ''] = path.slice(root.length + 1).split('/')
  if (git !== '.git' || worktrees !== 'worktrees' || name === '' || same(base) === same(folder)) return undefined
  return workspace.folders.find(one => one !== '' && same(one) === same(base))
}

/**
 * The folders of the listing that the queued tasks taking their project from their dir (needsWorkspace) lie in, each
 * once, as the listing spells them: the only folders whose `.git` is read (worktreeBase).
 */
export function queuedFolders(text: string, workspace: Workspace): string[] {
  const { same } = workspaceRoot(workspace)
  const names = (readTaskRecords(text) ?? []).flatMap(task => {
    const { dir, project } = task.fields
    if (task.status !== 'queued' || typeof dir !== 'string' || dir === '' || (typeof project === 'string' && project.trim() !== '')) return []
    const first = workspaceFolder(dir, workspace)
    const listed = first === undefined ? undefined : workspace.folders.find(one => same(one) === same(first))
    return listed === undefined ? [] : [listed]
  })
  return [...new Set(names)]
}

/** A task's project: its own `project` field (trimmed), else the one its `dir` lies in (projectFromDir), else General. */
export function projectOf(fields: Readonly<Record<string, unknown>>, workspace?: Workspace): string {
  const own = typeof fields.project === 'string' ? fields.project.trim() : ''
  if (own !== '') return own
  const dir = typeof fields.dir === 'string' ? fields.dir : ''
  return (dir === '' ? undefined : projectFromDir(dir, workspace)) ?? GENERAL_PROJECT
}

/** Whether a queued task of the queue's text takes its project from its dir: a dir and no project of its own. */
export function needsWorkspace(text: string): boolean {
  return (readTaskRecords(text) ?? []).some(task => task.status === 'queued' && typeof task.fields.dir === 'string' && task.fields.dir !== '' && !(typeof task.fields.project === 'string' && task.fields.project.trim() !== ''))
}

/** Tasks of task-queue.json whose status is exactly queued, in file order: running work is a session, not queued work. Read as the queue_task list action does. */
export function parseQueuedWork(text: string, workspace?: Workspace): QueuedTask[] | null {
  return readTaskRecords(text)?.filter(task => task.status === 'queued').map(({ title, fields }) => ({ title, project: projectOf(fields, workspace) })) ?? null
}

/** One group of the queued work: a project and its tasks in file order. */
export type QueueGroup<T extends { project: string } = QueuedTask> = { project: string; tasks: T[] }

/** The queued tasks grouped by project, the groups in order of their first task in the file, General last. */
export function queueGroups<T extends { project: string }>(tasks: readonly T[]): QueueGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const task of tasks) {
    const list = groups.get(task.project)
    if (list === undefined) groups.set(task.project, [task])
    else list.push(task)
  }
  const all = [...groups].map(([project, list]) => ({ project, tasks: list }))
  return [...all.filter(one => one.project !== GENERAL_PROJECT), ...all.filter(one => one.project === GENERAL_PROJECT)]
}

/** The longest group id groupKey keeps whole: its row's hover scope `q:<id>:t` stays within the 64 characters a surface takes. */
export const GROUP_KEY_MAX = 40

/**
 * The id a queue group's rows are keyed by (`q:<id>:0`, `q:<id>:t:0`) and its hover scope (`q:<id>:t`): the project URI
 * encoded, or for a longer one its first 30 characters and a hash of the whole name, so a key never grows past what a
 * surface accepts (a hover scope over 64 characters makes the surface refuse the whole tree).
 */
export function groupKey(project: string): string {
  const encoded = encodeURIComponent(project)
  if (encoded.length <= GROUP_KEY_MAX) return encoded
  let hash = 2166136261
  for (let i = 0; i < project.length; i++) hash = Math.imul(hash ^ project.charCodeAt(i), 16777619) >>> 0
  return `${encoded.slice(0, 30)}~${hash.toString(16).padStart(8, '0')}`
}

/** A group's row text: the project and the number of its tasks. */
export function groupLabel(group: { project: string; tasks: readonly unknown[] }): string {
  return `${group.project} (${group.tasks.length})`
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

/**
 * Word-wrap `text` into lines of at most `width` characters; a word longer than the width is cut. With `hang`, every
 * line after the first (the lines after a line break in `text` included) starts with that many blanks and is wrapped to
 * the width less them, so no line is longer than the width; an empty line stays empty. Linear in the text's length.
 */
export function wrapText(text: string, width: number, hang = 0): string[] {
  const w = Math.max(8, width)
  const indent = hang > 0 ? Math.min(Math.floor(hang), w - 1) : 0
  const pad = ' '.repeat(indent)
  const out: string[] = []
  // The room of the line being built: the whole width for the first line, less the indent for the lines after it.
  const room = () => (out.length === 0 ? w : w - indent)
  const push = (line: string) => out.push(out.length === 0 || line === '' ? line : pad + line)
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(x => x !== '')) {
      if (line !== '' && line.length + 1 + word.length <= room()) {
        line += ' ' + word
        continue
      }
      if (line !== '') push(line)
      // A word longer than the room is cut piece by piece, each piece as long as the room of the line it starts.
      let at = 0
      while (word.length - at > room()) {
        const cut = room()
        push(word.slice(at, at + cut))
        at += cut
      }
      line = at === 0 ? word : word.slice(at)
    }
    push(line)
  }
  return out.length === 0 ? [''] : out
}

/** The narrowest log box whose wrapped entries get a hanging indent: in a box of 20 columns or less the two columns stay text. */
export const LOG_HANG_MIN_WIDTH = 21

/**
 * A log line as the terminal panel and panel_snapshot wrap it: a tool call (`> `) or a tool result (`  < `, whose leading
 * blanks wrapText drops) keeps its continuation lines under the text after the marker, two blanks in; the worker's own
 * text, and any line in a box narrower than LOG_HANG_MIN_WIDTH, wraps as wrapText does. A line that fits is unchanged.
 * The desktop ends each log line at its own width (one row per line), so it has no continuation line to indent.
 */
export function wrapLogLine(line: string, width: number): string[] {
  return wrapText(line, width, width >= LOG_HANG_MIN_WIDTH && /^(?:> | {2}< )/.test(line) ? 2 : 0)
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

/**
 * Blank rows the desktop panel draws above and below its boxes. Claude Desktop scrolls a pane's body by itself and
 * reports a move (with no pointer) only once the body has moved, so a panel exactly as tall as the body leaves the wheel
 * nothing to move; with these rows the body has room both ways, and the scroll hook puts the window back in their middle.
 */
export const DESKTOP_SPARE_ROWS = 8

/** A section's window as last drawn: its rows, the rows it shows, the first row shown. */
export type BoxWindow = { total: number; visible: number; from: number }

/**
 * The section a wheel move with no pointer scrolls (the desktop sends none): the one the last such move scrolled, while
 * it still has rows that way; otherwise, moving down, the first section from the top with rows below its window, moving
 * up, the first from the bottom with rows above it. Undefined when no section has rows that way.
 */
export function wheelTarget(order: readonly SectionId[], windows: Partial<Record<SectionId, BoxWindow>>, by: number, last?: SectionId): SectionId | undefined {
  const canMove = (id: SectionId) => {
    const w = windows[id]
    return w !== undefined && (by > 0 ? w.from < w.total - w.visible : by < 0 && w.from > 0)
  }
  if (last !== undefined && order.includes(last) && canMove(last)) return last
  return (by > 0 ? order : [...order].reverse()).find(canMove)
}

/**
 * How the desktop panel lets the wheel scroll its sections (option desktopPaneScroll). Claude Desktop scrolls a pane's
 * body by itself, shows the body's own scroll bar whenever the body can move, and tells Claude Code of a move only once
 * the body has moved; no prop of a plugin's tree reaches that body's style. `spare`: the panel stands between
 * DESKTOP_SPARE_ROWS blank rows above and below, always. `overflow`: the same rows only while a section has more rows than
 * it shows. `minimal`: one blank row above and below, always. `overflow-minimal`: one row, only while a section has more
 * rows than it shows. `buttons`: no blank rows (the body never moves), each such section an up and a down button.
 * `drag`: no blank rows, each such section's scroll bar a slider to drag (a Client surface module). `page`: no window at
 * all: every section drawn whole at its natural height, one below the other, and the body scrolls the page by itself.
 * `sections`: three fixed boxes exactly as tall as the room, none scrolling, a box with more lines than it shows ending
 * on a `+N more` line and offering `[+]`, which draws that section alone as a page the body scrolls by itself.
 */
export const DESKTOP_PANE_SCROLLS = ['spare', 'overflow', 'minimal', 'overflow-minimal', 'buttons', 'drag', 'page', 'sections'] as const
export type DesktopPaneScroll = (typeof DESKTOP_PANE_SCROLLS)[number]

/** The option's value as the mod uses it: an unknown value, or none, counts as `spare`. */
export function desktopPaneScroll(value: unknown): DesktopPaneScroll {
  return (DESKTOP_PANE_SCROLLS as readonly unknown[]).includes(value) ? (value as DesktopPaneScroll) : 'spare'
}

/**
 * The blank rows a desktop panel that fits its room is drawn between, above and below, under a strategy; `isOverflowing`:
 * some section has more rows than it shows. One row is the least that lets the body move both ways: the page reports a
 * move in whole rows (its first visible row, rounded).
 */
export function desktopSpareRows(mode: DesktopPaneScroll, isOverflowing: boolean): number {
  switch (mode) {
    case 'spare':
      return DESKTOP_SPARE_ROWS
    case 'overflow':
      return isOverflowing ? DESKTOP_SPARE_ROWS : 0
    case 'minimal':
      return 1
    case 'overflow-minimal':
      return isOverflowing ? 1 : 0
    default:
      return 0
  }
}

/**
 * The page value's caps (desktopPaneScroll `page`): the log's latest entries drawn (the log view holds up to 300; a
 * worker's median transcript gives 60, one in ten more than 220), and the rows a list draws (sessions, queued tasks, open
 * points; the registry, the queue and the open points have held tens at most).
 */
export const PAGE_LOG_CAP = 100
export const PAGE_LIST_CAP = 50

/** A list as the page draws it: at most `cap` items, its first or its latest, and how many are left out. */
export function pageCap<T>(items: readonly T[], cap: number, keep: 'first' | 'latest'): { shown: T[]; more: number } {
  const more = Math.max(0, items.length - cap)
  return { shown: keep === 'first' ? items.slice(0, cap) : items.slice(more), more }
}

/**
 * The log's latest entries an expanded log of the `sections` view draws: the log view's own limit (summarizeTranscript
 * keeps 300), so the page shows the whole view; at most 300 Texts, drawn again only when the log or the panel changes.
 */
export const SECTIONS_LOG_CAP = 300

/**
 * A fixed box of the `sections` view: of `total` lines, the ones it shows in `visible` rows. All when they fit; else
 * `visible - 1` of them and a `+N more` line in the last row (`more`, the lines not shown). A box of one row shows the
 * `+N more` line alone.
 */
export function sectionWindow(total: number, visible: number): { shown: number; more: number } {
  if (total <= visible) return { shown: total, more: 0 }
  const shown = Math.max(0, visible - 1)
  return { shown, more: total - shown }
}

/** The rows a fixed box of the `sections` view takes before its lines: its two borders and its title row. */
export const SECTION_BOX_CHROME = 3

/**
 * What a fixed box of the `sections` view `height` rows tall draws of its `fixed` lines (a header, drawn first) and its
 * `body` lines: every line in a row of its own under the title (sectionWindow over both together), so the header lines
 * are counted as lines the box may leave out. All when they fit; else the lines its rows hold less one, and a `+N more`
 * line (`more`, the lines not shown, header lines included) with the `[+]`. A box of fewer than four rows has no row
 * for the `+N more` line and shows only its title with the `[+]`.
 */
export function sectionFit(height: number, fixed: number, body: number): { fixedShown: number; bodyShown: number; more: number } {
  const win = sectionWindow(fixed + body, Math.max(0, height - SECTION_BOX_CHROME))
  const fixedShown = Math.min(fixed, win.shown)
  return { fixedShown, bodyShown: win.shown - fixedShown, more: win.more }
}

/**
 * Where a change of the `sections` view moves the pane's body ($.ui.scroll): from one view (`was`, undefined before the
 * first drawing) to the next (`now`, undefined when the value no longer draws): a log page (`log-page:<sid>`) to its
 * end, any other view to its start; nothing on the first drawing, when the value stops drawing, or when nothing changed.
 */
export function sectionsScrollTo(was: string | undefined, now: string | undefined): 'start' | 'end' | undefined {
  if (was === undefined || now === undefined || was === now) return undefined
  return now.startsWith('log-page:') ? 'end' : 'start'
}

/** Whether a section as last drawn has more rows than it shows. */
export function isAnyOverflowing(windows: Partial<Record<SectionId, BoxWindow>>): boolean {
  return Object.values(windows).some(w => w !== undefined && w.total > w.visible)
}

/** The rows an up or down button of a section moves it: its window less one row, at least one. */
export function buttonStep(visible: number): number {
  return Math.max(1, visible - 1)
}

/**
 * A move a section's slider (the drag strategy's surface module) posted, checked: the section, and either the first row
 * it asks shown (`from`, a drag) or the rows to move by (`by`, a key). Undefined when the data is anything else.
 */
export function sliderMove(data: unknown): { id: SectionId; from: number } | { id: SectionId; by: number } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { id, from, by } = data as Record<string, unknown>
  if (id !== 'sessions' && id !== 'queue' && id !== 'points' && id !== 'log') return undefined
  if (typeof from === 'number' && Number.isInteger(from) && by === undefined) return { id, from }
  if (typeof by === 'number' && Number.isInteger(by) && from === undefined) return { id, by }
  return undefined
}

// ---------------------------------------------------------------- the desktop panel's look and preview (decisions smp-18 to smp-23)

/**
 * The look of the desktop panel's `sections` view (option desktopStyle). `tint-soft` (the default): each section's box on
 * a low-contrast tint of its hue, its title row starting on a bar of that hue. `plain`: no colour of its own. The other
 * values of desktopPaneScroll, and the terminal, draw as `plain` whatever the option says.
 */
export const DESKTOP_STYLES = ['tint-soft', 'plain'] as const
export type DesktopStyle = (typeof DESKTOP_STYLES)[number]
/** The look the sections view takes when the option is left out or unknown. */
export const DESKTOP_STYLE_DEFAULT: DesktopStyle = 'tint-soft'

/** The option's value as the mod uses it: an unknown value, or none, counts as DESKTOP_STYLE_DEFAULT. */
export function desktopStyle(value: unknown): DesktopStyle {
  return (DESKTOP_STYLES as readonly unknown[]).includes(value) ? (value as DesktopStyle) : DESKTOP_STYLE_DEFAULT
}

/** How the `sections` view draws its `[+]`, `[-]` and `[x]` (option desktopIcons): `text` as before, `svg` drawn icons. */
export const DESKTOP_ICONS = ['text', 'svg'] as const
export type DesktopIcons = (typeof DESKTOP_ICONS)[number]

/** The option's value as the mod uses it: an unknown value, or none, counts as `text`. */
export function desktopIcons(value: unknown): DesktopIcons {
  return (DESKTOP_ICONS as readonly unknown[]).includes(value) ? (value as DesktopIcons) : 'text'
}

/**
 * The gap between the boxes of the `sections` view's even view (option desktopGap), in CSS pixels at Desktop's default
 * density, where a pane line is 19 px (`--cds-leading-body` of `.cds-root`, 1.1875rem). Desktop draws a Box's vertical
 * spacing number N as `calc(N * var(--engine-row-unit, .5lh))`, half a line each (the pane sets no row unit; only a Client
 * does, to 1lh), and takes any finite number, fractions included, as the engine does. So the mod passes the pixels over
 * 9.5 (desktopRowGap): 2 px is a rowGap of 0.211, 1.8 px at the smallest density (17 px lines) and 2.3 px at the largest
 * (22 px). The boxes keep their heights in lines: the gap comes out of each box's spare space below its last row.
 */
export const DESKTOP_GAP_PX = 2
/** The most pixels desktopGap takes: a larger value, a negative one or no number counts as the default. */
export const DESKTOP_GAP_MAX_PX = 8
/** CSS pixels of one unit of a Box's vertical spacing on Desktop at its default density: half a 19 px line. */
export const DESKTOP_ROW_UNIT_PX = 9.5

/** The option's value as the mod uses it: a number of pixels from 0 to DESKTOP_GAP_MAX_PX, else DESKTOP_GAP_PX. */
export function desktopGap(value: unknown): number {
  const px = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(px) && px >= 0 && px <= DESKTOP_GAP_MAX_PX ? px : DESKTOP_GAP_PX
}

/** A gap of `px` pixels as the `rowGap` of a desktop Box: half lines, to three decimals; 0 for none. */
export function desktopRowGap(px: number): number {
  return Math.round((px / DESKTOP_ROW_UNIT_PX) * 1000) / 1000
}

/**
 * A fixed sample state the desktop panel draws instead of the live one (option desktopPreview): `off` the live state;
 * `overview` the three sections filled, none expanded; `queue` the queued work expanded; `points` the open points
 * expanded with the first one selected; `log` a running session's log expanded; `empty` nothing at all; `animate` the
 * overview's data expanding and collapsing each section in turn by itself (previewLoopAt), under desktopAnimation.
 */
export const DESKTOP_PREVIEWS = ['off', 'overview', 'queue', 'points', 'log', 'empty', 'animate'] as const
export type DesktopPreview = (typeof DESKTOP_PREVIEWS)[number]

/** The option's value as the mod uses it: an unknown value, or none, counts as `off`. */
export function desktopPreview(value: unknown): DesktopPreview {
  return (DESKTOP_PREVIEWS as readonly unknown[]).includes(value) ? (value as DesktopPreview) : 'off'
}

/**
 * How the `sections` view goes from its three even boxes to a section's page and back (option desktopAnimation):
 * `smooth` (the default) in steps (ANIMATION_SCHEDULES); `off` at once.
 */
export const DESKTOP_ANIMATIONS = ['off', 'smooth'] as const
export type DesktopAnimation = (typeof DESKTOP_ANIMATIONS)[number]
export const DESKTOP_ANIMATION_DEFAULT: DesktopAnimation = 'smooth'

/** The option's value as the mod uses it: an unknown value, or none, counts as the default (`smooth`). */
export function desktopAnimation(value: unknown): DesktopAnimation {
  return (DESKTOP_ANIMATIONS as readonly unknown[]).includes(value) ? (value as DesktopAnimation) : DESKTOP_ANIMATION_DEFAULT
}

/**
 * The shortest step of an animation: the engine redraws a pane at most ten times a second ($.ui.invalidate, a state
 * write's readers), and folds a sooner write into the next redraw.
 */
export const ANIMATION_MIN_STEP_MS = 100

/**
 * A stepped animation: `steps` frames from the press to the end state, one every `ms`; the last frame is the plain end
 * state (the page, or the three even boxes), so the move takes `(steps - 1) * ms` after the frame the press draws.
 */
export type AnimationSchedule = { steps: number; ms: number }

/** The stepped desktopAnimation: smooth, 15 frames one every 100 ms, 1.4 s. */
export const ANIMATION_SCHEDULES: Record<Exclude<DesktopAnimation, 'off'>, AnimationSchedule> = {
  smooth: { steps: 15, ms: 100 },
}

/** The schedule of a desktopAnimation value; undefined for `off`. */
export function animationSchedule(value: DesktopAnimation): AnimationSchedule | undefined {
  return value === 'off' ? undefined : ANIMATION_SCHEDULES[value]
}

/** The first step an expand of `id` draws at the press; null when the schedule has no step between (instant). */
export function expandStart(id: ExpandableId, schedule: AnimationSchedule): SectionAnimation | null {
  return schedule.steps < 2 ? null : { id, step: 1, steps: schedule.steps, dir: 1 }
}

/** The first step a collapse of `id` draws at the press: the same steps as the expand, backwards. */
export function collapseStart(id: ExpandableId, schedule: AnimationSchedule): SectionAnimation | null {
  return schedule.steps < 2 ? null : { id, step: schedule.steps - 1, steps: schedule.steps, dir: -1 }
}

/** The step after `anim`; null once it reaches its end state (step 0 or `steps`), which is drawn plain. */
export function animationNext(anim: SectionAnimation): SectionAnimation | null {
  const step = anim.step + anim.dir
  return step <= 0 || step >= anim.steps ? null : { ...anim, step }
}

/** `anim` turned back from the step it reached, one step on at once; null when that is its start state. */
export function animationReversed(anim: SectionAnimation): SectionAnimation | null {
  return animationNext({ ...anim, dir: anim.dir === 1 ? -1 : 1 })
}

/**
 * The boxes a step of an animation draws in a body of `bodyRows`: the even view's boxes (sectionBoxes) with the section's
 * box grown by `step / steps` of the way from its even height to the whole body, the other two shrunk by the same share
 * of their even heights, in their order. A box left below SECTION_BOX_CHROME rows (no room for its borders and title) is
 * not drawn, its rows going to the growing box; the boxes always fill the body exactly.
 */
export function animatedBoxes(bodyRows: number, anim: SectionAnimation): SectionBox[] {
  const even = sectionBoxes(bodyRows, false, null)
  const total = even.reduce((sum, box) => sum + box.height, 0)
  const share = Math.min(1, Math.max(0, anim.step / anim.steps))
  const others = new Map(even.filter(box => box.id !== anim.id).map(box => [box.id, Math.round(box.height * (1 - share))] as const))
  for (const [id, height] of others) if (height < SECTION_BOX_CHROME) others.delete(id)
  const grown = total - [...others.values()].reduce((sum, height) => sum + height, 0)
  let top = 0
  return even.flatMap(box => {
    const height = box.id === anim.id ? grown : others.get(box.id)
    if (height === undefined) return []
    const one: SectionBox = { id: box.id, top, height }
    top += height
    return [one]
  })
}

/** The hold of the desktopPreview `animate` loop on the three boxes and on each page: 2.4 s, a whole number of steps. */
export const PREVIEW_HOLD_MS = 2400

/** One frame of the desktopPreview `animate` loop: the section expanded, and the animation step drawn over it. */
export type PreviewLoopFrame = { expanded: ExpandableId | null; animation: SectionAnimation | null }

/** The length of one section's turn in the loop: a hold on the three boxes, the expand, a hold on the page, the collapse. */
export function previewTurnMs(schedule: AnimationSchedule | undefined): number {
  return 2 * PREVIEW_HOLD_MS + (schedule === undefined ? 0 : 2 * (schedule.steps - 1) * schedule.ms)
}

/** The whole loop: one turn for each section, in their order. */
export function previewLoopMs(schedule: AnimationSchedule | undefined): number {
  return SECTION_ORDER.length * previewTurnMs(schedule)
}

/**
 * The frame the desktopPreview `animate` loop draws `ms` after it started: for each section in turn (sessions, queued
 * work, open points) the three boxes for PREVIEW_HOLD_MS, the expand's steps one every `schedule.ms`, the page for
 * PREVIEW_HOLD_MS, the collapse's steps; then the next section, and from the first again. Under `off` (no schedule) the
 * page follows the boxes and the boxes the page at once.
 */
export function previewLoopAt(ms: number, schedule: AnimationSchedule | undefined): PreviewLoopFrame {
  const turn = previewTurnMs(schedule)
  const at = ((Math.floor(ms) % previewLoopMs(schedule)) + previewLoopMs(schedule)) % previewLoopMs(schedule)
  const id = SECTION_ORDER[Math.floor(at / turn)] as ExpandableId
  const into = at % turn
  const moving = schedule === undefined ? 0 : (schedule.steps - 1) * schedule.ms
  const steps = schedule?.steps ?? 1
  const stepMs = schedule?.ms ?? 1
  if (into < PREVIEW_HOLD_MS) return { expanded: null, animation: null }
  if (into < PREVIEW_HOLD_MS + moving) return { expanded: id, animation: { id, step: 1 + Math.floor((into - PREVIEW_HOLD_MS) / stepMs), steps, dir: 1 } }
  if (into < 2 * PREVIEW_HOLD_MS + moving) return { expanded: id, animation: null }
  return { expanded: null, animation: { id, step: steps - 1 - Math.floor((into - 2 * PREVIEW_HOLD_MS - moving) / stepMs), steps, dir: -1 } }
}

/**
 * One section's colours under a desktopStyle, raw hex for Desktop's dark mode (a plugin's tree cannot read the theme in
 * use, and no theme key names a tint): `body` the box's background, `accent` a bar one cell wide at the title row's
 * start, `border` the box's border (each undefined: none of its own, the border dim); `current` the
 * background of the section's title in the page view's strip while it is the one shown; `icon` the stroke of its drawn
 * icons (an Svg takes no text colour) and `iconHover` the background under one while the pointer is on it.
 */
export type SectionLook = { body?: string; accent?: string; border?: string; current?: string; icon: string; iconHover: string }

/** A desktopStyle: each section's colours, and the font style of the shown section's title in the strip. */
export type PanelLook = { sections: Record<SectionId, SectionLook>; current: { underline?: true } }

const plainLook: SectionLook = { icon: '#C2C0B8', iconHover: '#3A3A37' }

/**
 * The palettes, for Desktop's dark mode: its page `#262624`, its text `#FAF9F5` and its secondary text `#9C9A92` (the
 * `--bg-100`, `--text-100` and `--text-400` of its dark theme). Every background keeps the text at 4.5:1 or more and the
 * secondary text at 4.5:1 or more where it is drawn on it (the README's Claude Desktop section lists each ratio). Hues:
 * sessions blue, queued work violet, open points sand, the log grey; never the green, red and amber of the statuses.
 */
export const PANEL_LOOKS: Record<DesktopStyle, PanelLook> = {
  plain: { sections: { sessions: plainLook, queue: plainLook, points: plainLook, log: plainLook }, current: {} },
  'tint-soft': {
    sections: {
      sessions: { body: '#1D2633', accent: '#6B9BF2', border: '#3D5478', current: '#2E4F86', icon: '#C9D8F5', iconHover: '#2E4F86' },
      queue: { body: '#28212F', accent: '#A98BEB', border: '#584A7C', current: '#4F3C84', icon: '#DCD0F7', iconHover: '#4F3C84' },
      points: { body: '#2D2920', accent: '#D2B07A', border: '#6E5E40', current: '#66512C', icon: '#EEDFC4', iconHover: '#66512C' },
      log: { body: '#2A2A28', accent: '#9A9892', border: '#565653', current: '#4A4A46', icon: '#DAD8D2', iconHover: '#4A4A46' },
    },
    current: { underline: true },
  },
}

/** The drawn icons of desktopIcons `svg`: `plus` for `[+]`, `minus` for `[-]`, `close` for `[x]`. */
export type PanelIcon = 'plus' | 'minus' | 'close'

/** What each icon says to a reader that cannot see it (the Svg's `alt`), and the text the `text` value draws. */
export const PANEL_ICON_TEXT: Record<PanelIcon, { alt: string; label: string }> = {
  plus: { alt: 'Expand', label: '[+]' },
  minus: { alt: 'Back to the sections', label: '[-]' },
  close: { alt: 'Close the log', label: '[x]' },
}

/**
 * The geometry of the drawn icons, in CSS pixels (decision smp-23). Desktop draws an Svg as an `<img>` of the width and
 * height given, snapped to whole pixels, so every icon's viewBox is its own size in pixels (one unit, one pixel) and each
 * bar of a mark is a rectangle on whole pixels with `crispEdges`: no stroke is spread over two half-lit pixel rows.
 *
 * - PANEL_ICON_PX: the framed icon (desktopButtons `plain`), in a box one row tall with no border of its own: at least
 *   17 px at Desktop's smallest density, so the frame (1 px, on the icon's outer pixels) and the mark fit with room.
 * - PANEL_MARK_PX: the mark alone, inside the outline box (desktopButtons `outline`: 3 cells by 1 row, a 1 px border each
 *   side inside the row): its inner height is a line less 2 px, 15 px at the smallest density (17 px lines), 17 at the
 *   default (19 px), 18 at 20 px lines; its inner width 3ch less 2 px, about 21 px or more.
 * - PANEL_MARK_ARM_PX: the length of the bars of `+` and `−`; PANEL_MARK_THICK_PX their thickness. (size - arm) and
 *   (size - thick) are even, so both bars sit on whole pixels at the exact centre of the icon.
 * - PANEL_CROSS_REACH_PX: how far each diagonal of `×` reaches from the centre along each axis, and
 *   PANEL_CROSS_THICK_PX its stroke (a diagonal cannot sit on whole pixels; round caps, antialiased).
 */
export const PANEL_ICON_PX = 14
export const PANEL_MARK_PX = 12
export const PANEL_MARK_ARM_PX = 8
export const PANEL_MARK_THICK_PX = 2
export const PANEL_CROSS_REACH_PX = 3
export const PANEL_CROSS_THICK_PX = 2.25
/** The frame of a framed icon: its stroke and the radius of its corners, in pixels. */
export const PANEL_FRAME_THICK_PX = 1
export const PANEL_FRAME_RADIUS_PX = 3

/**
 * The label of the Button laid over a drawn icon to take its press: one no-break space. Desktop pads a plain Button
 * (`padding: 0 var(--cds-pad-xs)`, 4 to 6 px a side) and ends a label too wide for it with an ellipsis
 * (`[data-press-label]{overflow:hidden;text-overflow:ellipsis}`); three spaces overflowed the outline box (inner 25 px at
 * 20 px lines, less 2 x 6 px of padding: 13 px for three spaces of the 14 px body font, about 4.5 px each) and drew a `…`
 * under the mark. One space leaves 8 px or more to spare at every density.
 */
export const PANEL_ICON_PRESS_LABEL = '\u00A0'

/** A bar of a mark: a rectangle on whole pixels, `w` by `h`, centred in a square of `size`. */
function markBar(size: number, w: number, h: number, color: string): string {
  return `<rect x="${(size - w) / 2}" y="${(size - h) / 2}" width="${w}" height="${h}" fill="${color}" shape-rendering="crispEdges"/>`
}

/** An icon's mark in a square of `size` pixels: the bars of `+` or `−`, or the two diagonals of `×`. */
function panelMark(icon: PanelIcon, size: number, color: string): string {
  if (icon === 'close') {
    const [lo, hi] = [size / 2 - PANEL_CROSS_REACH_PX, size / 2 + PANEL_CROSS_REACH_PX]
    return `<path d="M${lo} ${lo}L${hi} ${hi}M${hi} ${lo}L${lo} ${hi}" fill="none" stroke="${color}" stroke-width="${PANEL_CROSS_THICK_PX}" stroke-linecap="round"/>`
  }
  const across = markBar(size, PANEL_MARK_ARM_PX, PANEL_MARK_THICK_PX, color)
  return icon === 'minus' ? across : `${across}${markBar(size, PANEL_MARK_THICK_PX, PANEL_MARK_ARM_PX, color)}`
}

/**
 * An icon's SVG markup in `color`: framed (desktopButtons `plain`) a rounded square of PANEL_ICON_PX holding a plus or a
 * minus, or a cross with no frame; with `isFramed` false the mark alone in PANEL_MARK_PX (desktopButtons `outline` draws
 * the frame as the icon's own bordered box). One unit of the viewBox is one pixel.
 */
export function panelIconSvg(icon: PanelIcon, color: string, isFramed = true): string {
  const size = isFramed ? PANEL_ICON_PX : PANEL_MARK_PX
  const half = PANEL_FRAME_THICK_PX / 2
  const frame = isFramed && icon !== 'close' ? `<rect x="${half}" y="${half}" width="${size - PANEL_FRAME_THICK_PX}" height="${size - PANEL_FRAME_THICK_PX}" rx="${PANEL_FRAME_RADIUS_PX}" fill="none" stroke="${color}" stroke-width="${PANEL_FRAME_THICK_PX}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${frame}${panelMark(icon, size, color)}</svg>`
}

/**
 * How the `sections` view draws its pressable elements (option desktopButtons): the titles of the strip over a page, the
 * `[+]`, `[-]` and `[x]` icons. `outline` (the default): each title a rounded chip bordered in its section's colour,
 * filled softly under the pointer, the shown one filled; each icon a rounded box bordered the same way. `plain`: bare
 * text. A title that cannot expand stays a greyed Text in a dim-bordered chip. The other values of desktopPaneScroll, and
 * the terminal, draw `plain` whatever the option says.
 */
export const DESKTOP_BUTTONS = ['outline', 'plain'] as const
export type DesktopButtons = (typeof DESKTOP_BUTTONS)[number]
/** The look the pressables take when the option is left out or unknown. */
export const DESKTOP_BUTTONS_DEFAULT: DesktopButtons = 'outline'

/** The option's value as the mod uses it: an unknown value, or none, counts as DESKTOP_BUTTONS_DEFAULT. */
export function desktopButtons(value: unknown): DesktopButtons {
  return (DESKTOP_BUTTONS as readonly unknown[]).includes(value) ? (value as DesktopButtons) : DESKTOP_BUTTONS_DEFAULT
}

/**
 * The steps of one hue the outline look draws with, raw hex for Desktop's dark mode: `edge` a chip's border, `soft` the
 * fill of a chip under the pointer and of the shown one, `ink` a drawn icon's mark. Every fill keeps Desktop's text
 * (`#FAF9F5`) at 4.5:1 or more.
 */
export type ButtonHue = { edge: string; soft: string; ink: string }

export const BUTTON_HUES: Record<'blue' | 'violet' | 'sand' | 'grey', ButtonHue> = {
  blue: { edge: '#6B9BF2', soft: '#2E4F86', ink: '#C9D8F5' },
  violet: { edge: '#A98BEB', soft: '#4F3C84', ink: '#DCD0F7' },
  sand: { edge: '#D2B07A', soft: '#66512C', ink: '#EEDFC4' },
  grey: { edge: '#9A9892', soft: '#4A4A46', ink: '#DAD8D2' },
}

/** The hue each section's buttons take under a desktopStyle: grey under `plain`, else its own. */
export const BUTTON_HUE_OF: Record<DesktopStyle, Record<SectionId, keyof typeof BUTTON_HUES>> = {
  plain: { sessions: 'grey', queue: 'grey', points: 'grey', log: 'grey' },
  'tint-soft': { sessions: 'blue', queue: 'violet', points: 'sand', log: 'grey' },
}

/**
 * One pressable's box under the outline look: its background and border at rest (a dim border without a colour), and
 * what changes under the pointer (`hover`).
 */
export type ChipLook = { backgroundColor?: string; borderColor?: string; borderDimColor?: true; hover?: { backgroundColor: string } }

/** A section's pressables under the outline look: a title, the shown title, a greyed title, an icon and its mark. */
export type ButtonLook = { title: ChipLook; current: ChipLook; greyed: ChipLook; icon: ChipLook; ink: string }

/** Desktop's text colour in dark mode (`--text-100`): a Button's label, which a plugin cannot colour. */
export const DESKTOP_TEXT = '#FAF9F5'

/** The pressables of section `id` under the outline look and the desktopStyle `style`. */
export function buttonLook(style: DesktopStyle, id: SectionId): ButtonLook {
  const hue = BUTTON_HUES[BUTTON_HUE_OF[style][id]]
  return {
    title: { borderColor: hue.edge, hover: { backgroundColor: hue.soft } },
    current: { backgroundColor: hue.soft, borderColor: hue.edge },
    greyed: { borderDimColor: true },
    icon: { borderColor: hue.edge, hover: { backgroundColor: hue.soft } },
    ink: hue.ink,
  }
}

/**
 * The font colour and style of the `sections` view (option desktopFont, decisions pfs-1 to pfs-4): how each section's
 * title, its rows in the text colour (`body`) and its dim rows (`detail`) are drawn, and its title in the strip over a
 * page while it is the one shown. `accent` (the default) writes them in the section's hue (fontLook); `standard` draws as
 * before: every title bold in Desktop's text colour, the rows in that colour or dim. The other values of
 * desktopPaneScroll, and the terminal, draw `standard` whatever the option says.
 */
export const DESKTOP_FONTS = ['standard', 'accent'] as const
export type DesktopFont = (typeof DESKTOP_FONTS)[number]
/** The font the sections view takes when the option is left out or unknown. */
export const DESKTOP_FONT_DEFAULT: DesktopFont = 'accent'

/** The option's value as the mod uses it: an unknown value, or none, counts as DESKTOP_FONT_DEFAULT. */
export function desktopFont(value: unknown): DesktopFont {
  return (DESKTOP_FONTS as readonly unknown[]).includes(value) ? (value as DesktopFont) : DESKTOP_FONT_DEFAULT
}

/**
 * The steps of one hue the accent font writes with, raw hex: `accent` the saturated step (the bar and border hue of
 * tint-soft), `ink` a light step, `muted` the step of a detail row. Each is drawn only on a background of fixed colour (a
 * section's tint, a chip's fill), never on Desktop's page, so it reads the same whichever theme Desktop shows; each keeps
 * 4.5:1 or more on what it is drawn on.
 */
export type FontHue = { accent: string; ink: string; muted: string }

export const FONT_HUES: Record<keyof typeof BUTTON_HUES, FontHue> = {
  blue: { accent: '#6B9BF2', ink: '#C9D8F5', muted: '#8FA9D6' },
  violet: { accent: '#A98BEB', ink: '#DCD0F7', muted: '#AC9CD0' },
  sand: { accent: '#D2B07A', ink: '#EEDFC4', muted: '#BCA987' },
  grey: { accent: '#9A9892', ink: '#DAD8D2', muted: '#A9A69D' },
}

/** The props of one Text under the accent font (the engine's Text props: colour, weight, styles). */
export type TextLook = { color?: string; dimColor?: true; weight?: 'bold'; italic?: true; underline?: true }

/**
 * One section's text under the accent font: `title` its title (in its box, on its page); `body` a row in the text
 * colour; `detail` a dim row; `current` its title in the strip while it is the one shown, on the chip's or the look's own
 * fill. A pressable row is a Button, whose label a plugin cannot colour: it keeps Desktop's text colour.
 */
export type FontLook = { title: TextLook; body: TextLook; detail: TextLook; current: TextLook }

/**
 * The text of section `id` under the font `font` and the desktopStyle `style`; undefined for `standard` (the trees of
 * before). `accent`: the title in the hue's accent at the heavier `bold` weight, the body rows in the hue's ink, the detail
 * rows in its muted step and italic; the shown title in the ink, `bold` and underlined. The colours are the section's hue
 * under `tint-soft` (sessions blue, queued work violet, open points sand, the log grey); under `plain`, which has no
 * colour of its own, the font keeps its weights and styles and adds no colour (dim rows stay dim).
 */
export function fontLook(font: DesktopFont, style: DesktopStyle, id: SectionId): FontLook | undefined {
  if (font === 'standard') return undefined
  const hue = style === 'plain' ? undefined : FONT_HUES[BUTTON_HUE_OF[style][id]]
  return {
    title: { weight: 'bold', ...(hue === undefined ? {} : { color: hue.accent }) },
    body: hue === undefined ? {} : { color: hue.ink },
    detail: { ...(hue === undefined ? { dimColor: true as const } : { color: hue.muted }), italic: true },
    current: { weight: 'bold', underline: true, ...(hue === undefined ? {} : { color: hue.ink }) },
  }
}

/** The text an icon's Button draws under the outline look: the glyph alone, the box being its frame. */
export const PANEL_ICON_GLYPH: Record<PanelIcon, string> = { plus: '+', minus: '−', close: '×' }

/**
 * What a desktopPreview state draws in place of the live one: the sessions, the queued tasks and the open points, the
 * log shown and the panel's own state (a session's log open, drawn as a page or not, the section expanded, the open point
 * selected), and the display clock. Pure data: it reads, writes and calls nothing.
 */
export type PreviewState = {
  snap: SessionSnapshot
  nowSec: number
  queue: QueuedTask[]
  points: PresentedPoint[]
  watch: { sid: string; title: string; lines: string[] } | null
  selected: string | null
  selectedPoint: string | null
  /** The queue group shown open (its project); null: every group collapsed. */
  expandedGroup: string | null
  expanded: ExpandableId | null
  logPage: boolean
}

/** The preview's clock: 2026-11-03 09:00 UTC. */
const PREVIEW_AT_SEC = 1793696400
const PREVIEW_SID_RUNNING = 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

const previewSessions: SessionRow[] = [
  { title: 'Panel style variants for the desktop sections view', sid: PREVIEW_SID_RUNNING, sid8: 'a3f1c2d4', model: 'opus', effort: 'high', configDir: '/home/user/.claude', status: 'alive', pid: 41207, elapsedSec: 1520, startedAt: PREVIEW_AT_SEC - 1520, transcriptAgeSec: 4 },
  { title: 'Review of the desktop scroll fix', sid: 'b7e2d9a1-2c3d-4e5f-9a0b-1c2d3e4f5a6b', sid8: 'b7e2d9a1', model: 'sonnet', effort: 'high', configDir: '/home/user/.claude', status: 'unreported', startedAt: PREVIEW_AT_SEC - 4100, endedAt: PREVIEW_AT_SEC - 1310, costUsd: 1.84 },
  { title: 'Licence daemon audit', sid: 'c0d4e8f2-6a7b-4c8d-9e0f-2a3b4c5d6e7f', sid8: 'c0d4e8f2', model: 'haiku', effort: 'low', configDir: '/home/user/.claude', status: 'done', startedAt: PREVIEW_AT_SEC - 9000, endedAt: PREVIEW_AT_SEC - 8650, costUsd: 0.12 },
]

const previewQueue: QueuedTask[] = [
  { title: 'Font colour variants for the section titles', project: 'session_control' },
  { title: 'Stepped expand and collapse animation', project: 'session_control' },
  { title: 'Light palette once Desktop exposes its theme to a plugin tree, with every tint and strip checked against the light page and text colours at the same contrast as the dark ones', project: 'session_control' },
  { title: 'Retire the buttons scroll value', project: 'session_control' },
  { title: 'Group the queued work by project', project: 'session_control' },
  { title: 'Hover light across a group\'s rows', project: 'session_control' },
  { title: 'Merge the panel style branch', project: 'website' },
  { title: 'Session log use case in Desktop', project: 'website' },
  { title: 'README screenshots of each variant', project: 'website' },
  { title: 'Trim the drift band text', project: GENERAL_PROJECT },
]

const previewPoints: PresentedPoint[] = [
  { id: 'pv1', title: 'Which panel style becomes the default', detail: 'Three tinted variants are built behind the desktopStyle option; the captures show each with the four sample states.', recommendation: 'Pick one after the captures.' },
  {
    id: 'pv2',
    title: 'Push policy for the session-control repository',
    detail: 'No policy is recorded for pushes to main of this repository: the first push to a protected branch asks every time until one is recorded. The branches merged so far went through the orchestrator after the user saw the result, fast-forward only, with the feature branch deleted after the merge as routine cleanup.',
    recommendation: 'Record "ask every time" until the panel work settles.',
  },
  { id: 'pv3', title: 'Light mode of the tinted variants', detail: '', recommendation: '' },
]

/** The preview log: 40 lines of a worker's transcript as the log view summarizes it, a few long enough to wrap. */
const previewLog: string[] = Array.from({ length: 40 }, (_, i) => {
  const n = i + 1
  if (n % 10 === 3)
    return `Reading the section boxes again: the title row, the accent bar and the icon share one row of the box, so a line keeps its height whatever the surface does with the icon; the body takes the tint and every row inside it keeps the text colour of the pane (step ${n}).`
  if (n % 5 === 1) return `> Bash claude plugin test ./mod (run ${n})`
  if (n % 5 === 2) return `  < (pass) desktopStyle ${n}: every variant draws every preview state on the desktop surface`
  if (n % 7 === 0) return `> Read mod/hooks/register.tsx`
  return `Step ${n}: checking the palette against the pane's text colour.`
})

/** The state a desktopPreview value draws; undefined for `off`. */
export function previewState(preview: DesktopPreview): PreviewState | undefined {
  if (preview === 'off') return undefined
  const base: PreviewState = {
    snap: { at: PREVIEW_AT_SEC * 1000, rows: previewSessions },
    nowSec: PREVIEW_AT_SEC,
    queue: previewQueue,
    points: previewPoints,
    watch: null,
    selected: null,
    selectedPoint: null,
    expandedGroup: null,
    expanded: null,
    logPage: false,
  }
  switch (preview) {
    case 'overview':
      return base
    case 'queue':
      return { ...base, expanded: 'queue', expandedGroup: previewQueue[0]?.project ?? null }
    // The points and the log pages open the first queue group too, so the queued work exceeds its even box and its title
    // in their strip can be pressed.
    case 'points':
      return { ...base, expanded: 'points', selectedPoint: previewPoints[0]?.id ?? null, expandedGroup: previewQueue[0]?.project ?? null }
    case 'log':
      return { ...base, watch: { sid: PREVIEW_SID_RUNNING, title: previewSessions[0]?.title ?? '', lines: previewLog }, selected: PREVIEW_SID_RUNNING, logPage: true, expandedGroup: previewQueue[0]?.project ?? null }
    case 'empty':
      return { ...base, snap: { at: PREVIEW_AT_SEC * 1000, rows: [] }, queue: [], points: [] }
    // The loop's data: the overview's, with the first queue group open and the first open point selected, so each page
    // is longer than its even box; the section expanded and the step drawn come from the loop (previewLoopAt).
    case 'animate':
      return { ...base, expandedGroup: previewQueue[0]?.project ?? null, selectedPoint: previewPoints[0]?.id ?? null }
  }
}
