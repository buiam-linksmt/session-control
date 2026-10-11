// The helper-file edit guard (decision mod-2): in the orchestrator's own session the model never edits the files the
// mod's tools write by hand. HELPER_FILES is the one list of those files, each with where it lives and the tools that
// write it; every tool that writes a helper file registers it here, and tests/guard.test.ts fails when a tool writes a
// file that is neither in this list nor in UNGUARDED_FILES (with its reason). Pure: no `$`, no I/O; register.tsx hooks
// `tool.call` for Edit, Write, MultiEdit, NotebookEdit, Bash and PowerShell and asks pathVerdict or commandVerdict.
//
// The Bash and PowerShell check is a heuristic against slips, not a sandbox. It reads the command text: a protected
// file named (by its base name, or a path ending in it) together with a construct that writes it is refused; reading
// commands pass. It cannot see what the text does not say: a glob (`task-*.json`, `*.md`), a name built at run time
// (`f=task; sed -i x "$f-queue.json"` in one segment), a name read from a file or another command's output (`ls |
// xargs rm`), a script file it runs (`python3 fix.py`, `sh edit.sh`), an encoded PowerShell command (-EncodedCommand),
// a link or alias to a helper file that already exists (making one by `ln` is refused, but a later `sed -i q` names
// only `q`), a rename of a parent folder, and a writer it does not list. A relative name after a `cd` is still caught
// by its base name; so is a helper file's name in any folder, which may refuse a file of the same name elsewhere. A refusal
// can also hit a harmless command that names a helper file beside a writing command (`cp task-queue.json /tmp`): read
// a helper file with cat, head, grep or jq instead.

import { winPath } from './core'

/** Where a helper file lives: the orchestrator directory, the registry path itself (the registryPath option), or the runs directory. */
export type HelperPlace = 'orchestrator' | 'registry' | 'runs'

export type HelperFileRule = {
  /** The file's base name; the registry's is the default one, its real path comes from the registryPath option. */
  name: string
  place: HelperPlace
  /** The tools that write it. */
  writers: readonly string[]
  /** The tools a refusal names instead. */
  useInstead: string
}

const REGISTRY_TOOLS = 'launch_worker, acknowledge_workers, retire_workers or close_worker'

/** Every file a tool of the mod writes and the guard protects. A tool that writes a new helper file adds it here. */
export const HELPER_FILES: readonly HelperFileRule[] = [
  { name: 'open-points.json', place: 'orchestrator', writers: ['open_point'], useInstead: 'open_point' },
  { name: 'open-points-archive.md', place: 'orchestrator', writers: ['open_point'], useInstead: 'open_point' },
  { name: 'task-queue.json', place: 'orchestrator', writers: ['queue_task'], useInstead: 'queue_task' },
  { name: 'agreed-decisions.md', place: 'orchestrator', writers: ['record_decision', 'archive_decisions'], useInstead: 'record_decision or archive_decisions' },
  { name: 'agreed-decisions-archive.md', place: 'orchestrator', writers: ['archive_decisions'], useInstead: 'record_decision or archive_decisions' },
  { name: 'headless-sessions.json', place: 'registry', writers: ['launch_worker', 'acknowledge_workers', 'retire_workers', 'close_worker'], useInstead: REGISTRY_TOOLS },
  { name: 'cleared.jsonl', place: 'runs', writers: ['retire_workers', 'close_worker'], useInstead: REGISTRY_TOOLS },
]

/**
 * The files the tools write that the guard leaves alone, each with its reason: a name in the orchestrator directory or
 * the runs directory (a `RegExp` over the path below it). A tool that writes a file that is in neither list fails the
 * coverage test until it is added to one of them.
 */
export const UNGUARDED_FILES: readonly { place: Exclude<HelperPlace, 'registry'> | 'any'; pattern: RegExp; reason: string }[] = [
  { place: 'orchestrator', pattern: /^backups\/[^/]+$/, reason: 'the daily backups the tools make before a change; backups/ stays editable by hand (mod-2)' },
  { place: 'any', pattern: /\.tmp\.[^/]+$/, reason: "an atomic write's temporary sibling, renamed over its file at once" },
  { place: 'runs', pattern: /^[^/]+\.(json|err|pid)$/, reason: "a launch's own run files (result, error, pid): mod-owned, never a helper file" },
  { place: 'runs', pattern: /^[^/]+\.prompt\.md$/, reason: 'a prompt file the mod wrote for a launch: mod-owned run file' },
  { place: 'runs', pattern: /^trace\.log(\.\d+)?$/, reason: 'the debug trace and its rotations' },
  { place: 'runs', pattern: /^[a-z]+\.ps1$/, reason: "the mod's own PowerShell scripts (native Windows)" },
  { place: 'runs', pattern: /^[^/]+\.add\.\d+$/, reason: "the lines of a Windows append, staged before the file script appends them" },
]

/** The protected files of this machine: each path, its base name and the tools a refusal names. */
export type ProtectedFile = { path: string; name: string; useInstead: string }

const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}/${name}`

/** HELPER_FILES at their places: the orchestrator directory, the registry path, the runs directory. */
export function protectedFiles(places: { orchestratorDir: string; registryPath: string; runsDir: string }): ProtectedFile[] {
  return HELPER_FILES.map(rule => {
    const path = rule.place === 'registry' ? places.registryPath : joinPath(rule.place === 'runs' ? places.runsDir : places.orchestratorDir, rule.name)
    return { path, name: path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1), useInstead: rule.useInstead }
  })
}

/** Which list a written path is in: `protected` (HELPER_FILES), `unguarded` (UNGUARDED_FILES, with the reason) or `unlisted`. */
export function writeKind(path: string, places: { orchestratorDir: string; registryPath: string; runsDir: string }): { kind: 'protected' | 'unlisted' } | { kind: 'unguarded'; reason: string } {
  if (protectedFiles(places).some(one => one.path === path)) return { kind: 'protected' }
  const below = (dir: string) => (path.startsWith(`${dir.replace(/\/+$/, '')}/`) ? path.slice(dir.replace(/\/+$/, '').length + 1) : undefined)
  for (const rule of UNGUARDED_FILES) {
    const rest = rule.place === 'any' ? path : below(rule.place === 'runs' ? places.runsDir : places.orchestratorDir)
    if (rest !== undefined && rule.pattern.test(rest)) return { kind: 'unguarded', reason: rule.reason }
  }
  return { kind: 'unlisted' }
}

// ---------------------------------------------------------------- paths (Edit, Write, MultiEdit, NotebookEdit)

/**
 * A path made absolute against `cwd`, its `.` and `..` segments folded and its separators `/`; on Windows in the
 * C:/... form (Git Bash's /c/... too) and in lower case, since Windows file names ignore case.
 */
export function normalPath(path: string, cwd: string, isWindows: boolean): string {
  const slashed = isWindows ? winPath(path) : path
  const isAbsolute = isWindows ? /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('//') : slashed.startsWith('/')
  const whole = isAbsolute ? slashed : `${(isWindows ? winPath(cwd) : cwd).replace(/\/+$/, '')}/${slashed}`
  const head = isWindows ? (/^[A-Za-z]:/.exec(whole)?.[0] ?? '') : ''
  const parts: string[] = []
  for (const part of whole.slice(head.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const folded = `${head}/${parts.join('/')}`
  return isWindows ? folded.toLowerCase() : folded
}

/**
 * The protected file a written path is, or undefined. `targets` are the spellings of the path (as given, and where it
 * lands through its links when the host could say), `files` the protected files with the spellings of each.
 */
export function pathVerdict(targets: readonly string[], files: readonly (ProtectedFile & { spellings: readonly string[] })[], cwd: string, isWindows: boolean): ProtectedFile | undefined {
  const wanted = new Set(targets.map(one => normalPath(one, cwd, isWindows)))
  return files.find(file => [file.path, ...file.spellings].some(one => wanted.has(normalPath(one, cwd, isWindows))))
}

// ---------------------------------------------------------------- commands (Bash, PowerShell)

type Word = { text: string; isExpanded: boolean }
type Segment = { words: Word[]; outputs: Word[] }

/** Whether a word names a file: the word itself, or a path or an assignment (`of=`, `--file=`) ending in it; any case. */
function namesFile(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'i').test(text)
}

/**
 * The words of a command line, split into segments at `;`, `&&`, `||`, `|`, `&`, line breaks and parentheses, with the
 * output redirections of each (`>`, `>>`, `>|`, `&>`, `<>`, a descriptor before them; a duplication such as `2>&1` is
 * none). Quotes go: single quotes keep everything, double quotes and a backslash escape (PowerShell: the backtick)
 * the next character. A word that holds `$` or a backtick substitution outside single quotes is marked expanded.
 */
function segmentsOf(command: string, isPowerShell: boolean): Segment[] {
  const segments: Segment[] = []
  let words: Word[] = []
  let outputs: Word[] = []
  let word = ''
  let isWord = false
  let isExpanded = false
  let pendingOutput = false
  const escape = isPowerShell ? '`' : '\\'
  const flush = () => {
    if (!isWord) return
    const one = { text: word, isExpanded }
    if (pendingOutput) {
      outputs.push(one)
      pendingOutput = false
    } else words.push(one)
    word = ''
    isWord = false
    isExpanded = false
  }
  const endSegment = () => {
    flush()
    pendingOutput = false
    if (words.length > 0 || outputs.length > 0) segments.push({ words, outputs })
    words = []
    outputs = []
  }
  for (let at = 0; at < command.length; at++) {
    const char = command[at] ?? ''
    const next = command[at + 1] ?? ''
    if (char === "'") {
      const end = command.indexOf("'", at + 1)
      const stop = end < 0 ? command.length : end
      word += command.slice(at + 1, stop)
      isWord = true
      at = stop
      // PowerShell doubles a quote inside single quotes.
      if (isPowerShell && command[stop + 1] === "'") word += "'"
      continue
    }
    if (char === '"') {
      isWord = true
      for (at++; at < command.length && command[at] !== '"'; at++) {
        const inner = command[at] ?? ''
        if (inner === escape && at + 1 < command.length) {
          word += command[++at] ?? ''
          continue
        }
        if (inner === '$' || inner === '`') isExpanded = true
        word += inner
      }
      continue
    }
    if (char === escape && next !== '') {
      word += next
      isWord = true
      at++
      continue
    }
    if (char === '#' && !isWord) {
      const end = command.indexOf('\n', at)
      at = end < 0 ? command.length : end - 1
      continue
    }
    if (char === '\n' || char === ';' || char === '(' || char === ')' || char === '{' || char === '}' || char === '|' || (char === '&' && next !== '>')) {
      if (char === '&' && command[at - 1] === '>') {
        word += char
        isWord = true
        continue
      }
      endSegment()
      if ((char === '|' || char === '&') && next === char) at++
      continue
    }
    if (char === '>' || (char === '<' && next === '>') || (char === '&' && next === '>') || (char === '*' && next === '>' && !isWord)) {
      // A descriptor right before (2>, *>) belongs to the operator; a word before it ends.
      if (isWord && !/^\d+$/.test(word)) flush()
      word = ''
      isWord = false
      let op = char
      while (/[>&|*<]/.test(command[at + 1] ?? '') && op.length < 3) op += command[++at] ?? ''
      // A duplication (>&1, >&-, 2>&1) writes no file.
      if (/&$/.test(op) && /[\d-]/.test(command[at + 1] ?? '')) {
        while (/[\d-]/.test(command[at + 1] ?? '')) at++
        continue
      }
      pendingOutput = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      flush()
      continue
    }
    if (char === '$' || char === '`') isExpanded = true
    word += char
    isWord = true
  }
  endSegment()
  return segments
}

/** Commands that change the file they are given, whatever their options. */
const WRITERS = new Set([
  'tee', 'mv', 'cp', 'rm', 'unlink', 'truncate', 'shred', 'install', 'ln', 'rsync', 'sponge', 'patch', 'touch',
  'vi', 'vim', 'nvim', 'nano', 'emacs', 'ed', 'ex', 'pico', 'joe',
  // cmd.exe
  'del', 'erase', 'copy', 'move', 'ren', 'rename', 'xcopy', 'robocopy',
  // PowerShell cmdlets and their aliases
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'remove-item', 'ri', 'rd', 'rmdir', 'move-item', 'mi', 'copy-item', 'cpi',
  'rename-item', 'rni', 'new-item', 'ni', 'clear-content', 'clc', 'tee-object', 'set-item', 'si', 'export-csv', 'export-clixml',
])

/** Words that run the command after them. */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time', 'timeout', 'stdbuf', 'xargs', 'busybox', '&', '.'])

/** Interpreters whose one-liners (-c, -e) can open a file for writing. */
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|awk|gawk|mawk|nawk)$/

/** Shells whose -c (PowerShell -Command) text is a command line of its own. */
const SHELLS = /^(bash|sh|dash|zsh|ksh|fish|cmd|cmd\.exe)$/
const POWERSHELLS = /^(powershell|powershell\.exe|pwsh|pwsh\.exe)$/

/** What a piece of code does that writes, removes or moves a file. */
const WRITE_MARKERS =
  /(['"])(w|wb|w\+|a|ab|a\+|r\+|x)\1|write|append|truncate|unlink|remove|rename|os\.replace|shutil|rmSync|rmdirSync|copyFile|\bcp\(|\bmv\(|inplace|>\s*['"]|\bsystem\s*\(|\.dump\s*\(|createWriteStream|\bopen\s*\([^)]*,\s*['"][^'"r]/i

/** .NET file calls from PowerShell that write. */
const DOTNET_WRITE = /\[(system\.)?io\.(file|directory)\]::\s*(write|append|delete|move|copy|replace|create|open(?!read))/i

export type CommandHit = { file: ProtectedFile; how: string }

/** The first protected file a command's text names, or undefined. */
function firstNamed(text: string, files: readonly ProtectedFile[]): ProtectedFile | undefined {
  return files.find(file => namesFile(text, file.name))
}

/**
 * Whether a Bash or PowerShell command writes a protected file, by its text: a redirection to it (or to a variable while
 * the command names it), a writing command or cmdlet given it (tee, mv, cp, rm, truncate, install, ln, editors,
 * Set-Content, Out-File, Add-Content, Remove-Item, Move-Item and the rest of WRITERS), `sed -i`, `perl -i`, `ruby -i`,
 * `awk -i inplace`, `yq -i`, `dd of=`, `git checkout|restore|rm|mv` of it, `find ... -delete|-exec`, an interpreter's
 * code that names it and writes, a .NET file call that names it; and the same inside `sh -c`, `bash -c`, `eval`,
 * `cmd /c` and `powershell -Command`. Undefined: the command reads it, or names no protected file.
 */
export function commandVerdict(command: string, files: readonly ProtectedFile[], dialect: 'bash' | 'powershell', depth = 0): CommandHit | undefined {
  const named = firstNamed(command, files)
  if (named === undefined || depth > 3) return undefined
  const isPowerShell = dialect === 'powershell'
  if (DOTNET_WRITE.test(command)) return { file: named, how: 'a .NET file call' }
  for (const segment of segmentsOf(command, isPowerShell)) {
    for (const target of segment.outputs) {
      const hit = firstNamed(target.text, files)
      if (hit !== undefined) return { file: hit, how: 'an output redirection (>)' }
      if (target.isExpanded) return { file: named, how: 'an output redirection to a variable, in a command that names the file' }
    }
    const words = segment.words.map(one => one.text)
    let at = 0
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '') || PREFIXES.has((words[at] ?? '').toLowerCase()) || (at > 0 && PREFIXES.has((words[at - 1] ?? '').toLowerCase()) && (words[at] ?? '').startsWith('-')))) at++
    const rawCommand = words[at] ?? ''
    const name = rawCommand.replace(/^.*[\\/]/, '').replace(/^microsoft\.powershell\.\w+\\/i, '').toLowerCase()
    const args = words.slice(at + 1)
    const argHit = args.map(arg => firstNamed(arg, files)).find(one => one !== undefined)
    if (WRITERS.has(name) && argHit !== undefined) return { file: argHit, how: rawCommand }
    if (name === 'sed' && args.some(arg => /^-[^-]*i|^--in-place/.test(arg)) && argHit !== undefined) return { file: argHit, how: 'sed -i' }
    if ((name === 'perl' || name === 'ruby') && args.some(arg => /^-[^-]*i/.test(arg)) && argHit !== undefined) return { file: argHit, how: `${name} -i` }
    if (name === 'yq' && args.some(arg => /^-[^-]*i|^--inplace/.test(arg)) && argHit !== undefined) return { file: argHit, how: 'yq -i' }
    if (/^g?awk$/.test(name) && args.some((arg, i) => arg === '--inplace' || (arg === '-i' && args[i + 1] === 'inplace')) && argHit !== undefined) return { file: argHit, how: 'awk -i inplace' }
    if (name === 'dd') {
      const out = args.find(arg => /^of=/i.test(arg) && firstNamed(arg, files) !== undefined)
      if (out !== undefined) return { file: firstNamed(out, files) ?? named, how: 'dd of=' }
    }
    if (name === 'git' && args.some(arg => ['checkout', 'restore', 'rm', 'mv', 'apply'].includes(arg)) && argHit !== undefined) return { file: argHit, how: `git ${args.find(arg => ['checkout', 'restore', 'rm', 'mv', 'apply'].includes(arg))}` }
    if (name === 'find' && args.some(arg => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(arg)) && argHit !== undefined) return { file: argHit, how: 'find -delete or -exec' }
    if (INTERPRETERS.test(name)) {
      const codeAt = args.findIndex(arg => /^(-c|-e|-E|--eval|-p|--print|-r)$/.test(arg))
      const code = codeAt >= 0 ? (args[codeAt + 1] ?? '') : /^g?awk$/.test(name) ? (args.find(arg => !arg.startsWith('-')) ?? '') : command
      const codeHit = firstNamed(code, files)
      if (codeHit !== undefined && WRITE_MARKERS.test(code)) return { file: codeHit, how: `${name} code that writes it` }
    }
    if (SHELLS.test(name) || name === 'eval') {
      const codeAt = args.findIndex(arg => /^(-c|\/c|\/k)$/i.test(arg))
      const code = name === 'eval' ? args.join(' ') : codeAt >= 0 ? args.slice(codeAt + 1).join(' ') : ''
      const inner = code === '' ? undefined : commandVerdict(code, files, 'bash', depth + 1)
      if (inner !== undefined) return inner
    }
    if (POWERSHELLS.test(name)) {
      const codeAt = args.findIndex(arg => /^-(c|command)$/i.test(arg))
      const inner = codeAt < 0 ? undefined : commandVerdict(args.slice(codeAt + 1).join(' '), files, 'powershell', depth + 1)
      if (inner !== undefined) return inner
    }
  }
  return undefined
}

/** The refusal: the file, the tool to use instead, what was refused, and that reading is fine. */
export function denyText(tool: string, file: ProtectedFile, how: string): string {
  return (
    `session-control: refused by the helper-file guard: ${file.name} is a helper file the mod's tools write; in this session it changes only through the ` +
    `session-control tool ${file.useInstead}, never by hand (${tool}: ${how}). Use ${file.useInstead} instead. Reading it is fine (cat, head, tail, grep, ` +
    `jq without an output redirection); CLAUDE.md, backups/ and reports/ stay editable by hand.`
  )
}
