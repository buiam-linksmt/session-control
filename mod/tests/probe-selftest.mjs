#!/usr/bin/env node
// Run with `node mod/tests/probe-selftest.mjs` (Node 22 or newer), from any directory; it prints one `ok` line per part
// and stops with exit 1 at the first failed check.
//
// Runs the Node helper's probe (`node mod/helper/host.mjs probe`, as the mod runs it) on the live /proc against a
// fixture config dir: a transcript with a known mtime and a sessions file whose procStart matches this process. Then
// REGISTER_SCRIPT, CLEAR_SCRIPT and ACK_SCRIPT of hooks/core.ts (the jq reference of the registry edits) on scratch
// registries and against the differential cases of REGISTRY_GOLDEN in tests/fixtures.ts, the <Button> shape of
// hooks/register.tsx, and the helper's append and rotate of a log. The registry scripts are sh scripts that call jq,
// and the probe reads /proc: this runs on Linux and WSL. It removes every scratch directory it made. Only the Node
// standard library is used.

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { after, before, pyEqual, pyJson, pyTruthy } from './lib/selftest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const made = []
/** tempfile.mkdtemp: a new directory under the temp dir (TMPDIR), removed at the end. */
const mkdtemp = prefix => {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
/** Python's assert: a failure stops the run with its message, exit 1. */
function check(condition, ...what) {
  if (!condition) throw new Error(`assertion failed: ${what.map(one => (typeof one === 'string' ? one : JSON.stringify(one))).join(' ')}`)
}
const utf8 = new TextDecoder('utf-8', { fatal: true })
/** open(path).read(): UTF-8 (a bad byte is an error), universal newlines. */
const read = path => utf8.decode(fs.readFileSync(path)).replace(/\r\n?/g, '\n')
/** open(path, encoding='utf-8', newline='').read(): UTF-8, no newline translation. */
const readExact = path => utf8.decode(fs.readFileSync(path))
const write = (path, text) => fs.writeFileSync(path, text, 'utf8')
/** subprocess.run(argv, capture_output=True, text=True[, timeout]): the exit code (null on a timeout) and both outputs. */
function run(argv, timeoutSec) {
  const ran = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(timeoutSec ? { timeout: timeoutSec * 1000 } : {}) })
  if (ran.error) throw new Error(`${argv[0]} did not run to its end: ${ran.error.message}`)
  return { returncode: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}
/** json.dump(value, file): the Python default layout (", " and ": "; jq reads it either way). */
const dumpPy = (value, path) => write(path, pyJson(value))
const HELPER = join(HERE, '..', 'helper', 'host.mjs')
/** One helper call as the mod makes it: the request as JSON on stdin; its answer, exit code and stderr. */
function helper(op, request) {
  const ran = spawnSync(process.execPath, [HELPER, op], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
  if (ran.error) throw new Error(`the helper did not run to its end: ${ran.error.message}`)
  return { answer: JSON.parse(ran.stdout), returncode: ran.status, stderr: ran.stderr }
}

try {
  const src = fs.readFileSync(join(HERE, '..', 'hooks', 'core.ts'), 'utf8')

  const cfg = mkdtemp('session-probe-')
  const sid = '11111111-2222-4333-8444-555555555555'
  fs.mkdirSync(`${cfg}/projects/-some-cwd`, { recursive: true })
  fs.mkdirSync(`${cfg}/sessions`)
  const tr = `${cfg}/projects/-some-cwd/${sid}.jsonl`
  write(tr, '{}\n')
  fs.utimesSync(tr, 1_700_000_000, 1_700_000_000)
  const pid = process.pid
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const procStart = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
  dumpPy({ sessionId: sid, procStart }, `${cfg}/sessions/${pid}.json`)

  const probe = helper('probe', { args: [`t:${sid}|${cfg}`, `pid:${pid}|${cfg}`] })
  check(probe.returncode === 0 && probe.answer.ok === true && probe.stderr === '', `probe failed: ${probe.returncode} ${JSON.stringify(probe.answer)} ${JSON.stringify(probe.stderr)}`)
  const out = String(probe.answer.out)
  check(out.includes(`T\t${sid}\t1700000000`), out)
  const proof = out.split('\n').filter(l => l.startsWith(`A\t${pid}\t`))
  check(proof.length > 0, out)
  const cols = proof[0].split('\t')
  check(cols[3] === procStart && cols[4] === procStart && cols[5] === sid, cols)
  console.log('probe-selftest: ok')

  // --- the P lines carry elapsed seconds without `ps`
  const elapsedRun = helper('probe', { args: [] })
  const plines = String(elapsedRun.answer.out).split('\n').filter(l => l.startsWith('P\t')).map(l => l.split('\t'))
  check(plines.length > 0, 'no claude process seen')
  check(plines.every(c => /^\d+$/.test(c[3] ?? '')), plines)

  // --- REGISTER_SCRIPT appends and updates in place through a temp file and mv
  const raw = before(after(src, 'export const REGISTER_SCRIPT = String.raw`'), '`\n')
  let reg = join(mkdtemp('session-reg-'), 'headless-sessions.json')
  dumpPy([{ session_id: 'old', title: 'x', reported: false, outcome: { kind: 'clean' }, resume: { keep: 1 }, pid: null }], reg)
  const fresh = { title: 'n', pid: 7, session_id: 'new-sid', config_dir: '/c', cwd: '/w', model: 'm', effort: 'e' }
  const r1 = run(['sh', '-c', raw, 'session-register', reg, pyJson(fresh), 'new'])
  check(r1.returncode === 0, r1.stderr)
  let data = JSON.parse(read(reg))
  check(isDeepStrictEqual(data.map(e => e.session_id), ['old', 'new-sid']) && isDeepStrictEqual(data[0].resume, { keep: 1 }), data)
  const upd = { session_id: 'old', pid: 9, result_file: '/r.json' }
  const r2 = run(['sh', '-c', raw, 'session-register', reg, pyJson(upd), 'resume'])
  check(r2.returncode === 0, r2.stderr)
  data = JSON.parse(read(reg))
  check(data[0].pid === 9 && data[0].result_file === '/r.json' && !('reported' in data[0]) && !('outcome' in data[0]) && isDeepStrictEqual(data[0].resume, { keep: 1 }), data[0])
  check(data[1].session_id === 'new-sid', data)
  check(!fs.readdirSync(dirname(reg)).some(f => f.includes('.tmp.')))
  console.log('register-selftest: ok')

  // Static guard: the user's engine (2.1.292) refuses a <Button> whose child is an element; a Button takes a label or one string.
  const tsx = fs.readFileSync(join(HERE, '..', 'hooks', 'register.tsx'), 'utf8')
  for (const m of tsx.matchAll(/<Button\b[^>]*?(\/>|>)/gs)) {
    if (m[1] === '>') {
      const end = m.index + m[0].length
      const following = tsx.slice(end, end + 80).trimStart()
      check(!following.startsWith('<'), 'a <Button> holds an element child: ' + following.slice(0, 40))
    }
  }
  console.log('button-shape-selftest: ok')

  // --- CLEAR_SCRIPT removes the named sessions, logs them first, leaves the rest untouched
  const clear = before(after(src, 'export const CLEAR_SCRIPT = String.raw`'), '`\n').replaceAll('\\n', '\n')
  check(run(['sh', '-n', '-c', clear]).returncode === 0)
  const d = mkdtemp('session-clear-')
  reg = `${d}/reg.json`
  let log = `${d}/cleared.jsonl`
  dumpPy([{ title: 'a', session_id: 'aaa', reported: false, resume: { strikes: 2 } },
    { title: 'b', session_id: 'bbb', unknown: [1, 2] },
    { title: 'c', session_id: 'ccc' }], reg)
  let r = run(['sh', '-c', clear, 'session-clear', reg, log, 'aaa', 'ccc'], 30)
  check(r.returncode === 0 && r.stderr === '', r.stderr)
  const left = JSON.parse(read(reg))
  check(isDeepStrictEqual(left.map(e => e.session_id), ['bbb']) && isDeepStrictEqual(left[0].unknown, [1, 2]), left)
  const logged = read(log).split('\n').filter((l, i, all) => i < all.length - 1 || l !== '').map(l => JSON.parse(l))
  check(isDeepStrictEqual(logged.map(e => e.session_id), ['aaa', 'ccc']) && isDeepStrictEqual(logged[0].resume, { strikes: 2 }), logged)
  check(!fs.readdirSync(d).some(f => f.startsWith('reg.json.tmp')))
  const nothing = run(['sh', '-c', clear, 'session-clear', reg, log], 30)
  check(nothing.returncode === 0 && isDeepStrictEqual(JSON.parse(read(reg)), left))
  console.log('clear-selftest: ok')

  // --- ACK_SCRIPT marks sessions acknowledged (and kept on request), leaving the rest untouched
  const ack = before(after(src, 'export const ACK_SCRIPT = String.raw`'), '`\n').replaceAll('\\n', '\n')
  check(run(['sh', '-n', '-c', ack]).returncode === 0)
  const d2 = mkdtemp('session-ack-')
  const reg2 = `${d2}/reg.json`
  dumpPy([{ title: 'a', session_id: 'aaa', reported: false, resume: { strikes: 2 } },
    { title: 'b', session_id: 'bbb', reported: false }], reg2)
  r = run(['sh', '-c', ack, 'session-ack', reg2, 'keep', 'aaa'], 30)
  check(r.returncode === 0 && r.stderr === '', r.stderr)
  let got = JSON.parse(read(reg2))
  check(got[0].reported === true && got[0].keep === true && isDeepStrictEqual(got[0].resume, { strikes: 2 }), got)
  check(got[1].reported === false && !('keep' in got[1]), got)
  run(['sh', '-c', ack, 'session-ack', reg2, 'plain', 'bbb'], 30)
  got = JSON.parse(read(reg2))
  check(got[1].reported === true && !('keep' in got[1]), got)
  run(['sh', '-c', ack, 'session-ack', reg2, 'plain', 'aaa'], 30)
  got = JSON.parse(read(reg2))
  check(got[0].reported === true && !('keep' in got[0]), got)
  console.log('ack-selftest: ok')

  // --- registry edits: REGISTER_SCRIPT, CLEAR_SCRIPT and ACK_SCRIPT against the differential cases the TypeScript
  // edits are tested on (REGISTRY_GOLDEN in tests/fixtures.ts); together they prove both write the same bytes.
  const fx = fs.readFileSync(join(HERE, 'fixtures.ts'), 'utf8')
  const goldenBlock = before(after(fx, '// REGISTRY_GOLDEN:BEGIN'), '// REGISTRY_GOLDEN:END')
  const golden = JSON.parse(after(goldenBlock, ' = '))
  const scripts = { register: raw, clear, ack }
  const goldDir = fs.mkdtempSync(join(tmpdir(), 'session-golden-'))
  try {
    golden.forEach((one, n) => {
      const greg = `${goldDir}/${n}.json`
      const glog = `${goldDir}/${n}.cleared.jsonl`
      if (one.registry !== null) fs.writeFileSync(greg, one.registry, 'utf8')
      let argv
      // The entry as Python's json.dumps(separators=(',', ':'), ensure_ascii=False) writes it, which is JSON.stringify's text.
      if (one.op === 'register') argv = ['session-register', greg, JSON.stringify(one.entry), one.mode]
      else if (one.op === 'clear') argv = ['session-clear', greg, glog, ...one.ids]
      else argv = ['session-ack', greg, one.keep ? 'keep' : 'plain', ...one.ids]
      const ran = spawnSync('sh', ['-c', scripts[one.op], ...argv], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
      if (ran.error) throw new Error(`${one.name}: sh did not run to its end: ${ran.error.message}`)
      const text = fs.existsSync(greg) ? readExact(greg) : null
      const loggedText = fs.existsSync(glog) ? readExact(glog) : ''
      const want = pyTruthy(one.old) ? one.old : one.expect
      const where = `${one.name}: exit ${ran.status}, ${JSON.stringify(text).slice(0, 200)}, log ${JSON.stringify(loggedText).slice(0, 200)}`
      if (pyTruthy(want.refused) || pyTruthy(want.fails)) check(ran.status !== 0 && text === one.registry, where)
      else if (pyTruthy(want.unchanged)) check(ran.status === 0 && text === one.registry, where)
      else if (pyTruthy(want.sameValue)) check(ran.status === 0 && pyEqual(JSON.parse(text), JSON.parse(one.expect.text)), where)
      else check(ran.status === 0 && text === want.text, where)
      check(loggedText === (want.log ?? ''), where)
    })
  } finally {
    fs.rmSync(goldDir, { recursive: true, force: true })
  }
  console.log(`registry-golden-selftest: ok (${golden.length} cases)`)

  // --- the helper's append adds lines to the cleared log without reading it, whatever its size
  const appendDir = fs.mkdtempSync(join(tmpdir(), 'session-append-'))
  try {
    log = `${appendDir}/cleared.jsonl`
    const big = '{"x":"' + 'y'.repeat(5 * 1024 * 1024) + '"}\n'
    write(log, big)
    const lines = '{"session_id":"a","t":"caf\u{e9}"}\n{"session_id":"b"}'
    const appended = helper('append', { path: log, text: `${lines}\n` })
    check(appended.returncode === 0 && appended.answer.ok === true && appended.stderr === '', appended)
    check(read(log) === big + lines + '\n')
  } finally {
    fs.rmSync(appendDir, { recursive: true, force: true })
  }
  console.log('append-selftest: ok')

  // --- the helper's rotate keeps three trace files: .1 moves to .2 (the oldest goes), the trace becomes .1. It reads the
  // size itself, so of several processes that found the trace too big only the first rotates; a missing trace is no
  // failure.
  const rotateDir = fs.mkdtempSync(join(tmpdir(), 'session-rotate-'))
  const rotateRequest = (trace, maxBytes, adding) => ({ path: trace, adding, maxBytes, moves: [[`${trace}.1`, `${trace}.2`], [trace, `${trace}.1`]] })
  const rotateRun = (trace, maxBytes, adding) => {
    const ran = helper('rotate', rotateRequest(trace, maxBytes, adding))
    return { returncode: ran.answer.ok === true ? ran.returncode : 1, stderr: ran.stderr, answer: ran.answer }
  }
  const listed = () => fs.readdirSync(rotateDir).sort()
  try {
    const trace = `${rotateDir}/trace.log`
    for (const [name, text] of [['trace.log', 'new\n'], ['trace.log.1', 'mid\n'], ['trace.log.2', 'old\n']]) write(`${rotateDir}/${name}`, text)
    // Within the limit (4 + 6 bytes of 10): nothing moves.
    r = rotateRun(trace, 10, 6)
    check(r.returncode === 0 && r.stderr === '', r)
    check(isDeepStrictEqual(listed(), ['trace.log', 'trace.log.1', 'trace.log.2']) && read(trace) === 'new\n')
    r = rotateRun(trace, 10, 7)
    check(r.returncode === 0 && r.stderr === '', r)
    check(isDeepStrictEqual(listed(), ['trace.log.1', 'trace.log.2']), listed())
    check(read(`${trace}.1`) === 'new\n' && read(`${trace}.2`) === 'mid\n')
    // The trace is gone (another process rotated it): nothing to do, no failure, no message.
    r = rotateRun(trace, 10, 100)
    check(r.returncode === 0 && r.stderr === '', r)
    check(isDeepStrictEqual(listed(), ['trace.log.1', 'trace.log.2']))
    // An empty trace is never rotated.
    write(trace, '')
    r = rotateRun(trace, 10, 100)
    check(r.returncode === 0 && isDeepStrictEqual(listed(), ['trace.log', 'trace.log.1', 'trace.log.2']))
    // The first rotation: only the trace is there.
    write(trace, 'first\n')
    fs.rmSync(`${trace}.1`)
    fs.rmSync(`${trace}.2`)
    r = rotateRun(trace, 10, 100)
    check(r.returncode === 0 && r.stderr === '', r)
    check(isDeepStrictEqual(listed(), ['trace.log.1']) && read(`${trace}.1`) === 'first\n')
    // A trace that is there and cannot be moved (a read-only directory; root moves it anyway) is a failure.
    if (process.geteuid() !== 0) {
      write(trace, 'stuck\n')
      fs.chmodSync(rotateDir, 0o555)
      try {
        r = rotateRun(trace, 1, 100)
      } finally {
        fs.chmodSync(rotateDir, 0o755)
      }
      check(r.returncode === 1 && fs.existsSync(trace), r)
    }
    // Eight processes find the same big trace and rotate at once, many times over: every one ends with exit 0 and no
    // message, at most three files remain and the big trace is kept whole as .1 or .2.
    const big = 'x'.repeat(5000) + '\n'
    const racer = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HELPER, 'rotate'])
        let err = ''
        let answer = ''
        child.stdout.on('data', chunk => (answer += chunk))
        child.stderr.on('data', chunk => (err += chunk))
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
        child.on('error', reject)
        child.on('close', code => {
          clearTimeout(timer)
          resolve({ code, err, answer })
        })
        child.stdin.end(JSON.stringify(rotateRequest(trace, 4096, 10)))
      })
    for (let round = 0; round < 20; round++) {
      for (const name of fs.readdirSync(rotateDir)) fs.rmSync(`${rotateDir}/${name}`)
      write(trace, big)
      write(`${trace}.1`, 'mid\n')
      const racers = await Promise.all(Array.from({ length: 8 }, racer))
      for (const one of racers) check(one.code === 0 && one.err === '' && JSON.parse(one.answer).ok === true, [one.code, one.err, one.answer])
      const remaining = listed()
      check(remaining.every(name => ['trace.log', 'trace.log.1', 'trace.log.2'].includes(name)) && !remaining.includes('trace.log'), remaining)
      check(remaining.map(name => read(`${rotateDir}/${name}`)).includes(big), remaining)
    }
  } finally {
    fs.rmSync(rotateDir, { recursive: true, force: true })
  }
  console.log('rotate-selftest: ok')
} finally {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true })
}
