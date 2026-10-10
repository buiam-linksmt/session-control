// Pure parts of the debug trace: the line format, the redaction, what of a message and of a command line is shown and
// the rotation. The writing itself lives in register.tsx, where `$` is available.

import { APPEND_SCRIPT, NEWER_SCRIPT, PROBE_SCRIPT, ROTATE_SCRIPT } from './host-posix'
import { FILES_PS1, NEWER_PS1, PROBE_PS1 } from './host-windows'

/** The trace file's name inside the runs directory. */
export const TRACE_FILE = 'trace.log'

/** The trace is rotated before an append would take it past about this size (several processes share it, see ROTATE_SCRIPT in host-posix.ts). */
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
  /\b(?:AKIA|ASIA)[A-Za-z0-9]{16}/g,
  /\b[0-9a-fA-F]{32,}\b/g,
]

/** The words that make a name secret, in any case; underscores and hyphens separate words, so API_KEY counts. */
const SECRET_WORD = '(?:key|token|secret|passwd|password|auth|credential)'
const NAME_CHAR = '[A-Za-z0-9_.-]'

/** `Authorization: Basic|Bearer|Token <anything>`: the scheme and what follows go, the header name stays. */
const AUTHORIZATION = /\b(Authorization["']?\s*[:=]\s*["']?)(?:Basic|Bearer|Token)\s+\S+/gi

/** A `NAME=value` or `NAME: value` whose name says secret: the value goes, the name stays. */
const SECRET_ASSIGNMENT = new RegExp(`(?<!${NAME_CHAR})(${NAME_CHAR}*${SECRET_WORD}${NAME_CHAR}*["']?\\s*[=:]\\s*["']?)[^\\s&;,'"]+`, 'gi')

/** A `--flag value` whose flag says secret, in one string: the value goes, the flag stays. */
const SECRET_FLAG = new RegExp(`(?<!${NAME_CHAR})(--?${NAME_CHAR}*${SECRET_WORD}${NAME_CHAR}*\\s+)[^\\s'"]+`, 'gi')

/** A flag that says secret as one argument of an argv: the next argument is its value. */
const SECRET_FLAG_ARG = new RegExp(`^--?${NAME_CHAR}*${SECRET_WORD}${NAME_CHAR}*$`, 'i')

/** URL userinfo, `scheme://user:pass@host`: the userinfo goes. */
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@'"]+@/g

/**
 * An absolute path (`/...`, `~/...`, `C:/...`, `C:\...`) or a run of 32 or more letters, digits, - _ / + = (a run
 * with a letter and a digit in it is a token). A path is matched first so it can be kept whole.
 */
const PATH_OR_RUN = /(?<![A-Za-z0-9_./~+=-])(?:[A-Za-z]:[\\/]|~\/|\/)[^\s"'|<>()[\]{},;:*?]*|[A-Za-z0-9_/+=-]{32,}/g
const RUN = /[A-Za-z0-9_/+=-]{32,}/g
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A run that is a token: it has a letter and a digit, and it is no UUID (a session id stays). */
const isTokenRun = (run: string) => /[A-Za-z]/.test(run) && /[0-9]/.test(run) && !UUID.test(run)

/**
 * A plain path: every word of every segment (split at - _ . + = and spaces) is letters only, digits only or shorter
 * than 16 characters. A long word mixing letters and digits is a token, wherever it sits.
 */
const isPlainPath = (path: string) =>
  path
    .split(/[\\/]/)
    .flatMap(segment => segment.split(/[-_.+=~]/))
    .every(word => word.length < 16 || /^[A-Za-z]+$/.test(word) || /^[0-9]+$/.test(word))

/** A string with everything that looks like a credential replaced by [redacted]; UUIDs and plain absolute paths stay. */
export function redact(text: string): string {
  let out = text
    .replace(AUTHORIZATION, (_, name: string) => `${name}${REDACTED}`)
    .replace(URL_USERINFO, (_, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(SECRET_ASSIGNMENT, (_, name: string) => `${name}${REDACTED}`)
    .replace(SECRET_FLAG, (_, flag: string) => `${flag}${REDACTED}`)
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED)
  return out.replace(PATH_OR_RUN, found => {
    if (!/^(?:[A-Za-z]:[\\/]|~\/|\/)/.test(found)) return isTokenRun(found) ? REDACTED : found
    return isPlainPath(found) ? found : found.replace(RUN, run => (isTokenRun(run) ? REDACTED : run))
  })
}

/** A value with every string in it redacted and cut to TRACE_MAX_STRING characters; keys stay. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const clean = redact(value)
    return clean.length <= TRACE_MAX_STRING ? clean : `${clean.slice(0, TRACE_MAX_STRING)}...[+${clean.length - TRACE_MAX_STRING} chars]`
  }
  // In an argv a flag that says secret takes the next argument as its value.
  if (Array.isArray(value)) return value.map((part, at) => (at > 0 && typeof value[at - 1] === 'string' && SECRET_FLAG_ARG.test(value[at - 1]) ? REDACTED : redactValue(part)))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, part]) => [key, redactValue(part)]))
  }
  return value
}

/** The most an error, refusal or answer text in the trace keeps. */
export const TRACE_MAX_MESSAGE = 120

/** Where a message goes on with text it was handed (a command's output, the picker's answer): all of that goes. */
const ECHO_TAIL = /((?:\(exit -?\d+\)|no licence has room|answered an unexpected value)\s*:)[\s\S]*$/
/** A quoted fragment: double, back or typographic quotes, or single quotes that are no apostrophe. */
const QUOTED = /"[^"]*"|`[^`]*`|“[^”]*”|(?<![A-Za-z])'[^']*'(?![A-Za-z])/g

/** The kind of a message the trace can tell: a JSON parse, the picker's exit or answer, a command's exit. */
export function messageKind(text: string): string | undefined {
  if (/no licence has room/.test(text)) return 'picker-exit-3'
  const picker = /licence picker gave nothing usable \(exit (-?\d+)\)/.exec(text)
  if (picker !== null) return `picker-exit-${picker[1]}`
  if (/licence picker answered an unexpected value/.test(text)) return 'picker-value'
  if (/not JSON|does not parse|JSON Parse error|not valid JSON|SyntaxError/i.test(text)) return 'json-parse'
  const exit = /\(exit (-?\d+)\)/.exec(text)
  return exit === null ? undefined : `exit-${exit[1]}`
}

/**
 * A message as the trace keeps it: what a command or the picker printed and every quoted fragment become …, so no
 * file content, output or command text a message quotes reaches the trace; cut at `max` characters.
 */
export function traceMessage(text: string, max = TRACE_MAX_MESSAGE): string {
  return text.replace(ECHO_TAIL, '$1 …').replace(QUOTED, '…').slice(0, max)
}

/** An error or refusal as trace fields: its kind when one is known, and the message as traceMessage keeps it. */
export function messageFields(text: string, name = 'message'): Record<string, string> {
  const kind = messageKind(text)
  return { ...(kind === undefined ? {} : { kind }), [name]: traceMessage(text) }
}

/** The licence picker as the trace shows it: its executable's name and how many arguments it got, never its text. */
export function shownPicker(argv: readonly string[]): { picker: string; args: number } {
  return { picker: (argv[0] ?? '').split(/[\\/]/).pop() ?? '', args: Math.max(0, argv.length - 1) }
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
  [NEWER_SCRIPT, '<NEWER_SCRIPT>'],
  [FILES_PS1, '<FILES_PS1>'],
  [PROBE_PS1, '<PROBE_PS1>'],
  [NEWER_PS1, '<NEWER_PS1>'],
]

/** A command line as the trace shows it: the mod's scripts by name, the text an append adds as its byte count. */
export function shownArgv(argv: readonly string[]): string[] {
  const isAppend = argv[0] === 'sh' && argv[2] === APPEND_SCRIPT
  return argv.map((arg, at) => {
    if (isAppend && at === 4) return `<${utf8Bytes(arg) + 1} bytes>`
    return SCRIPTS.find(([text]) => text === arg)?.[1] ?? arg
  })
}
