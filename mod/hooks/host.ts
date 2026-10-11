// The host interface: every operation of the mod that differs per operating system or needs a process, behind one
// type with two adapters, host-posix.ts (Linux and WSL) and host-windows.ts (native Windows). register.tsx picks the
// adapter once per load with selectHost and never branches on the platform itself.
//
// An adapter never holds `$`: the validator follows `$` only into functions of register.tsx itself, never across an
// import. register.tsx hands each operation a HostPort instead, the engine facilities it may use, built over the
// hook's own `$`. What pure TypeScript and `$.fs` do alike on both systems lives in host-shared.ts.

import type { FsStat, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { SessionEntry } from '../types'
import type { LaunchArgs, LaunchFacts, LaunchInput, ProcFact, ProcFacts } from './core'
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

/** How much of a transcript a tail reads: its last `lines`, each cut to `width` characters. */
export type TailShape = { lines: number; width: number }

/** What filesNewerThan answers: the newest files first (at most NEWER_MAX of host-shared.ts), each with its mtime, and how many there are in all. */
export type NewerFiles = { files: { path: string; mtimeMs: number }[]; total: number }

/**
 * What removeRegularFile came to: the file went (`removed`), was not there (`absent`), is a symbolic link or, on
 * Windows, another reparse point (`symlink`), is no regular file (`not-file`: a directory, a device), or would not go
 * (`failed`). Only `removed` and `absent` changed or found nothing; the others left the path as it was.
 */
export type RemoveOutcome = 'removed' | 'absent' | 'symlink' | 'not-file' | 'failed'

/**
 * One process of the tree stop_worker works on: its pid, its parent's pid, its start (Linux: field 22 of
 * /proc/<pid>/stat, in clock ticks; Windows: the creation time in epoch milliseconds), its state (Linux: the stat
 * state letter, `Z` a zombie; '' on Windows) and its name.
 */
export type TreeProc = { pid: number; ppid: number; start: string; state: string; comm: string }

/**
 * The tree as listed before the first signal: the root when it is still the process asked for (the same pid with the
 * same start; else undefined, with the start that pid has now, '' when it is gone), its descendants (children, their
 * children, and so on), and the pids above the listing process: this session's own process and its ancestors, which
 * are never signalled.
 */
export type ProcTree = { root?: TreeProc; rootStartNow: string; descendants: TreeProc[]; ancestors: number[] }

/** The process a stop is asked for: its pid and the start the Abort check proved. */
export type StopTarget = { pid: number; start: string }

/**
 * Where a process of a stop stands: `gone` (the pid is gone, or has another start: another process), `exited` (Linux:
 * a zombie, state Z: it has ended and runs nothing, and its /proc entry stays until its parent reaps it) or `alive`.
 */
export type StopStatus = 'gone' | 'exited' | 'alive'

/**
 * One step of a stop: a signal sent (Linux `TERM`, `KILL`; Windows `taskkill /T`, `taskkill /T /F`) with its time in
 * epoch milliseconds and the exit code of the call; a check after it with the seconds waited; or a process not
 * signalled (`gone`: no longer the process listed, or a zombie; `own`: this session's process or one of its ancestors).
 */
export type StopStep =
  | { kind: 'signal'; pid: number; signal: string; atMs: number; exitCode: number }
  | { kind: 'check'; pid: number; atMs: number; status: StopStatus; waitedSec: number }
  | { kind: 'skip'; pid: number; reason: 'gone' | 'own' }

/**
 * What a stop did: the tree listed before the first signal, the steps in order, where each process of the tree stands
 * at the end (with the state letter of one still there), and notes on how it ran (a helper call that failed and the
 * native operation that ran in its place).
 */
export type StopReport = { tree: ProcTree; steps: StopStep[]; final: { pid: number; status: StopStatus; state: string }[]; notes: string[] }

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
  /** The launch's arguments with its paths in the stored form (a path not given stays not given). */
  launchArgs<T extends LaunchInput>(given: T): T
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
  /**
   * Removes a regular file and nothing else: the path's own last component is looked at without following a link, and a
   * symbolic link, a directory or anything that is no regular file is refused (`symlink`, `not-file`) and left in place.
   * The caller has checked the path is a plain file name in the folder it may clean.
   */
  removeRegularFile(port: HostPort, path: string): Promise<RemoveOutcome>
  /** Puts the temporary file in the file's place. */
  renameOver(port: HostPort, tmp: string, path: string, text: string): Promise<void>
  /** Appends lines to a log without reading it; `onRan` gets the exit code; answers what went wrong. */
  append(port: HostPort, path: string, lines: readonly string[], isQuiet: boolean, onRan: (exitCode: number) => void): Promise<string | undefined>
  /**
   * The last 600 lines of a transcript, each cut to 20000 characters, or with `shape` its last `lines` cut to `width`
   * (the newest kept under the engine's output cap: TAIL_SHAPED_MAX_BYTES); undefined when it cannot be read.
   */
  tail(port: HostPort, path: string, shape?: TailShape): Promise<string | undefined>
  /**
   * The regular files under `dir` whose mtime is after `epochSeconds`, newest first, at most NEWER_MAX with the true
   * count: paths and mtimes only. A directory named `.git` is not entered and no symbolic link (or Windows reparse
   * point) is followed or listed. Undefined when `dir` is no directory or the listing failed.
   */
  filesNewerThan(port: HostPort, dir: string, epochSeconds: number): Promise<NewerFiles | undefined>
  /**
   * Stops a process and its descendants, and answers what it did (stop_worker). The tree is listed before the first
   * signal (unless `tree`, a listing made before, is given). Nothing is signalled when the root no longer has the start
   * asked or is this session's own process or one of its ancestors. Then the root: Linux `TERM`, re-checks every second
   * for up to STOP_WAIT_SECONDS, `KILL`, re-checks for up to 3 seconds; Windows `taskkill /T`, the same re-checks,
   * `taskkill /T /F`. Then every descendant still alive the same way. A process is signalled only while it still has
   * the start the listing found, so a pid reused meanwhile is never touched. The waits run inside the operation's own
   * processes, never on the engine's clock. Rejects when the tree cannot be listed or the stop cannot run.
   */
  stopProcessTree(port: HostPort, target: StopTarget, tree?: ProcTree): Promise<StopReport>
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
  'removeRegularFile',
  'renameOver',
  'append',
  'tail',
  'filesNewerThan',
  'stopProcessTree',
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
