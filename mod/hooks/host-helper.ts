// The host layer: withHelper makes the Host of a platform adapter (host-posix.ts, host-windows.ts). Every file
// operation, the usage probe and, on Linux, the process probe and the stop of stop_worker run in one
// `node mod/helper/host.mjs <op>` process each, with the request as JSON on stdin. Node is looked for at the first
// operation that needs it: while none is found, or one older than HELPER_MIN_NODE, the first operation
// HELPER_REDETECT_MS or more after that lookup looks again, so installing Node needs no reload; once found it stays for
// the load. Without a usable Node every operation that reads or writes the machine rejects with NodeMissingError, whose
// message is NODE_REFUSAL: the helper's, and the adapter's own too (the launch checks, the files and directories it
// makes, and on Windows the process probe and the stop). A helper call that fails (Node cannot start, times out,
// answers what is not one JSON object, or answers ok:false) answers what the operation answers for a failure, and the
// port is told the operation and a fixed code, never a message or content. Nothing falls back to another way of doing it.

import type { ProcessRunResult } from 'claude-code'

import type { SessionEntry } from '../types'
import { parseProcFacts, probeArgs } from './core'
import type { ProcFacts } from './core'
import type { Host, HostPort, NewerFiles, Platform, ProcTree, RemoveOutcome, RotatePlan, StopReport, StopTarget, TailShape, TreeHashes, TreeSpec } from './host'
import { isUsageCode, usageAnswer } from './usage'
import type { UsageProbe } from './usage'
import { NEWER_MAX, PANE_TAIL, STOP_TIMEOUT_MS, STOP_WAIT_SECONDS, TAIL_SHAPED_MAX_BYTES, parseStopOutput, stopTargets, unstoppable } from './host-shared'

/** The helper's entry point under the plugin's directory. */
export const HELPER_SCRIPT = 'helper/host.mjs'

/** The oldest Node major version the helper runs on. */
export const HELPER_MIN_NODE = 22

/** How long after a lookup that found no usable Node the next operation looks again. */
export const HELPER_REDETECT_MS = 10 * 60_000

/** What an operation that needs Node rejects with, and a tool answers, while no usable Node is found: one fixed text. */
export const NODE_REFUSAL = 'session-control needs Node.js 22 or newer on the PATH (or the nodePath option); nothing was done'

/** The panel's warning while no usable Node is found (its line reads `! session-control: ` and this). */
export const NODE_WARNING = 'needs Node.js 22 or newer on the PATH (or the nodePath option); nothing is tracked'

/** The rejection of an operation that needs Node while none is usable; its message is NODE_REFUSAL. */
export class NodeMissingError extends Error {
  constructor() {
    super(NODE_REFUSAL)
    this.name = 'NodeMissingError'
  }
}

/** Whether an error is the rejection for a missing Node, by its fixed message. */
export const isNodeMissing = (err: unknown): boolean => err instanceof Error && err.message === NODE_REFUSAL

/** How the helper is started: the node executable and the helper's absolute path. */
export type HelperSetup = { node: string; script: string }

/** The helper's operations as its protocol names them. */
export type HelperOp = 'probe' | 'writeAtomic' | 'renameOver' | 'removeFile' | 'append' | 'tail' | 'rotate' | 'filesNewerThan' | 'hashTree' | 'processTree' | 'stopProcesses' | 'probeUsage' | 'batch'

/** One step of a batch: a file operation and its request. */
export type HelperStep = { op: Exclude<HelperOp, 'probe' | 'processTree' | 'stopProcesses' | 'probeUsage' | 'batch'> } & Record<string, unknown>

/** What a helper call came to: its answer's fields, or the fixed code it failed with. */
export type HelperAnswer = { ok: true; fields: Record<string, unknown> } | { ok: false; code: string; at?: number }

/**
 * What the port is told: Node's detection, each time its outcome changes; and each helper call that failed, with the
 * operation and the code (`isQuiet`: of an untraced operation, the trace's own write among them).
 */
export type HelperNote = { kind: 'node'; isActive: boolean; version?: string; reason?: string } | { kind: 'failed'; op: HelperOp; code: string; isQuiet: boolean }

/** The codes this side gives a failed call; the helper's own codes (protocol.mjs) pass through when well formed. */
export const CALL_CODES = ['SPAWN', 'TIMEOUT', 'BAD_JSON', 'TRUNCATED', 'BAD_ANSWER'] as const

/** How long one helper call may take: a probe or a file operation. */
const CALL_TIMEOUT_MS = 10_000

/** How long the walk of filesNewerThan and the hashing of hashTrees may take. */
const LISTING_TIMEOUT_MS = 30_000

/** How long `node --version` may take. */
const VERSION_TIMEOUT_MS = 5_000

/** How long a probeUsage call may take: the helper's own 15 s bound on claude, and Node's start. */
export const USAGE_CALL_TIMEOUT_MS = 20_000

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

/** The text an append adds: each line and a newline. */
export const appendText = (lines: readonly string[]) => lines.map(line => `${line}\n`).join('')

/** A helper's filesNewerThan answer as NewerFiles: an array of `{path, mtimeMs}` and a count, or undefined. */
export function newerAnswer(fields: Record<string, unknown>): NewerFiles | undefined {
  const { files, total } = fields
  if (!Array.isArray(files) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < files.length) return undefined
  const isFile = (one: unknown): one is { path: string; mtimeMs: number } => isRecord(one) && typeof one.path === 'string' && typeof one.mtimeMs === 'number'
  return files.every(isFile) ? { files: files.map(one => ({ path: one.path, mtimeMs: one.mtimeMs })), total } : undefined
}

/** A helper hashTree answer as TreeHashes: an array of `{path, sha256}` (64 hex digits each), or undefined. */
export function treeAnswer(fields: unknown): TreeHashes | undefined {
  if (!isRecord(fields) || !Array.isArray(fields.files)) return undefined
  const files: Record<string, string> = {}
  for (const one of fields.files) {
    if (!isRecord(one) || typeof one.path !== 'string' || typeof one.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(one.sha256)) return undefined
    files[one.path] = one.sha256
  }
  return { method: 'sha256', files }
}

/**
 * What a probeUsage call answers for: the windows of an `ok` answer, or one of the probe's own codes (NO_CLAUDE,
 * TIMEOUT, NOT_LOGGED_IN, PARSE, FAILED). A call that timed out is TIMEOUT too: claude may have run its whole time
 * already. Undefined: the helper itself failed (Node did not start, an answer that is not JSON or not the answer
 * expected, any other code).
 */
export function usageOfCall(answer: HelperAnswer): UsageProbe | undefined {
  if (answer.ok) return usageAnswer(answer.fields)
  return isUsageCode(answer.code) ? { ok: false, code: answer.code } : undefined
}

/** The rotation request of a plan. */
const rotateRequest = (plan: RotatePlan) => ({ path: plan.path, adding: plan.adding, maxBytes: plan.maxBytes, moves: plan.moves.map(([from, to]) => [from, to]) })

/**
 * The Host of a platform adapter: nodeReady, writeAtomic, renameOver, removeFile, removeRegularFile (the helper's
 * removeFile with `regularOnly`), append, tail, rotate, rotateAndAppend (one batch), filesNewerThan, hashTrees (one
 * batch) and probeUsage by the helper on both platforms; probe and stopProcessTree by the helper on Linux and by the
 * adapter's own PowerShell scripts on Windows; launchChecks, createFile, prepareHelperDirs and prepareRunsDir the
 * adapter's own. Each of those runs only once Node is found. Every other member (the paths, the launch's text, the
 * worker match, the wait) is the adapter's own and needs no Node.
 */
export function withHelper(base: Platform, setup: HelperSetup): Host {
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
   * Whether Node is there: the first operation looks for it; while none (or an old one) was found, the first operation
   * HELPER_REDETECT_MS after the last lookup looks again. Operations at the same time share one lookup.
   */
  async function isReady(port: HostPort): Promise<boolean> {
    const current = ready
    if (current === undefined) return (ready = detect(port))
    if (await current) return true
    const now = await port.now()
    if (ready === current && now - checkedAt >= HELPER_REDETECT_MS) ready = detect(port)
    return ready ?? current
  }

  /** Rejects with NodeMissingError while no usable Node is found. */
  async function requireNode(port: HostPort): Promise<void> {
    if (!(await isReady(port))) throw new NodeMissingError()
  }

  /** One helper call; the trace shows the operation and the given fields, never the request. */
  async function call(port: HostPort, op: HelperOp, request: Record<string, unknown>, isQuiet: boolean, shown: Record<string, unknown>, timeoutMs: number): Promise<HelperAnswer> {
    try {
      const ran = await port.run([setup.node, setup.script, op], { stdin: JSON.stringify(request), timeoutMs }, isQuiet, { helper: op, ...shown })
      return readAnswer(ran)
    } catch (err) {
      return { ok: false, code: rejectionCode(err) }
    }
  }

  /** A call that failed, told to the port with its operation and code (an answer that was not the one expected: BAD_ANSWER); answers the code. */
  function failed(port: HostPort, op: HelperOp, answer: HelperAnswer, isQuiet = false): string {
    const code = answer.ok ? 'BAD_ANSWER' : answer.code
    port.noteHelper({ kind: 'failed', op, code, isQuiet })
    return code
  }

  /**
   * An operation through the helper: Node first (NodeMissingError without it), then one call. `use` reads the answer's
   * fields (undefined: not the answer expected); a call that failed is told to the port and answered by `onFailure`
   * with its code. `timeoutMs` bounds the call (CALL_TIMEOUT_MS unless given).
   */
  async function through<T>(
    port: HostPort,
    op: HelperOp,
    request: Record<string, unknown>,
    isQuiet: boolean,
    shown: Record<string, unknown>,
    use: (fields: Record<string, unknown>) => T | undefined,
    onFailure: (code: string) => T,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    await requireNode(port)
    const answer = await call(port, op, request, isQuiet, shown, timeoutMs)
    const value = answer.ok ? use(answer.fields) : undefined
    return value !== undefined ? value : onFailure(failed(port, op, answer, isQuiet))
  }

  /** One of the adapter's own operations, run only once Node is found. */
  const gated =
    <A extends unknown[], R>(work: (port: HostPort, ...args: A) => Promise<R>) =>
    async (port: HostPort, ...args: A): Promise<R> => {
      await requireNode(port)
      return work(port, ...args)
    }

  /** Linux: the helper's probe of /proc. A call that failed is an error: read as no process at all it would mark every worker dead. */
  async function helperProbe(port: HostPort, entries: readonly SessionEntry[]): Promise<ProcFacts> {
    const args = probeArgs(entries)
    return through(
      port,
      'probe',
      { args },
      false,
      { args: args.length },
      fields => (typeof fields.out === 'string' ? parseProcFacts(fields.out) : undefined),
      code => {
        throw new Error(`the process probe failed (${code})`)
      },
    )
  }

  /**
   * Linux: the tree by the helper's processTree (unless `tree` is given), then the stop by its stopProcesses over that
   * listing. A listing that fails rejects: nothing was signalled. A stop that fails rejects too, and what it signalled
   * before it failed is not in any record; the caller's Abort check afterwards says what is true.
   */
  async function helperStop(port: HostPort, target: StopTarget, tree?: ProcTree): Promise<StopReport> {
    await requireNode(port)
    let listing = tree
    if (listing === undefined) {
      const answer = await call(port, 'processTree', { pid: target.pid, start: target.start }, false, { pid: target.pid }, CALL_TIMEOUT_MS)
      const parsed = answer.ok && typeof answer.fields.out === 'string' ? parseStopOutput(answer.fields.out) : undefined
      if (parsed === undefined || !parsed.isListed) throw new Error(`the process tree could not be listed (${failed(port, 'processTree', answer)}); nothing was signalled`)
      listing = parsed.tree
    }
    const early = unstoppable(listing, target)
    if (early !== undefined) return early
    const targets = stopTargets(listing)
    const answer = await call(port, 'stopProcesses', { wait: STOP_WAIT_SECONDS, targets }, false, { pid: target.pid, targets: targets.length }, STOP_TIMEOUT_MS)
    if (answer.ok && typeof answer.fields.out === 'string') {
      const { isListed, ...done } = parseStopOutput(answer.fields.out, { tree: listing })
      return done
    }
    throw new Error(`the helper's stop failed (${failed(port, 'stopProcesses', answer)}); what it signalled before that is not known`)
  }

  const { probe: ownProbe, stopProcessTree: ownStop, ...own } = base

  return {
    ...own,

    nodeReady: (port: HostPort) => isReady(port),
    launchChecks: gated(base.launchChecks),
    createFile: gated(base.createFile),
    prepareHelperDirs: gated(base.prepareHelperDirs),
    prepareRunsDir: gated(base.prepareRunsDir),
    probe: ownProbe === undefined ? helperProbe : gated(ownProbe),
    stopProcessTree: ownStop === undefined ? helperStop : gated(ownStop),

    async writeAtomic(port: HostPort, path: string, text: string, expected?: string): Promise<boolean> {
      const request = expected === undefined ? { path, text } : { path, text, expected }
      return through(
        port,
        'writeAtomic',
        request,
        false,
        { path },
        fields => (typeof fields.written === 'boolean' ? fields.written : undefined),
        code => {
          throw new Error(`${path} could not be written (${code})`)
        },
      )
    },

    async renameOver(port: HostPort, tmp: string, path: string): Promise<void> {
      await through(
        port,
        'renameOver',
        { from: tmp, to: path },
        false,
        { path },
        () => true as const,
        code => {
          throw new Error(`${path} could not be replaced (${code})`)
        },
      )
    },

    /** A file that is not there counts as gone; a call that failed answers false. */
    async removeFile(port: HostPort, path: string, isQuiet = false): Promise<boolean> {
      return through(
        port,
        'removeFile',
        { path },
        isQuiet,
        { path },
        fields => (typeof fields.removed === 'boolean' ? true : undefined),
        () => false,
      )
    },

    /** A regular file only: the helper refuses a link and a non-file with a fixed code (IS_LINK, NOT_FILE), which is the answer. */
    async removeRegularFile(port: HostPort, path: string): Promise<RemoveOutcome> {
      await requireNode(port)
      const answer = await call(port, 'removeFile', { path, regularOnly: true }, false, { path, regularOnly: true }, CALL_TIMEOUT_MS)
      if (answer.ok && typeof answer.fields.removed === 'boolean') return answer.fields.removed ? 'removed' : 'absent'
      if (!answer.ok && answer.code === 'IS_LINK') return 'symlink'
      if (!answer.ok && answer.code === 'NOT_FILE') return 'not-file'
      failed(port, 'removeFile', answer)
      return 'failed'
    },

    async append(port: HostPort, path: string, lines: readonly string[], isQuiet: boolean, onRan: (exitCode: number) => void): Promise<string | undefined> {
      const done = await through<{ problem: string | undefined }>(
        port,
        'append',
        { path, text: appendText(lines) },
        isQuiet,
        { path },
        fields => (typeof fields.bytes === 'number' ? { problem: undefined } : undefined),
        code => ({ problem: `${path} cannot be appended to (${code})` }),
      )
      if (done.problem === undefined) onRan(0)
      return done.problem
    },

    /** A shaped tail asks the helper to keep TAIL_SHAPED_MAX_BYTES at most, the newest lines. */
    async tail(port: HostPort, path: string, shape?: TailShape): Promise<string | undefined> {
      const { lines, width } = shape ?? PANE_TAIL
      const request = shape === undefined ? { path, lines, width } : { path, lines, width, maxBytes: TAIL_SHAPED_MAX_BYTES }
      const found = await through<{ text: string | undefined }>(
        port,
        'tail',
        request,
        false,
        { path },
        fields => (typeof fields.text === 'string' ? { text: fields.text } : undefined),
        () => ({ text: undefined }),
      )
      return found.text
    },

    /** The walk in one Node process. */
    async filesNewerThan(port: HostPort, dir: string, epochSeconds: number): Promise<NewerFiles | undefined> {
      const done = await through<{ found: NewerFiles | undefined }>(
        port,
        'filesNewerThan',
        { dir, since: Math.floor(epochSeconds), max: NEWER_MAX },
        false,
        { path: dir },
        fields => {
          const found = newerAnswer(fields)
          return found === undefined ? undefined : { found }
        },
        () => ({ found: undefined }),
        LISTING_TIMEOUT_MS,
      )
      return done.found
    },

    /** Every root hashed by the helper's hashTree in one batch (one process, SHA-256 over the bytes). */
    async hashTrees(port: HostPort, roots: readonly string[], spec: TreeSpec): Promise<TreeHashes[] | undefined> {
      await requireNode(port)
      const steps = roots.map(root => ({ op: 'hashTree', root, dirs: [...spec.dirs], files: [...spec.files] }))
      const answer = await call(port, 'batch', { ops: steps }, false, { ops: steps.map(step => step.op), roots: roots.length }, LISTING_TIMEOUT_MS)
      const trees = answer.ok && Array.isArray(answer.fields.results) && answer.fields.results.length === roots.length ? answer.fields.results.map(treeAnswer) : undefined
      if (trees !== undefined && trees.every((one): one is TreeHashes => one !== undefined)) return trees
      failed(port, 'hashTree', answer)
      return undefined
    },

    /**
     * The usage probe in one helper process (claude.exe from the PATH on Windows, without a shell). The probe's own codes
     * are the answer (usageOfCall); a failure of the helper itself is FAILED.
     */
    async probeUsage(port: HostPort, configDir: string, isInherited: boolean): Promise<UsageProbe> {
      await requireNode(port)
      const request = isInherited ? { configDir, isInherited: true } : { configDir }
      const answer = await call(port, 'probeUsage', request, false, { configDir, isInherited }, USAGE_CALL_TIMEOUT_MS)
      const probed = usageOfCall(answer)
      if (probed !== undefined) return probed
      failed(port, 'probeUsage', answer)
      return { ok: false, code: 'FAILED' }
    },

    /** The helper's rotation, which checks the size again itself; untraced (the trace is what it rotates). */
    async rotate(port: HostPort, plan: RotatePlan): Promise<void> {
      await through(
        port,
        'rotate',
        rotateRequest(plan),
        true,
        { path: plan.path },
        fields => (typeof fields.rotated === 'boolean' ? true : undefined),
        code => {
          throw new Error(`the trace could not be rotated (${code})`)
        },
      )
    },

    /** The trace's write: with a rotation, one batch (the rotation, then the append) in one process; untraced. */
    async rotateAndAppend(port: HostPort, path: string, lines: readonly string[], rotation?: RotatePlan): Promise<string | undefined> {
      const appendStep = { op: 'append', path, text: appendText(lines) } as const
      const steps: HelperStep[] = rotation === undefined ? [appendStep] : [{ op: 'rotate', ...rotateRequest(rotation) }, appendStep]
      const done = await through<{ problem: string | undefined }>(
        port,
        'batch',
        { ops: steps },
        true,
        { ops: steps.map(step => step.op), path },
        fields => (Array.isArray(fields.results) && fields.results.length === steps.length ? { problem: undefined } : undefined),
        code => ({ problem: `${path} cannot be appended to (${code})` }),
      )
      return done.problem
    },
  }
}
