// The poll-based notices (notices.ts) through the plugin and as pure functions: orphan, stall, queue-ready,
// unit-complete, compliance-due, open-point-age, retire-due and repo-state; each one's debounce and re-arming on the
// mocked clock, a reload that fires nothing again, the notices option off, the one-line wording, the toast title per
// kind, the orchestrator's own process, and the Windows host. The machine is mock-world.ts (Linux) or the small Windows
// world below; the plugin's store is a map of the test's own, so a test can read what a load left and seed the next.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TOAST_TITLES, parseProcFacts } from '../hooks/core'
import type { ProcFacts } from '../hooks/core'
import {
  NOTICE_PREFIX,
  ORPHAN_GRACE_SEC,
  STALL_SEC,
  freshNoticeState,
  harvestNotices,
  isRegistrySound,
  isRepoDue,
  isRetireDue,
  noticeKeyDir,
  noticeLine,
  noticeStoreKey,
  orphanStep,
  parseNoticeState,
  pointStep,
  pruneHarvested,
  repoStep,
  retireStep,
  stallStep,
  unitStep,
} from '../hooks/notices'
import type { Notice, NoticeKind } from '../hooks/notices'
import { localDate } from '../hooks/store'
import { NOW_MS, RESULTS } from './fixtures'
import { HOME, OPTIONS, ORCH, REGISTRY, RUNS, mockWorld, seedLiveWorker } from './mock-world'
import type { World } from './mock-world'

const NOW_SEC = NOW_MS / 1000
const OWN_SID = '0f0f0f0f-0000-4000-8000-00000000000f'
const OTHER_SID = '5a5a5a5a-0000-4000-8000-00000000005a'
const SID_LIVE = '11111111-aaaa-4bbb-8ccc-111111111111'
const SID_UNIT = '22222222-aaaa-4bbb-8ccc-222222222222'
const SID_FREE = '33333333-aaaa-4bbb-8ccc-333333333333'
const SID_KEPT = '44444444-aaaa-4bbb-8ccc-444444444444'
const KINDS: readonly NoticeKind[] = ['orphan', 'stall', 'queue-ready', 'unit-complete', 'compliance-due', 'open-point-age', 'retire-due', 'repo-state']
const TITLES = KINDS.map(kind => TOAST_TITLES[kind])
const KEY = noticeStoreKey(ORCH)
const QUEUE_TOOL = 'mcp__session-control__queue_task'

type Store = Map<string, unknown>
const clone = (value: unknown) => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown))

/** The plugin's $.store as a map of the test's own, seeded with `entries`. */
function storeOf(on: On, entries: Record<string, unknown> = {}): Store {
  const store: Store = new Map(Object.entries(entries).map(([key, value]) => [key, clone(value)]))
  on('store.get', ($, e) => ({ value: clone(store.get(e.key)) }))
  on('store.set', ($, e) => {
    store.set(e.key, clone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

/** This session's id, as $.session.id answers it. */
const ownSession = (on: On, sid = OWN_SID) => on('session.id', () => ({ value: sid }) as never)

/** The prompt the plugin hands on, so a test reads the context it added. */
const echoPrompt = (on: On) => on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))

type Seed = { entries?: Record<string, unknown>[]; queue?: Record<string, unknown>[]; points?: Record<string, unknown>[] }

function seed(world: World, one: Seed = {}): void {
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  world.files.set(REGISTRY, `${JSON.stringify(one.entries ?? [], null, 2)}\n`)
  if (one.queue !== undefined) world.files.set(`${ORCH}/task-queue.json`, JSON.stringify({ tasks: one.queue }))
  if (one.points !== undefined) world.files.set(`${ORCH}/open-points.json`, JSON.stringify({ points: one.points }))
}

const start = ($: { session: { start: (e: never) => Promise<unknown> } }) => $.session.start({ cwd: ORCH, surface: null, isInteractive: true } as never)

/** Lets the poll run for `seconds`, one interval at a time. */
async function poll(world: World, seconds: number, step = 5): Promise<void> {
  for (let gone = 0; gone < seconds; gone += step) await world.clock.advance(step * 1000)
}

/** The toasts of the notices (by their titles). */
const noticeToasts = (world: World) => world.toasts.filter(text => TITLES.some(title => text.startsWith(`${title} \u00B7 `)))

/** The notice lines a prompt carried: every context line that starts with the notice prefix. */
function noticeLines(sent: { context?: readonly unknown[] }): string[] {
  return (sent.context ?? []).flatMap(one => String(one).split('\n')).filter(line => line.startsWith(NOTICE_PREFIX))
}

const userPrompt = ($: { prompt: { submit: (e: never) => Promise<unknown> } }) =>
  $.prompt.submit({ text: 'what is new?', wait: false, origin: { kind: 'composer' } } as never) as Promise<{ context?: readonly unknown[] }>

/** A live headless claude no entry claims: pid 5555 in /w/other, with its sessions file naming `sid`. */
function seedOrphan(world: World, sid = OTHER_SID, pid = 5555, cmdline = 'claude -p --model opus --output-format json'): void {
  world.table.procs.set(pid, { ppid: 1, start: '42', state: 'S', comm: 'claude', claude: { cwd: '/w/other', configDir: `${HOME}/.claude`, cmdline, elapsedSec: 600 } })
  world.files.set(`${HOME}/.claude/sessions/${pid}.json`, JSON.stringify({ sessionId: sid, procStart: '42' }))
}

/** A transcript the probe finds for a session (its mtime from world.mtimes). */
const seedTranscript = (world: World, sid: string) => world.files.set(`${HOME}/.claude/projects/-w-work/${sid}.jsonl`, '{"type":"user"}\n')

const ORPHAN_TEXT = `pid 5555 is a live headless claude no registry entry claims (cwd /w/other, config dir ${HOME}/.claude, age 10m00s, unclaimed 30s, session ${OTHER_SID}); raise an open point naming it`

describe('orphan', () => {
  for (const isHelper of [false, true]) {
    test(`${isHelper ? 'through the helper' : 'through sh'}: told once, 30 s after it is first seen unclaimed, as a toast titled by its kind and one line on the next prompt`, { options: OPTIONS }, async ($, on) => {
      const world = mockWorld(on, { isHelper })
      const store = storeOf(on)
      ownSession(on)
      echoPrompt(on)
      seed(world)
      seedOrphan(world)
      await start($)
      await poll(world, ORPHAN_GRACE_SEC - 5)
      expect(noticeToasts(world)).toEqual([])
      await poll(world, 5)
      expect(noticeToasts(world)).toEqual([`Unregistered session \u00B7 ${ORPHAN_TEXT}`])
      const sent = await userPrompt($)
      expect(noticeLines(sent)).toEqual([`session-control notice: orphan: ${ORPHAN_TEXT}`])
      // Never again for that pid; the next prompt carries nothing.
      await poll(world, 120)
      expect(noticeToasts(world).length).toBe(1)
      expect(noticeLines(await userPrompt($))).toEqual([])
      expect(parseNoticeState(store.get(KEY)).orphans['5555']).toEqual({ since: NOW_MS, isTold: true })
    })
  }

  test('never for the orchestrator\'s own process (its sessions file names this session), a licence probe or a registered worker', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    ownSession(on)
    seed(world, { entries: [seedLiveWorker(world, SID_LIVE)] })
    seedOrphan(world, OWN_SID, 6000, 'claude -p --output-format stream-json')
    seedOrphan(world, OTHER_SID, 6001, 'claude -p /usage --output-format json --no-session-persistence')
    seedTranscript(world, SID_LIVE)
    world.mtimes.set(SID_LIVE, NOW_SEC + 3600)
    await start($)
    await poll(world, 90)
    expect(noticeToasts(world)).toEqual([])
    // The own process is marked once and its sessions file is not read again at every poll.
    expect(parseNoticeState(store.get(KEY)).orphans['6000']).toEqual({ since: NOW_MS, isOwn: true })
    expect(parseNoticeState(store.get(KEY)).orphans['6001']).toBeUndefined()
  })

  test('the launch gap: a process claimed before the 30 s are up is never told, and a pid that goes is forgotten', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    seed(world)
    seedOrphan(world)
    await start($)
    await poll(world, 20)
    world.files.set(REGISTRY, JSON.stringify([{ title: 'launched', pid: 5555, session_id: OTHER_SID, config_dir: `${HOME}/.claude`, cwd: '/w/other' }]))
    await poll(world, 60)
    expect(noticeToasts(world)).toEqual([])
    expect(parseNoticeState(store.get(KEY)).orphans).toEqual({})
  })
})

describe('stall', () => {
  test('a live worker silent for 15 minutes is told once per episode; a transcript written again re-arms it', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, { entries: [seedLiveWorker(world, SID_LIVE, { name: 'w-live-worker-261011090000' })] })
    seedTranscript(world, SID_LIVE)
    world.mtimes.set(SID_LIVE, NOW_SEC - STALL_SEC + 10)
    await start($)
    await poll(world, 5)
    expect(noticeToasts(world)).toEqual([])
    await poll(world, 5)
    const text = 'worker "live worker" (session w-live-worker-261011090000) is alive but its transcript has not been written for 15 min; look at it with worker_tail'
    expect(noticeToasts(world)).toEqual([`Session stalled \u00B7 ${text}`])
    expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: stall: ${text}`])
    await poll(world, 300)
    expect(noticeToasts(world).length).toBe(1)
    // It writes again, then falls silent again: a new episode, told once more.
    world.mtimes.set(SID_LIVE, NOW_SEC + 310)
    await poll(world, 10)
    expect(noticeToasts(world).length).toBe(1)
    world.mtimes.set(SID_LIVE, NOW_SEC + 320 - STALL_SEC - 60)
    await poll(world, 5)
    expect(noticeToasts(world).length).toBe(2)
    expect(noticeToasts(world)[1]).toContain('has not been written for 16 min')
  })

  test('a finished worker is never stalled', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seed(world, { entries: [{ title: 'gone', session_id: SID_LIVE, config_dir: `${HOME}/.claude`, cwd: '/w/work', reported: false, outcome: { kind: 'clean' } }] })
    seedTranscript(world, SID_LIVE)
    world.mtimes.set(SID_LIVE, NOW_SEC - 7200)
    await start($)
    await poll(world, 30)
    expect(noticeToasts(world)).toEqual([])
  })
})

/** A finished worker with a clean report, launched with a decisions section, whose pid is gone: the first poll harvests it. */
const UNIT_ENTRY = {
  title: 'unit worker',
  pid: 4300,
  session_id: SID_UNIT,
  name: 'w-unit-worker-261011090000',
  config_dir: `${HOME}/.claude`,
  cwd: '/w/work',
  model: 'haiku',
  effort: 'low',
  result_file: `${RUNS}/unit.json`,
  section: 'Unit X (user, 2026-10-11)',
}

describe('harvest: queue-ready, compliance-due and unit-complete', () => {
  test('a harvest tells each queued task waiting for the session and the compliance check due; unit-complete waits for an empty queue and is told once until a task is queued again', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, {
      entries: [UNIT_ENTRY],
      queue: [
        { id: 'q-next', status: 'queued', title: 'Next step', waits_for: 'w-unit-worker-261011090000 to finish' },
        { id: 'q-id8', status: 'queued', title: 'By id', waits_for: `session ${SID_UNIT.slice(0, 8)}` },
        { id: 'q-licence', status: 'queued', title: 'Waits on licence', waits_for: 'licence headroom 40%' },
        { id: 'q-done', status: 'done', title: 'Done before', waits_for: SID_UNIT },
      ],
    })
    world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
    // The done task q-done also makes the hourly retire-due reminder due at the first tick: counted apart here.
    const told = () => noticeToasts(world).filter(text => !text.startsWith(`${TOAST_TITLES['retire-due']} \u00B7 `))
    await start($)
    expect(world.toasts).toEqual([
      'Session finished \u00B7 unit worker: clean: Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.',
      'Queued task ready \u00B7 queued task q-next waited for w-unit-worker-261011090000, which finished',
      'Queued task ready \u00B7 queued task q-id8 waited for w-unit-worker-261011090000, which finished',
      'Compliance check due \u00B7 compliance check due for section Unit X (user, 2026-10-11) (session w-unit-worker-261011090000)',
    ])
    // The task notification carries the completion and, after it, the notices, one line each.
    const sent = (await $.prompt.submit({ text: 'notification', wait: false, origin: { kind: 'task-notification' } } as never)) as { context?: readonly unknown[] }
    expect(String(sent.context?.[0])).toStartWith('session-control completions: unit worker: clean: ')
    expect(noticeLines(sent)).toEqual([
      'session-control notice: queue-ready: queued task q-next waited for w-unit-worker-261011090000, which finished',
      'session-control notice: queue-ready: queued task q-id8 waited for w-unit-worker-261011090000, which finished',
      'session-control notice: compliance-due: compliance check due for section Unit X (user, 2026-10-11) (session w-unit-worker-261011090000)',
    ])
    await poll(world, 30)
    expect(told().length).toBe(3)
    expect(noticeToasts(world).filter(text => text.startsWith('Housekeeping due')).length).toBe(1)
    // The queue empties through queue_task: unit-complete once the last queued task is done, not before, once.
    for (const id of ['q-next', 'q-id8']) await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id, status: 'done' } as never)
    expect(told().length).toBe(3)
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-licence', status: 'done' } as never)
    expect(told().slice(3)).toEqual(['Queue empty \u00B7 queue empty: run audit_state and report'])
    expect(noticeLines(await userPrompt($)).filter(line => !line.includes(' retire-due: '))).toEqual(['session-control notice: unit-complete: queue empty: run audit_state and report'])
    await $.tool.call({ tool: QUEUE_TOOL, action: 'remove', id: 'q-done' } as never)
    await poll(world, 30)
    expect(told().length).toBe(4)
    // A task queued again re-arms it.
    await $.tool.call({ tool: QUEUE_TOOL, action: 'add', id: 'q-new', title: 'New work', status: 'queued' } as never)
    await poll(world, 5)
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-new', status: 'running' } as never)
    expect(told().length).toBe(4)
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-new', status: 'done' } as never)
    expect(told().slice(4)).toEqual(['Queue empty \u00B7 queue empty: run audit_state and report'])
  })

  test('a harvest that leaves the queue empty tells unit-complete; a non-clean outcome or no section tells no compliance check', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seed(world, { entries: [{ ...UNIT_ENTRY, result_file: `${RUNS}/limit.json` }, { ...UNIT_ENTRY, pid: 4301, session_id: SID_FREE, name: 'w-plain-261011090000', section: undefined, result_file: `${RUNS}/plain.json` }], queue: [] })
    world.files.set(`${RUNS}/limit.json`, RESULTS.limit)
    world.files.set(`${RUNS}/plain.json`, RESULTS.clean)
    await start($)
    expect(noticeToasts(world)).toEqual(['Queue empty \u00B7 queue empty: run audit_state and report'])
  })
})

describe('open-point-age', () => {
  const dayMs = 86_400_000
  const raisedAgo = (days: number) => localDate(NOW_MS - days * dayMs)

  test('an open, not held point older than 24 hours is told once per point and day; a held, closed or fresh one is not', { options: { ...OPTIONS, pollSeconds: 3600 } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, {
      points: [
        { id: 'op-old', status: 'open', raised: raisedAgo(2), title: 'Which branch gets the fix?' },
        { id: 'op-held', status: 'open', hold: true, raised: raisedAgo(5), title: 'Held' },
        { id: 'op-closed', status: 'closed', raised: raisedAgo(5), title: 'Settled' },
        { id: 'op-new', status: 'open', raised: localDate(NOW_MS), title: 'Raised today' },
      ],
    })
    await start($)
    const old = `open point op-old (raised ${raisedAgo(2)}) is still open: Which branch gets the fix?`
    expect(noticeToasts(world)).toEqual([`Open point waiting \u00B7 ${old}`])
    expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: open-point-age: ${old}`])
    await poll(world, 3600, 3600)
    expect(noticeToasts(world).length).toBe(1)
    // The fresh point counts from the moment the mod first saw it: told 24 hours later; the old one once that next day.
    for (let hour = 1; hour < 24; hour++) await world.clock.advance(3600_000)
    const day = noticeToasts(world).slice(1)
    expect(day.filter(one => one.includes('op-old')).length).toBe(1)
    expect(day.filter(one => one.includes('op-new')).length).toBe(1)
    expect(day.some(one => one.includes('op-held') || one.includes('op-closed'))).toBe(false)
  })
})

describe('retire-due', () => {
  const entries = [
    { title: 'free', session_id: SID_FREE, config_dir: `${HOME}/.claude`, reported: true, outcome: { kind: 'clean' } },
    { title: 'kept', session_id: SID_KEPT, config_dir: `${HOME}/.claude`, reported: true, keep: true, outcome: { kind: 'clean' }, ended_at: NOW_SEC - 7 * 3600 },
  ]
  const queue = [
    { id: 'q-done', status: 'done', title: 'Done' },
    { id: 'q-blocked', status: 'blocked', title: 'Odd status' },
    { id: 'q-run', status: 'running', title: 'Running, no session' },
  ]
  const text = `1 finished session can be retired (${SID_FREE.slice(0, 8)}); 1 kept session idle over 6 hours (${SID_KEPT.slice(0, 8)}); 3 queue tasks look stale (q-blocked, q-run, q-done): run audit_state`

  test('from the poll, at most once per hour, with counts and ids from audit_state\'s own findings', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, { entries, queue })
    await start($)
    // Not at the activation: the poll's first tick.
    expect(noticeToasts(world)).toEqual([])
    await poll(world, 60, 60)
    expect(noticeToasts(world)).toEqual([`Housekeeping due \u00B7 ${text}`])
    expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: retire-due: ${text}`])
    await poll(world, 3540, 60)
    expect(noticeToasts(world).length).toBe(1)
    await poll(world, 60, 60)
    expect(noticeToasts(world).length).toBe(2)
  })

  test('nothing to retire and a clean queue: nothing told', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seed(world, { entries: [{ ...entries[0], outcome: { kind: 'limit' } }], queue: [{ id: 'q', status: 'queued', title: 'Fine' }] })
    await start($)
    await poll(world, 600, 60)
    expect(noticeToasts(world)).toEqual([])
  })
})

describe('repo-state', () => {
  /** git in the orchestrator directory: on `branch` (default main), CLAUDE.md changed when `isChanged`. */
  const gitOf = (world: World, branch: string, isChanged: boolean) => (args: readonly string[]) => {
    expect(args.slice(0, 3)).toEqual(['--no-optional-locks', '-C', ORCH])
    const rest = args.slice(3).join(' ')
    world.runs.push(['git-seen', rest])
    if (rest === 'rev-parse --is-inside-work-tree') return { exitCode: 0, stdout: 'true\n' }
    if (rest === 'symbolic-ref --short -q HEAD') return { exitCode: 0, stdout: `${branch}\n` }
    if (rest === 'symbolic-ref --short -q refs/remotes/origin/HEAD') return { exitCode: 0, stdout: 'origin/main\n' }
    if (rest.startsWith('status')) return { exitCode: 0, stdout: isChanged ? ' M CLAUDE.md\0' : '' }
    if (rest === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: `${ORCH}\n` }
    return { exitCode: 1, stdout: '' }
  }
  const gitRuns = (world: World) => world.runs.filter(argv => argv[0] === 'git').length

  test('from the poll with no worker alive, at most once per hour (git too): a branch other than the default, and changes once 30 minutes old', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world)
    world.git = gitOf(world, 'feature/x', true)
    await start($)
    expect(gitRuns(world)).toBe(0)
    await poll(world, 60, 60)
    const ran = gitRuns(world)
    expect(ran).toBeGreaterThan(0)
    // The change is a minute old: only the branch is told.
    const first = 'the orchestrator directory is on branch feature/x, not the default main, with no worker alive: run audit_state'
    expect(noticeToasts(world)).toEqual([`Repository state \u00B7 ${first}`])
    expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: repo-state: ${first}`])
    await poll(world, 3540, 60)
    expect(gitRuns(world)).toBe(ran)
    expect(noticeToasts(world).length).toBe(1)
    await poll(world, 60, 60)
    expect(gitRuns(world)).toBe(2 * ran)
    expect(noticeToasts(world)[1]).toBe('Repository state \u00B7 the orchestrator directory is on branch feature/x, not the default main and has 1 tracked file uncommitted, the oldest change 1h01m old, with no worker alive: run audit_state')
  })

  test('on the default branch with changes under 30 minutes old: nothing told; with a worker alive git does not even run; without git: silent', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seed(world, { entries: [seedLiveWorker(world, SID_LIVE)] })
    seedTranscript(world, SID_LIVE)
    world.mtimes.set(SID_LIVE, NOW_SEC + 7200)
    world.git = gitOf(world, 'main', true)
    await start($)
    await poll(world, 600, 60)
    expect(gitRuns(world)).toBe(0)
    // The worker ends (its process gone): git runs at the next poll; the change is 11 minutes old, on main: nothing.
    world.table.procs.clear()
    world.files.set(REGISTRY, '[]\n')
    await poll(world, 60, 60)
    expect(gitRuns(world)).toBeGreaterThan(0)
    expect(noticeToasts(world)).toEqual([])
    world.git = undefined
    await poll(world, 7200, 60)
    expect(noticeToasts(world)).toEqual([])
  })
})

// ---------------------------------------------------------------- reload and the option

/** Every condition at once: an orphan, a stalled worker, a harvest that waited, an old open point, a retirable session. */
function seedAll(world: World): void {
  seed(world, {
    entries: [seedLiveWorker(world, SID_LIVE), { ...UNIT_ENTRY }, { title: 'free', session_id: SID_FREE, config_dir: `${HOME}/.claude`, reported: true, outcome: { kind: 'clean' } }],
    queue: [{ id: 'q-next', status: 'queued', title: 'Next', waits_for: SID_UNIT }],
    points: [{ id: 'op-old', status: 'open', raised: localDate(NOW_MS - 3 * 86_400_000), title: 'Old question' }],
  })
  world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
  seedOrphan(world)
  seedTranscript(world, SID_LIVE)
  world.mtimes.set(SID_LIVE, NOW_SEC - STALL_SEC - 60)
}

let leftByFirstLoad: unknown

describe('a reload of the mod', () => {
  test('first load: every notice is told once', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    seedAll(world)
    await start($)
    await poll(world, 60)
    const kinds = noticeToasts(world).map(text => KINDS[TITLES.findIndex(title => text.startsWith(`${title} \u00B7 `))])
    expect([...new Set(kinds)].sort()).toEqual(['compliance-due', 'open-point-age', 'orphan', 'queue-ready', 'retire-due', 'stall'])
    expect(kinds.length).toBe(6)
    leftByFirstLoad = store.get(KEY)
    expect(leftByFirstLoad).toBeDefined()
  })

  test('a fresh load with the store the first one left, two minutes later: nothing is told again', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on, { [KEY]: leftByFirstLoad })
    echoPrompt(on)
    seedAll(world)
    // The first load merged the harvest into the registry: the entry carries its outcome and no pid.
    const merged = JSON.parse(world.files.get(REGISTRY) ?? '[]') as Record<string, unknown>[]
    world.files.set(REGISTRY, JSON.stringify(merged.map(one => (one.session_id === SID_UNIT ? { ...one, pid: undefined, reported: false, outcome: { kind: 'clean' } } : one))))
    await world.clock.advance(120_000)
    await start($)
    await poll(world, 120)
    expect(noticeToasts(world)).toEqual([])
    expect(noticeLines(await userPrompt($))).toEqual([])
  })

  test('the same, with completionWrites off: the harvest repeats its completion toast, but no notice', { options: { ...OPTIONS, completionWrites: false } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on, { [KEY]: leftByFirstLoad })
    seedAll(world)
    await world.clock.advance(120_000)
    await start($)
    await poll(world, 60)
    expect(world.toasts.some(text => text.startsWith('Session finished \u00B7 unit worker'))).toBe(true)
    expect(noticeToasts(world)).toEqual([])
  })
})

describe('the notices option', () => {
  test('off: no notice of any kind (no toast, no line, no store, no git); the completion note and its toast stay', { options: { ...OPTIONS, notices: 'off' } }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    echoPrompt(on)
    seedAll(world)
    world.git = () => ({ exitCode: 0, stdout: 'true\n' })
    await start($)
    await poll(world, 120)
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-next', status: 'done' } as never)
    expect(noticeToasts(world)).toEqual([])
    expect(world.toasts.some(text => text.startsWith('Session finished \u00B7 unit worker'))).toBe(true)
    const sent = (await $.prompt.submit({ text: 'notification', wait: false, origin: { kind: 'task-notification' } } as never)) as { context?: readonly unknown[] }
    expect(sent.context?.length).toBe(1)
    expect(String(sent.context?.[0])).toStartWith('session-control completions: unit worker: clean: ')
    expect(noticeLines(sent)).toEqual([])
    expect(store.size).toBe(0)
    expect(world.runs.some(argv => argv[0] === 'git')).toBe(false)
  })

  test('on, the debug trace: one notice line per notice with its kind, ids and counts, never its text', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedAll(world)
    await start($)
    await poll(world, 60)
    const lines = (world.files.get(`${RUNS}/trace.log`) ?? '').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const notices = lines.filter(line => line.event === 'notice')
    expect(notices.map(line => line.kind).sort()).toEqual(['compliance-due', 'open-point-age', 'orphan', 'queue-ready', 'retire-due', 'stall'])
    expect(notices.find(line => line.kind === 'orphan')).toMatchObject({ pid: 5555, unclaimedSec: 30, isSessionRead: true })
    expect(notices.find(line => line.kind === 'compliance-due')).toMatchObject({ session_id: SID_UNIT })
    const text = JSON.stringify(notices)
    for (const secret of ['Unit X', 'Old question', '/w/other', 'live worker', 'unit worker']) expect(text).not.toContain(secret)
  })
})

// ---------------------------------------------------------------- Windows

const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\w\\home' }
const WIN_ORCH = 'C:/w/orch'
const WIN_REGISTRY = 'C:/w/home/.claude/headless-sessions.json'
const WIN_OPTIONS = { orchestratorDir: WIN_ORCH, registryPath: '~/.claude/headless-sessions.json', completionWrites: true, helper: 'off' }
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** A path as the plugin gave it: on a Linux host the kit takes C:/x for a relative path after the session's directory. */
const given = (path: string) => path.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')

type WinWorld = { files: Map<string, string>; toasts: string[]; probe: string[]; clock: World['clock'] }

/** The Windows machine: files by their C:/ path, the probe's lines as PROBE_PS1 prints them, the file script answering ok. */
function winWorld(on: On, probe: string[]): WinWorld {
  const w: WinWorld = { files: new Map(), toasts: [], probe, clock: mock.clock(on, { now: NOW_MS }) }
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
  on('fs.list', () => ({ value: [] as never }))
  on('process.run', ($, e) => {
    const ok = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv[0] === POWERSHELL && String(e.argv[6]).endsWith('/probe.ps1')) return { value: { ...ok, stdout: `${w.probe.join('\r\n')}\r\n` } }
    if (e.argv[0] === POWERSHELL) return { value: { ...ok, stdout: '' } }
    if (e.argv[0] === 'git') return { value: { ...ok, exitCode: 128, stdout: '' } }
    throw new Error(`unexpected command ${e.argv.join(' ')}`)
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }) as never)
  return w
}

const winNoticeToasts = (w: WinWorld) => w.toasts.filter(text => TITLES.some(title => text.startsWith(`${title} \u00B7 `)))

describe('Windows host', () => {
  test('orphan: told after 30 s with the Windows cwd and config dir; the orchestrator\'s own claude.exe never', { options: WIN_OPTIONS }, async ($, on) => {
    const tab = (...cols: (string | number)[]) => cols.join('\t')
    const w = winWorld(on, [
      tab('P', 5555, 'claude', 600, 'C:\\w\\other', 'C:\\w\\home\\.claude', '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus --output-format json'),
      tab('P', 3000, 'claude', 900, 'C:\\w\\orch', 'C:\\w\\home\\.claude', '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --output-format stream-json'),
    ])
    storeOf(on)
    ownSession(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, '[]\n')
    w.files.set('C:/w/home/.claude/sessions/5555.json', JSON.stringify({ pid: 5555, sessionId: OTHER_SID, startedAt: NOW_MS - 600_000 }))
    w.files.set('C:/w/home/.claude/sessions/3000.json', JSON.stringify({ pid: 3000, sessionId: OWN_SID, startedAt: NOW_MS - 900_000 }))
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    for (let step = 0; step < 5; step++) await w.clock.advance(5000)
    expect(winNoticeToasts(w)).toEqual([])
    await w.clock.advance(5000)
    expect(winNoticeToasts(w)).toEqual([
      `Unregistered session \u00B7 pid 5555 is a live headless claude no registry entry claims (cwd C:\\w\\other, config dir C:\\w\\home\\.claude, age 10m00s, unclaimed 30s, session ${OTHER_SID}); raise an open point naming it`,
    ])
    for (let step = 0; step < 12; step++) await w.clock.advance(5000)
    expect(winNoticeToasts(w).length).toBe(1)
  })

  test('stall: a live registered worker (the probe\'s A line proves it) with an old transcript', { options: WIN_OPTIONS }, async ($, on) => {
    const tab = (...cols: (string | number)[]) => cols.join('\t')
    const w = winWorld(on, [
      tab('P', 4101, 'claude', 1200, 'C:\\work\\a', 'C:/w/home/.claude', '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model haiku'),
      tab('A', 4101, 'claude', 1789998800000, 1789998800000, SID_LIVE),
      tab('T', SID_LIVE, NOW_SEC - STALL_SEC - 120),
    ])
    storeOf(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, JSON.stringify([{ title: 'win worker', pid: 4101, session_id: SID_LIVE, config_dir: 'C:/w/home/.claude', cwd: 'C:/work/a', model: 'haiku', effort: 'low' }]))
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    expect(winNoticeToasts(w)).toEqual([`Session stalled \u00B7 worker "win worker" (session ${SID_LIVE.slice(0, 8)}) is alive but its transcript has not been written for 17 min; look at it with worker_tail`])
    for (let step = 0; step < 6; step++) await w.clock.advance(5000)
    expect(winNoticeToasts(w).length).toBe(1)
  })
})

// ---------------------------------------------------------------- the pure functions

const facts = (lines: string[]): ProcFacts => parseProcFacts(lines.join('\n'))

describe('notices.ts', () => {
  test('a line is the prefix, the kind and the message, and no message holds a line break', () => {
    const state = freshNoticeState()
    const out: Notice[] = [
      ...harvestNotices(state, { session_id: SID_UNIT, name: 'w-a\nb-261011090000', pid: 1, section: 'Sec\ntion' }, { kind: 'clean', summary: '' }, JSON.stringify({ tasks: [{ id: 'q\n1', status: 'queued', waits_for: SID_UNIT }] })),
      ...pointStep(state, JSON.stringify({ points: [{ id: 'p', status: 'open', raised: '2020-01-01', title: 'Two\nlines\r\nhere' }] }), NOW_MS),
    ]
    expect(out.length).toBe(3)
    for (const one of out) {
      expect(noticeLine(one)).toStartWith(`session-control notice: ${one.kind}: `)
      expect(noticeLine(one)).not.toMatch(/[\r\n]/)
    }
  })

  test('the store key belongs to one orchestrator directory', () => {
    expect(noticeStoreKey('/w/orch')).toBe('notices:/w/orch')
    expect(noticeKeyDir('notices:/w/orch')).toBe('/w/orch')
    expect(noticeKeyDir('other')).toBeUndefined()
  })

  test('a damaged stored state starts fresh; a good one reads back whole', () => {
    expect(parseNoticeState('nonsense')).toEqual(freshNoticeState())
    expect(parseNoticeState({ orphans: { 1: { since: 'x' } }, stalls: { a: 'y' }, queueReady: [1, 'k'], points: { p: {} } })).toEqual({ ...freshNoticeState(), queueReady: ['k'] })
    const full = { orphans: { 7: { since: 1, isTold: true } }, stalls: { s: 2 }, queueReady: ['q s:1'], isUnitTold: true, compliance: ['s'], points: { p: { seen: 3, told: '2026-10-11' } }, retireAt: 4, retireCheckAt: 5, repoAt: 6 }
    expect(parseNoticeState(JSON.parse(JSON.stringify(full)))).toEqual(full as never)
  })

  test('orphanStep: remembered from first sight, due after the grace, forgotten when claimed', () => {
    const state = freshNoticeState()
    const seen = facts(['P\t9\tclaude\t5\t/x\t/c\tclaude -p --model opus'])
    expect(orphanStep(state, [], seen, 1000)).toEqual([])
    expect(orphanStep(state, [], seen, 1000 + ORPHAN_GRACE_SEC * 1000 - 1)).toEqual([])
    expect(orphanStep(state, [], seen, 1000 + ORPHAN_GRACE_SEC * 1000).map(one => one.pid)).toEqual([9])
    expect(orphanStep(state, [{ pid: 9, session_id: 's' }], seen, 99_999)).toEqual([])
    expect(state.orphans).toEqual({})
  })

  test('stallStep: needs the Abort check alive and a known transcript mtime', () => {
    const state = freshNoticeState()
    const entry = { title: 't', pid: 7, session_id: 's7', config_dir: '/c' }
    const alive = facts(['A\t7\tclaude\t100\t100\ts7', `T\ts7\t${NOW_SEC - STALL_SEC}`])
    const unproved = facts(['A\t7\tclaude\t100\t101\ts7', `T\ts7\t${NOW_SEC - STALL_SEC}`])
    expect(stallStep(state, [entry], unproved, NOW_MS)).toEqual([])
    expect(stallStep(state, [entry], facts(['A\t7\tclaude\t100\t100\ts7']), NOW_MS)).toEqual([])
    expect(stallStep(state, [entry], alive, NOW_MS).map(one => one.fields)).toEqual([{ session_id: 's7', minutes: 15 }])
    expect(stallStep(state, [entry], alive, NOW_MS + 600_000)).toEqual([])
  })

  test('harvestNotices: by full id, by its first 8 characters or by name; once per task and run; never a task not queued', () => {
    const state = freshNoticeState()
    const entry = { session_id: SID_UNIT, name: 'w-n-261011090000', pid: 5 }
    const queue = JSON.stringify({
      tasks: [
        { id: 'full', status: 'queued', waits_for: SID_UNIT },
        { id: 'id8', status: 'queued', waits_for: `x ${SID_UNIT.slice(0, 8)} y` },
        { id: 'name', status: 'queued', waits_for: 'after w-n-261011090000' },
        { id: 'running', status: 'running', waits_for: SID_UNIT },
        { id: 'other', status: 'queued', waits_for: 'licence' },
      ],
    })
    expect(harvestNotices(state, entry, { kind: 'error', summary: '' }, queue).map(one => one.fields.task)).toEqual(['full', 'id8', 'name'])
    expect(harvestNotices(state, entry, { kind: 'error', summary: '' }, queue)).toEqual([])
    // A resume finishes under a new pid: told again.
    expect(harvestNotices(state, { ...entry, pid: 6 }, { kind: 'error', summary: '' }, queue).length).toBe(3)
    pruneHarvested(state, [], JSON.stringify({ tasks: [{ id: 'full', status: 'queued' }] }))
    expect(state.queueReady).toEqual([`full ${SID_UNIT}:5`, `full ${SID_UNIT}:6`])
  })

  test('unitStep: told on a trigger only, once, re-armed by a task queued or running; an unreadable queue changes nothing', () => {
    const state = freshNoticeState()
    const empty = JSON.stringify({ tasks: [{ id: 'd', status: 'done' }] })
    expect(unitStep(state, empty, false)).toEqual([])
    expect(unitStep(state, empty, true).map(one => one.message)).toEqual(['queue empty: run audit_state and report'])
    expect(unitStep(state, empty, true)).toEqual([])
    expect(unitStep(state, '{ broken', true)).toEqual([])
    expect(state.isUnitTold).toBe(true)
    expect(unitStep(state, JSON.stringify({ tasks: [{ status: 'running' }] }), false)).toEqual([])
    expect(unitStep(state, empty, true).length).toBe(1)
  })

  test('pointStep: the earlier of the end of the raised day and the first sight counts; once per day', () => {
    const state = freshNoticeState()
    const text = JSON.stringify({ points: [{ id: 'p', status: 'open', title: 'Q', raised: localDate(NOW_MS) }] })
    expect(pointStep(state, text, NOW_MS)).toEqual([])
    expect(pointStep(state, text, NOW_MS + 86_400_000 - 1)).toEqual([])
    expect(pointStep(state, text, NOW_MS + 86_400_000).length).toBe(1)
    expect(pointStep(state, text, NOW_MS + 86_400_000 + 1000)).toEqual([])
    // No raised date: from the first sight alone.
    const bare = freshNoticeState()
    const noDate = JSON.stringify({ points: [{ id: 'p', status: 'open', title: 'Q' }] })
    expect(pointStep(bare, noDate, NOW_MS)).toEqual([])
    expect(pointStep(bare, noDate, NOW_MS + 86_400_000)[0]?.message).toBe('open point p (first seen 24h00m ago) is still open: Q')
  })

  test('isRetireDue and isRepoDue: once per hour; the retire findings at most once per minute; git never with a worker alive', () => {
    const state = freshNoticeState()
    expect(isRetireDue(state, NOW_MS)).toBe(true)
    expect(retireStep(state, { entries: [], facts: facts([]), nowMs: NOW_MS })).toEqual([])
    expect(isRetireDue(state, NOW_MS + 59_000)).toBe(false)
    expect(isRetireDue(state, NOW_MS + 60_000)).toBe(true)
    expect(isRepoDue(state, NOW_MS, 1)).toBe(false)
    expect(isRepoDue(state, NOW_MS, 0)).toBe(true)
    expect(repoStep(state, undefined, NOW_MS)).toEqual([])
    expect(isRepoDue(state, NOW_MS + 3_599_000, 0)).toBe(false)
    expect(isRepoDue(state, NOW_MS + 3_600_000, 0)).toBe(true)
  })

  test('repoStep: a detached HEAD, more than three ids listed as "and N more" in retire-due', () => {
    expect(repoStep(freshNoticeState(), { changed: [] }, NOW_MS)[0]?.message).toBe('the orchestrator directory has a detached HEAD, with no worker alive: run audit_state')
    const tasks = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, status: 'done' }))
    expect(retireStep(freshNoticeState(), { entries: [], facts: facts([]), nowMs: NOW_MS, queueText: JSON.stringify({ tasks }) })[0]?.message).toBe('5 queue tasks look stale (a, b, c and 2 more): run audit_state')
  })
})

// ---------------------------------------------------------------- a registry that cannot be read (decision mod-20)

const SID_SECOND = '66666666-aaaa-4bbb-8ccc-666666666666'

/** A second live registered worker, pid 4201, whose transcript is fresh (never stalled). */
function seedSecondWorker(world: World): Record<string, unknown> {
  const cfg = `${HOME}/.claude`
  world.table.procs.set(4201, { ppid: 4000, start: '6000', state: 'S', comm: 'claude', claude: { cwd: '/w/work2', configDir: cfg, cmdline: 'claude -p --model haiku --output-format json' } })
  world.files.set(`${cfg}/sessions/4201.json`, JSON.stringify({ sessionId: SID_SECOND, procStart: '6000' }))
  world.files.set(`${cfg}/projects/-w-work2/${SID_SECOND}.jsonl`, '{"type":"user"}\n')
  world.mtimes.set(SID_SECOND, NOW_SEC + 7 * 86_400)
  return { title: 'second worker', pid: 4201, session_id: SID_SECOND, config_dir: cfg, cwd: '/w/work2', model: 'haiku', effort: 'low', result_file: `${RUNS}/second.json` }
}

/** The ways a registry read fails, each set on the world and undone by `restore`. */
const FAILED_READS: readonly [string, (world: World) => void][] = [
  ['empty', world => world.files.set(REGISTRY, '')],
  ['missing', world => world.files.delete(REGISTRY)],
  ['unreadable', world => world.unreadable.add(REGISTRY)],
  ['whitespace-only', world => world.files.set(REGISTRY, '  \n\t\n')],
  ['unparsable', world => world.files.set(REGISTRY, '[{"title": "half')],
]

function restore(world: World, text: string): void {
  world.unreadable.delete(REGISTRY)
  world.files.set(REGISTRY, text)
}

const toastsOf = (world: World, kind: NoticeKind) => noticeToasts(world).filter(text => text.startsWith(`${TOAST_TITLES[kind]} · `))

describe('a registry that cannot be read', () => {
  test('flapping between readable and unreadable (empty, missing, unreadable, whitespace-only, unparsable) every other poll for 5 minutes: one stall notice, no orphan notice', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    echoPrompt(on)
    seed(world, { entries: [seedLiveWorker(world, SID_LIVE), seedSecondWorker(world)] })
    const good = world.files.get(REGISTRY) ?? ''
    seedTranscript(world, SID_LIVE)
    world.mtimes.set(SID_LIVE, NOW_SEC - STALL_SEC - 60)
    await start($)
    expect(toastsOf(world, 'stall').length).toBe(1)
    for (let at = 0; at < 60; at++) {
      const failed = FAILED_READS[Math.floor(at / 2) % FAILED_READS.length]
      if (at % 2 === 0) failed?.[1](world)
      else restore(world, good)
      await poll(world, 5)
      // The stall stays remembered through every failed read.
      expect(parseNoticeState(store.get(KEY)).stalls[SID_LIVE]).toBe(NOW_SEC - STALL_SEC - 60)
    }
    restore(world, good)
    await poll(world, 10)
    expect(toastsOf(world, 'stall').length).toBe(1)
    expect(toastsOf(world, 'orphan')).toEqual([])
    const lines = noticeLines(await userPrompt($))
    expect(lines.filter(line => line.startsWith(`${NOTICE_PREFIX} stall: `)).length).toBe(1)
    expect(lines.filter(line => line.startsWith(`${NOTICE_PREFIX} orphan: `))).toEqual([])
    // No timer was started for a registered worker on a failed read.
    expect(parseNoticeState(store.get(KEY)).orphans).toEqual({})
  })

  for (const [how, fail] of FAILED_READS) {
    test(`${how} for 40 s with a registered live worker: no orphan notice, nothing pruned, nothing told again once it reads back`, { options: OPTIONS }, async ($, on) => {
      const world = mockWorld(on)
      const store = storeOf(on)
      echoPrompt(on)
      seed(world, { entries: [seedLiveWorker(world, SID_LIVE), seedSecondWorker(world)] })
      const good = world.files.get(REGISTRY) ?? ''
      seedTranscript(world, SID_LIVE)
      world.mtimes.set(SID_LIVE, NOW_SEC - STALL_SEC - 60)
      await start($)
      const before = clone(store.get(KEY))
      fail(world)
      await poll(world, 40)
      expect(toastsOf(world, 'orphan')).toEqual([])
      expect(store.get(KEY)).toEqual(before)
      restore(world, good)
      await poll(world, 60)
      expect(toastsOf(world, 'orphan')).toEqual([])
      expect(toastsOf(world, 'stall').length).toBe(1)
    })
  }

  test('a registry that parses to [] is a sound, empty registry: a live unclaimed headless process is told as an orphan after 30 s', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    ownSession(on)
    echoPrompt(on)
    seed(world, { entries: [seedLiveWorker(world, SID_LIVE)] })
    await start($)
    await poll(world, 10)
    // The entry is gone from a registry that reads back as []: pid 4101 is an orphan from the next poll on (5 s later),
    // and told once it has been unclaimed for 30 s.
    world.files.set(REGISTRY, '[]')
    await poll(world, ORPHAN_GRACE_SEC)
    expect(toastsOf(world, 'orphan')).toEqual([])
    await poll(world, 5)
    expect(toastsOf(world, 'orphan').length).toBe(1)
    expect(toastsOf(world, 'orphan')[0]).toContain('pid 4101 is a live headless claude no registry entry claims')
    expect(noticeLines(await userPrompt($)).filter(line => line.startsWith(`${NOTICE_PREFIX} orphan: pid 4101 `)).length).toBe(1)
  })

  test('a failed read still looks at the queue and the points: unit-complete re-arms and an old open point is told', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seed(world, { points: [{ id: 'op-old', status: 'open', raised: localDate(NOW_MS - 3 * 86_400_000), title: 'Old question' }] })
    world.files.set(REGISTRY, '')
    await start($)
    expect(toastsOf(world, 'open-point-age').length).toBe(1)
  })
})

describe('notices.ts: the registry read', () => {
  test('isRegistrySound: read, not blank and a JSON array; [] is sound', () => {
    expect(isRegistrySound(undefined)).toBe(false)
    expect(isRegistrySound('')).toBe(false)
    expect(isRegistrySound(' \n\t')).toBe(false)
    expect(isRegistrySound('[{"title": "half')).toBe(false)
    expect(isRegistrySound('{"sessions": []}')).toBe(false)
    expect(isRegistrySound('null')).toBe(false)
    expect(isRegistrySound('[]')).toBe(true)
    expect(isRegistrySound('[]\n')).toBe(true)
    expect(isRegistrySound('[{"title": "one"}]')).toBe(true)
  })
})
