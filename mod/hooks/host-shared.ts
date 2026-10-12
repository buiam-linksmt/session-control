// What both adapters and the helper layer share: pure TypeScript and `$.fs` (through the HostPort), which work the same
// on Linux and on Windows: the launch command, the launch checks and file creation through `$.fs`, the constants of the
// helper's requests, and the reading of a process tree and a stop. No `$` here.

import type { FsStat } from 'claude-code'

import type { LaunchArgs } from './core'
import { buildLaunchArgv } from './core'
import type { HostPort, LaunchTarget, ProcTree, StopReport, StopStatus, StopStep, StopTarget, TailShape, TreeProc } from './host'

/** Writes a file that is not there ($.fs.write makes the directories); a file that is there but cannot be read is left alone. */
export async function writeIfAbsent(port: HostPort, path: string, text: string): Promise<void> {
  if (!(await port.exists(path).catch(() => true))) await port.write(path, text)
}

/** Whether the prompt file is there and not empty, and the dir is a directory, by $.fs.stat. */
export async function statLaunchChecks(port: HostPort, args: LaunchArgs): Promise<{ promptFileOk: boolean; dirOk: boolean }> {
  const prompt: FsStat | undefined = await port.stat(args.prompt_file).catch(() => undefined)
  const dir: FsStat | undefined = await port.stat(args.dir).catch(() => undefined)
  return { promptFileOk: prompt?.kind === 'file' && prompt.size > 0, dirOk: dir?.kind === 'dir' }
}

/** The command the Bash tool runs for a launch: bash on Linux, Git Bash on Windows, the same text. */
export function bashLaunchCommand(args: LaunchArgs, target: LaunchTarget, resultFile: string, errFile: string): string {
  return buildLaunchArgv(args, target, resultFile, errFile)[2] ?? ''
}

/** The transcript tail of the log pane: its last 600 lines, each cut to 20000 characters. */
export const PANE_TAIL: TailShape = { lines: 600, width: 20000 }

/** A tail with a shape of its own keeps at most this many bytes, the newest, under the engine's 4 MiB output cap (the helper's maxBytes). */
export const TAIL_SHAPED_MAX_BYTES = 3 * 1024 * 1024

/** The most paths filesNewerThan answers; `total` counts them all. */
export const NEWER_MAX = 200

/** How long a stop on Linux waits after TERM, in one-second re-checks, before KILL (Windows sends no gentle signal first: host-windows.ts). */
export const STOP_WAIT_SECONDS = 10

/** How long a stop may run in one process: the root's wait and the descendants' wait, each with the re-checks after KILL. */
export const STOP_TIMEOUT_MS = 45_000

/**
 * What the tree listing and the stop print (the helper's processTree and stopProcesses on Linux, TREE_PS1 on Windows),
 * one tab-separated line each:
 *   R <pid> <ppid> <start> <state> <name>   the root, still the process asked for
 *   N <pid> <start now>                     the root is not (gone: no start; or another start: a reused pid)
 *   D <pid> <ppid> <start> <state> <name>   a descendant
 *   G <pid>                                 an ancestor of the listing process (this session's own chain)
 *   S <pid> <signal> <epoch ms> <exit code> a signal sent
 *   C <pid> <epoch ms> <gone|exited|alive> <seconds waited>   a check after it (exited: a zombie, Linux)
 *   X <pid> <gone|own>                      not signalled
 *   F <pid> <gone|exited|alive> <state>     the end state
 * Into `report` when given (its tree kept unless the text lists one); `isListed` says whether an R or N line came.
 */
export function parseStopOutput(stdout: string, report?: Pick<StopReport, 'tree'>): StopReport & { isListed: boolean } {
  const tree: ProcTree = report?.tree ?? { rootStartNow: '', descendants: [], ancestors: [] }
  const out: StopReport & { isListed: boolean } = { tree, steps: [], final: [], notes: [], isListed: false }
  const proc = (cols: string[]): TreeProc | undefined => {
    const pid = Number(cols[1])
    const ppid = Number(cols[2])
    return Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && /^\d+$/.test(cols[3] ?? '') ? { pid, ppid, start: cols[3] ?? '', state: (cols[4] ?? '').trim(), comm: cols.slice(5).join(' ').trim() } : undefined
  }
  const statusOf = (text: string | undefined): StopStatus => (text === 'alive' ? 'alive' : text === 'exited' ? 'exited' : 'gone')
  const pidOf = (text: string | undefined) => {
    const pid = Number(text)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  }
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    const cols = line.split('\t')
    const tag = cols[0]
    const pid = pidOf(cols[1])
    if (pid === undefined) continue
    if (tag === 'R') {
      const root = proc(cols)
      if (root !== undefined) {
        out.tree = { ...out.tree, root, rootStartNow: root.start, descendants: [], ancestors: [] }
        out.isListed = true
      }
    } else if (tag === 'N') {
      out.tree = { rootStartNow: /^\d+$/.test(cols[2] ?? '') ? (cols[2] ?? '') : '', descendants: [], ancestors: [] }
      out.isListed = true
    } else if (tag === 'D') {
      const one = proc(cols)
      if (one !== undefined) out.tree.descendants.push(one)
    } else if (tag === 'G') out.tree.ancestors.push(pid)
    else if (tag === 'S') {
      const atMs = Number(cols[3])
      const exitCode = Number(cols[4])
      out.steps.push({ kind: 'signal', pid, signal: cols[2] ?? '', atMs: Number.isFinite(atMs) ? atMs : 0, exitCode: Number.isInteger(exitCode) ? exitCode : -1 })
    } else if (tag === 'C') {
      const atMs = Number(cols[2])
      const waited = Number(cols[4])
      out.steps.push({ kind: 'check', pid, atMs: Number.isFinite(atMs) ? atMs : 0, status: statusOf(cols[3]), waitedSec: Number.isFinite(waited) ? waited : 0 })
    } else if (tag === 'X' && (cols[2] === 'gone' || cols[2] === 'own')) out.steps.push({ kind: 'skip', pid, reason: cols[2] })
    else if (tag === 'F') out.final.push({ pid, status: statusOf(cols[2]), state: (cols[3] ?? '').trim() })
  }
  return out
}

/** The listing of a tree as TREE_PS1 prints it: the tree, or an error when no R or N line came (the listing failed). */
export function treeOf(stdout: string): ProcTree {
  const parsed = parseStopOutput(stdout)
  if (!parsed.isListed) throw new Error('the process tree could not be listed')
  return parsed.tree
}

/** The stop's targets as the helper's stopProcesses takes them, `<pid>:<start>`: the root first, then its descendants. */
export function stopTargets(tree: ProcTree): string[] {
  return [...(tree.root === undefined ? [] : [tree.root]), ...tree.descendants].map(one => `${one.pid}:${one.start}`)
}

/**
 * The answer of a stop that signals nothing: the root is no longer the process asked for (gone, or its pid reused), or
 * it is this session's own process or one of its ancestors. Undefined when the stop may go on.
 */
export function unstoppable(tree: ProcTree, target: StopTarget): StopReport | undefined {
  const step = (reason: 'gone' | 'own'): StopStep => ({ kind: 'skip', pid: target.pid, reason })
  if (tree.root === undefined || tree.root.pid !== target.pid || tree.root.start !== target.start) return { tree, steps: [step('gone')], final: [{ pid: target.pid, status: 'gone', state: '' }], notes: [] }
  if (tree.ancestors.includes(target.pid)) return { tree, steps: [step('own')], final: [{ pid: target.pid, status: 'alive', state: tree.root.state }], notes: [] }
  return undefined
}
