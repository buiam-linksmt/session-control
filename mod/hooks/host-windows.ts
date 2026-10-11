// The Windows adapter of the host interface (native Windows: Claude Code on Windows, Git Bash as the Bash tool's
// shell, which has no sh, jq, mv or /proc on the PATH a command starts with). The file operations $.fs lacks and the
// process probe are Windows PowerShell 5.1 scripts, written to the runs directory and run with -File; paths are kept
// in the native C:/... form and compared as Windows compares them. Its scripts came here unchanged from core.ts.
// trace.ts imports them to name them: this file never imports trace.ts.

import type { SessionEntry } from '../types'
import {
  defaultConfigDir,
  findNewWindowsWorker,
  isDefaultConfigDir,
  isSameWinPath,
  isWinAbsolute,
  parseProcFacts,
  probeArgs,
  transcriptPath,
  windowsPickerRefusal,
  winPath,
} from './core'
import type { LaunchInput, ProcFacts } from './core'
import type { Host, HostPort, NewerFiles, ProcTree, RemoveOutcome, RotatePlan, StopReport, StopStep, StopTarget, TailShape, WorkerWant } from './host'
import {
  NEWER_MAX,
  PANE_TAIL,
  STOP_WAIT_SECONDS,
  bashLaunchCommand,
  clockPause,
  nativeHashTrees,
  nativeUsageProbe,
  parseNewerListing,
  parseStopOutput,
  readTail,
  removeOutcomeOfExit,
  rotateAndAppendWith,
  statLaunchChecks,
  treeOf,
  unstoppable,
  writeAtomicWith,
  writeIfAbsent,
} from './host-shared'

/**
 * The file operations $.fs lacks, for Windows PowerShell 5.1: written to the runs directory and run with -File
 * (never as -Command text, whose quoting does not survive). `move <from> <to>` replaces an existing file in one
 * step (File.Replace: a reader never finds it missing) or moves it there; `remove <path>`; `removeregular <path>`
 * removes a regular file only (the attributes are read without following a link: a reparse point, a symbolic link or
 * a junction, exits 4, a directory 5, a path that is not there 3); `append <from> <to>`
 * adds the text of a file to the end of another and removes the first, never reading what the second holds;
 * `tail <path> <lines> <width>` for a transcript over the 4 MiB read cap. Output is UTF-8; a failure exits 1 with
 * the reason.
 */
export const FILES_PS1 = [
  '# session-control: file operations for Windows PowerShell 5.1 (move, remove, append, tail)',
  'param([string]$Op, [string]$A, [string]$B, [string]$C)',
  // A PowerShell 7 parent leaves its own module folders first; Windows PowerShell must load its own.
  '$env:PSModulePath = "$PSHOME\\Modules"',
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'try {',
  '  switch ($Op) {',
  "    'move' {",
  '      if ([System.IO.File]::Exists($B)) { [System.IO.File]::Replace($A, $B, [NullString]::Value) }',
  '      else { [System.IO.File]::Move($A, $B) }',
  '    }',
  "    'remove' { if ([System.IO.File]::Exists($A)) { [System.IO.File]::Delete($A) } }",
  "    'removeregular' {",
  '      $attr = $null',
  '      try { $attr = [System.IO.File]::GetAttributes($A) } catch [System.IO.IOException] { exit 3 }',
  '      if ($attr -band [System.IO.FileAttributes]::ReparsePoint) { exit 4 }',
  '      if ($attr -band [System.IO.FileAttributes]::Directory) { exit 5 }',
  '      [System.IO.File]::Delete($A)',
  '    }',
  "    'append' {",
  '      $utf8 = New-Object System.Text.UTF8Encoding $false',
  '      [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($B))',
  '      [System.IO.File]::AppendAllText($B, [System.IO.File]::ReadAllText($A, $utf8), $utf8)',
  '      [System.IO.File]::Delete($A)',
  '    }',
  "    'tail' {",
  '      $width = [int]$C',
  '      foreach ($line in @(Get-Content -LiteralPath $A -Tail ([int]$B) -Encoding UTF8)) {',
  '        if ($line.Length -gt $width) { $line = $line.Substring(0, $width) }',
  '        [Console]::Out.Write($line + "`n")',
  '      }',
  '    }',
  '    default { throw "unknown operation: $Op" }',
  '  }',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
  'exit 0',
].join('\r\n')

/**
 * The files under a directory written after a time, for Windows PowerShell 5.1, read-only, run as a file like
 * FILES_PS1: args are the directory, the epoch seconds and the most lines to print. A walk of its own over
 * System.IO.DirectoryInfo: no folder named `.git` is entered, and an entry with the ReparsePoint attribute (a symbolic
 * link, a junction) is neither followed nor listed; a folder it cannot read is passed over. It prints what NEWER_SCRIPT
 * prints: the newest first, the first `max` as `<mtime in seconds>\t<path>`, then `N\t<count of all>`. Exit 3 when
 * the directory is not there.
 */
export const NEWER_PS1 = [
  '# session-control: the files under a folder written after a time, for Windows PowerShell 5.1 (session_writes)',
  'param([string]$Dir, [string]$Since, [string]$Max)',
  '$env:PSModulePath = "$PSHOME\\Modules"',
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  'try {',
  '  if (-not [System.IO.Directory]::Exists($Dir)) { exit 3 }',
  '  $epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)',
  '  $after = $epoch.AddSeconds([long]$Since)',
  '  $skip = [System.IO.FileAttributes]::ReparsePoint',
  '  $found = New-Object System.Collections.Generic.List[System.IO.FileSystemInfo]',
  '  $todo = New-Object System.Collections.Generic.Stack[string]',
  '  $todo.Push($Dir)',
  '  while ($todo.Count -gt 0) {',
  '    $here = $todo.Pop()',
  '    try { $entries = (New-Object System.IO.DirectoryInfo $here).GetFileSystemInfos() } catch { continue }',
  '    foreach ($one in $entries) {',
  "      if ($one.Name -eq '.git' -or ($one.Attributes -band $skip) -ne 0) { continue }",
  '      if ($one -is [System.IO.DirectoryInfo]) { $todo.Push($one.FullName) }',
  '      elseif ($one.LastWriteTimeUtc -gt $after) { $found.Add($one) }',
  '    }',
  '  }',
  '  $out = New-Object System.Text.StringBuilder',
  '  $shown = 0',
  '  foreach ($one in @($found | Sort-Object -Property @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true }, @{ Expression = { $_.FullName }; Descending = $false })) {',
  '    if ($shown -ge [int]$Max) { break }',
  '    $sec = ($one.LastWriteTimeUtc - $epoch).TotalSeconds.ToString(\'F3\', [System.Globalization.CultureInfo]::InvariantCulture)',
  '    [void]$out.Append("$sec`t$($one.FullName)`n")',
  '    $shown++',
  '  }',
  '  [void]$out.Append("N`t$($found.Count)`n")',
  '  [Console]::Out.Write($out.ToString())',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
  'exit 0',
].join('\r\n')

/**
 * How far a sessions file's `startedAt` may sit from its process's creation for the pid to count as that process,
 * in milliseconds: a little before (clock granularity), and after by however long the engine takes to start (2 to
 * 6 s seen on Linux, once 257 s). Only the lower bound guards against a reused pid: a process created after the file
 * was written cannot be the one that wrote it, and none created before it can share the pid while the writer lives.
 */
export const START_MATCH_MS = { before: 2_000, after: 600_000 } as const

/**
 * The process probe for native Windows (Windows PowerShell 5.1), run as a file like FILES_PS1. It prints the lines
 * PROBE_SCRIPT prints, so parseProcFacts and isPidAlive read them unchanged:
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
  '# session-control: the process probe for Windows PowerShell 5.1 (the P, A and T lines of PROBE_SCRIPT)',
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
 * The process tree of a stop and its re-checks, for Windows PowerShell 5.1, run as a file like FILES_PS1; it reads
 * Win32_Process (ProcessId, ParentProcessId, CreationDate, Name) as PROBE_PS1 does and signals nothing: the signals are
 * taskkill.exe, run by the adapter itself. A start is the creation time in epoch milliseconds (PROBE_PS1's arithmetic).
 *   list <pid> <start>             R or N for the root, G for each ancestor of this script, D for each descendant
 *   check <seconds> <pid:start>... after a sleep of the seconds given, an F line per target (gone: no process with
 *                                  that pid and that start); the first target binds to $B, the rest come in $args
 * A parent is taken as one only when it was created before its child: Windows keeps a dead parent's pid in
 * ParentProcessId, and that pid may since name another process.
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
  '  $procs = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate, Name)',
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
  const listing = tree ?? treeOf((await runScript(port, 'tree.ps1', TREE_PS1, ['list', String(target.pid), target.start], 30_000)).stdout)
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
  return { tree: listing, steps, final: all.map(one => ({ pid: one.pid, status: end.has(one.pid) ? 'alive' : 'gone', state: '' })), notes: [] }
}

/** Windows PowerShell 5.1 by absolute path: on Windows `bash` is the WSL launcher, and sh, mv and pwsh are not on the PATH a command gets. */
async function powershell(port: HostPort): Promise<string> {
  const root = (await port.env('SystemRoot')) ?? 'C:\\Windows'
  return `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** One of the mod's PowerShell scripts in the runs directory, written when it is not there as it should be (which makes the directory). */
async function ensureScript(port: HostPort, name: string, text: string, isQuiet = false): Promise<string> {
  const path = `${await port.runsDir()}/${name}`
  if ((await port.read(path).catch(() => undefined)) !== text) await port.write(path, text, isQuiet)
  return path
}

/** Runs one of the mod's PowerShell scripts with -File: its text never crosses a command line. */
async function runScript(port: HostPort, name: string, text: string, args: readonly string[], timeoutMs = 10_000, isQuiet = false) {
  const path = await ensureScript(port, name, text, isQuiet)
  return port.run([await powershell(port), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...args], { timeoutMs }, isQuiet)
}

/** Removes a file with the file script, best effort. Answers whether it went. */
async function removeFile(port: HostPort, path: string, isQuiet = false): Promise<boolean> {
  const ran = await runScript(port, 'files.ps1', FILES_PS1, ['remove', path], 10_000, isQuiet).catch((err: unknown) => {
    if (!isQuiet) port.traceError('remove', err)
    return undefined
  })
  return ran?.exitCode === 0
}

/** Removes a regular file with the file script's `removeregular`; a link or a directory stays. */
async function removeRegularFile(port: HostPort, path: string): Promise<RemoveOutcome> {
  const ran = await runScript(port, 'files.ps1', FILES_PS1, ['removeregular', path]).catch((err: unknown) => {
    port.traceError('remove', err)
    return undefined
  })
  return ran === undefined ? 'failed' : removeOutcomeOfExit(ran.exitCode)
}

/**
 * Puts the temp file in the file's place with the file script; when it cannot run or fails, the text is written over
 * the file directly (the caller has checked it is still the one expected), and that write, which a reader can see
 * half done, is reported once.
 */
async function renameOver(port: HostPort, tmp: string, path: string, text: string): Promise<void> {
  const ran = await runScript(port, 'files.ps1', FILES_PS1, ['move', tmp, path]).catch((err: unknown) => {
    port.traceError('rename', err)
    return { exitCode: -1, stderr: String(err) }
  })
  if (ran.exitCode === 0) return
  await port.write(path, text)
  // The script's own remove; when that cannot run either, $.fs (which cannot remove) empties the temp file instead.
  const isRemoved = await removeFile(port, tmp)
  if (!isRemoved) await port.write(tmp, '')
  const leftover = isRemoved ? '' : `; the temp file ${tmp} could not be removed and was emptied`
  port.noteDirectWrite(`the rename failed (${ran.stderr.trim().slice(0, 100)}); ${path} was written directly, not atomically${leftover}`)
}

/** On Windows the schema's leading / is Git Bash's /c/...: from here on, and in the registry, the native C:/... form. */
const native = (path: unknown) => (typeof path === 'string' ? winPath(path) : path) as string

export const windowsHost: Host = {
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
   * process at all it would mark every worker dead.
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
  /** Writing the file script makes the runs directory; the backups directory comes with the first backup. */
  async prepareHelperDirs(port: HostPort): Promise<void> {
    await ensureScript(port, 'files.ps1', FILES_PS1)
  },
  /** Writing the file script makes the runs directory. */
  async prepareRunsDir(port: HostPort): Promise<void> {
    await ensureScript(port, 'files.ps1', FILES_PS1)
  },
  /** The file script's append makes the directory itself: nothing to retry. */
  makeDir: async () => false,
  writeAtomic: (port: HostPort, path: string, text: string, expected?: string) => writeAtomicWith(windowsHost, port, path, text, expected),
  removeFile,
  removeRegularFile,
  renameOver,
  /** The lines go to a file of their own, which the file script appends and removes. */
  async append(port: HostPort, path: string, lines: readonly string[], isQuiet: boolean, onRan: (exitCode: number) => void) {
    const added = `${path}.add.${await port.now()}`
    await port.write(added, lines.map(line => `${line}\n`).join(''), isQuiet)
    const ran = await runScript(port, 'files.ps1', FILES_PS1, ['append', added, path], 10_000, isQuiet).catch((err: unknown) => ({ exitCode: -1, stderr: String(err) }))
    onRan(ran.exitCode)
    if (ran.exitCode === 0) return undefined
    await removeFile(port, added, isQuiet)
    return `${path} cannot be appended to (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 100)}`
  },
  /** A read, or the file script for a transcript over the read cap (an answer the engine cut counts as unread). */
  async tail(port: HostPort, path: string, shape?: TailShape): Promise<string | undefined> {
    const { lines, width } = shape ?? PANE_TAIL
    const text = await readTail(port, path, lines, width)
    if (text !== undefined) return text
    const ran = await runScript(port, 'files.ps1', FILES_PS1, ['tail', path, String(lines), String(width)]).catch((err: unknown) => {
      port.traceError('transcript tail', err)
      return undefined
    })
    return ran?.exitCode === 0 && (shape === undefined || !ran.isStdoutTruncated) ? ran.stdout : undefined
  },
  /** NEWER_PS1, its paths taken in the native C:/... form; nothing written but the script itself, as every script here. */
  async filesNewerThan(port: HostPort, dir: string, epochSeconds: number): Promise<NewerFiles | undefined> {
    const ran = await runScript(port, 'newer.ps1', NEWER_PS1, [dir, String(Math.floor(epochSeconds)), String(NEWER_MAX)], 30_000).catch((err: unknown) => {
      port.traceError('files newer than', err)
      return undefined
    })
    return ran?.exitCode === 0 && !ran.isStdoutTruncated ? parseNewerListing(ran.stdout, winPath) : undefined
  },
  /** Through `$.fs` (list, stat, read): no process (nativeHashTrees). */
  hashTrees: nativeHashTrees,
  stopProcessTree,
  /** Each rename of the plan by the file script, where a file another session moved meanwhile is no failure. */
  async rotate(port: HostPort, plan: RotatePlan): Promise<void> {
    for (const [from, to] of plan.moves) {
      if (!(await port.exists(from).catch(() => false))) continue
      const ran = await runScript(port, 'files.ps1', FILES_PS1, ['move', from, to], 10_000, true)
      if (ran.exitCode !== 0 && (await port.exists(from).catch(() => true))) throw new Error(`rotation failed (exit ${ran.exitCode}): ${ran.stderr.trim().slice(0, 100)}`)
    }
  },
  rotateAndAppend: (port: HostPort, path: string, lines: readonly string[], rotation?: RotatePlan) => rotateAndAppendWith(windowsHost, port, path, lines, rotation),
  /**
   * `claude.exe` from the PATH (no shell, so an npm `claude.cmd` shim is not run: NO_CLAUDE), in the root of the home
   * folder's drive (nativeUsageProbe). Not run on a live Windows host yet.
   */
  async probeUsage(port: HostPort, configDir: string, isInherited: boolean) {
    const drive = /^[A-Z]:\//.exec(await windowsHost.homeDir(port))?.[0]
    return nativeUsageProbe(port, 'claude.exe', winPath(configDir), isInherited, drive)
  },
}
