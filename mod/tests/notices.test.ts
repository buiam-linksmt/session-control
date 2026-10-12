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
  ORPHANS_SHOWN,
  ORPHAN_GRACE_SEC,
  ORPHAN_PIDS_LISTED,
  PENDING_NOTICES_MAX,
  STALL_SEC,
  TOASTS_PER_PASS,
  freshNoticeState,
  harvestNotices,
  isRegistrySound,
  isRepoDue,
  isRetireDue,
  moreLine,
  moreToastText,
  noticeKeyDir,
  noticeLine,
  noticeStoreKey,
  orphanGroupNotice,
  orphanStep,
  parseNoticeState,
  pendingWith,
  pointStep,
  RETIRE_EVERY_SEC,
  pruneFreeWaits,
  pruneHarvested,
  repoStep,
  retireStep,
  stallStep,
  unitStep,
  waitKey,
} from '../hooks/notices'
import type { Notice, NoticeKind } from '../hooks/notices'
import { localDate } from '../hooks/store'
import { nodeAnswer } from './fake-helper'
import { E2E_CWDS, NOW_MS, RESULTS } from './fixtures'
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
  test(`through the helper: told once, 30 s after it is first seen unclaimed, as a toast titled by its kind and one line on the next prompt`, { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
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

/** The pids of the orphan rows list_sessions lists, in its order. */
async function orphanRowPids($: { tool: { call: (e: never) => Promise<unknown> } }): Promise<number[]> {
  const answer = (await $.tool.call({ tool: 'mcp__session-control__list_sessions' } as never)) as { result?: unknown }
  return String(answer.result ?? '')
    .split('\n')
    .filter(line => line.startsWith('- orphan '))
    .map(line => Number(/\| pid (\d+) \|/.exec(line)?.[1]))
}

/** A live headless haiku claude in `cwd`, as an e2e script starts its orchestrator; no sessions file names it. */
function seedE2eProc(world: World, pid: number, cwd: string): void {
  const cmdline = 'claude -p --model haiku --max-budget-usd 0.25 --output-format stream-json --verbose'
  world.table.procs.set(pid, { ppid: 1, start: '42', state: 'S', comm: 'claude', claude: { cwd, configDir: `${HOME}/.claude`, cmdline, elapsedSec: 600 } })
}

describe('orphan: the e2e scripts\' own runs', () => {
  const { linux } = E2E_CWDS
  const exempt = linux.exempt.map((cwd, i) => [7100 + i, cwd] as const)
  const kept = linux.kept.map((cwd, i) => [7200 + i, cwd] as const)

  test('Linux: a live headless claude in /tmp/session-control-e2e<suffix>/orch or /work is no orphan row and no notice; each other form stays an orphan, told and listed', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    ownSession(on)
    echoPrompt(on)
    seed(world)
    for (const [pid, cwd] of [...exempt, ...kept]) seedE2eProc(world, pid, cwd)
    await start($)
    await poll(world, 90)
    const orphans = parseNoticeState(store.get(KEY)).orphans
    expect(Object.keys(orphans).sort()).toEqual(kept.map(([pid]) => String(pid)).sort())
    expect(Object.values(orphans).every(one => one.isTold === true)).toBe(true)
    expect((await orphanRowPids($)).sort()).toEqual(kept.map(([pid]) => pid).sort())
    const lines = noticeLines(await userPrompt($)).join('\n')
    for (const [pid] of exempt) expect(lines).not.toContain(`${pid}`)
    expect(world.toasts.join('\n')).not.toContain('pid 71')
    expect(toastsOf(world, 'orphan').length).toBeGreaterThan(0)
  })

  test('Linux with TMPDIR: its own scratch directories are exempt as well as /tmp\'s; one level deeper or elsewhere stays an orphan', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on, { env: { TMPDIR: '/var/tmp/' } })
    const store = storeOf(on)
    ownSession(on)
    seed(world)
    const free = [...linux.tmpdir, linux.exempt[0]].map((cwd, i) => [7300 + i, cwd] as const)
    const still = ['/var/tmp/x/session-control-e2e.a/orch', '/home/u/session-control-e2e-tools.Ab12Cd/orch', '/var/tmp/session-control-e2e.a/orch2'].map((cwd, i) => [7400 + i, cwd] as const)
    for (const [pid, cwd] of [...free, ...still]) seedE2eProc(world, pid, cwd)
    await start($)
    await poll(world, 60)
    expect(Object.keys(parseNoticeState(store.get(KEY)).orphans).sort()).toEqual(still.map(([pid]) => String(pid)))
    expect(toastsOf(world, 'orphan').length).toBe(still.length)
    expect((await orphanRowPids($)).sort()).toEqual(still.map(([pid]) => pid))
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

describe('toast order on a surface other than the terminal (decision mod-28)', () => {
  const COMPLETION = 'Session finished \u00B7 unit worker: clean: Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.'
  const READY = [
    'Queued task ready \u00B7 queued task q-next waited for w-unit-worker-261011090000, which finished',
    'Queued task ready \u00B7 queued task q-id8 waited for w-unit-worker-261011090000, which finished',
  ]
  const DUE = 'Compliance check due \u00B7 compliance check due for section Unit X (user, 2026-10-11) (session w-unit-worker-261011090000)'
  // The hourly reminder of the poll's first tick (its tasks wait on a session that finished): raised during the hold, held after the others.
  const HOUSEKEEPING = 'Housekeeping due \u00B7 2 queue tasks look stale (q-next, q-id8): run audit_state'
  const QUEUE = [
    { id: 'q-next', status: 'queued', title: 'Next step', waits_for: 'w-unit-worker-261011090000 to finish' },
    { id: 'q-id8', status: 'queued', title: 'By id', waits_for: `session ${SID_UNIT.slice(0, 8)}` },
  ]
  /** The surfaces the session draws on, as $.session.surfaces answers them. */
  const drawsOn = (on: On, surfaces: readonly string[]) => on('session.surfaces', () => ({ value: surfaces }) as never)

  test('on the desktop the completion toast shows alone for its 8 s, then the harvest\'s notice toasts follow it in order; the prompt lines are not held', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    drawsOn(on, ['desktop'])
    seed(world, { entries: [UNIT_ENTRY], queue: QUEUE })
    world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
    await start($)
    expect(world.toasts).toEqual([COMPLETION])
    const sent = (await $.prompt.submit({ text: 'notification', wait: false, origin: { kind: 'task-notification' } } as never)) as { context?: readonly unknown[] }
    expect(noticeLines(sent).length).toBe(3)
    await world.clock.advance(7999)
    expect(world.toasts).toEqual([COMPLETION])
    await world.clock.advance(1)
    // Then one toast each time the one before has shown for its 8 s, in order.
    expect(world.toasts).toEqual([COMPLETION, READY[0]])
    await world.clock.advance(8000)
    expect(world.toasts).toEqual([COMPLETION, ...READY])
    await world.clock.advance(8000)
    expect(world.toasts).toEqual([COMPLETION, ...READY, DUE])
    await world.clock.advance(8000)
    expect(world.toasts).toEqual([COMPLETION, ...READY, DUE, HOUSEKEEPING])
    await world.clock.advance(8000)
    // Nothing waits any more: a later notice toast goes out at once.
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-next', status: 'done' } as never)
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-id8', status: 'done' } as never)
    expect(world.toasts.at(-1)).toBe('Queue empty \u00B7 queue empty: run audit_state and report')
  })

  test('on the desktop a second completion waits for the first, and holds the toasts after it in turn', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    drawsOn(on, ['terminal', 'desktop'])
    const second = { ...UNIT_ENTRY, title: 'second worker', pid: 4301, session_id: SID_FREE, name: 'w-second-worker-261011090000', section: undefined, result_file: `${RUNS}/second.json` }
    seed(world, { entries: [UNIT_ENTRY, second], queue: QUEUE })
    world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
    world.files.set(`${RUNS}/second.json`, RESULTS.clean)
    await start($)
    const secondToast = COMPLETION.replace('unit worker', 'second worker')
    expect(world.toasts).toEqual([COMPLETION])
    // The notice toasts of the first harvest, one each 8 s, then the second completion, which holds the next in turn.
    for (const [at, shown] of [[8000, 2], [16000, 3], [24000, 4], [32000, 5]] as const) {
      await world.clock.set(NOW_MS + at)
      expect(world.toasts).toEqual([COMPLETION, ...READY, DUE, secondToast].slice(0, shown))
    }
    await world.clock.advance(7999)
    expect(world.toasts.length).toBe(5)
    await world.clock.advance(1)
    expect(world.toasts).toEqual([COMPLETION, ...READY, DUE, secondToast, HOUSEKEEPING])
  })

  /** Three open points two days old: three open-point-age notices of one pass, the poll's cap. */
  const threePoints = (world: World) => {
    const raised = localDate(NOW_MS - 2 * 86_400_000)
    const ids = ['op-a', 'op-b', 'op-c']
    seed(world, { points: ids.map(id => ({ id, status: 'open', raised, title: `Point ${id}` })) })
    return ids.map(id => `Open point waiting \u00B7 open point ${id} (raised ${raised}) is still open: Point ${id}`)
  }

  test('on the desktop three notice toasts raised together come out one after another, each once the one before has shown for 8 s', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    drawsOn(on, ['desktop'])
    const waiting = threePoints(world)
    await start($)
    expect(world.toasts).toEqual(waiting.slice(0, 1))
    // The model has every line at once: only the toasts wait.
    expect(noticeLines(await userPrompt($)).length).toBe(3)
    await world.clock.advance(7999)
    expect(world.toasts).toEqual(waiting.slice(0, 1))
    await world.clock.advance(1)
    expect(world.toasts).toEqual(waiting.slice(0, 2))
    await world.clock.advance(7999)
    expect(world.toasts).toEqual(waiting.slice(0, 2))
    await world.clock.advance(1)
    expect(world.toasts).toEqual(waiting)
    await world.clock.advance(8000)
    expect(world.toasts).toEqual(waiting)
  })

  test('on the terminal the same three notice toasts go out together, at once, as before', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    drawsOn(on, ['terminal'])
    const waiting = threePoints(world)
    await start($)
    expect(world.toasts).toEqual(waiting)
  })

  test('on the desktop at most 5 toasts wait: past that the newest waiting notice toast is folded into one summary toast after them, with the notices past their per-source cap; a completion toast keeps its place', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    drawsOn(on, ['desktop'])
    const more = (id: string) => ({ id, status: 'queued', title: `More ${id}`, waits_for: 'w-unit-worker-261011090000 to finish' })
    const second = { ...UNIT_ENTRY, title: 'second worker', pid: 4301, session_id: SID_FREE, name: 'w-second-worker-261011090000', section: undefined, result_file: `${RUNS}/second.json` }
    const third = { ...UNIT_ENTRY, title: 'third worker', pid: 4302, session_id: SID_KEPT, name: 'w-third-worker-261011090000', section: undefined, result_file: `${RUNS}/third.json` }
    const live = seedLiveWorker(world, SID_LIVE)
    seed(world, { entries: [UNIT_ENTRY, second, third, live], queue: [...QUEUE, more('q-third'), more('q-fourth')] })
    for (const file of ['unit', 'second', 'third', 'live']) world.files.set(`${RUNS}/${file}.json`, RESULTS.clean)
    await start($)
    const finished = (who: string) => COMPLETION.replace('unit worker', who)
    const thirdReady = 'Queued task ready \u00B7 queued task q-third waited for w-unit-worker-261011090000, which finished'
    // The first harvest: its completion shows; three of its five notices (the source's cap) wait with the next two
    // completions, the other two go to the summary.
    expect(world.toasts).toEqual([COMPLETION])
    // The live worker ends before the poll's first tick: its completion comes to a full queue and takes the place of the
    // newest waiting notice toast (q-third's), and the tick's hourly reminder after it is folded too.
    for (const pid of [4103, 4102, 4101]) world.table.procs.delete(pid)
    await world.clock.advance(5000)
    expect(world.toasts).toEqual([COMPLETION])
    const order = [COMPLETION, ...READY, finished('second worker'), finished('third worker'), finished('live worker'), 'More notices \u00B7 4 more notices: see the next prompt']
    for (let shown = 2; shown <= order.length; shown++) {
      await world.clock.set(NOW_MS + (shown - 1) * 8000 - 1)
      expect(world.toasts).toEqual(order.slice(0, shown - 1))
      await world.clock.advance(1)
      expect(world.toasts).toEqual(order.slice(0, shown))
    }
    await world.clock.advance(60_000)
    expect(world.toasts).toEqual(order)
    expect(world.toasts).not.toContain(thirdReady)
    // The folded notices still reach the model: every line rides on the next prompt.
    const lines = noticeLines(await userPrompt($))
    expect(lines).toContain('session-control notice: queue-ready: queued task q-third waited for w-unit-worker-261011090000, which finished')
    expect(lines).toContain('session-control notice: queue-ready: queued task q-fourth waited for w-unit-worker-261011090000, which finished')
    expect(lines.some(line => line.startsWith('session-control notice: retire-due: '))).toBe(true)
  })

  test('on the terminal alone nothing is held: the completion and the notice toasts of a pass go out together, as before', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    drawsOn(on, ['terminal'])
    seed(world, { entries: [UNIT_ENTRY], queue: QUEUE })
    world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
    await start($)
    expect(world.toasts).toEqual([COMPLETION, ...READY, DUE])
  })
})

describe('toasts while no surface is attached (decision mod-28)', () => {
  const COMPLETION = 'Session finished \u00B7 unit worker: clean: Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.'
  const READY = [
    'Queued task ready \u00B7 queued task q-next waited for w-unit-worker-261011090000, which finished',
    'Queued task ready \u00B7 queued task q-id8 waited for w-unit-worker-261011090000, which finished',
  ]
  const DUE = 'Compliance check due \u00B7 compliance check due for section Unit X (user, 2026-10-11) (session w-unit-worker-261011090000)'
  // The hourly reminder of the poll's first tick (5 s after the start).
  const HOUSEKEEPING = 'Housekeeping due \u00B7 2 queue tasks look stale (q-next, q-id8): run audit_state'
  const QUEUE = [
    { id: 'q-next', status: 'queued', title: 'Next step', waits_for: 'w-unit-worker-261011090000 to finish' },
    { id: 'q-id8', status: 'queued', title: 'By id', waits_for: `session ${SID_UNIT.slice(0, 8)}` },
  ]
  /** The surfaces the session draws on, as $.session.surfaces answers them now: none at first. */
  const roster = (on: On) => {
    const surfaces = { list: [] as readonly string[] }
    on('session.surfaces', () => ({ value: surfaces.list }) as never)
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    return surfaces
  }
  /** The harvest of a finished unit worker with two queued tasks waiting for it, started with no surface attached. */
  const unattachedStart = async ($: Parameters<typeof start>[0], on: On) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    const surfaces = roster(on)
    seed(world, { entries: [UNIT_ENTRY], queue: QUEUE })
    world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
    await start($)
    return { world, surfaces }
  }

  test('raised before a surface attaches, the toasts wait; the desktop attached 30 s later gets them through the queue, one each 8 s; the note and the lines reach the model at once', { options: OPTIONS }, async ($, on) => {
    const { world, surfaces } = await unattachedStart($, on)
    expect(world.toasts).toEqual([])
    const sent = await userPrompt($)
    expect(String(sent.context?.[0])).toStartWith('session-control completions: unit worker: clean: ')
    expect(noticeLines(sent).length).toBe(3)
    await world.clock.advance(30_000)
    expect(world.toasts).toEqual([])
    // The poll at 35 s reads the desktop attached: the kept toasts go out in the order they were raised.
    surfaces.list = ['desktop']
    await world.clock.advance(5000)
    expect(world.toasts).toEqual([COMPLETION])
    for (const [shown, toast] of [READY[0], READY[1], DUE, HOUSEKEEPING].entries()) {
      await world.clock.advance(7999)
      expect(world.toasts.length).toBe(shown + 1)
      await world.clock.advance(1)
      expect(world.toasts.at(-1)).toBe(toast)
    }
    expect(world.toasts).toEqual([COMPLETION, ...READY, DUE, HOUSEKEEPING])
  })

  test('a client that attaches gets the kept toasts at once, without waiting for the poll', { options: OPTIONS }, async ($, on) => {
    const { world, surfaces } = await unattachedStart($, on)
    await world.clock.advance(2000)
    surfaces.list = ['desktop']
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
    expect(world.toasts).toEqual([COMPLETION])
    await world.clock.advance(8000)
    expect(world.toasts).toEqual([COMPLETION, READY[0]])
  })

  test('a toast kept 60 s with no surface attached is dropped; the note and the lines stay for the model, and a toast raised later still goes out', { options: OPTIONS }, async ($, on) => {
    const { world, surfaces } = await unattachedStart($, on)
    // 65 s: the start's four toasts are past their 60 s; the reminder of the 5 s tick is 60 s old, still kept.
    await world.clock.advance(65_000)
    surfaces.list = ['desktop']
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
    expect(world.toasts).toEqual([HOUSEKEEPING])
    const sent = await userPrompt($)
    expect(String(sent.context?.[0])).toStartWith('session-control completions: unit worker: clean: ')
    expect(noticeLines(sent).length).toBe(4)
    await world.clock.advance(60_000)
    expect(world.toasts).toEqual([HOUSEKEEPING])
    // Attached now: a notice raised later goes out at once.
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-next', status: 'done' } as never)
    await $.tool.call({ tool: QUEUE_TOOL, action: 'update', id: 'q-id8', status: 'done' } as never)
    expect(world.toasts).toEqual([HOUSEKEEPING, 'Queue empty \u00B7 queue empty: run audit_state and report'])
  })

  test('the terminal is attached from the start: nothing is kept, the toasts of a pass go out together as before', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    on('session.surfaces', () => ({ value: ['terminal'] }) as never)
    seed(world, { entries: [UNIT_ENTRY], queue: QUEUE })
    world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
    await start($)
    expect(world.toasts).toEqual([COMPLETION, ...READY, DUE])
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

describe('retire-due: queued tasks whose wait audit_state cannot check', () => {
  const queue = [
    { id: 'q-groups', status: 'queued', title: 'After the groups', waits_for: 'mod step 3 groups T2a to T3b and the licence tools' },
    { id: 'q-steps', status: 'queued', title: 'After the steps', waits_for: 'mod steps 1 to 4 complete' },
    { id: 'q-licence', status: 'queued', title: 'Waits on licence', waits_for: 'licence headroom 40%' },
    { id: 'q-plain', status: 'queued', title: 'Ready' },
  ]
  const entries = [{ title: 'kept', session_id: SID_KEPT, config_dir: `${HOME}/.claude`, reported: true, keep: true, outcome: { kind: 'clean' }, ended_at: NOW_SEC - 600 }]
  const text = '2 queue tasks look stale (q-groups, q-steps): run audit_state'

  test('retireStep counts the free-text waits as stale queue tasks and names their ids; a licence wait and no wait are not counted', () => {
    const state = freshNoticeState()
    const told = retireStep(state, { entries, facts: facts([]), nowMs: NOW_MS, queueText: JSON.stringify({ tasks: queue }) })
    expect(told).toEqual([{ kind: 'retire-due', message: text, fields: { retirable: 0, keptOld: 0, staleTasks: 2 } }])
    expect(state.retireAt).toBe(NOW_MS)
    expect(retireStep(freshNoticeState(), { entries, facts: facts([]), nowMs: NOW_MS, queueText: JSON.stringify({ tasks: queue.slice(2) }) })).toEqual([])
    // With a done task as well: one group, the ids in audit_state's order.
    const mixed = retireStep(freshNoticeState(), { entries, facts: facts([]), nowMs: NOW_MS, queueText: JSON.stringify({ tasks: [...queue, { id: 'q-done', status: 'done', title: 'Done' }] }) })
    expect(mixed[0]?.message).toBe('3 queue tasks look stale (q-done, q-groups, q-steps): run audit_state')
  })

  let leftByFirstLoad: unknown

  test('from the poll, at most once per hour, naming the task ids', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    echoPrompt(on)
    seed(world, { entries, queue })
    await start($)
    expect(noticeToasts(world)).toEqual([])
    await poll(world, 60, 60)
    expect(noticeToasts(world)).toEqual([`Housekeeping due \u00B7 ${text}`])
    expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: retire-due: ${text}`])
    leftByFirstLoad = store.get(KEY)
    await poll(world, 3540, 60)
    expect(noticeToasts(world).length).toBe(1)
    // The same waits an hour on are not told again (retire-due: each free-text wait told once).
    await poll(world, 60, 60)
    expect(noticeToasts(world)).toEqual([`Housekeeping due \u00B7 ${text}`])
  })

  test('a fresh load with the store the first one left, two minutes later: nothing is told again', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    expect(leftByFirstLoad).toBeDefined()
    const world = mockWorld(on)
    storeOf(on, { [KEY]: leftByFirstLoad })
    echoPrompt(on)
    seed(world, { entries, queue })
    await world.clock.advance(120_000)
    await start($)
    await poll(world, 600, 60)
    expect(noticeToasts(world)).toEqual([])
    expect(noticeLines(await userPrompt($))).toEqual([])
  })
})

describe('retire-due: each free-text wait told once', () => {
  const HOUR_MS = RETIRE_EVERY_SEC * 1000
  const QUEUE_FILE = `${ORCH}/task-queue.json`
  // A finished session no finding names however long the clock runs, so only the queue is told.
  const kept = { title: 'limited', session_id: SID_FREE, config_dir: `${HOME}/.claude`, reported: true, outcome: { kind: 'limit' } }
  const groups = { id: 'q-groups', status: 'queued', title: 'After the groups', waits_for: 'mod step 3 groups T2a to T3b and the licence tools' }
  const steps = { id: 'q-steps', status: 'queued', title: 'After the steps', waits_for: 'mod steps 1 to 4 complete' }
  const queueOf = (tasks: Record<string, unknown>[]) => JSON.stringify({ tasks })
  const stepAt = (state: ReturnType<typeof freshNoticeState>, tasks: Record<string, unknown>[], nowMs: number) => retireStep(state, { entries: [kept], facts: facts([]), nowMs, queueText: queueOf(tasks) })
  const stale = (ids: string[]) => `${ids.length} queue ${ids.length === 1 ? 'task looks' : 'tasks look'} stale (${ids.join(', ')}): run audit_state`
  const toast = (ids: string[]) => `Housekeeping due · ${stale(ids)}`
  const setQueue = (world: World, tasks: Record<string, unknown>[]) => world.files.set(QUEUE_FILE, queueOf(tasks))

  test('retireStep: told once for an unchanged wait, again for a changed text, a task added later alone, a removed and re-added task again', () => {
    const state = freshNoticeState()
    expect(stepAt(state, [groups, steps], NOW_MS).map(one => one.message)).toEqual([stale(['q-groups', 'q-steps'])])
    expect(state.freeWaits).toEqual([waitKey('q-groups', groups.waits_for), waitKey('q-steps', steps.waits_for)])
    for (let hour = 1; hour <= 6; hour++) expect(stepAt(state, [groups, steps], NOW_MS + hour * HOUR_MS)).toEqual([])
    // Blanks around the same text are the same wait.
    expect(stepAt(state, [{ ...groups, waits_for: ` ${groups.waits_for}\n` }, steps], NOW_MS + 7 * HOUR_MS)).toEqual([])
    const changed = { ...steps, waits_for: 'mod steps 1 to 5 complete' }
    expect(stepAt(state, [groups, changed], NOW_MS + 8 * HOUR_MS).map(one => one.message)).toEqual([stale(['q-steps'])])
    const later = { id: 'q-later', status: 'queued', title: 'Added later', waits_for: 'the customer answer' }
    expect(stepAt(state, [groups, changed, later], NOW_MS + 9 * HOUR_MS).map(one => one.message)).toEqual([stale(['q-later'])])
    expect(stepAt(state, [changed, later], NOW_MS + 10 * HOUR_MS)).toEqual([])
    expect(state.freeWaits).toEqual([waitKey('q-steps', changed.waits_for), waitKey('q-later', later.waits_for)])
    expect(stepAt(state, [changed, later, groups], NOW_MS + 11 * HOUR_MS).map(one => one.message)).toEqual([stale(['q-groups'])])
    expect(stepAt(state, [], NOW_MS + 12 * HOUR_MS)).toEqual([])
    expect(state.freeWaits).toBeUndefined()
  })

  test('pruneFreeWaits forgets a task no longer queued with that wait, keeps them all when the queue cannot be read', () => {
    const state = freshNoticeState()
    state.freeWaits = [waitKey('q-groups', groups.waits_for), waitKey('q-steps', steps.waits_for)]
    pruneFreeWaits(state, undefined)
    pruneFreeWaits(state, '{not json')
    expect(state.freeWaits).toEqual([waitKey('q-groups', groups.waits_for), waitKey('q-steps', steps.waits_for)])
    pruneFreeWaits(state, queueOf([groups, { ...steps, status: 'done' }]))
    expect(state.freeWaits).toEqual([waitKey('q-groups', groups.waits_for)])
    pruneFreeWaits(state, queueOf([{ ...groups, waits_for: 'another wait' }]))
    expect(state.freeWaits).toBeUndefined()
    expect(parseNoticeState({ freeWaits: [waitKey('q-a', 'x'), 3] }).freeWaits).toEqual([waitKey('q-a', 'x')])
    expect('freeWaits' in parseNoticeState({ freeWaits: [] })).toBe(false)
    expect(waitKey('q-a', '  x\t')).toBe(waitKey('q-a', 'x'))
    expect(waitKey('q-a', 'x')).toMatch(/^q-a [0-9a-f]{8}$/)
  })

  test('the stored state holds the task ids and hashes only, never the wait text', () => {
    const canary = ['wait', Date.now().toString(36), 'marker'].join('-')
    const state = freshNoticeState()
    expect(stepAt(state, [{ ...groups, waits_for: `the ${canary} release` }], NOW_MS)).toHaveLength(1)
    const stored = JSON.stringify(state)
    expect(stored).not.toContain(canary)
    expect(stored).not.toContain('release')
    expect(state.freeWaits?.every(key => /^q-groups [0-9a-f]{8}$/.test(key))).toBe(true)
  })

  let leftByLoad: unknown

  test('through the poll: told once over 6 hours, again after its text changes, a task added later alone, a removed and re-added task again; no free text in the store', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    const canary = ['wait', Date.now().toString(36), 'marker'].join('-')
    const own = { ...steps, waits_for: `the ${canary} release` }
    const world = mockWorld(on)
    const store = storeOf(on)
    echoPrompt(on)
    seed(world, { entries: [kept], queue: [groups, own] })
    await start($)
    await poll(world, 60, 60)
    expect(noticeToasts(world)).toEqual([toast(['q-groups', 'q-steps'])])
    expect(noticeLines(await userPrompt($))).toEqual([`session-control notice: retire-due: ${stale(['q-groups', 'q-steps'])}`])
    await poll(world, 6 * 3600, 60)
    expect(noticeToasts(world)).toEqual([toast(['q-groups', 'q-steps'])])
    expect(noticeLines(await userPrompt($))).toEqual([])
    expect(JSON.stringify(store.get(KEY))).not.toContain(canary)
    setQueue(world, [groups, { ...own, waits_for: `the ${canary} release, then the merge` }])
    await poll(world, 120, 60)
    expect(noticeToasts(world)).toEqual([toast(['q-groups', 'q-steps']), toast(['q-steps'])])
    const later = { id: 'q-later', status: 'queued', title: 'Added later', waits_for: 'the customer answer' }
    setQueue(world, [groups, { ...own, waits_for: `the ${canary} release, then the merge` }, later])
    await poll(world, 3600, 60)
    expect(noticeToasts(world).slice(2)).toEqual([toast(['q-later'])])
    setQueue(world, [{ ...own, waits_for: `the ${canary} release, then the merge` }, later])
    await poll(world, 120, 60)
    setQueue(world, [{ ...own, waits_for: `the ${canary} release, then the merge` }, later, groups])
    await poll(world, 3600, 60)
    expect(noticeToasts(world).slice(3)).toEqual([toast(['q-groups'])])
    await poll(world, 3 * 3600, 60)
    expect(noticeToasts(world).length).toBe(4)
    const left = store.get(KEY) as { freeWaits?: string[] }
    expect(JSON.stringify(left)).not.toContain(canary)
    expect(JSON.stringify(left)).not.toContain('customer')
    expect(left.freeWaits?.length).toBe(3)
    leftByLoad = left
  })

  test('a fresh load with the store the last one left, two hours later: nothing is told again', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    expect(leftByLoad).toBeDefined()
    const world = mockWorld(on)
    storeOf(on, { [KEY]: leftByLoad })
    echoPrompt(on)
    // The first load told these three; the queue keeps two of them as they were.
    expect((leftByLoad as { freeWaits: string[] }).freeWaits.map(key => key.split(' ')[0])).toEqual(['q-steps', 'q-later', 'q-groups'])
    seed(world, { entries: [kept], queue: [groups, { id: 'q-later', status: 'queued', title: 'Added later', waits_for: 'the customer answer' }] })
    await world.clock.advance(2 * HOUR_MS)
    await start($)
    await poll(world, 2 * 3600, 60)
    expect(noticeToasts(world)).toEqual([])
    expect(noticeLines(await userPrompt($))).toEqual([])
  })

  test('the notices option off: never told, nothing stored', { options: { ...OPTIONS, pollSeconds: 60, notices: 'off' } }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    echoPrompt(on)
    seed(world, { entries: [kept], queue: [groups, steps] })
    await start($)
    await poll(world, 2 * 3600, 60)
    expect(noticeToasts(world)).toEqual([])
    expect(noticeLines(await userPrompt($))).toEqual([])
    expect(store.has(KEY)).toBe(false)
  })

  test('the other stale kinds keep their hourly notice, wording and ids beside a told free-text wait', { options: { ...OPTIONS, pollSeconds: 60 } }, async ($, on) => {
    const entries = [
      { title: 'free', session_id: SID_FREE, config_dir: `${HOME}/.claude`, reported: true, outcome: { kind: 'clean' } },
      { title: 'kept', session_id: SID_KEPT, config_dir: `${HOME}/.claude`, reported: true, keep: true, outcome: { kind: 'clean' }, ended_at: NOW_SEC - 7 * 3600 },
    ]
    const queue = [
      { id: 'q-done', status: 'done', title: 'Done' },
      { id: 'q-blocked', status: 'blocked', title: 'Odd status' },
      { id: 'q-run', status: 'running', title: 'Running, no session' },
    ]
    const head = `1 finished session can be retired (${SID_FREE.slice(0, 8)}); 1 kept session idle over 6 hours (${SID_KEPT.slice(0, 8)})`
    const text = `${head}; 3 queue tasks look stale (q-blocked, q-run, q-done): run audit_state`
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, { entries, queue: [...queue, groups] })
    await start($)
    expect(noticeToasts(world)).toEqual([])
    await poll(world, 60, 60)
    expect(noticeToasts(world)).toEqual([`Housekeeping due · ${head}; 4 queue tasks look stale (q-blocked, q-run, q-done and 1 more): run audit_state`])
    await poll(world, 3540, 60)
    expect(noticeToasts(world).length).toBe(1)
    await poll(world, 60, 60)
    expect(noticeToasts(world).length).toBe(2)
    expect(noticeToasts(world)[1]).toBe(`Housekeeping due · ${text}`)
    expect(noticeLines(await userPrompt($))).toEqual([
      `session-control notice: retire-due: ${head}; 4 queue tasks look stale (q-blocked, q-run, q-done and 1 more): run audit_state`,
      `session-control notice: retire-due: ${text}`,
    ])
    await poll(world, 3540, 60)
    expect(noticeToasts(world).length).toBe(2)
    await poll(world, 60, 60)
    expect(noticeToasts(world)).toEqual([
      `Housekeeping due · ${head}; 4 queue tasks look stale (q-blocked, q-run, q-done and 1 more): run audit_state`,
      `Housekeeping due · ${text}`,
      `Housekeeping due · ${text}`,
    ])
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
    // Node and its helper's file operations over the map (the probe on Windows is PROBE_PS1's).
    const node = nodeAnswer(e.argv, e.init?.stdin, w.files, given)
    if (node !== undefined) return { value: node }
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

  test('orphan: a live headless claude.exe in <...>\\Temp\\session-control-e2e<suffix>\\orch or \\work is no orphan row and no notice; each other form stays an orphan', { options: WIN_OPTIONS }, async ($, on) => {
    const tab = (...cols: (string | number)[]) => cols.join('\t')
    const cmd = '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model haiku --max-budget-usd 0.25 --output-format stream-json --verbose'
    const { windows } = E2E_CWDS
    const exempt = windows.exempt.map((cwd, i) => [7100 + i, cwd] as const)
    const kept = windows.kept.map((cwd, i) => [7200 + i, cwd] as const)
    const w = winWorld(on, [...exempt, ...kept].map(([pid, cwd]) => tab('P', pid, 'claude', 600, cwd, 'C:\\w\\home\\.claude', cmd)))
    const store = storeOf(on)
    ownSession(on)
    w.files.set(`${WIN_ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
    w.files.set(WIN_REGISTRY, '[]\n')
    await $.session.start({ cwd: 'C:\\w\\orch', surface: null, isInteractive: true } as never)
    for (let step = 0; step < 18; step++) await w.clock.advance(5000)
    // The one notice state of the load, under the key of its Windows orchestrator directory.
    const keys = [...store.keys()].filter(key => key.startsWith('notices:'))
    expect(keys.length).toBe(1)
    const orphans = parseNoticeState(store.get(keys[0]!)).orphans
    expect(Object.keys(orphans).sort()).toEqual(kept.map(([pid]) => String(pid)).sort())
    expect(Object.values(orphans).every(one => one.isTold === true)).toBe(true)
    expect(w.toasts.join('\n')).not.toContain('pid 71')
    expect(winNoticeToasts(w).length).toBeGreaterThan(0)
    expect((await orphanRowPids($)).sort()).toEqual(kept.map(([pid]) => pid).sort())
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

  test('orphanStep: an e2e run directory under the temporary directory is never remembered or due, on Linux and Windows; the other forms are', () => {
    const line = (pid: number, cwd: string) => ['P', pid, 'claude', 1, cwd, '/c', 'claude -p --model haiku'].join('\t')
    for (const [cases, temp] of [[E2E_CWDS.linux, { isWindows: false, dirs: ['/tmp'] }], [E2E_CWDS.windows, { isWindows: true, dirs: [] }]] as const) {
      const state = freshNoticeState()
      const seen = { ...facts([...cases.exempt.map((cwd, i) => line(100 + i, cwd)), ...cases.kept.map((cwd, i) => line(200 + i, cwd))]), temp }
      expect(orphanStep(state, [], seen, 1000)).toEqual([])
      expect(orphanStep(state, [], seen, 1000 + ORPHAN_GRACE_SEC * 1000).map(one => one.pid)).toEqual(cases.kept.map((_, i) => 200 + i))
      expect(Object.keys(state.orphans).sort()).toEqual(cases.kept.map((_, i) => String(200 + i)).sort())
    }
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

// ---------------------------------------------------------------- many at once (decision mod-20)

const MORE_TITLE = TOAST_TITLES.moreNotices

/** `count` live headless claudes no entry claims, pids from 7000 up, each with a sessions file of its own. */
function seedOrphans(world: World, count: number): number[] {
  const pids = Array.from({ length: count }, (_, at) => 7000 + at)
  for (const pid of pids) seedOrphan(world, `7a7a7a7a-0000-4000-8000-${String(pid).padStart(12, '0')}`, pid)
  return pids
}

/** `count` open points raised three days ago, ids op-01 up. */
const oldPoints = (count: number, from = 1) =>
  Array.from({ length: count }, (_, at) => ({ id: `op-${String(from + at).padStart(2, '0')}`, status: 'open', raised: localDate(NOW_MS - 3 * 86_400_000), title: `Question ${from + at}` }))

describe('many notices at once', () => {
  test('45 orphans in one poll: 5 told one by one and the other 40 in one notice; 3 toasts and one summary toast; every pid recorded, none told again', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    ownSession(on)
    echoPrompt(on)
    seed(world)
    const pids = seedOrphans(world, 45)
    await start($)
    await poll(world, ORPHAN_GRACE_SEC)
    const toasts = world.toasts.filter(text => text.startsWith(`${TOAST_TITLES.orphan} · `) || text.startsWith(`${MORE_TITLE} · `))
    expect(toasts.length).toBe(4)
    expect(toasts.slice(0, 3).every(text => text.startsWith(`${TOAST_TITLES.orphan} · pid 700`))).toBe(true)
    expect(toasts[3]).toBe(`${MORE_TITLE} · 3 more notices: see the next prompt`)
    const lines = noticeLines(await userPrompt($))
    expect(lines.length).toBe(6)
    expect(lines.slice(0, 5).map(line => line.slice(0, `${NOTICE_PREFIX} orphan: pid 7000 `.length))).toEqual([7000, 7001, 7002, 7003, 7004].map(pid => `${NOTICE_PREFIX} orphan: pid ${pid} `))
    expect(lines[5]).toBe(`${NOTICE_PREFIX} orphan: 40 more unregistered sessions: 7005, 7006, 7007, 7008, 7009, 7010, 7011, 7012, 7013, 7014 and 30 not listed; list_sessions shows each; raise an open point naming them`)
    const orphans = parseNoticeState(store.get(KEY)).orphans
    expect(Object.keys(orphans).sort()).toEqual(pids.map(String).sort())
    expect(Object.values(orphans).every(one => one.isTold === true)).toBe(true)
    await poll(world, 120)
    expect(noticeToasts(world).length).toBe(3)
    expect(world.toasts.filter(text => text.startsWith(`${MORE_TITLE} · `)).length).toBe(1)
    expect(noticeLines(await userPrompt($))).toEqual([])
  })

  test('a mix of kinds in one poll (2 orphans, a stall, 2 old open points): the first 3 toasted, one summary for the other 2, all 5 lines on the next prompt', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    ownSession(on)
    echoPrompt(on)
    seed(world, { entries: [seedLiveWorker(world, SID_LIVE)] })
    seedOrphans(world, 2)
    seedTranscript(world, SID_LIVE)
    // The stall and the orphans come due at the same poll, 30 s on; the points file appears just before it.
    world.mtimes.set(SID_LIVE, NOW_SEC + ORPHAN_GRACE_SEC - STALL_SEC)
    await start($)
    await poll(world, ORPHAN_GRACE_SEC - 5)
    expect(noticeToasts(world)).toEqual([])
    world.files.set(`${ORCH}/open-points.json`, JSON.stringify({ points: oldPoints(2) }))
    await poll(world, 5)
    const titles = world.toasts.filter(text => noticeToasts(world).includes(text) || text.startsWith(`${MORE_TITLE} · `)).map(text => text.slice(0, text.indexOf(' · ')))
    expect(titles).toEqual([TOAST_TITLES.orphan, TOAST_TITLES.orphan, TOAST_TITLES.stall, MORE_TITLE])
    expect(world.toasts.at(-1)).toBe(`${MORE_TITLE} · 2 more notices: see the next prompt`)
    const kinds = noticeLines(await userPrompt($)).map(line => line.slice(NOTICE_PREFIX.length + 1, line.indexOf(': ', NOTICE_PREFIX.length + 1)))
    expect(kinds).toEqual(['orphan', 'orphan', 'stall', 'open-point-age', 'open-point-age'])
  })

  test('a harvest with 4 queued tasks waiting and a compliance check, and 2 old open points, in one refresh: 3 toasts for the harvest, 2 for the poll, one summary', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, {
      entries: [{ ...UNIT_ENTRY }],
      queue: ['q-1', 'q-2', 'q-3', 'q-4'].map(id => ({ id, status: 'queued', title: id, waits_for: SID_UNIT })),
      points: oldPoints(2),
    })
    world.files.set(`${RUNS}/unit.json`, RESULTS.clean)
    await start($)
    const shown = world.toasts.filter(text => noticeToasts(world).includes(text) || text.startsWith(`${MORE_TITLE} · `)).map(text => text.slice(0, text.indexOf(' · ')))
    expect(shown).toEqual([TOAST_TITLES['queue-ready'], TOAST_TITLES['queue-ready'], TOAST_TITLES['queue-ready'], TOAST_TITLES['open-point-age'], TOAST_TITLES['open-point-age'], MORE_TITLE])
    expect(world.toasts.at(-1)).toBe(`${MORE_TITLE} · 2 more notices: see the next prompt`)
    const kinds = noticeLines(await userPrompt($)).map(line => line.slice(NOTICE_PREFIX.length + 1, line.indexOf(': ', NOTICE_PREFIX.length + 1)))
    expect(kinds).toEqual(['queue-ready', 'queue-ready', 'queue-ready', 'queue-ready', 'compliance-due', 'open-point-age', 'open-point-age'])
  })

  test('more than 30 lines waiting: the first 29 stay and the last line says how many were not shown, added up over several passes; drained by the prompt', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, { points: oldPoints(40) })
    await start($)
    expect(noticeToasts(world).length).toBe(3)
    expect(world.toasts.at(-1)).toBe(`${MORE_TITLE} · 37 more notices: see the next prompt`)
    world.files.set(`${ORCH}/open-points.json`, JSON.stringify({ points: [...oldPoints(40), ...oldPoints(5, 41)] }))
    await poll(world, 5)
    const lines = noticeLines(await userPrompt($))
    expect(lines.length).toBe(30)
    expect(lines.slice(0, 29).map(line => /open point (op-\d+)/.exec(line)?.[1])).toEqual(oldPoints(29).map(point => point.id))
    expect(lines[29]).toBe(`${NOTICE_PREFIX} more: 16 further notices not shown; run list_sessions and audit_state`)
    expect(noticeLines(await userPrompt($))).toEqual([])
  })
})

describe('notices.ts: the caps', () => {
  test('pendingWith: under the cap the lines are kept as they come; past it 29 stay and the more line counts the rest, over several additions', () => {
    const line = (at: number) => `${NOTICE_PREFIX} stall: line ${at}`
    const lines = (from: number, count: number) => Array.from({ length: count }, (_, at) => line(from + at))
    expect(pendingWith([], lines(1, 30))).toEqual(lines(1, 30))
    const over = pendingWith(lines(1, 20), lines(21, 15))
    expect(over.length).toBe(30)
    expect(over.slice(0, 29)).toEqual(lines(1, 29))
    expect(over[29]).toBe(moreLine(6))
    expect(over[29]).toBe(`${NOTICE_PREFIX} more: 6 further notices not shown; run list_sessions and audit_state`)
    expect(pendingWith(over, [line(36)])).toEqual([...lines(1, 29), moreLine(7)])
    expect(moreLine(1)).toBe(`${NOTICE_PREFIX} more: 1 further notice not shown; run list_sessions and audit_state`)
    expect(pendingWith(lines(1, 29), [line(30), line(31)])).toEqual([...lines(1, 29), moreLine(2)])
  })

  test('orphanGroupNotice and moreToastText: up to 10 pids listed, the count in the trace fields; singular and plural', () => {
    expect(orphanGroupNotice([1, 2, 3])).toEqual({ kind: 'orphan', message: '3 more unregistered sessions: 1, 2, 3; list_sessions shows each; raise an open point naming them', fields: { count: 3, isGroup: true } })
    const twelve = Array.from({ length: 12 }, (_, at) => 100 + at)
    expect(orphanGroupNotice(twelve).message).toBe('12 more unregistered sessions: 100, 101, 102, 103, 104, 105, 106, 107, 108, 109 and 2 not listed; list_sessions shows each; raise an open point naming them')
    expect(moreToastText(1)).toBe('1 more notice: see the next prompt')
    expect(moreToastText(4)).toBe('4 more notices: see the next prompt')
    expect([ORPHANS_SHOWN, ORPHAN_PIDS_LISTED, TOASTS_PER_PASS, PENDING_NOTICES_MAX]).toEqual([5, 10, 3, 30])
  })
})

// ---------------------------------------------------------------- completion notes redacted (decision mod-20)

describe('completion notes', () => {
  const TITLE_CANARY = ['sk', 'canarytitle00000000'].join('-')
  const RESULT_CANARY = ['ghp', 'canaryresult0000000000'].join('_')
  const ERROR_CANARY = ['sk', 'canaryerror000000000'].join('-')
  const notification = ($: { prompt: { submit: (e: never) => Promise<unknown> } }) =>
    $.prompt.submit({ text: 'notification', wait: false, origin: { kind: 'task-notification' } } as never) as Promise<{ context?: readonly unknown[] }>
  const completions = (sent: { context?: readonly unknown[] }) => (sent.context ?? []).map(String).filter(line => line.startsWith('session-control completions: '))
  const REPORT_CHECK = 'report check: report lacks git status -sb and git log --oneline @{u}..HEAD with their exit codes'

  test('a canary in the title and one in the result summary: redacted in the note and the toast; the rest of the wording as before', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seed(world, { entries: [{ ...UNIT_ENTRY, title: `rotate ${TITLE_CANARY} worker` }] })
    world.files.set(`${RUNS}/unit.json`, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Done; the canary ${RESULT_CANARY} was revoked and replaced.`, session_id: SID_UNIT }))
    await start($)
    const toast = world.toasts.find(text => text.startsWith('Session finished · '))
    expect(toast).toBe('Session finished · rotate [redacted] worker: clean: Done; the canary [redacted] was revoked and replaced.')
    const notes = completions(await notification($))
    // The secret scan (decision win-22) adds its line last: kinds only.
    expect(notes).toEqual([`session-control completions: rotate [redacted] worker: clean: Done; the canary [redacted] was revoked and replaced.; rotate [redacted] worker: ${REPORT_CHECK}; rotate [redacted] worker: secret scan: 1 likely secret redacted (kinds: github-token)`])
    const everything = JSON.stringify([world.toasts, notes])
    for (const canary of [TITLE_CANARY, RESULT_CANARY]) expect(everything).not.toContain(canary)
  })

  test('a canary in a failed run\'s message: redacted; no title: the session id\'s first 8 characters, readable; a usual title and summary unchanged', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    const usual = { ...UNIT_ENTRY, pid: 4301, session_id: SID_FREE, result_file: `${RUNS}/usual.json`, section: undefined }
    const untitled = { ...UNIT_ENTRY, title: undefined, section: undefined }
    seed(world, { entries: [untitled, usual] })
    world.files.set(`${RUNS}/unit.json`, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `push refused for ${ERROR_CANARY}`, session_id: SID_UNIT }))
    world.files.set(`${RUNS}/usual.json`, RESULTS.clean)
    await start($)
    const notes = completions(await notification($))
    expect(notes).toEqual([
      // The secret scan (decision win-22) adds its line after the completion it found the canary in.
      `session-control completions: ${SID_UNIT.slice(0, 8)}: error: push refused for [redacted]; ${SID_UNIT.slice(0, 8)}: secret scan: 1 likely secret redacted (kinds: sk-key); ` +
        `unit worker: clean: Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.; unit worker: ${REPORT_CHECK}`,
    ])
    expect(world.toasts).toContain(`Session failed · ${SID_UNIT.slice(0, 8)}: error: push refused for [redacted]`)
    expect(world.toasts.join('\n')).not.toContain(ERROR_CANARY)
  })
})
