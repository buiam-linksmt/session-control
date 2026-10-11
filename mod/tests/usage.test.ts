// The usage probe of probe_licence_usage below the tools: the parser (hooks/usage.ts) over the recorded and the written
// outputs of tests/usage-fixtures.ts, the native probe of both adapters through a recording port (what runs, in which
// directory, with which environment, and what a failure comes to), and the Node helper's route (host-helper.ts): the
// probe's own codes are the answer, a failure of the helper itself falls back to the native probe. The helper process
// itself is tested by helper.test.mjs, which also requires its parser to answer every case as this one does.

import { describe, expect, test } from 'claude-code/testing'
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { HostPort } from '../hooks/host'
import { USAGE_CALL_TIMEOUT_MS, usageOfCall, withHelper } from '../hooks/host-helper'
import type { HelperNote } from '../hooks/host-helper'
import { posixHost } from '../hooks/host-posix'
import { windowsHost } from '../hooks/host-windows'
import { USAGE_ARGS, USAGE_CODES, USAGE_TIMEOUT_MS, isUsageCode, parseUsage, usageAnswer } from '../hooks/usage'
import { USAGE_CASES, USAGE_FIXTURES } from './usage-fixtures'

const ran = (stdout = '', exitCode = 0, stderr = ''): ProcessRunResult => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })

type Run = { argv: string[]; init?: ProcessRunInit; isQuiet?: boolean; shown?: Record<string, unknown> }

/** A port that records each run and answers it with `answer` (a throw stands for a run that rejects). */
function recordingPort(answer: (argv: readonly string[], init?: ProcessRunInit) => ProcessRunResult, env: Record<string, string> = {}) {
  const runs: Run[] = []
  const notes: HelperNote[] = []
  const port: HostPort = {
    run: async (argv, init, isQuiet, shown) => {
      runs.push({ argv: [...argv], ...(init === undefined ? {} : { init }), ...(isQuiet === undefined ? {} : { isQuiet }), ...(shown === undefined ? {} : { shown }) })
      return answer(argv, init)
    },
    read: async () => {
      throw new Error('ENOENT')
    },
    write: async () => undefined,
    exists: async () => false,
    stat: async () => {
      throw new Error('ENOENT')
    },
    list: async () => [],
    now: async () => 1_700_000_000_000,
    sleep: async () => undefined,
    env: async name => env[name],
    runsDir: async () => '/m/runs',
    traceError: () => undefined,
    noteDirectWrite: () => undefined,
    noteHelper: note => notes.push(note),
  }
  return { port, runs, notes }
}

describe('the usage parser', () => {
  for (const one of USAGE_CASES) {
    test(`parses: ${one.name}`, () => {
      expect(parseUsage(one.stdout, one.stderr ?? '', one.exitCode ?? 0)).toEqual(one.expect)
    })
  }

  test('an answer holds the two windows and nothing else of the text', () => {
    const answer = JSON.stringify(parseUsage(USAGE_FIXTURES.recordedMain ?? ''))
    for (const word of ['subscription', 'Fable', 'contributing', 'requests', 'sessions', 'context', 'plugin-authoring', 'playwright']) expect(answer.includes(word)).toBe(false)
    expect(Object.keys(JSON.parse(answer) as object).sort()).toEqual(['five', 'ok', 'seven'])
  })

  test('the fixed codes, and what counts as one', () => {
    expect([...USAGE_CODES]).toEqual(['NO_CLAUDE', 'TIMEOUT', 'NOT_LOGGED_IN', 'PARSE', 'FAILED'])
    for (const code of USAGE_CODES) expect(isUsageCode(code)).toBe(true)
    for (const code of ['SPAWN', 'BAD_JSON', 'INTERNAL', 'BAD_REQUEST', 'timeout', '']) expect(isUsageCode(code)).toBe(false)
  })

  test("a helper answer is taken only in its exact shape: whole percents, plain resets, at least one window", () => {
    const five = { percent: 12, resets: 'Oct 11, 11:20am (Europe/Budapest)' }
    expect(usageAnswer({ five, seven: null })).toEqual({ ok: true, five, seven: null })
    expect(usageAnswer({ five: null, seven: null })).toBeUndefined()
    expect(usageAnswer({ five: { percent: 1.5, resets: '' }, seven: null })).toBeUndefined()
    expect(usageAnswer({ five: { percent: -1, resets: '' }, seven: null })).toBeUndefined()
    expect(usageAnswer({ five: { percent: 3, resets: ['mail me', 'x.invalid'].join('@') }, seven: null })).toBeUndefined()
    expect(usageAnswer({ five: { percent: 3, resets: 'x'.repeat(65) }, seven: null })).toBeUndefined()
    expect(usageAnswer({ five: { percent: 3 }, seven: null })).toBeUndefined()
    expect(usageAnswer({ five })).toBeUndefined()
  })
})

describe('the native probe', () => {
  test('Linux: claude from the PATH with the three arguments, in /, stdin closed, CLAUDE_CONFIG_DIR over the environment, 15 s', async () => {
    const { port, runs } = recordingPort(() => ran(USAGE_FIXTURES.recordedSecondary ?? ''))
    const got = await posixHost.probeUsage(port, '/home/u/.claude/second', false)
    expect(got).toEqual({ ok: true, five: { percent: 42, resets: 'Oct 11, 11:30am (Europe/Budapest)' }, seven: { percent: 5, resets: 'Oct 18, 6am (Europe/Budapest)' } })
    expect(runs).toEqual([
      {
        argv: ['claude', '-p', '/usage', '--no-session-persistence'],
        init: { stdin: '', timeoutMs: USAGE_TIMEOUT_MS, cwd: '/', env: { CLAUDE_CONFIG_DIR: '/home/u/.claude/second' } },
        isQuiet: false,
        shown: { usage: 'probe', configDir: '/home/u/.claude/second', isInherited: false },
      },
    ])
    expect([...USAGE_ARGS]).toEqual(['-p', '/usage', '--no-session-persistence'])
    // The trace's fields name the run; the text is in none of them.
    expect(JSON.stringify(runs[0]?.shown)).not.toContain('used')
  })

  test('the default directory a launch inherits: no CLAUDE_CONFIG_DIR is set', async () => {
    const { port, runs } = recordingPort(() => ran(USAGE_FIXTURES.recordedMain ?? ''))
    expect((await posixHost.probeUsage(port, '/home/u/.claude', true)).ok).toBe(true)
    expect(runs[0]?.init).toEqual({ stdin: '', timeoutMs: USAGE_TIMEOUT_MS, cwd: '/' })
  })

  test('a run that cannot start is NO_CLAUDE, one still running at the timeout is TIMEOUT; a login prompt, an error and nothing are their codes', async () => {
    const answers: [() => ProcessRunResult, string][] = [
      [
        () => {
          throw new Error('spawn claude ENOENT')
        },
        'NO_CLAUDE',
      ],
      [
        () => {
          throw new Error('the command timed out after 15000 ms')
        },
        'TIMEOUT',
      ],
      [() => ran('Not logged in · Please run /login\n', 1), 'NOT_LOGGED_IN'],
      [() => ran('', 1, 'Invalid API key · Please run /login'), 'NOT_LOGGED_IN'],
      [() => ran('API Error: 500\n', 1), 'FAILED'],
      [() => ran(''), 'PARSE'],
    ]
    for (const [answer, code] of answers) {
      const { port } = recordingPort(answer)
      expect(await posixHost.probeUsage(port, '/home/u/.claude', false)).toEqual({ ok: false, code })
    }
  })

  test('Windows: claude.exe, in the root of the home folder\'s drive, the directory in the native form', async () => {
    const { port, runs } = recordingPort(() => ran((USAGE_FIXTURES.recordedMain ?? '').replace(/\n/g, '\r\n')), { USERPROFILE: 'C:\\Users\\u' })
    const got = await windowsHost.probeUsage(port, 'C:\\Users\\u\\.claude\\second', false)
    expect(got.ok).toBe(true)
    expect(runs[0]?.argv).toEqual(['claude.exe', '-p', '/usage', '--no-session-persistence'])
    expect(runs[0]?.init).toEqual({ stdin: '', timeoutMs: USAGE_TIMEOUT_MS, cwd: 'C:/', env: { CLAUDE_CONFIG_DIR: 'C:/Users/u/.claude/second' } })
  })

  test('Windows with no home folder: the session\'s own directory, nothing else changed', async () => {
    const { port, runs } = recordingPort(() => ran(USAGE_FIXTURES.recordedMain ?? ''))
    await windowsHost.probeUsage(port, 'C:/Users/u/.claude', true)
    expect(runs[0]?.init).toEqual({ stdin: '', timeoutMs: USAGE_TIMEOUT_MS })
  })
})

describe('the helper route', () => {
  const NODE = '/m/node'
  const SCRIPT = '/m/mod/helper/host.mjs'
  const setup = { node: NODE, script: SCRIPT }

  /** A machine where node answers `helper` for probeUsage, and claude (the native probe) answers `native`. */
  function machine(helper: (request: Record<string, unknown>) => ProcessRunResult, native: () => ProcessRunResult = () => ran(USAGE_FIXTURES.recordedMain ?? ''), hasNode = true) {
    return recordingPort((argv, init) => {
      if (argv[0] === NODE && argv[1] === '--version') {
        if (!hasNode) throw new Error('spawn node ENOENT')
        return ran('v24.14.0\n')
      }
      if (argv[0] === NODE && argv[1] === SCRIPT && argv[2] === 'probeUsage') return helper(JSON.parse(init?.stdin ?? '{}') as Record<string, unknown>)
      if (argv[0] === 'claude' || argv[0] === 'claude.exe') return native()
      throw new Error(`unexpected ${argv.join(' ')}`)
    })
  }
  const windows = { ok: true, five: { percent: 12, resets: 'Oct 11, 11:20am (Europe/Budapest)' }, seven: { percent: 41, resets: 'Oct 16, 1pm (Europe/Budapest)' } }

  test('the helper answers: one node process with the directory, no claude run by the mod itself, no note', async () => {
    const sim = machine(() => ran(JSON.stringify(windows)))
    const host = withHelper(posixHost, setup)
    expect(await host.probeUsage(sim.port, '/home/u/.claude/second', false)).toEqual(windows)
    const calls = sim.runs.filter(one => one.argv[1] === SCRIPT)
    expect(calls.map(one => [one.argv[2], one.init?.stdin, one.init?.timeoutMs, one.shown])).toEqual([['probeUsage', '{"configDir":"/home/u/.claude/second"}', USAGE_CALL_TIMEOUT_MS, { helper: 'probeUsage', configDir: '/home/u/.claude/second', isInherited: false }]])
    expect(sim.runs.some(one => one.argv[0] === 'claude')).toBe(false)
    expect(sim.notes.filter(one => one.kind === 'fallback')).toEqual([])
  })

  test('the default directory goes as isInherited', async () => {
    const sim = machine(request => ran(JSON.stringify({ ok: true, five: windows.five, seven: null, isInherited: request.isInherited })))
    await withHelper(posixHost, setup).probeUsage(sim.port, '/home/u/.claude', true)
    expect(sim.runs.find(one => one.argv[1] === SCRIPT)?.init?.stdin).toBe('{"configDir":"/home/u/.claude","isInherited":true}')
  })

  test("the probe's own codes are the answer, with no fallback and no note; a call that timed out is TIMEOUT", async () => {
    for (const code of USAGE_CODES) {
      const sim = machine(() => ran(JSON.stringify({ ok: false, code }), 1))
      expect(await withHelper(posixHost, setup).probeUsage(sim.port, '/home/u/.claude', false)).toEqual({ ok: false, code })
      expect(sim.runs.some(one => one.argv[0] === 'claude')).toBe(false)
      expect(sim.notes.filter(one => one.kind === 'fallback')).toEqual([])
    }
    const slow = machine(() => {
      throw new Error('the command timed out after 20000 ms')
    })
    expect(await withHelper(posixHost, setup).probeUsage(slow.port, '/home/u/.claude', false)).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(slow.runs.some(one => one.argv[0] === 'claude')).toBe(false)
  })

  test('a failure of the helper itself falls back to the native probe, told to the port with its code', async () => {
    const failures: [() => ProcessRunResult, string][] = [
      [() => ran('not json', 1), 'BAD_JSON'],
      [() => ran(JSON.stringify({ ok: false, code: 'INTERNAL' }), 1), 'INTERNAL'],
      [() => ran(JSON.stringify({ ok: true, five: { percent: 'x' } })), 'BAD_ANSWER'],
      [
        () => {
          throw new Error('spawn /m/node EACCES')
        },
        'SPAWN',
      ],
    ]
    for (const [helper, code] of failures) {
      const sim = machine(helper)
      expect(await withHelper(posixHost, setup).probeUsage(sim.port, '/home/u/.claude', false)).toEqual(windows)
      expect(sim.notes.filter(one => one.kind === 'fallback')).toEqual([{ kind: 'fallback', op: 'probeUsage', code, isQuiet: false }])
      expect(sim.runs.filter(one => one.argv[0] === 'claude').length).toBe(1)
    }
  })

  test('without Node the native probe runs, as with the helper option off', async () => {
    const sim = machine(() => ran('{}'), undefined, false)
    expect(await withHelper(posixHost, setup).probeUsage(sim.port, '/home/u/.claude', false)).toEqual(windows)
    expect(sim.runs.map(one => one.argv[0])).toEqual([NODE, 'claude'])
  })

  test('Windows goes through the same helper operation', async () => {
    const sim = machine(() => ran(JSON.stringify(windows)))
    expect(await withHelper(windowsHost, setup).probeUsage(sim.port, 'C:/Users/u/.claude', false)).toEqual(windows)
    expect(sim.runs.filter(one => one.argv[1] === SCRIPT).map(one => one.argv[2])).toEqual(['probeUsage'])
  })

  test('usageOfCall: windows, a probe code, or undefined for the helper failing', () => {
    expect(usageOfCall({ ok: true, fields: windows })).toEqual(windows)
    expect(usageOfCall({ ok: false, code: 'PARSE' })).toEqual({ ok: false, code: 'PARSE' })
    expect(usageOfCall({ ok: false, code: 'TIMEOUT' })).toEqual({ ok: false, code: 'TIMEOUT' })
    expect(usageOfCall({ ok: false, code: 'SPAWN' })).toBeUndefined()
    expect(usageOfCall({ ok: true, fields: {} })).toBeUndefined()
  })
})
