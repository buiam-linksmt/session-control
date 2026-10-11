// The registry-unreadable notice (notices.ts, registryStep) through the plugin on the mock world and a small Windows
// machine, on the mocked clock: an unsound registry told once per episode after 5 minutes, re-armed by a sound read,
// while the registry-based notices stay frozen.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TOAST_TITLES } from '../hooks/core'
import { REGISTRY_UNREADABLE_SEC, freshNoticeState, noticeStoreKey, registryStep } from '../hooks/notices'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, ORCH, REGISTRY, mockWorld } from './mock-world'
import type { World } from './mock-world'
import { echoPrompt, noticeLines, poll, seedOrch, startOrch, storeOf, toastsOf, userPrompt } from './notice-kit'

/** A 10 s poll: the checks are timed by the mod's clock, not by the poll; fewer polls keep the suite light. */
const POLL_OPTIONS = { ...OPTIONS, pollSeconds: 10 }

// ---------------------------------------------------------------- registry-unreadable

/** The ways a registry read is unsound, each set on the world. */
const UNSOUND: readonly [string, (world: World) => void][] = [
  ['empty', world => world.files.set(REGISTRY, '')],
  ['missing', world => world.files.delete(REGISTRY)],
  ['unreadable', world => world.unreadable.add(REGISTRY)],
  ['whitespace-only', world => world.files.set(REGISTRY, '  \n\t\n')],
  ['unparsable', world => world.files.set(REGISTRY, '[{"title": "half')],
]

const UNREADABLE_TEXT = 'the registry has been unreadable for 5 min: the registry-based notices are paused'

describe('registry-unreadable', () => {
  for (const [how, fail] of UNSOUND) {
    test(`${how} for 5 minutes: told once; not again while it stays so; a sound read re-arms it`, { options: POLL_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
      const world = mockWorld(on)
      storeOf(on)
      echoPrompt(on)
      seedOrch(world)
      const good = world.files.get(REGISTRY) ?? '[]'
      await startOrch($)
      await poll(world, 10)
      fail(world)
      // The first unsound read is the next poll's (10 s on): told 5 minutes after it.
      await poll(world, REGISTRY_UNREADABLE_SEC)
      expect(toastsOf(world.toasts, 'registry-unreadable')).toEqual([])
      await poll(world, 10)
      expect(toastsOf(world.toasts, 'registry-unreadable')).toEqual([`${TOAST_TITLES['registry-unreadable']} \u00B7 ${UNREADABLE_TEXT}`])
      expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: registry-unreadable: ${UNREADABLE_TEXT}`])
      await poll(world, 60)
      expect(toastsOf(world.toasts, 'registry-unreadable').length).toBe(1)
      // A sound read ends the episode; the next one is told again after its own 5 minutes.
      world.unreadable.delete(REGISTRY)
      world.files.set(REGISTRY, good)
      await poll(world, 10)
      fail(world)
      await poll(world, REGISTRY_UNREADABLE_SEC + 10)
      expect(toastsOf(world.toasts, 'registry-unreadable').length).toBe(2)
    })
  }

  test('flapping every other poll for 7 minutes: never told; the episode is kept in memory, never in the stored notice state', { options: POLL_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    seedOrch(world)
    const good = world.files.get(REGISTRY) ?? '[]'
    await startOrch($)
    for (let at = 0; at < 42; at++) {
      if (at % 2 === 0) world.files.set(REGISTRY, '')
      else world.files.set(REGISTRY, good)
      await poll(world, 10)
    }
    expect(toastsOf(world.toasts, 'registry-unreadable')).toEqual([])
    expect(Object.keys(store.get(noticeStoreKey(ORCH)) as object).filter(key => !Object.keys(freshNoticeState()).includes(key)).sort()).toEqual(['repoAt', 'retireCheckAt'])
  })

  test('the registry-based notices stay frozen through the episode: a live unregistered claude is not told while the registry is unreadable', { options: POLL_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world)
    world.table.procs.set(5555, { ppid: 1, start: '42', state: 'S', comm: 'claude', claude: { cwd: '/w/other', configDir: `${HOME}/.claude`, cmdline: 'claude -p --model opus --output-format json', elapsedSec: 600 } })
    world.files.set(REGISTRY, '')
    await startOrch($)
    await poll(world, REGISTRY_UNREADABLE_SEC + 30)
    expect(toastsOf(world.toasts, 'registry-unreadable').length).toBe(1)
    expect(toastsOf(world.toasts, 'orphan')).toEqual([])
  })

  test('the notices option off: never told', { options: { ...POLL_OPTIONS, notices: 'off' }, timeoutMs: 30_000 }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world)
    world.files.set(REGISTRY, '')
    await startOrch($)
    await poll(world, REGISTRY_UNREADABLE_SEC + 30)
    expect(toastsOf(world.toasts, 'registry-unreadable')).toEqual([])
  })
})

// ---------------------------------------------------------------- Windows

const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\w\\home' }
const WIN_ORCH = 'C:/w/orch'
const WIN_REGISTRY = 'C:/w/home/.claude/headless-sessions.json'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const given = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')

/** A small Windows machine: files by their C:/ path, folders listed by what is under them, the probe's A lines for `alive`. */
function winWorld(on: On, alive: number[]) {
  const w = { files: new Map<string, string>(), toasts: [] as string[], probes: [] as string[][], clock: mock.clock(on, { now: NOW_MS }) }
  mock.env(on, WIN_ENV)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-control__${e.name}` } }))
  on('fs.read', ($, e) => {
    const text = w.files.get(given(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(given(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(given(e.path)) }))
  on('fs.stat', ($, e) => {
    if (w.files.has(given(e.path))) return { value: { kind: 'file', size: 1, mtimeMs: NOW_MS, isLink: false } as never }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', ($, e) => {
    const dir = given(e.path).replace(/\/+$/, '')
    const names = new Set([...w.files.keys()].filter(key => key.startsWith(`${dir}/`)).map(key => key.slice(dir.length + 1).split('/')[0] ?? ''))
    return { value: [...names].map(name => ({ name, kind: w.files.has(`${dir}/${name}`) ? 'file' : 'dir', size: 1, mtimeMs: NOW_MS, isLink: false })) as never }
  })
  on('process.run', ($, e) => {
    const ok = { exitCode: 0, stderr: '', stdout: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === POWERSHELL && String(e.argv[6]).endsWith('/probe.ps1')) {
      const args = e.argv.slice(7).map(String)
      w.probes.push(args)
      const lines = args.filter(arg => arg.startsWith('pid:') && alive.includes(Number(arg.slice(4).split('|')[0]))).map(arg => ['A', arg.slice(4).split('|')[0], 'python', '1789998800000', '', ''].join('\t'))
      return { value: { ...ok, stdout: lines.map(line => `${line}\r\n`).join('') } }
    }
    if (e.argv[0] === POWERSHELL) return { value: ok }
    if (e.argv[0] === 'git') return { value: { ...ok, exitCode: 128 } }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }) as never)
  return w
}

const WIN_OPTIONS = { orchestratorDir: WIN_ORCH, registryPath: '~/.claude/headless-sessions.json', helper: 'off', pollSeconds: 10 }

describe('Windows host', () => {
  test('registry-unreadable: an empty registry for 5 minutes is told once', { options: WIN_OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
    const w = winWorld(on, [])
    storeOf(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    // Empty, not missing: a missing registry is created ([]) when the board starts.
    w.files.set(WIN_REGISTRY, '')
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    for (let gone = 0; gone < REGISTRY_UNREADABLE_SEC + 30; gone += 5) await w.clock.advance(5000)
    expect(toastsOf(w.toasts, 'registry-unreadable')).toEqual([`${TOAST_TITLES['registry-unreadable']} \u00B7 ${UNREADABLE_TEXT}`])
  })
})

// ---------------------------------------------------------------- the pure functions

describe('notices.ts: registryStep', () => {
  test('an episode starts at the first unsound read, is told once after 5 minutes, and ends at a sound read', () => {
    const watch = {}
    expect(registryStep(watch, false, NOW_MS)).toEqual([])
    expect(registryStep(watch, false, NOW_MS + REGISTRY_UNREADABLE_SEC * 1000 - 1)).toEqual([])
    expect(registryStep(watch, false, NOW_MS + REGISTRY_UNREADABLE_SEC * 1000)).toEqual([{ kind: 'registry-unreadable', message: UNREADABLE_TEXT, fields: { minutes: 5 } }])
    expect(registryStep(watch, false, NOW_MS + 3600_000)).toEqual([])
    expect(registryStep(watch, true, NOW_MS + 3601_000)).toEqual([])
    expect(watch).toEqual({})
    expect(registryStep(watch, false, NOW_MS + 3602_000)).toEqual([])
    expect(registryStep(watch, false, NOW_MS + 3602_000 + 7 * 60_000)[0]?.message).toBe('the registry has been unreadable for 7 min: the registry-based notices are paused')
  })
})
