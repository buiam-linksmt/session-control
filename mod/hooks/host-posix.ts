// The Linux adapter of the host interface (Linux and WSL): the paths as they are, the launch through the Bash tool, the
// launch checks with `test`, directories made with `mkdir -p`, the wait with `sleep`. The process probe, the stop of
// stop_worker and every file operation are the Node helper's (host-helper.ts, helper/linux.mjs and helper/stop.mjs).

import type { SessionEntry } from '../types'
import { findNewWorker, isDefaultConfigDir, defaultConfigDir, transcriptPath } from './core'
import type { LaunchArgs, LaunchInput, ProcFacts } from './core'
import type { HostPort, Platform, WorkerWant } from './host'
import { bashLaunchCommand } from './host-shared'
import { dirOf } from './store'

export const posixHost: Platform = {
  platform: 'linux',

  async homeDir(port: HostPort): Promise<string> {
    const home = await port.env('HOME')
    return home ?? '/root'
  },
  nativePath: (path: string) => path,
  sessionDir: (cwd: string) => cwd.replace(/\/+$/, ''),
  isSameDir: (cwd: string, dir: string) => cwd === dir.replace(/\/+$/, ''),
  transcriptPath: (entry: SessionEntry) => transcriptPath(entry),
  defaultConfigDir: (home: string, own: string | undefined) => defaultConfigDir(home, own),
  isDefaultConfigDir: (dir: string, defaultDir: string) => isDefaultConfigDir(dir, defaultDir),

  async findNewWorker(port: HostPort, facts: ProcFacts, want: WorkerWant, known: ReadonlySet<number>) {
    return findNewWorker(facts, want, known)
  },
  /** The probe reads the worker's CLAUDE_CONFIG_DIR from its environment: an inherited one is the orchestrator's own, or none. */
  workerConfigDir: (verdict: { configDir: string; isConfigInherited?: boolean }, own: string | undefined) => (verdict.isConfigInherited === true ? (own ?? '') : verdict.configDir),
  async pause(port: HostPort, seconds: number): Promise<void> {
    await port.run(['sleep', String(seconds)], { timeoutMs: 5_000 })
  },

  launchArgs: <T extends LaunchInput>(given: T): T => given,
  /** `test -s` on the prompt file and `test -d` on the dir. */
  async launchChecks(port: HostPort, args: LaunchArgs) {
    const promptCheck = await port.run(['test', '-s', args.prompt_file], { timeoutMs: 5_000 })
    const dirCheck = await port.run(['test', '-d', args.dir], { timeoutMs: 5_000 })
    return { promptFileOk: promptCheck.exitCode === 0, dirOk: dirCheck.exitCode === 0 }
  },
  launchFacts: () => ({}),
  pickerArgv: (argv: string[]) => ({ argv }),
  launchTool: 'Bash',
  launchCommand: bashLaunchCommand,
  launchToolHint: '',
  /** The Bash route's line writes no pid file. */
  launchPidFile: () => undefined,
  /** The Bash route takes any path the guards pass. */
  launchRefusal: () => undefined,

  /** `test -e`, then `mkdir -p` and the write. */
  async createFile(port: HostPort, path: string, text: string): Promise<void> {
    if ((await port.run(['test', '-e', path], { timeoutMs: 5_000 })).exitCode === 0) return
    await port.run(['mkdir', '-p', dirOf(path)], { timeoutMs: 5_000 })
    await port.write(path, text)
  },
  async prepareHelperDirs(port: HostPort, backupsDir: string): Promise<void> {
    await port.run(['mkdir', '-p', backupsDir, await port.runsDir()], { timeoutMs: 5_000 })
  },
  async prepareRunsDir(port: HostPort, runsDir: string): Promise<void> {
    await port.run(['mkdir', '-p', runsDir], { timeoutMs: 5_000 })
  },
}
