// Pure parts of the helper-file store: what a missing file starts as, names and dates. The reads and writes
// themselves live in register.tsx, where `$` is available.

export const OPEN_POINTS_CLEANUP =
  'Live file holds every open entry plus closed ones from the last 7 days. On each write, closed entries older than that rotate into open-points-archive.md (append-only, human-readable) and are removed here. Open entries never rotate, however old.'

/** The text a helper file starts as on a fresh environment; undefined for a file the mod never creates. */
export function freshText(file: string): string | undefined {
  if (file === 'open-points.json') return JSON.stringify({ _cleanup: OPEN_POINTS_CLEANUP, points: [] }, null, 2) + '\n'
  if (file === 'task-queue.json') return JSON.stringify({ tasks: [] }, null, 2) + '\n'
  if (file === 'agreed-decisions.md') return '# Agreed decisions\n'
  if (file === 'open-points-archive.md') return '# Open points archive\n'
  if (file === 'headless-sessions.json') return '[]\n'
  return undefined
}

/** Local calendar date as YYYY-MM-DD, the one convention for backups and rotation. */
export function localDate(ms: number): string {
  const day = new Date(ms)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

/** Name of the once-a-day backup of a file for one tool, inside the backups directory. */
export function backupName(file: string, tool: string, today: string): string {
  const dot = file.lastIndexOf('.')
  return `${file.slice(0, dot)}-before-${tool}-${today}${file.slice(dot)}`
}

/** Temporary sibling a write goes to before the rename. */
export function tmpPath(path: string, stamp: number): string {
  return `${path}.tmp.${stamp}`
}

/** The directory part of a path. */
export function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '/' : path.slice(0, at)
}
