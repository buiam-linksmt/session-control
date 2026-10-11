// The secret scan of worker results (secrets.ts, decision win-22): the detector on canaries of every kind and on what
// must stay readable (git shas in git context, UUIDs, generated names, a sha256sum line, long paths, placeholders),
// the trailing `secret scan:` line of read_result, worker_tail, the completion notes and turn_digest, and the one
// secret-in-result notice per entry through the plugin on the mock world, with the notices option off too. Every canary
// is an invented string.

import { describe, expect, test } from 'claude-code/testing'

import { TOAST_TITLES } from '../hooks/core'
import { digestText } from '../hooks/digest'
import { clean, readResultText, workerTailText } from '../hooks/inspect'
import { freshNoticeState, parseNoticeState, pruneHarvested, secretNotice } from '../hooks/notices'
import { addTallies, findSecrets, maskSecrets, secretScanLine, tallyFromAnswer, tallyOf } from '../hooks/secrets'
import type { SecretKind } from '../hooks/secrets'
import { parseProcFacts } from '../hooks/core'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, RUNS, mockWorld } from './mock-world'
import { echoPrompt, noticeLines, poll, seedOrch, startOrch, storeOf, toastsOf } from './notice-kit'

/**
 * Canaries in a token's shape are joined at run time, so the file itself holds no string a push-protection scanner takes
 * for a live token (one such scanner turned down a commit that held a Slack-shaped canary literally).
 */
const PRIVATE_KEY_HEAD = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
const PRIVATE_KEY_FOOT = ['-----END', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
const GITHUB_CANARY = ['ghp', 'CANARYcanary0000000000000000000000'].join('_')
const GITHUB_PAT_CANARY = ['github', 'pat', '11CANARY0000000000', 'canarycanarycanary00'].join('_')
const SK_CANARY = ['sk', 'ant', 'api03', 'CANARYcanary000000000000'].join('-')
const SLACK_CANARY = ['xoxb', '1111111111', 'CANARYcanary00'].join('-')
const AWS_CANARY = ['AKIA', 'CANARY0000000000'].join('')
const BEARER_CANARY = ['eyCANARYcanary000000000000', 'payload'].join('.')
const URL_CREDENTIALS_CANARY = ['alice', 'canary0pass'].join(':')
const URL_CREDENTIALS_CANARY_2 = ['bob', 'canary1pass'].join(':')

/** One invented canary per kind, each in the context a report would show it in. */
const CANARIES: readonly (readonly [SecretKind, string, string])[] = [
  ['private-key', `${PRIVATE_KEY_HEAD}\nb3BlbnNzaC1rZXktdjEAAAAACANARYcanary00000000\n${PRIVATE_KEY_FOOT}`, 'b3BlbnNzaC1rZXktdjEAAAAACANARYcanary00000000'],
  ['github-token', `pushed with ${GITHUB_CANARY} by mistake`, GITHUB_CANARY],
  ['github-token', `GITHUB_TOKEN set to ${GITHUB_PAT_CANARY}`, GITHUB_PAT_CANARY],
  ['sk-key', `the environment had ${SK_CANARY} in it`, SK_CANARY],
  ['slack-token', `webhook ${SLACK_CANARY} posted`, SLACK_CANARY],
  ['aws-key', `aws id ${AWS_CANARY} found`, AWS_CANARY],
  ['bearer-token', `curl -H "Authorization: Bearer ${BEARER_CANARY}" https://x`, BEARER_CANARY],
  ['secret-assignment', 'DB_PASSWORD=canary0pass in .env', 'canary0pass'],
  ['secret-assignment', '{"api_key": "canary-0000-key-value"}', 'canary-0000-key-value'],
  ['secret-assignment', 'mysql --password Canary0Pass9 -u root', 'Canary0Pass9'],
  ['url-credentials', `git clone https://${URL_CREDENTIALS_CANARY}@example.com/repo.git`, URL_CREDENTIALS_CANARY],
  ['keyed-blob', 'the signing secret is Y2FuYXJ5LWNhbmFyeS1jYW5hcnktMDAwMDAw', 'Y2FuYXJ5LWNhbmFyeS1jYW5hcnktMDAwMDAw'],
  ['keyed-blob', 'api key: 0123456789abcdef0123456789abcdefcafe', '0123456789abcdef0123456789abcdefcafe'],
]

/** What must stay readable: no likely secret in any of them. */
const READABLE: readonly string[] = [
  'commit 7ebdad1d2c3f4e5a6b7c8d9e0f1a2b3c4d5e6f70 refs/heads/main',
  'origin 7ebdad1d2c3f4e5a6b7c8d9e0f1a2b3c4d5e6f70\trefs/heads/feature/x',
  'token for session 10000000-aaaa-4bbb-8ccc-000000000001',
  'auth token w-fix-the-parser-261010143117',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  README.md',
  'key file /home/user/workspaces/session_control/mod/hooks/secrets.ts',
  'the token budget is 128000; max_tokens: 4096; tokenState: refreshed2',
  'password=$DB_PASS token=<your-token> secret=*** password=changeme api_key=[redacted]',
  'PWD=/home/user/workspaces and git@github.com:owner/repo.git',
  'https://alice@example.com/x and https://u:${PASS}@h/',
  'API keys are stored in the vault; the auth flow is OAuth.',
  'secret scan: 2 likely secrets redacted (kinds: sk-key)',
  'src/api/webserver/AuthKeywords.robot:123 and ApiKeyFilter.java:88',
]

describe('secrets.ts: the detector', () => {
  test('a canary of every kind is found with its kind and line, and masked; the name before it stays readable', () => {
    for (const [kind, text, value] of CANARIES) {
      const finds = findSecrets(`first line\n${text}`)
      expect({ text, kinds: finds.map(one => one.kind), line: finds[0]?.line }).toEqual({ text, kinds: [kind], line: 2 })
      const masked = maskSecrets(text).text
      expect({ text, isGone: !masked.includes(value) && !clean(text).includes(value) }).toEqual({ text, isGone: true })
    }
    expect(maskSecrets('DB_PASSWORD=canary0pass').text).toBe('DB_PASSWORD=[redacted]')
    expect(maskSecrets(`https://${URL_CREDENTIALS_CANARY}@example.com/r`).text).toBe('https://[redacted]@example.com/r')
  })

  test('readable: git shas in git context, UUIDs, generated names, a sha256sum line, long paths, placeholders and plain words find nothing', () => {
    for (const text of READABLE) expect({ text, finds: findSecrets(text) }).toEqual({ text, finds: [] })
    // clean keeps them as the redaction did before (the sha256sum line's long hex goes, by the redaction, as before).
    expect(clean(READABLE[0] ?? '')).toBe(READABLE[0])
    expect(clean(READABLE[2] ?? '')).toBe(READABLE[2])
    expect(clean(READABLE[3] ?? '')).toBe(READABLE[3])
  })

  test('the scan line: count and kinds only, in a fixed order; read back from an answer; tallies add', () => {
    const tally = tallyOf(findSecrets(CANARIES.map(one => one[1]).join('\n')))
    expect(tally.count).toBe(CANARIES.length)
    expect(secretScanLine(tally)).toBe('secret scan: 13 likely secrets redacted (kinds: private-key, github-token, sk-key, slack-token, aws-key, bearer-token, url-credentials, secret-assignment, keyed-blob)')
    expect(secretScanLine({ count: 1, kinds: ['aws-key'] })).toBe('secret scan: 1 likely secret redacted (kinds: aws-key)')
    expect(tallyFromAnswer(`x\n${secretScanLine(tally)}`)).toEqual(tally)
    expect(tallyFromAnswer('x\nno scan')).toBeUndefined()
    expect(addTallies({ count: 1, kinds: ['keyed-blob'] }, { count: 2, kinds: ['aws-key', 'keyed-blob'] })).toEqual({ count: 3, kinds: ['aws-key', 'keyed-blob'] })
  })

  test('known false positive (accepted, documented): a base64 value after a key word in a quoted example is counted', () => {
    expect(findSecrets('> The README shows: token: "c2VjcmV0LWV4YW1wbGUtdmFsdWUtMDAx"').map(one => one.kind)).toEqual(['secret-assignment'])
  })
})

const SID = '66666666-aaaa-4bbb-8ccc-666666666666'
const ENTRY = { title: 'leaky worker', pid: 4300, session_id: SID, name: 'w-leaky-worker-261011090000', config_dir: `${HOME}/.claude`, cwd: '/w/work', model: 'haiku', effort: 'low', result_file: `${RUNS}/leaky.json` }
const LEAK = `Done. Pushed. The run printed ${AWS_CANARY} and ${GITHUB_CANARY}.\n## main...origin/main\nexit 0`
const resultOf = (text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.1, duration_ms: 1000, num_turns: 3 })
const NO_FACTS = parseProcFacts('')

describe('the trailing line of the answers', () => {
  test('read_result: the report masked, the redaction count includes the masks, the scan line last; none without a find', () => {
    const answer = readResultText({ entry: ENTRY, facts: NO_FACTS, resultText: resultOf(LEAK), errText: '', maxChars: 12000 })
    expect(answer).not.toContain(AWS_CANARY.slice(0, 10))
    expect(answer).not.toContain(GITHUB_CANARY.slice(0, 10))
    expect(answer.split('\n').pop()).toBe('secret scan: 2 likely secrets redacted (kinds: github-token, aws-key)')
    expect(answer).toContain('redaction: 2 replacements')
    const plain = readResultText({ entry: ENTRY, facts: NO_FACTS, resultText: resultOf('Done. Nothing to hide.'), errText: '', maxChars: 12000 })
    expect(plain).not.toContain('secret scan')
  })

  test('worker_tail: each line masked, one scan line last', () => {
    const answer = workerTailText({ entry: ENTRY, facts: NO_FACTS, path: '/t.jsonl', ageSec: 3, lines: ['assistant: DB_PASSWORD=canary0pass', 'tool: ok', `assistant: url https://${URL_CREDENTIALS_CANARY_2}@h/r`], wanted: 40 })
    expect(answer).not.toContain('canary0pass')
    expect(answer).not.toContain('canary1pass')
    expect(answer.split('\n').pop()).toBe('secret scan: 2 likely secrets redacted (kinds: url-credentials, secret-assignment)')
  })

  test('turn_digest: the completions\' tallies add up in one last line, within the 40-line bound', () => {
    const events = [
      { at: NOW_MS - 1000, kind: 'completion' as const, text: 'a: clean', secrets: { count: 2, kinds: ['aws-key' as const] } },
      ...Array.from({ length: 60 }, (_, i) => ({ at: NOW_MS - 900 + i, kind: 'completion' as const, text: `w${i}: clean` })),
      { at: NOW_MS - 10, kind: 'completion' as const, text: 'b: clean', secrets: { count: 1, kinds: ['sk-key' as const] } },
    ]
    const text = digestText({ events, dropped: 0, nowMs: NOW_MS, loadedAt: NOW_MS - 5000, isNoticesOff: false, peers: [], counts: { alive: 0, finished: 2, queued: 0, running: 0, openPoints: 0, isRegistryRead: true } })
    const lines = text.split('\n')
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines.pop()).toBe('secret scan: 3 likely secrets redacted (kinds: sk-key, aws-key)')
    expect(lines.pop()).toStartWith('state: ')
  })
})

describe('secret-in-result: one notice per entry', () => {
  test('pure: told once per session id, kinds and count only; pruned when the entry leaves the registry; a stored state without it is as before', () => {
    const state = freshNoticeState()
    const tally = { count: 2, kinds: ['github-token', 'aws-key'] as SecretKind[] }
    const first = secretNotice(state, ENTRY, tally, 'result')
    expect(first.map(one => [one.kind, one.message, one.fields])).toEqual([
      [
        'secret-in-result',
        'worker "leaky worker" (session w-leaky-worker-261011090000): its result holds 2 likely secrets (kinds: github-token, aws-key), redacted in the tools\' answers; raise an open point naming where, never the value',
        { session_id: SID, count: 2 },
      ],
    ])
    expect(secretNotice(state, ENTRY, tally, 'transcript tail')).toEqual([])
    expect(secretNotice(state, ENTRY, { count: 0, kinds: [] }, 'result')).toEqual([])
    expect(parseNoticeState(JSON.parse(JSON.stringify(state))).secrets).toEqual([SID])
    pruneHarvested(state, [], undefined)
    expect(state.secrets).toBeUndefined()
    expect('secrets' in parseNoticeState(freshNoticeState())).toBe(false)
  })

  test('through the plugin: a harvest whose report holds canaries adds the scan line last to the completion note and one notice; read_result and worker_tail carry the line and tell nothing again', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    echoPrompt(on)
    seedOrch(world, { entries: [ENTRY] })
    world.files.set(`${RUNS}/leaky.json`, resultOf(LEAK))
    const row = { type: 'assistant', timestamp: new Date(NOW_MS - 60_000).toISOString(), message: { content: [{ type: 'text', text: 'export TOKEN=canary0token9 then ran it' }] } }
    world.files.set(`${HOME}/.claude/projects/-w-work/${SID}.jsonl`, `${JSON.stringify(row)}\n`)
    await startOrch($)
    expect(toastsOf(world.toasts, 'secret-in-result')).toEqual([
      `${TOAST_TITLES['secret-in-result']} · worker "leaky worker" (session w-leaky-worker-261011090000): its result holds 2 likely secrets (kinds: github-token, aws-key), redacted in the tools' answers; raise an open point naming where, never the value`,
    ])
    const sent = (await $.prompt.submit({ text: 'notification', wait: false, origin: { kind: 'task-notification' } } as never)) as { context?: readonly unknown[] }
    const note = String(sent.context?.[0])
    expect(note).toStartWith('session-control completions: leaky worker: clean: ')
    expect(note).toEndWith('leaky worker: secret scan: 2 likely secrets redacted (kinds: github-token, aws-key)')
    expect(note).not.toContain(AWS_CANARY.slice(0, 10))
    expect(noticeLines(sent).filter(line => line.includes('secret-in-result'))).toHaveLength(1)
    for (const text of world.toasts) expect(text).not.toContain(GITHUB_CANARY.slice(0, 10))
    const read = String(((await $.tool.call({ tool: 'mcp__session-control__read_result', session_id: SID } as never)) as { result?: unknown }).result)
    expect(read.split('\n').pop()).toBe('secret scan: 2 likely secrets redacted (kinds: github-token, aws-key)')
    const tail = String(((await $.tool.call({ tool: 'mcp__session-control__worker_tail', session_id: SID } as never)) as { result?: unknown }).result)
    expect(tail).not.toContain('canary0token9')
    expect(tail.split('\n').pop()).toBe('secret scan: 1 likely secret redacted (kinds: secret-assignment)')
    await poll(world, 10)
    expect(toastsOf(world.toasts, 'secret-in-result')).toHaveLength(1)
  })

  test('through the plugin: worker_tail alone tells the notice for its entry once; the notices option off tells none, and the line stays', { options: { ...OPTIONS, notices: 'off' } }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world, { entries: [{ ...ENTRY, pid: undefined, outcome: { kind: 'clean', summary: 'clean' }, reported: true }] })
    const row = { type: 'assistant', timestamp: new Date(NOW_MS - 60_000).toISOString(), message: { content: [{ type: 'text', text: `the key is ${AWS_CANARY}` }] } }
    world.files.set(`${HOME}/.claude/projects/-w-work/${SID}.jsonl`, `${JSON.stringify(row)}\n`)
    await startOrch($)
    const tail = String(((await $.tool.call({ tool: 'mcp__session-control__worker_tail', session_id: SID } as never)) as { result?: unknown }).result)
    expect(tail.split('\n').pop()).toBe('secret scan: 1 likely secret redacted (kinds: aws-key)')
    expect(toastsOf(world.toasts, 'secret-in-result')).toEqual([])
  })

  test('through the plugin, notices on: worker_tail alone tells the notice once for its entry', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    storeOf(on)
    seedOrch(world, { entries: [{ ...ENTRY, pid: undefined, outcome: { kind: 'clean', summary: 'clean' }, reported: true }] })
    const row = { type: 'assistant', timestamp: new Date(NOW_MS - 60_000).toISOString(), message: { content: [{ type: 'text', text: `the key is ${AWS_CANARY}` }] } }
    world.files.set(`${HOME}/.claude/projects/-w-work/${SID}.jsonl`, `${JSON.stringify(row)}\n`)
    await startOrch($)
    for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'mcp__session-control__worker_tail', session_id: SID } as never)
    expect(toastsOf(world.toasts, 'secret-in-result')).toEqual([
      `${TOAST_TITLES['secret-in-result']} · worker "leaky worker" (session w-leaky-worker-261011090000): its transcript tail holds 1 likely secret (kinds: aws-key), redacted in the tools' answers; raise an open point naming where, never the value`,
    ])
  })
})
