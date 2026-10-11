// The usage probe's text, read: the twin of helper/usage.mjs's parser for the native fallback (host-shared.ts,
// nativeUsageProbe), which runs `claude -p /usage --no-session-persistence` through `$.process.run` when the Node helper
// is off or fails. Of the text only the 5-hour session window and the 7-day all-models window are kept (a floored percent
// and the reset as the CLI words it); every other line is discarded and the text is never returned, traced or written.
// helper.test.mjs runs both parsers over tests/usage-fixtures.ts and requires the same answer from each. No import:
// node loads this file as it is for that test.

/** One window: the percent used, floored, and the reset as the CLI words it (plain characters only, '' when not said). */
export type UsageWindow = { percent: number; resets: string }

/** The fixed codes of a probe that gave no window. */
export const USAGE_CODES = ['NO_CLAUDE', 'TIMEOUT', 'NOT_LOGGED_IN', 'PARSE', 'FAILED'] as const
export type UsageCode = (typeof USAGE_CODES)[number]

/** What one probe came to: the two windows (null when the line is missing), or a fixed code. */
export type UsageProbe = { ok: true; five: UsageWindow | null; seven: UsageWindow | null } | { ok: false; code: UsageCode }

/** How long one probe may run before claude is killed and the answer is TIMEOUT (the helper's USAGE_TIMEOUT_MS). */
export const USAGE_TIMEOUT_MS = 15_000

/** The probe's arguments after the executable: the /usage command, no transcript written into the licence. */
export const USAGE_ARGS = ['-p', '/usage', '--no-session-persistence'] as const

const MAX_PARSE_CHARS = 256 * 1024
const MAX_LINES = 2000
const MAX_LINE_CHARS = 500
const MAX_RESETS_CHARS = 64

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** The lines of a text as the parser reads them: no escapes or control characters, bounded in count and width. */
function linesOf(text: string): string[] {
  return text
    .slice(0, MAX_PARSE_CHARS)
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .replace(CONTROL, ' ')
    .split('\n')
    .slice(0, MAX_LINES)
    .map(line => line.slice(0, MAX_LINE_CHARS))
}

const LABEL = /^[\s>*|•·-]*current\s+(session|week|month)\b(.*)$/i
const ALL_MODELS = /^\s*\(\s*all\s+models\s*\)/i

/** A window's label at the start of a line, and which window it is (`other`: a model's own week, a month). */
function labelOf(line: string): 'five' | 'seven' | 'other' | undefined {
  const found = LABEL.exec(line)
  if (found === null) return undefined
  const word = (found[1] ?? '').toLowerCase()
  if (word === 'session') return 'five'
  return word === 'week' && ALL_MODELS.test(found[2] ?? '') ? 'seven' : 'other'
}

const PERCENT = /(<\s*)?(\d{1,4}(?:[.,]\d+)?)\s*%\s*used\b/i
const RESETS = /\bresets?\b[\s:]*(.*)$/i

/** A reset in plain characters, an `@` word (an address) dropped first, cut to MAX_RESETS_CHARS. */
function resetsText(raw: string): string {
  return raw
    .replace(/\S*@\S*/g, ' ')
    .replace(/[^A-Za-z0-9 :,./()+_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RESETS_CHARS)
    .trim()
}

/** One window from its label line, and up to three lines after it when the label line holds no percent. */
function windowAt(lines: readonly string[], at: number): UsageWindow | null {
  const first = lines[at] ?? ''
  const block = [first]
  if (!PERCENT.test(first)) {
    for (let next = at + 1; next < lines.length && next <= at + 3 && labelOf(lines[next] ?? '') === undefined; next++) block.push(lines[next] ?? '')
  }
  let percent: number | undefined
  let resets = ''
  for (const line of block) {
    const found = percent === undefined ? PERCENT.exec(line) : null
    if (found !== null) {
      const value = Number((found[2] ?? '').replace(',', '.'))
      percent = Math.max(0, Math.floor(value) - (found[1] === undefined ? 0 : 1))
    }
    const reset = resets === '' ? RESETS.exec(line) : null
    if (reset !== null) resets = resetsText(reset[1] ?? '')
  }
  return percent === undefined || !Number.isFinite(percent) ? null : { percent, resets }
}

const LOGIN = /not logged in|please (?:run )?\/login|run \/login|\/login to|invalid api key|oauth token (?:has )?expired|authentication[_ ]error|please log ?in|login required/i
const COST_SUMMARY = /^\s*total cost:/im
const ERROR = /\b(error|failed|unable|could not)\b/i

/**
 * The two windows of a /usage text, or a fixed code: NOT_LOGGED_IN (a login prompt in stdout or stderr, or the cost
 * summary of a config directory with no subscription login), FAILED (a non-zero exit or an error text, with no window),
 * PARSE (anything else, empty output among it).
 */
export function parseUsage(stdout: string, stderr = '', exitCode = 0): UsageProbe {
  const lines = linesOf(String(stdout))
  const found: { five: UsageWindow | null; seven: UsageWindow | null } = { five: null, seven: null }
  for (const [at, line] of lines.entries()) {
    const label = labelOf(line)
    if ((label === 'five' || label === 'seven') && found[label] === null) found[label] = windowAt(lines, at)
  }
  if (found.five !== null || found.seven !== null) return { ok: true, five: found.five, seven: found.seven }
  const text = lines.join('\n')
  const errText = linesOf(String(stderr)).join('\n')
  if (LOGIN.test(text) || LOGIN.test(errText) || COST_SUMMARY.test(text)) return { ok: false, code: 'NOT_LOGGED_IN' }
  if (exitCode !== 0 || ERROR.test(text)) return { ok: false, code: 'FAILED' }
  return { ok: false, code: 'PARSE' }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** One window of a helper answer: `{percent, resets}` with a whole percent and a plain reset, null, or undefined when malformed. */
function windowAnswer(value: unknown): UsageWindow | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !Number.isSafeInteger(value.percent) || (value.percent as number) < 0 || typeof value.resets !== 'string') return undefined
  if (value.resets.length > MAX_RESETS_CHARS || /[^A-Za-z0-9 :,./()+_-]/.test(value.resets)) return undefined
  return { percent: value.percent as number, resets: value.resets }
}

/** The helper's probeUsage answer fields as a UsageProbe; undefined when they are not the answer expected. */
export function usageAnswer(fields: Record<string, unknown>): UsageProbe | undefined {
  const five = windowAnswer(fields.five)
  const seven = windowAnswer(fields.seven)
  if (five === undefined || seven === undefined || (five === null && seven === null)) return undefined
  return { ok: true, five, seven }
}

/** Whether a helper code is one of the probe's own answers (no fallback then). */
export const isUsageCode = (code: string): code is UsageCode => (USAGE_CODES as readonly string[]).includes(code)
