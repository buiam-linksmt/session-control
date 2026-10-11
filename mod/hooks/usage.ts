// The usage probe's answer, as probe_licence_usage reads it: the 5-hour session window and the 7-day all-models window
// (a floored percent and the reset as the CLI words it) or one of the fixed codes. The helper's probeUsage
// (helper/usage.mjs) runs `claude -p /usage --no-session-persistence` and reads its text; the text never reaches the
// mod.

/** One window: the percent used, floored, and the reset as the CLI words it (plain characters only, '' when not said). */
export type UsageWindow = { percent: number; resets: string }

/** The fixed codes of a probe that gave no window. */
export const USAGE_CODES = ['NO_CLAUDE', 'TIMEOUT', 'NOT_LOGGED_IN', 'PARSE', 'FAILED'] as const
export type UsageCode = (typeof USAGE_CODES)[number]

/** What one probe came to: the two windows (null when the line is missing), or a fixed code. */
export type UsageProbe = { ok: true; five: UsageWindow | null; seven: UsageWindow | null } | { ok: false; code: UsageCode }

/** How long one probe may run before claude is killed and the answer is TIMEOUT (the helper's USAGE_TIMEOUT_MS). */
export const USAGE_TIMEOUT_MS = 15_000

/** The longest reset text an answer may carry. */
const MAX_RESETS_CHARS = 64

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

/** Whether a helper code is one of the probe's own answers. */
export const isUsageCode = (code: string): code is UsageCode => (USAGE_CODES as readonly string[]).includes(code)
