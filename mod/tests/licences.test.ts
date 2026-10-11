// The licence tools through the plugin on the mock engine: list_licences over a simulated machine (mock-world.ts on
// Linux, a small machine of its own for Windows), with directory listings and the presence of the two files of a
// licence; the licence files hold canaries that must reach no answer and no trace, since the tools never open them.
// The pure parts of hooks/licences.ts are tested on their own at the end.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isSameWinPath, parseProcFacts } from '../hooks/core'
import { TOAST_TITLES } from '../hooks/core'
import {
  MAX_LICENCES,
  SCAN_CACHE_MS,
  SCAN_MAX_DIRS,
  USAGE_CACHE_MS,
  USAGE_CALL_BUDGET_MS,
  USAGE_FAIL_CACHE_MS,
  USAGE_PROBE_WORST_MS,
  findLicence,
  hasProbeRoom,
  isUnderLicence,
  isUsageFresh,
  licenceCandidates,
  licenceDirsOf,
  licenceName,
  licenceOf,
  listLicencesText,
  normalConfigDir,
  probeUsageText,
} from '../hooks/licences'
import type { Licence } from '../hooks/licences'
import { NOTICE_PREFIX } from '../hooks/notices'
import { nodeAnswer, usageAnswerOf } from './fake-helper'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, ORCH, REGISTRY, RUNS, mockWorld, seedLiveWorker } from './mock-world'
import type { World } from './mock-world'
import { echoPrompt, noticeLines, storeOf, userPrompt } from './notice-kit'
import { USAGE_FIXTURES } from './usage-fixtures'

const tool = (name: string) => `mcp__session-control__${name}`
const CLAUDE = `${HOME}/.claude`
const SID_LIVE = '10000000-aaaa-4bbb-8ccc-000000000001'
const SID_DONE = '20000000-aaaa-4bbb-8ccc-000000000002'
const SID_ELSEWHERE = '30000000-aaaa-4bbb-8ccc-000000000003'

/** What a licence file holds on the simulated machine: a token-shaped canary and an account identity, built from parts. */
const CANARY_TOKEN = ['sk', 'ant', 'oat01', 'LICENCEcanary0123456789abcdef'].join('-')
const CANARY_MAIL = ['someone.canary', 'example.invalid'].join('@')
const CANARY_ORG = ['Canary', 'Org', 'Ltd'].join(' ')
const CANARY_PERSON = ['Canary', 'Person'].join(' ')
const credentialsText = () => JSON.stringify({ claudeAiOauth: { accessToken: CANARY_TOKEN, refreshToken: CANARY_TOKEN } })
const configText = () => JSON.stringify({ oauthAccount: { emailAddress: CANARY_MAIL, organizationName: CANARY_ORG, displayName: CANARY_PERSON } })
const expectNoIdentity = (text: string) => {
  for (const part of ['LICENCEcanary', 'someone.canary', CANARY_ORG, CANARY_PERSON, 'accessToken', 'oauthAccount']) expect(text.includes(part)).toBe(false)
  expect(text.includes('@')).toBe(false)
}

/** A licence directory with both files (or only those named). */
function licence(world: World, dir: string, files: readonly ('credentials' | 'config')[] = ['credentials', 'config']): void {
  if (files.includes('credentials')) world.files.set(`${dir}/.credentials.json`, credentialsText())
  if (files.includes('config')) world.files.set(`${dir}/.claude.json`, configText())
}

/** The orchestrator, a registry of three entries (one live under the default directory, one done under `second`, one under no licence). */
function seed(world: World): void {
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  const live = seedLiveWorker(world, SID_LIVE)
  const done = { title: 'done one', session_id: SID_DONE, config_dir: `${CLAUDE}/second`, cwd: '/w/work', model: 'haiku', effort: 'low', reported: true }
  const elsewhere = { title: 'elsewhere', session_id: SID_ELSEWHERE, config_dir: '/w/other-cfg', cwd: '/w/work', model: 'haiku', effort: 'low', reported: true }
  world.files.set(REGISTRY, `${JSON.stringify([live, done, elsewhere], null, 2)}\n`)
}

/** The machine's licence directories: the default, two children (one only half there), a link, two dash folders, an explicit one. */
function seedLicences(world: World): void {
  licence(world, CLAUDE)
  licence(world, `${CLAUDE}/second`)
  licence(world, `${CLAUDE}/half`, ['credentials'])
  licence(world, '/w/elsewhere/linked')
  world.links.set(`${CLAUDE}/linked`, '/w/elsewhere/linked')
  licence(world, `${HOME}/.claude-work`)
  world.files.set(`${HOME}/.claude-empty/notes.txt`, 'x')
  licence(world, '/w/lic/extra')
}

const answerOf = async ($: { tool: { call: (e: never) => Promise<unknown> } }, name: string, input: Record<string, unknown> = {}) => {
  const answer = (await $.tool.call({ tool: tool(name), ...input } as never)) as { result?: unknown; deny?: unknown; text?: unknown }
  return String(answer.result ?? answer.deny ?? answer.text ?? '')
}

const LICENCE_OPTIONS = { ...OPTIONS, licenceDirs: '/w/lic/extra, relative/dir, /w/lic/missing, ~/.claude/second' }

describe('list_licences', () => {
  test('the default directory, a child, a dash folder and an explicit one; half-filled, linked and empty folders left out; each counted once', { options: LICENCE_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    seedLicences(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = await answerOf($, 'list_licences')
    expect(text.split('\n')).toEqual([
      '4 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      `- default | config_dir ${CLAUDE} | source default | logged_in yes | sessions 1 live, 1 in all`,
      `- second | config_dir ${CLAUDE}/second | source child | logged_in yes | sessions 0 live, 1 in all`,
      `- .claude-work | config_dir ${HOME}/.claude-work | source dash | logged_in yes | sessions 0 live, 0 in all`,
      '- extra | config_dir /w/lic/extra | source explicit | logged_in yes | sessions 0 live, 0 in all',
      '1 registry entry is under no discovered licence.',
      '1 licenceDirs entry is not an absolute path and ignored.',
    ])
    expectNoIdentity(text)
  })

  test('the default directory is listed even with neither file; its .claude.json may be the home one', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect((await answerOf($, 'list_licences')).split('\n').slice(0, 2)).toEqual([
      '1 licence (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      `- default | config_dir ${CLAUDE} | source default | logged_in no | sessions 1 live, 1 in all`,
    ])
    world.files.set(`${CLAUDE}/.credentials.json`, credentialsText())
    world.files.set(`${HOME}/.claude.json`, configText())
    await world.clock.advance(SCAN_CACHE_MS + 1000)
    expect((await answerOf($, 'list_licences')).split('\n')[1]).toBe(`- default | config_dir ${CLAUDE} | source default | logged_in yes | sessions 1 live, 1 in all`)
  })

  test("the orchestrator's own CLAUDE_CONFIG_DIR is the default (as the registry records a launch without a picker); ~/.claude is then `home`", { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { env: { CLAUDE_CONFIG_DIR: `${CLAUDE}/second` } })
    seed(world)
    seedLicences(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const lines = (await answerOf($, 'list_licences')).split('\n')
    expect(lines.slice(1, 4)).toEqual([
      `- default | config_dir ${CLAUDE}/second | source default | logged_in yes | sessions 0 live, 1 in all`,
      `- .claude | config_dir ${CLAUDE} | source home | logged_in yes | sessions 1 live, 1 in all`,
      `- .claude-work | config_dir ${HOME}/.claude-work | source dash | logged_in yes | sessions 0 live, 0 in all`,
    ])
  })

  test('the scan is kept 60 s in memory: a call within answers from it and lists nothing; a call after rescans', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    seedLicences(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await answerOf($, 'list_licences')
    const listed = world.listed.length
    licence(world, `${CLAUDE}/third`)
    await world.clock.advance(30_000)
    const cached = await answerOf($, 'list_licences')
    expect(cached.split('\n')[0]).toBe('3 licences (directory scan cached, 30 s old; logged_in says only that .credentials.json and .claude.json are there: neither is opened).')
    expect(world.listed.length).toBe(listed)
    expect(cached.includes('third')).toBe(false)
    await world.clock.advance(SCAN_CACHE_MS)
    const fresh = await answerOf($, 'list_licences')
    expect(fresh.split('\n')[0]).toBe('4 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).')
    expect(fresh).toContain(`- third | config_dir ${CLAUDE}/third | source child`)
    expect(world.listed.length).toBeGreaterThan(listed)
  })

  test('the answer comes from presence alone: with every licence file unreadable it is the same, and it holds nothing of their content', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    seedLicences(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const before = await answerOf($, 'list_licences')
    for (const path of world.files.keys()) if (path.endsWith('/.credentials.json') || path.endsWith('/.claude.json')) world.unreadable.add(path)
    await world.clock.advance(SCAN_CACHE_MS + 1000)
    expect(await answerOf($, 'list_licences')).toBe(before)
    expectNoIdentity(before)
  })

  test('a licence holds both files as regular files: directories, a link to a directory and a broken link in their place are no licence; a link to a regular file counts', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    // The default directory with both names as directories: listed (a launch goes there), not logged in.
    world.files.set(`${CLAUDE}/.credentials.json/x`, credentialsText())
    world.files.set(`${CLAUDE}/.claude.json/x`, configText())
    world.files.set(`${HOME}/.claude.json/x`, configText())
    // Both names as directories.
    world.files.set(`${CLAUDE}/dirs/.credentials.json/x`, credentialsText())
    world.files.set(`${CLAUDE}/dirs/.claude.json/x`, configText())
    // One regular file, one directory.
    world.files.set(`${CLAUDE}/mixed/.credentials.json`, credentialsText())
    world.files.set(`${CLAUDE}/mixed/.claude.json/x`, configText())
    // Links to regular files elsewhere: a licence.
    world.files.set('/w/store/c.json', credentialsText())
    world.files.set('/w/store/a.json', configText())
    world.files.set(`${CLAUDE}/linkfile/notes.txt`, 'x')
    world.links.set(`${CLAUDE}/linkfile/.credentials.json`, '/w/store/c.json')
    world.links.set(`${CLAUDE}/linkfile/.claude.json`, '/w/store/a.json')
    // Links to directories.
    world.files.set('/w/store/d1/x', credentialsText())
    world.files.set('/w/store/d2/x', configText())
    world.files.set(`${CLAUDE}/linkdir/notes.txt`, 'x')
    world.links.set(`${CLAUDE}/linkdir/.credentials.json`, '/w/store/d1')
    world.links.set(`${CLAUDE}/linkdir/.claude.json`, '/w/store/d2')
    // Broken links.
    world.files.set(`${HOME}/.claude-broken/notes.txt`, 'x')
    world.links.set(`${HOME}/.claude-broken/.credentials.json`, '/w/store/missing-c.json')
    world.links.set(`${HOME}/.claude-broken/.claude.json`, '/w/store/missing-a.json')
    for (const path of [...world.files.keys()]) if (path.includes('.credentials.json') || path.includes('.claude.json') || path.startsWith('/w/store/')) world.unreadable.add(path)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = await answerOf($, 'list_licences')
    expect(text.split('\n').slice(0, 3)).toEqual([
      '2 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      `- default | config_dir ${CLAUDE} | source default | logged_in no | sessions 1 live, 1 in all`,
      `- linkfile | config_dir ${CLAUDE}/linkfile | source child | logged_in yes | sessions 0 live, 0 in all`,
    ])
    expectNoIdentity(text)
    // Asked by stat (kind), never by exists alone and never read.
    for (const name of ['dirs', 'mixed', 'linkdir', 'linkfile']) expect(world.statted).toContain(`${CLAUDE}/${name}/.credentials.json`)
    expect(world.statted).toContain(`${HOME}/.claude-broken/.credentials.json`)
  })

  test('a licenceDirs entry that is a symbolic link to a licence folder counts; a linked child or dash folder found by the scan does not', { options: { ...OPTIONS, licenceDirs: '/w/lic/linked' } }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    licence(world, CLAUDE)
    licence(world, '/w/elsewhere/real')
    world.links.set('/w/lic/linked', '/w/elsewhere/real')
    world.links.set(`${CLAUDE}/linkedchild`, '/w/elsewhere/real')
    world.links.set(`${HOME}/.claude-linked`, '/w/elsewhere/real')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const lines = (await answerOf($, 'list_licences')).split('\n')
    expect(lines.slice(0, 3)).toEqual([
      '2 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      `- default | config_dir ${CLAUDE} | source default | logged_in yes | sessions 1 live, 1 in all`,
      '- linked | config_dir /w/lic/linked | source explicit | logged_in yes | sessions 0 live, 0 in all',
    ])
  })

  test('registry config_dir paths are matched normalised (// and /./ collapsed, a trailing / stripped), never through a symbolic link', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    licence(world, CLAUDE)
    licence(world, `${CLAUDE}/second`)
    world.links.set('/w/alias-second', `${CLAUDE}/second`)
    const entry = (n: number, configDir: string) => ({ title: `e${n}`, session_id: `5000000${n}-aaaa-4bbb-8ccc-00000000000${n}`, config_dir: configDir, cwd: '/w/work', model: 'haiku', effort: 'low', reported: true })
    const entries = [
      entry(1, `${HOME}//.claude//second/`),
      entry(2, `${CLAUDE}/./second`),
      entry(3, `${CLAUDE}/second/.`),
      entry(4, `${CLAUDE}/second///`),
      entry(5, '/w/alias-second'),
      entry(6, `${CLAUDE}/x/../second`),
      entry(7, `${HOME}/./.claude/`),
    ]
    world.files.set(REGISTRY, `${JSON.stringify(entries, null, 2)}\n`)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect((await answerOf($, 'list_licences')).split('\n')).toEqual([
      '2 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      `- default | config_dir ${CLAUDE} | source default | logged_in yes | sessions 0 live, 1 in all`,
      `- second | config_dir ${CLAUDE}/second | source child | logged_in yes | sessions 0 live, 4 in all`,
      '2 registry entries are under no discovered licence.',
    ])
  })

  test('the registry unreadable: the licences with ? counts and the reason', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    licence(world, CLAUDE)
    world.files.set(REGISTRY, '{ not json')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const lines = (await answerOf($, 'list_licences')).split('\n')
    expect(lines[1]).toBe(`- default | config_dir ${CLAUDE} | source default | logged_in yes | sessions ? live, ? in all`)
    expect(lines[2]?.startsWith('The registry cannot be read (registry is not JSON')).toBe(true)
  })

  test('the debug trace: the call, the scan counts and the answer as a length; no path of a licence file, no canary', { options: { ...LICENCE_OPTIONS, debug: true } }, async ($, on) => {
    const world = mockWorld(on)
    seed(world)
    seedLicences(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await answerOf($, 'list_licences')
    const trace = world.files.get(`${RUNS}/trace.log`) ?? ''
    const lines = trace.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const mine = lines.filter(line => line.tool === 'list_licences' || line.event === 'licences.scan').map(({ ts: _t, seq: _s, ...rest }) => rest)
    expect(mine).toEqual([
      { event: 'tool.call', tool: 'list_licences' },
      { event: 'licences.scan', licences: 4, skipped: 0, ignored: 1 },
      { event: 'tool.result', tool: 'list_licences', resultChars: expect.any(Number) },
    ])
    expectNoIdentity(trace)
    expect(trace.includes('.credentials.json')).toBe(false)
  })
})

// ---------------------------------------------------------------- probe_licence_usage

const MAIN = { stdout: USAGE_FIXTURES.recordedMain ?? '' }
const SECOND = { stdout: USAGE_FIXTURES.recordedSecondary ?? '' }
const MAIN_ROW = 'five_hour 12% (resets Oct 11, 11:20am (Europe/Budapest)) | seven_day 41% (resets Oct 16, 1pm (Europe/Budapest))'
const SECOND_ROW = 'five_hour 42% (resets Oct 11, 11:30am (Europe/Budapest)) | seven_day 5% (resets Oct 18, 6am (Europe/Budapest))'
const STALE = "The figures are what the CLI's /usage shows: they can be stale (up to an hour when its own fetch fails), percents are floored and resets are as the CLI words them."

/** The orchestrator with the default licence and `second` (and `.claude-work`, not logged in to a subscription), and what their probes answer. */
function seedUsage(world: World): void {
  seed(world)
  licence(world, CLAUDE)
  licence(world, `${CLAUDE}/second`)
  licence(world, `${HOME}/.claude-work`)
  world.usage.set('inherited', MAIN)
  world.usage.set(`${CLAUDE}/second`, SECOND)
  world.usage.set(`${HOME}/.claude-work`, { stdout: USAGE_FIXTURES.recordedNoLogin ?? '' })
}

describe('probe_licence_usage', () => {
  test('every discovered licence, one after the other: the two windows or the code; the default a launch inherits probed without CLAUDE_CONFIG_DIR', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedUsage(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = await answerOf($, 'probe_licence_usage')
    expect(text.split('\n')).toEqual([
      'Usage of 3 licences (3 probed now, 0 from the cache): highest five_hour 42% (second), highest seven_day 41% (default).',
      `- default (config_dir ${CLAUDE}) | ${MAIN_ROW} | age_seconds 0 | cached no`,
      `- second (config_dir ${CLAUDE}/second) | ${SECOND_ROW} | age_seconds 0 | cached no`,
      `- .claude-work (config_dir ${HOME}/.claude-work) | error NOT_LOGGED_IN | age_seconds 0 | cached no`,
      STALE,
    ])
    // One helper probeUsage each; the default a launch inherits goes with isInherited (the helper leaves CLAUDE_CONFIG_DIR out).
    expect(world.usageRuns.map(run => [run.configDir, run.isInherited, run.via, run.argv[0], run.argv[2]])).toEqual([
      [CLAUDE, true, 'helper', 'node', 'probeUsage'],
      [`${CLAUDE}/second`, false, 'helper', 'node', 'probeUsage'],
      [`${HOME}/.claude-work`, false, 'helper', 'node', 'probeUsage'],
    ])
    expect(world.usageMaxInFlight).toBe(1)
    expectNoIdentity(text)
  })

  test('kept 60 s per licence (a failed probe 15 s): a call within answers from memory with its age and says cached', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedUsage(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await answerOf($, 'probe_licence_usage')
    await world.clock.advance(USAGE_FAIL_CACHE_MS + 1000)
    const again = (await answerOf($, 'probe_licence_usage')).split('\n')
    expect(again[0]).toBe('Usage of 3 licences (1 probed now, 2 from the cache): highest five_hour 42% (second), highest seven_day 41% (default).')
    expect(again.slice(1, 4)).toEqual([
      `- default (config_dir ${CLAUDE}) | ${MAIN_ROW} | age_seconds 16 | cached yes`,
      `- second (config_dir ${CLAUDE}/second) | ${SECOND_ROW} | age_seconds 16 | cached yes`,
      `- .claude-work (config_dir ${HOME}/.claude-work) | error NOT_LOGGED_IN | age_seconds 0 | cached no`,
    ])
    expect(world.usageRuns.length).toBe(4)
    await world.clock.advance(USAGE_CACHE_MS)
    expect((await answerOf($, 'probe_licence_usage')).split('\n')[0]).toBe('Usage of 3 licences (3 probed now, 0 from the cache): highest five_hour 42% (second), highest seven_day 41% (default).')
    expect(world.usageRuns.length).toBe(7)
  })

  test('config_dir: one discovered licence by its path or its name; anything else is refused with the fixed text and probes nothing', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedUsage(world)
    licence(world, '/w/lic/undiscovered')
    world.usage.set('/w/lic/undiscovered', MAIN)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect((await answerOf($, 'probe_licence_usage', { config_dir: `${CLAUDE}/second/` })).split('\n').slice(0, 2)).toEqual([
      'Usage of 1 licence (1 probed now, 0 from the cache): highest five_hour 42% (second), highest seven_day 5% (second).',
      `- second (config_dir ${CLAUDE}/second) | ${SECOND_ROW} | age_seconds 0 | cached no`,
    ])
    expect((await answerOf($, 'probe_licence_usage', { config_dir: 'default' })).split('\n')[1]).toBe(`- default (config_dir ${CLAUDE}) | ${MAIN_ROW} | age_seconds 0 | cached no`)
    const runs = world.usageRuns.length
    for (const asked of ['/w/lic/undiscovered', `${CLAUDE}/half`, 'nobody', `${CLAUDE}/../.claude/second`]) {
      expect(await answerOf($, 'probe_licence_usage', { config_dir: asked })).toBe('session-control: not a discovered licence')
    }
    expect(world.usageRuns.length).toBe(runs)
  })

  test('the call is held to 40 s: a probe starts only while one more fits; the licences left are named for the next call', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedUsage(world)
    licence(world, `${CLAUDE}/fourth`)
    world.usage.set(`${CLAUDE}/fourth`, SECOND)
    world.usageKnobs.stepMs = 15_000
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const lines = (await answerOf($, 'probe_licence_usage')).split('\n')
    expect(lines[0]).toBe('Usage of 2 licences (2 probed now, 0 from the cache): highest five_hour 42% (second), highest seven_day 41% (default).')
    expect(lines).toContain('2 more not probed: call again (fourth, .claude-work).')
    expect(world.usageRuns.length).toBe(2)
    // The next call answers the two from memory and probes the two left.
    const next = (await answerOf($, 'probe_licence_usage')).split('\n')
    expect(next[0]).toBe('Usage of 4 licences (2 probed now, 2 from the cache): highest five_hour 42% (second), highest seven_day 41% (default).')
    expect(world.usageRuns.length).toBe(4)
  })

  test('at most one probe at a time: a call made while another probes answers from memory at once and starts none', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedUsage(world)
    let release = () => undefined as void
    world.usageKnobs.hold = new Promise<void>(resolve => {
      release = resolve
    })
    let started = () => undefined as void
    const isStarted = new Promise<void>(resolve => {
      started = resolve
    })
    world.usageKnobs.onRun = () => started()
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const first = answerOf($, 'probe_licence_usage')
    await isStarted
    const second = (await answerOf($, 'probe_licence_usage')).split('\n')
    expect(second[0]).toBe('Usage of 0 licences (0 probed now, 0 from the cache): highest five_hour -, highest seven_day -.')
    expect(second).toContain('3 more not probed: call again (default, second, .claude-work).')
    expect(second.at(-1)).toBe('Another call was probing: this one probed nothing and answered from memory.')
    expect(world.usageRuns.length).toBe(1)
    release()
    expect((await first).split('\n')[0]).toBe('Usage of 3 licences (3 probed now, 0 from the cache): highest five_hour 42% (second), highest seven_day 41% (default).')
    expect(world.usageMaxInFlight).toBe(1)
  })

  test("the probe's own claude process is never an orphan: no orphan row in list_sessions, no orphan notice or toast", { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seedUsage(world)
    world.usageKnobs.linger = true
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await answerOf($, 'probe_licence_usage')
    expect([...world.table.procs.values()].filter(proc => proc.claude?.cmdline === 'claude -p /usage --no-session-persistence').length).toBe(3)
    for (let gone = 0; gone < 180; gone += 5) await world.clock.advance(5000)
    const sessions = await answerOf($, 'list_sessions')
    expect(sessions.includes('orphan')).toBe(false)
    expect(world.toasts.filter(text => text.startsWith(TOAST_TITLES.orphan)).length).toBe(0)
    const sent = await userPrompt($)
    expect(noticeLines(sent).filter(line => line.includes('orphan'))).toEqual([])
    expect(noticeLines(sent).every(line => line.startsWith(NOTICE_PREFIX))).toBe(true)
  })

  test('with the Node helper: the same answer through its probeUsage, one helper process per licence', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { isHelper: true })
    seedUsage(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = await answerOf($, 'probe_licence_usage')
    expect(text.split('\n')[1]).toBe(`- default (config_dir ${CLAUDE}) | ${MAIN_ROW} | age_seconds 0 | cached no`)
    expect(world.usageRuns.map(run => [run.via, run.isInherited])).toEqual([
      ['helper', true],
      ['helper', false],
      ['helper', false],
    ])
  })

  test('through the helper: no claude is NO_CLAUDE, none in time is TIMEOUT (a native timeout is a rejection the test kit cannot make: usage.test.ts covers it)', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { isHelper: true })
    seedUsage(world)
    world.usage.delete('inherited')
    world.usage.set(`${CLAUDE}/second`, 'timeout')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const lines = (await answerOf($, 'probe_licence_usage')).split('\n')
    expect(lines.slice(1, 3)).toEqual([`- default (config_dir ${CLAUDE}) | error NO_CLAUDE | age_seconds 0 | cached no`, `- second (config_dir ${CLAUDE}/second) | error TIMEOUT | age_seconds 0 | cached no`])
    expect(lines[0]).toBe('Usage of 3 licences (3 probed now, 0 from the cache): highest five_hour -, highest seven_day -.')
    // The probe's own codes are answers: no fallback to the native probe.
    expect(world.usageRuns.every(run => run.via === 'helper')).toBe(true)
  })

  test('the debug trace: the call, each probe by directory and route, the answer as a length; never a figure or the text', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const world = mockWorld(on)
    seedUsage(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await answerOf($, 'probe_licence_usage', { config_dir: 'second' })
    const trace = world.files.get(`${RUNS}/trace.log`) ?? ''
    const lines = trace.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const mine = lines.filter(line => line.tool === 'probe_licence_usage' || line.event === 'licences.usage' || line.helper === 'probeUsage').map(({ ts: _t, seq: _s, ms: _m, ...rest }) => rest)
    expect(mine).toEqual([
      { event: 'tool.call', tool: 'probe_licence_usage', config_dir: 'second' },
      { event: 'process.run', helper: 'probeUsage', configDir: `${CLAUDE}/second`, isInherited: false, exitCode: 0 },
      { event: 'licences.usage', configDir: `${CLAUDE}/second`, isCached: false },
      { event: 'tool.result', tool: 'probe_licence_usage', resultChars: expect.any(Number) },
    ])
    for (const word of ['Europe', 'used', 'resets', 'subscription']) expect(trace.includes(word)).toBe(false)
    expectNoIdentity(trace)
  })
})

// ---------------------------------------------------------------- launch_worker's config_dir

const PICKER = '/w/bin/pick --need {need}'
const PICK_OPTIONS = { ...OPTIONS, licencePickCommand: PICKER }
const LAUNCH = { dir: '/w/work', model: 'haiku', effort: 'low', title: 'licence launch', prompt: 'Reply PONG.' }
const SID_RESUME = '40000000-aaaa-4bbb-8ccc-000000000004'

/** The orchestrator and its licences, a picker that would choose .claude-work, and the launch's Bash command. */
function seedLaunch(world: World): void {
  seedUsage(world)
  world.launch.isFound = true
  world.commands.set('/w/bin/pick', () => ({ stdout: `${HOME}/.claude-work\n`, exitCode: 0 }))
}
const pickerRuns = (world: World) => world.runs.filter(argv => argv[0] === '/w/bin/pick')
const launchCommands = (world: World) => world.passed.filter(one => one.tool === 'Bash' && String(one.input.command).includes(' claude -p ')).map(one => String(one.input.command))
const registry = (world: World) => JSON.parse(world.files.get(REGISTRY) ?? '[]') as Record<string, unknown>[]

describe("launch_worker's config_dir", () => {
  test('an explicit config_dir wins over the picker: the picker is not run, the worker runs under it, the registry records it', { options: PICK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedLaunch(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = await answerOf($, 'launch_worker', { ...LAUNCH, config_dir: 'second' })
    expect(text).toContain(`config_dir ${CLAUDE}/second, registered.`)
    expect(text).toContain(' Licence: second (config_dir given; the licence picker was not run).')
    expect(text.includes('WARNING')).toBe(false)
    expect(pickerRuns(world)).toEqual([])
    expect(launchCommands(world).length).toBe(1)
    expect(launchCommands(world)[0]).toContain(`CLAUDE_CONFIG_DIR='${CLAUDE}/second' `)
    expect(registry(world).at(-1)?.config_dir).toBe(`${CLAUDE}/second`)
    // No probe runs inside a launch.
    expect(world.usageRuns).toEqual([])
  })

  test('without config_dir the launch is as before: the picker chooses, its directory is on the line and in the registry, no licence note', { options: PICK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedLaunch(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = await answerOf($, 'launch_worker', LAUNCH)
    expect(pickerRuns(world)).toEqual([['/w/bin/pick', '--need', '40']])
    expect(launchCommands(world)[0]).toContain(`CLAUDE_CONFIG_DIR='${HOME}/.claude-work' `)
    expect(registry(world).at(-1)?.config_dir).toBe(`${HOME}/.claude-work`)
    expect(text.includes('Licence:')).toBe(false)
    expect(world.usageRuns).toEqual([])
  })

  test('a config_dir that is not a discovered licence is refused with the discovered names only; nothing runs and nothing is written', { options: PICK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedLaunch(world)
    licence(world, '/w/lic/undiscovered')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const before = world.files.get(REGISTRY)
    const written = world.written.length
    for (const asked of ['/w/lic/undiscovered', `${CLAUDE}/half`, 'nobody']) {
      expect(await answerOf($, 'launch_worker', { ...LAUNCH, config_dir: asked })).toBe(
        'session-control: refused: config_dir is not a discovered licence (discovered: default, second, .claude-work; list_licences shows them); nothing was launched',
      )
    }
    expect(pickerRuns(world)).toEqual([])
    expect(launchCommands(world)).toEqual([])
    expect(world.files.get(REGISTRY)).toBe(before)
    expect(world.written.slice(written).filter(one => one.path.startsWith(RUNS) && !one.path.endsWith('/trace.log'))).toEqual([])
  })

  test('the default directory given explicitly: no CLAUDE_CONFIG_DIR on the line, as a launch without a picker runs there; the registry records it', { options: PICK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedLaunch(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = await answerOf($, 'launch_worker', { ...LAUNCH, config_dir: `${CLAUDE}/` })
    expect(text).toContain(`config_dir ${CLAUDE}, registered.`)
    expect(launchCommands(world)[0]?.includes('CLAUDE_CONFIG_DIR')).toBe(false)
    expect(registry(world).at(-1)?.config_dir).toBe(CLAUDE)
    expect(pickerRuns(world)).toEqual([])
  })

  test('a warning when a probe of the last 60 s showed the licence over 90%; none from an older probe; the launch never probes', { options: PICK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedLaunch(world)
    world.usage.set(`${CLAUDE}/second`, { stdout: 'Current session: 95% used \u00b7 resets 6pm (Europe/Rome)\nCurrent week (all models): 91% used \u00b7 resets Oct 14, 9am (Europe/Rome)\n' })
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await answerOf($, 'probe_licence_usage', { config_dir: 'second' })
    await world.clock.advance(20_000)
    const warned = await answerOf($, 'launch_worker', { ...LAUNCH, config_dir: 'second' })
    expect(warned).toContain(`config_dir ${CLAUDE}/second, registered.`)
    expect(warned.split('\n').filter(line => line.startsWith('WARNING:'))).toEqual(['WARNING: licence second was over 90% in a probe 20 s ago (five_hour 95%, seven_day 91%); launched as asked, it may stop at its limit'])
    expect(world.usageRuns.length).toBe(1)
    world.table.procs.delete(7001)
    await world.clock.advance(41_000)
    const later = await answerOf($, 'launch_worker', { ...LAUNCH, title: 'licence launch two', config_dir: 'second' })
    expect(later.includes('WARNING')).toBe(false)
    expect(world.usageRuns.length).toBe(1)
  })

  test('a resume runs under its entry\'s own config_dir: without config_dir as before, with another one refused, with its own accepted', { options: PICK_OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedLaunch(world)
    const entry = { title: 'to resume', session_id: SID_RESUME, config_dir: `${CLAUDE}/second`, cwd: '/w/work', model: 'haiku', effort: 'low', reported: true }
    world.files.set(REGISTRY, `${JSON.stringify([entry], null, 2)}\n`)
    world.files.set(`${CLAUDE}/second/projects/-w-work/${SID_RESUME}.jsonl`, '{}\n')
    world.launch.sid = SID_RESUME
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const resume = { resume_sid: SID_RESUME, prompt: 'Continue the work.' }
    expect(await answerOf($, 'launch_worker', { ...resume, config_dir: 'default' })).toBe(
      `session-control: refused: a resume runs under its entry's own config_dir (${CLAUDE}/second), not ${CLAUDE}; nothing was launched`,
    )
    expect(launchCommands(world)).toEqual([])
    const text = await answerOf($, 'launch_worker', resume)
    expect(text).toContain(`config_dir ${CLAUDE}/second, registered.`)
    expect(launchCommands(world)[0]).toContain(`CLAUDE_CONFIG_DIR='${CLAUDE}/second' `)
    expect(launchCommands(world)[0]).toContain(`--resume '${SID_RESUME}'`)
    expect(registry(world).find(one => one.session_id === SID_RESUME)?.config_dir).toBe(`${CLAUDE}/second`)
    expect(pickerRuns(world)).toEqual([])
    world.table.procs.delete(7001)
    const again = await answerOf($, 'launch_worker', { ...resume, config_dir: `${CLAUDE}/second` })
    expect(again).toContain(`config_dir ${CLAUDE}/second, registered.`)
    expect(again.includes('Licence:')).toBe(false)
  })

  test('the debug trace names the config_dir given and the refusal, never anything of a licence file', { options: { ...PICK_OPTIONS, debug: true } }, async ($, on) => {
    const world = mockWorld(on)
    seedLaunch(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await answerOf($, 'launch_worker', { ...LAUNCH, config_dir: 'nobody' })
    await answerOf($, 'launch_worker', { ...LAUNCH, config_dir: 'second' })
    const trace = world.files.get(`${RUNS}/trace.log`) ?? ''
    const lines = trace.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.filter(line => line.event === 'tool.call' && line.tool === 'launch_worker').map(line => line.config_dir)).toEqual(['nobody', 'second'])
    expect(lines.some(line => line.event === 'guard' && line.check === 'config_dir' && line.isOk === false)).toBe(true)
    expectNoIdentity(trace)
  })
})

// ---------------------------------------------------------------- Windows

const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\w\\home' }
const WIN_ORCH = 'C:/w/orch'
const WIN_REGISTRY = 'C:/w/home/.claude/headless-sessions.json'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const given = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')

/**
 * A small Windows machine: files by their C:/ path (case kept as given), folders listed by what is under them, Node and
 * its helper (whose probeUsage answers the recorded text's answer, and records each request), a process probe that
 * prints `probeOut` (empty unless a test sets it); `env` is added to the Windows environment.
 */
function winWorld(on: On, env: Record<string, string> = {}) {
  const w = { files: new Map<string, string>(), links: new Map<string, string>(), runs: [] as string[][], usageRequests: [] as Record<string, unknown>[], clock: mock.clock(on, { now: NOW_MS }), probeOut: '' }
  mock.env(on, { ...WIN_ENV, ...env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-control__${e.name}` } }))
  const key = (path: string) => given(path).toLowerCase()
  const find = (path: string) => [...w.files.entries()].find(([one]) => one.toLowerCase() === key(path))
  on('fs.read', ($, e) => {
    const found = find(e.path)
    if (found === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: found[1] }
  })
  on('fs.write', ($, e) => {
    w.files.set(given(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: find(e.path) !== undefined }))
  // A file is `file`, a folder (something under it) `dir`; a link (in links, by its C:/ path) is followed, and one that
  // leads nowhere is `other`, as the engine says it.
  const isFolder = (path: string) => [...w.files.keys()].some(one => one.toLowerCase().startsWith(`${key(path).replace(/\/+$/, '')}/`))
  const linkOf = (path: string) => [...w.links.entries()].find(([one]) => one.toLowerCase() === key(path))?.[1]
  on('fs.stat', ($, e) => {
    const target = linkOf(e.path)
    const path = target ?? e.path
    const isLink = target !== undefined
    if (find(path) !== undefined) return { value: { kind: 'file', size: 1, mtimeMs: NOW_MS, isLink } as never }
    if (isFolder(path)) return { value: { kind: 'dir', size: 0, mtimeMs: NOW_MS, isLink } as never }
    if (isLink) return { value: { kind: 'other', size: 0, mtimeMs: NOW_MS, isLink } as never }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', ($, e) => {
    const dir = key(e.path).replace(/\/+$/, '')
    const names = new Map<string, string>()
    for (const one of w.files.keys()) if (one.toLowerCase().startsWith(`${dir}/`)) names.set(one.slice(dir.length + 1).split('/')[0] ?? '', `${one.slice(0, dir.length)}/${one.slice(dir.length + 1).split('/')[0] ?? ''}`)
    return { value: [...names].map(([name, full]) => ({ name, kind: w.files.has(full) ? 'file' : 'dir', size: 1, mtimeMs: NOW_MS, isLink: false })) as never }
  })
  on('process.run', ($, e) => {
    w.runs.push(e.argv.map(String))
    const ok = { exitCode: 0, stderr: '', stdout: '', isStdoutTruncated: false, isStderrTruncated: false }
    // PROBE_PS1 prints what the test set (`probeOut`); TREE_PS1 nothing.
    if (e.argv[0] === POWERSHELL) return { value: { ...ok, stdout: String(e.argv[6] ?? '').endsWith('/probe.ps1') ? w.probeOut : '' } }
    if (e.argv[0] === 'git') return { value: { ...ok, exitCode: 128 } }
    // The helper's usage probe: each licence answers what the recorded main text gives.
    if (e.argv[0] === 'node' && e.argv[2] === 'probeUsage') {
      w.usageRequests.push(JSON.parse(String(e.init?.stdin ?? '{}')) as Record<string, unknown>)
      return { value: { ...ok, stdout: JSON.stringify(usageAnswerOf(USAGE_FIXTURES.recordedMain ?? '')) } }
    }
    const node = nodeAnswer(e.argv, e.init?.stdin, w.files, given)
    if (node !== undefined) return { value: node }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }) as never)
  return w
}

const WIN_OPTIONS = { orchestratorDir: WIN_ORCH, registryPath: '~/.claude/headless-sessions.json', licenceDirs: 'D:\\Lic\\Extra, d:/lic/extra/, C:\\w\\home\\.claude\\Second' }

describe('list_licences on Windows', () => {
  test('%USERPROFILE%\\.claude forms: the default, a child, a dash folder and an explicit one on another drive, each once with paths compared without case', { options: WIN_OPTIONS }, async ($, on) => {
    const w = winWorld(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, `${JSON.stringify([{ title: 'w', session_id: SID_DONE, config_dir: 'c:\\w\\home\\.claude\\second', cwd: 'C:/w/work', reported: true }])}\n`)
    for (const dir of ['C:/w/home/.claude', 'C:/w/home/.claude/Second', 'C:/w/home/.claude-Work', 'D:/Lic/Extra']) {
      w.files.set(`${dir}/.credentials.json`, credentialsText())
      w.files.set(`${dir}/.claude.json`, configText())
    }
    w.files.set('C:/w/home/.claude/projects/x.jsonl', '')
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    const text = await answerOf($, 'list_licences')
    expect(text.split('\n')).toEqual([
      '4 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      '- default | config_dir C:/w/home/.claude | source default | logged_in yes | sessions 0 live, 0 in all',
      '- Second | config_dir C:/w/home/.claude/Second | source child | logged_in yes | sessions 0 live, 1 in all',
      '- .claude-Work | config_dir C:/w/home/.claude-Work | source dash | logged_in yes | sessions 0 live, 0 in all',
      '- Extra | config_dir D:/Lic/Extra | source explicit | logged_in yes | sessions 0 live, 0 in all',
    ])
    expectNoIdentity(text)
    // No process but the PowerShell probe, Node's lookup and the helper's writes: the discovery is listings and presence only.
    expect(w.runs.every(argv => argv[0] === POWERSHELL || argv[0] === 'git' || (argv[0] === 'node' && (argv[1] === '--version' || ['writeAtomic', 'append', 'batch'].includes(String(argv[2])))))).toBe(true)
  })

  test('a licence holds both files as regular files: directories, a link to a folder and a broken link are no licence; a link to a regular file counts', { options: { ...WIN_OPTIONS, licenceDirs: '' } }, async ($, on) => {
    const w = winWorld(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, '[]\n')
    w.files.set('C:/w/home/.claude/.credentials.json', credentialsText())
    w.files.set('C:/w/home/.claude/.claude.json', configText())
    w.files.set('C:/w/home/.claude/Dirs/.credentials.json/x', credentialsText())
    w.files.set('C:/w/home/.claude/Dirs/.claude.json/x', configText())
    w.files.set('C:/w/store/c.json', credentialsText())
    w.files.set('C:/w/store/a.json', configText())
    w.files.set('C:/w/store/d1/x', credentialsText())
    w.files.set('C:/w/home/.claude/LinkFile/notes.txt', 'x')
    w.links.set('C:/w/home/.claude/LinkFile/.credentials.json', 'C:/w/store/c.json')
    w.links.set('C:/w/home/.claude/LinkFile/.claude.json', 'C:/w/store/a.json')
    w.files.set('C:/w/home/.claude/LinkDir/notes.txt', 'x')
    w.links.set('C:/w/home/.claude/LinkDir/.credentials.json', 'C:/w/store/d1')
    w.links.set('C:/w/home/.claude/LinkDir/.claude.json', 'C:/w/store/d1')
    w.files.set('C:/w/home/.claude-Broken/notes.txt', 'x')
    w.links.set('C:/w/home/.claude-Broken/.credentials.json', 'C:/w/store/gone.json')
    w.links.set('C:/w/home/.claude-Broken/.claude.json', 'C:/w/store/gone.json')
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    const text = await answerOf($, 'list_licences')
    expect(text.split('\n')).toEqual([
      '2 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      '- default | config_dir C:/w/home/.claude | source default | logged_in yes | sessions 0 live, 0 in all',
      '- LinkFile | config_dir C:/w/home/.claude/LinkFile | source child | logged_in yes | sessions 0 live, 0 in all',
    ])
    expectNoIdentity(text)
  })

  test('registry config_dir paths are matched normalised in both separators and without case; a trailing separator and .\\ dropped', { options: { ...WIN_OPTIONS, licenceDirs: '' } }, async ($, on) => {
    const w = winWorld(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    const entries = ['c:\\w\\home\\.claude\\.\\second\\\\', 'C:/w/home/.claude//Second/./', 'C:\\w\\home\\.claude\\other'].map((configDir, n) => ({ title: `w${n}`, session_id: `6000000${n}-aaaa-4bbb-8ccc-00000000000${n}`, config_dir: configDir, cwd: 'C:/w/work', reported: true }))
    w.files.set(WIN_REGISTRY, `${JSON.stringify(entries)}\n`)
    for (const dir of ['C:/w/home/.claude', 'C:/w/home/.claude/Second']) {
      w.files.set(`${dir}/.credentials.json`, credentialsText())
      w.files.set(`${dir}/.claude.json`, configText())
    }
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    expect((await answerOf($, 'list_licences')).split('\n')).toEqual([
      '2 licences (directory scan fresh; logged_in says only that .credentials.json and .claude.json are there: neither is opened).',
      '- default | config_dir C:/w/home/.claude | source default | logged_in yes | sessions 0 live, 0 in all',
      '- Second | config_dir C:/w/home/.claude/Second | source child | logged_in yes | sessions 0 live, 2 in all',
      '1 registry entry is under no discovered licence.',
    ])
  })

  test('probe_licence_usage on Windows: one helper probeUsage per licence, the config_dir in the native C:/ form, the default a launch inherits with isInherited', { options: { ...WIN_OPTIONS, licenceDirs: '' } }, async ($, on) => {
    const w = winWorld(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, '[]\n')
    for (const dir of ['C:/w/home/.claude', 'C:/w/home/.claude/Second']) {
      w.files.set(`${dir}/.credentials.json`, credentialsText())
      w.files.set(`${dir}/.claude.json`, configText())
    }
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    const text = await answerOf($, 'probe_licence_usage')
    expect(text.split('\n').slice(1, 3)).toEqual([`- default (config_dir C:/w/home/.claude) | ${MAIN_ROW} | age_seconds 0 | cached no`, `- Second (config_dir C:/w/home/.claude/Second) | ${MAIN_ROW} | age_seconds 0 | cached no`])
    expect(w.usageRequests).toEqual([{ configDir: 'C:/w/home/.claude', isInherited: true }, { configDir: 'C:/w/home/.claude/Second' }])
    expect(w.runs.some(argv => argv[0] === 'claude.exe')).toBe(false)
  })
})

describe('the process probe on Windows', () => {
  const seedLicences = (w: ReturnType<typeof winWorld>) => {
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, '[]\n')
    for (const dir of ['C:/w/home/.claude', 'C:/w/home/.claude/Second', 'C:/w/home/.claude-Work', 'D:/Lic/Extra']) {
      w.files.set(`${dir}/.credentials.json`, credentialsText())
      w.files.set(`${dir}/.claude.json`, configText())
    }
  }
  const HEADLESS = '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model haiku'

  test("it also looks for sessions files under the orchestrator's own config dir and each discovered licence, so an orphan under one of them shows its cwd and config dir", { options: WIN_OPTIONS }, async ($, on) => {
    const w = winWorld(on, { CLAUDE_CONFIG_DIR: 'C:\\w\\own' })
    seedLicences(w)
    // What PROBE_PS1 prints for a headless claude whose sessions file it found under the licence Second.
    w.probeOut = `P\t4242\tclaude\t9\tC:/w/work\tC:/w/home/.claude/Second\t${HEADLESS}\r\n`
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    const text = await answerOf($, 'list_sessions')
    expect(text).toContain('- orphan (no registry entry) | pid 4242 | age 9s | cwd C:/w/work | config_dir C:/w/home/.claude/Second')
    const probes = w.runs.filter(argv => argv[0] === POWERSHELL && String(argv[6] ?? '').endsWith('/probe.ps1'))
    expect(probes.length).toBeGreaterThan(0)
    for (const argv of probes) {
      expect(argv.slice(7).filter(arg => arg.startsWith('c:'))).toEqual(['c:C:/w/own', 'c:C:/w/home/.claude', 'c:C:/w/home/.claude/Second', 'c:C:/w/home/.claude-Work', 'c:D:/Lic/Extra'])
    }
    // The licence tools' own scan keeps its age: the probe's folders are read apart from it.
    expect((await answerOf($, 'list_licences')).split('\n')[0]).toContain('(directory scan fresh;')
  })

  test('a claude process whose command line cannot be read is no orphan row; the debug trace counts such processes each time the count changes', { options: { ...WIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = winWorld(on)
    seedLicences(w)
    const unreadable = 'P\t4343\tclaude\t9\t\t\t\r\n'
    const headless = `P\t4242\tclaude\t9\tC:/w/work\t\t${HEADLESS}\r\n`
    w.probeOut = unreadable + headless
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    const first = await answerOf($, 'list_sessions')
    expect(first).toContain('| pid 4242 |')
    expect(first).not.toContain('pid 4343')
    await answerOf($, 'list_sessions')
    w.probeOut = headless
    await answerOf($, 'list_sessions')
    const trace = w.files.get('C:/w/home/.claude/session-control/runs/trace.log') ?? ''
    const counted = trace
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(line => line.event === 'probe')
      .map(line => line.unreadableCommandLines)
    expect(counted).toEqual([1, 0])
  })
})

// ---------------------------------------------------------------- the pure parts

describe('licences.ts', () => {
  const same = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

  test('licenceDirsOf: comma separated, trimmed, ~ expanded, only absolute paths kept, trailing separators dropped', () => {
    expect(licenceDirsOf(' /a/b/ ,, ~/x, rel, ~ ,C:/y', '/h', path => path.startsWith('/'))).toEqual({ dirs: ['/a/b', '/h/x', '/h'], ignored: 2 })
    expect(licenceDirsOf('', '/h', () => true)).toEqual({ dirs: [], ignored: 0 })
  })

  test('licenceCandidates: sources in their order, each directory once, links and files never candidates, listings capped', () => {
    const got = licenceCandidates({
      home: '/h',
      defaultDir: '/h/.claude',
      children: [{ name: 'a', kind: 'dir' }, { name: 'l', kind: 'other' }, { name: 'f.json', kind: 'file' }],
      homeEntries: [{ name: '.claude-b', kind: 'dir' }, { name: '.claude-', kind: 'dir' }, { name: '.claude', kind: 'dir' }, { name: '.claude-c', kind: 'other' }],
      explicit: ['/h/.claude/a/', '/x'],
      isSame: same,
    })
    expect(got).toEqual({
      candidates: [
        { configDir: '/h/.claude', source: 'default', isHomeDefault: true },
        { configDir: '/h/.claude/a', source: 'child', isHomeDefault: false },
        { configDir: '/h/.claude-b', source: 'dash', isHomeDefault: false },
        { configDir: '/x', source: 'explicit', isHomeDefault: false },
      ],
      skipped: 0,
    })
    const many = Array.from({ length: SCAN_MAX_DIRS + 5 }, (_, at) => ({ name: `d${at}`, kind: 'dir' }))
    expect(licenceCandidates({ home: '/h', defaultDir: '/h/.claude', children: many, homeEntries: [], explicit: [], isSame: same }).skipped).toBe(5)
  })

  test('licenceOf: both files, or the default directory alone; the home .claude.json counts for <home>/.claude only', () => {
    const child = { configDir: '/h/.claude/a', source: 'child' as const, isHomeDefault: false }
    expect(licenceOf(child, { credentials: true, config: true, homeConfig: false })).toEqual({ configDir: '/h/.claude/a', name: 'a', source: 'child', loggedIn: true })
    expect(licenceOf(child, { credentials: true, config: false, homeConfig: true })).toBeUndefined()
    expect(licenceOf(child, { credentials: false, config: true, homeConfig: true })).toBeUndefined()
    const home = { configDir: '/h/.claude', source: 'default' as const, isHomeDefault: true }
    expect(licenceOf(home, { credentials: true, config: false, homeConfig: true })?.loggedIn).toBe(true)
    expect(licenceOf(home, { credentials: false, config: false, homeConfig: false })).toEqual({ configDir: '/h/.claude', name: 'default', source: 'default', loggedIn: false })
  })

  test('licenceName and findLicence: by path (as the platform compares) or by name', () => {
    expect(licenceName({ configDir: 'C:\\Users\\u\\.claude\\Work\\', source: 'child' })).toBe('Work')
    const licences: Licence[] = [
      { configDir: 'C:/Users/u/.claude', name: 'default', source: 'default', loggedIn: true },
      { configDir: 'C:/Users/u/.claude/Work', name: 'Work', source: 'child', loggedIn: true },
    ]
    expect(findLicence(licences, 'c:\\users\\U\\.claude\\work', isSameWinPath)?.name).toBe('Work')
    expect(findLicence(licences, 'Work', isSameWinPath)?.name).toBe('Work')
    expect(findLicence(licences, 'default', isSameWinPath)?.configDir).toBe('C:/Users/u/.claude')
    expect(findLicence(licences, 'C:/Users/u/.claude/other', isSameWinPath)).toBeUndefined()
    expect(findLicence(licences, '  ', isSameWinPath)).toBeUndefined()
  })

  test('normalConfigDir and isUnderLicence: spelling only (separators, . components, a trailing separator), .. kept, no link resolved', () => {
    expect(normalConfigDir('/h//.claude/./a/')).toBe('/h/.claude/a')
    expect(normalConfigDir('//h/.claude/a/.')).toBe('/h/.claude/a')
    expect(normalConfigDir('/h/.claude/x/../a')).toBe('/h/.claude/x/../a')
    expect(normalConfigDir('/')).toBe('/')
    expect(normalConfigDir('///')).toBe('/')
    expect(normalConfigDir('/h/a\\b')).toBe('/h/a\\b')
    expect(normalConfigDir('C:\\Users\\u\\.claude\\.\\Work\\\\', true)).toBe('C:/Users/u/.claude/Work')
    expect(normalConfigDir('\\\\srv\\share\\.claude\\', true)).toBe('//srv/share/.claude')
    expect(normalConfigDir('C:\\', true)).toBe('C:')
    expect(isUnderLicence('/h/.claude//a/', '/h/.claude/a', same)).toBe(true)
    expect(isUnderLicence('/h/link-to-a', '/h/.claude/a', same)).toBe(false)
    expect(isUnderLicence('', '/h/.claude/a', same)).toBe(false)
    expect(isUnderLicence('c:\\users\\U\\.claude\\.\\work\\', 'C:/Users/u/.claude/Work', isSameWinPath, true)).toBe(true)
  })

  test('listLicencesText: bounded to MAX_LICENCES lines, the rest counted; names and paths cleaned', () => {
    const licences = Array.from({ length: MAX_LICENCES + 3 }, (_, at) => ({ configDir: `/h/.claude/l${at}`, name: `l${at}`, source: 'child' as const, loggedIn: true }))
    const text = listLicencesText({ scan: { licences, skipped: 2, ignored: 0, scannedAt: 0 }, nowMs: 5000, isCached: true, registry: { entries: [], facts: parseProcFacts('') }, isSame: same })
    const lines = text.split('\n')
    expect(lines[0]).toBe(`${MAX_LICENCES + 3} licences (directory scan cached, 5 s old; logged_in says only that .credentials.json and .claude.json are there: neither is opened).`)
    expect(lines.filter(line => line.startsWith('- ')).length).toBe(MAX_LICENCES)
    expect(lines).toContain('(3 more licences not shown)')
    expect(lines).toContain(`2 directories were not examined (more than ${SCAN_MAX_DIRS} in one listing).`)
    const odd = listLicencesText({ scan: { licences: [{ configDir: '/h/\u001b[31mx', name: '\u001b[31mx', source: 'explicit', loggedIn: false }], skipped: 0, ignored: 0, scannedAt: 0 }, nowMs: 0, isCached: false, isSame: same })
    expect(odd.includes('\u001b')).toBe(false)
  })

  test('isUsageFresh and hasProbeRoom: windows kept 60 s, a code 15 s; a probe starts while one more fits in 40 s', () => {
    const ok = { at: 1000, result: { ok: true as const, five: null, seven: { percent: 3, resets: '' } } }
    const failed = { at: 1000, result: { ok: false as const, code: 'PARSE' as const } }
    expect([isUsageFresh(ok, 1000), isUsageFresh(ok, 1000 + USAGE_CACHE_MS - 1), isUsageFresh(ok, 1000 + USAGE_CACHE_MS), isUsageFresh(ok, 999)]).toEqual([true, true, false, false])
    expect([isUsageFresh(failed, 1000 + USAGE_FAIL_CACHE_MS - 1), isUsageFresh(failed, 1000 + USAGE_FAIL_CACHE_MS)]).toEqual([true, false])
    expect(USAGE_CALL_BUDGET_MS).toBe(40_000)
    expect([hasProbeRoom(0), hasProbeRoom(USAGE_CALL_BUDGET_MS - USAGE_PROBE_WORST_MS), hasProbeRoom(USAGE_CALL_BUDGET_MS - USAGE_PROBE_WORST_MS + 1)]).toEqual([true, true, false])
  })

  test('probeUsageText: a missing window is -, a code its own field; reset text cleaned; licences left named, at most ten', () => {
    const licences = Array.from({ length: 13 }, (_, at): Licence => ({ configDir: `/h/l${at}`, name: `l${at}`, source: 'child', loggedIn: true }))
    const rows = [
      { licence: licences[0] as Licence, seen: { at: 0, result: { ok: true as const, five: { percent: 7, resets: 'in 2 hr' }, seven: null } }, isCached: false },
      { licence: licences[1] as Licence, seen: { at: 0, result: { ok: false as const, code: 'FAILED' as const } }, isCached: true },
      ...licences.slice(2).map(licence => ({ licence, isCached: false })),
    ]
    const lines = probeUsageText(rows, 3000).split('\n')
    expect(lines.slice(0, 3)).toEqual([
      'Usage of 2 licences (1 probed now, 1 from the cache): highest five_hour 7% (l0), highest seven_day -.',
      '- l0 (config_dir /h/l0) | five_hour 7% (resets in 2 hr) | seven_day - | age_seconds 3 | cached no',
      '- l1 (config_dir /h/l1) | error FAILED | age_seconds 3 | cached yes',
    ])
    expect(lines[3]).toBe('11 more not probed: call again (l2, l3, l4, l5, l6, l7, l8, l9, l10, l11, ...).')
  })
})
