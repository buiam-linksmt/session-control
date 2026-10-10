import { describe, expect, test } from 'claude-code/testing'

import {
  annotateCleared,
  buildLaunchArgv,
  launchName,
  newRegistryEntry,
  reportCheck,
  resultReport,
  sessionFileFacts,
  workerName,
  WORKER_NAME,
  WORKER_SETTINGS,
  ackPeerNote,
  addPeerNote,
  boxAt,
  clampOffset,
  scrollbar,
  sectionBoxes,
  TOAST_TITLES,
  toastText,
  wrapText,
  retireVerdict,
  buildRows,
  nextBack,
  parseQueuedWork,
  pickWatched,
  summarizeTranscript,
  transcriptPath,
  unackedPeers,
  compactionDigest,
  checkLaunch,
  classifyResult,
  lintReport,
  missingPromptItems,
  parseOpenPoints,
  expandHome,
  formatHeader,
  holdOffset,
  formatRow,
  paneWidths,
  isPidAlive,
  mergeCompletion,
  parseProcFacts,
  parseRegistry,
  parseTaskNotification,
  pickArgv,
  PROBE_SCRIPT,
  probeArgs,
  rowStatus,
  statusLabel,
  registerEntry,
  removeEntries,
  ackEntries,
  FILES_PS1,
  PROBE_PS1,
  START_MATCH_MS,
  findNewWindowsWorker,
  findNewWorker,
  isHeadless,
  isLicenceRun,
  elapsedSeconds,
  formatAge,
  isSameWinPath,
  isWinAbsolute,
  tailLines,
  winPath,
  WINDOWS_PROMPT_MAX_CHARS,
  MSYS_REWRITTEN,
  windowsPickerRefusal,
  defaultConfigDir,
  isDefaultConfigDir,
} from '../hooks/core'
import type { LaunchArgs, LaunchFacts } from '../hooks/core'
import { freshText } from '../hooks/store'
import {
  DAEMON_RESUME,
  HOME,
  NOW_SEC,
  ORCH_DIR,
  PROBE_STDOUT,
  REGISTRY,
  REGISTRY_TEXT,
  RESULTS,
  REAL_RESULTS,
  REPORT_TEXTS,
  SID_ALIVE,
  SID_DEAD,
  SID_DONE,
  SID_REUSED,
  SID_UNREPORTED,
  TASK_NOTIFICATION_KILLED,
  REGISTRY_GOLDEN,
  WIN_PROBE_STDOUT,
  MSYS_PROMPTS,
} from './fixtures'
import type { SessionEntry } from '../types'

const facts = parseProcFacts(PROBE_STDOUT)
const statusLabelFor = (row: { status: never }) => statusLabel(row.status).slice(0, 6).padEnd(6)

describe('liveness (Abort check)', () => {
  const byPid = (pid: number) => REGISTRY.find(e => e.pid === pid)!
  test('a version-named comm with matching start ticks and session id is alive', () => {
    expect(isPidAlive(byPid(4101), facts)).toBe(true)
  })
  test('a reused pid (start ticks or session id differ) is not alive', () => {
    expect(isPidAlive(byPid(4106), facts)).toBe(false)
  })
  test('a pid with no sessions file is unverifiable, so not alive', () => {
    expect(isPidAlive(byPid(4102), facts)).toBe(false)
  })
})

describe('registry and /proc parsing', () => {
  test('parses the registry and keeps unknown fields', () => {
    const parsed = parseRegistry(REGISTRY_TEXT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.entries.length).toBe(6)
    expect(parsed.entries[1]?.resume).toEqual(DAEMON_RESUME)
  })

  test('refuses a registry that is not an array, accepts an empty file', () => {
    expect(parseRegistry('{"a":1}').ok).toBe(false)
    expect(parseRegistry('not json').ok).toBe(false)
    expect(parseRegistry('  ')).toEqual({ ok: true, entries: [] })
  })

  test('parses probe lines and skips garbage', () => {
    expect(facts.claude.length).toBe(3)
    expect(facts.pidComm.get(4101)).toBe('2.1.292')
    expect(facts.pidComm.get(4106)).toBe('bash')
    expect(facts.transcriptMtime.get(SID_ALIVE)).toBe(NOW_SEC - 30)
    expect(facts.claude[0]?.configDir).toBe('/fixture/lic/a')
  })

  test('probe args list each pid and each transcript to stat', () => {
    expect(probeArgs(REGISTRY)).toEqual([
      'pid:4101|/fixture/lic/a',
      `t:${SID_ALIVE}|/fixture/lic/a`,
      'pid:4102|/fixture/lic/b',
      `t:${SID_DEAD}|/fixture/lic/b`,
      `t:${SID_UNREPORTED}|/fixture/lic/a`,
      't:dddddddd-4444-4444-8444-444444444444|/fixture/lic/a',
      'pid:4106|/fixture/lic/c',
      `t:${SID_REUSED}|/fixture/lic/c`,
    ])
  })
})

describe('row status', () => {
  test('alive, dead, unreported, queued, done, pid reuse', () => {
    expect(REGISTRY.map(entry => rowStatus(entry, facts))).toEqual([
      'alive',
      'dead',
      'unreported',
      'queued',
      'done',
      'dead',
    ])
  })

  test('rows add an orphan for an unclaimed headless claude, not for the interactive one', () => {
    const rows = buildRows(REGISTRY, facts, NOW_SEC)
    const orphans = rows.filter(row => row.status === 'orphan')
    expect(orphans.length).toBe(1)
    expect(orphans[0]?.pid).toBe(4999)
    expect(rows[0]?.status).toBe('alive')
    expect(rows[0]?.elapsedSec).toBe(125)
    expect(rows[0]?.transcriptAgeSec).toBe(30)
    expect(rows.length).toBe(7)
  })

  test('a pane row is cut to the width', () => {
    const row = buildRows(REGISTRY, facts, NOW_SEC)[0]!
    expect(formatRow(row, 200)).toContain('alive worker')
    expect(formatRow(row, 30).length).toBe(30)
    expect(formatRow(row, 100).startsWith('alive worker')).toBe(true)
    expect(formatRow(row, 100)).toContain('running')
    expect(formatRow(row, 100)).not.toContain('/fixture/lic')
  })
})

describe('licence runs are not orphans', () => {
  // Command lines as the probes print them: Linux joins the arguments with spaces, Windows gives CommandLine as is.
  const LICENCE = [
    'claude -p /usage --output-format json --no-session-persistence',
    'claude -p ok --dangerously-skip-permissions',
    'claude -p ok',
    '/home/u/.local/bin/claude -p /usage --output-format json --no-session-persistence',
    '"C:\\Users\\u\\.local\\bin\\claude.exe" -p /usage --output-format json --no-session-persistence',
    '"C:\\Users\\u\\.local\\bin\\claude.exe" -p "ok" --dangerously-skip-permissions',
    'C:\\Users\\u\\.local\\bin\\claude.exe --print ok',
  ]
  const WORKER_PROMPT = '-n w-check-usage-261010173723 --settings {"crossSessionInbound":"accept"} --dangerously-skip-permissions --output-format json --'
  const WORKERS = [
    `claude -p --model opus ${WORKER_PROMPT} Goal: read the /usage text and report`,
    `claude -p --model haiku ${WORKER_PROMPT} /usage`,
    `claude -p --model haiku ${WORKER_PROMPT} ok`,
    'claude -p /usage is high: find out why and report',
    'claude -p ok, now run the suite --verbose',
    'claude -p ok -- go on',
    'claude --print --model sonnet',
    `"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus ${WORKER_PROMPT} "Goal: read the /usage text"`,
    '"C:\\Users\\u\\.local\\bin\\claude.exe" -p "ok then check /usage"',
  ]
  const probeLine = (pid: number, cwd: string, cmd: string) => ['P', pid, 'claude', 1, cwd, '/fixture/lic/a', cmd].join('\t')

  test('the usage probe and the token wake, Linux and Windows, are licence runs; worker command lines are not', () => {
    expect(LICENCE.map(isLicenceRun)).toEqual(LICENCE.map(() => true))
    expect(WORKERS.map(isLicenceRun)).toEqual(WORKERS.map(() => false))
    expect(LICENCE.every(isHeadless)).toBe(true)
  })

  test('no orphan row for a licence run; an unregistered worker is still one, a prompt holding /usage too', () => {
    for (const [stdout, isWin] of [[PROBE_STDOUT, false], [WIN_PROBE_STDOUT, true]] as const) {
      const extra = [...LICENCE, ...WORKERS].map((cmd, i) => probeLine(8000 + i, isWin ? 'C:\\' : '/', cmd))
      const rows = buildRows(REGISTRY, parseProcFacts([stdout, ...extra].join('\n')), NOW_SEC)
      const orphans = rows.filter(row => row.status === 'orphan').map(row => row.pid)
      expect(orphans).toEqual([4999, ...WORKERS.map((_, i) => 8000 + LICENCE.length + i)])
    }
  })

  test('the new-worker match never takes a licence run: it has no --model', () => {
    const want = { dir: '/', configDir: '/fixture/lic/a', model: 'opus' }
    const probes = parseProcFacts(LICENCE.map((cmd, i) => probeLine(8000 + i, '/', cmd)).join('\n'))
    expect(findNewWorker(probes, want, new Set())).toBeUndefined()
    const bare = parseProcFacts(LICENCE.map((cmd, i) => ['P', 8000 + i, 'claude', 1, '', '', cmd].join('\t')).join('\n'))
    expect(findNewWindowsWorker(bare, { ...want, dir: 'C:\\' }, new Set(), 5)).toBeUndefined()
  })
})

describe('completion classifier', () => {
  test('clean', () => {
    const out = classifyResult(RESULTS.clean)
    expect(out.kind).toBe('clean')
    expect(out.costUsd).toBe(1.23)
  })
  test('limit', () => expect(classifyResult(RESULTS.limit).kind).toBe('limit'))
  test('login', () => expect(classifyResult(RESULTS.login).kind).toBe('login'))
  test('chatter', () => expect(classifyResult(RESULTS.chatter).kind).toBe('chatter'))
  test('a short answer from a short run is clean', () => expect(classifyResult(RESULTS.shortAnswer).kind).toBe('clean'))
  test('an empty result is chatter', () => expect(classifyResult(JSON.stringify({ result: '', is_error: false })).kind).toBe('chatter'))
  test('empty or truncated result is killed', () => {
    expect(classifyResult(RESULTS.empty).kind).toBe('killed')
    expect(classifyResult(RESULTS.truncated).kind).toBe('killed')
  })
  test('low on memory is killed', () => expect(classifyResult(RESULTS.oom).kind).toBe('killed'))
  test('task status killed wins over a clean-looking result', () => {
    expect(classifyResult(RESULTS.clean, 'killed').kind).toBe('killed')
  })
  test('other is_error is error', () => expect(classifyResult(RESULTS.error).kind).toBe('error'))
  test('a normal report that quotes the login message is clean (the two reports once labelled login)', () => {
    expect(classifyResult(REAL_RESULTS.designReport)).toMatchObject({ kind: 'clean', costUsd: 9.5 })
    expect(classifyResult(REAL_RESULTS.probeReport).kind).toBe('clean')
    expect(classifyResult(REAL_RESULTS.designReport, 'completed', '').kind).toBe('clean')
  })
  test('a normal report that quotes limit or memory messages is clean too', () => {
    const report = "Checked the classifier: a run ends with \"You've hit your session limit · resets 3pm\" or \"Invalid API key · Please run /login\"; the kernel log had no out of memory or oom-kill line. All 12 tests pass."
    expect(classifyResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: report })).kind).toBe('clean')
  })
  test('genuine engine errors: limit and login from the error result text or the API status', () => {
    expect(classifyResult(REAL_RESULTS.limitError).summary).toBe('limit: rate limit hit')
    expect(classifyResult(REAL_RESULTS.limitStatus).kind).toBe('limit')
    expect(classifyResult(REAL_RESULTS.loginRefreshFailed).summary).toBe('login: licence needs a re-login')
    expect(classifyResult(REAL_RESULTS.loginExpired).kind).toBe('login')
    expect(classifyResult(REAL_RESULTS.loginStatus).kind).toBe('login')
  })
  test('the error file is a reliable signal when the result is not a success: login, limit or memory there decide', () => {
    expect(classifyResult('', undefined, 'Invalid API key · Please run /login\n').kind).toBe('login')
    expect(classifyResult(REAL_RESULTS.maxTurns, undefined, "Error: You've hit your weekly limit\n").kind).toBe('limit')
    expect(classifyResult('', 'failed', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n').summary).toBe('killed: killed (memory)')
    // An error file with other text changes nothing.
    expect(classifyResult(REAL_RESULTS.designReport, undefined, 'warning: something unrelated\n').kind).toBe('clean')
  })
  test('a success result is clean whatever its error file says: stderr may hold a benign limit-like line', () => {
    expect(classifyResult(REAL_RESULTS.designReport, undefined, 'usage limit reached, retrying in 5s\n').kind).toBe('clean')
    expect(classifyResult(REAL_RESULTS.designReport, 'completed', 'Invalid API key · Please run /login\n').kind).toBe('clean')
    // The task status still counts: a killed task is killed.
    expect(classifyResult(REAL_RESULTS.designReport, 'killed', 'usage limit reached, retrying\n').kind).toBe('killed')
  })
  test('a failed run, a truncated or a missing result: the error file decides', () => {
    expect(classifyResult(REAL_RESULTS.maxTurns, undefined, "Error: You've hit your session limit\n").kind).toBe('limit')
    expect(classifyResult(REAL_RESULTS.limitError.replace(/hit your session limit/, 'did not finish'), undefined, 'usage limit reached\n').kind).toBe('limit')
    const truncated = REAL_RESULTS.designReport.slice(0, 120)
    expect(classifyResult(truncated, undefined, 'Invalid API key · Please run /login\n').kind).toBe('login')
    expect(classifyResult('', 'failed', "Error: You've hit your weekly limit\n").kind).toBe('limit')
  })
  test('a failed run whose message is only in errors[] or error is labelled from it', () => {
    const failed = (fields: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, ...fields })
    expect(classifyResult(failed({ errors: ["You've hit your session limit · resets 3pm"] })).kind).toBe('limit')
    expect(classifyResult(failed({ errors: ['one', 5, 'Please run /login'] })).kind).toBe('login')
    expect(classifyResult(failed({ error: 'Failed to authenticate: OAuth session expired' })).kind).toBe('login')
    expect(classifyResult(failed({ errors: ['tool crashed'] })).kind).toBe('error')
    // A run that is not a failure never takes its label from errors[].
    expect(classifyResult(JSON.stringify({ subtype: 'success', is_error: false, result: 'Done. All twelve tests pass.', errors: ['usage limit reached'] })).kind).toBe('clean')
  })
  test('a success with is_error false that carries a bare limit text stays clean on purpose', () => {
    // The engine sets is_error on a real failure, so this is a report quoting the message, not a limit.
    expect(classifyResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: "You've hit your session limit · resets 3pm" })).kind).toBe('clean')
  })
  test('a subtype other than success is an error, with the subtype when there is no text', () => {
    expect(classifyResult(REAL_RESULTS.maxTurns).summary).toBe('error: error_max_turns')
  })
  test('the old matches on a failed run still hold: the old fixtures keep their labels', () => {
    expect(classifyResult(RESULTS.limit).kind).toBe('limit')
    expect(classifyResult(RESULTS.login).kind).toBe('login')
    expect(classifyResult(RESULTS.oom).kind).toBe('killed')
  })
  test('every outcome has a toast title, and the toast is the title, a separator, then the message', () => {
    const titles = (['clean', 'limit', 'login', 'killed', 'error', 'chatter'] as const).map(kind => TOAST_TITLES[kind])
    expect(titles).toEqual(['Session finished', 'Usage limit reached', 'Login needed', 'Session killed', 'Session failed', 'Session ended without a report'])
    expect([TOAST_TITLES.tracking, TOAST_TITLES.directWrite, TOAST_TITLES.trace]).toEqual(['Tracking problem', 'Write not atomic', 'Debug trace failed'])
    expect(toastText(TOAST_TITLES[classifyResult(RESULTS.oom).kind], 'w: killed (memory)')).toBe('Session killed \u00B7 w: killed (memory)')
  })
  test('task notification parse', () => {
    expect(parseTaskNotification(TASK_NOTIFICATION_KILLED)).toEqual({
      taskId: 'b7x1',
      status: 'killed',
      outputFile: '/tmp/tasks/b7x1.output',
    })
  })
})

describe('registry merge in place', () => {
  test('drops pid, sets reported:false, keeps resume and unknown fields, leaves others alone', () => {
    const merged = mergeCompletion(REGISTRY_TEXT, SID_DEAD, classifyResult(RESULTS.limit), NOW_SEC)
    expect(merged.changed).toBe(true)
    if (!merged.changed) return
    const after = JSON.parse(merged.text) as Record<string, unknown>[]
    const entry = after[1]!
    expect('pid' in entry).toBe(false)
    expect(entry.reported).toBe(false)
    expect(entry.resume).toEqual(DAEMON_RESUME)
    expect(entry.unknown_future_field).toEqual([1, 2, 3])
    expect(entry.result_file).toBe('/fixture/results/limit.json')
    expect((entry.outcome as { kind: string }).kind).toBe('limit')
    expect(entry.ended_at).toBe(NOW_SEC)
    expect(after.length).toBe(REGISTRY.length)
    expect(after.filter((_, i) => i !== 1)).toEqual(REGISTRY.filter((_, i) => i !== 1))
  })

  test('refuses an entry already harvested or missing', () => {
    expect(mergeCompletion(REGISTRY_TEXT, SID_UNREPORTED, classifyResult(RESULTS.clean), NOW_SEC).changed).toBe(false)
    expect(mergeCompletion(REGISTRY_TEXT, 'nope', classifyResult(RESULTS.clean), NOW_SEC).changed).toBe(false)
    expect(mergeCompletion('{', SID_DEAD, classifyResult(RESULTS.clean), NOW_SEC).changed).toBe(false)
  })
})

const N = 'w-new-261010120000'

describe('launch guard', () => {
  const base: LaunchArgs = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 't' }
  const ctx = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
    home: HOME,
    orchestratorDir: ORCH_DIR,
    entries: REGISTRY,
    facts,
    pick: { exitCode: 0, stdout: '/fixture/lic/a\n' },
    ...over,
  })

  test('the picker command becomes an argv', () => {
    expect(pickArgv('~/bin/pick --need {need}', 25, '/home/u')).toEqual(['/home/u/bin/pick', '--need', '25'])
    expect(pickArgv('  pick   {need} ', 40, '/h')).toEqual(['pick', '40'])
  })
  test('passes with a licence pick', () => {
    expect(checkLaunch(base, ctx())).toEqual({ ok: true, configDir: '/fixture/lic/a' })
  })
  test('refuses an empty pick and exit 3', () => {
    expect(checkLaunch(base, ctx({ pick: { exitCode: 0, stdout: '' } })).ok).toBe(false)
    const three = checkLaunch(base, ctx({ pick: { exitCode: 3, stdout: '', stderr: 'no licence has 40%' } }))
    expect(three).toEqual({ ok: false, reason: 'no licence has room: no licence has 40%' })
    expect(checkLaunch(base, ctx({ pick: undefined })).ok).toBe(false)
  })
  test('refuses cwd = orchestrator dir or $HOME, trailing slash included', () => {
    expect(checkLaunch({ ...base, dir: ORCH_DIR + '/' }, ctx()).ok).toBe(false)
    expect(checkLaunch({ ...base, dir: HOME }, ctx()).ok).toBe(false)
    expect(checkLaunch({ ...base, dir: 'relative' }, ctx()).ok).toBe(false)
  })
  test('requires model and effort', () => {
    expect(checkLaunch({ ...base, model: '' }, ctx())).toEqual({ ok: false, reason: 'model is required' })
    expect(checkLaunch({ ...base, effort: '' }, ctx()).ok).toBe(false)
    expect(checkLaunch({ ...base, effort: 'turbo' }, ctx()).ok).toBe(false)
  })
  test('refuses a resume while the pid is alive', () => {
    const verdict = checkLaunch({ ...base, resume_sid: SID_ALIVE }, ctx({ transcriptExists: true }))
    expect(verdict).toEqual({ ok: false, reason: 'refused: pid 4101 of that session is alive' })
  })
  test('a resume runs under the entry config dir, never a pick, and needs the transcript there', () => {
    expect(checkLaunch({ ...base, resume_sid: SID_UNREPORTED }, ctx({ pick: undefined, transcriptExists: true }))).toEqual({
      ok: true,
      configDir: '/fixture/lic/a',
      resumeSid: SID_UNREPORTED,
    })
    expect(checkLaunch({ ...base, resume_sid: SID_UNREPORTED }, ctx({ transcriptExists: false })).ok).toBe(false)
    expect(checkLaunch({ ...base, resume_sid: 'ffffffff-0000-4000-8000-000000000000' }, ctx()).ok).toBe(false)
  })
  test('the would-run command quotes every value', () => {
    const argv = buildLaunchArgv({ ...base, title: "it's" , dir: "/work/it's" }, { name: N, configDir: '/fixture/lic/a' }, '/work/r.json')
    expect(argv[0]).toBe('sh')
    expect(argv[2]).toContain(`cd '/work/it'\\''s'`)
    expect(argv[2]).toContain(`CLAUDE_CONFIG_DIR='/fixture/lic/a' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus'`)
  })
  test('expandHome', () => {
    expect(expandHome('~/.claude/x.json', HOME)).toBe('/fixture/home/.claude/x.json')
    expect(expandHome('/abs', HOME)).toBe('/abs')
  })
})

describe('probe script text', () => {
  // The script is shell inside a JS string: a nested double quote that lost its backslash breaks `sh`
  // (it did once, and the pid proof and the transcript lookup silently returned nothing).
  // The syntax and behaviour under a real `sh` are checked by tests/probe-selftest.py.
  test('reads the sessions file with jq and keeps no sed pattern with bare nested quotes', () => {
    expect(PROBE_SCRIPT).toContain('jq -r ".procStart // empty"')
    expect(PROBE_SCRIPT).toContain('jq -r ".sessionId // empty"')
    expect(PROBE_SCRIPT).not.toMatch(/sed -n "s\/\.\*"/)
  })
})

describe('launch guard: prompt file', () => {
  test('refuses a missing or empty prompt file', () => {
    const base = { dir: '/work', prompt_file: '/p.txt', model: 'opus', effort: 'high', title: 't' }
    const facts = { home: '/h', orchestratorDir: '/o', entries: [], facts: { claude: [], pidComm: new Map(), pidProof: new Map(), transcriptMtime: new Map() }, pick: { exitCode: 0, stdout: '/lic\n' } }
    expect(checkLaunch(base, { ...facts, promptFileOk: false })).toEqual({ ok: false, reason: 'refused: prompt file /p.txt is missing or empty' })
    expect(checkLaunch(base, { ...facts, promptFileOk: true }).ok).toBe(true)
  })
})

describe('status labels', () => {
  test('status words', () => {
    expect(['alive', 'dead', 'unreported', 'queued', 'orphan', 'done'].map(s => statusLabel(s as never))).toEqual([
      'running', 'finished-unharvested', 'finished-unreported', 'queued', 'orphan', 'finished',
    ])
  })
})


describe('pane columns', () => {
  test('columns sit close and line up with the header', () => {
    const rows = buildRows(REGISTRY, facts, NOW_SEC)
    const widths = paneWidths(rows, 160)
    const header = formatHeader(160, widths)
    const lines = rows.map(row => formatRow(row, 160, widths))
    const at = header.indexOf('status')
    for (const [i, line] of lines.entries()) expect(line.slice(at, at + 6)).toBe(statusLabelFor(rows[i]!))
    expect(header.indexOf('sid')).toBeLessThan(at)
    expect(lines[0]!.slice(header.indexOf('sid'), header.indexOf('sid') + 8)).toBe(rows[0]!.sid8 || '-'.padEnd(8))
    expect(widths.title).toBeLessThan(40)
    expect(header.indexOf('model')).toBeLessThan(80)
  })

  test('a long title shrinks to fit a narrow pane', () => {
    const rows = buildRows(REGISTRY, facts, NOW_SEC)
    const widths = paneWidths(rows, 70)
    expect(formatRow(rows[0]!, 70, widths).length).toBeLessThanOrEqual(70)
  })
})

describe('elapsed column', () => {
  const timed = REGISTRY.map(entry => {
    if (entry.session_id === SID_ALIVE) return { ...entry, started_at: NOW_SEC - 42 }
    if (entry.session_id === SID_UNREPORTED) return { ...entry, started_at: NOW_SEC - 4000, ended_at: NOW_SEC - 3688 }
    if (entry.session_id === SID_DONE) return { ...entry, started_at: NOW_SEC - 9000, ended_at: NOW_SEC - 5000 }
    return entry
  })
  const at = (sec: number) => ({ nowSec: NOW_SEC + sec, probedSec: NOW_SEC })
  const textOf = (rows: ReturnType<typeof buildRows>, title: string, sec: number) => {
    const row = rows.find(one => one.title === title)!
    return formatRow(row, 200, paneWidths(rows, 200, at(sec)), at(sec)).trimEnd().split(/\s+/).at(-1)
  }

  test('42s under a minute, 5m12s under an hour, 1h05m from an hour up', () => {
    expect([0, 42, 59.9, 60, 312, 3599, 3600, 3900, 3959, 86_400 + 61].map(formatAge)).toEqual(['0s', '42s', '59s', '1m00s', '5m12s', '59m59s', '1h00m', '1h05m', '1h05m', '24h01m'])
  })

  test('a running entry counts from started_at, a finished one shows its run, an orphan and an older entry the probe age', () => {
    const rows = buildRows(timed, facts, NOW_SEC)
    expect(rows.find(one => one.sid === SID_ALIVE)).toMatchObject({ startedAt: NOW_SEC - 42, elapsedSec: 125 })
    expect(textOf(rows, 'alive worker', 0)).toBe('42s')
    expect(textOf(rows, 'alive worker', 30)).toBe('1m12s')
    expect(textOf(rows, 'unreported worker', 30)).toBe('5m12s')
    expect(textOf(rows, 'done worker', 30)).toBe('1h06m')
    // The orphan: 2400 s at the probe, then the display clock's seconds since.
    expect(textOf(rows, '(no entry) /work/x', 0)).toBe('40m00s')
    expect(textOf(rows, '(no entry) /work/x', 7)).toBe('40m07s')
    // Entries without the fields stay valid: the probe age while running, '-' once finished.
    const old = buildRows(REGISTRY, facts, NOW_SEC)
    expect(textOf(old, 'alive worker', 5)).toBe('2m10s')
    expect(textOf(old, 'unreported worker', 5)).toBe('-')
    expect(textOf(old, 'limited worker', 5)).toBe('-')
  })

  test('without a display clock the row shows what the probe left; a started_at in the future reads 0s', () => {
    const rows = buildRows(timed, facts, NOW_SEC)
    expect(formatRow(rows[0]!, 200).trimEnd().endsWith('2m05s')).toBe(true)
    expect(elapsedSeconds({ ...rows[0]!, startedAt: NOW_SEC + 5 }, at(0))).toBe(0)
    expect(elapsedSeconds({ ...rows[0]!, status: 'dead', endedAt: undefined }, at(0))).toBe(125)
  })

  test('the columns stay put while the seconds tick: the elapsed column is as wide as its header', () => {
    const rows = buildRows(timed, facts, NOW_SEC)
    const widths = [0, 1, 17, 59, 61, 600, 3599, 3600].map(sec => paneWidths(rows, 120, at(sec)))
    expect(widths.every(one => JSON.stringify(one) === JSON.stringify(widths[0]))).toBe(true)
  })
})

describe('worker prompt checklist', () => {
  const full = 'Wait in the foreground. Report `git status -sb`. No AI attribution trailer.'
  test('a complete prompt passes', () => {
    expect(missingPromptItems(full)).toEqual([])
  })
  test('lists what is missing', () => {
    expect(missingPromptItems('Just do the work.').length).toBe(3)
    expect(missingPromptItems('Wait in the foreground.').join()).toContain('git status -sb')
  })
  test('a skill-test prompt is exempt', () => {
    expect(missingPromptItems('This is a skill test: run it.')).toEqual([])
  })
})

describe('compaction digest', () => {
  test('names live workers, unreported ones and the open points', () => {
    const text = compactionDigest(buildRows(REGISTRY, facts, NOW_SEC), [{ id: 'a', title: 'Pick one', detail: '', recommendation: '' }])
    expect(text).toContain('aaaaaaaa alive worker (pid 4101)')
    expect(text).toContain('Finished and not yet reported: cccccccc unreported worker')
    expect(text).toContain('1. Pick one')
    expect(text).toContain('Re-read the registry')
  })
  test('an empty registry and no points', () => {
    const text = compactionDigest([], [])
    expect(text).toContain('none running')
    expect(text).toContain('Open points: none')
  })
})

describe('peer ledger', () => {
  const sent = addPeerNote(addPeerNote([], 'obsidian-manager', 'Update the daily note for 2026-10-09', 1), 'wsl', 'Check the host clock', 2)

  test('a send stays open until a reply', () => {
    expect(unackedPeers(sent)).toEqual(['obsidian-manager', 'wsl'])
  })

  test('a reply naming the peer clears that peer only', () => {
    expect(unackedPeers(ackPeerNote(sent, 'obsidian-manager: the note is updated'))).toEqual(['wsl'])
  })

  test('an unnamed reply clears nothing while two are open, and the single one when one is open', () => {
    expect(unackedPeers(ackPeerNote(sent, 'done'))).toEqual(['obsidian-manager', 'wsl'])
    expect(unackedPeers(ackPeerNote(sent.slice(0, 1), 'done'))).toEqual([])
  })
})

describe('live view helpers', () => {
  test('the transcript path follows the config dir and the cwd', () => {
    expect(transcriptPath({ config_dir: '/c', cwd: '/home/u/work_space/x', session_id: 'abc' })).toBe('/c/projects/-home-u-work-space-x/abc.jsonl')
    expect(transcriptPath({ title: 'no cwd' })).toBeUndefined()
  })
  test('picks by sid prefix, by title, or the first running one', () => {
    const rows = buildRows(REGISTRY, facts, NOW_SEC)
    expect(pickWatched(rows, '')?.title).toBe('alive worker')
    expect(pickWatched(rows, 'aaaa')?.title).toBe('alive worker')
    expect(pickWatched(rows, 'limited')?.title).toBe('limited worker')
    expect(pickWatched(rows, 'nothing')).toBeUndefined()
  })
  test('summarizes assistant text, tool calls and results, newest last', () => {
    const tail = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Plan: edit it."},{"type":"tool_use","name":"Edit","input":{"file_path":"/a/b.ts"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","is_error":false}]}}',
      'half a line {',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"boom","is_error":true}]}}',
    ].join('\n')
    expect(summarizeTranscript(tail, 10)).toEqual(['Plan: edit it.', '> Edit /a/b.ts', '  < ok', '  < ERROR boom'])
    expect(summarizeTranscript(tail, 2)).toEqual(['  < ok', '  < ERROR boom'])
  })
})

describe('completion summary line', () => {
  test('skips a bare markdown heading and a # heading', () => {
    const summaryOf = (result: string) =>
      classifyResult(JSON.stringify({ type: 'result', is_error: false, result, duration_ms: 90000, num_turns: 9, total_cost_usd: 0.5 })).summary
    expect(summaryOf('**Summary**\n\n1. The top level has 15 files in the compose directory.')).toContain('The top level has 15 files')
    expect(summaryOf('## Summary of the repository\n\nThe repository holds the compose files for the stack.')).toContain('The repository holds the compose files')
  })
})

describe('panel helpers', () => {
  test('queued work keeps queued tasks in file order', () => {
    const text = JSON.stringify({ tasks: [{ status: 'queued', title: 'A' }, { status: 'done', title: 'B' }, { status: 'queued', title: 'C' }] })
    expect(parseQueuedWork(text)).toEqual([{ title: 'A' }, { title: 'C' }])
    const running = JSON.stringify({ tasks: [{ status: 'running', title: 'R' }, { status: 'running (worker x)', title: 'S' }, { status: 'queued', title: 'Q' }] })
    expect(parseQueuedWork(running)).toEqual([{ title: 'R', running: true }, { title: 'Q' }])
    expect(parseQueuedWork('{')).toBeNull()
  })
})

describe('output box scrolling', () => {
  test('a wheel move changes how far back the box is, inside the history', () => {
    expect(nextBack(0, -3, 50, 10)).toBe(3)
    expect(nextBack(3, 2, 50, 10)).toBe(1)
    expect(nextBack(1, 5, 50, 10)).toBe(0)
    expect(nextBack(39, -5, 50, 10)).toBe(40)
  })
})

describe('pane offset while the box scrolls', () => {
  test('stays a whole row inside the pane range', () => {
    expect(holdOffset(10, 3, 100, 20)).toBe(7)
    expect(holdOffset(10, -3, 100, 20)).toBe(13)
    expect(holdOffset(0, -1, 100, 20)).toBe(0)
    expect(holdOffset(80, 2, 100, 20)).toBe(80)
    expect(holdOffset(5, 1.5, 100, 20)).toBe(4)
    expect(holdOffset(0, 1, 10, 20)).toBe(0)
  })
})

describe('panel layout', () => {
  test('wraps text to the width and cuts a longer word', () => {
    expect(wrapText('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd'])
    expect(wrapText('x'.repeat(20), 8)).toEqual(['xxxxxxxx', 'xxxxxxxx', 'xxxx'])
  })
  test('the scrollbar thumb follows the window, and is blank when all fits', () => {
    expect(scrollbar(5, 5, 0)).toEqual([' ', ' ', ' ', ' ', ' '])
    const top = scrollbar(20, 5, 0)
    expect(top[0]).toBe('\u2503')
    expect(top[4]).toBe('\u2502')
    const end = scrollbar(20, 5, 15)
    expect(end[4]).toBe('\u2503')
    expect(end[0]).toBe('\u2502')
  })
  test('three equal thirds, or sessions one third and the log two thirds', () => {
    expect(sectionBoxes(36, false).map(b => [b.id, b.top, b.height])).toEqual([['sessions', 0, 12], ['queue', 12, 12], ['points', 24, 12]])
    expect(sectionBoxes(36, true).map(b => [b.id, b.top, b.height])).toEqual([['sessions', 0, 12], ['log', 12, 24]])
    // A small pane still gives every box three content rows.
    expect(sectionBoxes(12, false).map(b => b.height)).toEqual([7, 6, 6])
    expect(sectionBoxes(12, true).map(b => b.height)).toEqual([7, 8])
    expect(boxAt(sectionBoxes(36, false), 13)?.id).toBe('queue')
    expect(clampOffset(99, 20, 5)).toBe(15)
  })
  test('an expanded section takes the body less one row per other section, kept in order as one-line headers; an open log wins over it', () => {
    const shape = (expanded: 'sessions' | 'queue' | 'points') => sectionBoxes(36, false, expanded).map(b => [b.id, b.top, b.height, b.isHeader === true])
    expect(shape('sessions')).toEqual([['sessions', 0, 34, false], ['queue', 34, 1, true], ['points', 35, 1, true]])
    expect(shape('queue')).toEqual([['sessions', 0, 1, true], ['queue', 1, 34, false], ['points', 35, 1, true]])
    expect(shape('points')).toEqual([['sessions', 0, 1, true], ['queue', 1, 1, true], ['points', 2, 34, false]])
    expect(sectionBoxes(36, false, null)).toEqual(sectionBoxes(36, false))
    expect(sectionBoxes(36, true, 'sessions')).toEqual(sectionBoxes(36, true))
    expect(boxAt(sectionBoxes(36, false, 'points'), 30)?.id).toBe('points')
    expect(boxAt(sectionBoxes(36, false, 'points'), 1)).toEqual({ id: 'queue', top: 1, height: 1, isHeader: true })
    // A tiny body still gives the expanded section its minimum.
    expect(sectionBoxes(4, false, 'sessions').map(b => b.height)).toEqual([7, 1, 1])
  })
})

describe('retiring finished workers', () => {
  const none = parseProcFacts('')
  const clean = { kind: 'clean', summary: 'clean: done' }
  const entry = (sid: string, extra: object = {}) => ({ title: sid, session_id: sid, reported: false, outcome: clean, ...extra })
  test('a clean finished session may go', () => {
    expect(retireVerdict([entry('aaaaaaaa-1')], none, '', ['aaaaaaaa-1'])).toEqual({ removable: ['aaaaaaaa-1'], refused: [] })
  })
  test('a kept session is refused, a live one too', () => {
    const kept = entry('kept-0001', { keep: true })
    expect(retireVerdict([kept], none, '', ['kept-0001']).refused.map(r => r.reason)).toEqual(['marked keep: a resume or follow-up is expected'])
    const live = entry(SID_ALIVE, { pid: 4101, config_dir: '/fixture/lic/a', keep: true })
    expect(retireVerdict([live], parseProcFacts(PROBE_STDOUT), '', [SID_ALIVE]).refused.map(r => r.reason)).toEqual(['its process is alive'])
  })
  test('only queued or running tasks of the queue file hold a session back', () => {
    const queue = JSON.stringify({ tasks: [{ id: 'a', status: 'done', note: 'resume worker aaaaaaaa' }, { id: 'b', status: 'running', note: 'worker bbbbbbbb' }] })
    const list = [entry('aaaaaaaa-1'), entry('bbbbbbbb-1')]
    const v = retireVerdict(list, none, queue, ['aaaaaaaa-1', 'bbbbbbbb-1'])
    expect(v.removable).toEqual(['aaaaaaaa-1'])
    expect(v.refused.map(r => r.reason)).toEqual(['a queued or running task names it'])
  })
  test('the first eight characters name a session too', () => {
    expect(retireVerdict([entry('aaaaaaaa-1')], none, '', ['aaaaaaaa']).removable).toEqual(['aaaaaaaa-1'])
  })
  test('refuses a session that could still be resumed or is still needed, with the reason', () => {
    const list = [
      entry('limit-001', { outcome: { kind: 'limit', summary: 'limit' } }),
      entry('keep-0001', { keep: true }),
      entry('queued-01'),
      entry(SID_ALIVE, { pid: 4101, config_dir: '/fixture/lic/a' }),
    ]
    const v = retireVerdict(list, parseProcFacts(PROBE_STDOUT), 'task waits on queued-01', ['limit-001', 'keep-0001', 'queued-01', SID_ALIVE, 'unknown-1'])
    expect(v.removable).toEqual([])
    expect(v.refused.map(r => r.reason)).toEqual([
      'outcome limit needs a resume',
      'marked keep: a resume or follow-up is expected',
      'a queued or running task names it',
      'its process is alive',
      'no registry entry',
    ])
  })
})

describe('retiring with a review', () => {
  const none = parseProcFacts('')
  const entry = (sid: string, kind: string, extra: object = {}) => ({ title: sid, session_id: sid, reported: true, outcome: { kind, summary: kind }, ...extra })
  test('an outcome login, limit or killed goes with a reason, and the original kind is kept', () => {
    for (const kind of ['login', 'limit', 'killed']) {
      const v = retireVerdict([entry('aaaaaaaa-1', kind)], none, '', ['aaaaaaaa'], { aaaaaaaa: ' the run succeeded ' })
      expect(v).toEqual({ removable: ['aaaaaaaa-1'], refused: [], reviewed: [{ session_id: 'aaaaaaaa-1', was: kind, reason: 'the run succeeded' }] })
    }
  })
  test('a reviewed key may be the full id, and a clean session needs no review record', () => {
    const v = retireVerdict([entry('aaaaaaaa-1', 'login'), entry('bbbbbbbb-1', 'clean')], none, '', ['aaaaaaaa', 'bbbbbbbb-1'], { 'aaaaaaaa-1': 'wrong label', bbbbbbbb: 'not needed' })
    expect(v.removable).toEqual(['aaaaaaaa-1', 'bbbbbbbb-1'])
    expect(v.reviewed).toEqual([{ session_id: 'aaaaaaaa-1', was: 'login', reason: 'wrong label' }])
  })
  test('a reviewed entry without a reason is refused, the session stays', () => {
    for (const reason of ['', '   ', 5, null]) {
      const v = retireVerdict([entry('aaaaaaaa-1', 'login')], none, '', ['aaaaaaaa'], { aaaaaaaa: reason })
      expect(v.removable).toEqual([])
      expect(v.refused.map(r => r.reason)).toEqual(['reviewed needs a non-empty reason'])
    }
  })
  test('a reason does not lift the live, kept, queue-named, unclassified or unknown refusals', () => {
    const list = [
      entry('keep-0001', 'login', { keep: true }),
      entry('queued-01', 'limit'),
      entry(SID_ALIVE, 'killed', { pid: 4101, config_dir: '/fixture/lic/a' }),
      { title: 'dead', session_id: 'dead-0001', config_dir: '/fixture/lic/a', pid: 999999 },
    ]
    const ids = ['keep-0001', 'queued-01', SID_ALIVE, 'unknown-1']
    const reviewed = Object.fromEntries([...ids, 'dead-0001'].map(id => [id, 'read the transcript']))
    const v = retireVerdict(list, parseProcFacts(PROBE_STDOUT), 'task waits on queued-01', [...ids, 'dead-0001'], reviewed)
    expect(v.removable).toEqual([])
    expect(v.reviewed).toBeUndefined()
    expect(v.refused.map(r => r.reason)).toEqual([
      'reviewed names no session of session_ids',
      'marked keep: a resume or follow-up is expected',
      'a queued or running task names it',
      'its process is alive',
      'no registry entry',
      'its exit was not classified yet',
    ])
  })
  test('a partial batch: the reviewed one goes, the unreviewed one with a wrong label stays', () => {
    const v = retireVerdict([entry('aaaaaaaa-1', 'login'), entry('bbbbbbbb-1', 'limit')], none, '', ['aaaaaaaa', 'bbbbbbbb'], { aaaaaaaa: 'ok' })
    expect(v.removable).toEqual(['aaaaaaaa-1'])
    expect(v.refused).toEqual([{ id: 'bbbbbbbb', reason: 'outcome limit needs a resume' }])
  })
  test('a reviewed key that names no listed session, or is too short, is refused', () => {
    const v = retireVerdict([entry('aaaaaaaa-1', 'login'), entry('bbbbbbbb-1', 'login')], none, '', ['aaaaaaaa'], { bbbbbbbb: 'x', aaaa: 'y' })
    expect(v.refused.map(r => `${r.id}: ${r.reason}`)).toEqual(['bbbbbbbb: reviewed names no session of session_ids', 'aaaa: reviewed names no session of session_ids', 'aaaaaaaa: outcome login needs a resume'])
    expect(v.removable).toEqual([])
  })
  test('the cleared-log lines get the two fields at the end, other lines stay as they are', () => {
    const lines = '{"session_id":"a-1","outcome":{"kind":"login"}}\n{"session_id":"b-1"}\n'
    expect(annotateCleared(lines, [{ session_id: 'a-1', was: 'login', reason: 'ok \u00e9' }])).toBe(
      '{"session_id":"a-1","outcome":{"kind":"login"},"reviewed_outcome":"login","reviewed_reason":"ok \u00e9"}\n{"session_id":"b-1"}\n',
    )
    expect(annotateCleared(lines, [])).toBe(lines)
  })
})

describe('launch dir', () => {
  test('refuses a directory that does not exist', () => {
    const verdict = checkLaunch(
      { dir: '/work/missing', prompt_file: '/p.txt', model: 'opus', effort: 'high', title: 't' } as LaunchArgs,
      { home: HOME, orchestratorDir: ORCH_DIR, entries: [], facts, dirOk: false, promptFileOk: true } as LaunchFacts,
    )
    expect(verdict.ok).toBe(false)
    expect(!verdict.ok && verdict.reason).toContain('does not exist')
  })
})

describe('decision presenter', () => {
  const doc = JSON.stringify({
    points: [
      { id: 'a', status: 'open', title: 'A', detail: 'd', recommendation: 'r' },
      { id: 'b', status: 'answered', title: 'B' },
      { id: 'c', status: 'open', hold: true, title: 'C' },
      { id: 'd', status: 'open', title: 'D' },
    ],
  })

  test('keeps open, not held points in file order', () => {
    const parsed = parseOpenPoints(doc)
    expect(parsed.ok && parsed.points.map(p => p.id)).toEqual(['a', 'd'])
  })

  test('reports an unreadable file instead of showing nothing', () => {
    expect(parseOpenPoints('{').ok).toBe(false)
    expect(parseOpenPoints('{"points":1}').ok).toBe(false)
  })
})

describe('report linter', () => {
  const ctx = {}

  test('a clean answer has no findings', () => {
    expect(lintReport('The worker finished: 3 files changed, tests green.', ctx)).toEqual([])
  })

  test('flags decision numbers; helper-file names and any language pass', () => {
    expect(lintReport('Settled by decisions 12 and 13.', ctx)).toContain('decision numbers are shown to the user')
    expect(lintReport('See task-queue.json.', ctx)).toEqual([])
    expect(lintReport('Il lavoro non è stato fatto perché la sessione ha avuto un errore e abbiamo dovuto ripetere la prova con una nuova licenza.', ctx)).toEqual([])
  })

  test('flags contrastive phrasing', () => {
    expect(lintReport('It is not a bug, but a feature.', ctx).join()).toContain('contrastive')
    expect(lintReport('We chose A, rather than B.', ctx).join()).toContain('contrastive')
  })

  test('flags "done" for an unacknowledged peer', () => {
    const peers = { unackedPeers: ['obsidian-manager'] }
    expect(lintReport('The obsidian-manager updated the note.', peers).join()).toContain('has not acknowledged')
    expect(lintReport('The obsidian-manager update is unacknowledged.', peers)).toEqual([])
    const withFooter = { openPoints: 0, alive: 0, unackedPeers: ['obsidian-manager'] }
    const footer = '\n\nSessions\nnone'
    expect(lintReport('The obsidian-manager updated the note.' + footer, withFooter).join()).toContain('has not acknowledged')
    expect(lintReport('The obsidian-manager update is unacknowledged.' + footer, withFooter)).toEqual([])
  })
})

describe('registry edits: the differential cases the jq scripts are checked against', () => {
  for (const one of REGISTRY_GOLDEN) {
    test(one.name, () => {
      if (one.registry === null && one.op !== 'register') {
        // A missing file: the scripts exit without writing, and the caller reads nothing to edit.
        expect(one.expect).toEqual({ unchanged: true })
        return
      }
      // A missing file is registered into as the scripts do: it starts as an empty array.
      const text = one.registry ?? freshText('headless-sessions.json') ?? ''
      const ids = one.ids ?? []
      const edited =
        one.op === 'register'
          ? registerEntry(text, (one.entry ?? {}) as SessionEntry, one.mode === 'resume' ? 'resume' : 'new')
          : one.op === 'clear'
            ? removeEntries(text, ids)
            : ackEntries(text, ids, one.keep === true)
      if (one.expect.refused === true) {
        expect(edited.ok).toBe(false)
        return
      }
      expect(edited).toEqual(one.op === 'clear' ? { ok: true, text: one.expect.text, removed: one.expect.log } : { ok: true, text: one.expect.text })
    })
  }

  test('every kind of case is there', () => {
    const names = REGISTRY_GOLDEN.map(one => one.name).join('\n')
    for (const word of ['register new', 'register resume', 'clear', 'ack keep', 'ack plain', 'missing', 'empty', 'surrogate', 'DEL', 'key order', 'not JSON', 'inbox fields', 'socket_path null', 'started_at', 'ended_at']) {
      expect(names).toContain(word)
    }
  })

  test('the refusal of a registry that does not parse is parseRegistry\'s', () => {
    const bad = registerEntry('not json', {}, 'new')
    expect(bad.ok === false && bad.error.startsWith('registry is not JSON')).toBe(true)
    expect(ackEntries('{"a":1}', ['x'], false)).toEqual({ ok: false, error: 'registry is not a JSON array' })
  })
})

describe('Windows paths', () => {
  test('one native form from every spelling', () => {
    const table: [string, string][] = [
      ['C:\\Users\\u', 'C:/Users/u'],
      ['C:/Users/u', 'C:/Users/u'],
      ['/c/Users/u', 'C:/Users/u'],
      ['c:\\users\\u', 'C:/users/u'],
      ['/d/work', 'D:/work'],
      ['C:\\Users\\u\\', 'C:/Users/u'],
      ['C:/Users/u///', 'C:/Users/u'],
      ['/c/Users/u/', 'C:/Users/u'],
      ['C:\\', 'C:/'],
      ['C:', 'C:/'],
      ['/c', 'C:/'],
      ['/c/', 'C:/'],
      ['C:\\Users\\John Smith\\My Project', 'C:/Users/John Smith/My Project'],
      ['/c/Users/John Smith/', 'C:/Users/John Smith'],
      ['C:\\Users\\\\u\\/x', 'C:/Users/u/x'],
      ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\u', '//wsl.localhost/Ubuntu-24.04/home/u'],
      ['\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\', '//wsl.localhost/Ubuntu-24.04/home/u'],
      ['//server/share/dir', '//server/share/dir'],
      ['/mnt/c/Users/u', '/mnt/c/Users/u'],
      ['/tmp/x', '/tmp/x'],
      ['relative\\dir', 'relative/dir'],
    ]
    for (const [given, want] of table) expect([given, winPath(given)]).toEqual([given, want])
  })

  test('absolute is a drive or a share; comparisons ignore case and the spelling', () => {
    for (const path of ['C:\\x', 'C:/x', '/c/x', 'd:/', '\\\\wsl.localhost\\Ubuntu\\home', '//server/share']) expect([path, isWinAbsolute(path)]).toEqual([path, true])
    for (const path of ['/tmp/x', '/mnt/c/x', 'C:x', 'x\\y', '//server', '']) expect([path, isWinAbsolute(path)]).toEqual([path, false])
    expect(isSameWinPath('/c/Users/U/proj/', 'C:\\users\\u\\Proj')).toBe(true)
    expect(isSameWinPath('C:/Users/u/a', 'C:/Users/u/b')).toBe(false)
    expect(isSameWinPath('D:/x', 'C:/x')).toBe(false)
  })
})

describe('Windows file script', () => {
  test('tailLines is tail -n with cut -c: the last lines, each cut', () => {
    expect(tailLines('a\nb\nc\n', 2, 10)).toBe('b\nc\n')
    expect(tailLines('a\nb\nc', 5, 10)).toBe('a\nb\nc\n')
    expect(tailLines('abcdef\n', 1, 3)).toBe('abc\n')
    expect(tailLines('', 600, 20000)).toBe('')
  })

  test('the script takes its own modules, replaces in one step and is run as a file', () => {
    expect(FILES_PS1).toContain('$env:PSModulePath = "$PSHOME\\Modules"')
    expect(FILES_PS1).toContain('[System.IO.File]::Replace($A, $B, [NullString]::Value)')
    expect(FILES_PS1).toContain("Get-Content -LiteralPath $A -Tail ([int]$B) -Encoding UTF8")
    expect(FILES_PS1).toContain('exit 1')
    // Windows line ends throughout.
    expect(FILES_PS1.replace(/\r\n/g, '').includes('\n')).toBe(false)
  })
})

/** The tool fingerprint's checksum, over any text. */
function fingerprint(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0
  return `${text.length}:${hash.toString(16)}`
}

describe('Windows probe', () => {
  const win = parseProcFacts(WIN_PROBE_STDOUT)
  const byPid = (pid: number) => REGISTRY.find(e => e.pid === pid)!

  test('the Linux probe text is the one it always was', () => {
    expect(fingerprint(PROBE_SCRIPT)).toBe('1260:2204f4bb')
  })

  test('the Windows probe text is pinned: a change to it is a change of this test too', () => {
    expect(fingerprint(PROBE_PS1)).toBe('4738:13e4e8cf')
  })

  test('its lines read as the Linux ones: alive, a reused pid, no sessions file', () => {
    expect(isPidAlive(byPid(4101), win)).toBe(true)
    expect(isPidAlive(byPid(4106), win)).toBe(false)
    expect(isPidAlive(byPid(4102), win)).toBe(false)
    expect(REGISTRY.map(e => rowStatus(e, win))).toEqual(REGISTRY.map(e => rowStatus(e, facts)))
    expect(win.transcriptMtime.get(SID_ALIVE)).toBe(NOW_SEC - 30)
    expect(win.pidComm.get(4101)).toBe('claude')
  })

  test('a claude.exe no sessions file names is an orphan with no config dir; the interactive one is not listed', () => {
    const rows = buildRows(REGISTRY, win, NOW_SEC)
    const orphans = rows.filter(row => row.status === 'orphan')
    expect(orphans.map(row => [row.pid, row.configDir, row.elapsedSec])).toEqual([[4999, '?', 2400]])
    expect(rows.find(row => row.pid === 4101)?.elapsedSec).toBe(125)
  })

  test('Windows line ends, stripped as the probe call strips them, read the same', () => {
    const crlf = WIN_PROBE_STDOUT.replace(/\n/g, '\r\n')
    expect(parseProcFacts(crlf.replace(/\r/g, ''))).toEqual(win)
  })

  test('the script matches by startedAt within START_MATCH_MS, takes its own modules and the same arguments', () => {
    expect(PROBE_PS1).toContain(`$before = ${START_MATCH_MS.before}`)
    expect(PROBE_PS1).toContain(`$after = ${START_MATCH_MS.after}`)
    expect(PROBE_PS1).toContain("$name = 'claude.exe'")
    expect(PROBE_PS1).toContain('$env:PSModulePath = "$PSHOME\\Modules"')
    expect(PROBE_PS1).toContain('Get-CimInstance -ClassName Win32_Process -Filter $filter')
    expect(PROBE_PS1).toContain('$gap = [long]$file.startedAt - $ms')
    for (const tag of ["'pid:'", "'t:'", "'c:'", '"P`t', '"A`t', '"T`t']) expect(PROBE_PS1).toContain(tag)
    expect(PROBE_PS1.replace(/\r\n/g, '').includes('\n')).toBe(false)
  })
})

describe('the new worker of a launch', () => {
  const want = { dir: '/work/new', configDir: '/fixture/lic/a', model: 'opus' }
  const line = (pid: number, cwd: string, cfg: string, cmd = 'claude -p --model opus --output-format json', elapsed = 3) =>
    ['P', pid, 'claude', elapsed, cwd, cfg, cmd].join('\t')
  test('Linux: a headless claude in the dir under the config dir with the model, not seen before; exact paths', () => {
    const facts = parseProcFacts([line(1, '/work/new/', '/fixture/lic/a'), line(2, '/work/new', '/fixture/lic/a')].join('\n'))
    expect(findNewWorker(facts, want, new Set())?.pid).toBe(1)
    expect(findNewWorker(facts, want, new Set([1]))?.pid).toBe(2)
    expect(findNewWorker(parseProcFacts(line(3, '/Work/New', '/fixture/lic/a')), want, new Set())).toBeUndefined()
    expect(findNewWorker(parseProcFacts(line(4, '/work/new', '/fixture/lic/a', 'claude --model opus')), want, new Set())).toBeUndefined()
    expect(findNewWorker(parseProcFacts(line(5, '/work/new', '', 'claude -p --model opus')), want, new Set())).toBeUndefined()
  })

  test('Windows: paths compared as Windows does; without a sessions file a fresh headless claude.exe with the model', () => {
    const winWant = { dir: 'C:/Work/New', configDir: 'C:/Users/u/.claude', model: 'opus' }
    const spelled = parseProcFacts(line(1, 'C:\\work\\new\\', 'C:\\Users\\u\\.claude'))
    expect(findNewWindowsWorker(spelled, winWant, new Set(), 10)?.pid).toBe(1)
    expect(findNewWindowsWorker(spelled, winWant, new Set([1]), 10)).toBeUndefined()
    expect(findNewWindowsWorker(parseProcFacts(line(2, 'C:\\other', 'C:\\Users\\u\\.claude')), winWant, new Set(), 10)).toBeUndefined()
    expect(findNewWindowsWorker(parseProcFacts(line(3, 'C:\\work\\new', 'C:\\Users\\v\\.claude')), winWant, new Set(), 10)).toBeUndefined()
    const bare = (elapsed: number, cmd?: string) => parseProcFacts(line(4, '', '', cmd, elapsed))
    expect(findNewWindowsWorker(bare(3), winWant, new Set(), 4)?.pid).toBe(4)
    expect(findNewWindowsWorker(bare(30), winWant, new Set(), 4)).toBeUndefined()
    expect(findNewWindowsWorker(bare(3, 'claude.exe --model opus'), winWant, new Set(), 4)).toBeUndefined()
    expect(findNewWindowsWorker(bare(3, 'claude.exe -p --model sonnet'), winWant, new Set(), 4)).toBeUndefined()
    // A worker the probe placed wins over one it could not.
    const both = parseProcFacts([line(5, '', ''), line(6, 'C:/work/new', 'C:/Users/u/.claude')].join('\n'))
    expect(findNewWindowsWorker(both, winWant, new Set(), 10)?.pid).toBe(6)
  })
})

describe('launch line', () => {
  // N is the session name a launch passes with -n (workerName of the title 'new' at 2026-10-10 12:00:00 UTC).
  const linux: LaunchArgs = { dir: '/work/new', prompt_file: '/tmp/scratch/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  test('Linux: the line it always was', () => {
    expect(buildLaunchArgv(linux, { name: N, configDir: '/home/u/.claude' }, '/home/u/.claude/session-control/runs/r.json', '/home/u/.claude/session-control/runs/r.err')).toEqual([
      'sh',
      '-c',
      "cd '/work/new' && CLAUDE_CONFIG_DIR='/home/u/.claude' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' -n 'w-new-261010120000' --settings '{\"crossSessionInbound\":\"accept\"}' --dangerously-skip-permissions --output-format json -- \"$(cat '/tmp/scratch/prompt.md')\" > '/home/u/.claude/session-control/runs/r.json' 2> '/home/u/.claude/session-control/runs/r.err'",
    ])
    expect(buildLaunchArgv({ ...linux, dir: '/c/foo' }, { name: N, configDir: '/c/cfg', resumeSid: 'aaaaaaaa-1111-4111-8111-111111111111' }, '/r.json')[2]).toBe(
      "cd '/c/foo' && CLAUDE_CONFIG_DIR='/c/cfg' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --resume 'aaaaaaaa-1111-4111-8111-111111111111' -n 'w-new-261010120000' --settings '{\"crossSessionInbound\":\"accept\"}' --dangerously-skip-permissions --output-format json -- \"$(cat '/tmp/scratch/prompt.md')\" > '/r.json'",
    )
  })

  test('an inherited configuration: no CLAUDE_CONFIG_DIR on the line, on Linux and on Windows; everything else as before', () => {
    expect(buildLaunchArgv(linux, { name: N, configDir: '/home/u/.claude', isConfigInherited: true }, '/home/u/.claude/session-control/runs/r.json', '/home/u/.claude/session-control/runs/r.err')[2]).toBe(
      "cd '/work/new' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' -n 'w-new-261010120000' --settings '{\"crossSessionInbound\":\"accept\"}' --dangerously-skip-permissions --output-format json -- \"$(cat '/tmp/scratch/prompt.md')\" > '/home/u/.claude/session-control/runs/r.json' 2> '/home/u/.claude/session-control/runs/r.err'",
    )
    expect(buildLaunchArgv(linux, { name: N, configDir: '/home/u/.claude', resumeSid: 'aaaaaaaa-1111-4111-8111-111111111111', isConfigInherited: true }, '/r.json')[2]).toBe(
      "cd '/work/new' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --resume 'aaaaaaaa-1111-4111-8111-111111111111' -n 'w-new-261010120000' --settings '{\"crossSessionInbound\":\"accept\"}' --dangerously-skip-permissions --output-format json -- \"$(cat '/tmp/scratch/prompt.md')\" > '/r.json'",
    )
    // isConfigInherited false is the line with the variable, as when the field is absent.
    expect(buildLaunchArgv(linux, { name: N, configDir: '/home/u/.claude', isConfigInherited: false }, '/r.json')).toEqual(buildLaunchArgv(linux, { name: N, configDir: '/home/u/.claude' }, '/r.json'))
    const win: LaunchArgs = { ...linux, dir: 'C:/Users/u/proj', prompt_file: 'C:/Users/u/AppData/Local/Temp/p.md' }
    expect(buildLaunchArgv(win, { name: N, configDir: 'C:/Users/u/.claude', isConfigInherited: true }, 'C:/Users/u/.claude/session-control/runs/r.json', 'C:/Users/u/.claude/session-control/runs/r.err')[2]).toBe(
      "cd 'C:/Users/u/proj' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' -n 'w-new-261010120000' --settings '{\"crossSessionInbound\":\"accept\"}' --dangerously-skip-permissions --output-format json -- \"$(cat 'C:/Users/u/AppData/Local/Temp/p.md')\" " +
        "> 'C:/Users/u/.claude/session-control/runs/r.json' 2> 'C:/Users/u/.claude/session-control/runs/r.err'",
    )
    expect(buildLaunchArgv(win, { name: N, configDir: 'C:/Users/u/.claude/lic/b' }, 'C:/r.json')[2]).toBe(
      "cd 'C:/Users/u/proj' && CLAUDE_CONFIG_DIR='C:/Users/u/.claude/lic/b' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' -n 'w-new-261010120000' --settings '{\"crossSessionInbound\":\"accept\"}' --dangerously-skip-permissions --output-format json -- \"$(cat 'C:/Users/u/AppData/Local/Temp/p.md')\" > 'C:/r.json'",
    )
  })

  test('the default config dir: the orchestrator\'s own CLAUDE_CONFIG_DIR, else <home>/.claude; compared as the platform does', () => {
    expect(defaultConfigDir('/home/u', undefined)).toBe('/home/u/.claude')
    expect(defaultConfigDir('/home/u', '')).toBe('/home/u/.claude')
    expect(defaultConfigDir('/home/u', '/home/u/.claude/lic/b')).toBe('/home/u/.claude/lic/b')
    expect(defaultConfigDir('C:/Users/u', undefined, true)).toBe('C:/Users/u/.claude')
    expect(defaultConfigDir('C:/Users/u', 'C:\\Users\\u\\.claude\\lic\\b\\', true)).toBe('C:/Users/u/.claude/lic/b')
    expect(isDefaultConfigDir('/home/u/.claude/', '/home/u/.claude')).toBe(true)
    expect(isDefaultConfigDir('/home/u/.claude/lic/b', '/home/u/.claude')).toBe(false)
    expect(isDefaultConfigDir('/Home/u/.claude', '/home/u/.claude')).toBe(false)
    expect(isDefaultConfigDir('c:\\users\\U\\.claude', 'C:/Users/u/.claude', true)).toBe(true)
    expect(isDefaultConfigDir('C:/Users/u/.claude/lic/b', 'C:/Users/u/.claude', true)).toBe(false)
  })

  test('Windows: the same line for Git Bash, every path native C:/... in single quotes', () => {
    const args: LaunchArgs = { ...linux, dir: winPath("/c/Users/John Smith/O'Brien proj/"), prompt_file: winPath('/c/Users/John Smith/AppData/Local/Temp/prompt.md') }
    const runs = 'C:/Users/John Smith/.claude/session-control/runs'
    expect(buildLaunchArgv(args, { name: N, configDir: winPath('C:\\Users\\John Smith\\.claude') }, `${runs}/r.json`, `${runs}/r.err`)[2]).toBe(
      "cd 'C:/Users/John Smith/O'\\''Brien proj' && CLAUDE_CONFIG_DIR='C:/Users/John Smith/.claude' CLAUDE_CODE_EFFORT_LEVEL='high' " +
        "claude -p --model 'opus' -n 'w-new-261010120000' --settings '{\"crossSessionInbound\":\"accept\"}' --dangerously-skip-permissions --output-format json -- \"$(cat 'C:/Users/John Smith/AppData/Local/Temp/prompt.md')\" " +
        "> 'C:/Users/John Smith/.claude/session-control/runs/r.json' 2> 'C:/Users/John Smith/.claude/session-control/runs/r.err'",
    )
  })
})

describe('session name and inbox of a launch', () => {
  const at = Date.UTC(2026, 9, 10, 12, 0, 0)
  const linux: LaunchArgs = { dir: '/work/new', prompt_file: '/tmp/scratch/prompt.md', model: 'opus', effort: 'high', title: 'new' }
  const flags = `-n 'w-new-261010120000' --settings '{"crossSessionInbound":"accept"}'`
  test('the name: w-, the title slug up to 24, the UTC launch time; letters, digits and dashes, at most 39 characters', () => {
    expect(workerName('new', at)).toBe(N)
    expect(workerName("Design: launch_worker with an inbox (claude -p) - it's long", at)).toBe('w-design-launch-worker-wit-261010120000')
    expect(workerName('Ünïcode \u2615 — only', at)).toBe('w-n-code-only-261010120000')
    expect(workerName('\u2615\u2615', at)).toBe('w-worker-261010120000')
    // A slug cut at 24 that ends on a dash loses the dash.
    expect(workerName('abcdefghijklmnopqrstuvw-xyz', at)).toBe('w-abcdefghijklmnopqrstuvw-261010120000')
    for (const title of ['x', 'a'.repeat(120), '--- ---', 'A B/C\\D"E\'F$G`H', 'tab\there\nnewline']) {
      const name = workerName(title, at)
      expect(name).toMatch(WORKER_NAME)
      expect(name.length).toBeLessThanOrEqual(39)
    }
  })
  test('unique: a name already taken gets -2, -3 ...', () => {
    expect(workerName('new', at, new Set([N]))).toBe(`${N}-2`)
    expect(workerName('new', at, new Set([N, `${N}-2`]))).toBe(`${N}-3`)
    expect(`${N}-2`).toMatch(WORKER_NAME)
  })
  test('a fresh launch takes a fresh name, unique against the registry and the names this session gave out', () => {
    const entries = [{ session_id: SID_DEAD, name: N }, { session_id: SID_DONE, name: `${N}-2` }]
    expect(launchName('new', at, [], undefined)).toBe(N)
    expect(launchName('new', at, entries, undefined)).toBe(`${N}-3`)
    expect(launchName('new', at, [], undefined, new Set([N]))).toBe(`${N}-2`)
  })
  test('a resume keeps the entry name; an entry with no name or a name that is not one of ours gets a fresh one', () => {
    const named = [{ session_id: SID_DEAD, name: 'w-old-title-261001080000' }]
    expect(launchName('new', at, named, SID_DEAD)).toBe('w-old-title-261001080000')
    expect(launchName('new', at, [{ session_id: SID_DEAD }], SID_DEAD)).toBe(N)
    expect(launchName('new', at, [{ session_id: SID_DEAD, name: "x'; rm -rf /" }], SID_DEAD)).toBe(N)
    expect(launchName('new', at, [{ session_id: SID_DEAD, name: 7 }], SID_DEAD)).toBe(N)
  })
  test('golden: Linux with a picker, without one, and a resume keeping its name', () => {
    expect(buildLaunchArgv(linux, { configDir: '/home/u/.claude/lic/b', name: N }, '/runs/r.json', '/runs/r.err')[2]).toBe(
      `cd '/work/new' && CLAUDE_CONFIG_DIR='/home/u/.claude/lic/b' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' ${flags} ` +
        `--dangerously-skip-permissions --output-format json -- "$(cat '/tmp/scratch/prompt.md')" > '/runs/r.json' 2> '/runs/r.err'`,
    )
    expect(buildLaunchArgv(linux, { configDir: '/home/u/.claude', isConfigInherited: true, name: N }, '/runs/r.json', '/runs/r.err')[2]).toBe(
      `cd '/work/new' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' ${flags} ` +
        `--dangerously-skip-permissions --output-format json -- "$(cat '/tmp/scratch/prompt.md')" > '/runs/r.json' 2> '/runs/r.err'`,
    )
    expect(buildLaunchArgv(linux, { configDir: '/home/u/.claude/lic/b', resumeSid: SID_DEAD, name: 'w-old-title-261001080000' }, '/runs/r.json', '/runs/r.err')[2]).toBe(
      `cd '/work/new' && CLAUDE_CONFIG_DIR='/home/u/.claude/lic/b' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --resume '${SID_DEAD}' ` +
        `-n 'w-old-title-261001080000' --settings '{"crossSessionInbound":"accept"}' ` +
        `--dangerously-skip-permissions --output-format json -- "$(cat '/tmp/scratch/prompt.md')" > '/runs/r.json' 2> '/runs/r.err'`,
    )
  })
  test('golden: Windows (Git Bash) with a picker, without one, and a resume', () => {
    const win: LaunchArgs = { ...linux, dir: 'C:/Users/u/proj', prompt_file: 'C:/Users/u/AppData/Local/Temp/p.md' }
    const tail = `--dangerously-skip-permissions --output-format json -- "$(cat 'C:/Users/u/AppData/Local/Temp/p.md')" > 'C:/runs/r.json' 2> 'C:/runs/r.err'`
    expect(buildLaunchArgv(win, { configDir: 'C:/Users/u/.claude/lic/b', name: N }, 'C:/runs/r.json', 'C:/runs/r.err')[2]).toBe(
      `cd 'C:/Users/u/proj' && CLAUDE_CONFIG_DIR='C:/Users/u/.claude/lic/b' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' ${flags} ${tail}`,
    )
    expect(buildLaunchArgv(win, { configDir: 'C:/Users/u/.claude', isConfigInherited: true, name: N }, 'C:/runs/r.json', 'C:/runs/r.err')[2]).toBe(
      `cd 'C:/Users/u/proj' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' ${flags} ${tail}`,
    )
    expect(buildLaunchArgv(win, { configDir: 'C:/Users/u/.claude', resumeSid: SID_DEAD, isConfigInherited: true, name: N }, 'C:/runs/r.json', 'C:/runs/r.err')[2]).toBe(
      `cd 'C:/Users/u/proj' && CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --resume '${SID_DEAD}' ${flags} ${tail}`,
    )
  })
  test('the settings are one shell word with no blank and no quote shq would have to escape', () => {
    expect(JSON.parse(WORKER_SETTINGS)).toEqual({ crossSessionInbound: 'accept' })
    expect(WORKER_SETTINGS).not.toMatch(/[\s']/)
  })
  test('the worker matcher still finds the launched worker with the extra flags, on Linux and on Windows', () => {
    const want = { dir: '/work/new', configDir: '/fixture/lic/a', model: 'opus' }
    // /proc/<pid>/cmdline with its NULs turned to blanks, as PROBE_SCRIPT prints it.
    const linuxCmd = `claude -p --model opus -n ${N} --settings {"crossSessionInbound":"accept"} --dangerously-skip-permissions --output-format json -- Goal: x`
    const linuxResume = `claude -p --model opus --resume ${SID_DEAD} -n ${N} --settings {"crossSessionInbound":"accept"} --dangerously-skip-permissions --output-format json -- Goal: x`
    for (const cmd of [linuxCmd, linuxResume]) {
      expect(findNewWorker(parseProcFacts(['P', 7, 'claude', 2, '/work/new', '/fixture/lic/a', cmd].join('\t')), want, new Set())?.pid).toBe(7)
    }
    expect(findNewWorker(parseProcFacts(['P', 7, 'claude', 2, '/work/new', '/fixture/lic/a', linuxCmd].join('\t')), { ...want, model: 'sonnet' }, new Set())).toBeUndefined()
    // Win32_Process.CommandLine as Git Bash builds it for claude.exe.
    const winCmd = `"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus -n ${N} --settings "{\\"crossSessionInbound\\":\\"accept\\"}" --dangerously-skip-permissions --output-format json -- "Goal: x"`
    const winWant = { dir: 'C:/work/new', configDir: 'C:/Users/u/.claude', model: 'opus' }
    expect(findNewWindowsWorker(parseProcFacts(['P', 8, 'claude', 2, 'C:\\work\\new', 'C:\\Users\\u\\.claude', winCmd].join('\t')), winWant, new Set(), 5)?.pid).toBe(8)
    expect(findNewWindowsWorker(parseProcFacts(['P', 8, 'claude', 2, '', '', winCmd].join('\t')), winWant, new Set(), 5)?.pid).toBe(8)
  })
})

describe('worker-report check', () => {
  test('the two real reports carry both reads with exit codes and nothing unpushed: no note', () => {
    expect(reportCheck(REPORT_TEXTS.design)).toBeUndefined()
    expect(reportCheck(REPORT_TEXTS.probe)).toBeUndefined()
    expect(reportCheck(resultReport(REAL_RESULTS.designReport))).toBeUndefined()
  })
  test('a report without the reads: one short line naming what is missing', () => {
    expect(reportCheck('Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.')).toBe(
      'report lacks git status -sb and git log --oneline @{u}..HEAD with their exit codes',
    )
    const statusOnly = REPORT_TEXTS.design.split('`git log')[0] ?? ''
    expect(reportCheck(statusOnly)).toBe('report lacks git log --oneline @{u}..HEAD with its exit code')
    // The commands named without their output or exit code do not count.
    expect(reportCheck('I ran git status -sb and git log --oneline @{u}..HEAD; all clean.')).toBe(
      'report lacks git status -sb and git log --oneline @{u}..HEAD with their exit codes',
    )
    const noBranchLine = REPORT_TEXTS.probe.replace('## feature/panel-expand-sections...origin/feature/panel-expand-sections\n', '')
    expect(reportCheck(noBranchLine)).toBe('report lacks git status -sb with its exit code')
  })
  test('unpushed commits listed by the log are noted, in a fence or in a list', () => {
    const ahead = REPORT_TEXTS.probe
      .replace('...origin/feature/panel-expand-sections', '...origin/feature/panel-expand-sections [ahead 2]')
      .replace('$ git log --oneline @{u}..HEAD   → exit 0 (no output)', '$ git log --oneline @{u}..HEAD   → exit 0\nc1ff342 fix(completion): label limit and login only from reliable signals\n49467fc feat(registry): record the name')
    expect(reportCheck(ahead)).toBe('git log @{u}..HEAD lists 2 unpushed commits')
    const listed = '`git status -sb` (exit 0):\n```\n## main...origin/main [ahead 1]\n```\n`git log --oneline @{u}..HEAD` (exit 0):\n- `9b6e367` fix(toast): drop the plugin name\n\n## Files\n- none'
    expect(reportCheck(listed)).toBe('git log @{u}..HEAD lists 1 unpushed commit')
  })
  test('tolerant: case, exit=0, exit code: 0, rc=0, @{upstream}, quoted lines', () => {
    const variants = [
      'GIT STATUS -SB (EXIT=0)\n## main...origin/main\nGit Log --Oneline @{U}..HEAD (Exit Code: 0): empty',
      '```sh\n$ git status -sb; echo rc=0\n## feature/x...origin/feature/x\n$ git log --oneline @{upstream}..HEAD; echo rc=0\n```',
      '> git status -sb → exit 0\n> ## main...origin/main\n> git log --oneline @{u}..HEAD → exit 0, no output',
    ]
    for (const one of variants) expect(reportCheck(one)).toBeUndefined()
  })
  test('a log that failed (no upstream) is noted with its exit code', () => {
    const noUpstream = '`git status -sb` (exit 0):\n```\n## feature/new\n```\n`git log --oneline @{u}..HEAD` (exit 128): fatal: no upstream configured for branch \'feature/new\''
    expect(reportCheck(noUpstream)).toBe('git log @{u}..HEAD exited 128')
  })
  test('words of the report around the reads are not commits', () => {
    const words = '`git log --oneline @{u}..HEAD` (exit 0): no output.\n`git status -sb` (exit 0):\n```\n## main...origin/main\n```\ndefaced accepted 2026-10-10 deadbeef is not a commit line'
    expect(reportCheck(words)).toBeUndefined()
  })
  test('commits are counted only in the log\'s own output block', () => {
    const stray = '9b6e367 fix(toast): drop the plugin name'
    // After a blank line, after a heading, after a fence end, after an exit marker, after the next command.
    expect(reportCheck(`${REPORT_TEXTS.design}\n\nPushed earlier:\n${stray}`)).toBeUndefined()
    expect(reportCheck(REPORT_TEXTS.probe.replace('(no output)\n```', `(no output)\n\`\`\`\n${stray}`))).toBeUndefined()
    expect(reportCheck(REPORT_TEXTS.probe.replace('→ exit 0 (no output)', `→ exit 0\n## Pushed\n${stray}`))).toBeUndefined()
    expect(reportCheck(REPORT_TEXTS.probe.replace('→ exit 0 (no output)', `exit 0\nexit 0\n${stray}`))).toBeUndefined()
    expect(reportCheck(REPORT_TEXTS.probe.replace('→ exit 0 (no output)', `→ exit 0\n$ git show --oneline ${stray}`))).toBeUndefined()
    // Inside the block they still count, up to the stop.
    const two = REPORT_TEXTS.probe.replace('→ exit 0 (no output)', `→ exit 0\n${stray}\nc1ff342 fix(completion): label limit and login only from reliable signals\n\n${stray}`)
    expect(reportCheck(two)).toBe('git log @{u}..HEAD lists 2 unpushed commits')
  })
  test('exit spellings: exit status 0, → 0, (exit 0), exited 0', () => {
    const status = '`git status -sb` (exit 0):\n```\n## main...origin/main\n```\n'
    for (const spelling of ['exit status 0', '→ 0', '(exit 0)', 'exited 0', 'exit code 0']) {
      expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD ${spelling}`)).toBeUndefined()
      expect(reportCheck(`$ git status -sb ${spelling}\n## main...origin/main\n$ git log --oneline @{u}..HEAD ${spelling}`)).toBeUndefined()
    }
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD → 128`)).toBe('git log @{u}..HEAD exited 128')
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD exited 1`)).toBe('git log @{u}..HEAD exited 1')
  })
  test('the ASCII arrow -> 0 is an exit spelling in the same places as the Unicode arrow', () => {
    const status = '`git status -sb` (exit 0):\n```\n## main...origin/main\n```\n'
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD   -> 0`)).toBeUndefined()
    expect(reportCheck(`$ git status -sb -> 0\n## main...origin/main\n$ git log --oneline @{u}..HEAD ->0`)).toBeUndefined()
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD -> 128`)).toBe('git log @{u}..HEAD exited 128')
    // On the exit marker line after the output, and on the line after the fence that ends the block.
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD\n9b6e367 fix(toast): drop the plugin name\n-> 0`)).toBe('git log @{u}..HEAD lists 1 unpushed commit')
    expect(reportCheck(`${status}\`\`\`\n$ git log --oneline @{u}..HEAD\n\`\`\`\n-> 0`)).toBeUndefined()
    // A marker line stops the block: a commit-like line below it is not counted.
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD\n-> 0\n9b6e367 fix(toast): drop the plugin name`)).toBeUndefined()
    // Without a number after the arrow there is no exit code.
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD -> none`)).toBe('report lacks git log --oneline @{u}..HEAD with its exit code')
  })
  test('the log\'s exit code sits in or right after its block, not later in the report', () => {
    const status = '`git status -sb` (exit 0):\n```\n## main...origin/main\n```\n'
    const lacking = 'report lacks git log --oneline @{u}..HEAD with its exit code'
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD\n\nThe build script ended with exit 0.`)).toBe(lacking)
    expect(reportCheck(`${status}\`git log --oneline @{u}..HEAD\`: no output.\n\nLater: tests ran (exit 0).`)).toBe(lacking)
    // After the output, on an exit marker line or the line after the fence that ends the block.
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD\n9b6e367 fix(toast): drop the plugin name\nexit 0`)).toBe('git log @{u}..HEAD lists 1 unpushed commit')
    expect(reportCheck(`${status}\`\`\`\n$ git log --oneline @{u}..HEAD\n\`\`\`\nexit 0`)).toBeUndefined()
    // A commit subject holding an exit-like word is not the log's exit code.
    expect(reportCheck(`${status}$ git log --oneline @{u}..HEAD\n9b6e367 fix: exit 0 on cancel`)).toBe(lacking)
  })
  test('resultReport: the result text of a result file, empty otherwise', () => {
    expect(resultReport(JSON.stringify({ result: 'x' }))).toBe('x')
    for (const text of ['', '{', 'null', '{"result":5}']) expect(resultReport(text)).toBe('')
  })
})

describe('the inbox fields of the registry entry', () => {
  const args: LaunchArgs = { dir: '/work/new/', prompt_file: '/tmp/p.md', model: 'haiku', effort: 'low', title: 'new' }
  const files = { result: '/r/new.json', err: '/r/new.err' }
  test('sessionFileFacts reads sessionId, name and messagingSocketPath; anything else is undefined', () => {
    expect(sessionFileFacts(JSON.stringify({ pid: 7, sessionId: SID_DEAD, name: N, messagingSocketPath: '/run/user/1000/cc-socks/7.sock', kind: 'interactive' }))).toEqual({
      sessionId: SID_DEAD,
      name: N,
      socketPath: '/run/user/1000/cc-socks/7.sock',
    })
    expect(sessionFileFacts(JSON.stringify({ sessionId: SID_DEAD, procStart: '1' }))).toEqual({ sessionId: SID_DEAD })
    expect(sessionFileFacts(JSON.stringify({ sessionId: SID_DEAD, name: '', messagingSocketPath: 5 }))).toEqual({ sessionId: SID_DEAD })
    for (const text of ['', '{', 'null', '[1]', '"x"']) expect(sessionFileFacts(text)).toEqual({})
  })
  test('a fresh entry: name after the session id, socket_path when known, none otherwise', () => {
    expect(Object.keys(newRegistryEntry(args, { configDir: '/c/a' }, 7, SID_DEAD, files, { name: N, socketPath: '/s.sock' }, NOW_SEC - 9))).toEqual([
      'title', 'pid', 'session_id', 'name', 'socket_path', 'config_dir', 'cwd', 'model', 'effort', 'result_file', 'err_file', 'started_at',
    ])
    expect(newRegistryEntry(args, { configDir: '/c/a' }, 7, SID_DEAD, files, { name: N }, NOW_SEC - 9)).toEqual({
      title: 'new', pid: 7, session_id: SID_DEAD, name: N, config_dir: '/c/a', cwd: '/work/new', model: 'haiku', effort: 'low', result_file: '/r/new.json', err_file: '/r/new.err', started_at: NOW_SEC - 9,
    })
  })
  test('a resume entry: socket_path null when the new sessions file has none, so the merge clears the dead socket', () => {
    expect(newRegistryEntry(args, { configDir: '/c/a', resumeSid: SID_DEAD }, 7, SID_DEAD, files, { name: N }, NOW_SEC - 9).socket_path).toBeNull()
    expect(newRegistryEntry(args, { configDir: '/c/a', resumeSid: SID_DEAD }, 7, SID_DEAD, files, { name: N, socketPath: '/s.sock' }, NOW_SEC - 9).socket_path).toBe('/s.sock')
    const before = JSON.stringify([{ session_id: SID_DEAD, name: N, socket_path: '/old.sock', reported: false }])
    const merged = registerEntry(before, newRegistryEntry(args, { configDir: '/c/a', resumeSid: SID_DEAD }, 7, SID_DEAD, files, { name: N }, NOW_SEC - 9), 'resume')
    expect(merged.ok && JSON.parse(merged.text)[0].socket_path).toBeNull()
  })
})

describe('launch guard on Windows', () => {
  const args: LaunchArgs = { dir: 'C:/work/new', prompt_file: 'C:/Users/u/AppData/Local/Temp/p.md', model: 'opus', effort: 'high', title: 'new' }
  const ctx: LaunchFacts = {
    home: 'C:/Users/u',
    orchestratorDir: 'C:/Users/u/workspaces/session_control',
    entries: [],
    facts: parseProcFacts(''),
    pick: { exitCode: 0, stdout: 'C:/Users/u/.claude' },
    isWindows: true,
  }
  test('native paths pass; a POSIX one is refused with the Windows spelling', () => {
    expect(checkLaunch(args, ctx)).toEqual({ ok: true, configDir: 'C:/Users/u/.claude' })
    expect(checkLaunch({ ...args, dir: '/tmp/x' }, ctx)).toEqual({ ok: false, reason: 'dir must be absolute (on Windows /c/... or C:/...)' })
    expect(checkLaunch({ ...args, prompt_file: '/tmp/p.md' }, ctx)).toEqual({ ok: false, reason: 'prompt_file must be absolute (on Windows /c/... or C:/...)' })
    // Without the Windows flag nothing changes: a C:/ path is not absolute, and the reason has no Windows hint.
    expect(checkLaunch(args, { ...ctx, isWindows: undefined })).toEqual({ ok: false, reason: 'dir must be absolute' })
  })

  test('the orchestrator dir and home are refused in any spelling and case', () => {
    expect(checkLaunch({ ...args, dir: 'c:/users/U/Workspaces/session_control' }, ctx)).toEqual({ ok: false, reason: 'refused: cwd is the orchestrator dir' })
    expect(checkLaunch({ ...args, dir: winPath('/c/Users/u/') }, ctx)).toEqual({ ok: false, reason: 'refused: cwd is $HOME' })
  })

  test('a picker answer in any Windows spelling is taken in native form; a POSIX one is refused', () => {
    expect(checkLaunch(args, { ...ctx, pick: { exitCode: 0, stdout: 'C:\\Users\\u\\.claude\\lic\\b\r\n' } })).toEqual({ ok: true, configDir: 'C:/Users/u/.claude/lic/b' })
    expect(checkLaunch(args, { ...ctx, pick: { exitCode: 0, stdout: '/home/u/.claude' } })).toEqual({ ok: false, reason: 'the licence picker answered an unexpected value: /home/u/.claude' })
  })

  test(`a prompt over ${WINDOWS_PROMPT_MAX_CHARS} characters is refused on Windows only`, () => {
    expect(checkLaunch(args, { ...ctx, promptChars: WINDOWS_PROMPT_MAX_CHARS }).ok).toBe(true)
    const refused = checkLaunch(args, { ...ctx, promptChars: WINDOWS_PROMPT_MAX_CHARS + 1 })
    expect(refused.ok === false && refused.reason.startsWith('refused: on Windows the prompt goes on a command line of at most 32767 characters; it has 30001')).toBe(true)
    expect(checkLaunch({ ...args, dir: '/work/new', prompt_file: '/p.md' }, { ...ctx, home: '/home/u', orchestratorDir: '/o', pick: { exitCode: 0, stdout: '/c' }, isWindows: undefined, promptChars: 100_000 }).ok).toBe(true)
  })

  test('a prompt Git Bash would rewrite is refused on Windows, any other passes', () => {
    for (const one of MSYS_PROMPTS) {
      const verdict = checkLaunch(args, { ...ctx, promptLead: one.text.slice(0, 200) })
      expect([one.text, verdict.ok]).toEqual([one.text, !one.rewritten])
      expect([one.text, MSYS_REWRITTEN.test(one.text)]).toEqual([one.text, one.rewritten])
    }
    const refused = checkLaunch(args, { ...ctx, promptLead: '/c/x' })
    expect(refused.ok === false && refused.reason.startsWith('refused: on Windows Git Bash rewrites an argument that starts like a POSIX path')).toBe(true)
    expect(checkLaunch({ ...args, dir: '/w', prompt_file: '/p' }, { ...ctx, home: '/h', orchestratorDir: '/o', pick: { exitCode: 0, stdout: '/c' }, isWindows: undefined, promptLead: '/c/x' }).ok).toBe(true)
  })

  test('the licence picker on Windows starts with an absolute executable', () => {
    expect(windowsPickerRefusal(['pick', '--need', '40'])).toBe('refused: on Windows the licence picker command must start with the absolute path of an executable (C:/.../picker.exe), not "pick"')
    expect(windowsPickerRefusal([])).toContain('not ""')
    expect(windowsPickerRefusal(['C:/tools/pick.exe', '--need', '40'])).toBeUndefined()
    expect(windowsPickerRefusal(['/c/tools/pick.exe'])).toBeUndefined()
    expect(windowsPickerRefusal(pickArgv('~/bin/pick.exe --need {need}', 40, 'C:/Users/u'))).toBeUndefined()
  })

  test('the transcript folder is named after the native cwd on Windows, the given one on Linux', () => {
    const entry = { config_dir: 'C:/Users/u/.claude', cwd: '/c/Users/u/proj', session_id: SID_ALIVE }
    expect(transcriptPath(entry, true)).toBe(`C:/Users/u/.claude/projects/C--Users-u-proj/${SID_ALIVE}.jsonl`)
    expect(transcriptPath({ ...entry, cwd: 'C:\\Users\\u\\proj\\' }, true)).toBe(`C:/Users/u/.claude/projects/C--Users-u-proj/${SID_ALIVE}.jsonl`)
    expect(transcriptPath(entry)).toBe(`C:/Users/u/.claude/projects/-c-Users-u-proj/${SID_ALIVE}.jsonl`)
  })
})
