// The usage probe of probe_licence_usage: `claude -p /usage --no-session-persistence` run for one config directory,
// and the two figures read from its plain text. Of the text only the 5-hour session window and the 7-day all-models
// window are kept (each a floored percent and the reset as the CLI words it); every other line is discarded, and the
// text itself is never returned, logged or written to disk: it lives in this process's memory until the answer is
// printed. A failure is one fixed code: NO_CLAUDE, TIMEOUT, NOT_LOGGED_IN, PARSE or FAILED.
//
// The parser has a twin in hooks/usage.ts (the native fallback's); helper.test.mjs runs both over the recorded
// outputs of tests/usage-fixtures.ts and requires the same answer from each.

import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, parse } from 'node:path'

import { HelperError, path } from './protocol.mjs'

/** How long one probe may run before claude is killed (SIGKILL) and the answer is TIMEOUT. */
export const USAGE_TIMEOUT_MS = 15_000

/** The most bytes of stdout and of stderr kept: the two figures are at the top of the text. */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** The most characters of the text read, the most lines, and the most characters of a line. */
const MAX_PARSE_CHARS = 256 * 1024
const MAX_LINES = 2000
const MAX_LINE_CHARS = 500

/** The longest reset text kept. */
const MAX_RESETS_CHARS = 64

/** The test-only shortening of the timeout: counts only together with SC_HELPER_TEST=1, as the probe's fake /proc root. */
function timeoutMs() {
  const asked = process.env.SC_HELPER_TEST === '1' ? Number(process.env.SC_HELPER_USAGE_TIMEOUT_MS) : NaN
  return Number.isSafeInteger(asked) && asked > 0 && asked < USAGE_TIMEOUT_MS ? asked : USAGE_TIMEOUT_MS
}

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** The lines of a text as the parser reads them: no escapes or control characters, bounded in count and width. */
function linesOf(text) {
  return text
    .slice(0, MAX_PARSE_CHARS)
    .replace(ANSI, '')
    .replace(/\r/g, '')
    .replace(CONTROL, ' ')
    .split('\n')
    .slice(0, MAX_LINES)
    .map(line => line.slice(0, MAX_LINE_CHARS))
}

/** A window's label at the start of a line (after blanks, bullets or a bar), and which window it is. */
const LABEL = /^[\s>*|•·-]*current\s+(session|week|month)\b(.*)$/i
const ALL_MODELS = /^\s*\(\s*all\s+models\s*\)/i

function labelOf(line) {
  const found = LABEL.exec(line)
  if (found === null) return undefined
  if (found[1].toLowerCase() === 'session') return 'five'
  return found[1].toLowerCase() === 'week' && ALL_MODELS.test(found[2]) ? 'seven' : 'other'
}

const PERCENT = /(<\s*)?(\d{1,4}(?:[.,]\d+)?)\s*%\s*used\b/i
const RESETS = /\bresets?\b[\s:]*(.*)$/i

/**
 * A reset as the CLI words it, in plain characters (letters, digits, blanks and `:,./()+_-`), cut to MAX_RESETS_CHARS;
 * a word with an `@` in it (an address) is dropped first.
 */
function resetsText(raw) {
  return raw
    .replace(/\S*@\S*/g, ' ')
    .replace(/[^A-Za-z0-9 :,./()+_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RESETS_CHARS)
    .trim()
}

/**
 * One window from its label line and the lines after it: the label line alone when it holds the percent (the one-line
 * form `Current session: 12% used · resets Oct 11, 11:20am (Europe/Budapest)`), else up to three more lines before the
 * next label (a form with the bar and the reset on lines of their own). The percent is floored (`<1%` is 0); a window
 * whose percent is not found is null.
 */
function windowAt(lines, at) {
  const block = [lines[at]]
  if (!PERCENT.test(lines[at])) {
    for (let next = at + 1; next < lines.length && next <= at + 3 && labelOf(lines[next]) === undefined; next++) block.push(lines[next])
  }
  let percent
  let resets = ''
  for (const line of block) {
    const found = percent === undefined ? PERCENT.exec(line) : null
    if (found !== null) {
      const value = Number(found[2].replace(',', '.'))
      percent = Math.max(0, Math.floor(value) - (found[1] === undefined ? 0 : 1))
    }
    const reset = resets === '' ? RESETS.exec(line) : null
    if (reset !== null) resets = resetsText(reset[1])
  }
  return percent === undefined || !Number.isFinite(percent) ? null : { percent, resets }
}

/** A login prompt, an expired or refused credential: the CLI asks for /login. */
const LOGIN = /not logged in|please (?:run )?\/login|run \/login|\/login to|invalid api key|oauth token (?:has )?expired|authentication[_ ]error|please log ?in|login required/i

/** The cost summary the CLI prints for /usage where no subscription is logged in. */
const COST_SUMMARY = /^\s*total cost:/im

/** An error the CLI printed instead of the usage. */
const ERROR = /\b(error|failed|unable|could not)\b/i

/**
 * The two windows of a /usage text: `{ ok: true, five, seven }`, each `{ percent, resets }` or null when its line is
 * missing; or `{ ok: false, code }`: NOT_LOGGED_IN (a login prompt in stdout or stderr, or the cost summary of a config
 * directory with no subscription login), FAILED (a non-zero exit, or an error text, with no window), PARSE (anything
 * else: empty output among it). Nothing of the text is in the answer but the two windows.
 */
export function parseUsage(stdout, stderr = '', exitCode = 0) {
  const lines = linesOf(String(stdout))
  const found = { five: null, seven: null }
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

/** The claude executable as spawn looks for it on the PATH, with no shell: claude.exe on Windows. */
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude'

/**
 * `{configDir, isInherited?}`: the usage of that config directory, `{five, seven}`. CLAUDE_CONFIG_DIR is set to the
 * directory, or left out when `isInherited` (the machine's default directory, as a launch without a picker leaves it
 * out). No shell; stdin closed; the cwd the root of the temporary directory's drive (`/` on Linux), so no project's
 * files are read; stdout and stderr kept in memory only. Throws a fixed code (BAD_REQUEST, NO_CLAUDE, TIMEOUT,
 * NOT_LOGGED_IN, PARSE, FAILED).
 */
export function probeUsage(request) {
  const configDir = path(request, 'configDir')
  if (!isAbsolute(configDir)) throw new HelperError('BAD_REQUEST')
  const env = { ...process.env }
  if (request.isInherited === true) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = configDir
  const ran = spawnSync(CLAUDE, ['-p', '/usage', '--no-session-persistence'], {
    cwd: parse(tmpdir()).root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs(),
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
  })
  const code = ran.error?.code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC') throw new HelperError('NO_CLAUDE')
  if (code === 'ETIMEDOUT') throw new HelperError('TIMEOUT')
  // ENOBUFS: the output passed its cap and claude was stopped; what was read is parsed (the figures come first).
  if (ran.error !== undefined && code !== 'ENOBUFS') throw new HelperError('FAILED')
  const parsed = parseUsage(ran.stdout?.toString('utf8') ?? '', ran.stderr?.toString('utf8') ?? '', code === 'ENOBUFS' ? 0 : (ran.status ?? 1))
  if (!parsed.ok) throw new HelperError(parsed.code)
  return { five: parsed.five, seven: parsed.seven }
}
