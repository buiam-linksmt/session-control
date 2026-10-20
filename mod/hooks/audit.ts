// Pure part of audit_state, the end-of-unit audit of the helper files CLAUDE.md asks the orchestrator to do by hand:
// what register.tsx read (the registry with the probe, the queue, the open points, the decisions, the cleared log, the
// listings of backups/, the runs directory and reports/, the orchestrator directory's git state) in, a list of
// findings out, ordered by importance and bounded. Nothing here reads or writes; the tool changes nothing.

import type { SessionEntry } from '../types'
import { activeQueueText, formatAge, rowStatus } from './core'
import type { ProcFacts } from './core'
import { bounded, clean } from './inspect'
import { localDate } from './store'
import { ARCHIVED_HEADING } from './bookkeeping'

export const AUDIT_SCHEMA = { type: 'object', additionalProperties: false, properties: {} } as const

/** One entry of a directory listing ($.fs.list, a directory's mtime from $.fs.stat). */
export type ListedFile = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }

/** The orchestrator directory's git state; undefined when git is missing or the directory is no repository. */
export type GitState = {
  /** The current branch, or undefined on a detached HEAD. */
  branch?: string
  /** The default branch (origin/HEAD, else main or master when there); undefined when none is known. */
  defaultBranch?: string
  /** The tracked files with changes not committed, with their mtime when they are still there. */
  changed: { path: string; mtimeMs?: number }[]
}

export type AuditInput = {
  entries: readonly SessionEntry[]
  facts: ProcFacts
  /** Why the registry could not be read or parsed; the registry checks then run on no entries. */
  registryError?: string
  nowMs: number
  /** The helper files' text; undefined when missing. */
  queueText?: string
  pointsText?: string
  decisionsText?: string
  /** The session ids of cleared.jsonl (retired sessions); undefined when it cannot be read. */
  retired?: ReadonlySet<string>
  backups?: readonly ListedFile[]
  runs?: readonly ListedFile[]
  reports?: readonly ListedFile[]
  git?: GitState
}

export type Severity = 'high' | 'medium' | 'low'
/** One finding; `ref` is the id it is about (a task's id, or a session id's first 8 characters) where it has one: the retire-due notice lists them. */
export type Finding = { severity: Severity; kind: string; subject: string; evidence: string; action: string; ref?: string }

/** The kinds in the order they are told within a severity. */
const KIND_ORDER = [
  'helper-file',
  'queue-status',
  'running-task-no-session',
  'waits-for-finished',
  'unacknowledged',
  'done-in-queue',
  'queued-free-wait',
  'retirable',
  'stale-kept',
  'kept-old',
  'open-point-old',
  'git-uncommitted',
  'git-branch',
  'open-point-held',
  'backups',
  'runs',
  'reports',
  'decisions-stale',
]
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** The most findings told; the rest are counted. */
export const MAX_FINDINGS = 40
/** A kept session older than this is told. */
export const KEPT_MAX_SEC = 6 * 3600
/** A kept session finished longer ago than this is stale-kept: audit_state and the finished-open notice flag it. */
export const STALE_KEPT_SEC = 24 * 3600
/** An open point raised more than this many days ago is told. */
export const POINT_MAX_DAYS = 7
/** A backup older than this, other than the newest of its kind, is spent. */
export const BACKUP_MAX_SEC = 2 * 86400

/** The mod's own files in the runs directory, which no registry entry names: the trace, the cleared log, its scripts. */
const OWN_RUN_FILE = /^(trace\.log(\.\d+)?|cleared\.jsonl|[a-z]+\.ps1)$/

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
/** A licence headroom wait, as the orchestrator records a launch refused for licence room: a percentage or the word headroom. */
const LICENCE_WAIT = /\bheadroom\b|\d+(?:\.\d+)?\s*%/i
/** A reset time in a licence wait: an ISO date and time (a blank for the T, seconds and a zone optional; no zone is local time). */
const RESET_TIME = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?\b/gi

type Task = { id: string; title: string; status: string; waitsFor: string; text: string }
type Point = { id: string; title: string; status: string; hold: boolean; raised?: string }

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const short = (text: string, max = 120) => {
  const flat = clean(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const names = (list: readonly string[], max = 5, width = 80, show: (text: string, width: number) => string = short) =>
  `${list.slice(0, max).map(one => show(one, width)).join(', ')}${list.length > max ? ` and ${list.length - max} more` : ''}`
/**
 * A file name as an answer shows it: redacted as the trace redacts a path (a word of letters only, digits only or
 * under 16 characters stays, so a dated backup name reads whole; a long word mixing letters and digits goes).
 */
const fileName = (name: string, width = 80) => {
  const shown = clean(`/${name.replace(/\s+/g, ' ')}`).slice(1)
  return shown.length > width ? `${shown.slice(0, width - 1)}\u2026` : shown
}
const fileNames = (list: readonly string[], max = 5) => names(list, max, 80, fileName)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The tasks of the queue file, or why it cannot be read. */
function readTasks(text: string | undefined): Task[] | string {
  if (text === undefined) return []
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return 'task-queue.json does not parse'
  }
  const list = (doc as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(list)) return 'task-queue.json has no tasks array'
  return list
    .filter((one): one is Record<string, unknown> => one !== null && typeof one === 'object' && !Array.isArray(one))
    .map(one => ({ id: str(one.id), title: str(one.title), status: typeof one.status === 'string' ? one.status : JSON.stringify(one.status ?? null), waitsFor: str(one.waits_for), text: JSON.stringify(one) }))
}

/** The points of the open points file, or why it cannot be read. */
function readPoints(text: string | undefined): Point[] | string {
  if (text === undefined) return []
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return 'open-points.json does not parse'
  }
  const list = (doc as { points?: unknown } | null)?.points
  if (!Array.isArray(list)) return 'open-points.json has no points array'
  return list
    .filter((one): one is Record<string, unknown> => one !== null && typeof one === 'object' && !Array.isArray(one))
    .map(one => ({ id: str(one.id), title: str(one.title), status: str(one.status), hold: one.hold === true, ...(typeof one.raised === 'string' ? { raised: one.raised } : {}) }))
}

/** Whole days from a YYYY-MM-DD date to another; undefined when either is not one. */
function daysBetween(from: string, to: string): number | undefined {
  const day = (text: string) => {
    const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
    return found === null ? undefined : Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]))
  }
  const a = day(from)
  const b = day(to)
  return a === undefined || b === undefined ? undefined : Math.round((b - a) / 86_400_000)
}

/** A backup's kind: its name without the date (and what follows the date up to the extension). */
export function backupKind(name: string): string {
  return name.replace(/[-_.]?\d{4}-\d{2}-\d{2}[A-Za-z0-9]*/, '')
}

/**
 * A licence headroom wait's state: `none` when the text is no licence wait; `open` when it has no reset time or its
 * latest reset time is still ahead; `passed` with that time when every reset time it names is behind `nowMs`.
 */
export function licenceWait(text: string, nowMs: number): { state: 'none' | 'open' } | { state: 'passed'; reset: string } {
  if (!LICENCE_WAIT.test(text)) return { state: 'none' }
  const times = [...text.matchAll(RESET_TIME)]
    .map(found => ({ shown: found[0], ms: Date.parse(`${found[1]}T${found[2]}${(found[3] ?? '').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`) }))
    .filter(one => Number.isFinite(one.ms))
  if (times.length === 0) return { state: 'open' }
  const latest = times.reduce((a, b) => (b.ms > a.ms ? b : a))
  return latest.ms > nowMs ? { state: 'open' } : { state: 'passed', reset: latest.shown }
}

/** Whether a text names a session: its full id, its first 8 characters or its session name (the queue checks, the queue-ready notice). */
export function namesSession(text: string, entry: SessionEntry): boolean {
  const sid = str(entry.session_id)
  const name = str(entry.name)
  return (sid !== '' && (text.includes(sid) || text.includes(sid.slice(0, 8)))) || (name !== '' && text.includes(name))
}

/** The session ids of the retired sessions in cleared.jsonl, lower case; undefined when it cannot be read. */
export function retiredIds(clearedText: string | undefined): Set<string> | undefined {
  return clearedText === undefined ? undefined : new Set([...clearedText.matchAll(/"session_id":\s*"([0-9a-fA-F-]{36})"/g)].map(found => (found[1] ?? '').toLowerCase()))
}

/**
 * When a finished session was last active (epoch seconds): its `ended_at`, else its transcript's mtime, else its
 * `started_at`; undefined when none is known. The kept checks of audit_state and the finished-open notice read it.
 */
export function lastActiveSec(entry: SessionEntry, facts: ProcFacts): number | undefined {
  const sid = str(entry.session_id)
  if (typeof entry.ended_at === 'number') return entry.ended_at
  const mtime = sid === '' ? undefined : facts.transcriptMtime.get(sid)
  return mtime ?? (typeof entry.started_at === 'number' ? entry.started_at : undefined)
}

/** The mtime of the oldest tracked change git reports (epoch ms); undefined when none has one. */
export function oldestChangeMs(git: GitState): number | undefined {
  const times = git.changed.map(one => one.mtimeMs).filter((ms): ms is number => ms !== undefined)
  return times.length === 0 ? undefined : Math.min(...times)
}

/**
 * The git findings of the orchestrator directory: a branch other than the default with no worker alive (or a detached
 * HEAD), and tracked changes not committed with the age of the oldest. audit_state and the repo-state notice read the
 * same findings.
 */
export function gitFindings(git: GitState, aliveCount: number, nowMs: number): Finding[] {
  const out: Finding[] = []
  const workers = `${plural(aliveCount, 'worker')} alive`
  if (git.branch !== undefined && git.defaultBranch !== undefined && git.branch !== git.defaultBranch && aliveCount === 0) {
    out.push({ severity: 'medium', kind: 'git-branch', subject: 'the orchestrator directory', evidence: `on branch ${short(git.branch, 80)}, not the default ${short(git.defaultBranch, 80)}; ${workers}`, action: 'check the branch out back to the default one once nothing needs it' })
  }
  if (git.branch === undefined) out.push({ severity: 'medium', kind: 'git-branch', subject: 'the orchestrator directory', evidence: `HEAD is detached; ${workers}`, action: 'check out the default branch once nothing needs the detached HEAD' })
  if (git.changed.length > 0) {
    const oldestMs = oldestChangeMs(git)
    const oldest = oldestMs === undefined ? '' : `, the oldest change ${formatAge(Math.max(0, nowMs - oldestMs) / 1000)} old`
    out.push({
      severity: 'medium',
      kind: 'git-uncommitted',
      subject: 'the orchestrator directory',
      evidence: `${plural(git.changed.length, 'tracked file')} with changes not committed (${fileNames(git.changed.map(one => one.path))})${oldest}; branch ${short(git.branch ?? 'detached HEAD', 80)}; ${workers}`,
      action: 'commit what is settled through a worker, or say what keeps it uncommitted',
    })
  }
  return out
}

/** The base name of a path, on either system. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A sections' unit: the strong marks its heading carries (a branch, a T-number, a number of five or more digits). */
function strongMarks(heading: string): string[] {
  const marks = new Set<string>()
  for (const found of heading.matchAll(/\bbranch(?:es)?\s+([A-Za-z0-9._/-]+)/gi)) if (found[1] !== undefined) marks.add(found[1].replace(/[.,;:]+$/, ''))
  for (const found of heading.matchAll(/\bT\d{2,3}\b|\b\d{5,}\b/g)) marks.add(found[0])
  return [...marks]
}

const STOPWORDS = new Set(['with', 'from', 'that', 'this', 'into', 'over', 'after', 'before', 'user', 'users', 'what', 'when', 'where', 'which', 'their', 'about', 'than', 'then', 'them', 'they', 'were', 'will', 'goes', 'part', 'mine'])

/** A section heading's own words (its parenthetical attribution and dates left out), four letters or more. */
function headingWords(heading: string): string[] {
  const main = heading.replace(/\([^)]*\)/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
  return [...new Set(main.toLowerCase().split(/[^a-z0-9-]+/).filter(word => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word)))]
}

/** The `## ` sections of agreed-decisions.md: heading and line count. */
export function decisionSections(text: string): { heading: string; lines: number }[] {
  const sections: { heading: string; lines: number }[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) sections.push({ heading: line.slice(3).trim(), lines: 0 })
    else if (sections.length > 0) (sections.at(-1) as { lines: number }).lines++
  }
  return sections
}

/**
 * Whether a section's unit has something left: a strong mark of its heading (branch, T-number, long number) in the
 * live text (the queue's tasks not done, the registry's entries, the open points that are open); with no strong mark,
 * two of its words (or its only one) there.
 */
function hasUnitLeft(heading: string, live: string): { isLeft: boolean; by: string } {
  const strong = strongMarks(heading)
  if (strong.length > 0) return { isLeft: strong.some(mark => live.includes(mark.toLowerCase())), by: strong.join(', ') }
  const words = headingWords(heading)
  const hits = words.filter(word => live.includes(word))
  return { isLeft: words.length === 0 || hits.length >= Math.min(2, words.length), by: words.length === 0 ? 'no words to match' : `words ${words.slice(0, 6).join(', ')}` }
}

/** The findings of the audit, the most important first, unbounded (auditText bounds them). */
export function auditFindings(input: AuditInput): Finding[] {
  const out: Finding[] = []
  const nowSec = Math.floor(input.nowMs / 1000)
  const add = (finding: Finding) => out.push(finding)
  const { entries, facts } = input
  const sessionName = (entry: SessionEntry) => `session ${str(entry.session_id).slice(0, 8) || '(no id)'} "${short(str(entry.title) || '(untitled)', 80)}"`

  if (input.registryError !== undefined) add({ severity: 'high', kind: 'helper-file', subject: 'the registry', evidence: short(input.registryError, 200), action: 'raise an open point: a helper file that exists and does not parse is a blocker; the registry checks were skipped' })
  const tasks = readTasks(input.queueText)
  const points = readPoints(input.pointsText)
  for (const problem of [tasks, points]) {
    if (typeof problem === 'string') add({ severity: 'high', kind: 'helper-file', subject: problem.split(' ')[0] ?? 'a helper file', evidence: problem, action: 'raise an open point: a helper file that exists and does not parse is a blocker; its checks were skipped' })
  }
  const taskList = typeof tasks === 'string' ? [] : tasks
  const pointList = typeof points === 'string' ? [] : points
  const status = (entry: SessionEntry) => rowStatus(entry, facts)
  const alive = entries.filter(entry => status(entry) === 'alive')
  const isNamedBy = namesSession
  const taskName = (task: Task) => `task ${short(task.id || '(no id)', 60)} "${short(task.title || '(untitled)', 80)}"`

  // ---- the queue
  for (const task of taskList) {
    if (!['queued', 'running', 'done'].includes(task.status)) {
      add({ severity: 'high', kind: 'queue-status', ref: task.id, subject: taskName(task), evidence: `status "${short(task.status, 60)}" is not exactly queued, running or done`, action: 'queue_task update with status queued, running or done, the detail in note' })
    }
    if (task.status === 'running' && !alive.some(entry => isNamedBy(task.text, entry))) {
      add({
        severity: 'high',
        kind: 'running-task-no-session',
        ref: task.id,
        subject: taskName(task),
        evidence: `running, but it names no live session (by session id, its first 8 characters or its name); ${plural(alive.length, 'session')} alive`,
        action: 'when its work finished or died, set it done (or queued for a relaunch) with queue_task; when a live session does it, name that session in its note',
      })
    }
    // A waits_for of whitespace only is no wait.
    if (task.status === 'queued' && task.waitsFor.trim() !== '') {
      const ids = [...task.waitsFor.matchAll(UUID)].map(found => found[0].toLowerCase())
      const blockers: string[] = []
      for (const entry of entries) {
        if (isNamedBy(task.waitsFor, entry) && status(entry) !== 'alive') blockers.push(`${sessionName(entry)} finished`)
      }
      for (const id of ids) {
        if (!entries.some(entry => str(entry.session_id).toLowerCase() === id)) blockers.push(`session ${id.slice(0, 8)} ${input.retired?.has(id) === true ? 'was retired' : 'is in no registry entry'}`)
      }
      if (blockers.length > 0) add({ severity: 'high', kind: 'waits-for-finished', ref: task.id, subject: taskName(task), evidence: `waits_for "${short(task.waitsFor, 100)}": ${names(blockers, 3)}`, action: 'its blocker has cleared: launch it, or correct waits_for with queue_task' })
      // A wait the audit cannot check: it names no registry session and holds no full session id (an unreadable
      // registry leaves it out: no wait could be resolved), and it is no licence headroom wait still open.
      const licence = licenceWait(task.waitsFor, input.nowMs)
      const isSessionWait = ids.length > 0 || entries.some(entry => isNamedBy(task.waitsFor, entry))
      if (input.registryError === undefined && !isSessionWait && licence.state !== 'open') {
        const why = licence.state === 'passed' ? `a licence headroom wait whose reset time ${short(licence.reset, 40)} has passed` : 'names no registry session (by session id, its first 8 characters or its name)'
        add({ severity: 'medium', kind: 'queued-free-wait', ref: task.id, subject: taskName(task), evidence: `waits_for "${short(task.waitsFor, 120)}": ${why}`, action: 'confirm the wait still holds: when the work it waits for is finished or abandoned, set the task done or remove it with queue_task' })
      }
    }
    if (task.status === 'done') add({ severity: 'medium', kind: 'done-in-queue', ref: task.id, subject: taskName(task), evidence: 'status done, still in the queue', action: 'queue_task remove once its unit is closed and reported' })
  }

  // ---- the registry
  const active = activeQueueText(input.queueText ?? '')
  for (const entry of entries) {
    const state = status(entry)
    const outcome = entry.outcome as { kind?: unknown } | undefined
    const kind = typeof outcome?.kind === 'string' ? outcome.kind : undefined
    const ended = typeof entry.ended_at === 'number' ? entry.ended_at : undefined
    if (state === 'unreported' || state === 'dead') {
      const evidence =
        state === 'dead' ? `its pid ${entry.pid} is gone and the mod has not harvested its exit yet` : `finished${kind === undefined ? '' : ` (${kind})`}${ended === undefined ? '' : ` ${formatAge(nowSec - ended)} ago`}, not acknowledged`
      add({ severity: 'medium', kind: 'unacknowledged', subject: sessionName(entry), evidence, action: 'report its result, then acknowledge_workers (keep true when a resume or follow-up needs it)' })
    }
    const sid = str(entry.session_id)
    const isNamedByTask = sid !== '' && (active.includes(sid) || active.includes(sid.slice(0, 8)))
    if (state === 'done' && entry.keep !== true && kind === 'clean' && !isNamedByTask) {
      add({ severity: 'medium', kind: 'retirable', ref: sid.slice(0, 8), subject: sessionName(entry), evidence: `finished clean, acknowledged, not kept, no queued or running task names it${ended === undefined ? '' : `; ended ${formatAge(nowSec - ended)} ago`}`, action: 'retire_workers when its goal is met' })
    }
    if (entry.keep === true && state !== 'alive') {
      const since = lastActiveSec(entry, facts)
      if (since !== undefined && nowSec - since > STALE_KEPT_SEC) {
        add({ severity: 'medium', kind: 'stale-kept', ref: sid.slice(0, 8), subject: sessionName(entry), evidence: `marked keep, last active ${formatAge(nowSec - since)} ago (more than 24 hours): stale-kept`, action: 'resume it if the follow-up is still due; else acknowledge_workers with keep false, then retire_workers' })
      } else if (since !== undefined && nowSec - since > KEPT_MAX_SEC) {
        add({ severity: 'medium', kind: 'kept-old', ref: sid.slice(0, 8), subject: sessionName(entry), evidence: `marked keep, last active ${formatAge(nowSec - since)} ago (more than 6 hours)`, action: 'resume it if the follow-up is still due; else acknowledge_workers with keep false and retire it' })
      }
    }
  }

  // ---- the open points
  const today = localDate(input.nowMs)
  for (const point of pointList) {
    if (point.status !== 'open') continue
    const subject = `open point ${short(point.id || '(no id)', 60)} "${short(point.title || '(untitled)', 80)}"`
    if (point.hold) add({ severity: 'low', kind: 'open-point-held', subject, evidence: 'held: the panel and the chat leave it out', action: 'open_point release once the user takes it up again, or close it when it is settled' })
    const age = point.raised === undefined ? undefined : daysBetween(point.raised, today)
    if (age !== undefined && age > POINT_MAX_DAYS) add({ severity: 'medium', kind: 'open-point-old', subject, evidence: `raised ${point.raised}, ${age} days ago`, action: 'put it to the user again, or close it with its resolution if it is settled or stale' })
  }

  // ---- git
  if (input.git !== undefined) for (const finding of gitFindings(input.git, alive.length, input.nowMs)) add(finding)

  // ---- backups/: per kind, the files older than 2 days beyond the newest of their kind
  const kinds = new Map<string, ListedFile[]>()
  for (const file of input.backups ?? []) kinds.set(backupKind(file.name), [...(kinds.get(backupKind(file.name)) ?? []), file])
  for (const [kind, files] of kinds) {
    const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)
    const spent = sorted.slice(1).filter(file => input.nowMs - file.mtimeMs > BACKUP_MAX_SEC * 1000)
    if (spent.length > 0) {
      add({ severity: 'low', kind: 'backups', subject: `backups of kind ${fileName(kind)}`, evidence: `${plural(files.length, 'file')}; ${plural(spent.length, 'is', 'are')} older than 2 days besides the newest: ${fileNames(spent.map(file => file.name))}`, action: 'delete the spent ones, keeping the newest and any deliverable the user has not seen' })
    }
  }

  // ---- the runs directory: files no registry entry names
  const named = new Set<string>()
  for (const entry of entries) {
    for (const path of [entry.result_file, entry.err_file]) {
      if (typeof path !== 'string' || path === '') continue
      named.add(baseName(path))
      named.add(baseName(path).replace(/\.json$/, '.pid'))
    }
  }
  const loose = (input.runs ?? []).filter(file => file.kind === 'file' && !OWN_RUN_FILE.test(file.name) && !named.has(file.name)).sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (loose.length > 0) {
    const bytes = loose.reduce((sum, file) => sum + file.size, 0)
    const oldest = loose[0] as ListedFile
    add({
      severity: 'low',
      kind: 'runs',
      subject: 'the runs directory',
      evidence: `${plural(loose.length, 'file')} (${Math.ceil(bytes / 1024)} KiB) that no registry entry names, the oldest ${formatAge((input.nowMs - oldest.mtimeMs) / 1000)} old: ${fileNames(loose.map(file => file.name))}`,
      action: 'delete the spent ones once each outcome with its cost is in the registry (or its entry was retired) and nothing else is lost',
    })
  }

  // ---- reports/
  const reports = (input.reports ?? []).filter(file => file.kind !== 'other')
  if (reports.length > 0) {
    const sorted = [...reports].sort((a, b) => a.mtimeMs - b.mtimeMs)
    add({ severity: 'low', kind: 'reports', subject: 'reports/', evidence: `${plural(reports.length, 'saved report')}: ${sorted.slice(0, 5).map(file => `${fileName(file.name)} (${file.mtimeMs === 0 ? 'age unknown' : `${formatAge((input.nowMs - file.mtimeMs) / 1000)} old`})`).join(', ')}${sorted.length > 5 ? ` and ${sorted.length - 5} more` : ''}`, action: 'delete the spent reports of closed units' })
  }

  // ---- agreed-decisions.md: sections whose unit has nothing left
  if (input.decisionsText !== undefined) {
    const live = [
      ...taskList.filter(task => task.status !== 'done').map(task => task.text),
      ...entries.map(entry => [entry.title, entry.cwd, entry.name].filter(one => typeof one === 'string').join(' ')),
      ...pointList.filter(point => point.status === 'open').map(point => point.title),
    ]
      .join('\n')
      .toLowerCase()
    const stale = decisionSections(input.decisionsText)
      .filter(section => !/^standing\b/i.test(section.heading) && section.heading !== ARCHIVED_HEADING)
      .map(section => ({ section, left: hasUnitLeft(section.heading, live) }))
      .filter(one => !one.left.isLeft)
    if (stale.length > 0) {
      add({
        severity: 'low',
        kind: 'decisions-stale',
        subject: 'agreed-decisions.md',
        evidence: `${plural(stale.length, 'section')} whose unit no queue task, registry entry or open point names: ${names(stale.map(one => `"${one.section.heading}" (${one.left.by})`), 8, 200)}`,
        action: 'archive the sections of closed units with archive_decisions, keeping the Standing ones',
      })
    }
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
}

/** The facts line: how much each helper file and folder holds. */
function factsLine(input: AuditInput): string {
  const tasks = readTasks(input.queueText)
  const points = readPoints(input.pointsText)
  const alive = input.entries.filter(entry => rowStatus(entry, input.facts) === 'alive').length
  const kinds = new Map<string, number>()
  for (const file of input.backups ?? []) kinds.set(backupKind(file.name), (kinds.get(backupKind(file.name)) ?? 0) + 1)
  const sections = input.decisionsText === undefined ? undefined : decisionSections(input.decisionsText)
  const parts = [
    `registry ${input.registryError === undefined ? `${plural(input.entries.length, 'entry', 'entries')}, ${alive} alive` : 'unreadable'}`,
    `queue ${typeof tasks === 'string' ? 'unreadable' : plural(tasks.length, 'task')}`,
    `open points ${typeof points === 'string' ? 'unreadable' : `${points.filter(point => point.status === 'open').length} open (${points.filter(point => point.status === 'open' && point.hold).length} held)`}`,
    `backups/ ${input.backups === undefined ? 'missing' : `${plural(input.backups.length, 'file')} in ${plural(kinds.size, 'kind')}${kinds.size === 0 ? '' : ` (${[...kinds].slice(0, 12).map(([kind, n]) => `${fileName(kind, 60)} ${n}`).join(', ')}${kinds.size > 12 ? ', ...' : ''})`}`}`,
    `runs ${input.runs === undefined ? 'missing' : plural(input.runs.filter(file => file.kind === 'file').length, 'file')}`,
    `reports/ ${input.reports === undefined ? 'missing' : plural(input.reports.length, 'file')}`,
    `agreed-decisions.md ${sections === undefined ? 'missing' : `${(input.decisionsText ?? '').split('\n').length - ((input.decisionsText ?? '').endsWith('\n') ? 1 : 0)} lines, ${plural(sections.length, 'section')}`}`,
    `git ${input.git === undefined ? 'not checked (no git, or not a repository)' : `branch ${short(input.git.branch ?? 'detached HEAD', 60)}${input.git.defaultBranch === undefined ? '' : ` (default ${short(input.git.defaultBranch, 60)})`}, ${plural(input.git.changed.length, 'tracked file')} changed`}`,
  ]
  return `facts: ${parts.join('; ')}.`
}

/** audit_state's answer: the count, the facts, then the findings, numbered, the most important first. */
export function auditText(input: AuditInput): string {
  const findings = auditFindings(input)
  const count = (severity: Severity) => findings.filter(one => one.severity === severity).length
  const head = findings.length === 0 ? 'audit_state: no findings; nothing was changed.' : `audit_state: ${plural(findings.length, 'finding')} (${count('high')} high, ${count('medium')} medium, ${count('low')} low); nothing was changed.`
  const lines = [head, factsLine(input)]
  findings.slice(0, MAX_FINDINGS).forEach((one, at) => lines.push(`${at + 1}. [${one.severity}] ${one.kind} | ${one.subject} | ${one.evidence} | action: ${one.action}`))
  if (findings.length > MAX_FINDINGS) lines.push(`(${findings.length - MAX_FINDINGS} more findings not shown)`)
  return bounded(lines.join('\n'))
}
