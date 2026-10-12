// The Node helper simulated over a map of files, as mod/helper/host.mjs does its operations on disk: shared by the
// host contract (host.test.ts), the helper layer's tests on the mock engine (helper.test.ts) and the mock machines of
// the plugin's tests. Not a test file itself.

import { tailLines } from '../hooks/core'
import { USAGE_CASES } from './usage-fixtures'
import type { UsageExpect } from './usage-fixtures'

/**
 * A stand-in for the helper's SHA-256 of a file: 64 hex digits that change with the text, line ends folded as the
 * helper folds them (CRLF as LF, unless the text holds a NUL byte). Two FNV-1a lanes, each 32 bits, repeated.
 */
export function standInDigest(text: string): string {
  const folded = text.includes('\0') ? text : text.replace(/\r\n/g, '\n')
  let a = 2166136261
  let b = 3735928559
  for (let at = 0; at < folded.length; at++) {
    a = Math.imul(a ^ folded.charCodeAt(at), 16777619) >>> 0
    b = Math.imul(b ^ folded.charCodeAt(at), 2246822519) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`.repeat(4)
}

/**
 * What the helper's probeUsage answers for a text `claude -p /usage` printed: the answer the recorded and written cases
 * of usage-fixtures.ts give it (helper.test.mjs proves the helper's reader gives each case that answer). A text no case
 * holds is an error of the test.
 */
export function usageAnswerOf(stdout: string, stderr = '', exitCode = 0): UsageExpect {
  const found = USAGE_CASES.find(one => one.stdout === stdout && (one.stderr ?? '') === stderr && (one.exitCode ?? 0) === exitCode)
  if (found === undefined) throw new Error(`no case of usage-fixtures.ts holds this text: ${JSON.stringify(stdout).slice(0, 80)}`)
  return found.expect
}

type Request = Record<string, unknown>

/** The key a path has in the map: as given, or as the test's machine names it. */
export type KeyOf = (path: string) => string

const move = (files: Map<string, string>, keyOf: KeyOf, from: string, to: string) => {
  const text = files.get(keyOf(from))
  if (text === undefined) return false
  files.set(keyOf(to), text)
  files.delete(keyOf(from))
  return true
}

/**
 * A key as the system resolves it through the symbolic links of a test machine (`links`: a link's key to its target's
 * key): the link itself, or a path through a linked directory, comes out at the target.
 */
export function throughLinks(links: ReadonlyMap<string, string>, key: string): string {
  for (const [link, target] of links) {
    if (key === link) return target
    if (key.startsWith(`${link}/`)) return `${target}${key.slice(link.length)}`
  }
  return key
}

/** What the helper's regular-file-only removal does over the map, as a code: 0 removed, 3 not there, 4 a link, 5 no regular file. A path through a linked directory is not looked at: it reaches the target, as the system's does. */
export function removeRegularInMap(files: Map<string, string>, links: ReadonlyMap<string, string>, key: string): number {
  if (links.has(key)) return 4
  const real = throughLinks(links, key)
  if (files.delete(real)) return 0
  return [...files.keys()].some(file => file.startsWith(`${real}/`)) ? 5 : 3
}

/** The files under a directory of the map whose mtime (`mtimes`, 0 when unset) is after a time, as the helper's filesNewerThan walks them: no `.git` entered. */
export function newerInMap(files: Map<string, string>, mtimes: ReadonlyMap<string, number>, dir: string, sinceSec: number): { path: string; mtimeMs: number }[] | undefined {
  const root = dir.replace(/\/+$/, '')
  const under = [...files.keys()].filter(key => key.startsWith(`${root}/`))
  if (under.length === 0) return undefined
  return under
    .filter(key => !key.slice(root.length + 1).split('/').includes('.git'))
    .map(key => ({ path: key, mtimeMs: mtimes.get(key) ?? 0 }))
    .filter(one => one.mtimeMs > sinceSec * 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))
}

/**
 * A simulated process table for the stop of stop_worker: pid to its parent, start, state and name. A `stubborn` process
 * ignores TERM (and taskkill without /F); every signal it gets is recorded in `signals`, so a test can prove which pids
 * were touched. `own` are the pids above the listing process (the session's own chain).
 */
export type SimProc = {
  ppid: number
  start: string
  state: string
  comm: string
  isStubborn?: boolean
  /** A claude process as the probe reads it: its cwd, CLAUDE_CONFIG_DIR and command line (and its age in seconds, 3 when not given). */
  claude?: { cwd: string; configDir: string; cmdline: string; elapsedSec?: number }
  /**
   * Windows: a program started through Git Bash, with the Windows pid of its MSYS parent; its own `ppid` names the fork
   * that exec'd it, which is gone, so only the MSYS process table links it to the tree.
   */
  msysParent?: number
  /** Windows, with `msysParent`: the runtime folder (an MSYS table's `dir`) it runs from, when not the first table's. */
  msysDir?: string
  /** A process even taskkill /F cannot end (access denied: exit 1). */
  isUnkillable?: boolean
}
/**
 * Windows: the folder of an MSYS process table TREE_PS1 reads (Git's usr/bin), and whether that table cannot be read
 * (its ps.exe fails), or what its ps.exe does instead of printing the table (`garbage`: it exits 0 with no row of a
 * table, which TREE_PS1 takes as a table it could not read; `hang`: it gives no answer, and TREE_PS1 ends it at its
 * limit and reads no table).
 */
export type MsysTable = { dir: string; isUnreadable?: boolean; ps?: 'garbage' | 'hang' }
/** `msys`, Windows: the MSYS process table, or the tables, TREE_PS1 reads, in the order it reads them. */
export type ProcTable = { procs: Map<number, SimProc>; own: number[]; signals: { pid: number; signal: string }[]; nowMs: number; msys?: MsysTable | MsysTable[] }

/**
 * The helper's processTree lines over the table (TREE_PS1's list prints the same): R or N, the G lines, the D lines
 * breadth first. `isWindows`: TREE_PS1's own part after them, the table's MSYS process tables (`table.msys`) read for
 * the programs started through Git Bash (an M line with -1, or -2 for a ps.exe that hangs, per table not read; a D line
 * with state msys per process whose MSYS parent is a member and which started after it), then an M line per table read.
 */
export function treeInTable(table: ProcTable, pid: number, start: string, isWindows = false): string {
  const root = table.procs.get(pid)
  const isRoot = root !== undefined && root.start === start && start !== ''
  const lines = [isRoot ? `R\t${pid}\t${root.ppid}\t${root.start}\t${root.state}\t${root.comm}` : `N\t${pid}\t${root?.start ?? ''}`]
  for (const up of table.own) lines.push(`G\t${up}`)
  if (isRoot) {
    const queue = [pid]
    for (let at = 0; at < queue.length; at++) {
      for (const [child, one] of table.procs) {
        if (one.ppid !== queue[at] || queue.includes(child)) continue
        queue.push(child)
        lines.push(`D\t${child}\t${one.ppid}\t${one.start}\t${one.state}\t${one.comm}`)
      }
    }
    if (isWindows && table.msys !== undefined) {
      const tables = [table.msys].flat()
      const added = new Map<string, number>()
      for (const one of tables) {
        if (one.ps === 'hang') lines.push(`M\t-2\t${one.dir}`)
        else if (one.isUnreadable === true || one.ps === 'garbage') lines.push(`M\t-1\t${one.dir}`)
        else added.set(one.dir, 0)
      }
      if (added.size > 0) {
        for (let at = 0; at < queue.length; at++) {
          const parent = table.procs.get(queue[at] ?? 0)
          for (const [child, one] of table.procs) {
            const dir = one.msysDir ?? tables[0]?.dir ?? ''
            if (one.msysParent !== queue[at] || !added.has(dir) || queue.includes(child) || parent === undefined || BigInt(one.start) < BigInt(parent.start)) continue
            queue.push(child)
            added.set(dir, (added.get(dir) ?? 0) + 1)
            lines.push(`D\t${child}\t${queue[at]}\t${one.start}\tmsys\t${one.comm}`)
          }
        }
      }
      for (const [dir, count] of added) lines.push(`M\t${count}\t${dir}`)
    }
  }
  return lines.map(line => `${line}\n`).join('')
}

const sameIn = (table: ProcTable, pid: number, start: string) => table.procs.get(pid)?.start === start

/** One signal over the table: TERM ends a process that is not stubborn, KILL ends any. Answers kill's exit code. */
export function signalInTable(table: ProcTable, pid: number, signal: 'TERM' | 'KILL'): number {
  table.signals.push({ pid, signal })
  const one = table.procs.get(pid)
  if (one === undefined) return 1
  if (signal === 'KILL' || one.isStubborn !== true) table.procs.delete(pid)
  return 0
}

/** The helper's stopProcesses lines over the table: the root, then the descendants still there; then F lines. */
export function stopInTable(table: ProcTable, wait: number, targets: readonly string[]): string {
  const parsed = targets.map(one => ({ pid: Number(one.split(':')[0]), start: one.split(':')[1] ?? '' }))
  const lines: string[] = []
  const tick = () => (table.nowMs += 7)
  const group = (members: { pid: number; start: string }[]) => {
    const live = []
    for (const one of members) {
      if (table.own.includes(one.pid)) lines.push(`X\t${one.pid}\town`)
      else if (sameIn(table, one.pid, one.start)) {
        lines.push(`S\t${one.pid}\tTERM\t${tick()}\t${signalInTable(table, one.pid, 'TERM')}`)
        live.push(one)
      } else lines.push(`X\t${one.pid}\tgone`)
    }
    if (live.length === 0) return
    const waited = live.some(one => sameIn(table, one.pid, one.start)) ? wait : 0
    const rest = live.filter(one => sameIn(table, one.pid, one.start))
    for (const one of live) lines.push(`C\t${one.pid}\t${tick()}\t${rest.includes(one) ? 'alive' : 'gone'}\t${waited}`)
    if (rest.length === 0) return
    for (const one of rest) lines.push(`S\t${one.pid}\tKILL\t${tick()}\t${signalInTable(table, one.pid, 'KILL')}`)
    for (const one of rest) lines.push(`C\t${one.pid}\t${tick()}\t${sameIn(table, one.pid, one.start) ? 'alive' : 'gone'}\t0`)
  }
  const [root, ...descendants] = parsed
  if (root !== undefined) group([root])
  group(descendants.filter(one => sameIn(table, one.pid, one.start)))
  for (const one of parsed) lines.push(sameIn(table, one.pid, one.start) ? `F\t${one.pid}\talive\t${table.procs.get(one.pid)?.state ?? ''}` : `F\t${one.pid}\tgone\t`)
  return lines.map(line => `${line}\n`).join('')
}

/** TREE_PS1's check over the table: an F line per `<pid>:<start>` target. */
export function checkInTable(table: ProcTable, targets: readonly string[]): string {
  return targets.map(one => `F\t${one.split(':')[0]}\t${sameIn(table, Number(one.split(':')[0]), one.split(':')[1] ?? '') ? 'alive' : 'gone'}\t\n`).join('')
}

/** taskkill /PID <pid> /T (and /F) over the table: the process and its descendants; without /F a stubborn one stays (exit 128), an unkillable one always (exit 1). */
export function taskkillInTable(table: ProcTable, pid: number, isForced: boolean): number {
  const tree = [pid]
  for (let at = 0; at < tree.length; at++) for (const [child, one] of table.procs) if (one.ppid === tree[at] && !tree.includes(child)) tree.push(child)
  if (!table.procs.has(pid)) return 128
  let isRefused = false
  let isDenied = false
  for (const one of tree.reverse()) {
    table.signals.push({ pid: one, signal: isForced ? 'taskkill /F' : 'taskkill' })
    if (table.procs.get(one)?.isUnkillable === true) isDenied = true
    else if (isForced || table.procs.get(one)?.isStubborn !== true) table.procs.delete(one)
    else isRefused = true
  }
  return isDenied ? 1 : isRefused ? 128 : 0
}

/** The helper's answer to one request over the map of files; `probeOut` is what its probe prints; `mtimes` the files' mtimes in ms. */
export function helperAnswer(
  files: Map<string, string>,
  op: string,
  request: Request,
  probeOut: string,
  keyOf: KeyOf = path => path.replace(/\\/g, '/'),
  mtimes: ReadonlyMap<string, number> = new Map(),
  links: ReadonlyMap<string, string> = new Map(),
  table?: ProcTable,
): Record<string, unknown> {
  const path = keyOf(String(request.path ?? ''))
  const fail = (code: string) => ({ ok: false, code })
  if (op === 'probe') return { ok: true, out: probeOut }
  if (op === 'processTree' && table !== undefined) return { ok: true, out: treeInTable(table, Number(request.pid), String(request.start)) }
  if (op === 'stopProcesses' && table !== undefined) return { ok: true, out: stopInTable(table, Number(request.wait), request.targets as string[]) }
  if (op === 'writeAtomic') {
    if (request.expected !== undefined && files.get(path) !== request.expected) return { ok: true, written: false }
    files.set(path, String(request.text))
    return { ok: true, written: true }
  }
  if (op === 'renameOver') return move(files, keyOf, String(request.from), String(request.to)) ? { ok: true } : fail('NOT_FOUND')
  if (op === 'removeFile') {
    if (request.regularOnly !== true) return { ok: true, removed: files.delete(path) }
    const code = removeRegularInMap(files, links, path)
    return code === 0 ? { ok: true, removed: true } : code === 3 ? { ok: true, removed: false } : fail(code === 4 ? 'IS_LINK' : 'NOT_FILE')
  }
  if (op === 'append') {
    files.set(path, `${files.get(path) ?? ''}${String(request.text)}`)
    return { ok: true, bytes: String(request.text).length }
  }
  if (op === 'tail') {
    const text = files.get(path)
    return text === undefined ? fail('NOT_FOUND') : { ok: true, text: tailLines(text, Number(request.lines), Number(request.width)), dropped: 0 }
  }
  if (op === 'rotate') {
    const size = files.get(path)?.length ?? 0
    if (!(size > 0 && size + Number(request.adding) > Number(request.maxBytes))) return { ok: true, rotated: false }
    for (const [from, to] of request.moves as [string, string][]) move(files, keyOf, from, to)
    return { ok: true, rotated: true }
  }
  if (op === 'filesNewerThan') {
    const found = newerInMap(files, mtimes, keyOf(String(request.dir ?? '')), Number(request.since))
    return found === undefined ? fail('NOT_FOUND') : { ok: true, files: found.slice(0, Number(request.max)), total: found.length }
  }
  if (op === 'hashTree') {
    const found = treeInMap(files, links, keyOf(String(request.root ?? '')), request.dirs as string[], request.files as string[])
    return typeof found === 'string' ? fail(found) : { ok: true, files: found, total: found.length }
  }
  if (op === 'batch') {
    const results: unknown[] = []
    for (const [at, step] of (request.ops as Request[]).entries()) {
      const one = helperAnswer(files, String(step.op), step, probeOut, keyOf, mtimes, links, table)
      if (one.ok !== true) return { ...one, at, results }
      results.push(one)
    }
    return { ok: true, results }
  }
  return fail('BAD_OP')
}

/**
 * The helper's hashTree over the map: the direct files of each folder of `dirs` and each file of `files` under `root`,
 * a link (in `links`) passed over, sorted by path; a stand-in digest (standInDigest), which only has to change with the
 * text; NOT_FOUND for a root with nothing under it.
 */
export function treeInMap(files: Map<string, string>, links: ReadonlyMap<string, string>, root: string, dirs: readonly string[], names: readonly string[]): { path: string; sha256: string }[] | string {
  const top = root.replace(/\/+$/, '')
  if (![...files.keys()].some(key => key.startsWith(`${top}/`))) return 'NOT_FOUND'
  const found = new Set<string>()
  for (const dir of dirs) {
    if (links.has(`${top}/${dir}`)) continue
    for (const key of files.keys()) {
      const rest = key.startsWith(`${top}/${dir}/`) ? key.slice(top.length + 1) : undefined
      if (rest !== undefined && rest.split('/').length === dir.split('/').length + 1 && !links.has(key)) found.add(rest)
    }
  }
  for (const name of names) if (files.has(`${top}/${name}`) && !links.has(`${top}/${name}`)) found.add(name)
  return [...found].sort().map(rel => ({ path: rel, sha256: standInDigest(files.get(`${top}/${rel}`) ?? '') }))
}

/** `$.fs.list` over the map: the direct entries of `dir`, a file or a folder each, an entry in `links` as a link (`other`). */
export function listInMap(files: ReadonlyMap<string, string>, links: ReadonlyMap<string, string>, dir: string): { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }[] {
  const top = dir.replace(/\/+$/, '')
  const names = new Set([...files.keys(), ...links.keys()].filter(key => key.startsWith(`${top}/`)).map(key => key.slice(top.length + 1).split('/')[0] ?? ''))
  return [...names].map(name => {
    const full = `${top}/${name}`
    if (links.has(full)) return { name, kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true }
    const text = files.get(full)
    return text === undefined ? { name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } : { name, kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false }
  })
}

/**
 * A small machine's answer to Node: `node --version` (v24.14.0) and one helper call over its map of files (the probe
 * prints `probeOut`); undefined for any other command, which the machine answers itself.
 */
export function nodeAnswer(argv: readonly string[], stdin: string | undefined, files: Map<string, string>, keyOf: KeyOf, probeOut = ''): { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } | undefined {
  const done = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  if (argv[0] !== 'node') return undefined
  if (argv[1] === '--version') return done('v24.14.0\n')
  if (!String(argv[1]).endsWith('/helper/host.mjs')) return undefined
  const answer = helperAnswer(files, String(argv[2]), JSON.parse(stdin ?? '{}') as Request, probeOut, keyOf)
  return done(JSON.stringify(answer), answer.ok === true ? 0 : 1)
}
