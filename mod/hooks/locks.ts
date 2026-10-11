// The lock-holder notice (decision win-27): the lock folders the lockDirs option names are read, and a lock whose
// holder pid is no longer alive is told once (notices.ts, lockStep), re-armed when the lock's content changes. A lock
// is never deleted, written or touched. Pure: register.tsx lists the folders, reads the files and probes the pids.
//
// Two formats are read:
// - generic: a direct child of a lock folder that is a folder holding a file named `pid`, `owner` or `holder` (the
//   first of them there), or a file named `*.pid` or `*.lock`; the holder is the first integer in the first line;
// - JSON, as a real project's lock tool writes it (a `<name>.lock` file holding an indented JSON object): the holder
//   is the object's `pid`, and its `pid_start` (on Linux the process start, field 22 of /proc/<pid>/stat), when given,
//   must still be the pid's own start, else the pid was reused and the holder is gone.
// A pid that cannot be read or does not look like a number is skipped without a notice.

/** The files of a lock folder that name its holder, in the order they are looked for. */
export const HOLDER_FILES: readonly string[] = ['pid', 'owner', 'holder']

/** The lock checks run from the poll at most once per this interval. */
export const LOCK_EVERY_SEC = 60

/** The most locks read per lock folder at one check; the rest wait for a later check. */
export const LOCKS_PER_DIR = 50

/** The largest pid taken as one (Linux's pid_max ceiling is 2^22, Windows' pids stay under 2^32). */
const MAX_PID = 2 ** 32

/** One lock to read: where it is (the folder's child) and the file that names its holder. */
export type LockCandidate = { lock: string; file: string }

/** A lock's holder as its file names it. */
export type LockHolder = { pid: number; start?: string; isJson: boolean }

/** The lockDirs option: comma separated absolute folders (`/...`, `C:/...` or `C:\...`); anything else is left out. */
export function lockDirsOf(option: string): string[] {
  return [
    ...new Set(
      option
        .split(',')
        .map(one => one.trim())
        .filter(one => one.startsWith('/') || /^[A-Za-z]:[\\/]/.test(one))
        .map(one => one.replace(/[\\/]+$/, '') || '/'),
    ),
  ]
}

/**
 * The locks of one folder from its listing ($.fs.list: an entry as it stands, a link `other`): a folder is a lock read
 * through its holder files (the caller tries HOLDER_FILES in order), a file named `*.pid` or `*.lock` is read itself;
 * a link and any other file are passed over. At most LOCKS_PER_DIR, by name.
 */
export function lockCandidates(dir: string, entries: readonly { name: string; kind: string; isLink?: boolean }[]): { lock: string; isFolder: boolean }[] {
  const base = dir.replace(/[\\/]+$/, '')
  return entries
    .filter(one => one.isLink !== true && ((one.kind === 'dir' && !one.name.startsWith('.')) || (one.kind === 'file' && /\.(pid|lock)$/i.test(one.name))))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, LOCKS_PER_DIR)
    .map(one => ({ lock: `${base}/${one.name}`, isFolder: one.kind === 'dir' }))
}

const asPid = (value: unknown): number | undefined => {
  const pid = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : undefined
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0 && pid < MAX_PID ? pid : undefined
}

/**
 * The holder a lock's file names: a JSON object's `pid` (with its `pid_start` when given), else (a text that is not
 * JSON) the first whole number in the first line. Undefined when there is none or it is no plausible pid (0, too large,
 * after a minus sign), and for JSON that is not an object with a pid.
 */
export function lockHolder(text: string): LockHolder | undefined {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let doc: unknown
    try {
      doc = JSON.parse(trimmed)
    } catch {
      doc = undefined
    }
    // A JSON text names its holder only as an object's pid; JSON of any other shape names none.
    if (doc !== undefined) {
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined
      const record = doc as Record<string, unknown>
      const pid = asPid(record.pid)
      if (pid === undefined) return undefined
      const start = typeof record.pid_start === 'string' || typeof record.pid_start === 'number' ? String(record.pid_start).trim() : ''
      return start === '' ? { pid, isJson: true } : { pid, start, isJson: true }
    }
  }
  // The first whole number of the first line; one after a minus sign is no pid.
  const first = /(?:^|[^\d-])(\d+)/.exec(text.split(/\r?\n/, 1)[0] ?? '')
  const pid = first === null ? undefined : asPid(first[1])
  return pid === undefined ? undefined : { pid, isJson: false }
}

/**
 * Whether the holder is gone, from the probe's facts of its pid: the pid no longer exists, or (Linux, a JSON lock with
 * `pid_start`) the process that has it now started at another time. A zombie still has its pid and counts as alive.
 */
export function isHolderDead(holder: LockHolder, proof: { isAlive: boolean; startTicks?: string }, isLinux: boolean): boolean {
  if (!proof.isAlive) return true
  return isLinux && holder.start !== undefined && proof.startTicks !== undefined && proof.startTicks !== '' && proof.startTicks !== holder.start
}

/** A short stable fingerprint of a lock's content: a changed lock re-arms its notice. */
export function lockFingerprint(text: string): string {
  let hash = 2166136261
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619) >>> 0
  return `${text.length}:${hash.toString(16)}`
}
