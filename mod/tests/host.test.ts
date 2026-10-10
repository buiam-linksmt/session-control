// The host interface: one contract run against both adapters, and the one platform choice.
//
// The machine is simulated once (files in a map, the commands each adapter runs answered as that system would) and
// stands beneath the plugins as the mock engine's fs, process and env hooks. The contract calls the adapters over a
// HostPort on that same machine: the kit's test `$` has no fs or process noun, and an inline plugin runs in a realm
// of its own, so a port over a plugin's `$` cannot be handed to the test. The selection tests go through the plugin
// itself, on the mock engine.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsStat, On } from 'claude-code'

import { tailLines } from '../hooks/core'
import { HOST_MEMBERS, selectHost } from '../hooks/host'
import type { Host, HostPort } from '../hooks/host'
import { APPEND_SCRIPT, PROBE_SCRIPT, ROTATE_SCRIPT, posixHost } from '../hooks/host-posix'
import { FILES_PS1, PROBE_PS1, windowsHost } from '../hooks/host-windows'
import { NOW_MS } from './fixtures'

type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

const SID = '11111111-2222-4333-8444-555555555555'
const ran = (stdout = '', exitCode = 0, stderr = ''): Ran => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

/** A path as the adapter gave it: the kit resolves C:/x after the session's directory on a Linux host. */
const keyOf = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')

/** What a /proc probe (Linux) or a Win32_Process probe (Windows) prints for one new headless worker and one transcript. */
const probeOutput = (work: string, cfg: string, cmd: string) => `P\t4242\tclaude\t3\t${work}\t${cfg}\t${cmd}\nT\t${SID}\t1700000000\n`

type Machine = {
  env: Record<string, string>
  files: Map<string, string>
  runs: string[][]
  /** Milliseconds waited on the engine's clock. */
  sleeps: number[]
  read(path: string): string
  exists(path: string): boolean
  stat(path: string): FsStat
  run(argv: readonly string[]): Ran
}

/** The simulated machine: its files and the commands both adapters run, answered as the system would. */
function machine(env: Record<string, string>): Machine {
  const files = new Map<string, string>()
  const runs: string[][] = []
  const isDir = (path: string) => [...files.keys()].some(file => file.startsWith(`${keyOf(path).replace(/\/+$/, '')}/`))
  const move = (from: string, to: string) => {
    const text = files.get(keyOf(from))
    if (text === undefined) return false
    files.set(keyOf(to), text)
    files.delete(keyOf(from))
    return true
  }
  const read = (path: string) => {
    const text = files.get(keyOf(path))
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  }
  const stat = (path: string): FsStat => {
    const text = files.get(keyOf(path))
    const base = { mtimeMs: NOW_MS, isLink: false }
    if (text !== undefined) return { ...base, kind: 'file', size: text.length } as FsStat
    if (isDir(path)) return { ...base, kind: 'dir', size: 0 } as FsStat
    throw new Error(`ENOENT ${path}`)
  }
  const run = (given: readonly string[]): Ran => {
    const argv = given.map(String)
    runs.push(argv)
    const [cmd, , script] = argv
    if (cmd === 'rm') {
      files.delete(keyOf(argv[2] ?? ''))
      return ran()
    }
    if (cmd === 'mv') return move(argv[2] ?? '', argv[3] ?? '') ? ran() : ran('', 1, 'mv: cannot stat')
    if (cmd === 'mkdir' || cmd === 'sleep') return ran()
    if (cmd === 'test') {
      const path = argv[2] ?? ''
      const isThere = argv[1] === '-d' ? isDir(path) : argv[1] === '-s' ? (files.get(keyOf(path)) ?? '').length > 0 : files.has(keyOf(path)) || isDir(path)
      return ran('', isThere ? 0 : 1)
    }
    if (cmd === 'sh' && script === APPEND_SCRIPT) {
      const path = keyOf(argv[5] ?? '')
      files.set(path, `${files.get(path) ?? ''}${argv[4]}\n`)
      return ran()
    }
    if (cmd === 'sh' && script === PROBE_SCRIPT) return ran(probeOutput('/m/work', '/m/cfg', 'claude -p --model opus --output-format json -- Goal: x'))
    if (cmd === 'sh' && script?.startsWith('tail -n 600 ')) {
      const text = files.get(keyOf(argv[4] ?? ''))
      return text === undefined ? ran('', 1) : ran(tailLines(text, 600, 20000))
    }
    if (cmd === 'sh' && script === ROTATE_SCRIPT) {
      const path = argv[4] ?? ''
      move(`${path}.1`, `${path}.2`)
      move(path, `${path}.1`)
      return ran()
    }
    if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/files.ps1')) {
      expect(files.get(keyOf(argv[6]))).toBe(FILES_PS1)
      const [op, a = '', b = '', c = ''] = argv.slice(7)
      if (op === 'move') return move(a, b) ? ran() : ran('', 1, 'not found')
      if (op === 'remove') {
        files.delete(keyOf(a))
        return ran()
      }
      if (op === 'append') {
        files.set(keyOf(b), `${files.get(keyOf(b)) ?? ''}${files.get(keyOf(a)) ?? ''}`)
        files.delete(keyOf(a))
        return ran()
      }
      if (op === 'tail') {
        const text = files.get(keyOf(a))
        return text === undefined ? ran('', 1, 'not found') : ran(tailLines(text, Number(b), Number(c)))
      }
    }
    if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/probe.ps1')) {
      expect(files.get(keyOf(argv[6]))).toBe(PROBE_PS1)
      const out = probeOutput('C:\\m\\work', 'C:\\m\\cfg', '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus --output-format json -- "Goal: x"')
      return ran(out.replace(/\n/g, '\r\n'))
    }
    throw new Error(`unexpected command ${argv.join(' ')}`)
  }
  return { env, files, runs, sleeps: [], read, exists: path => files.has(keyOf(path)) || isDir(path), stat, run }
}

/** The machine beneath the plugins: the mock engine's fs, process, env and clock hooks answer from it. */
function mount(on: On, m: Machine): void {
  mock.clock(on, { now: NOW_MS })
  mock.env(on, m.env)
  on('fs.read', ($, e) => ({ value: m.read(e.path) }))
  on('fs.write', ($, e) => {
    m.files.set(keyOf(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: m.exists(e.path) }))
  on('fs.stat', ($, e) => ({ value: m.stat(e.path) }))
  on('process.run', ($, e) => ({ value: m.run(e.argv) }))
}

/** A HostPort on the machine, as register.tsx's port is on the engine (untraced). */
function portOf(m: Machine, runsDir: string, notes: string[] = []): HostPort {
  return {
    run: async argv => m.run(argv),
    read: async path => m.read(path),
    write: async (path, text) => {
      m.files.set(keyOf(path), text)
    },
    exists: async path => m.exists(path),
    stat: async path => m.stat(path),
    now: async () => NOW_MS,
    sleep: async ms => {
      m.sleeps.push(ms)
    },
    env: async name => m.env[name],
    runsDir: async () => runsDir,
    traceError: () => undefined,
    noteDirectWrite: text => {
      notes.push(text)
    },
  }
}

type Case = { host: Host; platform: 'linux' | 'windows'; env: Record<string, string>; root: string; home: string }

const CASES: Case[] = [
  { host: posixHost, platform: 'linux', env: { HOME: '/m/home' }, root: '/m', home: '/m/home' },
  // Git Bash's HOME in its /c/... form; the adapter stores C:/...
  { host: windowsHost, platform: 'windows', env: { OS: 'Windows_NT', USERPROFILE: 'C:\\m\\home', HOME: '/c/m/home', SystemRoot: 'C:\\Windows' }, root: 'C:/m', home: 'C:/m/home' },
]

describe('host contract', () => {
  for (const one of CASES) {
    const { host, root } = one
    const runs = `${root}/runs`
    const at = (m: Machine, path: string) => m.files.get(keyOf(path))

    test(`${one.platform}: the adapter has every member of Host, of the right kind`, () => {
      for (const name of HOST_MEMBERS) expect(host[name] === undefined).toBe(false)
      for (const name of HOST_MEMBERS.filter(name => !['platform', 'launchTool', 'launchToolHint'].includes(name))) expect(typeof host[name]).toBe('function')
      expect(host.platform).toBe(one.platform)
      expect(host.launchTool).toBe('Bash')
      expect(typeof host.launchToolHint).toBe('string')
    })

    test(`${one.platform}: paths: home, the stored form, the session directory, the config dir and the transcript`, async () => {
      const port = portOf(machine(one.env), runs)
      const home = await host.homeDir(port)
      expect(home).toBe(one.home)
      expect(host.nativePath(home)).toBe(home)
      expect(host.isSameDir(host.sessionDir(`${root}/orch/`), `${root}/orch`)).toBe(true)
      expect(host.isSameDir(host.sessionDir(`${root}/orch`), `${root}/other`)).toBe(false)
      expect(host.defaultConfigDir(home, undefined)).toBe(`${home}/.claude`)
      expect(host.isDefaultConfigDir(`${home}/.claude`, host.defaultConfigDir(home, undefined))).toBe(true)
      expect(host.isDefaultConfigDir(`${home}/.claude/lic/b`, `${home}/.claude`)).toBe(false)
      expect(host.transcriptPath({ config_dir: `${home}/.claude`, cwd: `${root}/work`, session_id: SID })).toMatch(new RegExp(`^${home}/\\.claude/projects/[A-Za-z0-9-]+/${SID}\\.jsonl$`))
      expect(host.transcriptPath({ title: 'no cwd' })).toBeUndefined()
    })

    test(`${one.platform}: writeAtomic replaces a file through a rename and leaves no temp file; a changed file is not written`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      const path = `${root}/orch/headless-sessions.json`
      m.files.set(keyOf(path), '[]\n')
      expect(await host.writeAtomic(port, path, '[1]\n', '[]\n')).toBe(true)
      expect(at(m, path)).toBe('[1]\n')
      expect(await host.writeAtomic(port, path, '[2]\n', '[]\n')).toBe(false)
      expect(at(m, path)).toBe('[1]\n')
      expect(await host.writeAtomic(port, `${root}/orch/new.json`, '{}\n')).toBe(true)
      expect(at(m, `${root}/orch/new.json`)).toBe('{}\n')
      expect([...m.files.keys()].filter(file => file.includes('.tmp.'))).toEqual([])
    })

    test(`${one.platform}: removeFile and renameOver`, async () => {
      const m = machine(one.env)
      const notes: string[] = []
      const port = portOf(m, runs, notes)
      m.files.set(keyOf(`${root}/a`), 'A')
      m.files.set(keyOf(`${root}/b.tmp.1`), 'B')
      expect(await host.removeFile(port, `${root}/a`)).toBe(true)
      expect(at(m, `${root}/a`)).toBeUndefined()
      await host.renameOver(port, `${root}/b.tmp.1`, `${root}/b`, 'B')
      expect(at(m, `${root}/b`)).toBe('B')
      expect(at(m, `${root}/b.tmp.1`)).toBeUndefined()
      expect(notes).toEqual([])
    })

    test(`${one.platform}: append adds lines to a log without reading it, and says the exit code`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      const log = `${runs}/cleared.jsonl`
      const codes: number[] = []
      expect(await host.append(port, log, ['{"a":1}', '{"b":2}'], false, code => codes.push(code))).toBeUndefined()
      expect(await host.append(port, log, ['{"c":3}'], true, code => codes.push(code))).toBeUndefined()
      expect(at(m, log)).toBe('{"a":1}\n{"b":2}\n{"c":3}\n')
      expect(codes).toEqual([0, 0])
      expect([...m.files.keys()].filter(file => file.includes('.add.'))).toEqual([])
    })

    test(`${one.platform}: tail gives the last 600 lines, each cut to 20000 characters; a missing file is undefined`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      const lines = Array.from({ length: 700 }, (_, line) => (line === 699 ? 'x'.repeat(25000) : `line ${line}`))
      m.files.set(keyOf(`${root}/t.jsonl`), `${lines.join('\n')}\n`)
      const tail = await host.tail(port, `${root}/t.jsonl`)
      expect(tail?.split('\n').slice(0, -1)).toEqual([...lines.slice(100, 699), 'x'.repeat(20000)])
      expect(await host.tail(port, `${root}/missing.jsonl`)).toBeUndefined()
    })

    test(`${one.platform}: createFile and the directories a fresh environment and a launch need`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      await host.createFile(port, `${root}/orch/task-queue.json`, '{"tasks":[]}\n')
      expect(at(m, `${root}/orch/task-queue.json`)).toBe('{"tasks":[]}\n')
      await host.prepareHelperDirs(port, `${root}/orch/backups`)
      await host.prepareRunsDir(port, runs)
      expect(typeof (await host.makeDir(port, runs))).toBe('boolean')
    })

    test(`${one.platform}: probe, then findNewWorker finds the new headless worker and not a known one`, async () => {
      const port = portOf(machine(one.env), runs)
      const facts = await host.probe(port, [{ session_id: SID, config_dir: `${root}/cfg` }], [`${root}/cfg`])
      expect(facts.claude.map(proc => proc.pid)).toEqual([4242])
      expect(facts.transcriptMtime.get(SID)).toBe(1700000000)
      const want = { dir: `${root}/work`, configDir: host.workerConfigDir({ configDir: `${root}/cfg` }, undefined), model: 'opus' }
      expect((await host.findNewWorker(port, facts, want, new Set(), NOW_MS))?.pid).toBe(4242)
      expect(await host.findNewWorker(port, facts, want, new Set([4242]), NOW_MS)).toBeUndefined()
      expect(await host.findNewWorker(port, facts, { ...want, model: 'sonnet' }, new Set(), NOW_MS)).toBeUndefined()
    })

    test(`${one.platform}: pause waits the seconds asked`, async () => {
      const m = machine(one.env)
      await host.pause(portOf(m, runs), 2)
      const waited = m.sleeps.reduce((sum, ms) => sum + ms, 0) + m.runs.filter(argv => argv[0] === 'sleep').reduce((sum, argv) => sum + Number(argv[1]) * 1000, 0)
      expect(waited).toBe(2000)
    })

    test(`${one.platform}: the launch: its paths, its checks, its facts, the picker and the command for the Bash tool`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      m.files.set(keyOf(`${root}/work/prompt.md`), 'Goal: x')
      const args = host.launchArgs({ dir: `${root}/work`, prompt_file: `${root}/work/prompt.md`, model: 'opus', effort: 'high', title: 'new' })
      expect(args).toMatchObject({ dir: `${root}/work`, prompt_file: `${root}/work/prompt.md` })
      expect(await host.launchChecks(port, args)).toEqual({ promptFileOk: true, dirOk: true })
      expect(await host.launchChecks(port, { ...args, prompt_file: `${root}/work/none.md`, dir: `${root}/none` })).toEqual({ promptFileOk: false, dirOk: false })
      expect(typeof host.launchFacts('Goal: x')).toBe('object')
      expect(host.pickerArgv([`${root}/bin/pick`, '--need', '40'])).toEqual({ argv: [`${root}/bin/pick`, '--need', '40'] })
      const command = host.launchCommand(args, { configDir: `${one.home}/.claude`, isConfigInherited: true, name: 'w-new-1' }, `${runs}/r.json`, `${runs}/r.err`)
      expect(command).toStartWith(`cd '${root}/work' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' -n 'w-new-1' `)
      expect(command).toEndWith(`-- "$(cat '${root}/work/prompt.md')" > '${runs}/r.json' 2> '${runs}/r.err'`)
    })

    test(`${one.platform}: rotate turns the trace into .1 and .1 into .2`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      const trace = `${runs}/trace.log`
      m.files.set(keyOf(trace), 'new\n')
      m.files.set(keyOf(`${trace}.1`), 'mid\n')
      await host.rotate(port, { path: trace, adding: 10, keep: 3, maxBytes: 8, moves: [[`${trace}.1`, `${trace}.2`], [trace, `${trace}.1`]] })
      expect([at(m, trace), at(m, `${trace}.1`), at(m, `${trace}.2`)]).toEqual([undefined, 'new\n', 'mid\n'])
    })
  }
})

describe('host selection', () => {
  test('the Windows environment values pick the Windows adapter', () => {
    expect(selectHost({ OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\u' })).toBe(windowsHost)
    expect(selectHost({ OS: 'Windows_NT', USERPROFILE: 'c:/Users/u' })).toBe(windowsHost)
  })
  test('anything else picks the Linux adapter, WSL included, and an incomplete or odd value fails closed to Linux', () => {
    expect(selectHost({})).toBe(posixHost)
    expect(selectHost({ OS: 'Linux' })).toBe(posixHost)
    // WSL can hand on OS from Windows; its profile then is no drive-letter path.
    expect(selectHost({ OS: 'Windows_NT', USERPROFILE: '/home/u' })).toBe(posixHost)
    expect(selectHost({ OS: 'Windows_NT' })).toBe(posixHost)
    expect(selectHost({ OS: 'Windows_NT', USERPROFILE: '' })).toBe(posixHost)
    expect(selectHost({ USERPROFILE: 'C:\\Users\\u' })).toBe(posixHost)
    expect(selectHost({ OS: 'windows_nt', USERPROFILE: 'C:\\Users\\u' })).toBe(posixHost)
    expect(selectHost({ OS: 'Windows_NT', USERPROFILE: '\\\\host\\share\\u' })).toBe(posixHost)
  })

  // Through the plugin on the mock engine: the board's probes at session start are the chosen adapter's.
  const PROBES: [string, Record<string, string>, string, 'Linux' | 'Windows'][] = [
    ['the Windows values', { OS: 'Windows_NT', USERPROFILE: 'C:\\m\\home', HOME: '/c/m/home' }, 'C:/m/orch', 'Windows'],
    ['a Linux environment', { HOME: '/m/home' }, '/m/orch', 'Linux'],
    ['Windows_NT without a drive-letter profile', { OS: 'Windows_NT', USERPROFILE: '/m/home', HOME: '/m/home' }, '/m/orch', 'Linux'],
  ]
  for (const [name, env, orch, adapter] of PROBES) {
    test(`the plugin runs the ${adapter} adapter for ${name}`, { options: { orchestratorDir: orch, registryPath: '~/.claude/headless-sessions.json' } }, async ($, on) => {
      const m = machine(env)
      mount(on, m)
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('command.register', ($, e) => ({ value: { command: e.name } }))
      on('tool.register', ($, e) => ({ value: { tool: `mcp__session-control__${e.name}` } }))
      on('ui.toast', () => ({ value: undefined }))
      await $.session.start({ cwd: orch, surface: null, isInteractive: true })
      const probes = m.runs.filter(argv => argv[2] === PROBE_SCRIPT || String(argv[6]).endsWith('/probe.ps1'))
      expect(probes.length).toBeGreaterThan(0)
      expect(probes.every(argv => (adapter === 'Linux' ? argv[0] === 'sh' : argv[0]?.endsWith('\\powershell.exe')))).toBe(true)
    })
  }
})
