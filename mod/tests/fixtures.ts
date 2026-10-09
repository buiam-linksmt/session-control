// Fixtures for session-control's tests. Pure data: no real registry, no real /proc,
// no real result file. Paths under /fixture/ exist nowhere; the integration
// tests serve them through their own `fs.read` / `process.run` hooks.

export const NOW_SEC = 1_790_000_000
export const NOW_MS = NOW_SEC * 1000

export const SID_ALIVE = 'aaaaaaaa-1111-4111-8111-111111111111'
export const SID_DEAD = 'bbbbbbbb-2222-4222-8222-222222222222'
export const SID_UNREPORTED = 'cccccccc-3333-4333-8333-333333333333'
export const SID_DONE = 'dddddddd-4444-4444-8444-444444444444'
export const SID_REUSED = 'eeeeeeee-5555-4555-8555-555555555555'

export const REGISTRY_PATH = '/fixture/home/.claude/headless-sessions.json'
export const ORCH_DIR = '/fixture/workspaces/session_control'
export const HOME = '/fixture/home'

/** The daemon's own object, which a merge must keep untouched. */
export const DAEMON_RESUME = { parked_until: '2026-10-06T12:00:00Z', strikes: 2, escalated: true }

export const REGISTRY = [
  { title: 'alive worker', pid: 4101, session_id: SID_ALIVE, config_dir: '/fixture/lic/a', model: 'opus', effort: 'high', cwd: '/work/a' },
  {
    title: 'limited worker',
    pid: 4102,
    session_id: SID_DEAD,
    config_dir: '/fixture/lic/b',
    model: 'sonnet',
    effort: 'medium',
    result_file: '/fixture/results/limit.json',
    resume: DAEMON_RESUME,
    unknown_future_field: [1, 2, 3],
  },
  { title: 'unreported worker', session_id: SID_UNREPORTED, config_dir: '/fixture/lic/a', reported: false },
  { title: 'queued worker', model: 'opus', effort: 'low' },
  { title: 'done worker', session_id: SID_DONE, config_dir: '/fixture/lic/a', reported: true },
  { title: 'pid reused', pid: 4106, session_id: SID_REUSED, config_dir: '/fixture/lic/c', model: 'opus', effort: 'max' },
]

export const REGISTRY_TEXT = JSON.stringify(REGISTRY, null, 2) + '\n'

const tab = (...cols: (string | number)[]) => cols.join('\t')

/** What the one /proc probe prints for the fixture registry. */
export const PROBE_STDOUT = [
  tab('P', 4101, 'claude', 125, '/work/a', '/fixture/lic/a', 'claude -p --model opus --dangerously-skip-permissions'),
  tab('P', 4999, 'claude', 2400, '/work/x', '/fixture/lic/b', 'claude --print --model sonnet'),
  tab('P', 3000, 'claude', 90000, ORCH_DIR, '', 'claude --continue'),
  tab('A', 4101, '2.1.292', 5000, 5000, SID_ALIVE),
  tab('A', 4106, 'bash', 7000, 6000, 'ffffffff-6666-4666-8666-666666666666'),
  tab('T', SID_ALIVE, NOW_SEC - 30),
  tab('T', SID_UNREPORTED, NOW_SEC - 4000),
  tab('T', SID_DEAD, NOW_SEC - 600),
  'garbage line',
  '',
].join('\n')

export const RESULTS = {
  clean: JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.',
    total_cost_usd: 1.23,
    session_id: SID_DEAD,
  }),
  limit: JSON.stringify({
    type: 'result',
    is_error: true,
    result: "You've hit your session limit · resets 3pm",
    total_cost_usd: 0.4,
    session_id: SID_DEAD,
  }),
  login: JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }),
  chatter: JSON.stringify({ type: 'result', is_error: false, result: 'Let me look at that.', duration_ms: 1_800_000, num_turns: 60, total_cost_usd: 7.2 }),
  shortAnswer: JSON.stringify({ type: 'result', is_error: false, result: 'ok', duration_ms: 2454, num_turns: 1, total_cost_usd: 0.05 }),
  empty: '',
  truncated: '{"type":"result","is_error":false,"result":"half wr',
  error: JSON.stringify({ type: 'result', is_error: true, result: 'Tool execution failed: ENOSPC while writing the output.' }),
  oom: 'Killed: process was low on memory',
}

export const TASK_NOTIFICATION_KILLED =
  '<task-notification>\n<task-id>b7x1</task-id>\n<output-file>/tmp/tasks/b7x1.output</output-file>\n<status>killed</status>\n<summary>Background command was killed</summary>\n</task-notification>'
