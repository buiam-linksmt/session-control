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
  /** Abort-check evidence per registry pid: /proc stat field 22 and the sessions file's own claim. */
  pidProof: Map<number, { startTicks: string; fileStart: string; fileSid: string }>
  /** Newest transcript mtime (epoch seconds) per session id. */
  transcriptMtime: Map<string, number>
}

/**
 * The one shell probe run through `$.process.run(['sh', '-c', PROBE_SCRIPT,
 * 'session-probe', ...probeArgs(entries)])`. Prints tab-separated lines:
 *   P <pid> <comm> <elapsedSec> <cwd> <CLAUDE_CONFIG_DIR> <cmdline>
 *   A <pid> <comm> <statStart> <fileProcStart> <fileSessionId>   for each asked pid that exists
 *   T <sid> <mtimeEpochSec>       newest transcript of an asked session
 */
export const PROBE_SCRIPT = [
  'up=$(cut -d. -f1 /proc/uptime 2>/dev/null)',
  'hz=$(getconf CLK_TCK 2>/dev/null)',
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  '  read -r c 2>/dev/null < "$d/comm" || continue',
  '  [ "$c" = claude ] || continue',
  '  cmd=$(tr "\\000\\t\\n" "   " < "$d/cmdline" 2>/dev/null)',
  '  cwd=$(readlink "$d/cwd" 2>/dev/null)',
  '  cfg=$(tr "\\000" "\\n" < "$d/environ" 2>/dev/null | sed -n "s/^CLAUDE_CONFIG_DIR=//p" | head -n 1)',
  '  stt=$(sed "s/^.*) //" "$d/stat" 2>/dev/null | cut -d" " -f20)',
  '  et=""; [ -n "$stt" ] && [ -n "$up" ] && [ -n "$hz" ] && et=$((up - stt / hz))',
  '  printf "P\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$c" "$et" "$cwd" "$cfg" "$cmd"',
  'done',
  'for a in "$@"; do',
  '  case "$a" in',
  '    pid:*) r=${a#pid:}; p=${r%%|*}; r=${r#*|}; c=${r%%|*}; [ -d "/proc/$p" ] || continue',
  '      st=$(sed "s/^.*) //" "/proc/$p/stat" 2>/dev/null | cut -d" " -f20)',
  '      fs=$(jq -r ".procStart // empty" "$c/sessions/$p.json" 2>/dev/null)',
  '      fi=$(jq -r ".sessionId // empty" "$c/sessions/$p.json" 2>/dev/null)',
  '      printf "A\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$(cat "/proc/$p/comm" 2>/dev/null)" "$st" "$fs" "$fi";;',
  '    t:*) r=${a#t:}; s=${r%%|*}; c=${r#*|}',
  '      f=$(ls -t "$c"/projects/*/"$s".jsonl 2>/dev/null | head -n 1)',
  '      [ -n "$f" ] && printf "T\\t%s\\t%s\\n" "$s" "$(stat -c %Y "$f")";;',
  '  esac',
  'done',
  'exit 0',
].join('\n')

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
        facts.pidProof.set(pid, { startTicks: cols[3] ?? '', fileStart: cols[4] ?? '', fileSid: cols[5] ?? '' })
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

/** One row per registry entry, plus one per live headless claude no entry claims. */
export function buildRows(
  entries: readonly SessionEntry[],
  facts: ProcFacts,
  nowSec: number,
): SessionRow[] {
  const rows: SessionRow[] = []
  const claimed = new Set<number>()
  for (const entry of entries) {
    if (typeof entry.pid === 'number') claimed.add(entry.pid)
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
      transcriptAgeSec: mtime === undefined ? undefined : Math.max(0, nowSec - mtime),
      costUsd: typeof outcome?.costUsd === 'number' ? outcome.costUsd : undefined,
    })
  }
  for (const proc of facts.claude) {
    if (claimed.has(proc.pid) || !isHeadless(proc.cmdline)) continue
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

export function formatAge(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
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

function elapsedText(row: SessionRow): string {
  return row.elapsedSec === undefined ? '-' : formatAge(row.elapsedSec)
}

/** Column widths from the content, so the columns sit close; the title takes what is left. */
export function paneWidths(rows: readonly SessionRow[], columns: number): PaneWidths {
  const widest = (header: string, cell: (row: SessionRow) => string) =>
    Math.max(header.length, ...rows.map(row => cell(row).length))
  const sid = widest('sid', row => row.sid8 || '-')
  const status = widest('status', row => statusLabel(row.status))
  const model = widest('model', row => row.model)
  const effort = widest('effort', row => row.effort)
  const elapsed = widest('elapsed', elapsedText)
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

/** One pane line for a row: title, status, model, effort, elapsed; cut to `columns`. */
export function formatRow(row: SessionRow, columns: number, widths: PaneWidths = paneWidths([row], columns)): string {
  return cut(
    [
      fit(row.title, widths.title),
      fit(row.sid8 || '-', widths.sid),
      fit(statusLabel(row.status), widths.status),
      fit(row.model, widths.model),
      fit(row.effort, widths.effort),
      elapsedText(row),
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

function shortDir(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || dir
}

// ---------------------------------------------------------------- completion

/**
 * Classifies a finished worker from its `--output-format json` result file's
 * text (may be empty or truncated) and, when known, the background task's
 * status (`completed`, `failed`, `killed`).
 */
export function classifyResult(resultText: string, taskStatus?: string): SessionOutcome {
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
  const costUsd = typeof parsed?.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined
  const sessionId = typeof parsed?.session_id === 'string' ? parsed.session_id : undefined
  const make = (kind: SessionOutcomeKind, why: string): SessionOutcome => ({
    kind,
    summary: `${kind}: ${why}`,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(sessionId === undefined ? {} : { sessionId }),
  })
  const haystack = `${text}\n${resultText}`
  if (/hit your (session |usage |weekly )?limit/i.test(haystack)) return make('limit', 'rate limit hit')
  if (/please run \/login|invalid api key|oauth token (has )?expired/i.test(haystack)) {
    return make('login', 'licence needs a re-login')
  }
  if (taskStatus === 'killed' || /low on memory|out of memory|oom-?kill/i.test(haystack)) {
    return make('killed', taskStatus === 'killed' ? 'background task killed' : 'killed (memory)')
  }
  if (parsed === undefined) {
    return make('killed', resultText.trim() === '' ? 'no result written' : 'result not JSON (cut off?)')
  }
  if (isError) return make('error', firstLine(text) || 'is_error with no text')
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
 * among them), loses `pid`, gains `reported: false` and `outcome`. Every other
 * entry is left as parsed. Refuses when the entry is gone or no longer has a
 * pid (someone else already harvested it).
 */
export function mergeCompletion(registryText: string, sessionId: string, outcome: SessionOutcome): MergeResult {
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
}

export type LaunchVerdict =
  | { ok: true; configDir: string; resumeSid?: string }
  | { ok: false; reason: string }

/** The tool's JSON schema: what the model must give. */
export const LAUNCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dir', 'prompt_file', 'model', 'effort', 'title'],
  properties: {
    dir: { type: 'string', description: 'Absolute working directory of the worker. Never the orchestrator dir nor $HOME.', pattern: '^/' },
    prompt_file: { type: 'string', description: 'Absolute path of the file holding the worker prompt.', pattern: '^/' },
    model: { type: 'string', minLength: 1, description: 'Model alias or id, e.g. opus, sonnet.' },
    effort: { type: 'string', enum: [...EFFORTS], description: 'CLAUDE_CODE_EFFORT_LEVEL for the worker.' },
    title: { type: 'string', minLength: 1, maxLength: 120, description: 'Registry title of the worker.' },
    need: { type: 'integer', minimum: 1, maximum: 100, description: 'Licence headroom percent to pass to the licence picker command, when one is configured (default 40).' },
    resume_sid: { type: 'string', pattern: '^[0-9a-f-]{36}$', description: 'Session id to resume; it runs under the config dir that created it.' },
    timeout_minutes: { type: 'integer', minimum: 5, maximum: 600, description: 'Background time limit of the worker in minutes (default 180).' },
  },
} as const

function normalize(path: string): string {
  const cut = path.replace(/\/+$/, '')
  return cut === '' ? '/' : cut
}

/** Pure guard of launch_worker. */
export function checkLaunch(args: LaunchArgs, ctx: LaunchFacts): LaunchVerdict {
  if (typeof args.model !== 'string' || args.model.trim() === '') return { ok: false, reason: 'model is required' }
  if (!(EFFORTS as readonly string[]).includes(args.effort)) {
    return { ok: false, reason: `effort is required, one of ${EFFORTS.join('|')}` }
  }
  if (typeof args.title !== 'string' || args.title.trim() === '') return { ok: false, reason: 'title is required' }
  if (typeof args.dir !== 'string' || !args.dir.startsWith('/')) return { ok: false, reason: 'dir must be absolute' }
  if (typeof args.prompt_file !== 'string' || !args.prompt_file.startsWith('/')) {
    return { ok: false, reason: 'prompt_file must be absolute' }
  }
  if (ctx.promptFileOk === false) return { ok: false, reason: `refused: prompt file ${args.prompt_file} is missing or empty` }
  if (ctx.missingItems !== undefined && ctx.missingItems.length > 0) {
    return { ok: false, reason: `refused: the prompt lacks: ${ctx.missingItems.join('; ')}` }
  }
  if (ctx.dirOk === false) return { ok: false, reason: `refused: directory ${args.dir} does not exist` }
  const dir = normalize(args.dir)
  if (dir === normalize(ctx.orchestratorDir)) return { ok: false, reason: 'refused: cwd is the orchestrator dir' }
  if (dir === normalize(ctx.home)) return { ok: false, reason: 'refused: cwd is $HOME' }

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
  if (!configDir.startsWith('/') || configDir.includes('\n')) {
    return { ok: false, reason: `the licence picker answered an unexpected value: ${configDir.slice(0, 80)}` }
  }
  return { ok: true, configDir }
}

/** The licence picker command as an argv: split on blanks, `{need}` replaced, a leading `~/` expanded. */
export function pickArgv(command: string, need: number, home: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map(part => (part.startsWith('~/') ? `${home}/${part.slice(2)}` : part).replace(/\{need\}/g, String(need)))
}

/** The argv the launch runs: result and error go to files the caller names (never inside the repo). */
export function buildLaunchArgv(
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string },
  resultFile: string,
  errFile?: string,
): string[] {
  const resume = verdict.resumeSid ? ` --resume ${shq(verdict.resumeSid)}` : ''
  const err = errFile === undefined ? '' : ` 2> ${shq(errFile)}`
  const script =
    `cd ${shq(args.dir)} && CLAUDE_CONFIG_DIR=${shq(verdict.configDir)} CLAUDE_CODE_EFFORT_LEVEL=${shq(args.effort)} ` +
    `claude -p --model ${shq(args.model)}${resume} --dangerously-skip-permissions --output-format json ` +
    `-- "$(cat ${shq(args.prompt_file)})" > ${shq(resultFile)}${err}`
  return ['sh', '-c', script]
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

/** The registry entry for a fresh launch (a resume updates the existing entry in place). */
export function newRegistryEntry(
  args: LaunchArgs,
  verdict: { configDir: string; resumeSid?: string },
  pid: number,
  sessionId: string,
  files: { result: string; err: string },
): SessionEntry {
  return {
    title: args.title,
    pid,
    session_id: sessionId,
    config_dir: verdict.configDir,
    cwd: args.dir.replace(/\/+$/, ''),
    model: args.model,
    effort: args.effort,
    result_file: files.result,
    err_file: files.err,
  }
}

/**
 * Appends (mode `new`) or updates in place (mode `resume`: the entry with that session id gets the
 * fields, `reported` and the previous `outcome` are dropped) one registry entry, through a temp file and `mv` so a reader never
 * sees half a file. Args: registry path, entry JSON, mode. Fields it does not know stay.
 */
export const REGISTER_SCRIPT = String.raw`R=$1; E=$2; M=$3
[ -f "$R" ] || echo '[]' > "$R"
tmp="$R.tmp.$$"
if [ "$M" = resume ]; then
  jq --argjson e "$E" 'map(if .session_id == $e.session_id then (. + $e) | del(.reported, .outcome) else . end)' "$R" > "$tmp"
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
// against the scripts by tests/probe-selftest.py). On purpose they differ in two places: registering into an
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

/** REGISTER_SCRIPT: `new` appends the entry; `resume` merges it over every entry with its session id, dropping `reported` and `outcome`. */
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

export type RetireVerdict = { removable: string[]; refused: { id: string; reason: string }[] }

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

export function retireVerdict(entries: readonly SessionEntry[], facts: ProcFacts, rawQueueText: string, ids: readonly string[]): RetireVerdict {
  const queueText = activeQueueText(rawQueueText)
  const verdict: RetireVerdict = { removable: [], refused: [] }
  for (const id of ids) {
    const entry = findBySid(entries, id)
    const sid = entry?.session_id
    if (entry === undefined || sid === undefined) {
      verdict.refused.push({ id, reason: 'no registry entry' })
      continue
    }
    const status = rowStatus(entry, facts)
    const outcome = entry.outcome as { kind?: unknown } | undefined
    if (status === 'alive') verdict.refused.push({ id, reason: 'its process is alive' })
    else if (status === 'dead') verdict.refused.push({ id, reason: 'its exit was not classified yet' })
    else if (entry.keep === true) verdict.refused.push({ id, reason: 'marked keep: a resume or follow-up is expected' })
    else if (outcome !== undefined && outcome.kind !== 'clean') verdict.refused.push({ id, reason: `outcome ${String(outcome.kind)} needs a resume` })
    else if (queueText.includes(sid) || queueText.includes(sid.slice(0, 8))) verdict.refused.push({ id, reason: 'a queued or running task names it' })
    else verdict.removable.push(sid)
  }
  return verdict
}

// ---------------------------------------------------------------- native Windows

// Native Windows (Claude Code on Windows, Git Bash as the Bash tool's shell) has no sh, jq, mv or /proc on the
// PATH a command starts with. register.tsx detects it from the environment and only then takes the Windows
// branches below; on Linux and WSL none of them runs.

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

/**
 * The file operations $.fs lacks, for Windows PowerShell 5.1: written to the runs directory and run with -File
 * (never as -Command text, whose quoting does not survive). `move <from> <to>` replaces an existing file in one
 * step (File.Replace: a reader never finds it missing) or moves it there; `remove <path>`; `tail <path> <lines>
 * <width>` for a transcript over the 4 MiB read cap. Output is UTF-8; a failure exits 1 with the reason.
 */
export const FILES_PS1 = [
  '# session-control: file operations for Windows PowerShell 5.1 (move, remove, tail)',
  'param([string]$Op, [string]$A, [string]$B, [string]$C)',
  // A PowerShell 7 parent leaves its own module folders first; Windows PowerShell must load its own.
  '$env:PSModulePath = "$PSHOME\\Modules"',
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'try {',
  '  switch ($Op) {',
  "    'move' {",
  '      if ([System.IO.File]::Exists($B)) { [System.IO.File]::Replace($A, $B, [NullString]::Value) }',
  '      else { [System.IO.File]::Move($A, $B) }',
  '    }',
  "    'remove' { if ([System.IO.File]::Exists($A)) { [System.IO.File]::Delete($A) } }",
  "    'tail' {",
  '      $width = [int]$C',
  '      foreach ($line in @(Get-Content -LiteralPath $A -Tail ([int]$B) -Encoding UTF8)) {',
  '        if ($line.Length -gt $width) { $line = $line.Substring(0, $width) }',
  '        [Console]::Out.Write($line + "`n")',
  '      }',
  '    }',
  '    default { throw "unknown operation: $Op" }',
  '  }',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
  'exit 0',
].join('\r\n')

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

/** Where a worker's transcript lives: <config_dir>/projects/<cwd with every non-alphanumeric as ->/<sid>.jsonl */
export function transcriptPath(entry: SessionEntry): string | undefined {
  if (typeof entry.config_dir !== 'string' || typeof entry.cwd !== 'string' || typeof entry.session_id !== 'string') return undefined
  return `${entry.config_dir}/projects/${entry.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${entry.session_id}.jsonl`
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

export type QueuedTask = { title: string; running?: true }

/** Tasks of task-queue.json whose status is exactly queued or running, in file order; a running one is marked. */
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
    .filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null && ['queued', 'running'].includes(String((one as { status?: unknown }).status)))
    .map(one => ({ title: typeof one.title === 'string' ? one.title : '(untitled)', ...(one.status === 'running' ? { running: true as const } : {}) }))
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
export type SectionBox = { id: SectionId; top: number; height: number }

/** Smallest box: two borders, the title, and three rows of content (the sessions box also holds a header row). */
export const MIN_BOX = 6
export const MIN_SESSIONS_BOX = 7

/** Heights of the boxes in the panel body: three equal thirds, or (log open) sessions one third and the log two thirds; never below three content rows. */
export function sectionBoxes(bodyRows: number, isLogOpen: boolean): SectionBox[] {
  const third = Math.max(MIN_SESSIONS_BOX, Math.floor(bodyRows / 3))
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
