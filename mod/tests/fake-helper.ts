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

/** The helper's answer to one request over the map of files; `probeOut` is what its probe prints; `mtimes` the files' mtimes in ms. */
export function helperAnswer(files: Map<string, string>, op: string, request: Request, probeOut: string, keyOf: KeyOf = path => path.replace(/\\/g, '/'), mtimes: ReadonlyMap<string, number> = new Map()): Record<string, unknown> {
  const path = keyOf(String(request.path ?? ''))
  const fail = (code: string) => ({ ok: false, code })
  if (op === 'probe') return { ok: true, out: probeOut }
  if (op === 'writeAtomic') {
    if (request.expected !== undefined && files.get(path) !== request.expected) return { ok: true, written: false }
    files.set(path, String(request.text))
    return { ok: true, written: true }
  }
  if (op === 'renameOver') return move(files, keyOf, String(request.from), String(request.to)) ? { ok: true } : fail('NOT_FOUND')
  if (op === 'removeFile') return { ok: true, removed: files.delete(path) }
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
      const one = helperAnswer(files, String(step.op), step, probeOut, keyOf, mtimes)
      if (one.ok !== true) return { ...one, at, results }
      results.push(one)
    }
    return { ok: true, results }
  }
  return fail('BAD_OP')
}
