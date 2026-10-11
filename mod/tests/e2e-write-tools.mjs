#!/usr/bin/env node
// Run with `node mod/tests/e2e-write-tools.mjs` (Node 22 or newer), from any directory; no sh, grep, tr, sed, jq or
// cygpath is needed.
//
// End-to-end test of the write-side tools of the session-control mod against the real claude, in a scratch directory
// it makes and removes. A headless haiku orchestrator (capped at --max-budget-usd 0.25) launches one tiny haiku worker
// ("reply PONG") through launch_worker with an inline prompt, a decisions section and the default rules, waits for it
// in the foreground, closes it with close_worker, retires three hostile registry entries (a result file that is a
// symbolic link out of the runs folder, one named through a `..` path, one named through a symbolic link to a folder)
// with retire_workers, calls archive_decisions on a scratch decisions file with two sections (one named by a queue task:
// refused; one free: archived) and calls list_sessions. Each tool's output is read from the orchestrator's own
// transcript and checked against the seeded data; the prompt file the mod wrote is copied the moment the worker's
// outcome is in the registry and checked for the section text and one rules block; the run files the retire deleted,
// the files the hostile entries name and the symbolic links (all outside the runs folder, all still there with their
// content), the archive, the summary line and the backup are checked on disk.
// Everything the mod reads or writes is in the scratch directory (registry, helper files, runs directory, trace); the
// real registry, helper files and runs directory are never touched, and the licence picker option is empty: the worker
// inherits the default configuration (this process's CLAUDE_CONFIG_DIR, else ~/.claude), where both transcripts stay.
// The symbolic links need a system that lets this process make them (Linux). One line per
// check; exit 1 on a failure. KEEP_OUT=<dir> copies the outputs, the prompt copy and the answer there before the
// scratch directory goes.

import * as fs from 'node:fs'
import {
  CFG_DEFAULT, LIB_URL, MOD, awaitOrchestrator, basename, byteSize, callCounts, entriesOf, finish, firstLine, globIn, grepF, isErrorFalse, join, jqPick, jsonValues, keepOut, kit, linesOf,
  localDate, native, nodeCommand, ours, processesNaming, readJson, readOr, removeTree, requireClaude, resultText, scratch,
  scratchSettings, shortId, signal, sleep, startClaude, toolUses, transcriptOf, writeJson, writeLines,
} from './lib/e2e.mjs'

const { pass, fail, info } = kit
const CLAUDE = requireClaude()
let orch
let WPID = ''
const S = scratch('session-control-e2e-write', dir => {
  if (orch?.alive() && ours(orch.pid, dir)) orch.stop()
  if (ours(WPID, dir)) signal(WPID)
  removeTree(dir)
})
const ORCH = join(S, 'orch')
const WORK = join(S, 'work')
const RUNS = join(S, 'runs')
const REG = join(S, 'headless-sessions.json')
const TRACE = join(RUNS, 'trace.log')

for (const d of [ORCH, WORK, RUNS]) fs.mkdirSync(d, { recursive: true })
const TODAY = localDate()
const FREE = 'E2E free unit'
const QUEUED = 'E2E queued unit - branch feature/e2e-queued'
const SECTION_MARKER = 'SECTION-MARKER-7f3a'
const PROMPT_MARKER = 'PROMPT-MARKER-c41e'

// ---------------------------------------------------------------- the seeded files
writeLines(join(ORCH, 'CLAUDE.md'), '# Role: Session Orchestrator', '', 'Scratch orchestrator of the session-control write-tools test: do exactly what the prompt says.')
writeLines(join(ORCH, 'agreed-decisions.md'), '# Agreed decisions', '', 'Scratch decisions of the write-tools test.', '',
  `## ${FREE}`, 'e2efree-1. The worker replies PONG and nothing else.', `e2efree-2. ${SECTION_MARKER}: this line reaches the worker prompt.`, '',
  `## ${QUEUED}`, 'e2eq-1. A queue task still names this unit.')
fs.copyFileSync(join(ORCH, 'agreed-decisions.md'), join(S, 'decisions-before.md'))
// The free section's lines as the file holds them (heading line to the next heading, its last blank line aside).
const FREE_TEXT = [`## ${FREE}`, 'e2efree-1. The worker replies PONG and nothing else.', `e2efree-2. ${SECTION_MARKER}: this line reaches the worker prompt.`].join('\n')
writeJson(join(ORCH, 'task-queue.json'), { tasks: [{ id: 'e2e-q', status: 'queued', title: 'Follow-up on feature/e2e-queued' }] })
writeJson(join(ORCH, 'open-points.json'), { points: [] })
writeLines(join(ORCH, 'open-points-archive.md'), '# Open points archive')
// Three hostile entries, finished and reported with a clean outcome, whose run files lead out of the runs folder; the
// files they lead to are scratch files of this test, with content to compare.
const OUT = join(S, 'outside')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(join(S, 'outside-dir'), { recursive: true })
fs.writeFileSync(join(OUT, 'secret1.txt'), 'outside secret 1\n')
fs.writeFileSync(join(OUT, 'secret2.txt'), 'outside secret 2\n')
fs.writeFileSync(join(S, 'outside-dir', 'secret3.txt'), 'outside secret 3\n')
try {
  fs.symlinkSync(join(OUT, 'secret1.txt'), join(RUNS, 'hostile-link.json'), 'file')
  fs.symlinkSync(join(S, 'outside-dir'), join(RUNS, 'hostile-dir'), 'dir')
} catch (error) {
  fail(`the symbolic links of the hostile entries made (${error.code})`)
  finish(S)
}
const H1 = '1a1a1a1a-0001-4001-8001-000000000001'
const H2 = '2b2b2b2b-0002-4002-8002-000000000002'
const H3 = '3c3c3c3c-0003-4003-8003-000000000003'
const hostile = (id, title, fields) => ({ title, session_id: id, config_dir: CFG_DEFAULT, cwd: WORK, reported: true, outcome: { kind: 'clean', summary: 'clean: hostile' }, ...fields })
writeJson(REG, [
  hostile(H1, 'hostile link', { result_file: `${RUNS}/hostile-link.json` }),
  hostile(H2, 'hostile dots', { result_file: `${RUNS}/../outside/secret2.txt` }),
  hostile(H3, 'hostile folder', { err_file: `${RUNS}/hostile-dir/secret3.txt` }),
])

// Once the worker's outcome is in the registry: a copy of the prompt file the mod wrote and the runs directory's
// listing, before close_worker deletes the run files. The script finds the registry, the scratch directory and the runs
// directory beside itself.
fs.writeFileSync(join(S, 'wait-outcome.mjs'),
  "import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'\n" +
  "import { dirname, join } from 'node:path'\n" +
  "import { fileURLToPath } from 'node:url'\n" +
  `import { jqLastTruthy, jqPick } from ${JSON.stringify(LIB_URL)}\n` +
  'const out = dirname(fileURLToPath(import.meta.url))\n' +
  "const [reg, runs] = [join(out, 'headless-sessions.json'), join(out, 'runs')]\n" +
  'const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)\n' +
  "const registry = () => { try { return JSON.parse(readFileSync(reg, 'utf8')) } catch { return undefined } }\n" +
  'let n = 0\n' +
  "while (!jqLastTruthy(registry(), 'e2e pong worker', 'outcome')) { n++; if (n > 100) process.exit(1); pause(3000) }\n" +
  "const p = jqPick(registry(), 'e2e pong worker', 'prompt_file')\n" +
  "if (p) try { copyFileSync(p, join(out, 'prompt-copy.md')) } catch {}\n" +
  "copyFileSync(reg, join(out, 'registry-at-outcome.json'))\n" +
  "writeFileSync(join(out, 'runs-at-outcome.txt'), readdirSync(runs).sort().map(name => name + '\\n').join(''))\n")
const SETTINGS = scratchSettings(native(ORCH), native(REG), native(RUNS))
const WORKER_PROMPT = `Reply with exactly the word PONG and nothing else. ${PROMPT_MARKER} (scratch directory ${S}).`
fs.writeFileSync(join(S, 'instruction.txt'),
  "This is an automated test of the session-control mod's write-side tools. Do exactly these steps, one after the other, and nothing else:\n" +
  `1. Call mcp__session-control__launch_worker once with exactly these inputs and no others: dir "${native(WORK)}", model "haiku", effort "low", title "e2e pong worker", timeout_minutes 5, section "${FREE}", prompt "${WORKER_PROMPT}". Give no prompt_file and no rules.\n` +
  `2. Run this one Bash command in the foreground, with a timeout of 600000 ms, and wait for it to finish: ${nodeCommand(join(S, 'wait-outcome.mjs'))}\n` +
  '3. Call mcp__session-control__close_worker with session_ids set to a list holding the full session id the launch tool returned in step 1.\n' +
  `4. Call mcp__session-control__retire_workers with session_ids ["${H1}", "${H2}", "${H3}"].\n` +
  `5. Call mcp__session-control__archive_decisions with sections ["${QUEUED}"].\n` +
  `6. Call mcp__session-control__archive_decisions with sections ["${FREE}"].\n` +
  '7. Call mcp__session-control__list_sessions with no input.\n' +
  'Then answer with one line: done.\n')

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
const pongOf = path => (readJson(path) ?? []).filter?.(e => e?.title === 'e2e pong worker').at(-1)
await awaitOrchestrator(orch, {
  limit: 540,
  dir: S,
  tick: async () => {
    if (!WPID) WPID = jqPick(readJson(REG), 'e2e pong worker', 'pid')
    await sleep(1000)
  },
  isOk: () => isErrorFalse(join(S, 'orchestrator.json')),
})
const ojson = readJson(join(S, 'orchestrator.json'))
const OSID = typeof ojson?.session_id === 'string' ? ojson.session_id : ''
info(`orchestrator cost USD ${ojson?.total_cost_usd ?? '?'}, session ${OSID} (config dir ${CFG_DEFAULT}, cwd ${ORCH})`)
const OT = transcriptOf(CFG_DEFAULT, OSID)
if (OSID && OT) pass(`orchestrator transcript found (${OT})`)
else fail(`orchestrator transcript found (session '${OSID}')`)
const entries = entriesOf(OT)

// The output of the n-th call of a tool, from the transcript's tool_result of that call.
const outPath = label => join(S, `out-${label}.txt`)
const calls = tool => toolUses(entries).filter(c => c.name === `mcp__session-control__${tool}`)
const out = (tool, n, label) => {
  const id = calls(tool)[n - 1]?.id
  if (!id) return false
  fs.writeFileSync(outPath(label), resultText(entries, id))
  return byteSize(outPath(label)) > 0
}
const has = (label, text) => grepF(readOr(outPath(label)), text)
const check = (label, text, what) => (has(label, text) ? pass(`${label}: ${what}`) : fail(`${label}: ${what} (missing: ${text})`))
const lacks = (label, text, what) => (has(label, text) ? fail(`${label}: ${what} (found: ${text})`) : pass(`${label}: ${what}`))
// The launch call that launched: the first launch_worker call whose answer says "Launched pid " (a refused or failed
// call before it, a retry of the model's, is passed over); the first call when none did, so the checks below fail.
const launches = calls('launch_worker')
let LAUNCH_N = 1
for (const [i, call] of launches.entries()) {
  if (resultText(entries, call.id).includes('Launched pid ')) {
    LAUNCH_N = i + 1
    break
  }
}
info(`launch_worker calls: ${launches.length}; judged: call ${LAUNCH_N} (the first that launched)`)
for (const [tool, n, label] of [['launch_worker', LAUNCH_N, 'launch'], ['close_worker', 1, 'close'], ['retire_workers', 1, 'hostile'], ['archive_decisions', 1, 'archive-refused'], ['archive_decisions', 2, 'archive'], ['list_sessions', 1, 'list']]) {
  if (out(tool, n, label)) pass(`${label}: ${tool} call ${n} was made and answered (${byteSize(outPath(label))} bytes)`)
  else {
    fail(`${label}: ${tool} call ${n} was made and answered`)
    fs.writeFileSync(outPath(label), '')
  }
}
info(`tool calls of the orchestrator: ${callCounts(entries)}`)
const input = launches[LAUNCH_N - 1]?.input
const INPUT = input === undefined ? '' : JSON.stringify(input)
if (input != null && input.prompt != null && input.prompt_file == null && input.section === FREE && input.rules == null) pass('launch: called with an inline prompt and the section, no prompt_file, rules left to the default')
else fail(`launch: called with an inline prompt and the section, no prompt_file, rules left to the default: ${INPUT}`)

// ---------------------------------------------------------------- launch_worker and the prompt file it wrote
// Every entry with the title, as jq gives them (two entries give two lines); the jq -e check below judges the last one.
const atOutcome = pongOf(join(S, 'registry-at-outcome.json'))
const regAtOutcome = readJson(join(S, 'registry-at-outcome.json'))
const SID = jqPick(regAtOutcome, 'e2e pong worker', 'session_id')
// cut -c1-8: the first 8 characters of each line.
const SID8 = SID.split('\n').map(line => line.slice(0, 8)).join('\n')
const RESULT_FILE = jqPick(regAtOutcome, 'e2e pong worker', 'result_file')
const ERR_FILE = jqPick(regAtOutcome, 'e2e pong worker', 'err_file')
const PROMPT_FILE = jqPick(regAtOutcome, 'e2e pong worker', 'prompt_file')
const WORKER_NAME = jqPick(regAtOutcome, 'e2e pong worker', 'name')
const OWN_PROMPT = `${native(RUNS)}/${WORKER_NAME}.prompt.md`
check('launch', 'Launched pid ', 'the worker was launched')
check('launch', ', registered. Name: w-e2e-pong-worker-', 'registered under its session name')
check('launch', `Prompt: ${OWN_PROMPT} (written by the mod; section "${FREE}" appended; rules block appended).`, 'the answer names the prompt file and what was appended')
if (WORKER_NAME && PROMPT_FILE === OWN_PROMPT) pass(`registry: prompt_file is the mod's file in the runs directory, named by the session name (${PROMPT_FILE})`)
else fail(`registry: prompt_file is the mod's file in the runs directory, named by the session name (got '${PROMPT_FILE}', name '${WORKER_NAME}')`)
if (atOutcome !== undefined && atOutcome.section === FREE && atOutcome.outcome?.kind === 'clean' && !Object.hasOwn(atOutcome, 'pid')) pass('registry: section recorded, outcome clean, pid dropped at the harvest')
else fail(`registry: section recorded, outcome clean, pid dropped at the harvest: ${readOr(join(S, 'registry-at-outcome.json')).slice(0, 400)}`)
const P = join(S, 'prompt-copy.md')
if (byteSize(P) > 0) {
  const ptext = readOr(P)
  const plines = linesOf(ptext)
  pass(`the prompt file was there at the worker's outcome (${byteSize(P)} bytes)`)
  if (firstLine(ptext).includes(WORKER_PROMPT)) pass('prompt file: starts with the prompt given')
  else fail(`prompt file: starts with the prompt given: ${firstLine(ptext)}`)
  if (plines.includes(`## Binding decisions (section ${FREE})`)) pass('prompt file: the section block title')
  else fail('prompt file: the section block title')
  if (plines.includes(`e2efree-2. ${SECTION_MARKER}: this line reaches the worker prompt.`) && plines.includes('e2efree-1. The worker replies PONG and nothing else.')) pass("prompt file: the section's two decision lines as the file holds them")
  else fail("prompt file: the section's two decision lines as the file holds them")
  if (ptext.includes('e2eq-1.')) fail("prompt file: the other section's text is not in it")
  else pass("prompt file: the other section's text is not in it")
  const N = plines.filter(l => l === '## Standard rules (session-control)').length
  if (N === 1) pass('prompt file: the rules block once')
  else fail(`prompt file: the rules block once (found ${N})`)
  const MISSING = ['no AI attribution trailer', 'never mention an agent', 'No human answers during the run', 'never for a sign-off item', 'Never read, print or pass a credential', 'run_in_background: true', 'foreground calls under ten minutes', 'Never end the turn while a run', '`git status -sb`', '`git log --oneline @{u}..HEAD`', 'exit code']
    .filter(phrase => !ptext.includes(phrase))
    .map(phrase => ` "${phrase}"`)
    .join('')
  if (!MISSING) pass('prompt file: the rules block carries each item')
  else fail(`prompt file: the rules block lacks${MISSING}`)
  const a = plines.findIndex(l => l.includes('## Binding decisions'))
  const rules = plines.map((l, i) => (l.includes('## Standard rules') ? i : -1)).filter(i => i >= 0)
  if (a >= 0 && rules.length === 1 && a < rules[0]) pass('prompt file: the section block comes before the rules block')
  else fail('prompt file: the section block comes before the rules block')
} else {
  fail('the prompt file was there at the worker outcome')
}
info(`run files at the outcome: ${readOr(join(S, 'runs-at-outcome.txt')).replaceAll('\n', ' ')}`)
if (RESULT_FILE) info(`worker session ${SID} (config dir ${CFG_DEFAULT}, cwd ${WORK})`)

// ---------------------------------------------------------------- close_worker and the run files
const NAME_JSON = basename(RESULT_FILE)
const NAME_ERR = basename(ERR_FILE)
const NAME_PROMPT = basename(PROMPT_FILE)
check('close', `Acknowledged: ${SID8}. Retired: ${SID8}.`, 'acknowledged, then retired')
check('close', `Run files deleted from ${native(RUNS)}: ${SID8} (${NAME_JSON}, ${NAME_ERR}, ${NAME_PROMPT}).`, 'the answer lists the run files deleted')
for (const f of [RESULT_FILE, ERR_FILE, PROMPT_FILE]) {
  if (f && !fs.existsSync(f)) pass(`run file deleted: ${basename(f)}`)
  else fail(`run file deleted: ${f}`)
}
const WT = transcriptOf(CFG_DEFAULT, SID)
if (SID && byteSize(WT) > 0) pass(`the worker's transcript stays (${WT})`)
else fail(`the worker's transcript stays (session '${SID}')`)
if (readJson(REG)?.length === 0) pass('registry: the entry is gone')
else fail(`registry: the entry is gone: ${readOr(REG).slice(0, 300)}`)
const CL = firstLine(readOr(join(RUNS, 'cleared.jsonl')))
const cleared = (() => {
  try {
    return JSON.parse(CL)
  } catch {
    return undefined
  }
})()
if (cleared?.session_id === SID && cleared?.outcome?.kind === 'clean' && typeof cleared?.cost_usd === 'number' && typeof cleared?.duration_ms === 'number' && typeof cleared?.prompt_file === 'string') {
  pass(`cleared.jsonl: the entry with its outcome, cost_usd ${cleared.cost_usd} and duration_ms ${cleared.duration_ms}`)
} else {
  fail(`cleared.jsonl: the entry with its outcome, cost_usd and duration_ms: ${CL.slice(0, 400)}`)
}

// ---------------------------------------------------------------- retire_workers over entries whose files lead out of the runs folder
check('hostile', `Retired: ${shortId(H1)}, ${shortId(H2)}, ${shortId(H3)}.`, 'the three hostile entries are retired')
check('hostile', 'not deleted: hostile-link.json: is a symbolic link', 'the symbolic link as a result file is named and kept')
check('hostile', 'not deleted: secret2.txt: the path has . or .. segments', 'the .. path is named and refused')
check('hostile', 'not deleted: secret3.txt: not directly in the runs folder', 'the file named through a linked folder is named and refused')
lacks('hostile', 'Run files deleted', 'nothing is reported deleted for them')
// "$(cat file)": the text without its last line ends.
const content = path => readOr(path).replace(/\n+$/, '')
if (content(join(OUT, 'secret1.txt')) === 'outside secret 1') pass('outside: the file the symbolic link leads to is intact')
else fail('outside: the file the symbolic link leads to is intact')
if (content(join(OUT, 'secret2.txt')) === 'outside secret 2') pass('outside: the file the .. path names is intact')
else fail('outside: the file the .. path names is intact')
if (content(join(S, 'outside-dir', 'secret3.txt')) === 'outside secret 3') pass('outside: the file behind the linked folder is intact')
else fail('outside: the file behind the linked folder is intact')
const isLink = path => {
  try {
    return fs.lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
if (isLink(join(RUNS, 'hostile-link.json')) && isLink(join(RUNS, 'hostile-dir'))) pass('the two symbolic links in the runs folder are still links')
else fail('the two symbolic links in the runs folder are still links')
// jq -s 'map(select(.title | startswith("hostile"))) | length': the whole file is read, so a part that is no JSON fails
// it, and so does an entry without a string title (startswith of anything else is jq's error).
const clearedAll = fs.existsSync(join(RUNS, 'cleared.jsonl')) ? jsonValues(readOr(join(RUNS, 'cleared.jsonl'))) : undefined
const titled = clearedAll?.every(e => e !== null && typeof e === 'object' && !Array.isArray(e) && typeof e.title === 'string') === true
if (titled && clearedAll.filter(e => e.title.startsWith('hostile')).length === 3) pass('cleared.jsonl: the three hostile entries are logged')
else fail('cleared.jsonl: the three hostile entries are logged')

// ---------------------------------------------------------------- archive_decisions
check('archive-refused', `nothing archived: "${QUEUED}" is still named: queue task e2e-q (queued) names it by feature/e2e-queued`, 'the section a queue task names is refused, saying which')
const SUMMARY = `- ${FREE} (ids e2efree-1 to e2efree-2): archived ${TODAY} to agreed-decisions-archive.md`
check('archive', `agreed-decisions.md: archived "${FREE}" to agreed-decisions-archive.md; the summary lines under "## Archived sections": ${SUMMARY}. Backup: backups/agreed-decisions-before-archive-decisions-${TODAY}.md (once per day).`, 'the free section is archived')
// The section ends with the blank line before the next heading.
const archiveWant = `# Agreed decisions archive\n\n# Archived ${TODAY} from agreed-decisions.md\n\n${FREE_TEXT}\n\n`
fs.writeFileSync(join(S, 'archive-want.md'), archiveWant)
const same = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}
if (same(join(S, 'archive-want.md'), join(ORCH, 'agreed-decisions-archive.md'))) pass('the archive file: its header, a dated header line, the section byte for byte')
else fail(`the archive file: ${readOr(join(ORCH, 'agreed-decisions-archive.md')).slice(0, 400).replaceAll('\n', '|')}`)
writeLines(join(S, 'decisions-want.md'), '# Agreed decisions', '', 'Scratch decisions of the write-tools test.', '', '## Archived sections', SUMMARY, '', `## ${QUEUED}`, 'e2eq-1. A queue task still names this unit.')
if (same(join(S, 'decisions-want.md'), join(ORCH, 'agreed-decisions.md'))) pass('the decisions file: one summary line under Archived sections, the queued section kept')
else fail(`the decisions file: ${readOr(join(ORCH, 'agreed-decisions.md')).slice(0, 400).replaceAll('\n', '|')}`)
if (same(join(S, 'decisions-before.md'), join(ORCH, 'backups', `agreed-decisions-before-archive-decisions-${TODAY}.md`))) pass('the backup holds the decisions file as it was')
else fail('the backup holds the decisions file as it was')
// ls "$ORCH"/*.tmp.*: a name with .tmp. in it that does not start with a dot.
if (fs.readdirSync(ORCH).some(name => !name.startsWith('.') && name.includes('.tmp.'))) fail('no temporary file left in the orchestrator directory')
else pass('no temporary file left in the orchestrator directory')

// ---------------------------------------------------------------- list_sessions
check('list', 'session row', 'the count line')
lacks('list', SID, 'the retired worker is no row')
check('list', `| cwd ${ORCH} | config_dir `, 'the orchestrator itself is the orphan row')

// ---------------------------------------------------------------- the trace keeps no prompt or section text
const trace = readOr(TRACE)
for (const marker of [PROMPT_MARKER, SECTION_MARKER, FREE]) {
  if (trace.includes(marker)) fail(`the trace does not hold "${marker}"`)
  else pass(`the trace does not hold "${marker}"`)
}
if (trace.includes('"event":"launch.prompt"') && trace.includes('"event":"retire.cleanup","deleted":1,"failed":0')) pass('the trace has the launch.prompt and retire.cleanup lines')
else fail('the trace has the launch.prompt and retire.cleanup lines')

if (process.env.KEEP_OUT) {
  const keep = process.env.KEEP_OUT
  keepOut(keep, [
    { files: [...globIn(S, /^out-.*\.txt$/, 'out-*.txt'), join(S, 'prompt-copy.md'), join(S, 'registry-at-outcome.json'), join(S, 'runs-at-outcome.txt'), join(S, 'orchestrator.json'), join(RUNS, 'cleared.jsonl'), TRACE] },
    { files: [join(ORCH, 'agreed-decisions.md')], name: 'agreed-decisions.after.md' },
    { files: [join(ORCH, 'agreed-decisions-archive.md')] },
  ])
  info(`outputs copied to ${keep}`)
}
const LEFT = processesNaming(S)
if (!LEFT) pass('no process names the scratch directory')
else fail(`no process names the scratch directory: ${LEFT}`)
finish(S)
