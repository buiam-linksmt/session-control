// The helper's operations by name: one request's answer, and a batch of file operations run in order.

import { FILE_OPS } from './files.mjs'
import { probe } from './linux.mjs'
import { processTree, stopProcesses } from './stop.mjs'
import { probeUsage } from './usage.mjs'
import { HelperError, count, failure } from './protocol.mjs'

/** The most operations one batch carries. */
export const MAX_BATCH = 1000

/** The longest wait one pause asks for, in milliseconds. */
export const PAUSE_MAX_MS = 10_000

/**
 * A wait in this process: answers `{ok:true}` once `ms` milliseconds (a whole number, 0 to PAUSE_MAX_MS) have passed,
 * and nothing else. The mod waits this way on Windows, where it has no `sleep` to start: a hook's time budget counts a
 * wait on the engine's clock and never the time a process runs.
 */
function pause(request) {
  const ms = count(request, 'ms')
  if (ms > PAUSE_MAX_MS) throw new HelperError('BAD_REQUEST')
  return new Promise(resolve => setTimeout(() => resolve({ ok: true }), ms))
}

/** One file operation of a batch, or of a request of its own. */
function runFileOp(op, request) {
  const work = Object.hasOwn(FILE_OPS, op) ? FILE_OPS[op] : undefined
  if (work === undefined) throw new HelperError('BAD_OP')
  return work(request)
}

/** The steps of a batch in order; the first that fails ends it, with its position and the answers before it. */
function batch(request) {
  const ops = request.ops
  if (!Array.isArray(ops) || ops.length > MAX_BATCH || !ops.every(one => one !== null && typeof one === 'object' && !Array.isArray(one) && typeof one.op === 'string')) {
    throw new HelperError('BAD_REQUEST')
  }
  const results = []
  for (const [at, one] of ops.entries()) {
    try {
      results.push({ ok: true, ...runFileOp(one.op, one) })
    } catch (err) {
      return failure(err, { at, results })
    }
  }
  return { ok: true, results }
}

/** The answer to one request: an object, or for probeUsage and pause the promise of one. */
export function answer(op, request) {
  try {
    if (op === 'batch') return batch(request)
    if (op === 'probe') {
      if (process.platform !== 'linux') throw new HelperError('UNSUPPORTED')
      return { ok: true, ...probe(request) }
    }
    // The stop of stop_worker (Linux only, as the probe): never in a batch.
    if (op === 'processTree') return { ok: true, ...processTree(request) }
    if (op === 'stopProcesses') return { ok: true, ...stopProcesses(request) }
    // The usage probe of probe_licence_usage: one claude process (its group on Linux), never in a batch.
    if (op === 'probeUsage') return probeUsage(request).then(fields => ({ ok: true, ...fields }), err => failure(err))
    // The wait between discovery checks (Windows): never in a batch.
    if (op === 'pause') return pause(request)
    return { ok: true, ...runFileOp(op, request) }
  } catch (err) {
    return failure(err)
  }
}
