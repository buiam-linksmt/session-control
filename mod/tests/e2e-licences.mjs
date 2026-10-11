#!/usr/bin/env node
// Run with `node mod/tests/e2e-licences.mjs` (Node 22 or newer), from any directory; no sh, grep, tr, sed, jq or cygpath is
// needed.
//
// End-to-end test of the licence tools of the session-control mod against the real claude and the real licences of
// this machine, in a scratch directory it makes and removes. A headless haiku orchestrator (capped at --max-budget-usd
// 0.30) runs in a scratch orchestrator directory and is told to (1) list_licences; (2) probe_licence_usage of every
// licence; (3) the same again, which answers from the cache; (4) probe_licence_usage of a directory that is no licence:
// refused; (5) launch_worker with a config_dir that is no licence: refused with the discovered names; (6) launch_worker
// with the explicit config_dir of the main licence (E2E_MAIN_DIR, else ~/.claude) and a prompt that replies PONG, and
// wait for its outcome in the foreground. The licences the tool must find are computed here the same way, by the
// presence of .credentials.json and .claude.json only (a stat, never an open): no licence file is ever opened by this
// script or the mod. The probes run `claude -p /usage --no-session-persistence` under each licence (no model turn);
// they read and change nothing of the licences beyond what the CLI itself does. Every tool answer, the final answer and
// the debug trace are checked for an `@` and for the identity strings given in E2E_IDENTITY (comma separated, never
// written in this file), and afterwards no `claude -p /usage --no-session-persistence` process may remain (read from
// /proc on Linux; elsewhere that check prints `skip`). Everything the mod writes is in the scratch directory; the
// orchestrator's transcript stays under this process's configuration (CLAUDE_CONFIG_DIR, else ~/.claude), the worker's
// under the main licence. One line per check; exit 1 on a failure. KEEP_OUT=<dir> keeps the tool answers.

import * as fs from 'node:fs'
import {
  CFG_DEFAULT, HAS_PROC, HOME, LIB_URL, MOD, awaitOrchestrator, byteSize, callCounts, cmdline, entriesOf, finish, globIn, grepF, isErrorFalse, join,
  jqPick, keepOut, kit, linesOf, native, nodeCommand, nodeMajor, ours, procCwd, procPids, processesNaming, readJson, readOr, removeTree, requireClaude,
  resultText, scratch, scratchSettings, signal, sleep, startClaude, toolUses, transcriptOf, writeJson, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, skip, info } = kit
const CLAUDE = requireClaude()
const MAIN_DIR = process.env.E2E_MAIN_DIR || join(HOME, '.claude')
const PROBE_LINE = 'claude -p /usage --no-session-persistence'
let orch
let WORK = ''
const workers = () => (WORK ? procPids().filter(p => procCwd(p) === WORK) : [])
const S = scratch('session-control-e2e-licences', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  // The worker the orchestrator launched, while it lives: a claude whose working directory is the scratch work folder.
  for (const p of workers()) if ((cmdline(p) ?? '').startsWith('claude ')) signal(p)
  removeTree(dir)
})
const ORCH = join(S, 'orch')
WORK = join(S, 'work')
const RUNS = join(S, 'runs')
const REG = join(S, 'headless-sessions.json')
const TRACE = join(RUNS, 'trace.log')

// The licences the tool must find, by presence only: the default (this process's own directory), ~/.claude, its
// children and the ~/.claude-* folders that hold both files. Each file is looked at with a stat, never opened.
const isFile = path => {
  try {
    return fs.statSync(path).isFile()
  } catch {
    return false
  }
}
const isLicence = dir => {
  try {
    if (!fs.statSync(dir).isDirectory() || fs.lstatSync(dir.replace(/\/+$/, '')).isSymbolicLink()) return false
  } catch {
    return false
  }
  return isFile(join(dir, '.credentials.json')) && isFile(join(dir, '.claude.json'))
}
/** `<dir>/<glob>/`: the folders (or links to folders) of a directory whose names pass a test, sorted. */
const subdirs = (dir, test) => {
  let names
  try {
    names = fs.readdirSync(dir).filter(test).sort()
  } catch {
    return []
  }
  return names.map(name => join(dir, name)).filter(path => {
    try {
      return fs.statSync(path).isDirectory()
    } catch {
      return false
    }
  })
}
const expectedAll = [CFG_DEFAULT]
if (isLicence(join(HOME, '.claude'))) expectedAll.push(join(HOME, '.claude'))
for (const d of [...subdirs(join(HOME, '.claude'), name => !name.startsWith('.')), ...subdirs(HOME, name => name.startsWith('.claude-'))]) if (isLicence(d)) expectedAll.push(d)
const EXPECTED = [...new Set(expectedAll)]
const COUNT = EXPECTED.filter(d => d !== '').length
info(`licences expected by presence: ${COUNT} (${EXPECTED.join(' ')})`)
if (!isLicence(MAIN_DIR)) {
  fail(`the main licence ${MAIN_DIR} holds both files`)
  process.exit(1)
}

for (const d of [ORCH, WORK, RUNS]) fs.mkdirSync(d, { recursive: true })
writeLines(join(ORCH, 'CLAUDE.md'), '# Role: Session Orchestrator', '', 'Scratch orchestrator of the session-control licence tools test: do exactly what the prompt says.')
writeLines(join(ORCH, 'agreed-decisions.md'), '# Agreed decisions')
writeJson(join(ORCH, 'task-queue.json'), { tasks: [] })
writeJson(join(ORCH, 'open-points.json'), { points: [] })
writeLines(join(ORCH, 'open-points-archive.md'), '# Open points archive')
fs.writeFileSync(REG, '[]\n')
const SETTINGS = scratchSettings(native(ORCH), native(REG), native(RUNS), 3)
fs.writeFileSync(join(S, 'wait-outcome.mjs'),
  "import { readFileSync } from 'node:fs'\n" +
  `import { jqLastTruthy } from ${JSON.stringify(LIB_URL)}\n` +
  'const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)\n' +
  "const done = () => { try { return jqLastTruthy(JSON.parse(readFileSync(process.argv[2], 'utf8')), 'e2e licence pong', 'outcome') } catch { return false } }\n" +
  'let n = 0\n' +
  'while (!done()) { n++; if (n > 100) process.exit(1); pause(3000) }\n')
const NOT_A_LICENCE = `${native(S)}/not-a-licence`
fs.writeFileSync(join(S, 'instruction.txt'),
  'This is an automated test of the licence tools. Do exactly these steps, one after the other, each one once, even when a step is refused (then go on with the next step), and nothing else. Give every tool exactly the inputs written here.\n' +
  '1. Call mcp__session-control__list_licences with no input.\n' +
  '2. Call mcp__session-control__probe_licence_usage with no input.\n' +
  '3. Call mcp__session-control__probe_licence_usage with no input again.\n' +
  `4. Call mcp__session-control__probe_licence_usage with config_dir "${NOT_A_LICENCE}".\n` +
  `5. Call mcp__session-control__launch_worker with dir "${native(WORK)}", model "haiku", effort "low", title "e2e licence refused", timeout_minutes 5, config_dir "${NOT_A_LICENCE}", prompt "Reply with the single word PONG and stop. Use no tool."\n` +
  `6. Call mcp__session-control__launch_worker with dir "${native(WORK)}", model "haiku", effort "low", title "e2e licence pong", timeout_minutes 5, config_dir "${native(MAIN_DIR)}", prompt "Reply with the single word PONG and stop. Use no tool."\n` +
  `7. Run this Bash command and wait for it (it returns when the worker of step 6 has finished): ${nodeCommand(join(S, 'wait-outcome.mjs'), REG)}\n` +
  'Then answer with one line: done.\n')

orch = startClaude({
  claude: CLAUDE,
  cwd: ORCH,
  args: ['-p', '--plugin-dir', native(MOD), '--model', 'haiku', '--dangerously-skip-permissions', '--max-budget-usd', '0.30', '--output-format', 'json', '--settings', SETTINGS],
  stdin: join(S, 'instruction.txt'),
  stdout: join(S, 'orchestrator.json'),
  stderr: join(S, 'orchestrator.err'),
  env: { SESSION_CONTROL_DEBUG: '1' },
})
await awaitOrchestrator(orch, { limit: 480, dir: S, isOk: () => isErrorFalse(join(S, 'orchestrator.json')) })
const ojson = readJson(join(S, 'orchestrator.json'))
const OSID = typeof ojson?.session_id === 'string' ? ojson.session_id : ''
info(`orchestrator cost USD ${ojson?.total_cost_usd ?? '?'}, session ${OSID} (config dir ${CFG_DEFAULT}, cwd ${ORCH})`)
const OT = transcriptOf(CFG_DEFAULT, OSID)
if (OSID && OT) pass(`orchestrator transcript found (${OT})`)
else fail(`orchestrator transcript found (session '${OSID}')`)
const entries = entriesOf(OT)

// The result of the n-th call (1 first) of a tool whose input matches a test: OK or ERROR, then its text.
const resPath = name => join(S, `res-${name}.txt`)
const result = (tool, test, name, nth) => {
  const call = toolUses(entries).filter(c => c.name === tool && test(c.input ?? {}))[nth - 1]
  if (!call?.id) return false
  fs.writeFileSync(resPath(name), resultText(entries, call.id, true))
  return byteSize(resPath(name)) > 0
}
const has = (name, text) => grepF(readOr(resPath(name)), text)
const check = (name, text, what) => (has(name, text) ? pass(`${name}: ${what}`) : fail(`${name}: ${what} (missing: ${text})`))
const P = 'mcp__session-control__probe_licence_usage'
const L = 'mcp__session-control__launch_worker'
for (const [tool, test, name, nth] of [
  ['mcp__session-control__list_licences', () => true, 'list', 1],
  [P, input => input.config_dir == null, 'probe', 1],
  [P, input => input.config_dir == null, 'again', 2],
  [P, input => input.config_dir != null, 'probe-refused', 1],
  [L, input => input.title === 'e2e licence refused', 'launch-refused', 1],
  [L, input => input.title === 'e2e licence pong', 'launch', 1],
]) {
  if (result(tool, test, name, nth)) pass(`${name}: the ${tool} call was made and answered`)
  else {
    fail(`${name}: the ${tool} call was made and answered`)
    fs.writeFileSync(resPath(name), '')
  }
}
info(`tool calls of the orchestrator: ${callCounts(entries)}`)

// ---------------------------------------------------------------- list_licences
check('list', `${COUNT} licence`, '(1) the count of the licences found by presence')
for (const d of EXPECTED.join(' ').split(/\s+/).filter(Boolean)) check('list', `| config_dir ${d} | source `, `(1) ${d} is listed`)
check('list', `- default | config_dir ${CFG_DEFAULT} | source default | logged_in `, "(1) the orchestrator's own directory is the default")
check('list', `| config_dir ${MAIN_DIR} | source `, '(1) the main licence is listed')
check('list', 'neither is opened', '(1) the answer says logged_in is presence only')

// ---------------------------------------------------------------- probe_licence_usage
check('probe', `Usage of ${COUNT} licence`, '(2) every licence answered')
const probeLines = linesOf(readOr(resPath('probe')))
const N_FIG = probeLines.filter(l => /\| five_hour [0-9-]/.test(l)).length
const N_ERR = probeLines.filter(l => l.includes('| error ')).length
if (N_FIG + N_ERR === COUNT) pass(`(2) one row per licence (${N_FIG} with figures, ${N_ERR} with a code)`)
else fail(`(2) one row per licence (${N_FIG} + ${N_ERR} of ${COUNT})`)
check('probe', `(config_dir ${MAIN_DIR}) | five_hour `, '(2) the main licence has its figures')
check('probe', 'can be stale', '(2) the answer says the figures can be stale')
check('again', 'from the cache)', '(3) the second call answers from the cache')
check('again', '| cached yes', '(3) its rows say cached')
check('probe-refused', 'not a discovered licence', '(4) a directory that is no licence is refused')
check('launch-refused', 'refused: config_dir is not a discovered licence (discovered: ', '(5) launch_worker refuses a config_dir that is no licence')
check('launch-refused', 'nothing was launched', '(5) nothing was launched')

// ---------------------------------------------------------------- launch_worker with the main licence
check('launch', `config_dir ${MAIN_DIR}, registered.`, '(6) launched under the main licence and registered')
check('launch', '(config_dir given; the licence picker was not run)', '(6) the answer says the picker was not run')
// Every entry with the title, as jq gives them: two entries give two lines, and each check below fails.
const reg = readJson(REG)
const ENTRY_CFG = jqPick(reg, 'e2e licence pong', 'config_dir')
if (ENTRY_CFG === MAIN_DIR) pass(`(6) the registry entry's config_dir is ${MAIN_DIR}`)
else fail(`(6) the registry entry's config_dir is ${MAIN_DIR} (got '${ENTRY_CFG}')`)
const WSID = jqPick(reg, 'e2e licence pong', 'session_id')
const OUTCOME = jqPick(reg, 'e2e licence pong', 'outcome.kind', 'none')
if (OUTCOME === 'clean') pass('(6) the worker finished clean')
else fail(`(6) the worker finished clean (outcome ${OUTCOME})`)
info(`worker session ${WSID} (config dir ${ENTRY_CFG}, cwd ${WORK}), outcome ${OUTCOME}`)
const WT = transcriptOf(MAIN_DIR, WSID)
if (WSID && WT) pass("(6) the worker's transcript is under the main licence")
else fail("(6) the worker's transcript is under the main licence")
if (Array.isArray(reg) && !reg.some(e => e?.title === 'e2e licence refused')) pass('(5) registry: the refused launch is not registered')
else fail('(5) registry: the refused launch is not registered')

// ---------------------------------------------------------------- no identity, no credential, no figure in the trace
fs.writeFileSync(join(S, 'answer.txt'), (typeof ojson?.result === 'string' ? ojson.result : '') + '\n')
const ALL = [join(S, 'answer.txt'), TRACE, ...fs.readdirSync(S).filter(name => /^res-.*\.txt$/.test(name)).sort().map(name => join(S, name))]
const AT = ALL.filter(f => readOr(f).includes('@'))
if (AT.length === 0) pass('no @ in any tool answer, the final answer or the trace')
else fail(`no @ in any tool answer, the final answer or the trace (found in: ${AT.map(f => f + ' ').join('')})`)
let LEAK = ''
const identity = process.env.E2E_IDENTITY ?? ''
for (const word of identity.split(',')) {
  if (!word) continue
  if (ALL.some(f => readOr(f).toLowerCase().includes(word.toLowerCase()))) LEAK += ' [an identity string]'
}
if (!identity) info('E2E_IDENTITY not set: only the @ check ran')
else if (!LEAK) pass('no identity string of E2E_IDENTITY in any answer or the trace')
else fail(`an identity string of E2E_IDENTITY was found:${LEAK}`)
const TOKEN_SHAPE = ['sk', 'ant', ''].join('-')
if (ALL.some(f => readOr(f).includes(TOKEN_SHAPE))) fail('no token-shaped text in any answer or the trace')
else pass('no token-shaped text in any answer or the trace')
const trace = readOr(TRACE)
for (const word of ['% used', 'resets ', 'subscription']) {
  if (trace.includes(word)) fail(`the trace holds no usage text (${word})`)
  else pass(`the trace holds no usage text (${word})`)
}
if (trace.includes('"event":"tool.result","tool":"probe_licence_usage","resultChars":')) pass('the trace has the probe answer as a length only')
else fail('the trace has the probe answer as a length only')
if (trace.includes('"event":"licences.usage"')) pass('the trace has a line per probe')
else fail('the trace has a line per probe')
const { major } = nodeMajor()
if (major !== undefined && major >= 22) {
  if (trace.includes('"helper":"probeUsage"') && !trace.includes('"op":"probeUsage"')) pass('the probes ran through the Node helper, no fallback')
  else fail('the probes ran through the Node helper, no fallback')
}

if (process.env.KEEP_OUT) {
  const keep = process.env.KEEP_OUT
  keepOut(keep, [{ files: [...globIn(S, /^res-.*\.txt$/, 'res-*.txt'), join(S, 'answer.txt'), REG, TRACE] }])
  info(`outputs copied to ${keep}`)
}
// The worker must be gone before the scratch directory goes: wait a little for it, then the cleanup stops what is left.
if (HAS_PROC) {
  for (let n = 0; n < 30 && workers().length > 0; n++) await sleep(1000)
  const PROBES = procPids().filter(p => cmdline(p) === `${PROBE_LINE} `)
  if (PROBES.length === 0) pass(`no ${PROBE_LINE} process remains`)
  else fail(`no ${PROBE_LINE} process remains (pids: ${PROBES.map(p => p + ' ').join('')})`)
} else {
  skip(`no ${PROBE_LINE} process remains (no /proc)`)
}
const STILL = processesNaming(S)
if (!STILL) pass('no process names the scratch directory')
else fail(`no process names the scratch directory: ${STILL}`)
finish(S)
