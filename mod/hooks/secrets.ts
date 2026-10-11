// The secret scan (decision win-22): the likely secrets a worker's result, a transcript tail or a prompt holds, by
// kind. The redaction of the tools (redact in trace.ts) already replaces most token shapes; the scan names what it
// found, so an answer can say `secret scan: N likely secrets redacted (kinds: ...)` and the mod can raise one
// secret-in-result notice per entry, and it masks each value it finds before that redaction runs, so a value it finds
// is never shown even where redact would keep it. It reports kinds and counts only, never a value; a prompt's
// refusal names the kind and the line. Pure: no `$`, no I/O.

import { REDACTED } from './trace'

export type SecretKind =
  | 'private-key'
  | 'github-token'
  | 'sk-key'
  | 'slack-token'
  | 'aws-key'
  | 'bearer-token'
  | 'secret-assignment'
  | 'url-credentials'
  | 'keyed-blob'

/** One likely secret: its kind, where the value starts and ends in the text (what a mask replaces), and its line (1-based). */
export type SecretFind = { kind: SecretKind; start: number; end: number; line: number }

/** A session id as the engine makes it, and a session name as a launch generates it: never a secret. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const GENERATED_NAME = /^w-[a-z0-9-]*-\d{12}(-\d+)?$/

/** A value that stands for a secret rather than being one: a variable, a placeholder, a mask, the redaction's own mark. */
const PLACEHOLDER = /^(?:\$|%|<|\[|\{|\*{3}|x{4}|X{4}|\.\.\.|…)|^(?:redacted|changeme|example|placeholder|none|null|nil|undefined|true|false|required|optional|unset|empty|secret|password|token)$/i

/** Words before a blob that make it a likely secret. */
const KEY_WORD = String.raw`(?:password|passwd|passphrase|token|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?key)`

/** A plain path: every part of every segment is letters only, digits only or shorter than 16 characters (trace.ts's rule). */
const isPlainPath = (text: string) =>
  text
    .split(/[\\/]/)
    .flatMap(segment => segment.split(/[-_.+=~]/))
    .every(word => word.length < 16 || /^[A-Za-z]+$/.test(word) || /^[0-9]+$/.test(word))

/** A value that is no secret by its shape: a UUID, a generated session name, a plain path. */
const isExempt = (value: string) => UUID.test(value) || GENERATED_NAME.test(value) || (/[\\/]/.test(value) && isPlainPath(value))

type Rule = { kind: SecretKind; pattern: RegExp; group?: number; accept?: (value: string, match: RegExpExecArray) => boolean }

/**
 * A name that says it holds a secret: its last part (split at `_`, `-`, `.` and a lower-to-upper case change) is
 * password, passwd, passphrase, token, secret, credential(s) or apikey, or key after api, access, private, secret,
 * signing or auth (`DB_PASSWORD`, `nadir_access_token`, `ANTHROPIC_API_KEY`, `clientSecret`); not `max_tokens`,
 * `tokenState` or `AuthKeywords.robot`.
 */
function isSecretName(name: string): boolean {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(one => one !== '')
    .map(one => one.toLowerCase())
  const last = parts[parts.length - 1] ?? ''
  const before = parts[parts.length - 2] ?? ''
  return /^(?:password|passwd|passphrase|token|secret|credentials?|apikey)$/.test(last) || (last === 'key' && /^(?:api|access|private|secret|signing|auth)$/.test(before))
}

/** A value of an assignment that is likely a real secret: no placeholder, at least 6 characters, and a digit or 12 characters or more. */
const isSecretValue = (value: string) => !PLACEHOLDER.test(value) && !isExempt(value) && value.length >= 6 && (/\d/.test(value) || value.length >= 12)

/** A blob after a key word: hex of 32 or more, or base64 of 24 or more with a letter and a digit. */
const isBlob = (value: string) => !isExempt(value) && (/^[0-9a-fA-F]{32,}$/.test(value) || (value.length >= 24 && /[A-Za-z]/.test(value) && /\d/.test(value)))

/**
 * The rules, in order; a find that overlaps an earlier one is dropped. Each masks the value only (the group), so a name
 * (`password=`), a scheme (`https://`) or the word Bearer stays readable.
 */
const RULES: readonly Rule[] = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$(?![\s\S]))/g },
  { kind: 'github-token', pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: 'sk-key', pattern: /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, accept: value => /\d/.test(value) && /[A-Za-z]/.test(value.slice(3)) },
  { kind: 'slack-token', pattern: /(?<![A-Za-z0-9_])xox[abeprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-key', pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { kind: 'bearer-token', pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g, group: 1, accept: value => !isExempt(value) },
  { kind: 'url-credentials', pattern: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/@:'"]+:[^\s/@'"]+)@/g, group: 1, accept: value => !PLACEHOLDER.test(value.slice(value.indexOf(':') + 1)) },
  // `password=...`, `api_key: ...`, `"token": "..."`, the value on the same line.
  {
    kind: 'secret-assignment',
    pattern: /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{3,64})["']?[ \t]*[=:][ \t]*["']?([^\s"'&;,<>()[\]{}]+)/g,
    group: 2,
    accept: (value, match) => isSecretName(match[1] ?? '') && isSecretValue(value),
  },
  // `--password ...`, `-token ...`.
  {
    kind: 'secret-assignment',
    pattern: /(?<![A-Za-z0-9_.-])--?([A-Za-z0-9_.-]{3,64})[ \t]+["']?([^\s"'&;,<>()[\]{}-][^\s"'&;,<>()[\]{}]*)/g,
    group: 2,
    accept: (value, match) => isSecretName(match[1] ?? '') && isSecretValue(value),
  },
  {
    kind: 'keyed-blob',
    pattern: new RegExp(String.raw`(?:\b(?:key|${KEY_WORD}|auth|bearer|signature)s?\b)[^\n]{0,24}?(?<![A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{24,}={0,2})(?![A-Za-z0-9+/=_-])`, 'gi'),
    group: 1,
    accept: value => isBlob(value),
  },
]

/** The line (1-based) of a position in a text. */
function lineAt(text: string, at: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line++
  return line
}

/** The likely secrets of a text, by position, none overlapping. */
export function findSecrets(text: string): SecretFind[] {
  const found: SecretFind[] = []
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    for (let match = rule.pattern.exec(text); match !== null; match = rule.pattern.exec(text)) {
      if (match[0] === '') {
        rule.pattern.lastIndex++
        continue
      }
      const value = rule.group === undefined ? match[0] : (match[rule.group] ?? '')
      if (value === '' || (rule.accept !== undefined && !rule.accept(value, match))) {
        // A candidate turned down must not hide one that starts inside it (`shows: token: ...`).
        rule.pattern.lastIndex = match.index + 1
        continue
      }
      const start = rule.group === undefined ? match.index : match.index + match[0].lastIndexOf(value)
      const end = start + value.length
      if (found.some(one => start < one.end && end > one.start)) continue
      found.push({ kind: rule.kind, start, end, line: 0 })
    }
  }
  return found.sort((a, b) => a.start - b.start).map(one => ({ ...one, line: lineAt(text, one.start) }))
}

/** The text with each likely secret's value replaced by the redaction's mark, and what was found. */
export function maskSecrets(text: string): { text: string; finds: SecretFind[] } {
  const finds = findSecrets(text)
  if (finds.length === 0) return { text, finds }
  let out = ''
  let from = 0
  for (const one of finds) {
    out += text.slice(from, one.start) + REDACTED
    from = one.end
  }
  return { text: out + text.slice(from), finds }
}

/** A scan's count and kinds (each kind once, in the order of RULES). */
export type SecretTally = { count: number; kinds: SecretKind[] }

export function tallyOf(finds: readonly { kind: SecretKind }[]): SecretTally {
  const order = RULES.map(rule => rule.kind)
  const kinds = [...new Set(finds.map(one => one.kind))].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return { count: finds.length, kinds }
}

/** Two tallies together. */
export function addTallies(a: SecretTally, b: SecretTally): SecretTally {
  const order = RULES.map(rule => rule.kind)
  return { count: a.count + b.count, kinds: [...new Set([...a.kinds, ...b.kinds])].sort((x, y) => order.indexOf(x) - order.indexOf(y)) }
}

/** The trailing line an answer carries when it found any: kinds only, never a value, never a position. */
export function secretScanLine(tally: SecretTally): string {
  return `secret scan: ${tally.count} likely ${tally.count === 1 ? 'secret' : 'secrets'} redacted (kinds: ${tally.kinds.join(', ')})`
}

/** The tally an answer's trailing secret-scan line states; undefined when it has none. */
export function tallyFromAnswer(answer: string): SecretTally | undefined {
  const match = /\nsecret scan: (\d+) likely secrets? redacted \(kinds: ([a-z, -]+)\)$/.exec(answer)
  if (match === null) return undefined
  return { count: Number(match[1]), kinds: (match[2] ?? '').split(', ').filter(one => one !== '') as SecretKind[] }
}
