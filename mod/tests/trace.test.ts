import { describe, expect, test } from 'claude-code/testing'

import { APPEND_SCRIPT, NEWER_SCRIPT, PROBE_SCRIPT, REMOVE_REGULAR_SCRIPT, ROTATE_SCRIPT } from '../hooks/host-posix'
import { FILES_PS1, NEWER_PS1 } from '../hooks/host-windows'
import {
  REDACTED,
  TRACE_CHUNK_BYTES,
  TRACE_KEEP,
  TRACE_MAX_BYTES,
  TRACE_MAX_MESSAGE,
  TRACE_MAX_STRING,
  chunkLines,
  isTraceSwitch,
  localIso,
  messageFields,
  messageKind,
  needsRotation,
  redact,
  redactValue,
  rotationMoves,
  shownArgv,
  shownPicker,
  traceLine,
  traceMessage,
  utf8Bytes,
} from '../hooks/trace'

import { NOW_MS } from './fixtures'

describe('redaction', () => {
  test('anything that looks like a token is replaced', () => {
    expect(redact('Authorization: Bearer abc.DEF-ghi_123')).toBe(`Authorization: ${REDACTED}`)
    expect(redact('key sk-ant-api03-AbCdEf1234567890xyz in it')).toBe(`key ${REDACTED} in it`)
    expect(redact(`push with ghp_${'A1b2C3d4'.repeat(4)}abcd`)).toBe(`push with ${REDACTED}`)
    expect(redact(`github_pat_${'11ABCDEFG0'.repeat(3)}`)).toBe(REDACTED)
    expect(redact('xoxb-1234567890-abcdefghij')).toBe(REDACTED)
    expect(redact(`sha ${'0123456789abcdef'.repeat(3)} end`)).toBe(`sha ${REDACTED} end`)
    expect(redact('blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9xYzE2NDQ1Njc4OTA= end')).toBe(`blob ${REDACTED} end`)
    expect(redact('a=1&password=hunter2&b=2')).toBe(`a=1&password=${REDACTED}&b=2`)
    expect(redact('API_KEY: abc123')).toBe(`API_KEY: ${REDACTED}`)
  })

  describe('git ids', () => {
    const TIP = '7ebdad1d0e3a5e562fe4070f84c13ef087fd005c'
    const BASE = '75bce63b2d3a4ab1c5e7f0b1d9c8a6e4f2b0d3c1'
    const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const CANARY = '3f2a9c1b7d4e8a6f0b5c2d9e1a7f4b3c8d6e0a2f'

    test('a 40 or 64 digit id in an evident git context stays: a ref, commit, HEAD, a range, git ls-remote, git log, git rev-parse, sha, the start of a log row', () => {
      for (const line of [
        `origin ${TIP} refs/heads/main`,
        `${TIP}\trefs/heads/feature/write-tools`,
        `refs/heads/main is at ${TIP}`,
        `commit ${TIP}`,
        `the commit ${TIP} was pushed`,
        `HEAD is now ${TIP}`,
        `${BASE}..${TIP}`,
        `${BASE}...${TIP}`,
        `range ${BASE}..${TIP} of the branch`,
        `$ git ls-remote origin ${TIP}`,
        `git log -1 ${TIP}`,
        `git rev-parse ${TIP}`,
        `the sha of the tip is ${TIP}`,
        `SHA ${TIP}`,
        `shas ${TIP} ${BASE}`,
        `sha256 ${SHA256}`,
        `object (sha1 ${TIP}) in the pack`,
        `${TIP} fix(mod): show a session name`,
        `  ${TIP} feat(mod): close_worker`,
        `${SHA256} a 64 digit log row`,
      ]) {
        expect(redact(line)).toBe(line)
      }
      // Each line of a text decides for itself; the id of a log row only, not the id further on.
      const report = `git ls-remote origin\n${TIP}\trefs/heads/main\n${BASE} docs(readme): x\n${CANARY}\nok`
      expect(redact(report)).toBe(report.replace(CANARY, REDACTED))
      expect(redact(`${TIP} fix: see also ${CANARY}`)).toBe(`${TIP} fix: see also ${REDACTED}`)
      // Another secret on the line goes, the id stays.
      expect(redact(`git ls-remote https://user:pa55@example.com/org/repo.git ${TIP} refs/heads/x`)).toBe(`git ls-remote https://${REDACTED}@example.com/org/repo.git ${TIP} refs/heads/x`)
      expect(redact(`commit ${TIP} and commit ${BASE}`)).toBe(`commit ${TIP} and commit ${BASE}`)
    })

    test('a long hex string with no git context, one next to a secret word or an = or : assignment, and one that is no 40 or 64 digit id stay redacted', () => {
      for (const [line, want] of [
        [CANARY, REDACTED],
        [`the value is ${CANARY} here`, `the value is ${REDACTED} here`],
        [`${CANARY}\n${CANARY}`, `${REDACTED}\n${REDACTED}`],
        [`${SHA256}`, REDACTED],
        // The id is the first word of a line that is no log row (nothing after it).
        [`${TIP} `, `${REDACTED} `],
        // A git line, but the id sits after a secret word or an assignment.
        [`refs/heads/main token ${CANARY}`, `refs/heads/main token ${REDACTED}`],
        [`HEAD secret ${CANARY}`, `HEAD secret ${REDACTED}`],
        [`commit key=${CANARY}`, `commit key=${REDACTED}`],
        [`git log password: ${CANARY}`, `git log password: ${REDACTED}`],
        [`sha=${CANARY}`, `sha=${REDACTED}`],
        [`sha: ${CANARY}`, `sha: ${REDACTED}`],
        [`refs/heads/main x=${CANARY}`, `refs/heads/main x=${REDACTED}`],
        [`refs/heads/main "id": "${CANARY}"`, `refs/heads/main "id": "${REDACTED}"`],
        [`API_KEY=${CANARY} refs/heads/main`, `API_KEY=${REDACTED} refs/heads/main`],
        [`Authorization: Bearer ${CANARY} refs/heads/main`, `Authorization: ${REDACTED} refs/heads/main`],
        // Not a 40 or 64 digit id: 32 to 39, 41 to 63, 65 and more, upper case, longer runs of letters and digits.
        [`refs/heads/main ${CANARY.slice(0, 32)}`, `refs/heads/main ${REDACTED}`],
        [`refs/heads/main ${CANARY.slice(0, 39)}`, `refs/heads/main ${REDACTED}`],
        [`refs/heads/main ${CANARY}a`, `refs/heads/main ${REDACTED}`],
        [`refs/heads/main ${SHA256}0`, `refs/heads/main ${REDACTED}`],
        [`refs/heads/main ${SHA256}${SHA256}`, `refs/heads/main ${REDACTED}`],
        [`commit ${CANARY.toUpperCase()}`, `commit ${REDACTED}`],
        [`commit ghp${CANARY}`, `commit ${REDACTED}`],
        [`commit ${CANARY}xyz`, `commit ${REDACTED}`],
        [`commit ${'a1b2c3d4e5f60718'.repeat(2)}ZZ${CANARY.slice(0, 8)}`, `commit ${REDACTED}`],
      ] as const) {
        expect(redact(line)).toBe(want)
      }
    })

    test('the placeholder characters in a text switch the shielding off for it: every long hex string goes', () => {
      expect(redact(`refs/heads/main ${CANARY} \uE0000\uE001`)).toBe(`refs/heads/main ${REDACTED} \uE0000\uE001`)
    })

    test('the trace uses the same function: an id on a git line (an argument with its ref too) stays, an id alone or beside a secret word goes, each string of a value on its own', () => {
      expect(traceLine(1, NOW_MS, 'x', { out: `origin ${TIP} refs/heads/main`, bare: TIP, secret: `token ${CANARY}`, argv: ['git', 'push', 'origin', `${TIP}:refs/heads/x`] })).toBe(
        JSON.stringify({ ts: localIso(NOW_MS), seq: 1, event: 'x', out: `origin ${TIP} refs/heads/main`, bare: REDACTED, secret: `token ${REDACTED}`, argv: ['git', 'push', 'origin', `${TIP}:refs/heads/x`] }),
      )
    })
  })

  test('NAME=value and NAME: value whose name says secret, in any case, underscores and hyphens separating words', () => {
    expect(redact('ANTHROPIC_API_KEY=abc')).toBe(`ANTHROPIC_API_KEY=${REDACTED}`)
    expect(redact('env GITHUB_TOKEN=x1 MY_SECRET_VALUE=y db_password=z PASSWD=w')).toBe(
      `env GITHUB_TOKEN=${REDACTED} MY_SECRET_VALUE=${REDACTED} db_password=${REDACTED} PASSWD=${REDACTED}`,
    )
    expect(redact('proxy-auth=u:p and aws_credentials: q')).toBe(`proxy-auth=${REDACTED} and aws_credentials: ${REDACTED}`)
    expect(redact('{"client_secret": "s3"}')).toBe(`{"client_secret": "${REDACTED}"}`)
    expect(redact('https://h/cb?access_token=t0&state=1')).toBe(`https://h/cb?access_token=${REDACTED}&state=1`)
  })

  test('--flag value and --flag=value whose flag says secret, in one string or as two arguments of an argv', () => {
    expect(redact('tool --api-key abc --verbose')).toBe(`tool --api-key ${REDACTED} --verbose`)
    expect(redact('tool --Password=hunter2')).toBe(`tool --Password=${REDACTED}`)
    expect(redact('login -auth-token xyz')).toBe(`login -auth-token ${REDACTED}`)
    expect(redactValue(['tool', '--client-secret', 'plain', '--Token', 'v', '--model', 'haiku'])).toEqual(['tool', '--client-secret', REDACTED, '--Token', REDACTED, '--model', 'haiku'])
  })

  test('Authorization: Basic, Bearer or Token with anything after it', () => {
    expect(redact('Authorization: Basic dXNlcjpwYXNz')).toBe(`Authorization: ${REDACTED}`)
    expect(redact('authorization: token a.b/c!d')).toBe(`authorization: ${REDACTED}`)
    // Anything: up to the next space, a closing quote included.
    expect(redact('-H "Authorization: Bearer x" -s')).toBe(`-H "Authorization: ${REDACTED} -s`)
  })

  test('URL userinfo', () => {
    expect(redact('git clone https://user:pa55@example.com/org/repo.git')).toBe(`git clone https://${REDACTED}@example.com/org/repo.git`)
    expect(redact('ssh://deploy@host:22/x')).toBe(`ssh://${REDACTED}@host:22/x`)
  })

  test("curl's credential flag: -u user:pass, --user user:pass and --user=user:pass, quoted or not, in one string or as two arguments", () => {
    expect(redact('curl -u alice:s3cretPW https://example.com/api')).toBe(`curl -u ${REDACTED} https://example.com/api`)
    expect(redact('curl --user alice:pw -s https://x')).toBe(`curl --user ${REDACTED} -s https://x`)
    expect(redact('curl --user=alice:pw https://x')).toBe(`curl --user=${REDACTED} https://x`)
    expect(redact(`curl -u 'alice:p@ss' x`)).toBe(`curl -u '${REDACTED}' x`)
    expect(redact('curl -u "alice:pw" x')).toBe(`curl -u "${REDACTED}" x`)
    expect(redact('-u alice:pw')).toBe(`-u ${REDACTED}`)
    expect(redact('curl -u alice:pw:with:colons x')).toBe(`curl -u ${REDACTED} x`)
    expect(redactValue(['curl', '-u', 'alice:pw', '--user', 'bob:x', 'https://x'])).toEqual(['curl', '-u', REDACTED, '--user', REDACTED, 'https://x'])
  })

  test("curl's credential flag with a quoted password that holds blanks: -u 'alice:s3cret pw', in any quote, in one string or as an argument", () => {
    expect(redact(`curl -u 'alice:s3cret pw' https://example.com/api`)).toBe(`curl -u '${REDACTED}' https://example.com/api`)
    expect(redact('curl -u "alice:s3cret pw" x')).toBe(`curl -u "${REDACTED}" x`)
    expect(redact(`curl --user 'alice:s3cret pw' -s x`)).toBe(`curl --user '${REDACTED}' -s x`)
    expect(redact(`curl --user='alice:s3cret pw' x`)).toBe(`curl --user='${REDACTED}' x`)
    expect(redact(`curl -u 'alice:a very secret pass phrase' -H 'Accept: json' x`)).toBe(`curl -u '${REDACTED}' -H 'Accept: json' x`)
    expect(redact(`curl -u "alice:it's secret" x`)).toBe(`curl -u "${REDACTED}" x`)
    expect(redact(`-u 'alice:s3cret pw'`)).toBe(`-u '${REDACTED}'`)
    expect(redact(`curl -u 'alice:s3cret pw' -u 'bob:other pw' x`)).toBe(`curl -u '${REDACTED}' -u '${REDACTED}' x`)
    expect(redactValue(['curl', '-u', 'alice:s3cret pw', 'https://x'])).toEqual(['curl', '-u', REDACTED, 'https://x'])
    expect(redactValue(['curl', '--user', 'alice:a b c', '-s'])).toEqual(['curl', '--user', REDACTED, '-s'])
    // The exceptions of the unquoted form hold for the quoted one: numeric on both sides, a path or a URL as the second part, no password.
    for (const kept of [`docker run -u '1000:1000' image`, `diff -u 'C:/a b' x`, `ssh -u 'x http://host:8080/path' y`, `curl -u 'alice: ' x`, `sort -u 'a b' names.txt`]) {
      expect(redact(kept)).toBe(kept)
    }
    expect(redactValue(['docker', 'run', '-u', '1000:1000', 'image'])).toEqual(['docker', 'run', '-u', '1000:1000', 'image'])
  })

  test('known over-redaction: a -u or --user value of the form name:name goes, whatever the command (www-data, sort, echo, docker, git push)', () => {
    expect(redact('docker run --user www-data:www-data image')).toBe(`docker run --user ${REDACTED} image`)
    expect(redact('sort -u a:b')).toBe(`sort -u ${REDACTED}`)
    expect(redact('echo -u foo:bar')).toBe(`echo -u ${REDACTED}`)
    expect(redact('docker run -u root:root image')).toBe(`docker run -u ${REDACTED} image`)
    expect(redact('git push -u origin:main')).toBe(`git push -u ${REDACTED}`)
  })

  test('ordinary command lines with -u or --user stay as they are', () => {
    const kept = [
      'git push -u origin feature/write-tools',
      'git push -u linksmt feature/write-tools',
      'sort -u names.txt',
      'git log -u HEAD~1',
      'ps -u root',
      'useradd --user bob',
      'diff -u C:/a/old.txt C:/a/new.txt',
      'diff -u /tmp/a.txt /tmp/b.txt',
      'docker run -u 1000:1000 image',
      'docker run --user 0:0 image',
      // curl prompts for the password: there is none on the line.
      'curl -u alice: https://x',
      'ssh -u x http://host:8080/path',
      'the -u flag of curl takes user:password',
      'meet at 12:30',
      'timestamps 2026-10-11T12:00:00Z and a ratio 3:4',
    ]
    for (const text of kept) expect(redact(text)).toBe(text)
    expect(redactValue(['git', 'push', '-u', 'origin', 'main', 'docker', '-u', '1000:1000'])).toEqual(['git', 'push', '-u', 'origin', 'main', 'docker', '-u', '1000:1000'])
  })

  test('AWS access key ids', () => {
    expect(redact('id AKIAABCDEFGHIJKLMNOP end')).toBe(`id ${REDACTED} end`)
    expect(redact('ASIA1234567890ABCDEF')).toBe(REDACTED)
  })

  test('a run of 32 or more letters, digits, - _ / + = with a letter and a digit, outside a plain path', () => {
    const token = 'abcdefghij0123456789klmnopqrstuv'
    expect(token.length).toBe(32)
    expect(redact(`t ${token} e`)).toBe(`t ${REDACTED} e`)
    expect(redact('see abc_def-ghi/jkl+mno=pqr1stuvwxyz0123 here')).toBe(`see ${REDACTED} here`)
    // A path with a token in a segment is no plain path: the run it is part of goes, slashes and all.
    expect(redact(`/home/u/${token}/x`)).toBe(REDACTED)
    expect(redact(`/${token}`)).toBe(REDACTED)
    expect(redact('/srv/cache/tok-ABCDEFGHIJ0123456789xy/data.json')).toBe(`${REDACTED}.json`)
  })

  test('ids, paths, names and times stay as they are', () => {
    const kept = [
      'abcdabcd-0000-4000-8000-000000000001',
      't:aaaaaaaa-1111-4111-8111-111111111111|/fixture/lic/a',
      '/home/someone/.claude/session-control/runs/20261010120000-a-long-worker-title-for-the-smoke-test.json',
      'C:/Users/Someone/.claude/session-control/runs/trace.log',
      'task-queue.json',
      'session-probe',
      'claude -p --model haiku --dangerously-skip-permissions --output-format json',
      '2026-10-10T12:34:56.789+02:00',
      'the prompt lacks: foreground wait (never end the turn on a background watcher)',
      // UUID session ids, alone or in paths, and plain absolute paths with long slugs, Linux and Windows.
      'session ABCDABCD-0000-4000-8000-000000000001',
      '/home/u/.claude/projects/-home-u-workspaces-session-control/abcdabcd-0000-4000-8000-000000000001.jsonl',
      't:abcdabcd-0000-4000-8000-000000000001|/home/u/.claude/projects/-home-u-workspaces-some-long-project-name-2026',
      '/tmp/session-control-e2e.Ab12Cd/work-dir/20261010120000-e2e-smoke-worker.err',
      'C:\\Users\\Someone\\AppData\\Local\\session-control\\runs\\20261010120000-a-long-worker-title.json',
      '~/.claude/session-control/runs/20261010120000-windows-support-for-the-panel.json',
      'model claude-opus-5-5 at effort high, timeout 180 minutes',
      '--dangerously-skip-permissions --output-format json --max-budget-usd 0.25',
    ]
    for (const text of kept) expect(redact(text)).toBe(text)
  })

  test('every string of a value is redacted and long ones are cut; keys and numbers stay', () => {
    expect(redactValue({ argv: ['curl', '-H', 'Bearer t0k3n'], exitCode: 3, nested: { sk: 'sk-12345678abc' }, isOk: true, none: null })).toEqual({
      argv: ['curl', '-H', REDACTED],
      exitCode: 3,
      nested: { sk: REDACTED },
      isOk: true,
      none: null,
    })
    const long = redactValue('x '.repeat(TRACE_MAX_STRING)) as string
    expect(long.startsWith('x x ')).toBe(true)
    expect(long.endsWith(`...[+${2 * TRACE_MAX_STRING - TRACE_MAX_STRING} chars]`)).toBe(true)
  })
})

describe('messages', () => {
  test('a JSON parse error: its kind, and the fragments it quotes from the file become \u2026', () => {
    const v8 = 'registry is not JSON: SyntaxError: Unexpected token \'s\', "secret note" is not valid JSON'
    expect(messageFields(v8)).toEqual({ kind: 'json-parse', message: 'registry is not JSON: SyntaxError: Unexpected token \u2026, \u2026 is not valid JSON' })
    const bun = 'registry is not JSON: SyntaxError: JSON Parse error: Unexpected identifier "hunter"'
    expect(traceMessage(bun)).toBe('registry is not JSON: SyntaxError: JSON Parse error: Unexpected identifier \u2026')
    expect(messageKind('open-points.json: the file does not parse')).toBe('json-parse')
  })

  test('the picker\'s output and a command\'s stderr echoed in a message become \u2026', () => {
    expect(messageFields('no licence has room: main 95% used, resets 14:00', 'reason')).toEqual({ kind: 'picker-exit-3', reason: 'no licence has room: \u2026' })
    expect(messageFields('the licence picker gave nothing usable (exit 2)')).toEqual({ kind: 'picker-exit-2', message: 'the licence picker gave nothing usable (exit 2)' })
    expect(messageFields('the licence picker answered an unexpected value: relative/dir')).toEqual({ kind: 'picker-value', message: 'the licence picker answered an unexpected value: \u2026' })
    expect(messageFields('rename failed (exit 1): mv: cannot move a to b')).toEqual({ kind: 'exit-1', message: 'rename failed (exit 1): \u2026' })
    expect(traceMessage('refused: the picker command must start with an absolute path, not "pick --key k"')).toBe('refused: the picker command must start with an absolute path, not \u2026')
    expect(traceMessage("ENOENT: no such file or directory, open '/x/y'")).toBe('ENOENT: no such file or directory, open \u2026')
  })

  test('the mod\'s own words stay, apostrophes included, cut at 120 characters', () => {
    expect(messageFields('refused: cwd is the orchestrator dir')).toEqual({ message: 'refused: cwd is the orchestrator dir' })
    expect(traceMessage("the session's file can't be read")).toBe("the session's file can't be read")
    expect(traceMessage('x'.repeat(300))).toBe('x'.repeat(TRACE_MAX_MESSAGE))
    expect(traceMessage('y'.repeat(300), 200)).toHaveLength(200)
  })

  test('the picker shows as its executable\'s name and the number of its arguments', () => {
    expect(shownPicker(['/home/u/bin/pick', '--need', '40'])).toEqual({ picker: 'pick', args: 2 })
    expect(shownPicker(['C:\\tools\\pick.exe'])).toEqual({ picker: 'pick.exe', args: 0 })
  })
})

describe('trace lines', () => {
  test('a line is the local time, the sequence number, the event, then the fields, redacted', () => {
    expect(traceLine(7, NOW_MS, 'process.run', { argv: ['x', 'Bearer abc'], exitCode: 0 })).toBe(
      `{"ts":"${localIso(NOW_MS)}","seq":7,"event":"process.run","argv":["x","${REDACTED}"],"exitCode":0}`,
    )
    // The fields cannot stand in for the time, the number or the event.
    expect(JSON.parse(traceLine(1, NOW_MS, 'poll.tick', { ts: 'x', seq: 99, event: 'y' }))).toEqual({ ts: localIso(NOW_MS), seq: 1, event: 'poll.tick' })
  })

  test('the time is local ISO 8601 with milliseconds and the offset, and reads back as the same instant', () => {
    for (const ms of [NOW_MS, NOW_MS + 123, Date.UTC(2026, 0, 1, 0, 0, 0, 5), Date.UTC(2026, 6, 15, 23, 59, 59, 999)]) {
      const iso = localIso(ms)
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
      expect(Date.parse(iso)).toBe(ms)
    }
  })

  test('SESSION_CONTROL_DEBUG switches the trace on with 1 (or true, yes, on)', () => {
    for (const value of ['1', 'true', 'TRUE', ' on ', 'yes']) expect(isTraceSwitch(value)).toBe(true)
    for (const value of [undefined, '', '0', 'false', 'no', '2']) expect(isTraceSwitch(value)).toBe(false)
  })

  test('a command line shows the mod\'s scripts by name and an append\'s text as its byte count', () => {
    expect(shownArgv(['sh', '-c', PROBE_SCRIPT, 'session-probe', 'pid:1|/c'])).toEqual(['sh', '-c', '<PROBE_SCRIPT>', 'session-probe', 'pid:1|/c'])
    expect(shownArgv(['sh', '-c', APPEND_SCRIPT, 'session-log', '{"a":"\u00e9"}', '/r/cleared.jsonl'])).toEqual(['sh', '-c', '<APPEND_SCRIPT>', 'session-log', '<11 bytes>', '/r/cleared.jsonl'])
    expect(shownArgv(['sh', '-c', ROTATE_SCRIPT, 'session-trace', '/r/trace.log', '2'])).toEqual(['sh', '-c', '<ROTATE_SCRIPT>', 'session-trace', '/r/trace.log', '2'])
    expect(shownArgv(['sh', '-c', REMOVE_REGULAR_SCRIPT, 'session-remove', '/r/a.json'])).toEqual(['sh', '-c', '<REMOVE_REGULAR_SCRIPT>', 'session-remove', '/r/a.json'])
    expect(shownArgv(['powershell.exe', '-File', 'C:/r/files.ps1', 'append', 'C:/r/a', 'C:/r/b'])).toEqual(['powershell.exe', '-File', 'C:/r/files.ps1', 'append', 'C:/r/a', 'C:/r/b'])
    expect(shownArgv([FILES_PS1])).toEqual(['<FILES_PS1>'])
    expect(shownArgv(['test', '-s', '/work/new/prompt.md'])).toEqual(['test', '-s', '/work/new/prompt.md'])
  })

  test('the listing of the files written after a time shows by name, its directory and arguments as they are', () => {
    expect(shownArgv(['sh', '-c', NEWER_SCRIPT, 'session-newer', '/work/a', '1790000000', '200'])).toEqual(['sh', '-c', '<NEWER_SCRIPT>', 'session-newer', '/work/a', '1790000000', '200'])
    expect(shownArgv([NEWER_PS1])).toEqual(['<NEWER_PS1>'])
  })

  test('UTF-8 byte counts', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('\u00e9')).toBe(2)
    expect(utf8Bytes('\u20ac')).toBe(3)
    expect(utf8Bytes('\u{1F600}')).toBe(4)
    expect(utf8Bytes('')).toBe(0)
  })
})

describe('rotation', () => {
  test('the trace rotates before an append would take it past 2 MiB, never when empty', () => {
    expect(TRACE_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(needsRotation(0, 3 * TRACE_MAX_BYTES)).toBe(false)
    expect(needsRotation(TRACE_MAX_BYTES - 10, 10)).toBe(false)
    expect(needsRotation(TRACE_MAX_BYTES - 10, 11)).toBe(true)
    expect(needsRotation(TRACE_MAX_BYTES + 1, 1)).toBe(true)
    expect(needsRotation(100, 100)).toBe(false)
    expect(needsRotation(60, 50, 100)).toBe(true)
  })

  test('three files are kept: the oldest is overwritten, then the trace becomes .1', () => {
    expect(TRACE_KEEP).toBe(3)
    expect(rotationMoves('/r/trace.log')).toEqual([
      ['/r/trace.log.1', '/r/trace.log.2'],
      ['/r/trace.log', '/r/trace.log.1'],
    ])
    expect(rotationMoves('/r/trace.log', 2)).toEqual([['/r/trace.log', '/r/trace.log.1']])
    expect(rotationMoves('/r/trace.log', 1)).toEqual([])
  })

  test('appended in steps, no file passes the limit and at most three files exist', () => {
    const max = 100
    let files: number[] = [0]
    const sizes: number[][] = []
    for (let step = 0; step < 20; step++) {
      const adding = 30
      if (needsRotation(files[0] ?? 0, adding, max)) files = [0, ...files].slice(0, TRACE_KEEP)
      files[0] = (files[0] ?? 0) + adding
      sizes.push([...files])
    }
    expect(sizes.every(set => set.length <= TRACE_KEEP && set.every(size => size <= max))).toBe(true)
    expect(sizes.at(-1)).toEqual([60, 90, 90])
    expect(sizes.slice(0, 5)).toEqual([[30], [60], [90], [30, 90], [60, 90]])
  })

  test('lines go in batches of at most 64 KiB; a longer line goes alone', () => {
    expect(TRACE_CHUNK_BYTES).toBe(64 * 1024)
    const ten = 'x'.repeat(9)
    expect(chunkLines([ten, ten, ten, ten, ten], 25)).toEqual([[ten, ten], [ten, ten], [ten]])
    const big = 'y'.repeat(40)
    expect(chunkLines([ten, big, ten], 25)).toEqual([[ten], [big], [ten]])
    expect(chunkLines([])).toEqual([])
  })
})
