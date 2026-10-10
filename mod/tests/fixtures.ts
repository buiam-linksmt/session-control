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

/**
 * What PROBE_PS1 prints on Windows for the same registry: the creation time in epoch ms in both start columns of a
 * pid whose sessions file matches (4101), the file's own startedAt where it does not (4106), none without a file
 * (4102); a claude.exe whose sessions file is nowhere has no cwd and no config dir (4999).
 */
export const WIN_PROBE_STDOUT = [
  tab('P', 4101, 'claude', 125, 'C:\\work\\a', 'C:/fixture/lic/a', '"C:\\Users\\u\\.local\\bin\\claude.exe" -p --model opus --dangerously-skip-permissions'),
  tab('P', 4999, 'claude', 2400, '', '', 'claude.exe --print --model sonnet'),
  tab('P', 3000, 'claude', 90000, 'C:\\orch', 'C:\\Users\\u\\.claude', 'claude.exe --continue'),
  tab('A', 4101, 'claude', 1789999875123, 1789999875123, SID_ALIVE),
  tab('A', 4102, 'claude', 1789990000000, '', ''),
  tab('A', 4106, 'claude', 1789999990000, 1789990000000, SID_REUSED),
  tab('T', SID_ALIVE, NOW_SEC - 30),
  tab('T', SID_DEAD, NOW_SEC - 600),
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

/**
 * Differential cases of the registry edits (registerEntry, removeEntries, ackEntries), shared with
 * tests/probe-selftest.py, which runs REGISTER_SCRIPT, CLEAR_SCRIPT and ACK_SCRIPT under sh and jq on the same
 * inputs: the text between the markers is plain JSON, which that script parses. `registry` null is a missing file.
 * `expect` is the TypeScript side (`text`, the cleared `log`, or `refused`; `unchanged` for a missing file that
 * nothing writes) and, without `old`, the jq side too, byte for byte. `old` names where the jq side differs on
 * purpose: its own `text` and `log`, `fails` (non-zero exit, registry untouched), or `sameValue` (the same JSON
 * value written another way).
 */
export type RegistryGolden = {
  name: string
  op: string
  registry: string | null
  mode?: string
  entry?: Record<string, unknown>
  ids?: string[]
  keep?: boolean
  expect: { text?: string; log?: string; refused?: boolean; unchanged?: boolean }
  old?: { text?: string; log?: string; fails?: boolean; sameValue?: boolean }
}

// REGISTRY_GOLDEN:BEGIN
export const REGISTRY_GOLDEN: RegistryGolden[] = [
  {"name": "register new: appended, the file laid out as jq lays it out", "op": "register", "mode": "new", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": false,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"keep\": false,\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  },\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: an already pretty file", "op": "register", "mode": "new", "registry": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": false,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"keep\": false,\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": false,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"keep\": false,\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  },\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register resume: merged in place, old key order kept, reported and outcome dropped", "op": "register", "mode": "resume", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "entry": {"pid": 7002, "session_id": "bbbbbbbb-2222-4222-8222-222222222222", "cwd": "/work/b", "result_file": "/r/y.json"}, "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true,\n    \"pid\": 7002,\n    \"cwd\": \"/work/b\",\n    \"result_file\": \"/r/y.json\"\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"keep\": false,\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n"}},
  {"name": "register resume: no entry with that session id", "op": "register", "mode": "resume", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "entry": {"pid": 7002, "session_id": "ffffffff-0000-4000-8000-000000000009", "cwd": "/work/b", "result_file": "/r/y.json"}, "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": false,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"keep\": false,\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n"}},
  {"name": "register new: a missing file starts as []", "op": "register", "mode": "new", "registry": null, "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: an empty array without a newline", "op": "register", "mode": "new", "registry": "[]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: an empty file keeps the entry (jq writes an empty file)", "op": "register", "mode": "new", "registry": "", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}, "old": {"text": ""}},
  {"name": "register new: a blank file keeps the entry (jq writes an empty file)", "op": "register", "mode": "new", "registry": " \n\n", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}, "old": {"text": ""}},
  {"name": "register resume: an empty file stays empty", "op": "register", "mode": "resume", "registry": "", "entry": {"pid": 7002, "session_id": "bbbbbbbb-2222-4222-8222-222222222222", "cwd": "/work/b", "result_file": "/r/y.json"}, "expect": {"text": ""}},
  {"name": "register new: DEL, control, U+2028, an escaped slash and a lone low surrogate come out as jq writes them", "op": "register", "mode": "new", "registry": "[{\"s\":\"a\u007fb\\u007f\\u0001\u2028\\/c\\udc00d\",\"t\\udc00\":\"\\b\\f\\n\\r\\t\\\"\\\\\"}]", "entry": {"title": "del\u007f and \u2028", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"s\": \"a\\u007fb\\u007f\\u0001\u2028/c\ufffdd\",\n    \"t\ufffd\": \"\\b\\f\\n\\r\\t\\\"\\\\\"\n  },\n  {\n    \"title\": \"del\\u007f and \u2028\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: a lone high surrogate escape is refused (jq cannot read it)", "op": "register", "mode": "new", "registry": "[{\"s\":\"x\\ud800y\"}]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"refused": true}},
  {"name": "register new: a JSON object is refused", "op": "register", "mode": "new", "registry": "{\"a\":1}", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"refused": true}},
  {"name": "register new: text that is not JSON is refused", "op": "register", "mode": "new", "registry": "not json", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"refused": true}},
  {"name": "register new: null is refused (jq appends to it)", "op": "register", "mode": "new", "registry": "null", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"refused": true}, "old": {"text": "[\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: two JSON values are refused (jq writes two arrays)", "op": "register", "mode": "new", "registry": "[] []", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"refused": true}, "old": {"text": "[\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n[\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: items that are not objects stay", "op": "register", "mode": "new", "registry": "[1,\"x\",[2],true,null]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  1,\n  \"x\",\n  [\n    2\n  ],\n  true,\n  null,\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register resume: an item that is not an object is refused (jq stops on it)", "op": "register", "mode": "resume", "registry": "[{\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\"},1]", "entry": {"pid": 7002, "session_id": "bbbbbbbb-2222-4222-8222-222222222222", "cwd": "/work/b", "result_file": "/r/y.json"}, "expect": {"refused": true}},
  {"name": "register resume: an entry without a session id matches an entry without one", "op": "register", "mode": "resume", "registry": "[{\"title\":\"a\"},{\"title\":\"b\",\"session_id\":null},{\"title\":\"c\",\"session_id\":\"x\"}]", "entry": {"title": "z", "pid": 3, "reported": true}, "expect": {"text": "[\n  {\n    \"title\": \"z\",\n    \"pid\": 3\n  },\n  {\n    \"title\": \"z\",\n    \"session_id\": null,\n    \"pid\": 3\n  },\n  {\n    \"title\": \"c\",\n    \"session_id\": \"x\"\n  }\n]\n"}},
  {"name": "register new: duplicate keys keep the first place and the last value", "op": "register", "mode": "new", "registry": "[{\"a\":1,\"b\":2,\"a\":3}]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"a\": 3,\n    \"b\": 2\n  },\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: a __proto__ key stays a key", "op": "register", "mode": "new", "registry": "[{\"__proto__\":{\"x\":1},\"a\":1}]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"__proto__\": {\n      \"x\": 1\n    },\n    \"a\": 1\n  },\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}},
  {"name": "register new: numbers jq keeps as written come out as JavaScript writes them, the same value", "op": "register", "mode": "new", "registry": "[{\"a\":1.0,\"b\":1e2,\"c\":1E-7,\"d\":0.10,\"e\":-0}]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"a\": 1,\n    \"b\": 100,\n    \"c\": 1e-7,\n    \"d\": 0.1,\n    \"e\": 0\n  },\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}, "old": {"sameValue": true}},
  {"name": "register new: integer-like keys come out in JavaScript's key order, the same value", "op": "register", "mode": "new", "registry": "[{\"b\":1,\"2\":2,\"a\":3,\"1\":4}]", "entry": {"title": "new \u2014 na\u00efve \u2713", "pid": 7001, "session_id": "abcdabcd-0000-4000-8000-000000000001", "cwd": "/work/new", "result_file": "/r/x.json"}, "expect": {"text": "[\n  {\n    \"1\": 4,\n    \"2\": 2,\n    \"b\": 1,\n    \"a\": 3\n  },\n  {\n    \"title\": \"new \u2014 na\u00efve \u2713\",\n    \"pid\": 7001,\n    \"session_id\": \"abcdabcd-0000-4000-8000-000000000001\",\n    \"cwd\": \"/work/new\",\n    \"result_file\": \"/r/x.json\"\n  }\n]\n"}, "old": {"sameValue": true}},
  {"name": "clear: removes the named sessions, logs them compact, keeps null and the rest", "op": "clear", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "ids": ["bbbbbbbb-2222-4222-8222-222222222222", "cccccccc-3333-4333-8333-333333333333", "ffffffff-0000-4000-8000-000000000009"], "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n", "log": "{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true}\n{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true}\n"}},
  {"name": "clear: nothing named is in the registry", "op": "clear", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "ids": ["ffffffff-0000-4000-8000-000000000009"], "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": false,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"keep\": false,\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n", "log": ""}},
  {"name": "clear: a missing file stays missing", "op": "clear", "registry": null, "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "expect": {"unchanged": true}},
  {"name": "clear: an empty file stays empty", "op": "clear", "registry": "", "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "expect": {"text": "", "log": ""}},
  {"name": "clear: an id argument holding a newline names two ids", "op": "clear", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "ids": ["aaaaaaaa-1111-4111-8111-111111111111\ncccccccc-3333-4333-8333-333333333333"], "expect": {"text": "[\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": false,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n", "log": "{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"}\n{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true}\n"}},
  {"name": "clear: an array session id matches a run of the ids, as jq's index does", "op": "clear", "registry": "[{\"session_id\":[\"x\",\"y\"]},{\"session_id\":[\"y\",\"x\"]},{\"session_id\":[]},{\"session_id\":5}]", "ids": ["x", "y", "z"], "expect": {"text": "[\n  {\n    \"session_id\": [\n      \"y\",\n      \"x\"\n    ]\n  },\n  {\n    \"session_id\": []\n  },\n  {\n    \"session_id\": 5\n  }\n]\n", "log": "{\"session_id\":[\"x\",\"y\"]}\n"}},
  {"name": "clear: an item that is not an object is refused (jq logs what came before it, then stops)", "op": "clear", "registry": "[{\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"t\":1},\"x\"]", "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "expect": {"refused": true}, "old": {"fails": true, "log": "{\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"t\":1}\n"}},
  {"name": "clear: not JSON is refused", "op": "clear", "registry": "[{", "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "expect": {"refused": true}},
  {"name": "ack keep: reported true, keep true, each key where it was", "op": "ack", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "ids": ["bbbbbbbb-2222-4222-8222-222222222222", "cccccccc-3333-4333-8333-333333333333"], "keep": true, "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\"\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": true,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ],\n    \"keep\": true\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"keep\": true,\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n"}},
  {"name": "ack plain: reported true, keep removed", "op": "ack", "registry": "[{\"title\":\"alive\",\"pid\":4101,\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"cwd\":\"/work/a\"},{\"title\":\"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\"session_id\":\"bbbbbbbb-2222-4222-8222-222222222222\",\"reported\":false,\"outcome\":{\"kind\":\"limit\",\"costUsd\":0.4},\"resume\":{\"strikes\":2,\"escalated\":true},\"future\":[1,2.5,-3,null,{\"x\":[],\"y\":{}}],\"keep\":true},{\"session_id\":\"cccccccc-3333-4333-8333-333333333333\",\"keep\":false,\"reported\":true},null,{\"title\":\"queued\"}]", "ids": ["bbbbbbbb-2222-4222-8222-222222222222", "cccccccc-3333-4333-8333-333333333333", "aaaaaaaa-1111-4111-8111-111111111111"], "keep": false, "expect": {"text": "[\n  {\n    \"title\": \"alive\",\n    \"pid\": 4101,\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"cwd\": \"/work/a\",\n    \"reported\": true\n  },\n  {\n    \"title\": \"limited \u2014 caf\u00e9 \u2615 \ud83d\ude00\",\n    \"session_id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n    \"reported\": true,\n    \"outcome\": {\n      \"kind\": \"limit\",\n      \"costUsd\": 0.4\n    },\n    \"resume\": {\n      \"strikes\": 2,\n      \"escalated\": true\n    },\n    \"future\": [\n      1,\n      2.5,\n      -3,\n      null,\n      {\n        \"x\": [],\n        \"y\": {}\n      }\n    ]\n  },\n  {\n    \"session_id\": \"cccccccc-3333-4333-8333-333333333333\",\n    \"reported\": true\n  },\n  null,\n  {\n    \"title\": \"queued\"\n  }\n]\n"}},
  {"name": "ack keep: missing keys are added at the end, reported before keep", "op": "ack", "registry": "[{\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\",\"title\":\"t\"}]", "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "keep": true, "expect": {"text": "[\n  {\n    \"session_id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n    \"title\": \"t\",\n    \"reported\": true,\n    \"keep\": true\n  }\n]\n"}},
  {"name": "ack: a missing file stays missing", "op": "ack", "registry": null, "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "keep": false, "expect": {"unchanged": true}},
  {"name": "ack: an empty file stays empty", "op": "ack", "registry": "", "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "keep": true, "expect": {"text": ""}},
  {"name": "ack: an item that is not an object is refused", "op": "ack", "registry": "[{\"session_id\":\"aaaaaaaa-1111-4111-8111-111111111111\"},2]", "ids": ["aaaaaaaa-1111-4111-8111-111111111111"], "keep": false, "expect": {"refused": true}}
]
// REGISTRY_GOLDEN:END

/**
 * Prompts as Git Bash hands them to a Windows program (claude.exe), shared with tests/windows-selftest.py, which runs
 * them through Git Bash: `rewritten` when MSYS turns the start of the argument into a Windows path. The text between
 * the markers is plain JSON.
 */
// MSYS_PROMPTS:BEGIN
export const MSYS_PROMPTS: { text: string; rewritten: boolean }[] = [
  {"text": "Goal: do \"the\" thing; it's $HOME `x` \\ back\\slash caf\u00e9 \u2615\nkey=/c/Users/x\n--flag=/tmp/y\nC:\\Users\\x and /c/Users/x\n  indented", "rewritten": false},
  {"text": "# Goal\n/c/Users/x", "rewritten": false},
  {"text": "see /c/Users/x", "rewritten": false},
  {"text": " /c/Users/x", "rewritten": false},
  {"text": "\n/c/Users/x first line was empty", "rewritten": false},
  {"text": "//server/share is a share", "rewritten": false},
  {"text": "x:/c/y", "rewritten": false},
  {"text": "https://example.com/a", "rewritten": false},
  {"text": "C:/Users/x", "rewritten": false},
  {"text": "Note: /c/x", "rewritten": false},
  {"text": "/c/Users/u/x is a path\nsecond line", "rewritten": true},
  {"text": "/tmp/x and more", "rewritten": true},
  {"text": "a=/c/Users/x", "rewritten": true},
  {"text": "key=/c/Users/x\nmore lines here", "rewritten": true},
  {"text": "--opt=/c/x", "rewritten": true},
  {"text": "-I/c/x rest of it", "rewritten": true},
  {"text": "/c/a:/c/b", "rewritten": true}
]
// MSYS_PROMPTS:END
