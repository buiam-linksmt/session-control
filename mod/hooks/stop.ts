// Pure parts of stop_worker: its schema, the Abort check of CLAUDE.md step 6 as words, and the proof the tool answers.
// No `$`, no I/O: register.tsx reads the registry and the probe, runs the host's stopProcessTree and the Abort check
// again, and hands the facts here. Free text (a title, a process name, the reason given) goes through `clean`, as the
// inspection tools' answers do; a session id of the UUID form is shown as it is.

import type { SessionEntry } from '../types'
import type { ProcFacts } from './core'
import type { StopReport, StopStatus, TreeProc } from './host'
import { clean, shownName, shownSessionId } from './inspect'

export const STOP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['session_id'],
  properties: {
    session_id: {
      type: 'string',
      minLength: 8,
      maxLength: 36,
      pattern: '^[0-9a-fA-F-]+$',
      description: 'Session id of a registry entry whose worker is alive: the full id, or its first 8 characters.',
    },
    reason: { type: 'string', maxLength: 500, description: 'Why the worker is stopped: repeated in the answer, never written to the debug trace.' },
  },
} as const

/** The Abort check of one entry: whether its recorded pid is its live process, and why, in words. */
export type AbortCheck = { isAlive: boolean; text: string }

/**
 * The Abort check (CLAUDE.md step 6, isPidAlive of core.ts) of an entry against the probe's facts, in words: alive only
 * when the sessions file of the pid names the entry's session and its start is the process's own (Linux: procStart
 * equals field 22 of /proc/<pid>/stat; Windows: the file's startedAt falls in PROBE_PS1's window around the creation
 * time, which the probe answers as the creation time in both columns).
 */
export function abortCheck(entry: SessionEntry, facts: ProcFacts, isWindows: boolean): AbortCheck {
  const pid = entry.pid
  if (typeof pid !== 'number') return { isAlive: false, text: 'not alive: the entry records no pid' }
  const file = `${typeof entry.config_dir === 'string' && entry.config_dir !== '' ? clean(entry.config_dir).replace(/\s+/g, ' ') : '<config_dir>'}/sessions/${pid}.json`
  const proof = facts.pidProof.get(pid)
  if (proof === undefined) return { isAlive: false, text: isWindows ? `dead: no process has pid ${pid}` : `dead: pid ${pid} is gone (no /proc/${pid})` }
  const startName = isWindows ? 'its creation time' : `/proc/${pid}/stat field 22`
  if (proof.startTicks === '') return { isAlive: false, text: `not verifiable: the start of pid ${pid} could not be read; counted as not alive` }
  if (proof.fileStart === '') return { isAlive: false, text: `not verifiable: ${file} gives no ${isWindows ? 'startedAt' : 'procStart'} (missing or unreadable); counted as not alive, a pid that may be another process` }
  if (proof.fileStart !== proof.startTicks) {
    const said = isWindows ? `${file} has startedAt ${proof.fileStart}, outside the window of the process creation time ${proof.startTicks} ms` : `${file} has procStart ${proof.fileStart}, ${startName} is ${proof.startTicks}`
    return { isAlive: false, text: `dead or a reused pid: ${said}` }
  }
  if (typeof entry.session_id === 'string' && proof.fileSid !== entry.session_id) return { isAlive: false, text: `not this session: ${file} names session ${shownSessionId(proof.fileSid || '(none)')}` }
  const matched = isWindows ? `its startedAt matches the process creation time ${proof.startTicks} ms` : `procStart ${proof.fileStart}, and ${startName} is ${proof.startTicks}`
  return { isAlive: true, text: `alive: ${file} names session ${shownSessionId(String(entry.session_id))} with ${matched}` }
}

/** A free text on one line, cut to `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = clean(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A process of the tree named for the proof: its pid and name. */
const named = (proc: TreeProc | undefined, pid: number) => (proc === undefined || proc.comm === '' ? `${pid}` : `${pid} (${oneLine(proc.comm, 40)})`)

/** A signal as the proof names it. */
const signalName = (signal: string, pid: number) => (signal === 'TERM' || signal === 'KILL' ? `SIG${signal}` : signal.startsWith('taskkill') ? `taskkill /PID ${pid}${signal.slice('taskkill'.length)}` : oneLine(signal, 40))

/** Where a process stands, in words. */
const statusText = (status: StopStatus) => (status === 'gone' ? 'gone' : status === 'exited' ? 'exited (a zombie: it runs nothing; its /proc entry stays until its parent reaps it)' : 'still alive')

/** What the proof is made of: the entry, the reason given, the Abort check before and after, and the stop's report or why it did not complete. */
export type StopProof = {
  entry: SessionEntry
  reason?: string
  before: AbortCheck
  report?: StopReport
  failure?: string
  after: AbortCheck
  isWindows: boolean
}

/**
 * The answer of stop_worker: the pid and session, the Abort check before, the descendants listed before the first
 * signal, each signal with its time and each re-check, the descendants at the end, the Abort check after and the
 * result, any survivor said plainly; the registry is left to the exit notification and the probe.
 */
export function stopProofText(proof: StopProof): string {
  const { entry, report, before, after } = proof
  const pid = Number(entry.pid)
  const title = typeof entry.title === 'string' ? oneLine(entry.title, 120) : '(untitled)'
  const name = typeof entry.name === 'string' && entry.name !== '' ? `, name ${shownName(entry.name)}` : ''
  const lines = [`stop_worker: session ${shownSessionId(String(entry.session_id))} "${title}"${name}, pid ${pid}.`]
  if (proof.reason !== undefined && proof.reason.trim() !== '') lines.push(`Reason given: ${oneLine(proof.reason, 500)}`)
  lines.push(`Abort check before: ${before.text}.`)
  const tree = report?.tree
  const byPid = new Map<number, TreeProc>([...(tree?.root === undefined ? [] : [tree.root]), ...(tree?.descendants ?? [])].map(one => [one.pid, one]))
  if (tree === undefined) lines.push('Descendants listed before the first signal: unknown (the tree could not be listed).')
  else if (tree.descendants.length === 0) lines.push('Descendants listed before the first signal: none.')
  else lines.push(`Descendants listed before the first signal (${tree.descendants.length}): ${tree.descendants.map(one => `${named(one, one.pid)}, ${one.state === 'msys' ? 'MSYS parent' : 'parent'} ${one.ppid}`).join('; ')}.`)
  const steps = report?.steps ?? []
  const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : 'time unknown')
  if (steps.length > 0) {
    lines.push('Signals and re-checks:')
    for (const step of steps) {
      if (step.kind === 'signal') lines.push(`- ${iso(step.atMs)} ${signalName(step.signal, step.pid)} to ${named(byPid.get(step.pid), step.pid)}: exit code ${step.exitCode}${step.exitCode === 0 ? '' : ' (not delivered, or refused)'}`)
      else if (step.kind === 'check') lines.push(`- ${iso(step.atMs)} re-check of ${step.pid} after ${step.waitedSec} s: ${statusText(step.status)}`)
      else lines.push(`- not signalled: ${named(byPid.get(step.pid), step.pid)}: ${step.reason === 'own' ? "this session's own process or one of its ancestors" : 'no longer the process listed (gone, its pid reused, or a zombie)'}`)
    }
  } else if (report !== undefined) lines.push('Signals: none were sent.')
  if (proof.failure !== undefined) lines.push(`The stop did not complete: ${oneLine(proof.failure, 300)}. What follows is what the checks found afterwards.`)
  for (const note of report?.notes ?? []) lines.push(`Note: ${oneLine(note, 400)}.`)
  const final = new Map((report?.final ?? []).map(one => [one.pid, one]))
  const descendants = tree?.descendants ?? []
  if (descendants.length > 0) {
    const at = descendants.map(one => {
      const end = final.get(one.pid)
      return `${named(one, one.pid)} ${end === undefined ? 'unknown (the stop did not report it)' : statusText(end.status)}`
    })
    lines.push(`Descendants at the end: ${at.join('; ')}.`)
  }
  lines.push(`Abort check after: ${after.text}.`)
  const rootEnd = final.get(pid)
  if (!after.isAlive) lines.push(`Result: pid ${pid} is dead: the Abort check fails after the stop (the pid is gone or has another start).`)
  else if (rootEnd?.status === 'exited') {
    lines.push(`Result: pid ${pid} has exited but is not yet dead by the Abort check: it is a zombie (state Z) that runs nothing, and its /proc entry and start stay until its parent reaps it; run stop_worker or worker_tail again shortly to see it gone.`)
  } else lines.push(`Result: pid ${pid} is STILL ALIVE after the stop: it is a live worker; report it as running, never as stopped.`)
  const survivors = descendants.filter(one => final.get(one.pid)?.status === 'alive')
  lines.push(survivors.length === 0 ? 'Surviving descendants: none.' : `Surviving descendants: ${survivors.map(one => `${named(one, one.pid)} still alive`).join('; ')}: live processes of the worker's tree.`)
  lines.push('The registry is unchanged: the exit notification and the probe record the outcome, as for any death.')
  return lines.join('\n')
}
