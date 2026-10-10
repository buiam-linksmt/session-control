// The host operations both adapters do alike: pure TypeScript and `$.fs` (through the HostPort), which work the same
// on Linux and on Windows. No `$` here, and no import of trace.ts (trace.ts names the adapters' scripts).

import type { FsStat } from 'claude-code'

import type { LaunchArgs } from './core'
import { buildLaunchArgv, tailLines } from './core'
import type { Host, HostPort, LaunchTarget } from './host'
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

/** Waits on the engine's clock. */
export async function clockPause(port: HostPort, seconds: number): Promise<void> {
  await port.sleep(seconds * 1000)
}

/** The command the Bash tool runs for a launch: bash on Linux, Git Bash on Windows, the same text. */
export function bashLaunchCommand(args: LaunchArgs, target: LaunchTarget, resultFile: string, errFile: string): string {
  return buildLaunchArgv(args, target, resultFile, errFile)[2] ?? ''
}
