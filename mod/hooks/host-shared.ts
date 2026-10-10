// The host operations both adapters do alike: pure TypeScript and `$.fs` (through the HostPort), which work the same
// on Linux and on Windows. No `$` here, and no import of trace.ts (trace.ts names the adapters' scripts).

import type { FsStat } from 'claude-code'

import type { LaunchArgs } from './core'
import { buildLaunchArgv, tailLines } from './core'
import type { Host, HostPort, LaunchTarget, NewerFiles, RemoveOutcome, RotatePlan, TailShape } from './host'
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
