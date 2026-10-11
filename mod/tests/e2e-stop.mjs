#!/usr/bin/env node
// The Node port of e2e-stop.sh, which stays beside it: the same checks, the same lines, the same options. Run with
// `node mod/tests/e2e-stop.mjs` (Node 22 or newer); no sh, grep, tr, sed, jq or cygpath is needed.
//
// End-to-end test of stop_worker against the real claude, in a scratch directory it makes and removes. A headless haiku
// orchestrator (capped at --max-budget-usd 0.25) launches one haiku worker through launch_worker whose task is to run
// foreground `sleep 20` calls for a few minutes, waits in the foreground until the scratch registry shows the worker
// alive with a `sleep` below it (the tree is recorded from /proc at that moment, with each start time), calls stop_worker
// on it, then on an unknown id and on a finished entry (both refused), and answers. From outside, /proc must show the
// worker pid and every process of its tree gone (or its pid with another start), while a bystander sleep of this script,
// the orchestrator itself and every other claude process alive before the stop are still there. The proof text the
// tool answered is read from the orchestrator's transcript and checked, and kept for the report with KEEP_OUT=<dir>.
// Everything the mod reads or writes is in the scratch directory (registry, helper files, runs directory, trace); the
// real registry is never touched and the licence picker option is empty: the worker inherits the default
// configuration, where both transcripts stay. Linux /proc is required, as for the shell script: elsewhere the run
// fails at once. One line per check; exit 1 on a failure. Only this run's own processes are ever signalled: the
// worker's tree as recorded, each only while it still has its recorded start, and the bystander likewise.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import {
  CFG_DEFAULT, HAS_PROC, MOD, awaitOrchestrator, basename, byteSize, callCounts, entriesOf, finish, isErrorFalse, join, kit,
  linesOf, nodeCommand, ours, procPids, processesNaming, readJson, readOr, removeTree, requireClaude, resultText, scratch, scratchSettings,
  signal, startClaude, startOf, toolUses, transcriptOf, writeJson, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, info } = kit
const CLAUDE = requireClaude()
if (!HAS_PROC) {
  fail('Linux /proc')
  process.exit(1)
}
let orch
let BYSTANDER = ''
let BYSTANDER_START = ''
const S = scratch('session-control-e2e-stop', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  // The worker's tree as recorded, only while each pid still has its recorded start (never another process).
  for (const line of linesOf(readOr(join(dir, 'tree-before.txt')))) {
    const [p, st] = line.split(' ')
    if (p && st && startOf(p) === st) signal(p, 'SIGKILL')
  }
  if (BYSTANDER && startOf(BYSTANDER) === (BYSTANDER_START || 'x')) signal(BYSTANDER)
  removeTree(dir)
})
const ORCH = join(S, 'orch')
const WORK = join(S, 'work')
const RUNS = join(S, 'runs')
const REG = join(S, 'headless-sessions.json')
const TRACE = join(RUNS, 'trace.log')

for (const d of [ORCH, WORK, RUNS]) fs.mkdirSync(d, { recursive: true })
writeLines(join(ORCH, 'CLAUDE.md'), '# Role: Session Orchestrator', '', 'Scratch orchestrator of the session-control stop_worker test: do exactly what the prompt says.')
writeLines(join(ORCH, 'agreed-decisions.md'), '# Agreed decisions')
writeJson(join(ORCH, 'task-queue.json'), { tasks: [] })
writeJson(join(ORCH, 'open-points.json'), { points: [] })
writeLines(join(ORCH, 'open-points-archive.md'), '# Open points archive')
const FIN = '5f5f5f5f-0005-4005-8005-000000000005'
writeJson(REG, [{ title: 'e2e finished entry', session_id: FIN, config_dir: CFG_DEFAULT, cwd: WORK, reported: true, outcome: { kind: 'clean', summary: 'clean: seeded' } }])

// A bystander of this script's own, outside every tree the stop sees.
const bystander = spawn('sleep', ['900'], { stdio: 'ignore' })
BYSTANDER = String(bystander.pid)
BYSTANDER_START = startOf(BYSTANDER)

// Waits until the worker is alive with a sleep below it, then records its tree (pid, start, name per line), the claude
// processes alive at that moment, and prints the worker's pid. A pid of the tree whose start cannot be read when it is
// recorded has ended meanwhile: it is no member of the tree and goes to tree-dropped.txt instead. The worker itself
// must still have its start, or the wait fails.
fs.writeFileSync(join(S, 'wait-alive.mjs'),
  "import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'\n" +
  "import { join } from 'node:path'\n" +
  'const [reg, out] = process.argv.slice(2)\n' +
  'const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)\n' +
  "const read = path => { try { return readFileSync(path, 'utf8') } catch { return '' } }\n" +
  "const startOf = p => { const s = read(`/proc/${p}/stat`); return s ? (s.slice(s.lastIndexOf(') ') + 2).split(' ')[19] ?? '') : '' }\n" +
  "const comm = p => read(`/proc/${p}/comm`).replace(/\\n$/, '')\n" +
  "const pids = () => readdirSync('/proc').filter(n => /^[0-9]+$/.test(n)).sort()\n" +
  "const kids = p => pids().filter(d => (/^PPid:\\s*(\\d+)/m.exec(read(`/proc/${d}/status`)) ?? [])[1] === p)\n" +
  'const tree = p => [p, ...kids(p).flatMap(tree)]\n' +
  'let n = 0\n' +
  'let pid\n' +
  'let t = []\n' +
  'for (;;) {\n' +
  "  n++; if (n > 120) { console.log('the worker never showed a sleep'); process.exit(1) }\n" +
  "  try { pid = String(JSON.parse(read(reg)).filter(e => e?.title === 'e2e sleeper').at(-1)?.pid ?? '') } catch { pid = '' }\n" +
  "  if (pid && existsSync(`/proc/${pid}`)) { t = tree(pid); if (t.some(p => comm(p) === 'sleep')) break }\n" +
  '  pause(2000)\n' +
  '}\n' +
  'const rec = t.map(p => [p, startOf(p)])\n' +
  "writeFileSync(join(out, 'tree-dropped.txt'), rec.filter(([, st]) => !st).map(([p]) => `${p}\\n`).join(''))\n" +
  "writeFileSync(join(out, 'tree-before.txt'), rec.filter(([, st]) => st).map(([p, st]) => `${p} ${st} ${comm(p)}\\n`).join(''))\n" +
  "if (!rec.some(([p, st]) => p === pid && st)) { console.log(`the worker pid ${pid} ended while its tree was recorded`); process.exit(1) }\n" +
  "writeFileSync(join(out, 'claude-before.txt'), pids().filter(p => comm(p) === 'claude').map(p => `${p} ${startOf(p)} ${read(`/proc/${p}/cmdline`).replace(/[\\0\\n\\t]/g, ' ').split(' ').slice(0, 3).join(' ')}\\n`).join(''))\n" +
  'console.log(`worker pid ${pid} is alive with ${rec.filter(([, st]) => st).length} processes in its tree, a sleep among them`)\n')
const SETTINGS = scratchSettings(ORCH, REG, RUNS)
const WORKER_PROMPT = `This is a process test, scratch directory ${S}. Run the Bash command: sleep 20 (in the foreground, with a timeout of 60000 ms), and when it ends run it again, twelve times in all, one call after the other. Do nothing else and write no file. When all twelve are done answer with the word done.`
fs.writeFileSync(join(S, 'instruction.txt'),
  "This is an automated test of the session-control mod's stop_worker tool. Do exactly these steps, one after the other, and nothing else:\n" +
  `1. Call mcp__session-control__launch_worker once with exactly these inputs and no others: dir "${WORK}", model "haiku", effort "low", title "e2e sleeper", timeout_minutes 10, prompt "${WORKER_PROMPT}". Give no prompt_file, no section and no rules.\n` +
  `2. Run this one Bash command in the foreground, with a timeout of 300000 ms, and wait for it to finish: ${nodeCommand(join(S, 'wait-alive.mjs'), REG, S)}\n` +
  '3. Call mcp__session-control__stop_worker with session_id set to the full session id the launch tool returned in step 1 and reason "e2e stop test".\n' +
  '4. Call mcp__session-control__stop_worker with session_id "deadbeef".\n' +
  `5. Call mcp__session-control__stop_worker with session_id "${FIN}".\n` +
  'Then answer with one line: done.\n')

// The worker's descendants seen from outside after the tree was recorded, until the orchestrator has ended: about three
// times a second /proc is read, and a process whose parent is a member is a member (the members to start from: every
// recorded or already seen pid that still has its start). The new members go to treeSeen (pid to start). A signal of
// the proof to a pid outside the recorded tree is excused only when this watch saw that pid in the tree: a child the
// worker spawned after the recording.
const treeSeen = new Map()
const watchTree = () => {
  const recorded = new Map(linesOf(readOr(join(S, 'tree-before.txt'))).map(l => l.split(' ')).filter(([p, st]) => p && st).map(([p, st]) => [p, st]))
  if (recorded.size === 0) return
  const stat = new Map()
  for (const p of procPids()) {
    const s = readOr(`/proc/${p}/stat`)
    if (!s) continue
    const f = s.slice(s.lastIndexOf(') ') + 2).split(' ')
    stat.set(p, { ppid: f[1], start: f[19] })
  }
  const members = new Set([...recorded, ...treeSeen].filter(([p, st]) => stat.get(p)?.start === st).map(([p]) => p))
  for (let grown = true; grown; ) {
    grown = false
    for (const [p, { ppid }] of stat) if (!members.has(p) && members.has(ppid)) members.add(p), (grown = true)
  }
  for (const p of members) if (!recorded.has(p) && !treeSeen.has(p)) treeSeen.set(p, stat.get(p).start)
}
const watcher = setInterval(watchTree, 300)
orch = startClaude({
  claude: CLAUDE,
  cwd: ORCH,
  args: ['-p', '--plugin-dir', MOD, '--model', 'haiku', '--dangerously-skip-permissions', '--max-budget-usd', '0.25', '--output-format', 'json', '--settings', SETTINGS],
  stdin: join(S, 'instruction.txt'),
  stdout: join(S, 'orchestrator.json'),
  stderr: join(S, 'orchestrator.err'),
  env: { SESSION_CONTROL_DEBUG: '1' },
})
await awaitOrchestrator(orch, { limit: 540, dir: S, isOk: () => isErrorFalse(join(S, 'orchestrator.json')) })
clearInterval(watcher)
fs.writeFileSync(join(S, 'tree-seen.txt'), [...treeSeen].map(([p, st]) => `${p} ${st}\n`).join(''))
const OPID_DONE = String(orch.pid)
const ojson = readJson(join(S, 'orchestrator.json'))
const OSID = typeof ojson?.session_id === 'string' ? ojson.session_id : ''
info(`orchestrator cost USD ${ojson?.total_cost_usd ?? '?'}, session ${OSID} (config dir ${CFG_DEFAULT}, cwd ${ORCH})`)
const OT = transcriptOf(CFG_DEFAULT, OSID)
if (OSID && OT) pass(`orchestrator transcript found (${OT})`)
else fail(`orchestrator transcript found (session '${OSID}')`)
const entries = entriesOf(OT)

// The output of the n-th call of a tool, from the transcript's tool_result of that call.
const outPath = label => join(S, `out-${label}.txt`)
const out = (tool, n, label) => {
  const id = toolUses(entries).filter(c => c.name === tool)[n - 1]?.id
  if (!id) return false
  fs.writeFileSync(outPath(label), resultText(entries, id))
  return byteSize(outPath(label)) > 0
}
const has = (label, text) => readOr(outPath(label)).includes(text)
const check = (label, text, what) => (has(label, text) ? pass(`${label}: ${what}`) : fail(`${label}: ${what} (missing: ${text})`))
for (const [tool, n, label] of [['mcp__session-control__launch_worker', 1, 'launch'], ['Bash', 1, 'wait'], ['mcp__session-control__stop_worker', 1, 'stop'], ['mcp__session-control__stop_worker', 2, 'unknown'], ['mcp__session-control__stop_worker', 3, 'finished']]) {
  if (out(tool, n, label)) pass(`${label}: ${tool} call ${n} was made and answered (${byteSize(outPath(label))} bytes)`)
  else {
    fail(`${label}: ${tool} call ${n} was made and answered`)
    fs.writeFileSync(outPath(label), '')
  }
}
info(`tool calls of the orchestrator: ${callCounts(entries)}`)

// ---------------------------------------------------------------- the worker and its tree before the stop
check('wait', 'is alive with', 'the worker was alive with a sleep below it before the stop')
const treeBefore = linesOf(readOr(join(S, 'tree-before.txt')))
const WPID = (treeBefore[0] ?? '').split(' ')[0]
const WSID = String((readJson(REG) ?? []).filter?.(e => e?.title === 'e2e sleeper').at(-1)?.session_id ?? '')
info(`worker session ${WSID}, pid ${WPID} (config dir ${CFG_DEFAULT}, cwd ${WORK}); tree before the stop: ${treeBefore.map(l => l + ';').join('')}`)
const dropped = linesOf(readOr(join(S, 'tree-dropped.txt')))
info(`${dropped.length} pids of the tree had no readable start when it was recorded (they had ended): dropped from the recorded set${dropped.length ? `: ${dropped.join(' ')}` : ''}`)
check('launch', `Launched pid ${WPID}, session ${WSID}`, 'the launch registered the worker the tree was read from')

// ---------------------------------------------------------------- the proof
check('stop', `stop_worker: session ${WSID} "e2e sleeper"`, 'the proof names the session')
check('stop', `, pid ${WPID}.`, 'and the pid')
check('stop', 'Reason given: e2e stop test', 'the reason')
check('stop', `Abort check before: alive: ${CFG_DEFAULT}/sessions/${WPID}.json names session ${WSID} with procStart`, 'the Abort check before: alive, by the sessions file and /proc')
check('stop', 'Descendants listed before the first signal (', 'the descendants listed before the first signal')
check('stop', `SIGTERM to ${WPID} (claude): exit code 0`, 'SIGTERM to the worker, with its time')
check('stop', `Abort check after: dead: pid ${WPID} is gone (no /proc/${WPID}).`, 'the Abort check after: dead')
check('stop', `Result: pid ${WPID} is dead`, 'the result')
check('stop', 'Surviving descendants: none.', 'no survivor')
check('stop', 'The registry is unchanged', 'no registry field written')
// Every signal went to a pid of the tree recorded before the stop, or to a child the worker spawned after the recording
// that the outside watch saw in its tree (such a pid is not required dead either); any other pid is a stray signal.
const stopLines = linesOf(readOr(outPath('stop')))
const treePids = new Set(treeBefore.map(l => l.split(' ')[0]))
const signalled = stopLines.filter(l => /^- [0-9TZ:.-]+ (SIGTERM|SIGKILL) to [0-9]+/.test(l)).map(l => /^.* to ([0-9]+).*$/.exec(l)[1])
const LATE = [...new Set(signalled.filter(p => !treePids.has(p) && treeSeen.has(p)))]
const STRAY = signalled.filter(p => !treePids.has(p) && !treeSeen.has(p))
info(`signalled pids outside the recorded tree that the outside watch saw in the worker's tree after the recording (not required dead, not stray): ${LATE.length ? LATE.join(' ') : 'none'}`)
if (STRAY.length === 0) pass(`every signal of the proof went to a process of the worker's tree (${stopLines.filter(l => /SIG(TERM|KILL) to/.test(l)).length} signals)`)
else fail(`a signal went outside the recorded tree: ${STRAY.join(' ')}`)

// ---------------------------------------------------------------- /proc from outside
const LEFT = treeBefore
  .map(l => l.split(' '))
  .filter(([p, st]) => p && startOf(p) === st)
  .map(([p, , name]) => `${p}(${name})`)
if (LEFT.length === 0) pass(`/proc: the worker pid and every process of its tree are gone or have another start (${treeBefore.length} processes, ${treeBefore.filter(l => / sleep$/.test(l)).length} sleep)`)
else fail(`/proc: still there: ${LEFT.join(' ')}`)
if (startOf(BYSTANDER) === BYSTANDER_START) pass(`/proc: the bystander sleep ${BYSTANDER} of this script is untouched`)
else fail('/proc: the bystander sleep of this script is untouched')
// The orchestrator (the claude this script started) has ended by itself. Any other claude process alive before the
// stop is still there, or it was another session's run that ended on its own: it is named with the first three words
// of its command line as read before the stop (never its prompt), and no signal of the proof went to it (checked above).
const claudeBefore = linesOf(readOr(join(S, 'claude-before.txt')))
const MISSING = claudeBefore
  .map(l => [l.split(' ')[0], l.split(' ')[1], l.split(' ').slice(2).join(' ')])
  .filter(([p]) => !treePids.has(p) && p !== OPID_DONE)
  .filter(([p, st]) => startOf(p) !== st)
  .map(([p, , cmd]) => ` ${p} (${cmd});`)
  .join('')
if (claudeBefore.some(l => l.startsWith(`${OPID_DONE} `))) info(`the orchestrator ${OPID_DONE} was alive at the stop and has ended by itself since`)
if (!MISSING) pass(`/proc: every other claude process alive before the stop is still there (${claudeBefore.filter(l => l !== '').length} claude processes before, the worker and the orchestrator among them)`)
else info(`claude processes of other sessions alive before the stop and gone now (no signal of the proof went to them; they ended on their own):${MISSING}`)
const trace = readOr(TRACE)
if (linesOf(trace).some(l => /"guard".*"tool":"stop_worker".*"isOk":true/.test(l))) pass('the trace has the stop_worker guard line')
else fail('the trace has the stop_worker guard line')
if (trace.includes('e2e stop test')) fail('the trace does not hold the reason')
else pass('the trace does not hold the reason')

// ---------------------------------------------------------------- the refusals
check('unknown', 'no registry entry has the session id deadbeef', 'an unknown id is refused')
check('finished', `refused: session ${FIN} is not alive: its entry records no pid`, 'a finished entry is refused: not alive')
check('finished', 'nothing was signalled', 'and nothing is signalled')

if (process.env.KEEP_OUT) {
  const keep = process.env.KEEP_OUT
  fs.mkdirSync(keep, { recursive: true })
  const names = fs.readdirSync(S).filter(name => /^out-.*\.txt$/.test(name)).map(name => join(S, name))
  for (const f of [...names, join(S, 'tree-before.txt'), join(S, 'tree-dropped.txt'), join(S, 'tree-seen.txt'), join(S, 'claude-before.txt'), join(S, 'orchestrator.json'), TRACE]) {
    try {
      fs.copyFileSync(f, join(keep, basename(f)))
    } catch {}
  }
  info(`outputs copied to ${keep}`)
}
const STILL = processesNaming(S, 'e2e-stop')
if (!STILL) pass('no process names the scratch directory')
else fail(`no process names the scratch directory: ${STILL}`)
finish(S)
