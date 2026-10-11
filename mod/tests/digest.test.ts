// turn_digest (digest.ts) through the plugin on the mock world: the first call from the mod's load, a second call that
// has nothing new, what each section takes (completions, orphans, stalls, ready tasks, aged points, the notices by kind,
// unacknowledged peer messages), the state line, the 40-line bound, the redaction, the notices option off, a reload of
// the mod, and that the call writes no file (its time goes to $.store).

import { describe, expect, test } from 'claude-code/testing'

import { DIGEST_MAX_LINES, digestKeyDir, digestStoreKey, digestText, lastCallOf, withEvent } from '../hooks/digest'
import { ORPHAN_GRACE_SEC, STALL_SEC } from '../hooks/notices'
import { localDate } from '../hooks/store'
import { NOW_MS, RESULTS } from './fixtures'
import { HOME, OPTIONS as BASE_OPTIONS, ORCH, RUNS, mockWorld, seedLiveWorker } from './mock-world'
import type { World } from './mock-world'
import { poll, seedOrch, startOrch, storeOf } from './notice-kit'

const NOW_SEC = NOW_MS / 1000
/** A 10 s poll: the notices are timed by the mod's clock, not by the poll; fewer polls keep the suite light. */
const OPTIONS = { ...BASE_OPTIONS, pollSeconds: 10 }
const DIGEST_TOOL = 'mcp__session-control__turn_digest'
const SID_LIVE = '11111111-aaaa-4bbb-8ccc-111111111111'
const SID_DONE = '22222222-aaaa-4bbb-8ccc-222222222222'
const OTHER_SID = '5a5a5a5a-0000-4000-8000-00000000005a'
const CANARY = ['sk', 'ant', 'api03', 'DIGESTCANARY0000000000000000000000'].join('-')

/** A worker whose pid is gone with a clean result: the first poll harvests it. */
const DONE_ENTRY = { title: 'done worker', pid: 4300, session_id: SID_DONE, name: 'w-done-worker-261011090000', config_dir: `${HOME}/.claude`, cwd: '/w/work', model: 'haiku', effort: 'low', result_file: `${RUNS}/done.json` }

/** A live headless claude no entry claims. */
function seedOrphan(world: World, pid = 5555, sid = OTHER_SID): void {
  world.table.procs.set(pid, { ppid: 1, start: '42', state: 'S', comm: 'claude', claude: { cwd: '/w/other', configDir: `${HOME}/.claude`, cmdline: 'claude -p --model opus --output-format json', elapsedSec: 600 } })
  world.files.set(`${HOME}/.claude/sessions/${pid}.json`, JSON.stringify({ sessionId: sid, procStart: '42' }))
}

/** Everything a digest reports: a harvest, an orphan, a stall, a ready task, an old open point. */
function seedEverything(world: World): void {
  seedOrch(world, {
    entries: [seedLiveWorker(world, SID_LIVE, { name: 'w-live-worker-261011090000' }), DONE_ENTRY],
    queue: [
      { id: 'q-next', status: 'queued', title: 'Next', waits_for: 'w-done-worker-261011090000' },
      { id: 'q-run', status: 'running', title: 'Running' },
    ],
    points: [{ id: 'op-old', status: 'open', raised: localDate(NOW_MS - 3 * 86_400_000), title: 'Old question' }],
  })
  world.files.set(`${RUNS}/done.json`, RESULTS.clean)
  world.files.set(`${HOME}/.claude/projects/-w-work/${SID_LIVE}.jsonl`, '{"type":"user"}\n')
  world.mtimes.set(SID_LIVE, NOW_SEC - STALL_SEC - 60)
  seedOrphan(world)
}

const digest = async ($: { tool: { call: (e: never) => Promise<unknown> } }) => String(((await $.tool.call({ tool: DIGEST_TOOL } as never)) as { result?: unknown }).result ?? '')

describe('turn_digest', () => {
  test(`through the helper: the first call reports from the mod's load; the second has nothing new; the call writes no file`, { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on)
    seedEverything(world)
    await startOrch($)
    await poll(world, ORPHAN_GRACE_SEC + 5)
    const written = world.written.length
    const first = await digest($)
    const lines = first.split('\n')
    expect(lines[0]).toBe(`turn_digest: since the mod's load at ${new Date(NOW_MS).toISOString().slice(0, 19).replace('T', ' ')} UTC (35s ago; first call)`)
    expect(first).toContain('worker completions harvested: 1\n- done worker: clean')
    expect(first).toContain(`sessions that became orphans (unregistered): 1\n- pid 5555 is a live headless claude no registry entry claims (cwd /w/other`)
    expect(first).toContain('sessions that stalled: 1\n- worker "live worker" (session w-live-worker-261011090000) is alive but its transcript has not been written for 16 min')
    expect(first).toContain('queue tasks that became ready: 1\n- queued task q-next waited for w-done-worker-261011090000, which finished')
    expect(first).toContain('open points that aged past 24 h: 1\n- open point op-old')
    expect(first).toContain('notices fired: ')
    for (const kind of ['orphan 1', 'stall 1', 'queue-ready 1', 'open-point-age 1']) expect(first).toContain(kind)
    expect(lines[lines.length - 1]).toBe('state: 1 alive, 1 finished; queue 1 queued, 1 running; 1 open point')
    expect(lines.length).toBeLessThanOrEqual(DIGEST_MAX_LINES)
    // The call wrote no file; its time is in the store.
    expect(world.written.slice(written).filter(one => !one.path.endsWith('/trace.log'))).toEqual([])
    expect(lastCallOf(store.get(digestStoreKey(ORCH)))).toBe(NOW_MS + 35_000)
    await poll(world, 60)
    const second = await digest($)
    expect(second).toBe(['turn_digest: since the last call at 2026-09-21 16:00:35 UTC (1m00s ago)'.replace('2026-09-21 16:00:35', new Date(NOW_MS + 35_000).toISOString().slice(0, 19).replace('T', ' ')), 'nothing new', 'state: 1 alive, 1 finished; queue 1 queued, 1 running; 1 open point'].join('\n'))
  })

  test('an unacknowledged peer message is reported until its reply arrives; one sent after the last call is new', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    on('session.send', () => ({ isDelivered: true }) as never)
    on('session.receive', (_$, e) => ({ text: e.text }))
    seedOrch(world)
    await startOrch($)
    await $.session.send({ to: 'w-peer-one', text: 'Do the thing', origin: { kind: 'model' } } as never)
    await poll(world, 10)
    expect(await digest($)).toContain('unacknowledged peer messages: 1 (w-peer-one 10s ago, new)')
    await poll(world, 10)
    expect(await digest($)).toContain('unacknowledged peer messages: 1 (w-peer-one 20s ago)')
    await $.session.receive({ text: 'w-peer-one: done', origin: { kind: 'peer' } } as never)
    expect(await digest($)).not.toContain('unacknowledged peer messages')
  })

  test('bounded: 12 orphans at once fit in 40 lines: five told one by one and the rest in one notice', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world)
    for (let at = 0; at < 12; at++) seedOrphan(world, 7000 + at, `7a7a7a7a-0000-4000-8000-${String(at).padStart(12, '0')}`)
    await startOrch($)
    await poll(world, ORPHAN_GRACE_SEC + 5)
    const text = await digest($)
    const lines = text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(DIGEST_MAX_LINES)
    // Five told one by one and one grouped notice for the other 7: six orphan notices in the ledger.
    expect(text).toContain('sessions that became orphans (unregistered): 6')
    expect(lines[lines.length - 1]).toStartWith('state: ')
  })

  test('redacted like the other tools: a secret in a worker\'s title never reaches the answer', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world, { entries: [{ ...DONE_ENTRY, title: `leaky ${CANARY} worker` }] })
    world.files.set(`${RUNS}/done.json`, RESULTS.clean)
    await startOrch($)
    const text = await digest($)
    expect(text).toContain('worker completions harvested: 1')
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain('DIGESTCANARY')
  })

  test('the notices option off: the completions only, and the answer says the notices are off', { options: { ...OPTIONS, notices: 'off' } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedEverything(world)
    await startOrch($)
    await poll(world, ORPHAN_GRACE_SEC + 5)
    const text = await digest($)
    expect(text).toContain('notices are off (option notices)')
    expect(text).toContain('worker completions harvested: 1')
    expect(text).not.toContain('orphans (unregistered)')
    expect(text).not.toContain('notices fired')
  })

  test('a reload of the mod: the last call\'s time comes from the store; what happened before the reload is not kept, and the answer says so', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on, { [digestStoreKey(ORCH)]: { lastCallAt: NOW_MS - 600_000 } })
    seedOrch(world)
    await startOrch($)
    const text = await digest($)
    expect(text.split('\n')[0]).toBe(
      `turn_digest: since the last call at ${new Date(NOW_MS - 600_000).toISOString().slice(0, 19).replace('T', ' ')} UTC (10m00s ago); the mod was loaded again at ${new Date(NOW_MS).toISOString().slice(0, 19).replace('T', ' ')} UTC and keeps what happened from then on only`,
    )
  })

  test('the key of an orchestrator directory that is gone is dropped at the load\'s first notice pass; this directory\'s and other keys stay', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const store = storeOf(on, { [digestStoreKey('/w/gone')]: { lastCallAt: 1 }, [digestStoreKey(ORCH)]: { lastCallAt: 2 }, 'other:/w/gone': 3 })
    seedOrch(world)
    await startOrch($)
    expect([...store.keys()].sort()).toEqual([digestStoreKey(ORCH), 'other:/w/gone'].sort())
    expect(digestKeyDir(digestStoreKey('/w/gone'))).toBe('/w/gone')
    expect(digestKeyDir('digest:')).toBeUndefined()
    expect(digestKeyDir('notices:/w/gone')).toBeUndefined()
  })

  test('a registry that cannot be read: the state line says so', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world)
    await startOrch($)
    world.files.set(`${HOME}/.claude/headless-sessions.json`, '[{"half')
    expect((await digest($)).split('\n').pop()).toBe('state: registry unreadable; queue 0 queued, 0 running; 0 open points')
  })
})

describe('digest.ts', () => {
  const counts = { alive: 0, finished: 0, queued: 0, running: 0, openPoints: 0, isRegistryRead: true }

  test('withEvent keeps the newest 500 and counts the rest', () => {
    let ledger = { events: [] as ReturnType<typeof withEvent>['events'], dropped: 0 }
    for (let at = 0; at < 510; at++) ledger = withEvent(ledger.events, ledger.dropped, { at, kind: 'orphan', text: `e${at}` })
    expect(ledger.events.length).toBe(500)
    expect(ledger.dropped).toBe(10)
    expect(ledger.events[0]?.text).toBe('e10')
    expect(digestText({ events: ledger.events, dropped: ledger.dropped, nowMs: NOW_MS, loadedAt: NOW_MS, isNoticesOff: false, peers: [], counts }).split('\n')[1]).toBe('(10 older events were not kept)')
  })

  test('the line budget: every section keeps its title, the longest is cut first, the state line is last', () => {
    const events = [
      ...Array.from({ length: 50 }, (_, at) => ({ at: NOW_MS, kind: 'orphan' as const, text: `orphan ${at}` })),
      ...Array.from({ length: 30 }, (_, at) => ({ at: NOW_MS, kind: 'completion' as const, text: `done ${at}` })),
      ...Array.from({ length: 3 }, (_, at) => ({ at: NOW_MS, kind: 'stall' as const, text: `stall ${at}` })),
    ]
    const lines = digestText({ events, dropped: 0, nowMs: NOW_MS, loadedAt: NOW_MS, isNoticesOff: false, peers: [], counts }).split('\n')
    expect(lines.length).toBe(DIGEST_MAX_LINES)
    expect(lines).toContain('worker completions harvested: 30')
    expect(lines).toContain('sessions that became orphans (unregistered): 50')
    expect(lines).toContain('sessions that stalled: 3')
    expect(lines).toContain('- stall 2')
    expect(lines.some(line => /^- \.\.\. \d+ more$/.test(line))).toBe(true)
    expect(lines[lines.length - 1]).toBe('state: 0 alive, 0 finished; queue 0 queued, 0 running; 0 open points')
  })

  test('lastCallOf: a positive number in the stored object, nothing else', () => {
    expect(lastCallOf({ lastCallAt: 5 })).toBe(5)
    for (const bad of [undefined, null, 5, {}, { lastCallAt: '5' }, { lastCallAt: -1 }, { lastCallAt: Number.NaN }]) expect(lastCallOf(bad)).toBeUndefined()
  })
})
