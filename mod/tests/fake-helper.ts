// The Node helper simulated over a map of files, as mod/helper/host.mjs does its operations on disk: shared by the
// host contract (host.test.ts) and the helper's own tests on the mock engine (helper.test.ts). Not a test file itself.

import { tailLines } from '../hooks/core'

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

/** What a regular-file-only removal does over the map: the exit code the native scripts give (0 removed, 3 not there, 4 a link, 5 no regular file). A path through a linked directory is not looked at: it reaches the target, as the system's does. */
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
  /** A claude process as the probe reads it: its cwd, CLAUDE_CONFIG_DIR and command line. */
  claude?: { cwd: string; configDir: string; cmdline: string }
}
export type ProcTable = { procs: Map<number, SimProc>; own: number[]; signals: { pid: number; signal: string }[]; nowMs: number }

/** TREE_SCRIPT's (and the helper's processTree) lines over the table: R or N, the G lines, the D lines breadth first. */
export function treeInTable(table: ProcTable, pid: number, start: string): string {
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

/** STOP_SCRIPT's (and the helper's stopProcesses) lines over the table: the root, then the descendants still there; then F lines. */
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

/** taskkill /PID <pid> /T (and /F) over the table: the process and its descendants; without /F a stubborn one stays (exit 128). */
export function taskkillInTable(table: ProcTable, pid: number, isForced: boolean): number {
  const tree = [pid]
  for (let at = 0; at < tree.length; at++) for (const [child, one] of table.procs) if (one.ppid === tree[at] && !tree.includes(child)) tree.push(child)
  if (!table.procs.has(pid)) return 128
  let isRefused = false
  for (const one of tree.reverse()) {
    table.signals.push({ pid: one, signal: isForced ? 'taskkill /F' : 'taskkill' })
    if (isForced || table.procs.get(one)?.isStubborn !== true) table.procs.delete(one)
    else isRefused = true
  }
  return isRefused ? 128 : 0
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
