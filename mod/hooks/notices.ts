// Pure part of the poll-based notices (decisions win-20, win-21, win-22, win-27, win-36, win-38 and mod-3): what the mod
// already knows at a poll, a harvest or a queue change, told to the orchestrator sparingly. Each notice is one line,
// `session-control notice: <kind>: <message>`, which register.tsx adds to the notes the next prompt carries, shows as a
// toast titled by its kind and traces. Each kind has its own debounce, kept in NoticeState, which register.tsx keeps in
// $.store so a reload of the mod fires nothing again. Nothing here reads, writes, probes or runs a process.

import type { SessionEntry, SessionOutcome } from '../types'
import { formatAge, orphanProcs, rowStatus } from './core'
import type { ProcFact, ProcFacts } from './core'
import { auditFindings, gitFindings, namesSession, oldestChangeMs } from './audit'
import type { Finding, GitState } from './audit'
import { clean } from './inspect'
import { localDate } from './store'

export type NoticeKind =
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

/** One notice: its kind, its message (one line) and the trace's fields (ids, counts and switches only, never free text). */
export type Notice = { kind: NoticeKind; message: string; fields: Record<string, string | number | boolean> }

/** What every notice line starts with. */
export const NOTICE_PREFIX = 'session-control notice:'

// ---------------------------------------------------------------- thresholds (README, Notices)

/** An orphan is told once it has been seen unclaimed for this long (the launch's pid discovery is shorter). */
export const ORPHAN_GRACE_SEC = 30
/** A live worker whose transcript has not been written for this long is stalled. */
export const STALL_SEC = 15 * 60
/** An open, not held point older than this is told, once per point and day. */
export const OPEN_POINT_AGE_SEC = 24 * 3600
/** The retire-due notice comes at most once per this interval. */
export const RETIRE_EVERY_SEC = 3600
/** While the retire-due notice is due, its findings are worked out at most once per this interval. */
export const RETIRE_CHECK_SEC = 60
/** The repo-state check (git) runs at most once per this interval, and only from the poll. */
export const REPO_EVERY_SEC = 3600
/** Tracked changes older than this, with no worker alive, are told by repo-state. */
export const REPO_CHANGE_AGE_SEC = 30 * 60
/** An unsound registry (isRegistrySound) read at every poll for this long is told once per episode (registryStep). */
export const REGISTRY_UNREADABLE_SEC = 5 * 60
/** How many ids a notice that counts lists before `and N more`. */
export const NOTICE_IDS_SHOWN = 3
/** The most notice lines waiting for the next prompt, the closing `more` line included (pendingWith). */
export const PENDING_NOTICES_MAX = 30
/**
 * The most notice toasts one pass shows: the poll's notices, the harvests' notices of one refresh together, a queue
 * change's; the rest of a refresh go to one summary toast (moreToastText).
 */
export const TOASTS_PER_PASS = 3
/** The orphans of one poll told one by one; the rest are grouped into one notice (orphanGroupNotice). */
export const ORPHANS_SHOWN = 5
/** How many pids the grouped orphan notice lists. */
export const ORPHAN_PIDS_LISTED = 10

/** The finding kinds of audit_state the retire-due notice counts, by its three groups. */
const RETIRE_GROUPS: readonly { kinds: readonly string[]; label: (n: number) => string }[] = [
  { kinds: ['retirable'], label: n => `${n} finished ${n === 1 ? 'session' : 'sessions'} can be retired` },
  { kinds: ['kept-old'], label: n => `${n} kept ${n === 1 ? 'session' : 'sessions'} idle over 6 hours` },
  { kinds: ['queue-status', 'running-task-no-session', 'waits-for-finished', 'done-in-queue'], label: n => `${n} queue ${n === 1 ? 'task looks' : 'tasks look'} stale` },
]

// ---------------------------------------------------------------- state

/**
 * The debounce state of the notices, kept in $.store under one key per orchestrator directory (noticeStoreKey), so a
 * reload of the mod, or a new session in the same directory, does not tell again what was told. Pruned at every poll:
 * a pid, session or point that is gone leaves it.
 */
export type NoticeState = {
  /** Per orphan pid: when it was first seen unclaimed (epoch ms), whether it was told, whether it is this session's own process. */
  orphans: Record<string, { since: number; isTold?: true; isOwn?: true }>
  /** Per live session id: the transcript mtime (epoch seconds) its stall was told at; a newer mtime re-arms it. */
  stalls: Record<string, number>
  /** The queue-ready notices told, as `<task id> <session id>:<pid>`. */
  queueReady: string[]
  /** Whether unit-complete was told and no task has been queued or running since. */
  isUnitTold: boolean
  /** The session ids whose compliance-due notice was told. */
  compliance: string[]
  /** Per open point id: when the mod first saw it open (epoch ms) and the local date its age notice was last told. */
  points: Record<string, { seen: number; told?: string }>
  /** When retire-due was last told, and when its findings were last worked out (epoch ms). */
  retireAt?: number
  retireCheckAt?: number
  /** When the repo-state check last ran git (epoch ms). */
  repoAt?: number
  /**
   * Per lock path told by lock-holder: the fingerprint of the content it was told for; a changed content re-arms it.
   * Absent until a lock is told, so the stored state of a mod with lockDirs off is as before.
   */
  locks?: Record<string, string>
  /** The changed files (one per line) the last mod-drift notice was told for; absent while the trees match. */
  drift?: string
}

export function freshNoticeState(): NoticeState {
  return { orphans: {}, stalls: {}, queueReady: [], isUnitTold: false, compliance: [], points: {} }
}

/** The $.store key of an orchestrator directory's notice state. */
export function noticeStoreKey(orchestratorDir: string): string {
  return `notices:${orchestratorDir}`
}

/** The orchestrator directory a $.store key belongs to; undefined for a key that is no notice state's. */
export function noticeKeyDir(key: string): string | undefined {
  return key.startsWith('notices:') && key.length > 'notices:'.length ? key.slice('notices:'.length) : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [])

/** A stored state read back; anything that is not one of its fields is dropped, so a damaged value starts fresh. */
export function parseNoticeState(value: unknown): NoticeState {
  const state = freshNoticeState()
  if (!isRecord(value)) return state
  if (isRecord(value.orphans)) {
    for (const [pid, one] of Object.entries(value.orphans)) {
      const since = isRecord(one) ? finite(one.since) : undefined
      if (since === undefined || !isRecord(one)) continue
      state.orphans[pid] = { since, ...(one.isTold === true ? { isTold: true as const } : {}), ...(one.isOwn === true ? { isOwn: true as const } : {}) }
    }
  }
  if (isRecord(value.stalls)) for (const [sid, mtime] of Object.entries(value.stalls)) if (finite(mtime) !== undefined) state.stalls[sid] = mtime as number
  state.queueReady = strings(value.queueReady)
  state.isUnitTold = value.isUnitTold === true
  state.compliance = strings(value.compliance)
  if (isRecord(value.points)) {
    for (const [id, one] of Object.entries(value.points)) {
      const seen = isRecord(one) ? finite(one.seen) : undefined
      if (seen === undefined || !isRecord(one)) continue
      state.points[id] = { seen, ...(typeof one.told === 'string' ? { told: one.told } : {}) }
    }
  }
  for (const key of ['retireAt', 'retireCheckAt', 'repoAt'] as const) {
    const at = finite(value[key])
    if (at !== undefined) state[key] = at
  }
  if (isRecord(value.locks)) {
    const locks = Object.fromEntries(Object.entries(value.locks).filter((one): one is [string, string] => typeof one[1] === 'string'))
    if (Object.keys(locks).length > 0) state.locks = locks
  }
  if (typeof value.drift === 'string' && value.drift !== '') state.drift = value.drift
  return state
}

// ---------------------------------------------------------------- text

/** The line the model reads. */
export function noticeLine(notice: Notice): string {
  return `${NOTICE_PREFIX} ${notice.kind}: ${notice.message}`
}

/** The line that closes the notices waiting for the next prompt when the cap left some out: how many. */
export function moreLine(count: number): string {
  return `${NOTICE_PREFIX} more: ${count} further ${count === 1 ? 'notice' : 'notices'} not shown; run list_sessions and audit_state`
}

const MORE_LINE = /^session-control notice: more: (\d+) further notices? not shown; /

/**
 * The notice lines waiting for the next prompt with `lines` added: at most PENDING_NOTICES_MAX lines. Past the cap the
 * first lines stay and the newer ones are counted: the last line (moreLine) says how many were not shown, so nothing
 * is dropped silently, and a later addition adds to that count.
 */
export function pendingWith(list: readonly string[], lines: readonly string[]): string[] {
  const found = MORE_LINE.exec(list[list.length - 1] ?? '')
  const dropped = found === null ? 0 : Number(found[1])
  const all = [...(found === null ? list : list.slice(0, -1)), ...lines]
  if (dropped === 0 && all.length <= PENDING_NOTICES_MAX) return all
  const room = PENDING_NOTICES_MAX - 1
  return [...all.slice(0, room), moreLine(dropped + Math.max(0, all.length - room))]
}

/** The summary toast's message for the notices past the toast cap of a refresh. */
export function moreToastText(count: number): string {
  return `${count} more ${count === 1 ? 'notice' : 'notices'}: see the next prompt`
}

/** A free text of a helper file or the registry on one line: control characters dropped, secrets redacted, cut. */
function oneLine(text: string, max = 80): string {
  const flat = clean(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** A session as a notice names it: its session name, else its id's first 8 characters. */
function sessionLabel(entry: SessionEntry): string {
  const name = str(entry.name)
  return name !== '' ? oneLine(name, 64) : str(entry.session_id).slice(0, 8) || '(no id)'
}

/** Up to NOTICE_IDS_SHOWN ids, then how many more. */
function idList(ids: readonly string[]): string {
  const shown = ids.slice(0, NOTICE_IDS_SHOWN).map(id => oneLine(id, 40)).join(', ')
  return ids.length > NOTICE_IDS_SHOWN ? `${shown} and ${ids.length - NOTICE_IDS_SHOWN} more` : shown
}

// ---------------------------------------------------------------- the registry as the notices read it

/**
 * Whether the registry text read at a poll can carry the registry-dependent notices (orphan, stall, queue-ready,
 * compliance-due, retire-due, repo-state) and their pruning: read (not missing, not unreadable), not empty or blank,
 * and a JSON array. Otherwise those steps are skipped for that poll: nothing fires and nothing is forgotten, so a
 * failed read never counts as an empty registry. A registry that parses to `[]` is a sound, empty registry.
 */
export function isRegistrySound(text: string | undefined): boolean {
  if (text === undefined || text.trim() === '') return false
  try {
    return Array.isArray(JSON.parse(text))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- the helper files as the notices read them

type Task = { id: string; status: string; waitsFor: string }

/** The queue's tasks; undefined when the file is missing, does not parse or has no tasks array (no notice can tell then). */
export function queueTasks(text: string | undefined): Task[] | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  const list = isRecord(doc) ? doc.tasks : undefined
  if (!Array.isArray(list)) return undefined
  return list.filter(isRecord).map(one => ({ id: str(one.id), status: str(one.status), waitsFor: str(one.waits_for) }))
}

type Point = { id: string; title: string; isHeld: boolean; raised?: string }

/** The open points (status open), held ones included; undefined when the file cannot be read as the points file. */
function openPoints(text: string | undefined): Point[] | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  const list = isRecord(doc) ? doc.points : undefined
  if (!Array.isArray(list)) return undefined
  return list
    .filter(isRecord)
    .filter(one => one.status === 'open' && str(one.id) !== '')
    .map(one => ({ id: str(one.id), title: str(one.title), isHeld: one.hold === true, ...(typeof one.raised === 'string' ? { raised: one.raised } : {}) }))
}

/** The end of a local calendar day YYYY-MM-DD (the next local midnight, epoch ms); undefined when it is not a date. */
function dayEndMs(date: string): number | undefined {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (found === null) return undefined
  const end = new Date(Number(found[1]), Number(found[2]) - 1, Number(found[3]) + 1).getTime()
  return Number.isFinite(end) ? end : undefined
}

// ---------------------------------------------------------------- orphan

/**
 * The orphan step of a poll: each orphan (orphanProcs, the panel's own predicate) is remembered from the poll that first
 * sees it unclaimed; a pid no longer an orphan (claimed, or gone) is forgotten. Answers the orphans unclaimed for
 * ORPHAN_GRACE_SEC or more that were not told yet and are not known to be this session's own process: register.tsx
 * reads their sessions files, sets aside its own process (markOrphans) and tells the rest.
 */
export function orphanStep(state: NoticeState, entries: readonly SessionEntry[], facts: ProcFacts, nowMs: number): ProcFact[] {
  const orphans = orphanProcs(entries, facts)
  const live = new Set(orphans.map(proc => String(proc.pid)))
  for (const pid of Object.keys(state.orphans)) if (!live.has(pid)) delete state.orphans[pid]
  const due: ProcFact[] = []
  for (const proc of orphans) {
    const key = String(proc.pid)
    const known = state.orphans[key] ?? (state.orphans[key] = { since: nowMs })
    if (known.isTold !== true && known.isOwn !== true && nowMs - known.since >= ORPHAN_GRACE_SEC * 1000) due.push(proc)
  }
  return due
}

/** An orphan register.tsx found to be this session's own process is never told; one told is told once. */
export function markOrphan(state: NoticeState, pid: number, mark: 'told' | 'own'): void {
  const known = state.orphans[String(pid)]
  if (known === undefined) return
  if (mark === 'own') known.isOwn = true
  else known.isTold = true
}

/** The orphan notice: pid, cwd, config dir, process age, how long unclaimed, and the session id when its sessions file names one. */
export function orphanNotice(proc: ProcFact, state: NoticeState, nowMs: number, sessionId?: string): Notice {
  const since = state.orphans[String(proc.pid)]?.since ?? nowMs
  const unclaimed = formatAge((nowMs - since) / 1000)
  const age = proc.elapsedSec === undefined ? 'unknown' : formatAge(proc.elapsedSec)
  const session = sessionId === undefined ? '' : `, session ${oneLine(sessionId, 40)}`
  return {
    kind: 'orphan',
    message: `pid ${proc.pid} is a live headless claude no registry entry claims (cwd ${oneLine(proc.cwd || '?', 120)}, config dir ${oneLine(proc.configDir || 'default', 120)}, age ${age}, unclaimed ${unclaimed}${session}); raise an open point naming it`,
    fields: { pid: proc.pid, unclaimedSec: Math.floor((nowMs - since) / 1000), isSessionRead: sessionId !== undefined },
  }
}

/**
 * The orphans of one poll past the first ORPHANS_SHOWN, grouped into one notice: how many, and the first
 * ORPHAN_PIDS_LISTED pids.
 */
export function orphanGroupNotice(pids: readonly number[]): Notice {
  const listed = pids.slice(0, ORPHAN_PIDS_LISTED).join(', ')
  const rest = pids.length > ORPHAN_PIDS_LISTED ? ` and ${pids.length - ORPHAN_PIDS_LISTED} not listed` : ''
  return {
    kind: 'orphan',
    message: `${pids.length} more unregistered sessions: ${listed}${rest}; list_sessions shows each; raise an open point naming them`,
    fields: { count: pids.length, isGroup: true },
  }
}

// ---------------------------------------------------------------- stall

/**
 * The stall step of a poll: a registered worker whose pid is alive (the Abort check) and whose transcript mtime is
 * STALL_SEC or more ago is told once per episode: the mtime it was told at is kept, and a transcript written again (a
 * newer mtime) re-arms it. A session no longer alive is forgotten.
 */
export function stallStep(state: NoticeState, entries: readonly SessionEntry[], facts: ProcFacts, nowMs: number): Notice[] {
  const notices: Notice[] = []
  const nowSec = nowMs / 1000
  const alive = entries.filter(entry => typeof entry.session_id === 'string' && entry.session_id !== '' && rowStatus(entry, facts) === 'alive')
  const live = new Set(alive.map(entry => String(entry.session_id)))
  for (const sid of Object.keys(state.stalls)) if (!live.has(sid)) delete state.stalls[sid]
  for (const entry of alive) {
    const sid = String(entry.session_id)
    const mtime = facts.transcriptMtime.get(sid)
    if (mtime === undefined || nowSec - mtime < STALL_SEC || state.stalls[sid] === mtime) continue
    state.stalls[sid] = mtime
    const minutes = Math.floor((nowSec - mtime) / 60)
    notices.push({
      kind: 'stall',
      message: `worker "${oneLine(str(entry.title) || '(untitled)')}" (session ${sessionLabel(entry)}) is alive but its transcript has not been written for ${minutes} min; look at it with worker_tail`,
      fields: { session_id: sid, minutes },
    })
  }
  return notices
}

// ---------------------------------------------------------------- harvest: queue-ready and compliance-due

/**
 * The notices of one harvested completion: each queued task whose waits_for names the session (its full id, its
 * first 8 characters or its session name) gets queue-ready, once per task and run (`<task id> <session id>:<pid>`); a
 * session launched with a decisions `section` that finished clean gets compliance-due, once per session.
 */
export function harvestNotices(state: NoticeState, entry: SessionEntry, outcome: SessionOutcome, queueText: string | undefined): Notice[] {
  const notices: Notice[] = []
  const sid = str(entry.session_id)
  if (sid === '') return notices
  for (const task of queueTasks(queueText) ?? []) {
    if (task.status !== 'queued' || task.waitsFor === '' || !namesSession(task.waitsFor, entry)) continue
    const key = `${task.id} ${sid}:${String(entry.pid ?? '')}`
    if (state.queueReady.includes(key)) continue
    state.queueReady.push(key)
    notices.push({ kind: 'queue-ready', message: `queued task ${oneLine(task.id || '(no id)', 60)} waited for ${sessionLabel(entry)}, which finished`, fields: { task: task.id, session_id: sid } })
  }
  const section = str(entry.section)
  if (outcome.kind === 'clean' && section !== '' && !state.compliance.includes(sid)) {
    state.compliance.push(sid)
    notices.push({ kind: 'compliance-due', message: `compliance check due for section ${oneLine(section, 120)} (session ${sessionLabel(entry)})`, fields: { session_id: sid } })
  }
  return notices
}

/** Forgets what no longer needs remembering: queue-ready keys of tasks no longer queued, compliance of sessions gone from the registry. */
export function pruneHarvested(state: NoticeState, entries: readonly SessionEntry[], queueText: string | undefined): void {
  const tasks = queueTasks(queueText)
  if (tasks !== undefined) {
    const queuedIds = new Set(tasks.filter(task => task.status === 'queued').map(task => task.id))
    state.queueReady = state.queueReady.filter(key => queuedIds.has(key.slice(0, key.lastIndexOf(' '))))
  }
  const sids = new Set(entries.map(entry => str(entry.session_id)).filter(sid => sid !== ''))
  state.compliance = state.compliance.filter(sid => sids.has(sid))
}

// ---------------------------------------------------------------- unit-complete

/**
 * unit-complete: after a queue_task change or a harvest (`isTrigger`), when no task is queued or running, told once;
 * any read of the queue that finds a task queued or running re-arms it. A queue that cannot be read tells nothing and
 * changes nothing.
 */
export function unitStep(state: NoticeState, queueText: string | undefined, isTrigger: boolean): Notice[] {
  const tasks = queueTasks(queueText)
  if (tasks === undefined) return []
  if (tasks.some(task => task.status === 'queued' || task.status === 'running')) {
    state.isUnitTold = false
    return []
  }
  if (!isTrigger || state.isUnitTold) return []
  state.isUnitTold = true
  return [{ kind: 'unit-complete', message: 'queue empty: run audit_state and report', fields: { tasks: tasks.length } }]
}

// ---------------------------------------------------------------- open-point-age

/**
 * open-point-age: an open, not held point told once per point and local day when it is surely older than
 * OPEN_POINT_AGE_SEC: its `raised` date gives only the day, so its age counts from the earlier of the end of that day and
 * the moment the mod first saw the point open (a point raised at 09:00 and seen then is told the next day at 09:00).
 */
export function pointStep(state: NoticeState, pointsText: string | undefined, nowMs: number): Notice[] {
  const points = openPoints(pointsText)
  if (points === undefined) return []
  const open = new Set(points.map(point => point.id))
  for (const id of Object.keys(state.points)) if (!open.has(id)) delete state.points[id]
  const today = localDate(nowMs)
  const notices: Notice[] = []
  for (const point of points) {
    const known = state.points[point.id] ?? (state.points[point.id] = { seen: nowMs })
    if (point.isHeld || known.told === today) continue
    const dayEnd = point.raised === undefined ? undefined : dayEndMs(point.raised)
    const raisedBy = Math.min(known.seen, dayEnd ?? known.seen)
    if (nowMs - raisedBy < OPEN_POINT_AGE_SEC * 1000) continue
    known.told = today
    const raised = point.raised === undefined ? `first seen ${formatAge((nowMs - known.seen) / 1000)} ago` : `raised ${oneLine(point.raised, 20)}`
    notices.push({ kind: 'open-point-age', message: `open point ${oneLine(point.id, 60)} (${raised}) is still open: ${oneLine(point.title || '(untitled)', 120)}`, fields: { id: point.id } })
  }
  return notices
}

// ---------------------------------------------------------------- retire-due

/** Whether the retire-due findings are to be worked out now: the last notice an hour back or more, the last look a minute back or more. */
export function isRetireDue(state: NoticeState, nowMs: number): boolean {
  return (state.retireAt === undefined || nowMs - state.retireAt >= RETIRE_EVERY_SEC * 1000) && (state.retireCheckAt === undefined || nowMs - state.retireCheckAt >= RETIRE_CHECK_SEC * 1000)
}

/**
 * retire-due (decision win-36): audit_state's own findings (auditFindings) over the registry, the probe, the queue and
 * the cleared log, counted in three groups (sessions to retire, kept sessions idle over 6 hours, stale queue tasks)
 * with the first few ids; one notice pointing at audit_state, at most once per RETIRE_EVERY_SEC.
 */
export function retireStep(
  state: NoticeState,
  input: { entries: readonly SessionEntry[]; facts: ProcFacts; nowMs: number; queueText?: string; retired?: ReadonlySet<string> },
): Notice[] {
  state.retireCheckAt = input.nowMs
  const findings: Finding[] = auditFindings({
    entries: input.entries,
    facts: input.facts,
    nowMs: input.nowMs,
    ...(input.queueText === undefined ? {} : { queueText: input.queueText }),
    ...(input.retired === undefined ? {} : { retired: input.retired }),
  })
  const parts: string[] = []
  const fields: Record<string, number> = {}
  for (const [at, group] of RETIRE_GROUPS.entries()) {
    const ids = [...new Set(findings.filter(one => group.kinds.includes(one.kind)).map(one => one.ref ?? '?'))]
    fields[['retirable', 'keptOld', 'staleTasks'][at] as string] = ids.length
    if (ids.length > 0) parts.push(`${group.label(ids.length)} (${idList(ids)})`)
  }
  if (parts.length === 0) return []
  state.retireAt = input.nowMs
  return [{ kind: 'retire-due', message: `${parts.join('; ')}: run audit_state`, fields }]
}

// ---------------------------------------------------------------- repo-state

/** Whether the repo-state check runs git now: from the poll only, with no worker alive, the last check an hour back or more. */
export function isRepoDue(state: NoticeState, nowMs: number, aliveCount: number): boolean {
  return aliveCount === 0 && (state.repoAt === undefined || nowMs - state.repoAt >= REPO_EVERY_SEC * 1000)
}

/**
 * repo-state (decision mod-3): the git findings of audit_state (gitFindings) with no worker alive: the orchestrator
 * directory on a branch other than the default (or a detached HEAD), or tracked changes whose oldest is
 * REPO_CHANGE_AGE_SEC or more old; one notice. No git state (git missing, no repository): nothing.
 */
export function repoStep(state: NoticeState, git: GitState | undefined, nowMs: number): Notice[] {
  state.repoAt = nowMs
  if (git === undefined) return []
  const findings = gitFindings(git, 0, nowMs)
  const parts: string[] = []
  const isOffDefault = findings.some(one => one.kind === 'git-branch')
  if (isOffDefault) parts.push(git.branch === undefined ? 'has a detached HEAD' : `is on branch ${oneLine(git.branch, 60)}, not the default ${oneLine(git.defaultBranch ?? '?', 60)}`)
  const oldest = oldestChangeMs(git)
  const isStaleChange = findings.some(one => one.kind === 'git-uncommitted') && oldest !== undefined && nowMs - oldest >= REPO_CHANGE_AGE_SEC * 1000
  if (isStaleChange) parts.push(`has ${git.changed.length} tracked ${git.changed.length === 1 ? 'file' : 'files'} uncommitted, the oldest change ${formatAge((nowMs - (oldest as number)) / 1000)} old`)
  if (parts.length === 0) return []
  return [{ kind: 'repo-state', message: `the orchestrator directory ${parts.join(' and ')}, with no worker alive: run audit_state`, fields: { isOffDefault, isStaleChange, changed: git.changed.length } }]
}

// ---------------------------------------------------------------- registry-unreadable

/**
 * The registry-unreadable episode of this load: when the first unsound read of a row was (epoch ms) and whether it was
 * told. Kept in memory, not in $.store: the stored notice state stays as it was through an unsound registry (mod-20).
 */
export type RegistryWatch = { since?: number; isTold?: boolean }

/**
 * registry-unreadable: an unsound read (isRegistrySound false) starts an episode, and one that has lasted
 * REGISTRY_UNREADABLE_SEC or more is told once; a sound read ends it, so the next episode is told again. The
 * registry-based notices stay frozen meanwhile, as pollNotices freezes them.
 */
export function registryStep(watch: RegistryWatch, isSound: boolean, nowMs: number): Notice[] {
  if (isSound) {
    delete watch.since
    delete watch.isTold
    return []
  }
  const since = watch.since ?? (watch.since = nowMs)
  if (watch.isTold === true || nowMs - since < REGISTRY_UNREADABLE_SEC * 1000) return []
  watch.isTold = true
  const minutes = Math.floor((nowMs - since) / 60_000)
  return [{ kind: 'registry-unreadable', message: `the registry has been unreadable for ${minutes} min: the registry-based notices are paused`, fields: { minutes } }]
}

// ---------------------------------------------------------------- lock-holder

/** One lock as the check read it: its path, the content's fingerprint, the holder and whether it is gone. */
export type LockSeen = { lock: string; fingerprint: string; pid: number; isJson: boolean; isDead: boolean }

/**
 * lock-holder (decision win-27): each lock whose holder is gone is told once per content (its fingerprint); a lock
 * whose content changes is told again when its holder is gone again. A lock no longer there is forgotten, as is one
 * whose holder is alive. `seen` holds the locks read at this check; `dirsRead` the lock folders that could be listed
 * (a lock under a folder that could not be read is kept, not forgotten).
 */
export function lockStep(state: NoticeState, seen: readonly LockSeen[], dirsRead: readonly string[]): Notice[] {
  const told = state.locks ?? {}
  const present = new Map(seen.map(one => [one.lock, one]))
  const under = (lock: string) => dirsRead.some(dir => lock.startsWith(`${dir.replace(/[\\/]+$/, '')}/`))
  for (const lock of Object.keys(told)) {
    const one = present.get(lock)
    if ((one === undefined && under(lock)) || (one !== undefined && !one.isDead)) delete told[lock]
  }
  const notices: Notice[] = []
  for (const one of seen) {
    if (!one.isDead || told[one.lock] === one.fingerprint) continue
    told[one.lock] = one.fingerprint
    notices.push({
      kind: 'lock-holder',
      message: `lock ${oneLine(one.lock, 160)} is held by pid ${one.pid}, which is no longer alive (${one.isJson ? 'its JSON pid' : 'the first number of its holder file'}); the mod leaves the lock as it is: release it with the tool that took it`,
      fields: { pid: one.pid, isJson: one.isJson },
    })
  }
  if (Object.keys(told).length > 0) state.locks = told
  else delete state.locks
  return notices
}

// ---------------------------------------------------------------- mod-drift

/**
 * mod-drift (decision win-35): the first time a set of changed files is seen (driftNoticeMessage), told once; a match
 * (`changed` empty) clears it, so the next drift is told again, as is a drift whose set of files changes. `changed`
 * undefined (a folder could not be read) tells nothing and changes nothing.
 */
export function driftStep(state: NoticeState, changed: readonly string[] | undefined, message: string): Notice[] {
  if (changed === undefined) return []
  if (changed.length === 0) {
    delete state.drift
    return []
  }
  const key = changed.join('\n')
  if (state.drift === key) return []
  state.drift = key
  return [{ kind: 'mod-drift', message, fields: { changed: changed.length } }]
}
