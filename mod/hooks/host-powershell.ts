// The PowerShell launch route (the launchRoute option at `powershell`, native Windows only): a worker starts through
// the engine's PowerShell tool instead of its Bash tool, which on Windows the engine offers only when it finds Git
// Bash. withPowerShellLaunch lays the route over the Windows adapter: launchTool, launchCommand, launchToolHint,
// launchPidFile and launchRefusal are its own, every other member (the launch guards, the probe, the worker match) the
// adapter's.
// Nothing here runs a process: the command is text for the PowerShell tool. tests/windows-selftest.py renders it with
// this file and runs it under Windows PowerShell 5.1 and PowerShell 7, with node.exe standing in for claude.exe.

import { WORKER_SETTINGS } from './core'
import type { LaunchArgs } from './core'
import type { Host, LaunchTarget } from './host'

/**
 * One argument as a Windows program reads it back from its command line (the C runtime's rules, which claude.exe and
 * node.exe follow): as it is when it holds no blank, tab or double quote and is not empty; else in double quotes, each
 * quote escaped with a backslash and the backslashes right before a quote, or before the closing one, doubled.
 */
export function winArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value
  let quoted = '"'
  let slashes = 0
  for (const char of value) {
    if (char === '\\') {
      slashes++
      continue
    }
    quoted += char === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${char}`
    slashes = 0
  }
  return `${quoted}${'\\'.repeat(slashes * 2)}"`
}

/**
 * A PowerShell string literal that keeps the command in printable ASCII, so it reads the same whatever encoding the
 * PowerShell tool hands it on in: single-quoted, its quotes doubled, when the value is printable ASCII; else
 * double-quoted, with a backtick before each backtick, `$` and `"`, and every other character as `$([char]0x....)`
 * (a character outside the BMP as its two UTF-16 halves, which the string joins again).
 */
export function psLiteral(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return `'${value.replace(/'/g, "''")}'`
  let text = '"'
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at)
    const char = value.charAt(at)
    if (code >= 0x20 && code <= 0x7e) text += '`$"'.includes(char) ? `\`${char}` : char
    else text += `$([char]0x${code.toString(16).toUpperCase().padStart(4, '0')})`
  }
  return `${text}"`
}

/**
 * A path as Start-Process reads it for -WorkingDirectory, a wildcard pattern: `[`, `]`, `*`, `?` and the backtick each
 * get a backtick (WildcardPattern.Escape), which Windows PowerShell 5.1 and PowerShell 7 both read back as the path.
 */
export function wildcardEscape(path: string): string {
  return path.replace(/[[\]*?`]/g, '`$&')
}

/**
 * Why the PowerShell route cannot start a launch, or undefined. Start-Process also reads its redirection paths as
 * wildcard patterns, and no spelling of a path with `[`, `]` or a backtick reaches both versions whole: plain, the
 * pattern finds no file; escaped, PowerShell 7 looks for the backticks themselves (and 5.1 for the standard input's).
 * Measured with tests/windows-selftest.py's layouts. The launch directory is escaped instead (wildcardEscape).
 */
export function powershellLaunchRefusal(args: LaunchArgs, runsDir: string): string | undefined {
  const named = [
    ['prompt file', args.prompt_file],
    ['runs directory', runsDir],
  ].filter(([, path]) => /[[\]`]/.test(path ?? ''))
  if (named.length === 0) return undefined
  return (
    `refused: on the PowerShell launch route Start-Process reads the prompt file and the run files as wildcard patterns, and Windows PowerShell 5.1 and PowerShell 7 ` +
    `cannot both be given a path with [, ] or a backtick: ${named.map(([what, path]) => `the ${what} ${path}`).join(' and ')}; move it to a path without them, or set the launchRoute option to bash`
  )
}

/** The pid file a PowerShell launch writes beside its result file: `<runs>/<stamp>-<slug>.pid`. */
export function launchPidFile(resultFile: string): string {
  return `${resultFile.replace(/\.json$/, '')}.pid`
}

/**
 * claude.exe's arguments for a launch, the flags of the Bash route's line in its order: `-p --model <model>
 * [--resume <sid>] -n <name> --settings <WORKER_SETTINGS> --dangerously-skip-permissions --output-format json`. No
 * prompt: it comes on standard input from the prompt file.
 */
export function powershellLaunchArgs(args: LaunchArgs, target: LaunchTarget): string[] {
  const resume = target.resumeSid ? ['--resume', target.resumeSid] : []
  return ['-p', '--model', args.model, ...resume, '-n', target.name, '--settings', WORKER_SETTINGS, '--dangerously-skip-permissions', '--output-format', 'json']
}

/**
 * The command the PowerShell tool runs for a launch (PowerShell 7 or Windows PowerShell 5.1, whichever the tool
 * starts). Windows PowerShell must load its own modules under a PowerShell 7 parent; the effort, and the config
 * directory unless the worker inherits it, are set for claude.exe to inherit; claude.exe is found on the PATH.
 * Start-Process starts it in the launch directory (wildcard-escaped, as it reads it) with the prompt file as standard
 * input and the result and error files as standard output and error (its own redirections: the bytes go through as
 * they are, never re-encoded, and the prompt never meets the command-line length limit). Its arguments go as one
 * string, each quoted by winArg: Windows PowerShell 5.1 joins an argument list with blanks and quotes nothing, so the
 * name and the settings JSON reach claude.exe whole only when quoted here, the same string under both. Then the pid
 * goes to the pid file, the command waits for claude.exe and exits with its exit code, so the tool's exit
 * notification carries it.
 */
export function powershellLaunchCommand(args: LaunchArgs, target: LaunchTarget, resultFile: string, errFile: string): string {
  const argumentList = powershellLaunchArgs(args, target).map(winArg).join(' ')
  return [
    '$env:PSModulePath = "$PSHOME\\Modules"',
    "$ErrorActionPreference = 'Stop'",
    `$env:CLAUDE_CODE_EFFORT_LEVEL = ${psLiteral(args.effort)}`,
    ...(target.isConfigInherited === true ? [] : [`$env:CLAUDE_CONFIG_DIR = ${psLiteral(target.configDir)}`]),
    '$exe = (Get-Command claude.exe -ErrorAction Stop).Source',
    `$p = Start-Process -FilePath $exe -ArgumentList ${psLiteral(argumentList)} -WorkingDirectory ${psLiteral(wildcardEscape(args.dir))} ` +
      `-RedirectStandardInput ${psLiteral(args.prompt_file)} -RedirectStandardOutput ${psLiteral(resultFile)} -RedirectStandardError ${psLiteral(errFile)} -NoNewWindow -PassThru`,
    // The handle is kept so the exit code can still be read after the process ends.
    '$null = $p.Handle',
    `Set-Content -LiteralPath ${psLiteral(launchPidFile(resultFile))} -Value $p.Id -Encoding Ascii`,
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('\n')
}

/** Said after the PowerShell tool refused to start a worker. */
export const POWERSHELL_TOOL_HINT =
  ' On Windows Claude Code offers the PowerShell tool by default only when it does not find Git Bash: start the orchestrator with CLAUDE_CODE_USE_POWERSHELL_TOOL=1, or set the launchRoute option to bash.'

/** The Windows adapter with its launch through the PowerShell tool; every other member is the adapter's own. */
export function withPowerShellLaunch(base: Host): Host {
  return {
    ...base,
    launchTool: 'PowerShell',
    launchCommand: powershellLaunchCommand,
    launchToolHint: POWERSHELL_TOOL_HINT,
    launchPidFile,
    launchRefusal: powershellLaunchRefusal,
  }
}
