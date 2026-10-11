#!/usr/bin/env node
// The Node port of windows-selftest.py: run with `node mod/tests/windows-selftest.mjs` (Node 22 or newer). It checks
// the same things with the same fixtures and prints the same `ok` lines; windows-selftest.py stays beside it, and the
// two must agree (a difference is a bug in one of them). Only the Node standard library is used.
//
// Where it runs: from WSL, where Windows PowerShell is reachable through interop (paths converted with wslpath, the
// Windows programs started from Linux), as the Python version runs; and natively on Windows (process.platform win32),
// where it starts powershell.exe, cmd.exe, Git Bash's bash.exe and node.exe directly and uses Windows paths as they
// are. THE NATIVE WINDOWS BRANCH IS UNVERIFIED: it has not been run on a Windows host; only the WSL branch has.
// Without powershell.exe it prints `skipped`.
//
// Extracts the Windows PowerShell scripts from hooks/host-windows.ts, writes them to a scratch directory on the Windows
// side and runs them through powershell.exe, the way the mod runs them on native Windows (absolute path, -File).
// It proves the scripts' own behaviour on this host's PowerShell and file system only: not what the Windows engine
// passes them, nor a real claude.exe. NEWER_PS1 (the listing of the files written after a time) runs over a scratch
// tree holding a .git folder and a junction out of the tree. The scratch directory is a new folder under SC_WIN_SCRATCH
// (a Windows path) or under the Windows %TEMP%, and is removed at the end.
//
// Its last parts copy the Node helper (mod/helper/*.mjs) to the scratch directory and run its file operations with the
// Windows node.exe (SC_WIN_NODE, else C:\Program Files\nodejs\node.exe from WSL and the node.exe running this test on
// native Windows), as the mod does on native Windows: rename over an existing file (also while another process holds
// it open), append, remove, the tail of a 3 MB UTF-8 file with CRLF line ends and non-ASCII text, filesNewerThan over
// the tree NEWER_PS1 listed (the junction neither followed nor listed), hashTree over two copies of a mod folder (the
// SHA-256 of each file against Node's own, a junction in hooks neither followed nor hashed, the generated
// .claude-plugin/types and tests left out, the fixed codes), and a batch of 20 operations, with the time per batch;
// then probeUsage's process shape: claude.exe looked up on a PATH of one scratch folder without a shell (a copy of
// node.exe stands in, so no claude starts), a claude.cmd alone and an empty PATH answered NO_CLAUDE; then the stop of
// stop_worker on a throwaway node.exe tree of its own. Without that node.exe those parts print `skipped`.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { after, before, isDigits, median, pyEqual, pyInt, pyJson, pyLiteral, pySlice, pySplitlines, sleepMs } from './lib/selftest.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IS_WINDOWS = process.platform === 'win32'
const utf8 = new TextDecoder('utf-8', { fatal: true })
const utf8Lenient = new TextDecoder('utf-8')
const readFile = path => fs.readFileSync(path, 'utf8')
const SRC = readFile(join(HERE, '..', 'hooks', 'core.ts'))
// The scripts the Windows adapter runs (FILES_PS1, PROBE_PS1) live in hooks/host-windows.ts.
const WIN_SRC = readFile(join(HERE, '..', 'hooks', 'host-windows.ts'))

/** shutil.which: the first file of that name on the PATH (on Windows also with each PATHEXT ending). */
function which(name) {
  const endings = IS_WINDOWS && !/\.[^\\/.]+$/.test(name) ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ending of endings) {
      const candidate = join(dir, name + ending)
      try {
        if (!fs.statSync(candidate).isFile()) continue
        if (!IS_WINDOWS) fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {}
    }
  }
  return undefined
}

const SYSTEM32 = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`
const PS = which('powershell.exe') ?? (IS_WINDOWS ? `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe` : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
if (!fs.existsSync(PS)) {
  console.log('windows-selftest: skipped (no powershell.exe)')
  process.exit(0)
}

/** Python's assert: a failure stops the run with its message, exit 1. */
function check(condition, ...what) {
  if (!condition) throw new Error(`assertion failed: ${what.map(one => (typeof one === 'string' ? one : JSON.stringify(one))).join(' ')}`)
}

/** subprocess.run(argv, capture_output=True): the exit code and both outputs as bytes; a timeout or a missing program is an error. */
function runBytes(argv, { timeout = undefined, cwd = undefined, input = undefined } = {}) {
  const ran = spawnSync(argv[0], argv.slice(1), { cwd, input, maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...(timeout ? { timeout: timeout * 1000 } : {}) })
  if (ran.error) throw new Error(`${argv[0]} did not run to its end: ${ran.error.message}`)
  return { returncode: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}
/** The same with text=True: both outputs decoded (a bad byte is an error) with universal newlines. */
function runText(argv, options = {}) {
  const r = runBytes(argv, options)
  const text = buf => utf8.decode(buf).replace(/\r\n?/g, '\n')
  const out = { returncode: r.returncode, stdout: text(r.stdout), stderr: text(r.stderr) }
  if (options.check && out.returncode !== 0) throw new Error(`${argv.join(' ')} exited ${out.returncode}: ${out.stderr}`)
  return out
}
/** subprocess.Popen(argv, cwd=...): a process not waited for; wait() gives its exit code or fails past the timeout. */
function startProc(argv, cwd) {
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  const exited = new Promise(done => {
    child.on('exit', code => done(code))
    child.on('error', () => done(null))
  })
  return {
    child,
    async wait(seconds) {
      let timer
      const late = new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`a process did not end within ${seconds} s`)), seconds * 1000)))
      try {
        return await Promise.race([exited, late])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
const sha256 = data => createHash('sha256').update(data).digest('hex')
/** bytes.replace(b'\r\n', b'\n') */
function crlfToLf(buf) {
  const out = []
  for (let i = 0; i < buf.length; i++) if (!(buf[i] === 13 && buf[i + 1] === 10)) out.push(buf[i])
  return Buffer.from(out)
}
/** text.rsplit(sep, 1)[0] */
const rsplitFirst = (text, sep) => (text.lastIndexOf(sep) < 0 ? text : text.slice(0, text.lastIndexOf(sep)))
const count = (text, part) => text.split(part).length - 1
const cpLen = text => Array.from(text).length
/** open(path, 'w', encoding='ascii', newline='').write(text): a character past ASCII is an error. */
function writeAscii(path, text) {
  if (/[^\x00-\x7f]/.test(text)) throw new Error(`not ASCII: ${path}`)
  fs.writeFileSync(path, text, 'latin1')
}

/** A `[...].join('\r\n')` constant of host-windows.ts, as the text the mod writes. */
function constant(name) {
  const body = before(after(WIN_SRC, `export const ${name} = [`), "].join('\\r\\n')")
  const lines = pySplitlines(body.trim()).map(l => l.trim())
  return lines.filter(l => l && !l.startsWith('//')).map(l => pyLiteral(l.replace(/,+$/, ''))).join('\r\n')
}

/** A Windows path as this side's file functions take it: the WSL form from WSL, the path itself on Windows. */
const toWsl = win => (IS_WINDOWS ? win : runText(['wslpath', '-u', win], { check: true }).stdout.trim())
/** A path in the Windows form, C:/... (slash '/') or C:\... (slash '\\'). */
function toWin(path, slash = '/') {
  if (IS_WINDOWS) {
    const full = resolve(path)
    return slash === '/' ? full.replaceAll('\\', '/') : full.replaceAll('/', '\\')
  }
  return runText(['wslpath', slash === '/' ? '-m' : '-w', path], { check: true }).stdout.trim()
}

const baseWin = process.env.SC_WIN_SCRATCH || runText([PS, '-NoProfile', '-NonInteractive', '-Command', '[IO.Path]::GetTempPath()'], { cwd: IS_WINDOWS ? undefined : '/mnt/c' }).stdout.trim()
const base = toWsl(baseWin)
fs.mkdirSync(base, { recursive: true })
const work = fs.mkdtempSync(join(base, 'sc-selftest-'))
const win = toWin(work)

function run(scriptName, text, ...args) {
  const path = join(work, scriptName)
  fs.writeFileSync(path, text, 'utf8')
  const argv = [PS, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${win}/${scriptName}`, ...args]
  const r = runBytes(argv, { timeout: 60, cwd: work })
  return [r.returncode, utf8.decode(r.stdout), utf8Lenient.decode(r.stderr)]
}
const put = (name, text) => fs.writeFileSync(join(work, name), text, 'utf8')
function get(name) {
  const path = join(work, name)
  return fs.existsSync(path) ? utf8.decode(fs.readFileSync(path)) : null
}
const exists = path => fs.existsSync(path)
/** os.makedirs(path): the parents made too; a path that is already there is an error. */
function makedirs(path) {
  if (fs.existsSync(path)) throw new Error(`already there: ${path}`)
  fs.mkdirSync(path, { recursive: true })
}
const JUNCTION_PS1 = 'param([string]$L, [string]$T)\r\n$null = New-Item -ItemType Junction -Path $L -Target $T\r\n'

try {
  const files = constant('FILES_PS1')
  // move onto a name that is not there yet; spaces and brackets stay literal
  put('a b [1].tmp', 'one')
  let [code, out, err] = run('files.ps1', files, 'move', `${win}/a b [1].tmp`, `${win}/reg [x].json`)
  check(code === 0 && err === '', [code, err])
  check(get('reg [x].json') === 'one' && get('a b [1].tmp') === null)
  // move over an existing file: replaced in one step
  put('reg [x].json.tmp.1', 'two')
  ;[code, out, err] = run('files.ps1', files, 'move', `${win}/reg [x].json.tmp.1`, `${win}/reg [x].json`)
  check(code === 0 && get('reg [x].json') === 'two' && get('reg [x].json.tmp.1') === null, [code, err])
  // backslash paths work the same
  put('c.tmp', 'three')
  ;[code, out, err] = run('files.ps1', files, 'move', toWin(join(work, 'c.tmp'), '\\'), toWin(join(work, 'reg [x].json'), '\\'))
  check(code === 0 && get('reg [x].json') === 'three', [code, err])
  // a failed move exits 1 with the reason and leaves the target alone
  ;[code, out, err] = run('files.ps1', files, 'move', `${win}/missing.tmp`, `${win}/reg [x].json`)
  check(code === 1 && err.trim() !== '' && get('reg [x].json') === 'three', [code, err])
  // remove: a file goes, a missing one is no error
  put('gone.tmp', 'x')
  check(run('files.ps1', files, 'remove', `${win}/gone.tmp`)[0] === 0 && get('gone.tmp') === null)
  check(run('files.ps1', files, 'remove', `${win}/gone.tmp`)[0] === 0)
  // tail: the last lines, each cut to the width, as UTF-8
  const tailLines = Array.from({ length: 700 }, (_, i) => pyJson({ n: i, text: 'caf\u{e9} \u{2615} \u{1F600}' }))
  tailLines[650] = 'x'.repeat(25000)
  put('t.jsonl', tailLines.join('\n') + '\n')
  ;[code, out, err] = run('files.ps1', files, 'tail', `${win}/t.jsonl`, '600', '20000')
  check(code === 0, err)
  let want = tailLines.slice(-600).map(line => pySlice(line, 0, 20000) + '\n').join('')
  check(out === want, [out.length, want.length, out.slice(0, 200)])
  // append: the text of one file goes to the end of another, which is not read; the first is removed
  put('log.jsonl', 'old line\n')
  put('add.tmp', '{"t":"caf\u{e9} \u{2615}"}\n{"t":"b"}\n')
  ;[code, out, err] = run('files.ps1', files, 'append', `${win}/add.tmp`, `${win}/log.jsonl`)
  check(code === 0 && err === '', [code, err])
  check(get('log.jsonl') === 'old line\n{"t":"caf\u{e9} \u{2615}"}\n{"t":"b"}\n' && get('add.tmp') === null)
  put('add.tmp', 'x\n')
  ;[code, out, err] = run('files.ps1', files, 'append', `${win}/add.tmp`, `${win}/new dir/fresh.jsonl`)
  check(code === 0 && get('new dir/fresh.jsonl') === 'x\n', [code, err])
  ;[code, out, err] = run('files.ps1', files, 'append', `${win}/missing.tmp`, `${win}/log.jsonl`)
  check(code === 1 && get('log.jsonl').startsWith('old line'), [code, err])
  ;[code, out, err] = run('files.ps1', files, 'nonsense')
  check(code === 1 && err.includes('unknown operation'), [code, err])
  // removeregular: a regular file goes (a name with brackets and blanks is literal); a path that is not there is exit 3
  // (a missing folder too); a directory is exit 5; a junction (a reparse point, made with New-Item: no admin right
  // needed) is exit 4, and neither the junction nor the folder it leads to is touched.
  put('rr [1] x.json', 'x')
  check(run('files.ps1', files, 'removeregular', `${win}/rr [1] x.json`)[0] === 0 && get('rr [1] x.json') === null)
  check(run('files.ps1', files, 'removeregular', `${win}/rr [1] x.json`)[0] === 3)
  check(run('files.ps1', files, 'removeregular', `${win}/no such dir/x.json`)[0] === 3)
  makedirs(join(work, 'rr-dir'))
  put('rr-dir/inner.txt', 'inner')
  check(run('files.ps1', files, 'removeregular', `${win}/rr-dir`)[0] === 5 && get('rr-dir/inner.txt') === 'inner')
  makedirs(join(work, 'rr-out'))
  put('rr-out/secret.txt', 'outside')
  ;[code, out, err] = run('junction.ps1', JUNCTION_PS1, toWin(join(work, 'rr-junction'), '\\'), toWin(join(work, 'rr-out'), '\\'))
  check(code === 0, [code, err])
  check(run('files.ps1', files, 'removeregular', `${win}/rr-junction`)[0] === 4)
  check(exists(join(work, 'rr-junction')) && get('rr-out/secret.txt') === 'outside')
  console.log('windows-files-selftest: ok')

  // --- NEWER_PS1: the files under a folder written after a time. A junction out of the tree (made with New-Item, no
  // admin right needed) is neither followed nor listed, no .git folder is entered, the newest come first and the
  // count covers what the cap leaves out.
  const newer = constant('NEWER_PS1')
  const T = 1_790_000_000
  const stamp = (name, sec, text = 'x') => {
    fs.mkdirSync(dirname(join(work, name)), { recursive: true })
    put(name, text)
    fs.utimesSync(join(work, name), sec, sec)
  }
  stamp('newer/a.txt', T + 30)
  stamp('newer/sub [1]/b b.txt', T + 20)
  stamp('newer/caf\u{e9}.txt', T + 25)
  stamp('newer/old.txt', T - 100)
  stamp('newer/.git/HEAD', T + 50)
  stamp('outside/secret.txt', T + 40, 'canary-outside')
  ;[code, out, err] = run('junction.ps1', JUNCTION_PS1, toWin(join(work, 'newer', 'j'), '\\'), toWin(join(work, 'outside'), '\\'))
  check(code === 0, [code, err])
  check(exists(join(work, 'newer', 'j', 'secret.txt')), 'the junction does not lead out of the tree')
  const wantNewer = [['a.txt', (T + 30) * 1000], ['caf\u{e9}.txt', (T + 25) * 1000], ['sub [1]/b b.txt', (T + 20) * 1000]]

  const newerLines = text => {
    const lines = text.replaceAll('\r\n', '\n').replace(/\n+$/, '').split('\n')
    const total = lines.pop()
    check(total.startsWith('N\t'), text)
    const found = []
    for (const line of lines) {
      const [sec, path] = [before(line, '\t'), after(line, '\t')]
      const [whole, fraction] = sec.includes('.') ? [before(sec, '.'), after(sec, '.')] : [sec, '']
      found.push([path.replaceAll('\\', '/'), pyInt(whole) * 1000 + pyInt((fraction + '000').slice(0, 3))])
    }
    return [found, pyInt(total.slice(2))]
  }

  ;[code, out, err] = run('newer.ps1', newer, `${win}/newer`, String(T), '200')
  check(code === 0 && err === '', [code, err])
  let [found, total] = newerLines(out)
  const root = toWin(join(work, 'newer')).replace(/\/+$/, '')
  check(isDeepStrictEqual(found.map(([p, ms]) => [pySlice(p, cpLen(root) + 1), ms]), wantNewer) && total === 3, [found, total])
  check(!out.includes('outside') && !out.includes('secret'), out)
  ;[code, out, err] = run('newer.ps1', newer, `${win}/newer`, String(T), '1')
  ;[found, total] = newerLines(out)
  check(code === 0 && found.length === 1 && found[0][0].endsWith('/a.txt') && total === 3, [code, out, err])
  ;[code, out, err] = run('newer.ps1', newer, `${win}/no such folder`, String(T), '200')
  check(code === 3 && out === '', [code, out, err])
  console.log('windows-newer-selftest: ok (NEWER_PS1: newest first, the cap and the count, no .git, the junction neither followed nor listed)')

  // --- PROBE_PS1, with its process name swapped to powershell.exe: a sleeping powershell.exe of this test's own
  // plays the worker, and fake sessions files under the scratch directory play the engine's. This verifies the
  // script's own arithmetic and output only, never a real claude.exe or a real sessions file.
  let probe = constant('PROBE_PS1')
  check(count(probe, "$name = 'claude.exe'") === 1)
  probe = probe.replaceAll("$name = 'claude.exe'", "$name = 'powershell.exe'")
  const TO_MS = '[long][Math]::Floor(($t.ToUniversalTime() - (New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc))).TotalMilliseconds)'

  const ps = command => {
    const r = runText([PS, '-NoProfile', '-NonInteractive', '-Command', command], { timeout: 60, cwd: work })
    check(r.returncode === 0, r.stderr)
    return r.stdout.trim()
  }

  const sleeper = seconds => {
    const marker = join(work, `pid-${seconds}.txt`)
    const proc = startProc([PS, '-NoProfile', '-NonInteractive', '-Command', `$PID | Set-Content -Encoding ascii '${toWin(marker)}'; Start-Sleep ${seconds}`], work)
    for (let i = 0; i < 300; i++) {
      if (exists(marker) && readFile(marker).trim()) return [proc, pyInt(readFile(marker).trim())]
      sleepMs(100)
    }
    throw new Error('the sleeper did not start')
  }

  const [live, pid] = sleeper(120)
  const [gone, gonePid] = sleeper(0)
  await gone.wait(60)
  try {
    const created = pyInt(ps(`$t = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate; ${TO_MS}`))
    const [sid, sid2] = ['11111111-2222-4333-8444-555555555555', '99999999-2222-4333-8444-555555555555']

    const sessionDir = (name, fields) => {
      const cfg = join(work, name)
      fs.mkdirSync(join(cfg, 'sessions'), { recursive: true })
      fs.writeFileSync(join(cfg, 'sessions', `${pid}.json`), pyJson(fields), 'utf8')
      return toWin(cfg)
    }

    const good = sessionDir('cfg good', { pid, sessionId: sid, cwd: 'C:\\fake\\cwd', startedAt: created + 1500 })
    makedirs(join(work, 'cfg good', 'projects', 'C--fake-cwd'))
    const transcript = join(work, 'cfg good', 'projects', 'C--fake-cwd', `${sid}.jsonl`)
    fs.writeFileSync(transcript, '{}\n')
    fs.utimesSync(transcript, 1_700_000_000, 1_700_000_000)
    makedirs(join(work, 'cfg good', 'projects', 'other'))
    const older = join(work, 'cfg good', 'projects', 'other', `${sid}.jsonl`)
    fs.writeFileSync(older, '{}\n')
    fs.utimesSync(older, 1_600_000_000, 1_600_000_000)
    const stale = sessionDir('cfg stale', { pid, sessionId: sid2, cwd: 'C:\\old', startedAt: created - 3_600_000 })
    const late = sessionDir('cfg late', { pid, sessionId: sid2, cwd: 'C:\\late', startedAt: created + 600_001 })
    const other = sessionDir('cfg other pid', { pid: pid + 1, sessionId: sid2, cwd: 'C:\\x', startedAt: created + 10 })
    const empty = toWin(join(work, 'cfg empty'))

    const lines = (...args) => {
      const [c, o, e] = run('probe.ps1', probe, ...args)
      check(c === 0 && e === '', [c, e])
      check(!o.includes('\r'))
      return pySplitlines(o).map(line => line.split('\t'))
    }

    const started = Date.now() / 1000
    let got = lines(`pid:${pid}|${good}`, `t:${sid}|${good}`, `c:${stale}`, `pid:${gonePid}|${good}`)
    const took = Date.now() / 1000 - started
    const mine = got.filter(cols => cols[0] === 'P' && cols[1] === String(pid))
    check(mine.length === 1 && mine[0][2] === 'claude' && mine[0][4] === 'C:\\fake\\cwd' && mine[0][5] === good, mine)
    check(pyInt(mine[0][3]) >= 0 && mine[0][6].includes('Start-Sleep 120'), mine)
    check(isDeepStrictEqual(got.filter(cols => cols[0] === 'A'), [['A', String(pid), 'powershell', String(created), String(created), sid]]), got)
    check(isDeepStrictEqual(got.filter(cols => cols[0] === 'T'), [['T', sid, '1700000000']]), got)
    // a sessions file from before the process (a reused pid), one written too long after it, one naming another
    // pid, and none at all: the start columns differ or the file's is empty, so the pid is not alive
    for (const [cfg, wantStart] of [[stale, String(created - 3_600_000)], [late, String(created + 600_001)], [other, String(created + 10)], [empty, '']]) {
      got = lines(`pid:${pid}|${cfg}`, `c:${cfg}`)
      check(isDeepStrictEqual(got.filter(cols => cols[0] === 'A'), [['A', String(pid), 'powershell', String(created), wantStart, [stale, late, other].includes(cfg) ? sid2 : '']]), [cfg, got])
      check(isDeepStrictEqual(got.filter(cols => cols[0] === 'P' && cols[1] === String(pid)).map(cols => cols.slice(4, 6)), [['', '']]), [cfg, got])
    }
    // an empty registry: P lines only; a config dir of '~' is never searched
    check(lines('pid:1|~', 't:x|~').filter(cols => cols[1] !== '1').every(cols => cols[0] === 'P'))
    console.log(`windows-probe-selftest: ok (verifies our arithmetic only; one probe took ${took.toFixed(2)} s)`)
  } finally {
    runBytes([PS, '-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -ErrorAction SilentlyContinue`], { timeout: 60, cwd: work })
    await live.wait(60)
  }

  // --- the launch line in Git Bash, the Bash tool's shell on Windows, with claude() a node.exe that echoes what it
  // gets: no claude starts. The line has the shape buildLaunchArgv returns (pinned by its golden tests); this checks
  // what Git Bash makes of it: cd into a path with a blank and a quote, CLAUDE_CONFIG_DIR as written, the -n name and
  // the --settings JSON reaching the program as single arguments with their double quotes, $(cat) of the
  // prompt, the redirections, and which prompts MSYS rewrites (MSYS_PROMPTS in tests/fixtures.ts).
  const where = exe => runText([PS, '-NoProfile', '-NonInteractive', '-Command', `(Get-Command ${exe} -ErrorAction SilentlyContinue).Source`], { timeout: 60, cwd: work }).stdout.trim()

  const git = where('git.exe')
  const bash = git.toLowerCase().endsWith('\\cmd\\git.exe') ? toWsl(rsplitFirst(git, '\\cmd\\') + '\\bin\\bash.exe') : ''
  if (!bash || !exists(bash) || !where('node.exe')) {
    console.log('windows-launch-selftest: skipped (no Git Bash or no node.exe)')
  } else {
    const fx = readFile(join(HERE, 'fixtures.ts'))
    const block = before(after(fx, '// MSYS_PROMPTS:BEGIN'), '// MSYS_PROMPTS:END')
    const prompts = JSON.parse(after(block, ' = '))
    const shq = v => "'" + v.replaceAll("'", "'\\''") + "'"
    // The session name and the settings JSON buildLaunchArgv adds (WORKER_SETTINGS in hooks/core.ts).
    const settings = before(after(SRC, "export const WORKER_SETTINGS = '"), "'")
    const name = 'w-selftest-261010120000'
    const [proj, cfg, runs] = ["proj o'k", 'cfg dir', 'runs dir'].map(one => join(work, one))
    for (const d of [proj, cfg, runs]) makedirs(d)
    const echo =
      "claude() { node.exe -e 'process.stdout.write(JSON.stringify({argv: process.argv.slice(1), " +
      "cfg: process.env.CLAUDE_CONFIG_DIR, effort: process.env.CLAUDE_CODE_EFFORT_LEVEL, cwd: process.cwd()}))' -- \"$@\"; }\n"
    prompts.forEach((one, n) => {
      const [prompt, result, errFile] = [join(work, `prompt ${n}.md`), join(runs, `${n}.json`), join(runs, `${n}.err`)]
      fs.writeFileSync(prompt, one.text + '\n', 'utf8')
      const line =
        `cd ${shq(toWin(proj))} && CLAUDE_CONFIG_DIR=${shq(toWin(cfg))} CLAUDE_CODE_EFFORT_LEVEL=${shq('high')} ` +
        `claude -p --model ${shq('opus')} -n ${shq(name)} --settings ${shq(settings)} --dangerously-skip-permissions --output-format json ` +
        `-- "$(cat ${shq(toWin(prompt))})" > ${shq(toWin(result))} 2> ${shq(toWin(errFile))}`
      const script = join(work, `launch ${n}.sh`)
      fs.writeFileSync(script, echo + line + '\n', 'utf8')
      const r = runBytes([bash, toWin(script)], { timeout: 60, cwd: work })
      check(r.returncode === 0 && r.stderr.length === 0 && readFile(errFile) === '', [one, r.returncode, r.stderr.toString()])
      const got = JSON.parse(utf8.decode(fs.readFileSync(result)))
      check(isDeepStrictEqual(got.argv.slice(0, 11), ['-p', '--model', 'opus', '-n', name, '--settings', settings, '--dangerously-skip-permissions', '--output-format', 'json', '--']), got)
      check(got.cfg === toWin(cfg) && got.effort === 'high' && got.cwd === toWin(proj, '\\'), got)
      check((got.argv[11] !== one.text) === one.rewritten, [one, got.argv[11]])
    })
    console.log(`windows-launch-selftest: ok (${prompts.length} prompts through Git Bash)`)
  }

  // --- the PowerShell launch route (the launchRoute option at powershell): the command rendered by the real
  // powershellLaunchCommand of hooks/host-powershell.ts (the node running this test loads the TypeScript itself), then
  // run as a script by Windows PowerShell 5.1 and by PowerShell 7, as the engine's PowerShell tool would run it.
  // node.exe with a stub script stands in for claude.exe: the test swaps `Get-Command claude.exe` for `Get-Command
  // node.exe` and puts the stub's path first in the argument string, and checks no claude.exe is left in the text before
  // anything runs. The stub prints its argv, working directory, the two variables and its pid as JSON on stdout (with
  // the prompt it read, so the result file holds non-ASCII text), copies its stdin byte for byte to a file, writes a
  // line to stderr and exits with the code it is given. The only process cmdlets are the command's own Start-Process and
  // Get-Command.
  const linuxNode = process.execPath
  const shells = [['Windows PowerShell 5.1', PS]]
  const pwsh = which('pwsh.exe')
  if (pwsh) shells.push(['PowerShell 7', pwsh])
  const nodeExeWin = where('node.exe')
  if (!linuxNode || !nodeExeWin) {
    console.log('windows-powershell-launch-selftest: skipped (no node on Linux to render the command, or no node.exe on Windows)')
  } else {
    const hooks = join(HERE, '..', 'hooks')
    // Relative imports without an extension (./core) resolve to the .ts file beside them, as the engine resolves them.
    const resolveHook =
      "data:text/javascript,import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){try{return n(s,c)}" +
      "catch(e){if(/^\\.\\.?\\//.test(s))return n(s+'.ts',c);throw e}}})"
    const renderJs =
      "import{readFileSync}from'node:fs';" +
      `const m=await import(${JSON.stringify(pathToFileURL(resolve(hooks, 'host-powershell.ts')).href)});` +
      "const cases=JSON.parse(readFileSync(0,'utf8'));" +
      'process.stdout.write(JSON.stringify(cases.map(c=>({command:m.powershellLaunchCommand(c.args,c.target,c.result,c.err),' +
      'argv:m.powershellLaunchArgs(c.args,c.target),pidFile:m.launchPidFile(c.result),refusal:m.powershellLaunchRefusal(c.args,c.runsDir)??null}))))'

    const render = cases => {
      const r = runBytes([linuxNode, '--no-warnings', '--experimental-strip-types', '--import', resolveHook, '--input-type=module', '-e', renderJs], {
        input: Buffer.from(pyJson(cases), 'utf8'),
        timeout: 120,
      })
      check(r.returncode === 0, utf8Lenient.decode(r.stderr).slice(0, 2000))
      return JSON.parse(utf8.decode(r.stdout))
    }

    const stubDir = join(work, 'stub')
    makedirs(stubDir)
    const stub = join(stubDir, 'claude-stub.js')
    fs.writeFileSync(
      stub,
      "const fs = require('fs')\n" +
        'const input = fs.readFileSync(0)\n' +
        'fs.writeFileSync(process.env.SC_STUB_STDIN_COPY, input)\n' +
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), cfg: process.env.CLAUDE_CONFIG_DIR ?? null,\n' +
        "  effort: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null, pid: process.pid, prompt: input.toString('utf8') }))\n" +
        // The stub writes the escape itself: caf, a backslash, u00e9.
        "process.stderr.write('stub stderr caf\\" + "u00e9\\n')\n" +
        'process.exitCode = Number(process.env.SC_STUB_EXIT)\n',
      'utf8',
    )
    let stubArg = toWin(stub)
    if (stubArg.includes(' ') || stubArg.includes('"')) stubArg = '"' + stubArg + '"'
    const sid = 'bbbbbbbb-2222-4222-8222-222222222222'
    const promptText =
      'Goal: check the "launch" route\'s quoting\r\nline two: caf\u{e9} \u{2615} \u{65e5}\u{672c} \u{1F600}\n' +
      '$env:PATH `backtick` %PATH% & | < > ^ ; \' "" \\" \\\\\nlast line without newline \u{2019} end'
    // (label, launch dir, prompt file, runs dir, config dir picked (null: inherited), resume sid, exit code)
    const layouts = [
      ['fresh, config inherited, blanks and a quote', "proj o'k dir", 'prompt one.md', "runs o'k", null, null, 0],
      ['picked config dir; brackets, a backtick and non-ASCII in the launch dir', 'proj [1] Jos`\u{e9}', 'prompt \u{e9} \u{2019}.md', 'runs \u{e8} dir', 'cfg \u{e9} dir', null, 3],
      ['a resume under a picked config dir', 'proj resume', 'p.md', 'runs-r', 'cfg-r', sid, 1],
    ]
    const cases = []
    const prepared = []
    layouts.forEach(([label, d, p, r, cfg, resume, exitCode], n) => {
      const baseDir = join(work, `ps${n}`)
      const [proj, runsDir] = [join(baseDir, d), join(baseDir, r)]
      makedirs(proj)
      makedirs(runsDir)
      const promptPath = join(baseDir, p)
      fs.writeFileSync(promptPath, Buffer.from(promptText, 'utf8'))
      const cfgWin = cfg ? toWin(join(baseDir, cfg)) : 'C:/inherited/never/written'
      const name = `w-selftest-${n}-261010120000`
      const result = toWin(join(runsDir, `20261010120000-ps-${n}.json`))
      const errFile = toWin(join(runsDir, `20261010120000-ps-${n}.err`))
      const target = { configDir: cfgWin, name, ...(cfg === null ? { isConfigInherited: true } : {}), ...(resume ? { resumeSid: resume } : {}) }
      cases.push({ args: { dir: toWin(proj), prompt_file: toWin(promptPath), model: 'opus', effort: 'high', title: 'ps' }, target, result, err: errFile, runsDir: toWin(runsDir) })
      prepared.push([label, proj, promptPath, runsDir, cfg ? cfgWin : null, exitCode, baseDir])
    })
    // Why a prompt file (or a run file) with brackets is refused on this route: rendered as it would be, it fails at
    // Start-Process under both versions before anything starts; the real refusal names it.
    const wildDir = join(work, 'ps-wild', 'p [x]')
    makedirs(wildDir)
    fs.writeFileSync(join(wildDir, 'prompt.md'), 'x\n', 'utf8')
    const wildRuns = join(work, 'ps-wild', 'runs')
    makedirs(wildRuns)
    cases.push({
      args: { dir: toWin(join(work, 'ps-wild')), prompt_file: toWin(join(wildDir, 'prompt.md')), model: 'opus', effort: 'high', title: 'ps' },
      target: { configDir: 'C:/x', isConfigInherited: true, name: 'w-wild-1' },
      result: toWin(join(wildRuns, 'w.json')),
      err: toWin(join(wildRuns, 'w.err')),
      runsDir: toWin(wildRuns),
    })
    const rendered = render(cases)
    check(isDeepStrictEqual(rendered.map(one => one.refusal === null), [true, true, true, false]), rendered.map(one => one.refusal))
    const wild = rendered.pop()
    cases.pop()
    const settings = before(after(SRC, "export const WORKER_SETTINGS = '"), "'")
    const linesOut = []
    const nodeDir = rsplitFirst(nodeExeWin, '\\')
    for (const [shellName, shell] of shells) {
      for (const [n, [label, proj, , , cfgWin, exitCode, baseDir]] of prepared.entries()) {
        const one = rendered[n]
        const command = one.command
        check(count(command, 'Get-Command claude.exe ') === 1 && count(command, "-ArgumentList '-p --model ") === 1, command)
        check([...command].every(ch => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e) || ch === '\n'), 'the command is not printable ASCII')
        const wantArgv = ['-p', '--model', 'opus', ...(n === 2 ? ['--resume', sid] : []), '-n', `w-selftest-${n}-261010120000`, '--settings', settings,
          '--dangerously-skip-permissions', '--output-format', 'json']
        check(isDeepStrictEqual(one.argv, wantArgv), one.argv)
        const runCmd = command.replaceAll('Get-Command claude.exe ', 'Get-Command node.exe ').replaceAll("-ArgumentList '-p --model ", `-ArgumentList '${stubArg} -p --model `)
        check(!runCmd.includes('claude.exe'))
        const copy = join(baseDir, `stdin-copy-${linesOut.length}.bin`)
        for (const leftover of [cases[n].result, cases[n].err, one.pidFile]) if (exists(toWsl(leftover))) fs.rmSync(toWsl(leftover))
        // The tool's own process: node.exe found on its PATH, a parent CLAUDE_CONFIG_DIR that an inherited launch keeps
        // and a picked one replaces, the stub's knobs. Then the rendered command, unchanged but for the stand-in.
        const preamble = [
          `$env:Path = '${nodeDir};' + $env:Path`,
          "$env:CLAUDE_CONFIG_DIR = 'C:/parent/config'",
          'Remove-Item Env:CLAUDE_CODE_EFFORT_LEVEL -ErrorAction SilentlyContinue',
          `$env:SC_STUB_STDIN_COPY = '${toWin(copy)}'`,
          `$env:SC_STUB_EXIT = '${exitCode}'`,
        ].join('\n')
        const script = join(baseDir, `launch-${linesOut.length}.ps1`)
        writeAscii(script, preamble + '\n' + runCmd + '\n')
        const r = runBytes([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', toWin(script)], { timeout: 120, cwd: work })
        const stderr = utf8Lenient.decode(r.stderr)
        check(r.returncode === exitCode, [shellName, label, r.returncode, stderr.slice(0, 1500), r.stdout.toString().slice(0, 500)])
        const raw = fs.readFileSync(toWsl(cases[n].result))
        check(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), 'the result file has a BOM')
        const got = JSON.parse(utf8.decode(raw))
        check(isDeepStrictEqual(got.argv, wantArgv), [shellName, label, got.argv])
        check(fs.readFileSync(copy).equals(Buffer.from(promptText, 'utf8')), 'stdin changed on the way')
        check(got.prompt === promptText)
        check(got.cwd.toLowerCase() === toWin(proj, '\\').toLowerCase(), [got.cwd, proj])
        check(got.effort === 'high', got)
        check(got.cfg === (cfgWin ? cfgWin : 'C:/parent/config'), [label, got.cfg])
        const pidText = fs.readFileSync(toWsl(one.pidFile))
        check(!/[^\x00-\x7f]/.test(pidText.toString('latin1')) && pidText.toString('latin1').trim() === String(got.pid), [pidText.toString('latin1'), got.pid])
        check(fs.readFileSync(toWsl(cases[n].err)).equals(Buffer.from('stub stderr caf\u{e9}\n', 'utf8')))
        linesOut.push(`  ${shellName}: ${label}: exit ${r.returncode} = ${exitCode}; argv ${got.argv.length} intact (name and settings JSON single); ` +
          `stdin ${Buffer.byteLength(promptText, 'utf8')} bytes intact; result UTF-8, no BOM; pid file ${got.pid} = child pid; ` +
          `cwd ok; CLAUDE_CONFIG_DIR ${cfgWin ? 'set to the picked dir' : 'inherited from the parent'}`)
      }
    }
    for (const [shellName, shell] of shells) {
      const runCmd = wild.command.replaceAll('Get-Command claude.exe ', 'Get-Command node.exe ').replaceAll("-ArgumentList '-p --model ", `-ArgumentList '${stubArg} -p --model `)
      check(!runCmd.includes('claude.exe'))
      const script = join(work, 'ps-wild', `wild-${linesOut.length}.ps1`)
      writeAscii(script, `$env:Path = '${nodeDir};' + $env:Path\n` + runCmd + '\n')
      const r = runBytes([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', toWin(script)], { timeout: 120, cwd: work })
      const stderr = utf8Lenient.decode(r.stderr)
      check(r.returncode === 1 && stderr.includes('Start-Process') && !exists(join(wildRuns, 'w.json')), [shellName, r.returncode, stderr.slice(0, 600)])
      linesOut.push(`  ${shellName}: a prompt file under "p [x]": Start-Process fails (exit 1, nothing started), as powershellLaunchRefusal says`)
    }
    console.log(`windows-powershell-launch-selftest: ok (${linesOut.length} runs under ${shells.map(([name]) => name).join(', ')})`)
    console.log(linesOut.join('\n'))
    if (!pwsh) console.log('windows-powershell-launch-selftest: PowerShell 7 skipped (no pwsh.exe)')
  }

  // --- the Node helper's file operations with the Windows node.exe, from a copy of mod/helper in the scratch
  // directory (a script on the WSL file system would be read over \\wsl$). No claude starts; no PowerShell script
  // of this test calls a process API.
  let nodeWin = process.env.SC_WIN_NODE || (IS_WINDOWS ? process.execPath : 'C:\\Program Files\\nodejs\\node.exe')
  let node = toWsl(nodeWin)
  if (!exists(node)) {
    console.log(`windows-helper-selftest: skipped (no ${nodeWin})`)
  } else {
    const helperDir = join(work, 'helper')
    makedirs(helperDir)
    for (const name of fs.readdirSync(join(HERE, '..', 'helper'))) if (name.endsWith('.mjs')) fs.copyFileSync(join(HERE, '..', 'helper', name), join(helperDir, name))
    const host = `${win}/helper/host.mjs`

    const helper = (op, request) => {
      const started = performance.now()
      const r = runBytes([node, host, op], { input: Buffer.from(pyJson(request), 'utf8'), timeout: 120, cwd: work })
      const took = performance.now() - started
      check(r.stderr.length === 0, [op, r.stderr.toString().slice(0, 500)])
      const answer = JSON.parse(utf8.decode(r.stdout))
      check(r.returncode === (answer.ok === true ? 0 : 1), [op, r.returncode, answer])
      return [answer, took]
    }

    const version = runText([node, '--version'], { timeout: 60, cwd: work }).stdout.trim()
    const w = name => `${win}/${name}`
    // rename over an existing file: replaced in one step, the temp file gone
    put('reg.json', 'old')
    put('reg.json.tmp.1', 'new \u{e9}')
    let [answer] = helper('renameOver', { from: w('reg.json.tmp.1'), to: w('reg.json') })
    check(pyEqual(answer, { ok: true }) && get('reg.json') === 'new \u{e9}' && get('reg.json.tmp.1') === null, answer)
    // ... while another process holds the target open without delete sharing (a reader): the helper tries again
    // until the holder lets go (here after 0.6 s; it gives up after 1 s)
    put('held.json', 'old')
    put('held.json.tmp', 'new')
    const holder = startProc([PS, '-NoProfile', '-NonInteractive', '-Command',
      `$f = [System.IO.File]::Open('${toWin(join(work, 'held.json'), '\\')}', 'Open', 'Read', 'Read'); ` +
      `'held' | Set-Content -Encoding ascii '${toWin(join(work, 'held.flag'), '\\')}'; Start-Sleep -Milliseconds 600; $f.Close()`], work)
    for (let i = 0; i < 300; i++) {
      if (get('held.flag')) break
      sleepMs(50)
    }
    check(get('held.flag'), 'the holder did not open the file')
    let heldMs
    ;[answer, heldMs] = helper('renameOver', { from: w('held.json.tmp'), to: w('held.json') })
    await holder.wait(60)
    check(pyEqual(answer, { ok: true }) && get('held.json') === 'new', answer)
    // writeAtomic: a new file and its directory, a replaced one, a changed one left alone, no temp file left
    check(pyEqual(helper('writeAtomic', { path: w('deep dir/reg [1].json'), text: '[]\n' })[0], { ok: true, written: true }))
    check(pyEqual(helper('writeAtomic', { path: w('deep dir/reg [1].json'), text: '[1]\n', expected: '[]\n' })[0], { ok: true, written: true }))
    check(pyEqual(helper('writeAtomic', { path: w('deep dir/reg [1].json'), text: '[2]\n', expected: '[]\n' })[0], { ok: true, written: false }))
    check(get('deep dir/reg [1].json') === '[1]\n' && isDeepStrictEqual(fs.readdirSync(join(work, 'deep dir')), ['reg [1].json']))
    // append: to the end, never read; a new directory made; remove: a file goes, a missing one is no failure
    put('log.jsonl', 'old line\n')
    check(helper('append', { path: w('log.jsonl'), text: '{"t":"caf\u{e9} \u{2615}"}\n{"t":"b"}\n' })[0].ok === true)
    check(get('log.jsonl') === 'old line\n{"t":"caf\u{e9} \u{2615}"}\n{"t":"b"}\n')
    check(helper('append', { path: w('node dir/fresh.jsonl'), text: 'x\n' })[0].ok === true && get('node dir/fresh.jsonl') === 'x\n')
    check(pyEqual(helper('removeFile', { path: w('log.jsonl') })[0], { ok: true, removed: true }) && get('log.jsonl') === null)
    check(pyEqual(helper('removeFile', { path: w('log.jsonl') })[0], { ok: true, removed: false }))
    // regularOnly: a regular file goes, a directory is NOT_FILE and a junction IS_LINK (nothing touched), a missing path is no failure
    put('ro.json', 'x')
    check(pyEqual(helper('removeFile', { path: w('ro.json'), regularOnly: true })[0], { ok: true, removed: true }) && get('ro.json') === null)
    check(pyEqual(helper('removeFile', { path: w('ro.json'), regularOnly: true })[0], { ok: true, removed: false }))
    check(pyEqual(helper('removeFile', { path: w('rr-dir'), regularOnly: true })[0], { ok: false, code: 'NOT_FILE' }) && get('rr-dir/inner.txt') === 'inner')
    check(pyEqual(helper('removeFile', { path: w('rr-junction'), regularOnly: true })[0], { ok: false, code: 'IS_LINK' }))
    check(exists(join(work, 'rr-junction')) && get('rr-out/secret.txt') === 'outside')
    // a failure is a fixed code, with no path or message
    ;[answer] = helper('tail', { path: w('missing.jsonl'), lines: 600, width: 20000 })
    check(pyEqual(answer, { ok: false, code: 'NOT_FOUND' }), answer)
    // tail of a 3 MB UTF-8 file with CRLF line ends and non-ASCII text (4000 rows): the last 600 lines, each cut to 20000
    // UTF-16 units (tailLines of hooks/core.ts; the \r stays, as in tailLines and tail | cut)
    const utf16Cut = (line, width) => {
      const cut = line.slice(0, width)
      // Python decodes the cut UTF-16 bytes strictly: half of a surrogate pair at the end is an error there.
      const last = cut.charCodeAt(cut.length - 1)
      if (line.length > width && last >= 0xd800 && last <= 0xdbff) throw new Error('the cut splits a surrogate pair')
      return cut
    }
    const rows = []
    for (let i = 0; i < 4000; i++) {
      if (i % 211 === 0) rows.push(pyJson({ i, big: 'caf\u{e9} '.repeat(4000) + '\u{fc}'.repeat(30) }, { ensureAscii: false }))
      else if (i % 3 === 0) rows.push(pyJson({ i, t: 'r\u{e9}sum\u{e9} \u{2615} \u{65e5}\u{672c}\u{8a9e} \u{1F600} '.repeat(i % 40) }, { ensureAscii: false }))
      else rows.push(pyJson({ i, t: 'x'.repeat(i % 1500) }))
    }
    const text = rows.map(row => row + '\r\n').join('')
    fs.writeFileSync(join(work, 'big.jsonl'), text, 'utf8')
    const size = fs.statSync(join(work, 'big.jsonl')).size
    check(size >= 3_000_000, size)
    const bigLines = text.split('\n')
    if (bigLines[bigLines.length - 1] === '') bigLines.pop()
    want = bigLines.slice(-600).map(line => utf16Cut(line, 20000) + '\n').join('')
    let tailMs
    ;[answer, tailMs] = helper('tail', { path: w('big.jsonl'), lines: 600, width: 20000 })
    check(answer.ok === true && answer.dropped === 0, Object.fromEntries(Object.entries(answer).filter(([k]) => k !== 'text')))
    check(answer.text === want, [answer.text?.length, want.length])
    // the file script's tail of the same file: Get-Content drops the \r, otherwise the same lines
    ;[code, out, err] = run('files.ps1', files, 'tail', w('big.jsonl'), '600', '20000')
    check(code === 0 && out === want.replaceAll('\r\n', '\n'), [code, err.slice(0, 200)])
    // filesNewerThan: the same files as NEWER_PS1 over the same tree, the junction out of it neither followed nor
    // listed, paths in the stored C:/... form, mtimes in ms; a missing folder is a fixed code
    let newerMs
    ;[answer, newerMs] = helper('filesNewerThan', { dir: w('newer'), since: T, max: 200 })
    check(answer.ok === true && answer.total === 3, answer)
    check(isDeepStrictEqual(answer.files.map(one => [pySlice(one.path, cpLen(w('newer')) + 1), one.mtimeMs]), wantNewer), answer)
    check(!pyJson(answer).includes('outside'), answer)
    ;[answer] = helper('filesNewerThan', { dir: w('newer'), since: T, max: 1 })
    check(answer.total === 3 && answer.files.length === 1, answer)
    ;[answer] = helper('filesNewerThan', { dir: w('no such folder'), since: T, max: 1 })
    check(pyEqual(answer, { ok: false, code: 'NOT_FOUND' }), answer)
    // hashTree (the drift band): two copies of a mod folder that differ in one file; the SHA-256 of each file as
    // Node computes it over the same bytes with each CRLF folded to LF (line ends do not count; a file with a NUL
    // byte keeps its bytes; non-ASCII kept); a junction in hooks out of the folder (made
    // with New-Item, no admin right) neither followed nor hashed; .claude-plugin/types, tests and a nested folder
    // never; paths relative with / on Windows too; a missing root and a bad request are fixed codes.
    const modFiles = {
      'hooks/register.tsx': 'export const register = 1\r\n// caf\u{e9} \u{2615}\r\n',
      'hooks/core.ts': 'export const core = 1\n',
      'helper/host.mjs': '// helper\n',
      'types/index.d.ts': 'export type X = 1\n',
      '.claude-plugin/plugin.json': '{"name":"x"}\n',
      '.claude-plugin/types/claude-code.d.ts': '// generated\n',
      'tests/core.test.ts': '// test\n',
      'hooks/deeper/inner.ts': '// nested\n',
    }
    const putDeep = (name, content) => {
      fs.mkdirSync(dirname(join(work, name)), { recursive: true })
      put(name, content)
    }
    for (const modRoot of ['hmod-a', 'hmod-b']) for (const [rel, content] of Object.entries(modFiles)) putDeep(`${modRoot}/${rel}`, content)
    putDeep('hmod-b/hooks/core.ts', 'export const core = 2\n')
    putDeep('hmod-out/secret.ts', 'outside')
    ;[code, out, err] = run('junction.ps1', JUNCTION_PS1, toWin(join(work, 'hmod-a', 'hooks', 'out'), '\\'), toWin(join(work, 'hmod-out'), '\\'))
    check(code === 0 && exists(join(work, 'hmod-a', 'hooks', 'out', 'secret.ts')), [code, err.slice(0, 200)])
    const spec = { dirs: ['hooks', 'helper', 'types'], files: ['.claude-plugin/plugin.json'] }
    let hashMs
    ;[answer, hashMs] = helper('batch', { ops: ['hmod-a', 'hmod-b'].map(modRoot => ({ op: 'hashTree', root: w(modRoot), ...spec })) })
    check(answer.ok === true && answer.results.length === 2, answer)
    const wantPaths = ['.claude-plugin/plugin.json', 'helper/host.mjs', 'hooks/core.ts', 'hooks/register.tsx', 'types/index.d.ts']
    const trees = answer.results.map(result => new Map(result.files.map(one => [one.path, one.sha256])))
    for (const [tree, modRoot] of [[trees[0], 'hmod-a'], [trees[1], 'hmod-b']]) {
      check(isDeepStrictEqual([...tree.keys()], wantPaths), [...tree])
      for (const rel of wantPaths) {
        const raw = fs.readFileSync(join(work, modRoot, ...rel.split('/')))
        check(tree.get(rel) === sha256(raw.includes(0) ? raw : crlfToLf(raw)), [modRoot, rel])
      }
    }
    // The CRLF file hashes as its LF copy would.
    check(trees[0].get('hooks/register.tsx') === sha256(Buffer.from(modFiles['hooks/register.tsx'].replaceAll('\r\n', '\n'), 'utf8')))
    check(isDeepStrictEqual(wantPaths.filter(rel => trees[0].get(rel) !== trees[1].get(rel)), ['hooks/core.ts']))
    const dumped = pyJson(answer)
    check(!dumped.includes(sha256(Buffer.from('outside'))) && !dumped.includes(work) && !dumped.includes(JSON.stringify(work).slice(1, -1)), answer)
    check(pyEqual(helper('hashTree', { root: w('no such mod'), ...spec })[0], { ok: false, code: 'NOT_FOUND' }))
    for (const bad of [{ root: w('hmod-a'), dirs: ['..\\x'], files: [] }, { root: w('hmod-a'), dirs: ['C:/x'], files: [] }, { root: w('hmod-a'), dirs: ['\\x'], files: [] }]) {
      check(pyEqual(helper('hashTree', bad)[0], { ok: false, code: 'BAD_REQUEST' }), bad)
    }
    check(get('hmod-out/secret.ts') === 'outside')
    // a batch of 20 file operations in one process, in order; timed against 20 helper runs and 20 file-script runs
    const batchOps = n => {
      const ops = []
      for (let k = 0; k < 5; k++) {
        ops.push({ op: 'writeAtomic', path: w(`b${n}/reg.json`), text: `[${k}]\n` },
          { op: 'append', path: w(`b${n}/log.jsonl`), text: `{"k":${k}}\n` },
          { op: 'tail', path: w(`b${n}/log.jsonl`), lines: 2, width: 100 },
          { op: 'rotate', path: w(`b${n}/log.jsonl`), adding: 1, maxBytes: 1000, moves: [[w(`b${n}/log.jsonl`), w(`b${n}/log.jsonl.1`)]] })
      }
      return ops
    }
    const batchMs = []
    for (let n = 0; n < 5; n++) {
      const [batchAnswer, took] = helper('batch', { ops: batchOps(n) })
      check(batchAnswer.ok === true && batchAnswer.results.length === 20, batchAnswer)
      check(batchAnswer.results[18].text === '{"k":3}\n{"k":4}\n' && get(`b${n}/reg.json`) === '[4]\n', batchAnswer.results[18])
      batchMs.push(took)
    }
    const singleMs = []
    for (const step of batchOps(9)) {
      const { op, ...request } = step
      const [stepAnswer, took] = helper(op, request)
      check(stepAnswer.ok === true, stepAnswer)
      singleMs.push(took)
    }
    const psMs = []
    put('ps.log', '')
    for (let k = 0; k < 20; k++) {
      put('ps.add', `{"k":${k}}\n`)
      const started = performance.now()
      ;[code, out, err] = run('files.ps1', files, 'append', w('ps.add'), w('ps.log'))
      psMs.push(performance.now() - started)
      check(code === 0, err)
    }
    // probeUsage on Windows, its process shape only, with no claude: a launcher run by the same node.exe gives the
    // helper a PATH of one scratch folder. There a copy of node.exe named claude.exe stands in for claude: the
    // helper must find it by the PATH without a shell, and node.exe refuses the probe's arguments (bad option, exit
    // 9), which the helper answers as the fixed code FAILED with no text. A folder holding only a claude.cmd (an npm
    // shim) is NO_CLAUDE, since no shell runs it; an empty folder is NO_CLAUDE. The PATH never holds the folder of a
    // real claude.exe, so none can start. The usage text itself is parsed alike on every platform (helper.test.mjs).
    const fakeDir = join(work, 'fake claude')
    const cmdDir = join(work, 'cmd only')
    const emptyDir = join(work, 'no claude')
    for (const one of [fakeDir, cmdDir, emptyDir]) makedirs(one)
    const linked = runText([PS, '-NoProfile', '-NonInteractive', '-Command',
      `Copy-Item -LiteralPath '${nodeWin}' -Destination '${toWin(fakeDir, '\\')}\\claude.exe'`], { timeout: 60, cwd: IS_WINDOWS ? undefined : '/mnt/c' })
    check(linked.returncode === 0 && exists(join(fakeDir, 'claude.exe')), linked.stderr.slice(0, 300))
    fs.writeFileSync(join(cmdDir, 'claude.cmd'), '@echo Current session: 1%% used\r\n')
    fs.writeFileSync(join(work, 'usage-launcher.js'),
      "const { spawnSync } = require('node:child_process')\n" +
      'const [host, dir, request] = process.argv.slice(2)\n' +
      'const env = { ...process.env }\n' +
      "for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]\n" +
      'env.PATH = dir\n' +
      "const ran = spawnSync(process.execPath, [host, 'probeUsage'], { input: request, env, timeout: 60000 })\n" +
      'process.stdout.write(JSON.stringify({ status: ran.status, out: String(ran.stdout), err: String(ran.stderr) }))\n')

    const usageProbe = (pathDir, configDir) => {
      const r = runBytes([node, `${win}/usage-launcher.js`, host, toWin(pathDir, '\\'), pyJson({ configDir })], { timeout: 120, cwd: work })
      check(r.returncode === 0, r.stderr.toString().slice(0, 300))
      const ran = JSON.parse(utf8.decode(r.stdout))
      check(ran.err === '', ran.err.slice(0, 300))
      return [ran.status, JSON.parse(ran.out)]
    }

    const configDir = toWin(join(work, 'licence'))
    for (const [pathDir, wantCode] of [[fakeDir, 'FAILED'], [cmdDir, 'NO_CLAUDE'], [emptyDir, 'NO_CLAUDE']]) {
      const [status, usage] = usageProbe(pathDir, configDir)
      check(status === 1 && pyEqual(usage, { ok: false, code: wantCode }), [pathDir, status, usage])
    }
    const [status, usage] = usageProbe(fakeDir, 'relative\\dir')
    check(status === 1 && pyEqual(usage, { ok: false, code: 'BAD_REQUEST' }), usage)
    console.log('windows-usage-selftest: ok (claude.exe found on the PATH without a shell and answered as a fixed code; a claude.cmd alone and an empty PATH are NO_CLAUDE; no claude started)')

    const ms = value => value.toFixed(0)
    console.log(`windows-helper-selftest: ok (node ${version}; rename over a held file ${ms(heldMs)} ms; tail of ${(size / 1e6).toFixed(1)} MB ${ms(tailMs)} ms; filesNewerThan ${ms(newerMs)} ms; hashTree of two mod folders ${ms(hashMs)} ms; ` +
      `a batch of 20 operations: median ${ms(median(batchMs))} ms per batch (runs ${batchMs.map(ms).join(', ')}); ` +
      `the same 20 as single helper runs ${ms(singleMs.reduce((a, b) => a + b, 0))} ms in all (median ${ms(median(singleMs))} ms each); ` +
      `20 file-script appends ${ms(psMs.reduce((a, b) => a + b, 0))} ms in all (median ${ms(median(psMs))} ms each); ${IS_WINDOWS ? 'timed natively on Windows' : 'timed from WSL through interop'})`)
  }

  // --- the stop of stop_worker on Windows: TREE_PS1 lists a throwaway node.exe tree (a parent that started one
  // child), then taskkill.exe through cmd.exe stops it the way the Windows adapter does: /T, the re-check by TREE_PS1's
  // check, /T /F, the re-check. A second node.exe outside the tree must survive, a start that is not the process's
  // own reads as gone, and the listing names this script's own ancestors. No claude starts.
  nodeWin = process.env.SC_WIN_NODE || (IS_WINDOWS ? process.execPath : 'C:\\Program Files\\nodejs\\node.exe')
  node = toWsl(nodeWin)
  if (!exists(node)) {
    console.log(`windows-stop-selftest: skipped (no ${nodeWin})`)
  } else {
    const treePs1 = constant('TREE_PS1')
    const CMD = which('cmd.exe') ?? (IS_WINDOWS ? `${SYSTEM32}\\cmd.exe` : '/mnt/c/Windows/System32/cmd.exe')
    const marker = join(work, 'stop-pids.txt')
    fs.writeFileSync(join(work, 'stop-parent.js'),
      "const { spawn } = require('child_process');\n" +
      "const fs = require('fs');\n" +
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n" +
      `fs.writeFileSync(${pyJson(toWin(marker))}, process.pid + ' ' + child.pid);\n` +
      'setInterval(() => {}, 1000);\n')
    const byMarker = join(work, 'stop-bystander.txt')
    fs.writeFileSync(join(work, 'stop-bystander.js'), `require('fs').writeFileSync(${pyJson(toWin(byMarker))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`)
    // The pid of a process started from WSL is the WSL side's interop process, never the Windows pid: every Windows
    // pid here is the one the node.exe processes wrote themselves, and taskkill is only ever given those.
    const bystander = startProc([node, `${win}/stop-bystander.js`], work)
    const parent = startProc([node, `${win}/stop-parent.js`], work)
    const mine = new Map()
    try {
      for (let i = 0; i < 300; i++) {
        if (exists(marker) && readFile(marker).split(/\s+/).filter(Boolean).length === 2 && exists(byMarker) && readFile(byMarker).trim()) break
        sleepMs(100)
      }
      const [rootPid, childPid] = readFile(marker).split(/\s+/).filter(Boolean).map(pyInt)
      const byPid = pyInt(readFile(byMarker).trim())

      const created = pid => runText([PS, '-NoProfile', '-NonInteractive', '-Command', `$t = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate; ${TO_MS}`],
        { timeout: 60, cwd: work }).stdout.trim()

      const [rootStart, childStart, byStart] = [created(rootPid), created(childPid), created(byPid)]
      mine.set(rootPid, rootStart).set(childPid, childStart).set(byPid, byStart)
      check([...mine.values()].every(isDigits), [...mine])
      ;[code, out, err] = run('tree.ps1', treePs1, 'list', String(rootPid), rootStart)
      const got = pySplitlines(out).map(line => line.split('\t'))
      check(code === 0 && err === '' && !out.includes('\r'), [code, err])
      check(isDeepStrictEqual(['R', String(rootPid)], got[0].slice(0, 2)) && got[0][3] === rootStart && got[0][5] === 'node.exe', got)
      // The node.exe child, and whatever Windows attached to the tree itself (a conhost.exe for a console process).
      const descendants = got.filter(cols => cols[0] === 'D')
      check(isDeepStrictEqual(descendants.filter(cols => cols[1] === String(childPid)).map(cols => [...cols.slice(0, 4), ...cols.slice(5)]), [['D', String(childPid), String(rootPid), childStart, 'node.exe']]), got)
      check(descendants.every(cols => cols[2] === String(rootPid) && ['node.exe', 'conhost.exe'].includes(cols[5])), got)
      const tree = descendants.map(cols => [pyInt(cols[1]), cols[3]])
      for (const [pid, start] of tree) mine.set(pid, start)
      const ancestors = got.filter(cols => cols[0] === 'G').map(cols => cols[1])
      check(ancestors.length >= 1 && !ancestors.includes(String(rootPid)), got)
      // a start that is not the process's own: the root is not that process (N), and the check says gone
      ;[code, out, err] = run('tree.ps1', treePs1, 'list', String(rootPid), String(pyInt(rootStart) + 1))
      check(code === 0 && isDeepStrictEqual(pySplitlines(out)[0].split('\t').slice(0, 2), ['N', String(rootPid)]) && !pySplitlines(out).some(l => l.startsWith('D')), out)
      ;[code, out, err] = run('tree.ps1', treePs1, 'check', '0', `${rootPid}:${rootStart}`, `${childPid}:${childStart}`, `${rootPid}:${pyInt(rootStart) + 1}`)
      check(code === 0 && isDeepStrictEqual(pySplitlines(out), [`F\t${rootPid}\talive\t`, `F\t${childPid}\talive\t`, `F\t${rootPid}\tgone\t`]), out)
      const steps = []
      let r = runBytes([CMD, '/c', 'taskkill', '/PID', String(rootPid), '/T'], { timeout: 60, cwd: work })
      steps.push(`taskkill /T exit ${r.returncode}`)
      let left = null
      let waited
      for (waited = 0; waited < 4; waited++) {
        ;[code, out, err] = run('tree.ps1', treePs1, 'check', waited ? '1' : '0', `${rootPid}:${rootStart}`, ...tree.map(([pid, start]) => `${pid}:${start}`))
        left = pySplitlines(out).filter(l => l.split('\t')[2] === 'alive').map(l => l.split('\t')[1])
        if (left.length === 0) break
      }
      if (waited === 4) waited = 3
      steps.push(`after ${waited} s: ${left.length} alive`)
      if (left.length > 0) {
        r = runBytes([CMD, '/c', 'taskkill', '/PID', String(rootPid), '/T', '/F'], { timeout: 60, cwd: work })
        steps.push(`taskkill /T /F exit ${r.returncode}`)
        ;[code, out, err] = run('tree.ps1', treePs1, 'check', '1', `${rootPid}:${rootStart}`, ...tree.map(([pid, start]) => `${pid}:${start}`))
        left = pySplitlines(out).filter(l => l.split('\t')[2] === 'alive').map(l => l.split('\t')[1])
      }
      await parent.wait(60)
      check(left.length === 0, [left, steps])
      ;[code, out, err] = run('tree.ps1', treePs1, 'check', '0', `${rootPid}:${rootStart}`, ...tree.map(([pid, start]) => `${pid}:${start}`), `${byPid}:${byStart}`)
      check(isDeepStrictEqual(pySplitlines(out), [`F\t${rootPid}\tgone\t`, ...tree.map(([pid]) => `F\t${pid}\tgone\t`), `F\t${byPid}\talive\t`]), out)
      console.log(`windows-stop-selftest: ok (node.exe tree ${rootPid} with child ${childPid} (${tree.length} descendants: ${descendants.map(cols => cols[5]).join(', ')}): listed by TREE_PS1 with ${ancestors.length} ancestors of its own; ${steps.join('; ')}; the root and every descendant gone by the check; the node.exe ${byPid} outside the tree still runs)`)
    } finally {
      // Only this test's own node.exe processes, by the Windows pid each wrote and only while it still has the start read.
      for (const [pid, start] of mine) {
        const [, checkOut] = run('tree.ps1', treePs1, 'check', '0', `${pid}:${start}`)
        if (checkOut.trim() === `F\t${pid}\talive`) runBytes([CMD, '/c', 'taskkill', '/PID', String(pid), '/T', '/F'], { timeout: 60, cwd: work })
      }
      for (const proc of [parent, bystander]) {
        try {
          await proc.wait(30)
        } catch {
          proc.child.kill()
        }
      }
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
