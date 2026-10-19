// What stays of guard.ts beside the sign-off guard (signoff.test.ts): the Bash parsers it reads commands with
// (cutHeredocs, substitutionsOf), and record_decision's check against the decisions archive through the plugin on the
// mock world (mock-world.ts).

import { describe, expect, test } from 'claude-code/testing'

import { cutHeredocs, substitutionsOf } from '../hooks/guard'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, ORCH, REGISTRY, RUNS, mockWorld, seedLiveWorker } from './mock-world'
import type { World } from './mock-world'

const SID_LIVE = '10000000-aaaa-4bbb-8ccc-000000000001'
const SID_ACK = '20000000-aaaa-4bbb-8ccc-000000000002'
const SID_RETIRE = '30000000-aaaa-4bbb-8ccc-000000000003'
const SID_CLOSE = '40000000-aaaa-4bbb-8ccc-000000000004'
const CLEAN = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done. git status -sb exit 0', total_cost_usd: 0.1, duration_ms: 2000 })

/** A finished, clean entry with its result file and a transcript in the default config directory. */
function finished(world: World, sid: string, title: string, reported: boolean): Record<string, unknown> {
  world.files.set(`${RUNS}/${title}.json`, CLEAN)
  world.files.set(`${RUNS}/${title}.err`, '')
  const row = { type: 'assistant', timestamp: new Date(NOW_MS - 600_000).toISOString(), message: { content: [{ type: 'text', text: `Report of ${title}. ${'x'.repeat(220)}` }] } }
  world.files.set(`${HOME}/.claude/projects/-w-work/${sid}.jsonl`, `${JSON.stringify(row)}\n`)
  return { title, session_id: sid, config_dir: `${HOME}/.claude`, cwd: '/w/work', model: 'haiku', effort: 'low', result_file: `${RUNS}/${title}.json`, err_file: `${RUNS}/${title}.err`, outcome: { kind: 'clean', summary: 'clean' }, reported, started_at: Math.floor(NOW_MS / 1000) - 900 }
}

/** The orchestrator directory, the registry and the runs directory as a working orchestrator has them. */
function seedOrchestrator(world: World): void {
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  world.files.set(`${ORCH}/open-points.json`, `${JSON.stringify({ points: [{ id: 'old', status: 'closed', title: 'Settled long ago', closed: '2026-01-01', resolution: 'done' }] }, null, 2)}\n`)
  world.files.set(`${ORCH}/task-queue.json`, `${JSON.stringify({ tasks: [] }, null, 2)}\n`)
  world.files.set(`${ORCH}/agreed-decisions.md`, '# Agreed decisions\n\n## Free unit\nfree-1. A decision.\n\n## Old unit\nold-1. An old decision.\n')
  world.files.set(`${ORCH}/open-points-archive.md`, '# Open points archive\n')
  const entries = [seedLiveWorker(world, SID_LIVE), finished(world, SID_ACK, 'ack', false), finished(world, SID_RETIRE, 'retire', true), finished(world, SID_CLOSE, 'close', false)]
  world.files.set(REGISTRY, `${JSON.stringify(entries, null, 2)}\n`)
}

const answerOf = (answer: unknown) => {
  const one = answer as { result?: unknown; deny?: unknown; text?: unknown; isError?: unknown }
  return { text: String(one.deny ?? one.result ?? one.text ?? ''), isRefused: one.deny !== undefined || one.isError === true }
}

describe('heredocs, quoted arguments and substitutions, as the sign-off guard reads a command', () => {
  test('cutHeredocs and substitutionsOf: bodies as Bash reads them, a mark each; substitutions outside single quotes', () => {
    const cut = cutHeredocs("cat > a <<'X'; cat > b <<Y\none\nX\ntwo $(date)\nY\necho after")
    expect(cut.heredocs.map(one => [one.body, one.isQuoted])).toEqual([['one', true], ['two $(date)', false]])
    expect(cut.text).not.toContain('one')
    expect(cut.text).toContain('echo after')
    expect(cutHeredocs('echo "<<X"\nx\nX').heredocs).toEqual([])
    expect(cutHeredocs('cat <<EOF\nno end').heredocs.map(one => one.body)).toEqual(['no end'])
    expect(substitutionsOf('a $(b "c") `d` \'$(e)\' "$(f)" $((1+2))')).toEqual(['b "c"', 'd', 'f'])
    expect(substitutionsOf("it's $(g)", true)).toEqual(['g'])
  })
})

describe('record_decision and the decisions archive', () => {
  test('an id an archived section holds is refused with the reason; a new id is recorded; an unreadable archive refuses; no archive, no check', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedOrchestrator(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const record = async (id: string) => answerOf(await $.tool.call({ tool: 'mcp__session-control__record_decision', section: 'Free unit', id, text: 'A line.' } as never))
    // No archive yet: only the file's own ids count.
    expect((await record('arch-1')).isRefused).toBe(false)
    world.files.set(`${ORCH}/agreed-decisions-archive.md`, '# Agreed decisions archive\n# Archived 2026-09-20 from agreed-decisions.md\n## Gone unit\ngone-1. Archived.\n')
    const refused = await record('gone-1')
    expect(refused.isRefused).toBe(true)
    expect(refused.text).toContain("decision gone-1 already exists in agreed-decisions-archive.md (an archived section's ids stay taken); choose another id")
    expect(world.files.get(`${ORCH}/agreed-decisions.md`)).not.toContain('gone-1.')
    expect((await record('free-9')).isRefused).toBe(false)
    expect(world.files.get(`${ORCH}/agreed-decisions.md`)).toContain('free-9. A line.')
    world.unreadable.add(`${ORCH}/agreed-decisions-archive.md`)
    const unreadable = await record('free-10')
    expect(unreadable.isRefused).toBe(true)
    expect(unreadable.text).toContain('agreed-decisions-archive.md is there but cannot be read, so the id cannot be checked')
    expect(world.files.get(`${ORCH}/agreed-decisions.md`)).not.toContain('free-10.')
  })
})

describe('a hot reload after a cd', () => {
  // Without the orchestratorDir option the orchestrator directory is the session's own; a hot reload runs session.start
  // again from the session's current directory, which a cd in Bash may have moved into a subfolder.
  const { orchestratorDir, ...unset } = OPTIONS
  test('the reload keeps the orchestrator directory an earlier load turned the board on for: the board is on and record_decision writes the orchestrator\'s file', { options: unset }, async ($, on) => {
    expect(orchestratorDir).toBe(ORCH)
    const world = mockWorld(on)
    seedOrchestrator(world)
    // What the session's earlier load left: it turned the board on for the orchestrator directory.
    on('state.get', ($, e, next) => (e.plugin === 'session-control' && e.key === 'boardDir' ? { value: { value: ORCH, version: 1 } } : next(e)))
    await $.session.start({ cwd: `${ORCH}/scratch/port43`, surface: null, isInteractive: true })
    const recorded = answerOf(await $.tool.call({ tool: 'mcp__session-control__record_decision', section: 'Free unit', id: 'free-2', text: 'After the reload.' } as never))
    expect(recorded).toEqual({ text: 'agreed-decisions.md: recorded free-2 in Free unit.', isRefused: false })
    expect(world.files.get(`${ORCH}/agreed-decisions.md`)).toContain('free-2. After the reload.')
    expect([...world.files.keys()].filter(path => !path.startsWith('/w/'))).toEqual([])
    // The board is on again, with the sign-off guard on the session's own commands.
    const forced = answerOf(await $.tool.call({ tool: 'Bash', command: 'git push --force origin x' } as never))
    expect(forced.text).toStartWith('session-control: refused by the sign-off guard: git push --force')
    expect(world.passed.filter(one => one.tool === 'Bash')).toEqual([])
  })
})
