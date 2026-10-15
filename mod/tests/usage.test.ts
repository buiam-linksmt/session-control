// The usage probe of probe_licence_usage below the tools: the helper's answer as hooks/usage.ts reads it, and the Node
// helper's route (host-helper.ts) through a recording port: one helper process per probe, the probe's own codes are the
// answer, a failure of the helper itself is FAILED, and without Node the probe refuses. The helper process itself, its
// reader of claude's text among it, is tested by helper.test.mjs over the cases of tests/usage-fixtures.ts.

import { describe, expect, test } from 'claude-code/testing'
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { HostPort } from '../hooks/host'
import { NODE_REFUSAL, usageOfCall, withHelper } from '../hooks/host-helper'
import type { HelperNote } from '../hooks/host-helper'
import { posixHost } from '../hooks/host-posix'
import { windowsHost } from '../hooks/host-windows'
import { USAGE_CODES, isUsageCode, usageAnswer } from '../hooks/usage'

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
    now: async () => 1_700_000_000_000,
    env: async name => env[name],
    runsDir: async () => '/m/runs',
    noteHelper: note => notes.push(note),
  }
  return { port, runs, notes }
}

describe('the usage parser', () => {
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

describe('the helper route', () => {
  const NODE = '/m/node'
  const SCRIPT = '/m/mod/helper/host.mjs'
  const setup = { node: NODE, script: SCRIPT }

  /** A machine where node answers `helper` for probeUsage (with `hasNode` false node cannot start); claude never runs from the mod. */
  function machine(helper: (request: Record<string, unknown>) => ProcessRunResult, hasNode = true) {
    return recordingPort((argv, init) => {
      if (argv[0] === NODE && argv[1] === '--version') {
        if (!hasNode) throw new Error('spawn node ENOENT')
        return ran('v24.14.0\n')
      }
      if (argv[0] === NODE && argv[1] === SCRIPT && argv[2] === 'probeUsage') return helper(JSON.parse(init?.stdin ?? '{}') as Record<string, unknown>)
      throw new Error(`unexpected ${argv.join(' ')}`)
    })
  }
  const windows = { ok: true, five: { percent: 12, resets: 'Oct 11, 11:20am (Europe/Budapest)' }, seven: { percent: 41, resets: 'Oct 16, 1pm (Europe/Budapest)' } }

  test('the default directory goes as isInherited', async () => {
    const sim = machine(request => ran(JSON.stringify({ ok: true, five: windows.five, seven: null, isInherited: request.isInherited })))
    await withHelper(posixHost, setup).probeUsage(sim.port, '/home/u/.claude', true)
    expect(sim.runs.find(one => one.argv[1] === SCRIPT)?.init?.stdin).toBe('{"configDir":"/home/u/.claude","isInherited":true}')
  })

  test('a failure of the helper itself is FAILED, told to the port with its code; nothing else runs', async () => {
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
      expect(await withHelper(posixHost, setup).probeUsage(sim.port, '/home/u/.claude', false)).toEqual({ ok: false, code: 'FAILED' })
      expect(sim.notes.filter(one => one.kind === 'failed')).toEqual([{ kind: 'failed', op: 'probeUsage', code, isQuiet: false }])
      expect(sim.runs.map(one => one.argv[0])).toEqual([NODE, NODE])
    }
  })

  test('without Node the probe refuses with the fixed text, and no helper call is made', async () => {
    const sim = machine(() => ran('{}'), false)
    await expect(withHelper(posixHost, setup).probeUsage(sim.port, '/home/u/.claude', false)).rejects.toThrow(NODE_REFUSAL)
    expect(sim.runs.map(one => one.argv.join(' '))).toEqual([`${NODE} --version`])
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
