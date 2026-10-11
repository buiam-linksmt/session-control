// The licence tools through the plugin on the mock engine: list_licences over a simulated machine (mock-world.ts on
// Linux, a small machine of its own for Windows), with directory listings and the presence of the two files of a
// licence; the licence files hold canaries that must reach no answer and no trace, since the tools never open them.
// The pure parts of hooks/licences.ts are tested on their own at the end.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isSameWinPath, parseProcFacts } from '../hooks/core'
import { MAX_LICENCES, SCAN_CACHE_MS, SCAN_MAX_DIRS, findLicence, licenceCandidates, licenceDirsOf, licenceName, licenceOf, listLicencesText } from '../hooks/licences'
import type { Licence } from '../hooks/licences'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, ORCH, REGISTRY, RUNS, mockWorld, seedLiveWorker } from './mock-world'
import type { World } from './mock-world'

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

// ---------------------------------------------------------------- Windows

const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\w\\home' }
const WIN_ORCH = 'C:/w/orch'
const WIN_REGISTRY = 'C:/w/home/.claude/headless-sessions.json'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const given = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')

/** A small Windows machine: files by their C:/ path (case kept as given), folders listed by what is under them, no process. */
function winWorld(on: On) {
  const w = { files: new Map<string, string>(), runs: [] as string[][], clock: mock.clock(on, { now: NOW_MS }) }
  mock.env(on, WIN_ENV)
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
  on('fs.stat', ($, e) => {
    if (find(e.path) !== undefined) return { value: { kind: 'file', size: 1, mtimeMs: NOW_MS, isLink: false } as never }
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
    if (e.argv[0] === POWERSHELL) return { value: ok }
    if (e.argv[0] === 'git') return { value: { ...ok, exitCode: 128 } }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }) as never)
  return w
}

const WIN_OPTIONS = { orchestratorDir: WIN_ORCH, registryPath: '~/.claude/headless-sessions.json', helper: 'off', licenceDirs: 'D:\\Lic\\Extra, d:/lic/extra/, C:\\w\\home\\.claude\\Second' }

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
    // No process but the mod's own PowerShell scripts: the discovery is listings and presence only.
    expect(w.runs.every(argv => argv[0] === POWERSHELL || argv[0] === 'git')).toBe(true)
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
})
