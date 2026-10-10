// The host interface: every operation of the mod that differs per operating system or needs a process, behind one
// type with two adapters, host-posix.ts (Linux and WSL) and host-windows.ts (native Windows). register.tsx picks the
// adapter once per load with selectHost and never branches on the platform itself.
//
// An adapter never holds `$`: the validator follows `$` only into functions of register.tsx itself, never across an
// import. register.tsx hands each operation a HostPort instead, the engine facilities it may use, built over the
// hook's own `$`. What pure TypeScript and `$.fs` do alike on both systems lives in host-shared.ts.

import type { FsStat, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { SessionEntry } from '../types'
import type { LaunchArgs, LaunchFacts, ProcFact, ProcFacts } from './core'
import type { HelperNote } from './host-helper'
import { posixHost } from './host-posix'
import { windowsHost } from './host-windows'

/** The environment variables an adapter reads, each by a literal name in register.tsx. */
export type HostEnvName = 'HOME' | 'USERPROFILE' | 'SystemRoot'

/** The engine facilities an adapter uses, over one hook's `$`. */
export type HostPort = {
  /** `$.process.run`; traced unless `isQuiet` (the command as `shown` gives it, else its argv). */
  run(argv: readonly string[], init?: ProcessRunInit, isQuiet?: boolean, shown?: Record<string, unknown>): Promise<ProcessRunResult>
  /** `$.fs.read`: rejects when the file is missing or over the read cap. */
  read(path: string): Promise<string>
  /** `$.fs.write` (which makes the directories); traced unless `isQuiet`. */
  write(path: string, text: string, isQuiet?: boolean): Promise<void>
  /** `$.fs.exists`. */
  exists(path: string): Promise<boolean>
  /** `$.fs.stat`. */
  stat(path: string): Promise<FsStat>
  /** `$.clock.now`, epoch milliseconds. */
  now(): Promise<number>
  /** `$.clock.sleep`. */
  sleep(ms: number): Promise<void>
  /** `$.env.get` of one of the names an adapter reads. */
  env(name: HostEnvName): Promise<string | undefined>
  /** The runs directory of the settings, in the adapter's own path form. */
  runsDir(): Promise<string>
  /** A caught error, traced with where it was caught. */
  traceError(where: string, err: unknown): void
  /** Tells the user, once per load, that a file was written over directly instead of through a rename. */
  noteDirectWrite(text: string): void
  /** The Node helper's detection (traced once) and each fallback to the adapter's own operation (traced, toasted once per load). */
  noteHelper(note: HelperNote): void
}

/** What a launch looks for among the probe's claude processes. */
export type WorkerWant = { dir: string; configDir: string; model: string }

/** One rotation of the trace: the file, the bytes about to go in, the files kept, the size limit and the renames. */
export type RotatePlan = { path: string; adding: number; keep: number; maxBytes: number; moves: readonly (readonly [string, string])[] }

/** What filesNewerThan answers: the newest files first (at most NEWER_MAX of host-shared.ts), each with its mtime, and how many there are in all. */
export type NewerFiles = { files: { path: string; mtimeMs: number }[]; total: number }

/** The launch verdict's fields the command and the worker match read. */
export type LaunchTarget = { configDir: string; resumeSid?: string; isConfigInherited?: boolean; name: string }

export type Host = {
  /** The platform as the trace names it. */
  readonly platform: 'linux' | 'windows'

  // ---- paths
  /** The home directory, in the adapter's path form. */
  homeDir(port: HostPort): Promise<string>
  /** A path in the form the mod stores and passes on (on Linux the path as given). */
  nativePath(path: string): string
  /** The session's directory in the form the orchestrator directory is compared in. */
  sessionDir(cwd: string): string
  /** Whether the session's directory (from sessionDir) is the orchestrator directory. */
  isSameDir(cwd: string, dir: string): boolean
  /** Where a worker's transcript lives. */
  transcriptPath(entry: SessionEntry): string | undefined
  /** The config directory a launch without a picker inherits. */
  defaultConfigDir(home: string, own: string | undefined): string
  /** Whether a config directory is the default one. */
  isDefaultConfigDir(dir: string, defaultDir: string): boolean

  // ---- processes
  /** The process facts: claude processes, liveness proof of the asked pids, transcript ages (sessions files under `configDirs` too where the probe needs them). */
  probe(port: HostPort, entries: readonly SessionEntry[], configDirs?: readonly string[]): Promise<ProcFacts>
  /** The new worker a launch started, among the probe's facts; undefined while it has not appeared. */
  findNewWorker(port: HostPort, facts: ProcFacts, want: WorkerWant, known: ReadonlySet<number>, launchedAt: number): Promise<ProcFact | undefined>
  /** The config directory the probe shows for the new worker. */
  workerConfigDir(verdict: { configDir: string; isConfigInherited?: boolean }, own: string | undefined): string
  /** Waits a few seconds between discovery checks. */
  pause(port: HostPort, seconds: number): Promise<void>

  // ---- launch
  /** The launch's arguments with its paths in the stored form. */
  launchArgs(given: LaunchArgs): LaunchArgs
  /** Whether the prompt file is there and not empty, and the dir is a directory. */
  launchChecks(port: HostPort, args: LaunchArgs): Promise<{ promptFileOk: boolean; dirOk: boolean }>
  /** The platform's own facts for checkLaunch. */
  launchFacts(promptText: string | undefined): Partial<LaunchFacts>
  /** The licence picker's argv as it is run, or why it is refused. */
  pickerArgv(argv: string[]): { argv: string[] } | { refusal: string }
  /** The engine tool the worker is started through: Bash, or PowerShell on the Windows PowerShell route (host-powershell.ts). */
  readonly launchTool: 'Bash' | 'PowerShell'
  /** The command text that tool runs. */
  launchCommand(args: LaunchArgs, target: LaunchTarget, resultFile: string, errFile: string): string
  /** Said after the tool refused to start a worker ('' when there is nothing to add). */
  readonly launchToolHint: string
  /** The file the command writes the worker's pid to, read as one more fact beside the probe; undefined: it writes none. */
  launchPidFile(resultFile: string): string | undefined
  /** Why the launch route cannot start this launch, said before anything runs; undefined: it can. */
  launchRefusal(args: LaunchArgs, runsDir: string): string | undefined

  // ---- files
  /** Creates a missing file with its directory (the caller found it unreadable). */
  createFile(port: HostPort, path: string, text: string): Promise<void>
  /** Makes the backups and runs directories of a fresh environment. */
  prepareHelperDirs(port: HostPort, backupsDir: string): Promise<void>
  /** Makes the runs directory a launch redirects into. */
  prepareRunsDir(port: HostPort, runsDir: string): Promise<void>
  /** Makes a directory after an append found none; false where the append makes it itself (nothing to retry). */
  makeDir(port: HostPort, dir: string): Promise<boolean>
  /** Writes a file through a temporary sibling and a rename; with `expected`, nothing is written (false) when the file changed meanwhile. */
  writeAtomic(port: HostPort, path: string, text: string, expected?: string): Promise<boolean>
  /** Removes a file; answers whether it went. */
  removeFile(port: HostPort, path: string, isQuiet?: boolean): Promise<boolean>
  /** Puts the temporary file in the file's place. */
  renameOver(port: HostPort, tmp: string, path: string, text: string): Promise<void>
  /** Appends lines to a log without reading it; `onRan` gets the exit code; answers what went wrong. */
  append(port: HostPort, path: string, lines: readonly string[], isQuiet: boolean, onRan: (exitCode: number) => void): Promise<string | undefined>
  /** The last 600 lines of a transcript, each cut to 20000 characters; undefined when it cannot be read. */
  tail(port: HostPort, path: string): Promise<string | undefined>
  /**
   * The regular files under `dir` whose mtime is after `epochSeconds`, newest first, at most NEWER_MAX with the true
   * count: paths and mtimes only. A directory named `.git` is not entered and no symbolic link (or Windows reparse
   * point) is followed or listed. Undefined when `dir` is no directory or the listing failed.
   */
  filesNewerThan(port: HostPort, dir: string, epochSeconds: number): Promise<NewerFiles | undefined>
  /** Rotates the trace. */
  rotate(port: HostPort, plan: RotatePlan): Promise<void>
  /** The trace's write, untraced: the rotation when one is given, then the append; answers what went wrong with the append. */
  rotateAndAppend(port: HostPort, path: string, lines: readonly string[], rotation?: RotatePlan): Promise<string | undefined>
}

/** Every operation and field of Host: the contract test checks both adapters against this list. */
export const HOST_MEMBERS = [
  'platform',
  'homeDir',
  'nativePath',
  'sessionDir',
  'isSameDir',
  'transcriptPath',
  'defaultConfigDir',
  'isDefaultConfigDir',
  'probe',
  'findNewWorker',
  'workerConfigDir',
  'pause',
  'launchArgs',
  'launchChecks',
  'launchFacts',
  'pickerArgv',
  'launchTool',
  'launchCommand',
  'launchToolHint',
  'launchPidFile',
  'launchRefusal',
  'createFile',
  'prepareHelperDirs',
  'prepareRunsDir',
  'makeDir',
  'writeAtomic',
  'removeFile',
  'renameOver',
  'append',
  'tail',
  'filesNewerThan',
  'rotate',
  'rotateAndAppend',
] as const satisfies readonly (keyof Host)[]

// A member added to Host and not to the list fails to compile here.
type Unlisted = Exclude<keyof Host, (typeof HOST_MEMBERS)[number]>
const isListComplete: Unlisted extends never ? true : never = true
void isListComplete

/**
 * The one platform choice: native Windows, told by positive signs only (OS is Windows_NT and USERPROFILE a
 * drive-letter path), takes the Windows adapter; anything else, WSL included, the Linux one.
 */
export function selectHost(env: { OS?: string; USERPROFILE?: string }): Host {
  return env.OS === 'Windows_NT' && /^[A-Za-z]:[\\/]/.test(env.USERPROFILE ?? '') ? windowsHost : posixHost
}
