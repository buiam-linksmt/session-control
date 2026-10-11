// The Node helper (mod/helper/host.mjs) as a process, the way the mod runs it: `node host.mjs <op>`, one JSON request
// on stdin, one JSON answer on stdout. Run with `node --test mod/tests/helper.test.mjs` (Node 22 or newer). The probe
// is checked against the lines recorded over a fake /proc tree.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = join(HERE, '..', 'helper', 'host.mjs')
const IS_LINUX = process.platform === 'linux'
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0
/** Node strips the types of a .ts file by itself (Node 23.6 or newer, or 22 with the flag): the fixtures and core.ts load as they are. */
const HAS_TS = Boolean(process.features?.typescript)

/** One helper run: the answer parsed, the exit code and the raw stdout. */
function helper(op, request, env = {}) {
  const input = typeof request === 'string' || Buffer.isBuffer(request) ? request : JSON.stringify(request)
  const ran = spawnSync(process.execPath, [HOST, op], { input, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  const stdout = ran.stdout.toString('utf8')
  return { answer: JSON.parse(stdout), code: ran.status, stdout, stderr: ran.stderr.toString('utf8') }
}

/** The same run, not waited for. */
function helperAsync(op, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST, op])
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('error', reject)
    child.on('close', code => resolve({ answer: JSON.parse(out), code }))
    child.stdin.end(JSON.stringify(request))
  })
}

const scratch = () => fs.mkdtempSync(join(tmpdir(), 'sc-helper-test-'))
const FIXED = new Set(['ok', 'code', 'at', 'results'])

/** A failure answer holds its code (and a batch's position) only: no message, path or content. */
function assertFailure(run, code, dir) {
  assert.equal(run.code, 1)
  assert.equal(run.answer.ok, false)
  assert.equal(run.answer.code, code)
  assert.ok(Object.keys(run.answer).every(key => FIXED.has(key)), run.stdout)
  if (dir !== undefined) assert.ok(!run.stdout.includes(dir), run.stdout)
  assert.equal(run.stderr, '')
}

test('protocol: an unknown operation, a request that is not a JSON object, a missing field, a request too large', () => {
  const dir = scratch()
  try {
    assertFailure(helper('nonsense', {}), 'BAD_OP')
    assertFailure(helper('', {}), 'BAD_OP')
    assertFailure(helper('toString', {}), 'BAD_OP')
    assertFailure(helper('append', 'not json at all'), 'BAD_REQUEST')
    assertFailure(helper('append', '[1,2]'), 'BAD_REQUEST')
    assertFailure(helper('append', 'null'), 'BAD_REQUEST')
    assertFailure(helper('append', ''), 'BAD_REQUEST')
    assertFailure(helper('append', { path: join(dir, 'x') }), 'BAD_REQUEST')
    assertFailure(helper('append', { path: '', text: 'x' }), 'BAD_REQUEST')
    assertFailure(helper('append', { path: `${dir}/a\u0000b`, text: 'x' }), 'BAD_REQUEST')
    assertFailure(helper('tail', { path: join(dir, 'x'), lines: 0, width: 10 }), 'BAD_REQUEST')
    assertFailure(helper('tail', { path: join(dir, 'x'), lines: 1.5, width: 10 }), 'BAD_REQUEST')
    assertFailure(helper('rotate', { path: join(dir, 'x'), adding: 1, maxBytes: 1, moves: [['a']] }), 'BAD_REQUEST')
    assertFailure(helper('batch', { ops: 'append' }), 'BAD_REQUEST')
    assertFailure(helper('batch', { ops: [{ path: 'x' }] }), 'BAD_REQUEST')
    assertFailure(helper('append', Buffer.alloc(32 * 1024 * 1024 + 1, 0x20)), 'TOO_LARGE')
    assert.equal(fs.readdirSync(dir).length, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('protocol: a file-system failure is a fixed code, never the message (which names the path and can quote content)', () => {
  const dir = scratch()
  try {
    fs.writeFileSync(join(dir, 'file'), 'secret content line\n')
    assertFailure(helper('tail', { path: join(dir, 'missing.jsonl'), lines: 5, width: 10 }), 'NOT_FOUND', dir)
    // The directory to make is a file.
    assertFailure(helper('writeAtomic', { path: join(dir, 'file', 'under-a-file.json'), text: 'x' }), 'EXISTS', dir)
    assertFailure(helper('append', { path: join(dir, 'file', 'log'), text: 'x' }), 'EXISTS', dir)
    assertFailure(helper('removeFile', { path: join(dir, 'file', 'x') }), 'NOT_DIR', dir)
    assertFailure(helper('renameOver', { from: join(dir, 'missing.tmp'), to: join(dir, 'file') }), 'NOT_FOUND', dir)
    assertFailure(helper('tail', { path: dir, lines: 5, width: 10 }), 'IS_DIR', dir)
    if (IS_LINUX && process.getuid?.() !== 0) {
      fs.chmodSync(join(dir, 'file'), 0o000)
      const denied = helper('tail', { path: join(dir, 'file'), lines: 5, width: 10 })
      assertFailure(denied, 'ACCESS', dir)
      assert.ok(!denied.stdout.includes('secret'))
      fs.chmodSync(join(dir, 'file'), 0o600)
    }
    assert.equal(helper('probe', { args: [] }).answer.ok, IS_LINUX)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writeAtomic: a new file and its directory, a replaced file, a changed file left alone, no temp file left', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'deep', 'er', 'headless-sessions.json')
    assert.deepEqual(helper('writeAtomic', { path, text: '[]\n' }).answer, { ok: true, written: true })
    assert.equal(fs.readFileSync(path, 'utf8'), '[]\n')
    assert.deepEqual(helper('writeAtomic', { path, text: '[1]\n', expected: '[]\n' }).answer, { ok: true, written: true })
    assert.deepEqual(helper('writeAtomic', { path, text: '[2]\n', expected: '[]\n' }).answer, { ok: true, written: false })
    assert.equal(fs.readFileSync(path, 'utf8'), '[1]\n')
    assert.deepEqual(helper('writeAtomic', { path: join(dir, 'none.json'), text: 'x', expected: '' }).answer, { ok: true, written: false })
    assert.equal(fs.existsSync(join(dir, 'none.json')), false)
    const text = 'caf\u00e9 \u2615 \u{1F600}\r\nline two\n'
    helper('writeAtomic', { path, text })
    assert.equal(fs.readFileSync(path, 'utf8'), text)
    assert.deepEqual(fs.readdirSync(join(dir, 'deep', 'er')), ['headless-sessions.json'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writeAtomic: a rename that fails (the path is a directory) is IS_DIR and leaves no temp file beside it; the directory is untouched', () => {
  const dir = scratch()
  try {
    const target = join(dir, 'headless-sessions.json')
    fs.mkdirSync(target)
    fs.writeFileSync(join(target, 'inside.txt'), 'inside')
    assertFailure(helper('writeAtomic', { path: target, text: '[]\n' }), 'IS_DIR', dir)
    assert.deepEqual(fs.readdirSync(dir), ['headless-sessions.json'])
    // With `expected` the read right before the rename fails the same way, and the temp file goes too.
    assertFailure(helper('writeAtomic', { path: target, text: '[]\n', expected: '' }), 'IS_DIR', dir)
    assert.deepEqual(fs.readdirSync(dir), ['headless-sessions.json'])
    assert.deepEqual(fs.readdirSync(target), ['inside.txt'])
    assert.equal(fs.readFileSync(join(target, 'inside.txt'), 'utf8'), 'inside')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('writeAtomic: a reader never finds the file missing or half written while it is replaced', async () => {
  const dir = scratch()
  try {
    const path = join(dir, 'reg.json')
    const big = n => `${JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ n, i })))}\n`
    fs.writeFileSync(path, big(0))
    let isDone = false
    const seen = new Set()
    const reader = (async () => {
      while (!isDone) {
        const text = fs.readFileSync(path, 'utf8')
        JSON.parse(text)
        seen.add(text.length)
        await new Promise(resolve => setImmediate(resolve))
      }
    })()
    for (let n = 1; n <= 10; n++) assert.equal((await helperAsync('writeAtomic', { path, text: big(n) })).answer.written, true)
    isDone = true
    await reader
    assert.equal(fs.readFileSync(path, 'utf8'), big(10))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('renameOver: the temp file takes an existing file\'s place; removeFile: a file goes, a missing one is no failure', () => {
  const dir = scratch()
  try {
    fs.writeFileSync(join(dir, 'reg.json'), 'old')
    fs.writeFileSync(join(dir, 'reg.json.tmp.1'), 'new')
    assert.deepEqual(helper('renameOver', { from: join(dir, 'reg.json.tmp.1'), to: join(dir, 'reg.json') }).answer, { ok: true })
    assert.equal(fs.readFileSync(join(dir, 'reg.json'), 'utf8'), 'new')
    assert.deepEqual(fs.readdirSync(dir), ['reg.json'])
    fs.writeFileSync(join(dir, 'a b [1].tmp'), 'spaces')
    assert.equal(helper('renameOver', { from: join(dir, 'a b [1].tmp'), to: join(dir, 'reg [x].json') }).answer.ok, true)
    assert.equal(fs.readFileSync(join(dir, 'reg [x].json'), 'utf8'), 'spaces')
    assert.deepEqual(helper('removeFile', { path: join(dir, 'reg.json') }).answer, { ok: true, removed: true })
    assert.deepEqual(helper('removeFile', { path: join(dir, 'reg.json') }).answer, { ok: true, removed: false })
    assert.deepEqual(fs.readdirSync(dir), ['reg [x].json'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('removeFile with regularOnly: a regular file goes; a symbolic link (to a file, a directory, a missing target), a directory and a bad flag are refused with a fixed code and nothing is touched', () => {
  const dir = scratch()
  const outside = scratch()
  try {
    const runs = join(dir, 'runs')
    fs.mkdirSync(runs)
    fs.writeFileSync(join(outside, 'secret.txt'), 'outside file')
    fs.writeFileSync(join(runs, 'plain.json'), 'plain')
    fs.mkdirSync(join(runs, 'sub'))
    fs.writeFileSync(join(runs, 'sub', 'inner.txt'), 'inner')
    fs.symlinkSync(join(outside, 'secret.txt'), join(runs, 'link.json'))
    fs.symlinkSync(outside, join(runs, 'linkdir'), 'dir')
    fs.symlinkSync(join(outside, 'missing'), join(runs, 'dangling.json'))
    // The normal case, and a path that is not there.
    assert.deepEqual(helper('removeFile', { path: join(runs, 'plain.json'), regularOnly: true }).answer, { ok: true, removed: true })
    assert.equal(fs.existsSync(join(runs, 'plain.json')), false)
    assert.deepEqual(helper('removeFile', { path: join(runs, 'plain.json'), regularOnly: true }).answer, { ok: true, removed: false })
    // A link of any kind is refused with IS_LINK; the link and its target stay.
    for (const name of ['link.json', 'linkdir', 'dangling.json']) {
      const run = helper('removeFile', { path: join(runs, name), regularOnly: true })
      assertFailure(run, 'IS_LINK', dir)
      assert.ok(fs.lstatSync(join(runs, name)).isSymbolicLink(), name)
    }
    assert.equal(fs.readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside file')
    assert.deepEqual(fs.readdirSync(outside), ['secret.txt'])
    // A directory (not empty or empty) is refused with NOT_FILE.
    assertFailure(helper('removeFile', { path: join(runs, 'sub'), regularOnly: true }), 'NOT_FILE', dir)
    assert.equal(fs.readFileSync(join(runs, 'sub', 'inner.txt'), 'utf8'), 'inner')
    // A bad flag is a bad request; without the flag the operation is the old one.
    assertFailure(helper('removeFile', { path: join(runs, 'link.json'), regularOnly: 'yes' }), 'BAD_REQUEST', dir)
    assert.ok(fs.lstatSync(join(runs, 'link.json')).isSymbolicLink())
    assert.deepEqual(helper('removeFile', { path: join(runs, 'link.json') }).answer, { ok: true, removed: true })
    assert.equal(fs.readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside file')
    // In a batch the refusal stops it, with its position.
    const batch = helper('batch', { ops: [{ op: 'removeFile', path: join(runs, 'sub'), regularOnly: true }] })
    assert.equal(batch.answer.code, 'NOT_FILE')
    assert.equal(batch.answer.at, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('append: added to the end without reading the file, its directory made; many processes at once lose and split nothing', async () => {
  const dir = scratch()
  try {
    const log = join(dir, 'runs', 'cleared.jsonl')
    assert.deepEqual(helper('append', { path: log, text: '{"a":1}\n' }).answer, { ok: true, bytes: 8 })
    assert.deepEqual(helper('append', { path: log, text: 'caf\u00e9\n' }).answer, { ok: true, bytes: 6 })
    assert.equal(fs.readFileSync(log, 'utf8'), '{"a":1}\ncaf\u00e9\n')
    // Two processes, then twenty, each appending its own block of lines at the same moment.
    for (const writers of [2, 20]) {
      fs.writeFileSync(log, '')
      const block = w => Array.from({ length: 300 }, (_, i) => JSON.stringify({ w, i, pad: 'x'.repeat(200) })).join('\n') + '\n'
      const answers = await Promise.all(Array.from({ length: writers }, (_, w) => helperAsync('append', { path: log, text: block(w) })))
      assert.ok(answers.every(one => one.code === 0 && one.answer.ok === true))
      const lines = fs.readFileSync(log, 'utf8').trimEnd().split('\n')
      assert.equal(lines.length, writers * 300)
      const rows = lines.map(line => JSON.parse(line))
      for (let w = 0; w < writers; w++) {
        const mine = rows.filter(row => row.w === w).map(row => row.i)
        // Each writer's block arrives whole and in order: one write per append.
        assert.deepEqual(mine, Array.from({ length: 300 }, (_, i) => i))
        const first = rows.findIndex(row => row.w === w)
        assert.ok(rows.slice(first, first + 300).every(row => row.w === w))
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** What tailLines in hooks/core.ts gives: the reference the helper's tail is held to. */
function tailLines(text, count, width) {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
    .slice(-count)
    .map(line => line.slice(0, width) + '\n')
    .join('')
}

test('tail: the cases at the edges, as tailLines gives them', () => {
  const dir = scratch()
  try {
    const cases = ['', '\n', '\n\n', 'one', 'one\n', 'a\nb', 'a\nb\n', 'a\n\nb\n\n', 'x\r\ny\r\n', 'caf\u00e9 \u2615\n\u{1F600}\u{1F600}\n', 'abcdefghij\n']
    for (const text of cases) {
      fs.writeFileSync(join(dir, 't'), text)
      for (const [lines, width] of [[1, 3], [2, 1], [3, 20000], [600, 20000]]) {
        const got = helper('tail', { path: join(dir, 't'), lines, width }).answer
        assert.deepEqual(got, { ok: true, text: tailLines(text, lines, width), dropped: 0 }, JSON.stringify({ text, lines, width }))
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail of a large file: the same as tail -n 600 | cut -c1-20000, from the end without reading the file', { skip: !IS_LINUX || !has('tail') || !has('cut') }, () => {
  const dir = scratch()
  try {
    const path = join(dir, 'transcript.jsonl')
    // About 28 MB: short lines, long ones past the cut (ASCII, where cut's byte cut and the character cut agree), and
    // lines of non-ASCII text under the cut.
    const out = fs.openSync(path, 'w')
    for (let i = 0; i < 3000; i++) {
      const line = i % 97 === 0 ? `{"i":${i},"big":"${'y'.repeat(25000 + i)}"}` : i % 5 === 0 ? `{"i":${i},"t":"caf\u00e9 \u2615 \u00fc\u00f1\u00ee\u00e7\u00f8d\u00e9 ${'z'.repeat(i % 300)}"}` : `{"i":${i},"t":"${'x'.repeat((i * 37) % 19000)}"}`
      fs.writeSync(out, `${line}\n`)
    }
    fs.closeSync(out)
    const want = spawnSync('sh', ['-c', 'tail -n 600 "$1" | cut -c1-20000', 'tail', path], { maxBuffer: 64 * 1024 * 1024 }).stdout.toString('utf8')
    const got = helper('tail', { path, lines: 600, width: 20000, maxBytes: 64 * 1024 * 1024 }).answer
    assert.equal(got.ok, true)
    assert.equal(got.text, want)
    assert.equal(got.text, tailLines(fs.readFileSync(path, 'utf8'), 600, 20000))
    // The default answer stays under the engine's 4 MiB stdout cap: the oldest lines go and are counted.
    const capped = helper('tail', { path, lines: 600, width: 20000 })
    assert.ok(Buffer.byteLength(capped.stdout) < 4 * 1024 * 1024)
    assert.ok(capped.answer.dropped > 0)
    assert.ok(want.endsWith(capped.answer.text))
    assert.equal(capped.answer.text.split('\n').length - 1, 600 - capped.answer.dropped)

    // A 4 GiB file (sparse: 4 GiB of nothing, then the lines) is tailed in well under a second: read from its end.
    const sparse = join(dir, 'sparse.jsonl')
    const fd = fs.openSync(sparse, 'w')
    fs.ftruncateSync(fd, 4 * 1024 * 1024 * 1024)
    fs.closeSync(fd)
    fs.appendFileSync(sparse, Array.from({ length: 1000 }, (_, i) => `{"n":${i}}`).join('\n') + '\n')
    const started = Date.now()
    const tail = helper('tail', { path: sparse, lines: 600, width: 20000 }).answer
    const took = Date.now() - started
    assert.equal(tail.text, Array.from({ length: 600 }, (_, i) => `{"n":${i + 400}}\n`).join(''))
    assert.ok(took < 2000, `took ${took} ms`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rotate: only a trace that would pass the limit, each move whose source is there, the trace last', () => {
  const dir = scratch()
  try {
    const trace = join(dir, 'trace.log')
    const moves = [[`${trace}.2`, `${trace}.3`], [`${trace}.1`, `${trace}.2`], [trace, `${trace}.1`]]
    const rotate = (adding, maxBytes) => helper('rotate', { path: trace, adding, maxBytes, moves }).answer
    assert.deepEqual(rotate(10, 5), { ok: true, rotated: false })
    fs.writeFileSync(trace, '')
    assert.deepEqual(rotate(10, 5), { ok: true, rotated: false })
    fs.writeFileSync(trace, 'abc\n')
    assert.deepEqual(rotate(1, 5), { ok: true, rotated: false })
    assert.deepEqual(rotate(2, 5), { ok: true, rotated: true })
    assert.deepEqual([fs.existsSync(trace), fs.readFileSync(`${trace}.1`, 'utf8'), fs.existsSync(`${trace}.2`)], [false, 'abc\n', false])
    fs.writeFileSync(trace, 'def\n')
    fs.writeFileSync(`${trace}.2`, 'old\n')
    assert.deepEqual(rotate(10, 5), { ok: true, rotated: true })
    assert.deepEqual([`${trace}.1`, `${trace}.2`, `${trace}.3`].map(one => fs.readFileSync(one, 'utf8')), ['def\n', 'abc\n', 'old\n'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('batch: the operations in order in one process; the first failure stops it with its position and the answers before it', () => {
  const dir = scratch()
  try {
    const log = join(dir, 'log')
    const ops = [
      { op: 'append', path: log, text: 'one\n' },
      { op: 'writeAtomic', path: join(dir, 'reg.json'), text: '[]\n' },
      { op: 'append', path: log, text: 'two\n' },
      { op: 'tail', path: log, lines: 1, width: 10 },
      { op: 'renameOver', from: log, to: join(dir, 'log.1') },
      { op: 'removeFile', path: join(dir, 'reg.json') },
    ]
    const run = helper('batch', { ops })
    assert.equal(run.code, 0)
    assert.deepEqual(run.answer, {
      ok: true,
      results: [{ ok: true, bytes: 4 }, { ok: true, written: true }, { ok: true, bytes: 4 }, { ok: true, text: 'two\n', dropped: 0 }, { ok: true }, { ok: true, removed: true }],
    })
    assert.deepEqual(fs.readdirSync(dir), ['log.1'])
    assert.equal(fs.readFileSync(join(dir, 'log.1'), 'utf8'), 'one\ntwo\n')
    const failed = helper('batch', { ops: [{ op: 'append', path: log, text: 'a\n' }, { op: 'tail', path: join(dir, 'none'), lines: 1, width: 1 }, { op: 'append', path: log, text: 'never\n' }] })
    assertFailure(failed, 'NOT_FOUND', dir)
    assert.equal(failed.answer.at, 1)
    assert.deepEqual(failed.answer.results, [{ ok: true, bytes: 2 }])
    assert.equal(fs.readFileSync(log, 'utf8'), 'a\n')
    assert.equal(helper('batch', { ops: [{ op: 'probe', args: [] }] }).answer.code, 'BAD_OP')
    assert.equal(helper('batch', { ops: [{ op: 'batch', ops: [] }] }).answer.code, 'BAD_OP')
    assert.deepEqual(helper('batch', { ops: [] }).answer, { ok: true, results: [] })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- filesNewerThan: the read-only listing


/** A file with its mtime set to `sec` (epoch seconds, a fraction allowed). */
function put(file, sec, text = 'x') {
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  fs.utimesSync(file, sec, sec)
}

const T = 1_790_000_000

test('filesNewerThan: the files written after the time, newest first, paths and mtimes only; .git never entered; no symbolic link followed or listed', { skip: process.platform === 'win32' }, () => {
  const top = scratch()
  try {
    const dir = join(top, 'work')
    const outside = join(top, 'outside')
    put(join(dir, 'a.txt'), T + 30)
    put(join(dir, 'sub', 'b.txt'), T + 20.5)
    put(join(dir, 'old.txt'), T - 100)
    put(join(dir, '.git', 'HEAD'), T + 50)
    put(join(dir, 'sub', '.git', 'index'), T + 50)
    put(join(outside, 'secret.txt'), T + 40, 'canary-outside-content')
    // A folder link out of the tree, a file link out of it, and a link back up that would loop.
    fs.symlinkSync(outside, join(dir, 'out'))
    fs.symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'))
    fs.symlinkSync(dir, join(dir, 'sub', 'loop'))
    const run = helper('filesNewerThan', { dir, since: T, max: 200 })
    assert.equal(run.code, 0, run.stdout)
    assert.deepEqual(run.answer, {
      ok: true,
      files: [
        { path: `${dir}/a.txt`, mtimeMs: (T + 30) * 1000 },
        { path: `${dir}/sub/b.txt`, mtimeMs: (T + 20.5) * 1000 },
      ],
      total: 2,
    })
    assert.ok(!run.stdout.includes('outside') && !run.stdout.includes('canary'), run.stdout)
    assert.equal(run.stderr, '')
    // Nothing was written: the tree is as it was.
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.git', 'a.txt', 'link.txt', 'old.txt', 'out', 'sub'])
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

test('filesNewerThan: at most `max` paths, the newest, with the count of all; a tie goes by path; a file of exactly the second asked is not after it', () => {
  const dir = scratch()
  try {
    for (let n = 0; n < 230; n++) put(join(dir, `f${String(n).padStart(3, '0')}.txt`), T + 1 + n)
    put(join(dir, 'tie-b.txt'), T + 500)
    put(join(dir, 'tie-a.txt'), T + 500)
    put(join(dir, 'exact.txt'), T)
    const run = helper('filesNewerThan', { dir, since: T, max: 200 })
    assert.equal(run.code, 0)
    assert.equal(run.answer.total, 232)
    assert.equal(run.answer.files.length, 200)
    assert.deepEqual(run.answer.files.slice(0, 3).map(one => one.path.slice(dir.length + 1)), ['tie-a.txt', 'tie-b.txt', 'f229.txt'])
    assert.equal(run.answer.files.at(-1).path, `${dir}/f032.txt`)
    assert.ok(run.answer.files.every((one, at, all) => at === 0 || all[at - 1].mtimeMs >= one.mtimeMs))
    assert.ok(run.answer.files.every(one => Object.keys(one).join() === 'path,mtimeMs'))
    assert.ok(!run.answer.files.some(one => one.path.endsWith('exact.txt')))
    assert.deepEqual(helper('filesNewerThan', { dir, since: T + 1000, max: 5 }).answer, { ok: true, files: [], total: 0 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('filesNewerThan: a bad request, a missing directory and a file in its place are fixed codes, never a path', () => {
  const dir = scratch()
  try {
    put(join(dir, 'file'), T)
    assertFailure(helper('filesNewerThan', { dir: join(dir, 'none'), since: 0, max: 10 }), 'NOT_FOUND', dir)
    assertFailure(helper('filesNewerThan', { dir: join(dir, 'file'), since: 0, max: 10 }), 'NOT_DIR', dir)
    assertFailure(helper('filesNewerThan', { dir, since: '0', max: 10 }), 'BAD_REQUEST')
    assertFailure(helper('filesNewerThan', { dir, since: -1, max: 10 }), 'BAD_REQUEST')
    assertFailure(helper('filesNewerThan', { dir, since: 0, max: 0 }), 'BAD_REQUEST')
    assertFailure(helper('filesNewerThan', { dir: '', since: 0, max: 10 }), 'BAD_REQUEST')
    assertFailure(helper('filesNewerThan', { since: 0, max: 10 }), 'BAD_REQUEST')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('filesNewerThan: a folder it cannot read is passed over, the rest listed', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const dir = scratch()
  try {
    put(join(dir, 'open', 'a.txt'), T + 10)
    put(join(dir, 'shut', 'b.txt'), T + 20)
    fs.chmodSync(join(dir, 'shut'), 0o000)
    const run = helper('filesNewerThan', { dir, since: T, max: 10 })
    assert.deepEqual(run.answer, { ok: true, files: [{ path: `${dir}/open/a.txt`, mtimeMs: (T + 10) * 1000 }], total: 1 })
  } finally {
    fs.chmodSync(join(dir, 'shut'), 0o755)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- the probe over a fake /proc tree

const CANARY = ['sk', 'canary-env-0123456789abcdef'].join('-')

/**
 * A fake /proc: claude processes with and without a config dir, a cwd, a command line with a tab and a newline, a
 * command name with ") " in it, a process of another name, the canary among the environment variables; a config dir
 * with a sessions file (more fields than the probe takes) and transcripts in two projects and a hidden one.
 */
function fakeTree() {
  const root = scratch()
  const proc = join(root, 'proc')
  const cfg = join(root, 'cfg')
  fs.mkdirSync(proc)
  fs.writeFileSync(join(proc, 'uptime'), '98765.43 12345.67\n')
  // The fields after the command: the state first, the start time 20th (field 22 of the line).
  const stat = (pid, comm, start) => `${pid} (${comm}) ${Array.from({ length: 50 }, (_, at) => (at === 0 ? 'S' : at === 19 ? start : String(at))).join(' ')}\n`
  const process = (pid, comm, start, { cmdline, environ, cwd, statComm = comm } = {}) => {
    const dir = join(proc, String(pid))
    fs.mkdirSync(dir)
    fs.writeFileSync(join(dir, 'comm'), `${comm}\n`)
    fs.writeFileSync(join(dir, 'stat'), stat(pid, statComm, start))
    if (cmdline !== undefined) fs.writeFileSync(join(dir, 'cmdline'), cmdline)
    if (environ !== undefined) fs.writeFileSync(join(dir, 'environ'), environ)
    if (cwd !== undefined) fs.symlinkSync(cwd, join(dir, 'cwd'))
  }
  process(100, 'claude', '9000000', {
    cmdline: 'claude\0-p\0--model\0opus\0--\0hello\tthere\nnext line\0',
    environ: `PATH=/usr/bin\0${'SECRET_CANARY'}=${CANARY}\0CLAUDE_CONFIG_DIR=${cfg}\0HOME=/home/someone\0`,
    cwd: join(root, 'work dir'),
  })
  process(2000, 'claude', '9500000', { cmdline: 'claude\0--resume\0abc\0', environ: `${'API'}_KEY=${CANARY}\0`, cwd: '/' })
  process(31, 'bash', '100', { cmdline: 'bash\0', environ: `CLAUDE_CONFIG_DIR=/not/claude\0` })
  process(4, 'claude', '7000000', { statComm: 'we) ird' })
  fs.mkdirSync(join(cfg, 'sessions'), { recursive: true })
  fs.writeFileSync(join(cfg, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: 'sid-a', procStart: '9000000', cwd: '/secret/cwd/never', name: 'w-x', secret: CANARY }))
  fs.writeFileSync(join(cfg, 'sessions', '2000.json'), 'not json')
  fs.writeFileSync(join(cfg, 'sessions', '4.json'), JSON.stringify({ sessionId: null, procStart: 7000000 }))
  for (const [project, mtime] of [['p-one', 1_700_000_000], ['p-two', 1_600_000_000], ['.hidden', 1_800_000_000]]) {
    fs.mkdirSync(join(cfg, 'projects', project), { recursive: true })
    const file = join(cfg, 'projects', project, 'sid-a.jsonl')
    fs.writeFileSync(file, '{}\n')
    fs.utimesSync(file, mtime, mtime)
  }
  const args = [`pid:100|${cfg}`, `pid:2000|${cfg}`, `pid:4|${cfg}|extra`, `pid:999|${cfg}`, `t:sid-a|${cfg}`, `t:sid-none|${cfg}`, 'garbage']
  return { root, proc, cfg, args }
}

/** The lines the fake tree gives, recorded once from the shell probe the mod ran before the helper (<cfg> and <root> stand for the tree's paths). */
const RECORDED = [
  'P\t100\tclaude\t8765\t<root>/work dir\t<cfg>\tclaude -p --model opus -- hello there next line ',
  'P\t2000\tclaude\t3765\t/\t\tclaude --resume abc ',
  'P\t4\tclaude\t28765\t\t\t',
  'A\t100\tclaude\t9000000\t9000000\tsid-a\tS',
  'A\t2000\tclaude\t9500000\t\t\tS',
  'A\t4\tclaude\t7000000\t7000000\t\tS',
  'T\tsid-a\t1700000000',
  '',
].join('\n')

test('probe: the fake /proc tree gives the recorded lines', { skip: !IS_LINUX }, () => {
  const tree = fakeTree()
  try {
    const want = RECORDED.replaceAll('<cfg>', tree.cfg).replaceAll('<root>', tree.root)
    const run = helper('probe', { args: tree.args }, { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: tree.proc })
    assert.equal(run.code, 0)
    assert.deepEqual(Object.keys(run.answer), ['ok', 'out'])
    assert.equal(run.answer.out, want)
    // A pid that is no number (the registry never holds one: probeArgs takes numbers only) is never looked up, not even
    // one that names an entry of /proc (self).
    fs.mkdirSync(join(tree.proc, 'self'))
    assert.ok(!helper('probe', { args: ['pid:self|~', 'pid:..|~', 'pid:|~'] }, { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: tree.proc }).answer.out.includes('\nA\t'))
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('probe: no environment content but CLAUDE_CONFIG_DIR, and no sessions-file field but procStart and sessionId, in any answer', { skip: !IS_LINUX }, () => {
  const tree = fakeTree()
  try {
    const run = helper('probe', { args: tree.args }, { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: tree.proc })
    assert.equal(run.answer.ok, true)
    for (const text of [run.stdout, run.stderr]) {
      assert.ok(!text.includes(CANARY), 'the canary leaked')
      assert.ok(!text.includes('SECRET_CANARY') && !text.includes('API_KEY') && !text.includes('PATH=') && !text.includes('/home/someone'), 'another variable leaked')
      assert.ok(!text.includes('/secret/cwd/never') && !text.includes('w-x'), 'a sessions-file field leaked')
      assert.ok(!text.includes('/not/claude'), 'a non-claude process leaked')
    }
    // A request that fails says nothing of the tree either.
    const bad = helper('probe', '{"args":', { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: tree.proc })
    assertFailure(bad, 'BAD_REQUEST', tree.root)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('probe: SC_HELPER_PROC_ROOT alone, or with SC_HELPER_TEST other than 1, is ignored: the live /proc is read', { skip: !IS_LINUX }, () => {
  const tree = fakeTree()
  try {
    const fake = helper('probe', { args: tree.args }, { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: tree.proc }).answer.out
    assert.ok(fake.includes(`P\t100\tclaude\t8765\t${tree.root}/work dir\t`), fake)
    for (const env of [{ SC_HELPER_PROC_ROOT: tree.proc }, { SC_HELPER_TEST: 'true', SC_HELPER_PROC_ROOT: tree.proc }, { SC_HELPER_TEST: '0', SC_HELPER_PROC_ROOT: tree.proc }, { SC_HELPER_TEST: '', SC_HELPER_PROC_ROOT: tree.proc }]) {
      const run = helper('probe', { args: tree.args }, env)
      assert.equal(run.code, 0)
      // None of the fake tree's processes: its claude in "work dir", its resumed claude, its odd comm.
      assert.ok(!run.answer.out.includes(`${tree.root}/work dir`), JSON.stringify(env))
      assert.ok(!run.answer.out.includes('claude --resume abc'), JSON.stringify(env))
      assert.ok(!run.answer.out.includes('\t8765\t') && !run.answer.out.includes('\t28765\t'), JSON.stringify(env))
    }
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('probe: a pid whose sessions file records another procStart than its stat field 22 (a reused pid) is reported with both starts and reads as dead, never alive', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const { parseProcFacts, isPidAlive, rowStatus } = await import('../hooks/core.ts')
  const tree = fakeTree()
  try {
    // pid 3000: a claude started at tick 9600000; its sessions file was written by an earlier process of that pid.
    const dir = join(tree.proc, '3000')
    fs.mkdirSync(dir)
    fs.writeFileSync(join(dir, 'comm'), 'claude\n')
    fs.writeFileSync(join(dir, 'stat'), `3000 (claude) ${Array.from({ length: 50 }, (_, at) => (at === 0 ? 'S' : at === 19 ? '9600000' : String(at))).join(' ')}\n`)
    const file = join(tree.cfg, 'sessions', '3000.json')
    const probe = () => helper('probe', { args: [`pid:3000|${tree.cfg}`] }, { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: tree.proc })
    const entry = { pid: 3000, session_id: 'sid-r', config_dir: tree.cfg }
    const proofLines = out => out.split('\n').filter(line => line.startsWith('A\t'))
    fs.writeFileSync(file, JSON.stringify({ pid: 3000, sessionId: 'sid-r', procStart: '1234567' }))
    const reused = probe()
    assert.equal(reused.code, 0)
    assert.deepEqual(proofLines(reused.answer.out), ['A\t3000\tclaude\t9600000\t1234567\tsid-r\tS'])
    const facts = parseProcFacts(reused.answer.out)
    assert.equal(isPidAlive(entry, facts), false)
    assert.equal(rowStatus(entry, facts), 'dead')
    // The same pid with its own start in the file is alive: the start is what tells them apart.
    fs.writeFileSync(file, JSON.stringify({ pid: 3000, sessionId: 'sid-r', procStart: '9600000' }))
    const own = probe()
    assert.deepEqual(proofLines(own.answer.out), ['A\t3000\tclaude\t9600000\t9600000\tsid-r\tS'])
    assert.equal(rowStatus(entry, parseProcFacts(own.answer.out)), 'alive')
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- the stop of stop_worker, on real processes

/** Field 22 of /proc/<pid>/stat, or '' when the pid is gone. */
function startOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] ?? ''
  } catch {
    return ''
  }
}

/**
 * A throwaway tree of this test's own: a shell that starts a sleep and a second shell that ignores TERM and starts a
 * sleep of its own (which inherits the ignored TERM). Answers the root's pid once its three descendants are there, and
 * a bystander sleep outside the tree.
 */
async function throwawayTree() {
  const root = spawn('sh', ['-c', 'sleep 300 & sh -c \'trap "" TERM; sleep 300\' & wait'], { stdio: 'ignore' })
  const bystander = spawn('sleep', ['300'], { stdio: 'ignore' })
  const children = () => spawnSync('sh', ['-c', `pgrep -P ${root.pid}; for c in $(pgrep -P ${root.pid}); do pgrep -P $c; done`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  for (let at = 0; at < 100 && children().length < 3; at++) await new Promise(done => setTimeout(done, 50))
  assert.equal(children().length, 3, 'the throwaway tree did not start')
  return { root, bystander, all: [root.pid, ...children().map(Number)] }
}

/** Kills what is left of a throwaway tree (only this test's own pids, by their start). */
function cleanup(tree, starts) {
  for (const pid of [...tree.all, tree.bystander.pid]) if (startOf(pid) !== '' && startOf(pid) === starts.get(pid)) process.kill(pid, 'SIGKILL')
}

const lines = out => out.replace(/\n$/, '').split('\n').map(line => line.split('\t'))

{
  test(`stop (helper): the tree is listed first, the root and every descendant stopped (KILL where TERM is ignored), the bystander untouched`, { skip: !IS_LINUX || !has('pgrep') }, async () => {
    const tree = await throwawayTree()
    const starts = new Map([...tree.all, tree.bystander.pid].map(pid => [pid, startOf(pid)]))
    try {
      const rootStart = starts.get(tree.root.pid)
      const listed = helper('processTree', { pid: tree.root.pid, start: rootStart }).answer.out
      const got = lines(listed)
      assert.deepEqual(got[0].slice(0, 4), ['R', String(tree.root.pid), String(process.pid), rootStart])
      assert.equal(got[0][5].trim(), 'sh')
      const descendants = got.filter(cols => cols[0] === 'D')
      assert.deepEqual(descendants.map(cols => Number(cols[1])).sort(), tree.all.slice(1).sort())
      assert.deepEqual(descendants.map(cols => cols[5].trim()).sort(), ['sh', 'sleep', 'sleep'])
      // The listing process's own ancestors: this test runner and those above it.
      const ancestors = got.filter(cols => cols[0] === 'G').map(cols => Number(cols[1]))
      assert.ok(ancestors.includes(process.pid), listed)
      const targets = [tree.root.pid, ...descendants.map(cols => Number(cols[1]))].map(pid => `${pid}:${starts.get(pid)}`)
      const stopped = helper('stopProcesses', { wait: 2, targets }).answer.out
      const steps = lines(stopped)
      const sent = steps.filter(cols => cols[0] === 'S')
      assert.deepEqual(sent[0].slice(0, 3), ['S', String(tree.root.pid), 'TERM'])
      assert.ok(sent.every(cols => cols[4] === '0' && Math.abs(Number(cols[3]) - Date.now()) < 60_000), stopped)
      // The shell that ignores TERM needed KILL (its sleep and, where the runner starts children with TERM ignored, the
      // other sleep too); every signal went to a pid of the tree, KILL only after that pid's TERM and its re-check.
      const killed = sent.filter(cols => cols[2] === 'KILL').map(cols => Number(cols[1]))
      assert.ok(killed.length >= 1 && killed.every(pid => tree.all.includes(pid) && pid !== tree.root.pid), stopped)
      assert.ok(sent.every(cols => tree.all.includes(Number(cols[1]))), stopped)
      for (const pid of killed) {
        const at = steps.findIndex(cols => cols[0] === 'S' && cols[1] === String(pid) && cols[2] === 'KILL')
        assert.ok(steps.slice(0, at).some(cols => cols[0] === 'C' && cols[1] === String(pid) && cols[3] === 'alive'), stopped)
      }
      // The root's parent is this runner, blocked in the call: a root that died stays a zombie until the runner reaps it
      // (exited, state Z); a descendant is reaped by its own shell or by init.
      const ends = steps.filter(cols => cols[0] === 'F')
      assert.deepEqual(ends.map(cols => cols[1]), targets.map(one => one.split(':')[0]))
      assert.ok(ends.every(cols => cols[2] === 'gone' || (cols[2] === 'exited' && cols[3] === 'Z' && cols[1] === String(tree.root.pid))), stopped)
      assert.ok(!steps.some(cols => cols[0] === 'S' && cols[2] === 'KILL' && ends.some(end => end[1] === cols[1] && end[2] === 'exited') && steps.indexOf(cols) > steps.findIndex(c => c[0] === 'C' && c[1] === cols[1] && c[3] === 'exited')), 'a zombie was signalled')
      await new Promise(done => setTimeout(done, 300))
      for (const pid of tree.all) assert.equal(startOf(pid) === starts.get(pid), false, `${pid} is still there`)
      assert.equal(startOf(tree.bystander.pid), starts.get(tree.bystander.pid))
    } finally {
      cleanup(tree, starts)
    }
  })

  test(`stop (helper): a pid with another start is never signalled; this runner (an ancestor of the stop) is never signalled`, { skip: !IS_LINUX }, async () => {
    const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' })
    await new Promise(done => setTimeout(done, 100))
    const start = startOf(sleeper.pid)
    try {
      const wrong = `${sleeper.pid}:${Number(start) + 1}`
      const own = `${process.pid}:${startOf(process.pid)}`
      const run = targets => helper('stopProcesses', { wait: 1, targets }).answer.out
      assert.deepEqual(lines(run([wrong])), [['X', String(sleeper.pid), 'gone'], ['F', String(sleeper.pid), 'gone', '']])
      assert.deepEqual(lines(run([own])).map(cols => cols.slice(0, 3)), [['X', String(process.pid), 'own'], ['F', String(process.pid), 'alive']])
      assert.equal(startOf(sleeper.pid), start)
      const listed = helper('processTree', { pid: sleeper.pid, start: String(Number(start) + 1) }).answer.out
      assert.deepEqual(lines(listed)[0], ['N', String(sleeper.pid), start])
      assert.equal(lines(listed).filter(cols => cols[0] === 'D').length, 0)
    } finally {
      sleeper.kill('SIGKILL')
    }
  })
}

test('stop: a bad request is a fixed code, and a target list is never read from a fake /proc tree', { skip: !IS_LINUX }, () => {
  assertFailure(helper('processTree', { pid: 0, start: '1' }), 'BAD_REQUEST')
  assertFailure(helper('processTree', { pid: 1, start: 'x' }), 'BAD_REQUEST')
  assertFailure(helper('stopProcesses', { wait: 1, targets: [] }), 'BAD_REQUEST')
  assertFailure(helper('stopProcesses', { wait: 1, targets: ['self:1'] }), 'BAD_REQUEST')
  assertFailure(helper('stopProcesses', { wait: 61, targets: ['5:1'] }), 'BAD_REQUEST')
  assertFailure(helper('stopProcesses', { wait: 1, targets: ['0:1'] }), 'BAD_REQUEST')
  assertFailure(helper('batch', { ops: [{ op: 'stopProcesses', wait: 1, targets: ['5:1'] }] }), 'BAD_OP')
  // The probe's fake tree variable changes nothing here: the live /proc is read (pid 1 has the start it has there).
  const live = helper('processTree', { pid: 1, start: startOf(1) }, { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: '/nonexistent' })
  assert.equal(lines(live.answer.out)[0][0], 'R')
})

// ---------------------------------------------------------------- hashTree (the drift band)

const sha256 = text => createHash('sha256').update(text).digest('hex')
const SPEC = { dirs: ['hooks', 'helper', 'types'], files: ['.claude-plugin/plugin.json'] }

/** A mod folder: the compared files, and what never is (tests, the engine's generated types, a nested folder). */
function modTree(root, extra = {}) {
  const files = {
    'hooks/register.tsx': 'export const register = 1\n',
    'hooks/core.ts': 'export const core = 1\n',
    'helper/host.mjs': '// helper\n',
    'types/index.d.ts': 'export type X = 1\n',
    '.claude-plugin/plugin.json': '{"name":"x"}\n',
    '.claude-plugin/types/claude-code.d.ts': '// generated\n',
    'tests/core.test.ts': '// test\n',
    'hooks/deeper/inner.ts': '// nested\n',
    ...extra,
  }
  for (const [rel, text] of Object.entries(files)) {
    if (text === undefined) continue
    fs.mkdirSync(dirname(join(root, rel)), { recursive: true })
    fs.writeFileSync(join(root, rel), text)
  }
  return files
}

test('hashTree: the SHA-256 of the direct files of hooks, helper and types and of plugin.json, sorted, relative paths and hex only; tests, generated types and nested folders never', () => {
  const top = scratch()
  try {
    const root = join(top, 'mod')
    const files = modTree(root)
    const run = helper('hashTree', { root, ...SPEC })
    assert.equal(run.code, 0, run.stdout)
    const want = ['.claude-plugin/plugin.json', 'helper/host.mjs', 'hooks/core.ts', 'hooks/register.tsx', 'types/index.d.ts']
    assert.deepEqual(run.answer, { ok: true, files: want.map(rel => ({ path: rel, sha256: sha256(files[rel]) })), total: want.length })
    assert.ok(!run.stdout.includes(top), run.stdout)
    assert.equal(run.stderr, '')
    // Read-only: nothing added or changed.
    assert.deepEqual(fs.readdirSync(join(root, 'hooks')).sort(), ['core.ts', 'deeper', 'register.tsx'])
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

test('hashTree: no symbolic link inside the root is followed or hashed (a file link, a folder link for types, a dangling one); the root itself is followed', { skip: process.platform === 'win32' }, () => {
  const top = scratch()
  try {
    const root = join(top, 'mod')
    modTree(root, { 'types/index.d.ts': undefined })
    const outside = join(top, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'secret.ts'), 'canary-outside-content\n')
    fs.symlinkSync(join(outside, 'secret.ts'), join(root, 'hooks', 'linked.ts'))
    fs.symlinkSync(outside, join(root, 'types'))
    fs.symlinkSync(join(top, 'nowhere'), join(root, 'helper', 'dangling.mjs'))
    const linkedRoot = join(top, 'linked-mod')
    fs.symlinkSync(root, linkedRoot)
    for (const one of [root, linkedRoot]) {
      const run = helper('hashTree', { root: one, ...SPEC })
      assert.equal(run.code, 0, run.stdout)
      assert.deepEqual(run.answer.files.map(file => file.path), ['.claude-plugin/plugin.json', 'helper/host.mjs', 'hooks/core.ts', 'hooks/register.tsx'])
      assert.ok(!run.stdout.includes(sha256('canary-outside-content\n')), run.stdout)
    }
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

test('hashTree: a link among the folders on the way is not followed either: plugin.json under a linked .claude-plugin is passed over', { skip: process.platform === 'win32' }, () => {
  const top = scratch()
  try {
    const root = join(top, 'mod')
    modTree(root, { '.claude-plugin/plugin.json': undefined, '.claude-plugin/types/claude-code.d.ts': undefined })
    const outside = join(top, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(join(outside, 'plugin.json'), 'canary-outside-plugin\n')
    fs.rmSync(join(root, '.claude-plugin'), { recursive: true, force: true })
    fs.symlinkSync(outside, join(root, '.claude-plugin'))
    const run = helper('hashTree', { root, dirs: ['hooks', 'helper', 'types'], files: ['.claude-plugin/plugin.json', 'hooks/core.ts'] })
    assert.equal(run.code, 0, run.stdout)
    assert.deepEqual(run.answer.files.map(file => file.path), ['helper/host.mjs', 'hooks/core.ts', 'hooks/register.tsx', 'types/index.d.ts'])
    assert.ok(!run.stdout.includes(sha256('canary-outside-plugin\n')), run.stdout)
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

test('hashTree: a folder or file of the request that is not there counts as empty or absent; one changed byte changes its digest only', () => {
  const top = scratch()
  try {
    const a = join(top, 'a')
    const b = join(top, 'b')
    modTree(a)
    modTree(b, { 'hooks/core.ts': 'export const core = 2\n' })
    fs.rmSync(join(b, 'helper'), { recursive: true, force: true })
    fs.rmSync(join(b, '.claude-plugin', 'plugin.json'))
    const run = helper('batch', { ops: [a, b].map(root => ({ op: 'hashTree', root, ...SPEC })) })
    assert.equal(run.code, 0, run.stdout)
    const [one, two] = run.answer.results.map(result => Object.fromEntries(result.files.map(file => [file.path, file.sha256])))
    assert.deepEqual(Object.keys(two), ['hooks/core.ts', 'hooks/register.tsx', 'types/index.d.ts'])
    assert.notEqual(one['hooks/core.ts'], two['hooks/core.ts'])
    assert.equal(one['hooks/register.tsx'], two['hooks/register.tsx'])
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

test('hashTree: line ends do not count (CRLF and LF copies hash alike, as LF does); one changed byte still counts; a file with a NUL byte keeps its bytes', () => {
  const top = scratch()
  try {
    const a = join(top, 'a')
    const b = join(top, 'b')
    const c = join(top, 'c')
    modTree(a, { 'hooks/core.ts': 'export const core = 1\nline two\n', 'helper/bin.dat': 'x\0y\nz\n' })
    modTree(b, { 'hooks/core.ts': 'export const core = 1\r\nline two\r\n', 'helper/bin.dat': 'x\0y\r\nz\r\n' })
    modTree(c, { 'hooks/core.ts': 'export const core = 1\r\nline twO\r\n', 'helper/bin.dat': 'x\0y\nz\n' })
    const run = helper('batch', { ops: [a, b, c].map(root => ({ op: 'hashTree', root, ...SPEC })) })
    assert.equal(run.code, 0, run.stdout)
    const [one, two, three] = run.answer.results.map(result => Object.fromEntries(result.files.map(file => [file.path, file.sha256])))
    assert.equal(one['hooks/core.ts'], two['hooks/core.ts'])
    assert.equal(one['hooks/core.ts'], sha256('export const core = 1\nline two\n'))
    assert.notEqual(two['hooks/core.ts'], three['hooks/core.ts'])
    // A binary-looking file is hashed as it is: CRLF against LF differs there, and its digest is that of its bytes.
    assert.notEqual(one['helper/bin.dat'], two['helper/bin.dat'])
    assert.equal(two['helper/bin.dat'], sha256('x\0y\r\nz\r\n'))
    assert.equal(one['helper/bin.dat'], three['helper/bin.dat'])
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

test('hashTree: a root that is not there or is a file, a bad request, over 500 files, a file over 8 MiB: fixed codes, never a path', () => {
  const top = scratch()
  try {
    const root = join(top, 'mod')
    modTree(root)
    assertFailure(helper('hashTree', { root: join(top, 'none'), ...SPEC }), 'NOT_FOUND', top)
    assertFailure(helper('hashTree', { root: join(root, 'hooks', 'core.ts'), ...SPEC }), 'NOT_DIR', top)
    for (const bad of [
      { root, dirs: ['../x'], files: [] },
      { root, dirs: ['hooks/../..'], files: [] },
      { root, dirs: ['/etc'], files: [] },
      { root, dirs: ['C:/x'], files: [] },
      { root, dirs: [''], files: [] },
      { root, dirs: ['./hooks'], files: [] },
      { root, dirs: 'hooks', files: [] },
      { root, dirs: [1], files: [] },
      { root, dirs: Array.from({ length: 21 }, (_, at) => `d${at}`), files: [] },
      { root, dirs: [], files: ['a\u0000b'] },
      { root: '', dirs: [], files: [] },
      { dirs: [], files: [] },
    ]) {
      assertFailure(helper('hashTree', bad), 'BAD_REQUEST', top)
    }
    for (let at = 0; at < 501; at++) fs.writeFileSync(join(root, 'helper', `f${String(at).padStart(3, '0')}.mjs`), `${at}\n`)
    assertFailure(helper('hashTree', { root, ...SPEC }), 'TOO_LARGE', top)
    fs.rmSync(join(root, 'helper'), { recursive: true, force: true })
    assert.equal(helper('hashTree', { root, ...SPEC }).code, 0)
    const big = fs.openSync(join(root, 'hooks', 'big.ts'), 'w')
    fs.ftruncateSync(big, 8 * 1024 * 1024 + 1)
    fs.closeSync(big)
    assertFailure(helper('hashTree', { root, ...SPEC }), 'TOO_LARGE', top)
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- probeUsage (usage.mjs)

test('probeUsage parser: the helper gives each recorded and written case its answer', { skip: !HAS_TS }, async () => {
  const { parseUsage } = await import('../helper/usage.mjs')
  const { USAGE_CASES } = await import('./usage-fixtures.ts')
  assert.ok(USAGE_CASES.length >= 20)
  for (const one of USAGE_CASES) assert.deepEqual(parseUsage(one.stdout, one.stderr ?? '', one.exitCode ?? 0), one.expect, one.name)
})

test('probeUsage parser: a label with no percent after it is a missing window, never PARSE; the other window is read; with neither the no-window code', { skip: !HAS_TS }, async () => {
  const { parseUsage } = await import('../helper/usage.mjs')
  const { USAGE_MISSING_CASES } = await import('./usage-fixtures.ts')
  assert.ok(USAGE_MISSING_CASES.filter(one => one.name.startsWith('mixed: ')).length >= 8)
  for (const one of USAGE_MISSING_CASES) assert.deepEqual(parseUsage(one.stdout, one.stderr ?? '', one.exitCode ?? 0), one.expect, one.name)
})

test('probeUsage parser: an answer holds the two windows and nothing else of the text', { skip: !HAS_TS }, async () => {
  const { parseUsage } = await import('../helper/usage.mjs')
  const { USAGE_FIXTURES } = await import('./usage-fixtures.ts')
  const answer = JSON.stringify(parseUsage(USAGE_FIXTURES.recordedMain ?? ''))
  for (const word of ['subscription', 'Fable', 'contributing', 'requests', 'sessions', 'context', 'plugin-authoring', 'playwright']) assert.ok(!answer.includes(word), word)
  assert.deepEqual(Object.keys(JSON.parse(answer)).sort(), ['five', 'ok', 'seven'])
})

test('probeUsage parser: an ambiguous or out-of-range percent, or one off its label line, is PARSE wherever it stands; the good forms keep their figure', async () => {
  const { parseUsage } = await import('../helper/usage.mjs')
  const session = 'Current session: 12% used · resets 6pm (UTC)'
  const week = 'Current week (all models): 41% used · resets Oct 16, 1pm (UTC)'
  const bad = ['104%', '100.5%', '-5%', '\u22125%', '1,234%', '12,5%', '104,5 %', '12345%', '99999%', '>99%', '> 99%', '.5%', '1.2.3%']
  const shapes = token => [
    `Current session: ${token} used · resets 6pm\n${week}\n`,
    `${session}\nCurrent week (all models): ${token} used\n`,
    `Current session\n  ████ ${token} used\n  Resets 6pm\n${week}\n`,
    `${session}\nCurrent week (all models)\n  ${token} used\n`,
  ]
  for (const token of bad) {
    for (const text of shapes(token)) {
      assert.deepEqual(parseUsage(text), { ok: false, code: 'PARSE' }, JSON.stringify(text))
    }
  }
  const off = [
    `Current session\n\n  37% used\n${week}\n`,
    `Current session\n  Extra usage: 50% used\n${week}\n`,
    `Current session: resets 6pm\n  37% used\n${week}\n`,
    `Current session\n a\n b\n c\n  37% used\n${week}\n`,
    `${session}\nCurrent week (all models)\n x\n\n  9% used\n`,
  ]
  for (const text of off) {
    assert.deepEqual(parseUsage(text), { ok: false, code: 'PARSE' }, JSON.stringify(text))
  }
  for (const [token, percent] of [['0%', 0], ['<1%', 0], ['< 1%', 0], ['<5%', 4], ['7%', 7], ['07%', 7], ['99.9%', 99], ['100%', 100], ['100.0%', 100]]) {
    for (const text of shapes(token)) {
      const one = parseUsage(text)
      assert.equal(one.ok, true, JSON.stringify(text))
      assert.ok(one.five?.percent === percent || one.seven?.percent === percent, JSON.stringify(text))
    }
  }
})

/**
 * A fake `claude` first on the PATH, in a scratch folder: it records its arguments, cwd, CLAUDE_CONFIG_DIR and what it
 * read on stdin, and answers by the last component of CLAUDE_CONFIG_DIR (`inherited` when unset): `ok` and `inherited`
 * the recorded text of a licence, `login` a login prompt, `slow` five seconds of nothing (its pid written first),
 * `empty` nothing, `fail` an API error, `long` the text and then 2 MB more, `garbage` a text with no window. Three
 * start a grandchild first (`sleep GRANDCHILD_SLEEP`, its pid in rec-<name>.pid), which holds the output open:
 * `grandchild` then becomes a sleep itself (its pid in rec-grandchild-parent.pid), `linger` prints the text and exits, `floodgc`
 * prints the text and 2 MB more.
 */
/** The sleep a fake claude's grandchild runs: an odd length, so a cleanup can tell the test's own throwaway by its command line. */
const GRANDCHILD_SLEEP = '27.31'

/** Whether a pid is a grandchild sleep of these tests (its command line exactly `sleep GRANDCHILD_SLEEP`). */
const isOwnSleep = pid => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') === `sleep\0${GRANDCHILD_SLEEP}\0`
  } catch {
    return false
  }
}

/** Whether a pid is gone, not even a zombie (kill 0 answers ESRCH and /proc has no entry), within `ms`. */
async function isGoneWithin(pid, ms) {
  const end = Date.now() + ms
  for (;;) {
    let isThere = true
    try {
      process.kill(pid, 0)
    } catch (err) {
      isThere = err.code !== 'ESRCH'
    }
    if (!isThere && !fs.existsSync(`/proc/${pid}`)) return true
    if (Date.now() > end) return false
    await new Promise(done => setTimeout(done, 50))
  }
}

/** The pid a fake recorded, waited for a moment (the grandchild writes it as it starts). */
async function recordedPid(top, name) {
  const file = join(top, `rec-${name}.pid`)
  for (let tries = 0; tries < 40 && !fs.existsSync(file); tries++) await new Promise(done => setTimeout(done, 50))
  return Number(fs.readFileSync(file, 'utf8'))
}

/** Kills what is left of the tests' own grandchild sleeps only (checked by command line), so a failing test leaves nothing behind. */
function killOwnLeftovers(top) {
  for (const name of ['grandchild-parent', 'grandchild', 'linger', 'floodgc']) {
    const file = join(top, `rec-${name}.pid`)
    const pid = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0
    if (pid > 1 && isOwnSleep(pid)) process.kill(pid, 'SIGKILL')
  }
}

async function fakeClaude() {
  const { USAGE_FIXTURES } = await import('./usage-fixtures.ts')
  const top = scratch()
  const bin = join(top, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(join(top, 'usage.txt'), USAGE_FIXTURES.recordedMain)
  const script = `#!/bin/sh
rec="${top}/rec"
case "\${CLAUDE_CONFIG_DIR-}" in "") name=inherited ;; *) name=$(basename "$CLAUDE_CONFIG_DIR") ;; esac
{ printf 'args=%s\\n' "$*"; printf 'cwd=%s\\n' "$(pwd)"; printf 'cfg=%s\\n' "\${CLAUDE_CONFIG_DIR-unset}"; printf 'stdin=%s\\n' "$(cat | wc -c | tr -d ' ')"; } > "$rec-$name"
case "$name" in
  ok|inherited) cat "${top}/usage.txt" ;;
  login) echo 'Not logged in · Please run /login'; exit 1 ;;
  slow) echo $$ > "$rec-slow.pid"; sleep 5 ;;
  empty) ;;
  fail) echo 'API Error: 500 Internal server error'; exit 1 ;;
  long) cat "${top}/usage.txt"; yes 'filler line of the long output' | head -n 70000 ;;
  garbage) echo 'Something else entirely' ;;
  grandchild) sh -c 'echo $$ > "$1"; exec sleep ${GRANDCHILD_SLEEP}' gc "$rec-grandchild.pid" & echo $$ > "$rec-grandchild-parent.pid"; exec sleep ${GRANDCHILD_SLEEP} ;;
  linger) sh -c 'echo $$ > "$1"; exec sleep ${GRANDCHILD_SLEEP}' gc "$rec-linger.pid" & cat "${top}/usage.txt" ;;
  floodgc) sh -c 'echo $$ > "$1"; exec sleep ${GRANDCHILD_SLEEP}' gc "$rec-floodgc.pid" & cat "${top}/usage.txt"; yes 'filler line of the long output' | head -n 70000 ;;
esac
`
  fs.writeFileSync(join(bin, 'claude'), script, { mode: 0o755 })
  const cfg = name => {
    const dir = join(top, 'cfg', name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
  const run = (request, env = {}) => helper('probeUsage', request, { PATH: `${bin}:${process.env.PATH}`, ...env })
  const record = name => Object.fromEntries(fs.readFileSync(join(top, `rec-${name}`), 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  return { top, bin, cfg, run, record }
}

const MAIN_WINDOWS = { five: { percent: 12, resets: 'Oct 11, 11:20am (Europe/Budapest)' }, seven: { percent: 41, resets: 'Oct 16, 1pm (Europe/Budapest)' } }

test('probeUsage: claude -p /usage --no-session-persistence with CLAUDE_CONFIG_DIR set, in /, stdin closed; only the two windows come back', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const fake = await fakeClaude()
  try {
    const dir = fake.cfg('ok')
    const got = fake.run({ configDir: dir })
    assert.equal(got.code, 0, got.stdout)
    assert.deepEqual(got.answer, { ok: true, ...MAIN_WINDOWS })
    assert.equal(got.stderr, '')
    assert.ok(!got.stdout.includes(dir) && !got.stdout.includes('subscription') && !got.stdout.includes('Fable'), got.stdout)
    assert.deepEqual(fake.record('ok'), { args: '-p /usage --no-session-persistence', cwd: '/', cfg: dir, stdin: '0' })
    // Nothing written beside the record of the fake: the text is never put on disk.
    assert.deepEqual(fs.readdirSync(fake.top).sort(), ['bin', 'cfg', 'rec-ok', 'usage.txt'])
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally {
    fs.rmSync(fake.top, { recursive: true, force: true })
  }
})

test('probeUsage: isInherited leaves CLAUDE_CONFIG_DIR out, even when the helper itself has one', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const fake = await fakeClaude()
  try {
    const got = fake.run({ configDir: fake.cfg('default'), isInherited: true }, { CLAUDE_CONFIG_DIR: join(fake.top, 'cfg', 'elsewhere') })
    assert.deepEqual(got.answer, { ok: true, ...MAIN_WINDOWS })
    assert.equal(fake.record('inherited').cfg, 'unset')
  } finally {
    fs.rmSync(fake.top, { recursive: true, force: true })
  }
})

test('probeUsage: each failure is its fixed code alone (NOT_LOGGED_IN, FAILED, PARSE, NO_CLAUDE), with no text, path or environment', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const fake = await fakeClaude()
  try {
    for (const [name, code] of [['login', 'NOT_LOGGED_IN'], ['fail', 'FAILED'], ['empty', 'PARSE'], ['garbage', 'PARSE']]) {
      const dir = fake.cfg(name)
      assertFailure(fake.run({ configDir: dir }), code, dir)
    }
    // No claude on the PATH at all.
    const dir = fake.cfg('ok')
    assertFailure(helper('probeUsage', { configDir: dir }, { PATH: join(fake.top, 'cfg') }), 'NO_CLAUDE', dir)
    // A request without a directory, or with a relative one, runs nothing.
    assertFailure(fake.run({}), 'BAD_REQUEST')
    assertFailure(fake.run({ configDir: '' }), 'BAD_REQUEST')
    assertFailure(fake.run({ configDir: 'cfg/ok' }), 'BAD_REQUEST')
    assertFailure(fake.run({ configDir: 7 }), 'BAD_REQUEST')
  } finally {
    fs.rmSync(fake.top, { recursive: true, force: true })
  }
})

test('probeUsage: an output past the 1 MiB cap stops claude and the windows at its top are read', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const fake = await fakeClaude()
  try {
    assert.deepEqual(fake.run({ configDir: fake.cfg('long') }).answer, { ok: true, ...MAIN_WINDOWS })
  } finally {
    fs.rmSync(fake.top, { recursive: true, force: true })
  }
})

test('probeUsage: past its time claude is killed and the answer is TIMEOUT; the shortened time counts only with SC_HELPER_TEST=1', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const fake = await fakeClaude()
  try {
    const dir = fake.cfg('slow')
    const started = Date.now()
    assertFailure(fake.run({ configDir: dir }, { SC_HELPER_TEST: '1', SC_HELPER_USAGE_TIMEOUT_MS: '500' }), 'TIMEOUT', dir)
    assert.ok(Date.now() - started < 4000)
    const pid = Number(fs.readFileSync(join(fake.top, 'rec-slow.pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
    // Without the test switch the variable is ignored: the five seconds pass and the empty text is PARSE, not TIMEOUT.
    const again = Date.now()
    assertFailure(fake.run({ configDir: dir }, { SC_HELPER_USAGE_TIMEOUT_MS: '500' }), 'PARSE', dir)
    assert.ok(Date.now() - again >= 4500)
  } finally {
    fs.rmSync(fake.top, { recursive: true, force: true })
  }
})

test('probeUsage: on Linux claude runs in a process group of its own; at the timeout the whole group is killed, a sleeping grandchild with it, and no zombie stays', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const fake = await fakeClaude()
  try {
    const dir = fake.cfg('grandchild')
    const started = Date.now()
    assertFailure(fake.run({ configDir: dir }, { SC_HELPER_TEST: '1', SC_HELPER_USAGE_TIMEOUT_MS: '500' }), 'TIMEOUT', dir)
    assert.ok(Date.now() - started < 4000)
    const parent = await recordedPid(fake.top, 'grandchild-parent')
    const grandchild = await recordedPid(fake.top, 'grandchild')
    assert.ok(parent > 1 && grandchild > 1 && parent !== grandchild)
    assert.ok(await isGoneWithin(parent, 3000), `claude ${parent} is still there`)
    assert.ok(await isGoneWithin(grandchild, 3000), `its grandchild ${grandchild} is still there`)
  } finally {
    killOwnLeftovers(fake.top)
    fs.rmSync(fake.top, { recursive: true, force: true })
  }
})

test('probeUsage: an output flood kills the whole group too, and a grandchild that holds the output after claude exits is killed after a short grace; the windows are read in both', { skip: !IS_LINUX || !HAS_TS }, async () => {
  const fake = await fakeClaude()
  try {
    const flood = fake.run({ configDir: fake.cfg('floodgc') })
    assert.deepEqual(flood.answer, { ok: true, ...MAIN_WINDOWS })
    const floodChild = await recordedPid(fake.top, 'floodgc')
    assert.ok(await isGoneWithin(floodChild, 3000), `the flood's grandchild ${floodChild} is still there`)
    const started = Date.now()
    const linger = fake.run({ configDir: fake.cfg('linger') })
    assert.deepEqual(linger.answer, { ok: true, ...MAIN_WINDOWS })
    assert.ok(Date.now() - started < 4000, 'the answer waited for the grandchild')
    const lingerChild = await recordedPid(fake.top, 'linger')
    assert.ok(await isGoneWithin(lingerChild, 3000), `the lingering grandchild ${lingerChild} is still there`)
  } finally {
    killOwnLeftovers(fake.top)
    fs.rmSync(fake.top, { recursive: true, force: true })
  }
})
