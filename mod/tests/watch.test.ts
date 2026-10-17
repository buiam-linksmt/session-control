// The lock-holder notice (decision win-27, locks.ts) and the registry-unreadable notice (notices.ts, registryStep)
// through the plugin on the mock world and a small Windows machine, on the mocked clock. Both lock formats are covered
// (the generic one and the JSON one of a real project's lock tool), and no lock is ever written.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TOAST_TITLES, parseProcFacts } from '../hooks/core'
import { LOCK_EVERY_SEC, holderState, isHolderDead, lockCandidates, lockDirsOf, lockFingerprint, lockHolder } from '../hooks/locks'
import { REGISTRY_UNREADABLE_SEC, freshNoticeState, lockStep, noticeStoreKey, parseNoticeState, registryStep } from '../hooks/notices'
import type { LockSeen, RegistryWatch } from '../hooks/notices'
import { nodeAnswer } from './fake-helper'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, ORCH, POWERSHELL, REGISTRY, WIN_ENV, WIN_ORCH, WIN_REGISTRY, mockWorld, startWinOrch, winBase, winFiles, winGiven as given } from './mock-world'
import type { World } from './mock-world'
import { echoPrompt, noticeLines, poll, seedOrch, startOrch, storeOf, toastsOf, userPrompt } from './notice-kit'

const LOCKS = '/w/locks'
const OTHER_LOCKS = '/w/other-locks'
/** A 10 s poll: the checks are timed by the mod's clock, not by the poll; fewer polls keep the suite light. */
const POLL_OPTIONS = { ...OPTIONS, pollSeconds: 10 }
const LOCK_OPTIONS = { ...POLL_OPTIONS, lockDirs: `${LOCKS}, ${OTHER_LOCKS}` }

/** A live process of the table: pid, start (/proc stat field 22), not a claude. */
const live = (world: World, pid: number, start = '9000') => world.table.procs.set(pid, { ppid: 1, start, state: 'S', comm: 'python3' })

/** A lock as a real project's lock tool writes it: an indented JSON object (json.dump with indent=1). */
const jsonLock = (pid: number, start: string) => JSON.stringify({ lock: 'jammer1', pid, pid_start: start, worker: 'w', cwd: '/w/work', host: 'h', purpose: 'arm jammer1', acquired_at: '2026-10-11T09:00:00+00:00' }, null, 1)

const deadText = (lock: string, pid: number, how = 'the first number of its holder file') =>
  `lock ${lock} is held by pid ${pid}, which is no longer alive (${how}); the mod leaves the lock as it is: release it with the tool that took it`

/** A holder whose pid is alive but belongs to a process started at another time than the lock records. */
const reusedText = (lock: string, pid: number) =>
  `lock ${lock} is held by pid ${pid}, which is no longer running as that process (its JSON pid; the pid now belongs to a process started at another time); the mod leaves the lock as it is: release it with the tool that took it`

/** A holder that has exited and is a zombie its parent has not reaped. */
const zombieText = (lock: string, pid: number, how = 'the first number of its holder file') =>
  `lock ${lock} is held by pid ${pid}, which has exited: it is a zombie its parent has not reaped (${how}); the mod leaves the lock as it is: release it with the tool that took it`

/** What the plugin wrote or ran under the lock folders: nothing, ever. */
const touched = (world: World) => [
  ...world.written.filter(one => one.path.startsWith(`${LOCKS}/`) || one.path.startsWith(`${OTHER_LOCKS}/`)).map(one => `${one.via} ${one.path}`),
  ...world.runs.filter(argv => argv.some(arg => arg.includes(LOCKS) || arg.includes(OTHER_LOCKS))).map(argv => argv.join(' ')),
]

describe('lock-holder', () => {
  test(`through the helper: a folder lock whose pid file names a dead pid is told once, as a toast and one line; the lock is never touched`, { options: LOCK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    echoPrompt(on)
    seedOrch(world)
    world.files.set(`${LOCKS}/stack/pid`, '12345\n')
    world.files.set(`${LOCKS}/stack/info`, 'taken by a worker\n')
    await startOrch($)
    await poll(world, 10)
    const text = deadText(`${LOCKS}/stack`, 12345)
    expect(toastsOf(world.toasts, 'lock-holder')).toEqual([`${TOAST_TITLES['lock-holder']} \u00B7 ${text}`])
    expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: lock-holder: ${text}`])
    await poll(world, 3 * LOCK_EVERY_SEC)
    expect(toastsOf(world.toasts, 'lock-holder').length).toBe(1)
    expect(parseNoticeState(store.get(noticeStoreKey(ORCH))).locks).toEqual({ [`${LOCKS}/stack`]: lockFingerprint('12345\n') })
    expect(touched(world)).toEqual([])
    expect(world.files.get(`${LOCKS}/stack/pid`)).toBe('12345\n')
  })

  test('the formats: a *.pid file, a *.lock file, a holder file, and the JSON lock of a real project (its pid, and its pid_start against a reused pid)', { options: LOCK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seedOrch(world)
    live(world, 5100, '7000')
    live(world, 5200, '8000')
    world.files.set(`${LOCKS}/server.pid`, '5001')
    world.files.set(`${LOCKS}/build.lock`, 'pid=5002 host=x\n')
    world.files.set(`${LOCKS}/deploy/holder`, '5003\n')
    world.files.set(`${OTHER_LOCKS}/jammer1.lock`, jsonLock(5100, '7000'))
    world.files.set(`${OTHER_LOCKS}/jammer2.lock`, jsonLock(5200, '1234'))
    world.files.set(`${OTHER_LOCKS}/dds1.lock`, jsonLock(5300, '42'))
    // The lock tool's own flock file: not a lock by name, never read.
    world.files.set(`${OTHER_LOCKS}/.guard`, '')
    await startOrch($)
    await poll(world, 10)
    // Five at once: the toasts stop at the cap of a pass (three and a summary); the next prompt carries every line.
    expect(toastsOf(world.toasts, 'lock-holder').length).toBe(3)
    expect(noticeLines(await userPrompt($)).map(line => line.slice('session-control notice: lock-holder: '.length)).sort()).toEqual(
      [
        deadText(`${LOCKS}/build.lock`, 5002),
        deadText(`${LOCKS}/deploy`, 5003),
        deadText(`${LOCKS}/server.pid`, 5001),
        deadText(`${OTHER_LOCKS}/dds1.lock`, 5300, 'its JSON pid'),
        // jammer2's pid is alive but started at another time than the lock records: the holder is gone, and the notice
        // says the pid is no longer that process.
        reusedText(`${OTHER_LOCKS}/jammer2.lock`, 5200),
      ].sort(),
    )
    expect(touched(world)).toEqual([])
  })

  test('a zombie holder (state Z in /proc/<pid>/stat, as the probe reads it) is dead, as NADIR\'s StackLocks reclaim takes it; its notice says so', { options: LOCK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seedOrch(world)
    world.table.procs.set(5400, { ppid: 1, start: '9100', state: 'Z', comm: 'python3' })
    world.table.procs.set(5500, { ppid: 1, start: '9200', state: 'S', comm: 'python3' })
    world.files.set(`${LOCKS}/zombie.pid`, '5400\n')
    world.files.set(`${OTHER_LOCKS}/jammer1.lock`, jsonLock(5400, '9100'))
    world.files.set(`${OTHER_LOCKS}/alive.lock`, jsonLock(5500, '9200'))
    await startOrch($)
    await poll(world, 10)
    expect(noticeLines(await userPrompt($)).map(line => line.slice('session-control notice: lock-holder: '.length)).sort()).toEqual(
      [zombieText(`${LOCKS}/zombie.pid`, 5400), zombieText(`${OTHER_LOCKS}/jammer1.lock`, 5400, 'its JSON pid')].sort(),
    )
    expect(touched(world)).toEqual([])
  })

  test('unreadable, odd or missing holders are skipped without a notice; a link in the lock folder is not followed', { options: LOCK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world)
    world.files.set(`${LOCKS}/unreadable.lock`, '9999\n')
    world.unreadable.add(`${LOCKS}/unreadable.lock`)
    world.files.set(`${LOCKS}/words.lock`, 'held by nobody\n')
    world.files.set(`${LOCKS}/zero.pid`, '0\n')
    world.files.set(`${LOCKS}/huge.pid`, '99999999999999\n')
    world.files.set(`${LOCKS}/later-line.lock`, 'header\n9998\n')
    world.files.set(`${LOCKS}/empty.lock`, '')
    world.files.set(`${LOCKS}/nopid.lock`, '{\n "lock": "x"\n}\n')
    world.files.set(`${LOCKS}/badpid.lock`, '{\n "pid": "x12"\n}\n')
    world.files.set(`${LOCKS}/broken.lock`, '{\n "pid": 9997,\n')
    world.files.set(`${LOCKS}/nofile/readme`, 'no holder file here\n')
    world.files.set(`${LOCKS}/notes.txt`, '9996\n')
    world.files.set('/w/elsewhere/real.lock', '9995\n')
    world.links.set(`${LOCKS}/linked.lock`, '/w/elsewhere/real.lock')
    await startOrch($)
    await poll(world, 3 * LOCK_EVERY_SEC)
    expect(toastsOf(world.toasts, 'lock-holder')).toEqual([])
    expect(touched(world)).toEqual([])
  })

  test('off by default: no lock folder is listed and nothing is told', { options: POLL_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world)
    world.files.set(`${LOCKS}/stack/pid`, '12345\n')
    await startOrch($)
    await poll(world, 3 * LOCK_EVERY_SEC)
    expect(world.listed.filter(path => path.startsWith('/w/locks'))).toEqual([])
    expect(toastsOf(world.toasts, 'lock-holder')).toEqual([])
  })

  test('the notices option off: no lock folder is listed and nothing is told', { options: { ...LOCK_OPTIONS, notices: 'off' } }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    seedOrch(world)
    world.files.set(`${LOCKS}/stack/pid`, '12345\n')
    await startOrch($)
    await poll(world, 3 * LOCK_EVERY_SEC)
    expect(world.listed.filter(path => path.startsWith('/w/locks'))).toEqual([])
    expect(toastsOf(world.toasts, 'lock-holder')).toEqual([])
    expect(store.size).toBe(0)
  })

  test('at most one check per minute, from the poll: the folders are listed once a minute', { options: LOCK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world)
    await startOrch($)
    await poll(world, 3 * LOCK_EVERY_SEC)
    // The first poll's tick (10 s) and then once a minute (70 s, 130 s): 3 checks of each folder in 3 minutes.
    expect(world.listed.filter(path => path === LOCKS).length).toBe(3)
    expect(world.listed.filter(path => path === OTHER_LOCKS).length).toBe(3)
  })
})

// ---------------------------------------------------------------- registry-unreadable

const UNREADABLE_TEXT = 'the registry has been unreadable for 5 min: the registry-based notices are paused'

describe('registry-unreadable', () => {
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

  test('registryStep: a registry file that is not there and was never seen is no episode (a fresh machine); seen once, then gone, it is; an existing unreadable or empty one is', () => {
    const fresh: RegistryWatch = {}
    expect(registryStep(fresh, false, NOW_MS, true)).toEqual([])
    expect(registryStep(fresh, false, NOW_MS + REGISTRY_UNREADABLE_SEC * 1000 + 1000, true)).toEqual([])
    expect(fresh.since).toBeUndefined()
    // Seen (the caller marks a read that found the file), then gone for 5 minutes: told.
    const seen: RegistryWatch = { isSeen: true }
    expect(registryStep(seen, false, NOW_MS + 1000, true)).toEqual([])
    expect(registryStep(seen, false, NOW_MS + 1000 + REGISTRY_UNREADABLE_SEC * 1000, true).map(one => one.kind)).toEqual(['registry-unreadable'])
    const empty: RegistryWatch = {}
    expect(registryStep(empty, false, NOW_MS)).toEqual([])
    expect(registryStep(empty, false, NOW_MS + REGISTRY_UNREADABLE_SEC * 1000).map(one => one.kind)).toEqual(['registry-unreadable'])
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

/** A small Windows machine: files by their C:/ path, folders listed by what is under them, the probe's A lines for `alive`. */
function winWorld(on: On, alive: number[]) {
  const w = { files: new Map<string, string>(), toasts: [] as string[], probes: [] as string[][], clock: mock.clock(on, { now: NOW_MS }) }
  winBase(on, WIN_ENV, w.toasts)
  winFiles(on, w.files, given)
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
    // Node and its helper's file operations over the map (the probe on Windows is PROBE_PS1's).
    const node = nodeAnswer(e.argv, e.init?.stdin, w.files, given)
    if (node !== undefined) return { value: node }
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
  return w
}

const WIN_OPTIONS = { orchestratorDir: WIN_ORCH, registryPath: '~/.claude/headless-sessions.json', pollSeconds: 10, lockDirs: 'C:\\w\\locks' }

describe('Windows host', () => {
  test('lock-holder: a dead holder in a C:\\ lock folder is told once, an alive one never (the probe proves it); a JSON lock\'s pid_start is not compared on Windows', { options: WIN_OPTIONS }, async ($, on) => {
    const w = winWorld(on, [6100, 6200])
    storeOf(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, '[]\n')
    w.files.set('C:/w/locks/dead.pid', '6000\r\n')
    w.files.set('C:/w/locks/alive.pid', '6100\r\n')
    w.files.set('C:/w/locks/tool.lock', jsonLock(6200, '1234'))
    await startWinOrch($)
    for (let gone = 0; gone < 3 * LOCK_EVERY_SEC; gone += 5) await w.clock.advance(5000)
    expect(toastsOf(w.toasts, 'lock-holder')).toEqual([`${TOAST_TITLES['lock-holder']} \u00B7 ${deadText('C:/w/locks/dead.pid', 6000)}`])
    expect(w.probes.some(args => args.includes('pid:6000|~') && args.includes('pid:6100|~'))).toBe(true)
  })

  test('registry-unreadable: an empty registry for 5 minutes is told once', { options: { ...WIN_OPTIONS, lockDirs: '' }, timeoutMs: 30_000 }, async ($, on) => {
    const w = winWorld(on, [])
    storeOf(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    // Empty, not missing: a missing registry is created ([]) when the board starts.
    w.files.set(WIN_REGISTRY, '')
    await startWinOrch($)
    for (let gone = 0; gone < REGISTRY_UNREADABLE_SEC + 30; gone += 5) await w.clock.advance(5000)
    expect(toastsOf(w.toasts, 'registry-unreadable')).toEqual([`${TOAST_TITLES['registry-unreadable']} \u00B7 ${UNREADABLE_TEXT}`])
  })
})

// ---------------------------------------------------------------- the pure functions

describe('locks.ts', () => {
  test('lockDirsOf: comma separated absolute folders, trimmed, without a trailing separator, once each', () => {
    expect(lockDirsOf('')).toEqual([])
    expect(lockDirsOf(' /tmp/nadir-locks/ , relative/x, C:\\locks\\, D:/l ,/tmp/nadir-locks')).toEqual(['/tmp/nadir-locks', 'C:\\locks', 'D:/l'])
    expect(lockDirsOf('~/locks')).toEqual([])
  })

  test('lockCandidates: folders and *.pid or *.lock files, by name; links, hidden folders and other files left out; at most 50', () => {
    const entries = [
      { name: 'b.lock', kind: 'file' },
      { name: 'a.pid', kind: 'file' },
      { name: 'stack', kind: 'dir' },
      { name: '.cache', kind: 'dir' },
      { name: '.guard', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
      { name: 'linked.lock', kind: 'other', isLink: true },
    ]
    expect(lockCandidates('/l/', entries)).toEqual([
      { lock: '/l/a.pid', isFolder: false },
      { lock: '/l/b.lock', isFolder: false },
      { lock: '/l/stack', isFolder: true },
    ])
    expect(lockCandidates('/l', Array.from({ length: 60 }, (_, at) => ({ name: `x${String(at).padStart(2, '0')}.lock`, kind: 'file' }))).length).toBe(50)
  })

  test('lockHolder: the first integer of the first line, or a JSON object\'s pid and pid_start; anything else is no holder', () => {
    expect(lockHolder('12345\n')).toEqual({ pid: 12345, isJson: false })
    expect(lockHolder('pid=77 host=h\n99\n')).toEqual({ pid: 77, isJson: false })
    expect(lockHolder('  4242  ')).toEqual({ pid: 4242, isJson: false })
    expect(lockHolder(jsonLock(5100, '7000'))).toEqual({ pid: 5100, start: '7000', isJson: true })
    expect(lockHolder('{"pid": "5100"}')).toEqual({ pid: 5100, isJson: true })
    expect(lockHolder('{"pid": 5100, "pid_start": 88}')).toEqual({ pid: 5100, start: '88', isJson: true })
    for (const odd of ['', 'none\n12', '0', '-5', 'pid -77', '99999999999999', '{"lock":"x"}', '{"pid":"x1"}', '{"pid": 0}', '{"pid": 1.5}', '[1, 2]', 'header\n9998']) expect(lockHolder(odd)).toBeUndefined()
    // A broken JSON text falls to the generic rule: its first line holds no number.
    expect(lockHolder('{\n "pid": 9997,\n')).toBeUndefined()
  })

  test('isHolderDead: a pid that is gone; on Linux a JSON pid_start that is not the process\'s own start', () => {
    expect(isHolderDead({ pid: 1, isJson: false }, { isAlive: false }, true)).toBe(true)
    expect(isHolderDead({ pid: 1, isJson: false }, { isAlive: true, startTicks: '5' }, true)).toBe(false)
    expect(isHolderDead({ pid: 1, start: '5', isJson: true }, { isAlive: true, startTicks: '5' }, true)).toBe(false)
    expect(isHolderDead({ pid: 1, start: '5', isJson: true }, { isAlive: true, startTicks: '6' }, true)).toBe(true)
    expect(isHolderDead({ pid: 1, start: '5', isJson: true }, { isAlive: true, startTicks: '6' }, false)).toBe(false)
    expect(isHolderDead({ pid: 1, start: '5', isJson: true }, { isAlive: true, startTicks: '' }, true)).toBe(false)
  })

  test('holderState: gone, reused (Linux, a JSON pid_start that differs), zombie (Linux, state Z), alive; a zombie and a reused pid are dead; Windows compares neither', () => {
    expect(holderState({ pid: 1, isJson: false }, { isAlive: false }, true)).toBe('gone')
    expect(holderState({ pid: 1, start: '5', isJson: true }, { isAlive: true, startTicks: '6' }, true)).toBe('reused')
    expect(holderState({ pid: 1, isJson: false }, { isAlive: true, startTicks: '5', state: 'Z' }, true)).toBe('zombie')
    expect(holderState({ pid: 1, start: '5', isJson: true }, { isAlive: true, startTicks: '5', state: 'Z' }, true)).toBe('zombie')
    expect(holderState({ pid: 1, isJson: false }, { isAlive: true, startTicks: '5', state: 'S' }, true)).toBe('alive')
    expect(holderState({ pid: 1, isJson: false }, { isAlive: true, state: 'Z' }, false)).toBe('alive')
    expect(isHolderDead({ pid: 1, isJson: false }, { isAlive: true, startTicks: '5', state: 'Z' }, true)).toBe(true)
    // The probe's A line carries the state as its seventh column; an older line without it has none.
    expect(parseProcFacts('A\t7\tpython3\t100\t\t\tZ\n').pidProof.get(7)?.state).toBe('Z')
    expect(parseProcFacts('A\t7\tpython3\t100\t\t\n').pidProof.get(7)?.state).toBeUndefined()
  })

  test('lockStep: told once per content; a changed content re-arms; a lock gone or alive again is forgotten; a folder not read keeps its locks', () => {
    const state = freshNoticeState()
    const dead = (lock: string, fingerprint = 'f1'): LockSeen => ({ lock, fingerprint, pid: 9, isJson: false, isDead: true })
    expect(lockStep(state, [dead('/l/a')], ['/l']).map(one => one.kind)).toEqual(['lock-holder'])
    expect(lockStep(state, [dead('/l/a')], ['/l'])).toEqual([])
    expect(lockStep(state, [dead('/l/a', 'f2')], ['/l']).length).toBe(1)
    expect(lockStep(state, [], [])).toEqual([])
    expect(state.locks).toEqual({ '/l/a': 'f2' })
    expect(lockStep(state, [{ ...dead('/l/a', 'f2'), isDead: false }], ['/l'])).toEqual([])
    expect(state.locks).toBeUndefined()
    expect(lockStep(state, [dead('/l/a', 'f2')], ['/l']).length).toBe(1)
    expect(lockStep(state, [], ['/l'])).toEqual([])
    expect(state.locks).toBeUndefined()
  })
})

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
