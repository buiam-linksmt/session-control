// The Node helper behind the host interface (hooks/host-helper.ts): its answers read, each operation sent as one
// request, a failed call answered as the operation's own failure with nothing falling back, every operation refused
// with one fixed text while no usable Node is found, the batch's order, Node looked for once and again later, and the
// nodePath option and a missing Node through the plugin. The helper itself is tested by tests/helper.test.mjs under
// `node --test`; here it is simulated over a map of files.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { parseProcFacts } from '../hooks/core'
import type { Host, HostPort, RotatePlan } from '../hooks/host'
import { CALL_CODES, HELPER_MIN_NODE, HELPER_REDETECT_MS, NODE_REFUSAL, NODE_WARNING, appendText, newerAnswer, nodeMajor, readAnswer, rejectionCode, treeAnswer, withHelper } from '../hooks/host-helper'
import { TAIL_SHAPED_MAX_BYTES } from '../hooks/host-shared'
import type { HelperNote } from '../hooks/host-helper'
import { posixHost } from '../hooks/host-posix'
import { PROBE_PS1, windowsHost } from '../hooks/host-windows'
import { helperAnswer as fakeHelper } from './fake-helper'
import { NOW_MS } from './fixtures'

const ran = (stdout = '', exitCode = 0, stderr = '', isStdoutTruncated = false): ProcessRunResult => ({ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated: false })

const NODE = '/m/node/bin/node'
const SCRIPT = '/m/mod/helper/host.mjs'
const SID = '11111111-2222-4333-8444-555555555555'
/** What the helper's probe prints on the simulated machine (one worker, one transcript). */
const PROBE_OUT = `P\t4242\tclaude\t3\t/m/work\t/m/cfg\tclaude -p --model opus -- Goal: x \nA\t4242\tclaude\t123\t123\t${SID}\nT\t${SID}\t1700000000\n`
const WIN_PROBE_OUT = `P\t4242\tclaude\t3\tC:\\m\\work\tC:\\m\\cfg\tclaude.exe -p\r\n`

type Request = Record<string, unknown>
/** How the simulated helper answers: as the real one does, or a failure of a given kind. */
type Answering = 'real' | 'spawn' | 'timeout' | ((op: string, request: Request) => ProcessRunResult)

type Run = { argv: string[]; stdin?: string; isQuiet?: boolean; shown?: Record<string, unknown> }

type Sim = {
  files: Map<string, string>
  /** The symbolic links: a link's key to its target's key. */
  links: Map<string, string>
  runs: Run[]
  notes: HelperNote[]
  /** What `node --version` prints; null: node cannot start. */
  version: string | null
  answering: Answering
  /** The port's clock, epoch milliseconds. */
  nowMs: number
}

/** A path as the adapters give it (C:\x and C:/x alike). */
const keyOf = (path: string) => path.replace(/\\/g, '/')

/** The helper's operations over the map of files (tests/fake-helper.ts), its probe printing PROBE_OUT. */
const helperAnswer = (files: Map<string, string>, op: string, request: Request, links: ReadonlyMap<string, string> = new Map()) => fakeHelper(files, op, request, PROBE_OUT, keyOf, new Map(), links)

/** The simulated machine: node (and the helper) answered as the system would; on Windows the probe script too. */
function machine(answering: Answering = 'real', version: string | null = 'v24.14.0\n'): Sim {
  return { files: new Map(), links: new Map(), runs: [], notes: [], version, answering, nowMs: NOW_MS }
}

function runOn(sim: Sim, argv: readonly string[], stdin?: string): ProcessRunResult {
  const [cmd] = argv
  if (cmd === NODE && argv[1] === '--version') {
    if (sim.version === null) throw new Error('spawn /m/node/bin/node ENOENT')
    return ran(sim.version)
  }
  if (cmd === NODE && argv[1] === SCRIPT) {
    const op = String(argv[2])
    const request = JSON.parse(stdin ?? '') as Request
    if (sim.answering === 'spawn') throw new Error('spawn /m/node/bin/node EACCES')
    if (sim.answering === 'timeout') throw new Error('the command timed out after 10000 ms')
    if (typeof sim.answering === 'function') return sim.answering(op, request)
    const answer = helperAnswer(sim.files, op, request, sim.links)
    return ran(JSON.stringify(answer), answer.ok === true ? 0 : 1)
  }
  if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/probe.ps1')) return ran(WIN_PROBE_OUT)
  throw new Error(`unexpected command ${argv.join(' ')}`)
}

/** A HostPort on the simulated machine, as register.tsx's is on the engine; reads over `cap` characters reject as $.fs's 4 MiB cap does. */
function portOf(sim: Sim, cap = Infinity): HostPort {
  return {
    run: async (argv, init, isQuiet, shown) => {
      sim.runs.push({ argv: [...argv], stdin: init?.stdin, isQuiet, shown })
      return runOn(sim, argv, init?.stdin)
    },
    read: async path => {
      const text = sim.files.get(keyOf(path))
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      if (text.length > cap) throw new Error(`EFBIG ${path}`)
      return text
    },
    write: async (path, text) => {
      sim.files.set(keyOf(path), text)
    },
    exists: async path => sim.files.has(keyOf(path)),
    stat: async path => {
      const text = sim.files.get(keyOf(path))
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return { kind: 'file', size: text.length, mtimeMs: NOW_MS, isLink: false } as never
    },
    now: async () => sim.nowMs,
    sleep: async () => undefined,
    env: async name => (name === 'SystemRoot' ? 'C:\\Windows' : '/m/home'),
    runsDir: async () => '/m/runs',
    noteHelper: note => {
      sim.notes.push(note)
    },
  }
}

const helped = (base = posixHost) => withHelper(base, { node: NODE, script: SCRIPT })
/** The helper calls made, with their requests. */
const calls = (sim: Sim) => sim.runs.filter(one => one.argv[0] === NODE && one.argv[1] === SCRIPT).map(one => ({ op: one.argv[2], request: JSON.parse(one.stdin ?? '') as Request }))
const lookups = (sim: Sim) => sim.runs.filter(one => one.argv[0] === NODE && one.argv[1] === '--version')
const failures = (sim: Sim) => sim.notes.filter(note => note.kind === 'failed')
const PLAN: RotatePlan = { path: '/m/runs/trace.log', adding: 10, keep: 3, maxBytes: 8, moves: [['/m/runs/trace.log.1', '/m/runs/trace.log.2'], ['/m/runs/trace.log', '/m/runs/trace.log.1']] }

/** What a call came to: the value it answered, or the message of what it rejected with. */
async function outcome<T>(work: Promise<T>): Promise<{ value: T } | { rejected: string }> {
  try {
    return { value: await work }
  } catch (err) {
    return { rejected: err instanceof Error ? err.message : String(err) }
  }
}

describe('helper answers', () => {
  test('an answer is one JSON object: ok with exit 0, or ok:false with a fixed code; anything else is a code of this side', () => {
    expect(readAnswer(ran('{"ok":true,"written":true}\n'))).toEqual({ ok: true, fields: { ok: true, written: true } })
    expect(readAnswer(ran('{"ok":false,"code":"ACCESS"}\n', 1))).toEqual({ ok: false, code: 'ACCESS' })
    expect(readAnswer(ran('{"ok":false,"code":"IO","at":1,"results":[{"ok":true}]}', 1))).toEqual({ ok: false, code: 'IO', at: 1 })
    expect(readAnswer(ran('Error: EACCES: permission denied, open /etc/x', 1))).toEqual({ ok: false, code: 'BAD_JSON' })
    expect(readAnswer(ran(''))).toEqual({ ok: false, code: 'BAD_JSON' })
    expect(readAnswer(ran('[{"ok":true}]'))).toEqual({ ok: false, code: 'BAD_JSON' })
    expect(readAnswer(ran('"ok"'))).toEqual({ ok: false, code: 'BAD_JSON' })
    expect(readAnswer(ran('{"ok":true}', 1))).toEqual({ ok: false, code: 'BAD_ANSWER' })
    expect(readAnswer(ran('{"written":true}'))).toEqual({ ok: false, code: 'BAD_ANSWER' })
    expect(readAnswer(ran('{"ok":"yes"}'))).toEqual({ ok: false, code: 'BAD_ANSWER' })
    expect(readAnswer(ran('{"ok":true,"text":"cut', 0, '', true))).toEqual({ ok: false, code: 'TRUNCATED' })
  })

  test('a failure code that is not a fixed word (a message, a path, file content) never passes on', () => {
    for (const code of ['EACCES: permission denied, open /home/u/.claude/x', 'access', '/etc/passwd', 'A', 'TOO_LONG_' + 'X'.repeat(40), 42, null]) {
      expect(readAnswer(ran(JSON.stringify({ ok: false, code }), 1))).toEqual({ ok: false, code: 'BAD_ANSWER' })
    }
  })

  test('the Node version and a rejected start', () => {
    expect(nodeMajor('v24.14.0\n')).toBe(24)
    expect(nodeMajor('v22.10.0')).toBe(22)
    expect([nodeMajor(''), nodeMajor('v8'), nodeMajor('node 24.1.0'), nodeMajor('Welcome to Node.js')]).toEqual([undefined, undefined, undefined, undefined])
    expect(HELPER_MIN_NODE).toBe(22)
    expect(rejectionCode(new Error('the command timed out after 10000 ms'))).toBe('TIMEOUT')
    expect(rejectionCode(new Error('spawn node ENOENT'))).toBe('SPAWN')
    expect(rejectionCode('not an error')).toBe('SPAWN')
    expect(CALL_CODES).toEqual(['SPAWN', 'TIMEOUT', 'BAD_JSON', 'TRUNCATED', 'BAD_ANSWER'])
  })

  test('an append adds each line and a newline, as APPEND_SCRIPT prints them', () => {
    expect(appendText(['{"a":1}', '{"b":2}'])).toBe('{"a":1}\n{"b":2}\n')
    expect(appendText([])).toBe('')
  })
})

describe('withHelper on Linux', () => {
  test('Node is looked for once, untraced, at the first operation; each operation is one helper call with its request', async () => {
    const sim = machine()
    const host = helped()
    const port = portOf(sim)
    sim.files.set('/m/reg.json', '[]\n')
    sim.files.set('/m/runs/t.jsonl', 'a\nb\n')
    sim.files.set('/m/a.tmp', 'A')
    sim.files.set('/m/gone', 'x')

    const facts = await host.probe(port, [{ pid: 4242, session_id: SID, config_dir: '/m/cfg' }])
    expect(facts).toEqual(parseProcFacts(PROBE_OUT))
    expect(await host.writeAtomic(port, '/m/reg.json', '[1]\n', '[]\n')).toBe(true)
    expect(await host.writeAtomic(port, '/m/reg.json', '[2]\n', '[]\n')).toBe(false)
    await host.renameOver(port, '/m/a.tmp', '/m/a')
    expect(await host.removeFile(port, '/m/gone')).toBe(true)
    const codes: number[] = []
    expect(await host.append(port, '/m/runs/log.jsonl', ['{"a":1}', '{"b":2}'], false, code => codes.push(code))).toBeUndefined()
    expect(await host.tail(port, '/m/runs/t.jsonl')).toBe('a\nb\n')
    await host.rotate(port, { ...PLAN, path: '/m/runs/t.jsonl', moves: [['/m/runs/t.jsonl', '/m/runs/t.jsonl.1']] })

    expect(lookups(sim).map(one => one.isQuiet)).toEqual([true])
    expect(sim.runs[0]?.argv).toEqual([NODE, '--version'])
    expect(sim.notes).toEqual([{ kind: 'node', isActive: true, version: 'v24.14.0' }])
    expect(calls(sim)).toEqual([
      { op: 'probe', request: { args: [`pid:4242|/m/cfg`, `t:${SID}|/m/cfg`] } },
      { op: 'writeAtomic', request: { path: '/m/reg.json', text: '[1]\n', expected: '[]\n' } },
      { op: 'writeAtomic', request: { path: '/m/reg.json', text: '[2]\n', expected: '[]\n' } },
      { op: 'renameOver', request: { from: '/m/a.tmp', to: '/m/a' } },
      { op: 'removeFile', request: { path: '/m/gone' } },
      { op: 'append', request: { path: '/m/runs/log.jsonl', text: '{"a":1}\n{"b":2}\n' } },
      { op: 'tail', request: { path: '/m/runs/t.jsonl', lines: 600, width: 20000 } },
      { op: 'rotate', request: { path: '/m/runs/t.jsonl', adding: 10, maxBytes: 8, moves: [['/m/runs/t.jsonl', '/m/runs/t.jsonl.1']] } },
    ])
    // No adapter command ran: one process per operation, the helper's.
    expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    expect([sim.files.get('/m/reg.json'), sim.files.get('/m/a'), sim.files.has('/m/gone'), sim.files.get('/m/runs/log.jsonl'), sim.files.get('/m/runs/t.jsonl.1')]).toEqual([
      '[1]\n',
      'A',
      false,
      '{"a":1}\n{"b":2}\n',
      'a\nb\n',
    ])
    expect(codes).toEqual([0])
    expect(failures(sim)).toEqual([])
  })

  test('the trace sees the operation and its path, never the request: the text written stays out', async () => {
    const sim = machine()
    const port = portOf(sim)
    await helped().writeAtomic(port, '/m/reg.json', '[{"title":"secret plan"}]\n')
    await helped().append(port, '/m/log', ['{"title":"secret plan"}'], true, () => undefined)
    const shown = sim.runs.filter(one => one.argv[1] === SCRIPT)
    expect(shown.map(one => [one.shown, one.isQuiet])).toEqual([
      [{ helper: 'writeAtomic', path: '/m/reg.json' }, false],
      [{ helper: 'append', path: '/m/log' }, true],
    ])
    expect(sim.runs.every(one => !one.argv.join(' ').includes('secret'))).toBe(true)
  })

  const FAILURES: [string, Answering, string][] = [
    ['node cannot start the helper', 'spawn', 'SPAWN'],
    ['the helper outlasts its timeout', 'timeout', 'TIMEOUT'],
    ['the helper prints what is not JSON', () => ran('Segmentation fault', 139), 'BAD_JSON'],
    ['the helper prints a JSON array', () => ran('[]'), 'BAD_JSON'],
    ['the helper output is cut', () => ran('{"ok":true', 0, '', true), 'TRUNCATED'],
    ['the helper answers ok:false', () => ran('{"ok":false,"code":"ACCESS"}', 1), 'ACCESS'],
    ['the helper answers ok:false with a message for a code', () => ran('{"ok":false,"code":"EACCES: /m/reg.json"}', 1), 'BAD_ANSWER'],
    ['the helper answers ok with exit 1', () => ran('{"ok":true,"written":true}', 1), 'BAD_ANSWER'],
    // A rename's whole answer is {"ok":true}: only the other operations miss their fields.
    ['the helper answers ok without the fields', (op, request) => (op === 'renameOver' ? ran(JSON.stringify(helperAnswer(SIM_FILES.files, op, request))) : ran('{"ok":true}')), 'BAD_ANSWER'],
  ]
  /** The files of the machine a failure case runs on, for an answering that does part of the work. */
  const SIM_FILES: { files: Map<string, string> } = { files: new Map() }
  for (const [name, answering, code] of FAILURES) {
    test(`${name}: every operation answers its own failure with the code ${code}, and nothing else runs`, async () => {
      const sim = machine(answering)
      SIM_FILES.files = sim.files
      const host = helped()
      const port = portOf(sim)
      sim.files.set('/m/reg.json', '[]\n')
      sim.files.set('/m/a.tmp', 'A')
      sim.files.set('/m/gone', 'x')
      sim.files.set('/m/runs/t.jsonl', 'a\nb\n')
      sim.files.set('/m/runs/trace.log', 'old\n')
      const isRenamed = name.includes('without the fields')

      // A probe that failed is an error: read as no process at all it would mark every worker dead.
      expect(await outcome(host.probe(port, []))).toEqual({ rejected: `the process probe failed (${code})` })
      expect(await outcome(host.writeAtomic(port, '/m/reg.json', '[1]\n', '[]\n'))).toEqual({ rejected: `/m/reg.json could not be written (${code})` })
      expect(await outcome(host.renameOver(port, '/m/a.tmp', '/m/a'))).toEqual(isRenamed ? { value: undefined } : { rejected: `/m/a could not be replaced (${code})` })
      expect(await host.removeFile(port, '/m/gone')).toBe(false)
      const codes: number[] = []
      expect(await host.append(port, '/m/runs/log.jsonl', ['x'], false, exit => codes.push(exit))).toBe(`/m/runs/log.jsonl cannot be appended to (${code})`)
      expect(await host.tail(port, '/m/runs/t.jsonl')).toBeUndefined()
      expect(await outcome(host.rotate(port, PLAN))).toEqual({ rejected: `the trace could not be rotated (${code})` })
      expect(await host.rotateAndAppend(port, '/m/runs/trace.log', ['new'])).toBe(`/m/runs/trace.log cannot be appended to (${code})`)

      const ops = ['probe', 'writeAtomic', 'renameOver', 'removeFile', 'append', 'tail', 'rotate', 'batch']
      // Each call went to the helper, once, and nothing ran in its place.
      expect(calls(sim).map(one => one.op)).toEqual(ops)
      expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
      const quiet = ['rotate', 'batch']
      expect(failures(sim)).toEqual(ops.filter(op => !(isRenamed && op === 'renameOver')).map(op => ({ kind: 'failed', op, code, isQuiet: quiet.includes(op) })))
      // Nothing was written: the files are as they were (but the rename that went through).
      expect([sim.files.get('/m/reg.json'), sim.files.get('/m/a'), sim.files.has('/m/gone'), sim.files.get('/m/runs/log.jsonl'), sim.files.get('/m/runs/trace.log')]).toEqual(['[]\n', isRenamed ? 'A' : undefined, true, undefined, 'old\n'])
      expect(codes).toEqual([])
      // A note holds an operation and a code only.
      expect(sim.notes.every(note => Object.keys(note).every(key => ['kind', 'op', 'code', 'isQuiet', 'isActive', 'version'].includes(key)))).toBe(true)
    })
  }

  /** A helper that does the operation, then outlasts its timeout (the write went through, the answer never came). */
  const writesThenTimesOut = (sim: Sim) => (op: string, request: Request): ProcessRunResult => {
    if (op === 'append' || op === 'batch') {
      helperAnswer(sim.files, op, request)
      throw new Error('the command timed out after 10000 ms')
    }
    const answer = helperAnswer(sim.files, op, request)
    return ran(JSON.stringify(answer), answer.ok === true ? 0 : 1)
  }

  test('removeRegularFile is one helper call with regularOnly; the helper\'s refusal of a link or a non-file is the answer, no fallback, no adapter command', async () => {
    const sim = machine()
    const host = helped()
    const port = portOf(sim)
    sim.files.set('/m/runs/a.json', 'A')
    sim.files.set('/m/runs/sub/inner', 'I')
    sim.files.set('/m/out/secret', 'S')
    sim.links.set('/m/runs/link.json', '/m/out/secret')
    sim.links.set('/m/runs/linkdir', '/m/out')
    expect(await host.removeRegularFile(port, '/m/runs/a.json')).toBe('removed')
    expect(await host.removeRegularFile(port, '/m/runs/a.json')).toBe('absent')
    expect(await host.removeRegularFile(port, '/m/runs/link.json')).toBe('symlink')
    expect(await host.removeRegularFile(port, '/m/runs/linkdir')).toBe('symlink')
    expect(await host.removeRegularFile(port, '/m/runs/sub')).toBe('not-file')
    expect(calls(sim)).toEqual(['/m/runs/a.json', '/m/runs/a.json', '/m/runs/link.json', '/m/runs/linkdir', '/m/runs/sub'].map(path => ({ op: 'removeFile', request: { path, regularOnly: true } })))
    expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    expect(failures(sim)).toEqual([])
    expect([...sim.files.keys()].sort()).toEqual(['/m/out/secret', '/m/runs/sub/inner'])
    expect(sim.links.size).toBe(2)
  })

  test('removeRegularFile after a failed call (a spawn failure, a timeout, an access error, an answer that is not JSON, one without the field) answers failed, told by its code; nothing is removed', async () => {
    for (const [answering, code] of [
      ['spawn', 'SPAWN'],
      ['timeout', 'TIMEOUT'],
      [(): ProcessRunResult => ran('{"ok":false,"code":"ACCESS"}\n', 1), 'ACCESS'],
      [(): ProcessRunResult => ran('boom', 1), 'BAD_JSON'],
      [(): ProcessRunResult => ran('{"ok":true}\n'), 'BAD_ANSWER'],
    ] as const) {
      const sim = machine(answering)
      const port = portOf(sim)
      sim.files.set('/m/runs/a.json', 'A')
      expect(await helped().removeRegularFile(port, '/m/runs/a.json')).toBe('failed')
      expect(failures(sim)).toEqual([{ kind: 'failed', op: 'removeFile', code, isQuiet: false }])
      expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
      expect(sim.files.get('/m/runs/a.json')).toBe('A')
    }
  })

  test('an append that timed out after writing is not made again: one line in the log, a note that says so, no exit code', async () => {
    const sim = machine('real')
    sim.answering = writesThenTimesOut(sim)
    const port = portOf(sim)
    sim.files.set('/m/runs/cleared.jsonl', 'old\n')
    const codes: number[] = []
    expect(await helped().append(port, '/m/runs/cleared.jsonl', ['{"session_id":"x"}'], false, exit => codes.push(exit))).toBe('/m/runs/cleared.jsonl cannot be appended to (TIMEOUT)')
    expect(sim.files.get('/m/runs/cleared.jsonl')).toBe('old\n{"session_id":"x"}\n')
    expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    expect(codes).toEqual([])
    expect(failures(sim)).toEqual([{ kind: 'failed', op: 'append', code: 'TIMEOUT', isQuiet: false }])
  })

  test('the trace\'s batch that timed out after writing is not made again: rotated once, the lines once', async () => {
    const sim = machine('real')
    sim.answering = writesThenTimesOut(sim)
    const port = portOf(sim)
    sim.files.set('/m/runs/trace.log', 'old\n')
    expect(await helped().rotateAndAppend(port, '/m/runs/trace.log', ['new'], PLAN)).toBe('/m/runs/trace.log cannot be appended to (TIMEOUT)')
    expect([sim.files.get('/m/runs/trace.log'), sim.files.get('/m/runs/trace.log.1'), sim.files.get('/m/runs/trace.log.2')]).toEqual(['new\n', 'old\n', undefined])
    expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    expect(failures(sim)).toEqual([{ kind: 'failed', op: 'batch', code: 'TIMEOUT', isQuiet: true }])
  })

  test('the batch: the rotation, then the append, in that order, in one helper process', async () => {
    const sim = machine()
    const port = portOf(sim)
    sim.files.set('/m/runs/trace.log', 'old\n')
    sim.files.set('/m/runs/trace.log.1', 'older\n')
    expect(await helped().rotateAndAppend(port, '/m/runs/trace.log', ['one', 'two'], PLAN)).toBeUndefined()
    expect(calls(sim)).toEqual([
      {
        op: 'batch',
        request: {
          ops: [
            { op: 'rotate', path: '/m/runs/trace.log', adding: 10, maxBytes: 8, moves: PLAN.moves },
            { op: 'append', path: '/m/runs/trace.log', text: 'one\ntwo\n' },
          ],
        },
      },
    ])
    expect(sim.runs.filter(one => one.argv[1] === SCRIPT).map(one => [one.isQuiet, one.shown])).toEqual([[true, { helper: 'batch', ops: ['rotate', 'append'], path: '/m/runs/trace.log' }]])
    expect([sim.files.get('/m/runs/trace.log'), sim.files.get('/m/runs/trace.log.1'), sim.files.get('/m/runs/trace.log.2')]).toEqual(['one\ntwo\n', 'old\n', 'older\n'])
    // Without a rotation the batch is the append alone.
    await helped().rotateAndAppend(port, '/m/runs/trace.log', ['three'])
    expect((calls(sim).at(-1)?.request.ops as Request[]).map(step => step.op)).toEqual(['append'])
    expect(sim.files.get('/m/runs/trace.log')).toBe('one\ntwo\nthree\n')
  })

  test('a batch that failed after its rotation is not made again: the trace rotated once, the problem said', async () => {
    const sim = machine((op, request) => {
      // The rotation goes through, the append fails.
      const steps = request.ops as Request[]
      helperAnswer(sim.files, 'rotate', steps[0] ?? {})
      return ran(JSON.stringify({ ok: false, code: 'NO_SPACE', at: 1, results: [{ ok: true, rotated: true }] }), 1)
    })
    const port = portOf(sim)
    sim.files.set('/m/runs/trace.log', 'old\n')
    sim.files.set('/m/runs/trace.log.1', 'older\n')
    expect(await helped().rotateAndAppend(port, '/m/runs/trace.log', ['new'], PLAN)).toBe('/m/runs/trace.log cannot be appended to (NO_SPACE)')
    expect(calls(sim).map(one => one.op)).toEqual(['batch'])
    expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    expect([sim.files.get('/m/runs/trace.log'), sim.files.get('/m/runs/trace.log.1'), sim.files.get('/m/runs/trace.log.2')]).toEqual([undefined, 'old\n', 'older\n'])
    expect(failures(sim)).toEqual([{ kind: 'failed', op: 'batch', code: 'NO_SPACE', isQuiet: true }])
  })

  const NO_NODE: [string, string | null, Record<string, unknown>][] = [
    ['no Node', null, { kind: 'node', isActive: false, reason: 'not-found' }],
    ['Node 20', 'v20.18.1\n', { kind: 'node', isActive: false, version: 'v20.18.1', reason: 'too-old' }],
    ['Node 21', 'v21.7.3\n', { kind: 'node', isActive: false, version: 'v21.7.3', reason: 'too-old' }],
    ['a node that prints no version', 'hello\n', { kind: 'node', isActive: false, reason: 'version-unreadable' }],
  ]
  for (const [name, version, note] of NO_NODE) {
    test(`${name}: every operation that reads or writes the machine refuses with the fixed text for the whole load, one lookup, one note`, async () => {
      const sim = machine('real', version)
      const host = helped()
      const port = portOf(sim)
      sim.files.set('/m/reg.json', '[]\n')
      sim.files.set('/m/runs/a.json', 'A')
      const refused = { rejected: NODE_REFUSAL }
      expect(await host.nodeReady(port)).toBe(false)
      expect(await outcome(host.probe(port, []))).toEqual(refused)
      expect(await outcome(host.writeAtomic(port, '/m/reg.json', '[1]\n', '[]\n'))).toEqual(refused)
      expect(await outcome(host.renameOver(port, '/m/a.tmp', '/m/a'))).toEqual(refused)
      expect(await outcome(host.removeFile(port, '/m/gone'))).toEqual(refused)
      expect(await outcome(host.removeRegularFile(port, '/m/runs/a.json'))).toEqual(refused)
      expect(await outcome(host.append(port, '/m/log', ['x'], false, () => undefined))).toEqual(refused)
      expect(await outcome(host.tail(port, '/m/runs/a.json'))).toEqual(refused)
      expect(await outcome(host.filesNewerThan(port, '/m', 0))).toEqual(refused)
      expect(await outcome(host.hashTrees(port, ['/m/a', '/m/b'], { dirs: ['hooks'], files: [] }))).toEqual(refused)
      expect(await outcome(host.rotate(port, PLAN))).toEqual(refused)
      expect(await outcome(host.rotateAndAppend(port, '/m/log', ['y']))).toEqual(refused)
      expect(await outcome(host.probeUsage(port, '/m/cfg', false))).toEqual(refused)
      expect(await outcome(host.stopProcessTree(port, { pid: 4242, start: '123' }))).toEqual(refused)
      expect(await outcome(host.launchChecks(port, { dir: '/m', prompt_file: '/m/p.md', model: 'm', effort: 'e', title: 't' } as never))).toEqual(refused)
      expect(await outcome(host.createFile(port, '/m/new.json', '{}'))).toEqual(refused)
      expect(await outcome(host.prepareHelperDirs(port, '/m/backups'))).toEqual(refused)
      expect(await outcome(host.prepareRunsDir(port, '/m/runs'))).toEqual(refused)
      expect(lookups(sim).length).toBe(1)
      expect(calls(sim)).toEqual([])
      expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
      expect(sim.notes).toEqual([note])
      expect([sim.files.get('/m/reg.json'), sim.files.get('/m/runs/a.json'), sim.files.has('/m/log'), sim.files.has('/m/new.json')]).toEqual(['[]\n', 'A', false, false])
      // The members that touch nothing answer as ever.
      expect(await host.homeDir(port)).toBe('/m/home')
      expect(host.nativePath('/m/x')).toBe('/m/x')
    })
  }

  test('Node 22 is enough', async () => {
    const sim = machine('real', 'v22.10.0\n')
    await helped().probe(portOf(sim), [])
    expect(sim.notes).toEqual([{ kind: 'node', isActive: true, version: 'v22.10.0' }])
    expect(calls(sim).map(one => one.op)).toEqual(['probe'])
  })

  test('two operations at once share the one lookup', async () => {
    const sim = machine()
    const host = helped()
    const port = portOf(sim)
    await Promise.all([host.probe(port, []), host.append(port, '/m/log', ['x'], false, () => undefined)])
    expect(lookups(sim).length).toBe(1)
    expect(calls(sim).map(one => one.op).sort()).toEqual(['append', 'probe'])
  })

  test('no Node: looked for again at the first operation 10 minutes after the last lookup, not before; Node installed meanwhile is taken', async () => {
    const sim = machine('real', null)
    const host = helped()
    const port = portOf(sim)
    expect(HELPER_REDETECT_MS).toBe(600_000)
    expect(await outcome(host.probe(port, []))).toEqual({ rejected: NODE_REFUSAL })
    expect(lookups(sim).length).toBe(1)
    // Node is installed four minutes on; the operations before the interval do not look for it.
    sim.nowMs += 240_000
    sim.version = 'v24.14.0\n'
    expect(await outcome(host.probe(port, []))).toEqual({ rejected: NODE_REFUSAL })
    sim.nowMs += HELPER_REDETECT_MS - 240_000 - 1
    expect(await outcome(host.append(port, '/m/log', ['x'], false, () => undefined))).toEqual({ rejected: NODE_REFUSAL })
    expect(lookups(sim).length).toBe(1)
    expect(calls(sim)).toEqual([])
    // At the interval, the next operation looks again, finds it and uses it.
    sim.nowMs += 1
    await host.append(port, '/m/log', ['y'], false, () => undefined)
    expect(lookups(sim).length).toBe(2)
    expect(calls(sim).map(one => one.op)).toEqual(['append'])
    expect(sim.files.get('/m/log')).toBe('y\n')
    // One note per change of state: none found, then found.
    expect(sim.notes).toEqual([
      { kind: 'node', isActive: false, reason: 'not-found' },
      { kind: 'node', isActive: true, version: 'v24.14.0' },
    ])
    // Found, it stays for the load: an hour on, no lookup.
    sim.nowMs += 3_600_000
    await host.probe(port, [])
    expect(lookups(sim).length).toBe(2)
  })

  test('Node still missing at each later lookup: a lookup every 10 minutes at most, and no new note until its state changes', async () => {
    const sim = machine('real', null)
    const host = helped()
    const port = portOf(sim)
    for (let minute = 0; minute <= 25; minute++) {
      sim.nowMs = NOW_MS + minute * 60_000
      await outcome(host.probe(port, []))
    }
    // Looked for at minutes 0, 10 and 20.
    expect(lookups(sim).length).toBe(3)
    expect(sim.notes).toEqual([{ kind: 'node', isActive: false, reason: 'not-found' }])
    // An old Node turns up: a change of state, one note; still old ten minutes on: no note.
    sim.version = 'v20.18.1\n'
    sim.nowMs = NOW_MS + 30 * 60_000
    await outcome(host.probe(port, []))
    sim.nowMs = NOW_MS + 40 * 60_000
    await outcome(host.probe(port, []))
    expect(lookups(sim).length).toBe(5)
    expect(sim.notes).toEqual([
      { kind: 'node', isActive: false, reason: 'not-found' },
      { kind: 'node', isActive: false, version: 'v20.18.1', reason: 'too-old' },
    ])
    expect(calls(sim)).toEqual([])
  })

  test('operations at the same time after the interval share one new lookup', async () => {
    const sim = machine('real', null)
    const host = helped()
    const port = portOf(sim)
    await outcome(host.probe(port, []))
    sim.nowMs += HELPER_REDETECT_MS
    sim.version = 'v24.14.0\n'
    await Promise.all([host.probe(port, []), host.append(port, '/m/log', ['x'], false, () => undefined), host.removeFile(port, '/m/none')])
    expect(lookups(sim).length).toBe(2)
    expect(calls(sim).map(one => one.op).sort()).toEqual(['append', 'probe', 'removeFile'])
  })

  test('the other members are the adapter\'s own', () => {
    const host = helped()
    for (const name of ['homeDir', 'launchCommand', 'findNewWorker', 'pause'] as const) expect(host[name]).toBe(posixHost[name])
    expect(host.platform).toBe('linux')
  })
})

describe('withHelper: the listing and the shaped tail', () => {
  test('filesNewerThan is one helper call with its request and a 30 s limit; a shaped tail asks the helper to keep the newest bytes', async () => {
    const sim = machine()
    const host = helped()
    const timeouts: (number | undefined)[] = []
    const base = portOf(sim)
    const port: HostPort = { ...base, run: (argv, init, isQuiet, shown) => (timeouts.push(init?.timeoutMs), base.run(argv, init, isQuiet, shown)) }
    sim.files.set('/m/work/a.txt', 'x')
    sim.files.set('/m/runs/t.jsonl', 'a\nbb\nc\n')
    expect(await host.filesNewerThan(port, '/m/work', 1700000000.9)).toEqual({ files: [], total: 0 })
    expect(await host.tail(port, '/m/runs/t.jsonl', { lines: 2, width: 1 })).toBe('b\nc\n')
    expect(calls(sim)).toEqual([
      { op: 'filesNewerThan', request: { dir: '/m/work', since: 1700000000, max: 200 } },
      { op: 'tail', request: { path: '/m/runs/t.jsonl', lines: 2, width: 1, maxBytes: TAIL_SHAPED_MAX_BYTES } },
    ])
    // The lookup, then the listing at 30 s and the tail at the usual 10 s.
    expect(timeouts).toEqual([5_000, 30_000, 10_000])
    expect(failures(sim)).toEqual([])
  })

  test('filesNewerThan: an answer of the wrong shape or a directory the helper does not find answers nothing, told by its code', async () => {
    for (const [answer, code] of [
      ['{"ok":true,"files":"nope","total":1}', 'BAD_ANSWER'],
      ['{"ok":false,"code":"NOT_FOUND"}', 'NOT_FOUND'],
    ] as const) {
      const sim = machine(() => ran(answer, answer.includes('"ok":true') ? 0 : 1))
      expect(await helped().filesNewerThan(portOf(sim), '/m/work', 1700000000)).toBeUndefined()
      expect(failures(sim)).toEqual([{ kind: 'failed', op: 'filesNewerThan', code, isQuiet: false }])
      expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    }
  })

  test('on Windows the listing goes through the helper, its request in the stored C:/ form', async () => {
    const sim = machine()
    sim.files.set('C:/m/work/a.txt', 'x')
    expect(await helped(windowsHost).filesNewerThan(portOf(sim), 'C:/m/work', 1700000000)).toEqual({ files: [], total: 0 })
    expect(calls(sim)).toEqual([{ op: 'filesNewerThan', request: { dir: 'C:/m/work', since: 1700000000, max: 200 } }])
    expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
  })

  test('newerAnswer takes an array of path and mtime pairs with a whole count no smaller than the list, and nothing else', () => {
    const one = { path: '/a', mtimeMs: 1 }
    expect(newerAnswer({ files: [one], total: 3 })).toEqual({ files: [one], total: 3 })
    expect(newerAnswer({ files: [{ ...one, extra: 'x' }], total: 1 })).toEqual({ files: [one], total: 1 })
    expect(newerAnswer({ files: [one], total: 0 })).toBeUndefined()
    expect(newerAnswer({ files: [one], total: 1.5 })).toBeUndefined()
    expect(newerAnswer({ files: [{ path: '/a' }], total: 1 })).toBeUndefined()
    expect(newerAnswer({ files: 'x', total: 1 })).toBeUndefined()
    expect(newerAnswer({ total: 0 })).toBeUndefined()
  })
})

describe('withHelper on Windows', () => {
  test('the probe stays PROBE_PS1, run once Node is found; every file operation goes through the helper, a tail under the read cap too', async () => {
    const sim = machine()
    const host = helped(windowsHost)
    const port = portOf(sim, 100)
    sim.files.set('C:/m/reg.json', '[]\n')
    sim.files.set('C:/m/t.jsonl', 'a\nb\n')
    sim.files.set('C:/m/big.jsonl', `${'x'.repeat(120)}\nlast\n`)
    const facts = await host.probe(port, [{ pid: 4242, session_id: SID, config_dir: 'C:/m/cfg' }], ['C:/m/cfg'])
    expect(facts.claude.map(one => one.pid)).toEqual([4242])
    expect(sim.runs[0]?.argv).toEqual([NODE, '--version'])
    expect(sim.runs[1]?.argv[6]).toBe('/m/runs/probe.ps1')
    expect(sim.files.get('/m/runs/probe.ps1')).toBe(PROBE_PS1)
    expect(await host.writeAtomic(port, 'C:/m/reg.json', '[1]\n', '[]\n')).toBe(true)
    expect(await host.tail(port, 'C:/m/t.jsonl')).toBe('a\nb\n')
    expect(await host.tail(port, 'C:/m/big.jsonl')).toBe(`${'x'.repeat(120)}\nlast\n`)
    expect(calls(sim)).toEqual([
      { op: 'writeAtomic', request: { path: 'C:/m/reg.json', text: '[1]\n', expected: '[]\n' } },
      { op: 'tail', request: { path: 'C:/m/t.jsonl', lines: 600, width: 20000 } },
      { op: 'tail', request: { path: 'C:/m/big.jsonl', lines: 600, width: 20000 } },
    ])
    // The only PowerShell script that ran is the probe's.
    expect(sim.runs.filter(one => one.argv[0] !== NODE).map(one => String(one.argv[6]).replace(/^.*\//, ''))).toEqual(['probe.ps1'])
  })

  test('without Node the probe, the stop and every file operation refuse; no PowerShell script runs or is written', async () => {
    const sim = machine('real', null)
    const host = helped(windowsHost)
    const port = portOf(sim)
    const refused = { rejected: NODE_REFUSAL }
    expect(await outcome(host.probe(port, [], ['C:/m/cfg']))).toEqual(refused)
    expect(await outcome(host.stopProcessTree(port, { pid: 4242, start: '1789999875123' }))).toEqual(refused)
    expect(await outcome(host.writeAtomic(port, 'C:/m/reg.json', '[1]\n'))).toEqual(refused)
    expect(await outcome(host.prepareRunsDir(port, 'C:/m/runs'))).toEqual(refused)
    expect(sim.runs.map(one => one.argv[0])).toEqual([NODE])
    expect([...sim.files.keys()]).toEqual([])
  })

  test('removeRegularFile on Windows: through the helper, which keeps a link and a directory; a failed call answers failed', async () => {
    const sim = machine()
    const host = helped(windowsHost)
    const port = portOf(sim)
    sim.files.set('C:/m/runs/a.json', 'A')
    sim.files.set('C:/m/runs/sub/inner', 'I')
    sim.files.set('C:/m/out/secret', 'S')
    sim.links.set('C:/m/runs/link.json', 'C:/m/out/secret')
    expect(await host.removeRegularFile(port, 'C:/m/runs/a.json')).toBe('removed')
    expect(await host.removeRegularFile(port, 'C:/m/runs/link.json')).toBe('symlink')
    expect(await host.removeRegularFile(port, 'C:/m/runs/sub')).toBe('not-file')
    expect(failures(sim)).toEqual([])
    sim.answering = 'spawn'
    sim.files.set('C:/m/runs/b.json', 'B')
    expect(await host.removeRegularFile(port, 'C:/m/runs/b.json')).toBe('failed')
    expect(failures(sim)).toEqual([{ kind: 'failed', op: 'removeFile', code: 'SPAWN', isQuiet: false }])
    expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    expect([...sim.files.keys()].sort()).toEqual(['C:/m/out/secret', 'C:/m/runs/b.json', 'C:/m/runs/sub/inner'])
  })
})

// ---------------------------------------------------------------- Node through the plugin on the mock engine

const ORCH = '/m/orch'
const PLUGIN_OPTIONS = { orchestratorDir: ORCH, registryPath: '~/.claude/headless-sessions.json', completionWrites: true }

type World = { sim: Sim; toasts: string[]; argv: string[][]; clock: ReturnType<typeof mock.clock> }

/**
 * The machine beneath the plugin: fs over the map, process.run over the simulated commands with node wherever the
 * options put it, the clock, the environment.
 */
function world(on: On, node: string | undefined, answering: Answering = 'real', version: string | null = 'v24.14.0\n'): World {
  const sim = machine(answering, version)
  const w: World = { sim, toasts: [], argv: [], clock: mock.clock(on, { now: NOW_MS }) }
  mock.env(on, { HOME: '/m/home' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__session-control__${e.name}` } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = sim.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    sim.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: sim.files.has(e.path) }))
  on('fs.stat', ($, e) => {
    const text = sim.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: NOW_MS, isLink: false } as never }
  })
  on('fs.list', () => ({ value: [] as never }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    // The plugin's own node and helper path, in the simulated machine's names.
    const isNode = node !== undefined && argv[0] === node
    const mapped = isNode ? [NODE, argv[1]?.endsWith('/helper/host.mjs') ? SCRIPT : String(argv[1]), ...argv.slice(2)] : argv
    if (mapped[0] === 'test') return { value: ran('', sim.files.has(String(mapped[2])) ? 0 : 1) }
    if (mapped[0] === 'mkdir' || mapped[0] === 'git') return { value: ran('', mapped[0] === 'git' ? 128 : 0) }
    if (!isNode && /(^|\/)node$/.test(String(argv[0]))) throw new Error(`spawn ${argv[0]} ENOENT`)
    return { value: runOn(sim, mapped, e.init?.stdin) }
  })
  return w
}

const nodeRuns = (w: World) => w.argv.filter(argv => /(^|\/)node$/.test(String(argv[0])))
const probes = (w: World) => w.argv.filter(argv => argv[2] === 'probe')
/** The plugin's panel atoms are behind its own pane; the answer of panel_snapshot shows them. */
const answerOf = async ($: Parameters<Parameters<typeof test>[2]>[0], tool: string, input: Record<string, unknown> = {}) => {
  const out = (await $.tool.call({ tool: `mcp__session-control__${tool}`, ...input } as never)) as { result?: unknown; deny?: unknown }
  return { text: String(out.deny ?? out.result ?? ''), isRefused: out.deny !== undefined }
}
/** Every tool of the mod with an input it accepts. */
const TOOL_CALLS: [string, Record<string, unknown>][] = [
  ['launch_worker', { dir: '/m/work', model: 'haiku', effort: 'low', title: 'node test', prompt: 'Reply PONG.' }],
  ['acknowledge_workers', { session_ids: [SID] }],
  ['retire_workers', { session_ids: [SID] }],
  ['close_worker', { session_ids: [SID] }],
  ['stop_worker', { session_id: SID, reason: 'test' }],
  ['open_point', { action: 'add', id: 'p1', title: 'A question.', detail: 'x', recommendation: 'y' }],
  ['queue_task', { action: 'add', id: 't1', title: 'A task', status: 'queued' }],
  ['record_decision', { section: 'Unit', id: 'u-1', text: 'A decision.' }],
  ['archive_decisions', { sections: ['Unit'] }],
  ['list_sessions', {}],
  ['read_result', { session_id: SID }],
  ['worker_tail', { session_id: SID }],
  ['session_writes', { session_id: SID }],
  ['audit_state', {}],
  ['list_licences', {}],
  ['probe_licence_usage', {}],
  ['panel_snapshot', {}],
  ['turn_digest', {}],
]

describe('helper options, through the plugin', () => {
  test('auto (the default) with Node 24 on the PATH: the probe and the registry write go through the helper in the plugin\'s folder', { options: PLUGIN_OPTIONS }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)[0]).toEqual(['node', '--version'])
    const helper = nodeRuns(w).filter(argv => argv[1] !== '--version')
    expect(helper.length).toBeGreaterThan(0)
    // The helper in the plugin's own folder ($.plugin.root), by absolute path.
    expect(helper.every(argv => argv.length === 3 && /^\/.+\/helper\/host\.mjs$/.test(String(argv[1])) && !argv[1]?.includes('//'))).toBe(true)
    expect(probes(w)).toEqual([['node', helper[0]?.[1] ?? '', 'probe']])
    expect(w.argv.filter(argv => argv[0] === 'sh')).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('an unknown value is auto', { options: { ...PLUGIN_OPTIONS, helper: 'sometimes' } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(probes(w).every(argv => argv[0] === 'node')).toBe(true)
  })

  test('a leftover helper option (off) is ignored without an error: Node is looked for and the helper runs', { options: { ...PLUGIN_OPTIONS, helper: 'off' } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)[0]).toEqual(['node', '--version'])
    expect(probes(w).length).toBe(1)
    expect(w.toasts).toEqual([])
  })

  test('without Node: one lookup, nothing tracked, the panel warning and one Node helper toast; every tool but panel_snapshot answers the fixed refusal, and nothing is written', { options: PLUGIN_OPTIONS, timeoutMs: 15_000 }, async ($, on) => {
    const w = world(on, undefined)
    w.sim.files.set('/m/home/.claude/headless-sessions.json', `${JSON.stringify([{ title: 'w', pid: 4242, session_id: SID, config_dir: '/m/cfg', cwd: '/m/work' }])}\n`)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await w.clock.advance(5000)
    await w.clock.advance(5000)
    expect(nodeRuns(w)).toEqual([['node', '--version']])
    // No probe, no helper call, no file made: the poll tracks nothing.
    expect(w.argv.filter(argv => argv[0] !== 'node')).toEqual([])
    expect([...w.sim.files.keys()]).toEqual(['/m/home/.claude/headless-sessions.json'])
    expect(w.toasts).toEqual([`Node helper \u00B7 session-control ${NODE_WARNING}`])
    for (const [tool, input] of TOOL_CALLS) {
      const answer = await answerOf($, tool, input)
      if (tool === 'panel_snapshot') {
        expect(answer.isRefused).toBe(false)
        expect(answer.text).toContain(`! session-control: ${NODE_WARNING}`)
      } else expect({ tool, answer }).toEqual({ tool, answer: { text: NODE_REFUSAL, isRefused: true } })
    }
    expect([...w.sim.files.keys()]).toEqual(['/m/home/.claude/headless-sessions.json'])
    expect(w.argv.filter(argv => argv[0] !== 'node')).toEqual([])
    expect(w.toasts.length).toBe(1)
  })

  test('with Node 20: one lookup, the same warning and refusal', { options: PLUGIN_OPTIONS }, async ($, on) => {
    const w = world(on, 'node', 'real', 'v20.18.1\n')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)).toEqual([['node', '--version']])
    expect(probes(w)).toEqual([])
    expect(w.toasts).toEqual([`Node helper \u00B7 session-control ${NODE_WARNING}`])
    expect(await answerOf($, 'list_sessions')).toEqual({ text: NODE_REFUSAL, isRefused: true })
  })

  test('nodePath names the executable, a leading ~/ the home directory', { options: { ...PLUGIN_OPTIONS, nodePath: '~/node/bin/node' } }, async ($, on) => {
    const w = world(on, '/m/home/node/bin/node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)[0]).toEqual(['/m/home/node/bin/node', '--version'])
    expect(probes(w).every(argv => argv[0] === '/m/home/node/bin/node')).toBe(true)
  })

  test('a nodePath that is not there: one lookup of it, then the warning and the refusal', { options: { ...PLUGIN_OPTIONS, nodePath: '/opt/none/node' } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)).toEqual([['/opt/none/node', '--version']])
    expect(probes(w)).toEqual([])
    expect(w.toasts).toEqual([`Node helper \u00B7 session-control ${NODE_WARNING}`])
    expect(await answerOf($, 'audit_state')).toEqual({ text: NODE_REFUSAL, isRefused: true })
  })

  // 20 minutes of traced poll ticks on the mocked clock: about 1 s alone, but up to 5 s (the kit's default limit) while
  // the suite's other files run beside it, on main too; the limit is raised, the assertions are as they were.
  test('no Node at the start, installed later: the mock clock\'s ticks look again after 10 minutes, the helper takes over, one trace line per change', { options: { ...PLUGIN_OPTIONS, debug: true }, timeoutMs: 15_000 }, async ($, on) => {
    const w = world(on, 'node', 'real', null)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const versions = () => nodeRuns(w).filter(argv => argv[1] === '--version').length
    expect(versions()).toBe(1)
    // Five minutes of poll ticks: no probe, no lookup, no trace written (its lines wait for Node).
    await w.clock.advance(300_000)
    expect(versions()).toBe(1)
    expect(probes(w)).toEqual([])
    expect(w.sim.files.has('/m/home/.claude/session-control/runs/trace.log')).toBe(false)
    // Node is installed; at the first tick 10 minutes after the lookup it is found and runs the probe from then on.
    w.sim.version = 'v24.14.0\n'
    await w.clock.advance(300_000)
    expect(versions()).toBe(2)
    expect(probes(w).length).toBeGreaterThan(0)
    expect(probes(w).every(argv => argv[0] === 'node')).toBe(true)
    await w.clock.advance(600_000)
    expect(versions()).toBe(2)
    const trace = (w.sim.files.get('/m/home/.claude/session-control/runs/trace.log') ?? '').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(trace.filter(line => line.event === 'helper').map(({ ts: _ts, seq: _seq, ...rest }) => rest)).toEqual([
      { event: 'helper', isActive: false, reason: 'not-found' },
      { event: 'helper', isActive: true, version: 'v24.14.0' },
    ])
    expect(trace.filter(line => line.event === 'helper.failed')).toEqual([])
  })

  test('a helper call that fails: a helper.failed trace line with the operation and the code, no toast of its own; the failed probe is a tracking problem', { options: { ...PLUGIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on, 'node', (op, request) => {
      if (op === 'probe') return ran('{"ok":false,"code":"ACCESS"}', 1)
      const answer = helperAnswer(w.sim.files, op, request)
      return ran(JSON.stringify(answer), answer.ok === true ? 0 : 1)
    })
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    await w.clock.advance(5000)
    const trace = (w.sim.files.get('/m/home/.claude/session-control/runs/trace.log') ?? '').trimEnd().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    const lines = trace.filter(line => line.event === 'helper.failed')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every(line => Object.keys(line).sort().join() === 'code,event,op,seq,ts' && line.op === 'probe' && line.code === 'ACCESS')).toBe(true)
    expect(w.toasts).toEqual(['Tracking problem \u00B7 Error: the process probe failed (ACCESS)'])
  })

  test('the trace shows the helper in use: its detection line and each call by operation and path, never the request', { options: { ...PLUGIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = w.sim.files.get('/m/home/.claude/session-control/runs/trace.log') ?? ''
    const trace = text.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(trace.find(line => line.event === 'helper')).toMatchObject({ isActive: true, version: 'v24.14.0' })
    expect(trace.filter(line => line.event === 'process.run' && line.helper === 'probe').length).toBeGreaterThan(0)
    expect(trace.filter(line => line.event === 'helper.failed')).toEqual([])
    expect(trace.every(line => line.event !== 'process.run' || !('argv' in line) || !String(line.argv).includes('helper'))).toBe(true)
  })
})

// ---------------------------------------------------------------- hashTrees (the drift band, feature/drift-digest)

describe('withHelper: hashTrees', () => {
  const SPEC = { dirs: ['hooks', 'helper', 'types'], files: ['.claude-plugin/plugin.json'] }
  /** The two mod folders of the simulated machine, alike but for hooks/b.ts; the port also tells a folder by what is under it. */
  function trees(sim: Sim): HostPort {
    for (const root of ['/m/loaded', '/m/source']) {
      sim.files.set(`${root}/hooks/a.ts`, 'a\n')
      sim.files.set(`${root}/types/index.d.ts`, 't\n')
      sim.files.set(`${root}/.claude-plugin/plugin.json`, '{}\n')
      sim.files.set(`${root}/tests/x.test.ts`, root)
    }
    sim.files.set('/m/loaded/hooks/b.ts', 'b1\n')
    sim.files.set('/m/source/hooks/b.ts', 'b2\n')
    const base = portOf(sim)
    return {
      ...base,
      stat: async path => {
        const key = keyOf(path).replace(/\/+$/, '')
        if ([...sim.files.keys()].some(one => one.startsWith(`${key}/`))) return { kind: 'dir', size: 0, mtimeMs: NOW_MS, isLink: false } as never
        return base.stat(path)
      },
    }
  }

  test('one helper batch hashes both folders with the same method, at the listing\'s 30 s limit; no fallback', async () => {
    const sim = machine()
    const port = trees(sim)
    const timeouts: (number | undefined)[] = []
    const timed: HostPort = { ...port, run: (argv, init, isQuiet, shown) => (timeouts.push(init?.timeoutMs), port.run(argv, init, isQuiet, shown)) }
    const found = await helped().hashTrees(timed, ['/m/loaded', '/m/source'], SPEC)
    expect(found?.map(one => one.method)).toEqual(['sha256', 'sha256'])
    expect(Object.keys(found?.[0]?.files ?? {})).toEqual(['.claude-plugin/plugin.json', 'hooks/a.ts', 'hooks/b.ts', 'types/index.d.ts'])
    expect(found?.[0]?.files['hooks/a.ts']).toBe(found?.[1]?.files['hooks/a.ts'])
    expect(found?.[0]?.files['hooks/b.ts']).not.toBe(found?.[1]?.files['hooks/b.ts'])
    expect(calls(sim)).toEqual([{ op: 'batch', request: { ops: ['/m/loaded', '/m/source'].map(root => ({ op: 'hashTree', root, dirs: SPEC.dirs, files: SPEC.files })) } }])
    expect(timeouts).toEqual([5_000, 30_000])
    expect(failures(sim)).toEqual([])
  })

  for (const code of ['NOT_FOUND', 'NOT_DIR', 'TOO_LARGE', 'ACCESS', 'IO']) {
    test(`a ${code} from the helper is the answer: nothing compared, no native hash, no fallback note`, async () => {
      const sim = machine(() => ran(`{"ok":false,"code":"${code}","at":1,"results":[]}`, 1))
      const port = trees(sim)
      expect(await helped().hashTrees(port, ['/m/loaded', '/m/source'], SPEC)).toBeUndefined()
      expect(failures(sim)).toEqual([{ kind: 'failed', op: 'hashTree', code, isQuiet: false }])
      expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    })
  }

  test('a helper that cannot hash (node not starting, a timeout, no answer, an older helper, a wrong shape): nothing compared, told by its code', async () => {
    for (const [answering, code] of [
      ['spawn', 'SPAWN'],
      ['timeout', 'TIMEOUT'],
      [() => ran('', 1, 'Error: Cannot find module'), 'BAD_JSON'],
      [() => ran('{"ok":false,"code":"BAD_OP","at":0,"results":[]}', 1), 'BAD_OP'],
      [() => ran('{"ok":true,"results":[{"ok":true,"files":[{"path":"a","sha256":"x"}]},{"ok":true,"files":[]}]}'), 'BAD_ANSWER'],
    ] as const) {
      const sim = machine(answering)
      const port = trees(sim)
      expect(await helped().hashTrees(port, ['/m/loaded', '/m/source'], SPEC)).toBeUndefined()
      expect(failures(sim)).toEqual([{ kind: 'failed', op: 'hashTree', code, isQuiet: false }])
      expect(sim.runs.filter(one => one.argv[0] !== NODE)).toEqual([])
    }
  })

  test('on Windows the helper hashes too (node.exe takes the same request)', async () => {
    const sim = machine()
    const port = trees(sim)
    expect((await helped(windowsHost).hashTrees(port, ['/m/loaded', '/m/source'], SPEC))?.map(one => one.method)).toEqual(['sha256', 'sha256'])
    expect(calls(sim).map(one => one.op)).toEqual(['batch'])
  })

  test('treeAnswer: an array of path and 64-digit hex sha256 pairs, nothing else', () => {
    const digest = 'a'.repeat(64)
    expect(treeAnswer({ files: [{ path: 'hooks/a.ts', sha256: digest }], total: 1 })).toEqual({ method: 'sha256', files: { 'hooks/a.ts': digest } })
    expect(treeAnswer({ files: [{ path: 'hooks/a.ts', sha256: 'A'.repeat(64) }] })).toBeUndefined()
    expect(treeAnswer({ files: [{ path: 'hooks/a.ts', sha256: digest.slice(1) }] })).toBeUndefined()
    expect(treeAnswer({ files: [{ path: 1, sha256: digest }] })).toBeUndefined()
    expect(treeAnswer({ files: 'x' })).toBeUndefined()
    expect(treeAnswer(null)).toBeUndefined()
  })
})
