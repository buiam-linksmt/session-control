// The PowerShell launch route (hooks/host-powershell.ts): the command text the PowerShell tool runs on native Windows,
// its quoting at both levels (the PowerShell string, and the Windows command line claude.exe reads back), the pid file,
// and the adapter it makes. tests/windows-selftest.py runs the same text under Windows PowerShell 5.1 and PowerShell 7.

import { describe, expect, test } from 'claude-code/testing'

import { WORKER_SETTINGS, pidFromFile } from '../hooks/core'
import { HOST_MEMBERS } from '../hooks/host'
import { withHelper } from '../hooks/host-helper'
import {
  POWERSHELL_TOOL_HINT,
  launchPidFile,
  powershellLaunchArgs,
  powershellLaunchCommand,
  powershellLaunchRefusal,
  psLiteral,
  wildcardEscape,
  winArg,
  withPowerShellLaunch,
} from '../hooks/host-powershell'
import { posixHost } from '../hooks/host-posix'
import { windowsHost } from '../hooks/host-windows'

/** How the C runtime splits a command line into arguments (the post-2008 rules), to read back what winArg wrote. */
function crtSplit(line: string): string[] {
  const args: string[] = []
  let at = 0
  while (at < line.length) {
    while (line[at] === ' ' || line[at] === '\t') at++
    if (at >= line.length) break
    let arg = ''
    let isQuoted = false
    for (; at < line.length; at++) {
      const char = line[at]
      if (!isQuoted && (char === ' ' || char === '\t')) break
      if (char === '\\') {
        let slashes = 0
        while (line[at] === '\\') {
          slashes++
          at++
        }
        if (line[at] === '"') {
          arg += '\\'.repeat(Math.floor(slashes / 2))
          if (slashes % 2 === 1) arg += '"'
          else isQuoted = !isQuoted
        } else {
          arg += '\\'.repeat(slashes)
          at--
        }
        continue
      }
      if (char === '"') {
        if (isQuoted && line[at + 1] === '"') {
          arg += '"'
          at++
        } else isQuoted = !isQuoted
        continue
      }
      arg += char
    }
    args.push(arg)
  }
  return args
}

const ARGS = { dir: 'C:/work/new', prompt_file: 'C:/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }
const RUNS = 'C:/Users/u/.claude/session-control/runs'
const RESULT = `${RUNS}/20260921141320-new.json`
const ERR = `${RUNS}/20260921141320-new.err`

describe('quoting', () => {
  test('winArg: a plain word stays as it is, so the probe still finds `--model opus` and the name', () => {
    for (const word of ['-p', '--model', 'opus', 'claude-opus-5-5', 'w-new-260921141320', '--output-format', 'json', 'C:/x/y', 'a\\b']) expect(winArg(word)).toBe(word)
  })

  test('winArg: blanks, quotes, backslashes before a quote or the end, and the empty string, as the C runtime reads them back', () => {
    expect(winArg(WORKER_SETTINGS)).toBe('"{\\"crossSessionInbound\\":\\"accept\\"}"')
    expect(winArg('')).toBe('""')
    expect(winArg('a b')).toBe('"a b"')
    expect(winArg('C:\\my dir\\')).toBe('"C:\\my dir\\\\"')
    expect(winArg('say \\"hi\\"')).toBe('"say \\\\\\"hi\\\\\\""')
    const cases = [WORKER_SETTINGS, '', 'a b', 'tab\there', 'C:\\my dir\\', 'x\\\\"y', 'quote " in', '"', '\\', 'caf\u00e9 \u2615', "it's", 'trailing\\\\', 'new\nline']
    const line = ['claude.exe', ...cases].map(winArg).join(' ')
    expect(crtSplit(line)).toEqual(['claude.exe', ...cases])
  })

  test('psLiteral: printable ASCII single-quoted with its quotes doubled; anything else double-quoted in ASCII with $([char]...)', () => {
    expect(psLiteral('C:/work/new')).toBe("'C:/work/new'")
    expect(psLiteral("it's")).toBe("'it''s'")
    expect(psLiteral('$env:X `n "q"')).toBe("'$env:X `n \"q\"'")
    expect(psLiteral('')).toBe("''")
    expect(psLiteral('C:/Users/Jos\u00e9')).toBe('"C:/Users/Jos$([char]0x00E9)"')
    // Typographic quotes, which PowerShell also takes for quotes, never appear as themselves.
    expect(psLiteral('it\u2019s $x `y "z"')).toBe('"it$([char]0x2019)s `$x ``y `"z`""')
    // A character outside the BMP as its two UTF-16 halves.
    expect(psLiteral('\u{1F600}')).toBe('"$([char]0xD83D)$([char]0xDE00)"')
    expect(psLiteral('a\tb')).toBe('"a$([char]0x0009)b"')
    for (const value of ['C:/x', "o'k", 'Jos\u00e9 \u2019 \u{1F600}', 'tab\t']) expect(/^[\x20-\x7e]*$/.test(psLiteral(value))).toBe(true)
  })
})

describe('the command', () => {
  test('a fresh launch that inherits the config dir: no CLAUDE_CONFIG_DIR line, the flags of the Bash route, the prompt on standard input', () => {
    const command = powershellLaunchCommand(ARGS, { configDir: 'C:/Users/u/.claude', isConfigInherited: true, name: 'w-new-260921141320' }, RESULT, ERR)
    expect(command).toBe(
      [
        '$env:PSModulePath = "$PSHOME\\Modules"',
        "$ErrorActionPreference = 'Stop'",
        "$env:CLAUDE_CODE_EFFORT_LEVEL = 'high'",
        '$exe = (Get-Command claude.exe -ErrorAction Stop).Source',
        `$p = Start-Process -FilePath $exe -ArgumentList '-p --model opus -n w-new-260921141320 --settings "{\\"crossSessionInbound\\":\\"accept\\"}" --dangerously-skip-permissions --output-format json' ` +
          `-WorkingDirectory 'C:/work/new' -RedirectStandardInput 'C:/work/new/prompt.md' -RedirectStandardOutput '${RESULT}' -RedirectStandardError '${ERR}' -NoNewWindow -PassThru`,
        '$null = $p.Handle',
        `Set-Content -LiteralPath '${RUNS}/20260921141320-new.pid' -Value $p.Id -Encoding Ascii`,
        '$p.WaitForExit()',
        'exit $p.ExitCode',
      ].join('\n'),
    )
    // No prompt, no `--` and no positional argument: the prompt is the redirected standard input.
    expect(command).not.toContain(' -- ')
    expect(command).not.toContain('cat ')
  })

  test('with a picked config dir (a picker, or a resume under another dir): CLAUDE_CONFIG_DIR is set, right after the effort', () => {
    const lines = powershellLaunchCommand(ARGS, { configDir: 'C:/Users/u/.claude/lic b', name: 'w-new-1' }, RESULT, ERR).split('\n')
    expect(lines.slice(2, 5)).toEqual(["$env:CLAUDE_CODE_EFFORT_LEVEL = 'high'", "$env:CLAUDE_CONFIG_DIR = 'C:/Users/u/.claude/lic b'", '$exe = (Get-Command claude.exe -ErrorAction Stop).Source'])
  })

  test('a resume: --resume and the session id right after the model, as on the Bash route', () => {
    const sid = 'bbbbbbbb-2222-4222-8222-222222222222'
    expect(powershellLaunchArgs(ARGS, { configDir: 'C:/c', resumeSid: sid, name: 'w-old-1' })).toEqual([
      '-p',
      '--model',
      'opus',
      '--resume',
      sid,
      '-n',
      'w-old-1',
      '--settings',
      WORKER_SETTINGS,
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
    ])
    expect(powershellLaunchCommand(ARGS, { configDir: 'C:/c', resumeSid: sid, name: 'w-old-1' }, RESULT, ERR)).toContain(`-ArgumentList '-p --model opus --resume ${sid} -n w-old-1 --settings `)
  })

  test('paths with blanks, quotes, brackets and non-ASCII letters: each one PowerShell string, the command printable ASCII', () => {
    const args = { ...ARGS, dir: "C:/Users/Jos\u00e9/my work/o'k [1]", prompt_file: "C:/Users/Jos\u00e9/my work/o'k/prompt \u2019.md" }
    const runs = "C:/Users/Jos\u00e9/.claude/run's"
    const command = powershellLaunchCommand(args, { configDir: 'C:/Users/Jos\u00e9/.claude', name: 'w-new-1' }, `${runs}/1-new.json`, `${runs}/1-new.err`)
    expect(/^[\x20-\x7e\n]*$/.test(command)).toBe(true)
    // The launch directory as the wildcard pattern Start-Process reads it as: each bracket behind a backtick.
    expect(command).toContain('-WorkingDirectory "C:/Users/Jos$([char]0x00E9)/my work/o\'k ``[1``]" ')
    expect(command).toContain(`-RedirectStandardInput "C:/Users/Jos$([char]0x00E9)/my work/o'k/prompt $([char]0x2019).md" `)
    expect(command).toContain(`-RedirectStandardOutput "C:/Users/Jos$([char]0x00E9)/.claude/run's/1-new.json" `)
    expect(command).toContain(`$env:CLAUDE_CONFIG_DIR = "C:/Users/Jos$([char]0x00E9)/.claude"`)
    expect(command).toContain(`Set-Content -LiteralPath "C:/Users/Jos$([char]0x00E9)/.claude/run's/1-new.pid" `)
    const ascii = powershellLaunchCommand({ ...ARGS, dir: "C:/my work/o'k" }, { configDir: 'C:/c', isConfigInherited: true, name: 'w-new-1' }, "C:/r's/1.json", "C:/r's/1.err")
    expect(ascii).toContain(`-WorkingDirectory 'C:/my work/o''k' `)
    expect(ascii).toContain(`Set-Content -LiteralPath 'C:/r''s/1.pid' `)
    const bracketed = powershellLaunchCommand({ ...ARGS, dir: 'C:/work/[a] b`c' }, { configDir: 'C:/c', isConfigInherited: true, name: 'w-new-1' }, RESULT, ERR)
    expect(bracketed).toContain("-WorkingDirectory 'C:/work/`[a`] b``c' ")
  })

  test('wildcardEscape: the characters a wildcard pattern reads, each behind a backtick (WildcardPattern.Escape)', () => {
    expect(wildcardEscape('C:/work/new')).toBe('C:/work/new')
    expect(wildcardEscape("C:/a [1]/b*?/c`d o'k")).toBe("C:/a `[1`]/b`*`?/c``d o'k")
  })

  test('a prompt file or runs directory with [, ] or a backtick is refused before anything runs; the launch directory is not', () => {
    expect(powershellLaunchRefusal(ARGS, RUNS)).toBeUndefined()
    expect(powershellLaunchRefusal({ ...ARGS, dir: 'C:/work/[1] o`k' }, RUNS)).toBeUndefined()
    expect(powershellLaunchRefusal({ ...ARGS, prompt_file: "C:/tmp/o'k Jos\u00e9/p.md" }, "C:/r's \u00e9")).toBeUndefined()
    expect(powershellLaunchRefusal({ ...ARGS, prompt_file: 'C:/tmp/[x]/p.md' }, RUNS)).toBe(
      'refused: on the PowerShell launch route Start-Process reads the prompt file and the run files as wildcard patterns, and Windows PowerShell 5.1 and PowerShell 7 ' +
        'cannot both be given a path with [, ] or a backtick: the prompt file C:/tmp/[x]/p.md; move it to a path without them, or set the launchRoute option to bash',
    )
    expect(powershellLaunchRefusal({ ...ARGS, prompt_file: 'C:/tmp/a`b.md' }, 'C:/runs]')).toContain(': the prompt file C:/tmp/a`b.md and the runs directory C:/runs]; move it')
    expect(powershellLaunchRefusal(ARGS, 'C:/r [old]')).toContain(': the runs directory C:/r [old]; move it')
  })

  test('a model or effort with characters of its own is quoted for the command line and the PowerShell string alike', () => {
    const command = powershellLaunchCommand({ ...ARGS, model: `odd "model" x`, effort: "lo'w" }, { configDir: 'C:/c', isConfigInherited: true, name: 'w-new-1' }, RESULT, ERR)
    expect(command).toContain(`$env:CLAUDE_CODE_EFFORT_LEVEL = 'lo''w'`)
    const list = /-ArgumentList '(.*?)' -WorkingDirectory/.exec(command)?.[1] ?? ''
    expect(crtSplit(list.replace(/''/g, "'"))).toEqual(powershellLaunchArgs({ ...ARGS, model: `odd "model" x` }, { configDir: 'C:/c', name: 'w-new-1' }))
  })

  test('the pid file sits beside the result file; its content is read back as one pid', () => {
    expect(launchPidFile(RESULT)).toBe(`${RUNS}/20260921141320-new.pid`)
    expect(launchPidFile('C:/r/x')).toBe('C:/r/x.pid')
    expect(pidFromFile('7001\r\n')).toBe(7001)
    expect(pidFromFile('7001')).toBe(7001)
    for (const text of ['', '\r\n', 'abc', '-1', '0', '12 34', '7001x', '12345678901']) expect(pidFromFile(text)).toBeUndefined()
  })
})

describe('the adapter', () => {
  test('withPowerShellLaunch: the launch tool, command, hint and pid file are its own; every other member is the Windows adapter\'s', () => {
    const host = withPowerShellLaunch(windowsHost)
    expect(host.launchTool).toBe('PowerShell')
    expect(host.launchCommand).toBe(powershellLaunchCommand)
    expect(host.launchToolHint).toBe(POWERSHELL_TOOL_HINT)
    expect(host.launchPidFile(RESULT)).toBe(`${RUNS}/20260921141320-new.pid`)
    expect(host.launchRefusal).toBe(powershellLaunchRefusal)
    for (const name of HOST_MEMBERS.filter(name => !['launchTool', 'launchCommand', 'launchToolHint', 'launchPidFile', 'launchRefusal'].includes(name))) expect(host[name]).toBe(windowsHost[name])
    expect(POWERSHELL_TOOL_HINT).toBe(
      ' On Windows Claude Code offers the PowerShell tool by default only when it does not find Git Bash: start the orchestrator with CLAUDE_CODE_USE_POWERSHELL_TOOL=1, or set the launchRoute option to bash.',
    )
  })

  test('the Bash route\'s adapters write no pid file, and the helper keeps the route\'s launch members', () => {
    expect([windowsHost.launchPidFile(RESULT), posixHost.launchPidFile('/r/x.json')]).toEqual([undefined, undefined])
    expect([windowsHost.launchRefusal({ ...ARGS, prompt_file: 'C:/[x]/p.md' }, 'C:/[r]'), posixHost.launchRefusal({ ...ARGS, prompt_file: '/[x]/p.md' }, '/[r]')]).toEqual([undefined, undefined])
    expect([windowsHost.launchTool, posixHost.launchTool]).toEqual(['Bash', 'Bash'])
    const helped = withHelper(withPowerShellLaunch(windowsHost), { node: 'node', script: '/m/helper/host.mjs' })
    expect(helped.launchTool).toBe('PowerShell')
    expect(helped.launchCommand).toBe(powershellLaunchCommand)
    expect(helped.launchPidFile(RESULT)).toBe(`${RUNS}/20260921141320-new.pid`)
  })
})
