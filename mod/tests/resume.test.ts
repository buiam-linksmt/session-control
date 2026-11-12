// A resume of a finished worker (launch_worker with resume_sid) through the plugin on the simulated machine
// (mock-world.ts): the new run's registration, its life and its harvest. A resumed session's engine writes its sessions
// file `<config_dir>/sessions/<pid>.json` only once it has loaded the transcript, seconds after the process started; the
// worker must count as running until then, get its socket once the file names it, and take its outcome from its own
// result file. Then the cases next to it: the old run's pid given out again, a resume of a retired entry, and the rule
// of a starting worker (isPidStarting through rowStatus and checkLaunch). resumeGone and setInbox: core.test.ts.

import { describe, expect, test } from 'claude-code/testing'

import { checkLaunch, parseProcFacts, rowStatus } from '../hooks/core'
import type { SessionEntry } from '../types'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, REGISTRY, RUNS, mockWorld } from './mock-world'
import type { World } from './mock-world'
import { poll, seedOrch, startOrch } from './notice-kit'

const TAE = `${HOME}/.claude/tae`
const SID = 'd5db1035-52ed-44a8-b26d-ba62d10823c1'
const NAME = 'w-investigate-the-mod-s-ti-261112114740'
const OLD_RESULT = `${RUNS}/20261112114740-investigate-the-mod-s-timing-bound-tests.json`
const NEW_SOCKET = '/run/user/1000/cc-socks/7001.sock'
/** The kept, finished, acknowledged entry of the first run, as the harvest and close_worker keep:true left it. */
const KEPT = {
  title: "Investigate the mod's timing-bound tests",
  session_id: SID,
  name: NAME,
  socket_path: '/run/user/1000/cc-socks/455893.sock',
  config_dir: TAE,
  cwd: '/w/work',
  model: 'opus',
  effort: 'xhigh',
  result_file: OLD_RESULT,
  err_file: OLD_RESULT.replace(/\.json$/, '.err'),
  started_at: Math.floor(NOW_MS / 1000) - 3 * 3600,
  section: 'Mod timing-bound tests (investigation)',
  keep: true,
  reported: true,
  outcome: { kind: 'clean', summary: 'clean: the old run report' },
  ended_at: Math.floor(NOW_MS / 1000) - 3600,
}

const tool = (name: string) => `mcp__session-control__${name}`
const answerOf = async ($: { tool: { call: (e: never) => Promise<unknown> } }, name: string, input: Record<string, unknown> = {}) => {
  const answer = (await $.tool.call({ tool: tool(name), ...input } as never)) as { result?: unknown; deny?: unknown; text?: unknown }
  return String(answer.result ?? answer.deny ?? answer.text ?? '')
}
const entryOf = (world: World, sid = SID) => (JSON.parse(world.files.get(REGISTRY) ?? '[]') as Record<string, unknown>[]).find(one => one.session_id === sid)
const resultText = (report: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: report, session_id: SID, total_cost_usd: 1.25, num_turns: 30, duration_ms: 600_000, ...extra })
const sessionFile = (world: World, pid: number, fields: Record<string, unknown>) => world.files.set(`${TAE}/sessions/${pid}.json`, JSON.stringify({ pid, sessionId: SID, procStart: '777', ...fields }))
const launches = (world: World) => world.passed.filter(one => one.tool === 'Bash' && String(one.input.command).includes(' claude -p '))

/** The orchestrator with the kept entry, its transcript under its licence and its first run's result file on disk. */
function seedKept(world: World, entry: Record<string, unknown> = KEPT): void {
  seedOrch(world, { entries: [entry] })
  world.files.set(`${TAE}/projects/-w-work/${SID}.jsonl`, '{}\n')
  world.files.set(OLD_RESULT, resultText('The old run report: the failures depend on load.'))
}

describe('a resume of a kept finished entry', () => {
  test('whose sessions file comes late: registered with its pid, running until its process ends, its socket filled in, its outcome from its own result file', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedKept(world)
    world.launch = { cwd: '/w/work', sid: SID, isFound: true, isFileLate: true }
    await startOrch($)
    const text = await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.', timeout_minutes: 120 })
    expect(text).toContain(`Launched pid 7001, session ${SID}, config_dir ${TAE}, registered. Name: ${NAME}; socket: none.`)
    expect(String(launches(world)[0]?.input.command)).toContain(`--resume '${SID}' -n '${NAME}'`)
    // The entry right after the launch's own refresh: the new run's pid and files, the old run's outcome and end gone.
    const started = entryOf(world)
    expect(started).toMatchObject({ pid: 7001, keep: true, socket_path: null, config_dir: TAE, cwd: '/w/work' })
    expect(started?.outcome).toBeUndefined()
    expect(started?.ended_at).toBeUndefined()
    expect(started?.reported).toBeUndefined()
    expect(started?.result_file).not.toBe(OLD_RESULT)
    expect(String(started?.result_file)).toStartWith(`${RUNS}/`)
    expect(world.toasts.some(one => one.startsWith('Session killed'))).toBe(false)
    // The poll keeps it running while the engine has not written the sessions file: no harvest, no orphan row.
    await poll(world, 30)
    expect(entryOf(world)).toMatchObject({ pid: 7001, socket_path: null })
    expect(entryOf(world)?.outcome).toBeUndefined()
    const listed = await answerOf($, 'list_sessions')
    expect(listed).toContain('running')
    expect(listed.includes('(no entry)')).toBe(false)
    expect(listed.includes('finished')).toBe(false)
    // The engine writes the file: the next poll writes its socket (and name) into the entry.
    sessionFile(world, 7001, { name: NAME, messagingSocketPath: NEW_SOCKET })
    await poll(world, 5)
    expect(entryOf(world)).toMatchObject({ pid: 7001, socket_path: NEW_SOCKET, name: NAME })
    // The run ends and writes its own result file; the first run's file is still on disk and is not read.
    world.table.procs.delete(7001)
    world.files.set(String(started?.result_file), resultText('The new run report: both changes are in one commit.'))
    await poll(world, 5)
    const ended = entryOf(world)
    expect(ended?.pid).toBeUndefined()
    expect(ended?.outcome).toMatchObject({ kind: 'clean', summary: 'clean: The new run report: both changes are in one commit.' })
    expect(ended).toMatchObject({ reported: false, keep: true, result_file: started?.result_file })
    expect(world.files.get(OLD_RESULT)).toContain('The old run report')
    expect(world.toasts.filter(one => one.startsWith('Session finished')).length).toBe(1)
    expect(world.toasts.some(one => one.startsWith('Session killed'))).toBe(false)
  })

  test('whose sessions file is there at once: registered with its socket in the answer, as before', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedKept(world)
    world.launch = { cwd: '/w/work', sid: SID, isFound: true }
    await startOrch($)
    const text = await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.' })
    expect(text).toContain('Launched pid 7001')
    await poll(world, 10)
    expect(entryOf(world)).toMatchObject({ pid: 7001 })
    expect(entryOf(world)?.outcome).toBeUndefined()
  })

  test('whose process ends before its sessions file was written: harvested from its own result file', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedKept(world)
    world.launch = { cwd: '/w/work', sid: SID, isFound: true, isFileLate: true }
    await startOrch($)
    await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.' })
    const started = entryOf(world)
    expect(started?.pid).toBe(7001)
    world.table.procs.delete(7001)
    world.files.set(String(started?.result_file), resultText('', { is_error: true, subtype: 'error_during_execution', result: 'The run failed at once.' }))
    await poll(world, 5)
    expect(entryOf(world)?.pid).toBeUndefined()
    expect(entryOf(world)?.outcome).toMatchObject({ kind: 'error' })
  })

  test('whose new process got the old run\'s pid again: the second run is harvested too', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    // The first run, live at pid 7001 under its sessions file, then ended and harvested in this load.
    const first = `${RUNS}/first-run.json`
    seedKept(world, { ...KEPT, pid: 7001, result_file: first, outcome: undefined, ended_at: undefined, reported: undefined, keep: undefined })
    world.table.procs.set(7001, { ppid: 6999, start: '777', state: 'S', comm: 'claude', claude: { cwd: '/w/work', configDir: TAE, cmdline: `claude -p --model opus -n ${NAME} --output-format json` } })
    sessionFile(world, 7001, { name: NAME })
    await startOrch($)
    await poll(world, 5)
    expect(entryOf(world)?.pid).toBe(7001)
    world.table.procs.delete(7001)
    world.files.set(first, resultText('The first run report: the first fix is in one commit and pushed.'))
    await poll(world, 5)
    expect(entryOf(world)?.outcome).toMatchObject({ kind: 'clean' })
    // The resume's process is given pid 7001 again.
    world.launch = { cwd: '/w/work', sid: SID, isFound: true, pid: 7001 }
    expect(await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.' })).toContain('Launched pid 7001')
    const second = String(entryOf(world)?.result_file)
    expect(second).not.toBe(first)
    await poll(world, 5)
    expect(entryOf(world)?.pid).toBe(7001)
    world.table.procs.delete(7001)
    world.files.set(second, resultText('', { is_error: true, subtype: 'error_during_execution', result: 'The second run failed.' }))
    await poll(world, 5)
    expect(entryOf(world)?.pid).toBeUndefined()
    expect(entryOf(world)?.outcome).toMatchObject({ kind: 'error', summary: 'error: The second run failed.' })
  })

  test('whose old pid now belongs to another claude: harvested as gone, and the resume registers its own pid', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    // The entry still records pid 7001 (its exit not harvested yet); 7001 is now an interactive claude with no sessions file there.
    seedKept(world, { ...KEPT, pid: 7001, outcome: undefined, ended_at: undefined, reported: undefined })
    world.table.procs.set(7001, { ppid: 1, start: '9000', state: 'S', comm: 'claude', claude: { cwd: '/w/work', configDir: TAE, cmdline: 'claude --model sonnet' } })
    await startOrch($)
    await poll(world, 5)
    expect(entryOf(world)?.pid).toBeUndefined()
    expect(entryOf(world)?.outcome).toMatchObject({ kind: 'clean', summary: 'clean: The old run report: the failures depend on load.' })
    world.launch = { cwd: '/w/work', sid: SID, isFound: true, isFileLate: true, pid: 7002 }
    expect(await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.' })).toContain('Launched pid 7002')
    await poll(world, 15)
    expect(entryOf(world)).toMatchObject({ pid: 7002 })
    expect(entryOf(world)?.outcome).toBeUndefined()
    expect(world.table.procs.has(7001)).toBe(true)
  })

  test('a second resume while the first one starts is refused: its process is alive', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedKept(world)
    world.launch = { cwd: '/w/work', sid: SID, isFound: true, isFileLate: true }
    await startOrch($)
    expect(await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.' })).toContain('Launched pid 7001')
    expect(await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.' })).toBe('session-control: refused: pid 7001 of that session is alive')
    expect(launches(world).length).toBe(1)
  })
})

describe('a resume of a retired entry', () => {
  test('is refused before anything runs: no launch, the registry as it was', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedKept(world)
    world.files.set(REGISTRY, '[]\n')
    world.launch = { cwd: '/w/work', sid: SID, isFound: true }
    await startOrch($)
    expect(await answerOf($, 'launch_worker', { resume_sid: SID, prompt: 'Continue the work.', dir: '/w/work', model: 'opus', effort: 'xhigh', title: 't' })).toBe(`session-control: no registry entry for ${SID}`)
    expect(launches(world).length).toBe(0)
    expect(world.files.get(REGISTRY)).toBe('[]\n')
  })
})

describe('the rules', () => {
  const entry = { pid: 7001, session_id: SID, name: NAME, cwd: '/w/work', config_dir: TAE } as SessionEntry
  const proc = (cmdline: string, cwd = '/w/work') => `P\t7001\tclaude\t3\t${cwd}\t${TAE}\t${cmdline}`
  const proof = (fileStart: string, fileSid: string, start = '777') => `A\t7001\tclaude\t${start}\t${fileStart}\t${fileSid}\tS`
  const facts = (...lines: string[]) => parseProcFacts(`${lines.join('\n')}\n`)
  const headless = `claude -p --model opus --resume ${SID} -n ${NAME} --output-format json`

  test('a worker whose sessions file is not written yet runs when its command line carries the entry\'s name in its cwd', () => {
    expect(rowStatus(entry, facts(proc(headless), proof('', '')))).toBe('alive')
    // On Windows the probe reads no cwd without the sessions file.
    expect(rowStatus(entry, facts(proc(headless, ''), proof('', '')))).toBe('alive')
    expect(rowStatus({ ...entry, cwd: '/w/work/' }, facts(proc(headless), proof('', '')))).toBe('alive')
  })

  test('anything else without the Abort check\'s proof is gone', () => {
    expect(rowStatus(entry, facts(proc(headless.replace(NAME, 'w-other-261112114740')), proof('', '')))).toBe('dead')
    expect(rowStatus(entry, facts(proc(`claude --model opus -n ${NAME}`), proof('', '')))).toBe('dead')
    expect(rowStatus(entry, facts(proc(headless, '/w/elsewhere'), proof('', '')))).toBe('dead')
    expect(rowStatus({ ...entry, name: undefined }, facts(proc(headless), proof('', '')))).toBe('dead')
    // A sessions file that is there decides: another start (the pid given out again) or another session.
    expect(rowStatus(entry, facts(proc(headless), proof('555', SID)))).toBe('dead')
    expect(rowStatus(entry, facts(proc(headless), proof('777', 'ffffffff-0000-4000-8000-000000000009')))).toBe('dead')
    // The process gone: no proof line, or no start read.
    expect(rowStatus(entry, facts(proc(headless)))).toBe('dead')
    expect(rowStatus(entry, facts(proc(headless), proof('', '', '')))).toBe('dead')
    expect(rowStatus(entry, facts(proof('', '')))).toBe('dead')
    // The proof as ever.
    expect(rowStatus(entry, facts(proc(headless), proof('777', SID)))).toBe('alive')
  })

  test('a resume of an entry whose worker is still starting is refused', () => {
    const args = { dir: '/w/work', prompt_file: '/w/p.md', model: 'opus', effort: 'xhigh', title: 't', resume_sid: SID }
    const ctx = { home: HOME, orchestratorDir: '/w/orch', entries: [entry], transcriptExists: true, promptFileOk: true, dirOk: true }
    expect(checkLaunch(args, { ...ctx, facts: facts(proc(headless), proof('', '')) })).toEqual({ ok: false, reason: 'refused: pid 7001 of that session is alive' })
    expect(checkLaunch(args, { ...ctx, facts: facts(proof('', '')) })).toEqual({ ok: true, configDir: TAE, resumeSid: SID })
  })
})
