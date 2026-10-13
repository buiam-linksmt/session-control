// What the end-to-end scripts (mod/tests/e2e-*.mjs) share: the check lines, the scratch directory and its cleanup, the
// headless orchestrator's start and wait, the reading of its transcript, and the process checks. The Node standard
// library only: no sh, grep, tr, sed, jq or cygpath, so a script runs on Windows without Git Bash. The /proc checks are
// Linux-only; elsewhere they print a `skip` line, and no process that is not this run's own throwaway is ever
// signalled. Node 22 or newer. Every script keeps all the mod reads or writes (registry, helper files, runs directory,
// trace) in its scratch directory with an empty licence picker (scratchSettings, or e2e-smoke's own settings), so the
// real ones are never touched and the sessions inherit the default configuration (CLAUDE_CONFIG_DIR, else ~/.claude),
// where their transcripts stay. One line per check; exit 1 on a failure.

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IS_WINDOWS = process.platform === 'win32'
export const HAS_PROC = process.platform === 'linux' && fs.existsSync('/proc/self')
/** The plugin folder (mod/), with its links resolved, as `pwd -P` gives it. */
export const MOD = fs.realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
export const HOME = process.env.HOME || homedir()
/** The configuration the sessions inherit: this process's CLAUDE_CONFIG_DIR, else ~/.claude. */
export const CFG_DEFAULT = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude')

/** One line per check (`ok   `, `FAIL `, `skip `, `info `); `failed` is set by the first FAIL. */
export const kit = {
  failed: false,
  pass: text => out(`ok   ${text}`),
  fail: text => {
    kit.failed = true
    out(`FAIL ${text}`)
  },
  skip: text => out(`skip ${text}`),
  info: text => out(`info ${text}`),
}
function out(line) {
  fs.writeSync(1, line + '\n')
}

/** `command -v name` on a PATH (this process's by default): the file, or undefined. On Windows each PATHEXT ending too. */
export function which(name, path = process.env.PATH ?? '') {
  const endings = IS_WINDOWS && !/\.[^\\/.]+$/.test(name) ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';') : ['']
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ending of endings) {
      const candidate = join(dir, name + ending)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}
/** `[ -x path ]` for a file: a regular file this process may run (on Windows: there). */
export function isExecutable(path) {
  try {
    if (!fs.statSync(path).isFile()) return false
    if (!IS_WINDOWS) fs.accessSync(path, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A path as claude and the mod take it: C:/... on Windows, unchanged elsewhere. */
export const native = path => (IS_WINDOWS ? path.replaceAll('\\', '/') : path)
/**
 * A path as the mod prints one it made itself: on Windows the C:/... form winPath (hooks/core.ts) stores, elsewhere
 * unchanged. A path the mod prints from the registry or a transcript keeps the form it was written in.
 */
export function shown(path) {
  if (!IS_WINDOWS) return path
  const slashed = native(path).replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`)
  const cut = ((/^\/\/[^/]/.test(slashed) ? '/' : '') + slashed.replace(/\/{2,}/g, '/')).replace(/\/+$/, '')
  return /^[A-Z]:$/.test(cut) ? `${cut}/` : cut
}
/** Its /c/... form on Windows (Git Bash's), unchanged elsewhere. */
export const msys = path => native(path).replace(/^([A-Za-z]):\//, '/$1/')

export const sleep = ms => new Promise(done => setTimeout(done, ms))
export const readText = path => fs.readFileSync(path, 'utf8')
/** The text of a file, or '' when it cannot be read. */
export function readOr(path, fallback = '') {
  try {
    return readText(path)
  } catch {
    return fallback
  }
}
/** A file parsed as JSON, or undefined when it is missing or no JSON (jq's silent failure). */
export function readJson(path) {
  try {
    return JSON.parse(readText(path))
  } catch {
    return undefined
  }
}
/** jq -n's layout: two-space indent and a final newline. */
export const writeJson = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
/** printf '%s\n' line... > path */
export const writeLines = (path, ...lines) => fs.writeFileSync(path, lines.map(line => line + '\n').join(''))
/** The lines of a text as grep, head and tail see them (no empty item after the final newline). */
export function linesOf(text) {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
export const firstLine = text => linesOf(text)[0] ?? ''
export const lastLine = text => linesOf(text).at(-1) ?? ''
/** `wc -l`: the number of newlines. */
export const lineCount = text => text.split('\n').length - 1
/** `wc -c` of a file: its size in bytes, 0 when missing. */
export function byteSize(path) {
  try {
    return fs.statSync(path).size
  } catch {
    return 0
  }
}
/** `head -c 300 file...`: with more than one file each part has the ==> name <== header head writes. */
export function headBytes(paths, bytes = 300) {
  return paths
    .map(path => {
      let part
      try {
        part = fs.readFileSync(path).subarray(0, bytes).toString('utf8')
      } catch {
        part = `head: cannot open '${path}' for reading: No such file or directory`
      }
      return paths.length > 1 ? `==> ${path} <==\n${part}` : part
    })
    .join('\n')
}
/** The first match of a regular expression in a text (`grep -o ... | head -n 1`), its group 1 when it has one. */
export function firstMatch(text, regex) {
  const m = regex.exec(text)
  return m === null ? '' : (m[1] ?? m[0])
}
/** `sort | uniq -c | tr -s ' ' | tr '\n' ';'` over a list of names. */
export function countedList(names) {
  const counts = new Map()
  for (const name of [...names].sort()) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, n]) => ` ${n} ${name};`).join('')
}
/** The part before the first '-'. */
export const shortId = id => id.split('-')[0]
/** Every character outside A-Z, a-z and 0-9 as '-' (the engine's project folder name). */
export const sanitized = text => text.replace(/[^A-Za-z0-9]/g, '-')
/** `date -u -d @<sec> +%Y-%m-%dT%H:%M:%S.000Z` */
export const iso = sec => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z')
/** `date -d '<n> days ago' +%Y-%m-%d`, in local time; with 0 `date +%Y-%m-%d`. */
export function localDate(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** `touch -d '<seconds> seconds ago' path` */
export function touchAgo(path, seconds) {
  const when = Date.now() / 1000 - seconds
  fs.utimesSync(path, when, when)
}
/** `find dir -type f`: the regular files under a folder, links not followed, with / as separator. */
export function regularFiles(dir) {
  const found = []
  const walk = here => {
    let entries
    try {
      entries = fs.readdirSync(here, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(here, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) found.push(native(path))
    }
  }
  walk(dir)
  return found.sort()
}
/** The node on a PATH and its major version (`node --version`); undefined when none. */
export function nodeMajor(path = process.env.PATH ?? '') {
  const node = which('node', path)
  if (node === undefined) return { node: undefined, major: undefined }
  const ran = spawnSync(node, ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: path }, timeout: 30_000 })
  const m = /^v(\d+)\./.exec(ran.stdout ?? '')
  return { node, major: m ? Number(m[1]) : undefined }
}

// ---------------------------------------------------------------- the scratch directory and the cleanup

let cleanupFn = () => {}
let cleaned = false
/** Runs the script's cleanup once: at the end, on an error, or on SIGINT/SIGTERM (then exit 1, as `trap 'exit 1' INT TERM`). */
export function runCleanup() {
  if (cleaned) return
  cleaned = true
  try {
    cleanupFn()
  } catch (error) {
    out(`info cleanup: ${error.message}`)
  }
}
process.on('exit', runCleanup)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1))

/** `mktemp -d "${TMPDIR:-/tmp}/<prefix>.XXXXXX"`, links resolved; the cleanup given runs once at the end. */
export function scratch(prefix, cleanup) {
  const base = process.env.TMPDIR || (IS_WINDOWS ? tmpdir() : '/tmp')
  let dir
  try {
    dir = fs.realpathSync(fs.mkdtempSync(join(base, `${prefix}.`)))
  } catch {
    kit.fail('scratch directory made')
    process.exit(1)
  }
  cleanupFn = () => cleanup(dir)
  return dir
}
/** The end of a run: the cleanup, then the check that the scratch directory went, then the exit code. */
export function finish(dir) {
  runCleanup()
  if (fs.existsSync(dir)) kit.fail(`scratch directory ${dir} removed`)
  else kit.pass('scratch directory removed')
  process.exit(kit.failed ? 1 : 0)
}
/** `rm -rf dir` */
export const removeTree = dir => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })

// ---------------------------------------------------------------- processes

/** `/proc/<pid>/cmdline` with its NULs as blanks (`tr '\0' ' '`), or undefined. Linux only. */
export function cmdline(pid) {
  if (!HAS_PROC) return undefined
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ')
  } catch {
    return undefined
  }
}
/** Field 22 of /proc/<pid>/stat, the start, or '' when gone. Linux only. */
export function startOf(pid) {
  if (!HAS_PROC) return ''
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] ?? ''
  } catch {
    return ''
  }
}
export const comm = pid => readOr(`/proc/${pid}/comm`).replace(/\n$/, '')
/**
 * Every process from Win32_Process in one PowerShell call: pid to parent pid, name, start in epoch ms (PROBE_PS1's
 * arithmetic, so it compares with the starts stop_worker reports) and command line. Empty map when the call fails.
 */
export function winProcs() {
  const script =
    '$e = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc); ' +
    "Get-CimInstance Win32_Process | ForEach-Object { $c = ''; if ($_.CreationDate) { $c = [long][Math]::Floor(($_.CreationDate.ToUniversalTime() - $e).TotalMilliseconds) }; " +
    "@($_.ProcessId, $_.ParentProcessId, $_.Name, $c, ([string]$_.CommandLine -replace '[\\t\\r\\n]', ' ')) -join [char]9 }"
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const all = new Map()
  for (const line of linesOf(ran.stdout ?? '')) {
    const [pid, ppid, name, start, ...cmd] = line.split('\t')
    if (/^[0-9]+$/.test(pid ?? '')) all.set(pid, { ppid: ppid ?? '', name: name ?? '', start: start ?? '', cmd: cmd.join(' ') })
  }
  return all
}
export const procCwd = pid => {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return ''
  }
}
export const ppid = pid => firstMatch(readOr(`/proc/${pid}/status`), /^PPid:\s*(\d+)/m)
/** The numeric entries of /proc, sorted as a glob /proc/[0-9]* gives them. */
export const procPids = () => (HAS_PROC ? fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name)).sort() : [])
/** Whether a pid is still one this run started: its command line names the scratch directory. */
export const ours = (pid, dir) => Boolean(pid) && (cmdline(pid)?.includes(dir) || cmdline(pid)?.includes(native(dir))) === true
/** Whether a process with that pid exists (`kill -0` without a signal: /proc on Linux, signal 0 elsewhere). */
export function pidExists(pid) {
  if (!pid) return false
  if (HAS_PROC) return fs.existsSync(`/proc/${pid}`)
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
/** `kill -<signal> pid` for a pid the caller has proved is this run's own; false when it failed. */
export function signal(pid, sig = 'SIGTERM') {
  try {
    process.kill(Number(pid), sig)
    return true
  } catch {
    return false
  }
}

/**
 * The first three processes other than this one and its parent whose command line or working directory names the
 * directory, as `<pid> <command line>[ (cwd <dir>)]`. Only those two pids are left out, never a process by its name, so
 * every leftover of this run is reported. The working directory is read on Linux only (/proc).
 */
export function processesNaming(dir) {
  let rows = []
  if (HAS_PROC) {
    rows = procPids().map(pid => [pid, cmdline(pid) ?? '', procCwd(pid)])
  } else if (IS_WINDOWS) {
    const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }"], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    rows = linesOf(ran.stdout ?? '').map(line => [before(line, ' '), line.slice(line.indexOf(' ') + 1), ''])
  } else {
    const ran = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 60_000 })
    rows = linesOf(ran.stdout ?? '').map(line => [before(line.trim(), ' '), line.trim().slice(line.trim().indexOf(' ') + 1), ''])
  }
  const own = new Set([String(process.pid), String(process.ppid)])
  const wanted = [dir, native(dir), dir.replaceAll('/', '\\')]
  const names = text => wanted.some(one => text.includes(one))
  return rows
    .filter(([pid, args, cwd]) => !own.has(pid) && (names(args) || names(cwd)))
    .slice(0, 3)
    .map(([pid, args, cwd]) => `${pid} ${args}${names(cwd) ? ` (cwd ${cwd})` : ''}`)
    .join('\n')
}

/**
 * A script's KEEP_OUT copies (`mkdir -p <keep> && cp ...`). `steps` are cp calls: `{ files }` into the folder, `{ files:
 * [file], name }` to a name of its own. A failure never ends the run; with `quiet` false it is said on stderr. Answers
 * whether every step copied everything.
 */
export function keepOut(keep, steps, quiet = true) {
  const say = text => quiet || fs.writeSync(2, text + '\n')
  let made = true
  try {
    fs.mkdirSync(keep, { recursive: true })
  } catch (error) {
    // mkdir's message is never hidden.
    fs.writeSync(2, `mkdir: cannot create directory '${keep}': ${error.code ?? error.message}\n`)
    made = false
  }
  let ok = made
  steps.forEach((step, n) => {
    if (n === 0 && !made) return
    for (const file of step.files) {
      try {
        fs.copyFileSync(file, join(keep, step.name ?? basename(file)))
      } catch (error) {
        say(`cp: cannot copy '${file}': ${error.code ?? error.message}`)
        ok = false
      }
    }
  })
  return ok
}
/** A shell glob `<dir>/<pattern>` of file names matching `regex`, sorted; with no match the pattern itself, as sh leaves it. */
export function globIn(dir, regex, pattern) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter(name => regex.test(name)).sort()
  } catch {}
  return names.length > 0 ? names.map(name => join(dir, name)) : [join(dir, pattern)]
}
const before = (text, sep) => (text.includes(sep) ? text.slice(0, text.indexOf(sep)) : text)

/**
 * The headless orchestrator: `(cd <cwd> && <env> exec claude <args> < <stdin> > <stdout> 2> <stderr>) &`. The child is
 * claude itself, so its pid is the orchestrator's. Only this run's own child is ever signalled:
 * stop() signals it while Node still holds it unreaped.
 */
export function startClaude({ claude, cwd, args, stdin, stdout, stderr, env = {} }) {
  const fds = [fs.openSync(stdin, 'r'), fs.openSync(stdout, 'w'), fs.openSync(stderr, 'w')]
  const child = spawn(claude, args, { cwd, env: withEnv(env), stdio: fds, windowsHide: true })
  for (const fd of fds) fs.closeSync(fd)
  let code = null
  const exited = new Promise(done => {
    child.on('exit', (status, sig) => {
      code = status ?? (sig ? 128 : 1)
      done(code)
    })
    child.on('error', () => {
      code = 127
      done(code)
    })
  })
  return {
    pid: child.pid,
    alive: () => code === null,
    code: () => code,
    exited,
    stop() {
      if (code === null) child.kill('SIGTERM')
    },
  }
}
/** This process's environment with some variables set; on Windows, where names ignore case, an old Path goes first. */
export function withEnv(env) {
  const all = { ...process.env }
  for (const key of Object.keys(env)) {
    if (IS_WINDOWS) for (const old of Object.keys(all)) if (old.toUpperCase() === key.toUpperCase()) delete all[old]
    all[key] = env[key]
  }
  return all
}
/** The claude on the PATH (`command -v claude`), or a FAIL line and exit 1. */
export function requireClaude(path = process.env.PATH ?? '', what = 'claude is on the PATH') {
  const claude = which('claude', path)
  if (claude === undefined) {
    kit.fail(what)
    process.exit(1)
  }
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(claude)) {
    // Node starts no .cmd shim without a shell; the native installer's claude.exe is what the mod runs too.
    kit.fail(`${what} as claude.exe (found ${claude}, a shim that needs a shell)`)
    process.exit(1)
  }
  return claude
}
/**
 * The wait for the orchestrator: up to `limit` seconds, one tick a second (`tick` runs each second, before the pause);
 * then the verdict lines. `isOk` reads orchestrator.json (is_error false). Returns the elapsed seconds.
 */
export async function awaitOrchestrator(orch, { limit, dir, tick = async () => sleep(1000), isOk }) {
  let elapsed = 0
  while (orch.alive() && elapsed < limit) {
    await tick()
    elapsed++
  }
  if (orch.alive()) {
    kit.fail(`orchestrator finished within ${limit} s`)
    orch.stop()
    await Promise.race([orch.exited, sleep(30_000)])
  } else {
    const code = orch.code()
    if (code === 0 && isOk()) kit.pass(`orchestrator finished in ${elapsed} s, exit 0`)
    else kit.fail(`orchestrator finished, exit ${code}: ${headBytes([join(dir, 'orchestrator.err'), join(dir, 'orchestrator.json')]).replaceAll('\n', ' ')}`)
  }
  return elapsed
}
/** jq -e '.is_error == false' orchestrator.json */
export const isErrorFalse = path => readJson(path)?.is_error === false
/** The settings every script passes: the scratch orchestrator directory, registry and runs directory, no licence picker. */
export const scratchSettings = (orch, reg, runs, pollSeconds = 2) =>
  JSON.stringify({ pluginConfigs: { 'session-control@inline': { options: { orchestratorDir: orch, registryPath: reg, runsDir: runs, licencePickCommand: '', completionWrites: true, pollSeconds, debug: false } } } })

// ---------------------------------------------------------------- the orchestrator's transcript

/** `ls <cfg>/projects/*\/<sid>.jsonl | head -n 1`: the transcript of a session, or ''. */
export function transcriptOf(cfg, sid) {
  if (!sid) return ''
  let dirs
  try {
    dirs = fs.readdirSync(join(cfg, 'projects')).sort()
  } catch {
    return ''
  }
  for (const d of dirs) {
    const path = join(cfg, 'projects', d, `${sid}.jsonl`)
    if (fs.existsSync(path)) return path
  }
  return ''
}
/** The transcript's entries, one JSON value per line; reading stops at a line that is no JSON, as jq does. */
export function entriesOf(path) {
  const entries = []
  for (const line of linesOf(readOr(path))) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      break
    }
  }
  return entries
}
/** The tool_use blocks of the assistant entries, in order: {id, name, input}. */
export const toolUses = entries =>
  entries.filter(e => e?.type === 'assistant').flatMap(e => (Array.isArray(e.message?.content) ? e.message.content : [])).filter(c => c?.type === 'tool_use')
/**
 * The answer to a tool call as jq -r prints it: each tool_result of that id, its content (a string, or its text parts
 * joined by newlines) plus a newline; with `marked` each starts with OK or ERROR and a newline. Where jq stops with an
 * error (content missing or a scalar, a part no object, a text an object or array) the rest of that transcript line
 * gives nothing, as in jq: a call whose only answer has no content has no answer.
 */
export function resultText(entries, id, marked = false) {
  let text = ''
  for (const e of entries) {
    const type = jqField(e, 'type')
    if (type !== 'user') continue
    const content = jqField(jqField(e, 'message'), 'content')
    for (const c of jqEach(content) ?? []) {
      const ctype = jqField(c, 'type')
      if (ctype === JQ_ERROR) break
      if (ctype !== 'tool_result' || jqField(c, 'tool_use_id') !== id) continue
      const body = jqContent(jqField(c, 'content'))
      if (body === JQ_ERROR) break
      text += (marked ? (c.is_error === true ? 'ERROR\n' : 'OK\n') : '') + body + '\n'
    }
  }
  return text
}
/** What jq gives instead of a value when it stops with an error. */
const JQ_ERROR = Symbol('jq error')
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
/** jq's `.key`: null for null (and for a value already failed: the error), the field of an object (null when missing); an error for anything else. */
function jqField(value, key) {
  if (value === JQ_ERROR) return JQ_ERROR
  if (value === null || value === undefined) return null
  if (!isObject(value)) return JQ_ERROR
  return Object.hasOwn(value, key) ? value[key] : null
}
/** jq's `.[]`: an array's items, an object's values; undefined (jq's error) for anything else. */
const jqEach = value => (Array.isArray(value) ? value : isObject(value) ? Object.values(value) : undefined)
/** `if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end`, or JQ_ERROR. */
function jqContent(content) {
  if (typeof content === 'string') return content
  const parts = jqEach(content)
  if (parts === undefined) return JQ_ERROR
  const texts = []
  for (const part of parts) {
    const type = jqField(part, 'type')
    if (type === JQ_ERROR) return JQ_ERROR
    if (type === 'text') texts.push(jqField(part, 'text'))
  }
  // join: null as '', a number or a boolean as its JSON text, an object or an array an error.
  if (texts.some(text => text !== null && typeof text === 'object')) return JQ_ERROR
  return texts.map(text => (text === null ? '' : typeof text === 'string' ? text : JSON.stringify(text))).join('\n')
}
/** A value as jq -r prints it: a string as it is, anything else as JSON (an object or an array indented by two). */
const jqRaw = value => (typeof value === 'string' ? value : isObject(value) || Array.isArray(value) ? JSON.stringify(value, null, 2) : JSON.stringify(value))
/**
 * `jq -r '(.[] | select(.title == "<title>")).<path> // <alt>' <registry>` as $(...) holds it: the non-null, non-false
 * values at the path (as `outcome.kind`) of every entry with that title, one per line, else `alt`. Where jq stops with
 * an error (registry missing or no array/object, an entry no object, a path through a scalar) the values before it
 * stand and `alt` is not given. Two entries with the title give two lines, which no single value equals.
 */
export function jqPick(registry, title, path, alt = '') {
  const items = registry === undefined ? undefined : jqEach(registry)
  if (items === undefined) return ''
  const values = []
  for (const item of items) {
    const itemTitle = jqField(item, 'title')
    if (itemTitle === JQ_ERROR) return values.join('\n')
    if (itemTitle !== title) continue
    let value = item
    for (const key of path.split('.')) value = jqField(value, key)
    if (value === JQ_ERROR) return values.join('\n')
    if (value !== null && value !== false) values.push(jqRaw(value))
  }
  return values.length > 0 ? values.join('\n') : alt
}
/**
 * `jq -e '.[] | select(.title == "<title>") | .<path>' <registry>` succeeds: there is an entry with that title, no error,
 * and the value of the last one is neither null nor false (jq -e judges by its last output).
 */
export function jqLastTruthy(registry, title, path) {
  const items = registry === undefined ? undefined : jqEach(registry)
  if (items === undefined) return false
  const values = []
  for (const item of items) {
    const itemTitle = jqField(item, 'title')
    if (itemTitle === JQ_ERROR) return false
    if (itemTitle !== title) continue
    let value = item
    for (const key of path.split('.')) value = jqField(value, key)
    if (value === JQ_ERROR) return false
    values.push(value)
  }
  return values.length > 0 && values.at(-1) !== null && values.at(-1) !== false
}
/**
 * `grep -F -q -- <pattern>` over a text: each line of the pattern is a pattern of its own (a value read from two
 * registry entries is two), any of them found within one line of the text matches, an empty one matches any line, and
 * a text with no line matches nothing.
 */
export function grepF(text, pattern) {
  const patterns = pattern.split('\n')
  return linesOf(text).some(line => patterns.some(one => line.includes(one)))
}
/** This file as a URL: the scripts a test writes for the orchestrator's Bash tool import it from there. */
export const LIB_URL = import.meta.url
/**
 * The JSON values of a text one after the other, as jq reads a file: whitespace (line ends too) between them, so a
 * value may span lines and a line may hold two; undefined when any part is no JSON (jq stops there with an error).
 */
export function jsonValues(text) {
  const values = []
  const blank = c => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  // The index after the string that starts at i, or -1 when it does not end.
  const stringEnd = i => {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === '\\') j++
      else if (text[j] === '"') return j + 1
    }
    return -1
  }
  let i = 0
  for (;;) {
    while (i < text.length && blank(text[i])) i++
    if (i >= text.length) return values
    const from = i
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0
      while (i < text.length) {
        const c = text[i]
        if (c === '"') {
          i = stringEnd(i)
          if (i < 0) return undefined
          continue
        }
        i++
        if (c === '{' || c === '[') depth++
        else if ((c === '}' || c === ']') && --depth === 0) break
      }
      if (depth !== 0) return undefined
    } else if (text[i] === '"') {
      i = stringEnd(i)
      if (i < 0) return undefined
    } else {
      while (i < text.length && !blank(text[i]) && !'{["'.includes(text[i])) i++
    }
    try {
      values.push(JSON.parse(text.slice(from, i)))
    } catch {
      return undefined
    }
  }
}
/** The tool names the orchestrator called, as the info line lists them. */
export const callCounts = entries => countedList(toolUses(entries).map(c => c.name))

/** A node script for the orchestrator's Bash tool to run with this node (process.execPath). */
export function nodeCommand(script, ...args) {
  const quote = text => `"${native(text)}"`
  return [quote(process.execPath), quote(script), ...args.map(quote)].join(' ')
}
/** Writes a node script into the scratch directory. */
export const writeScript = (path, body) => fs.writeFileSync(path, body)
export { basename, join }
