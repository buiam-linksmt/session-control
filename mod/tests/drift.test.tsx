// The loaded-mod drift band (decision win-35, drift.ts) through the plugin on the mock world: the loaded plugin's
// folder against the source mod folder, by the Node helper's hashTree and by the native hash, the band above the prompt,
// its one toast and notice line, the 5-minute rhythm, what is never compared, the source missing, the helper and Node
// missing, the notices option, modSource off, and a small Windows machine. The kit loads the plugin from the real mod
// folder ($.plugin.root): its first check finds that folder, which each test then links to /w/loaded on the mock world
// (or C:/w/loaded on the Windows one) and fills with the loaded copy.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TOAST_TITLES } from '../hooks/core'
import { DRIFT_EVERY_SEC, DRIFT_SPEC, changedFiles, driftBandText, driftEverySec, driftNoticeMessage, sourceModDir } from '../hooks/drift'
import { base64Bytes, cyrb53, driftBytes, driftText, nativeHashTrees } from '../hooks/host-shared'
import { driftStep, freshNoticeState, noticeStoreKey, parseNoticeState } from '../hooks/notices'
import { listInMap } from './fake-helper'
import { NOW_MS } from './fixtures'
import { OPTIONS, ORCH, mockWorld } from './mock-world'
import type { World } from './mock-world'
import { echoPrompt, noticeLines, poll, seedOrch, startOrch, storeOf, toastsOf, userPrompt } from './notice-kit'

const SOURCE = '/w/src/mod'
const LOADED = '/w/loaded'
/** A 10 s poll: the checks are timed by the mod's clock, not by the poll; fewer polls keep the suite light. */
const SOURCE_OPTIONS = { ...OPTIONS, modSource: SOURCE, pollSeconds: 10 }
/**
 * The documented test-only shortening (drift.ts, driftEverySec): most tests check every EVERY seconds, so the mocked
 * clock has fewer polls to run; the 5-minute rhythm itself is tested at its real length.
 */
const FAST = { SESSION_CONTROL_TEST: '1', SESSION_CONTROL_DRIFT_SECONDS: '20' }
const EVERY = 20
/** The time a test of the real 5-minute rhythm may take on the mocked clock. */
const LONG = { timeoutMs: 30_000 }

/** A mod folder: the compared files, and some that never are (tests, the engine's generated types). */
const MOD_FILES: Record<string, string> = {
  'hooks/register.tsx': 'export const register = () => undefined\n',
  'hooks/core.ts': 'export const core = 1\n',
  'helper/host.mjs': '// helper\n',
  'types/index.d.ts': 'export type X = 1\n',
  '.claude-plugin/plugin.json': '{"name":"session-control"}\n',
  '.claude-plugin/types/claude-code.d.ts': '// generated\n',
  'tests/core.test.ts': '// a test\n',
}

function seedMod(world: World, dir: string, files: Record<string, string> = MOD_FILES): void {
  for (const [rel, text] of Object.entries(files)) world.files.set(`${dir}/${rel}`, text)
}

/** The engine's own band, beneath the plugin: what shows when the plugin passes. */
function engineBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
}

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 } }

/** The band's first line as the terminal draws it: its first Text (the drift line drawn above the band beneath it). */
async function bandOf($: { ui: { mount: (target: never) => Promise<{ findAll: (q: object) => Promise<unknown[]> }> } }, props: Record<string, unknown> = BAND_PROPS): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'AbovePrompt', props } as never)
  return String(((await ui.findAll({ type: 'Text' }))[0] as { text?: string } | undefined)?.text ?? '')
}

/** Every Text of the band, in order. */
async function bandLines($: { ui: { mount: (target: never) => Promise<{ findAll: (q: object) => Promise<unknown[]> }> } }): Promise<string[]> {
  const ui = await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS } as never)
  return (await ui.findAll({ type: 'Text' })).map(one => String((one as { text?: string }).text ?? ''))
}

/** The loaded plugin's folder as the first check asked for it: the first $.fs.stat with resolve outside the mock world's /w. */
const pluginRoot = (world: World) => world.statted.find(one => one.endsWith('+resolve') && !one.startsWith('/w/'))?.replace(/\+resolve$/, '')

/**
 * The start: the orchestrator and the source mod seeded, the plugin started (its first check finds the plugin's own
 * folder, not on the mock world: nothing to compare yet), then that folder linked to /w/loaded and filled with
 * `loaded`. The next check is one interval later (EVERY with the shortening, else DRIFT_EVERY_SEC).
 */
async function started($: Parameters<Parameters<typeof test>[2]>[0], world: World, loaded: Record<string, string> = MOD_FILES, source: Record<string, string> = MOD_FILES): Promise<void> {
  seedOrch(world)
  seedMod(world, SOURCE, source)
  await startOrch($)
  const root = pluginRoot(world)
  expect(root).toBeDefined()
  world.links.set(root ?? '', LOADED)
  seedMod(world, LOADED, loaded)
}

/** The checks run so far: each one resolves the source folder once. */
const checks = (world: World) => world.statted.filter(one => one === `${SOURCE}+resolve`).length

const changedOne = { ...MOD_FILES, 'hooks/core.ts': 'export const core = 2\n' }
const BAND_ONE = `session-control: the loaded mod differs from ${SOURCE} (1 file changed: hooks/core.ts). Reload it: copy hooks, helper, types and plugin.json to the plugin folder, or restart with --plugin-dir ${SOURCE}`
const TOAST_ONE = `${TOAST_TITLES['mod-drift']} \u00B7 the loaded mod differs from ${SOURCE} (1 file changed: hooks/core.ts); the band above the prompt says how to reload it`

describe('the drift band on the mock world', () => {
  for (const isHelper of [false, true]) {
    const how = isHelper ? 'by the helper' : 'natively'

    test(`${how}: the two folders match: no band, no toast, no notice line`, { options: SOURCE_OPTIONS }, async ($, on) => {
      const world = mockWorld(on, { isHelper, env: FAST })
      storeOf(on)
      echoPrompt(on)
      engineBand(on)
      await started($, world)
      await poll(world, EVERY)
      expect(checks(world)).toBe(2)
      expect(await bandOf($)).toBe('engine band')
      expect(toastsOf(world.toasts, 'mod-drift')).toEqual([])
      expect(noticeLines(await userPrompt($))).toEqual([])
      // The helper's hashTree did the comparing (one batch for both folders), or no process at all.
      const batches = world.runs.filter(argv => argv[0] === 'node' && argv[2] === 'batch')
      expect(batches.length).toBe(isHelper ? 2 : 0)
    })

    test(`${how}: one changed file: the band, one toast and one notice line; the next checks tell nothing again`, { options: SOURCE_OPTIONS }, async ($, on) => {
      const world = mockWorld(on, { isHelper, env: FAST })
      const store = storeOf(on)
      echoPrompt(on)
      engineBand(on)
      await started($, world, changedOne)
      await poll(world, EVERY)
      expect(await bandOf($)).toBe(BAND_ONE)
      expect(toastsOf(world.toasts, 'mod-drift')).toEqual([TOAST_ONE])
      expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: mod-drift: the loaded mod differs from ${SOURCE} (1 file changed: hooks/core.ts); the band above the prompt says how to reload it`])
      expect(parseNoticeState(store.get(noticeStoreKey(ORCH))).drift).toBe('hooks/core.ts')
      await poll(world, 2 * EVERY)
      expect(checks(world)).toBe(4)
      expect(await bandOf($)).toBe(BAND_ONE)
      expect(toastsOf(world.toasts, 'mod-drift').length).toBe(1)
      expect(noticeLines(await userPrompt($))).toEqual([])
    })

    test(`${how}: an added file and a removed file count; past three names the band ends with ...`, { options: SOURCE_OPTIONS }, async ($, on) => {
      const world = mockWorld(on, { isHelper, env: FAST })
      storeOf(on)
      engineBand(on)
      const loaded: Record<string, string> = { ...MOD_FILES, 'hooks/added.ts': 'new\n' }
      delete loaded['helper/host.mjs']
      await started($, world, loaded)
      await poll(world, EVERY)
      expect(await bandOf($)).toContain(`(2 files changed: helper/host.mjs, hooks/added.ts). Reload it:`)
      world.files.set(`${LOADED}/types/index.d.ts`, 'export type X = 2\n')
      world.files.set(`${LOADED}/.claude-plugin/plugin.json`, '{"name":"session-control","version":"2"}\n')
      await poll(world, EVERY)
      expect(await bandOf($)).toContain(`(4 files changed: .claude-plugin/plugin.json, helper/host.mjs, hooks/added.ts, ...). Reload it:`)
      // A new set of changed files is told again.
      expect(toastsOf(world.toasts, 'mod-drift').length).toBe(2)
    })

    test(`${how}: the engine's generated .claude-plugin/types, tests/ and a folder inside hooks/ are never compared`, { options: SOURCE_OPTIONS }, async ($, on) => {
      const world = mockWorld(on, { isHelper, env: FAST })
      storeOf(on)
      engineBand(on)
      await started($, world, { ...MOD_FILES, '.claude-plugin/types/claude-code.d.ts': '// generated again\n', 'tests/core.test.ts': '// changed\n', 'tests/new.test.ts': 'x', 'hooks/deeper/x.ts': 'x', 'node_modules/a/index.js': 'x' })
      await poll(world, EVERY)
      expect(await bandOf($)).toBe('engine band')
      expect(toastsOf(world.toasts, 'mod-drift')).toEqual([])
    })

    test(`${how}: a symbolic link in hooks/ is neither followed nor hashed`, { options: SOURCE_OPTIONS }, async ($, on) => {
      const world = mockWorld(on, { isHelper, env: FAST })
      storeOf(on)
      engineBand(on)
      await started($, world)
      // In the loaded copy hooks/linked.ts is a link to a file outside: not compared, so the folders still match.
      world.files.set('/w/outside/secret.ts', 'outside\n')
      world.links.set(`${LOADED}/hooks/linked.ts`, '/w/outside/secret.ts')
      await poll(world, EVERY)
      expect(await bandOf($)).toBe('engine band')
    })
  }

  test('the source folder is not there: no band, nothing hashed, nothing told', { options: { ...SOURCE_OPTIONS, modSource: '/w/nowhere/mod' } }, async ($, on) => {
    const world = mockWorld(on, { isHelper: true, env: FAST })
    storeOf(on)
    engineBand(on)
    seedOrch(world)
    await startOrch($)
    await poll(world, EVERY)
    expect(await bandOf($)).toBe('engine band')
    expect(world.runs.filter(argv => argv[0] === 'node' && argv[2] === 'batch')).toEqual([])
    expect(world.statted.some(one => one.endsWith('+resolve'))).toBe(false)
    expect(toastsOf(world.toasts, 'mod-drift')).toEqual([])
  })

  test('the default source is <orchestrator directory>/mod when it exists', { options: { ...OPTIONS, pollSeconds: 10 } }, async ($, on) => {
    const world = mockWorld(on, { env: FAST })
    storeOf(on)
    engineBand(on)
    seedOrch(world)
    seedMod(world, `${ORCH}/mod`)
    await startOrch($)
    world.links.set(pluginRoot(world) ?? '', LOADED)
    seedMod(world, LOADED, changedOne)
    await poll(world, EVERY)
    expect(await bandOf($)).toBe(BAND_ONE.replaceAll(SOURCE, `${ORCH}/mod`))
  })

  test('modSource off: no band, nothing looked at', { options: { ...SOURCE_OPTIONS, modSource: 'off' } }, async ($, on) => {
    const world = mockWorld(on, { env: FAST })
    storeOf(on)
    engineBand(on)
    seedOrch(world)
    seedMod(world, `${ORCH}/mod`, changedOne)
    await startOrch($)
    await poll(world, EVERY)
    expect(await bandOf($)).toBe('engine band')
    expect(world.statted.some(one => one.endsWith('+resolve'))).toBe(false)
  })

  test('the helper missing (node starts, the script does not answer): the native hash shows the band; one fallback toast in all', { options: SOURCE_OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { isHelper: true, env: FAST })
    storeOf(on)
    engineBand(on)
    world.breaks.add('helper')
    await started($, world, changedOne)
    await poll(world, EVERY)
    expect(await bandOf($)).toBe(BAND_ONE)
    // The helper was asked (one batch for both folders) and failed; the native hash answered. The fallback toast is said
    // once per load, here by the first operation that fell back (the probe's).
    expect(world.runs.some(argv => argv[0] === 'node' && argv[2] === 'batch')).toBe(true)
    expect(world.toasts.filter(text => text.startsWith(`${TOAST_TITLES.helper} \u00B7 `)).length).toBe(1)
  })

  test('Node missing: the native hash shows the band, no helper call', { options: SOURCE_OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { isHelper: false, env: FAST })
    storeOf(on)
    engineBand(on)
    await started($, world, changedOne)
    await poll(world, EVERY)
    expect(await bandOf($)).toBe(BAND_ONE)
    expect(world.runs.filter(argv => argv[0] === 'node' && argv[1] !== '--version')).toEqual([])
  })

  test('the 5-minute rule: a change is seen at the next check, never before; the band goes after a match and a new drift is told again', { options: SOURCE_OPTIONS, ...LONG }, async ($, on) => {
    const world = mockWorld(on, { isHelper: true })
    storeOf(on)
    engineBand(on)
    await started($, world)
    await poll(world, DRIFT_EVERY_SEC)
    expect(checks(world)).toBe(2)
    world.files.set(`${SOURCE}/hooks/core.ts`, 'export const core = 3\n')
    await poll(world, DRIFT_EVERY_SEC - 5)
    expect(checks(world)).toBe(2)
    expect(await bandOf($)).toBe('engine band')
    await poll(world, 5)
    expect(checks(world)).toBe(3)
    expect(await bandOf($)).toBe(BAND_ONE)
    expect(toastsOf(world.toasts, 'mod-drift').length).toBe(1)
    // The source is put back: the band goes at the next check.
    world.files.set(`${SOURCE}/hooks/core.ts`, MOD_FILES['hooks/core.ts'] ?? '')
    await poll(world, DRIFT_EVERY_SEC - 5)
    expect(await bandOf($)).toBe(BAND_ONE)
    await poll(world, 5)
    expect(await bandOf($)).toBe('engine band')
    // The same file differs again: the match cleared the notice, so it is told once more.
    world.files.set(`${SOURCE}/hooks/core.ts`, 'export const core = 3\n')
    await poll(world, DRIFT_EVERY_SEC)
    expect(toastsOf(world.toasts, 'mod-drift').length).toBe(2)
    // At most one check per interval in all, whatever the poll does: 5 checks in 15 minutes and the start.
    expect(checks(world)).toBe(5)
  })

  test('the test-only shortening: with SESSION_CONTROL_TEST=1 and SESSION_CONTROL_DRIFT_SECONDS=20 the check runs every 20 s', { options: SOURCE_OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { env: { SESSION_CONTROL_TEST: '1', SESSION_CONTROL_DRIFT_SECONDS: '20' } })
    storeOf(on)
    engineBand(on)
    await started($, world, changedOne)
    await poll(world, 20)
    expect(checks(world)).toBe(2)
    expect(await bandOf($)).toBe(BAND_ONE)
  })

  test('the shortening alone (no SESSION_CONTROL_TEST=1) is inert: still every 5 minutes', { options: SOURCE_OPTIONS, ...LONG }, async ($, on) => {
    const world = mockWorld(on, { env: { SESSION_CONTROL_DRIFT_SECONDS: '20' } })
    storeOf(on)
    engineBand(on)
    await started($, world, changedOne)
    await poll(world, DRIFT_EVERY_SEC - 5)
    expect(checks(world)).toBe(1)
    await poll(world, 5)
    expect(checks(world)).toBe(2)
  })

  test('notices off: the band still shows; no toast, no notice line, nothing stored', { options: { ...SOURCE_OPTIONS, notices: 'off' } }, async ($, on) => {
    const world = mockWorld(on, { env: FAST })
    const store = storeOf(on)
    echoPrompt(on)
    engineBand(on)
    await started($, world, changedOne)
    await poll(world, EVERY)
    expect(await bandOf($)).toBe(BAND_ONE)
    expect(toastsOf(world.toasts, 'mod-drift')).toEqual([])
    expect(noticeLines(await userPrompt($))).toEqual([])
    expect(store.size).toBe(0)
  })

  test('the drift line goes above the band beneath it, which stays drawn (another plugin\'s band, or the engine\'s own)', { options: SOURCE_OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { env: FAST })
    storeOf(on)
    engineBand(on)
    await started($, world, changedOne)
    await poll(world, EVERY)
    expect(await bandLines($)).toEqual([BAND_ONE, 'engine band'])
  })

  test('a survey holds the band: the engine draws', { options: SOURCE_OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { env: FAST })
    storeOf(on)
    engineBand(on)
    await started($, world, changedOne)
    await poll(world, EVERY)
    expect(await bandOf($, { ...BAND_PROPS, hasSurvey: true })).toBe('engine band')
    expect(await bandOf($)).toBe(BAND_ONE)
  })

  test('outside the orchestrator directory nothing is checked and the band is the engine\'s', { options: { ...SOURCE_OPTIONS, orchestratorDir: '' } }, async ($, on) => {
    const world = mockWorld(on, { env: FAST })
    engineBand(on)
    seedMod(world, SOURCE, changedOne)
    await $.session.start({ cwd: '/w/work', surface: null, isInteractive: true } as never)
    await poll(world, EVERY)
    expect(world.statted.some(one => one.endsWith('+resolve'))).toBe(false)
    expect(await bandOf($)).toBe('engine band')
  })
})

// ---------------------------------------------------------------- Windows

const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\w\\home' }
const WIN_ORCH = 'C:/w/orch'
const WIN_SOURCE = 'C:/w/src/mod'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** A path as the plugin gave it: on a Linux host the kit takes C:/x for a relative path after the session's directory. */
const given = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')

/** A small Windows machine: files by their C:/ path, folders by what is under them, the plugin's folder linked to C:/w/loaded once known, the probe empty. */
function winWorld(on: On) {
  const w = { files: new Map<string, string>(), toasts: [] as string[], root: undefined as string | undefined, clock: mock.clock(on, { now: NOW_MS }) }
  const key = (path: string) => {
    const one = given(path).replace(/\/+$/, '')
    return w.root !== undefined && (one === w.root || one.startsWith(`${w.root}/`)) ? `C:/w/loaded${one.slice(w.root.length)}` : one
  }
  const isDir = (path: string) => [...w.files.keys()].some(file => file.startsWith(`${key(path)}/`))
  mock.env(on, WIN_ENV)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-control__${e.name}` } }))
  on('fs.read', ($, e) => {
    const text = w.files.get(key(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: w.files.has(key(e.path)) || isDir(e.path) }))
  on('fs.stat', ($, e) => {
    if ((e as { resolve?: boolean }).resolve === true && w.root === undefined && !given(e.path).startsWith('C:/')) w.root = given(e.path).replace(/\/+$/, '')
    const real = (e as { resolve?: boolean }).resolve === true ? { realPath: key(e.path) } : {}
    if (w.files.has(key(e.path))) return { value: { kind: 'file', size: 1, mtimeMs: NOW_MS, isLink: false, ...real } as never }
    if (isDir(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: NOW_MS, isLink: false, ...real } as never }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', ($, e) => ({ value: listInMap(w.files, new Map(), key(e.path)) as never }))
  on('process.run', ($, e) => {
    const ok = { exitCode: 0, stderr: '', stdout: '', isStdoutTruncated: false, isStderrTruncated: false }
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

describe('the drift band on a Windows machine', () => {
  test('natively over C:/ paths: one changed file shows the band and one toast; a match takes it away', { options: { orchestratorDir: WIN_ORCH, registryPath: '~/.claude/headless-sessions.json', helper: 'off', modSource: WIN_SOURCE, pollSeconds: 10 }, ...LONG }, async ($, on) => {
    const w = winWorld(on)
    storeOf(on)
    engineBand(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set('C:/w/home/.claude/headless-sessions.json', '[]\n')
    for (const [rel, text] of Object.entries(MOD_FILES)) w.files.set(`${WIN_SOURCE}/${rel}`, text)
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    expect(w.root).toBeDefined()
    for (const [rel, text] of Object.entries(changedOne)) w.files.set(`C:/w/loaded/${rel}`, text)
    for (let gone = 0; gone < DRIFT_EVERY_SEC; gone += 5) await w.clock.advance(5000)
    const band = BAND_ONE.replaceAll(SOURCE, WIN_SOURCE)
    expect(await bandOf($)).toBe(band)
    expect(toastsOf(w.toasts, 'mod-drift')).toEqual([TOAST_ONE.replaceAll(SOURCE, WIN_SOURCE)])
    w.files.set('C:/w/loaded/hooks/core.ts', MOD_FILES['hooks/core.ts'] ?? '')
    for (let gone = 0; gone < DRIFT_EVERY_SEC; gone += 5) await w.clock.advance(5000)
    expect(await bandOf($)).toBe('engine band')
  })
})

// ---------------------------------------------------------------- the pure functions

describe('drift.ts', () => {
  test('driftEverySec: 300 s unless SESSION_CONTROL_TEST=1 with a whole number of seconds from 5 up to below 300', () => {
    expect(driftEverySec(undefined, undefined)).toBe(300)
    expect(driftEverySec(undefined, '20')).toBe(300)
    expect(driftEverySec('true', '20')).toBe(300)
    expect(driftEverySec('0', '20')).toBe(300)
    expect(driftEverySec('1', '20')).toBe(20)
    expect(driftEverySec('1', ' 20 ')).toBe(20)
    expect(driftEverySec('1', '4')).toBe(300)
    expect(driftEverySec('1', '300')).toBe(300)
    expect(driftEverySec('1', '2.5')).toBe(300)
    expect(driftEverySec('1', '-20')).toBe(300)
    expect(driftEverySec('1', undefined)).toBe(300)
  })

  test('sourceModDir: the option, off, or <orchestrator directory>/mod', () => {
    expect(sourceModDir('', '/w/orch/')).toBe('/w/orch/mod')
    expect(sourceModDir('  ', '/w/orch')).toBe('/w/orch/mod')
    expect(sourceModDir('', '')).toBeUndefined()
    expect(sourceModDir('off', '/w/orch')).toBeUndefined()
    expect(sourceModDir('OFF', '/w/orch')).toBeUndefined()
    expect(sourceModDir('~/src/mod', '/w/orch')).toBe('~/src/mod')
  })

  test('changedFiles: changed, added and removed, sorted', () => {
    const a = { method: 'sha256' as const, files: { 'hooks/a.ts': '1', 'hooks/b.ts': '2', 'types/x.d.ts': '3' } }
    const b = { method: 'sha256' as const, files: { 'hooks/a.ts': '1', 'hooks/b.ts': '9', 'helper/h.mjs': '4' } }
    expect(changedFiles(a, b)).toEqual(['helper/h.mjs', 'hooks/b.ts', 'types/x.d.ts'])
    expect(changedFiles(a, a)).toEqual([])
  })

  test('the band and the notice: the count, up to three names, nothing else', () => {
    expect(driftBandText('/r/mod', ['a'])).toBe('session-control: the loaded mod differs from /r/mod (1 file changed: a). Reload it: copy hooks, helper, types and plugin.json to the plugin folder, or restart with --plugin-dir /r/mod')
    expect(driftBandText('/r/mod', ['a', 'b', 'c', 'd'])).toContain('(4 files changed: a, b, c, ...)')
    expect(driftNoticeMessage('/r/mod', ['a', 'b'])).toBe('the loaded mod differs from /r/mod (2 files changed: a, b); the band above the prompt says how to reload it')
    expect(DRIFT_SPEC).toEqual({ dirs: ['hooks', 'helper', 'types'], files: ['.claude-plugin/plugin.json'] })
  })

  test('driftStep: told once per set of changed files; a match clears it; an unread folder changes nothing', () => {
    const state = freshNoticeState()
    expect(driftStep(state, undefined, 'm')).toEqual([])
    expect(driftStep(state, ['a'], 'm').map(one => one.kind)).toEqual(['mod-drift'])
    expect(driftStep(state, ['a'], 'm')).toEqual([])
    expect(driftStep(state, undefined, 'm')).toEqual([])
    expect(state.drift).toBe('a')
    expect(driftStep(state, ['a', 'b'], 'm').length).toBe(1)
    expect(driftStep(state, [], 'm')).toEqual([])
    expect(state.drift).toBeUndefined()
    expect(driftStep(state, ['a', 'b'], 'm').length).toBe(1)
    // The stored state keeps it, and a fresh one has none (the stored notice state of a mod in step is as before).
    expect(parseNoticeState(JSON.parse(JSON.stringify(state))).drift).toBe('a\nb')
    expect('drift' in freshNoticeState()).toBe(false)
  })

  test('cyrb53: stable, 14 hex digits, different for a one-character change', () => {
    expect(cyrb53('')).toMatch(/^[0-9a-f]{14}$/)
    expect(cyrb53('export const core = 1\n')).toBe(cyrb53('export const core = 1\n'))
    expect(cyrb53('export const core = 1\n')).not.toBe(cyrb53('export const core = 2\n'))
    expect(cyrb53('abc')).toBe('11f9f91ac18c8d')
  })

  test('nativeHashTrees by bytes: CRLF and LF alike, one changed byte counts, 0xff against 0xfe counts (they decode alike), a file with a NUL byte as it is; a port that answers text: line ends folded', async () => {
    const raw = new Map<string, number[]>([
      ['/r/a/hooks/x.ts', [...'a\nb\n'].map(one => one.charCodeAt(0))],
      ['/r/b/hooks/x.ts', [...'a\r\nb\r\n'].map(one => one.charCodeAt(0))],
      ['/r/a/hooks/y.ts', [0x61, 0xff, 0x0a]],
      ['/r/b/hooks/y.ts', [0x61, 0xfe, 0x0a]],
      ['/r/a/hooks/z.bin', [0x00, 0x0d, 0x0a]],
      ['/r/b/hooks/z.bin', [0x00, 0x0a]],
      ['/r/a/hooks/w.ts', [...'one\r\n'].map(one => one.charCodeAt(0))],
      ['/r/b/hooks/w.ts', [...'onE\n'].map(one => one.charCodeAt(0))],
    ])
    const toBase64 = (bytes: readonly number[]) => btoa(String.fromCharCode(...bytes))
    const port = {
      stat: async (path: string) => {
        if (raw.has(path)) return { kind: 'file', size: 1, mtimeMs: 0, isLink: false }
        if ([...raw.keys()].some(one => one.startsWith(`${path}/`))) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        throw new Error('ENOENT')
      },
      list: async (path: string) => listInMap(new Map([...raw.keys()].map(key => [key, 'x'])), new Map(), path),
      // The text as the engine decodes it: a byte that is no UTF-8 becomes U+FFFD, so y.ts reads alike in both.
      read: async (path: string) => String.fromCharCode(...(raw.get(path) ?? []).map(one => (one > 0x7f ? 0xfffd : one))),
      readBytes: async (path: string) => ({ base64: toBase64(raw.get(path) ?? []) }),
    }
    const trees = await nativeHashTrees(port as never, ['/r/a', '/r/b'], DRIFT_SPEC)
    expect(changedFiles(trees?.[0] as never, trees?.[1] as never)).toEqual(['hooks/w.ts', 'hooks/y.ts', 'hooks/z.bin'])
    // Read as text only (an engine without bytes): 0xff and 0xfe are lost to the decoding, the line ends still fold.
    const textOnly = { ...port, readBytes: async (path: string) => port.read(path) }
    const asText = await nativeHashTrees(textOnly as never, ['/r/a', '/r/b'], DRIFT_SPEC)
    expect(changedFiles(asText?.[0] as never, asText?.[1] as never)).toEqual(['hooks/w.ts', 'hooks/z.bin'])
    expect(driftText('a\r\nb')).toBe('a\nb')
    expect(driftText('a\0\r\n')).toBe('a\0\r\n')
    expect([...driftBytes(new Uint8Array([0x61, 0x0d, 0x0a, 0x0d]))]).toEqual([0x61, 0x0a, 0x0d])
    for (const bytes of [[], [0x66], [0x66, 0x6f], [0x66, 0x6f, 0x6f], [0, 255, 254, 13, 10, 128]]) expect([...base64Bytes(toBase64(bytes))]).toEqual(bytes)
  })

  test('nativeHashTrees: a link among the folders on the way is not followed: plugin.json under a linked .claude-plugin is passed over', async () => {
    const files = new Map(Object.entries({ '/r/a/hooks/x.ts': 'x', '/r/a/.claude-plugin/plugin.json': '{}' }))
    const port = {
      stat: async (path: string) => {
        if (path === '/r/a/.claude-plugin') return { kind: 'dir', size: 0, mtimeMs: 0, isLink: true }
        if (files.has(path)) return { kind: 'file', size: 1, mtimeMs: 0, isLink: false }
        if ([...files.keys()].some(one => one.startsWith(`${path}/`))) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        throw new Error('ENOENT')
      },
      list: async (path: string) => listInMap(files, new Map(), path),
      read: async (path: string) => files.get(path) ?? '',
    }
    const trees = await nativeHashTrees(port as never, ['/r/a'], DRIFT_SPEC)
    expect(Object.keys(trees?.[0]?.files ?? {})).toEqual(['hooks/x.ts'])
  })

  test('nativeHashTrees: a root that is no folder answers nothing; a file over the read cap answers nothing', async () => {
    const files = new Map(Object.entries({ '/r/a/hooks/x.ts': 'x', '/r/b/hooks/x.ts': 'y', '/r/c/hooks/big.ts': 'z'.repeat(50) }))
    const port = {
      stat: async (path: string) => {
        if (files.has(path)) return { kind: 'file', size: 1, mtimeMs: 0, isLink: false }
        if ([...files.keys()].some(one => one.startsWith(`${path}/`))) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
        throw new Error('ENOENT')
      },
      list: async (path: string) => listInMap(files, new Map(), path),
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined || text.length > 40) throw new Error('EFBIG')
        return text
      },
    }
    const trees = await nativeHashTrees(port as never, ['/r/a', '/r/b'], DRIFT_SPEC)
    expect(trees?.map(one => one.method)).toEqual(['cyrb53', 'cyrb53'])
    expect(changedFiles(trees?.[0] as never, trees?.[1] as never)).toEqual(['hooks/x.ts'])
    expect(await nativeHashTrees(port as never, ['/r/a', '/r/none'], DRIFT_SPEC)).toBeUndefined()
    expect(await nativeHashTrees(port as never, ['/r/a', '/r/c'], DRIFT_SPEC)).toBeUndefined()
  })
})
