// stop_worker through the plugin, on the mock world (mock-world.ts): a registered worker with a child and a grandchild
// in a simulated process table, the helper's probe computed from that table and the sessions files, and its stop over
// the table. What the tool refuses, what it signals (never anything outside the worker's tree), and the proof it answers.

import { describe, expect, test } from 'claude-code/testing'

import { HOME, OPTIONS, ORCH, REGISTRY, RUNS, mockWorld, seedLiveWorker } from './mock-world'
import type { World } from './mock-world'

const SID = '12345678-aaaa-4bbb-8ccc-1234567890ab'
const OTHER = '87654321-aaaa-4bbb-8ccc-1234567890ab'
const STOP = 'mcp__session-control__stop_worker'

/** The world with the orchestrator directory, a registry holding `entries`, and a bystander claude outside every tree. */
function seed(world: World, entries: Record<string, unknown>[]): void {
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  world.files.set(REGISTRY, `${JSON.stringify(entries, null, 2)}\n`)
  world.table.procs.set(5555, { ppid: 1, start: '42', state: 'S', comm: 'claude', claude: { cwd: '/w/other', configDir: `${HOME}/.claude`, cmdline: 'claude -p --model opus' } })
}

/** The answer's text: the tool's result, or its refusal. */
const answerOf = (answer: unknown) => {
  const one = answer as { result?: unknown; deny?: unknown; text?: unknown; isError?: unknown }
  return { text: String(one.deny ?? one.result ?? one.text ?? ''), isRefused: one.deny !== undefined || one.isError === true }
}

describe('stop_worker', () => {
  test('through the helper: a live registered worker is stopped and proved dead, its descendants listed first and stopped; nothing else is signalled and the registry is not written', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world, [seedLiveWorker(world, SID)])
    const registryBefore = world.files.get(REGISTRY)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const writesBefore = world.written.length
    const { text, isRefused } = answerOf(await $.tool.call({ tool: STOP, session_id: SID.slice(0, 8), reason: 'stuck on a prompt' } as never))
    expect(isRefused).toBe(false)
    expect(text).toContain(`stop_worker: session ${SID} "live worker", pid 4101.`)
    expect(text).toContain('Reason given: stuck on a prompt')
    expect(text).toContain(`Abort check before: alive: ${HOME}/.claude/sessions/4101.json names session ${SID} with procStart 5000, and /proc/4101/stat field 22 is 5000.`)
    expect(text).toContain('Descendants listed before the first signal (2): 4102 (bash), parent 4101; 4103 (sleep), parent 4102.')
    expect(text).toMatch(/- \d{4}-\d\d-\d\dT[\d:.]+Z SIGTERM to 4101 \(claude\): exit code 0/)
    expect(text).toMatch(/re-check of 4101 after \d+ s: gone/)
    expect(text).toContain('Descendants at the end: 4102 (bash) gone; 4103 (sleep) gone.')
    expect(text).toContain('Abort check after: dead: pid 4101 is gone (no /proc/4101).')
    expect(text).toContain('Result: pid 4101 is dead')
    expect(text).toContain('Surviving descendants: none.')
    expect(text).toContain('The registry is unchanged')
    expect(world.table.signals.map(one => one.pid).every(pid => [4101, 4102, 4103].includes(pid))).toBe(true)
    expect([...world.table.procs.keys()]).toEqual([5555])
    expect(world.files.get(REGISTRY)).toBe(registryBefore)
    expect(world.written.slice(writesBefore).filter(one => one.path === REGISTRY)).toEqual([])
    expect(world.runs.some(argv => argv[0] === 'node' && argv[2] === 'processTree')).toBe(true)
    expect(world.runs.some(argv => argv[0] === 'node' && argv[2] === 'stopProcesses')).toBe(true)
  })

  test('a descendant that ignores SIGTERM gets SIGKILL, and the proof says so', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world, [seedLiveWorker(world, SID)])
    const sleeper = world.table.procs.get(4103)
    if (sleeper !== undefined) sleeper.isStubborn = true
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const { text } = answerOf(await $.tool.call({ tool: STOP, session_id: SID } as never))
    expect(text).toMatch(/SIGTERM to 4103 \(sleep\): exit code 0/)
    expect(text).toMatch(/re-check of 4103 after 10 s: still alive/)
    expect(text).toMatch(/SIGKILL to 4103 \(sleep\): exit code 0/)
    expect(text).toMatch(/re-check of 4103 after 0 s: gone/)
    expect(world.table.signals).toEqual([
      { pid: 4101, signal: 'TERM' },
      { pid: 4102, signal: 'TERM' },
      { pid: 4103, signal: 'TERM' },
      { pid: 4103, signal: 'KILL' },
    ])
  })

  test('refused, nothing signalled: an unknown id, a finished entry (no pid), a pid whose sessions file names another session, a reused pid, a gone pid, this session\'s own process', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    const live = seedLiveWorker(world, SID)
    seed(world, [
      live,
      { title: 'finished', session_id: OTHER, config_dir: `${HOME}/.claude`, outcome: { kind: 'clean' }, reported: true },
      { title: 'gone', pid: 4999, session_id: '11111111-aaaa-4bbb-8ccc-1234567890ab', config_dir: `${HOME}/.claude` },
    ])
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const ask = async (id: string) => answerOf(await $.tool.call({ tool: STOP, session_id: id } as never))
    const unknown = await ask('99999999')
    expect(unknown.isRefused).toBe(true)
    expect(unknown.text).toContain('no registry entry has the session id 99999999')
    const finished = await ask(OTHER)
    expect(finished.isRefused).toBe(true)
    expect(finished.text).toContain(`refused: session ${OTHER} is not alive: its entry records no pid`)
    const gone = await ask('11111111')
    expect(gone.text).toContain('the Abort check before the stop does not prove pid 4999')
    expect(gone.text).toContain('dead: pid 4999 is gone')
    // The sessions file names another session: the pid is not this worker's.
    world.files.set(`${HOME}/.claude/sessions/4101.json`, JSON.stringify({ sessionId: OTHER, procStart: '5000' }))
    const another = await ask(SID)
    expect(another.isRefused).toBe(true)
    expect(another.text).toContain(`not this session: ${HOME}/.claude/sessions/4101.json names session ${OTHER}`)
    // A reused pid: the process's start is not the sessions file's procStart.
    world.files.set(`${HOME}/.claude/sessions/4101.json`, JSON.stringify({ sessionId: SID, procStart: '4000' }))
    const reused = await ask(SID)
    expect(reused.text).toContain('dead or a reused pid: ')
    expect(reused.text).toContain('has procStart 4000, /proc/4101/stat field 22 is 5000')
    // This session's own process (or an ancestor of it): the listing finds it above itself.
    world.files.set(`${HOME}/.claude/sessions/4101.json`, JSON.stringify({ sessionId: SID, procStart: '5000' }))
    world.table.own = [4101, 3000, 1]
    const own = await ask(SID)
    expect(own.isRefused).toBe(true)
    expect(own.text).toContain("pid 4101 is this session's own process or one of its ancestors; nothing was signalled")
    expect(world.table.signals).toEqual([])
    expect(world.table.procs.size).toBe(4)
  })

  test('a stop that sends nothing, or cannot list the tree, is decided by the Abort check after: STILL ALIVE, said plainly', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seed(world, [seedLiveWorker(world, SID)])
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    // The helper's stop sends nothing and fails: nothing falls back, and the proof says the stop did not complete.
    world.breaks.add('stop')
    const quiet = answerOf(await $.tool.call({ tool: STOP, session_id: SID } as never))
    expect(quiet.isRefused).toBe(false)
    expect(quiet.text).toContain("The stop did not complete: the helper's stop failed (IO); what it signalled before that is not known. What follows is what the checks found afterwards.")
    expect(quiet.text).toContain('Abort check after: alive: ')
    expect(quiet.text).toContain('Result: pid 4101 is STILL ALIVE after the stop: it is a live worker; report it as running, never as stopped.')
    expect(world.table.signals).toEqual([])
    world.breaks.delete('stop')
    world.breaks.add('tree')
    const failed = answerOf(await $.tool.call({ tool: STOP, session_id: SID } as never))
    expect(failed.text).toContain('Descendants listed before the first signal: unknown (the tree could not be listed).')
    expect(failed.text).toContain('The stop did not complete: the process tree could not be listed (IO); nothing was signalled. What follows is what the checks found afterwards.')
    expect(failed.text).toContain('Result: pid 4101 is STILL ALIVE')
    expect(world.table.signals).toEqual([])
  })

  test('the debug trace keeps the session id, the counts and the answer\'s length, never the reason or the title', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const world = mockWorld(on)
    seed(world, [seedLiveWorker(world, SID, { title: 'secret title words' })])
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await $.tool.call({ tool: STOP, session_id: SID, reason: 'private reason words' } as never)
    const trace = world.files.get(`${RUNS}/trace.log`) ?? ''
    const lines = trace.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.find(line => line.event === 'tool.call' && line.tool === 'stop_worker')).toMatchObject({ session_id: SID })
    expect(lines.find(line => line.event === 'guard' && line.tool === 'stop_worker')).toMatchObject({ isOk: true, pid: 4101, signals: 3, isDeadAfter: true, survivors: 0 })
    expect(typeof lines.find(line => line.event === 'tool.result' && line.tool === 'stop_worker')?.resultChars).toBe('number')
    expect(trace).not.toContain('private reason')
    expect(trace).not.toContain('secret title')
    expect(lines.some(line => line.event === 'process.run' && line.helper === 'stopProcesses' && line.pid === 4101 && line.targets === 3)).toBe(true)
  })
})
