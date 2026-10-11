#!/usr/bin/env node
// Run with `node mod/tests/e2e-tools.mjs` (Node 22 or newer), from any directory; no sh, grep, tr, sed, jq or cygpath is
// needed.
//
// End-to-end test of the six read-only inspection tools of the session-control mod against the real claude, in a
// scratch directory it makes and removes. It seeds a scratch registry with three finished sessions (a clean one with
// its result file; a chatter one whose result file says "Done." and whose transcript holds the real report; one whose
// cwd is the scratch root, which holds the orchestrator directory and the registry), their transcripts under a scratch
// config directory, run files, a queue with one stale task, one fine task and one task waiting on free text, an open
// point raised ten days ago, a decisions section and two backups of one kind. A headless haiku orchestrator (capped
// at --max-budget-usd 0.25) is asked to call each tool once and to answer with their outputs verbatim; each output is
// then read from the orchestrator's own transcript and checked against the seeded data, and no output, no answer and no
// trace line may hold the canary secret. The orchestrator itself is no orphan row: its cwd is the orch directory of an
// e2e scratch directory under the temporary directory; the other live claude processes of the machine show as they are
// and are never touched.
// Everything the mod reads or writes is in the scratch directory (registry, helper files, runs directory, trace); the
// real registry, helper files and runs directory are never touched, and the licence picker option is empty. The
// orchestrator runs under the default configuration (this process's CLAUDE_CONFIG_DIR, else ~/.claude): its
// transcript stays there. One line per check; exit 1 on a failure. KEEP_OUT=<dir> copies the six outputs there before
// the scratch directory goes.

import * as fs from 'node:fs'
import {
  CFG_DEFAULT, MOD, awaitOrchestrator, basename, byteSize, callCounts, entriesOf, finish, firstLine, globIn, grepF, iso, isErrorFalse, join, keepOut, kit,
  localDate, native, nodeMajor, ours, processesNaming, readJson, readOr, removeTree, requireClaude, resultText, sanitized, scratch,
  scratchSettings, shortId, startClaude, toolUses, touchAgo, transcriptOf, writeJson, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, info } = kit
const CLAUDE = requireClaude()
let orch
const S = scratch('session-control-e2e-tools', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  removeTree(dir)
})
const ORCH = join(S, 'orch')
const CFG = join(S, 'cfg')
const RUNS = join(S, 'runs')
const REG = join(S, 'headless-sessions.json')
const TRACE = join(RUNS, 'trace.log')
// A text the trace's redaction takes for a key: no output may show it.
// Joined from two parts, so the file holds no complete key-shaped string.
const CANARY = ['sk', 'e2ecanary0123456789abcdef'].join('-')

const NOW = Math.floor(Date.now() / 1000)
const SID_CLEAN = 'e2e0c1ea-1111-4111-8111-111111111111'
const SID_CHATTER = 'e2e0c4a7-2222-4222-8222-222222222222'
const SID_WRITER = 'e2e0e7e7-3333-4333-8333-333333333333'
for (const d of [join(ORCH, 'backups'), CFG, RUNS, join(S, 'work-clean'), join(S, 'work-chatter'), join(S, 'work'), join(S, '.git')]) fs.mkdirSync(d, { recursive: true })

// ---------------------------------------------------------------- the seeded files
writeLines(join(ORCH, 'CLAUDE.md'), '# Role: Session Orchestrator', '', 'Scratch orchestrator of the session-control tools test: do exactly what the prompt says.')
writeJson(join(ORCH, 'task-queue.json'), { tasks: [{ id: 'e2e-stale', title: 'E2E stale task', status: 'blocked' }, { id: 'e2e-fine', title: 'E2E fine task', status: 'queued' }, { id: 'e2e-free-wait', title: 'E2E free wait task', status: 'queued', waits_for: 'mod steps 1 to 4 complete' }] })
const RAISED = localDate(10)
writeJson(join(ORCH, 'open-points.json'), { points: [{ id: 'e2e-point', status: 'open', raised: RAISED, title: 'E2E open point about the parser', detail: 'Seeded by the test.', recommendation: 'Close it.' }] })
writeLines(join(ORCH, 'agreed-decisions.md'), '# Agreed decisions', '', '## E2E unit - branch feature/e2e-gone', '1. a decision of a closed unit')
writeLines(join(ORCH, 'open-points-archive.md'), '# Open points archive')
fs.writeFileSync(join(ORCH, 'backups', 'task-queue-before-queue-task-2026-01-01.json'), 'old\n')
touchAgo(join(ORCH, 'backups', 'task-queue-before-queue-task-2026-01-01.json'), 5 * 86400)
fs.writeFileSync(join(ORCH, 'backups', 'task-queue-before-queue-task-2026-01-09.json'), 'new\n')

const REPORT = `## Final report of the clean worker\nThe parser is done; 14 tests pass. A key ${CANARY} was found in an old fixture and is reported as an open point.`
writeJson(join(RUNS, 'clean.json'), { type: 'result', subtype: 'success', is_error: false, result: REPORT, total_cost_usd: 0.42, duration_ms: 312000, num_turns: 41 })
fs.writeFileSync(join(RUNS, 'clean.err'), '')
writeJson(join(RUNS, 'chatter.json'), { type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 7.2, duration_ms: 1800000, num_turns: 60 })
fs.writeFileSync(join(RUNS, '20250101000000-loose.json'), '{}\n')
touchAgo(join(RUNS, '20250101000000-loose.json'), 3 * 86400)

const transcript = (cwd, sid) => {
  const d = join(CFG, 'projects', sanitized(cwd))
  fs.mkdirSync(d, { recursive: true })
  return join(d, `${sid}.jsonl`)
}
const jsonl = (path, ...entries) => fs.writeFileSync(path, entries.map(e => JSON.stringify(e) + '\n').join(''))
const REAL = `E2E-REAL-REPORT-MARKER: the suite was rewritten and every case passes; the branch is pushed to both remotes. The token ${CANARY} sat in .env.example and is reported. ${'More detail of the real report. '.repeat(6)}`
const T_CHATTER = transcript(join(S, 'work-chatter'), SID_CHATTER)
jsonl(T_CHATTER,
  { type: 'user', timestamp: iso(NOW - 1800), message: { content: 'Do the work.' } },
  { type: 'assistant', timestamp: iso(NOW - 1790), message: { id: 'm1', content: [{ type: 'text', text: 'Starting.' }] } },
  { type: 'assistant', timestamp: iso(NOW - 1700), message: { id: 'm2', content: [{ type: 'text', text: REAL }] } },
  { type: 'user', timestamp: iso(NOW - 1690), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '<task-notification>done</task-notification>' }] } },
  { type: 'assistant', timestamp: iso(NOW - 1680), message: { id: 'm3', content: [{ type: 'text', text: 'Done.' }] } })
const T_CLEAN = transcript(join(S, 'work-clean'), SID_CLEAN)
jsonl(T_CLEAN, { type: 'user', timestamp: iso(NOW - 7200), message: { content: 'Go.' } })
// The writer's transcript starts 10 minutes ago and edits a helper file of the orchestrator directory.
const T_WRITER = transcript(S, SID_WRITER)
jsonl(T_WRITER,
  { type: 'user', timestamp: iso(NOW - 600), message: { content: 'Write things.' } },
  { type: 'assistant', timestamp: iso(NOW - 590), message: { id: 'w1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: join(ORCH, 'open-points.json'), old_string: 'a', new_string: 'b' } }] } })
// Under the writer's cwd: one file before its start, one after, one inside a .git folder.
fs.writeFileSync(join(S, 'work', 'old.txt'), 'x\n')
touchAgo(join(S, 'work', 'old.txt'), 3600)
fs.writeFileSync(join(S, 'work', 'new.txt'), 'x\n')
fs.writeFileSync(join(S, '.git', 'index'), 'x\n')

writeJson(REG, [
  { title: 'e2e clean worker', session_id: SID_CLEAN, name: 'w-e2e-clean-1', config_dir: CFG, cwd: join(S, 'work-clean'), model: 'haiku', effort: 'low',
    reported: true, result_file: join(RUNS, 'clean.json'), err_file: join(RUNS, 'clean.err'), started_at: NOW - 7200, ended_at: NOW - 6900,
    outcome: { kind: 'clean', summary: 'clean: The parser is done; 14 tests pass.', costUsd: 0.42 } },
  { title: 'e2e chatter worker', session_id: SID_CHATTER, config_dir: CFG, cwd: join(S, 'work-chatter'), model: 'sonnet', effort: 'medium',
    reported: false, result_file: join(RUNS, 'chatter.json'), started_at: NOW - 1800, ended_at: NOW - 1600,
    outcome: { kind: 'chatter', summary: 'chatter: short result "Done." after a substantial run', costUsd: 7.2 } },
  { title: 'e2e writer', session_id: SID_WRITER, config_dir: CFG, cwd: S, model: 'opus', effort: 'high', reported: true, keep: true, started_at: NOW - 600, ended_at: NOW - 300 },
])

const SETTINGS = scratchSettings(ORCH, REG, RUNS)
fs.writeFileSync(join(S, 'instruction.txt'),
  "This is an automated test of the session-control mod's read-only tools. Use no other tool than these six, each exactly once, in this order (you may call them all in one turn):\n" +
  '1. mcp__session-control__list_sessions with no input.\n' +
  `2. mcp__session-control__read_result with session_id "${SID_CHATTER}".\n` +
  `3. mcp__session-control__worker_tail with session_id "${SID_CHATTER}" and lines 5.\n` +
  `4. mcp__session-control__session_writes with session_id "${SID_WRITER}".\n` +
  '5. mcp__session-control__panel_snapshot with no input.\n' +
  '6. mcp__session-control__audit_state with no input.\n' +
  'Then answer with the six outputs verbatim, each after a line "=== <tool name> ===" (the short name, for example "=== list_sessions ==="), and nothing else.\n')

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

// Each tool's output as the tool returned it, from the transcript's tool_result of its first call.
const outPath = t => join(S, `out-${t}.txt`)
const out = t => {
  const call = toolUses(entries).find(c => c.name === `mcp__session-control__${t}`)
  if (!call?.id) return false
  fs.writeFileSync(outPath(t), resultText(entries, call.id))
  return byteSize(outPath(t)) > 0
}
const has = (t, text) => grepF(readOr(outPath(t)), text)
const check = (t, text, what) => (has(t, text) ? pass(`${t}: ${what}`) : fail(`${t}: ${what} (missing: ${text})`))
const lacks = (t, text, what) => (has(t, text) ? fail(`${t}: ${what} (found: ${text})`) : pass(`${t}: ${what}`))
const TOOLS = ['list_sessions', 'read_result', 'worker_tail', 'session_writes', 'panel_snapshot', 'audit_state']
for (const t of TOOLS) {
  if (out(t)) pass(`${t} was called and answered (${byteSize(outPath(t))} bytes)`)
  else {
    fail(`${t} was called and answered`)
    fs.writeFileSync(outPath(t), '')
  }
}
info(`tool calls of the orchestrator: ${callCounts(entries)}`)

// ---------------------------------------------------------------- each output against the seeded data
check('list_sessions', 'session rows:', 'the count line comes first')
if (/session rows*:/.test(firstLine(readOr(outPath('list_sessions'))))) pass('list_sessions: the first line is the count')
else fail('list_sessions: the first line is the count')
check('list_sessions', `- finished | e2e clean worker | session_id ${SID_CLEAN} | name w-e2e-clean-1 | pid - | elapsed 5m00s | model haiku/low | cwd ${S}/work-clean | config_dir ${CFG} | outcome clean (clean: The parser is done; 14 tests pass.) | cost USD 0.42`, 'the clean row with every field')
check('list_sessions', `- finished-unreported | e2e chatter worker | session_id ${SID_CHATTER} |`, 'the chatter row, finished-unreported')
check('list_sessions', `| e2e writer | session_id ${SID_WRITER} |`, 'the writer row')
lacks('list_sessions', `| cwd ${ORCH} | config_dir `, 'the orchestrator itself is no orphan row (its cwd is an e2e scratch orch directory)')

check('read_result', 'source: the transcript, its last substantial assistant message', 'the chatter fallback reads the transcript')
check('read_result', 'because the result file .result is chatter (Done.)', 'it says why')
check('read_result', 'outcome: chatter: short result "Done." after a substantial run', 'the outcome label')
check('read_result', 'run: cost USD 7.20, duration 30m00s, turns 60, is_error false, subtype success', 'cost, duration, turns, is_error, subtype')
check('read_result', 'redaction: 1 replacement', 'the redaction count')
check('read_result', 'E2E-REAL-REPORT-MARKER', 'the real report, not the chatter')
check('read_result', 'truncated: no', 'no truncation said')

check('worker_tail', `worker_tail for session ${SID_CHATTER}`, 'the session named')
check('worker_tail', 'process: not alive (no pid recorded', 'the process state')
check('worker_tail', ' s ago', 'the transcript age in seconds')
check('worker_tail', 'last 4 lines (of 5 asked)', 'the summarised lines, as many as there are')
check('worker_tail', '  < <task-notification>done</task-notification>', 'a tool result as the log pane shows it')

check('session_writes', `since: ${iso(NOW - 600).replace(/\.000Z$/, 'Z')} (the transcript's first timestamp`, 'the start is the first transcript timestamp')
check('session_writes', `  ${ORCH}/task-queue.json  [ORCHESTRATOR DIR]`, 'a helper file under the orchestrator directory is flagged')
check('session_writes', `  ${REG}  [REGISTRY]`, 'the registry is flagged')
check('session_writes', `  ${S}/work/new.txt`, 'a file written after the start is listed')
lacks('session_writes', `${S}/work/old.txt`, 'a file older than the start is not')
lacks('session_writes', `${S}/.git/`, 'nothing under .git')
check('session_writes', `- Edit of ${ORCH}/open-points.json`, "the transcript's own write under the orchestrator directory")

check('panel_snapshot', 'SESSIONS', 'the sessions section')
check('panel_snapshot', 'e2e chatter worker', 'a session row')
check('panel_snapshot', 'QUEUED WORK', 'the queued work section')
check('panel_snapshot', `${String.fromCodePoint(0x2022)} E2E fine task`, 'the fine task')
lacks('panel_snapshot', 'E2E stale task', 'the stale task (status blocked) is not queued work')
check('panel_snapshot', '1. E2E open point about the parser', 'the open point')

check('audit_state', 'nothing was changed.', 'the count line')
check('audit_state', '[high] queue-status | task e2e-stale "E2E stale task" | status "blocked" is not exactly queued, running or done', 'the stale queue entry')
lacks('audit_state', 'task e2e-fine', 'the fine queue entry is no finding')
check('audit_state', '[medium] queued-free-wait | task e2e-free-wait "E2E free wait task" | waits_for "mod steps 1 to 4 complete": names no registry session (by session id, its first 8 characters or its name)', 'the queued task waiting on free text')
check('audit_state', `[medium] unacknowledged | session ${shortId(SID_CHATTER)} "e2e chatter worker"`, 'the unacknowledged chatter session')
check('audit_state', `[medium] retirable | session ${shortId(SID_CLEAN)} "e2e clean worker"`, 'the retirable clean session')
check('audit_state', '[medium] open-point-old | open point e2e-point', 'the open point raised ten days ago')
check('audit_state', '[low] backups | backups of kind task-queue-before-queue-task.json | 2 files; 1 is older than 2 days besides the newest', 'the spent backup')
check('audit_state', '20250101000000-loose.json', 'the run file no entry names')
check('audit_state', '"E2E unit - branch feature/e2e-gone"', 'the decision section of a closed unit')
lacks('audit_state', 'git-', 'git is silent: the scratch directory is no repository')

// ---------------------------------------------------------------- no secret anywhere; the trace keeps no report text
const outFiles = () => fs.readdirSync(S).filter(name => /^out-.*\.txt$/.test(name)).sort().map(name => join(S, name))
const LEAK = [...outFiles(), join(S, 'orchestrator.json'), TRACE].filter(f => readOr(f).includes(CANARY)).map(f => basename(f))
if (LEAK.length === 0) pass('the canary secret is in no output, no answer and no trace line')
else fail(`the canary secret leaked into: ${LEAK.join(' ')}`)
const trace = readOr(TRACE)
if (trace.includes('E2E-REAL-REPORT-MARKER')) fail('the trace holds no report text')
else pass('the trace holds no report text')
if (trace.includes('"event":"tool.result","tool":"read_result","resultChars":')) pass('the trace has the length of the answer only')
else fail('the trace has the length of the answer only')
const { major } = nodeMajor()
if (major !== undefined && major >= 22) {
  if (trace.includes('"event":"process.run","helper":"filesNewerThan"') && !trace.includes('"event":"helper.failed"')) pass('the listing ran through the Node helper, no failed call')
  else fail('the listing ran through the Node helper, no failed call')
}
// The answer: the six outputs verbatim, each after its line.
const answer = typeof ojson?.result === 'string' ? ojson.result : ''
fs.writeFileSync(join(S, 'answer.txt'), answer + '\n')
let N = 0
for (const t of TOOLS) {
  if (new RegExp(`=== (mcp__session-control__)?${t} ===`).test(answer) && answer.includes(firstLine(readOr(outPath(t))))) N++
}
if (N === 6) pass('the answer gives the six outputs, each after its line')
else info(`the answer gives ${N} of the six outputs with their first line verbatim (the model's copy, not the tools')`)
// Nothing changed by the tools: the seeded helper files are as written (the mod creates none: all are there).
if (readJson(join(ORCH, 'task-queue.json'))?.tasks?.length === 3 && readJson(REG)?.length === 3 && fs.readdirSync(join(ORCH, 'backups')).length === 2) pass('the queue, the registry and backups/ are as seeded')
else fail('the queue, the registry and backups/ are as seeded')
if (process.env.KEEP_OUT && keepOut(process.env.KEEP_OUT, [{ files: [...globIn(S, /^out-.*\.txt$/, 'out-*.txt'), join(S, 'answer.txt')] }], false)) {
  info(`outputs copied to ${process.env.KEEP_OUT}`)
}

const LEFT = processesNaming(S)
if (!LEFT) pass('no process names the scratch directory')
else fail(`no process names the scratch directory: ${LEFT}`)
finish(S)
