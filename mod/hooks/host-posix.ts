// The Linux adapter of the host interface (Linux and WSL): the probe of /proc, files moved, removed, appended to and
// tailed with sh, mv, rm and tail, directories made with mkdir, the wait with sleep. Its scripts, run through
// `sh -c`, came here unchanged from core.ts and trace.ts. trace.ts imports them to name them: this file never imports
// trace.ts.

import type { SessionEntry } from '../types'
import { findNewWorker, isDefaultConfigDir, defaultConfigDir, parseProcFacts, probeArgs, transcriptPath } from './core'
import type { LaunchArgs, LaunchInput, ProcFacts } from './core'
import type { Host, HostPort, NewerFiles, RotatePlan, TailShape, WorkerWant } from './host'
import { NEWER_MAX, TAIL_SHAPED_MAX_BYTES, bashLaunchCommand, parseNewerListing, rotateAndAppendWith, writeAtomicWith } from './host-shared'
import { dirOf } from './store'

/**
 * The one shell probe run through `$.process.run(['sh', '-c', PROBE_SCRIPT,
 * 'session-probe', ...probeArgs(entries)])`. Prints tab-separated lines:
 *   P <pid> <comm> <elapsedSec> <cwd> <CLAUDE_CONFIG_DIR> <cmdline>
 *   A <pid> <comm> <statStart> <fileProcStart> <fileSessionId>   for each asked pid that exists
 *   T <sid> <mtimeEpochSec>       newest transcript of an asked session
 */
export const PROBE_SCRIPT = [
  'up=$(cut -d. -f1 /proc/uptime 2>/dev/null)',
  'hz=$(getconf CLK_TCK 2>/dev/null)',
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  '  read -r c 2>/dev/null < "$d/comm" || continue',
  '  [ "$c" = claude ] || continue',
  '  cmd=$(tr "\\000\\t\\n" "   " < "$d/cmdline" 2>/dev/null)',
  '  cwd=$(readlink "$d/cwd" 2>/dev/null)',
  '  cfg=$(tr "\\000" "\\n" < "$d/environ" 2>/dev/null | sed -n "s/^CLAUDE_CONFIG_DIR=//p" | head -n 1)',
  '  stt=$(sed "s/^.*) //" "$d/stat" 2>/dev/null | cut -d" " -f20)',
  '  et=""; [ -n "$stt" ] && [ -n "$up" ] && [ -n "$hz" ] && et=$((up - stt / hz))',
  '  printf "P\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$c" "$et" "$cwd" "$cfg" "$cmd"',
  'done',
  'for a in "$@"; do',
  '  case "$a" in',
  '    pid:*) r=${a#pid:}; p=${r%%|*}; r=${r#*|}; c=${r%%|*}; [ -d "/proc/$p" ] || continue',
  '      st=$(sed "s/^.*) //" "/proc/$p/stat" 2>/dev/null | cut -d" " -f20)',
  '      fs=$(jq -r ".procStart // empty" "$c/sessions/$p.json" 2>/dev/null)',
  '      fi=$(jq -r ".sessionId // empty" "$c/sessions/$p.json" 2>/dev/null)',
  '      printf "A\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$p" "$(cat "/proc/$p/comm" 2>/dev/null)" "$st" "$fs" "$fi";;',
  '    t:*) r=${a#t:}; s=${r%%|*}; c=${r#*|}',
  '      f=$(ls -t "$c"/projects/*/"$s".jsonl 2>/dev/null | head -n 1)',
  '      [ -n "$f" ] && printf "T\\t%s\\t%s\\n" "$s" "$(stat -c %Y "$f")";;',
  '  esac',
  'done',
  'exit 0',
].join('\n')

/** Appends a text and a newline to a log, as CLEAR_SCRIPT appended the cleared entries: args are the text and the log path. */
export const APPEND_SCRIPT = `printf '%s\\n' "$1" >> "$2"`

/**
 * The rotation on Linux, one process: args are the trace path, the number of the oldest file kept, the size limit and
 * the bytes about to go in. The size is read here, right before the renames, so of several processes sharing the
 * trace only the first to find it too big rotates it; the others find it small or gone and leave it. Each older file
 * moves one up (the oldest is overwritten; a move another process made first is no failure), then the trace becomes
 * .1: the exit code is that move's, and a trace another process moved meanwhile is no failure either.
 */
export const ROTATE_SCRIPT = String.raw`L=$1; i=$2; max=$3; add=$4
{ size=$(wc -c < "$L"); } 2>/dev/null || exit 0
[ $((size)) -gt 0 ] && [ $((size + add)) -gt "$max" ] || exit 0
while [ "$i" -gt 1 ]; do p=$((i - 1)); [ -f "$L.$p" ] && mv -f "$L.$p" "$L.$i" 2>/dev/null; i=$p; done
mv -f "$L" "$L.1" 2>/dev/null || [ ! -e "$L" ]`

/**
 * The files under a directory written after a time, read-only: args are the directory, the epoch seconds and the most
 * lines to print. `find -newermt @<seconds>` lists the regular files newer than that second (a symbolic link is no
 * regular file, and find does not follow one), never entering a `.git`; newest first, the first `max` printed as
 * `<mtime>\t<path>`, then `N\t<count of all>`. A path holding a line break is left out (it would split its line).
 * Exit 3 when the directory is not there.
 */
export const NEWER_SCRIPT = String.raw`d=$1; t=$2; max=$3
[ -d "$d" ] || exit 3
export LC_ALL=C
nl='
'
find "$d" -name .git -prune -o -type f ! -path "*$nl*" -newermt "@$t" -printf '%T@\t%p\n' 2>/dev/null |
  sort -t "$(printf '\t')" -k1,1nr -k2,2 | awk -v max="$max" 'NR <= max { print } END { printf "N\t%d\n", NR }'`

/**
 * A tail with a shape of its own: args are the file, the lines, the width and the most bytes kept, the newest (the
 * first line kept may then be cut at its start).
 */
export const TAIL_SHAPED_SCRIPT = 'tail -n "$2" "$1" | cut -c1-"$3" | tail -c "$4"'

/** Removes a file with `rm -f`; it counts as gone. */
async function removeFile(port: HostPort, path: string, isQuiet = false): Promise<boolean> {
  await port.run(['rm', '-f', path], { timeoutMs: 5_000 }, isQuiet)
  return true
}

/** Puts the temp file in the file's place with `mv -f`. */
async function renameOver(port: HostPort, tmp: string, path: string): Promise<void> {
  const ran = await port.run(['mv', '-f', tmp, path], { timeoutMs: 5_000 })
  if (ran.exitCode !== 0) throw new Error(`rename failed (exit ${ran.exitCode}): ${ran.stderr.slice(0, 100)}`)
}

export const posixHost: Host = {
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

  /** The process facts: PROBE_SCRIPT under sh, which reads /proc (no sessions-file search needed). */
  async probe(port: HostPort, entries: readonly SessionEntry[]): Promise<ProcFacts> {
    const ran = await port.run(['sh', '-c', PROBE_SCRIPT, 'session-probe', ...probeArgs(entries)], {
      timeoutMs: 10_000,
    })
    return parseProcFacts(ran.stdout)
  },
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
  /** Outside the orchestrator directory nothing may have made the runs directory yet: `mkdir -p`, untraced. */
  async makeDir(port: HostPort, dir: string): Promise<boolean> {
    await port.run(['mkdir', '-p', dir], { timeoutMs: 5_000 }, true)
    return true
  },
  writeAtomic: (port: HostPort, path: string, text: string, expected?: string) => writeAtomicWith(posixHost, port, path, text, expected),
  removeFile,
  renameOver,
  /** APPEND_SCRIPT, which never reads the log, so a log of any size takes the lines. */
  async append(port: HostPort, path: string, lines: readonly string[], isQuiet: boolean, onRan: (exitCode: number) => void) {
    const ran = await port.run(['sh', '-c', APPEND_SCRIPT, 'session-log', lines.join('\n'), path], { timeoutMs: 10_000 }, isQuiet)
    onRan(ran.exitCode)
    return ran.exitCode === 0 ? undefined : `${path} cannot be appended to (exit ${ran.exitCode}): ${ran.stderr.slice(0, 100)}`
  },
  /** tail and cut, so one huge tool result cannot push the newest rows out; a shaped tail keeps the newest bytes. */
  async tail(port: HostPort, path: string, shape?: TailShape): Promise<string | undefined> {
    const argv =
      shape === undefined
        ? ['sh', '-c', 'tail -n 600 "$1" | cut -c1-20000', 'session-tail', path]
        : ['sh', '-c', TAIL_SHAPED_SCRIPT, 'session-tail', path, String(shape.lines), String(shape.width), String(TAIL_SHAPED_MAX_BYTES)]
    const ran = await port.run(argv, { timeoutMs: shape === undefined ? 5_000 : 15_000 })
    return ran.exitCode === 0 ? ran.stdout : undefined
  },
  /** NEWER_SCRIPT under sh: find, sort and awk, nothing written. */
  async filesNewerThan(port: HostPort, dir: string, epochSeconds: number): Promise<NewerFiles | undefined> {
    const ran = await port.run(['sh', '-c', NEWER_SCRIPT, 'session-newer', dir, String(Math.floor(epochSeconds)), String(NEWER_MAX)], { timeoutMs: 30_000 })
    return ran.exitCode === 0 && !ran.isStdoutTruncated ? parseNewerListing(ran.stdout) : undefined
  },
  /** ROTATE_SCRIPT, which checks the size again itself; untraced (the trace is what it rotates). */
  async rotate(port: HostPort, plan: RotatePlan): Promise<void> {
    const argv = ['sh', '-c', ROTATE_SCRIPT, 'session-trace', plan.path, String(plan.keep - 1), String(plan.maxBytes), String(plan.adding)]
    const ran = await port.run(argv, { timeoutMs: 10_000 }, true)
    if (ran.exitCode !== 0) throw new Error(`rotation failed (exit ${ran.exitCode}): ${ran.stderr.slice(0, 100)}`)
  },
  rotateAndAppend: (port: HostPort, path: string, lines: readonly string[], rotation?: RotatePlan) => rotateAndAppendWith(posixHost, port, path, lines, rotation),
}
