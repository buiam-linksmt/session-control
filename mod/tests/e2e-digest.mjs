#!/usr/bin/env node
// Run with `node mod/tests/e2e-digest.mjs` (Node 22 or newer), from any directory.
//
// End-to-end test of turn_digest against the real claude, in a scratch directory it makes and removes. It seeds one
// worker whose pid is gone and whose result file is a clean report (the first poll harvests it), a queue task waiting
// for it, and an open point raised ten days ago. A headless haiku orchestrator (--max-budget-usd 0.25) calls
// turn_digest twice; read from its transcript, the first output reports from the mod's load (the completion, the ready
// task, the aged point, the notices by kind, the state line), the second has nothing new; no output or trace line
// holds the canary seeded in the worker's title, and the tool wrote no file. Isolation as in lib/e2e.mjs.
// KEEP_OUT=<dir> keeps the two outputs.

import * as fs from 'node:fs'
import {
  CFG_DEFAULT, IS_WINDOWS, MOD, awaitOrchestrator, basename, entriesOf, finish, firstLine, globIn, grepF, isErrorFalse, join, keepOut, kit, lastLine, lineCount, linesOf,
  localDate, native, ours, pidExists, processesNaming, readJson, readOr, regularFiles, removeTree, requireClaude, resultText, scratch,
  scratchSettings, startClaude, toolUses, transcriptOf, writeJson, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, info } = kit
const CLAUDE = requireClaude()
let orch
const S = scratch('session-control-e2e-digest', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  removeTree(dir)
})
const ORCH = join(S, 'orch')
const RUNS = join(S, 'runs')
const REG = join(S, 'headless-sessions.json')
const TRACE = join(RUNS, 'trace.log')
// A text the redaction takes for a key: no output may show it.
// Joined from two parts, so the file holds no complete key-shaped string.
const CANARY = ['sk', 'e2ecanary0123456789digest'].join('-')

const SID_DONE = 'e2e0d16e-1111-4111-8111-111111111111'
// A pid no process has: the worker's recorded pid is gone, so the first poll harvests it.
let DEAD = 4194000
while (pidExists(DEAD)) DEAD++
for (const d of [ORCH, RUNS, join(S, 'work')]) fs.mkdirSync(d, { recursive: true })

writeLines(join(ORCH, 'CLAUDE.md'), '# Role: Session Orchestrator', '', 'Scratch orchestrator of the session-control turn_digest test: do exactly what the prompt says.')
writeJson(join(ORCH, 'task-queue.json'), { tasks: [{ id: 'e2e-next', title: 'E2E next step', status: 'queued', waits_for: 'w-e2e-digest-worker-1 to finish' }] })
const RAISED = localDate(10)
writeJson(join(ORCH, 'open-points.json'), { points: [{ id: 'e2e-old-point', status: 'open', raised: RAISED, title: 'E2E point waiting for the user', detail: 'Seeded by the test.', recommendation: 'Close it.' }] })
writeLines(join(ORCH, 'agreed-decisions.md'), '# Agreed decisions')
writeLines(join(ORCH, 'open-points-archive.md'), '# Open points archive')
writeJson(join(RUNS, 'done.json'), { type: 'result', subtype: 'success', is_error: false, result: '## Report\nThe digest worker is done; 3 tests pass.\n\ngit status -sb\n## main...origin/main\nexit 0\ngit log --oneline @{u}..HEAD\nexit 0', total_cost_usd: 0.01, duration_ms: 4000, num_turns: 2 })
fs.writeFileSync(join(RUNS, 'done.err'), '')
writeJson(REG, [
  { title: `e2e digest worker ${CANARY}`, pid: DEAD, session_id: SID_DONE, name: 'w-e2e-digest-worker-1', config_dir: CFG_DEFAULT, cwd: `${S}/work`, model: 'haiku', effort: 'low',
    result_file: `${RUNS}/done.json`, err_file: `${RUNS}/done.err`, started_at: Math.floor(Date.now() / 1000) - 60 },
])

const SETTINGS = scratchSettings(native(ORCH), native(REG), native(RUNS))
fs.writeFileSync(join(S, 'instruction.txt'),
  "This is an automated test of the session-control mod's turn_digest tool. Do exactly this and nothing else:\n" +
  '1. Call mcp__session-control__turn_digest with no input.\n' +
  '2. Right after it answers, call mcp__session-control__turn_digest again with no input.\n' +
  'Use no other tool. Then answer with the two outputs verbatim, the first after a line "=== first ===" and the second after a line "=== second ===", and nothing else.\n')
const filesBefore = regularFiles(S)
fs.writeFileSync(join(S, 'files-before.txt'), filesBefore.map(f => f + '\n').join(''))

// ---------------------------------------------------------------- the orchestrator
orch = startClaude({
  claude: CLAUDE,
  cwd: ORCH,
  args: ['-p', '--plugin-dir', native(MOD), '--model', 'haiku', '--dangerously-skip-permissions', '--max-budget-usd', '0.25', '--output-format', 'json', '--settings', SETTINGS],
  stdin: join(S, 'instruction.txt'),
  stdout: join(S, 'orchestrator.json'),
  stderr: join(S, 'orchestrator.err'),
  env: { SESSION_CONTROL_DEBUG: '1' },
})
await awaitOrchestrator(orch, { limit: 300, dir: S, isOk: () => isErrorFalse(join(S, 'orchestrator.json')) })
const ojson = readJson(join(S, 'orchestrator.json'))
const OSID = typeof ojson?.session_id === 'string' ? ojson.session_id : ''
info(`orchestrator cost USD ${ojson?.total_cost_usd ?? '?'}, session ${OSID} (config dir ${CFG_DEFAULT}, cwd ${ORCH})`)
const OT = transcriptOf(CFG_DEFAULT, OSID)
if (OSID && OT) pass(`orchestrator transcript found (${OT})`)
else fail(`orchestrator transcript found (session '${OSID}')`)
const entries = entriesOf(OT)

// The outputs of the tool's calls as the tool returned them, from the transcript's tool_results, in order.
const outPath = n => join(S, `out-${n}.txt`)
const digestCalls = toolUses(entries).filter(c => c.name === 'mcp__session-control__turn_digest')
digestCalls.forEach((call, i) => fs.writeFileSync(outPath(i + 1), resultText(entries, call.id)))
const N = digestCalls.length
if (N === 2) pass('turn_digest was called twice')
else fail(`turn_digest was called twice (called ${N} times)`)
const OTHER = [...new Set(toolUses(entries).filter(c => c.name !== 'mcp__session-control__turn_digest').map(c => c.name))].sort().map(name => name + ' ').join('')
if (!OTHER) pass('no other tool was called')
else info(`other tools the orchestrator called: ${OTHER}`)
for (const n of [1, 2]) if (!(fs.existsSync(outPath(n)) && fs.statSync(outPath(n)).size > 0)) fs.writeFileSync(outPath(n), '')
const first = readOr(outPath(1))
const second = readOr(outPath(2))
info('first output:')
for (const l of linesOf(first)) console.log(`  | ${l}`)
info('second output:')
for (const l of linesOf(second)) console.log(`  | ${l}`)

const outs = { 1: first, 2: second }
const check = (n, text, what) => (grepF(outs[n], text) ? pass(`call ${n}: ${what}`) : fail(`call ${n}: ${what} (missing: ${text})`))
const lacks = (n, text, what) => (grepF(outs[n], text) ? fail(`call ${n}: ${what} (found: ${text})`) : pass(`call ${n}: ${what}`))

// case "$x" in "<head>"*"<tail>"): the head, then anything, then the tail, the two not sharing a character.
const globbed = (text, head, tail) => text.length >= head.length + tail.length && text.startsWith(head) && text.endsWith(tail)
const FIRST_HEAD = firstLine(first)
if (globbed(FIRST_HEAD, "turn_digest: since the mod's load at ", '; first call)')) pass(`call 1: reports from the mod's load (${FIRST_HEAD})`)
else fail(`call 1: reports from the mod's load (got '${FIRST_HEAD}')`)
check(1, 'worker completions harvested: 1', 'the harvested completion counted')
check(1, '- e2e digest worker [redacted]: clean', "the completion's line, its title redacted")
check(1, 'queue tasks that became ready: 1', 'the ready task counted')
check(1, '- queued task e2e-next waited for w-e2e-digest-worker-1, which finished', "the ready task's line")
check(1, 'open points that aged past 24 h: 1', 'the aged point counted')
check(1, '- open point e2e-old-point', "the aged point's line")
check(1, 'notices fired: ', 'the notices by kind and count')
check(1, 'queue-ready 1', 'queue-ready counted')
check(1, 'open-point-age 1', 'open-point-age counted')
if (lastLine(first) === 'state: 0 alive, 1 finished; queue 1 queued, 0 running; 1 open point') pass('call 1: the state line last')
else fail(`call 1: the state line last (got '${lastLine(first)}')`)
if (lineCount(first) <= 40) pass(`call 1: at most 40 lines (${lineCount(first)})`)
else fail('call 1: at most 40 lines')

const SECOND_HEAD = firstLine(second)
if (globbed(SECOND_HEAD, 'turn_digest: since the last call at ', ' ago)')) pass(`call 2: since the last call (${SECOND_HEAD})`)
else fail(`call 2: since the last call (got '${SECOND_HEAD}')`)
if ((linesOf(second)[1] ?? '') === 'nothing new') pass('call 2: nothing new')
else fail(`call 2: nothing new (got '${linesOf(second)[1] ?? ''}')`)
lacks(2, 'worker completions harvested', 'the completion is not reported again')
lacks(2, 'notices fired', 'no notice reported again')
if (lineCount(second) === 3) pass('call 2: three lines (since, nothing new, the state line)')
else fail(`call 2: three lines (got ${lineCount(second)})`)

// ---------------------------------------------------------------- no secret; no file written by the tool
const outFiles = fs.readdirSync(S).filter(name => /^out-.*\.txt$/.test(name)).sort().map(name => join(S, name))
const LEAK = [...outFiles, join(S, 'orchestrator.json'), TRACE].filter(f => readOr(f).includes(CANARY)).map(f => basename(f))
if (LEAK.length === 0) pass('the canary secret is in no output, no answer and no trace line')
else fail(`the canary secret leaked into: ${LEAK.join(' ')}`)
const trace = readOr(TRACE)
const traceLines = linesOf(trace)
if (trace.includes('"event":"tool.result","tool":"turn_digest","resultChars":')) pass('the trace has the length of the answers only')
else fail('the trace has the length of the answers only')
const DIGEST_LINES = traceLines.filter(l => l.includes('"event":"digest"')).length
if (DIGEST_LINES === 2) pass('the trace has one digest line per call (counts only)')
else fail(`the trace has one digest line per call (got ${DIGEST_LINES})`)
// The files written during the run: the registry (the completion merged), the trace, a backup of the registry, and
// what the board makes at its start; none by turn_digest, which keeps its time in the engine's store.
const filesAfter = regularFiles(S)
fs.writeFileSync(join(S, 'files-after.txt'), filesAfter.map(f => f + '\n').join(''))
const before = new Set(filesBefore)
const ignored = [/\/runs\/trace\.log/, /\/orch\/backups\//, /\/files-before\.txt$/, /\/files-after\.txt$/, /\/orchestrator\.(json|err)$/, /\/out-[12]\.txt$/]
// On native Windows the board writes its process probe script into the runs directory at its start (README, Windows):
// that one file, by its exact path.
const PROBE_SCRIPT = IS_WINDOWS ? native(join(RUNS, 'probe.ps1')) : undefined
const NEW = filesAfter.filter(f => !before.has(f) && !ignored.some(re => re.test(f)) && f !== PROBE_SCRIPT)
if (NEW.length === 0) pass('no file besides the trace, the registry backup and the run outputs was created')
else fail(`no file besides the trace, the registry backup and the run outputs was created: ${NEW.join('\n')}`)
// Between a turn_digest call line and its answer line, no line of a write.
let on = false
let found = false
for (const line of traceLines) {
  if (line.includes('"event":"tool.call","tool":"turn_digest"')) on = true
  if (line.includes('"event":"tool.result","tool":"turn_digest"')) on = false
  if (on && /"event":"fs\.(write|append)"|"helper":"(writeAtomic|append)"/.test(line)) found = true
}
if (trace.includes('"event":"tool.call","tool":"turn_digest"') && !found) pass('the trace shows no write between a turn_digest call and its answer')
else fail('the trace shows no write between a turn_digest call and its answer')
const reg = readJson(REG)
if (Array.isArray(reg) && reg.length === 1 && reg[0]?.outcome?.kind === 'clean') pass('the registry holds the harvested entry, outcome clean')
else fail('the registry holds the harvested entry, outcome clean')
if (process.env.KEEP_OUT && keepOut(process.env.KEEP_OUT, [{ files: globIn(S, /^out-.*\.txt$/, 'out-*.txt') }], false)) {
  info(`outputs copied to ${process.env.KEEP_OUT}`)
}

const LEFT = processesNaming(S)
if (!LEFT) pass('no process names the scratch directory')
else fail(`no process names the scratch directory: ${LEFT}`)
finish(S)
