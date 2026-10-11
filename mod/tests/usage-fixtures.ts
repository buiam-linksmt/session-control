// The text `claude -p /usage --no-session-persistence` prints, as test fixtures of the usage reader of the helper
// (helper/usage.mjs: helper.test.mjs requires it to give each case its answer, and the plugin's tests answer for the
// simulated helper with the answer of the case that holds the text). The recorded ones are real outputs of Claude Code 2.1.296 on Linux,
// byte for byte (non-ASCII characters escaped): a subscription licence in the default config directory, a secondary one
// through CLAUDE_CONFIG_DIR, and a config directory with no login. They hold no account identity (no email, name or
// organisation appears in the text). The others are written by hand for the forms the parser must also read. Data only,
// no import: node runs this file as it is (type stripping) for the helper's tests.

export const USAGE_FIXTURES: Record<string, string> = {
  recordedMain: "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 12% used \u00b7 resets Oct 11, 11:20am (Europe/Budapest)\nCurrent week (all models): 41% used \u00b7 resets Oct 16, 1pm (Europe/Budapest)\nCurrent week (Fable): 0% used \u00b7 resets Oct 16, 1pm (Europe/Budapest)\n\nWhat's contributing to your limits usage?\nApproximate, based on local sessions on this machine \u2014 does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.\n\nLast 24h \u00b7 4811 requests \u00b7 222 sessions\n  81% of your usage was at >150k context\n  22% of your usage was while 4+ sessions ran in parallel\n  18% of your usage came from subagent-heavy sessions\n  18% of your usage came from sessions active for 8+ hours\n  Top skills: /plugin-authoring 4%\n\nLast 7d \u00b7 16008 requests \u00b7 405 sessions\n  81% of your usage was at >150k context\n  37% of your usage came from subagent-heavy sessions\n  34% of your usage came from sessions active for 8+ hours\n  23% of your usage was while 4+ sessions ran in parallel\n  Top skills: /plugin-authoring 1%, /docx 1%\n  Top subagents: general-purpose 5%, workflow-subagent 1%\n  Top MCP servers: playwright-windows 2%\n",
  recordedSecondary: "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 42% used \u00b7 resets Oct 11, 11:30am (Europe/Budapest)\nCurrent week (all models): 5% used \u00b7 resets Oct 18, 6am (Europe/Budapest)\nCurrent week (Fable): 0% used \u00b7 resets Oct 18, 6am (Europe/Budapest)\n\nWhat's contributing to your limits usage?\nApproximate, based on local sessions on this machine \u2014 does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.\n\nLast 24h \u00b7 764 requests \u00b7 58 sessions\n  90% of your usage was at >150k context\n  14% of your usage was while 4+ sessions ran in parallel\n\nLast 7d \u00b7 764 requests \u00b7 58 sessions\n  90% of your usage was at >150k context\n  14% of your usage was while 4+ sessions ran in parallel\n",
  recordedNoLogin: "Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 0s\nTotal code changes:    0 lines added, 0 lines removed\nUsage:                 0 input, 0 output, 0 cache read, 0 cache write\n",
}

/** What the parser answers: the two windows (null when the line is missing), or a fixed code. */
export type UsageExpect = { ok: true; five: { percent: number; resets: string } | null; seven: { percent: number; resets: string } | null } | { ok: false; code: string }

/** One case: the text on stdout (and stderr, and the exit code, when not empty and 0) and the answer it must give. */
export type UsageCase = { name: string; stdout: string; stderr?: string; exitCode?: number; expect: UsageExpect }

const SESSION = 'Current session: 12% used · resets Oct 11, 11:20am (Europe/Budapest)'
const WEEK = 'Current week (all models): 41% used · resets Oct 16, 1pm (Europe/Budapest)'
const MAIN = { ok: true, five: { percent: 12, resets: 'Oct 11, 11:20am (Europe/Budapest)' }, seven: { percent: 41, resets: 'Oct 16, 1pm (Europe/Budapest)' } } as const
const JUNK_LINE = `  ${'filler '.repeat(70)}\n`
/** A fake account identity for the redaction case, built from parts. */
const FAKE_MAIL = ['someone', 'example.invalid'].join('@')
const FAKE_ORG = ['Example', 'Org', 'Ltd'].join(' ')

export const USAGE_CASES: UsageCase[] = [
  { name: 'recorded: subscription licence, default config directory', stdout: USAGE_FIXTURES.recordedMain ?? '', expect: MAIN },
  {
    name: 'recorded: secondary licence through CLAUDE_CONFIG_DIR',
    stdout: USAGE_FIXTURES.recordedSecondary ?? '',
    expect: { ok: true, five: { percent: 42, resets: 'Oct 11, 11:30am (Europe/Budapest)' }, seven: { percent: 5, resets: 'Oct 18, 6am (Europe/Budapest)' } },
  },
  { name: 'recorded: a config directory with no login answers the cost summary', stdout: USAGE_FIXTURES.recordedNoLogin ?? '', expect: { ok: false, code: 'NOT_LOGGED_IN' } },
  {
    name: 'reset as a bare hour with its zone, and as a date with "at"',
    stdout: 'Current session: 30% used · Resets 6pm (Europe/Rome)\nCurrent week (all models): 12% used · Resets Oct 14 at 9am (Europe/Rome)\n',
    expect: { ok: true, five: { percent: 30, resets: '6pm (Europe/Rome)' }, seven: { percent: 12, resets: 'Oct 14 at 9am (Europe/Rome)' } },
  },
  {
    name: 'reset in relative form',
    stdout: 'Current session: 7% used · resets in 2 hr 13 min\nCurrent week (all models): 63% used · resets in 4 days\n',
    expect: { ok: true, five: { percent: 7, resets: 'in 2 hr 13 min' }, seven: { percent: 63, resets: 'in 4 days' } },
  },
  {
    name: 'the panel form: label, bar and reset on lines of their own; another model window after it ignored',
    stdout:
      'Current session\n  ███████▌            37% used\n  Resets 6pm (Europe/Rome)\n\nCurrent week (all models)\n  ██                  9% used\n  Resets Oct 14, 9am (Europe/Rome)\n\nCurrent week (Sonnet only)\n  █                   80% used\n  Resets Oct 14, 9am (Europe/Rome)\n',
    expect: { ok: true, five: { percent: 37, resets: '6pm (Europe/Rome)' }, seven: { percent: 9, resets: 'Oct 14, 9am (Europe/Rome)' } },
  },
  {
    name: 'percent forms: a fraction is floored, below one is 0',
    stdout: 'Current session: 99.9% used · resets 3am (UTC)\nCurrent week (all models): <1% used · resets Oct 20, 3am (UTC)\n',
    expect: { ok: true, five: { percent: 99, resets: '3am (UTC)' }, seven: { percent: 0, resets: 'Oct 20, 3am (UTC)' } },
  },
  {
    // Once read as 100 and 104: a percent over 100 and a comma in the number are now refused, the whole answer PARSE.
    name: 'percent forms: at and over the limit, a decimal comma',
    stdout: 'Current session: 100% used · resets 11:20am (Europe/Budapest)\nCurrent week (all models): 104,5 % used · resets Oct 16, 1pm (Europe/Budapest)\n',
    expect: { ok: false, code: 'PARSE' },
  },
  {
    name: 'percent forms: exactly 100 is kept, 100.0 too; below five is one lower, as below one is 0',
    stdout: 'Current session: 100% used · resets 11:20am (Europe/Budapest)\nCurrent week (all models): 100.0% used\nCurrent session: <5% used\n',
    expect: { ok: true, five: { percent: 100, resets: '11:20am (Europe/Budapest)' }, seven: { percent: 100, resets: '' } },
  },
  {
    name: 'the panel form with an ASCII bar, and with the percent on the second line below the label',
    stdout: 'Current session\n  [=====-----] 50% used\n  Resets 6pm (Europe/Rome)\nCurrent week (all models):\n  ##########\n  9% used\n',
    expect: { ok: true, five: { percent: 50, resets: '6pm (Europe/Rome)' }, seven: { percent: 9, resets: '' } },
  },
  { name: 'refused (PARSE): a percent over 100', stdout: `Current session: 104% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a percent over 100 by a fraction', stdout: `Current session: 100.5% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a negative percent (-5%)', stdout: `Current session: -5% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a negative percent with a minus sign', stdout: `${WEEK}\nCurrent session: \u22125% used\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a comma-separated percent (1,234%)', stdout: `Current session: 1,234% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a decimal comma below 100 (12,5%)', stdout: `Current session: 12,5% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): more than four digits, once cut to 2345 or clamped to 9999', stdout: `${SESSION}\nCurrent week (all models): 12345% used\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): five nines, once clamped to 9999', stdout: `${SESSION}\nCurrent week (all models): 99999% used\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): more than a percent (>99%), spaced or not', stdout: `Current session: >99% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): more than a percent with a blank (> 99%)', stdout: `${SESSION}\nCurrent week (all models): > 99% used\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a number after a dot (.5%)', stdout: `Current session: .5% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a number with two dots (1.2.3%)', stdout: `Current session: 1.2.3% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): the percent only in a following block, after a blank line', stdout: `Current session\n\n  37% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): the weekly percent only in a following block', stdout: `${SESSION}\nCurrent week (all models)\n\n\n  9% used\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a percent under a panel label on a line that is no bar', stdout: `Current session\n  Extra usage: 50% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): a label line with other text, its percent on the next line', stdout: `Current session: resets 6pm\n  37% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): the percent more than three lines below its label', stdout: `Current session\n a\n b\n c\n  37% used\n${WEEK}\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): the weekly percent more than three lines below its label', stdout: `${SESSION}\nCurrent week (all models)\n a\n b\n c\n d\n  9% used\n`, expect: { ok: false, code: 'PARSE' } },
  { name: 'refused (PARSE): an out-of-range percent on a panel bar line', stdout: 'Current session\n  ██████████ 140% used\n', expect: { ok: false, code: 'PARSE' } },
  {
    name: 'the weekly line missing: the session window alone',
    stdout: `You are currently using your subscription to power your Claude Code usage\n\n${SESSION}\n\nLast 24h · 760 requests\n  90% of your usage was at >150k context\n`,
    expect: { ok: true, five: MAIN.five, seven: null },
  },
  { name: 'the session line missing: the weekly window alone', stdout: `${WEEK}\nCurrent week (Fable): 0% used\n`, expect: { ok: true, five: null, seven: MAIN.seven } },
  { name: 'a window with no reset text', stdout: 'Current session: 3% used\nCurrent week (all models): 4% used\n', expect: { ok: true, five: { percent: 3, resets: '' }, seven: { percent: 4, resets: '' } } },
  { name: 'a login prompt', stdout: 'Not logged in · Please run /login\n', exitCode: 1, expect: { ok: false, code: 'NOT_LOGGED_IN' } },
  { name: 'an expired credential', stdout: 'OAuth token has expired. Please obtain a new token or run /login to refresh your existing token.\n', expect: { ok: false, code: 'NOT_LOGGED_IN' } },
  { name: 'a refused key on stderr only', stdout: '', stderr: 'Invalid API key · Please run /login\n', exitCode: 1, expect: { ok: false, code: 'NOT_LOGGED_IN' } },
  { name: 'an error text with a non-zero exit', stdout: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n', exitCode: 1, expect: { ok: false, code: 'FAILED' } },
  { name: 'an error text with exit 0', stdout: 'Error: failed to fetch usage data\n', expect: { ok: false, code: 'FAILED' } },
  { name: 'empty output, exit 0', stdout: '', expect: { ok: false, code: 'PARSE' } },
  { name: 'empty output, a non-zero exit', stdout: '', exitCode: 1, expect: { ok: false, code: 'FAILED' } },
  { name: 'a text with no window in it', stdout: 'Something else entirely\n\nNothing about limits here.\n', expect: { ok: false, code: 'PARSE' } },
  {
    name: 'a very long output: the windows at its top are read, the rest passed over',
    stdout: `${USAGE_FIXTURES.recordedMain ?? ''}${JUNK_LINE.repeat(4000)}`,
    expect: MAIN,
  },
  {
    name: 'a very long output with the windows past the parse window: PARSE, never a figure from the rest',
    stdout: `${JUNK_LINE.repeat(1000)}${SESSION}\n${WEEK}\n`,
    expect: { ok: false, code: 'PARSE' },
  },
  {
    name: 'terminal escapes and Windows line ends',
    stdout: `\u001b[1mCurrent session\u001b[0m: 12% used · resets Oct 11, 11:20am (Europe/Budapest)\r\n\u001b[2mCurrent week (all models)\u001b[22m: 41% used · resets Oct 16, 1pm (Europe/Budapest)\r\n`,
    expect: MAIN,
  },
  {
    name: 'an account identity in the text never reaches the answer; a reset drops an email-shaped word and keeps plain characters only',
    stdout: `Logged in as ${FAKE_MAIL} (${FAKE_ORG})\nCurrent session: 12% used · resets <b>6pm</b> ${FAKE_MAIL}\nCurrent week (all models): 41% used · resets Oct 16, 1pm (Europe/Budapest)\n`,
    expect: { ok: true, five: { percent: 12, resets: 'b 6pm /b' }, seven: MAIN.seven },
  },
  {
    name: 'written: both windows over 90 percent, one line each',
    stdout: 'Current session: 95% used \u00b7 resets 6pm (Europe/Rome)\nCurrent week (all models): 91% used \u00b7 resets Oct 14, 9am (Europe/Rome)\n',
    expect: { ok: true, five: { percent: 95, resets: '6pm (Europe/Rome)' }, seven: { percent: 91, resets: 'Oct 14, 9am (Europe/Rome)' } },
  },
]
