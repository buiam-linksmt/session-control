// The stop of stop_worker on Linux: the process tree read from /proc and the signals sent with process.kill, printed in
// the line format parseStopOutput in hooks/host-shared.ts reads (TREE_PS1 of hooks/host-windows.ts prints the same
// tree lines on Windows):
//   R <pid> <ppid> <start> <state> <name>   N <pid> <start now>   D <pid> <ppid> <start> <state> <name>   G <pid>
//   S <pid> <signal> <epoch ms> <exit code>   C <pid> <epoch ms> <gone|exited|alive> <seconds waited>
//   X <pid> <gone|own>   F <pid> <gone|exited|alive> <state>
// A start is field 22 of /proc/<pid>/stat (clock ticks). A process is signalled only while it still has the start its
// target names and is no zombie (state Z, `exited`: ended, its entry kept until its parent reaps it), and never when it
// is this helper or one of its ancestors (the session's own process among them).
//
// The live /proc only: SC_HELPER_PROC_ROOT (the probe's fake tree for its tests) is never honoured here, since a fake
// tree's pids would be signalled on the real machine.

import * as fs from 'node:fs'

import { HelperError, count } from './protocol.mjs'

/** The most seconds a stop waits after TERM. */
const MAX_WAIT = 60

/** How long a KILLed process is waited for (a parent reaps it). */
const KILL_WAIT = 3

/** Waits without a timer (the helper is one short synchronous run). */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A file's text, or undefined when it cannot be read. */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** State, parent pid and start of a pid from /proc/<pid>/stat (the fields after the name's last ") "), or undefined. */
function statOf(pid) {
  const stat = readText(`/proc/${pid}/stat`)
  if (stat === undefined) return undefined
  const at = stat.lastIndexOf(') ')
  if (at < 0) return undefined
  const fields = stat.slice(at + 2).split(' ')
  return { state: fields[0] ?? '', ppid: Number(fields[1]), start: fields[19] ?? '' }
}

/** The name of a pid as the tree lines show it: /proc/<pid>/comm with tabs and line breaks as blanks. */
function nameOf(pid) {
  return (readText(`/proc/${pid}/comm`) ?? '').replace(/[\t\n]/g, ' ').trim()
}

/** Every process: pid to state, parent pid and start, in the order a /proc/[0-9]* glob lists them. */
function snapshot() {
  const all = new Map()
  let names = []
  try {
    names = fs.readdirSync('/proc')
  } catch {
    throw new HelperError('IO')
  }
  for (const name of names.filter(one => /^[0-9]+$/.test(one)).sort()) {
    const stat = statOf(name)
    if (stat !== undefined) all.set(Number(name), stat)
  }
  return all
}

/** This helper's ancestors, from its parent up to (not counting) pid 1: the session's own process is among them. */
function ancestors(all) {
  const up = []
  for (let at = process.ppid; at > 1 && !up.includes(at); at = all.get(at)?.ppid ?? 0) up.push(at)
  return up
}

/** The pid and start of a request, or BAD_REQUEST. */
function rootOf(request) {
  const pid = count(request, 'pid', 1)
  const start = request.start
  if (typeof start !== 'string' || !/^[0-9]+$/.test(start)) throw new HelperError('BAD_REQUEST')
  return { pid, start }
}

/** `{pid, start}`: the tree before the first signal, as R or N, G and D lines. `{out}`. */
export function processTree(request) {
  if (process.platform !== 'linux') throw new HelperError('UNSUPPORTED')
  const { pid, start } = rootOf(request)
  const all = snapshot()
  const root = all.get(pid)
  const isRoot = root !== undefined && root.start === start
  const lines = [isRoot ? `R\t${pid}\t${root.ppid}\t${root.start}\t${root.state}\t${nameOf(pid)}` : `N\t${pid}\t${root?.start ?? ''}`]
  for (const up of ancestors(all)) lines.push(`G\t${up}`)
  if (isRoot) {
    const seen = new Set([pid])
    const queue = [pid]
    for (let at = 0; at < queue.length; at++) {
      for (const [child, stat] of all) {
        if (stat.ppid !== queue[at] || seen.has(child)) continue
        seen.add(child)
        queue.push(child)
        lines.push(`D\t${child}\t${stat.ppid}\t${stat.start}\t${stat.state}\t${nameOf(child)}`)
      }
    }
  }
  return { out: lines.map(line => `${line}\n`).join('') }
}

/** The targets of a stop request, `<pid>:<start>`, the root first; or BAD_REQUEST. */
function targetsOf(request) {
  const targets = request.targets
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 10_000) throw new HelperError('BAD_REQUEST')
  return targets.map(one => {
    const found = typeof one === 'string' ? /^([0-9]+):([0-9]+)$/.exec(one) : null
    if (found === null || Number(found[1]) < 1) throw new HelperError('BAD_REQUEST')
    return { pid: Number(found[1]), start: found[2] }
  })
}

/** Whether a pid still has the start of its target and runs (no zombie). */
const isSame = target => {
  const stat = statOf(target.pid)
  return stat?.start === target.start && stat.state !== 'Z'
}

/** Where a target stands: alive, exited (a zombie with its start) or gone. */
function where(target) {
  const stat = statOf(target.pid)
  return stat?.start !== target.start ? 'gone' : stat.state === 'Z' ? 'exited' : 'alive'
}

/** Sends a signal; the exit code `kill` would give (0 sent, 1 not). */
function signal(pid, name) {
  try {
    process.kill(pid, name)
    return 0
  } catch {
    return 1
  }
}

/** Waits up to `seconds`, one second at a time, while any target still has its start; answers the seconds waited. */
function waitGone(targets, seconds) {
  let waited = 0
  while (waited < seconds && targets.some(isSame)) {
    pause(1000)
    waited++
  }
  return waited
}

/** One group of targets: TERM, the re-checks, KILL to those left, the re-checks. */
function group(targets, wait, own, lines) {
  const live = []
  for (const target of targets) {
    if (own.has(target.pid)) lines.push(`X\t${target.pid}\town`)
    else if (isSame(target)) {
      const code = signal(target.pid, 'SIGTERM')
      lines.push(`S\t${target.pid}\tTERM\t${Date.now()}\t${code}`)
      live.push(target)
    } else lines.push(`X\t${target.pid}\tgone`)
  }
  if (live.length === 0) return
  const waited = waitGone(live, wait)
  const rest = []
  for (const target of live) {
    const status = where(target)
    lines.push(`C\t${target.pid}\t${Date.now()}\t${status}\t${waited}`)
    if (status === 'alive') rest.push(target)
  }
  if (rest.length === 0) return
  for (const target of rest) {
    if (!isSame(target)) continue
    const code = signal(target.pid, 'SIGKILL')
    lines.push(`S\t${target.pid}\tKILL\t${Date.now()}\t${code}`)
  }
  const after = waitGone(rest, KILL_WAIT)
  for (const target of rest) lines.push(`C\t${target.pid}\t${Date.now()}\t${where(target)}\t${after}`)
}

/**
 * `{wait, targets}`: the stop: the root (the first target), then every descendant still alive after it, together; then
 * the end state of each. `{out}`.
 */
export function stopProcesses(request) {
  if (process.platform !== 'linux') throw new HelperError('UNSUPPORTED')
  const wait = count(request, 'wait')
  if (wait > MAX_WAIT) throw new HelperError('BAD_REQUEST')
  const [root, ...descendants] = targetsOf(request)
  const own = new Set([process.pid, ...ancestors(snapshot())])
  const lines = []
  group([root], wait, own, lines)
  group(descendants.filter(isSame), wait, own, lines)
  for (const target of [root, ...descendants]) {
    const status = where(target)
    lines.push(status === 'gone' ? `F\t${target.pid}\tgone\t` : `F\t${target.pid}\t${status}\t${statOf(target.pid)?.state ?? ''}`)
  }
  return { out: lines.map(line => `${line}\n`).join('') }
}
