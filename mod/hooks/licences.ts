// Pure parts of the licence tools (list_licences, probe_licence_usage, launch_worker's config_dir): the discovery of the
// machine's licences from directory listings, and the plain text each tool answers with. A licence is a config
// directory; it counts when it holds both .credentials.json and .claude.json as regular files (or links that lead to
// regular files), a test of their presence and kind only: neither is ever opened, so no credential and no account
// identity can reach an answer, the trace or a log. No `$`, no I/O: register.tsx lists the directories, asks $.fs.stat
// what kind the two paths are, and hands the answers here.

import type { SessionEntry } from '../types'
import { rowStatus } from './core'
import type { ProcFacts } from './core'
import { bounded, clean } from './inspect'
import { USAGE_TIMEOUT_MS } from './usage'
import type { UsageProbe, UsageWindow } from './usage'

// ---------------------------------------------------------------- schemas

export const LIST_LICENCES_SCHEMA = { type: 'object', additionalProperties: false, properties: {} } as const

export const PROBE_USAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    config_dir: {
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      description: 'One discovered licence (list_licences): its config_dir, or its name. Absent: every discovered licence, one after the other.',
    },
  },
} as const

// ---------------------------------------------------------------- discovery

/** The two files a licence directory holds, looked for by presence and kind only (a regular file, never opened). */
export const LICENCE_FILES = ['.credentials.json', '.claude.json'] as const

/** How long a directory scan is kept in memory before a call scans again. */
export const SCAN_CACHE_MS = 60_000

/** The most directories of one listing a scan looks into; the rest are counted, not examined. */
export const SCAN_MAX_DIRS = 200

/** The most licences an answer lists. */
export const MAX_LICENCES = 50

/**
 * Where a licence was found: `default` the directory a launch with no picker and no config_dir uses (the orchestrator's
 * own CLAUDE_CONFIG_DIR, else <home>/.claude: what the registry records for such a launch); `home` <home>/.claude when
 * that is not the default; `child` <home>/.claude/<name>; `dash` <home>/.claude-<name>; `explicit` the licenceDirs option.
 */
export type LicenceSource = 'default' | 'home' | 'child' | 'dash' | 'explicit'

/** One discovered licence: its directory in the host's path form, its name, where it was found and whether both files are there. */
export type Licence = { configDir: string; name: string; source: LicenceSource; loggedIn: boolean }

/** A scan's licences, with what it passed over: listing entries past SCAN_MAX_DIRS, and option entries that are not absolute. */
export type LicenceScan = { licences: Licence[]; skipped: number; ignored: number; scannedAt: number }

/** A candidate directory before its files are looked at. */
export type LicenceCandidate = { configDir: string; source: LicenceSource; isHomeDefault: boolean }

/** The directory entries a scan reads: name and kind, as `$.fs.list` gives them (a link is `other`, never followed). */
export type ListedEntry = { name: string; kind: string }

/**
 * The licenceDirs option: comma separated directories, each absolute after a leading `~` is expanded (`isAbsolute`
 * says what the platform takes as absolute); the others are ignored and counted.
 */
export function licenceDirsOf(option: string, home: string, isAbsolute: (path: string) => boolean): { dirs: string[]; ignored: number } {
  const dirs: string[] = []
  let ignored = 0
  for (const raw of option.split(',')) {
    const one = raw.trim()
    if (one === '') continue
    const expanded = one === '~' ? home : one.startsWith('~/') ? `${home}${one.slice(1)}` : one
    if (isAbsolute(expanded)) dirs.push(expanded.replace(/[\\/]+$/, '') || expanded)
    else ignored++
  }
  return { dirs, ignored }
}

/**
 * The candidates in the order their sources rank (default, home, child, dash, explicit), each directory once (`isSame`
 * compares as the platform compares paths; the first source wins). `children` and `home` are the listings of
 * <home>/.claude and of <home>, directories only (a link, `other`, is not followed), each cut at SCAN_MAX_DIRS.
 */
export function licenceCandidates(input: {
  home: string
  defaultDir: string
  children: readonly ListedEntry[]
  homeEntries: readonly ListedEntry[]
  explicit: readonly string[]
  isSame: (a: string, b: string) => boolean
}): { candidates: LicenceCandidate[]; skipped: number } {
  const homeClaude = `${input.home}/.claude`
  const childDirs = input.children.filter(one => one.kind === 'dir')
  const dashDirs = input.homeEntries.filter(one => one.kind === 'dir' && one.name.startsWith('.claude-') && one.name.length > '.claude-'.length)
  const skipped = Math.max(0, childDirs.length - SCAN_MAX_DIRS) + Math.max(0, dashDirs.length - SCAN_MAX_DIRS)
  const all: Omit<LicenceCandidate, 'isHomeDefault'>[] = [
    { configDir: input.defaultDir, source: 'default' },
    { configDir: homeClaude, source: 'home' },
    ...childDirs.slice(0, SCAN_MAX_DIRS).map(one => ({ configDir: `${homeClaude}/${one.name}`, source: 'child' as const })),
    ...dashDirs.slice(0, SCAN_MAX_DIRS).map(one => ({ configDir: `${input.home}/${one.name}`, source: 'dash' as const })),
    ...input.explicit.map(dir => ({ configDir: dir, source: 'explicit' as const })),
  ]
  const candidates: LicenceCandidate[] = []
  for (const one of all) {
    if (candidates.some(seen => input.isSame(seen.configDir, one.configDir))) continue
    candidates.push({ ...one, isHomeDefault: input.isSame(one.configDir, homeClaude) })
  }
  return { candidates, skipped }
}

/**
 * Whether a candidate counts, from the presence of its two files as regular files (a directory or a broken link in a
 * file's place is not there): the default directory always (a launch goes there
 * whether or not it is logged in), any other only with both. <home>/.claude may keep its .claude.json at <home>/.claude.json,
 * where Claude Code keeps it when CLAUDE_CONFIG_DIR is not set: either place counts for it.
 */
export function licenceOf(candidate: LicenceCandidate, has: { credentials: boolean; config: boolean; homeConfig: boolean }): Licence | undefined {
  const loggedIn = has.credentials && (has.config || (candidate.isHomeDefault && has.homeConfig))
  if (!loggedIn && candidate.source !== 'default') return undefined
  return { configDir: candidate.configDir, name: licenceName(candidate), source: candidate.source, loggedIn }
}

/** A licence's name: `default` for the default directory, else the last component of its path. */
export function licenceName(candidate: { configDir: string; source: LicenceSource }): string {
  if (candidate.source === 'default') return 'default'
  const parts = candidate.configDir.split(/[\\/]+/).filter(part => part !== '')
  return parts.at(-1) ?? candidate.configDir
}

/** The discovered licence a config directory names, by its path (compared as the platform does) or by its name; undefined: none. */
export function findLicence(licences: readonly Licence[], asked: string, isSame: (a: string, b: string) => boolean): Licence | undefined {
  const given = asked.trim()
  if (given === '') return undefined
  return licences.find(one => isSame(one.configDir, given)) ?? licences.find(one => one.name === given)
}

// ---------------------------------------------------------------- list_licences

/**
 * A config directory as the registry match compares it: repeated separators collapsed, `.` components dropped and a
 * trailing separator stripped (on Windows `\\` is a separator too, and a leading `//` of a UNC path is kept). Spelling
 * only: `..` is kept and no symbolic link is resolved (the mod never resolves one), so a registry path through a link
 * and the licence's own path count as two directories.
 */
export function normalConfigDir(path: string, isWindows = false): string {
  const slashed = isWindows ? path.replace(/\\/g, '/') : path
  const lead = isWindows && /^\/\/[^/]/.test(slashed) ? '//' : slashed.startsWith('/') ? '/' : ''
  const parts = slashed.split('/').filter(part => part !== '' && part !== '.')
  return lead + parts.join('/') || lead || '.'
}

/** Whether a registry entry's config_dir is a licence's directory: both normalised (normalConfigDir), then compared as the platform does. */
export function isUnderLicence(entryDir: string, licenceDir: string, isSame: (a: string, b: string) => boolean, isWindows = false): boolean {
  return entryDir !== '' && isSame(normalConfigDir(entryDir, isWindows), normalConfigDir(licenceDir, isWindows))
}

/** Registry sessions per licence: live (the Abort check passes) and in all; the paths matched by isUnderLicence. */
export function sessionCounts(licence: Licence, entries: readonly SessionEntry[], facts: ProcFacts, isSame: (a: string, b: string) => boolean, isWindows = false): { live: number; all: number } {
  const under = entries.filter(entry => typeof entry.config_dir === 'string' && isUnderLicence(entry.config_dir, licence.configDir, isSame, isWindows))
  return { live: under.filter(entry => rowStatus(entry, facts) === 'alive').length, all: under.length }
}

/** How old a scan is, in whole seconds. */
const ageOf = (scan: LicenceScan, nowMs: number) => Math.max(0, Math.floor((nowMs - scan.scannedAt) / 1000))

/**
 * list_licences' answer: one summary line, then one line per licence (config_dir, name, source, logged_in, the
 * registry's sessions under it). `registry` is undefined when the registry cannot be read (the counts are then `?`).
 */
export function listLicencesText(input: {
  scan: LicenceScan
  nowMs: number
  isCached: boolean
  registry?: { entries: readonly SessionEntry[]; facts: ProcFacts }
  registryError?: string
  isSame: (a: string, b: string) => boolean
  isWindows?: boolean
}): string {
  const { scan } = input
  const age = ageOf(scan, input.nowMs)
  const count = scan.licences.length
  const lines = [
    `${count} licence${count === 1 ? '' : 's'} (directory scan ${input.isCached ? `cached, ${age} s old` : 'fresh'}; logged_in says only that .credentials.json and .claude.json are there: neither is opened).`,
  ]
  for (const licence of scan.licences.slice(0, MAX_LICENCES)) {
    const counts = input.registry === undefined ? undefined : sessionCounts(licence, input.registry.entries, input.registry.facts, input.isSame, input.isWindows)
    lines.push(
      [
        `- ${clean(licence.name)}`,
        `config_dir ${clean(licence.configDir)}`,
        `source ${licence.source}`,
        `logged_in ${licence.loggedIn ? 'yes' : 'no'}`,
        `sessions ${counts === undefined ? '? live, ? in all' : `${counts.live} live, ${counts.all} in all`}`,
      ].join(' | '),
    )
  }
  if (count > MAX_LICENCES) lines.push(`(${count - MAX_LICENCES} more licences not shown)`)
  if (input.registry !== undefined) {
    const known = input.registry.entries.filter(entry => typeof entry.config_dir === 'string' && scan.licences.some(one => isUnderLicence(entry.config_dir as string, one.configDir, input.isSame, input.isWindows))).length
    const other = input.registry.entries.length - known
    if (other > 0) lines.push(`${other} registry entr${other === 1 ? 'y is' : 'ies are'} under no discovered licence.`)
  } else lines.push(`The registry cannot be read (${clean(input.registryError ?? 'unknown')}): no session counts.`)
  if (scan.skipped > 0) lines.push(`${scan.skipped} director${scan.skipped === 1 ? 'y was' : 'ies were'} not examined (more than ${SCAN_MAX_DIRS} in one listing).`)
  if (scan.ignored > 0) lines.push(`${scan.ignored} licenceDirs entr${scan.ignored === 1 ? 'y is' : 'ies are'} not an absolute path and ignored.`)
  return bounded(lines.join('\n'))
}

// ---------------------------------------------------------------- probe_licence_usage

/** How long a probe's windows are kept per licence: a call within answers from memory and says so. */
export const USAGE_CACHE_MS = 60_000

/** How long a failed probe is kept: a code is tried again sooner than a figure. */
export const USAGE_FAIL_CACHE_MS = 15_000

/**
 * The most one probe_licence_usage call takes: the engine documents no limit for a plugin tool's call (a hook's own
 * 10 s budget does not count the `$` calls it waits on), and the mod holds the call to this.
 */
export const USAGE_CALL_BUDGET_MS = 40_000

/** The most one probe can take: claude's USAGE_TIMEOUT_MS, and the helper's start around it (USAGE_CALL_TIMEOUT_MS). */
export const USAGE_PROBE_WORST_MS = USAGE_TIMEOUT_MS + 5_000

/** A launch under an explicit config_dir warns when a probe of the last USAGE_CACHE_MS shows a window over this percent. */
export const USAGE_WARN_PERCENT = 90

/** One probe's answer and when it was made (epoch ms). */
export type UsageSeen = { at: number; result: UsageProbe }

/** Whether a kept probe still answers: windows for USAGE_CACHE_MS, a code for USAGE_FAIL_CACHE_MS. */
export function isUsageFresh(seen: UsageSeen, nowMs: number): boolean {
  const age = nowMs - seen.at
  return age >= 0 && age < (seen.result.ok ? USAGE_CACHE_MS : USAGE_FAIL_CACHE_MS)
}

/** Whether one more probe fits in the call's budget after `elapsedMs`, at its worst. */
export const hasProbeRoom = (elapsedMs: number) => elapsedMs + USAGE_PROBE_WORST_MS <= USAGE_CALL_BUDGET_MS

/** One licence of the answer: its probe (`isCached` when from memory), or not probed (no room left in the call). */
export type UsageRow = { licence: Licence; seen?: UsageSeen; isCached: boolean }

const windowText = (label: string, one: UsageWindow | null) => (one === null ? `${label} -` : `${label} ${one.percent}%${one.resets === '' ? '' : ` (resets ${clean(one.resets)})`}`)

/** The window of the rows with the highest percent, said as `<percent>% (<name>)`, or `-`. */
function highest(rows: readonly UsageRow[], pick: (result: UsageProbe & { ok: true }) => UsageWindow | null): string {
  let best: { percent: number; name: string } | undefined
  for (const row of rows) {
    const result = row.seen?.result
    const one = result?.ok === true ? pick(result) : null
    if (one !== null && (best === undefined || one.percent > best.percent)) best = { percent: one.percent, name: row.licence.name }
  }
  return best === undefined ? '-' : `${best.percent}% (${clean(best.name)})`
}

/**
 * probe_licence_usage's answer: one summary line, one line per licence (the 5-hour and 7-day all-models windows, or the
 * fixed code; age_seconds and cached), the licences left for the next call, and how far the figures can be trusted.
 */
export function probeUsageText(rows: readonly UsageRow[], nowMs: number): string {
  const probed = rows.filter(row => row.seen !== undefined)
  const fromCache = probed.filter(row => row.isCached).length
  const left = rows.filter(row => row.seen === undefined)
  const lines = [
    `Usage of ${probed.length} licence${probed.length === 1 ? '' : 's'} (${probed.length - fromCache} probed now, ${fromCache} from the cache): highest five_hour ${highest(probed, one => one.five)}, highest seven_day ${highest(probed, one => one.seven)}.`,
  ]
  for (const row of probed.slice(0, MAX_LICENCES)) {
    const seen = row.seen as UsageSeen
    const age = Math.max(0, Math.floor((nowMs - seen.at) / 1000))
    const figures = seen.result.ok ? [windowText('five_hour', seen.result.five), windowText('seven_day', seen.result.seven)] : [`error ${seen.result.code}`]
    lines.push([`- ${clean(row.licence.name)} (config_dir ${clean(row.licence.configDir)})`, ...figures, `age_seconds ${age}`, `cached ${row.isCached ? 'yes' : 'no'}`].join(' | '))
  }
  if (probed.length > MAX_LICENCES) lines.push(`(${probed.length - MAX_LICENCES} more licences not shown)`)
  if (left.length > 0) lines.push(`${left.length} more not probed: call again (${left.slice(0, 10).map(row => clean(row.licence.name)).join(', ')}${left.length > 10 ? ', ...' : ''}).`)
  lines.push('The figures are what the CLI\'s /usage shows: they can be stale (up to an hour when its own fetch fails), percents are floored and resets are as the CLI words them.')
  return bounded(lines.join('\n'))
}

/**
 * The warning a launch under an explicit config_dir gives when a probe of that licence within USAGE_CACHE_MS showed a
 * window over USAGE_WARN_PERCENT; undefined when none did (or no probe is that recent: nothing is probed for it).
 */
export function usageWarning(licence: Licence, seen: UsageSeen | undefined, nowMs: number): string | undefined {
  if (seen === undefined || !seen.result.ok || nowMs - seen.at < 0 || nowMs - seen.at >= USAGE_CACHE_MS) return undefined
  const over = [
    ...(seen.result.five !== null && seen.result.five.percent > USAGE_WARN_PERCENT ? [`five_hour ${seen.result.five.percent}%`] : []),
    ...(seen.result.seven !== null && seen.result.seven.percent > USAGE_WARN_PERCENT ? [`seven_day ${seen.result.seven.percent}%`] : []),
  ]
  if (over.length === 0) return undefined
  const age = Math.floor((nowMs - seen.at) / 1000)
  return `licence ${clean(licence.name)} was over ${USAGE_WARN_PERCENT}% in a probe ${age} s ago (${over.join(', ')}); launched as asked, it may stop at its limit`
}

/** The refusal of a config_dir that is no discovered licence: the names of those that are, never anything of their files. */
export function notDiscoveredText(licences: readonly Licence[]): string {
  const names = licences.slice(0, 20).map(one => clean(one.name))
  return `refused: config_dir is not a discovered licence (discovered: ${names.length === 0 ? 'none' : names.join(', ')}${licences.length > 20 ? ', ...' : ''}; list_licences shows them); nothing was launched`
}
