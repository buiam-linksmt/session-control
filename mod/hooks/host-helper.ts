// The Node.js helper behind the host interface: withHelper wraps an adapter so that its file operations (and on Linux
// the process probe) run in one `node mod/helper/host.mjs <op>` process each, with the request as JSON on stdin. Node
// is looked for at the first operation that needs it: none, or one older than HELPER_MIN_NODE, leaves the adapter's
// own operations in place, and the first operation HELPER_REDETECT_MS or more after that lookup looks again, so
// installing Node needs no reload; once found it stays for the load. A call that fails (Node cannot start, times out,
// answers what is not one JSON object or answers ok:false) falls back to the adapter's own operation for that call,
// and the port is told the operation and a fixed code, never a message or content; an append that timed out is the
// exception (appendNotRepeated).

import type { ProcessRunResult } from 'claude-code'

import type { SessionEntry } from '../types'
import { parseProcFacts, probeArgs } from './core'
import type { ProcFacts } from './core'
import type { Host, HostPort, RotatePlan } from './host'
import { readTail } from './host-shared'

/** The helper's entry point under the plugin's directory. */
export const HELPER_SCRIPT = 'helper/host.mjs'

/** The oldest Node major version the helper runs on. */
export const HELPER_MIN_NODE = 22

/** How long after a lookup that found no usable Node the next helper operation looks again. */
export const HELPER_REDETECT_MS = 10 * 60_000

/** How the helper is started: the node executable and the helper's absolute path. */
export type HelperSetup = { node: string; script: string }

/** The helper's operations as its protocol names them. */
export type HelperOp = 'probe' | 'writeAtomic' | 'renameOver' | 'removeFile' | 'append' | 'tail' | 'rotate' | 'batch'

/** One step of a batch: a file operation and its request. */
export type HelperStep = { op: Exclude<HelperOp, 'probe' | 'batch'> } & Record<string, unknown>

/** What a helper call came to: its answer's fields, or the fixed code it failed with. */
export type HelperAnswer = { ok: true; fields: Record<string, unknown> } | { ok: false; code: string; at?: number }

/**
 * What the port is told: Node's detection, each time its outcome changes; and each fallback (`isQuiet`: of an untraced
 * operation, the trace's own write among them; `isRepeated` false: an append that timed out, not made again).
 */
export type HelperNote =
  | { kind: 'node'; isActive: boolean; version?: string; reason?: string }
  | { kind: 'fallback'; op: HelperOp; code: string; isQuiet: boolean; isRepeated?: false }

/** The codes this side gives a failed call; the helper's own codes (protocol.mjs) pass through when well formed. */
export const CALL_CODES = ['SPAWN', 'TIMEOUT', 'BAD_JSON', 'TRUNCATED', 'BAD_ANSWER'] as const

/** How long one helper call may take: a probe or a file operation. */
const CALL_TIMEOUT_MS = 10_000

/** How long `node --version` may take. */
const VERSION_TIMEOUT_MS = 5_000

/** The lines and width of a transcript tail (as the adapters' tail). */
const TAIL = { lines: 600, width: 20000 } as const

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A helper code as it may pass on: capitals and underscores only, else BAD_ANSWER. */
const passCode = (code: unknown) => (typeof code === 'string' && /^[A-Z][A-Z_]{1,31}$/.test(code) ? code : 'BAD_ANSWER')

/** The major version `node --version` prints (`v24.14.0`), or undefined. */
export function nodeMajor(stdout: string): number | undefined {
  const found = /^v(\d+)\.\d+\.\d+/.exec(stdout.trim())
  return found === null ? undefined : Number(found[1])
}

/** The code of a call `$.process.run` rejected: it ran too long, or it could not start. */
export function rejectionCode(err: unknown): 'TIMEOUT' | 'SPAWN' {
  return /timed? ?out|timeout/i.test(err instanceof Error ? err.message : String(err)) ? 'TIMEOUT' : 'SPAWN'
}

/** Reads one helper answer: one JSON object on a stdout that was not cut, `ok:true` with exit code 0, or `ok:false` with its code. */
export function readAnswer(ran: ProcessRunResult): HelperAnswer {
  if (ran.isStdoutTruncated) return { ok: false, code: 'TRUNCATED' }
  let parsed: unknown
  try {
    parsed = JSON.parse(ran.stdout)
  } catch {
    return { ok: false, code: 'BAD_JSON' }
  }
  if (!isRecord(parsed)) return { ok: false, code: 'BAD_JSON' }
  if (parsed.ok === true) return ran.exitCode === 0 ? { ok: true, fields: parsed } : { ok: false, code: 'BAD_ANSWER' }
  if (parsed.ok !== false) return { ok: false, code: 'BAD_ANSWER' }
  return typeof parsed.at === 'number' ? { ok: false, code: passCode(parsed.code), at: parsed.at } : { ok: false, code: passCode(parsed.code) }
}

/** The text an append adds: each line and a newline (APPEND_SCRIPT's `printf '%s\n'` of the lines joined by newlines). */
export const appendText = (lines: readonly string[]) => lines.map(line => `${line}\n`).join('')

/**
 * Whether a failed call that appended (an append, or the trace's batch) is left as it is: after a TIMEOUT the helper
 * may have written the lines already, and the adapter's own append would write them a second time. Every other
 * failure (Node did not start, an exit code with no answer, an answer that is not JSON, ok:false) means nothing was
 * written, and the adapter appends. The lines may then be missing from the log; they are never in it twice.
 */
export const appendNotRepeated = (failed: { code: string }) => failed.code === 'TIMEOUT'

/** A fallback's trace fields: the operation and the code, and `isRepeated` false for an append that was not made again. */
export function fallbackFields(note: HelperNote & { kind: 'fallback' }): Record<string, unknown> {
  return note.isRepeated === false ? { op: note.op, code: note.code, isRepeated: false } : { op: note.op, code: note.code }
}

/** A fallback's toast text. */
export function fallbackToast(note: HelperNote & { kind: 'fallback' }): string {
  return `helper fallback: ${note.op}${note.isRepeated === false ? ' (timed out, not repeated)' : ''}`
}

/** The rotation request of a plan. */
const rotateRequest = (plan: RotatePlan) => ({ path: plan.path, adding: plan.adding, maxBytes: plan.maxBytes, moves: plan.moves.map(([from, to]) => [from, to]) })

/**
 * The adapter with its listed operations run by the helper: probe (Linux only: on Windows the process rows stay on
 * PROBE_PS1), writeAtomic, renameOver, removeFile, append, tail, rotate and rotateAndAppend (one batch). Every other
 * member is the adapter's own.
 */
export function withHelper(base: Host, setup: HelperSetup): Host {
  let ready: Promise<boolean> | undefined
  /** When the last lookup started (the port's clock), and what the port was last told of Node. */
  let checkedAt = 0
  let toldNode: string | undefined

  /** Tells the port Node's state when it differs from what it was last told: one note per change, not per lookup. */
  function noteNode(port: HostPort, note: HelperNote & { kind: 'node' }): void {
    const told = JSON.stringify(note)
    if (told === toldNode) return
    toldNode = told
    port.noteHelper(note)
  }

  /** Node, looked for: `node --version`, untraced, accepted from HELPER_MIN_NODE on. */
  async function detect(port: HostPort): Promise<boolean> {
    checkedAt = await port.now()
    let ran: ProcessRunResult
    try {
      ran = await port.run([setup.node, '--version'], { timeoutMs: VERSION_TIMEOUT_MS }, true)
    } catch (err) {
      noteNode(port, { kind: 'node', isActive: false, reason: rejectionCode(err) === 'TIMEOUT' ? 'timeout' : 'not-found' })
      return false
    }
    const major = ran.exitCode === 0 ? nodeMajor(ran.stdout) : undefined
    if (major === undefined) {
      noteNode(port, { kind: 'node', isActive: false, reason: ran.exitCode === 0 ? 'version-unreadable' : `exit-${ran.exitCode}` })
      return false
    }
    const version = ran.stdout.trim()
    const isActive = major >= HELPER_MIN_NODE
    noteNode(port, isActive ? { kind: 'node', isActive, version } : { kind: 'node', isActive, version, reason: 'too-old' })
    return isActive
  }

  /**
   * Whether the helper is there: the first operation looks for Node; while none (or an old one) was found, the first
   * operation HELPER_REDETECT_MS after the last lookup looks again. Operations at the same time share one lookup.
   */
  async function isReady(port: HostPort): Promise<boolean> {
    const current = ready
    if (current === undefined) return (ready = detect(port))
    if (await current) return true
    const now = await port.now()
    if (ready === current && now - checkedAt >= HELPER_REDETECT_MS) ready = detect(port)
    return ready ?? current
  }

  /** One helper call; the trace shows the operation and the given fields, never the request. */
  async function call(port: HostPort, op: HelperOp, request: Record<string, unknown>, isQuiet: boolean, shown: Record<string, unknown>): Promise<HelperAnswer> {
    try {
      const ran = await port.run([setup.node, setup.script, op], { stdin: JSON.stringify(request), timeoutMs: CALL_TIMEOUT_MS }, isQuiet, { helper: op, ...shown })
      return readAnswer(ran)
    } catch (err) {
      return { ok: false, code: rejectionCode(err) }
    }
  }

  /**
   * An operation through the helper: `use` reads the answer's fields (undefined: not the answer expected), `fallback`
   * is the adapter's own operation, run when Node is missing or the call fails; a failed call is told to the port.
   * `unrepeated`, for a call that appends, is what a failure appendNotRepeated leaves in place of the fallback.
   */
  async function through<T>(
    port: HostPort,
    op: HelperOp,
    request: Record<string, unknown>,
    isQuiet: boolean,
    shown: Record<string, unknown>,
    use: (fields: Record<string, unknown>) => T | undefined,
    fallback: (failed: HelperAnswer & { ok: false }) => Promise<T>,
    unrepeated?: T,
  ): Promise<T> {
    if (!(await isReady(port))) return fallback({ ok: false, code: 'NO_NODE' })
    const answer = await call(port, op, request, isQuiet, shown)
    const value = answer.ok ? use(answer.fields) : undefined
    if (value !== undefined) return value
    const failed = answer.ok ? ({ ok: false, code: 'BAD_ANSWER' } as const) : answer
    if (unrepeated !== undefined && appendNotRepeated(failed)) {
      port.noteHelper({ kind: 'fallback', op, code: failed.code, isQuiet, isRepeated: false })
      return unrepeated
    }
    port.noteHelper({ kind: 'fallback', op, code: failed.code, isQuiet })
    return fallback(failed)
  }

  const isProbed = base.platform === 'linux'

  return {
    ...base,

    async probe(port: HostPort, entries: readonly SessionEntry[], configDirs: readonly string[] = []): Promise<ProcFacts> {
      if (!isProbed) return base.probe(port, entries, configDirs)
      const args = probeArgs(entries)
      return through(
        port,
        'probe',
        { args },
        false,
        { args: args.length },
        fields => (typeof fields.out === 'string' ? parseProcFacts(fields.out) : undefined),
        () => base.probe(port, entries, configDirs),
      )
    },

    async writeAtomic(port: HostPort, path: string, text: string, expected?: string): Promise<boolean> {
      const request = expected === undefined ? { path, text } : { path, text, expected }
      return through(
        port,
        'writeAtomic',
        request,
        false,
        { path },
        fields => (typeof fields.written === 'boolean' ? fields.written : undefined),
        () => base.writeAtomic(port, path, text, expected),
      )
    },

    async renameOver(port: HostPort, tmp: string, path: string, text: string): Promise<void> {
      return through(
        port,
        'renameOver',
        { from: tmp, to: path },
        false,
        { path },
        () => true as const,
        () => base.renameOver(port, tmp, path, text),
      ).then(() => undefined)
    },

    async removeFile(port: HostPort, path: string, isQuiet = false): Promise<boolean> {
      return through(
        port,
        'removeFile',
        { path },
        isQuiet,
        { path },
        fields => (typeof fields.removed === 'boolean' ? true : undefined),
        () => base.removeFile(port, path, isQuiet),
      )
    },

    async append(port: HostPort, path: string, lines: readonly string[], isQuiet: boolean, onRan: (exitCode: number) => void): Promise<string | undefined> {
      const appended = await through(
        port,
        'append',
        { path, text: appendText(lines) },
        isQuiet,
        { path },
        fields => (typeof fields.bytes === 'number' ? { problem: undefined, isFallback: false } : undefined),
        async () => ({ problem: await base.append(port, path, lines, isQuiet, onRan), isFallback: true }),
        // Timed out: the lines may be in the log already. Not repeated, no exit code to give, nothing for the caller
        // to retry.
        { problem: undefined, isFallback: true },
      )
      if (!appended.isFallback) onRan(0)
      return appended.problem
    },

    /** On Windows a transcript under the read cap is read and cut in the engine first, as the adapter does: no process. */
    async tail(port: HostPort, path: string): Promise<string | undefined> {
      if (base.platform === 'windows') {
        const read = await readTail(port, path, TAIL.lines, TAIL.width)
        if (read !== undefined) return read
      }
      return through(
        port,
        'tail',
        { path, lines: TAIL.lines, width: TAIL.width },
        false,
        { path },
        fields => (typeof fields.text === 'string' ? { text: fields.text } : undefined),
        async () => ({ text: await base.tail(port, path) }),
      ).then(found => found.text)
    },

    async rotate(port: HostPort, plan: RotatePlan): Promise<void> {
      return through(
        port,
        'rotate',
        rotateRequest(plan),
        true,
        { path: plan.path },
        fields => (typeof fields.rotated === 'boolean' ? true : undefined),
        () => base.rotate(port, plan).then(() => true),
      ).then(() => undefined)
    },

    /**
     * The trace's write: with a rotation, one batch (the rotation, then the append) in one process. A batch that failed
     * after its rotation went through falls back to the append alone, so the rotation is never made twice.
     */
    async rotateAndAppend(port: HostPort, path: string, lines: readonly string[], rotation?: RotatePlan): Promise<string | undefined> {
      const appendStep = { op: 'append', path, text: appendText(lines) } as const
      const steps: HelperStep[] = rotation === undefined ? [appendStep] : [{ op: 'rotate', ...rotateRequest(rotation) }, appendStep]
      return through(
        port,
        'batch',
        { ops: steps },
        true,
        { ops: steps.map(step => step.op), path },
        fields => (Array.isArray(fields.results) && fields.results.length === steps.length ? { problem: undefined } : undefined),
        async failed => ({
          problem: await (rotation !== undefined && failed.at !== undefined && failed.at >= 1 ? base.rotateAndAppend(port, path, lines) : base.rotateAndAppend(port, path, lines, rotation)),
        }),
        // A batch that timed out may have rotated and appended already: neither is made again (appendNotRepeated).
        { problem: undefined },
      ).then(done => done.problem)
    },
  }
}
