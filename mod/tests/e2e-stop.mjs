#!/usr/bin/env node
// Run with `node mod/tests/e2e-stop.mjs` (Node 22 or newer), from any directory; no sh, grep, tr, sed, jq or cygpath is
// needed.
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
// configuration, where both transcripts stay. Linux /proc or native Windows is required: elsewhere the run
// fails at once. One line per check; exit 1 on a failure. Only this run's own processes are ever signalled: the
// worker's tree as recorded, each only while it still has its recorded start, and the bystander likewise.
//
// On native Windows the same run reads Win32_Process through Windows PowerShell (winProcs of lib/e2e.mjs; a start is
// the creation time in epoch ms, as the mod's own scripts compute it) for the tree, the outside watch and every check
// after the stop; the bystander is a node.exe of this script. The worker's `sleep 20` runs through Git Bash: an MSYS
// sleep.exe whose Windows parent (the fork that exec'd it) has exited, so it is in no Windows tree; it is recorded by
// its command line (`...sleep.exe" 20`) and a start after the worker's, never through the MSYS process table the mod
// reads, and its end is checked like the rest of the tree. The stop's proof is checked in its Windows words
// (taskkill /T /F at once, the creation-time Abort check, the MSYS table note). The orchestrator's Bash tool needs Git
// Bash (CLAUDE_CODE_GIT_BASH_PATH where Claude Code does not find it).

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import {
  CFG_DEFAULT, HAS_PROC, IS_WINDOWS, LIB_URL, MOD, awaitOrchestrator, byteSize, callCounts, entriesOf, finish, firstMatch, globIn, grepF, isErrorFalse, join, jqPick, keepOut, kit,
  linesOf, nodeCommand, ours, procPids, processesNaming, readJson, readOr, removeTree, requireClaude, resultText, scratch, scratchSettings,
  shown, signal, startClaude, startOf, toolUses, transcriptOf, winProcs, writeJson, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, info } = kit
const CLAUDE = requireClaude()
if (!HAS_PROC && !IS_WINDOWS) {
  fail('Linux /proc')
  process.exit(1)
}
let orch
let BYSTANDER = ''
let BYSTANDER_START = ''
const S = scratch('session-control-e2e-stop', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  // The worker's tree as recorded, only while each pid still has its recorded start (never another process).
  if (IS_WINDOWS) {
    const all = winProcs()
    for (const line of linesOf(readOr(join(dir, 'tree-before.txt')))) {
      const [p, st] = line.split(' ')
      if (p && st && all.get(p)?.start === st) spawnSync('taskkill.exe', ['/PID', p, '/F'], { windowsHide: true })
    }
    if (BYSTANDER && all.get(BYSTANDER)?.start === (BYSTANDER_START || 'x')) signal(BYSTANDER)
  } else {
    for (const line of linesOf(readOr(join(dir, 'tree-before.txt')))) {
      const [p, st] = line.split(' ')
      if (p && st && startOf(p) === st) signal(p, 'SIGKILL')
    }
    if (BYSTANDER && startOf(BYSTANDER) === (BYSTANDER_START || 'x')) signal(BYSTANDER)
  }
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

// A bystander of this script's own, outside every tree the stop sees (on Windows a node.exe that only waits).
const bystander = IS_WINDOWS ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 900000)'], { stdio: 'ignore', windowsHide: true }) : spawn('sleep', ['900'], { stdio: 'ignore' })
BYSTANDER = String(bystander.pid)
BYSTANDER_START = IS_WINDOWS ? (winProcs().get(BYSTANDER)?.start ?? '') : startOf(BYSTANDER)
const BYSTANDER_NAME = IS_WINDOWS ? 'node.exe' : 'sleep'

/**
 * The wait of step 2 on Windows, written to wait-alive.mjs (see below) and run by the orchestrator's Bash tool: the
 * registry's `e2e sleeper` pid alive with a sleep below it, then its tree, the claude.exe processes and the worker pid,
 * as the Linux wait records them. The tree is the worker's Windows tree (each child created after its parent: a dead
 * parent's pid may name another process now) and the MSYS sleep.exe of its Git Bash, told by its command line and by a
 * start after the worker's, since its Windows parent has exited.
 */
function waitAliveOnWindows(reg, out, { jqPick, winProcs, readFileSync, writeFileSync, join }) {
  const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const read = path => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  const treeOf = (all, root) => {
    const tree = [root]
    for (let at = 0; at < tree.length; at++) {
      for (const [p, one] of all) if (one.ppid === tree[at] && !tree.includes(p) && Number(one.start) >= Number(all.get(tree[at])?.start ?? Infinity)) tree.push(p)
    }
    return tree
  }
  const isSleep = one => one.name.toLowerCase() === 'sleep.exe'
  const isWorkerSleep = (one, after) => isSleep(one) && /sleep(\.exe)?"?\s+20$/i.test(one.cmd.trim()) && Number(one.start) >= after
  let pid = ''
  let all = new Map()
  let rec = []
  for (let n = 1; ; n++) {
    if (n > 120) {
      console.log('the worker never showed a sleep')
      process.exit(1)
    }
    try {
      pid = String(jqPick(JSON.parse(read(reg)), 'e2e sleeper', 'pid') ?? '')
    } catch {
      pid = ''
    }
    all = pid ? winProcs() : new Map()
    const root = all.get(pid)
    if (root !== undefined) {
      const tree = treeOf(all, pid)
      const sleeps = [...all].filter(([p, one]) => !tree.includes(p) && isWorkerSleep(one, Number(root.start))).map(([p]) => p)
      if (sleeps.length > 0 || tree.some(p => isSleep(all.get(p)))) {
        rec = [...tree, ...sleeps]
        break
      }
    }
    pause(2000)
  }
  writeFileSync(join(out, 'tree-dropped.txt'), rec.filter(p => !all.get(p)?.start).map(p => `${p}\n`).join(''))
  writeFileSync(join(out, 'tree-before.txt'), rec.filter(p => all.get(p)?.start).map(p => `${p} ${all.get(p).start} ${all.get(p).name}\n`).join(''))
  writeFileSync(join(out, 'claude-before.txt'), [...all].filter(([, one]) => one.name.toLowerCase() === 'claude.exe').map(([p, one]) => `${p} ${one.start} ${one.cmd.split(' ').slice(0, 3).join(' ')}\n`).join(''))
  console.log(`worker pid ${pid} is alive with ${rec.length} processes in its tree, a sleep among them`)
}

// Waits until the worker is alive with a sleep below it, then records its tree (pid, start, name per line), the claude
// processes alive at that moment, and prints the worker's pid. A pid of the tree whose start cannot be read when it is
// recorded has ended meanwhile: it is no member of the tree and goes to tree-dropped.txt instead. The worker itself
// must still have its start, or the wait fails. On Windows the same records come from waitAliveOnWindows.
const WAIT_ON_WINDOWS = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  `import { jqPick, winProcs } from ${JSON.stringify(LIB_URL)}`,
  `;(${waitAliveOnWindows.toString()})(process.argv[2], process.argv[3], { jqPick, winProcs, readFileSync, writeFileSync, join })`,
  '',
].join('\n')
fs.writeFileSync(join(S, 'wait-alive.mjs'), IS_WINDOWS ? WAIT_ON_WINDOWS :
  "import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'\n" +
  "import { join } from 'node:path'\n" +
  `import { jqPick } from ${JSON.stringify(LIB_URL)}\n` +
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
  "  try { pid = jqPick(JSON.parse(read(reg)), 'e2e sleeper', 'pid') } catch { pid = '' }\n" +
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
// recorded or already seen pid that still has its start). The new members go to treeSeen (pid to start). A recorded or
// seen pid found with another start (another process now has the pid) goes to treeReused ("pid start"). A signal of the
// proof to a pid outside the recorded tree is excused only when this watch saw that pid in the tree, a child the worker
// spawned after the recording, and the signalled process had the start the watch saw (see lateOk).
const treeSeen = new Map()
const treeReused = new Set()
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
  for (const [p, st] of [...recorded, ...treeSeen]) if (stat.has(p) && stat.get(p).start !== st) treeReused.add(`${p} ${stat.get(p).start}`)
}
// The same watch on Windows, from one Win32_Process snapshot every 2 s (a PowerShell start takes about a second): a
// process whose parent is a member and which was created after it is a member, and so is a later MSYS sleep.exe of the
// worker's Git Bash (`...sleep.exe" 20`, created after the worker, the worker still alive), whose Windows parent has
// exited. A child that comes and goes between two snapshots is not seen: a signal to it counts as stray (a failure,
// never a pass).
const watchTreeOnWindows = () => {
  const lines = linesOf(readOr(join(S, 'tree-before.txt'))).map(l => l.split(' ')).filter(([p, st]) => p && st)
  const recorded = new Map(lines.map(([p, st]) => [p, st]))
  if (recorded.size === 0) return
  const [rootPid, rootStart] = lines[0] ?? []
  const all = winProcs()
  const members = new Set([...recorded, ...treeSeen].filter(([p, st]) => all.get(p)?.start === st).map(([p]) => p))
  for (let grown = true; grown; ) {
    grown = false
    for (const [p, one] of all) if (!members.has(p) && members.has(one.ppid) && Number(one.start) >= Number(all.get(one.ppid)?.start ?? Infinity)) members.add(p), (grown = true)
  }
  if (all.get(rootPid)?.start === rootStart) {
    for (const [p, one] of all) if (!members.has(p) && one.name.toLowerCase() === 'sleep.exe' && /sleep(\.exe)?"?\s+20$/i.test(one.cmd.trim()) && Number(one.start) >= Number(rootStart)) members.add(p)
  }
  for (const p of members) if (!recorded.has(p) && !treeSeen.has(p)) treeSeen.set(p, all.get(p).start)
  for (const [p, st] of [...recorded, ...treeSeen]) if (all.has(p) && all.get(p).start !== st) treeReused.add(`${p} ${all.get(p).start}`)
}
const watcher = IS_WINDOWS ? setInterval(watchTreeOnWindows, 2000) : setInterval(watchTree, 300)
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
fs.writeFileSync(join(S, 'tree-reused.txt'), [...treeReused].map(line => `${line}\n`).join(''))
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
const has = (label, text) => grepF(readOr(outPath(label)), text)
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
const WSID = jqPick(readJson(REG), 'e2e sleeper', 'session_id')
info(`worker session ${WSID}, pid ${WPID} (config dir ${CFG_DEFAULT}, cwd ${WORK}); tree before the stop: ${treeBefore.map(l => l + ';').join('')}`)
const dropped = linesOf(readOr(join(S, 'tree-dropped.txt')))
info(`${dropped.length} pids of the tree had no readable start when it was recorded (they had ended): dropped from the recorded set${dropped.length ? `: ${dropped.join(' ')}` : ''}`)
check('launch', `Launched pid ${WPID}, session ${WSID}`, 'the launch registered the worker the tree was read from')

// ---------------------------------------------------------------- the proof
check('stop', `stop_worker: session ${WSID} "e2e sleeper"`, 'the proof names the session')
check('stop', `, pid ${WPID}.`, 'and the pid')
check('stop', 'Reason given: e2e stop test', 'the reason')
if (IS_WINDOWS) check('stop', `Abort check before: alive: ${shown(CFG_DEFAULT)}/sessions/${WPID}.json names session ${WSID} with its startedAt matches the process creation time `, 'the Abort check before: alive, by the sessions file and Win32_Process')
else check('stop', `Abort check before: alive: ${CFG_DEFAULT}/sessions/${WPID}.json names session ${WSID} with procStart`, 'the Abort check before: alive, by the sessions file and /proc')
check('stop', 'Descendants listed before the first signal (', 'the descendants listed before the first signal')
if (IS_WINDOWS) {
  // Windows: taskkill /T /F at once (a console process without a window refuses taskkill without /F), and the program
  // the worker runs through Git Bash found by the MSYS process table.
  check('stop', `taskkill /PID ${WPID} /T /F to ${WPID} (claude.exe): exit code 0`, 'taskkill /T /F to the worker at once, with its time')
  if (!linesOf(readOr(outPath('stop'))).some(l => /taskkill \/PID [0-9]+ \/T to /.test(l))) pass('no taskkill without /F was sent')
  else fail('no taskkill without /F was sent')
  check('stop', ' (Git Bash) was read before the first signal: ', "the MSYS process table of the worker's Git Bash was read before the first signal")
  check('stop', '(sleep.exe), MSYS parent ', "the worker's Git Bash sleep is among the descendants, by its MSYS parent")
} else check('stop', `SIGTERM to ${WPID} (claude): exit code 0`, 'SIGTERM to the worker, with its time')
check('stop', IS_WINDOWS ? `Abort check after: dead: no process has pid ${WPID}.` : `Abort check after: dead: pid ${WPID} is gone (no /proc/${WPID}).`, 'the Abort check after: dead')
check('stop', `Result: pid ${WPID} is dead`, 'the result')
check('stop', 'Surviving descendants: none.', 'no survivor')
check('stop', 'The registry is unchanged', 'no registry field written')
// Every signal went to a pid of the tree recorded before the stop, or to a child the worker spawned after the recording
// that the outside watch saw in its tree (such a pid is not required dead either); any other pid is a stray signal.
// A late pid counts by its start, not its number alone (lateOk): the watch saw it with a start and never saw that pid
// with another, the signal was not sent before that start (the start's wall time from btime and the clock ticks, 2 s
// allowed for btime's whole seconds; on Windows the start is that wall time in ms, 2 s allowed alike), and the pid is
// gone now or still has that start.
const stopLines = linesOf(readOr(outPath('stop')))
const treePids = new Set(treeBefore.map(l => l.split(' ')[0]))
// Where the checks below read a process's start now: /proc, or one Win32_Process snapshot taken after the run.
const WHERE = IS_WINDOWS ? 'Win32_Process' : '/proc'
const NOW = IS_WINDOWS ? winProcs() : undefined
const startNow = p => (NOW === undefined ? startOf(p) : (NOW.get(p)?.start ?? ''))
const BT = IS_WINDOWS ? '' : firstMatch(readOr('/proc/stat'), /^btime (.*)$/m)
const TCK = IS_WINDOWS ? '' : (spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout ?? '').replace(/\n+$/, '')
const lateOk = (p, at) => {
  const seen = treeSeen.get(p)
  if (seen === undefined) return false
  if ([...treeReused].some(line => line.startsWith(`${p} `))) return false
  const now = startNow(p)
  if (now !== '' && now !== seen) return false
  const atMs = Date.parse(at)
  if (IS_WINDOWS) return !Number.isNaN(atMs) && /^[0-9]+$/.test(seen) && atMs + 2000 >= Number(seen)
  if (Number.isNaN(atMs) || !/^[0-9]+$/.test(BT) || !/^[0-9]+$/.test(TCK)) return false
  return atMs + 2000 >= Number(BT) * 1000 + Math.floor((Number(seen) * 1000) / Number(TCK))
}
const SIGNAL_LINE = IS_WINDOWS ? /^- ([0-9TZ:.-]+) taskkill \/PID ([0-9]+) \/T \/F to ([0-9]+)/ : /^- [0-9TZ:.-]+ (SIGTERM|SIGKILL) to [0-9]+/
const signals = IS_WINDOWS
  ? stopLines.map(l => SIGNAL_LINE.exec(l)).filter(Boolean).map(m => [m[1], m[3]])
  : stopLines.filter(l => SIGNAL_LINE.test(l)).map(l => /^- ([0-9TZ:.-]+) .* to ([0-9]+).*$/.exec(l)).map(m => [m[1], m[2]])
const LATE = []
const STRAY = []
for (const [at, p] of signals) {
  if (treePids.has(p)) continue
  if (lateOk(p, at)) {
    if (!LATE.includes(p)) LATE.push(p)
  } else STRAY.push(p)
}
info(`signalled pids outside the recorded tree that the outside watch saw in the worker's tree after the recording, with the start it saw (not required dead, not stray): ${LATE.length ? LATE.join(' ') : 'none'}`)
if (STRAY.length === 0) pass(`every signal of the proof went to a process of the worker's tree (${IS_WINDOWS ? signals.length : stopLines.filter(l => /SIG(TERM|KILL) to/.test(l)).length} signals)`)
else fail(`a signal went outside the recorded tree: ${STRAY.join(' ')}`)

// ---------------------------------------------------------------- /proc (Win32_Process) from outside
const LEFT = treeBefore
  .map(l => l.split(' '))
  .filter(([p, st]) => p && startNow(p) === st)
  .map(([p, , name]) => `${p}(${name})`)
if (LEFT.length === 0) pass(`${WHERE}: the worker pid and every process of its tree are gone or have another start (${treeBefore.length} processes, ${treeBefore.filter(l => / sleep(\.exe)?$/i.test(l)).length} sleep)`)
else fail(`${WHERE}: still there: ${LEFT.join(' ')}`)
if (startNow(BYSTANDER) === BYSTANDER_START) pass(`${WHERE}: the bystander ${BYSTANDER_NAME} ${BYSTANDER} of this script is untouched`)
else fail(`${WHERE}: the bystander ${BYSTANDER_NAME} of this script is untouched`)
// The orchestrator (the claude this script started) has ended by itself. Any other claude process alive before the
// stop is still there, or it was another session's run that ended on its own: it is named with the first three words
// of its command line as read before the stop (never its prompt), and no signal of the proof went to it (checked above).
const claudeBefore = linesOf(readOr(join(S, 'claude-before.txt')))
const MISSING = claudeBefore
  .map(l => [l.split(' ')[0], l.split(' ')[1], l.split(' ').slice(2).join(' ')])
  .filter(([p]) => !treePids.has(p) && p !== OPID_DONE)
  .filter(([p, st]) => startNow(p) !== st)
  .map(([p, , cmd]) => ` ${p} (${cmd});`)
  .join('')
if (claudeBefore.some(l => l.startsWith(`${OPID_DONE} `))) info(`the orchestrator ${OPID_DONE} was alive at the stop and has ended by itself since`)
if (!MISSING) pass(`${WHERE}: every other claude process alive before the stop is still there (${claudeBefore.filter(l => l !== '').length} claude processes before, the worker and the orchestrator among them)`)
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
  keepOut(keep, [{ files: [...globIn(S, /^out-.*\.txt$/, 'out-*.txt'), join(S, 'tree-before.txt'), join(S, 'tree-dropped.txt'), join(S, 'tree-seen.txt'), join(S, 'tree-reused.txt'), join(S, 'claude-before.txt'), join(S, 'orchestrator.json'), TRACE] }])
  info(`outputs copied to ${keep}`)
}
const STILL = processesNaming(S)
if (!STILL) pass('no process names the scratch directory')
else fail(`no process names the scratch directory: ${STILL}`)
finish(S)
