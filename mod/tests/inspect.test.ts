// The read-only inspection tools (list_sessions, read_result, worker_tail, session_writes, panel_snapshot) through the
// plugin on the mock engine, over a simulated machine: files in a map with their mtimes, the probe's output, the
// transcript tails and the listing answered from that map. No real registry, transcript or /proc. The pure parts of
// hooks/inspect.ts are tested on their own at the end.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { tailLines, workerName } from '../hooks/core'
import { APPEND_SCRIPT, NEWER_SCRIPT, PROBE_SCRIPT, TAIL_SHAPED_SCRIPT } from '../hooks/host-posix'
import {
  MAX_ANSWER_CHARS,
  assistantMessages,
  bounded,
  firstTimestamp,
  isSamePath,
  isUnder,
  lastReport,
  matchSession,
  plainText,
  redactCounted,
  sessionWritesText,
  shownName,
  shownSessionId,
  transcriptWrites,
  workerTailText,
} from '../hooks/inspect'
import { REDACTED, redact } from '../hooks/trace'
import { newerInMap } from './fake-helper'
import { NOW_MS, NOW_SEC } from './fixtures'

const HOME = '/m/home'
const ORCH = '/m/work/orch'
const CFG = '/m/cfg'
const REG = `${HOME}/.claude/headless-sessions.json`
const RUNS = `${HOME}/.claude/session-control/runs`
const OPTIONS = { orchestratorDir: ORCH, registryPath: '~/.claude/headless-sessions.json', completionWrites: false, helper: 'off' }

const tool = (name: string) => `mcp__session-control__${name}`

// The sessions of the fixture registry.
const SID_CLEAN = 'c1ea0000-1111-4111-8111-111111111111'
const SID_CHATTER = 'c4a7000a-2222-4222-8222-222222222222'
const SID_MISSING = '0155000b-3333-4333-8333-333333333333'
const SID_ALIVE = 'a11e000c-4444-4444-8444-444444444444'
const SID_BARE = 'ba7e000d-5555-4555-8555-555555555555'
const SID_TWIN_A = 'deadbeef-6666-4666-8666-666666666661'
const SID_TWIN_B = 'deadbeef-6666-4666-8666-666666666662'
const SID_WRITER = 'e7e7000e-7777-4777-8777-777777777777'
const SID_BIG = 'b1900000-8888-4888-8888-888888888888'

/** Secrets of the kinds the trace's redaction knows: none may reach an answer. */
const CANARIES = {
  anthropic: 'sk-ant-api03-CANARYcanary0123456789abcdef',
  github: 'ghp_CANARY0123456789abcdefABCDEF',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjYW5hcnkiLCJpYXQiOjE3OTAwMDAwMDB9.c2lnbmF0dXJlY2FuYXJ5MDEyMzQ1Njc4OWFiY2RlZg',
  password: 'hunter2canary',
}
const CANARY_PARTS = ['CANARY', 'canary0123', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'hunter2']
const expectNoCanary = (text: string) => {
  for (const part of CANARY_PARTS) expect(text).not.toContain(part)
}

const CLEAN_REPORT = [
  '## Report',
  'Implemented the parser; 14 tests pass; pushed feature/parser to both remotes.',
  `The key ${CANARIES.anthropic} and the token ${CANARIES.github} were found in the old config, and a JWT ${CANARIES.jwt}.`,
  `password=${CANARIES.password} was in a fixture; all of them are reported as an open point.`,
  '`git status -sb` (exit 0): ## feature/parser...origin/feature/parser',
].join('\n')

const transcriptOf = (cwd: string, sid: string) => `${CFG}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${sid}.jsonl`
const row = (value: object) => JSON.stringify(value)
const assistant = (id: string, text: string, at: string, extra: object = {}) => row({ type: 'assistant', timestamp: at, message: { id, content: [{ type: 'text', text }] }, ...extra })
const toolUse = (id: string, name: string, input: object, at: string) => row({ type: 'assistant', timestamp: at, message: { id, content: [{ type: 'tool_use', name, input }] } })
const toolResult = (content: string, at: string) => row({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', content }] } })

const REAL_REPORT = `## Final report\n${'The suite was rewritten and every case passes. '.repeat(8)}\nThe token ${CANARIES.github} sat in .env.example.`
/** A chatter run's transcript: the real report, then late notification chatter, and a subagent's long message (not the session's). */
const CHATTER_TRANSCRIPT = [
  row({ type: 'user', timestamp: '2026-09-21T10:00:00.250Z', message: { content: 'Do the work.' } }),
  assistant('m1', 'Starting.', '2026-09-21T10:00:05Z'),
  assistant('m2', `${REAL_REPORT.slice(0, 200)}`, '2026-09-21T10:20:00Z'),
  // The same API message goes on in a second row: its text belongs to the same report.
  assistant('m2', REAL_REPORT.slice(200), '2026-09-21T10:20:00Z'),
  toolResult('<task-notification>done</task-notification>', '2026-09-21T10:21:00Z'),
  assistant('m3', 'Noted.', '2026-09-21T10:21:05Z'),
  assistant('s1', `A subagent's long text ${'x'.repeat(400)}`, '2026-09-21T10:21:10Z', { isSidechain: true }),
  assistant('m4', 'Done.', '2026-09-21T10:21:20Z'),
].join('\n')

const ALIVE_TRANSCRIPT = [
  row({ type: 'user', timestamp: '2026-09-21T11:00:00Z', message: { content: 'Go.' } }),
  assistant('a1', 'Reading the suite files.', '2026-09-21T11:00:02Z'),
  toolUse('a2', 'Bash', { command: 'git status -sb' }, '2026-09-21T11:00:03Z'),
  toolResult(`## develop...origin/develop\nAPI_KEY=${CANARIES.password}`, '2026-09-21T11:00:04Z'),
  assistant('a3', `Now \u001b[31mred\u001b[0m text and a key ${CANARIES.anthropic}.`, '2026-09-21T11:00:05Z'),
].join('\n')

/** The writer's transcript: it starts at T0, edits a helper file and names the registry in a command. */
const T0 = NOW_SEC - 3600
const WRITER_TRANSCRIPT = [
  row({ type: 'queue-operation', operation: 'enqueue' }),
  row({ type: 'user', timestamp: new Date(T0 * 1000 + 750).toISOString(), message: { content: 'Write things.' } }),
  toolUse('w1', 'Edit', { file_path: `${ORCH}/open-points.json`, old_string: 'a', new_string: 'b' }, new Date((T0 + 10) * 1000).toISOString()),
  toolUse('w2', 'Bash', { command: `jq . ${REG} > /dev/null` }, new Date((T0 + 20) * 1000).toISOString()),
  toolUse('w3', 'Write', { file_path: '/m/work/a/x.txt', content: 'x' }, new Date((T0 + 30) * 1000).toISOString()),
].join('\n')

const REGISTRY = [
  { title: 'clean worker', session_id: SID_CLEAN, name: 'w-clean-260921100000', config_dir: CFG, cwd: '/m/work/clean', model: 'opus', effort: 'high', reported: true, result_file: `${RUNS}/clean.json`, err_file: `${RUNS}/clean.err`, started_at: NOW_SEC - 7200, ended_at: NOW_SEC - 6000, outcome: { kind: 'clean', summary: 'clean: Implemented the parser', costUsd: 1.23 } },
  { title: 'chatter worker', session_id: SID_CHATTER, config_dir: CFG, cwd: '/m/work/chatter', model: 'sonnet', effort: 'medium', reported: false, result_file: `${RUNS}/chatter.json`, outcome: { kind: 'chatter', summary: 'chatter: short result "Done." after a substantial run', costUsd: 7.2 } },
  { title: 'missing result', session_id: SID_MISSING, config_dir: CFG, cwd: '/m/work/missing', model: 'opus', effort: 'low', reported: false, result_file: `${RUNS}/gone.json` },
  { title: 'alive \u001b[31mworker\u001b[0m', pid: 4101, session_id: SID_ALIVE, config_dir: CFG, cwd: '/m/work/alive', model: 'opus', effort: 'high', started_at: NOW_SEC - 125 },
  { title: `bare ${CANARIES.github}`, session_id: SID_BARE, config_dir: CFG, cwd: '/m/work/bare', reported: true },
  { title: 'twin a', session_id: SID_TWIN_A, config_dir: CFG, cwd: '/m/work/twin', reported: true },
  { title: 'twin b', session_id: SID_TWIN_B, config_dir: CFG, cwd: '/m/work/twin', reported: true },
  { title: 'writer', session_id: SID_WRITER, config_dir: CFG, cwd: '/m/work', reported: true, started_at: T0 + 600 },
  { title: 'big transcript', session_id: SID_BIG, config_dir: CFG, cwd: '/m/work/big', reported: true, result_file: `${RUNS}/big.json`, started_at: T0 + 900 },
]

const result = (fields: object) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields })

/** What the /proc probe prints: the alive worker's proof, an orphan, a licence probe and an interactive claude (neither listed), transcript ages. */
const PROBE = [
  ['P', 4101, 'claude', 125, '/m/work/alive', CFG, 'claude -p --model opus -- prompt'],
  ['P', 4999, 'claude', 2400, '/m/elsewhere', '/m/lic/b', 'claude -p --model haiku --output-format json -- a prompt'],
  ['P', 5100, 'claude', 1, '/', '/m/lic/b', 'claude -p /usage --output-format json --no-session-persistence'],
  ['P', 3000, 'claude', 90000, ORCH, '', 'claude --continue'],
  ['A', 4101, 'claude', 5000, 5000, SID_ALIVE],
  ['T', SID_ALIVE, NOW_SEC - 30],
]
  .map(cols => cols.join('\t'))
  .join('\n')

type World = { files: Map<string, string>; mtimes: Map<string, number>; writes: string[]; runs: string[][]; unreadable: Set<string> }

function world(on: On, registry: object[] = REGISTRY): World {
  const files = new Map<string, string>([
    [REG, JSON.stringify(registry, null, 2) + '\n'],
    [`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n'],
    [`${ORCH}/open-points.json`, JSON.stringify({ points: [{ id: 'p1', status: 'open', title: `Rotate the key ${CANARIES.anthropic}`, detail: 'Found in a transcript.', recommendation: 'Rotate it.', raised: '2026-09-20' }, { id: 'p2', status: 'open', title: 'Second point', detail: '', recommendation: '' }] })],
    [`${ORCH}/task-queue.json`, JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: 'Queued task' }, { id: 'q2', status: 'running', title: 'Running task' }, { id: 'q3', status: 'done', title: 'Done task' }] })],
    [`${ORCH}/agreed-decisions.md`, '# Agreed decisions\n'],
    [`${ORCH}/open-points-archive.md`, '# Open points archive\n'],
    [`${RUNS}/clean.json`, result({ result: CLEAN_REPORT, total_cost_usd: 1.23, duration_ms: 312_000, num_turns: 41 })],
    [`${RUNS}/clean.err`, ''],
    [`${RUNS}/chatter.json`, result({ result: 'Done.', total_cost_usd: 7.2, duration_ms: 1_800_000, num_turns: 60 })],
    [`${RUNS}/big.json`, result({ result: `${'A long report line. '.repeat(400)}`, total_cost_usd: 2, duration_ms: 100_000, num_turns: 9 })],
    [transcriptOf('/m/work/chatter', SID_CHATTER), CHATTER_TRANSCRIPT],
    [transcriptOf('/m/work/missing', SID_MISSING), CHATTER_TRANSCRIPT],
    [transcriptOf('/m/work/alive', SID_ALIVE), ALIVE_TRANSCRIPT],
    [transcriptOf('/m/work', SID_WRITER), WRITER_TRANSCRIPT],
    [transcriptOf('/m/work/big', SID_BIG), WRITER_TRANSCRIPT],
    // The writer's tree: written before and after its start, a .git folder, the orchestrator directory below it.
    ['/m/work/old.txt', 'x'],
    ['/m/work/a/x.txt', 'x'],
    ['/m/work/.git/index', 'x'],
    [`${ORCH}/task-queue.json.bak`, 'x'],
  ])
  const mtimes = new Map<string, number>([
    ['/m/work/old.txt', (T0 - 100) * 1000],
    ['/m/work/a/x.txt', (T0 + 30) * 1000],
    ['/m/work/.git/index', (T0 + 40) * 1000],
    [`${ORCH}/open-points.json`, (T0 + 10) * 1000],
    [`${ORCH}/task-queue.json.bak`, (T0 + 50) * 1000],
  ])
  const w: World = { files, mtimes, writes: [], runs: [], unreadable: new Set() }
  const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  mock.clock(on, { now: NOW_MS })
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: tool(e.name) } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    if (w.unreadable.has(e.path)) throw new Error(`EFBIG ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.stat', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: mtimes.get(e.path) ?? NOW_MS - 45_000, isLink: false } }
  })
  on('process.run', ($, e) => {
    const argv = e.argv.map(String)
    w.runs.push(argv)
    const [cmd, , script] = argv
    if (cmd === 'sh' && script === PROBE_SCRIPT) return ok(PROBE)
    if (cmd === 'sh' && script === 'tail -n 600 "$1" | cut -c1-20000') {
      const text = files.get(argv[4] ?? '')
      return text === undefined ? ok('', 1) : ok(tailLines(text, 600, 20000))
    }
    if (cmd === 'sh' && script === TAIL_SHAPED_SCRIPT) {
      const text = files.get(argv[4] ?? '')
      return text === undefined ? ok('', 1) : ok(tailLines(text, Number(argv[5]), Number(argv[6])).slice(-Number(argv[7])))
    }
    if (cmd === 'sh' && script === NEWER_SCRIPT) {
      const found = newerInMap(files, mtimes, argv[4] ?? '', Number(argv[5]))
      if (found === undefined) return ok('', 3)
      return ok(`${found.slice(0, Number(argv[6])).map(one => `${(one.mtimeMs / 1000).toFixed(10)}\t${one.path}\n`).join('')}N\t${found.length}\n`)
    }
    // The debug trace's own appends.
    if (cmd === 'sh' && script === APPEND_SCRIPT) {
      files.set(argv[5] ?? '', `${files.get(argv[5] ?? '') ?? ''}${argv[4]}\n`)
      return ok()
    }
    if (cmd === 'mkdir' || cmd === 'test') return ok()
    throw new Error(`unexpected command ${argv.join(' ')}`)
  })
  return w
}

/** Starts the board and calls one tool; the tool's own writes and commands are what it did after the start. */
async function call($: Parameters<Parameters<typeof test>[2]>[0], w: World, name: string, input: object = {}) {
  await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
  const writes = w.writes.length
  const runs = w.runs.length
  const out = (await $.tool.call({ tool: tool(name), ...input } as never)) as { result?: unknown; deny?: unknown }
  return { out, text: String(out.result ?? ''), deny: out.deny === undefined ? undefined : String(out.deny), writes: w.writes.slice(writes), runs: w.runs.slice(runs) }
}

/** Every command a tool ran is a read: the probe, a tail, the listing. */
const READS = new Set([PROBE_SCRIPT, 'tail -n 600 "$1" | cut -c1-20000', TAIL_SHAPED_SCRIPT, NEWER_SCRIPT])
const expectReadOnly = (got: { writes: string[]; runs: string[][] }) => {
  expect(got.writes).toEqual([])
  expect(got.runs.every(argv => argv[0] === 'sh' && READS.has(argv[2] ?? ''))).toBe(true)
}

describe('list_sessions', () => {
  test('a count line, then every registry row with its fields and the orphan; licence probes and interactive sessions left out; read-only', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'list_sessions')
    expectReadOnly(got)
    const lines = got.text.split('\n')
    expect(lines[0]).toBe('10 session rows: 1 running, 2 finished-unreported, 6 finished, 1 orphan.')
    expect(lines.length).toBe(11)
    expect(lines[1]).toBe(
      `- running | alive worker | session_id ${SID_ALIVE} | name - | pid 4101 | elapsed 2m05s | model opus/high | cwd /m/work/alive | config_dir ${CFG} | outcome - | cost -`,
    )
    expect(got.text).toContain(`- finished | clean worker | session_id ${SID_CLEAN} | name w-clean-260921100000 | pid - | elapsed 20m00s | model opus/high | cwd /m/work/clean | config_dir ${CFG} | outcome clean (clean: Implemented the parser) | cost USD 1.23`)
    expect(got.text).toContain(`- finished-unreported | chatter worker | session_id ${SID_CHATTER} |`)
    expect(got.text).toContain('outcome chatter (chatter: short result "Done." after a substantial run) | cost USD 7.20')
    // The panel's order: running, then the orphan, then the finished rows.
    expect(lines[2]).toBe('- orphan (no registry entry) | pid 4999 | age 40m00s | cwd /m/elsewhere | config_dir /m/lic/b')
    expect(got.text).not.toContain('pid 5100')
    expect(got.text).not.toContain('pid 3000')
    // No terminal control and no secret from the registry's titles.
    expect(got.text).not.toContain('\u001b')
    expect(got.text).toContain('bare [redacted]')
    expectNoCanary(got.text)
  })

  test('include_finished false leaves the finished rows out and says how many', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'list_sessions', { include_finished: false })
    const lines = got.text.split('\n')
    expect(lines[0]).toBe('10 session rows: 1 running, 2 finished-unreported, 6 finished, 1 orphan. 8 finished rows left out (include_finished false).')
    expect(lines.slice(1).map(one => one.split(' | ')[0])).toEqual(['- running', '- orphan (no registry entry)'])
  })

  test('an empty registry: the count line says so, and every live headless claude is an orphan', { options: OPTIONS }, async ($, on) => {
    const w = world(on, [])
    const got = await call($, w, 'list_sessions')
    expect(got.text.split('\n')).toEqual([
      '2 session rows: 2 orphan.',
      '- orphan (no registry entry) | pid 4101 | age 2m05s | cwd /m/work/alive | config_dir /m/cfg',
      '- orphan (no registry entry) | pid 4999 | age 40m00s | cwd /m/elsewhere | config_dir /m/lic/b',
    ])
  })

  test('the session names the launch gives and the session ids are shown as they are; a title keeps its redaction', { options: OPTIONS }, async ($, on) => {
    // Real-shaped names: what workerName gives for real titles, a uniqueness suffix among them. Each is a run of 32 or
    // more letters, digits and dashes, which the redaction takes for a token in free text.
    const at = Date.UTC(2026, 9, 11, 12, 0, 0)
    const names = [
      workerName('session-control T2a write tools', at),
      workerName('NADIR manual tests for 946665, 946670 and 946671', at),
      `${workerName('Windows support for the mod panel', at)}-2`,
      workerName('fix token refresh', at),
    ]
    expect(names).toEqual(['w-session-control-t2a-writ-261011120000', 'w-nadir-manual-tests-for-9-261011120000', 'w-windows-support-for-the-261011120000-2', 'w-fix-token-refresh-261011120000'])
    expect(names.slice(0, 3).every(name => redact(name) === REDACTED)).toBe(true)
    const sids = ['5e551011-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '5e551011-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '5e551011-cccc-4ccc-8ccc-ccccccccccc3', '5e551011-dddd-4ddd-8ddd-ddddddddddd4']
    const entries = names.map((name, n) => ({ title: n === 0 ? `T2a with ${CANARIES.github} in the title` : `worker ${n}`, session_id: sids[n], name, config_dir: CFG, cwd: '/m/work/named', model: 'haiku', effort: 'low', reported: true }))
    // A name the launch never gives (a hand edit, another tool) is free text: a token in it goes.
    entries.push({ title: 'foreign', session_id: '5e551011-eeee-4eee-8eee-eeeeeeeeeee5', name: `my ${CANARIES.anthropic}`, config_dir: CFG, cwd: '/m/work/named', model: 'haiku', effort: 'low', reported: true })
    const w = world(on, entries)
    const got = await call($, w, 'list_sessions')
    expectReadOnly(got)
    for (const [n, name] of names.entries()) expect(got.text).toContain(`| session_id ${sids[n]} | name ${name} | pid -`)
    expect(got.text).toContain(`- finished | T2a with ${REDACTED} in the title | session_id ${sids[0]} | name ${names[0]} |`)
    expect(got.text).toContain(`| name my ${REDACTED} | pid -`)
    expectNoCanary(got.text)
    // The headings of the tools that name one session show the id as it is too.
    const tail = await $.tool.call({ tool: tool('worker_tail'), session_id: sids[0] } as never)
    expect(String((tail as { result?: unknown }).result).split('\n')[0]).toBe(`worker_tail for session ${sids[0]} "T2a with ${REDACTED} in the title"`)
  })

  test('shownName and shownSessionId: the mod\'s forms as they are, anything else cleaned and redacted', () => {
    expect(shownName('w-session-control-t2a-writ-261011120000')).toBe('w-session-control-t2a-writ-261011120000')
    expect(shownName('w-a-261011120000-12')).toBe('w-a-261011120000-12')
    // Not the launch's form: upper case, a blank, control characters, over 64 characters.
    expect(shownName(`W-${'a1'.repeat(20)}`)).toBe(`W-${REDACTED}`)
    expect(shownName('w-a b\u001b[31m')).toBe('w-a b')
    expect(shownName(`w-${'a1b2c3d4e5-'.repeat(6)}261011120000`)).toBe(REDACTED)
    expect(shownSessionId(SID_CLEAN)).toBe(SID_CLEAN)
    expect(shownSessionId(`x ${CANARIES.github}`)).toBe(`x ${REDACTED}`)
  })

  test('a registry that does not parse is a refusal, nothing written', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.files.set(REG, '[{"title": ')
    const got = await call($, w, 'list_sessions')
    expect(got.deny).toStartWith('session-control: registry is not JSON')
    expect(got.writes).toEqual([])
  })
})

describe('read_result', () => {
  test('a clean result: the result file .result, its figures, the redaction counted with canary secrets, no truncation; read-only', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'read_result', { session_id: SID_CLEAN })
    expectReadOnly(got)
    const lines = got.text.split('\n')
    expect(lines.slice(0, 7)).toEqual([
      `read_result for session ${SID_CLEAN} "clean worker"`,
      'process: not alive (no pid recorded: finished or never started)',
      'source: the result file .result',
      'outcome: clean: Implemented the parser; 14 tests pass; pushed feature/parser to both remotes.',
      'run: cost USD 1.23, duration 5m12s, turns 41, is_error false, subtype success',
      'redaction: 6 replacements (each shows as [redacted])',
      `truncated: no (${got.text.split('--- report ---\n')[1]?.split('\n--- end of report ---')[0]?.length} characters)`,
    ])
    expect(got.text).toContain('The key [redacted] and the token [redacted] were found')
    expect(got.text).toContain('a JWT [redacted].[redacted].[redacted].')
    expect(got.text).toContain('password=[redacted] was in a fixture')
    expect(got.text).toContain('## feature/parser...origin/feature/parser')
    expectNoCanary(got.text)
  })

  test('the first 8 characters name the session as the full id does', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'read_result', { session_id: SID_CLEAN.slice(0, 8) })
    expect(got.text.split('\n')[0]).toBe(`read_result for session ${SID_CLEAN} "clean worker"`)
  })

  test('chatter: the last substantial assistant message of the transcript, not the late chatter nor a subagent, its parts joined', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'read_result', { session_id: SID_CHATTER })
    expectReadOnly(got)
    const lines = got.text.split('\n')
    expect(lines[2]).toBe(
      'source: the transcript, its last substantial assistant message (200 characters or more, written 2026-09-21T10:20:00Z; 2 shorter assistant messages came after it), because the result file .result is chatter (Done.)',
    )
    expect(lines[3]).toBe('outcome: chatter: short result "Done." after a substantial run')
    expect(lines[4]).toBe('run: cost USD 7.20, duration 30m00s, turns 60, is_error false, subtype success')
    expect(lines[5]).toBe('redaction: 1 replacement (each shows as [redacted])')
    const report = got.text.split('--- report ---\n')[1]?.split('\n--- end of report ---')[0]
    // The two rows of message m2 are one report again, a blank line between its blocks.
    expect(report).toBe(`${REAL_REPORT.slice(0, 200)}\n\n${REAL_REPORT.slice(200)}`.replace(CANARIES.github, '[redacted]'))
    expect(got.text).not.toContain("A subagent's long text")
    expect(got.text).not.toContain('Noted.')
  })

  test('a missing result file: the transcript is the source, and the answer says why', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'read_result', { session_id: SID_MISSING })
    const lines = got.text.split('\n')
    expect(lines[2]).toEndWith('because the result file is not there (the run has not ended, or wrote none)')
    expect(lines[3]).toBe('outcome: none yet')
    expect(got.text).not.toContain('run: ')
    expect(got.text).toContain('## Final report')
  })

  test('no result file named and no transcript: source none, and why', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'read_result', { session_id: SID_BARE })
    expect(got.text.split('\n').slice(2)).toEqual([
      `source: none: the entry names no result file, and the transcript cannot be read (${transcriptOf('/m/work/bare', SID_BARE)} cannot be read)`,
      'outcome: none yet',
    ])
    expect(got.text).not.toContain('--- report ---')
  })

  test('a transcript over the read cap is read from its tail, in the wide shape, and said to be the tail', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.unreadable.add(transcriptOf('/m/work/chatter', SID_CHATTER))
    const got = await call($, w, 'read_result', { session_id: SID_CHATTER })
    expectReadOnly(got)
    expect(got.text.split('\n')[2]).toStartWith("source: the transcript's tail, its last substantial assistant message")
    expect(got.runs.some(argv => argv[2] === TAIL_SHAPED_SCRIPT && argv[5] === '400' && argv[6] === '400000')).toBe(true)
  })

  test('truncation: the head kept up to max_chars, the cut counted', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'read_result', { session_id: SID_BIG, max_chars: 1000 })
    expect(got.text).toContain('truncated: yes, the first 1000 of 8000 characters kept, 7000 cut')
    expect(got.text.split('--- report ---\n')[1]?.split('\n--- end of report ---')[0]?.length).toBe(1000)
  })

  test('an unknown id and an id two entries share are clear refusals', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const unknown = await call($, w, 'read_result', { session_id: '99999999' })
    expect(unknown.deny).toBe('session-control: no registry entry has the session id 99999999 (give the full id or its first 8 characters; list_sessions shows the registry)')
    const twin = await $.tool.call({ tool: tool('read_result'), session_id: 'deadbeef' } as never)
    expect(String((twin as { deny?: unknown }).deny)).toBe(`session-control: 2 registry entries start with deadbeef: give more of the id (${SID_TWIN_A}, ${SID_TWIN_B})`)
    const full = await $.tool.call({ tool: tool('read_result'), session_id: SID_TWIN_B } as never)
    expect(String((full as { result?: unknown }).result).split('\n')[0]).toBe(`read_result for session ${SID_TWIN_B} "twin b"`)
  })
})

describe('worker_tail', () => {
  test('the alive worker: alive, the transcript age from the probe, the last lines as the log pane summarises them, redacted, no terminal control', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'worker_tail', { session_id: SID_ALIVE })
    expectReadOnly(got)
    expect(got.text.split('\n')).toEqual([
      `worker_tail for session ${SID_ALIVE} "alive worker"`,
      'process: alive, pid 4101',
      `transcript: ${transcriptOf('/m/work/alive', SID_ALIVE)}, last written 30 s ago`,
      "last 4 lines (of 40 asked), summarised as the panel's log shows them; redaction: 2 replacements:",
      'Reading the suite files.',
      '> Bash git status -sb',
      '  < ## develop...origin/develop API_KEY=[redacted]',
      'Now red text and a key [redacted].',
    ])
    expectNoCanary(got.text)
    expect(got.text).not.toContain('\u001b')
  })

  test('lines asks for fewer; a finished worker is not alive and its age comes from the file', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'worker_tail', { session_id: SID_ALIVE, lines: 2 })
    expect(got.text.split('\n').slice(3)).toEqual(["last 2 lines (of 2 asked), summarised as the panel's log shows them; redaction: 2 replacements:", '  < ## develop...origin/develop API_KEY=[redacted]', 'Now red text and a key [redacted].'])
    const done = await $.tool.call({ tool: tool('worker_tail'), session_id: SID_CHATTER } as never)
    const lines = String((done as { result?: unknown }).result).split('\n')
    expect(lines[1]).toBe('process: not alive (no pid recorded: finished or never started)')
    expect(lines[2]).toBe(`transcript: ${transcriptOf('/m/work/chatter', SID_CHATTER)}, last written 45 s ago`)
  })

  test('a transcript that cannot be read, and an unknown id', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'worker_tail', { session_id: SID_BARE })
    expect(got.text.split('\n').slice(2)).toEqual([`transcript: ${transcriptOf('/m/work/bare', SID_BARE)}, last write unknown`, 'the transcript cannot be read'])
    const unknown = await $.tool.call({ tool: tool('worker_tail'), session_id: '12345678-0000' } as never)
    expect(String((unknown as { deny?: unknown }).deny)).toContain('no registry entry has the session id 12345678-0000')
  })
})

describe('session_writes', () => {
  test('the files written under the cwd since the first transcript timestamp, newest first; under the orchestrator directory flagged; the transcript\'s own writes; read-only', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'session_writes', { session_id: SID_WRITER })
    expectReadOnly(got)
    // The start is the transcript's first timestamp with its fraction dropped.
    expect(got.runs.find(argv => argv[2] === NEWER_SCRIPT)?.slice(4)).toEqual(['/m/work', String(T0), '200'])
    const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    expect(got.text.split('\n')).toEqual([
      `session_writes for session ${SID_WRITER} "writer"`,
      'cwd: /m/work',
      `since: ${iso(T0)} (the transcript's first timestamp; fractional seconds dropped)`,
      '3 files under the cwd written since then, newest first; .git and symbolic links left out. By mtime: a write by any other process in that tree shows too.',
      `flagged among those shown: 2 under the orchestrator directory ${ORCH}; 0 the registry file ${REG}`,
      `${iso(T0 + 50)}  ${ORCH}/task-queue.json.bak  [ORCHESTRATOR DIR]`,
      `${iso(T0 + 30)}  /m/work/a/x.txt`,
      `${iso(T0 + 10)}  ${ORCH}/open-points.json  [ORCHESTRATOR DIR]`,
      'transcript (the whole transcript): 2 calls writing the registry or under the orchestrator directory, or naming either:',
      `- Edit of ${ORCH}/open-points.json`,
      `- Bash command naming it: jq . ${REG} > /dev/null`,
    ])
  })

  test('the registry file inside the cwd is flagged as the registry', { options: { ...OPTIONS, registryPath: '/m/work/reg.json' } }, async ($, on) => {
    const w = world(on)
    w.files.set('/m/work/reg.json', JSON.stringify(REGISTRY))
    w.mtimes.set('/m/work/reg.json', (T0 + 70) * 1000)
    const got = await call($, w, 'session_writes', { session_id: SID_WRITER })
    expect(got.text).toContain(`flagged among those shown: 2 under the orchestrator directory ${ORCH}; 1 the registry file /m/work/reg.json`)
    expect(got.text).toContain('  /m/work/reg.json  [REGISTRY]')
  })

  test("a transcript over the read cap: the entry's started_at is the start, and the answer says what that leaves out", { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.unreadable.add(transcriptOf('/m/work/big', SID_BIG))
    w.files.set('/m/work/big/late.txt', 'x')
    w.mtimes.set('/m/work/big/late.txt', (T0 + 1000) * 1000)
    w.files.set('/m/work/big/early.txt', 'x')
    w.mtimes.set('/m/work/big/early.txt', (T0 + 100) * 1000)
    const got = await call($, w, 'session_writes', { session_id: SID_BIG })
    expect(got.text).toContain("(the entry's started_at, because the transcript is over the read cap, so its first timestamp cannot be read; a resumed session's earlier runs are not covered; fractional seconds dropped)")
    expect(got.text).toContain('1 file under the cwd written since then')
    expect(got.text).toContain("transcript (the transcript's last 600 lines):")
  })

  test('no start time, no cwd, a cwd that is not there, and an unknown id', { options: OPTIONS }, async ($, on) => {
    const w = world(on, [...REGISTRY, { title: 'no cwd', session_id: 'f0f0f0f0-0000-4000-8000-000000000000', config_dir: CFG }, { title: 'gone dir', session_id: 'f1f1f1f1-0000-4000-8000-000000000000', config_dir: CFG, cwd: '/m/nowhere', started_at: T0 }])
    const bare = await call($, w, 'session_writes', { session_id: SID_BARE })
    expect(bare.deny).toBe(`session-control: no start time for ${SID_BARE}: ${transcriptOf('/m/work/bare', SID_BARE)} cannot be read, and the entry has no started_at`)
    const noCwd = await $.tool.call({ tool: tool('session_writes'), session_id: 'f0f0f0f0' } as never)
    expect(String((noCwd as { deny?: unknown }).deny)).toBe('session-control: the entry of f0f0f0f0-0000-4000-8000-000000000000 has no cwd to list')
    const gone = await $.tool.call({ tool: tool('session_writes'), session_id: 'f1f1f1f1' } as never)
    expect(String((gone as { result?: unknown }).result)).toContain('the files under /m/nowhere cannot be listed (the directory is not there, or the listing failed)')
    const unknown = await $.tool.call({ tool: tool('session_writes'), session_id: 'abcdef12' } as never)
    expect(String((unknown as { deny?: unknown }).deny)).toContain('no registry entry has the session id abcdef12')
  })
})

describe('panel_snapshot', () => {
  const stubPanel = (on: On) => {
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.panes', () => ({ value: [] }) as never)
  }

  test('the three sections as the panel draws them, plain text, the open points redacted; read-only', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    const got = await call($, w, 'panel_snapshot')
    expect(got.writes).toEqual([])
    expect(got.runs).toEqual([])
    const text = got.text
    expect(text.split('\n')[0]).toBe("panel_snapshot: the panel's text as of its last poll 0 s ago, at 120 columns.")
    expect(text).toMatch(/\nSESSIONS\n {2}title +sid +status +model +effort +elapsed\n/)
    expect(text).toMatch(/\n {2}alive worker +a11e000c +running +opus +high +2m05s\n/)
    expect(text).toMatch(/\n {2}\(no entry\) \/m\/elsewhere +- +orphan +\? +\? +40m00s\n/)
    expect(text).toContain('\nQUEUED WORK\n\u2022 Queued task\n\u2022 Running task (running)\n')
    expect(text).toContain('\nOPEN POINTS\n  1. Rotate the key [redacted]\n  2. Second point')
    expect(text).not.toContain('Done task')
    expect(text).not.toContain('LOG ')
    expect(text).not.toContain('\u001b')
    expectNoCanary(text)
  })

  test('with a session log open, its lines follow the sessions, as the panel shows them', { options: OPTIONS }, async ($, on) => {
    // A plain title: the engine refuses to draw a Button whose label holds a control character.
    const w = world(on, REGISTRY.map(one => (one.session_id === SID_ALIVE ? { ...one, title: 'alive worker' } : one)))
    stubPanel(on)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await $.command.run({ command: 'session-control', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'session-control', surface: 'terminal', component: 'Pane', requestId: 'session-control', props: { title: 'Session control', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 36 } } as never })
    await ui.press({ key: `s:${SID_ALIVE}` })
    const out = (await $.tool.call({ tool: tool('panel_snapshot') } as never)) as { result?: unknown }
    const text = String(out.result)
    expect(text.split('\n')[0]).toContain('; a log is open.')
    expect(text).toContain('\nLOG alive worker\nReading the suite files.\n> Bash git status -sb\n')
    expect(text).toContain('API_KEY=[redacted]')
    expectNoCanary(text)
    void w
  })
})

describe('the inspection tools in the debug trace', () => {
  test('a call line with its named fields and a result line with the length only: no report, transcript or file text', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on)
    await call($, w, 'read_result', { session_id: SID_CLEAN })
    await $.tool.call({ tool: tool('worker_tail'), session_id: SID_ALIVE, lines: 3 } as never)
    const trace = w.files.get(`${RUNS}/trace.log`) ?? ''
    const lines = trace.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.filter(line => line.event === 'tool.call').map(({ ts: _t, seq: _s, ...rest }) => rest)).toEqual([
      { event: 'tool.call', tool: 'read_result', session_id: SID_CLEAN },
      { event: 'tool.call', tool: 'worker_tail', session_id: SID_ALIVE, lines: 3 },
    ])
    const results = lines.filter(line => line.event === 'tool.result')
    expect(results.map(line => Object.keys(line).sort())).toEqual([['event', 'resultChars', 'seq', 'tool', 'ts'], ['event', 'resultChars', 'seq', 'tool', 'ts']])
    expect(trace).not.toContain('Implemented the parser')
    expect(trace).not.toContain('Reading the suite files')
  })
})

// ---------------------------------------------------------------- the pure parts

describe('inspect.ts', () => {
  test('matchSession: the full id, its first 8 or more characters, case aside; fewer than 8, none or two are refused', () => {
    const entries = [{ session_id: SID_TWIN_A }, { session_id: SID_TWIN_B }, { session_id: SID_CLEAN }]
    expect(matchSession(entries, SID_CLEAN)).toEqual({ entry: { session_id: SID_CLEAN } })
    expect(matchSession(entries, SID_CLEAN.slice(0, 8).toUpperCase())).toEqual({ entry: { session_id: SID_CLEAN } })
    expect(matchSession(entries, SID_TWIN_A)).toEqual({ entry: { session_id: SID_TWIN_A } })
    expect('error' in matchSession(entries, 'deadbeef')).toBe(true)
    expect('error' in matchSession(entries, 'c1ea')).toBe(true)
    expect('error' in matchSession(entries, '')).toBe(true)
  })

  test('plainText drops escape sequences and control characters; redactCounted counts what it replaced, not what was there', () => {
    expect(plainText('a\u001b[1;31mb\u001b[0m\u001b]0;title\u0007c\rd\r\ne\u0000f\tg')).toBe('abc d\ne f\tg')
    expect(redactCounted(`[redacted] ${CANARIES.anthropic} and ${CANARIES.github}`)).toEqual({ text: '[redacted] [redacted] and [redacted]', count: 2 })
    expect(redactCounted('nothing here')).toEqual({ text: 'nothing here', count: 0 })
  })

  test('assistantMessages joins the rows of one message, leaves out subagents and cut lines; lastReport takes the last long one', () => {
    const cut = assistant('x', 'y'.repeat(300), '2026-09-21T10:30:00Z').slice(0, 100)
    const text = `${CHATTER_TRANSCRIPT}\n${cut}`
    const messages = assistantMessages(text)
    expect(messages.map(one => one.text.length)).toEqual([9, REAL_REPORT.length + 2, 6, 5])
    expect(lastReport(text)?.after).toBe(2)
    expect(lastReport(assistant('a', 'short', 'x'))).toBeUndefined()
  })

  test('firstTimestamp passes rows without one; isUnder and isSamePath compare as the platform does', () => {
    expect(firstTimestamp(WRITER_TRANSCRIPT)).toBe(T0 * 1000 + 750)
    expect(firstTimestamp('not json\n{"type":"x"}')).toBeUndefined()
    expect(isUnder('/m/work/orch/a', '/m/work/orch', false)).toBe(true)
    expect(isUnder('/m/work/orchestra/a', '/m/work/orch', false)).toBe(false)
    expect(isUnder('/m/work/orch', '/m/work/orch/', false)).toBe(true)
    expect(isUnder('/M/work/orch/a', '/m/work/orch', false)).toBe(false)
    expect(isUnder('c:\\Work\\Orch\\a.json', 'C:/work/orch', true)).toBe(true)
    expect(isSamePath('C:\\Users\\U\\.claude\\headless-sessions.json', 'c:/users/u/.claude/headless-sessions.json', true)).toBe(true)
    expect(isSamePath('/a/B', '/a/b', false)).toBe(false)
  })

  test('session_writes on Windows: a path under the orchestrator directory and the registry are flagged in any case and separator', () => {
    const text = sessionWritesText({
      entry: { session_id: SID_WRITER, title: 'w', cwd: 'C:/work' },
      start: { ms: T0 * 1000, source: "the transcript's first timestamp" },
      listing: { files: [{ path: 'C:/work/Orch/open-points.json', mtimeMs: (T0 + 5) * 1000 }, { path: 'C:/work/reg.json', mtimeMs: (T0 + 4) * 1000 }, { path: 'C:/work/a.txt', mtimeMs: (T0 + 3) * 1000 }], total: 3 },
      orchestratorDir: 'C:/work/orch',
      registryPath: 'C:/WORK/REG.json',
      isWindows: true,
      transcript: { text: toolUse('e', 'Write', { file_path: 'c:\\work\\orch\\task-queue.json' }, 'x'), isWhole: true },
    })
    expect(text).toContain('flagged among those shown: 1 under the orchestrator directory C:/work/orch; 1 the registry file C:/WORK/REG.json')
    expect(text).toContain('C:/work/Orch/open-points.json  [ORCHESTRATOR DIR]')
    expect(text).toContain('C:/work/reg.json  [REGISTRY]')
    expect(text).toContain('- Write of c:\\work\\orch\\task-queue.json')
  })

  test('worker_tail tells the age in whole seconds, and from a minute up also as the elapsed column does', () => {
    const entry = { session_id: SID_CHATTER, title: 't' }
    const facts = { claude: [], pidComm: new Map(), pidProof: new Map(), transcriptMtime: new Map() }
    const line = (ageSec: number) => workerTailText({ entry, facts, path: '/t.jsonl', ageSec, lines: [], wanted: 1 }).split('\n')[2]
    expect(line(5.9)).toBe('transcript: /t.jsonl, last written 5 s ago')
    expect(line(125.6)).toBe('transcript: /t.jsonl, last written 125 s ago (2m05s)')
  })

  test('transcriptWrites keeps at most 20 lines; bounded cuts an answer and says how much', () => {
    const many = Array.from({ length: 30 }, (_, n) => toolUse(`t${n}`, 'Write', { file_path: `${ORCH}/f${n}` }, 'x')).join('\n')
    expect(transcriptWrites(many, ORCH, REG, false).length).toBe(20)
    expect(bounded('x'.repeat(MAX_ANSWER_CHARS + 5))).toEndWith('\n[answer cut: 5 more characters not shown]')
  })
})
