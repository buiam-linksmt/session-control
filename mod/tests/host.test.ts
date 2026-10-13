// The host interface: one contract run against the Host withHelper makes of each adapter, and the one platform choice.
//
// The machine is simulated once (files in a map, Node and its helper over them, the commands the adapters still run
// answered as that system would) and stands beneath the plugins as the mock engine's fs, process and env hooks. The
// contract calls the hosts over a HostPort on that same machine: the kit's test `$` has no fs or process noun, and an inline plugin runs in a realm
// of its own, so a port over a plugin's `$` cannot be handed to the test. The selection tests go through the plugin
// itself, on the mock engine.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { FsStat, On } from 'claude-code'

import { HOST_MEMBERS, selectHost } from '../hooks/host'
import type { Host, HostPort, Platform, StopReport } from '../hooks/host'
import { withHelper } from '../hooks/host-helper'
import { withPowerShellLaunch } from '../hooks/host-powershell'
import { NEWER_MAX } from '../hooks/host-shared'
import { posixHost } from '../hooks/host-posix'
import { MSYS_PS_MS, PROBE_PS1, PROBE_TIMEOUT_MS, TREE_PS1, windowsHost } from '../hooks/host-windows'
import { localDate } from '../hooks/store'
import { checkInTable, helperAnswer, taskkillInTable, treeInTable } from './fake-helper'
import type { ProcTable } from './fake-helper'
import { NOW_MS, worldPath } from './fixtures'

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
  /** The files' mtimes in epoch ms (0 when unset), for the listing of the files written after a time. */
  mtimes: Map<string, number>
  /** The symbolic links: a link's key to its target's key (a file, or a directory the paths under the link go through). */
  links: Map<string, string>
  /** The path (key) of every removal the helper's removeFile was asked for. */
  removals: string[]
  runs: string[][]
  /** Milliseconds the helper's pause waited (Windows), one per call. */
  paused: number[]
  /** The processes the stop of stop_worker sees, and every signal sent to one. */
  table: ProcTable
  /** The machine's clock (epoch ms) as HostPort.now reads it; each TREE_PS1 check moves it on by its sleep and `checkMs`, the time PowerShell takes to start. */
  clock: { ms: number; checkMs: number }
  read(path: string): string
  exists(path: string): boolean
  stat(path: string): FsStat
  run(argv: readonly string[], stdin?: string): Ran
}

/** The simulated machine: its files, Node and its helper, and the commands the adapters run, answered as the system would. */
function machine(env: Record<string, string>): Machine {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const links = new Map<string, string>()
  const removals: string[] = []
  const runs: string[][] = []
  const paused: number[] = []
  const table: ProcTable = { procs: new Map(), own: [900, 1], signals: [], nowMs: NOW_MS }
  const clock = { ms: NOW_MS, checkMs: 0 }
  const isDir = (path: string) => [...files.keys()].some(file => file.startsWith(`${keyOf(path).replace(/\/+$/, '')}/`))
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
  const run = (given: readonly string[], stdin?: string): Ran => {
    const argv = given.map(String)
    runs.push(argv)
    const [cmd] = argv
    // Node 24 and the helper (tests/fake-helper.ts), whose probe prints what /proc shows.
    if (cmd === NODE && argv[1] === '--version') return ran('v24.14.0\n')
    if (cmd === NODE && (argv[1] === HELPER || argv[1]?.endsWith('/helper/host.mjs'))) {
      const isWin = env.OS === 'Windows_NT'
      const out = isWin ? '' : probeOutput('/m/work', '/m/cfg', 'claude -p --model opus --output-format json -- Goal: x')
      const request = JSON.parse(stdin ?? '') as Record<string, unknown>
      if (argv[2] === 'removeFile') removals.push(keyOf(String(request.path)))
      if (argv[2] === 'pause') paused.push(Number(request.ms))
      const answer = helperAnswer(files, String(argv[2]), request, out, keyOf, mtimes, links, isWin ? undefined : table)
      return ran(JSON.stringify(answer), answer.ok === true ? 0 : 1)
    }
    if (cmd === 'mkdir' || cmd === 'sleep') return ran()
    if (cmd === 'test') {
      const path = argv[2] ?? ''
      const isThere = argv[1] === '-d' ? isDir(path) : argv[1] === '-s' ? (files.get(keyOf(path)) ?? '').length > 0 : files.has(keyOf(path)) || isDir(path)
      return ran('', isThere ? 0 : 1)
    }
    if (cmd?.endsWith('\\taskkill.exe')) return ran('', taskkillInTable(table, Number(argv[2]), argv.includes('/F')))
    if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/tree.ps1')) {
      expect(files.get(keyOf(argv[6]))).toBe(TREE_PS1)
      const [op, a = '', b = ''] = argv.slice(7)
      if (op === 'check') clock.ms += Number(a) * 1000 + clock.checkMs
      const out = op === 'list' ? treeInTable(table, Number(a), b, true) : checkInTable(table, argv.slice(9))
      return ran(out.replace(/\n/g, '\r\n'))
    }
    if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/probe.ps1')) {
      expect(files.get(keyOf(argv[6]))).toBe(PROBE_PS1)
      const out = probeOutput('C:\\m\\work', 'C:\\m\\cfg', '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus --output-format json -- "Goal: x"')
      return ran(out.replace(/\n/g, '\r\n'))
    }
    throw new Error(`unexpected command ${argv.join(' ')}`)
  }
  const result: Machine = { env, files, mtimes, links, removals, runs, paused, table, clock, read, exists: path => files.has(keyOf(path)) || isDir(path), stat, run }
  return result
}

/**
 * The machine beneath the plugins: the mock engine's fs, process, env and clock hooks answer from it, each path in the
 * form the machine keys it (worldPath: C:/... for a Windows machine, /... for a Linux one, on either host).
 */
function mount(on: On, m: Machine): void {
  mock.clock(on, { now: NOW_MS })
  mock.env(on, m.env)
  const at = (path: string) => worldPath(path, m.env.OS === 'Windows_NT')
  on('fs.read', ($, e) => ({ value: m.read(at(e.path)) }))
  on('fs.write', ($, e) => {
    m.files.set(keyOf(at(e.path)), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: m.exists(at(e.path)) }))
  on('fs.stat', ($, e) => ({ value: m.stat(at(e.path)) }))
  on('process.run', ($, e) => ({ value: m.run(e.argv, e.init?.stdin) }))
}

/** The session started in `cwd`. */
const startIn = ($: { session: { start: (e: never) => Promise<unknown> } }, cwd: string) => $.session.start({ cwd, surface: null, isInteractive: true } as never)

/** A HostPort on the machine, as register.tsx's port is on the engine (untraced). */
function portOf(m: Machine, runsDir: string, notes: string[] = []): HostPort {
  return {
    run: async (argv, init) => m.run(argv, init?.stdin),
    read: async path => m.read(path),
    write: async (path, text) => {
      m.files.set(keyOf(path), text)
    },
    exists: async path => m.exists(path),
    stat: async path => m.stat(path),
    now: async () => m.clock.ms,
    env: async name => m.env[name],
    runsDir: async () => runsDir,
    noteHelper: note => {
      if (note.kind === 'failed') notes.push(`helper failed: ${note.op} ${note.code}`)
    },
  }
}

/** The node and the helper of the composed adapters (withHelper), as the machine knows them. */
const NODE = 'node'
const HELPER = '/m/mod/helper/host.mjs'

type Case = { host: Host; name: string; platform: 'linux' | 'windows'; env: Record<string, string>; root: string; home: string; isPowerShellRoute?: boolean }

const LINUX_ENV = { HOME: '/m/home' }
// Git Bash's HOME in its /c/... form; the adapter stores C:/...
const WINDOWS_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\m\\home', HOME: '/c/m/home', SystemRoot: 'C:\\Windows' }
const CASES: Case[] = [
  // The Host of each adapter, the Node helper in front of it.
  { host: withHelper(posixHost, { node: NODE, script: HELPER }), name: 'linux with the helper', platform: 'linux', env: LINUX_ENV, root: '/m', home: '/m/home' },
  { host: withHelper(windowsHost, { node: NODE, script: HELPER }), name: 'windows with the helper', platform: 'windows', env: WINDOWS_ENV, root: 'C:/m', home: 'C:/m/home' },
  // The Windows adapter on the PowerShell launch route (the launchRoute option at powershell), behind the helper.
  {
    host: withHelper(withPowerShellLaunch(windowsHost), { node: NODE, script: HELPER }),
    name: 'windows, PowerShell route, with the helper',
    platform: 'windows',
    env: WINDOWS_ENV,
    root: 'C:/m',
    home: 'C:/m/home',
    isPowerShellRoute: true,
  },
]

describe('host contract', () => {
  for (const one of CASES) {
    const { host, root } = one
    const runs = `${root}/runs`
    const at = (m: Machine, path: string) => m.files.get(keyOf(path))

    test(`${one.name}: the adapter has every member of Host, of the right kind`, () => {
      for (const name of HOST_MEMBERS) expect(host[name] === undefined).toBe(false)
      for (const name of HOST_MEMBERS.filter(name => !['platform', 'launchTool', 'launchToolHint'].includes(name))) expect(typeof host[name]).toBe('function')
      expect(host.platform).toBe(one.platform)
      expect(host.launchTool).toBe(one.isPowerShellRoute === true ? 'PowerShell' : 'Bash')
      expect(typeof host.launchToolHint).toBe('string')
    })

    test(`${one.name}: paths: home, the stored form, the session directory, the config dir and the transcript`, async () => {
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

    test(`${one.name}: writeAtomic replaces a file through a rename and leaves no temp file; a changed file is not written`, async () => {
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

    test(`${one.name}: removeFile and renameOver`, async () => {
      const m = machine(one.env)
      const notes: string[] = []
      const port = portOf(m, runs, notes)
      m.files.set(keyOf(`${root}/a`), 'A')
      m.files.set(keyOf(`${root}/b.tmp.1`), 'B')
      expect(await host.removeFile(port, `${root}/a`)).toBe(true)
      expect(at(m, `${root}/a`)).toBeUndefined()
      await host.renameOver(port, `${root}/b.tmp.1`, `${root}/b`)
      expect(at(m, `${root}/b`)).toBe('B')
      expect(at(m, `${root}/b.tmp.1`)).toBeUndefined()
      expect(notes).toEqual([])
    })

    test(`${one.name}: removeRegularFile removes a regular file and nothing else: a link, a directory and a missing path are answered, nothing changes`, async () => {
      const m = machine(one.env)
      const notes: string[] = []
      const port = portOf(m, runs, notes)
      m.files.set(keyOf(`${root}/r/a.json`), 'A')
      m.files.set(keyOf(`${root}/r/sub/inner`), 'I')
      m.files.set(keyOf(`${root}/out/secret`), 'S')
      m.links.set(keyOf(`${root}/r/link.json`), keyOf(`${root}/out/secret`))
      m.links.set(keyOf(`${root}/r/linkdir`), keyOf(`${root}/out`))
      expect(await host.removeRegularFile(port, `${root}/r/a.json`)).toBe('removed')
      expect(at(m, `${root}/r/a.json`)).toBeUndefined()
      expect(await host.removeRegularFile(port, `${root}/r/a.json`)).toBe('absent')
      expect(await host.removeRegularFile(port, `${root}/r/link.json`)).toBe('symlink')
      expect(await host.removeRegularFile(port, `${root}/r/linkdir`)).toBe('symlink')
      expect(await host.removeRegularFile(port, `${root}/r/sub`)).toBe('not-file')
      expect([...m.files.keys()].filter(key => !key.endsWith('/files.ps1')).sort()).toEqual([`${root}/out/secret`, `${root}/r/sub/inner`].map(keyOf).sort())
      expect(m.links.size).toBe(2)
      expect(notes).toEqual([])
    })

    test(`${one.name}: append adds lines to a log without reading it, and says the exit code`, async () => {
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

    test(`${one.name}: tail gives the last 600 lines, each cut to 20000 characters; a missing file is undefined`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      const lines = Array.from({ length: 700 }, (_, line) => (line === 699 ? 'x'.repeat(25000) : `line ${line}`))
      m.files.set(keyOf(`${root}/t.jsonl`), `${lines.join('\n')}\n`)
      const tail = await host.tail(port, `${root}/t.jsonl`)
      expect(tail?.split('\n').slice(0, -1)).toEqual([...lines.slice(100, 699), 'x'.repeat(20000)])
      expect(await host.tail(port, `${root}/missing.jsonl`)).toBeUndefined()
    })

    test(`${one.name}: a tail with a shape gives the last lines asked, each cut to the width asked; a missing file is undefined`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      const lines = Array.from({ length: 50 }, (_, line) => (line === 49 ? 'y'.repeat(300) : `row ${line}`))
      m.files.set(keyOf(`${root}/t.jsonl`), `${lines.join('\n')}\n`)
      expect(await host.tail(port, `${root}/t.jsonl`, { lines: 5, width: 100 })).toBe([...lines.slice(45, 49), 'y'.repeat(100)].map(line => `${line}\n`).join(''))
      expect(await host.tail(port, `${root}/missing.jsonl`, { lines: 5, width: 100 })).toBeUndefined()
    })

    test(`${one.name}: createFile and the directories a fresh environment and a launch need`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      await host.createFile(port, `${root}/orch/task-queue.json`, '{"tasks":[]}\n')
      expect(at(m, `${root}/orch/task-queue.json`)).toBe('{"tasks":[]}\n')
      await host.prepareHelperDirs(port, `${root}/orch/backups`)
      await host.prepareRunsDir(port, runs)
    })

    test(`${one.name}: probe, then findNewWorker finds the new headless worker and not a known one`, async () => {
      const port = portOf(machine(one.env), runs)
      const facts = await host.probe(port, [{ session_id: SID, config_dir: `${root}/cfg` }], [`${root}/cfg`])
      expect(facts.claude.map(proc => proc.pid)).toEqual([4242])
      expect(facts.transcriptMtime.get(SID)).toBe(1700000000)
      const want = { dir: `${root}/work`, configDir: host.workerConfigDir({ configDir: `${root}/cfg` }, undefined), model: 'opus' }
      expect((await host.findNewWorker(port, facts, want, new Set(), NOW_MS))?.pid).toBe(4242)
      expect(await host.findNewWorker(port, facts, want, new Set([4242]), NOW_MS)).toBeUndefined()
      expect(await host.findNewWorker(port, facts, { ...want, model: 'sonnet' }, new Set(), NOW_MS)).toBeUndefined()
    })

    // The Windows probe is a PowerShell start of seconds (2 to 24 s seen in a desktop session under load): 60 s.
    test(`${one.name}: the process probe's time limit`, async () => {
      const m = machine(one.env)
      const limits: (number | undefined)[] = []
      const port = { ...portOf(m, runs), run: async (argv: readonly string[], init?: { stdin?: string; timeoutMs?: number }) => {
        if (String(argv[6] ?? '').endsWith('/probe.ps1')) limits.push(init?.timeoutMs)
        return m.run(argv, init?.stdin)
      } }
      await host.probe(port, [])
      expect(limits).toEqual(one.platform === 'windows' ? [60_000] : [])
      expect(PROBE_TIMEOUT_MS).toBe(60_000)
    })

    test(`${one.name}: pause waits the seconds asked`, async () => {
      const m = machine(one.env)
      await host.pause(portOf(m, runs), 2)
      const waited = m.paused.reduce((sum, ms) => sum + ms, 0) + m.runs.filter(argv => argv[0] === 'sleep').reduce((sum, argv) => sum + Number(argv[1]) * 1000, 0)
      expect(waited).toBe(2000)
    })

    // A hook's time budget counts a wait on the engine's clock and not the time a process runs (decision mod-28): the
    // port has no clock wait at all, and the wait is one process, Linux's `sleep` or the Node helper's pause on Windows.
    test(`${one.name}: the wait is one process: sleep on Linux, the helper's pause on Windows`, async () => {
      const m = machine(one.env)
      await host.pause(portOf(m, runs), 2)
      // Node's lookup, made once per composed host, is left out.
      expect(m.runs.filter(argv => argv[1] !== '--version')).toEqual(one.platform === 'linux' ? [['sleep', '2']] : [[NODE, HELPER, 'pause']])
      expect(m.paused).toEqual(one.platform === 'linux' ? [] : [2000])
    })

    test(`${one.name}: the launch: its paths, its checks, its facts, the picker and the command for the Bash tool`, async () => {
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
      if (one.isPowerShellRoute === true) {
        expect(command).toContain(`$p = Start-Process -FilePath $exe -ArgumentList '-p --model opus -n w-new-1 --settings `)
        expect(command).toContain(`-WorkingDirectory '${root}/work' -RedirectStandardInput '${root}/work/prompt.md' -RedirectStandardOutput '${runs}/r.json' -RedirectStandardError '${runs}/r.err' `)
        expect(host.launchPidFile(`${runs}/r.json`)).toBe(`${runs}/r.pid`)
        expect(command).toEndWith(`Set-Content -LiteralPath '${runs}/r.pid' -Value $p.Id -Encoding Ascii\n$p.WaitForExit()\nexit $p.ExitCode`)
        return
      }
      expect(command).toStartWith(`cd '${root}/work' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' -n 'w-new-1' `)
      expect(command).toEndWith(`-- "$(cat '${root}/work/prompt.md')" > '${runs}/r.json' 2> '${runs}/r.err'`)
      expect(host.launchPidFile(`${runs}/r.json`)).toBeUndefined()
    })

    test(`${one.name}: rotate turns the trace into .1 and .1 into .2`, async () => {
      const m = machine(one.env)
      const port = portOf(m, runs)
      const trace = `${runs}/trace.log`
      m.files.set(keyOf(trace), 'new\n')
      m.files.set(keyOf(`${trace}.1`), 'mid\n')
      await host.rotate(port, { path: trace, adding: 10, keep: 3, maxBytes: 8, moves: [[`${trace}.1`, `${trace}.2`], [trace, `${trace}.1`]] })
      expect([at(m, trace), at(m, `${trace}.1`), at(m, `${trace}.2`)]).toEqual([undefined, 'new\n', 'mid\n'])
    })

    test(`${one.name}: rotateAndAppend rotates when a plan is given, then appends; without one it only appends`, async () => {
      const m = machine(one.env)
      const notes: string[] = []
      const port = portOf(m, runs, notes)
      const trace = `${runs}/trace.log`
      m.files.set(keyOf(trace), 'new\n')
      m.files.set(keyOf(`${trace}.1`), 'mid\n')
      const plan = { path: trace, adding: 10, keep: 3, maxBytes: 8, moves: [[`${trace}.1`, `${trace}.2`], [trace, `${trace}.1`]] as [string, string][] }
      expect(await host.rotateAndAppend(port, trace, ['{"a":1}'], plan)).toBeUndefined()
      expect([at(m, trace), at(m, `${trace}.1`), at(m, `${trace}.2`)]).toEqual(['{"a":1}\n', 'new\n', 'mid\n'])
      expect(await host.rotateAndAppend(port, trace, ['{"b":2}'])).toBeUndefined()
      expect([at(m, trace), at(m, `${trace}.1`)]).toEqual(['{"a":1}\n{"b":2}\n', 'new\n'])
      expect(notes).toEqual([])
    })

    test(`${one.name}: filesNewerThan lists the files written after a time, newest first, paths and mtimes only, never in .git; a missing directory is undefined`, async () => {
      const m = machine(one.env)
      const notes: string[] = []
      const port = portOf(m, runs, notes)
      const put = (path: string, sec: number) => {
        m.files.set(keyOf(path), 'x')
        m.mtimes.set(keyOf(path), sec * 1000 + 250)
      }
      put(`${root}/work/old.txt`, 1000)
      put(`${root}/work/new.txt`, 3000)
      put(`${root}/work/sub dir/mid.txt`, 2000)
      put(`${root}/work/same.txt`, 2000)
      put(`${root}/work/.git/index`, 3500)
      put(`${root}/work/sub dir/.git/HEAD`, 3500)
      put(`${root}/other/x.txt`, 4000)
      // A file of exactly the second asked is not after it; 250 ms into it is.
      put(`${root}/work/at.txt`, 1500)
      m.mtimes.set(keyOf(`${root}/work/at.txt`), 1_500_000)
      expect(await host.filesNewerThan(port, `${root}/work`, 1500)).toEqual({
        files: [
          { path: `${root}/work/new.txt`, mtimeMs: 3_000_250 },
          { path: `${root}/work/same.txt`, mtimeMs: 2_000_250 },
          { path: `${root}/work/sub dir/mid.txt`, mtimeMs: 2_000_250 },
        ],
        total: 3,
      })
      expect(await host.filesNewerThan(port, `${root}/work`, 5000)).toEqual({ files: [], total: 0 })
      expect(notes).toEqual([])
      expect(await host.filesNewerThan(port, `${root}/none`, 0)).toBeUndefined()
    })

    test(`${one.name}: filesNewerThan answers at most ${NEWER_MAX} paths, the newest, with the count of all`, async () => {
      const m = machine(one.env)
      for (let n = 0; n < NEWER_MAX + 25; n++) {
        m.files.set(keyOf(`${root}/work/f${n}.txt`), 'x')
        m.mtimes.set(keyOf(`${root}/work/f${n}.txt`), (10_000 + n) * 1000)
      }
      const listed = await host.filesNewerThan(portOf(m, runs), `${root}/work`, 0)
      expect(listed?.total).toBe(NEWER_MAX + 25)
      expect(listed?.files.length).toBe(NEWER_MAX)
      expect(listed?.files[0]).toEqual({ path: `${root}/work/f${NEWER_MAX + 24}.txt`, mtimeMs: (10_000 + NEWER_MAX + 24) * 1000 })
      expect(listed?.files.at(-1)?.path).toBe(`${root}/work/f25.txt`)
    })

    /** A worker's tree: root 5000 with a child 5001 and a grandchild 5002 that ignores TERM; 6000 is outside it. */
    const seedTree = (m: Machine) => {
      m.table.procs.set(5000, { ppid: 1, start: '100', state: 'S', comm: 'claude' })
      m.table.procs.set(5001, { ppid: 5000, start: '101', state: 'S', comm: 'bash' })
      m.table.procs.set(5002, { ppid: 5001, start: '102', state: 'S', comm: 'sleep', isStubborn: true })
      m.table.procs.set(6000, { ppid: 1, start: '50', state: 'S', comm: 'claude' })
    }
    const signalsOf = (steps: StopReport['steps']) => steps.flatMap(step => (step.kind === 'signal' ? [`${step.pid} ${step.signal}`] : []))

    test(`${one.name}: stopProcessTree lists the tree before the first signal, stops the root, then the descendant still there; nothing outside the tree is signalled`, async () => {
      const m = machine(one.env)
      seedTree(m)
      const notes: string[] = []
      const report = await host.stopProcessTree(portOf(m, runs, notes), { pid: 5000, start: '100' })
      expect(report.tree.root).toMatchObject({ pid: 5000, ppid: 1, start: '100', comm: 'claude' })
      expect(report.tree.descendants.map(proc => [proc.pid, proc.ppid, proc.start, proc.comm])).toEqual([
        [5001, 5000, '101', 'bash'],
        [5002, 5001, '102', 'sleep'],
      ])
      expect(report.tree.ancestors).toEqual([900, 1])
      // The listing ran before any signal: the first signal is recorded after it.
      const listedAt = m.runs.findIndex(argv => argv.some(arg => arg.endsWith('/tree.ps1')) || argv.includes('processTree'))
      const firstSignal = m.runs.findIndex(argv => argv[0]?.endsWith('\\taskkill.exe') === true || argv.includes('stopProcesses'))
      expect(listedAt).toBeGreaterThanOrEqual(0)
      expect(firstSignal).toBeGreaterThan(listedAt)
      // Windows sends no gentle taskkill first (a console process without a window refuses it): /T /F to the root takes
      // its whole Windows tree, the one that ignores the gentle signal with it.
      expect(signalsOf(report.steps)).toEqual(one.platform === 'linux' ? ['5000 TERM', '5001 TERM', '5002 TERM', '5002 KILL'] : ['5000 taskkill /T /F'])
      expect(report.steps.filter(step => step.kind === 'check' && step.status === 'gone').map(step => step.pid).sort()).toEqual(one.platform === 'linux' ? [5000, 5001, 5002] : [5000])
      if (one.platform === 'windows') expect(m.table.signals.every(sent => sent.signal === 'taskkill /F')).toBe(true)
      expect(report.final).toEqual([5000, 5001, 5002].map(pid => ({ pid, status: 'gone', state: '' })))
      expect([...m.table.procs.keys()]).toEqual([6000])
      expect(m.table.signals.some(sent => sent.pid === 6000)).toBe(false)
      expect(notes).toEqual([])
      expect(report.notes).toEqual([])
    })

    if (one.platform === 'windows') {
      test(`${one.name}: stopProcessTree reaches a program the worker started through Git Bash by the MSYS process table, and says when that table cannot be read`, async () => {
        const GIT = 'C:\\Program Files\\Git\\usr\\bin'
        /** The tree, plus a sleep.exe under the worker's bash 5001 through MSYS: its Windows parent 4999 (the fork that exec'd it) is gone. */
        const seedMsys = (m: Machine) => {
          seedTree(m)
          m.table.procs.set(5003, { ppid: 4999, start: '103', state: '', comm: 'sleep.exe', msysParent: 5001 })
          // Another session's MSYS program: its MSYS parent is outside the tree.
          m.table.procs.set(6001, { ppid: 4998, start: '104', state: '', comm: 'sleep.exe', msysParent: 6000 })
          // A program whose MSYS parent pid names a member that started after it: not that member's child.
          m.table.procs.set(6002, { ppid: 4997, start: '90', state: '', comm: 'sleep.exe', msysParent: 5001 })
        }
        const m = machine(one.env)
        seedMsys(m)
        m.table.msys = { dir: GIT }
        const report = await host.stopProcessTree(portOf(m, runs), { pid: 5000, start: '100' })
        expect(report.tree.descendants.map(proc => [proc.pid, proc.ppid, proc.start, proc.state, proc.comm])).toEqual([
          [5001, 5000, '101', 'S', 'bash'],
          [5002, 5001, '102', 'S', 'sleep'],
          [5003, 5001, '103', 'msys', 'sleep.exe'],
        ])
        expect(report.notes).toEqual([
          'the MSYS process table of C:/Program Files/Git/usr/bin (Git Bash) was read before the first signal: 1 program the worker started through Git Bash, whose Windows parent has exited, is among the descendants listed, each with its MSYS parent',
        ])
        expect(signalsOf(report.steps)).toEqual(['5000 taskkill /T /F', '5003 taskkill /T /F'])
        expect(report.final).toEqual([5000, 5001, 5002, 5003].map(pid => ({ pid, status: 'gone', state: '' })))
        expect([...m.table.procs.keys()].sort()).toEqual([6000, 6001, 6002])
        expect(m.table.signals.some(sent => [6000, 6001, 6002].includes(sent.pid))).toBe(false)

        // The same worker with a table that cannot be read: the program stays outside the stop, and the note says so.
        const blind = machine(one.env)
        seedMsys(blind)
        blind.table.msys = { dir: GIT, isUnreadable: true }
        const unread = await host.stopProcessTree(portOf(blind, runs), { pid: 5000, start: '100' })
        expect(unread.tree.descendants.map(proc => proc.pid)).toEqual([5001, 5002])
        expect(unread.notes).toEqual([
          'the MSYS process table of C:/Program Files/Git/usr/bin (Git Bash) could not be read: a program the worker started through Git Bash whose Windows parent has exited is not among the descendants listed, and this stop does not reach it',
        ])
        expect(blind.table.procs.has(5003)).toBe(true)
        expect(blind.table.signals.some(sent => [5003, 6000, 6001, 6002].includes(sent.pid))).toBe(false)

        // No MSYS member in the tree: no table read, no note.
        const plain = machine(one.env)
        seedTree(plain)
        expect((await host.stopProcessTree(portOf(plain, runs), { pid: 5000, start: '100' })).notes).toEqual([])
      })

      test(`${one.name}: stopProcessTree takes an MSYS process table with no row of a table (a ps.exe that exits 0 and prints garbage) as one that cannot be read, and stops what the Windows tree reaches`, async () => {
        const m = machine(one.env)
        seedTree(m)
        // The worker's Git Bash sleep.exe: only the MSYS process table links it to bash 5001.
        m.table.procs.set(5003, { ppid: 4999, start: '103', state: '', comm: 'sleep.exe', msysParent: 5001 })
        m.table.msys = { dir: 'C:\\Program Files\\Git\\usr\\bin', ps: 'garbage' }
        const report = await host.stopProcessTree(portOf(m, runs), { pid: 5000, start: '100' })
        expect(report.tree.descendants.map(proc => proc.pid)).toEqual([5001, 5002])
        expect(report.notes).toEqual([
          'the MSYS process table of C:/Program Files/Git/usr/bin (Git Bash) could not be read: a program the worker started through Git Bash whose Windows parent has exited is not among the descendants listed, and this stop does not reach it',
        ])
        expect(signalsOf(report.steps)).toEqual(['5000 taskkill /T /F'])
        expect(report.final).toEqual([5000, 5001, 5002].map(pid => ({ pid, status: 'gone', state: '' })))
        expect([...m.table.procs.keys()].sort()).toEqual([5003, 6000])
        expect(m.table.signals.some(sent => [5003, 6000].includes(sent.pid))).toBe(false)
      })

      test(`${one.name}: stopProcessTree goes on with the Windows tree and the other MSYS tables when one ps.exe gives no answer, and says that table could not be read`, async () => {
        const GIT = 'C:\\Program Files\\Git\\usr\\bin'
        const OTHER = 'C:\\Users\\u\\gb3\\usr\\bin'
        const m = machine(one.env)
        seedTree(m)
        // The standard Git Bash 5001's sleep.exe, and a second Git Bash 5005 of another installation with its sleep.exe:
        // each linked to its bash only by the MSYS process table of its own installation.
        m.table.procs.set(5003, { ppid: 4999, start: '103', state: '', comm: 'sleep.exe', msysParent: 5001 })
        m.table.procs.set(5005, { ppid: 5000, start: '105', state: '', comm: 'bash.exe' })
        m.table.procs.set(5006, { ppid: 4996, start: '106', state: '', comm: 'sleep.exe', msysParent: 5005, msysDir: OTHER })
        m.table.msys = [{ dir: GIT }, { dir: OTHER, ps: 'hang' }]
        const report = await host.stopProcessTree(portOf(m, runs), { pid: 5000, start: '100' })
        expect(report.tree.descendants.map(proc => [proc.pid, proc.ppid, proc.state])).toEqual([
          [5001, 5000, 'S'],
          [5005, 5000, ''],
          [5002, 5001, 'S'],
          [5003, 5001, 'msys'],
        ])
        expect(report.notes).toEqual([
          `the MSYS process table of C:/Users/u/gb3/usr/bin (Git Bash) could not be read: its ps.exe gave no answer within ${MSYS_PS_MS / 1000} s and no longer runs; a program the worker started through Git Bash whose Windows parent has exited is not among the descendants listed, and this stop does not reach it`,
          'the MSYS process table of C:/Program Files/Git/usr/bin (Git Bash) was read before the first signal: 1 program the worker started through Git Bash, whose Windows parent has exited, is among the descendants listed, each with its MSYS parent',
        ])
        expect(signalsOf(report.steps)).toEqual(['5000 taskkill /T /F', '5003 taskkill /T /F'])
        expect(report.final).toEqual([5000, 5001, 5005, 5002, 5003].map(pid => ({ pid, status: 'gone', state: '' })))
        expect([...m.table.procs.keys()].sort()).toEqual([5006, 6000])
        expect(m.table.signals.some(sent => [5006, 6000].includes(sent.pid))).toBe(false)
      })

      test(`${one.name}: stopProcessTree sends taskkill /T /F at once, and its re-checks report the seconds of the clock, never the count of checks`, async () => {
        const m = machine(one.env)
        m.table.procs.set(5000, { ppid: 1, start: '100', state: '', comm: 'claude.exe', isUnkillable: true })
        m.table.procs.set(6000, { ppid: 1, start: '50', state: '', comm: 'claude.exe' })
        // Each check is a PowerShell start that takes 2.5 s: after the signal one check at once, one after a second's
        // sleep, and the 3 s of the wait are over (6 s by the clock).
        m.clock.checkMs = 2500
        const report = await host.stopProcessTree(portOf(m, runs), { pid: 5000, start: '100' })
        expect(signalsOf(report.steps)).toEqual(['5000 taskkill /T /F'])
        expect(report.steps.filter(step => step.kind === 'signal').map(step => (step.kind === 'signal' ? step.exitCode : -1))).toEqual([1])
        expect(report.steps.filter(step => step.kind === 'check')).toEqual([{ kind: 'check', pid: 5000, atMs: NOW_MS + 3 * 2500 + 1000, status: 'alive', waitedSec: 6 }])
        expect(report.final).toEqual([{ pid: 5000, status: 'alive', state: '' }])
        expect(m.table.signals).toEqual([{ pid: 5000, signal: 'taskkill /F' }])
        // Quick checks: one a second, three in the 3 s.
        const quick = machine(one.env)
        quick.table.procs.set(5000, { ppid: 1, start: '100', state: '', comm: 'claude.exe', isUnkillable: true })
        const fast = await host.stopProcessTree(portOf(quick, runs), { pid: 5000, start: '100' })
        expect(fast.steps.filter(step => step.kind === 'check').map(step => (step.kind === 'check' ? step.waitedSec : -1))).toEqual([3])
      })
    }

    test(`${one.name}: stopProcessTree signals nothing when the pid has another start (a reused pid) or is this session's own process or an ancestor of it`, async () => {
      const m = machine(one.env)
      seedTree(m)
      const port = portOf(m, runs)
      const reused = await host.stopProcessTree(port, { pid: 5000, start: '99' })
      expect(reused.tree.root).toBeUndefined()
      expect(reused.tree.rootStartNow).toBe('100')
      expect(reused.steps).toEqual([{ kind: 'skip', pid: 5000, reason: 'gone' }])
      const gone = await host.stopProcessTree(port, { pid: 7777, start: '1' })
      expect(gone.tree.rootStartNow).toBe('')
      expect(gone.steps).toEqual([{ kind: 'skip', pid: 7777, reason: 'gone' }])
      m.table.own = [5000, 900, 1]
      const own = await host.stopProcessTree(port, { pid: 5000, start: '100' })
      expect(own.steps).toEqual([{ kind: 'skip', pid: 5000, reason: 'own' }])
      expect(m.table.signals).toEqual([])
      expect(m.table.procs.size).toBe(4)
      expect(m.runs.some(argv => argv[0]?.endsWith('\\taskkill.exe') === true || argv.includes('stopProcesses'))).toBe(false)
    })

    test(`${one.name}: no operation falls back (the helper, where there is one, answers every call)`, async () => {
      const m = machine(one.env)
      const notes: string[] = []
      const port = portOf(m, runs, notes)
      m.files.set(keyOf(`${root}/orch/reg.json`), '[]\n')
      m.files.set(keyOf(`${root}/t.jsonl`), 'a\n')
      await host.probe(port, [], [])
      await host.writeAtomic(port, `${root}/orch/reg.json`, '[1]\n', '[]\n')
      await host.append(port, `${runs}/log`, ['x'], false, () => undefined)
      await host.tail(port, `${root}/t.jsonl`)
      seedTree(m)
      await host.stopProcessTree(port, { pid: 5000, start: '100' })
      expect(notes).toEqual([])
      expect(m.runs.some(argv => argv[0] === NODE && argv[1] === HELPER)).toBe(true)
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
      await startIn($, orch)
      // Linux: the helper's probe; Windows: PROBE_PS1 (the helper probes Linux only).
      const probes = m.runs.filter(argv => (argv[0] === NODE && argv[2] === 'probe') || String(argv[6]).endsWith('/probe.ps1'))
      expect(probes.length).toBeGreaterThan(0)
      expect(probes.every(argv => (adapter === 'Linux' ? argv[0] === NODE : argv[0]?.endsWith('\\powershell.exe')))).toBe(true)
    })
  }
})

// The write-side tools through the plugin on the simulated machine, Linux and Windows: files that really change, so an
// acknowledgement's write is what the retire after it reads, and a deleted run file is gone.
describe('write-side tools through the plugin, on both platforms', () => {
  const PLATFORMS: { name: string; env: Record<string, string>; root: string }[] = [
    { name: 'Linux', env: LINUX_ENV, root: '/m' },
    { name: 'Windows', env: WINDOWS_ENV, root: 'C:/m' },
  ]
  const SID_A = 'aaaa0001-1111-4111-8111-111111111111'
  const SID_B = 'bbbb0002-2222-4222-8222-222222222222'
  const SID_C = 'cccc0003-3333-4333-8333-333333333333'
  const SID_D = 'dddd0004-4444-4444-8444-444444444444'
  const SID_E = 'eeee0005-5555-4555-8555-555555555555'
  const today = localDate(NOW_MS)

  for (const p of PLATFORMS) {
    const orch = `${p.root}/orch`
    const home = `${p.root}/home`
    const runs = `${home}/.claude/session-control/runs`
    const reg = `${home}/.claude/headless-sessions.json`
    const cfg = `${home}/.claude`
    const options = { orchestratorDir: orch, registryPath: '~/.claude/headless-sessions.json', completionWrites: false }
    const boot = (on: On, m: Machine) => {
      mount(on, m)
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      on('command.register', ($, e) => ({ value: { command: e.name } }))
      on('tool.register', ($, e) => ({ value: { tool: `mcp__session-control__${e.name}` } }))
      on('ui.toast', () => ({ value: undefined }))
    }
    const put = (m: Machine, path: string, text: string) => m.files.set(keyOf(path), text)
    const get = (m: Machine, path: string) => m.files.get(keyOf(path))
    const result = (cost: number, ms: number) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: cost, duration_ms: ms })

    test(`${p.name}: retire_workers deletes the run files of a clean session it removes, in the runs directory and named by no other entry, and keeps cost and duration in the cleared log`, { options }, async ($, on) => {
      const m = machine(p.env)
      boot(on, m)
      const entries = [
        { title: 'a', session_id: SID_A, config_dir: cfg, cwd: `${p.root}/work`, reported: true, outcome: { kind: 'clean', summary: 'clean: a' }, result_file: `${runs}/20260921-a.json`, err_file: `${runs}/20260921-a.err`, prompt_file: `${runs}/20260921-a.prompt.md` },
        { title: 'c', session_id: SID_C, config_dir: cfg, cwd: `${p.root}/work`, reported: false, err_file: `${runs}/20260921-a.err` },
        { title: 'e', session_id: SID_E, config_dir: cfg, cwd: `${p.root}/work`, reported: true, result_file: `${runs}/20260921-e.json` },
      ]
      put(m, reg, `${JSON.stringify(entries, null, 2)}\n`)
      put(m, `${runs}/20260921-a.json`, result(0.12, 4500))
      put(m, `${runs}/20260921-a.err`, '')
      put(m, `${runs}/20260921-a.pid`, '4242\r\n')
      put(m, `${runs}/20260921-a.prompt.md`, 'Reply PONG.')
      put(m, `${runs}/20260921-e.json`, result(1, 1))
      await startIn($, orch)
      const out = (await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: [SID_A, SID_E] } as never)) as { result?: unknown }
      expect(String(out.result)).toBe(`Retired: aaaa0001, eeee0005. Run files deleted from ${runs}: aaaa0001 (20260921-a.json, 20260921-a.pid, 20260921-a.prompt.md).`)
      for (const gone of ['20260921-a.json', '20260921-a.pid', '20260921-a.prompt.md']) expect(get(m, `${runs}/${gone}`)).toBeUndefined()
      expect(get(m, `${runs}/20260921-a.err`)).toBe('')
      expect(get(m, `${runs}/20260921-e.json`)).toBe(result(1, 1))
      const cleared = (get(m, `${runs}/cleared.jsonl`) ?? '').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(cleared).toEqual([{ ...entries[0], cost_usd: 0.12, duration_ms: 4500 }, { ...entries[2], cost_usd: 1, duration_ms: 1 }])
      expect(JSON.parse(get(m, reg) ?? '[]')).toEqual([entries[1]])
    })

    test(`${p.name}: close_worker acknowledges then retires; the run files of a clean session go, unless outside the runs directory or named by another entry; cost and duration stay in the cleared log`, { options }, async ($, on) => {
      const m = machine(p.env)
      boot(on, m)
      const transcriptA = posixOrWindows(p.name).transcriptPath({ config_dir: cfg, cwd: `${p.root}/work`, session_id: SID_A }) ?? ''
      const entries = [
        // A: clean, all four run files in the runs directory; its error file is also C's, so it stays.
        { title: 'a', session_id: SID_A, config_dir: cfg, cwd: `${p.root}/work`, reported: false, outcome: { kind: 'clean', summary: 'clean: a' }, result_file: `${runs}/20260921-a.json`, err_file: `${runs}/20260921-a.err`, prompt_file: `${runs}/20260921-a.prompt.md` },
        // B: clean but kept: the acknowledgement clears keep, so the retire after it takes it.
        { title: 'b', session_id: SID_B, config_dir: cfg, cwd: `${p.root}/work`, reported: true, keep: true, outcome: { kind: 'clean', summary: 'clean: b' }, result_file: `${runs}/20260921-b.json` },
        { title: 'c', session_id: SID_C, config_dir: cfg, cwd: `${p.root}/work`, reported: false, err_file: `${runs}/20260921-a.err` },
        // D: clean, its result file outside the runs directory.
        { title: 'd', session_id: SID_D, config_dir: cfg, cwd: `${p.root}/work`, reported: false, outcome: { kind: 'clean', summary: 'clean: d' }, result_file: `${p.root}/elsewhere/d.json` },
        // E: no outcome (an entry from before outcomes): retired, its files kept.
        { title: 'e', session_id: SID_E, config_dir: cfg, cwd: `${p.root}/work`, reported: false, result_file: `${runs}/20260921-e.json` },
      ]
      put(m, reg, `${JSON.stringify(entries, null, 2)}\n`)
      put(m, `${runs}/20260921-a.json`, result(0.12, 4500))
      put(m, `${runs}/20260921-a.err`, '')
      put(m, `${runs}/20260921-a.pid`, '4242\r\n')
      put(m, `${runs}/20260921-a.prompt.md`, 'Reply PONG.')
      put(m, `${runs}/20260921-b.json`, result(0.5, 60000))
      put(m, `${runs}/20260921-e.json`, result(1, 1))
      put(m, `${p.root}/elsewhere/d.json`, result(2, 2))
      put(m, transcriptA, '{"type":"user"}\n')
      await startIn($, orch)
      const out = (await $.tool.call({ tool: 'mcp__session-control__close_worker', session_ids: [SID_A, SID_B, SID_D, SID_E] } as never)) as { result?: unknown }
      expect(String(out.result)).toBe(
        'Acknowledged: aaaa0001, bbbb0002, dddd0004, eeee0005. Retired: aaaa0001, bbbb0002, dddd0004, eeee0005. ' +
          `Run files deleted from ${runs}: aaaa0001 (20260921-a.json, 20260921-a.pid, 20260921-a.prompt.md); bbbb0002 (20260921-b.json).`,
      )
      for (const gone of ['20260921-a.json', '20260921-a.pid', '20260921-a.prompt.md', '20260921-b.json']) expect(get(m, `${runs}/${gone}`)).toBeUndefined()
      expect(get(m, `${runs}/20260921-a.err`)).toBe('')
      expect(get(m, `${runs}/20260921-e.json`)).toBe(result(1, 1))
      expect(get(m, `${p.root}/elsewhere/d.json`)).toBe(result(2, 2))
      expect(get(m, transcriptA)).toBe('{"type":"user"}\n')
      const cleared = (get(m, `${runs}/cleared.jsonl`) ?? '').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
      expect(cleared.map(one => one.session_id)).toEqual([SID_A, SID_B, SID_D, SID_E])
      expect(cleared[0]).toMatchObject({ session_id: SID_A, outcome: { kind: 'clean' }, cost_usd: 0.12, duration_ms: 4500 })
      expect(cleared[1]).toMatchObject({ session_id: SID_B, cost_usd: 0.5, duration_ms: 60000 })
      expect(cleared[2]).toMatchObject({ session_id: SID_D, cost_usd: 2, duration_ms: 2 })
      expect(JSON.parse(get(m, reg) ?? '[]')).toEqual([entries[2]])
    })

    test(`${p.name}: a reviewed retire deletes the run files too; a kept close leaves every file`, { options }, async ($, on) => {
      const m = machine(p.env)
      boot(on, m)
      const entries = [
        { title: 'a', session_id: SID_A, config_dir: cfg, cwd: `${p.root}/work`, reported: false, outcome: { kind: 'login', summary: 'login: wrong' }, result_file: `${runs}/20260921-a.json`, err_file: `${runs}/20260921-a.err` },
        { title: 'b', session_id: SID_B, config_dir: cfg, cwd: `${p.root}/work`, reported: false, outcome: { kind: 'clean', summary: 'clean: b' }, result_file: `${runs}/20260921-b.json` },
      ]
      put(m, reg, `${JSON.stringify(entries, null, 2)}\n`)
      put(m, `${runs}/20260921-a.json`, result(0.3, 30))
      put(m, `${runs}/20260921-a.err`, 'Please run /login\n')
      put(m, `${runs}/20260921-b.json`, result(0.4, 40))
      await startIn($, orch)
      const reviewed = (await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: [SID_A], reviewed: { aaaa0001: 'the run succeeded' } } as never)) as { result?: unknown }
      expect(String(reviewed.result)).toBe(`Retired: aaaa0001. Retired with review: aaaa0001 (was login: the run succeeded). Run files deleted from ${runs}: aaaa0001 (20260921-a.json, 20260921-a.err).`)
      const kept = (await $.tool.call({ tool: 'mcp__session-control__close_worker', session_ids: [SID_B], keep: true } as never)) as { result?: unknown }
      expect(String(kept.result)).toBe('Acknowledged and kept: bbbb0002.')
      expect(get(m, `${runs}/20260921-b.json`)).toBe(result(0.4, 40))
      expect(JSON.parse(get(m, reg) ?? '[]')).toEqual([{ ...entries[1], reported: true, keep: true }])
    })

    test(`${p.name}, helper auto: a retire deletes only regular files directly in the runs folder: a .. path, an absolute outside path, a symlinked folder, a symlinked file, a subfolder, a directory, a shared file and a non-clean outcome leave every file where it is, and are named`, { options }, async ($, on) => {
      const m = machine(p.env)
      boot(on, m)
      const out = `${p.root}/outside`
      const sid = (n: number) => `${n.toString(16).padStart(4, '0')}0${n}00-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
      const [NORMAL, DOTS, FOLDER, LINK, NESTED, SHARED, LOGIN, KEEPER] = [1, 2, 3, 4, 5, 6, 7, 8].map(sid)
      const clean = (n: string) => ({ kind: 'clean', summary: `clean: ${n}` })
      const base = { config_dir: cfg, cwd: `${p.root}/work`, reported: true }
      const entries = [
        { ...base, title: 'normal', session_id: NORMAL, outcome: clean('n'), result_file: `${runs}/n.json`, err_file: `${runs}/n.err`, prompt_file: `${runs}/n.prompt.md` },
        { ...base, title: 'dots', session_id: DOTS, outcome: clean('d'), result_file: `${runs}/../outside/x.json`, err_file: `${out}/abs.err`, prompt_file: `${runs}/./p.md` },
        { ...base, title: 'folder', session_id: FOLDER, outcome: clean('f'), result_file: `${runs}/linkdir/c.json`, err_file: `${runs}/linkdir/c.err` },
        { ...base, title: 'link', session_id: LINK, outcome: clean('l'), result_file: `${runs}/l.json`, err_file: `${runs}/ldir`, prompt_file: `${runs}/l.prompt.md` },
        { ...base, title: 'nested', session_id: NESTED, outcome: clean('s'), result_file: `${runs}/sub/s.json`, err_file: `${runs}/s.err` },
        { ...base, title: 'shared', session_id: SHARED, outcome: clean('h'), result_file: `${runs}/h.json`, prompt_file: `${runs}/adir` },
        { ...base, title: 'login', session_id: LOGIN, outcome: { kind: 'login', summary: 'login: x' }, result_file: `${runs}/g.json`, err_file: `${runs}/g.err` },
        { ...base, title: 'keeper', session_id: KEEPER, keep: true, outcome: clean('k'), result_file: `${runs}/h.json` },
      ]
      put(m, reg, `${JSON.stringify(entries, null, 2)}\n`)
      const content = new Map<string, string>()
      const file = (path: string, text = path) => {
        put(m, path, text)
        content.set(keyOf(path), text)
      }
      for (const name of ['n.json', 'n.err', 'n.pid', 'n.prompt.md']) file(`${runs}/${name}`)
      file(`${out}/x.json`)
      file(`${out}/abs.err`)
      file(`${runs}/p.md`)
      // A folder inside the runs folder that is a symbolic link out of it: the files under it are the outside folder's.
      m.links.set(keyOf(`${runs}/linkdir`), keyOf(`${p.root}/outside2`))
      file(`${p.root}/outside2/c.json`)
      file(`${p.root}/outside2/c.err`)
      // A symbolic link to a file outside, one to a folder outside, and a plain file the entry names beside them.
      m.links.set(keyOf(`${runs}/l.json`), keyOf(`${out}/target.json`))
      m.links.set(keyOf(`${runs}/ldir`), keyOf(`${p.root}/outside3`))
      file(`${out}/target.json`)
      file(`${p.root}/outside3/inner`)
      file(`${runs}/l.prompt.md`)
      file(`${runs}/sub/s.json`)
      file(`${runs}/s.err`)
      file(`${runs}/h.json`)
      file(`${runs}/adir/inner`)
      file(`${runs}/g.json`)
      file(`${runs}/g.err`)
      await startIn($, orch)
      const outcome = (await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: [NORMAL, DOTS, FOLDER, LINK, NESTED, SHARED, LOGIN] } as never)) as { result?: unknown }
      const answer = String(outcome.result)
      const short = (id: string) => id.slice(0, 8)
      expect(answer.startsWith(`Retired: ${[NORMAL, DOTS, FOLDER, LINK, NESTED, SHARED].map(short).join(', ')}.`)).toBe(true)
      expect(answer).toContain(`Refused: ${short(LOGIN)} (`)
      expect(answer).toContain(` Run files deleted from ${runs}: ${short(NORMAL)} (n.json, n.err, n.pid, n.prompt.md); ${short(LINK)} (l.prompt.md); ${short(NESTED)} (s.err).`)
      expect(answer.endsWith(
        ' (not deleted: x.json: the path has . or .. segments; not deleted: p.md: the path has . or .. segments; ' +
          'not deleted: c.json: not directly in the runs folder; not deleted: c.err: not directly in the runs folder; ' +
          'not deleted: l.json: is a symbolic link; not deleted: ldir: is a symbolic link; ' +
          'not deleted: s.json: not directly in the runs folder; not deleted: adir: is not a regular file)',
      )).toBe(true)
      // Only the plain files directly in the runs folder went; every other file holds what it held and links stay links.
      const gone = ['n.json', 'n.err', 'n.pid', 'n.prompt.md', 'l.prompt.md', 's.err']
      for (const name of gone) expect(get(m, `${runs}/${name}`)).toBeUndefined()
      for (const [key, text] of content) if (!gone.some(name => key === keyOf(`${runs}/${name}`))) expect(m.files.get(key)).toBe(text)
      expect([...m.links.keys()].sort()).toEqual([`${runs}/l.json`, `${runs}/ldir`, `${runs}/linkdir`].map(keyOf).sort())
      // The host was asked to remove only paths directly in the runs folder: nothing with a .. or a . segment, nothing
      // outside, nothing through the linked folder, nothing in a subfolder, nothing of the entry that was refused.
      expect(m.removals.map(path => path.slice(keyOf(runs).length + 1)).sort()).toEqual(['adir', 'h.pid', 'l.json', 'l.pid', 'l.prompt.md', 'ldir', 'n.err', 'n.json', 'n.pid', 'n.prompt.md', 's.err'])
      expect(m.removals.every(path => path.startsWith(`${keyOf(runs)}/`) && !path.slice(keyOf(runs).length + 1).includes('/'))).toBe(true)
      // The removals went through the helper, and nothing else removed a file.
      expect(m.runs.some(argv => argv[0] === NODE && argv[2] === 'removeFile')).toBe(true)
      expect(m.runs.every(argv => argv[0] === NODE || ['mkdir', 'test', 'git'].includes(String(argv[0])) || String(argv[0]).endsWith('\\powershell.exe'))).toBe(true)
      // The retired entries are gone from the registry whatever happened to their files; the kept and the refused stay.
      expect((JSON.parse(get(m, reg) ?? '[]') as { session_id: string }[]).map(one => one.session_id)).toEqual([LOGIN, KEEPER])
      const cleared = (get(m, `${runs}/cleared.jsonl`) ?? '').trimEnd().split('\n').map(line => (JSON.parse(line) as { session_id: string }).session_id)
      expect(cleared).toEqual([NORMAL, DOTS, FOLDER, LINK, NESTED, SHARED])
    })

    test(`${p.name}: archive_decisions moves a free section byte for byte under a dated header, leaves one summary line, backs the file up; refuses a named, a Standing and an unknown section`, { options }, async ($, on) => {
      const m = machine(p.env)
      boot(on, m)
      const decisions = [
        '# Agreed decisions',
        '',
        'One section per unit of work.',
        '',
        '## Unit A (user, 2026-09-20)',
        'unita-1. Keep the grammar.\t(tab kept)',
        'unita-2. No new dependency; trailing blanks stay.   ',
        '',
        '## Unit B - branch feature/unit-b',
        'unitb-1. One commit per feature.',
        '',
        '## Standing',
        'push-x. Pushes need no go-ahead.',
        '',
      ].join('\n')
      const sectionA = '## Unit A (user, 2026-09-20)\nunita-1. Keep the grammar.\t(tab kept)\nunita-2. No new dependency; trailing blanks stay.   \n\n'
      put(m, `${orch}/agreed-decisions.md`, decisions)
      put(m, `${orch}/task-queue.json`, JSON.stringify({ tasks: [{ id: 'q-b', status: 'queued', title: 'Follow-up on feature/unit-b' }, { id: 'q-a', status: 'done', title: 'Unit A (user, 2026-09-20) done' }] }))
      await startIn($, orch)
      const archive = (sections: string[]) => $.tool.call({ tool: 'mcp__session-control__archive_decisions', sections } as never) as Promise<{ result?: unknown; deny?: unknown }>
      // All or nothing: B is named by a queued task (by its branch), so A is not archived either.
      const refused = await archive(['Unit A (user, 2026-09-20)', 'Unit B - branch feature/unit-b', 'Standing', 'Unit C'])
      expect(String(refused.deny)).toBe(
        'session-control: nothing archived: "Unit B - branch feature/unit-b" is still named: queue task q-b (queued) names it by feature/unit-b; "Standing" is a Standing section, which is never archived; agreed-decisions.md has no section "Unit C"',
      )
      expect(get(m, `${orch}/agreed-decisions.md`)).toBe(decisions)
      expect(get(m, `${orch}/agreed-decisions-archive.md`)).toBeUndefined()
      const done = await archive(['Unit A (user, 2026-09-20)'])
      const summaryA = `- Unit A (user, 2026-09-20) (ids unita-1 to unita-2): archived ${today} to agreed-decisions-archive.md`
      expect(String(done.result)).toBe(
        `agreed-decisions.md: archived "Unit A (user, 2026-09-20)" to agreed-decisions-archive.md; the summary lines under "## Archived sections": ${summaryA}. Backup: backups/agreed-decisions-before-archive-decisions-${today}.md (once per day).`,
      )
      expect(get(m, `${orch}/agreed-decisions-archive.md`)).toBe(`# Agreed decisions archive\n\n# Archived ${today} from agreed-decisions.md\n\n${sectionA}`)
      expect(get(m, `${orch}/agreed-decisions.md`)).toBe(
        ['# Agreed decisions', '', 'One section per unit of work.', '', '## Archived sections', summaryA, '', '## Unit B - branch feature/unit-b', 'unitb-1. One commit per feature.', '', '## Standing', 'push-x. Pushes need no go-ahead.', ''].join('\n'),
      )
      expect(get(m, `${orch}/backups/agreed-decisions-before-archive-decisions-${today}.md`)).toBe(decisions)
      expect([...m.files.keys()].filter(file => file.includes('.tmp.'))).toEqual([])
      // Once the queue no longer names B: appended under a second header, the first archive's bytes untouched.
      put(m, `${orch}/task-queue.json`, JSON.stringify({ tasks: [] }))
      const second = await archive(['Unit B - branch feature/unit-b'])
      expect(String(second.result)).toContain('archived "Unit B - branch feature/unit-b"')
      expect(get(m, `${orch}/agreed-decisions-archive.md`)).toBe(
        `# Agreed decisions archive\n\n# Archived ${today} from agreed-decisions.md\n\n${sectionA}\n# Archived ${today} from agreed-decisions.md\n\n## Unit B - branch feature/unit-b\nunitb-1. One commit per feature.\n\n`,
      )
      expect(get(m, `${orch}/agreed-decisions.md`)).toBe(
        ['# Agreed decisions', '', 'One section per unit of work.', '', '## Archived sections', summaryA, `- Unit B - branch feature/unit-b (id unitb-1): archived ${today} to agreed-decisions-archive.md`, '', '## Standing', 'push-x. Pushes need no go-ahead.', ''].join('\n'),
      )
      // The backup of the day is the first one: it is written once per day.
      expect(get(m, `${orch}/backups/agreed-decisions-before-archive-decisions-${today}.md`)).toBe(decisions)
      const again = await archive(['Archived sections'])
      expect(String(again.deny)).toBe('session-control: nothing archived: "Archived sections" holds the summary lines of archived sections')
    })
  }
})

describe('TREE_PS1', () => {
  test('a table with no row TREE_PS1 can read is a table it could not read: the rows of a stand-in ps.exe that prints garbage match none, every row of a real table but its header matches', () => {
    const pattern = /-match '(\^[^']+)'/.exec(TREE_PS1)?.[1]
    expect(pattern).toBeDefined()
    const isRow = (row: string) => new RegExp(pattern ?? '$^').test(row)
    // What the stand-in ps.exe of the Windows check prints in its garbage mode, with exit code 0.
    const garbage = ['\u0001\u0002 garbage ### not a table', '      PID    PPID    PGID     WINPID', 'abc 12 34 56 78', '12 34 56', '-1 -2 -3 -4']
    expect(garbage.filter(isRow)).toEqual([])
    // `ps.exe -al` of a copy of Git for Windows 2.56.0 (Windows 11, the stand-in worker check).
    const real = [
      '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
      '      548       1     548       4936  ?         197608 00:45:53 /usr/bin/ps-real',
      '      547     545     545       9916  cons1     197608 00:45:52 /usr/bin/sleep',
      '      542       1     542       9616  ?         197608 00:45:50 /usr/bin/bash',
      '      544     542     542       2160  ?         197608 00:45:50 /usr/bin/sleep',
    ]
    expect(real.filter(isRow)).toEqual(real.slice(1))
    // No row read: the M line of a table that could not be read, before any count of what it added.
    const lines = TREE_PS1.split('\r\n')
    const noRow = lines.findIndex(line => line.includes('if ($read.Count -eq 0) { [void]$out.Append("M`t-1`t$(Flat $dir)`n"); continue }'))
    expect(noRow).toBeGreaterThan(0)
    expect(noRow).toBeLessThan(lines.findIndex(line => line.includes('$added[$dir] = 0')))
  })

  test('each ps.exe runs with a limit of its own: past it TREE_PS1 ends that ps.exe alone and reads no table from it', () => {
    expect(TREE_PS1).toContain(`$psMs = ${MSYS_PS_MS}`)
    expect(MSYS_PS_MS).toBe(5_000)
    expect(TREE_PS1).toContain('$ps = [System.Diagnostics.Process]::Start($how)')
    expect(TREE_PS1).toContain('if ($ps.WaitForExit($psMs) -and $text.Wait(1000)) {')
    expect(TREE_PS1).toContain('try { $ps.Kill() } catch { }')
    expect(TREE_PS1).toContain('if ($code -eq -2 -or $code -eq -3) { [void]$out.Append("M`t$code`t$(Flat $dir)`n"); continue }')
    // The ps.exe is run through the process it started, never by name and never by the call operator, which has no limit.
    expect(TREE_PS1).not.toContain('& "$dir\\ps.exe"')
    expect(TREE_PS1).not.toMatch(/taskkill|Stop-Process/i)
  })
})

/** The adapter of a platform's name, for the paths the tests place files at. */
function posixOrWindows(name: string): Platform {
  return name === 'Windows' ? windowsHost : posixHost
}
