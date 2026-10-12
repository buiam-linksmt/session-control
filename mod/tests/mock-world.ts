// A Linux machine for tests that drive the whole plugin through the mock engine: files in a map (with symbolic links),
// the processes of a simulated table (claude workers among them), Node 24 on the PATH and the Node helper's operations
// run over the same map and table (fake-helper.ts), its probe included (its P, A and T lines computed from the table,
// the sessions files and the transcripts in the map); the Linux adapter's own commands (test, mkdir, sleep) answered as
// the system would. With `isHelper` false Node is not found. Every write to the machine is recorded with how it was
// made, so a test can see what the plugin wrote. The helper's probeUsage answers from `usage` per config directory.
// Not a test file itself: stop.test.ts, guard.test.ts and the notice, licence, drift and digest tests use it.

import { mock } from 'claude-code/testing'
import type { FsStat, On } from 'claude-code'

import { helperAnswer, throughLinks, usageAnswerOf } from './fake-helper'
import type { ProcTable } from './fake-helper'
import { NOW_MS, worldPath } from './fixtures'

/** The usage probe's arguments after the executable, as a probe process shows them in the table. */
const USAGE_ARGS = ['-p', '/usage', '--no-session-persistence']

export const HOME = '/w/home'
export const ORCH = '/w/orch'
export const REGISTRY = `${HOME}/.claude/headless-sessions.json`
export const RUNS = `${HOME}/.claude/session-control/runs`
export const OPTIONS = { orchestratorDir: ORCH, registryPath: '~/.claude/headless-sessions.json', completionWrites: true }

/**
 * What `claude -p /usage` answers for a config directory: its text (and stderr, exit code; the helper's answer is that of
 * the case of usage-fixtures.ts that holds the text), or no claude, or no answer in time.
 */
export type UsageFake = { stdout: string; stderr?: string; exitCode?: number } | 'missing' | 'timeout'

/** One usage probe the plugin made: the directory (`inherited` when CLAUDE_CONFIG_DIR was left out) and the helper's argv. */
export type UsageRun = { configDir: string; isInherited: boolean; via: 'helper'; argv: string[] }

/** One write the plugin made: the path and how (`fs.write`, `mv`, `append`, `rm`, `helper:<op>`). */
export type Written = { path: string; via: string }

export type World = {
  files: Map<string, string>
  links: Map<string, string>
  table: ProcTable
  written: Written[]
  runs: string[][]
  tools: { name: string; description: unknown; inputSchema: unknown }[]
  toasts: string[]
  /** The Bash and PowerShell calls that reached the bottom of the chain (the guard let them through), and the file tools'. */
  passed: { tool: string; input: Record<string, unknown> }[]
  /**
   * Where the next launch's worker runs: its cwd and the session id its sessions file names. With `isFound` its command
   * line carries the model as the shell hands it on (unquoted), so the launch finds the worker and registers it; without,
   * the line keeps the quotes and the launch answers that no worker appeared (what the older tests rely on).
   */
  launch: { cwd: string; sid: string; isFound?: boolean }
  /**
   * Operations made to fail: `tree` (the helper's listing answers ok:false IO), `stop` (the helper's stop sends nothing
   * and answers ok:false IO), `helper` (node starts but the helper script is not there: exit 1, nothing on stdout).
   */
  breaks: Set<'tree' | 'stop' | 'helper'>
  /** Every path $.fs.stat was asked about, in order (with `resolve` marked `+resolve`). */
  statted: string[]
  /** Every folder $.fs.list was asked for, in order. */
  listed: string[]
  /** Files that are there but cannot be read (over the read cap, say). */
  unreadable: Set<string>
  /**
   * Named pipes: a stat answers `other`, as the engine answers for what is no file and no folder; a read is recorded in
   * `fifoReads` and never settles, as the open of a pipe that no process writes to waits.
   */
  fifos: Set<string>
  fifoReads: string[]
  /** A transcript's mtime the probe reports, epoch seconds, by session id (not listed: 5 s before the fixture's start). */
  mtimes: Map<string, number>
  /** How `git` answers (its arguments after the program); not set: exit 128, as where there is no repository. */
  git?: (args: readonly string[]) => { exitCode: number; stdout: string }
  /** The mocked clock, which moves only when a test advances it. */
  clock: ReturnType<typeof mock.clock>
  /** What `claude -p /usage` answers per CLAUDE_CONFIG_DIR (`inherited` when it is left out); a directory not here: no claude. */
  usage: Map<string, UsageFake>
  /** Every usage probe, in order. */
  usageRuns: UsageRun[]
  /** The most usage probes that were running at once. */
  usageMaxInFlight: number
  /**
   * Knobs of the usage probe: `linger` leaves each probe's claude process in the table (as the probe would show it
   * while it runs); `hold` keeps each probe running until the promise settles; `stepMs` moves the clock on that much
   * per probe; `onRun` is told when a probe starts.
   */
  usageKnobs: { linger?: boolean; hold?: Promise<void>; stepMs?: number; onRun?: () => void }
  /** Other commands by their executable (a licence picker, say): what each prints and exits with. */
  commands: Map<string, (argv: readonly string[]) => { stdout: string; exitCode: number }>
}

const ok = (stdout = '', exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** The probe's lines over the table and the map, as the helper's probe prints them for its arguments. */
function probeLines(world: World, args: readonly string[]): string {
  const lines: string[] = []
  for (const [pid, proc] of world.table.procs) if (proc.claude !== undefined) lines.push(['P', pid, 'claude', proc.claude.elapsedSec ?? 3, proc.claude.cwd, proc.claude.configDir, proc.claude.cmdline].join('\t'))
  for (const arg of args) {
    if (arg.startsWith('pid:')) {
      const [pid = '', cfg = ''] = arg.slice(4).split('|')
      const proc = world.table.procs.get(Number(pid))
      if (proc === undefined) continue
      let file: Record<string, unknown> = {}
      try {
        file = JSON.parse(world.files.get(`${cfg}/sessions/${pid}.json`) ?? '{}') as Record<string, unknown>
      } catch {
        file = {}
      }
      lines.push(['A', pid, proc.comm, proc.start, String(file.procStart ?? ''), String(file.sessionId ?? ''), proc.state].join('\t'))
    } else if (arg.startsWith('t:')) {
      const [sid = '', cfg = ''] = arg.slice(2).split('|')
      const found = [...world.files.keys()].some(key => key.startsWith(`${cfg}/projects/`) && key.endsWith(`/${sid}.jsonl`))
      if (found) lines.push(['T', sid, world.mtimes.get(sid) ?? Math.floor(NOW_MS / 1000) - 5].join('\t'))
    }
  }
  return lines.map(line => `${line}\n`).join('')
}

export function mockWorld(on: On, opts: { isHelper?: boolean; env?: Record<string, string> } = {}): World {
  const world: World = {
    files: new Map(),
    links: new Map(),
    table: { procs: new Map(), own: [3000, 1], signals: [], nowMs: NOW_MS },
    written: [],
    runs: [],
    tools: [],
    toasts: [],
    passed: [],
    launch: { cwd: '/w/work', sid: 'abcdabcd-0000-4000-8000-000000000001' },
    breaks: new Set(),
    statted: [],
    listed: [],
    unreadable: new Set(),
    fifos: new Set(),
    fifoReads: [],
    mtimes: new Map(),
    clock: mock.clock(on, { now: NOW_MS }),
    usage: new Map(),
    usageRuns: [],
    usageMaxInFlight: 0,
    usageKnobs: {},
    commands: new Map(),
  }
  const { files, links } = world
  const real = (path: string) => throughLinks(links, worldPath(path).replace(/\/+$/, ''))
  const isDir = (path: string) => [...files.keys()].some(key => key.startsWith(`${real(path)}/`))
  const record = (path: string, via: string) => world.written.push({ path, via })
  const write = (path: string, text: string, via: string) => {
    files.set(real(path), text)
    record(path, via)
  }
  let usageInFlight = 0
  /** One usage probe over `world.usage`: the fake's answer after the knobs (a process left in the table, a hold, the clock moved on). */
  const usageProbe = async <T,>(run: UsageRun, answer: (fake: UsageFake) => T): Promise<T> => {
    world.usageRuns.push(run)
    usageInFlight++
    world.usageMaxInFlight = Math.max(world.usageMaxInFlight, usageInFlight)
    try {
      world.usageKnobs.onRun?.()
      if (world.usageKnobs.linger === true) {
        const pid = 8100 + world.usageRuns.length
        world.table.procs.set(pid, { ppid: 1, start: String(pid), state: 'S', comm: 'claude', claude: { cwd: '/', configDir: run.isInherited ? '' : run.configDir, cmdline: `claude ${USAGE_ARGS.join(' ')}`, elapsedSec: 1 } })
      }
      if (world.usageKnobs.hold !== undefined) await world.usageKnobs.hold
      if (world.usageKnobs.stepMs !== undefined) await world.clock.advance(world.usageKnobs.stepMs)
      return answer(world.usage.get(run.isInherited ? 'inherited' : run.configDir) ?? 'missing')
    } finally {
      usageInFlight--
    }
  }
  mock.env(on, { HOME, ...opts.env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => {
    world.tools.push({ name: e.name, description: e.description, inputSchema: e.inputSchema })
    return { value: { tool: `mcp__session-control__${e.name}` } }
  })
  on('fs.read', ($, e) => {
    if (world.fifos.has(real(worldPath(e.path)))) {
      world.fifoReads.push(worldPath(e.path))
      return new Promise<never>(() => undefined)
    }
    if (world.unreadable.has(real(worldPath(e.path)))) throw new Error(`EFBIG ${worldPath(e.path)}`)
    const text = files.get(real(worldPath(e.path)))
    if (text === undefined) throw new Error(`ENOENT ${worldPath(e.path)}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    write(worldPath(e.path), e.text, 'fs.write')
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(real(worldPath(e.path))) || isDir(worldPath(e.path)) || world.fifos.has(real(worldPath(e.path))) }))
  on('fs.stat', ($, e) => {
    world.statted.push((e as { resolve?: boolean }).resolve === true ? `${worldPath(e.path)}+resolve` : worldPath(e.path))
    const path = worldPath(e.path).replace(/\/+$/, '')
    const target = real(path)
    const base = { mtimeMs: NOW_MS, isLink: links.has(path) }
    const realPath = (e as { resolve?: boolean }).resolve === true ? { realPath: target } : {}
    if (world.fifos.has(target)) return { value: { ...base, kind: 'other', size: 0, ...realPath } as FsStat }
    if (files.has(target)) return { value: { ...base, kind: 'file', size: (files.get(target) ?? '').length, ...realPath } as FsStat }
    if (isDir(path) || target === '/' || [HOME, ORCH, '/w', '/w/work'].includes(target)) return { value: { ...base, kind: 'dir', size: 0, ...realPath } as FsStat }
    // A link that leads nowhere is `other`, as the engine says it, with no realPath.
    if (links.has(path)) return { value: { ...base, kind: 'other', size: 0 } as FsStat }
    throw new Error(`ENOENT ${worldPath(e.path)}`)
  })
  on('fs.list', ($, e) => {
    world.listed.push(worldPath(e.path))
    const dir = real(worldPath(e.path))
    const names = new Set([...files.keys()].filter(key => key.startsWith(`${dir}/`)).map(key => key.slice(dir.length + 1).split('/')[0] ?? ''))
    // A link (in links) is listed as one, as the engine lists it: `other`, isLink, not followed.
    for (const link of links.keys()) if (link.startsWith(`${dir}/`) && !link.slice(dir.length + 1).includes('/')) names.add(link.slice(dir.length + 1))
    return {
      value: [...names].map(name =>
        links.has(`${dir}/${name}`)
          ? { name, kind: 'other', size: 0, mtimeMs: 0, isLink: true }
          : { name, kind: files.has(`${dir}/${name}`) ? 'file' : 'dir', size: (files.get(`${dir}/${name}`) ?? '').length, mtimeMs: NOW_MS },
      ) as never,
    }
  })
  on('process.run', ($, e) => {
    const argv = e.argv.map(String)
    world.runs.push(argv)
    const [cmd] = argv
    if (cmd === 'node' && argv[1] === '--version') {
      if (opts.isHelper === false) throw new Error('spawn node ENOENT')
      return { value: ok('v24.14.0\n') }
    }
    if (cmd === 'node' && argv[1]?.endsWith('/helper/host.mjs')) {
      if (world.breaks.has('helper')) return { value: { ...ok('', 1), stderr: 'Error: Cannot find module' } }
      const op = argv[2] ?? ''
      const request = JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>
      if (op === 'probeUsage') {
        const isInherited = request.isInherited === true
        return usageProbe({ configDir: String(request.configDir), isInherited, via: 'helper', argv }, fake => {
          const parsed = fake === 'missing' ? { ok: false, code: 'NO_CLAUDE' } : fake === 'timeout' ? { ok: false, code: 'TIMEOUT' } : usageAnswerOf(fake.stdout, fake.stderr, fake.exitCode)
          return { value: ok(JSON.stringify(parsed), parsed.ok ? 0 : 1) }
        })
      }
      if (op === 'processTree' && world.breaks.has('tree')) return { value: ok(JSON.stringify({ ok: false, code: 'IO' }), 1) }
      if (op === 'stopProcesses' && world.breaks.has('stop')) return { value: ok(JSON.stringify({ ok: false, code: 'IO' }), 1) }
      const steps = op === 'batch' ? (request.ops as Record<string, unknown>[]) : [{ op, ...request }]
      for (const step of steps) {
        if (['writeAtomic', 'append', 'rotate'].includes(String(step.op))) record(String(step.path), `helper:${String(step.op)}`)
        if (step.op === 'renameOver') record(String(step.to), 'helper:renameOver')
        if (step.op === 'removeFile') record(String(step.path), 'helper:removeFile')
      }
      const answer = helperAnswer(files, op, request, probeLines(world, (request.args as string[] | undefined) ?? []), real, new Map(), links, world.table)
      return { value: ok(JSON.stringify(answer), answer.ok === true ? 0 : 1) }
    }
    // The bound of a task notification's prompt on its harvest (sleep 3): it ends when the test's clock gets there, as a
    // real pause takes its time.
    if (cmd === 'sleep' && argv[1] === '3') return world.clock.sleep(3000).then(() => ({ value: ok() }))
    if (cmd === 'mkdir' || cmd === 'sleep') return { value: ok() }
    if (cmd === 'test') {
      const path = argv[2] ?? ''
      const isThere = argv[1] === '-d' ? isDir(path) || ['/w/work', ORCH].includes(path) : argv[1] === '-s' ? (files.get(real(path)) ?? '') !== '' : files.has(real(path)) || isDir(path)
      return { value: ok('', isThere ? 0 : 1) }
    }
    if (cmd === 'git') {
      const answer = world.git?.(argv.slice(1))
      return { value: answer === undefined ? ok('', 128) : ok(answer.stdout, answer.exitCode) }
    }
    const command = world.commands.get(cmd ?? '')
    if (command !== undefined) {
      const answer = command(argv)
      return { value: ok(answer.stdout, answer.exitCode) }
    }
    throw new Error(`unexpected command ${argv.join(' ')}`)
  })
  // The launch's background task: the worker appears in the table, its sessions file written as the engine writes it.
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    const command = String((e as { command?: unknown }).command ?? '')
    world.passed.push({ tool: 'Bash', input: { ...(e as object) } as Record<string, unknown> })
    const model = (world.launch.isFound === true ? /--model '?([^'\s]+)'?/ : /--model (\S+)/).exec(command)?.[1]
    if ((e as { run_in_background?: unknown }).run_in_background === true && model !== undefined && command.includes(' -p ')) {
      const pid = 7001
      // The worker's CLAUDE_CONFIG_DIR: the one on the line, else the orchestrator's own it inherits (none: the default).
      const configDir = /CLAUDE_CONFIG_DIR='([^']*)'/.exec(command)?.[1] ?? opts.env?.CLAUDE_CONFIG_DIR ?? ''
      // The session name the launch passed with -n, as the process's command line shows it.
      const name = /\s-n '([^']*)'/.exec(command)?.[1] ?? 'w-x'
      world.table.procs.set(pid, { ppid: 6999, start: '777', state: 'S', comm: 'claude', claude: { cwd: world.launch.cwd, configDir, cmdline: `claude -p --model ${model} -n ${name} --dangerously-skip-permissions --output-format json` } })
      files.set(`${configDir === '' ? `${HOME}/.claude` : configDir}/sessions/${pid}.json`, JSON.stringify({ sessionId: world.launch.sid, procStart: '777' }))
    }
    return { result: 'Command running in background with ID: mock' }
  })
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) {
    on('tool.call', { tool } as never, (($: unknown, e: Record<string, unknown>) => {
      world.passed.push({ tool, input: { ...e } })
      return { result: 'done' }
    }) as never)
  }
  on('tool.call', { tool: 'PowerShell' } as never, (($: unknown, e: Record<string, unknown>) => {
    world.passed.push({ tool: 'PowerShell', input: { ...e } })
    return { result: 'done' }
  }) as never)
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  return world
}

/** A live worker in the table and the registry: pid 4101 with its sessions file, a child bash and a grandchild sleep. */
export function seedLiveWorker(world: World, sid: string, entry: Record<string, unknown> = {}): Record<string, unknown> {
  const cfg = `${HOME}/.claude`
  world.table.procs.set(4101, { ppid: 4000, start: '5000', state: 'S', comm: 'claude', claude: { cwd: '/w/work', configDir: cfg, cmdline: 'claude -p --model haiku --output-format json' } })
  world.table.procs.set(4102, { ppid: 4101, start: '5001', state: 'S', comm: 'bash' })
  world.table.procs.set(4103, { ppid: 4102, start: '5002', state: 'S', comm: 'sleep' })
  world.files.set(`${cfg}/sessions/4101.json`, JSON.stringify({ sessionId: sid, procStart: '5000' }))
  return { title: 'live worker', pid: 4101, session_id: sid, config_dir: cfg, cwd: '/w/work', model: 'haiku', effort: 'low', result_file: `${RUNS}/live.json`, err_file: `${RUNS}/live.err`, ...entry }
}
