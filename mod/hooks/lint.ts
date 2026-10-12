// The prompt lint of launch_worker, beside the check of the three items every worker prompt carries
// (missingPromptItems in core.ts): a size cap, the secret scan (secrets.ts) and a missing branch or decision section
// (decision win-22). The size cap and the secret scan refuse; the branch check only warns, in the launch's answer. A
// skill test ("skill test" in the prompt) is exempt from the size cap and the warning, as from the three items; the
// secret scan holds for every prompt, a skill test's too. Pure: no `$`, no I/O.

import { RULES_BLOCK } from './core'
import { findSecrets } from './secrets'

/** The longest prompt a launch takes, in characters. */
export const PROMPT_MAX_CHARS = 60_000

/** The phrase that marks a skill-test prompt (CLAUDE.md, A session that tests a skill). */
export const isSkillTest = (prompt: string) => /skill[- ]test/i.test(prompt)

/** How many secret finds a refusal lists before `and N more`. */
const FINDS_LISTED = 5

/** What a prompt says that asks the worker to commit, push or work on a branch. */
const GIT_WORK = /\b(?:commit(?:s|ted|ting)?|push(?:es|ed|ing)?|branch(?:es)?)\b/i

/**
 * The sentences of a text: split after `.`, `!`, `?` or `;` followed by a blank, and at line breaks; a list item or a
 * heading is a sentence of its own.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map(one => one.trim())
    .filter(one => one !== '')
}

/**
 * A negation in a sentence: no, not (do not, must not, may not), never, nothing, neither, nor, without, don't,
 * doesn't, mustn't, shan't, cannot, can't, refrain, avoid, forbidden, prohibited, disallowed, stop before, a sign-off, a
 * go-ahead. A sentence with one of them counts as saying the worker must not do what it names.
 */
export const NEGATION = /(?<![\w-])(?:no|not|never|nothing|neither|nor|without|don't|doesn't|mustn't|shan't|cannot|can't|refrain|avoid|forbidden|prohibited|disallowed)(?![\w-])|\bstop before\b|\bsign-?off\b|\bgo-ahead\b/i

/**
 * A branch named: the word branch with a name after it in the same sentence (in backticks or quotes, a gitflow name, or
 * main, master, develop), a gitflow name anywhere (`feature/x`), or "create one".
 */
const BRANCH_NAMED = [
  /\bbranch(?:es)?\b[^.\n]{0,80}?(?:`[^`\s]+`|"[^"\s]+"|'[^'\s]+'|\b(?:feature|bugfix|release|hotfix|fix|feat|chore|docs|test)\/[\w./-]+|\b(?:main|master|develop)\b)/i,
  /(?<![\w/])(?:feature|bugfix|release|hotfix)\/[\w.-]+/,
  /\bcreate one\b/i,
]

/** A decision section named: the block a `section` appends, or the decisions file or a section of it named in the text. */
const SECTION_NAMED = /## Binding decisions \(section |agreed-decisions|decision(?:s)? section|section ["'`][^"'`\n]+["'`]/i

export type PromptLint = { refusal?: string; warnings: string[] }

/**
 * The lint of the prompt a launch runs with (the text given, the section's block and the rules block, as composed):
 * a refusal (the first that applies: secrets, then the size), and warnings. A refusal names each secret's kind and line,
 * never its value.
 */
export function promptLint(prompt: string): PromptLint {
  const isSkill = isSkillTest(prompt)
  const finds = findSecrets(prompt)
  if (finds.length > 0) {
    const listed = finds.slice(0, FINDS_LISTED).map(one => `${one.kind} on line ${one.line}`)
    const more = finds.length > FINDS_LISTED ? ` and ${finds.length - FINDS_LISTED} more` : ''
    return {
      refusal: `refused: the prompt holds ${finds.length === 1 ? 'a likely secret' : `${finds.length} likely secrets`} (${listed.join(', ')}${more}); a prompt never carries a credential: name where the worker finds it (an environment variable, a credential helper), never the value`,
      warnings: [],
    }
  }
  if (!isSkill && prompt.length > PROMPT_MAX_CHARS) {
    return {
      refusal: `refused: the prompt has ${prompt.length} characters, the limit is ${PROMPT_MAX_CHARS}: reference a long document by its file path for the worker to read instead of pasting it into the prompt`,
      warnings: [],
    }
  }
  const warnings: string[] = []
  // The rules block mentions commits and branches itself: only the rest of the prompt counts.
  const own = prompt.split(RULES_BLOCK).join('')
  // A mention in a negated sentence ("no commit", "never push") asks for nothing.
  const asksGitWork = sentencesOf(own).some(one => GIT_WORK.test(one) && !NEGATION.test(one))
  if (!isSkill && asksGitWork && !BRANCH_NAMED.some(one => one.test(own)) && !SECTION_NAMED.test(own)) {
    warnings.push('the prompt asks to commit, push or work on a branch but names no branch (an existing one by exact name, or "create one" with its gitflow prefix) and no decision section; the worker may pick one itself')
  }
  return { warnings }
}

// ---------------------------------------------------------------- the sign-off guard on the prompt (README, Sign-off guard)

/**
 * A sign-off action found in a sentence: what the refusal calls it, the token the negation window is measured from
 * (`at` to `end`: the flag, the refspec or the force-push word), and where the action's words start (`from`: the verb,
 * or `git` before it), which a governing no or without must stand right before.
 */
type ActionHit = { label: string; at: number; end: number; from: number }

/** git's own options before the subcommand, as a prompt writes them (`git -C /r push`, `git --no-pager push`). */
const GIT_OPTIONS = String.raw`(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)\S+|\s+--?[A-Za-z][\w-]*(?:=\S+)?)*`

/** A verb whose flags can make a sign-off action, with `git` and its options before it (group 1) or alone. */
const VERB = new RegExp(String.raw`(\bgit${GIT_OPTIONS}\s+)?\b(push|reset|clean|branch)\b`, 'gi')

/** The words force-push, force push, force-pushes, force-pushing; a past form (force-pushed) describes, it never matches. */
const FORCE_PUSH_WORDS = /\bforce[- ]?push(?:es|ing)?\b(?!-)/gi

/** A past or passive form right before a verb or the force-push word (`was reset --hard`): it describes, it does not instruct. */
const PAST_BEFORE = /\b(?:was|were|been|being|had)\s+$/i

/**
 * Where one command's words end in a sentence: a quote, a backtick, a parenthesis, a separator, a punctuation mark
 * before a blank, or a word that starts another clause, so the `-f` of `then make -f` or `and tail -f` is no git flag.
 */
const COMMAND_END = /[`"'()|;&]|[,.!?:](?=\s|$)|\s(?:then|and|or|after|before|when|if|so|but|until|while|once|unless|except)\b/i

/** A short option cluster (`-fu`, `-df`) that holds a letter. */
const hasLetter = (word: string, letter: string) => /^-[a-zA-Z]+$/.test(word) && word.slice(1).includes(letter)

type Word = { word: string; at: number }

/** The words of the command after a verb, each with its place in the sentence: at most 12, up to COMMAND_END. */
function commandWords(sentence: string, from: number): Word[] {
  const rest = sentence.slice(from)
  const stop = rest.search(COMMAND_END)
  return [...(stop < 0 ? rest : rest.slice(0, stop)).matchAll(/\S+/g)].slice(0, 12).map(one => ({ word: one[0], at: from + (one.index ?? 0) }))
}

/**
 * The sign-off actions of the command a VERB match found. A short flag cluster (`-f`, `-d`, `-fd`) counts only after
 * `git` (a `-f` after make, tail or rm is no git flag), and so does every flag of clean (clean is an English word);
 * a long flag (`--force`, `--force-with-lease`, `--delete`, `--mirror`, `--prune`, `--hard`), a refspec (`+ref`,
 * `:ref`) and branch's `-D` count after the bare verb too.
 */
function verbActions(sentence: string, match: RegExpMatchArray): ActionHit[] {
  const isGit = match[1] !== undefined
  const verb = (match[2] ?? '').toLowerCase()
  const from = match.index ?? 0
  if (!isGit && PAST_BEFORE.test(sentence.slice(0, from))) return []
  const words = commandWords(sentence, from + match[0].length)
  const hits: ActionHit[] = []
  const add = (label: string, one: Word | undefined) => {
    if (one !== undefined) hits.push({ label, at: one.at, end: one.at + one.word.length, from })
  }
  const first = (test: (word: string) => boolean) => words.find(one => test(one.word))
  if (verb === 'push') {
    add('a force-push', first(w => w === '--force' || /^--force-with-lease(?:=\S*)?$/.test(w) || /^\+[\w./:@^~-]+$/.test(w) || (isGit && hasLetter(w, 'f'))))
    add('a remote branch or tag deletion', first(w => w === '--delete' || /^:[\w./-]+$/.test(w) || (isGit && hasLetter(w, 'd'))))
    add('a mirror push', first(w => w === '--mirror'))
    add('a pruning push', first(w => w === '--prune'))
  }
  if (verb === 'reset') add('reset --hard', first(w => w === '--hard'))
  if (verb === 'clean' && isGit) add('a forced clean', first(w => w === '--force' || hasLetter(w, 'f')))
  if (verb === 'branch') {
    const upper = words.findIndex(one => (isGit ? hasLetter(one.word, 'D') : one.word === '-D'))
    const remove = words.findIndex(one => one.word === '--delete' || (isGit && hasLetter(one.word, 'd')))
    const force = words.findIndex(one => one.word === '--force' || (isGit && hasLetter(one.word, 'f')))
    const both = remove >= 0 && force >= 0 ? Math.max(remove, force) : -1
    const at = [upper, both].filter(one => one >= 0).sort((a, b) => a - b)[0]
    add('branch -D', at === undefined ? undefined : words[at])
  }
  return hits
}

/** The sign-off actions a sentence names, by their words and by their git flags. */
function actionsOf(sentence: string): ActionHit[] {
  const hits: ActionHit[] = []
  for (const match of sentence.matchAll(FORCE_PUSH_WORDS)) {
    const at = match.index ?? 0
    if (!PAST_BEFORE.test(sentence.slice(0, at))) hits.push({ label: 'a force-push', at, end: at + match[0].length, from: at })
  }
  for (const match of sentence.matchAll(VERB)) hits.push(...verbActions(sentence, match))
  return hits
}

/** A push to main or develop named in a sentence: warned, since the project's push policy decides whether it needs a go-ahead. */
const PROTECTED_PUSH = /\bpush(?:es|ed|ing)?\b[^\n]{0,80}?\b(main|develop)\b|\b(main|develop)\b[^\n]{0,40}?\bpush(?:es|ed|ing)?\b/gi

/**
 * A negation that covers an action in its window: not (do not, must not, may NOT), never, nothing, neither, nor,
 * don't, doesn't, mustn't, shan't, shouldn't, won't, cannot, can't, refrain, avoid, forbidden, prohibited,
 * disallowed, stop before. No and without count only when they govern the action (GOVERNING); a go-ahead or a
 * sign-off counts only as a gate (GATE).
 */
const GUARD_NEGATION = /(?<![\w-])(?:not|never|nothing|neither|nor|(?:don|doesn|mustn|shan|shouldn|won|can)['’]t|cannot|refrain|avoid|forbidden|prohibited|disallowed)(?![\w-])|\bstop before\b/i

/** A gate on the action: it needs or requires the user's go-ahead (sign-off, approval, permission, consent), or is a sign-off item. */
const GATE = /\b(?:needs?|requires?|needing|requiring)\s+(?:(?:the|a|an|explicit|written|prior|their|user['’]s|users['’])\s+){0,3}(?:go-ahead|sign-?off|approval|permission|consent)\b|\b(?:is|are)\s+(?:a\s+|on\s+the\s+)?sign-?off\s+(?:items?|list|actions?)\b/i

/** A refusal word before the action (the guard refuses a force-push) or a passive refusal after it (`... is refused`). */
const REFUSAL_BEFORE = /\b(?:refuse[sd]?|refusing|refusal|deny|denies|denied|denial|reject(?:s|ed|ing)?)\b/i
const REFUSAL_AFTER = /\b(?:is|are|be|being|gets?|got|was|were)\s+(?:refused|denied|rejected)\b/i

/** No and without, which cover an action only when they govern it: nothing but these words between (`no force-push`, `without any git push --force`). */
const GOVERNING = /(?<![\w-])(?:no|without)(?![\w-])/gi
const GOVERNED_GAP = /^(?:(?:any|a|an|the|other|more|further|git|ever|use|using|run|running)\s+){0,3}$/i

/** Words that turn a clause around: a negation on the other side of one does not cover the action. */
const CONTRAST_WORDS = String.raw`\b(?:but|however|then|instead|yet|otherwise|except|unless)\b`
const CONTRAST = new RegExp(CONTRAST_WORDS, 'gi')
const HAS_CONTRAST = new RegExp(CONTRAST_WORDS, 'i')

/** The negation window, counted from the action's token (the flag, the refspec, the force-push word): this many words before it, this many after, in its sentence. */
export const NEGATION_WORDS_BEFORE = 20
export const NEGATION_WORDS_AFTER = 6

/** Whether a text holds a negation, a gate or a refusal word before an action. */
const negatesBefore = (text: string) => GUARD_NEGATION.test(text) || GATE.test(text) || REFUSAL_BEFORE.test(text)

/**
 * Whether an action is an item of a negated list: a colon or an opening parenthesis whose 8 words before hold a
 * negation, a gate or a refusal word (`never: force-push, reset --hard, branch -D`, `need the user's go-ahead (...,
 * force-push, ...`), the parenthesis not closed before the action. `text` runs from the last contrast word to the token.
 */
function isNegatedListItem(text: string): boolean {
  for (const opener of text.matchAll(/[:(]/g)) {
    const at = opener.index ?? 0
    if (opener[0] === '(' && text.indexOf(')', at) >= 0) continue
    if (negatesBefore((text.slice(0, at).match(/\S+/g) ?? []).slice(-8).join(' '))) return true
  }
  return false
}

/**
 * Whether the action whose token is at `start` to `end` of a sentence is said not to be done: a negation
 * (GUARD_NEGATION), a gate (GATE) or a refusal word at most NEGATION_WORDS_BEFORE words before the token or
 * NEGATION_WORDS_AFTER words after it, or a no or without right before the action's words (`from`), or the action an
 * item of a negated list (isNegatedListItem), with no contrast word (but, however, then, instead, yet, otherwise,
 * except, unless) between the two.
 */
export function isNegatedAt(sentence: string, start: number, end: number, from = start): boolean {
  let lo = 0
  for (const one of sentence.slice(0, start).matchAll(CONTRAST)) lo = (one.index ?? 0) + one[0].length
  if (isNegatedListItem(sentence.slice(lo, start))) return true
  const words = [...sentence.slice(lo, start).matchAll(/\S+/g)]
  lo += words[Math.max(0, words.length - NEGATION_WORDS_BEFORE)]?.index ?? 0
  const before = sentence.slice(lo, start)
  if (negatesBefore(before)) return true
  for (const one of sentence.slice(lo, from).matchAll(GOVERNING)) {
    const gap = sentence.slice(lo + (one.index ?? 0) + one[0].length, from).replace(/[`"'*]/g, ' ').trim()
    if (gap === '' || GOVERNED_GAP.test(`${gap} `)) return true
  }
  let after = sentence.slice(end)
  const cut = after.search(CONTRAST)
  if (cut >= 0) after = after.slice(0, cut)
  const afterText = (after.match(/\S+/g) ?? []).slice(0, NEGATION_WORDS_AFTER).join(' ')
  return GUARD_NEGATION.test(afterText) || GATE.test(afterText) || REFUSAL_AFTER.test(afterText)
}

/** The quoted parts of a line: backtick spans and double-quoted spans, straight or curly. */
const QUOTED = /`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g

/** Words that introduce a quoted example: refuse, refused, deny, denied, reject, example, e.g., for instance, form(s), such as, attack. */
const INTRODUCER = /\b(?:refus(?:e|es|ed|ing|al)|den(?:y|ies|ied|ial)|reject(?:s|ed|ing)?|examples?|e\.g\.|for instance|forms?|such as|attacks?)(?![\w-])/i

/** The sentences of a line with their places, split as sentencesOf splits but never inside a quoted part or after e.g. or i.e. */
function sentenceRanges(line: string): { start: number; end: number }[] {
  const masked = line.replace(QUOTED, part => part.replace(/[.!?;]/g, '_')).replace(/\b(?:e\.g|i\.e)\./gi, part => part.replace(/\./g, '_'))
  const ranges: { start: number; end: number }[] = []
  let start = 0
  for (const one of masked.matchAll(/(?<=[.!?;])\s+/g)) {
    ranges.push({ start, end: one.index ?? 0 })
    start = (one.index ?? 0) + one[0].length
  }
  ranges.push({ start, end: line.length })
  return ranges.filter(one => line.slice(one.start, one.end).trim() !== '')
}

/**
 * Whether the action token at `at` of a line sits in a quoted example: inside a backtick or quoted part, with an
 * introducing word (INTRODUCER) before that part in its sentence and no contrast word between them, outside quotes.
 */
function isQuotedExample(line: string, sentenceStart: number, at: number): boolean {
  const part = [...line.matchAll(QUOTED)].find(one => (one.index ?? 0) < at && at < (one.index ?? 0) + one[0].length)
  if (part === undefined || (part.index ?? 0) < sentenceStart) return false
  const lead = line.slice(sentenceStart, part.index).replace(QUOTED, one => ' '.repeat(one.length))
  let lo = 0
  for (const one of lead.matchAll(CONTRAST)) lo = (one.index ?? 0) + one[0].length
  return INTRODUCER.test(lead.slice(lo))
}

/** A list item: a bullet (`-`, `*`, `+`, `•`) or a number (`1.`, `1)`), its indentation in group 1. */
const BULLET = /^(\s*)(?:[-*+•]|\d+[.)])\s+/

/**
 * A line that heads a list it negates: it ends with a colon and its last sentence holds a negation or a gate with no
 * contrast word after it (`You may NOT:`, `Never run these:`, `Forbidden:`).
 */
function isNegatingHead(line: string): boolean {
  const text = line.trim()
  if (!text.endsWith(':')) return false
  const last = sentenceRanges(text).pop()
  const sentence = last === undefined ? '' : text.slice(last.start, last.end)
  let lo = 0
  for (const one of sentence.matchAll(CONTRAST)) lo = (one.index ?? 0) + one[0].length
  return GUARD_NEGATION.test(sentence.slice(lo)) || GATE.test(sentence.slice(lo))
}

/** A code fence line. */
const FENCE = /^\s*(?:```|~~~)/

// ---------------------------------------------------------------- a Standing go-ahead and its signoff block (README, Sign-off guard)

/** The action classes a Standing go-ahead covers, each by the marker its line starts with (`[signoff:delete-branch]`). */
export type SignoffClass = 'delete-branch' | 'force-push'

/** A Standing go-ahead: its decision id, its class and the text of its line after the marker. */
export type StandingGrant = { id: string; actionClass: SignoffClass; text: string }

/** The decisions file as the launch read it, or why it could not be read. */
export type StandingRead = { text: string } | { unreadable: string }

/** A line of a Standing section that carries a marker: `<id>. [signoff:<class>] <text>`. */
const GRANT_LINE = /^([A-Za-z0-9][\w-]*)\.\s+\[signoff:(delete-branch|force-push)\](.*)$/

/** A Standing section's heading, in this case: `## Standing`, `## Standing:...` or `## Standing <text>`. */
const STANDING_HEADING = /^## Standing(?:$|:| +\S)/

/** A heading that ends a section: one or two `#` and a blank (a `###` heading stays inside it). */
const SECTION_HEADING = /^#{1,2}(?:[ \t]|$)/

/** A CommonMark fence line: up to three blanks, three or more backticks or tildes (group 1), the rest (group 2). */
const FENCE_RUN = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** The run of marks a line opens a fenced block with, outside one; a backtick fence's info holds no backtick. */
function fenceOpened(line: string): string | undefined {
  const match = FENCE_RUN.exec(line)
  if (match === null) return undefined
  const [, run = '', info = ''] = match
  return run.startsWith('`') && info.includes('`') ? undefined : run
}

/** Whether a line closes the fenced block `run` opened: the same mark, at least as many, nothing after but blanks. */
function fenceCloses(run: string, line: string): boolean {
  const match = FENCE_RUN.exec(line)
  const [, marks = '', rest = ''] = match ?? []
  return match !== null && marks[0] === run[0] && marks.length >= run.length && rest.trim() === ''
}

/**
 * The Standing go-ahead lines of the decisions file: each line `<id>. [signoff:<class>] <text>` (GRANT_LINE, the
 * marker right after the id) of a section whose heading is STANDING_HEADING, up to the next `#` or `##` heading;
 * a line inside a fenced block is neither a heading nor a go-ahead. A leading byte order mark and CRLF or CR line
 * ends are read as LF. An id counts once, from its first marked line.
 */
export function standingGrants(decisions: string): StandingGrant[] {
  const grants: StandingGrant[] = []
  let isStanding = false
  let fence: string | undefined
  for (const line of decisions.replace(/^\ufeff/, '').split(/\r\n|\r|\n/)) {
    if (fence !== undefined) {
      if (fenceCloses(fence, line)) fence = undefined
      continue
    }
    fence = fenceOpened(line)
    if (fence !== undefined) continue
    if (SECTION_HEADING.test(line)) {
      isStanding = STANDING_HEADING.test(line)
      continue
    }
    const match = isStanding ? GRANT_LINE.exec(line) : null
    if (match === null) continue
    const [, id = '', actionClass = '', text = ''] = match
    if (!grants.some(one => one.id === id)) grants.push({ id, actionClass: actionClass as SignoffClass, text })
  }
  return grants
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a text holds a word exactly: no letter, digit, `_` or `-` right before or after it. */
const holdsWord = (text: string, word: string) => new RegExp(`(?<![\\w-])${escaped(word)}(?![\\w-])`).test(text)

/** A word in any case, one character class per letter (`[mM][aA][iI][nN]`), so a form needs no `i` flag. */
const anyCase = (word: string) => word.replace(/[A-Za-z]/g, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`)
const anyOf = (words: readonly string[]) => `(?:${words.map(anyCase).join('|')})`

/** The branch names a signoff block never deletes, in any case (and release with anything under it). */
const PROTECTED_NAMES = ['main', 'master', 'develop', 'release', 'head']

/** git's first path segments of other namespaces and its special refs, in any case: a name starting with one reaches them through git's short ref paths. */
const RESERVED_SEGMENTS = ['heads', 'tags', 'remotes', 'for', 'pull', 'notes', 'refs', 'changes', 'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']

/** One segment of a name: a letter or digit, then letters, digits, `.`, `_` and `-`. */
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*'

/**
 * A literal branch name, the last word of its line: segments joined by one `/`; no `..`, no segment that ends in `.`
 * or `.lock`; never a protected name or release/..., never one whose first segment is reserved (in any case), so a
 * name cannot reach another namespace through git's short ref paths.
 */
const NAME = String.raw`(?!${anyOf(RESERVED_SEGMENTS)}(?:/|$))(?!${anyOf(PROTECTED_NAMES)}$)(?!${anyCase('release')}/)(?!.*\.\.)(?!.*\.(?:/|$))(?!.*\.${anyCase('lock')}(?:/|$))${SEGMENT}(?:/${SEGMENT})*`

/** A remote: one literal name (no path, no URL), never a protected name or a reserved segment. */
const REMOTE = `(?!(?:${anyOf(PROTECTED_NAMES)}|${anyOf(RESERVED_SEGMENTS)}) )${SEGMENT}`

/**
 * The lines a signoff block takes: one anchored regular expression for each whole line, by class; group 1 is the
 * remote of a push. A remote branch deletion names one remote and one branch as `refs/heads/<name>` (git resolves a bare
 * name against every ref of the remote: with no such branch it deletes a tag or another ref of that name); a local one
 * names a bare `<name>` (git branch looks only among the branches); the leased push takes `main` to one remote, the
 * flag bare, `=main` or `=refs/heads/main`.
 */
export const BLOCK_FORMS: readonly { actionClass: SignoffClass; form: RegExp }[] = [
  { actionClass: 'delete-branch', form: new RegExp(`^git push (${REMOTE}) --delete refs/heads/${NAME}$`) },
  { actionClass: 'delete-branch', form: new RegExp(`^git push (${REMOTE}) :refs/heads/${NAME}$`) },
  { actionClass: 'delete-branch', form: new RegExp(`^git branch -d ${NAME}$`) },
  { actionClass: 'force-push', form: new RegExp(`^git push --force-with-lease(?:=main|=refs/heads/main)? (${REMOTE}) main$`) },
]

/** The class and the remote of a line one form of BLOCK_FORMS takes whole; undefined for any other line. */
function lineForm(line: string): { actionClass: SignoffClass; remote?: string } | undefined {
  for (const one of BLOCK_FORMS) {
    const match = one.form.exec(line)
    if (match !== null) return { actionClass: one.actionClass, ...(match[1] === undefined ? {} : { remote: match[1] }) }
  }
  return undefined
}

/** A signoff block's opening line: three backticks at the start of the line, `signoff`, one blank, the decision id, nothing more. */
const BLOCK_OPEN = /^```signoff ([A-Za-z0-9][\w-]*)$/

/** The line that closes a signoff block: exactly three backticks. */
const BLOCK_CLOSE = '```'

/** The most lines a signoff block holds. */
export const BLOCK_MAX_LINES = 100

/** The most commands of a go-ahead its warning line lists before their count. */
export const WARNED_COMMANDS = 20

/**
 * A line written as a signoff block's opening line, once format characters (a zero-width space) are dropped: three or
 * more marks that are no ASCII letter, digit or blank (backticks, tildes, their lookalikes, after a quote's `>`), then
 * signoff in any case, also with up to three such marks between sign and off (sign-off, sign off, a lookalike hyphen).
 */
const NEAR_OPEN = /^[\s>]*[^A-Za-z0-9\s]{3,}\s*sign[^A-Za-z0-9]{0,3}off/iu

/** Why a line written as an opening line (NEAR_OPEN) is not one (BLOCK_OPEN), the first reason that applies. */
function nearOpenFault(line: string): string {
  if (line.includes('\r')) return 'it ends with a carriage return (a prompt with CRLF line ends holds no signoff block)'
  if (line.includes('\t')) return 'it holds a tab'
  if (/\p{Cf}/u.test(line)) return 'it holds an invisible format character (a zero-width space, say)'
  if (/[^\x20-\x7e]/.test(line)) return 'it holds a character that is not printable ASCII (a lookalike of a backtick, a letter or a blank)'
  if (/^[\s>]/.test(line)) return 'it does not start at the start of the line (an indented or quoted fence)'
  if (!line.startsWith('```')) return 'its fence is not three backticks'
  if (line.startsWith('````')) return 'its fence has more than three backticks'
  if (!line.startsWith('```signoff')) return 'its info line does not start with the word signoff, in lower case, right after the backticks'
  return 'its info line is not exactly the word signoff, one blank and one decision id (no other word, no trailing blank)'
}

/** A signoff block: the decision id its opening line cites, that line's index, and its lines with their indexes. */
type SignoffBlock = { id: string; open: number; body: { text: string; index: number }[] }

/**
 * The signoff blocks among a prompt's first `ownLines` lines, outside fenced blocks (fenceOpened, fenceCloses): an
 * opening line (BLOCK_OPEN) up to the next line of exactly three backticks. Or the first line that breaks the syntax and
 * why: an opening line no such line closes (an unterminated block is no block), or a line written as an opening line
 * that is not one (NEAR_OPEN). An opening line inside another fenced block is no block, and its lines are prose.
 */
function signoffBlocks(lines: readonly string[], ownLines: number): { blocks: SignoffBlock[]; broken?: { index: number; why: string } } {
  const blocks: SignoffBlock[] = []
  const end = Math.min(lines.length, ownLines)
  let fence: string | undefined
  for (let index = 0; index < end; index++) {
    const line = lines[index] ?? ''
    if (fence !== undefined) {
      if (fenceCloses(fence, line)) fence = undefined
      continue
    }
    const id = BLOCK_OPEN.exec(line)?.[1]
    if (id !== undefined) {
      const close = lines.indexOf(BLOCK_CLOSE, index + 1)
      if (close < 0 || close >= end) return { blocks, broken: { index, why: 'opens a signoff block that no line of exactly three backticks closes' } }
      blocks.push({ id, open: index, body: lines.slice(index + 1, close).map((text, at) => ({ text, index: index + 1 + at })) })
      index = close
      continue
    }
    if (NEAR_OPEN.test(line.replace(/\p{Cf}/gu, ''))) return { blocks, broken: { index, why: `is written as a signoff block's opening line but is not exactly \`\`\`signoff <id>: ${nearOpenFault(line)}` } }
    fence = fenceOpened(line)
  }
  return { blocks }
}

/** Whether the first `ownLines` lines of a prompt hold a well-formed signoff block, which the decisions file is read for. */
export function hasSignoffBlock(prompt: string, ownLines = Number.POSITIVE_INFINITY): boolean {
  const scan = signoffBlocks(prompt.split('\n'), ownLines)
  return scan.broken === undefined && scan.blocks.length > 0
}

/**
 * What is wrong with a signoff block, checked against the Standing go-ahead lines: its id on none of them, no line,
 * more than BLOCK_MAX_LINES lines, or, at its first such line, a line no form takes whole (BLOCK_FORMS), a line of the
 * other class, or a leased push to a remote the go-ahead's line does not hold as a word. Undefined when nothing is.
 */
function blockFault(block: SignoffBlock, grants: readonly StandingGrant[]): string | undefined {
  const grant = grants.find(one => one.id === block.id)
  if (grant === undefined) return `${block.id} is on no line of a Standing section as \`${block.id}. [signoff:<class>] <text>\` (the marker right after the id)`
  if (block.body.length === 0) return 'it holds no command'
  if (block.body.length > BLOCK_MAX_LINES) return `it holds ${block.body.length} lines, more than ${BLOCK_MAX_LINES}`
  for (const [at, line] of block.body.entries()) {
    const where = `its line ${at + 1} (line ${line.index + 1} of the prompt)`
    const form = lineForm(line.text)
    if (form === undefined) return `${where} is ${line.text === '' ? 'empty' : `not one command in a form of the ${grant.actionClass} class`}`
    if (form.actionClass !== grant.actionClass) return `${where} is a ${form.actionClass} command, and ${block.id} covers ${grant.actionClass}`
    if (form.remote !== undefined && form.actionClass === 'force-push' && !holdsWord(grant.text, form.remote)) return `${where} pushes to ${form.remote}, a word the line of ${block.id} does not hold`
  }
  return undefined
}

/** What a signoff block's refusal ends with: the forms its lines may take. */
const BLOCK_FORMS_TEXT =
  'a signoff block holds one command per line, nothing else, each of the class of its go-ahead: git push <remote> --delete refs/heads/<name>, git push <remote> :refs/heads/<name> or git branch -d <name> for delete-branch, git push --force-with-lease <remote> main for force-push (README, Sign-off guard)'

/** The class of the refusal labels a signoff block can cover. */
const CLASS_OF: Readonly<Record<string, SignoffClass>> = { 'a remote branch or tag deletion': 'delete-branch', 'a force-push': 'force-push' }

/** What the refusal of a deletion or a force-push ends with: how a recorded Standing go-ahead is used. */
export const BLOCK_HINT = 'to authorise a class the user has recorded a Standing go-ahead for, write its commands, one per line, in a fenced block whose info line is signoff <id>'

/** What a signoff block allowed: the go-ahead's id, its class and every command of its blocks, in order. */
export type SignoffAllowed = { id: string; actionClass: SignoffClass; commands: string[] }

export type SignoffLint = { refusal?: string; warnings: string[]; allowed?: SignoffAllowed[] }

/** The commands of a warning line: all of them up to WARNED_COMMANDS, else that many and how many more. */
const commandsShown = (commands: readonly string[]) =>
  commands.length <= WARNED_COMMANDS ? commands.join('; ') : `${commands.slice(0, WARNED_COMMANDS).join('; ')}; and ${commands.length - WARNED_COMMANDS} more (${commands.length} in all)`

/**
 * The sign-off guard on a worker prompt: each action of the sign-off list (a force-push, a remote branch or tag
 * deletion, a mirror or pruning push, reset --hard, a forced clean, branch -D) that a sentence instructs refuses the
 * launch, naming the actions and their lines; a push to main or develop warns. An action passes when its sentence
 * negates it (isNegatedAt), when it is an item of a list under a negating head line (isNegatingHead) with no contrast
 * word before it in the item, and when it is a quoted example (isQuotedExample) or a line of a fenced block whose
 * line before holds an introducing word or is a negating head. A skill test is not exempt. A slip guard: it reads words.
 *
 * A signoff block (signoffBlocks) among the first `ownLines` lines, the prompt as given, is checked first, against the
 * Standing go-ahead lines of `standing` (standingGrants; blockFault): a broken block, a decisions file that could not
 * be read or a fault refuses the launch. The lines of sound blocks are left out of the check above, recorded and named in
 * one warning line per go-ahead; every other line is checked as above, whatever id it names.
 */
export function signoffLint(prompt: string, standing?: StandingRead, ownLines = Number.POSITIVE_INFINITY): SignoffLint {
  const lines = prompt.split('\n')
  const scan = signoffBlocks(lines, ownLines)
  if (scan.broken !== undefined) return { refusal: `refused by the sign-off guard: line ${scan.broken.index + 1} ${scan.broken.why}; ${BLOCK_FORMS_TEXT}`, warnings: [] }
  const allowed: SignoffAllowed[] = []
  const blockLines = new Set<number>()
  const [first] = scan.blocks
  if (first !== undefined) {
    if (standing === undefined || 'unreadable' in standing) {
      const why = standing === undefined ? 'it was not read' : standing.unreadable
      return { refusal: `refused by the sign-off guard: the signoff block on line ${first.open + 1} cannot be checked: the Standing decisions file could not be read: ${why}`, warnings: [] }
    }
    const grants = standingGrants(standing.text)
    for (const block of scan.blocks) {
      const fault = blockFault(block, grants)
      if (fault !== undefined) return { refusal: `refused by the sign-off guard: the signoff block on line ${block.open + 1} (signoff ${block.id}): ${fault}; ${BLOCK_FORMS_TEXT}`, warnings: [] }
      const actionClass = grants.find(one => one.id === block.id)?.actionClass ?? 'delete-branch'
      const one = allowed.find(each => each.id === block.id)
      const commands = block.body.map(line => line.text)
      if (one === undefined) allowed.push({ id: block.id, actionClass, commands })
      else one.commands.push(...commands)
      for (const line of block.body) blockLines.add(line.index)
    }
  }
  const found: { label: string; line: number }[] = []
  const warned = new Set<string>()
  let fence: { isExample: boolean } | undefined
  let list: { headIndent: number } | undefined
  let previous = ''
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line)) {
      fence = fence === undefined ? { isExample: INTRODUCER.test(previous) || isNegatingHead(previous) } : undefined
      list = undefined
      previous = ''
      continue
    }
    if (fence?.isExample === true) continue
    if (line.trim() === '') {
      list = undefined
      continue
    }
    const bullet = BULLET.exec(line)
    const indent = (/^\s*/.exec(line)?.[0] ?? '').length
    if (list !== undefined && !(bullet !== null ? indent > list.headIndent : indent > Math.max(list.headIndent, 0))) list = undefined
    const isListed = list !== undefined
    // A line of a sound signoff block: its form was matched whole (blockFault), so only the push warning reads it.
    const isBlockLine = blockLines.has(index)
    for (const range of sentenceRanges(line)) {
      const sentence = line.slice(range.start, range.end)
      for (const action of isBlockLine ? [] : actionsOf(sentence)) {
        if (isNegatedAt(sentence, action.at, action.end, action.from)) continue
        if (isListed && !HAS_CONTRAST.test(line.slice(0, range.start + action.at))) continue
        if (isQuotedExample(line, range.start, range.start + action.at)) continue
        if (!found.some(one => one.label === action.label && one.line === index + 1)) found.push({ label: action.label, line: index + 1 })
      }
      for (const match of sentence.matchAll(PROTECTED_PUSH)) {
        const at = match.index ?? 0
        if (!isNegatedAt(sentence, at, at + match[0].length)) warned.add((match[1] ?? match[2] ?? '').toLowerCase())
      }
    }
    if (isNegatingHead(line)) list = { headIndent: bullet === null ? -1 : indent }
    previous = line
  }
  const warnings = [...warned].sort().map(branch => `the prompt names a push to ${branch}: a push to a protected branch needs the user's go-ahead where the project's push policy asks (a Standing decision push-<project>); check it before the worker pushes`)
  if (found.length === 0) {
    if (allowed.length === 0) return { warnings }
    return { warnings: [...warnings, ...allowed.map(one => `sign-off allowed by ${one.id}: ${one.actionClass}: ${commandsShown(one.commands)}`)], allowed }
  }
  const listed = found.map(one => `${one.label} on line ${one.line}`).join(', ')
  const isCoverable = found.some(one => CLASS_OF[one.label] !== undefined)
  return {
    refusal:
      `refused by the sign-off guard: the prompt instructs ${listed} as a step for the worker; that needs the user's go-ahead in this conversation, a sign-off item the mod cannot see. ` +
      'Raise an open point for the go-ahead and launch without the step; with the go-ahead the user runs it or says how, and a prompt may tell the worker to stop before it and report. ' +
      `A sentence that tells the worker not to do it (never, do not, stop before) passes${isCoverable ? `; ${BLOCK_HINT}` : ''}`,
    warnings,
  }
}
