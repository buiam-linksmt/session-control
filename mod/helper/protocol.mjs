// The helper's protocol: one JSON request on stdin, one JSON object on stdout, exit code 0 or 1. A failure is answered
// with a fixed code only: never a Node error message, a path or file content (a message can quote a file's content).

/** The most a request may carry: the mod sends a registry, a helper file or a 64 KiB chunk of trace lines. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024

/** Every code the helper answers with. */
export const CODES = Object.freeze([
  'BAD_OP',
  'BAD_REQUEST',
  'TOO_LARGE',
  'UNSUPPORTED',
  'NOT_FOUND',
  'ACCESS',
  'BUSY',
  'EXISTS',
  'IS_DIR',
  'NOT_DIR',
  'IS_LINK',
  'NOT_FILE',
  'NO_SPACE',
  'READ_ONLY',
  'CROSS_DEVICE',
  'IO',
  'INTERNAL',
])

/** Node's error codes as the helper's own; anything else from the file system is IO. */
const FS_CODES = {
  ENOENT: 'NOT_FOUND',
  EACCES: 'ACCESS',
  EPERM: 'ACCESS',
  EBUSY: 'BUSY',
  EEXIST: 'EXISTS',
  EISDIR: 'IS_DIR',
  ENOTDIR: 'NOT_DIR',
  ENOSPC: 'NO_SPACE',
  EDQUOT: 'NO_SPACE',
  EROFS: 'READ_ONLY',
  EXDEV: 'CROSS_DEVICE',
}

/** A failure the helper names itself. */
export class HelperError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

/** The fixed code of anything thrown: a HelperError's own, a file-system error's by its errno name, else INTERNAL. */
export function codeOf(err) {
  if (err instanceof HelperError) return err.code
  const code = err !== null && typeof err === 'object' ? err.code : undefined
  if (typeof code !== 'string') return 'INTERNAL'
  // ERR_* is Node's own (a bad argument), E<errno> the system's.
  return FS_CODES[code] ?? (/^E[A-Z]+$/.test(code) ? 'IO' : 'INTERNAL')
}

/** A string field of a request, or BAD_REQUEST. */
export function text(request, name, isOptional = false) {
  const value = request[name]
  if (value === undefined && isOptional) return undefined
  if (typeof value !== 'string') throw new HelperError('BAD_REQUEST')
  return value
}

/** A non-empty string field naming a file, or BAD_REQUEST. */
export function path(request, name) {
  const value = text(request, name)
  if (value === '' || value.includes('\0')) throw new HelperError('BAD_REQUEST')
  return value
}

/** A whole number field of at least `min`, or BAD_REQUEST. */
export function count(request, name, min = 0) {
  const value = request[name]
  if (!Number.isSafeInteger(value) || value < min) throw new HelperError('BAD_REQUEST')
  return value
}

/** The request as an object, or BAD_REQUEST. */
export function parseRequest(bytes) {
  if (bytes.length > MAX_REQUEST_BYTES) throw new HelperError('TOO_LARGE')
  let request
  try {
    request = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new HelperError('BAD_REQUEST')
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new HelperError('BAD_REQUEST')
  return request
}

/** Reads the whole of stdin, stopping at the request limit. */
export async function readStdin(stream = process.stdin) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new HelperError('TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** The answer of a failure: its code alone, and the fields the caller adds that carry no text (a position). */
export function failure(err, extra = {}) {
  return { ok: false, code: codeOf(err), ...extra }
}
