// The helper-file edit guard (decision mod-2): in the orchestrator's own session the model never edits the files the
// mod's tools write by hand. HELPER_FILES is the one list of those files, each with where it lives and the tools that
// write it; every tool that writes a helper file registers it here, and tests/guard.test.ts fails when a tool writes a
// file that is neither in this list nor in UNGUARDED_FILES (with its reason). Pure: no `$`, no I/O; register.tsx hooks
// `tool.call` for Edit, Write, MultiEdit, NotebookEdit, Bash and PowerShell and asks pathVerdict or commandVerdict.
//
// The Bash and PowerShell check is a heuristic against slips, not a sandbox or a security boundary; it errs on
// refusing. It reads the command text that runs: a protected file named (by its base name, or a path ending in it)
// together with a construct that writes it is refused; reading commands pass. A heredoc body that only data sinks read
// and a quoted plain argument are text, not commands (decision mod-20); substitutions and a heredoc or here-string a
// shell or an interpreter reads are checked as the code they are. It cannot see what the text does not say: a glob (`task-*.json`, `*.md`), a name built at run time
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

type Word = { text: string; isExpanded: boolean; isQuoted: boolean }
/**
 * A segment's words and output redirections; `isPiped` when a single `|` ends it (its output feeds the next segment),
 * `isSubstitution` when it sits inside a `$(...)`, `hereStrings` the words after a `<<<` (also among its words).
 */
type Segment = { words: Word[]; outputs: Word[]; isPiped: boolean; isSubstitution: boolean; hereStrings: string[] }

/** Whether a word names a file: the word itself, or a path or an assignment (`of=`, `--file=`) ending in it; any case. */
function namesFile(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'i').test(text)
}

/**
 * The words of a command line, split into segments at `;`, `&&`, `||`, `|`, `&`, line breaks and parentheses, with the
 * output redirections of each (`>`, `>>`, `>|`, `&>`, `<>`, a descriptor before them; a duplication such as `2>&1` is
 * none). Quotes go: single quotes keep everything, double quotes and a backslash escape (PowerShell: the backtick)
 * the next character. A word that holds `$` or a backtick substitution outside single quotes is marked expanded, one
 * that a quote contributed to is marked quoted.
 */
function segmentsOf(command: string, isPowerShell: boolean): Segment[] {
  const segments: Segment[] = []
  let words: Word[] = []
  let outputs: Word[] = []
  let hereStrings: string[] = []
  let word = ''
  let isWord = false
  let isExpanded = false
  let isQuoted = false
  let pendingOutput = false
  let pendingHere = false
  // Per open parenthesis: whether it opened a `$(...)`.
  const parens: boolean[] = []
  const escape = isPowerShell ? '`' : '\\'
  const flush = () => {
    if (!isWord) return
    const one = { text: word, isExpanded, isQuoted }
    if (pendingOutput) {
      outputs.push(one)
      pendingOutput = false
    } else {
      words.push(one)
      if (pendingHere) hereStrings.push(word)
    }
    pendingHere = false
    word = ''
    isWord = false
    isExpanded = false
    isQuoted = false
  }
  const endSegment = (isPiped = false) => {
    flush()
    pendingOutput = false
    pendingHere = false
    if (words.length > 0 || outputs.length > 0) segments.push({ words, outputs, isPiped, isSubstitution: parens.includes(true), hereStrings })
    words = []
    outputs = []
    hereStrings = []
  }
  for (let at = 0; at < command.length; at++) {
    const char = command[at] ?? ''
    const next = command[at + 1] ?? ''
    if (char === "'") {
      const end = command.indexOf("'", at + 1)
      const stop = end < 0 ? command.length : end
      word += command.slice(at + 1, stop)
      isWord = true
      isQuoted = true
      at = stop
      // PowerShell doubles a quote inside single quotes.
      if (isPowerShell && command[stop + 1] === "'") word += "'"
      continue
    }
    if (char === '"') {
      isWord = true
      isQuoted = true
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
    if (!isPowerShell && char === '<' && next === '<' && command[at + 2] === '<') {
      // A here-string: the next word is the command's standard input; it stays among the words, as before.
      flush()
      words.push({ text: '<<<', isExpanded: false, isQuoted: false })
      pendingHere = true
      at += 2
      continue
    }
    if (char === '\n' || char === ';' || char === '(' || char === ')' || char === '{' || char === '}' || char === '|' || (char === '&' && next !== '>')) {
      if (char === '&' && command[at - 1] === '>') {
        word += char
        isWord = true
        continue
      }
      const isSubstitutionOpen = char === '(' && word.endsWith('$')
      endSegment(char === '|' && next !== '|')
      if (char === '(') parens.push(isSubstitutionOpen)
      if (char === ')') parens.pop()
      if ((char === '|' || char === '&') && next === char) at++
      continue
    }
    if (char === '>' || (char === '<' && next === '>') || (char === '&' && next === '>') || (char === '*' && next === '>' && !isWord)) {
      // A descriptor right before (2>, *>) belongs to the operator; a word before it ends.
      if (isWord && !/^\d+$/.test(word)) flush()
      word = ''
      isWord = false
      isExpanded = false
      isQuoted = false
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

// ---------------------------------------------------------------- heredocs and substitutions (Bash)

/**
 * A heredoc cut out of a command: its body, whether its delimiter was quoted (`<<'X'`, `<<"X"`, `<<\X`: the body is
 * literal text, nothing in it runs) and the mark its operator left in the command's text, a word of its own.
 */
type Heredoc = { body: string; isQuoted: boolean; mark: string }

const heredocMark = (index: number) => `\u0002${index}\u0003`

/**
 * A Bash command with its heredoc bodies cut out: each `<<X`, `<<-X`, `<<'X'` or `<<"X"` outside quotes, a comment and
 * an arithmetic `((...))` (where `<<` is a shift) becomes a mark word, and its body (the lines after the line that holds
 * the operator, up to the line that is exactly the delimiter, after leading tabs with `<<-`; to the end when none is)
 * is taken out, as Bash reads it. A `<<<` here-string stays. A command that holds the mark's own characters is left
 * whole, its bodies read as command lines as before.
 */
export function cutHeredocs(command: string): { text: string; heredocs: Heredoc[] } {
  if (/[\u0002\u0003]/.test(command)) return { text: command, heredocs: [] }
  const heredocs: Heredoc[] = []
  const pending: { delimiter: string; isQuoted: boolean; isTabbed: boolean; mark: string }[] = []
  let out = ''
  let quote = ''
  let arithmetic = 0
  let isWordStart = true
  for (let at = 0; at < command.length; at++) {
    const char = command[at] ?? ''
    const next = command[at + 1] ?? ''
    if (quote === "'") {
      out += char
      if (char === "'") quote = ''
      continue
    }
    if (quote === '"') {
      out += char
      if (char === '\\' && next !== '') {
        out += next
        at++
      } else if (char === '"') quote = ''
      continue
    }
    if (char === '\\' && next !== '') {
      out += char + next
      at++
      isWordStart = false
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      out += char
      isWordStart = false
      continue
    }
    if (char === '#' && isWordStart) {
      const end = command.indexOf('\n', at)
      const stop = end < 0 ? command.length : end
      out += command.slice(at, stop)
      at = stop - 1
      continue
    }
    if (char === '(' && next === '(') {
      arithmetic++
      out += '(('
      at++
      isWordStart = true
      continue
    }
    if (char === ')' && next === ')' && arithmetic > 0) {
      arithmetic--
      out += '))'
      at++
      isWordStart = false
      continue
    }
    if (char === '<' && next === '<' && command[at + 2] === '<') {
      out += '<<<'
      at += 2
      isWordStart = true
      continue
    }
    if (char === '<' && next === '<' && arithmetic === 0) {
      let end = at + 2
      const isTabbed = command[end] === '-'
      if (isTabbed) end++
      while (command[end] === ' ' || command[end] === '\t') end++
      let delimiter = ''
      let isQuoted = false
      while (end < command.length && !/[\s;&|<>()]/.test(command[end] ?? '')) {
        const one = command[end] ?? ''
        if (one === "'" || one === '"') {
          isQuoted = true
          const close = command.indexOf(one, end + 1)
          const stop = close < 0 ? command.length : close
          delimiter += command.slice(end + 1, stop)
          end = stop + 1
          continue
        }
        if (one === '\\') {
          isQuoted = true
          delimiter += command[end + 1] ?? ''
          end += 2
          continue
        }
        delimiter += one
        end++
      }
      if (delimiter === '') {
        out += '<<'
        at++
        continue
      }
      const mark = heredocMark(heredocs.length + pending.length)
      pending.push({ delimiter, isQuoted, isTabbed, mark })
      out += ` ${mark} `
      at = end - 1
      isWordStart = true
      continue
    }
    if (char === '\n' && pending.length > 0) {
      out += '\n'
      let from = at + 1
      for (const one of pending) {
        const lines: string[] = []
        while (from < command.length) {
          const end = command.indexOf('\n', from)
          const stop = end < 0 ? command.length : end
          const line = command.slice(from, stop)
          from = stop + 1
          if ((one.isTabbed ? line.replace(/^\t+/, '') : line) === one.delimiter) break
          lines.push(line)
        }
        heredocs.push({ body: lines.join('\n'), isQuoted: one.isQuoted, mark: one.mark })
      }
      pending.length = 0
      at = from - 1
      isWordStart = true
      continue
    }
    out += char
    isWordStart = /[\s;&|()<>]/.test(char)
  }
  // An operator on the last line has no body.
  for (const one of pending) heredocs.push({ body: '', isQuoted: one.isQuoted, mark: one.mark })
  return { text: out, heredocs }
}

/**
 * The command texts that run inside a text: each `$(...)` (not an arithmetic `$((...))`) and each backtick pair outside
 * single quotes, in double quotes too; with `isBody` (an unquoted heredoc's body) quotes are literal text, so every one
 * counts. Nested ones are found when the inner text is checked in turn.
 */
export function substitutionsOf(text: string, isBody = false): string[] {
  const found: string[] = []
  let isDouble = false
  for (let at = 0; at < text.length; at++) {
    const char = text[at] ?? ''
    if (char === '\\') {
      at++
      continue
    }
    if (!isBody && char === "'" && !isDouble) {
      const end = text.indexOf("'", at + 1)
      at = end < 0 ? text.length : end
      continue
    }
    if (!isBody && char === '"') {
      isDouble = !isDouble
      continue
    }
    if (char === '$' && text[at + 1] === '(' && text[at + 2] !== '(') {
      let depth = 0
      let end = at + 1
      for (; end < text.length; end++) {
        const one = text[end]
        if (one === '\\') end++
        else if (one === '(') depth++
        else if (one === ')' && --depth === 0) break
      }
      found.push(text.slice(at + 2, end))
      at = end
      continue
    }
    if (char === '`') {
      let end = at + 1
      while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1
      found.push(text.slice(at + 1, end))
      at = end
    }
  }
  return found
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

/** Words that run the command after them; the shell's own keywords before a command (`do`, `then`, `if`, ...) too. */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time', 'timeout', 'stdbuf', 'xargs', 'busybox', '&', '.', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!'])

/** Interpreters whose one-liners (-c, -e) can open a file for writing. */
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|awk|gawk|mawk|nawk)$/

/** Shells whose -c (PowerShell -Command) text is a command line of its own. */
const SHELLS = /^(bash|sh|dash|zsh|ksh|fish|cmd|cmd\.exe)$/
const POWERSHELLS = /^(powershell|powershell\.exe|pwsh|pwsh\.exe)$/

/**
 * Commands that take a heredoc or a here-string as data: they print, count, filter or store it (tee writes it to the
 * files it is given, which the check of its arguments sees), never run it. A heredoc whose whole pipeline is made of
 * these is text; `git commit`, `git tag` and `git notes` take one as a message.
 */
const DATA_SINKS = new Set([
  'cat', 'tee', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'fold', 'fmt', 'nl', 'rev', 'column',
  'base64', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'od', 'xxd', 'hexdump', 'strings', 'less', 'more', 'jq', 'diff', 'cmp',
  'echo', 'printf', 'true', ':', 'gh',
])
const GIT_MESSAGES = new Set(['commit', 'tag', 'notes'])

/** Commands whose quoted arguments name what the shell keeps (assignments, word lists, code): such a name counts as said. */
const KEEPS_QUOTES = new Set(['export', 'declare', 'local', 'readonly', 'typeset', 'alias', 'let', 'eval', 'read', 'readarray', 'mapfile', 'for', 'select', 'case', 'set', 'source', '.'])

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

/** A segment's command: the word after its assignments and prefixes (sudo, env, xargs, do, ...), its name as compared, its arguments, and whether xargs feeds it. */
function commandOf(segment: Segment): { raw: string; name: string; args: string[]; isXargs: boolean } {
  const words = segment.words.map(one => one.text)
  let at = 0
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '') || PREFIXES.has((words[at] ?? '').toLowerCase()) || (at > 0 && PREFIXES.has((words[at - 1] ?? '').toLowerCase()) && (words[at] ?? '').startsWith('-')))) at++
  const raw = words[at] ?? ''
  const name = raw.replace(/^.*[\\/]/, '').replace(/^microsoft\.powershell\.\w+\\/i, '').toLowerCase()
  return { raw, name, args: words.slice(at + 1), isXargs: words.slice(0, at).some(one => one.toLowerCase() === 'xargs') }
}

/** An interpreter's or a shell's option that takes code in the next argument. */
const CODE_FLAG = /^(-c|-e|-E|--eval|-p|--print|-r|\/c|\/k)$/i

/** Whether a segment runs a script file: an interpreter or a shell given a file and no code, `source` or `.`, or a command by its path (`./fix.sh`). */
function runsScript(segment: Segment): boolean {
  const first = segment.words[0]?.text ?? ''
  const { raw, name, args } = commandOf(segment)
  const isGivenFile = args.some(arg => !arg.startsWith('-') && !arg.startsWith('\u0002')) && !args.some(arg => CODE_FLAG.test(arg))
  return ((INTERPRETERS.test(name) || SHELLS.test(name)) && isGivenFile) || name === 'source' || first === '.' || /^\.{0,2}\//.test(raw)
}

/** Whether a word is an assignment (`NAME=...`, `NAME[i]=...`, `NAME+=...`): what is quoted in it is kept by the shell. */
const isAssignment = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(text)

/**
 * The first protected file the command names outside its quoted plain arguments: an unquoted word, an output target, an
 * assignment, a word of a substitution, a here-string, a quoted word that holds a `$(...)` or a backtick, and every word
 * of a command that keeps its quoted words (KEEPS_QUOTES; printf with -v). A name only inside a quoted argument of any
 * other command (`echo "... task-queue.json ..."`) is data.
 */
function namedOutsideData(segments: readonly Segment[], files: readonly ProtectedFile[]): ProtectedFile | undefined {
  for (const segment of segments) {
    const first = (segment.words[0]?.text ?? '').toLowerCase()
    const isKept = segment.isSubstitution || KEEPS_QUOTES.has(first) || (first === 'printf' && segment.words.some(one => one.text === '-v'))
    for (const word of [...segment.words, ...segment.outputs]) {
      const counts = isKept || !word.isQuoted || segment.outputs.includes(word) || isAssignment(word.text) || /\$\(|`/.test(word.text) || segment.hereStrings.includes(word.text)
      const hit = counts ? firstNamed(word.text, files) : undefined
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** The code rule of an interpreter: code that names a protected file and does something that writes. */
function codeHit(code: string, files: readonly ProtectedFile[]): ProtectedFile | undefined {
  const hit = firstNamed(code, files)
  return hit !== undefined && WRITE_MARKERS.test(code) ? hit : undefined
}

/**
 * What a heredoc or here-string's text is to the pipeline that reads it, from the segment that holds it to the end of
 * its pipeline: `code` when a shell reads it (checked as a command line), `script` when an interpreter does (its code
 * rule), `data` when every command is a data sink (DATA_SINKS; git commit, tag, notes), `operands` when xargs turns it
 * into arguments, else `lines`: read as command lines, as the guard did before it knew heredocs.
 */
function feedOf(segments: readonly Segment[], at: number): { kind: 'code' | 'script' | 'data' | 'operands' | 'lines'; name: string } {
  const chain: Segment[] = []
  for (let index = at; index < segments.length; index++) {
    chain.push(segments[index] as Segment)
    if (!(segments[index] as Segment).isPiped) break
  }
  const commands = chain.map(commandOf)
  const shell = commands.find(one => SHELLS.test(one.name) || POWERSHELLS.test(one.name) || one.name === 'source' || one.name === 'eval')
  if (shell !== undefined) return { kind: 'code', name: shell.raw }
  const interpreter = commands.find(one => INTERPRETERS.test(one.name))
  if (interpreter !== undefined) return { kind: 'script', name: interpreter.raw }
  const xargs = commands.find(one => one.isXargs)
  if (xargs !== undefined) return { kind: 'operands', name: `xargs ${xargs.raw}` }
  const isData = commands.every(one => !one.isXargs && (DATA_SINKS.has(one.name) || (one.name === 'git' && one.args.some(arg => GIT_MESSAGES.has(arg)))))
  return { kind: isData ? 'data' : 'lines', name: commands[0]?.raw ?? '' }
}

/**
 * Whether a Bash or PowerShell command writes a protected file, by its text: a redirection to it (or to a variable while
 * the command names it outside its quoted plain arguments), a writing command or cmdlet given it (tee, mv, cp, rm,
 * truncate, install, ln, editors, Set-Content, Out-File, Add-Content, Remove-Item, Move-Item and the rest of WRITERS),
 * `sed -i`, `perl -i`, `ruby -i`, `awk -i inplace`, `yq -i`, `dd of=`, `git checkout|restore|rm|mv` of it,
 * `find ... -delete|-exec`, an interpreter's code that names it and writes, a .NET file call that names it; and the same
 * inside `sh -c`, `bash -c`, `eval`, `cmd /c`, `powershell -Command`, a `$(...)` or backtick substitution (in double
 * quotes and in an unquoted heredoc too), and a heredoc or here-string a shell or an interpreter reads. A heredoc's body
 * that only data sinks read (`cat > prompt.md <<'EOF'`) is text and is not read for names. Undefined: the command reads
 * it, or names no protected file.
 */
export function commandVerdict(command: string, files: readonly ProtectedFile[], dialect: 'bash' | 'powershell', depth = 0): CommandHit | undefined {
  if (firstNamed(command, files) === undefined || depth > 3) return undefined
  const isPowerShell = dialect === 'powershell'
  if (DOTNET_WRITE.test(command)) {
    const named = firstNamed(command, files)
    if (named !== undefined) return { file: named, how: 'a .NET file call' }
  }
  // A command that also runs a script (a file an interpreter or a shell runs, `source`, `./x`) may run what its heredoc
  // wrote: its heredoc bodies are read as before, as command lines and as the interpreter's code.
  const cut = isPowerShell ? { text: command, heredocs: [] } : cutHeredocs(command)
  const isScriptRun = !isPowerShell && segmentsOf(cut.text, false).some(runsScript)
  const { text, heredocs } = isScriptRun ? { text: command, heredocs: [] } : cut
  const segments = segmentsOf(text, isPowerShell)
  // What runs inside the text: substitutions, and each heredoc as its pipeline reads it.
  if (!isPowerShell) {
    for (const inner of substitutionsOf(text)) {
      const hit = commandVerdict(inner, files, 'bash', depth + 1)
      if (hit !== undefined) return hit
    }
    for (const heredoc of heredocs) {
      if (firstNamed(heredoc.body, files) === undefined) continue
      const at = segments.findIndex(segment => segment.words.some(one => one.text === heredoc.mark))
      const feed = feedOf(segments, Math.max(0, at))
      if (!heredoc.isQuoted) {
        for (const inner of substitutionsOf(heredoc.body, true)) {
          const hit = commandVerdict(inner, files, 'bash', depth + 1)
          if (hit !== undefined) return hit
        }
      }
      if (feed.kind === 'data') continue
      if (feed.kind === 'script') {
        const hit = codeHit(heredoc.body, files)
        if (hit !== undefined) return { file: hit, how: `${feed.name} code that writes it (a heredoc)` }
        continue
      }
      if (feed.kind === 'operands') return { file: firstNamed(heredoc.body, files) as ProtectedFile, how: `a heredoc fed to ${feed.name}` }
      const hit = commandVerdict(heredoc.body, files, 'bash', depth + 1)
      if (hit !== undefined) return hit
    }
  }
  const named = isPowerShell ? firstNamed(command, files) : namedOutsideData(segments, files)
  for (const [index, segment] of segments.entries()) {
    for (const target of segment.outputs) {
      const hit = firstNamed(target.text, files)
      if (hit !== undefined) return { file: hit, how: 'an output redirection (>)' }
      if (target.isExpanded && named !== undefined) return { file: named, how: 'an output redirection to a variable, in a command that names the file' }
    }
    const { raw: rawCommand, name, args } = commandOf(segment)
    const argHit = args.map(arg => firstNamed(arg, files)).find(one => one !== undefined)
    if (WRITERS.has(name) && argHit !== undefined) return { file: argHit, how: rawCommand }
    if (name === 'sed' && args.some(arg => /^-[^-]*i|^--in-place/.test(arg)) && argHit !== undefined) return { file: argHit, how: 'sed -i' }
    if ((name === 'perl' || name === 'ruby') && args.some(arg => /^-[^-]*i/.test(arg)) && argHit !== undefined) return { file: argHit, how: `${name} -i` }
    if (name === 'yq' && args.some(arg => /^-[^-]*i|^--inplace/.test(arg)) && argHit !== undefined) return { file: argHit, how: 'yq -i' }
    if (/^g?awk$/.test(name) && args.some((arg, i) => arg === '--inplace' || (arg === '-i' && args[i + 1] === 'inplace')) && argHit !== undefined) return { file: argHit, how: 'awk -i inplace' }
    if (name === 'dd') {
      const out = args.find(arg => /^of=/i.test(arg) && firstNamed(arg, files) !== undefined)
      if (out !== undefined) return { file: firstNamed(out, files) ?? (argHit as ProtectedFile), how: 'dd of=' }
    }
    if (name === 'git' && args.some(arg => ['checkout', 'restore', 'rm', 'mv', 'apply'].includes(arg)) && argHit !== undefined) return { file: argHit, how: `git ${args.find(arg => ['checkout', 'restore', 'rm', 'mv', 'apply'].includes(arg))}` }
    if (name === 'find' && args.some(arg => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(arg)) && argHit !== undefined) return { file: argHit, how: 'find -delete or -exec' }
    // A here-string a shell or an interpreter reads is code.
    for (const fed of segment.hereStrings) {
      if (firstNamed(fed, files) === undefined) continue
      const feed = feedOf(segments, index)
      if (feed.kind === 'code') {
        const hit = commandVerdict(fed, files, 'bash', depth + 1)
        if (hit !== undefined) return hit
      }
      if (feed.kind === 'script') {
        const hit = codeHit(fed, files)
        if (hit !== undefined) return { file: hit, how: `${feed.name} code that writes it (a here-string)` }
      }
    }
    if (INTERPRETERS.test(name)) {
      const codeAt = args.findIndex(arg => /^(-c|-e|-E|--eval|-p|--print|-r)$/.test(arg))
      // Without a code argument the whole command line, heredoc bodies aside (a heredoc it reads was checked above).
      const code = codeAt >= 0 ? (args[codeAt + 1] ?? '') : /^g?awk$/.test(name) ? (args.find(arg => !arg.startsWith('-')) ?? '') : text
      const hit = codeHit(code, files)
      if (hit !== undefined) return { file: hit, how: `${name} code that writes it` }
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

// ---------------------------------------------------------------- the sign-off guard on the orchestrator's commands

/** What the sign-off guard refused in a command: the git action as written short, and its place on the sign-off list. */
export type SignoffHit = { how: string; what: string }

/** git's own options before the subcommand that take a value as the next word. */
const GIT_OPTION_WITH_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/

/** A short option cluster (`-fu`, `-df`) that holds a letter. */
const hasShort = (arg: string, letter: string) => /^-[a-zA-Z]+$/.test(arg) && arg.slice(1).includes(letter)

/**
 * The sign-off action a git command runs, or undefined: a push with --force, -f, --force-with-lease or a `+` refspec
 * (a force-push), with --delete, -d or a `:ref` refspec (a remote branch or tag deletion), with --mirror (overwrites and
 * deletes remote refs) or --prune (deletes remote branches); reset --hard; clean with -f or --force; branch -D, or
 * -d/--delete with -f/--force.
 */
export function gitSignoffAction(args: readonly string[]): SignoffHit | undefined {
  let at = 0
  while (at < args.length && (args[at] ?? '').startsWith('-')) at += GIT_OPTION_WITH_VALUE.test(args[at] ?? '') ? 2 : 1
  const sub = args[at] ?? ''
  const rest = args.slice(at + 1)
  if (sub === 'push') {
    if (rest.some(arg => arg === '--force' || arg.startsWith('--force-with-lease') || hasShort(arg, 'f') || /^\+./.test(arg))) return { how: 'git push --force', what: 'a force-push or history rewrite' }
    if (rest.some(arg => arg === '--delete' || hasShort(arg, 'd') || /^:./.test(arg))) return { how: 'git push --delete', what: 'deleting a remote branch or tag' }
    if (rest.includes('--mirror')) return { how: 'git push --mirror', what: 'a mirror push, which overwrites and deletes remote refs' }
    if (rest.includes('--prune')) return { how: 'git push --prune', what: 'deleting the remote branches that have no local counterpart' }
  }
  if (sub === 'reset' && rest.includes('--hard')) return { how: 'git reset --hard', what: 'reset --hard over uncommitted work' }
  if (sub === 'clean' && rest.some(arg => arg === '--force' || hasShort(arg, 'f'))) return { how: 'git clean -f', what: 'clean over uncommitted work' }
  if (sub === 'branch') {
    const isDelete = rest.some(arg => arg === '--delete' || hasShort(arg, 'd'))
    const isForce = rest.some(arg => arg === '--force' || hasShort(arg, 'f'))
    if (rest.some(arg => hasShort(arg, 'D')) || (isDelete && isForce)) return { how: 'git branch -D', what: 'branch -D over unpushed work' }
  }
  return undefined
}

/**
 * Whether a Bash or PowerShell command of the orchestrator runs one of the git actions of the sign-off list
 * (gitSignoffAction), read as commandVerdict reads a command: heredoc bodies that data sinks read and quoted arguments
 * are text; `sh -c`, `bash -c`, `eval`, `powershell -Command`, substitutions and a heredoc or here-string a shell reads
 * are code; git's options before the subcommand are passed over.
 */
export function signoffVerdict(command: string, dialect: 'bash' | 'powershell', depth = 0): SignoffHit | undefined {
  if (!/\bgit/i.test(command) || depth > 3) return undefined
  const isPowerShell = dialect === 'powershell'
  const { text, heredocs } = isPowerShell ? { text: command, heredocs: [] } : cutHeredocs(command)
  const segments = segmentsOf(text, isPowerShell)
  if (!isPowerShell) {
    for (const inner of substitutionsOf(text)) {
      const hit = signoffVerdict(inner, 'bash', depth + 1)
      if (hit !== undefined) return hit
    }
    for (const heredoc of heredocs) {
      const at = segments.findIndex(segment => segment.words.some(one => one.text === heredoc.mark))
      const feed = feedOf(segments, Math.max(0, at))
      const inners = [...(heredoc.isQuoted ? [] : substitutionsOf(heredoc.body, true)), ...(feed.kind === 'code' || feed.kind === 'lines' ? [heredoc.body] : [])]
      for (const inner of inners) {
        const hit = signoffVerdict(inner, 'bash', depth + 1)
        if (hit !== undefined) return hit
      }
    }
  }
  for (const [index, segment] of segments.entries()) {
    const { name, args } = commandOf(segment)
    if (name === 'git' || name === 'git.exe') {
      const hit = gitSignoffAction(args)
      if (hit !== undefined) return hit
    }
    for (const fed of segment.hereStrings) {
      if (feedOf(segments, index).kind !== 'code') continue
      const hit = signoffVerdict(fed, 'bash', depth + 1)
      if (hit !== undefined) return hit
    }
    if (SHELLS.test(name) || name === 'eval') {
      const codeAt = args.findIndex(arg => /^(-c|\/c|\/k)$/i.test(arg))
      const code = name === 'eval' ? args.join(' ') : codeAt >= 0 ? args.slice(codeAt + 1).join(' ') : ''
      const inner = code === '' ? undefined : signoffVerdict(code, 'bash', depth + 1)
      if (inner !== undefined) return inner
    }
    if (POWERSHELLS.test(name)) {
      const codeAt = args.findIndex(arg => /^-(c|command)$/i.test(arg))
      const inner = codeAt < 0 ? undefined : signoffVerdict(args.slice(codeAt + 1).join(' '), 'powershell', depth + 1)
      if (inner !== undefined) return inner
    }
  }
  return undefined
}

/** The sign-off guard's refusal of an orchestrator command. */
export function signoffDenyText(tool: string, hit: SignoffHit): string {
  return (
    `session-control: refused by the sign-off guard: ${hit.how} is ${hit.what}, an action on the sign-off list (${tool}). The orchestrator never runs it ` +
    "itself: this repository's rules give pushes and resets to workers, and this one needs the user's go-ahead in this conversation, which the mod cannot see. " +
    'Raise an open point for the go-ahead; with it the user runs the step or says how.'
  )
}
