// The Node helper behind the host interface (hooks/host-helper.ts): its answers read, each operation sent as one
// request, every failure falling back to the adapter's own operation for that call, the batch's order, Node looked for
// once, and the helper and nodePath options through the plugin. The helper itself is tested by tests/helper.test.mjs
// under `node --test`; here it is simulated over a map of files, as the adapters' commands are.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { parseProcFacts, tailLines } from '../hooks/core'
import type { Host, HostPort, RotatePlan } from '../hooks/host'
import { CALL_CODES, HELPER_MIN_NODE, appendNotRepeated, appendText, fallbackFields, fallbackToast, nodeMajor, readAnswer, rejectionCode, withHelper } from '../hooks/host-helper'
import type { HelperNote } from '../hooks/host-helper'
import { APPEND_SCRIPT, PROBE_SCRIPT, ROTATE_SCRIPT, posixHost } from '../hooks/host-posix'
import { FILES_PS1, PROBE_PS1, windowsHost } from '../hooks/host-windows'
import { helperAnswer as fakeHelper } from './fake-helper'
import { NOW_MS } from './fixtures'

const ran = (stdout = '', exitCode = 0, stderr = '', isStdoutTruncated = false): ProcessRunResult => ({ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated: false })

const NODE = '/m/node/bin/node'
const SCRIPT = '/m/mod/helper/host.mjs'
const SID = '11111111-2222-4333-8444-555555555555'
/** What the helper's probe and the shell probe print on the simulated machine (one worker, one transcript). */
const PROBE_OUT = `P\t4242\tclaude\t3\t/m/work\t/m/cfg\tclaude -p --model opus -- Goal: x \nA\t4242\tclaude\t123\t123\t${SID}\nT\t${SID}\t1700000000\n`
const WIN_PROBE_OUT = `P\t4242\tclaude\t3\tC:\\m\\work\tC:\\m\\cfg\tclaude.exe -p\r\n`

type Request = Record<string, unknown>
/** How the simulated helper answers: as the real one does, or a failure of a given kind. */
type Answering = 'real' | 'spawn' | 'timeout' | ((op: string, request: Request) => ProcessRunResult)

type Run = { argv: string[]; stdin?: string; isQuiet?: boolean; shown?: Record<string, unknown> }

type Sim = {
  files: Map<string, string>
  runs: Run[]
  notes: HelperNote[]
  /** What `node --version` prints; null: node cannot start. */
  version: string | null
  answering: Answering
}

/** A path as the adapters give it (C:\x and C:/x alike). */
const keyOf = (path: string) => path.replace(/\\/g, '/')

const move = (files: Map<string, string>, from: string, to: string) => {
  const text = files.get(keyOf(from))
  if (text === undefined) return false
  files.set(keyOf(to), text)
  files.delete(keyOf(from))
  return true
}

/** The helper's operations over the map of files (tests/fake-helper.ts), its probe printing PROBE_OUT. */
const helperAnswer = (files: Map<string, string>, op: string, request: Request) => fakeHelper(files, op, request, PROBE_OUT)

/** The simulated machine: the adapters' own commands (sh, mv, rm, PowerShell's scripts) and node, answered as the system would. */
function machine(answering: Answering = 'real', version: string | null = 'v24.14.0\n'): Sim {
  return { files: new Map(), runs: [], notes: [], version, answering }
}

function runOn(sim: Sim, argv: readonly string[], stdin?: string): ProcessRunResult {
  const [cmd, , script] = argv
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
    const answer = helperAnswer(sim.files, op, request)
    return ran(JSON.stringify(answer), answer.ok === true ? 0 : 1)
  }
  if (cmd === 'mv') return move(sim.files, argv[2] ?? '', argv[3] ?? '') ? ran() : ran('', 1, 'mv: cannot stat')
  if (cmd === 'rm') {
    sim.files.delete(keyOf(argv[2] ?? ''))
    return ran()
  }
  if (cmd === 'sh' && script === PROBE_SCRIPT) return ran(PROBE_OUT)
  if (cmd === 'sh' && script === APPEND_SCRIPT) {
    const path = keyOf(argv[5] ?? '')
    sim.files.set(path, `${sim.files.get(path) ?? ''}${argv[4]}\n`)
    return ran()
  }
  if (cmd === 'sh' && script?.startsWith('tail -n 600 ')) {
    const text = sim.files.get(keyOf(argv[4] ?? ''))
    return text === undefined ? ran('', 1) : ran(tailLines(text, 600, 20000))
  }
  if (cmd === 'sh' && script === ROTATE_SCRIPT) {
    const path = argv[4] ?? ''
    move(sim.files, `${path}.1`, `${path}.2`)
    move(sim.files, path, `${path}.1`)
    return ran()
  }
  if (cmd?.endsWith('\\powershell.exe') && argv[6]?.endsWith('/files.ps1')) {
    const [op, a = '', b = ''] = argv.slice(7)
    if (op === 'move') return move(sim.files, a, b) ? ran() : ran('', 1, 'not found')
    if (op === 'remove') {
      sim.files.delete(keyOf(a))
      return ran()
    }
    if (op === 'append') {
      sim.files.set(keyOf(b), `${sim.files.get(keyOf(b)) ?? ''}${sim.files.get(keyOf(a)) ?? ''}`)
      sim.files.delete(keyOf(a))
      return ran()
    }
    if (op === 'tail') {
      const text = sim.files.get(keyOf(a))
      return text === undefined ? ran('', 1, 'not found') : ran(tailLines(text, 600, 20000))
    }
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
    now: async () => NOW_MS,
    sleep: async () => undefined,
    env: async name => (name === 'SystemRoot' ? 'C:\\Windows' : '/m/home'),
    runsDir: async () => '/m/runs',
    traceError: () => undefined,
    noteDirectWrite: () => undefined,
    noteHelper: note => {
      sim.notes.push(note)
    },
  }
}

const helped = (base: Host = posixHost) => withHelper(base, { node: NODE, script: SCRIPT })
/** The helper calls made, with their requests. */
const calls = (sim: Sim) => sim.runs.filter(one => one.argv[0] === NODE && one.argv[1] === SCRIPT).map(one => ({ op: one.argv[2], request: JSON.parse(one.stdin ?? '') as Request }))
const lookups = (sim: Sim) => sim.runs.filter(one => one.argv[0] === NODE && one.argv[1] === '--version')
const fallbacks = (sim: Sim) => sim.notes.filter(note => note.kind === 'fallback')
const PLAN: RotatePlan = { path: '/m/runs/trace.log', adding: 10, keep: 3, maxBytes: 8, moves: [['/m/runs/trace.log.1', '/m/runs/trace.log.2'], ['/m/runs/trace.log', '/m/runs/trace.log.1']] }

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
    await host.renameOver(port, '/m/a.tmp', '/m/a', 'A')
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
    expect(fallbacks(sim)).toEqual([])
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
    // A timeout is the one failure after which the helper may have written: the append and the trace's batch are not
    // made again (appendNotRepeated), every other operation falls back as with any failure.
    const isTimeout = code === 'TIMEOUT'
    const title = isTimeout ? 'every operation but the appends falls back' : 'every operation falls back'
    test(`${name}: ${title} to the adapter's own, with the code ${code} and nothing else`, async () => {
      const sim = machine(answering)
      SIM_FILES.files = sim.files
      const host = helped()
      const port = portOf(sim)
      sim.files.set('/m/reg.json', '[]\n')
      sim.files.set('/m/a.tmp', 'A')
      sim.files.set('/m/gone', 'x')
      sim.files.set('/m/runs/t.jsonl', 'a\nb\n')
      sim.files.set('/m/runs/trace.log', 'old\n')

      expect(await host.probe(port, [])).toEqual(parseProcFacts(PROBE_OUT))
      expect(await host.writeAtomic(port, '/m/reg.json', '[1]\n', '[]\n')).toBe(true)
      await host.renameOver(port, '/m/a.tmp', '/m/a', 'A')
      expect(await host.removeFile(port, '/m/gone')).toBe(true)
      const codes: number[] = []
      expect(await host.append(port, '/m/runs/log.jsonl', ['x'], false, exit => codes.push(exit))).toBeUndefined()
      expect(await host.tail(port, '/m/runs/t.jsonl')).toBe('a\nb\n')
      await host.rotate(port, PLAN)
      expect(await host.rotateAndAppend(port, '/m/runs/trace.log', ['new'])).toBeUndefined()

      const ops = ['probe', 'writeAtomic', 'renameOver', 'removeFile', 'append', 'tail', 'rotate', 'batch']
      const isRenamed = name.includes('without the fields')
      // Each call tried the helper first, and fell back for that call alone.
      expect(calls(sim).map(one => one.op)).toEqual(ops)
      const quiet = ['rotate', 'batch']
      const unrepeated = (op: string) => (isTimeout && ['append', 'batch'].includes(op) ? { isRepeated: false } : {})
      expect(fallbacks(sim)).toEqual(ops.filter(op => !(isRenamed && op === 'renameOver')).map(op => ({ kind: 'fallback', op, code, isQuiet: quiet.includes(op), ...unrepeated(op) })))
      const adapter = [PROBE_SCRIPT, 'mv', 'mv', 'rm', APPEND_SCRIPT, 'tail -n 600 "$1" | cut -c1-20000', ROTATE_SCRIPT, APPEND_SCRIPT]
      const ran = (isRenamed ? adapter.filter((_, at) => at !== 2) : adapter).filter(one => !(isTimeout && one === APPEND_SCRIPT))
      expect(sim.runs.filter(one => one.argv[0] !== NODE).map(one => (one.argv[0] === 'sh' ? one.argv[2] : one.argv[0]))).toEqual(ran)
      // The adapter did the work: the files are as the helper would have left them (the simulated timeout wrote nothing,
      // and nothing appended it again).
      expect([sim.files.get('/m/reg.json'), sim.files.get('/m/a'), sim.files.has('/m/gone'), sim.files.get('/m/runs/log.jsonl')]).toEqual(['[1]\n', 'A', false, isTimeout ? undefined : 'x\n'])
      expect([sim.files.get('/m/runs/trace.log.1'), sim.files.get('/m/runs/trace.log')]).toEqual(['old\n', isTimeout ? undefined : 'new\n'])
      expect(codes).toEqual(isTimeout ? [] : [0])
      // A note holds an operation and a code only.
      expect(sim.notes.every(note => Object.keys(note).every(key => ['kind', 'op', 'code', 'isQuiet', 'isRepeated', 'isActive', 'version'].includes(key)))).toBe(true)
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

  test('an append that timed out after writing is not made again: one line in the log, a note that says so, no exit code', async () => {
    const sim = machine('real')
    sim.answering = writesThenTimesOut(sim)
    const port = portOf(sim)
    sim.files.set('/m/runs/cleared.jsonl', 'old\n')
    const codes: number[] = []
    expect(await helped().append(port, '/m/runs/cleared.jsonl', ['{"session_id":"x"}'], false, exit => codes.push(exit))).toBeUndefined()
    expect(sim.files.get('/m/runs/cleared.jsonl')).toBe('old\n{"session_id":"x"}\n')
    expect(sim.runs.filter(one => one.argv[0] === 'sh')).toEqual([])
    expect(codes).toEqual([])
    expect(fallbacks(sim)).toEqual([{ kind: 'fallback', op: 'append', code: 'TIMEOUT', isQuiet: false, isRepeated: false }])
  })

  test('the trace\'s batch that timed out after writing is not made again: rotated once, the lines once', async () => {
    const sim = machine('real')
    sim.answering = writesThenTimesOut(sim)
    const port = portOf(sim)
    sim.files.set('/m/runs/trace.log', 'old\n')
    expect(await helped().rotateAndAppend(port, '/m/runs/trace.log', ['new'], PLAN)).toBeUndefined()
    expect([sim.files.get('/m/runs/trace.log'), sim.files.get('/m/runs/trace.log.1'), sim.files.get('/m/runs/trace.log.2')]).toEqual(['new\n', 'old\n', undefined])
    expect(sim.runs.filter(one => one.argv[0] === 'sh')).toEqual([])
    expect(fallbacks(sim)).toEqual([{ kind: 'fallback', op: 'batch', code: 'TIMEOUT', isQuiet: true, isRepeated: false }])
  })

  test('an append that failed with nothing written (an exit code, no JSON, ok:false, Node not starting) still falls back: one line', async () => {
    const kinds: [string, Answering][] = [
      ['an exit code with no answer', () => ran('', 1)],
      ['an answer that is not JSON', () => ran('Segmentation fault', 139)],
      ['ok:false', () => ran('{"ok":false,"code":"NO_SPACE"}', 1)],
      ['Node not starting', 'spawn'],
    ]
    for (const [, answering] of kinds) {
      const sim = machine(answering)
      const codes: number[] = []
      expect(await helped().append(portOf(sim), '/m/runs/cleared.jsonl', ['{"session_id":"x"}'], false, exit => codes.push(exit))).toBeUndefined()
      expect(sim.files.get('/m/runs/cleared.jsonl')).toBe('{"session_id":"x"}\n')
      expect(sim.runs.filter(one => one.argv[0] === 'sh').map(one => one.argv[2])).toEqual([APPEND_SCRIPT])
      expect(codes).toEqual([0])
      expect(fallbacks(sim).map(note => 'isRepeated' in note)).toEqual([false])
    }
    // What the trace line and the toast say (register.tsx's noteHelper writes them).
    expect(fallbackFields({ kind: 'fallback', op: 'append', code: 'TIMEOUT', isQuiet: false, isRepeated: false })).toEqual({ op: 'append', code: 'TIMEOUT', isRepeated: false })
    expect(fallbackFields({ kind: 'fallback', op: 'append', code: 'SPAWN', isQuiet: false })).toEqual({ op: 'append', code: 'SPAWN' })
    expect(fallbackToast({ kind: 'fallback', op: 'append', code: 'TIMEOUT', isQuiet: false, isRepeated: false })).toBe('helper fallback: append (timed out, not repeated)')
    expect(fallbackToast({ kind: 'fallback', op: 'probe', code: 'ACCESS', isQuiet: false })).toBe('helper fallback: probe')
    expect([appendNotRepeated({ code: 'TIMEOUT' }), ...['SPAWN', 'BAD_JSON', 'TRUNCATED', 'BAD_ANSWER', 'NO_SPACE', 'IO'].map(code => appendNotRepeated({ code }))]).toEqual([true, false, false, false, false, false, false])
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

  test('a batch that failed after its rotation falls back to the append alone: the trace is never rotated twice', async () => {
    const sim = machine((op, request) => {
      // The rotation goes through, the append fails.
      const steps = request.ops as Request[]
      helperAnswer(sim.files, 'rotate', steps[0] ?? {})
      return ran(JSON.stringify({ ok: false, code: 'NO_SPACE', at: 1, results: [{ ok: true, rotated: true }] }), 1)
    })
    const port = portOf(sim)
    sim.files.set('/m/runs/trace.log', 'old\n')
    sim.files.set('/m/runs/trace.log.1', 'older\n')
    expect(await helped().rotateAndAppend(port, '/m/runs/trace.log', ['new'], PLAN)).toBeUndefined()
    expect(sim.runs.filter(one => one.argv[0] === 'sh').map(one => one.argv[2])).toEqual([APPEND_SCRIPT])
    expect([sim.files.get('/m/runs/trace.log'), sim.files.get('/m/runs/trace.log.1'), sim.files.get('/m/runs/trace.log.2')]).toEqual(['new\n', 'old\n', 'older\n'])
    expect(fallbacks(sim)).toEqual([{ kind: 'fallback', op: 'batch', code: 'NO_SPACE', isQuiet: true }])
  })

  test('a batch that failed at its rotation falls back to the rotation and the append', async () => {
    const sim = machine(() => ran(JSON.stringify({ ok: false, code: 'ACCESS', at: 0, results: [] }), 1))
    const port = portOf(sim)
    sim.files.set('/m/runs/trace.log', 'old\n')
    await helped().rotateAndAppend(port, '/m/runs/trace.log', ['new'], PLAN)
    expect(sim.runs.filter(one => one.argv[0] === 'sh').map(one => one.argv[2])).toEqual([ROTATE_SCRIPT, APPEND_SCRIPT])
    expect([sim.files.get('/m/runs/trace.log'), sim.files.get('/m/runs/trace.log.1')]).toEqual(['new\n', 'old\n'])
  })

  const NO_NODE: [string, string | null, Record<string, unknown>][] = [
    ['no Node', null, { kind: 'node', isActive: false, reason: 'not-found' }],
    ['Node 20', 'v20.18.1\n', { kind: 'node', isActive: false, version: 'v20.18.1', reason: 'too-old' }],
    ['Node 21', 'v21.7.3\n', { kind: 'node', isActive: false, version: 'v21.7.3', reason: 'too-old' }],
    ['a node that prints no version', 'hello\n', { kind: 'node', isActive: false, reason: 'version-unreadable' }],
  ]
  for (const [name, version, note] of NO_NODE) {
    test(`${name}: the adapter's own operations for the whole load, one lookup, one note and no fallback`, async () => {
      const sim = machine('real', version)
      const host = helped()
      const port = portOf(sim)
      sim.files.set('/m/reg.json', '[]\n')
      await host.probe(port, [])
      expect(await host.writeAtomic(port, '/m/reg.json', '[1]\n', '[]\n')).toBe(true)
      await host.append(port, '/m/log', ['x'], false, () => undefined)
      await host.rotateAndAppend(port, '/m/log', ['y'])
      expect(lookups(sim).length).toBe(1)
      expect(calls(sim)).toEqual([])
      expect(sim.notes).toEqual([note])
      expect(sim.files.get('/m/log')).toBe('x\ny\n')
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

  test('the other members are the adapter\'s own', () => {
    const host = helped()
    for (const name of ['homeDir', 'launchCommand', 'findNewWorker', 'launchChecks', 'createFile', 'makeDir', 'pause'] as const) expect(host[name]).toBe(posixHost[name])
    expect(host.platform).toBe('linux')
  })
})

describe('withHelper on Windows', () => {
  test('the probe stays PROBE_PS1; the file operations go through the helper; a tail under the read cap is read in the engine', async () => {
    const sim = machine()
    const host = helped(windowsHost)
    const port = portOf(sim, 100)
    sim.files.set('C:/m/reg.json', '[]\n')
    sim.files.set('C:/m/t.jsonl', 'a\nb\n')
    sim.files.set('C:/m/big.jsonl', `${'x'.repeat(120)}\nlast\n`)
    const facts = await host.probe(port, [{ pid: 4242, session_id: SID, config_dir: 'C:/m/cfg' }], ['C:/m/cfg'])
    expect(facts.claude.map(one => one.pid)).toEqual([4242])
    expect(sim.runs[0]?.argv[6]).toBe('/m/runs/probe.ps1')
    expect(sim.files.get('/m/runs/probe.ps1')).toBe(PROBE_PS1)
    expect(await host.writeAtomic(port, 'C:/m/reg.json', '[1]\n', '[]\n')).toBe(true)
    expect(await host.tail(port, 'C:/m/t.jsonl')).toBe('a\nb\n')
    expect(await host.tail(port, 'C:/m/big.jsonl')).toBe(`${'x'.repeat(120)}\nlast\n`)
    expect(calls(sim)).toEqual([
      { op: 'writeAtomic', request: { path: 'C:/m/reg.json', text: '[1]\n', expected: '[]\n' } },
      { op: 'tail', request: { path: 'C:/m/big.jsonl', lines: 600, width: 20000 } },
    ])
    // No PowerShell file script ran: one Node start per file operation instead.
    expect(sim.runs.filter(one => String(one.argv[6]).endsWith('/files.ps1'))).toEqual([])
  })

  test('a failed helper call falls back to the file script', async () => {
    const sim = machine('spawn')
    const host = helped(windowsHost)
    const port = portOf(sim)
    sim.files.set('C:/m/reg.json', '[]\n')
    expect(await host.writeAtomic(port, 'C:/m/reg.json', '[1]\n', '[]\n')).toBe(true)
    await host.append(port, 'C:/m/log', ['x'], false, () => undefined)
    expect(sim.files.get('C:/m/reg.json')).toBe('[1]\n')
    expect(sim.files.get('C:/m/log')).toBe('x\n')
    expect(sim.files.get('/m/runs/files.ps1')).toBe(FILES_PS1)
    expect(fallbacks(sim)).toEqual([
      { kind: 'fallback', op: 'writeAtomic', code: 'SPAWN', isQuiet: false },
      { kind: 'fallback', op: 'append', code: 'SPAWN', isQuiet: false },
    ])
  })
})

// ---------------------------------------------------------------- the options, through the plugin on the mock engine

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
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.argv.push(argv)
    // The plugin's own node and helper path, in the simulated machine's names.
    const isNode = node !== undefined && argv[0] === node
    const mapped = isNode ? [NODE, argv[1]?.endsWith('/helper/host.mjs') ? SCRIPT : String(argv[1]), ...argv.slice(2)] : argv
    if (mapped[0] === 'test') return { value: ran('', sim.files.has(String(mapped[2])) ? 0 : 1) }
    if (mapped[0] === 'mkdir') return { value: ran() }
    if (!isNode && /(^|\/)node$/.test(String(argv[0]))) throw new Error(`spawn ${argv[0]} ENOENT`)
    return { value: runOn(sim, mapped, e.init?.stdin) }
  })
  return w
}

const nodeRuns = (w: World) => w.argv.filter(argv => /(^|\/)node$/.test(String(argv[0])))
const probes = (w: World) => w.argv.filter(argv => argv[2] === PROBE_SCRIPT || argv[2] === 'probe')

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

  test('off: the adapters\' own operations, and Node is never looked for', { options: { ...PLUGIN_OPTIONS, helper: 'off' } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)).toEqual([])
    expect(probes(w).every(argv => argv[0] === 'sh' && argv[2] === PROBE_SCRIPT)).toBe(true)
    expect(probes(w).length).toBeGreaterThan(0)
  })

  test('an unknown value is auto', { options: { ...PLUGIN_OPTIONS, helper: 'sometimes' } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(probes(w).every(argv => argv[0] === 'node')).toBe(true)
  })

  test('auto without Node: one lookup, the adapters\' own operations, no error and no toast', { options: PLUGIN_OPTIONS }, async ($, on) => {
    const w = world(on, undefined)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)).toEqual([['node', '--version']])
    expect(probes(w).every(argv => argv[0] === 'sh')).toBe(true)
    expect(w.toasts).toEqual([])
  })

  test('auto with Node 20: one lookup, the adapters\' own operations', { options: PLUGIN_OPTIONS }, async ($, on) => {
    const w = world(on, 'node', 'real', 'v20.18.1\n')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)).toEqual([['node', '--version']])
    expect(probes(w).every(argv => argv[0] === 'sh')).toBe(true)
  })

  test('nodePath names the executable, a leading ~/ the home directory', { options: { ...PLUGIN_OPTIONS, nodePath: '~/node/bin/node' } }, async ($, on) => {
    const w = world(on, '/m/home/node/bin/node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)[0]).toEqual(['/m/home/node/bin/node', '--version'])
    expect(probes(w).every(argv => argv[0] === '/m/home/node/bin/node')).toBe(true)
  })

  test('a nodePath that is not there: no helper, the adapters\' own operations', { options: { ...PLUGIN_OPTIONS, nodePath: '/opt/none/node' } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    expect(nodeRuns(w)).toEqual([['/opt/none/node', '--version']])
    expect(probes(w).every(argv => argv[0] === 'sh')).toBe(true)
  })

  test('helper failures: a helper.fallback trace line each, with the operation and the code, and one toast for the load', { options: { ...PLUGIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on, 'node', () => ran('{"ok":false,"code":"ACCESS"}', 1))
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    // Two poll ticks: more helper calls, more fallbacks.
    await w.clock.advance(5000)
    await w.clock.advance(5000)
    const trace = (w.sim.files.get(`/m/home/.claude/session-control/runs/trace.log`) ?? '').trimEnd().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
    const lines = trace.filter(line => line.event === 'helper.fallback')
    expect(lines.length).toBeGreaterThan(1)
    // The trace's own write fell back too (it is written by the adapter's append): traced once, not once per flush.
    expect(lines.filter(line => line.op === 'batch').length).toBe(1)
    expect(lines.filter(line => line.op === 'probe').length).toBeGreaterThan(1)
    expect(lines.every(line => Object.keys(line).sort().join() === 'code,event,op,seq,ts' && line.code === 'ACCESS')).toBe(true)
    expect(trace.find(line => line.event === 'helper')).toMatchObject({ event: 'helper', isActive: true, version: 'v24.14.0' })
    expect(w.toasts).toEqual([`Node helper \u00B7 helper fallback: ${String(lines[0]?.op)}`])
  })

  test('the trace shows the helper in use: its detection line and each call by operation and path, never the request', { options: { ...PLUGIN_OPTIONS, debug: true } }, async ($, on) => {
    const w = world(on, 'node')
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const text = w.sim.files.get('/m/home/.claude/session-control/runs/trace.log') ?? ''
    const trace = text.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(trace.find(line => line.event === 'helper')).toMatchObject({ isActive: true, version: 'v24.14.0' })
    expect(trace.filter(line => line.event === 'process.run' && line.helper === 'probe').length).toBeGreaterThan(0)
    expect(trace.filter(line => line.event === 'helper.fallback')).toEqual([])
    expect(trace.every(line => line.event !== 'process.run' || !('argv' in line) || !String(line.argv).includes('helper'))).toBe(true)
  })
})
