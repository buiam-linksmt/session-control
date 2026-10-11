// What the Node ports of the Python self-tests (probe-selftest.mjs, windows-selftest.mjs) share: the few Python
// built-ins they lean on, written out so each port reads the TypeScript sources exactly as its Python twin does.
// Node standard library only.

/** Python's `text.split(sep, 1)[1]`: what follows the first `sep`; a missing `sep` is an error, as Python's IndexError. */
export function after(text, sep) {
  const at = text.indexOf(sep)
  if (at < 0) throw new Error(`not found: ${JSON.stringify(sep)}`)
  return text.slice(at + sep.length)
}

/** Python's `text.split(sep, 1)[0]`: what comes before the first `sep`, or the whole text. */
export function before(text, sep) {
  const at = text.indexOf(sep)
  return at < 0 ? text : text.slice(0, at)
}

/** Python's truth value of a JSON value: null, false, 0, '' and an empty list or object are false. */
export function pyTruthy(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

const SIMPLE = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\n': '' }

/**
 * Python's `ast.literal_eval` of one string literal ('...' or "...", no prefix): the text it stands for, with Python's
 * escapes (\\ \' \" \a \b \f \n \r \t \v, octal \ooo, \xhh, \uXXXX, \UXXXXXXXX, an escaped line end; an unknown
 * escape keeps its backslash). Anything that is not exactly one such literal is an error, as literal_eval's.
 */
export function pyLiteral(source) {
  const quote = source[0]
  if ((quote !== "'" && quote !== '"') || source.length < 2 || source[source.length - 1] !== quote) throw new Error(`not a string literal: ${source}`)
  const body = source.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === quote) throw new Error(`not one string literal: ${source}`)
    if (ch === '\n') throw new Error(`a line end inside a literal: ${source}`)
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = body[i + 1]
    if (next === undefined) throw new Error(`a literal ends in a backslash: ${source}`)
    if (next in SIMPLE) {
      out += SIMPLE[next]
      i++
    } else if (/[0-7]/.test(next)) {
      const digits = /^[0-7]{1,3}/.exec(body.slice(i + 1))[0]
      out += String.fromCodePoint(parseInt(digits, 8))
      i += digits.length
    } else if (next === 'x' || next === 'u' || next === 'U') {
      const width = { x: 2, u: 4, U: 8 }[next]
      const hex = body.slice(i + 2, i + 2 + width)
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) throw new Error(`a bad \\${next} escape: ${source}`)
      out += String.fromCodePoint(parseInt(hex, 16))
      i += 1 + width
    } else if (next === 'N') {
      throw new Error(`a \\N{...} escape is not supported: ${source}`)
    } else {
      out += '\\'
    }
  }
  return out
}

/**
 * Python's `==` over two parsed JSON values: numbers by value (so -0 equals 0, as Python's int and float compare),
 * lists in order, objects by their keys whatever the order.
 */
export function pyEqual(a, b) {
  // Python's True and False are the ints 1 and 0.
  if (typeof a === 'number' || typeof b === 'number') return (typeof a === 'boolean' ? Number(a) : a) === (typeof b === 'boolean' ? Number(b) : b)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === b.length && a.every((one, i) => pyEqual(one, b[i]))
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && pyEqual(a[key], b[key]))
}

// Built from char codes: every UTF-16 unit from DEL up (an astral character is two), and Python's line boundaries.
const PAST_ASCII = new RegExp(`[\\x7f-${String.fromCharCode(0xffff)}]`, 'g')
const LINE_BREAKS = new RegExp(`\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85${String.fromCharCode(0x2028, 0x2029)}]`)

/**
 * Python's `json.dumps(value)`: ", " and ": " between items unless `separators` says otherwise, and with `ensureAscii`
 * (Python's default) every character outside ' '..'~' that JSON does not escape anyway written as \uXXXX (a character
 * past U+FFFF as its two surrogates), as Python writes them.
 */
export function pyJson(value, { ensureAscii = true, separators = [', ', ': '] } = {}) {
  const [item, key] = separators
  const one = v => pyJson(v, { ensureAscii, separators })
  if (Array.isArray(value)) return `[${value.map(one).join(item)}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${one(k)}${key}${one(v)}`).join(item)}}`
  if (typeof value === 'string') {
    const text = JSON.stringify(value)
    return ensureAscii ? text.replace(PAST_ASCII, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) : text
  }
  return JSON.stringify(value)
}

/** Python's `str.splitlines()`: split at every line boundary Python knows, none kept, no empty last item. */
export function pySplitlines(text) {
  const parts = text.split(LINE_BREAKS)
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Python's slice of a string, `text[start:end]`, counted in code points as Python counts (a character past U+FFFF is one). */
export const pySlice = (text, start, end) => Array.from(text).slice(start, end).join('')

/** Python's `int(text)` of a decimal: anything else is an error. */
export function pyInt(text) {
  const trimmed = String(text).trim()
  if (!/^[+-]?\d+$/.test(trimmed)) throw new Error(`invalid literal for int(): ${JSON.stringify(text)}`)
  return Number(trimmed)
}

/** Python's `str.isdigit()` for the ASCII digits these tests read. */
export const isDigits = text => /^[0-9]+$/.test(text)

/** statistics.median of a non-empty list of numbers. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** time.sleep without a process: blocks this thread for the milliseconds given. */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
