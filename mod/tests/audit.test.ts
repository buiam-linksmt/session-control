// audit_state: the findings of hooks/audit.ts, one fixture per kind, their order and bound; then the tool through the
// plugin on the mock engine (the listings by $.fs.list, git as a process with read commands only, nothing written),
// with git there, missing, and the directory no repository.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MAX_FINDINGS, auditFindings, auditText, backupKind, decisionSections } from '../hooks/audit'
import type { AuditInput, Finding } from '../hooks/audit'
import { parseProcFacts } from '../hooks/core'
import { PROBE_SCRIPT } from '../hooks/host-posix'
import { NOW_MS } from './fixtures'

const SID_LIVE = 'a1a1a1a1-1111-4111-8111-111111111111'
const SID_DONE = 'd0d0d0d0-2222-4222-8222-222222222222'
const SID_UNREP = 'e0e0e0e0-3333-4333-8333-333333333333'
const SID_KEPT = 'f0f0f0f0-4444-4444-8444-444444444444'
const SID_DEAD = 'b0b0b0b0-5555-4555-8555-555555555555'
const SID_RETIRED = 'c0c0c0c0-6666-4666-8666-666666666666'
const DAY = 86_400_000

/** The audit's own clock (the points' dates are local dates of it), and in epoch seconds. */
const NOW = Date.UTC(2026, 0, 10, 12)
const NOWS = NOW / 1000

/** The probe: the live worker's proof only (the dead one's pid is gone). */
const FACTS = parseProcFacts([['A', 4101, 'claude', 5000, 5000, SID_LIVE].join('\t'), ['T', SID_KEPT, NOWS - 30 * 3600].join('\t')].join('\n'))

const ENTRIES = [
  { title: 'live worker', pid: 4101, session_id: SID_LIVE, name: 'w-live-1', config_dir: '/c', cwd: '/w/live' },
  { title: 'clean done', session_id: SID_DONE, config_dir: '/c', reported: true, result_file: '/r/20261010-done.json', err_file: '/r/20261010-done.err', outcome: { kind: 'clean', summary: 'clean: ok' }, ended_at: NOWS - 3600 },
  { title: 'unreported', session_id: SID_UNREP, config_dir: '/c', reported: false, outcome: { kind: 'chatter', summary: 'chatter: x' }, ended_at: NOWS - 600 },
  { title: 'kept long', session_id: SID_KEPT, config_dir: '/c', reported: true, keep: true, outcome: { kind: 'clean', summary: 'clean: ok' }, ended_at: NOWS - 7 * 3600 },
  { title: 'dead unharvested', pid: 4102, session_id: SID_DEAD, config_dir: '/c', result_file: '/r/20261010-dead.json' },
]

const QUEUE = {
  tasks: [
    { id: 'q-blocked', title: 'Blocked task', status: 'blocked' },
    { id: 'q-run-none', title: 'Running with no session', status: 'running' },
    { id: 'q-run-live', title: 'Running with the live one', status: 'running', note: `session ${SID_LIVE.slice(0, 8)}` },
    { id: 'q-wait-done', title: 'Waits on the clean one', status: 'queued', waits_for: `session ${SID_DONE.slice(0, 8)} to finish` },
    { id: 'q-wait-retired', title: 'Waits on a retired one', status: 'queued', waits_for: SID_RETIRED },
    { id: 'q-wait-text', title: 'Waits on a step', status: 'queued', waits_for: 'mod step 2' },
    { id: 'q-done', title: 'Finished task', status: 'done' },
  ],
}

const POINTS = {
  points: [
    { id: 'old', status: 'open', title: 'An old question', raised: '2026-01-01' },
    { id: 'fresh', status: 'open', title: 'A fresh question', raised: '2026-01-07' },
    { id: 'held', status: 'open', hold: true, title: 'A held question', raised: '2026-01-07' },
    { id: 'closed', status: 'closed', title: 'Settled long ago', raised: '2025-01-01' },
  ],
}

const DECISIONS = [
  '# Agreed decisions',
  '',
  '## T58 - requirement 946677 (HMI switch) - branch feature/req-946677',
  '1. a decision',
  '## Live work on the parser (user, 2026-01-05)',
  '1. a decision',
  '2. another',
  '## Windows support for the mod (user, 2026-01-02)',
  '1. done long ago',
  '## Standing',
  '1. never stale',
].join('\n')

const file = (name: string, ageMs: number, size = 10, kind: 'file' | 'dir' | 'other' = 'file') => ({ name, kind, size, mtimeMs: NOW - ageMs })

const BASE: AuditInput = {
  entries: ENTRIES,
  facts: FACTS,
  nowMs: NOW,
  queueText: JSON.stringify(QUEUE),
  pointsText: JSON.stringify(POINTS),
  decisionsText: DECISIONS,
  retired: new Set([SID_RETIRED]),
  backups: [
    file('task-queue-before-queue-task-2026-01-10.json', 0.5 * DAY),
    file('task-queue-before-queue-task-2026-01-07.json', 3 * DAY),
    file('task-queue-before-queue-task-2026-01-06.json', 4 * DAY),
    file('open-points-before-open-point-2026-01-01.json', 9 * DAY),
    file('dev-mod-before-sync-2026-01-09', 1.5 * DAY, 0, 'dir'),
  ],
  runs: [file('20261010-done.json', DAY), file('20261010-done.err', DAY), file('20261010-done.pid', DAY), file('20261010-dead.json', DAY), file('trace.log', 0), file('trace.log.1', DAY), file('cleared.jsonl', DAY), file('probe.ps1', DAY), file('20250101-old.json', 30 * DAY, 2048), file('20250101-old.err', 30 * DAY, 0)],
  reports: [file('unit-a.md', 5 * DAY), file('unit-b.md', DAY)],
  git: { branch: 'feature/x', defaultBranch: 'main', changed: [{ path: 'CLAUDE.md', mtimeMs: NOW - 3 * 3600_000 }] },
}

const kinds = (findings: Finding[]) => findings.map(one => `${one.kind}:${one.subject}`)

describe('audit findings, one fixture per kind', () => {
  const findings = auditFindings(BASE)
  const of = (kind: string) => findings.filter(one => one.kind === kind)

  test('the queue: a status not exactly queued, running or done; a running task naming no live session; a queued task waiting on a finished or retired session; a done task', () => {
    expect(of('queue-status').map(one => [one.subject, one.evidence])).toEqual([['task q-blocked "Blocked task"', 'status "blocked" is not exactly queued, running or done']])
    expect(of('running-task-no-session').map(one => one.subject)).toEqual(['task q-run-none "Running with no session"'])
    expect(of('running-task-no-session')[0]?.evidence).toBe('running, but it names no live session (by session id, its first 8 characters or its name); 1 session alive')
    expect(of('waits-for-finished').map(one => [one.subject, one.evidence])).toEqual([
      ['task q-wait-done "Waits on the clean one"', `waits_for "session ${SID_DONE.slice(0, 8)} to finish": session d0d0d0d0 "clean done" finished`],
      ['task q-wait-retired "Waits on a retired one"', `waits_for "${SID_RETIRED}": session c0c0c0c0 was retired`],
    ])
    expect(of('done-in-queue').map(one => one.subject)).toEqual(['task q-done "Finished task"'])
    expect(findings.every(one => one.action !== '')).toBe(true)
  })

  test('the registry: unacknowledged (and unharvested) sessions, a retirable one, an old kept one', () => {
    expect(of('unacknowledged').map(one => [one.subject, one.evidence])).toEqual([
      ['session e0e0e0e0 "unreported"', 'finished (chatter) 10m00s ago, not acknowledged'],
      ['session b0b0b0b0 "dead unharvested"', 'its pid 4102 is gone and the mod has not harvested its exit yet'],
    ])
    // The clean one is named by a queued task's waits_for: that counts as named, so it is not retirable.
    expect(of('retirable')).toEqual([])
    expect(of('kept-old').map(one => [one.subject, one.evidence])).toEqual([['session f0f0f0f0 "kept long"', 'marked keep, last active 7h00m ago (more than 6 hours)']])
  })

  test('a finished clean acknowledged session no task names is retirable; kept, named or not clean is not', () => {
    const queue = JSON.stringify({ tasks: [{ id: 'q', status: 'queued', title: 'x', note: SID_UNREP.slice(0, 8) }] })
    const entries = [
      { title: 'free', session_id: SID_DONE, reported: true, outcome: { kind: 'clean' } },
      { title: 'kept', session_id: SID_KEPT, reported: true, keep: true, outcome: { kind: 'clean' }, ended_at: NOW / 1000 - 60 },
      { title: 'named', session_id: SID_UNREP, reported: true, outcome: { kind: 'clean' } },
      { title: 'limited', session_id: SID_DEAD, reported: true, outcome: { kind: 'limit' } },
    ]
    const found = auditFindings({ entries, facts: FACTS, nowMs: NOW, queueText: queue })
    expect(kinds(found.filter(one => one.kind === 'retirable'))).toEqual(['retirable:session d0d0d0d0 "free"'])
    expect(found.filter(one => one.kind === 'kept-old')).toEqual([])
  })

  test('the open points: an open one raised more than 7 days ago, a held one; closed and fresh ones are fine', () => {
    expect(of('open-point-old').map(one => [one.subject, one.evidence])).toEqual([['open point old "An old question"', 'raised 2026-01-01, 9 days ago']])
    expect(of('open-point-held').map(one => one.subject)).toEqual(['open point held "A held question"'])
  })

  test('git: a branch other than the default with no worker alive, tracked changes and their age; silent without git', () => {
    const noLive = auditFindings({ ...BASE, entries: ENTRIES.filter(one => one.session_id !== SID_LIVE) })
    expect(noLive.filter(one => one.kind === 'git-branch').map(one => one.evidence)).toEqual(['on branch feature/x, not the default main; 0 workers alive'])
    // A worker alive: it may be on that branch on purpose.
    expect(of('git-branch')).toEqual([])
    expect(of('git-uncommitted').map(one => one.evidence)).toEqual(['1 tracked file with changes not committed (CLAUDE.md), the oldest change 3h00m old; branch feature/x; 1 worker alive'])
    expect(auditFindings({ ...BASE, git: { changed: [] } }).filter(one => one.kind === 'git-branch').map(one => one.evidence)).toEqual(['HEAD is detached; 1 worker alive'])
    const silent = auditFindings({ ...BASE, git: undefined } as AuditInput)
    expect(silent.filter(one => one.kind.startsWith('git'))).toEqual([])
  })

  test('backups/: per kind, the files older than 2 days besides the newest; a kind of one file is fine', () => {
    expect(of('backups').map(one => [one.subject, one.evidence])).toEqual([
      ['backups of kind task-queue-before-queue-task.json', '3 files; 2 are older than 2 days besides the newest: task-queue-before-queue-task-2026-01-07.json, task-queue-before-queue-task-2026-01-06.json'],
    ])
    // A file name is redacted as a path is: dated names read whole, a token-like word goes.
    const token = 'ghp_CANARY0123456789abcdefABCDEF'
    const tokenName = auditFindings({ ...BASE, backups: [file(`${token}-2026-01-09.json`, 0), file(`${token}-2026-01-01.json`, 5 * DAY)] }).filter(one => one.kind === 'backups')
    expect(tokenName.map(one => [one.subject, one.evidence])).toEqual([['backups of kind [redacted].json', '2 files; 1 is older than 2 days besides the newest: [redacted]-2026-01-01.json']])
    expect(auditText({ ...BASE, backups: [file(`${token}-2026-01-09.json`, 0)] })).not.toContain('CANARY')
    const loose = auditFindings({ ...BASE, runs: [file('ghp_CANARY0123456789abcdefABCDEF.json', DAY)] }).filter(one => one.kind === 'runs')
    expect(loose.map(one => one.evidence)).toEqual(['1 file (1 KiB) that no registry entry names, the oldest 24h00m old: [redacted].json'])
    expect(backupKind('headless-sessions-before-completion-2026-10-10.json')).toBe('headless-sessions-before-completion.json')
    expect(backupKind('license-lib.sh.orig-2026-10-10b')).toBe('license-lib.sh.orig')
    expect(backupKind('sheet-notes-1.2.8-2026-10-09.md')).toBe('sheet-notes-1.2.8.md')
  })

  test('the runs directory: the files no registry entry names, the mod\'s own files aside; reports/: every saved report', () => {
    expect(of('runs').map(one => one.evidence)).toEqual(['2 files (2 KiB) that no registry entry names, the oldest 720h00m old: 20250101-old.json, 20250101-old.err'])
    expect(of('reports').map(one => one.evidence)).toEqual(['2 saved reports: unit-a.md (120h00m old), unit-b.md (24h00m old)'])
  })

  test('agreed-decisions.md: the sections whose unit nothing names, by their branch, number or words; Standing never', () => {
    const live = { ...BASE, entries: [...ENTRIES, { title: 'Live parser work', session_id: 'x', cwd: '/w' }] }
    const stale = auditFindings(live).filter(one => one.kind === 'decisions-stale')
    expect(stale.map(one => one.evidence)).toEqual([
      '2 sections whose unit no queue task, registry entry or open point names: "T58 - requirement 946677 (HMI switch) - branch feature/req-946677" (feature/req-946677, T58, 946677), "Windows support for the mod (user, 2026-01-02)" (words windows, support)',
    ])
    expect(decisionSections(DECISIONS).map(one => [one.heading.slice(0, 12), one.lines])).toEqual([
      ['T58 - requir', 1],
      ['Live work on', 2],
      ['Windows supp', 1],
      ['Standing', 1],
    ])
  })

  test('a helper file that does not parse is a high finding and its checks are skipped; so is an unreadable registry', () => {
    const found = auditFindings({ entries: [], facts: FACTS, nowMs: NOW, queueText: '{', pointsText: '[]', registryError: 'registry is not JSON: x' })
    expect(found.map(one => [one.severity, one.kind, one.evidence])).toEqual([
      ['high', 'helper-file', 'registry is not JSON: x'],
      ['high', 'helper-file', 'task-queue.json does not parse'],
      ['high', 'helper-file', 'open-points.json has no points array'],
    ])
  })

  test('the order: high, then medium, then low, each kind in its place', () => {
    const order = findings.map(one => one.severity)
    expect(order).toEqual([...order].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)))
    expect(findings[0]?.kind).toBe('queue-status')
    expect(findings.at(-1)?.kind).toBe('decisions-stale')
  })
})

describe('audit text', () => {
  test('the count, the facts, then the numbered findings; nothing changed', () => {
    const text = auditText(BASE)
    const lines = text.split('\n')
    expect(lines[0]).toBe('audit_state: 15 findings (4 high, 6 medium, 5 low); nothing was changed.')
    expect(lines[1]).toBe(
      'facts: registry 5 entries, 1 alive; queue 7 tasks; open points 3 open (1 held); backups/ 5 files in 3 kinds (task-queue-before-queue-task.json 3, open-points-before-open-point.json 1, dev-mod-before-sync 1); runs 10 files; reports/ 2 files; agreed-decisions.md 11 lines, 4 sections; git branch feature/x (default main), 1 tracked file changed.',
    )
    expect(lines[2]).toBe('1. [high] queue-status | task q-blocked "Blocked task" | status "blocked" is not exactly queued, running or done | action: queue_task update with status queued, running or done, the detail in note')
    expect(lines.length).toBe(17)
  })

  test('free text is redacted; at most MAX_FINDINGS findings, the rest counted; no findings said as such', () => {
    const tasks = Array.from({ length: MAX_FINDINGS + 3 }, (_, n) => ({ id: `t${n}`, title: n === 0 ? 'key ghp_CANARY0123456789abcdefABCDEF' : `t${n}`, status: 'later' }))
    const text = auditText({ entries: [], facts: FACTS, nowMs: NOW, queueText: JSON.stringify({ tasks }) })
    expect(text).not.toContain('CANARY')
    expect(text).toContain('task t0 "key [redacted]"')
    expect(text.split('\n').at(-1)).toBe('(3 more findings not shown)')
    expect(auditText({ entries: [], facts: FACTS, nowMs: NOW }).split('\n')[0]).toBe('audit_state: no findings; nothing was changed.')
  })
})

// ---------------------------------------------------------------- through the plugin

const HOME = '/m/home'
const ORCH = '/m/orch'
const RUNS = `${HOME}/.claude/session-control/runs`
const REG = `${HOME}/.claude/headless-sessions.json`
const OPTIONS = { orchestratorDir: ORCH, registryPath: '~/.claude/headless-sessions.json', completionWrites: false, helper: 'off' }

type Git = 'repo' | 'missing' | 'not-a-repo'

function world(on: On, git: Git) {
  const files = new Map<string, string>([
    [REG, JSON.stringify([{ title: 'clean done', session_id: SID_DONE, config_dir: '/c', reported: true, outcome: { kind: 'clean', summary: 'clean: ok' }, result_file: `${RUNS}/a.json` }])],
    [`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n'],
    [`${ORCH}/open-points.json`, JSON.stringify({ points: [] })],
    [`${ORCH}/task-queue.json`, JSON.stringify({ tasks: [{ id: 'stale', status: 'pending', title: 'Stale entry' }, { id: 'fine', status: 'queued', title: 'Fine entry' }] })],
    [`${ORCH}/agreed-decisions.md`, '# Agreed decisions\n'],
    [`${ORCH}/open-points-archive.md`, '# Open points archive\n'],
    [`${RUNS}/cleared.jsonl`, `${JSON.stringify({ session_id: SID_RETIRED })}\n`],
    [`${ORCH}/README.md`, 'x'],
  ])
  const dirs: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }[]> = {
    [`${ORCH}/backups`]: [{ name: 'task-queue-before-queue-task-2026-09-17.json', kind: 'file', size: 5, mtimeMs: NOW_MS - 4 * DAY, isLink: false }, { name: 'task-queue-before-queue-task-2026-09-21.json', kind: 'file', size: 5, mtimeMs: NOW_MS, isLink: false }],
    [RUNS]: [{ name: 'a.json', kind: 'file', size: 9, mtimeMs: NOW_MS, isLink: false }, { name: 'loose.json', kind: 'file', size: 9, mtimeMs: NOW_MS - DAY, isLink: false }],
  }
  const w = { writes: [] as string[], runs: [] as string[][] }
  const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  mock.clock(on, { now: NOW_MS })
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-control__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || e.path in dirs }))
  on('fs.stat', ($, e) => {
    if (e.path === `${ORCH}/README.md`) return { value: { kind: 'file', size: 1, mtimeMs: NOW_MS - 2 * 3600_000, isLink: false } }
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.list', ($, e) => {
    const list = dirs[String(e.path)]
    if (list === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: list }
  })
  on('process.run', ($, e) => {
    const argv = e.argv.map(String)
    w.runs.push(argv)
    if (argv[0] === 'sh' && argv[2] === PROBE_SCRIPT) return ok('')
    if (argv[0] === 'mkdir') return ok()
    if (argv[0] === 'git') {
      if (git === 'missing') throw new Error('spawn git ENOENT')
      const args = argv.slice(4).join(' ')
      if (args === 'rev-parse --is-inside-work-tree') return git === 'repo' ? ok('true\n') : ok('', 128)
      if (args === 'symbolic-ref --short -q HEAD') return ok('feature/old\n')
      if (args === 'symbolic-ref --short -q refs/remotes/origin/HEAD') return ok('origin/main\n')
      if (args === 'status --porcelain=v1 -z --untracked-files=no') return ok(' M README.md\0R  new.md\0old.md\0')
      if (args === 'rev-parse --show-toplevel') return ok(`${ORCH}\n`)
    }
    throw new Error(`unexpected command ${argv.join(' ')}`)
  })
  return w
}

describe('audit_state through the plugin', () => {
  test('the findings of the seeded files, git read with read commands only, nothing written', { options: OPTIONS }, async ($, on) => {
    const w = world(on, 'repo')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const writes = w.writes.length
    const runs = w.runs.length
    const out = (await $.tool.call({ tool: 'mcp__session-control__audit_state' } as never)) as { result?: unknown }
    const text = String(out.result)
    expect(w.writes.slice(writes)).toEqual([])
    const ran = w.runs.slice(runs)
    expect(ran.filter(argv => argv[0] !== 'git').map(argv => argv[2])).toEqual([PROBE_SCRIPT])
    // Every git command carries --no-optional-locks (no index refresh) and is a read.
    const gits = ran.filter(argv => argv[0] === 'git')
    expect(gits.map(argv => argv.slice(1, 4).join(' '))).toEqual(Array(5).fill(`--no-optional-locks -C ${ORCH}`))
    expect(gits.map(argv => argv.slice(4).join(' '))).toEqual([
      'rev-parse --is-inside-work-tree',
      'symbolic-ref --short -q HEAD',
      'symbolic-ref --short -q refs/remotes/origin/HEAD',
      'status --porcelain=v1 -z --untracked-files=no',
      'rev-parse --show-toplevel',
    ])
    const lines = text.split('\n')
    expect(lines[0]).toBe('audit_state: 6 findings (1 high, 3 medium, 2 low); nothing was changed.')
    expect(text).toContain('[high] queue-status | task stale "Stale entry" | status "pending" is not exactly queued, running or done')
    expect(text).not.toContain('task fine')
    expect(text).toContain(`[medium] retirable | session ${SID_DONE.slice(0, 8)} "clean done"`)
    expect(text).toContain('[medium] git-uncommitted | the orchestrator directory | 2 tracked files with changes not committed (README.md, new.md), the oldest change 2h00m old; branch feature/old; 0 workers alive')
    expect(text).toContain('[medium] git-branch | the orchestrator directory | on branch feature/old, not the default main; 0 workers alive')
    expect(text).toContain('[low] backups | backups of kind task-queue-before-queue-task.json | 2 files; 1 is older than 2 days besides the newest: task-queue-before-queue-task-2026-09-17.json')
    expect(text).toContain('[low] runs | the runs directory | 1 file (1 KiB) that no registry entry names, the oldest 24h00m old: loose.json')
    expect(lines[1]).toContain('reports/ missing')
  })

  test('git missing: no git finding and no error, the rest as before', { options: OPTIONS }, async ($, on) => {
    const w = world(on, 'missing')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const out = (await $.tool.call({ tool: 'mcp__session-control__audit_state' } as never)) as { result?: unknown }
    const text = String(out.result)
    expect(text).not.toContain('git-')
    expect(text.split('\n')[1]).toContain('git not checked (no git, or not a repository)')
    expect(text).toContain('[high] queue-status')
    expect(w.writes).toEqual([])
  })

  test('the directory no repository: git asked once, then silent', { options: OPTIONS }, async ($, on) => {
    const w = world(on, 'not-a-repo')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const runs = w.runs.length
    const out = (await $.tool.call({ tool: 'mcp__session-control__audit_state' } as never)) as { result?: unknown }
    expect(String(out.result)).not.toContain('git-')
    expect(w.runs.slice(runs).filter(argv => argv[0] === 'git').map(argv => argv.slice(4).join(' '))).toEqual(['rev-parse --is-inside-work-tree'])
  })
})
