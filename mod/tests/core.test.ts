import { describe, expect, test } from 'claude-code/testing'

import {
  buildLaunchArgv,
  ackPeerNote,
  addPeerNote,
  boxAt,
  clampOffset,
  scrollbar,
  sectionBoxes,
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
  isSameWinPath,
  isWinAbsolute,
  tailLines,
  winPath,
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
  SID_ALIVE,
  SID_DEAD,
  SID_REUSED,
  SID_UNREPORTED,
  TASK_NOTIFICATION_KILLED,
  REGISTRY_GOLDEN,
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
    const merged = mergeCompletion(REGISTRY_TEXT, SID_DEAD, classifyResult(RESULTS.limit))
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
    expect(after.length).toBe(REGISTRY.length)
    expect(after.filter((_, i) => i !== 1)).toEqual(REGISTRY.filter((_, i) => i !== 1))
  })

  test('refuses an entry already harvested or missing', () => {
    expect(mergeCompletion(REGISTRY_TEXT, SID_UNREPORTED, classifyResult(RESULTS.clean)).changed).toBe(false)
    expect(mergeCompletion(REGISTRY_TEXT, 'nope', classifyResult(RESULTS.clean)).changed).toBe(false)
    expect(mergeCompletion('{', SID_DEAD, classifyResult(RESULTS.clean)).changed).toBe(false)
  })
})

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
    const argv = buildLaunchArgv({ ...base, title: "it's" , dir: "/work/it's" }, { configDir: '/fixture/lic/a' }, '/work/r.json')
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
    for (const word of ['register new', 'register resume', 'clear', 'ack keep', 'ack plain', 'missing', 'empty', 'surrogate', 'DEL', 'key order', 'not JSON']) {
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
