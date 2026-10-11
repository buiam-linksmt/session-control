// The Windows adapter of the host interface (native Windows: Claude Code on Windows, Git Bash as the Bash tool's
// shell, which has no sh, jq, mv or /proc on the PATH a command starts with). The process probe and the process tree of
// stop_worker, which the Node helper does not do on Windows, are Windows PowerShell 5.1 scripts (PROBE_PS1, TREE_PS1),
// written to the runs directory and run with -File, and the stop's signals are taskkill.exe; the file operations are
// the helper's (host-helper.ts). Paths are kept in the native C:/... form and compared as Windows compares them.

import type { SessionEntry } from '../types'
import { defaultConfigDir, findNewWindowsWorker, isDefaultConfigDir, isSameWinPath, isWinAbsolute, parseProcFacts, probeArgs, transcriptPath, windowsPickerRefusal, winPath } from './core'
import type { LaunchInput, ProcFacts } from './core'
import type { HostPort, Platform, ProcTree, StopReport, StopStep, StopTarget, WorkerWant } from './host'
import { STOP_WAIT_SECONDS, bashLaunchCommand, clockPause, parseStopOutput, statLaunchChecks, treeOf, unstoppable, writeIfAbsent } from './host-shared'

/**
 * How far a sessions file's `startedAt` may sit from its process's creation for the pid to count as that process,
 * in milliseconds: a little before (clock granularity), and after by however long the engine takes to start (2 to
 * 6 s seen on Linux, once 257 s). Only the lower bound guards against a reused pid: a process created after the file
 * was written cannot be the one that wrote it, and none created before it can share the pid while the writer lives.
 */
export const START_MATCH_MS = { before: 2_000, after: 600_000 } as const

/**
 * The process probe for native Windows (Windows PowerShell 5.1), written to the runs directory and run with -File (never
 * as -Command text, whose quoting does not survive). It prints the lines the helper's Linux probe prints
 * (helper/linux.mjs), so parseProcFacts and isPidAlive read them unchanged:
 *   P <pid> claude <elapsedSec> <cwd> <configDir> <cmdline>   per claude.exe (Win32_Process)
 *   A <pid> <name> <creationMs> <fileStart> <fileSessionId>   per asked pid that exists
 *   T <sid> <mtimeEpochSec>                                   newest transcript of an asked session
 * Win32_Process has no cwd and no environment, so cwd and config dir come from the engine's own
 * <config dir>/sessions/<pid>.json, looked for in the asked config dirs, the `c:<dir>` arguments and
 * %USERPROFILE%\.claude. A file counts for a process when its `pid` (if any) is the pid and its `startedAt` (epoch ms)
 * is within START_MATCH_MS of the creation time; the A line then carries the creation time in both start columns,
 * else the file's own value, which isPidAlive reads as not alive. No file: no cwd, no config dir, not alive.
 */
export const PROBE_PS1 = [
  '# session-control: the process probe for Windows PowerShell 5.1 (the P, A and T lines of the Linux probe)',
  '$env:PSModulePath = "$PSHOME\\Modules"',
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  "$name = 'claude.exe'",
  // START_MATCH_MS
  '$before = 2000',
  '$after = 600000',
  '$epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)',
  '$dirs = New-Object System.Collections.Generic.List[string]',
  'function Add-Dir([string]$dir) { if ($dir -ne \'\' -and $dir -ne \'~\' -and -not $dirs.Contains($dir)) { $dirs.Add($dir) } }',
  'function Flat($text) { if ($null -eq $text) { return \'\' } return ([string]$text -replace "[`t`r`n]", \' \') }',
  'function Ms([DateTime]$at) { return [long][Math]::Floor(($at.ToUniversalTime() - $epoch).TotalMilliseconds) }',
  '# The sessions file of a pid under a config dir, or $null when there is none to read.',
  'function Session([string]$dir, [long]$id) {',
  '  $file = "$dir\\sessions\\$id.json"',
  '  if ($dir -eq \'~\' -or -not [System.IO.File]::Exists($file)) { return $null }',
  '  try { return ([System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) } catch { return $null }',
  '}',
  '# Whether a sessions file was written by the process created at $ms.',
  'function IsSame($file, [long]$id, [long]$ms) {',
  '  if ($null -eq $file -or $null -eq $file.startedAt) { return $false }',
  '  if ($null -ne $file.pid -and [long]$file.pid -ne $id) { return $false }',
  '  $gap = [long]$file.startedAt - $ms',
  '  return ($gap -ge -$before -and $gap -le $after)',
  '}',
  '$asked = @()',
  '$sessions = @()',
  'foreach ($arg in $args) {',
  "  if ($arg.StartsWith('pid:')) {",
  '    $rest = $arg.Substring(4); $cut = $rest.IndexOf(\'|\')',
  '    $id = if ($cut -lt 0) { $rest } else { $rest.Substring(0, $cut) }',
  '    $dir = if ($cut -lt 0) { $rest } else { $rest.Substring($cut + 1) }',
  '    if ($dir.IndexOf(\'|\') -ge 0) { $dir = $dir.Substring(0, $dir.IndexOf(\'|\')) }',
  '    $n = 0L',
  '    if ([long]::TryParse($id, [ref]$n)) { $asked += ,@($n, $dir); Add-Dir $dir }',
  "  } elseif ($arg.StartsWith('t:')) {",
  '    $rest = $arg.Substring(2); $cut = $rest.IndexOf(\'|\')',
  '    $sid = if ($cut -lt 0) { $rest } else { $rest.Substring(0, $cut) }',
  '    $dir = if ($cut -lt 0) { $rest } else { $rest.Substring($cut + 1) }',
  '    $sessions += ,@($sid, $dir); Add-Dir $dir',
  "  } elseif ($arg.StartsWith('c:')) { Add-Dir $arg.Substring(2) }",
  '}',
  'if ($env:USERPROFILE) { Add-Dir "$env:USERPROFILE\\.claude" }',
  'try {',
  '  $filter = "Name=\'$name\'"',
  '  foreach ($one in $asked) { $filter += " OR ProcessId=$($one[0])" }',
  '  $procs = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -Property ProcessId, Name, CreationDate, CommandLine)',
  '  $now = [DateTime]::UtcNow',
  '  $out = New-Object System.Text.StringBuilder',
  '  $byPid = @{}',
  '  foreach ($proc in $procs) { $byPid[[long]$proc.ProcessId] = $proc }',
  '  foreach ($proc in $procs) {',
  '    if ($proc.Name -ne $name -or $null -eq $proc.CreationDate) { continue }',
  '    $id = [long]$proc.ProcessId; $ms = Ms $proc.CreationDate',
  '    $elapsed = [long][Math]::Floor(($now - $proc.CreationDate.ToUniversalTime()).TotalSeconds)',
  '    $cwd = \'\'; $cfg = \'\'',
  '    foreach ($dir in $dirs) {',
  '      $file = Session $dir $id',
  '      if (IsSame $file $id $ms) { $cwd = Flat $file.cwd; $cfg = Flat $dir; break }',
  '    }',
  '    [void]$out.Append("P`t$id`tclaude`t$elapsed`t$cwd`t$cfg`t$(Flat $proc.CommandLine)`n")',
  '  }',
  '  foreach ($one in $asked) {',
  '    $proc = $byPid[[long]$one[0]]',
  '    if ($null -eq $proc) { continue }',
  '    $id = [long]$one[0]',
  '    $comm = $proc.Name -replace \'\\.exe$\', \'\'',
  '    if ($null -eq $proc.CreationDate) { [void]$out.Append("A`t$id`t$comm`t`t`t`n"); continue }',
  '    $ms = Ms $proc.CreationDate',
  '    $file = Session $one[1] $id',
  '    $start = \'\'; $sid = \'\'',
  '    if ($null -ne $file) {',
  '      if ($null -ne $file.sessionId) { $sid = Flat $file.sessionId }',
  '      if (IsSame $file $id $ms) { $start = "$ms" } elseif ($null -ne $file.startedAt) { $start = Flat $file.startedAt }',
  '    }',
  '    [void]$out.Append("A`t$id`t$comm`t$ms`t$start`t$sid`n")',
  '  }',
  '  foreach ($one in $sessions) {',
  '    $projects = "$($one[1])\\projects"',
  '    if ($one[1] -eq \'~\' -or -not [System.IO.Directory]::Exists($projects)) { continue }',
  '    $newest = $null',
  '    foreach ($dir in [System.IO.Directory]::GetDirectories($projects)) {',
  '      $path = "$dir\\$($one[0]).jsonl"',
  '      if ([System.IO.File]::Exists($path)) {',
  '        $at = [System.IO.File]::GetLastWriteTimeUtc($path)',
  '        if ($null -eq $newest -or $at -gt $newest) { $newest = $at }',
  '      }',
  '    }',
  '    if ($null -ne $newest) { [void]$out.Append("T`t$($one[0])`t$([long][Math]::Floor(($newest - $epoch).TotalSeconds))`n") }',
  '  }',
  '  [Console]::Out.Write($out.ToString())',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
  'exit 0',
].join('\r\n')

/**
 * The process tree of a stop and its re-checks, for Windows PowerShell 5.1, run as a file like PROBE_PS1; it reads
 * Win32_Process (ProcessId, ParentProcessId, CreationDate, Name) as PROBE_PS1 does and signals nothing: the signals are
 * taskkill.exe, run by the adapter itself. A start is the creation time in epoch milliseconds (PROBE_PS1's arithmetic).
 *   list <pid> <start>             R or N for the root, G for each ancestor of this script, D for each descendant, M
 *                                  for each MSYS process table read (below)
 *   check <seconds> <pid:start>... after a sleep of the seconds given, an F line per target (gone: no process with
 *                                  that pid and that start); the first target binds to $B, the rest come in $args
 * A parent is taken as one only when it was created before its child: Windows keeps a dead parent's pid in
 * ParentProcessId, and that pid may since name another process.
 *
 * A program the worker runs through Git Bash is an MSYS process: bash forks a copy of itself, which execs the program
 * as a new Windows process and exits, so the program's ParentProcessId names a process that is gone and Win32_Process
 * links it to no member of the tree. The MSYS runtime keeps its own process table, with each process's MSYS parent and
 * its Windows pid; `ps.exe -al` of the same installation prints it. For each folder of a member's executable that holds
 * the MSYS (msys-2.0.dll) or Cygwin (cygwin1.dll) runtime, that folder's ps.exe is run once, and every process whose
 * MSYS parent is a member (or one found this way), and which was created after that parent, is a descendant too: a D
 * line with state `msys` and the parent's Windows pid as its parent. An M line per folder gives how many it added
 * (`M <count> <folder>`), or -1 when its table could not be read.
 */
export const TREE_PS1 = [
  '# session-control: the process tree of a stop and its re-checks, for Windows PowerShell 5.1 (stop_worker)',
  'param([string]$Op, [string]$A, [string]$B)',
  '$env:PSModulePath = "$PSHOME\\Modules"',
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)',
  'function Ms([DateTime]$at) { return [long][Math]::Floor(($at.ToUniversalTime() - $epoch).TotalMilliseconds) }',
  'function Flat($text) { if ($null -eq $text) { return \'\' } return ([string]$text -replace "[`t`r`n]", \' \') }',
  'try {',
  "  if ($Op -eq 'check' -and [int]$A -gt 0) { Start-Sleep -Seconds ([int]$A) }",
  '  $procs = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate, Name, ExecutablePath)',
  '  $byPid = @{}',
  '  foreach ($proc in $procs) { $byPid[[long]$proc.ProcessId] = $proc }',
  '  function StartOf([long]$id) { $proc = $byPid[$id]; if ($null -eq $proc -or $null -eq $proc.CreationDate) { return \'\' }; return "$(Ms $proc.CreationDate)" }',
  '  function IsChild($child, [long]$parent) {',
  '    $up = $byPid[$parent]',
  '    return ($null -ne $up -and $null -ne $up.CreationDate -and $null -ne $child.CreationDate -and $up.CreationDate -le $child.CreationDate)',
  '  }',
  '  $out = New-Object System.Text.StringBuilder',
  "  if ($Op -eq 'list') {",
  '    $root = [long]$A',
  '    $start = StartOf $root',
  '    $isRoot = ($start -ne \'\' -and $start -eq $B)',
  '    if ($isRoot) { [void]$out.Append("R`t$root`t$([long]$byPid[$root].ParentProcessId)`t$start`t`t$(Flat $byPid[$root].Name)`n") }',
  '    else { [void]$out.Append("N`t$root`t$start`n") }',
  '    $at = [long]$PID',
  '    for ($hop = 0; $hop -lt 64; $hop++) {',
  '      $me = $byPid[$at]',
  '      if ($null -eq $me) { break }',
  '      $up = [long]$me.ParentProcessId',
  '      if ($up -le 0 -or -not (IsChild $me $up)) { break }',
  '      [void]$out.Append("G`t$up`n")',
  '      $at = $up',
  '    }',
  '    if ($isRoot) {',
  '      $todo = New-Object System.Collections.Generic.Queue[long]',
  '      $seen = @{}',
  '      $todo.Enqueue($root); $seen[$root] = $true',
  '      while ($todo.Count -gt 0) {',
  '        $here = $todo.Dequeue()',
  '        foreach ($proc in $procs) {',
  '          $id = [long]$proc.ProcessId',
  '          if ([long]$proc.ParentProcessId -ne $here -or $seen.ContainsKey($id) -or -not (IsChild $proc $here)) { continue }',
  '          $seen[$id] = $true; $todo.Enqueue($id)',
  '          [void]$out.Append("D`t$id`t$here`t$(StartOf $id)`t`t$(Flat $proc.Name)`n")',
  '        }',
  '      }',
  '      # The MSYS process tables of the members\' runtime folders (see above): Windows pid to `<folder>|<MSYS pid>`, and',
  '      # `<folder>|<MSYS parent>` to the Windows pids of its children.',
  '      $tables = @{}',
  '      foreach ($id in @($seen.Keys)) {',
  '        $exe = $byPid[$id].ExecutablePath',
  '        if (-not $exe) { continue }',
  '        try { $dir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($exe)) } catch { continue }',
  '        if ([System.IO.File]::Exists("$dir\\msys-2.0.dll") -or [System.IO.File]::Exists("$dir\\cygwin1.dll")) { $tables[$dir] = $true }',
  '      }',
  '      $msysOf = @{}; $kidsOf = @{}; $added = @{}',
  '      foreach ($dir in @($tables.Keys)) {',
  '        $rows = @(); $code = -1',
  "        $ErrorActionPreference = 'Continue'",
  '        try { if ([System.IO.File]::Exists("$dir\\ps.exe")) { $rows = @(& "$dir\\ps.exe" -al 2>$null); $code = $LASTEXITCODE } } catch { $code = -1 }',
  "        $ErrorActionPreference = 'Stop'",
  '        if ($code -ne 0) { [void]$out.Append("M`t-1`t$(Flat $dir)`n"); continue }',
  '        $added[$dir] = 0',
  '        # PID PPID PGID WINPID ..., after a status letter in the first column when there is one.',
  '        foreach ($row in $rows) {',
  "          if ([string]$row -notmatch '^\\s*(?:[A-Za-z]\\s+)?(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)(\\s|$)') { continue }",
  '          $msysOf[[long]$Matches[4]] = "$dir|$($Matches[1])"',
  '          $up = "$dir|$($Matches[2])"',
  '          if (-not $kidsOf.ContainsKey($up)) { $kidsOf[$up] = New-Object System.Collections.Generic.List[long] }',
  '          $kidsOf[$up].Add([long]$Matches[4])',
  '        }',
  '      }',
  '      # Every member again, now with its MSYS children (state msys) and the Windows children of those.',
  '      if ($msysOf.Count -gt 0) {',
  '        $todo = New-Object System.Collections.Generic.Queue[long]',
  '        foreach ($id in @($seen.Keys)) { $todo.Enqueue($id) }',
  '        while ($todo.Count -gt 0) {',
  '          $here = $todo.Dequeue()',
  '          $key = $msysOf[$here]',
  '          if ($null -ne $key -and $kidsOf.ContainsKey($key)) {',
  '            foreach ($id in $kidsOf[$key]) {',
  '              $proc = $byPid[$id]',
  '              if ($seen.ContainsKey($id) -or $null -eq $proc -or -not (IsChild $proc $here)) { continue }',
  '              $seen[$id] = $true; $todo.Enqueue($id)',
  "              $dir = $key.Substring(0, $key.LastIndexOf('|')); $added[$dir] = $added[$dir] + 1",
  '              [void]$out.Append("D`t$id`t$here`t$(StartOf $id)`tmsys`t$(Flat $proc.Name)`n")',
  '            }',
  '          }',
  '          foreach ($proc in $procs) {',
  '            $id = [long]$proc.ProcessId',
  '            if ([long]$proc.ParentProcessId -ne $here -or $seen.ContainsKey($id) -or -not (IsChild $proc $here)) { continue }',
  '            $seen[$id] = $true; $todo.Enqueue($id)',
  '            [void]$out.Append("D`t$id`t$here`t$(StartOf $id)`t`t$(Flat $proc.Name)`n")',
  '          }',
  '        }',
  '      }',
  '      foreach ($dir in @($added.Keys)) { [void]$out.Append("M`t$($added[$dir])`t$(Flat $dir)`n") }',
  '    }',
  "  } elseif ($Op -eq 'check') {",
  '    foreach ($one in (@($B) + @($args))) {',
  '      $cut = ([string]$one).IndexOf(\':\')',
  '      if ($cut -lt 1) { continue }',
  '      $id = [long]([string]$one).Substring(0, $cut)',
  '      $want = ([string]$one).Substring($cut + 1)',
  '      $now = StartOf $id',
  '      if ($now -ne \'\' -and $now -eq $want) { [void]$out.Append("F`t$id`talive`t`n") } else { [void]$out.Append("F`t$id`tgone`t`n") }',
  '    }',
  '  } else { throw "unknown operation: $Op" }',
  '  [Console]::Out.Write($out.ToString())',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
  'exit 0',
].join('\r\n')

/**
 * The notes of TREE_PS1's M lines: per MSYS process table, what it added to the tree, or that it could not be read
 * (then a program the worker started through Git Bash whose Windows parent has exited is outside the stop).
 */
export function msysNotes(stdout: string): string[] {
  const notes: string[] = []
  for (const line of stdout.replace(/\r/g, '').split('\n')) {
    const [tag, count, ...rest] = line.split('\t')
    const dir = rest.join(' ').trim()
    if (tag !== 'M' || !/^-?\d+$/.test(count ?? '') || dir === '') continue
    const table = `the MSYS process table of ${winPath(dir)} (Git Bash)`
    const added = Number(count)
    if (added < 0) notes.push(`${table} could not be read: a program the worker started through Git Bash whose Windows parent has exited is not among the descendants listed, and this stop does not reach it`)
    else if (added === 0) notes.push(`${table} was read before the first signal: no program the worker started through Git Bash is outside its Windows process tree`)
    else notes.push(`${table} was read before the first signal: ${added} program${added === 1 ? '' : 's'} the worker started through Git Bash, whose Windows parent has exited, ${added === 1 ? 'is' : 'are'} among the descendants listed, each with its MSYS parent`)
  }
  return notes
}

/** The tree of a stop by TREE_PS1's list, with the notes of its MSYS process tables. */
async function listTree(port: HostPort, target: StopTarget): Promise<{ tree: ProcTree; notes: string[] }> {
  const ran = await runScript(port, 'tree.ps1', TREE_PS1, ['list', String(target.pid), target.start], 30_000)
  return { tree: treeOf(ran.stdout), notes: msysNotes(ran.stdout) }
}

/** taskkill.exe by absolute path, as Windows ships it. */
async function taskkill(port: HostPort): Promise<string> {
  const root = (await port.env('SystemRoot')) ?? 'C:\\Windows'
  return `${root.replace(/[\\/]+$/, '')}\\System32\\taskkill.exe`
}

/** Which of the targets (`<pid>:<start>`) are still alive, after a sleep of `sleepSec` inside TREE_PS1's check. */
async function stillAlive(port: HostPort, targets: readonly string[], sleepSec: number): Promise<Set<number>> {
  const ran = await runScript(port, 'tree.ps1', TREE_PS1, ['check', String(sleepSec), ...targets], 20_000 + sleepSec * 1000)
  if (ran.exitCode !== 0) throw new Error(`the process check failed (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 160)}`)
  return new Set(parseStopOutput(ran.stdout).final.filter(one => one.status === 'alive').map(one => one.pid))
}

/**
 * The stop on Windows, in short steps (each one process, so no wait falls on the engine's clock): the tree by
 * TREE_PS1's list unless given; then for the root, and after it for every descendant still alive: `taskkill /PID <pid>
 * /T` (a console process without a window refuses that and needs /F; the exit code is recorded), a re-check every
 * second for up to STOP_WAIT_SECONDS, `taskkill /PID <pid> /T /F` to one still there, re-checks for up to 3 seconds;
 * then the end state of each.
 */
async function stopProcessTree(port: HostPort, target: StopTarget, tree?: ProcTree): Promise<StopReport> {
  const listed = tree === undefined ? await listTree(port, target) : { tree, notes: [] }
  const listing = listed.tree
  const early = unstoppable(listing, target)
  if (early !== undefined) return early
  const exe = await taskkill(port)
  const steps: StopStep[] = []
  const own = new Set(listing.ancestors)
  const key = (one: { pid: number; start: string }) => `${one.pid}:${one.start}`
  const group = async (members: readonly { pid: number; start: string }[]) => {
    const live: { pid: number; start: string }[] = []
    const alive = await stillAlive(port, members.map(key), 0)
    for (const one of members) {
      if (own.has(one.pid)) steps.push({ kind: 'skip', pid: one.pid, reason: 'own' })
      else if (!alive.has(one.pid)) steps.push({ kind: 'skip', pid: one.pid, reason: 'gone' })
      else {
        const atMs = await port.now()
        const ran = await port.run([exe, '/PID', String(one.pid), '/T'], { timeoutMs: 15_000 })
        steps.push({ kind: 'signal', pid: one.pid, signal: 'taskkill /T', atMs, exitCode: ran.exitCode })
        live.push(one)
      }
    }
    if (live.length === 0) return
    let waited = 0
    let left = await stillAlive(port, live.map(key), 0)
    while (waited < STOP_WAIT_SECONDS && left.size > 0) {
      left = await stillAlive(port, live.map(key), 1)
      waited++
    }
    const checkedAt = await port.now()
    for (const one of live) steps.push({ kind: 'check', pid: one.pid, atMs: checkedAt, status: left.has(one.pid) ? 'alive' : 'gone', waitedSec: waited })
    const rest = live.filter(one => left.has(one.pid))
    if (rest.length === 0) return
    for (const one of rest) {
      const atMs = await port.now()
      const ran = await port.run([exe, '/PID', String(one.pid), '/T', '/F'], { timeoutMs: 15_000 })
      steps.push({ kind: 'signal', pid: one.pid, signal: 'taskkill /T /F', atMs, exitCode: ran.exitCode })
    }
    let after = 0
    left = await stillAlive(port, rest.map(key), 0)
    while (after < 3 && left.size > 0) {
      left = await stillAlive(port, rest.map(key), 1)
      after++
    }
    const doneAt = await port.now()
    for (const one of rest) steps.push({ kind: 'check', pid: one.pid, atMs: doneAt, status: left.has(one.pid) ? 'alive' : 'gone', waitedSec: after })
  }
  const root = listing.root ?? target
  await group([root])
  const others = await stillAlive(port, listing.descendants.map(key), 0)
  await group(listing.descendants.filter(one => others.has(one.pid)))
  const all = [root, ...listing.descendants]
  const end = await stillAlive(port, all.map(key), 0)
  return { tree: listing, steps, final: all.map(one => ({ pid: one.pid, status: end.has(one.pid) ? 'alive' : 'gone', state: '' })), notes: listed.notes }
}

/** Windows PowerShell 5.1 by absolute path: on Windows `bash` is the WSL launcher, and sh, mv and pwsh are not on the PATH a command gets. */
async function powershell(port: HostPort): Promise<string> {
  const root = (await port.env('SystemRoot')) ?? 'C:\\Windows'
  return `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** One of the mod's PowerShell scripts in the runs directory, written when it is not there as it should be (which makes the directory). */
async function ensureScript(port: HostPort, name: string, text: string): Promise<string> {
  const path = `${await port.runsDir()}/${name}`
  if ((await port.read(path).catch(() => undefined)) !== text) await port.write(path, text)
  return path
}

/** Runs one of the mod's PowerShell scripts with -File: its text never crosses a command line. */
async function runScript(port: HostPort, name: string, text: string, args: readonly string[], timeoutMs = 10_000) {
  const path = await ensureScript(port, name, text)
  return port.run([await powershell(port), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args], { timeoutMs })
}

/** On Windows the schema's leading / is Git Bash's /c/...: from here on, and in the registry, the native C:/... form. */
const native = (path: unknown) => (typeof path === 'string' ? winPath(path) : path) as string

export const windowsHost: Platform = {
  platform: 'windows',

  /** Git Bash hands on HOME as /c/Users/...; without a usable one the profile folder is home. Native form either way. */
  async homeDir(port: HostPort): Promise<string> {
    const home = await port.env('HOME')
    return winPath(home !== undefined && isWinAbsolute(home) ? home : ((await port.env('USERPROFILE')) ?? ''))
  },
  nativePath: winPath,
  sessionDir: winPath,
  isSameDir: isSameWinPath,
  transcriptPath: (entry: SessionEntry) => transcriptPath(entry, true),
  defaultConfigDir: (home: string, own: string | undefined) => defaultConfigDir(home, own, true),
  isDefaultConfigDir: (dir: string, defaultDir: string) => isDefaultConfigDir(dir, defaultDir, true),

  /**
   * PROBE_PS1, which also looks for sessions files under `configDirs`. A probe that fails is an error: read as no
   * process at all it would mark every worker dead. The helper's probe is Linux-only, so this one stays the adapter's.
   */
  async probe(port: HostPort, entries: readonly SessionEntry[], configDirs: readonly string[] = []): Promise<ProcFacts> {
    const ran = await runScript(port, 'probe.ps1', PROBE_PS1, [...probeArgs(entries), ...configDirs.map(dir => `c:${dir}`)], 20_000)
    if (ran.exitCode !== 0) throw new Error(`the process probe failed (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 160)}`)
    return parseProcFacts(ran.stdout.replace(/\r/g, ''))
  },
  async findNewWorker(port: HostPort, facts: ProcFacts, want: WorkerWant, known: ReadonlySet<number>, launchedAt: number) {
    return findNewWindowsWorker(facts, want, known, ((await port.now()) - launchedAt) / 1000)
  },
  /** The probe reads where the worker's sessions file is: the config dir itself. */
  workerConfigDir: (verdict: { configDir: string }) => verdict.configDir,
  /** The engine's clock: Windows has no sleep to start. */
  pause: clockPause,

  launchArgs: <T extends LaunchInput>(given: T): T => ({
    ...given,
    ...(given.dir === undefined ? {} : { dir: native(given.dir) }),
    ...(given.prompt_file === undefined ? {} : { prompt_file: native(given.prompt_file) }),
  }),
  launchChecks: statLaunchChecks,
  launchFacts: (promptText: string | undefined) => ({ isWindows: true, promptChars: promptText?.length, promptLead: promptText?.slice(0, 200) }),
  pickerArgv(argv: string[]) {
    const refusal = windowsPickerRefusal(argv)
    if (refusal !== undefined) return { refusal }
    argv[0] = winPath(argv[0] ?? '')
    return { argv }
  },
  launchTool: 'Bash',
  launchCommand: bashLaunchCommand,
  // On Windows the engine offers the Bash tool only when it finds Git Bash, which it may miss for a per-user Git
  // whose mingw64 git.exe comes first on the PATH (a session started from Git Bash).
  launchToolHint: ' On Windows Claude Code offers the Bash tool only when it finds Git Bash: start the orchestrator with CLAUDE_CODE_GIT_BASH_PATH set to Git\\bin\\bash.exe.',
  /** The Bash route's line writes no pid file (the PowerShell route's does: host-powershell.ts). */
  launchPidFile: () => undefined,
  /** The Bash route takes any path the guards pass. */
  launchRefusal: () => undefined,

  createFile: writeIfAbsent,
  /** Writing the probe script (the one the probe runs) makes the runs directory; the backups directory comes with the first backup. */
  async prepareHelperDirs(port: HostPort): Promise<void> {
    await ensureScript(port, 'probe.ps1', PROBE_PS1)
  },
  /** Writing the probe script makes the runs directory. */
  async prepareRunsDir(port: HostPort): Promise<void> {
    await ensureScript(port, 'probe.ps1', PROBE_PS1)
  },
  /** TREE_PS1 lists the tree and re-checks it, taskkill signals: the helper's stop is Linux-only. */
  stopProcessTree,
}
