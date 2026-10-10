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

/** The helper's answer to one request over the map of files; `probeOut` is what its probe prints. */
export function helperAnswer(files: Map<string, string>, op: string, request: Request, probeOut: string, keyOf: KeyOf = path => path.replace(/\\/g, '/')): Record<string, unknown> {
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
  if (op === 'batch') {
    const results: unknown[] = []
    for (const [at, step] of (request.ops as Request[]).entries()) {
      const one = helperAnswer(files, String(step.op), step, probeOut, keyOf)
      if (one.ok !== true) return { ...one, at, results }
      results.push(one)
    }
    return { ok: true, results }
  }
  return fail('BAD_OP')
}
