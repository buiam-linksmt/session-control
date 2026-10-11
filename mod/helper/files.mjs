// The file operations, alike on Linux and Windows: an atomic write through a sibling temp file, a rename over an
// existing file, a removal, a true OS append, the tail of a file read from its end, the trace rotation, the read-only
// listing of the files written after a time under a directory, and the read-only content hashes of a mod folder.

import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname } from 'node:path'

import { HelperError, count, path, text } from './protocol.mjs'

const IS_WINDOWS = process.platform === 'win32'

/** How long a rename on Windows is tried again while another process holds the target open (a reader, an antivirus). */
const RENAME_RETRY_MS = 1000

/** Windows refuses to replace a file another process has open without delete sharing: those errors pass, the rest stay. */
const isTransient = err => IS_WINDOWS && ['EPERM', 'EACCES', 'EBUSY'].includes(err?.code)

/** Waits a few milliseconds without a timer (the helper is one short synchronous run). */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Renames over an existing file. On Linux rename(2) replaces the target in one step. On Windows Node's rename is
 * MoveFileEx with MOVEFILE_REPLACE_EXISTING, also one step, which fails while another process holds the target open
 * without delete sharing: that is tried again for up to RENAME_RETRY_MS.
 */
export function renameReplacing(from, to) {
  const until = Date.now() + RENAME_RETRY_MS
  for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      if (!isTransient(err) || Date.now() >= until) throw err
      pause(wait)
    }
  }
}

/** Flushes a directory's entry table, so a rename survives a crash (Linux only; Windows cannot open a directory). */
function syncDir(dir) {
  if (IS_WINDOWS) return
  let fd
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
  } catch {
    // best effort: the rename itself has happened
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Writes all of a buffer to a file descriptor. */
function writeAll(fd, bytes) {
  for (let at = 0; at < bytes.length; ) at += fs.writeSync(fd, bytes, at, bytes.length - at)
}

/**
 * `{path, text, expected?}`: the text goes to a new temp file in the same directory (made when missing, as `$.fs.write`
 * makes it), flushed, then renamed over the file. With `expected`, the file is read again right before the rename and
 * nothing is written when it no longer holds that text (a missing file holds none): `{written: false}`.
 */
export function writeAtomic(request) {
  const target = path(request, 'path')
  const body = text(request, 'text')
  const expected = text(request, 'expected', true)
  fs.mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
  const fd = fs.openSync(tmp, 'wx')
  try {
    writeAll(fd, Buffer.from(body, 'utf8'))
    fs.fsyncSync(fd)
  } catch (err) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw err
  }
  fs.closeSync(fd)
  try {
    if (expected !== undefined && readOrUndefined(target) !== expected) {
      fs.rmSync(tmp, { force: true })
      return { written: false }
    }
    renameReplacing(tmp, target)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  syncDir(dirname(target))
  return { written: true }
}

/** A file's text, or undefined when it is not there. */
function readOrUndefined(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined
    throw err
  }
}

/** `{from, to}`: the first file takes the second's place, replacing it in one step. */
export function renameOver(request) {
  renameReplacing(path(request, 'from'), path(request, 'to'))
  return {}
}

/**
 * `{path, regularOnly?}`: the file goes; one that is not there is no failure (`removed: false`). With `regularOnly: true`
 * only a regular file goes: the path's last component is looked at with lstat, which does not follow a link, and a
 * symbolic link (on Windows also a junction) is refused with IS_LINK, anything else that is no regular file (a
 * directory, a device) with NOT_FILE; nothing is removed then. The unlink itself never follows a link either.
 */
export function removeFile(request) {
  const target = path(request, 'path')
  if (request.regularOnly !== undefined && typeof request.regularOnly !== 'boolean') throw new HelperError('BAD_REQUEST')
  try {
    if (request.regularOnly === true) {
      const info = fs.lstatSync(target)
      if (info.isSymbolicLink()) throw new HelperError('IS_LINK')
      if (!info.isFile()) throw new HelperError('NOT_FILE')
    }
    fs.unlinkSync(target)
    return { removed: true }
  } catch (err) {
    if (err?.code === 'ENOENT') return { removed: false }
    throw err
  }
}

/**
 * `{path, text}`: the text is added to the end of the file in one write on a descriptor opened for append (O_APPEND,
 * FILE_APPEND_DATA on Windows), so two writers never overwrite each other; the file is never read. The directory is
 * made when missing.
 */
export function append(request) {
  const target = path(request, 'path')
  const bytes = Buffer.from(text(request, 'text'), 'utf8')
  fs.mkdirSync(dirname(target), { recursive: true })
  const fd = fs.openSync(target, 'a')
  try {
    writeAll(fd, bytes)
  } finally {
    fs.closeSync(fd)
  }
  return { bytes: bytes.length }
}

/** The bytes read at a time from the end of a file. */
const CHUNK = 1024 * 1024

/** The answer of a tail stays under the engine's 4 MiB stdout cap: older lines go first. */
export const TAIL_MAX_BYTES = 3 * 1024 * 1024

/**
 * `{path, lines, width, maxBytes?}`: what `tail -n <lines> | cut -c1-<width>` prints (as tailLines in hooks/core.ts
 * computes it: lines split at \n, each cut to `width` UTF-16 units and ended with \n), read from the end of the file
 * without reading it all: of each line only its first bytes are read. When the answer would pass `maxBytes`, the
 * oldest lines are left out and counted in `dropped`.
 */
export function tail(request) {
  const file = path(request, 'path')
  const want = count(request, 'lines', 1)
  const width = count(request, 'width', 1)
  const budget = request.maxBytes === undefined ? TAIL_MAX_BYTES : count(request, 'maxBytes', 1)
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    // The lines as byte ranges, newest first. A last \n closes the last line and opens none (as tailLines drops the
    // empty piece after it); an empty file has no line.
    const ranges = []
    if (size > 0) {
      const last = Buffer.alloc(1)
      fs.readSync(fd, last, 0, 1, size - 1)
      let lineEnd = last[0] === 0x0a ? size - 1 : size
      let scanTo = lineEnd
      const buf = Buffer.alloc(CHUNK)
      while (ranges.length < want && scanTo > 0) {
        const from = Math.max(0, scanTo - CHUNK)
        fs.readSync(fd, buf, 0, scanTo - from, from)
        for (let at = scanTo - from; ranges.length < want && at > 0; ) {
          const nl = buf.lastIndexOf(0x0a, at - 1)
          if (nl < 0) break
          ranges.push([from + nl + 1, lineEnd])
          lineEnd = from + nl
          at = nl
        }
        scanTo = from
      }
      // The start of the file reached: the first line.
      if (ranges.length < want) ranges.push([0, lineEnd])
    }
    // Oldest first; each line read only as far as its cut can reach (4 bytes per UTF-16 unit is more than enough).
    const lines = ranges.reverse().map(([start, end]) => {
      const length = Math.min(end - start, width * 4 + 4)
      const bytes = Buffer.alloc(length)
      if (length > 0) fs.readSync(fd, bytes, 0, length, start)
      return `${bytes.toString('utf8').slice(0, width)}\n`
    })
    let total = lines.reduce((sum, line) => sum + Buffer.byteLength(JSON.stringify(line)), 0)
    let dropped = 0
    while (total > budget && dropped < lines.length) {
      total -= Buffer.byteLength(JSON.stringify(lines[dropped]))
      dropped++
    }
    return { text: lines.slice(dropped).join(''), dropped }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * `{path, adding, maxBytes, moves}`: the trace rotation of ROTATE_SCRIPT in hooks/host-posix.ts. The size is read here,
 * right before the renames, so of several processes sharing the trace only the first to find it too big rotates it.
 * Each move whose source is there is made in order (the oldest file is overwritten); a move another process made
 * first is no failure, and only the last move (the trace itself) failing while its source is still there is one.
 */
export function rotate(request) {
  const trace = path(request, 'path')
  const adding = count(request, 'adding')
  const max = count(request, 'maxBytes', 1)
  const moves = request.moves
  if (!Array.isArray(moves) || !moves.every(move => Array.isArray(move) && move.length === 2 && move.every(part => typeof part === 'string' && part !== '' && !part.includes('\0')))) {
    throw new HelperError('BAD_REQUEST')
  }
  let size
  try {
    size = fs.statSync(trace).size
  } catch {
    return { rotated: false }
  }
  if (!(size > 0 && size + adding > max)) return { rotated: false }
  moves.forEach(([from, to], at) => {
    if (!fs.existsSync(from)) return
    try {
      renameReplacing(from, to)
    } catch (err) {
      if (at === moves.length - 1 && fs.existsSync(from)) throw err
    }
  })
  return { rotated: true }
}

/** A directory entry joined to its directory with `/`, the separator the mod stores on both systems. */
const joined = (dir, name) => (dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`)

/**
 * `{dir, since, max}`: the regular files under `dir` whose mtime is after `since` (epoch seconds), newest first (a
 * tie by path), the first `max` of them with `total`, the count of all: `{files: [{path, mtimeMs}], total}`, paths
 * and mtimes only, nothing read and nothing written. Every entry is taken by lstat: a symbolic link (on Windows also
 * a junction, which lstat reports as one) is neither followed nor listed, so the walk never leaves the tree; a folder
 * named `.git` is not entered; a folder that cannot be read is passed over, as `find` passes it over. `dir` itself
 * must be a directory (NOT_DIR, NOT_FOUND).
 */
export function filesNewerThan(request) {
  const root = path(request, 'dir')
  const since = request.since
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) throw new HelperError('BAD_REQUEST')
  const max = count(request, 'max', 1)
  if (!fs.statSync(root).isDirectory()) throw new HelperError('NOT_DIR')
  const after = since * 1000
  const found = []
  const todo = [root]
  while (todo.length > 0) {
    const dir = todo.pop()
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name === '.git') continue
      const full = joined(dir, name)
      let stat
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) todo.push(full)
      else if (stat.isFile() && stat.mtimeMs > after) found.push({ path: full, mtimeMs: Math.floor(stat.mtimeMs) })
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files: found.slice(0, max), total: found.length }
}

/** The most files hashTree hashes under one root; one more is TOO_LARGE. */
export const TREE_MAX_FILES = 500

/** The largest file hashTree hashes; a larger one is TOO_LARGE. */
export const TREE_MAX_FILE_BYTES = 8 * 1024 * 1024

/**
 * The bytes a drift digest is taken over: each CRLF folded to LF, so a copy whose line ends differ hashes alike; a file
 * that holds a NUL byte (binary-looking) keeps its bytes as they are.
 */
export function driftBytes(bytes) {
  if (bytes.includes(0)) return bytes
  const out = Buffer.allocUnsafe(bytes.length)
  let size = 0
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] === 0x0d && bytes[at + 1] === 0x0a) continue
    out[size++] = bytes[at]
  }
  return out.subarray(0, size)
}

/** A folder or file name of hashTree's request: a relative path of plain names, no `.` or `..` part, no empty part. */
function treePart(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || /^([\\/]|[A-Za-z]:)/.test(value)) throw new HelperError('BAD_REQUEST')
  if (value.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) throw new HelperError('BAD_REQUEST')
  return value.replace(/\\/g, '/')
}

/** A list field of hashTree's request: an array of at most 20 relative paths. */
function treeParts(request, name) {
  const value = request[name]
  if (!Array.isArray(value) || value.length > 20) throw new HelperError('BAD_REQUEST')
  return value.map(treePart)
}

/** The lstat of a path, or undefined when it is not there (or a part of it is no folder). */
function lstatOrUndefined(file) {
  try {
    return fs.lstatSync(file)
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return undefined
    throw err
  }
}

/** Whether a folder on the way from `root` to `rel` (not `rel` itself) is a symbolic link (on Windows also a junction). */
function isLinkOnTheWay(root, rel) {
  const parts = rel.split('/')
  for (let at = 1; at < parts.length; at++) {
    const stat = lstatOrUndefined(joined(root, parts.slice(0, at).join('/')))
    if (stat === undefined || stat.isSymbolicLink()) return true
  }
  return false
}

/**
 * `{root, dirs, files}`: the SHA-256 of the regular files directly in each folder of `dirs` and of each file of
 * `files` (over driftBytes: line ends folded, a file with a NUL byte as it is), all relative to `root`, as `{files: [{path, sha256}], total}` sorted by path: relative paths and hex digests
 * only. Read-only. `root` is followed when it is a link (the engine names the plugin's folder); inside it nothing is:
 * an entry (a folder of `dirs`, a file in it, a file of `files`) is taken by lstat, and a symbolic link (on Windows
 * also a junction) is passed over, as is a folder in a folder of `dirs`, and an entry with a link among the folders on
 * its way (`.claude-plugin` linked elsewhere: its plugin.json is passed over). A folder of `dirs` or a file of `files` that
 * is not there counts as empty or absent. `root` itself must be a directory (NOT_FOUND, NOT_DIR); more than
 * TREE_MAX_FILES files, or one over TREE_MAX_FILE_BYTES, is TOO_LARGE.
 */
export function hashTree(request) {
  const root = path(request, 'root')
  const dirs = treeParts(request, 'dirs')
  const files = treeParts(request, 'files')
  if (!fs.statSync(root).isDirectory()) throw new HelperError('NOT_DIR')
  const found = []
  const take = (rel, stat) => {
    if (stat === undefined || !stat.isFile()) return
    if (found.length >= TREE_MAX_FILES || stat.size > TREE_MAX_FILE_BYTES) throw new HelperError('TOO_LARGE')
    found.push(rel)
  }
  for (const dir of dirs) {
    const stat = isLinkOnTheWay(root, dir) ? undefined : lstatOrUndefined(joined(root, dir))
    if (stat === undefined || !stat.isDirectory()) continue
    for (const name of fs.readdirSync(joined(root, dir)).sort()) take(`${dir}/${name}`, lstatOrUndefined(joined(root, `${dir}/${name}`)))
  }
  for (const file of files) take(file, isLinkOnTheWay(root, file) ? undefined : lstatOrUndefined(joined(root, file)))
  const unique = [...new Set(found)].sort()
  const hashed = unique.map(rel => {
    const bytes = fs.readFileSync(joined(root, rel))
    if (bytes.length > TREE_MAX_FILE_BYTES) throw new HelperError('TOO_LARGE')
    return { path: rel, sha256: createHash('sha256').update(driftBytes(bytes)).digest('hex') }
  })
  return { files: hashed, total: hashed.length }
}

/** The file operations by name, for a request of its own or one step of a batch. */
export const FILE_OPS = Object.freeze({ writeAtomic, renameOver, removeFile, append, tail, rotate, filesNewerThan, hashTree })
