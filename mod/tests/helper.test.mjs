// The Node helper (mod/helper/host.mjs) as a process, the way the mod runs it: `node host.mjs <op>`, one JSON request
// on stdin, one JSON answer on stdout. Run with `node --test mod/tests/helper.test.mjs` (Node 22 or newer). The probe
// is checked against the shell probe (PROBE_SCRIPT of hooks/host-posix.ts) run over the same fake /proc tree.

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = join(HERE, '..', 'helper', 'host.mjs')
const IS_LINUX = process.platform === 'linux'
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0

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

/** REMOVE_REGULAR_SCRIPT of hooks/host-posix.ts, the adapter's own removal of a regular file, as the mod runs it. */
function removeRegularScript() {
  const src = fs.readFileSync(join(HERE, '..', 'hooks', 'host-posix.ts'), 'utf8')
  const found = /export const REMOVE_REGULAR_SCRIPT = String\.raw`([\s\S]*?)`\n/.exec(src)
  assert.ok(found, 'REMOVE_REGULAR_SCRIPT not found')
  return found[1]
}

test('REMOVE_REGULAR_SCRIPT under sh (the native fallback): the same answers as the helper, by exit code (0 removed, 3 not there, 4 a link, 5 no regular file)', { skip: !IS_LINUX }, () => {
  const dir = scratch()
  const outside = scratch()
  try {
    const script = removeRegularScript()
    const run = path => spawnSync('sh', ['-c', script, 'session-remove', path]).status
    const runs = join(dir, 'runs')
    fs.mkdirSync(runs)
    fs.writeFileSync(join(outside, 'secret.txt'), 'outside file')
    fs.writeFileSync(join(runs, 'plain.json'), 'plain')
    fs.writeFileSync(join(runs, '-dash [x] \'q\'.json'), 'odd name')
    fs.mkdirSync(join(runs, 'sub'))
    fs.symlinkSync(join(outside, 'secret.txt'), join(runs, 'link.json'))
    fs.symlinkSync(outside, join(runs, 'linkdir'), 'dir')
    fs.symlinkSync(join(outside, 'missing'), join(runs, 'dangling.json'))
    assert.equal(run(join(runs, 'plain.json')), 0)
    assert.equal(fs.existsSync(join(runs, 'plain.json')), false)
    assert.equal(run(join(runs, '-dash [x] \'q\'.json')), 0)
    assert.equal(run(join(runs, 'plain.json')), 3)
    assert.equal(run(join(runs, 'link.json')), 4)
    assert.equal(run(join(runs, 'linkdir')), 4)
    assert.equal(run(join(runs, 'dangling.json')), 4)
    assert.equal(run(join(runs, 'sub')), 5)
    for (const name of ['link.json', 'linkdir', 'dangling.json']) assert.ok(fs.lstatSync(join(runs, name)).isSymbolicLink(), name)
    assert.equal(fs.readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside file')
    assert.ok(fs.statSync(join(runs, 'sub')).isDirectory())
    // A relative path that begins with a dash is a file name, not an option.
    const plainDir = spawnSync('sh', ['-c', `${script}`, 'session-remove', '-x'], { cwd: runs })
    assert.equal(plainDir.status, 3)
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

/** NEWER_SCRIPT of hooks/host-posix.ts, as the mod runs it. */
function newerScript() {
  const src = fs.readFileSync(join(HERE, '..', 'hooks', 'host-posix.ts'), 'utf8')
  const found = /export const NEWER_SCRIPT = String\.raw`([\s\S]*?)`\n/.exec(src)
  assert.ok(found, 'NEWER_SCRIPT not found')
  return found[1]
}

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

test('filesNewerThan: the same files, order and count as NEWER_SCRIPT under sh over the same tree', { skip: !IS_LINUX || !has('find') || !has('sort') || !has('awk') }, () => {
  const top = scratch()
  try {
    const dir = join(top, 'work tree')
    put(join(dir, 'a.txt'), T + 30.25)
    put(join(dir, 'deep', 'er', 'b b.txt'), T + 20)
    put(join(dir, 'tie2.txt'), T + 25)
    put(join(dir, 'tie1.txt'), T + 25)
    put(join(dir, 'old.txt'), T - 5)
    put(join(dir, '.git', 'x'), T + 60)
    put(join(top, 'outside.txt'), T + 70)
    fs.symlinkSync(top, join(dir, 'up'))
    fs.symlinkSync(join(top, 'outside.txt'), join(dir, 'l.txt'))
    for (const max of [10, 2]) {
      const sh = spawnSync('sh', ['-c', newerScript(), 'session-newer', dir, String(T), String(max)], { encoding: 'utf8' })
      assert.equal(sh.status, 0, sh.stderr)
      const lines = sh.stdout.trimEnd().split('\n')
      const total = Number(lines.pop().split('\t')[1])
      const shFiles = lines.map(line => {
        const [sec, ...rest] = line.split('\t')
        const [whole, fraction = ''] = sec.split('.')
        return { path: rest.join('\t'), mtimeMs: Number(whole) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3)) }
      })
      const run = helper('filesNewerThan', { dir, since: T, max })
      assert.deepEqual({ files: shFiles, total }, { files: run.answer.files, total: run.answer.total })
    }
    assert.equal(spawnSync('sh', ['-c', newerScript(), 'session-newer', join(top, 'none'), String(T), '10']).status, 3)
  } finally {
    fs.rmSync(top, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- the probe over a fake /proc tree

/** PROBE_SCRIPT of hooks/host-posix.ts, as the mod runs it. */
function probeScript() {
  const src = fs.readFileSync(join(HERE, '..', 'hooks', 'host-posix.ts'), 'utf8')
  const found = /export const PROBE_SCRIPT = (\[[\s\S]*?\])\.join\('\\n'\)/.exec(src)
  assert.ok(found, 'PROBE_SCRIPT not found in host-posix.ts')
  return vm.runInNewContext(found[1]).join('\n')
}

const CANARY = 'sk-canary-env-0123456789abcdef'

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

/** The lines the fake tree gives, recorded from PROBE_SCRIPT under sh (<cfg> and <root> stand for the tree's paths). */
const RECORDED = [
  'P\t100\tclaude\t8765\t<root>/work dir\t<cfg>\tclaude -p --model opus -- hello there next line ',
  'P\t2000\tclaude\t3765\t/\t\tclaude --resume abc ',
  'P\t4\tclaude\t28765\t\t\t',
  'A\t100\tclaude\t9000000\t9000000\tsid-a',
  'A\t2000\tclaude\t9500000\t\t',
  'A\t4\tclaude\t7000000\t7000000\t',
  'T\tsid-a\t1700000000',
  '',
].join('\n')

test('probe: the fake /proc tree gives the recorded PROBE_SCRIPT lines, the same as the shell probe over it', { skip: !IS_LINUX || !has('jq') }, () => {
  const tree = fakeTree()
  try {
    const want = RECORDED.replaceAll('<cfg>', tree.cfg).replaceAll('<root>', tree.root)
    const shell = spawnSync('sh', ['-c', probeScript().replaceAll('/proc', tree.proc), 'session-probe', ...tree.args]).stdout.toString('utf8')
    assert.equal(shell, want)
    const run = helper('probe', { args: tree.args }, { SC_HELPER_TEST: '1', SC_HELPER_PROC_ROOT: tree.proc })
    assert.equal(run.code, 0)
    assert.deepEqual(Object.keys(run.answer), ['ok', 'out'])
    assert.equal(run.answer.out, want)
    // One difference on purpose: a pid that is no number (the registry never holds one: probeArgs takes numbers only)
    // is never looked up, where the shell would print a line for /proc/self.
    fs.mkdirSync(join(tree.proc, 'self'))
    const shellSelf = spawnSync('sh', ['-c', probeScript().replaceAll('/proc', tree.proc), 'session-probe', 'pid:self|~']).stdout.toString('utf8')
    assert.ok(shellSelf.includes('A\tself\t'))
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

test('probe: the live /proc gives the shell probe\'s lines, elapsed seconds aside', { skip: !IS_LINUX || !has('jq') }, () => {
  const shell = spawnSync('sh', ['-c', probeScript(), 'session-probe']).stdout.toString('utf8')
  const node = helper('probe', { args: [] }).answer.out
  const strip = text => text.split('\n').map(line => line.split('\t').filter((_, at) => at !== 3).join('\t')).join('\n')
  // A claude process may start or end between the two runs: the lines both saw are the same.
  const shellLines = new Set(strip(shell).split('\n'))
  const nodeLines = strip(node).split('\n')
  const common = nodeLines.filter(line => shellLines.has(line))
  assert.ok(common.length >= Math.min(shellLines.size, nodeLines.length) - 2, `${shell}\n---\n${node}`)
})
