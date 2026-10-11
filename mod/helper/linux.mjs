// The process probe on Linux: /proc read directly, printed in the line format parseProcFacts in hooks/core.ts reads
// (PROBE_PS1 of hooks/host-windows.ts prints the same lines on Windows):
//   P <pid> <comm> <elapsedSec> <cwd> <CLAUDE_CONFIG_DIR> <cmdline>   each process named claude
//   A <pid> <comm> <statStart> <fileProcStart> <fileSessionId>        each asked pid that exists
//   T <sid> <mtimeEpochSec>                                            newest transcript of an asked session
// Of a process's environment only CLAUDE_CONFIG_DIR is taken, in memory; the rest is never kept, returned or logged.
// Of a sessions file only procStart and sessionId are taken.

import * as fs from 'node:fs'

/**
 * /proc, or a fake tree's in the helper's own tests: SC_HELPER_PROC_ROOT counts only together with SC_HELPER_TEST=1, so
 * a stray variable in the environment the mod runs node with cannot point the probe at another tree.
 */
const PROC = (process.env.SC_HELPER_TEST === '1' && process.env.SC_HELPER_PROC_ROOT) || '/proc'

/**
 * Clock ticks per second of /proc/<pid>/stat (what `getconf CLK_TCK` prints). The kernel reports USER_HZ, which is
 * 100 on every Linux architecture Claude Code runs on (x86-64, arm64); Node has no sysconf to ask.
 */
const CLK_TCK = 100

/** A file's text, or undefined when it cannot be read. */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Field 22 of /proc/<pid>/stat, the start time in clock ticks: the 20th field after the command's closing ") ". */
function startTicks(pid) {
  const stat = readText(`${PROC}/${pid}/stat`)
  if (stat === undefined) return ''
  const at = stat.lastIndexOf(') ')
  return at < 0 ? '' : (stat.slice(at + 2).split(' ')[19] ?? '')
}

/** A pid's state letter (field 3 of /proc/<pid>/stat: R, S, D, Z, ...), or '' when it cannot be read. */
function procState(pid) {
  const stat = readText(`${PROC}/${pid}/stat`)
  if (stat === undefined) return ''
  const at = stat.lastIndexOf(') ')
  return at < 0 ? '' : (stat.slice(at + 2).split(' ')[0] ?? '')
}

/** The comm of a pid without its newline (`read -r` also drops blanks at both ends), or undefined. */
function comm(pid) {
  const text = readText(`${PROC}/${pid}/comm`)
  return text === undefined ? undefined : text.replace(/\n$/, '')
}

/**
 * CLAUDE_CONFIG_DIR of a process: its environ split at NUL and newline, the first piece that starts with the name
 * (as `tr "\000" "\n" | sed -n "s/^CLAUDE_CONFIG_DIR=//p" | head -n 1` takes it). Nothing else of the environment
 * leaves this function.
 */
function configDir(pid) {
  const environ = readText(`${PROC}/${pid}/environ`)
  if (environ === undefined) return ''
  const name = 'CLAUDE_CONFIG_DIR='
  const piece = environ.split(/[\0\n]/).find(one => one.startsWith(name))
  return piece === undefined ? '' : piece.slice(name.length)
}

/** jq -r '.<field> // empty' of a parsed sessions file: null, false and a missing field are empty, a string is itself. */
function jqRaw(value) {
  if (value === undefined || value === null || value === false) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** procStart and sessionId of a sessions file, those two fields only; empty when the file is missing or not JSON. */
function sessionFields(file) {
  const text = readText(file)
  if (text === undefined) return { procStart: '', sessionId: '' }
  try {
    const parsed = JSON.parse(text)
    const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    return isObject ? { procStart: jqRaw(parsed.procStart), sessionId: jqRaw(parsed.sessionId) } : { procStart: '', sessionId: '' }
  } catch {
    return { procStart: '', sessionId: '' }
  }
}

/** The P lines: each process named claude, in the order a /proc/[0-9]* glob lists them. */
function claudeLines() {
  const uptime = readText(`${PROC}/uptime`)
  const up = uptime === undefined ? undefined : Number.parseInt(uptime.split('.')[0], 10)
  let names
  try {
    names = fs.readdirSync(PROC)
  } catch {
    return []
  }
  const pids = names.filter(name => /^[0-9]/.test(name)).sort()
  const lines = []
  for (const pid of pids) {
    const name = comm(pid)
    if (name === undefined || name.trim() !== 'claude') continue
    const cmdline = (readText(`${PROC}/${pid}/cmdline`) ?? '').replace(/[\0\t\n]/g, ' ')
    let cwd = ''
    try {
      cwd = fs.readlinkSync(`${PROC}/${pid}/cwd`)
    } catch {
      // another user's process, or gone
    }
    const ticks = startTicks(pid)
    const elapsed = ticks !== '' && up !== undefined && Number.isFinite(up) ? String(up - Math.floor(Number(ticks) / CLK_TCK)) : ''
    lines.push(`P\t${pid}\tclaude\t${elapsed}\t${cwd}\t${configDir(pid)}\t${cmdline}\n`)
  }
  return lines
}

/** The A line of a `pid:<pid>|<config dir>` argument whose pid exists. */
function proofLine(arg) {
  const rest = arg.slice('pid:'.length)
  const cut = rest.indexOf('|')
  const pid = cut < 0 ? rest : rest.slice(0, cut)
  const after = cut < 0 ? rest : rest.slice(cut + 1)
  const dir = after.includes('|') ? after.slice(0, after.indexOf('|')) : after
  // A registry pid is a number; anything else (self, ..) is never looked up.
  if (!/^[0-9]+$/.test(pid)) return undefined
  try {
    if (!fs.statSync(`${PROC}/${pid}`).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const ticks = startTicks(pid)
  const file = sessionFields(`${dir}/sessions/${pid}.json`)
  return `A\t${pid}\t${comm(pid) ?? ''}\t${ticks}\t${file.procStart}\t${file.sessionId}\t${procState(pid)}\n`
}

/** The T line of a `t:<session id>|<config dir>` argument: the newest <config dir>/projects/*\/<sid>.jsonl. */
function transcriptLine(arg) {
  const rest = arg.slice('t:'.length)
  const cut = rest.indexOf('|')
  const sid = cut < 0 ? rest : rest.slice(0, cut)
  const dir = cut < 0 ? rest : rest.slice(cut + 1)
  let projects
  try {
    projects = fs.readdirSync(`${dir}/projects`)
  } catch {
    return undefined
  }
  let newest
  // The glob's * leaves out names that start with a dot.
  for (const project of projects.filter(name => !name.startsWith('.'))) {
    try {
      // stat -c %Y and ls -t read a link itself, not what it names.
      const stat = fs.lstatSync(`${dir}/projects/${project}/${sid}.jsonl`, { bigint: true })
      if (newest === undefined || stat.mtimeNs > newest) newest = stat.mtimeNs
    } catch {
      // no transcript of that session in this project
    }
  }
  return newest === undefined ? undefined : `T\t${sid}\t${newest / 1_000_000_000n}\n`
}

/** `{args}`, the arguments probeArgs gives the probe: `{out}`, the probe's lines. */
export function probe(request) {
  const args = Array.isArray(request.args) ? request.args.filter(arg => typeof arg === 'string') : []
  const lines = claudeLines()
  for (const arg of args) {
    const line = arg.startsWith('pid:') ? proofLine(arg) : arg.startsWith('t:') ? transcriptLine(arg) : undefined
    if (line !== undefined) lines.push(line)
  }
  return { out: lines.join('') }
}
