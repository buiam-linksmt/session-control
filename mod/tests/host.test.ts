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
import { withHelper } from '../hooks/host-helper'
import { withPowerShellLaunch } from '../hooks/host-powershell'
import { NEWER_MAX } from '../hooks/host-shared'
import { APPEND_SCRIPT, NEWER_SCRIPT, PROBE_SCRIPT, ROTATE_SCRIPT, TAIL_SHAPED_SCRIPT, posixHost } from '../hooks/host-posix'
import { FILES_PS1, NEWER_PS1, PROBE_PS1, windowsHost } from '../hooks/host-windows'
import { localDate } from '../hooks/store'
import { helperAnswer, newerInMap } from './fake-helper'
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
  /** The files' mtimes in epoch ms (0 when unset), for the listing of the files written after a time. */
  mtimes: Map<string, number>
  runs: string[][]
  /** Milliseconds waited on the engine's clock. */
  sleeps: number[]
  read(path: string): string
  exists(path: string): boolean
  stat(path: string): FsStat
  run(argv: readonly string[], stdin?: string): Ran
}

/** The simulated machine: its files and the commands both adapters run, answered as the system would. */
function machine(env: Record<string, string>): Machine {
  const files = new Map<string, string>()
  const mtimes = new Map<string, number>()
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
  const run = (given: readonly string[], stdin?: string): Ran => {
    const argv = given.map(String)
    runs.push(argv)
    const [cmd, , script] = argv
    // Node 24 and the helper (tests/fake-helper.ts), whose probe prints what the system's own probe prints.
    if (cmd === NODE && argv[1] === '--version') return ran('v24.14.0\n')
    if (cmd === NODE && argv[1] === HELPER) {
      const isWin = env.OS === 'Windows_NT'
      const out = isWin ? '' : probeOutput('/m/work', '/m/cfg', 'claude -p --model opus --output-format json -- Goal: x')
      const answer = helperAnswer(files, String(argv[2]), JSON.parse(stdin ?? '') as Record<string, unknown>, out, keyOf, mtimes)
      return ran(JSON.stringify(answer), answer.ok === true ? 0 : 1)
    }
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
    // The listing as find, sort and awk print it: seconds with a fraction, the count last; exit 3 without the directory.
    if (cmd === 'sh' && script === NEWER_SCRIPT) {
      const found = newerInMap(files, mtimes, keyOf(argv[4] ?? ''), Number(argv[5]))
      if (found === undefined) return ran('', 3)
      return ran(`${found.slice(0, Number(argv[6])).map(one => `${(one.mtimeMs / 1000).toFixed(10)}\t${one.path}\n`).join('')}N\t${found.length}\n`)
    }
    if (cmd === 'sh' && script === PROBE_SCRIPT) return ran(probeOutput('/m/work', '/m/cfg', 'claude -p --model opus --output-format json -- Goal: x'))
    if (cmd === 'sh' && script?.startsWith('tail -n 600 ')) {
      const text = files.get(keyOf(argv[4] ?? ''))
      return text === undefined ? ran('', 1) : ran(tailLines(text, 600, 20000))
    }
    if (cmd === 'sh' && script === TAIL_SHAPED_SCRIPT) {
      const text = files.get(keyOf(argv[4] ?? ''))
      return text === undefined ? ran('', 1) : ran(tailLines(text, Number(argv[5]), Number(argv[6])).slice(-Number(argv[7])))
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
    // NEWER_PS1 prints full names with backslashes and three decimals, with PowerShell's own line ends.
    if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/newer.ps1')) {
      expect(files.get(keyOf(argv[6]))).toBe(NEWER_PS1)
      const found = newerInMap(files, mtimes, keyOf(argv[7] ?? ''), Number(argv[8]))
      if (found === undefined) return ran('', 3)
      const lines = found.slice(0, Number(argv[9])).map(one => `${(one.mtimeMs / 1000).toFixed(3)}\t${one.path.replace(/\//g, '\\')}`)
      return ran([...lines, `N\t${found.length}`, ''].join('\r\n'))
    }
    if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/probe.ps1')) {
      expect(files.get(keyOf(argv[6]))).toBe(PROBE_PS1)
      const out = probeOutput('C:\\m\\work', 'C:\\m\\cfg', '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus --output-format json -- "Goal: x"')
      return ran(out.replace(/\n/g, '\r\n'))
    }
    throw new Error(`unexpected command ${argv.join(' ')}`)
  }
  return { env, files, mtimes, runs, sleeps: [], read, exists: path => files.has(keyOf(path)) || isDir(path), stat, run }
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
    run: async (argv, init) => m.run(argv, init?.stdin),
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
    noteHelper: note => {
      if (note.kind === 'fallback') notes.push(`helper fallback: ${note.op} ${note.code}`)
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
  { host: posixHost, name: 'linux', platform: 'linux', env: LINUX_ENV, root: '/m', home: '/m/home' },
  { host: windowsHost, name: 'windows', platform: 'windows', env: WINDOWS_ENV, root: 'C:/m', home: 'C:/m/home' },
  // The same contract with the Node helper in front of each adapter.
  { host: withHelper(posixHost, { node: NODE, script: HELPER }), name: 'linux with the helper', platform: 'linux', env: LINUX_ENV, root: '/m', home: '/m/home' },
  { host: withHelper(windowsHost, { node: NODE, script: HELPER }), name: 'windows with the helper', platform: 'windows', env: WINDOWS_ENV, root: 'C:/m', home: 'C:/m/home' },
  // The Windows adapter on the PowerShell launch route (the launchRoute option at powershell), alone and behind the helper.
  { host: withPowerShellLaunch(windowsHost), name: 'windows, PowerShell route', platform: 'windows', env: WINDOWS_ENV, root: 'C:/m', home: 'C:/m/home', isPowerShellRoute: true },
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
      await host.renameOver(port, `${root}/b.tmp.1`, `${root}/b`, 'B')
      expect(at(m, `${root}/b`)).toBe('B')
      expect(at(m, `${root}/b.tmp.1`)).toBeUndefined()
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
      expect(typeof (await host.makeDir(port, runs))).toBe('boolean')
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

    test(`${one.name}: pause waits the seconds asked`, async () => {
      const m = machine(one.env)
      await host.pause(portOf(m, runs), 2)
      const waited = m.sleeps.reduce((sum, ms) => sum + ms, 0) + m.runs.filter(argv => argv[0] === 'sleep').reduce((sum, argv) => sum + Number(argv[1]) * 1000, 0)
      expect(waited).toBe(2000)
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
      expect(notes).toEqual([])
      const isHelped = one.name.endsWith('with the helper')
      expect(m.runs.some(argv => argv[0] === NODE && argv[1] === HELPER)).toBe(isHelped)
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
    const options = { orchestratorDir: orch, registryPath: '~/.claude/headless-sessions.json', helper: 'off', completionWrites: false }
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
      await $.session.start({ cwd: orch, surface: null, isInteractive: true })
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
      await $.session.start({ cwd: orch, surface: null, isInteractive: true })
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
      await $.session.start({ cwd: orch, surface: null, isInteractive: true })
      const reviewed = (await $.tool.call({ tool: 'mcp__session-control__retire_workers', session_ids: [SID_A], reviewed: { aaaa0001: 'the run succeeded' } } as never)) as { result?: unknown }
      expect(String(reviewed.result)).toBe(`Retired: aaaa0001. Retired with review: aaaa0001 (was login: the run succeeded). Run files deleted from ${runs}: aaaa0001 (20260921-a.json, 20260921-a.err).`)
      const kept = (await $.tool.call({ tool: 'mcp__session-control__close_worker', session_ids: [SID_B], keep: true } as never)) as { result?: unknown }
      expect(String(kept.result)).toBe('Acknowledged and kept: bbbb0002.')
      expect(get(m, `${runs}/20260921-b.json`)).toBe(result(0.4, 40))
      expect(JSON.parse(get(m, reg) ?? '[]')).toEqual([{ ...entries[1], reported: true, keep: true }])
    })

  }
})

/** The adapter of a platform's name, for the paths the tests place files at. */
function posixOrWindows(name: string): Host {
  return name === 'Windows' ? windowsHost : posixHost
}
