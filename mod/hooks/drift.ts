// The loaded-mod drift band (decision win-35): the mod the session runs is often a copy of the repository's mod folder
// (a hot-reload folder), and the copy can lag behind. register.tsx hashes the loaded plugin's folder and the source mod
// folder (host.hashTrees, over DRIFT_SPEC only), at the start and every DRIFT_EVERY_SEC; while they differ the band
// above the prompt shows driftBandText, and the first time a set of changed files is seen one `mod-drift` notice goes
// out (notices.ts, driftStep). Pure: no `$`, no I/O.

import type { TreeHashes, TreeSpec } from './host'

/**
 * What is compared: the files directly in hooks/, helper/ and types/, and the manifest; never tests, node_modules or the
 * engine's generated .claude-plugin/types.
 */
export const DRIFT_SPEC: TreeSpec = { dirs: ['hooks', 'helper', 'types'], files: ['.claude-plugin/plugin.json'] }

/** The check runs at the start and then at most once per this interval, from the poll. */
export const DRIFT_EVERY_SEC = 300

/** The shortest interval the test-only shortening (driftEverySec) allows. */
export const DRIFT_TEST_MIN_SEC = 5

/** How many changed file names the band and the notice name. */
export const DRIFT_NAMES_SHOWN = 3

/**
 * The check's interval: DRIFT_EVERY_SEC, unless the environment carries the test-only shortening, which counts only
 * with SESSION_CONTROL_TEST=1 (any other value, or none, leaves it inert, as the helper's SC_HELPER_TEST does) and a
 * whole number of seconds in SESSION_CONTROL_DRIFT_SECONDS, at least DRIFT_TEST_MIN_SEC and below DRIFT_EVERY_SEC.
 */
export function driftEverySec(testSwitch: string | undefined, seconds: string | undefined): number {
  if (testSwitch !== '1' || seconds === undefined || !/^\d{1,4}$/.test(seconds.trim())) return DRIFT_EVERY_SEC
  const wanted = Number(seconds.trim())
  return wanted >= DRIFT_TEST_MIN_SEC && wanted < DRIFT_EVERY_SEC ? wanted : DRIFT_EVERY_SEC
}

/**
 * The source mod folder: the modSource option when set (`off`: no band), else `<orchestrator directory>/mod`; the
 * caller checks that it exists. Undefined: the band is off.
 */
export function sourceModDir(option: string, orchestratorDir: string): string | undefined {
  const given = option.trim()
  if (given.toLowerCase() === 'off') return undefined
  if (given !== '') return given
  return orchestratorDir === '' ? undefined : `${orchestratorDir.replace(/[\\/]+$/, '')}/mod`
}

/** The relative paths that differ between two trees hashed by one call: changed, added or removed, sorted. */
export function changedFiles(loaded: TreeHashes, source: TreeHashes): string[] {
  const paths = new Set([...Object.keys(loaded.files), ...Object.keys(source.files)])
  return [...paths].filter(path => loaded.files[path] !== source.files[path]).sort()
}

/** Up to DRIFT_NAMES_SHOWN names, then `...` when there are more. */
function names(changed: readonly string[]): string {
  const shown = changed.slice(0, DRIFT_NAMES_SHOWN).join(', ')
  return changed.length > DRIFT_NAMES_SHOWN ? `${shown}, ...` : shown
}

const countText = (n: number) => `${n} ${n === 1 ? 'file' : 'files'} changed`

/** The band's one line: the source folder, how many files differ, up to three names, and how to reload. */
export function driftBandText(modDir: string, changed: readonly string[]): string {
  return `session-control: the loaded mod differs from ${modDir} (${countText(changed.length)}: ${names(changed)}). Reload it: copy hooks, helper, types and plugin.json to the plugin folder, or restart with --plugin-dir ${modDir}`
}

/** The `mod-drift` notice's message. */
export function driftNoticeMessage(modDir: string, changed: readonly string[]): string {
  return `the loaded mod differs from ${modDir} (${countText(changed.length)}: ${names(changed)}); the band above the prompt says how to reload it`
}
