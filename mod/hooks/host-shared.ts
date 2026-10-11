// The host operations both adapters do alike: pure TypeScript and `$.fs` (through the HostPort), which work the same
// on Linux and on Windows. No `$` here, and no import of trace.ts (trace.ts names the adapters' scripts).

import type { FsStat } from 'claude-code'

import type { LaunchArgs } from './core'
import { buildLaunchArgv, tailLines } from './core'
import type { Host, HostPort, LaunchTarget, NewerFiles, ProcTree, RemoveOutcome, RotatePlan, StopReport, StopStatus, StopStep, StopTarget, TailShape, TreeHashes, TreeProc, TreeSpec } from './host'
import { tmpPath } from './store'

/**
 * Write a file through a temporary sibling and a rename, so a reader never sees half a file. When `expected` is
 * given the file is read again just before the rename: if another writer changed it meanwhile nothing is
 * written and false is returned.
 */
export async function writeAtomicWith(host: Pick<Host, 'removeFile' | 'renameOver'>, port: HostPort, path: string, text: string, expected?: string): Promise<boolean> {
  const tmp = tmpPath(path, await port.now())
  await port.write(tmp, text)
  if (expected !== undefined && (await port.read(path).catch(() => undefined)) !== expected) {
    await host.removeFile(port, tmp)
    return false
  }
  await host.renameOver(port, tmp, path, text)
  return true
}

/**
 * What the native scripts that remove a regular file (REMOVE_REGULAR_SCRIPT, the `removeregular` operation of
 * FILES_PS1) exit with: 0 removed, 3 not there, 4 a link, 5 no regular file; anything else is a failure.
 */
export function removeOutcomeOfExit(exitCode: number): RemoveOutcome {
  return exitCode === 0 ? 'removed' : exitCode === 3 ? 'absent' : exitCode === 4 ? 'symlink' : exitCode === 5 ? 'not-file' : 'failed'
}

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

/** The last lines of a file $.fs can read whole, as `tail -n <count> | cut -c1-<width>` prints them; undefined when it cannot. */
export async function readTail(port: HostPort, path: string, count: number, width: number): Promise<string | undefined> {
  const text = await port.read(path).catch(() => undefined)
  return text === undefined ? undefined : tailLines(text, count, width)
}

/** The trace's write: the rotation when one is given, then a quiet append. */
export async function rotateAndAppendWith(host: Pick<Host, 'rotate' | 'append'>, port: HostPort, path: string, lines: readonly string[], rotation?: RotatePlan): Promise<string | undefined> {
  if (rotation !== undefined) await host.rotate(port, rotation)
  return host.append(port, path, lines, true, () => undefined)
}

/** Waits on the engine's clock. */
export async function clockPause(port: HostPort, seconds: number): Promise<void> {
  await port.sleep(seconds * 1000)
}

/** The command the Bash tool runs for a launch: bash on Linux, Git Bash on Windows, the same text. */
export function bashLaunchCommand(args: LaunchArgs, target: LaunchTarget, resultFile: string, errFile: string): string {
  return buildLaunchArgv(args, target, resultFile, errFile)[2] ?? ''
}

/** The transcript tail of the log pane: its last 600 lines, each cut to 20000 characters. */
export const PANE_TAIL: TailShape = { lines: 600, width: 20000 }

/** A tail with a shape of its own keeps at most this many bytes, the newest, under the engine's 4 MiB output cap. */
export const TAIL_SHAPED_MAX_BYTES = 3 * 1024 * 1024

/** The most paths filesNewerThan answers; `total` counts them all. */
export const NEWER_MAX = 200

/** `1791667060.8924861740` as whole milliseconds, read from the digits (no floating-point rounding). */
const secondsToMs = (text: string) => {
  const [whole = '0', fraction = ''] = text.split('.')
  return Number(whole) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3))
}

/**
 * What NEWER_SCRIPT (Linux) and NEWER_PS1 (Windows) print, read back: one `<mtime in seconds, with a fraction>\t<path>`
 * line per file, newest first, then `N\t<count of all>`. Undefined without that last line (the listing did not end).
 * `toPath` turns a printed path into the stored form.
 */
export function parseNewerListing(stdout: string, toPath: (path: string) => string = path => path): NewerFiles | undefined {
  const files: NewerFiles['files'] = []
  let total: number | undefined
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const head = line.slice(0, tab)
    const rest = line.slice(tab + 1)
    if (head === 'N' && /^\d+$/.test(rest)) total = Number(rest)
    else if (/^\d+(\.\d+)?$/.test(head) && rest !== '') files.push({ path: toPath(rest), mtimeMs: secondsToMs(head) })
  }
  return total === undefined ? undefined : { files, total: Math.max(total, files.length) }
}

/** How long a stop waits after the first signal, in one-second re-checks, before the second (KILL, taskkill /F). */
export const STOP_WAIT_SECONDS = 10

/** How long a stop may run in one process: the root's wait and the descendants' wait, each with the re-checks after KILL. */
export const STOP_TIMEOUT_MS = 45_000

/**
 * What the tree listing and the stop print (TREE_SCRIPT and STOP_SCRIPT on Linux, the helper's processTree and
 * stopProcesses, TREE_PS1 on Windows), one tab-separated line each:
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

/** The listing of a tree as TREE_SCRIPT reads it: the tree, or an error when no R or N line came (the listing failed). */
export function treeOf(stdout: string): ProcTree {
  const parsed = parseStopOutput(stdout)
  if (!parsed.isListed) throw new Error('the process tree could not be listed')
  return parsed.tree
}

/** The stop's targets as the scripts and the helper take them, `<pid>:<start>`: the root first, then its descendants. */
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

// ---------------------------------------------------------------- hashTrees, natively

/** The most files hashTrees hashes under one root (the helper's TREE_MAX_FILES). */
export const TREE_MAX_FILES = 500

/**
 * cyrb53, a 53-bit string hash (two 32-bit multiply-xor lanes folded together), over a text's UTF-16 code units, as 14
 * hex digits: the native fallback's digest. Stable across runs and machines; not cryptographic, which a check of
 * whether two copies of the mod differ does not need.
 */
export function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

const joinRel = (root: string, rel: string) => `${root.replace(/[\\/]+$/, '')}/${rel}`

/** One root, natively: undefined when it is no directory, holds too many files or a file cannot be read. */
async function nativeTree(port: HostPort, root: string, spec: TreeSpec): Promise<Record<string, string> | undefined> {
  const top = await port.stat(root).catch(() => undefined)
  if (top?.kind !== 'dir') return undefined
  const found: string[] = []
  for (const dir of spec.dirs) {
    // The folder itself is looked at without following a link: a linked folder is passed over.
    const own = await port.stat(joinRel(root, dir)).catch(() => undefined)
    if (own === undefined || own.isLink || own.kind !== 'dir') continue
    const entries = await port.list(joinRel(root, dir)).catch(() => undefined)
    if (entries === undefined) return undefined
    for (const entry of entries) if (entry.kind === 'file' && !entry.isLink) found.push(`${dir}/${entry.name}`)
  }
  for (const file of spec.files) {
    const own = await port.stat(joinRel(root, file)).catch(() => undefined)
    if (own !== undefined && !own.isLink && own.kind === 'file') found.push(file)
  }
  const unique = [...new Set(found)].sort()
  if (unique.length > TREE_MAX_FILES) return undefined
  const files: Record<string, string> = {}
  for (const rel of unique) {
    const text = await port.read(joinRel(root, rel)).catch(() => undefined)
    if (text === undefined) return undefined
    files[rel] = cyrb53(text)
  }
  return files
}

/** hashTrees through `$.fs` alone (list, stat, read), on both systems: cyrb53 over each file's text. */
export async function nativeHashTrees(port: HostPort, roots: readonly string[], spec: TreeSpec): Promise<TreeHashes[] | undefined> {
  const trees: TreeHashes[] = []
  for (const root of roots) {
    const files = await nativeTree(port, root, spec)
    if (files === undefined) return undefined
    trees.push({ method: 'cyrb53', files })
  }
  return trees
}
