import { describe, expect, test } from 'claude-code/testing'

import { APPEND_SCRIPT, FILES_PS1, PROBE_SCRIPT } from '../hooks/core'
import {
  REDACTED,
  ROTATE_SCRIPT,
  TRACE_CHUNK_BYTES,
  TRACE_KEEP,
  TRACE_MAX_BYTES,
  TRACE_MAX_STRING,
  chunkLines,
  isTraceSwitch,
  localIso,
  needsRotation,
  redact,
  redactValue,
  rotationMoves,
  shownArgv,
  traceLine,
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
    expect(shownArgv(['powershell.exe', '-File', 'C:/r/files.ps1', 'append', 'C:/r/a', 'C:/r/b'])).toEqual(['powershell.exe', '-File', 'C:/r/files.ps1', 'append', 'C:/r/a', 'C:/r/b'])
    expect(shownArgv([FILES_PS1])).toEqual(['<FILES_PS1>'])
    expect(shownArgv(['test', '-s', '/work/new/prompt.md'])).toEqual(['test', '-s', '/work/new/prompt.md'])
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
