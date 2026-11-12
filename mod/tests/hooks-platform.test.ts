// Integration: the plugin's hooks against the engine's test kit, the hosts: Linux, Windows and the PowerShell launch
// route, the debug trace, and one probe at a time with the poll's rest. The world and its knobs are hooks-kit.ts'.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { probeArgs } from '../hooks/core'
import { TRACE_MAX_BYTES } from '../hooks/trace'

import { HOME, NOW_MS, ORCH_DIR, REGISTRY_PATH, REGISTRY_TEXT, SID_ALIVE, SID_DEAD, SID_DONE } from './fixtures'
import {
  bare,
  BIG_PROMPT,
  boot,
  DECISIONS,
  fixture,
  from,
  HELD,
  isTraceRun,
  lastRegistry,
  launchTool,
  LINUX_FIXTURE,
  mountPane,
  OPTIONS,
  pinned,
  POWERSHELL,
  PROBES,
  runCommand,
  stubPanel,
  TRACE,
  traceOf,
  WINDOWS,
  WORKER,
  world,
} from './hooks-kit'
import type { World } from './hooks-kit'

describe('platform', () => {
  const args = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  /** A launch, an acknowledgement and a retirement, the helper shown as <helper>. */
  const flow = async ($: Parameters<Parameters<typeof test>[2]>[0], w: World) => {
    await boot($)
    expect(String((await launchTool($, args)).result)).toContain('Launched pid 7001')
    expect(String((await $.tool.call({ tool: 'mcp__session-control__acknowledge_workers', session_ids: ['cccccccc'] } as never)).result)).toContain('Acknowledged: cccccccc.')
    expect(String((await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['dddddddd'] } as never)).result)).toContain('Retired: dddddddd.')
    return w.runs.map(pinned)
  }
  // The helper's operations, each one process: the probe, the registry's atomic write, the cleared log's append.
  const probe = ['node', '<helper>', 'probe']
  const rename = ['node', '<helper>', 'writeAtomic']
  /** The Node helper's one lookup, made when the board goes on, before anything that needs it. */
  const NODE_LOOKUP = ['node', '--version']
  const RUNS = `${HOME}/.claude/session-control/runs`
  /**
   * The commands the Linux flow runs (the jq calls aside): the lookup of Node first, then the probe, the registry's
   * rename and the cleared log's append through the helper.
   */
  const LINUX = [
    NODE_LOOKUP,
    ['test', '-e', `${ORCH_DIR}/agreed-decisions.md`],
    ['mkdir', '-p', ORCH_DIR],
    ['test', '-e', `${ORCH_DIR}/open-points-archive.md`],
    ['mkdir', '-p', ORCH_DIR],
    ['mkdir', '-p', `${ORCH_DIR}/backups`, RUNS],
    probe,
    rename,
    probe,
    ['test', '-s', '/work/new/prompt.md'],
    ['test', '-d', '/work/new'],
    ['/fixture/bin/pick', '--need', '40'],
    ['mkdir', '-p', RUNS],
    ['sleep', '2'],
    probe,
    rename,
    probe,
    probe,
    rename,
    probe,
    probe,
    ['node', '<helper>', 'append'],
    rename,
    probe,
  ]
  const linuxLike: [string, Record<string, string>][] = [
    ['HOME only', { HOME }],
    ['HOME and a Windows USERPROFILE (WSL)', { HOME, USERPROFILE: 'C:\\Users\\u' }],
    ['OS=Windows_NT without USERPROFILE', { HOME, OS: 'Windows_NT' }],
    ['OS=Windows_NT with a USERPROFILE that is no drive path', { HOME, OS: 'Windows_NT', USERPROFILE: '/mnt/c/Users/u' }],
  ]
  for (const [name, env] of linuxLike) {
    test(`Linux commands, unchanged: ${name}`, { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, env)
      expect(await flow($, w)).toEqual(LINUX)
    })
  }

  // The flow recorded with the trace off, for the test after it.
  const recorded: { off?: { runs: string[][]; writes: World['writes']; reads: string[]; bash: World['bash'] } } = {}
  test('Linux, the trace off: a launch, an acknowledgement and a retirement, recorded', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    expect(await flow($, w)).toEqual(LINUX)
    recorded.off = { runs: w.runs, writes: w.writes, reads: w.reads, bash: w.bash }
  })

  // The PowerShell route is native Windows' own: on Linux, and on WSL with Windows values in its environment, the
  // option changes nothing, down to the Bash tool's input.
  for (const [name, env] of [linuxLike[0], linuxLike[1]] as [string, Record<string, string>][]) {
    test(`Linux, launchRoute powershell: the same commands, writes, reads and Bash call as recorded without it (${name})`, { options: { ...OPTIONS, launchRoute: 'powershell' } }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, env)
      expect(await flow($, w)).toEqual(LINUX)
      expect(recorded.off).toBeDefined()
      expect(w.runs).toEqual(recorded.off?.runs ?? [])
      expect(w.writes).toEqual(recorded.off?.writes ?? [])
      expect(w.reads).toEqual(recorded.off?.reads ?? [])
      // The engine gives every call a tool_use_id of its own; the rest of the Bash tool's input is the same.
      const input = (calls: World['bash']) => calls.map(({ tool_use_id: _id, ...rest }: Record<string, unknown>) => rest)
      expect(input(w.bash)).toEqual(input(recorded.off?.bash ?? []))
      expect(w.bash.length).toBe(1)
      expect(w.powershell).toEqual([])
    })
  }

  test('Linux, the trace on: the same commands, writes and reads as with it off, less the trace appends', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on)
    const runs = await flow($, w)
    expect(runs.filter(isTraceRun).length).toBeGreaterThan(0)
    expect(runs.filter(argv => !isTraceRun(argv))).toEqual(LINUX)
    expect(recorded.off).toBeDefined()
    expect(w.runs.filter(argv => !isTraceRun(argv))).toEqual(recorded.off?.runs ?? [])
    expect(w.writes.filter(one => !one.path.endsWith('/trace.log'))).toEqual(recorded.off?.writes ?? [])
    expect(w.reads).toEqual(recorded.off?.reads ?? [])
  })

  const WINDOWS_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' }
  /** The Windows machine of the fixture, with `pick` the licence picker's output. */
  const winWorld = (on: On, pick = '/fixture/lic/a\n') => world(on, pick, true, REGISTRY_TEXT, WINDOWS_ENV)
  const WIN_OPTIONS = { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}` }
  const WIN_REGISTRY = `C:${REGISTRY_PATH}`
  const WIN_RUNS = `C:${RUNS}`

  test('Windows, the trace on: a poll tick with a failing probe writes its lines through the helper', { options: { ...WIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = winWorld(on)
    await boot($, `C:${ORCH_DIR}`)
    const trace = `${WIN_RUNS}/trace.log`
    expect(traceOf(w, trace)[0]).toMatchObject({ event: 'session.start', platform: 'windows' })
    WINDOWS.isProbeBroken = true
    try {
      const before = traceOf(w, trace).length
      await w.clock.advance(5000)
      // The probe's stderr is output: the trace has its size, and the error that quotes it has … in its place.
      const message = 'the process probe failed (exit 1): \u2026'
      const probe = [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${WIN_RUNS}/probe.ps1`, ...probeArgs(JSON.parse(REGISTRY_TEXT)), 'c:C:/fixture/home/.claude']
      expect(bare(traceOf(w, trace)).slice(before)).toEqual([
        { event: 'poll.tick' },
        { event: 'process.run', argv: probe, exitCode: 1, ms: 0, stderrBytes: 'Invalid class'.length },
        { event: 'error', where: 'refresh', kind: 'exit-1', message },
        { event: 'error', where: 'panel', kind: 'exit-1', message: `Error: ${message}` },
      ])
      expect(w.writes.filter(one => one.path === trace).some(one => one.text.includes('Invalid class'))).toBe(false)
      // Each flush is one helper batch, its append to the trace in the stored C:/ form.
      const flushes = w.calls.filter(one => one.op === 'batch')
      expect(flushes.length).toBeGreaterThan(1)
      expect(flushes.every(one => (one.request.ops as { op: string; path: string }[]).every(step => step.op === 'append' && step.path === trace))).toBe(true)
    } finally {
      WINDOWS.isProbeBroken = false
    }
  })

  test('Windows: a probe that fails is an error on the panel, and no worker is taken for dead', { options: WIN_OPTIONS }, async ($, on) => {
    WINDOWS.isProbeBroken = true
    try {
      const w = winWorld(on)
      await boot($, `C:${ORCH_DIR}`)
      expect(w.toasts).toEqual(['Tracking problem \u00B7 Error: the process probe failed (exit 1): Invalid class'])
      expect(w.writes.some(one => fixture(one.path).startsWith(REGISTRY_PATH))).toBe(false)
    } finally {
      WINDOWS.isProbeBroken = false
    }
  })

  /** A call that waits on $.clock.sleep: the mocked clock is moved on until it settles. */
  const settled = async <T>(w: World, pending: Promise<T>): Promise<T> => {
    let isDone = false
    void pending.then(
      () => (isDone = true),
      () => (isDone = true),
    )
    for (let step = 0; step < 90 && !isDone; step++) await w.clock.advance(1000)
    return pending
  }
  const winArgs = { dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  const WIN_HOME_CLAUDE = 'C:/fixture/home/.claude'
  const NO_PICKER = { ...WIN_OPTIONS, licencePickCommand: '' }

  test('Windows: the waits between the discovery checks are the helper\'s pause, never the engine\'s clock; a worker not seen in 30 s is answered as started, and the poll registers it when it shows', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.isWorkerHidden = true
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const before = w.calls.length
      // No settled(): nothing in the launch waits on the mocked clock.
      const out = await launchTool($, winArgs)
      expect(String(out.result)).toBe(
        'Started in the background, but no claude process for it appeared within 30 s: it is not registered yet. ' +
          "Check it with list_sessions: while it runs unregistered it is an orphan row (cwd C:/work/new); the mod's poll registers it as soon as it finds it " +
          '(up to 10 min after the launch), and its entry then takes the orphan row\'s place. ' +
          `If neither row appears, it did not start: read ${WIN_RUNS}/20260921141320-new.err. Result: ${WIN_RUNS}/20260921141320-new.json.`,
      )
      expect(w.calls.slice(before).filter(one => one.op === 'pause').map(one => one.request)).toEqual(Array.from({ length: 15 }, () => ({ ms: 2000 })))
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
      WINDOWS.isWorkerHidden = false
      await w.clock.advance(5000)
      // The poll looks in the launch's config dir too, and registers the worker as the launch would have.
      expect(w.runs.some(argv => String(argv[6]).endsWith('/probe.ps1') && argv.includes(`c:${WIN_HOME_CLAUDE}`))).toBe(true)
      expect(lastRegistry(w).at(-1)).toEqual({
        title: 'new',
        pid: 7001,
        session_id: 'abcdabcd-0000-4000-8000-000000000001',
        name: 'w-new-260921141320',
        config_dir: WIN_HOME_CLAUDE,
        cwd: 'C:/work/new',
        model: 'opus',
        effort: 'high',
        result_file: `${WIN_RUNS}/20260921141320-new.json`,
        err_file: `${WIN_RUNS}/20260921141320-new.err`,
        started_at: NOW_MS / 1000,
      })
    } finally {
      WINDOWS.isWorkerHidden = false
    }
  })

  test('Windows: an orchestrator with its own CLAUDE_CONFIG_DIR: no variable on the line, its dir in native form in the registry', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\a'
    try {
      const w = world(on, '', true, REGISTRY_TEXT, { ...WINDOWS_ENV, CLAUDE_CONFIG_DIR: 'C:\\fixture\\lic\\a\\' })
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
      expect(String(out.result)).toContain('config_dir C:/fixture/lic/a, registered.')
      expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, config_dir: 'C:/fixture/lic/a' })
    } finally {
      WINDOWS.workerConfigDir = 'C:\\fixture\\home\\.claude'
    }
  })

  test('Windows: without a Bash tool (Git Bash not found) the refusal says how to give the engine Git Bash', { options: NO_PICKER }, async ($, on) => {
    WORKER.isBashMissing = true
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await launchTool($, winArgs)
      expect(String(out.deny)).toContain('nothing was launched. On Windows Claude Code offers the Bash tool only when it finds Git Bash: start the orchestrator with CLAUDE_CODE_GIT_BASH_PATH set to Git\\bin\\bash.exe.')
      expect(w.bash.length).toBe(0)
    } finally {
      WORKER.isBashMissing = false
    }
  })

  // ---- the PowerShell launch route (the launchRoute option at powershell)
  const PS_OPTIONS = { ...NO_PICKER, launchRoute: 'powershell' }
  /** The PowerShell route's command for the fixture launch: its config line (none when inherited), arguments and files. */
  const psCommand = (config: string | undefined, argumentList: string, base: string, dir = 'C:/work/new', prompt = 'C:/work/new/prompt.md') =>
    [
      '$env:PSModulePath = "$PSHOME\\Modules"',
      "$ErrorActionPreference = 'Stop'",
      "$env:CLAUDE_CODE_EFFORT_LEVEL = 'high'",
      ...(config === undefined ? [] : [config]),
      '$exe = (Get-Command claude.exe -ErrorAction Stop).Source',
      `$p = Start-Process -FilePath $exe -ArgumentList '${argumentList}' -WorkingDirectory '${dir}' -RedirectStandardInput '${prompt}' ` +
        `-RedirectStandardOutput '${base}.json' -RedirectStandardError '${base}.err' -NoNewWindow -PassThru`,
      '$null = $p.Handle',
      `Set-Content -LiteralPath '${base}.pid' -Value $p.Id -Encoding Ascii`,
      '$p.WaitForExit()',
      'exit $p.ExitCode',
    ].join('\n')
  const PS_SETTINGS = '--settings "{\\"crossSessionInbound\\":\\"accept\\"}" --dangerously-skip-permissions --output-format json'

  test('Windows, launchRoute powershell: the worker starts through the PowerShell tool, Start-Process with the prompt on standard input; found and registered as by the Bash route', { options: PS_OPTIONS }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const out = await settled(w, launchTool($, winArgs))
    expect(String(out.result)).toBe(
      `Launched pid 7001, session abcdabcd-0000-4000-8000-000000000001, config_dir ${WIN_HOME_CLAUDE}, registered. ` +
        `Name: w-new-260921141320; socket: none. ` +
        `Result: ${WIN_RUNS}/20260921141320-new.json; errors: ${WIN_RUNS}/20260921141320-new.err.`,
    )
    expect(w.bash).toEqual([])
    expect(w.powershell.length).toBe(1)
    expect(w.powershell[0]).toMatchObject({ description: 'session-control worker: new', run_in_background: true, timeout: 180 * 60_000 })
    // No picker: the worker inherits the config dir, so no CLAUDE_CONFIG_DIR line.
    expect(w.powershell[0]?.command).toBe(psCommand(undefined, `-p --model opus -n w-new-260921141320 ${PS_SETTINGS}`, `${WIN_RUNS}/20260921141320-new`))
    expect(lastRegistry(w).at(-1)).toEqual({
      title: 'new',
      pid: 7001,
      session_id: 'abcdabcd-0000-4000-8000-000000000001',
      name: 'w-new-260921141320',
      config_dir: WIN_HOME_CLAUDE,
      cwd: 'C:/work/new',
      model: 'opus',
      effort: 'high',
      result_file: `${WIN_RUNS}/20260921141320-new.json`,
      err_file: `${WIN_RUNS}/20260921141320-new.err`,
      started_at: NOW_MS / 1000,
    })
    // The pid came from the probe, and the pid file was read beside it; every command is still one of the mod's scripts.
    expect(w.reads).toContain(`${WIN_RUNS}/20260921141320-new.pid`)
    expect(w.runs.every(argv => argv[0] === 'node' || (argv[0] === POWERSHELL && /\/(probe|files)\.ps1$/.test(String(argv[6]))))).toBe(true)
  })

  test('Windows, launchRoute powershell: a resume passes --resume after the model and sets the entry\'s config dir', { options: PS_OPTIONS }, async ($, on) => {
    const registry = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_DEAD ? { ...one, config_dir: 'C:/fixture/lic/b' } : one)))
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\b'
    try {
      const w = world(on, '', true, registry, WINDOWS_ENV)
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, { ...winArgs, resume_sid: SID_DEAD }))
      expect(String(out.result)).toContain(`Launched pid 7001, session ${SID_DEAD}, config_dir C:/fixture/lic/b`)
      expect(w.powershell[0]?.command).toBe(psCommand("$env:CLAUDE_CONFIG_DIR = 'C:/fixture/lic/b'", `-p --model opus --resume ${SID_DEAD} -n w-new-260921141320 ${PS_SETTINGS}`, `${WIN_RUNS}/20260921141320-new`))
    } finally {
      WINDOWS.workerConfigDir = 'C:\\fixture\\home\\.claude'
    }
  })

  test('Windows: an inline prompt that starts like a POSIX path is refused, as a prompt file would be, and nothing is written', { options: NO_PICKER }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const { prompt_file: _file, ...inline } = winArgs
    const out = await launchTool($, { ...inline, prompt: '/c/work/x: wait in the foreground, git status -sb, no attribution' })
    expect(String(out.deny)).toContain('Git Bash rewrites an argument that starts like a POSIX path')
    expect(w.writes.some(one => one.path.endsWith('.prompt.md'))).toBe(false)
  })

  test('Windows, launchRoute powershell: an inline prompt goes to standard input from the prompt file of the mod', { options: PS_OPTIONS }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const { prompt_file: _file, ...inline } = winArgs
    const out = await settled(w, launchTool($, { ...inline, prompt: 'Goal: x. Wait in the foreground. Report git status -sb. No attribution.' }))
    const own = `${WIN_RUNS}/w-new-260921141320.prompt.md`
    expect(String(out.result)).toContain(`Prompt: ${own} (written by the mod).`)
    expect(w.powershell[0]?.command).toBe(psCommand(undefined, `-p --model opus -n w-new-260921141320 ${PS_SETTINGS}`, `${WIN_RUNS}/20260921141320-new`, 'C:/work/new', own))
  })

  test('Windows, launchRoute powershell: a runs directory with brackets is refused too; the Bash route takes it', { options: { ...PS_OPTIONS, runsDir: 'C:/fixture/runs [old]' } }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const out = await launchTool($, winArgs)
    expect(String(out.deny)).toContain('cannot both be given a path with [, ] or a backtick: the runs directory C:/fixture/runs [old]; move it')
    expect(w.powershell.length).toBe(0)
  })

  test('Windows, launchRoute powershell: a pid file naming another pid is said in the answer; the probe\'s pid is the one registered', { options: PS_OPTIONS }, async ($, on) => {
    WINDOWS.pidFileText = '7002\r\n'
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
      expect(String(out.result)).toEndWith(`errors: ${WIN_RUNS}/20260921141320-new.err. The launch's pid file names pid 7002, not the one the probe found.`)
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001 })
    } finally {
      WINDOWS.pidFileText = '7001\r\n'
    }
  })

  test('Windows, launchRoute powershell: no pid file (not written yet, or unreadable) changes nothing', { options: PS_OPTIONS }, async ($, on) => {
    WINDOWS.pidFileText = undefined
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
      expect(String(out.result)).toEndWith(`errors: ${WIN_RUNS}/20260921141320-new.err.`)
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001 })
    } finally {
      WINDOWS.pidFileText = '7001\r\n'
    }
  })

  test('Windows, launchRoute powershell, the trace on: the start names the route; the worker line says whether the pid file agrees', { options: { ...PS_OPTIONS, debug: true } }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    await settled(w, launchTool($, winArgs))
    const lines = traceOf(w, `${WIN_RUNS}/trace.log`)
    expect((lines.find(line => line.event === 'session.start') as { options?: Record<string, unknown> }).options?.launchRoute).toBe('powershell')
    expect(lines.find(line => line.event === 'worker.found')).toMatchObject({ pid: 7001, pidFile: 'same' })
  })

  test('Windows: a launchRoute other than powershell is the Bash route', { options: { ...NO_PICKER, launchRoute: 'pwsh' } }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    await settled(w, launchTool($, winArgs))
    expect(w.powershell).toEqual([])
    expect(String(w.bash[0]?.command)).toStartWith(`cd 'C:/work/new' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' `)
    expect(w.reads.some(path => path.endsWith('.pid'))).toBe(false)
  })

  test('Windows: a new claude.exe whose sessions file the probe found nowhere is still the worker', { options: NO_PICKER }, async ($, on) => {
    WINDOWS.isWorkerUnplaced = true
    try {
      const w = winWorld(on, '')
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, winArgs))
      expect(String(out.result)).toContain('Launched pid 7001, session abcdabcd-0000-4000-8000-000000000001')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, cwd: 'C:/work/new', config_dir: WIN_HOME_CLAUDE })
    } finally {
      WINDOWS.isWorkerUnplaced = false
    }
  })

  test('Windows: a picker named by absolute path runs, and its answer is taken in native form', { options: { ...WIN_OPTIONS, licencePickCommand: 'C:/fixture/bin/pick.exe --need {need}' } }, async ($, on) => {
    WINDOWS.workerConfigDir = 'C:\\fixture\\lic\\a'
    try {
      const w = winWorld(on)
      await boot($, `C:${ORCH_DIR}`)
      const out = await settled(w, launchTool($, { ...winArgs, need: 25 }))
      expect(w.runs).toContainEqual(['C:/fixture/bin/pick.exe', '--need', '25'])
      expect(String(out.result)).toContain('config_dir C:/fixture/lic/a, registered')
      expect(String(w.bash[0]?.command)).toContain("CLAUDE_CONFIG_DIR='C:/fixture/lic/a'")
    } finally {
      WINDOWS.workerConfigDir = 'C:\\fixture\\home\\.claude'
    }
  })

  test('Windows: a picker by bare name is refused before anything runs', { options: { ...WIN_OPTIONS, licencePickCommand: 'pick --need {need}' } }, async ($, on) => {
    const w = winWorld(on)
    await boot($, `C:${ORCH_DIR}`)
    const out = await launchTool($, winArgs)
    expect(String(out.deny)).toBe('session-control: refused: on Windows the licence picker command must start with the absolute path of an executable (C:/.../picker.exe), not "pick"')
    expect(w.runs.some(argv => argv[0] === 'pick')).toBe(false)
    expect(w.bash.length).toBe(0)
  })

  test('Windows: a prompt too long for the command line is refused, a POSIX path too', { options: NO_PICKER }, async ($, on) => {
    const w = winWorld(on, '')
    await boot($, `C:${ORCH_DIR}`)
    const big = await launchTool($, { ...winArgs, prompt_file: '/c/work/new/big.md' })
    expect(String(big.deny)).toContain(`it has ${BIG_PROMPT.length}, the limit is 30000`)
    const posix = await launchTool($, { ...winArgs, dir: '/tmp/new' })
    expect(String(posix.deny)).toBe('session-control: dir must be absolute (on Windows /c/... or C:/...)')
    const gone = await launchTool($, { ...winArgs, dir: '/c/work/gone' })
    expect(String(gone.deny)).toBe('session-control: refused: directory C:/work/gone does not exist')
    expect(w.bash.length).toBe(0)
  })

  test('Windows: an empty prompt file is told by $.fs.stat', { options: NO_PICKER }, async ($, on) => {
    const w = world(on, '', false, REGISTRY_TEXT, WINDOWS_ENV)
    await boot($, `C:${ORCH_DIR}`)
    expect(String((await launchTool($, winArgs)).deny)).toBe('session-control: refused: prompt file C:/work/new/prompt.md is missing or empty')
    expect(w.bash.length).toBe(0)
  })

  test('Windows: a session\'s output box reads its transcript through the helper', { options: WIN_OPTIONS }, async ($, on) => {
    const w = winWorld(on)
    stubPanel(on)
    await boot($, `C:${ORCH_DIR}`)
    await runCommand($, '')
    const ui = await mountPane($)
    await ui.press({ key: `s:${SID_ALIVE}` })
    expect(await ui.find({ type: 'Text', text: /Reading the suite files/ })).toBeDefined()
    expect(w.calls).toContainEqual({ op: 'tail', request: { path: `/fixture/lic/a/projects/-work-a/${SID_ALIVE}.jsonl`, lines: 600, width: 20000 } })
  })

  test('Windows: a HOME that Git Bash handed on (/c/...) is home, in native form', { options: WIN_OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { ...WINDOWS_ENV, USERPROFILE: 'C:\\Users\\other', HOME: '/c/fixture/home' })
    await boot($, `C:${ORCH_DIR}`)
    expect(w.calls.some(one => one.op === 'writeAtomic' && one.request.path === WIN_REGISTRY)).toBe(true)
  })

  test('Windows: a registry write the helper fails is said in the answer, and nothing writes the registry another way', { options: WIN_OPTIONS }, async ($, on) => {
    const w = winWorld(on)
    await boot($, `C:${ORCH_DIR}`)
    WINDOWS.isMoveBroken = true
    try {
      const before = w.writes.length
      const out = await $.tool.call({ tool: 'mcp__session-control__acknowledge_workers', session_ids: ['cccccccc'] } as never)
      expect(JSON.stringify(out)).toContain(`${WIN_REGISTRY} could not be written (ACCESS)`)
      expect(w.writes.slice(before).filter(one => fixture(one.path).startsWith(REGISTRY_PATH))).toEqual([])
      expect(w.toasts.filter(text => text.includes('not atomically'))).toEqual([])
    } finally {
      WINDOWS.isMoveBroken = false
    }
  })
})

describe('debug trace', () => {
  const args = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  // The call's line: the title is free text and stays out.
  const { title: _title, ...called } = args
  const PICK = { event: 'process.run', picker: 'pick', args: 2, exitCode: 0, ms: 0 }
  const TRACED = { ...OPTIONS, debug: true }
  const RUNS = `${HOME}/.claude/session-control/runs`
  const ran = (argv: string[], exitCode = 0) => ({ event: 'process.run', argv, exitCode, ms: 0 })
  /** A helper call as the trace shows it: the operation and the fields the call names, never the request. */
  const helper = (op: string, fields: Record<string, unknown>, exitCode = 0) => ({ event: 'process.run', helper: op, ...fields, exitCode, ms: 0 })
  const PROBE = helper('probe', { args: probeArgs(JSON.parse(REGISTRY_TEXT)).length })
  const REGISTRY_WRITE = helper('writeAtomic', { path: REGISTRY_PATH })

  test('a launch: the call, the probe, the checks, the verdict, the worker and its registration, the answer', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, args)
    const stamp = new Date(NOW_MS).toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const sid = 'abcdabcd-0000-4000-8000-000000000001'
    expect(from(bare(traceOf(w)), 'tool.call')).toEqual([
      { event: 'tool.call', tool: 'launch_worker', ...called },
      PROBE,
      ran(['test', '-s', '/work/new/prompt.md']),
      ran(['test', '-d', '/work/new']),
      PICK,
      { event: 'guard', tool: 'launch_worker', isOk: true, configDir: '/fixture/lic/a' },
      ran(['mkdir', '-p', RUNS]),
      { event: 'worker.start', configDir: '/fixture/lic/a', isConfigDirSet: true, resultFile: `${RUNS}/${stamp}-new.json`, errFile: `${RUNS}/${stamp}-new.err`, timeoutMs: 180 * 60_000 },
      ran(['sleep', '2']),
      PROBE,
      { event: 'worker.found', pid: 7001, sessionId: sid, isNamed: true, isSocketSeen: true },
      REGISTRY_WRITE,
      { event: 'worker.registered', pid: 7001, sessionId: sid, isRegistered: true },
      PROBE,
      { event: 'tool.result', tool: 'launch_worker', result: String(out.result) },
    ])
    // The trace is written in one append per hook: session.start's and the launch's.
    expect(w.runs.filter(isTraceRun).length).toBe(2)
    // Neither the title nor the picker's command line is in it.
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('"title"') || one.text.includes('/fixture/bin/pick'))).toBe(false)
  })

  test('a launch without a picker: options say empty, the verdict names the default dir, the worker line sets no variable', { options: { ...TRACED, licencePickCommand: '' } }, async ($, on) => {
    WORKER.linuxConfigDir = ''
    try {
      const w = world(on, '')
      await boot($)
      await launchTool($, args)
      const lines = bare(traceOf(w))
      expect((lines.find(one => one.event === 'session.start') as { options?: { licencePickCommand?: string } }).options?.licencePickCommand).toBe('empty')
      expect(lines.find(one => one.event === 'tool.call')).toEqual({ event: 'tool.call', tool: 'launch_worker', ...called })
      expect(lines.find(one => one.event === 'guard')).toEqual({ event: 'guard', tool: 'launch_worker', isOk: true, configDir: `${HOME}/.claude` })
      expect(lines.find(one => one.event === 'worker.start')).toMatchObject({ event: 'worker.start', configDir: `${HOME}/.claude`, isConfigDirSet: false })
      expect(lines.some(one => one.event === 'process.run' && 'picker' in one)).toBe(false)
    } finally {
      WORKER.linuxConfigDir = '/fixture/lic/a'
    }
  })

  test('the start: platform, options and the activation, no environment', { options: TRACED }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SECRET_THING: ['sk', 'should-never-appear-1234'].join('-') })
    await boot($)
    const [first] = bare(traceOf(w))
    expect(first).toEqual({
      event: 'session.start',
      cwd: ORCH_DIR,
      platform: 'linux',
      isOrchestratorDir: true,
      options: {
        orchestratorDir: ORCH_DIR,
        registryPath: '~/.claude/headless-sessions.json',
        completionWrites: true,
        pollSeconds: 5,
        runsDir: '~/.claude/session-control/runs',
        licencePickCommand: 'set',
        debug: true,
        nodePath: '',
        launchRoute: 'bash',
        notices: 'on',
        desktopPaneScroll: 'spare',
        desktopStyle: 'tint-soft',
        desktopIcons: 'text',
        desktopPreview: 'off',
        desktopGap: 2,
        desktopButtons: 'outline',
        desktopFont: 'accent',
        desktopAnimation: 'off',
      },
    })
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('sk-should') || one.text.includes(HOME + '"') || one.text.includes('/fixture/bin/pick'))).toBe(false)
  })

  test('a refused launch: the verdict with its reason, and the refusal the model gets', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    await launchTool($, { ...args, dir: ORCH_DIR })
    expect(from(bare(traceOf(w)), 'tool.call')).toEqual([
      { event: 'tool.call', tool: 'launch_worker', ...called, dir: ORCH_DIR },
      PROBE,
      ran(['test', '-s', '/work/new/prompt.md']),
      ran(['test', '-d', ORCH_DIR]),
      PICK,
      { event: 'guard', tool: 'launch_worker', isOk: false, reason: 'refused: cwd is the orchestrator dir' },
      { event: 'tool.result', tool: 'launch_worker', deny: 'session-control: refused: cwd is the orchestrator dir' },
    ])
  })

  test('a retire: the verdict, the cleared-log append by size, the registry write, the answer', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['dddddddd'] } as never)
    const doneLine = JSON.stringify(JSON.parse(REGISTRY_TEXT).find((one: { session_id?: string }) => one.session_id === SID_DONE))
    expect(from(bare(traceOf(w)), 'tool.call')).toEqual([
      { event: 'tool.call', tool: 'retire_workers', session_ids: ['dddddddd'] },
      PROBE,
      { event: 'guard', tool: 'retire_workers', removable: [SID_DONE], refused: [] },
      helper('append', { path: `${RUNS}/cleared.jsonl` }),
      { event: 'fs.append', path: `${RUNS}/cleared.jsonl`, bytes: doneLine.length + 1, lines: 1, exitCode: 0 },
      REGISTRY_WRITE,
      PROBE,
      { event: 'tool.result', tool: 'retire_workers', result: 'Retired: dddddddd.' },
    ])
    // The entry's content is in the cleared log, never in the trace.
    expect(w.writes.filter(one => one.path === TRACE).some(one => one.text.includes('done worker'))).toBe(false)
  })

  test('the write-side tools in the trace: an inline prompt, a section heading and archived headings never reach it', { options: TRACED }, async ($, on) => {
    DECISIONS.text = '# Agreed decisions\n\n## Secret unit heading\nsu-1. x\n'
    try {
      const w = world(on)
      await boot($)
      await launchTool($, { dir: '/work/new', model: 'opus', effort: 'high', title: 'new', prompt: 'Reply PONG about the zebra-canary.', section: 'Secret unit heading', rules: true })
      await $.tool.call({ tool: 'mcp__session-control__archive_decisions', sections: ['Secret unit heading'] } as never)
      await $.tool.call({ tool: 'mcp__session-control__close_worker', session_ids: ['dddddddd'], keep: true } as never)
      const lines = from(bare(traceOf(w)), 'tool.call')
      const calls = lines.filter(line => line.event === 'tool.call')
      expect(calls).toEqual([
        { event: 'tool.call', tool: 'launch_worker', dir: '/work/new', model: 'opus', effort: 'high', rules: true },
        { event: 'tool.call', tool: 'archive_decisions' },
        { event: 'tool.call', tool: 'close_worker', session_ids: ['dddddddd'], keep: true },
      ])
      expect(lines).toContainEqual({ event: 'launch.prompt', promptFile: `${HOME}/.claude/session-control/runs/w-new-260921141320.prompt.md`, chars: expect.any(Number), isInline: true, isSectionAdded: true, isRulesAdded: true } as never)
      const text = w.writes.filter(one => one.path === TRACE).map(one => one.text).join('')
      expect(text).not.toContain('zebra-canary')
      expect(text).not.toContain('Secret unit heading')
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('a reviewed retire: the guard line names the original outcome and the reason, the call line keeps free text out', { options: TRACED }, async ($, on) => {
    const login = { title: 'stuck login', session_id: '57575751-0000-4000-8000-000000000001', config_dir: '/fixture/lic/a', reported: true, outcome: { kind: 'login', summary: 'login: old label' } }
    const w = world(on, '/fixture/lic/a\n', true, JSON.stringify([...JSON.parse(REGISTRY_TEXT), login]))
    await boot($)
    await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: ['57575751'], reviewed: { '57575751': 'wrong label' } } as never)
    const events = from(bare(traceOf(w)), 'tool.call')
    expect(events[0]).toEqual({ event: 'tool.call', tool: 'retire_workers', session_ids: ['57575751'] })
    expect(events).toContainEqual({ event: 'guard', tool: 'retire_workers', removable: [login.session_id], refused: [], reviewed: [{ session_id: login.session_id, was: 'login', reason: 'wrong label' }] })
    expect(events.at(-1)).toEqual({ event: 'tool.result', tool: 'retire_workers', result: 'Retired: 57575751. Retired with review: 57575751 (was login: wrong label).' })
  })

  test('a poll tick with a failing probe: the tick, the failed run, the error caught, the warning; renders are counted', { options: TRACED }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, '')
    const ui = await mountPane($)
    await ui.findAll({})
    LINUX_FIXTURE.isProbeBroken = true
    try {
      const before = traceOf(w).length
      await w.clock.advance(5000)
      const tick = bare(traceOf(w)).slice(before)
      // The helper's probe answers a fixed code; the mod says the probe failed, never what the system said.
      const message = 'the process probe failed (IO)'
      expect(tick).toEqual([
        { event: 'ui.render', count: 1 },
        { event: 'poll.tick' },
        { ...PROBE, exitCode: 1 },
        { event: 'helper.failed', op: 'probe', code: 'IO' },
        { event: 'error', where: 'refresh', message },
        { event: 'error', where: 'panel', message: `Error: ${message}` },
      ])
    } finally {
      LINUX_FIXTURE.isProbeBroken = false
    }
  })

  test('SESSION_CONTROL_DEBUG=1 switches it on; otherwise nothing is written and no trace command runs', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SESSION_CONTROL_DEBUG: '1' })
    await boot($)
    expect(traceOf(w)[0]?.event).toBe('session.start')
  })

  test('an environment that cannot be read leaves the trace off and the start goes on', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME }, true)
    let isAsked = false
    on('env.get', ($, e) => {
      if (!JSON.stringify(e).includes('SESSION_CONTROL_DEBUG')) return { value: JSON.stringify(e).includes('"HOME"') ? HOME : undefined } as never
      isAsked = true
      throw new Error('the environment cannot be read')
    })
    await boot($)
    expect(isAsked).toBe(true)
    expect(w.registered).toContain('launch_worker')
    expect(w.writes.some(one => one.path.includes('trace.log'))).toBe(false)
    expect(w.runs.some(isTraceRun)).toBe(false)
  })

  // A worker inherits SESSION_CONTROL_DEBUG; with the debug option on a machine the option is on for every session.
  for (const [name, options, env] of [
    ['SESSION_CONTROL_DEBUG=1', OPTIONS, { HOME, SESSION_CONTROL_DEBUG: '1' }],
    ['the debug option', TRACED, { HOME }],
    ['the debug option, no orchestratorDir option', { ...TRACED, orchestratorDir: '' }, { HOME }],
  ] as const) {
    test(`outside the orchestrator directory nothing is traced and no runs directory is made: ${name}`, { options }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, env)
      await boot($, '/work/new')
      expect(w.runs).toEqual([])
      expect(w.writes).toEqual([])
      expect(w.registered).toEqual(['/session-control'])
    })
  }

  test('/session-control turns the board on elsewhere: the trace starts there, with the start line', { options: TRACED }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($, '/work/elsewhere')
    expect(w.writes.some(one => one.path === TRACE)).toBe(false)
    await runCommand($, '')
    const [first, second] = bare(traceOf(w))
    expect(first).toMatchObject({ event: 'session.start', cwd: '/work/elsewhere', isOrchestratorDir: false })
    expect(second).toEqual({ event: 'command.run', command: 'session-control' })
  })

  test('off by default: no trace file, no trace command', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { HOME, SESSION_CONTROL_DEBUG: '0' })
    await boot($)
    await launchTool($, args)
    expect(w.writes.some(one => one.path.includes('trace.log'))).toBe(false)
    expect(w.runs.some(isTraceRun)).toBe(false)
  })

  test('a trace that cannot be written breaks nothing and is toasted once', { options: TRACED }, async ($, on) => {
    LINUX_FIXTURE.isAppendBroken = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('Launched pid 7001')
      expect(w.toasts.filter(text => text.includes('debug trace cannot be written'))).toEqual([
        'Debug trace failed \u00B7 the debug trace cannot be written (/fixture/home/.claude/session-control/runs/trace.log cannot be appended to (READ_ONLY)); the mod goes on without it',
      ])
    } finally {
      LINUX_FIXTURE.isAppendBroken = false
    }
  })

  test('a trace near 2 MiB is rotated once before the next append', { options: TRACED }, async ($, on) => {
    LINUX_FIXTURE.traceSize = TRACE_MAX_BYTES - 10
    try {
      const w = world(on)
      await boot($)
      await launchTool($, args)
      const steps = (one: { request: Record<string, unknown> }) => one.request.ops as Record<string, unknown>[]
      const rotations = w.calls.filter(one => one.op === 'batch' && steps(one).some(step => step.op === 'rotate'))
      // The helper reads the size again itself: it gets the limit and the bytes about to go in, then the append follows
      // in the same batch.
      expect(rotations.length).toBe(1)
      const [rotate, append] = steps(rotations[0] ?? { request: {} })
      expect(rotate).toMatchObject({ op: 'rotate', path: TRACE, maxBytes: TRACE_MAX_BYTES, moves: [[`${TRACE}.1`, `${TRACE}.2`], [TRACE, `${TRACE}.1`]] })
      expect(Number(rotate?.adding)).toBeGreaterThan(10)
      expect(append).toMatchObject({ op: 'append', path: TRACE })
    } finally {
      LINUX_FIXTURE.traceSize = 0
    }
  })
})

// ---------------------------------------------------------------- the probe's limits on a slow machine (decision mod-28)

describe('one probe at a time, the poll\'s rest and the tracking toast per episode', () => {
  const LIST = 'mcp__session-control__list_sessions'
  const TRACED = { ...OPTIONS, debug: true }
  const probes = (w: World) => w.calls.filter(one => one.op === 'probe').length

  test('a poll tick during a probe skips its refresh', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    let release = () => {}
    HELD.probe = new Promise<void>(resolve => {
      release = resolve
    })
    try {
      const before = probes(w)
      const first = $.tool.call({ tool: LIST } as never)
      await w.clock.advance(5000)
      expect(probes(w)).toBe(before + 1)
      expect(traceOf(w).filter(line => line.event === 'poll.skip').map(line => line.isProbing)).toContain(true)
      release()
      HELD.probe = undefined
      expect(String(((await first) as { result?: unknown }).result)).toStartWith('7 session rows: 1 running, ')
      expect(PROBES.max).toBe(1)
    } finally {
      release()
      HELD.probe = undefined
    }
  })

  test('Windows: two tools at once probe one after the other, the second waiting in the helper\'s short pauses: never two probes at once', { options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}` } }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' })
    await boot($, `C:${ORCH_DIR}`)
    WINDOWS.probeMs = 3000
    try {
      const before = w.calls.length
      const answers = await Promise.all([$.tool.call({ tool: LIST } as never), $.tool.call({ tool: LIST } as never)])
      for (const one of answers) expect(String((one as { result?: unknown }).result)).toMatch(/^\d+ session rows: /)
      expect(PROBES.max).toBe(1)
      expect(w.calls.slice(before).some(one => one.op === 'pause' && one.request.ms === 250)).toBe(true)
    } finally {
      WINDOWS.probeMs = 0
    }
  })

  test('after a probe longer than the poll interval the poll rests as long again from its end; then it probes as before', { options: TRACED }, async ($, on) => {
    const w = world(on)
    await boot($)
    LINUX_FIXTURE.probeMs = 12_000
    try {
      const before = probes(w)
      await w.clock.advance(5000)
      LINUX_FIXTURE.probeMs = 0
      expect(probes(w)).toBe(before + 1)
      const rested = traceOf(w).filter(line => line.event === 'poll.skip' && Number(line.restMs) > 0)
      for (let step = 0; step < 2; step++) await w.clock.advance(5000)
      expect(traceOf(w).filter(line => line.event === 'poll.skip' && Number(line.restMs) > 0).length).toBeGreaterThan(rested.length)
      const atRestEnd = probes(w)
      expect(atRestEnd).toBe(before + 1)
      for (let step = 0; step < 4; step++) await w.clock.advance(5000)
      expect(probes(w)).toBeGreaterThan(atRestEnd)
    } finally {
      LINUX_FIXTURE.probeMs = 0
    }
  })

  test('a probe that fails now and then is one episode, one tracking toast; the same problem again after 10 minutes without it is toasted again', { options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}` } }, async ($, on) => {
    const tracking = (w: World) => w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 '))
    WINDOWS.isProbeBroken = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' })
      await boot($, `C:${ORCH_DIR}`)
      expect(tracking(w)).toEqual(['Tracking problem \u00B7 Error: the process probe failed (exit 1): Invalid class'])
      WINDOWS.isProbeBroken = false
      await w.clock.advance(5000)
      WINDOWS.isProbeBroken = true
      await w.clock.advance(5000)
      WINDOWS.isProbeBroken = false
      await w.clock.advance(5000)
      WINDOWS.isProbeBroken = true
      await w.clock.advance(5000)
      expect(tracking(w).length).toBe(1)
      // Ten minutes and more without it: a new episode.
      WINDOWS.isProbeBroken = false
      for (let step = 0; step < 122; step++) await w.clock.advance(5000)
      WINDOWS.isProbeBroken = true
      await w.clock.advance(5000)
      expect(tracking(w).length).toBe(2)
    } finally {
      WINDOWS.isProbeBroken = false
    }
  })
})
