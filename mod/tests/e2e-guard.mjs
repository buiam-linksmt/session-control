#!/usr/bin/env node
// The Node port of e2e-guard.sh, which stays beside it: the same checks, the same lines, the same options. Run with
// `node mod/tests/e2e-guard.mjs` (Node 22 or newer); the test itself needs no sh, grep, tr, sed, jq or cygpath. The
// orchestrator is still told to run `sed -i`, `cat` and `jq` through its Bash tool, because those commands are what the
// guard is tested on: the `sed -i` is refused before it runs, the `cat` and `jq` steps need those tools on the PATH of
// the session's Bash tool (on Windows, Git Bash's, which may lack jq).
//
// End-to-end test of the helper-file edit guard against the real claude, in a scratch directory it makes and removes.
// A headless haiku orchestrator (capped at --max-budget-usd 0.25) runs in a scratch orchestrator directory and is told
// to (1) Write over open-points.json, (2) run `sed -i` on task-queue.json through Bash, (3) run `cat task-queue.json`
// and (4) `jq` over it, (5) Read and then Edit its CLAUDE.md, (6) call open_point add. Its transcript must show (1) and
// (2) refused with the guard's text naming open_point and queue_task, (3) to (5) run, (6) answered by the tool; on
// disk task-queue.json must be byte for byte as seeded, open-points.json must hold the point the tool added and not
// the Write's text, and CLAUDE.md the edit. Everything is in the scratch directory; the transcript stays under the
// default configuration. One line per check; exit 1 on a failure. KEEP_OUT=<dir> keeps the tool results.

import * as fs from 'node:fs'
import {
  CFG_DEFAULT, MOD, awaitOrchestrator, byteSize, callCounts, entriesOf, finish, globIn, grepF, isErrorFalse, join, keepOut, kit, native, ours,
  processesNaming, readJson, readOr, removeTree, requireClaude, resultText, scratch, scratchSettings, startClaude, toolUses,
  transcriptOf, writeJson, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, info } = kit
const CLAUDE = requireClaude()
let orch
const S = scratch('session-control-e2e-guard', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  removeTree(dir)
})
const ORCH = join(S, 'orch')
const RUNS = join(S, 'runs')
const REG = join(S, 'headless-sessions.json')

for (const d of [ORCH, RUNS]) fs.mkdirSync(d, { recursive: true })
writeLines(join(ORCH, 'CLAUDE.md'), '# Role: Session Orchestrator', '', 'Scratch orchestrator of the session-control guard test: do exactly what the prompt says.', 'SCRATCH-LINE-ONE')
writeLines(join(ORCH, 'agreed-decisions.md'), '# Agreed decisions')
writeJson(join(ORCH, 'task-queue.json'), { tasks: [{ id: 'e2e-t', status: 'queued', title: 'A queued task' }] })
writeJson(join(ORCH, 'open-points.json'), { points: [] })
writeLines(join(ORCH, 'open-points-archive.md'), '# Open points archive')
fs.writeFileSync(REG, '[]\n')
fs.copyFileSync(join(ORCH, 'task-queue.json'), join(S, 'queue-before.json'))
const SETTINGS = scratchSettings(native(ORCH), native(REG), native(RUNS), 5)
const O = native(ORCH)
fs.writeFileSync(join(S, 'instruction.txt'),
  'This is an automated test of a guard. Do exactly these six steps, one after the other, each one once, even when a step is refused (then go on with the next step), and nothing else:\n' +
  `1. Use the Write tool to write the text {"points": [], "e2e": "WRITE-BY-HAND"} to the file ${O}/open-points.json\n` +
  `2. Run this Bash command: sed -i 's/queued/done/' ${O}/task-queue.json\n` +
  `3. Run this Bash command: cat ${O}/task-queue.json\n` +
  `4. Run this Bash command: jq '.tasks | length' ${O}/task-queue.json\n` +
  `5. Use the Read tool on ${O}/CLAUDE.md, then the Edit tool on ${O}/CLAUDE.md to replace SCRATCH-LINE-ONE with SCRATCH-LINE-EDITED.\n` +
  '6. Call mcp__session-control__open_point with action "add", id "e2e-p1", title "A test point.", detail "Added by the guard test.", recommendation "None."\n' +
  'Then answer with one line: done.\n')

orch = startClaude({
  claude: CLAUDE,
  cwd: ORCH,
  args: ['-p', '--plugin-dir', native(MOD), '--model', 'haiku', '--dangerously-skip-permissions', '--max-budget-usd', '0.25', '--output-format', 'json', '--settings', SETTINGS],
  stdin: join(S, 'instruction.txt'),
  stdout: join(S, 'orchestrator.json'),
  stderr: join(S, 'orchestrator.err'),
})
await awaitOrchestrator(orch, { limit: 300, dir: S, isOk: () => isErrorFalse(join(S, 'orchestrator.json')) })
const ojson = readJson(join(S, 'orchestrator.json'))
const OSID = typeof ojson?.session_id === 'string' ? ojson.session_id : ''
info(`orchestrator cost USD ${ojson?.total_cost_usd ?? '?'}, session ${OSID} (config dir ${CFG_DEFAULT}, cwd ${ORCH})`)
const OT = transcriptOf(CFG_DEFAULT, OSID)
if (OSID && OT) pass(`orchestrator transcript found (${OT})`)
else fail(`orchestrator transcript found (session '${OSID}')`)
const entries = entriesOf(OT)

// The result of the first call of a tool whose input matches a test: its text and whether it was an error.
const resPath = name => join(S, `res-${name}.txt`)
const result = (tool, test, name) => {
  const call = toolUses(entries).find(c => c.name === tool && test(c.input ?? {}))
  if (!call?.id) return false
  fs.writeFileSync(resPath(name), resultText(entries, call.id, true))
  return byteSize(resPath(name)) > 0
}
const has = (name, text) => grepF(readOr(resPath(name)), text)
const check = (name, text, what) => (has(name, text) ? pass(`${name}: ${what}`) : fail(`${name}: ${what} (missing: ${text})`))
const str = value => (typeof value === 'string' ? value : '')
for (const [tool, test, name] of [
  ['Write', input => str(input.file_path).endsWith('open-points.json'), 'write'],
  ['Bash', input => str(input.command).startsWith('sed -i'), 'sed'],
  ['Bash', input => str(input.command).startsWith('cat '), 'cat'],
  ['Bash', input => str(input.command).startsWith('jq '), 'jq'],
  ['Edit', input => str(input.file_path).endsWith('CLAUDE.md'), 'edit'],
  ['mcp__session-control__open_point', input => input.id === 'e2e-p1', 'point'],
]) {
  if (result(tool, test, name)) pass(`${name}: the ${tool} call was made and answered`)
  else {
    fail(`${name}: the ${tool} call was made and answered`)
    fs.writeFileSync(resPath(name), '')
  }
}
info(`tool calls of the orchestrator: ${callCounts(entries)}`)

check('write', 'ERROR', '(1) Write over open-points.json is refused')
check('write', 'refused by the helper-file guard: open-points.json is a helper file', '(1) by the guard')
check('write', 'session-control tool open_point, never by hand (Write: a write of', '(1) naming open_point')
check('sed', 'ERROR', '(2) sed -i on task-queue.json through Bash is refused')
check('sed', 'session-control tool queue_task, never by hand (Bash: sed -i)', '(2) naming queue_task and sed -i')
check('cat', 'OK', '(3) cat task-queue.json runs')
check('cat', '"e2e-t"', '(3) and shows the file')
check('jq', 'OK', '(4) jq over task-queue.json runs')
check('jq', '1', '(4) and answers')
check('edit', 'OK', '(5) Edit of CLAUDE.md runs')
check('point', 'OK', '(6) open_point add runs')
check('point', 'open-points.json: added e2e-p1', '(6) the tool added the point')

const same = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}
if (same(join(S, 'queue-before.json'), join(ORCH, 'task-queue.json'))) pass('disk: task-queue.json is byte for byte as seeded')
else fail(`disk: task-queue.json changed: ${readOr(join(ORCH, 'task-queue.json')).slice(0, 300)}`)
const points = readJson(join(ORCH, 'open-points.json'))
if (Array.isArray(points?.points) && points.points.some(p => p?.id === 'e2e-p1') && !Object.hasOwn(points, 'e2e')) pass('disk: open-points.json holds the point the tool added, not the hand-written text')
else fail(`disk: open-points.json: ${readOr(join(ORCH, 'open-points.json')).slice(0, 300)}`)
if (readOr(join(ORCH, 'CLAUDE.md')).includes('SCRATCH-LINE-EDITED')) pass('disk: CLAUDE.md holds the edit')
else fail('disk: CLAUDE.md holds the edit')

if (process.env.KEEP_OUT) {
  const keep = process.env.KEEP_OUT
  keepOut(keep, [{ files: [...globIn(S, /^res-.*\.txt$/, 'res-*.txt'), join(S, 'orchestrator.json')] }, { files: [join(ORCH, 'open-points.json'), join(ORCH, 'task-queue.json'), join(ORCH, 'CLAUDE.md')] }])
  info(`outputs copied to ${keep}`)
}
const STILL = processesNaming(S, 'e2e-guard')
if (!STILL) pass('no process names the scratch directory')
else fail(`no process names the scratch directory: ${STILL}`)
finish(S)
