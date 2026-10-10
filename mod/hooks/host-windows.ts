// The scripts of the Windows adapter (native Windows, Windows PowerShell 5.1): the file operations $.fs lacks and the
// process probe, each written to the runs directory and run with -File by the adapter below. Moved here unchanged
// from core.ts.

/**
 * The file operations $.fs lacks, for Windows PowerShell 5.1: written to the runs directory and run with -File
 * (never as -Command text, whose quoting does not survive). `move <from> <to>` replaces an existing file in one
 * step (File.Replace: a reader never finds it missing) or moves it there; `remove <path>`; `append <from> <to>`
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
