// The sign-off guard on the orchestrator's own Bash and PowerShell commands: a git force-push, remote branch or tag
// deletion, mirror or pruning push, reset --hard, forced clean or branch -D is refused (signoffVerdict). Pure: no `$`,
// no I/O; register.tsx hooks `tool.call` for Bash and PowerShell in the orchestrator directory's own session and asks
// signoffVerdict.
//
// It reads the command text that runs, as Bash reads it: a heredoc body that only data sinks, an interpreter or xargs
// read and a quoted plain argument are text; substitutions, a heredoc a shell or an unknown command reads and a
// here-string a shell reads are code (segmentsOf, cutHeredocs, substitutionsOf, feedOf). It is a heuristic against
// slips, not a sandbox or a security boundary: an alias, a script file or a command built at run time is not seen.

// ---------------------------------------------------------------- commands (Bash, PowerShell)

type Word = { text: string; isExpanded: boolean; isQuoted: boolean }
/**
 * A segment's words and output redirections; `isPiped` when a single `|` ends it (its output feeds the next segment),
 * `isSubstitution` when it sits inside a `$(...)`, `hereStrings` the words after a `<<<` (also among its words).
 */
type Segment = { words: Word[]; outputs: Word[]; isPiped: boolean; isSubstitution: boolean; hereStrings: string[] }

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

/** Words that run the command after them; the shell's own keywords before a command (`do`, `then`, `if`, ...) too. */
const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time', 'timeout', 'stdbuf', 'xargs', 'busybox', '&', '.', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!'])

/** Interpreters: a heredoc or here-string one of them reads is its code, not a command line. */
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|awk|gawk|mawk|nawk)$/

/** Shells whose -c (PowerShell -Command) text is a command line of its own. */
const SHELLS = /^(bash|sh|dash|zsh|ksh|fish|cmd|cmd\.exe)$/
const POWERSHELLS = /^(powershell|powershell\.exe|pwsh|pwsh\.exe)$/

/**
 * Commands that take a heredoc or a here-string as data: they print, count, filter or store it, never run it. A heredoc
 * whose whole pipeline is made of these is text; `git commit`, `git tag` and `git notes` take one as a message.
 */
const DATA_SINKS = new Set([
  'cat', 'tee', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'fold', 'fmt', 'nl', 'rev', 'column',
  'base64', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'od', 'xxd', 'hexdump', 'strings', 'less', 'more', 'jq', 'diff', 'cmp',
  'echo', 'printf', 'true', ':', 'gh',
])
const GIT_MESSAGES = new Set(['commit', 'tag', 'notes'])

/** A segment's command: the word after its assignments and prefixes (sudo, env, xargs, do, ...), its name as compared, its arguments, and whether xargs feeds it. */
function commandOf(segment: Segment): { raw: string; name: string; args: string[]; isXargs: boolean } {
  const words = segment.words.map(one => one.text)
  let at = 0
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? '') || PREFIXES.has((words[at] ?? '').toLowerCase()) || (at > 0 && PREFIXES.has((words[at - 1] ?? '').toLowerCase()) && (words[at] ?? '').startsWith('-')))) at++
  const raw = words[at] ?? ''
  const name = raw.replace(/^.*[\\/]/, '').replace(/^microsoft\.powershell\.\w+\\/i, '').toLowerCase()
  return { raw, name, args: words.slice(at + 1), isXargs: words.slice(0, at).some(one => one.toLowerCase() === 'xargs') }
}

/**
 * What a heredoc or here-string's text is to the pipeline that reads it, from the segment that holds it to the end of
 * its pipeline: `code` when a shell reads it (checked as a command line), `script` when an interpreter does, `data` when
 * every command is a data sink (DATA_SINKS; git commit, tag, notes), `operands` when xargs turns it into arguments, else
 * `lines`: read as command lines.
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
 * (gitSignoffAction), by its text: heredoc bodies that data sinks, an interpreter or xargs read and quoted arguments are
 * text; `sh -c`, `bash -c`, `eval`, `powershell -Command`, substitutions and a heredoc or here-string a shell reads
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
