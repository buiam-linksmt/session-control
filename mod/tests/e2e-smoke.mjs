#!/usr/bin/env node
// The Node port of e2e-smoke.sh, which stays beside it: the same checks, the same lines, the same options. Run with
// `node mod/tests/e2e-smoke.mjs` (Node 22 or newer); no sh, grep, tr, sed, jq or cygpath is needed.
//
// End-to-end smoke test of the session-control mod against the real claude, in a scratch directory it makes and
// removes: (a) one headless haiku orchestrator launches one haiku worker through launch_worker and waits for it in the
// foreground, and the worker's launch line, session name, messaging socket and registry entry are checked; (b) where
// tmux exists, an interactive claude opens the panel with /session-control (no model call).
// Everything goes to the scratch directory (registry, runs directory, trace); the real registry, helper files and runs
// directory are never touched, and the licence picker option is empty: the worker gets no CLAUDE_CONFIG_DIR and
// inherits the default configuration (this process's CLAUDE_CONFIG_DIR, else ~/.claude), which the registry records.
// A few cents of haiku (the orchestrator is capped at USD 0.25). One line per check; exit 1 on a failure.
// KEEP_TRACE=<file> copies the trace there before the scratch directory goes. The mod runs with its default helper
// option (auto): where Node 22 or newer is on the PATH the trace must show the Node helper in use and no
// helper.fallback line. HIDE_NODE=1 starts both claude sessions with every PATH directory that holds node left out:
// the mod must find no Node, keep its built-in operations, and the run must pass all the same. The orchestrator's
// foreground wait runs a node script of this test by the absolute path of the node running it, so it needs no node
// on that PATH. The launch line and the socket are read from /proc (Linux); elsewhere those checks print `skip`.
// The interactive part needs tmux; without it it prints `skip`.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { delimiter } from 'node:path'
import {
  CFG_DEFAULT, HAS_PROC, IS_WINDOWS, MOD, awaitOrchestrator, basename, cmdline, comm, finish, firstMatch, grepF, isExecutable, join, jsonValues, kit,
  linesOf, msys, native, nodeCommand, ours, pidExists, ppid, procCwd, procPids, processesNaming, readOr, removeTree, requireClaude,
  sanitized, scratch, signal, sleep, startClaude, which, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, skip, info } = kit
/**
 * Whether a file holds a text in any capitalisation: 0 it does, 1 it does not, 2 the check itself failed (an empty
 * text or an unreadable file).
 */
function holdsCi(want, path) {
  const lower = want.toLowerCase()
  if (!lower) return 2
  let text
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch {
    return 2
  }
  return text.toLowerCase().includes(lower) ? 0 : 1
}

requireClaude()
// The PATH the claude sessions start with: this one, or with HIDE_NODE=1 this one less every directory holding node.
let RUN_PATH = process.env.PATH ?? ''
if (process.env.HIDE_NODE === '1') {
  const kept = []
  for (const d of RUN_PATH.split(delimiter)) {
    if (!d) continue
    if (isExecutable(join(d, 'node')) || isExecutable(join(d, 'node.exe'))) {
      info(`PATH without ${d} (it holds node)`)
      continue
    }
    kept.push(d)
  }
  RUN_PATH = kept.join(delimiter)
  requireClaude(RUN_PATH, 'claude is on the PATH without node')
}
const CLAUDE = requireClaude(RUN_PATH)
// Whether the mod should find the helper's Node: node on that PATH, version 22 or newer.
const NODE_FOUND = which('node', RUN_PATH)
let NODE_MAJOR = ''
if (NODE_FOUND) {
  const ran = spawnSync(NODE_FOUND, ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: RUN_PATH }, timeout: 30_000 })
  NODE_MAJOR = firstMatch(ran.stdout ?? '', /^v(\d+)\./)
}
const HELPER_WANTED = NODE_MAJOR !== '' && Number(NODE_MAJOR) >= 22
info(`node for the sessions: ${NODE_FOUND || 'none'} (major ${NODE_MAJOR || 'none'}); the helper is expected ${HELPER_WANTED ? 'active' : 'inactive'}`)
// Windows: the claude.exe offers its Bash tool only when it finds Git Bash: point it at the bash.exe of the Git on the
// PATH when nothing names one (the shell script does the same from Git Bash).
if (IS_WINDOWS && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
  const git = which('git.exe')
  const root = git ? git.replace(/\\(cmd|bin|mingw64\\bin)\\git\.exe$/i, '') : ''
  if (root && root !== git && fs.existsSync(`${root}\\bin\\bash.exe`)) {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = `${root}\\bin\\bash.exe`
    info(`CLAUDE_CODE_GIT_BASH_PATH set to ${process.env.CLAUDE_CODE_GIT_BASH_PATH}`)
  }
}

let orch
let WPID = ''
let TSOCK = ''
const S = scratch('session-control-e2e', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  else if (orch?.alive() && !HAS_PROC) orch.stop()
  if (ours(WPID, dir)) signal(WPID)
  if (TSOCK) spawnSync('tmux', ['-L', TSOCK, 'kill-server'], { stdio: 'ignore' })
  removeTree(dir)
})
const ORCH = join(S, 'orch')
// The worker's directory carries a canary that looks like a key: the trace must show it as [redacted].
// Joined from two parts, so the file holds no complete key-shaped string.
const CANARY = ['sk', 'e2ecanary00000000'].join('-')
const WORK = join(S, `work-${CANARY}`)
const RUNS = join(S, 'runs')
const REG = join(S, 'headless-sessions.json')
const PROMPT = join(S, 'worker-prompt.md')
const TRACE = join(RUNS, 'trace.log')

for (const d of [ORCH, WORK, RUNS]) fs.mkdirSync(d, { recursive: true })
writeLines(join(ORCH, 'CLAUDE.md'), '# Role: Session Orchestrator', '', 'Scratch orchestrator of the session-control smoke test: do exactly what the prompt says.')
// The launch guard wants the prompt to name a foreground wait, the git status -sb report and no AI attribution.
fs.writeFileSync(PROMPT,
  'Smoke test of a worker launch: reply with the single word PONG and stop.\n' +
  'Use no tool. There is nothing to wait for in the foreground, no git status -sb to report and no commit, so no AI attribution question arises.\n')
// The worker's command line carries its prompt: with the scratch path in it, the exit cleanup can tell the worker is ours.
fs.appendFileSync(PROMPT, `Scratch directory of this smoke test: ${S}\n`)
const PROMPT_PHRASE = 'reply with the single word PONG'
fs.writeFileSync(join(S, 'wait-outcome.mjs'),
  "import { readFileSync } from 'node:fs'\n" +
  'const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)\n' +
  'const holds = () => { try { return readFileSync(process.argv[2], "utf8").includes(\'"outcome"\') } catch { return false } }\n' +
  'let n = 0\n' +
  'while (!holds()) { n++; if (n > 100) process.exit(1); pause(3000) }\n')
const SETTINGS = JSON.stringify({ pluginConfigs: { 'session-control@inline': { options: { orchestratorDir: native(ORCH), registryPath: native(REG), runsDir: native(RUNS), licencePickCommand: '', completionWrites: true, pollSeconds: 2, debug: false } } } })
fs.writeFileSync(join(S, 'instruction.txt'),
  "This is an automated smoke test of the session-control mod. Do exactly these three steps and nothing else:\n" +
  `1. Call the tool mcp__session-control__launch_worker once, with dir "${msys(WORK)}", prompt_file "${msys(PROMPT)}", model "haiku", effort "low", title "e2e smoke worker" and timeout_minutes 5.\n` +
  `2. Run this one Bash command in the foreground, with a timeout of 600000 ms, and wait for it to finish: ${nodeCommand(join(S, 'wait-outcome.mjs'), REG)}\n` +
  '3. Answer with one line: the text the launch tool returned.\n')

// ---------------------------------------------------------------- (a) headless orchestrator and worker
orch = startClaude({
  claude: CLAUDE,
  cwd: ORCH,
  args: ['-p', '--plugin-dir', native(MOD), '--model', 'haiku', '--dangerously-skip-permissions', '--max-budget-usd', '0.25', '--output-format', 'json', '--settings', SETTINGS],
  stdin: join(S, 'instruction.txt'),
  stdout: join(S, 'orchestrator.json'),
  stderr: join(S, 'orchestrator.err'),
  env: { PATH: RUN_PATH, SESSION_CONTROL_DEBUG: '1' },
})
let SEEN_PID = ''
// The worker's launch line, read off the command line of the shell that runs it, where /proc shows the worker. A haiku
// worker lives a few seconds, sometimes about one: the registry, the worker and its socket are looked for every 0.2 s
// while the orchestrator runs.
let WLINE = ''
// The worker's own argv (NULs as blanks) and pid, from the same /proc entry.
let WCMD = ''
let WPROC = ''
const catchWorker = () => {
  for (const p of procPids()) {
    if (procCwd(p) !== WORK || comm(p) !== 'claude') continue
    WLINE = cmdline(ppid(p)) ?? ''
    WCMD = cmdline(p) ?? ''
    WPROC = p
    return
  }
}
// The worker's messaging socket while it lives: messagingSocketPath of its sessions file under the inherited config
// dir, seen as a socket while /proc still lists the worker.
const CFG_DIR = CFG_DEFAULT
let SOCK_LIVE = ''
const isSocket = path => {
  try {
    return fs.statSync(path).isSocket()
  } catch {
    return false
  }
}
const catchSocket = () => {
  if (!WPROC || !fs.existsSync(`/proc/${WPROC}`)) return
  const sp = firstMatch(readOr(join(CFG_DIR, 'sessions', `${WPROC}.json`)), /"messagingSocketPath": *"([^"]*)"/)
  if (sp && isSocket(sp) && fs.existsSync(`/proc/${WPROC}`)) SOCK_LIVE = sp
}
await awaitOrchestrator(orch, {
  limit: 480,
  dir: S,
  tick: async () => {
    for (let q = 0; q < 5; q++) {
      if (!SEEN_PID && fs.existsSync(REG)) {
        SEEN_PID = firstMatch(readOr(REG), /"pid": *([0-9]*)/)
        if (SEEN_PID) WPID = SEEN_PID
      }
      if (!WLINE && HAS_PROC) catchWorker()
      if (!SOCK_LIVE && HAS_PROC) catchSocket()
      await sleep(200)
    }
  },
  isOk: () => /"is_error": *false/.test(readOr(join(S, 'orchestrator.json'))),
})
const ojson = readOr(join(S, 'orchestrator.json'))
info(`orchestrator cost USD ${firstMatch(ojson, /"total_cost_usd": *([0-9.e-]*)/)}`)
info(`orchestrator session ${firstMatch(ojson, /"session_id": *"([^"]*)"/)} (config dir ${CFG_DEFAULT}, cwd ${ORCH})`)

const field = name => firstMatch(readOr(REG), new RegExp(`"${name}": *"([^"]*)"`))
const SID = field('session_id')
// Whether the registry entry had the worker's pid while it ran. A haiku worker can live about a second, and the
// completion drops the pid from the entry, so the registry sampled every 0.2 s above can still miss it: the trace
// proves the same thing on its own. Its worker.found line records the pid the probe found for the new worker, and its
// worker.registered line the pid of the entry just written, with isRegistered true and the entry's session id; the two
// pids equal and that session id the registry's own mean the entry held that live pid. At least one of the two proofs
// is required; neither found fails the check.
const traceText = () => readOr(TRACE)
const traceLines = () => linesOf(traceText())
const TRACE_FOUND = firstMatch(traceText(), /"event":"worker\.found","pid":([0-9]*)/)
const TRACE_REG = firstMatch(
  traceLines().filter(l => l.includes('"event":"worker.registered"') && l.includes('"isRegistered":true') && l.includes(`"sessionId":"${SID}"`)).join('\n'),
  /"pid":([0-9]*)/,
)
if (SEEN_PID || (SID && TRACE_FOUND && TRACE_FOUND === TRACE_REG)) {
  pass(`registry entry had a pid while the worker ran (registry sampled: ${SEEN_PID || 'missed'}; trace: worker.found pid ${TRACE_FOUND || 'none'}, registered pid ${TRACE_REG || 'none'})`)
} else {
  fail(`registry entry had a pid while the worker ran (registry sampled: missed; trace: worker.found pid ${TRACE_FOUND || 'none'}, registered pid ${TRACE_REG || 'none'})`)
}
if (/^[0-9a-f-]{36}$/.test(SID)) pass(`registry entry has a session_id (${SID})`)
else fail(`registry entry has a session_id (got '${SID}')`)
const KIND = firstMatch(readOr(REG), /"kind": *"([a-z]*)"/)
if (KIND === 'clean') pass('registry entry has the outcome clean')
else fail(`registry entry has the outcome clean (got '${KIND}')`)
const RESULT_FILE = field('result_file')
const ERR_FILE = field('err_file')
const sizeOf = path => {
  try {
    return fs.statSync(path).size
  } catch {
    return 0
  }
}
if (RESULT_FILE && sizeOf(RESULT_FILE) > 0) pass('worker result file exists')
else fail(`worker result file exists ('${RESULT_FILE}')`)
if (ERR_FILE && fs.existsSync(ERR_FILE)) pass('worker error file exists')
else fail(`worker error file exists ('${ERR_FILE}')`)
// No picker: the registry records the configuration the worker inherited.
const WANT_CFG = native(CFG_DEFAULT)
const CFG = field('config_dir')
if (CFG === WANT_CFG) pass(`registry entry has the inherited config_dir (${CFG})`)
else fail(`registry entry has the inherited config_dir ${WANT_CFG} (got '${CFG}')`)
if (WLINE) {
  if (WLINE.includes('claude -p') && !WLINE.includes('CLAUDE_CONFIG_DIR=')) pass("worker's launch line sets no CLAUDE_CONFIG_DIR")
  else fail(`worker's launch line sets no CLAUDE_CONFIG_DIR: ${WLINE.slice(0, 300)}`)
  // The Bash tool runs the launch line inside a quoted command of its own: its quotes show as '"'"' there.
  if (/claude -p --model 'haiku' -n 'w-e2e-smoke-worker-[0-9]{12}' --settings '\{"crossSessionInbound":"accept"\}' --dangerously-skip-permissions/.test(WLINE.replaceAll(`'"'"'`, "'"))) {
    pass("worker's launch line carries -n <unique name> and --settings with crossSessionInbound accept")
  } else {
    fail(`worker's launch line carries -n <unique name> and --settings with crossSessionInbound accept: ${firstMatch(WLINE, /(claude -p.*--output-format)/).slice(0, 300)}`)
  }
  if (/-p --model haiku -n w-e2e-smoke-worker-[0-9]{12} --settings \{"crossSessionInbound":"accept"\} --dangerously-skip-permissions/.test(WCMD)) {
    pass("worker's own argv has the name and the settings JSON as single arguments")
  } else {
    fail(`worker's own argv has the name and the settings JSON as single arguments: ${firstMatch(WCMD, /(-p.*--output-format)/).slice(0, 300)}`)
  }
} else {
  skip("worker's launch line (its shell not seen in /proc)")
}
const NAME = field('name')
const SOCKET = field('socket_path')
if (/^w-e2e-smoke-worker-[0-9]{12}$/.test(NAME)) pass(`registry entry has the session name (${NAME})`)
else fail(`registry entry has the session name w-e2e-smoke-worker-<yyMMddHHmmss> (got '${NAME}')`)
if (SOCKET) pass(`registry entry has the socket_path (${SOCKET})`)
else fail('registry entry has the socket_path')
if (HAS_PROC) {
  if (SOCK_LIVE && SOCK_LIVE === SOCKET) pass('the socket existed while the worker lived, at the path the registry records')
  else fail(`the socket existed while the worker lived, at the path the registry records (seen '${SOCK_LIVE}')`)
  if (SOCKET && !fs.existsSync(SOCKET)) pass('the socket is gone after the worker exited')
  else info(`socket after the exit: ${SOCKET ? (fs.existsSync(SOCKET) ? `${SOCKET} is still there` : `${SOCKET} is gone`) : 'no socket path recorded'}`)
} else {
  skip('the socket while the worker lived (no /proc listing of the worker)')
}
if (RESULT_FILE) info(`worker cost USD ${firstMatch(readOr(RESULT_FILE), /"total_cost_usd": *([0-9.e-]*)/)}`)

const has = text => grepF(traceText(), text)
if (has('"event":"tool.call","tool":"launch_worker"')) pass('trace has the launch tool.call line')
else fail('trace has the launch tool.call line')
if (has('"event":"process.run","argv":["sh","-c","<PROBE_SCRIPT>"') || has('"event":"process.run","helper":"probe"') || traceLines().some(l => l.includes('"event":"process.run"') && l.includes('probe.ps1'))) {
  pass('trace has the process.run line of the probe')
} else {
  fail('trace has the process.run line of the probe')
}
const REGN = native(REG)
if (HELPER_WANTED) {
  // The Node helper writes the registry in one process: its temp file never goes through $.fs.
  if (has(`"event":"process.run","helper":"writeAtomic","path":"${REGN}","exitCode":0`) && has('"event":"worker.registered"')) {
    pass('trace has the register write: the helper writeAtomic of the registry, exit 0')
  } else {
    fail('trace has the register write: the helper writeAtomic of the registry, exit 0')
  }
} else if (has(`"event":"fs.write","path":"${REGN}.tmp.`) && traceLines().some(l => l.includes('"event":"process.run"') && l.includes(`${REGN}.tmp.`)) && has('"event":"worker.registered"')) {
  pass('trace has the register write: its temp file and the process.run of the rename')
} else {
  fail('trace has the register write: its temp file and the process.run of the rename')
}
// The Node helper: in use with no fallback where Node 22+ is on the sessions' PATH, else not found and never run.
const FALLBACKS = traceLines().filter(l => l.includes('"event":"helper.fallback"')).length
const HELPER_RUNS = traceLines().filter(l => l.includes('"event":"process.run","helper":"')).length
if (HELPER_WANTED) {
  if (has('"event":"helper","isActive":true') && HELPER_RUNS > 0 && FALLBACKS === 0) {
    pass(`trace: the Node helper in use (${firstMatch(traceText(), /"event":"helper","isActive":true,"version":"([^"]*)"/)}, ${HELPER_RUNS} helper runs), no helper.fallback line`)
  } else {
    const kinds = new Map()
    for (const m of traceText().matchAll(/"event":"helper[^}]*/g)) kinds.set(m[0], (kinds.get(m[0]) ?? 0) + 1)
    const listed = [...kinds].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 5).map(([k, n]) => `${String(n).padStart(7)} ${k}`).join(' ')
    fail(`trace: the Node helper in use, no helper.fallback line (${HELPER_RUNS} helper runs, ${FALLBACKS} fallbacks: ${listed} )`)
  }
} else if (has('"event":"helper","isActive":false') && HELPER_RUNS === 0 && FALLBACKS === 0) {
  pass(`trace: no Node found (${firstMatch(traceText(), /"event":"helper","isActive":false[^}]*/).replace(/.*"isActive":false,/, '')}), the built-in operations only, no helper run`)
} else {
  fail(`trace: no Node found, the built-in operations only (${HELPER_RUNS} helper runs, ${FALLBACKS} fallbacks)`)
}
if (has('"event":"worker.found"') && has('"isNamed":true,"isSocketSeen":true')) pass('trace: the worker.found line saw the name and the socket in the sessions file')
else fail('trace: the worker.found line saw the name and the socket in the sessions file')
if (has('"event":"completion"') && has('"outcome":"clean"')) pass(`trace: the completion line has the outcome clean (report check noted: ${firstMatch(traceText(), /"isReportNoted":([a-z]*)/)})`)
else fail('trace: the completion line has the outcome clean')
if (/sk-ant-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}|"(accessToken|refreshToken|apiKey)"/.test(traceText())) fail('trace: no token-like text (sk-ant-, a JWT, a token field)')
else pass('trace: no token-like text (sk-ant-, a JWT, a token field)')
if (has('"event":"worker.start"') && has('"isConfigDirSet":false')) pass('trace: the worker.start line sets no CLAUDE_CONFIG_DIR')
else fail('trace: the worker.start line sets no CLAUDE_CONFIG_DIR')
if (has('"licencePickCommand":"empty"') && has(`"registryPath":"${REGN}"`)) pass('trace shows the scratch options (scratch registry, no licence picker)')
else fail('trace shows the scratch options (scratch registry, no licence picker)')
const SN = native(S)
const OUTSIDE = traceLines()
  .flatMap(l => [...l.matchAll(/"event":"(?:fs\.(?:write|append)|process\.run","helper":"[A-Za-z]*)","path":"([^"]*)"/g)].map(m => m[1]))
  .filter(path => !path.includes(`${SN}/`))
  .slice(0, 3)
  .join('\n')
if (has('"event":"fs.write"') && !OUTSIDE) pass('trace: every file write is inside the scratch directory')
else fail(`trace: every file write is inside the scratch directory (outside: ${OUTSIDE})`)
if (has('work-[redacted]') && !has(CANARY)) pass('trace: the key-like canary in the worker directory is [redacted]')
else fail('trace: the key-like canary in the worker directory is [redacted]')
{
  // jq -e . over the trace: the whole file JSON values, at least one (a trace that is empty or blank gives jq no value,
  // exit 4), the last neither null nor false. A missing trace is jq's error.
  const values = fs.existsSync(TRACE) ? jsonValues(traceText()) : undefined
  if (values !== undefined && values.length > 0 && values.at(-1) !== null && values.at(-1) !== false) pass(`trace: all ${traceText().split('\n').length - 1} lines are JSON`)
  else fail('trace: all lines are JSON')
}

// ---------------------------------------------------------------- (b) interactive panel in tmux
if (which('tmux')) {
  TSOCK = `session-control-e2e-${process.pid}`
  const ISETTINGS = SETTINGS.replace(/^\{/, '{"tui":"fullscreen",')
  // The pane runs a node script of this test (no shell): claude in the pane's terminal, then its exit code, then a
  // sleep, so the pane stays after claude exits and a failure can show what it said.
  fs.writeFileSync(join(S, 'interactive.mjs'),
    "import { spawnSync } from 'node:child_process'\n" +
    // A ctrl+c that reaches this process while claude runs must not end the pane before claude does.
    "process.on('SIGINT', () => {})\n" +
    `const ran = spawnSync(${JSON.stringify(CLAUDE)}, ['--plugin-dir', ${JSON.stringify(MOD)}, '--model', 'haiku', '--settings', ${JSON.stringify(ISETTINGS)}], ` +
    `{ cwd: ${JSON.stringify(ORCH)}, stdio: 'inherit', env: { ...process.env, PATH: ${JSON.stringify(RUN_PATH)}, SESSION_CONTROL_DEBUG: '1' } })\n` +
    "process.stdout.write(`claude exited with ${ran.status ?? 128}\\n`)\n" +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300000)\n')
  const tmux = (...args) => spawnSync('tmux', ['-L', TSOCK, ...args], { encoding: 'utf8', timeout: 30_000 })
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'e2e', '-x', '200', '-y', '50', process.execPath, join(S, 'interactive.mjs'))
  const pane = () => tmux('capture-pane', '-p', '-t', 'e2e').stdout ?? ''
  const waitFor = async (pattern, seconds) => {
    const regex = new RegExp(pattern, 'i')
    for (let w = 0; w < seconds; w++) {
      if (regex.test(pane())) return true
      await sleep(1000)
    }
    return false
  }
  const showPane = (text, max, fromEnd = false) => {
    const shown = linesOf(text).map(l => `     | ${l}`).filter(l => !/^ {5}\| *$/.test(l))
    for (const l of fromEnd ? shown.slice(-max) : shown.slice(0, max)) console.log(l)
  }
  // A folder seen for the first time asks for trust first, with "No, exit" selected: the cursor goes down to the
  // option that trusts it, then Enter.
  const TRUST = new RegExp(`${String.fromCodePoint(0x276f)} *Yes, I trust this folder`)
  if ((await waitFor('trust this folder|shortcuts', 40)) && pane().includes('Yes, I trust this folder')) {
    await sleep(1000)
    let d = 0
    while (!TRUST.test(pane()) && d < 3) {
      tmux('send-keys', '-t', 'e2e', 'Down')
      await sleep(1000)
      d++
    }
    if (TRUST.test(pane())) {
      tmux('send-keys', '-t', 'e2e', 'Enter')
      info('answered the folder trust question: Yes, I trust this folder')
    } else {
      info('the trust question has no selectable "Yes, I trust this folder":')
      showPane(pane(), 30)
    }
  }
  // Typed again (the line cleared first) until the prompt shows it: keys sent while the screen starts are lost.
  for (let n = 0; n < 6; n++) {
    await sleep(3000)
    tmux('send-keys', '-t', 'e2e', 'C-u')
    tmux('send-keys', '-t', 'e2e', '-l', '/session-control')
    await sleep(2000)
    if (pane().includes('/session-control')) break
  }
  tmux('send-keys', '-t', 'e2e', 'Enter')
  if (!(await waitFor('QUEUED WORK', 15))) {
    tmux('send-keys', '-t', 'e2e', 'Enter')
    await waitFor('QUEUED WORK', 30)
  }
  await sleep(2000)
  const paneText = pane()
  fs.writeFileSync(join(S, 'pane.txt'), paneText)
  const missing = ['SESSIONS', 'QUEUED WORK', 'OPEN POINTS'].filter(title => !paneText.includes(title))
  if (missing.length === 0) {
    pass('interactive panel shows SESSIONS, QUEUED WORK and OPEN POINTS')
  } else {
    fail(`interactive panel shows SESSIONS, QUEUED WORK and OPEN POINTS (missing: ${missing.join(' ')}); the pane:`)
    showPane(paneText, 50)
  }
  if (traceLines().filter(l => l.includes('"event":"session.start"')).length >= 2 && has('"event":"command.run","command":"session-control"')) pass('trace has the interactive session start and its /session-control line')
  else fail('trace has the interactive session start and its /session-control line')
  // /exit is the engine's own command (no model call); two ctrl+c are the fallback.
  tmux('send-keys', '-t', 'e2e', 'C-u')
  tmux('send-keys', '-t', 'e2e', '-l', '/exit')
  await sleep(2000)
  tmux('send-keys', '-t', 'e2e', 'Enter')
  if (!(await waitFor('claude exited with', 15))) {
    tmux('send-keys', '-t', 'e2e', 'C-c')
    await sleep(1000)
    tmux('send-keys', '-t', 'e2e', 'C-c')
    await waitFor('claude exited with', 10)
  }
  if (pane().includes('claude exited with')) pass(`interactive session closed (${firstMatch(pane(), /(claude exited with [0-9]*)/)})`)
  else {
    fail('interactive session closed with /exit or ctrl+c')
    showPane(pane(), 15, true)
  }
  tmux('kill-server')
  TSOCK = ''
} else {
  skip('interactive panel (no tmux)')
}

// ---------------------------------------------------------------- (c) the prompt never in the trace; clean up
// In any capitalisation; a check that cannot run is a failure, never a pass.
const p1 = holdsCi(PROMPT_PHRASE, TRACE)
const p2 = holdsCi('nothing to wait for in the foreground', TRACE)
if (!(fs.existsSync(TRACE) && fs.statSync(TRACE).size > 0)) fail('trace: no line contains the prompt text (no trace)')
else if (p1 === 2 || p2 === 2) fail('trace: no line contains the prompt text (the check could not run)')
else if (p1 === 0 || p2 === 0) fail('trace: no line contains the prompt text')
else pass('trace: no line contains the prompt text')
// A process ended by the tmux server's exit may take a moment to go.
let LEFT = ''
for (let l = 0; ; l++) {
  LEFT = processesNaming(S)
  if (!LEFT || l >= 10) break
  await sleep(1000)
}
if (WPID && pidExists(WPID)) fail(`worker pid ${WPID} has exited`)
else if (LEFT) fail(`no process names the scratch directory: ${LEFT}`)
else pass('no orchestrator, worker, interactive claude or tmux process left')
WPID = ''
// The sessions this run started, by their transcripts (they stay under the config dir; the scratch directory goes).
const tag = sanitized(basename(S))
let projects = []
try {
  projects = fs.readdirSync(join(CFG_DIR, 'projects')).filter(name => name.includes(tag)).sort()
} catch {}
for (const p of projects) {
  let names = []
  try {
    names = fs.readdirSync(join(CFG_DIR, 'projects', p)).filter(name => name.endsWith('.jsonl')).sort()
  } catch {}
  for (const t of names) info(`session ${t.slice(0, -'.jsonl'.length)} in ${p}`)
}
if (process.env.KEEP_TRACE && fs.existsSync(TRACE)) {
  fs.copyFileSync(TRACE, process.env.KEEP_TRACE)
  info(`trace copied to ${process.env.KEEP_TRACE}`)
}
finish(S)
