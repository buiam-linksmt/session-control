// Pure parts of the debug trace: the line format, the redaction, the rotation arithmetic and what of a command line
// is shown. The writing itself lives in register.tsx, where `$` is available.

import { APPEND_SCRIPT, FILES_PS1, PROBE_PS1, PROBE_SCRIPT } from './core'

/** The trace file's name inside the runs directory. */
export const TRACE_FILE = 'trace.log'

/** The trace is rotated before an append would take it past this size. */
export const TRACE_MAX_BYTES = 2 * 1024 * 1024

/** Files kept in all: trace.log, trace.log.1 and trace.log.2. */
export const TRACE_KEEP = 3

/** The most one append carries on its command line (Linux caps one argument at 128 KiB). */
export const TRACE_CHUNK_BYTES = 64 * 1024

/** A logged string longer than this is cut. */
export const TRACE_MAX_STRING = 1000

/** What stands in for anything that looks like a credential. */
export const REDACTED = '[redacted]'

/** Whether the value of SESSION_CONTROL_DEBUG switches the trace on. */
export function isTraceSwitch(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim())
}

/** Local time as ISO 8601 with milliseconds and the offset, e.g. 2026-10-10T12:34:56.789+02:00. */
export function localIso(ms: number): string {
  const at = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  const offset = -at.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const zone = `${sign}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`
  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:` +
    `${two(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}${zone}`
  )
}

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[0-9a-fA-F]{32,}\b/g,
]

/** A `name=value` whose name says secret: the value goes, the name stays. */
const SECRET_ASSIGNMENT = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)\s*[=:]\s*)[^\s&;,'"]+/gi

/**
 * A long run of base64 characters with lower case, upper case and digits in one piece of 24 or more between
 * slashes: a path's segments are short, a token's are not. A session id (lower-case hex and hyphens) stays.
 */
const BASE64_RUN = /[A-Za-z0-9+/_=-]{32,}/g
const isBase64Token = (run: string) =>
  run.split('/').some(piece => piece.length >= 24 && /[a-z]/.test(piece) && /[A-Z]/.test(piece) && /[0-9]/.test(piece))

/** A string with everything that looks like a token replaced by [redacted]. */
export function redact(text: string): string {
  let out = text.replace(SECRET_ASSIGNMENT, (_, name: string) => `${name}${REDACTED}`)
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED)
  return out.replace(BASE64_RUN, run => (isBase64Token(run) ? REDACTED : run))
}

/** A value with every string in it redacted and cut to TRACE_MAX_STRING characters; keys stay. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const clean = redact(value)
    return clean.length <= TRACE_MAX_STRING ? clean : `${clean.slice(0, TRACE_MAX_STRING)}...[+${clean.length - TRACE_MAX_STRING} chars]`
  }
  if (Array.isArray(value)) return value.map(redactValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, part]) => [key, redactValue(part)]))
  }
  return value
}

/** One trace line (no newline): the time, the sequence number, the event, then the fields, redacted. */
export function traceLine(seq: number, ms: number, event: string, fields: Record<string, unknown> = {}): string {
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'ts' && key !== 'seq' && key !== 'event'))
  return JSON.stringify({ ts: localIso(ms), seq, event, ...(redactValue(rest) as Record<string, unknown>) })
}

/** UTF-8 length of a text in bytes. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** Whether a file of `size` bytes is rotated before `adding` more go in; an empty file never is. */
export function needsRotation(size: number, adding: number, max = TRACE_MAX_BYTES): boolean {
  return size > 0 && size + adding > max
}

/** The renames of one rotation, oldest first: trace.log.1 to trace.log.2, then trace.log to trace.log.1. */
export function rotationMoves(path: string, keep = TRACE_KEEP): [string, string][] {
  const moves: [string, string][] = []
  for (let at = keep - 1; at >= 1; at--) moves.push([at === 1 ? path : `${path}.${at - 1}`, `${path}.${at}`])
  return moves
}

/**
 * The rotation on Linux, one process: args are the trace path and the number of the oldest file kept. Each older
 * file moves one up (the oldest is overwritten), then the trace becomes .1.
 */
export const ROTATE_SCRIPT = String.raw`L=$1; i=$2
while [ "$i" -gt 1 ]; do p=$((i - 1)); if [ -f "$L.$p" ]; then mv -f "$L.$p" "$L.$i" || exit 1; fi; i=$p; done
mv -f "$L" "$L.1"`

/** Lines in batches of at most `maxBytes` (a longer line goes alone). */
export function chunkLines(lines: readonly string[], maxBytes = TRACE_CHUNK_BYTES): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let size = 0
  for (const line of lines) {
    const bytes = utf8Bytes(line) + 1
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(line)
    size += bytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

const SCRIPTS: readonly [string, string][] = [
  [PROBE_SCRIPT, '<PROBE_SCRIPT>'],
  [APPEND_SCRIPT, '<APPEND_SCRIPT>'],
  [ROTATE_SCRIPT, '<ROTATE_SCRIPT>'],
  [FILES_PS1, '<FILES_PS1>'],
  [PROBE_PS1, '<PROBE_PS1>'],
]

/** A command line as the trace shows it: the mod's scripts by name, the text an append adds as its byte count. */
export function shownArgv(argv: readonly string[]): string[] {
  const isAppend = argv[0] === 'sh' && argv[2] === APPEND_SCRIPT
  return argv.map((arg, at) => {
    if (isAppend && at === 4) return `<${utf8Bytes(arg) + 1} bytes>`
    return SCRIPTS.find(([text]) => text === arg)?.[1] ?? arg
  })
}
