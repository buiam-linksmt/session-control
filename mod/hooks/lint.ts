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
 * (`at` to `end`: the flag, the refspec or the force-push word), where the action's words start (`from`: the verb,
 * or `git` before it), which a governing no or without must stand right before, and whether it is a command shape (a
 * verb and its flag) or the force-push words.
 */
type ActionHit = { label: string; at: number; end: number; from: number; isShape: boolean }

// ---------------------------------------------------------------- the sentence index: work that grows with the line

/**
 * The matches of a pattern in a text, in order, as `matchAll` finds them. None of the patterns the guard indexes has two
 * matches that overlap or nest, and each has one match at most at a place, so a later match also ends later.
 */
type Spans = { starts: number[]; ends: number[] }

function spansOf(pattern: RegExp, text: string): Spans {
  const spans: Spans = { starts: [], ends: [] }
  for (const one of text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
    spans.starts.push(one.index ?? 0)
    spans.ends.push((one.index ?? 0) + one[0].length)
  }
  return spans
}

/** The index of the first number of a sorted list that is at least `at`; the list's length when none is. */
function firstFrom(list: readonly number[], at: number): number {
  let low = 0
  let high = list.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((list[mid] ?? 0) < at) low = mid + 1
    else high = mid
  }
  return low
}

/** Whether a match lies inside text[from, to): the first that starts at or after `from` ends by `to`. */
function isSpanInside(spans: Spans, from: number, to: number): boolean {
  const at = firstFrom(spans.starts, from)
  return at < spans.starts.length && (spans.ends[at] ?? 0) <= to
}

/** Whether the character at `at` is a blank (`\s`), ASCII ones read by their code. */
function isBlankAt(text: string, at: number): boolean {
  const code = text.charCodeAt(at)
  return code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(text[at] ?? ''))
}

/** A value computed on its first use, then kept. */
function once<T>(make: () => T): () => T {
  let value: { made: T } | undefined
  return () => (value ??= { made: make() }).made
}

/**
 * What the guard reads of one sentence, each part made once, on its first use: its words (its `\S+` runs), the words
 * joined by one blank as the negation windows join them (and where each word starts there), and the matches of the
 * patterns the windows test. A window is then a range of words, and whether a pattern matches inside it a search among
 * the matches, so the work of the guard grows with the length of a line and not with its square (README, Sign-off guard).
 */
type SentenceIndex = {
  text: string
  words: () => { starts: number[]; ends: number[] }
  joined: () => { text: string; starts: number[] }
  /** CONTRAST, GOVERNING and COMMAND_END over the text. */
  contrasts: () => Spans
  governing: () => Spans
  commandEnds: () => number[]
  /** GUARD_NEGATION, GATE and REFUSAL_BEFORE over the text, and over the joined words; GUARD_NEGATION, GATE and REFUSAL_AFTER over the joined words. */
  before: () => Spans[]
  joinedBefore: () => Spans[]
  joinedAfter: () => Spans[]
  /** The places of the colons, the opening and the closing parentheses. */
  openers: () => { colons: number[]; opens: number[]; closes: number[] }
  /** The list heads of each clause, by where the clause starts (listHeads). */
  heads: Map<number, { colon: number; opens: number[] }>
}

function sentenceIndex(text: string): SentenceIndex {
  const words = once(() => {
    const starts: number[] = []
    const ends: number[] = []
    for (const one of text.matchAll(/\S+/g)) {
      starts.push(one.index ?? 0)
      ends.push((one.index ?? 0) + one[0].length)
    }
    return { starts, ends }
  })
  const joined = once(() => {
    const { starts, ends } = words()
    const parts = starts.map((start, at) => text.slice(start, ends[at]))
    let length = 0
    return { text: parts.join(' '), starts: parts.map(part => (length += part.length + 1) - part.length - 1) }
  })
  const joinedGates = once(() => [spansOf(GUARD_NEGATION, joined().text), spansOf(GATE, joined().text)])
  const places = (mark: RegExp) => [...text.matchAll(mark)].map(one => one.index ?? 0)
  return {
    text,
    words,
    joined,
    contrasts: once(() => spansOf(CONTRAST, text)),
    governing: once(() => spansOf(GOVERNING, text)),
    commandEnds: once(() => spansOf(COMMAND_END, text).starts),
    before: once(() => [spansOf(GUARD_NEGATION, text), spansOf(GATE, text), spansOf(REFUSAL_BEFORE, text)]),
    joinedBefore: once(() => [...joinedGates(), spansOf(REFUSAL_BEFORE, joined().text)]),
    joinedAfter: once(() => [...joinedGates(), spansOf(REFUSAL_AFTER, joined().text)]),
    openers: once(() => ({ colons: places(/:/g), opens: places(/\(/g), closes: places(/\)/g) })),
    heads: new Map(),
  }
}

/** The last `count` words of text[from, to), cut at both ends: where the first starts, and the indexes of the first and the last word. */
function lastWords(ix: SentenceIndex, from: number, to: number, count: number): { start: number; first: number; last: number } | undefined {
  const { starts, ends } = ix.words()
  const last = firstFrom(starts, to) - 1
  if (last < 0 || (ends[last] ?? 0) <= from) return undefined
  let first = last
  while (last - first + 1 < count && first > 0 && (ends[first - 1] ?? 0) > from) first--
  return { start: Math.max(starts[first] ?? 0, from), first, last }
}

/** The first `count` words of text[from, to), cut at both ends: where the last ends, and the indexes of the first and the last word. */
function firstWords(ix: SentenceIndex, from: number, to: number, count: number): { end: number; first: number; last: number } | undefined {
  const { starts, ends } = ix.words()
  const first = firstFrom(ends, from + 1)
  if (first >= starts.length || (starts[first] ?? 0) >= to) return undefined
  let last = first
  while (last - first + 1 < count && last + 1 < starts.length && (starts[last + 1] ?? 0) < to) last++
  return { end: Math.min(ends[last] ?? 0, to), first, last }
}

/** Where a place of the text inside or at the end of word `word` lies in the joined words. */
const joinedAt = (ix: SentenceIndex, word: number, place: number) => (ix.joined().starts[word] ?? 0) + place - (ix.words().starts[word] ?? 0)

// ---------------------------------------------------------------- the actions of a sentence

/** A word that is one of git's options taking its value as the next word (`-C /r`), in any case. */
const GIT_PAIR_OPTION = /^(?:-C|-c|--git-dir|--work-tree)$/i

/** A word that is one of git's options by itself (`--no-pager`, `-C=/r`, `--git-dir=/r`). */
const GIT_OPTION = /^--?[A-Za-z][\w-]*(?:=\S+)?$/i

/** A word that starts with a verb whose flags can make a sign-off action, the verb alone (`push`), and `git` before a blank. */
const VERB_WORD = /^(?:push|reset|clean|branch|worktree)\b/i
const BARE_VERB = /\b(?:push|reset|clean|branch|worktree)\b/gi
const GIT_WORD = /\bgit(?=\s)/gi

/** A verb found: where its match starts (at `git` when git and its options come before the verb), its length, and the verb. */
export type VerbMatch = { index: number; length: number; isGit: boolean; verb: string }

/**
 * The verbs of a sentence, the matches of the pattern `(\bgit<options>\s+)?\b(push|reset|clean|branch|worktree)\b` (flags gi)
 * one after the other, where git's options before the verb are `-C`, `-c`, `--git-dir` or `--work-tree` with its value
 * as the next word, or one word `--?<letter>[\w-]*(=\S+)?`. The pattern itself backtracks exponentially over a run of
 * such options that leads to no verb (`git -C -C -C ...`); here each word is read once, from the last: the verb its
 * options lead to, an option with a value taking the next word first, as the pattern tries it first.
 */
function verbMatches(ix: SentenceIndex): VerbMatch[] {
  const { text } = ix
  const gits: VerbMatch[] = []
  const starts = [...text.matchAll(GIT_WORD)].map(one => one.index ?? 0)
  if (starts.length > 0) {
    const words = ix.words()
    const leadsTo = new Int32Array(words.starts.length + 2).fill(-1)
    for (let at = words.starts.length - 1; at >= 0; at--) {
      const word = text.slice(words.starts[at], words.ends[at])
      if (GIT_PAIR_OPTION.test(word) && (leadsTo[at + 2] ?? -1) >= 0) leadsTo[at] = leadsTo[at + 2] ?? -1
      else if (GIT_OPTION.test(word)) leadsTo[at] = leadsTo[at + 1] ?? -1
      else if (VERB_WORD.test(word)) leadsTo[at] = at
    }
    for (const start of starts) {
      const verbAt = leadsTo[firstFrom(words.starts, start + 3)] ?? -1
      if (verbAt < 0) continue
      const verbStart = words.starts[verbAt] ?? 0
      const verb = VERB_WORD.exec(text.slice(verbStart, words.ends[verbAt]))?.[0] ?? ''
      gits.push({ index: start, length: verbStart + verb.length - start, isGit: true, verb: verb.toLowerCase() })
    }
  }
  const bare = spansOf(BARE_VERB, text)
  const matches: VerbMatch[] = []
  let from = 0
  let git = 0
  let alone = 0
  for (;;) {
    while (git < gits.length && (gits[git]?.index ?? 0) < from) git++
    while (alone < bare.starts.length && (bare.starts[alone] ?? 0) < from) alone++
    const withGit = gits[git]
    const start = bare.starts[alone]
    if (withGit !== undefined && (start === undefined || withGit.index < start)) {
      matches.push(withGit)
      from = withGit.index + withGit.length
    } else if (start !== undefined) {
      const end = bare.ends[alone] ?? 0
      matches.push({ index: start, length: end - start, isGit: false, verb: text.slice(start, end).toLowerCase() })
      from = end
    } else return matches
  }
}

/** The verbs of a sentence (verbMatches). */
export const verbsOf = (sentence: string) => verbMatches(sentenceIndex(sentence))

/** The words force-push, force push, force-pushes, force-pushing; a past form (force-pushed) describes, it never matches. */
const FORCE_PUSH_WORDS = /\bforce[- ]?push(?:es|ing)?\b(?!-)/gi

/**
 * A past or passive form right before a verb or the force-push word (`was reset --hard`, the pattern
 * `\b(?:was|were|been|being|had)\s+$` on the text before it): it describes, it does not instruct. Read from the blanks
 * before the place and the word before them only.
 */
const PAST_WORD = /\b(?:was|were|been|being|had)$/i

function isPastBefore(text: string, at: number): boolean {
  let blank = at
  while (blank > 0 && isBlankAt(text, blank - 1)) blank--
  return blank < at && PAST_WORD.test(text.slice(Math.max(0, blank - 6), blank))
}

/**
 * Where one command's words end in a sentence: a quote, a backtick, a parenthesis, a separator, a punctuation mark
 * before a blank, or a word that starts another clause, so the `-f` of `then make -f` or `and tail -f` is no git flag.
 */
const COMMAND_END = /[`"'()|;&]|[,.!?:](?=\s|$)|\s(?:then|and|or|after|before|when|if|so|but|until|while|once|unless|except)\b/i

/** A short option cluster (`-fu`, `-df`) that holds a letter. */
const hasLetter = (word: string, letter: string) => /^-[a-zA-Z]+$/.test(word) && word.slice(1).includes(letter)

/** A `--force-with-lease` flag, bare or with `=` and a value (`^--force-with-lease(?:=\S*)?$` on a word, which holds no blank). */
const isLease = (word: string) => word.startsWith('--force-with-lease') && (word.length === 18 || word[18] === '=')

type Word = { word: string; at: number }

/**
 * The words of the command after a verb, each with its place in the sentence: at most 12, up to COMMAND_END. A word
 * that starts with no `-`, `+` or `:` is no flag and no refspec: only its first character is kept.
 */
function commandWords(ix: SentenceIndex, from: number): Word[] {
  const ends = ix.commandEnds()
  const stop = ends[firstFrom(ends, from)] ?? ix.text.length
  const words = ix.words()
  const out: Word[] = []
  for (let at = firstFrom(words.ends, from + 1); at < words.starts.length && (words.starts[at] ?? 0) < stop && out.length < 12; at++) {
    const start = Math.max(words.starts[at] ?? 0, from)
    const end = '-+:'.includes(ix.text[start] ?? '') ? Math.min(words.ends[at] ?? 0, stop) : start + 1
    out.push({ word: ix.text.slice(start, end), at: start })
  }
  return out
}

/**
 * The sign-off actions of the command a verb match found (verbMatches). A short flag cluster (`-f`, `-d`, `-fd`) counts only after
 * `git` (a `-f` after make, tail or rm is no git flag), and so does every flag of clean (clean is an English word);
 * a long flag (`--force`, `--force-with-lease`, `--delete`, `--mirror`, `--prune`, `--hard`), a refspec (`+ref`,
 * `:ref`) and branch's `-D` count after the bare verb too. A worktree's flag counts only after its subcommand remove,
 * the command's first word (`git worktree remove --force x`, `git worktree remove -f x`).
 */
function verbActions(ix: SentenceIndex, match: VerbMatch): ActionHit[] {
  const { isGit, verb } = match
  const from = match.index
  if (!isGit && isPastBefore(ix.text, from)) return []
  const words = commandWords(ix, from + match.length)
  const hits: ActionHit[] = []
  const add = (label: string, one: Word | undefined) => {
    if (one !== undefined) hits.push({ label, at: one.at, end: one.at + one.word.length, from, isShape: true })
  }
  const first = (test: (word: string) => boolean) => words.find(one => test(one.word))
  if (verb === 'push') {
    add('a force-push', first(w => w === '--force' || isLease(w) || /^\+[\w./:@^~-]+$/.test(w) || (isGit && hasLetter(w, 'f'))))
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
  if (verb === 'worktree' && words[0] !== undefined && /^remove(?![\w-])/i.test(ix.text.slice(words[0].at, words[0].at + 7))) {
    add('a forced worktree remove', words.slice(1).find(one => one.word === '--force' || (isGit && hasLetter(one.word, 'f'))))
  }
  return hits
}

/** The sign-off actions a sentence names, by their words and by their git flags. */
function actionsOf(ix: SentenceIndex): ActionHit[] {
  const hits: ActionHit[] = []
  for (const match of ix.text.matchAll(FORCE_PUSH_WORDS)) {
    const at = match.index ?? 0
    if (!isPastBefore(ix.text, at)) hits.push({ label: 'a force-push', at, end: at + match[0].length, from: at, isShape: false })
  }
  for (const match of verbMatches(ix)) hits.push(...verbActions(ix, match))
  return hits
}

/** A word every action (FORCE_PUSH_WORDS, verbMatches) and every PROTECTED_PUSH match holds. */
const ACTION_WORD = /push|reset|clean|branch|worktree/i

/** A push to main or develop named in a sentence: warned, since the project's push policy decides whether it needs a go-ahead. */
const PROTECTED_PUSH = /\bpush(?:es|ed|ing)?\b[^\n]{0,80}?\b(main|develop)\b|\b(main|develop)\b[^\n]{0,40}?\bpush(?:es|ed|ing)?\b/gi

/**
 * A negation that covers an action in its window: not (do not, must not, may NOT), never, nothing, neither, nor,
 * don't, doesn't, mustn't, shan't, shouldn't, won't, cannot, can't, refrain, avoid, forbidden, prohibited,
 * disallowed, stop before. No and without count only when they govern the action (GOVERNING); a go-ahead or a
 * sign-off counts only as a gate (GATE).
 */
const GUARD_NEGATION = /(?<![\w-])(?:not|never|nothing|neither|nor|(?:don|doesn|mustn|shan|shouldn|won|can)['’]t|cannot|refrain|avoid|forbidden|prohibited|disallowed)(?![\w-])|\bstop before\b/i

/**
 * A phrase that reads as a negation and is none (don't forget to, do not fail to, never skip, why not): a command shape
 * reads its negation with these blanked out, so `Don't forget to run git push --force` is no negation of the push.
 */
const NOT_A_NEGATION = /(?<![\w-])(?:(?:don['’]t|do\s+not|never|not|cannot|can['’]t|won['’]t|shouldn['’]t|mustn['’]t)\s+(?:forget(?:ting)?|fail|neglect|omit|skip|hesitate)|why\s+not)(?![\w-])/gi

/** A text with NOT_A_NEGATION's phrases blanked, each character a blank, so every place stays where it was. */
const withoutFalseNegations = (text: string) => text.replace(NOT_A_NEGATION, part => ' '.repeat(part.length))

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
/** A contrast word that ends a text, or starts it (of a bounded slice of the text: the longest word has 9 letters). */
const CONTRAST_AT_END = new RegExp(`${CONTRAST_WORDS}$`, 'i')
const CONTRAST_AT_START = new RegExp(`^${CONTRAST_WORDS}`, 'i')

/** The negation window, counted from the action's token (the flag, the refspec, the force-push word): this many words before it, this many after, in its sentence. */
export const NEGATION_WORDS_BEFORE = 20
export const NEGATION_WORDS_AFTER = 6

/** Whether a text holds a negation, a gate or a refusal word before an action. */
const negatesBefore = (text: string) => GUARD_NEGATION.test(text) || GATE.test(text) || REFUSAL_BEFORE.test(text)

/**
 * Whether an action is an item of a negated list: a colon or an opening parenthesis whose 8 words before hold a
 * negation, a gate or a refusal word (`never: force-push, reset --hard, branch -D`, `need the user's go-ahead (...,
 * force-push, ...`), the parenthesis not closed before the action. `text` runs from the last contrast word to the token.
 * What isNegatedAt reads where the index cannot answer (isNegatedAtBySlices).
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
  return negatedAt(sentenceIndex(sentence), start, end, from)
}

/**
 * isNegatedAt read on slices of the sentence, each window cut out and tested again: its work grows with the square of
 * the sentence. negatedAt reads the same through the sentence's index, and comes here only at the two edges where a
 * window can hold a match that the whole sentence does not (NEGATION_TAIL); no action the guard finds stands at one.
 */
export function isNegatedAtBySlices(sentence: string, start: number, end: number, from: number): boolean {
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

/** The last word of a match of GUARD_NEGATION, GATE or REFUSAL_BEFORE, at the end of a text (of its last 12 characters). */
const NEGATION_TAIL = /(?:not|never|nothing|neither|nor|n['’]t|cannot|refrain|avoid|forbidden|prohibited|disallowed|before|go-ahead|sign-?off|approval|permission|consent|items?|list|actions?|refuse[sd]?|refusing|refusal|deny|denies|denied|denial|reject(?:s|ed|ing)?)$/i

/** A no or without that ends a text (GOVERNING). */
const GOVERNING_AT_END = /(?<![\w-])(?:no|without)$/i

/**
 * isNegatedAt through the sentence's index: the same windows, each a range of words, each test a search among the
 * matches of its pattern. A window ends where a match of the whole sentence would end too, except right before a
 * letter, a digit, `_` or `-` (a match may end there inside the window and not in the sentence): before the token, when
 * the text before it ends with a word a negation, a gate or a refusal ends with, and after the token, when a word goes on
 * through its end; there the slices themselves are read (isNegatedAtBySlices).
 */
function negatedAt(ix: SentenceIndex, start: number, end: number, from: number): boolean {
  const { text } = ix
  const isTokenEdge = /[\w-]/.test(text[start] ?? '') && NEGATION_TAIL.test(text.slice(Math.max(0, start - 12), start))
  const isAfterEdge = /[A-Za-z]/.test(text[end] ?? '') && /[\w-]/.test(text[end - 1] ?? '')
  if (isTokenEdge || isAfterEdge) return isNegatedAtBySlices(text, start, end, from)
  const lo = contrastEndBefore(ix, start)
  if (isListItemAt(ix, lo, start)) return true
  const windowStart = lastWords(ix, lo, start, NEGATION_WORDS_BEFORE)?.start ?? lo
  if (ix.before().some(spans => isSpanInside(spans, windowStart, start))) return true
  if (isGovernedAt(ix, windowStart, from)) return true
  return isNegatedAfter(ix, end)
}

/** Where the last contrast word before `at` ends (the end of the text before it counts as a word's end); 0 when there is none. */
function contrastEndBefore(ix: SentenceIndex, at: number): number {
  if (CONTRAST_AT_END.test(ix.text.slice(Math.max(0, at - 12), at))) return at
  const { ends } = ix.contrasts()
  return ends[firstFrom(ends, at + 1) - 1] ?? 0
}

/**
 * isNegatedListItem of text[lo, start): an opener of the clause from `lo` before `start`, its 8 words before negating
 * (listHeads), the first such colon, or the last such opening parenthesis with no closing one before `start`.
 */
function isListItemAt(ix: SentenceIndex, lo: number, start: number): boolean {
  if (lo >= start) return false
  const heads = listHeads(ix, lo)
  if (heads.colon < start) return true
  const open = heads.opens[firstFrom(heads.opens, start) - 1]
  if (open === undefined) return false
  const { closes } = ix.openers()
  return (closes[firstFrom(closes, open + 1)] ?? Number.POSITIVE_INFINITY) >= start
}

/**
 * The openers of the clause that starts at `lo` (up to the end of the next contrast word) whose 8 words before, from
 * `lo`, hold a negation, a gate or a refusal word: the first such colon, and every such opening parenthesis. Each opener
 * is read once, for its own clause.
 */
function listHeads(ix: SentenceIndex, lo: number): { colon: number; opens: number[] } {
  const known = ix.heads.get(lo)
  if (known !== undefined) return known
  const { ends } = ix.contrasts()
  const clauseEnd = ends[firstFrom(ends, lo + 1)] ?? ix.text.length
  const { colons, opens } = ix.openers()
  const negates = (at: number) => {
    const words = lastWords(ix, lo, at, 8)
    if (words === undefined) return false
    const from = joinedAt(ix, words.first, words.start)
    const to = joinedAt(ix, words.last, Math.min(ix.words().ends[words.last] ?? 0, at))
    return ix.joinedBefore().some(spans => isSpanInside(spans, from, to))
  }
  let colon = Number.POSITIVE_INFINITY
  for (let at = firstFrom(colons, lo); at < colons.length && (colons[at] ?? 0) < clauseEnd; at++) {
    if (negates(colons[at] ?? 0)) {
      colon = colons[at] ?? 0
      break
    }
  }
  const heads = { colon, opens: opens.slice(firstFrom(opens, lo), firstFrom(opens, clauseEnd)).filter(negates) }
  ix.heads.set(lo, heads)
  return heads
}

/**
 * Whether a no or without in text[windowStart, from) governs the action: only the last one can (the gap after an
 * earlier one holds the later one's word), when nothing but up to three of GOVERNED_GAP's words, blanks, quotes and `*`
 * stand between it and `from`.
 */
function isGovernedAt(ix: SentenceIndex, windowStart: number, from: number): boolean {
  if (GOVERNING_AT_END.test(ix.text.slice(Math.max(windowStart, from - 8), from))) return true
  const { starts, ends } = ix.governing()
  const at = firstFrom(ends, from + 1) - 1
  if (at < 0 || (starts[at] ?? 0) < windowStart) return false
  const gapStart = ends[at] ?? 0
  let marks = 0
  for (let place = from; place > gapStart; place--) if (!isBlankAt(ix.text, place - 1) && !'`"\'*'.includes(ix.text[place - 1] ?? '') && ++marks > 24) return false
  const gap = ix.text.slice(gapStart, from).replace(/[`"'*]/g, ' ').trim()
  return gap === '' || GOVERNED_GAP.test(`${gap} `)
}

/** Whether a negation, a gate or a passive refusal stands in the NEGATION_WORDS_AFTER words after `end`, before the next contrast word. */
function isNegatedAfter(ix: SentenceIndex, end: number): boolean {
  const { starts } = ix.contrasts()
  const cut = CONTRAST_AT_START.test(ix.text.slice(end, end + 12)) ? end : (starts[firstFrom(starts, end)] ?? ix.text.length)
  const words = firstWords(ix, end, cut, NEGATION_WORDS_AFTER)
  if (words === undefined) return false
  const from = joinedAt(ix, words.first, Math.max(ix.words().starts[words.first] ?? 0, end))
  const to = joinedAt(ix, words.last, words.end)
  return ix.joinedAfter().some(spans => isSpanInside(spans, from, to))
}

/** The mark that closes a quoted part, by the kind of its opening mark (quoteKind). */
const QUOTE_CLOSES = ['`', '"', '”'] as const

/** The kind of a quoted part a character opens: 0 a backtick, 1 a straight double quote, 2 a curly one; -1 none. */
const quoteKind = (code: number) => (code === 0x60 ? 0 : code === 0x22 ? 1 : code === 0x201c ? 2 : -1)

/**
 * The quoted parts of a line: backtick spans and double-quoted spans, straight or curly, the spans the pattern
 * `` `[^`\n]*`|"[^"\n]*"|“[^”\n]*” `` (flag g) matches: from left to right, an opening mark and the first closing mark
 * of its pair after it, with no line break between; an opening mark with none is no part. The place of the next closing
 * mark of each kind and of the next line break is looked up once and kept while it lies ahead, so the work grows with
 * the length of the line, however many opening marks lack a closing one.
 */
export function quotedSpans(line: string): Spans {
  const spans: Spans = { starts: [], ends: [] }
  const ahead = [-1, -1, -1]
  let newline = -1
  const nextOf = (mark: string, from: number) => {
    const found = line.indexOf(mark, from)
    return found < 0 ? line.length : found
  }
  for (let at = 0; at < line.length; at++) {
    const kind = quoteKind(line.charCodeAt(at))
    if (kind < 0) continue
    if ((ahead[kind] ?? -1) <= at) ahead[kind] = nextOf(QUOTE_CLOSES[kind] ?? '', at + 1)
    if (newline <= at) newline = nextOf('\n', at + 1)
    const stop = ahead[kind] ?? line.length
    if (stop >= newline) continue
    spans.starts.push(at)
    spans.ends.push(stop + 1)
    at = stop
  }
  return spans
}

/** A text with the matches of `pattern` (flag g) that lie inside its quoted parts (`spans`) replaced by `by`. */
function maskInQuoted(text: string, spans: Spans, pattern: RegExp, by: string): string {
  let part = 0
  return text.replace(pattern, (match: string, at: number) => {
    while ((spans.ends[part] ?? Number.POSITIVE_INFINITY) <= at) part++
    return (spans.starts[part] ?? Number.POSITIVE_INFINITY) <= at ? by : match
  })
}

/** A text with its quoted parts (`spans`) blanked out, each character a blank. */
function blankQuoted(text: string, spans: Spans): string {
  const out: string[] = []
  let done = 0
  for (const [at, start] of spans.starts.entries()) {
    const end = spans.ends[at] ?? start
    out.push(text.slice(done, start), ' '.repeat(end - start))
    done = end
  }
  out.push(text.slice(done))
  return out.join('')
}

/** Words that introduce a quoted example: refuse, refused, deny, denied, reject, example, e.g., for instance, form(s), such as, attack. */
const INTRODUCER = /\b(?:refus(?:e|es|ed|ing|al)|den(?:y|ies|ied|ial)|reject(?:s|ed|ing)?|examples?|e\.g\.|for instance|forms?|such as|attacks?)(?![\w-])/i

/** The sentences of a line with their places, split as sentencesOf splits but never inside a quoted part or after e.g. or i.e. */
function sentenceRanges(line: string): { start: number; end: number }[] {
  const masked = maskInQuoted(line, quotedSpans(line), /[.!?;]/g, '_').replace(/\b(?:e\.g|i\.e)\./gi, part => part.replace(/\./g, '_'))
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
 * What the guard reads of one line, each part made once: its quoted parts, the line with them blanked out, and the
 * contrast words of each and the introducing words of the blanked line.
 */
type LineIndex = { line: string; quoted: () => Spans; contrasts: () => Spans; blankContrasts: () => Spans; introducers: () => Spans }

function lineIndex(line: string): LineIndex {
  const quoted = once(() => quotedSpans(line))
  const blanked = once(() => blankQuoted(line, quoted()))
  return {
    line,
    quoted,
    contrasts: once(() => spansOf(CONTRAST, line)),
    blankContrasts: once(() => spansOf(CONTRAST, blanked())),
    introducers: once(() => spansOf(INTRODUCER, blanked())),
  }
}

/**
 * Whether the action token at `at` of a line sits in a quoted example: inside a backtick or quoted part, with an
 * introducing word (INTRODUCER) before that part in its sentence and no contrast word between them, outside quotes.
 */
function isQuotedExample(lx: LineIndex, sentenceStart: number, at: number): boolean {
  const quoted = lx.quoted()
  const part = firstFrom(quoted.starts, at) - 1
  const partStart = quoted.starts[part]
  if (partStart === undefined || at >= (quoted.ends[part] ?? 0) || partStart < sentenceStart) return false
  const contrasts = lx.blankContrasts()
  const last = firstFrom(contrasts.ends, partStart + 1) - 1
  const lo = last >= 0 && (contrasts.starts[last] ?? 0) >= sentenceStart ? (contrasts.ends[last] ?? 0) : sentenceStart
  return isSpanInside(lx.introducers(), lo, partStart)
}

/** Whether a contrast word stands in a line before `at` (the end of the text before it counts as a word's end). */
const hasContrastBefore = (lx: LineIndex, at: number) => (lx.contrasts().ends[0] ?? Number.POSITIVE_INFINITY) <= at || CONTRAST_AT_END.test(lx.line.slice(Math.max(0, at - 12), at))

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

// ---------------------------------------------------------------- a describe block (README, Sign-off guard)

/** A describe block's opening line: up to three blanks, three or more backticks or tildes (group 1), the word describe, nothing else. */
const DESCRIBE_OPEN = /^ {0,3}(`{3,}|~{3,})describe$/

/** A describe block's two fence lines, as the detail of a refusal shows them. */
const DESCRIBE_EXAMPLE = '```describe\n```'

/** The marks a line may close a describe block with: its fence mark and the lookalikes of it. */
const BACKTICK_MARKS = new Set([...'`ˋˊ´‵′`´｀‘’'])
const TILDE_MARKS = new Set([...'~˜⁓∼〜～˷῀'])

/** Whether the character at `at` is an invisible format character (`\p{Cf}`: a zero-width space, say). */
const isFormatAt = (text: string, at: number) => text.charCodeAt(at) > 127 && /\p{Cf}/u.test(text[at] ?? '')

/** The kinds of the lines of a prompt for its describe blocks (describeBlocks). */
const PROSE = 0
const DESCRIBE_OPENING = 1
const DESCRIBED = 2
const DESCRIBE_CLOSING = 3
const DESCRIBE_CLOSING_MORE = 4

/**
 * How a line inside a describe block opened with the marks `run` reads: 0 a line of the block, DESCRIBE_CLOSING its
 * closing line, DESCRIBE_CLOSING_MORE a closing line with more after its marks. A line closes the block when, after any
 * blanks, `>` and format characters, it starts with at least as many marks as `run` of its kind, lookalikes and format
 * characters among them counted as such marks or passed over: wider than a fence's own closing line, so a line a reader
 * may take for the end of the block ends it here too, and never later.
 */
function describeCloseOf(run: string, line: string): number {
  const marks = run.startsWith('`') ? BACKTICK_MARKS : TILDE_MARKS
  let at = 0
  while (at < line.length && (isBlankAt(line, at) || line[at] === '>' || isFormatAt(line, at))) at++
  let count = 0
  for (; at < line.length; at++) {
    if (marks.has(line[at] ?? '')) count++
    else if (!isFormatAt(line, at)) break
  }
  if (count < run.length) return PROSE
  while (at < line.length && isBlankAt(line, at)) at++
  return at === line.length ? DESCRIBE_CLOSING : DESCRIBE_CLOSING_MORE
}

/** Whether an HTML comment is open after a line: its last `<!--` stands after its last `-->`, or neither is on it and one was open before. */
function isCommentAfter(line: string, isOpen: boolean): boolean {
  const open = line.lastIndexOf('<!--')
  if (open >= 0) return line.indexOf('-->', open + 2) < 0
  return isOpen && !line.includes('-->')
}

/**
 * The describe blocks among a prompt's first `ownLines` lines, outside fenced blocks (fenceOpened, fenceCloses) and
 * HTML comments (from a `<!--` that no `-->` follows on its line up to a line that holds `-->`), as one kind per line:
 * a DESCRIBE_OPEN line, its lines, and the first line that closes it (describeCloseOf), all among those lines. A block
 * that no line closes is no describe block: it and every line after it are prose. Each line is read once.
 */
export function describeBlocks(lines: readonly string[], ownLines = Number.POSITIVE_INFINITY): Uint8Array {
  const kinds = new Uint8Array(lines.length)
  const end = Math.min(lines.length, ownLines)
  let fence: string | undefined
  let isComment = false
  for (let index = 0; index < end; index++) {
    const line = lines[index] ?? ''
    if (fence !== undefined) {
      if (fenceCloses(fence, line)) fence = undefined
      continue
    }
    if (isComment) {
      isComment = isCommentAfter(line, true)
      continue
    }
    const run = DESCRIBE_OPEN.exec(line)?.[1]
    if (run !== undefined) {
      let close = index + 1
      let how = PROSE
      while (close < end && (how = describeCloseOf(run, lines[close] ?? '')) === PROSE) close++
      // Not closed: no escape; the rest is one fenced block (a fence's own closing line would close it here too).
      if (close >= end) return kinds
      kinds[index] = DESCRIBE_OPENING
      kinds.fill(DESCRIBED, index + 1, close)
      kinds[close] = how
      index = close
      continue
    }
    fence = fenceOpened(line)
    if (fence === undefined) isComment = isCommentAfter(line, false)
  }
  return kinds
}

/**
 * The Standing go-ahead lines of the decisions file: each line `<id>. [signoff:<class>] <text>` (GRANT_LINE, the
 * marker right after the id) of a section whose heading is STANDING_HEADING, up to the next `#` or `##` heading;
 * a line inside a fenced block is neither a heading nor a go-ahead. A leading byte order mark and CRLF or CR line
 * ends are read as LF. An id counts once, from its first marked line.
 */
export function standingGrants(decisions: string): StandingGrant[] {
  const grants: StandingGrant[] = []
  const ids = new Set<string>()
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
    if (ids.has(id)) continue
    ids.add(id)
    grants.push({ id, actionClass: actionClass as SignoffClass, text })
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
 * A literal branch name, the last word of its line: segments (SEGMENT) joined by one `/`; no `..`, no segment that ends
 * in `.` or `.lock`; never a protected name or release/..., never one whose first segment is reserved (in any case), so
 * a name cannot reach another namespace through git's short ref paths. The segments are read as one run of their
 * characters in which every `/` is followed by a letter or digit: the same names as `SEGMENT(?:/SEGMENT)*`, which the
 * engine reads at a cost per segment, 0.3 s over a 1 MB name of `a/a/...`, against 3 ms.
 */
const NAME = String.raw`(?!${anyOf(RESERVED_SEGMENTS)}(?:/|$))(?!${anyOf(PROTECTED_NAMES)}$)(?!${anyCase('release')}/)(?!.*\.\.)(?!.*\.(?:/|$))(?!.*\.${anyCase('lock')}(?:/|$))(?!.*\/(?:[\/._-]|$))[A-Za-z0-9][A-Za-z0-9._\/-]*`

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

/**
 * One unprotected branch a leased push may name: `feature/` or `bugfix/`, in lower case, then segments (SEGMENT) joined
 * by one `/`, with no `..` and no segment that ends in `.` or `.lock`; read as NAME reads its run, so no wildcard, `:`,
 * `+`, quote, `$` or blank, and never main, develop, master, release/... or hotfix/....
 */
const BRANCH = String.raw`(?:feature|bugfix)\/(?!.*\.\.)(?!.*\.(?:\/|$))(?!.*\.${anyCase('lock')}(?:\/|$))(?!.*\/(?:[\/._-]|$))[A-Za-z0-9][A-Za-z0-9._\/-]*`

/**
 * The force-push line of one unprotected branch: the bare flag, one remote (group 1) and one BRANCH (group 2), bare or
 * as `refs/heads/<branch>`. Kept out of BLOCK_FORMS: it is a form only for a go-ahead whose line covers its branch
 * (coversBranch), and the go-ahead's line need not hold its remote.
 */
export const BRANCH_LEASE_FORM = new RegExp(`^git push --force-with-lease (${REMOTE}) (?:refs/heads/)?(${BRANCH})$`)

/** The words of a go-ahead's line, between blanks, without the quotes, brackets and punctuation around each. */
const tokensOf = (text: string) => text.split(/\s+/).map(word => word.replace(/^[("'`«“‘[{]+/, '').replace(/[)"'`»”’\]},;:.!?]+$/, ''))

/**
 * Whether a go-ahead's line covers a branch of BRANCH_LEASE_FORM: one of its words (tokensOf) is that exact branch, or
 * `feature/*` for a feature branch, `bugfix/*` for a bugfix one. No other wildcard covers anything.
 */
export function coversBranch(text: string, branch: string): boolean {
  const words = new Set(tokensOf(text))
  return words.has(branch) || words.has(`${branch.slice(0, branch.indexOf('/'))}/*`)
}

/** A word of a go-ahead's line (tokensOf) that names a feature or bugfix branch or pattern: a line that holds one is a branch grant. */
const BRANCH_WORD = /^(?:feature|bugfix)\//

/**
 * Where a go-ahead's line names the remotes of a leased push of main: `main` (bare, or in backticks or quotes), ` to `,
 * then the remotes, either in parentheses right after `remote` or `remotes` (up to three of both, the, two, all, named
 * before it; group 1) or as a plain list (group 2), each list `<remote>`, `<remote> and <remote>` or `<remote>, <remote>`.
 */
const MAIN_TO = /(?<![\w/.-])[`"'«“]?main[`"'»”]? to (?:(?:(?:both|the|two|all|named) ){0,3}remotes? \(([^()]*)\)|([A-Za-z0-9][\w.-]*(?:(?:,? and |, )[A-Za-z0-9][\w.-]*)*))/g

/** The end of a clause of a go-ahead's line: `.`, `;`, `:`, `!` or `?` before a blank or the end. */
const CLAUSE_END = /[.;:!?](?=\s|$)/g

/**
 * The remotes a go-ahead's line names for a leased push of main: the lists of its MAIN_TO places, each item without a
 * trailing `.`, but none of a place whose clause holds a negation (GUARD_NEGATION) before `main`. Each clause is read
 * once, so the work is linear in the length of the line.
 */
export function mainRemotes(text: string): Set<string> {
  const remotes = new Set<string>()
  const ends = new RegExp(CLAUSE_END)
  let end = ends.exec(text)
  let read = 0
  let negated = false
  for (const match of text.matchAll(MAIN_TO)) {
    const at = match.index ?? 0
    while (end !== null && end.index < at) {
      read = end.index + 1
      negated = false
      end = ends.exec(text)
    }
    if (!negated) negated = GUARD_NEGATION.test(text.slice(read, at))
    read = at
    if (negated) continue
    for (const item of (match[1] ?? match[2] ?? '').split(/,? and |, /)) remotes.add(item.trim().replace(/\.+$/, ''))
  }
  return remotes
}

/** The class and the remote of a line one form of BLOCK_FORMS or BRANCH_LEASE_FORM takes whole, and the branch of the latter; undefined for any other line. */
function lineForm(line: string): { actionClass: SignoffClass; remote?: string; branch?: string } | undefined {
  for (const one of BLOCK_FORMS) {
    const match = one.form.exec(line)
    if (match !== null) return { actionClass: one.actionClass, ...(match[1] === undefined ? {} : { remote: match[1] }) }
  }
  const branch = BRANCH_LEASE_FORM.exec(line)
  return branch === null ? undefined : { actionClass: 'force-push', remote: branch[1] ?? '', branch: branch[2] ?? '' }
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
 * signoff in any case, also with up to three such marks between sign and off (sign-off, sign off, a lookalike hyphen):
 * the lines the pattern `^[\s>]*[^A-Za-z0-9\s]{3,}\s*sign[^A-Za-z0-9]{0,3}off` (flags iu) matches. In that pattern `>`
 * is in both classes, so it backtracks over a run of `>` in time that grows with the square of the run; here the leading
 * blanks and `>` are skipped first, and MARKS_SIGNOFF, whose quantified classes share no character, reads what follows
 * them, and what follows the last `>` run among them (its `>` are the first marks then).
 */
const MARKS_SIGNOFF = /^[^A-Za-z0-9\s]{3,}\s*sign[^A-Za-z0-9]{0,3}off/iu

export function isNearOpen(line: string): boolean {
  const lead = /^[\s>]*/.exec(line)?.[0].length ?? 0
  let quote = lead
  while (quote > 0 && isBlankAt(line, quote - 1)) quote--
  while (quote > 0 && line[quote - 1] === '>') quote--
  return MARKS_SIGNOFF.test(line.slice(lead)) || (quote < lead && MARKS_SIGNOFF.test(line.slice(quote)))
}

/**
 * The longest line read for a near opening line (isNearOpen): a longer line is no signoff block's opening line, and only
 * the exact test (BLOCK_OPEN) reads it; it is prose or a fence line, as for every other line, so it lifts nothing.
 */
export const NEAR_OPEN_MAX_CHARS = 4096

/** Why a line written as an opening line (isNearOpen) is not one (BLOCK_OPEN), the first reason that applies. */
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
 * that is not one (isNearOpen, on a line of at most NEAR_OPEN_MAX_CHARS characters). An opening line inside another
 * fenced block is no block, and its lines are prose.
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
    if (line.length <= NEAR_OPEN_MAX_CHARS && isNearOpen(line.replace(/\p{Cf}/gu, ''))) return { blocks, broken: { index, why: `is written as a signoff block's opening line but is not exactly \`\`\`signoff <id>: ${nearOpenFault(line)}` } }
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
 * more than BLOCK_MAX_LINES lines, or, at its first such line, a line no form takes whole (BLOCK_FORMS,
 * BRANCH_LEASE_FORM), a line of the other class, a leased push of main to a remote the go-ahead's line does not hold as a
 * word, under a line that names a feature or bugfix branch (BRANCH_WORD) or to a remote the line does not name for main
 * (mainRemotes), or a leased push of a branch that line does not cover (coversBranch, read as no form of the class).
 * Undefined when nothing is.
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
    if (form.branch !== undefined) {
      if (!coversBranch(grant.text, form.branch)) return `${where} is not one command in a form of the ${grant.actionClass} class`
      continue
    }
    if (form.remote !== undefined && form.actionClass === 'force-push') {
      if (!holdsWord(grant.text, form.remote)) return `${where} pushes to ${form.remote}, a word the line of ${block.id} does not hold`
      if (tokensOf(grant.text).some(word => BRANCH_WORD.test(word))) return `${where} pushes main, and the line of ${block.id} names a feature or bugfix branch`
      if (!mainRemotes(grant.text).has(form.remote)) return `${where} pushes main to ${form.remote}, which the line of ${block.id} does not name after main to (main to <remote>, main to <remote> and <remote>, main to the remotes (<remote> and <remote>)) in a clause with no negation before main`
    }
  }
  return undefined
}

/** What a signoff block's refusal ends with: the forms its lines may take. */
const BLOCK_FORMS_TEXT =
  'a signoff block holds one command per line, nothing else, each of the class of its go-ahead: git push <remote> --delete refs/heads/<name>, git push <remote> :refs/heads/<name> or git branch -d <name> for delete-branch, git push --force-with-lease <remote> main or git push --force-with-lease <remote> <branch> (also refs/heads/<branch>), <branch> one feature/... or bugfix/... branch the go-ahead\'s line names or covers with feature/* or bugfix/*, for force-push (README, Sign-off guard)'

/** The class of the refusal labels a signoff block can cover. */
const CLASS_OF: Readonly<Record<string, SignoffClass>> = { 'a remote branch or tag deletion': 'delete-branch', 'a force-push': 'force-push' }

/** What the refusal of a deletion or a force-push ends with: how a recorded Standing go-ahead is used. */
export const BLOCK_HINT = 'to authorise a class the user has recorded a Standing go-ahead for, write its commands, one per line, in a fenced block whose info line is signoff <id>'

/** What a signoff block allowed: the go-ahead's id, its class and every command of its blocks, in order. */
export type SignoffAllowed = { id: string; actionClass: SignoffClass; commands: string[] }

/**
 * The verdict of the sign-off guard: a refusal, warnings, what signoff blocks allowed, and the detail of a refusal of
 * steps (refusalDetail), which the launch's denial carries after the refusal.
 */
export type SignoffLint = { refusal?: string; detail?: string; warnings: string[]; allowed?: SignoffAllowed[] }

/** The commands of a warning line: all of them up to WARNED_COMMANDS, else that many and how many more. */
const commandsShown = (commands: readonly string[]) =>
  commands.length <= WARNED_COMMANDS ? commands.join('; ') : `${commands.slice(0, WARNED_COMMANDS).join('; ')}; and ${commands.length - WARNED_COMMANDS} more (${commands.length} in all)`

/**
 * The sign-off guard on a worker prompt: each action of the sign-off list (a force-push, a remote branch or tag
 * deletion, a mirror or pruning push, reset --hard, a forced clean, branch -D, a forced worktree remove) that a sentence
 * instructs refuses the launch, naming the actions and their lines, with the detail of what made it (refusalDetail);
 * a push to main or develop warns. An action passes when its sentence negates it (isNegatedAt), when it is an item of a
 * list under a negating head line (isNegatingHead) with no contrast word before it in the item, and when it is a quoted
 * example (isQuotedExample) or a line of a fenced block whose line before holds an introducing word or is a negating
 * head; a command shape reads these negations without false ones (NOT_A_NEGATION). The force-push words of a describe
 * block's lines (describeBlocks) are not read; its command shapes are, as any line's. A skill test is not exempt. A slip
 * guard: it reads words.
 *
 * A signoff block (signoffBlocks) among the first `ownLines` lines, the prompt as given, is checked first, against the
 * Standing go-ahead lines of `standing` (standingGrants; blockFault): a broken block, a decisions file that could not
 * be read or a fault refuses the launch; a block with a line in a describe block is no block. The lines of sound blocks
 * are left out of the check above, recorded and named in one warning line per go-ahead; every other line is checked as
 * above, whatever id it names.
 */
export function signoffLint(prompt: string, standing?: StandingRead, ownLines = Number.POSITIVE_INFINITY): SignoffLint {
  const lines = prompt.split('\n')
  const scan = signoffBlocks(lines, ownLines)
  if (scan.broken !== undefined) return { refusal: `refused by the sign-off guard: line ${scan.broken.index + 1} ${scan.broken.why}; ${BLOCK_FORMS_TEXT}`, warnings: [] }
  const described = describeBlocks(lines, ownLines)
  // A signoff block with a line in a describe block is no block: its lines are read as the describe block's lines.
  const blocks = scan.blocks.filter(block => described[block.open] === PROSE && block.body.every(line => described[line.index] === PROSE))
  const allowed: SignoffAllowed[] = []
  const blockLines = new Set<number>()
  const [first] = blocks
  if (first !== undefined) {
    if (standing === undefined || 'unreadable' in standing) {
      const why = standing === undefined ? 'it was not read' : standing.unreadable
      return { refusal: `refused by the sign-off guard: the signoff block on line ${first.open + 1} cannot be checked: the Standing decisions file could not be read: ${why}`, warnings: [] }
    }
    const grants = standingGrants(standing.text)
    for (const block of blocks) {
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
  const foundKeys = new Set<string>()
  const causes: Cause[] = []
  const causeKeys = new Map<string, number>()
  const warned = new Set<string>()
  // A fenced block (FENCE) and whether it is an example: for the words, and for the command shapes, whose negating head
  // is read without its false negations (`Don't forget:` heads no example of a command).
  let fence: { isExample: boolean; isShapeExample: boolean } | undefined
  // A list under a negating head line, and whether that head negates the command shapes too.
  let list: { headIndent: number; negatesShapes: boolean } | undefined
  let previous = ''
  for (const [index, line] of lines.entries()) {
    const kind = described[index] ?? PROSE
    // The words of a line in a describe block are not read; its command shapes are, as any line's.
    let readsWords = kind !== DESCRIBED
    if (kind !== PROSE) {
      // A describe block's own fence lines touch no fenced block of the lines around it; a closing line with more on it is read.
      if (kind !== DESCRIBED) {
        list = undefined
        previous = ''
        if (kind !== DESCRIBE_CLOSING_MORE) continue
      }
    } else {
      if (FENCE.test(line)) {
        fence = fence === undefined ? { isExample: INTRODUCER.test(previous) || isNegatingHead(previous), isShapeExample: INTRODUCER.test(previous) || isNegatingHead(withoutFalseNegations(previous)) } : undefined
        list = undefined
        previous = ''
        continue
      }
      if (fence?.isShapeExample === true) continue
      if (fence?.isExample === true) readsWords = false
    }
    if (line.trim() === '') {
      list = undefined
      continue
    }
    const bullet = BULLET.exec(line)
    const indent = (/^\s*/.exec(line)?.[0] ?? '').length
    if (list !== undefined && !(bullet !== null ? indent > list.headIndent : indent > Math.max(list.headIndent, 0))) list = undefined
    const isListed = list !== undefined
    const isShapeListed = list?.negatesShapes === true
    // A line of a sound signoff block: its form was matched whole (blockFault), so only the push warning reads it.
    const isBlockLine = blockLines.has(index)
    const lx = lineIndex(line)
    for (const range of sentenceRanges(line)) {
      // Every action and every push to main or develop holds one of these words: a sentence without them names none.
      const sentence = line.slice(range.start, range.end)
      if (!ACTION_WORD.test(sentence)) continue
      const ix = sentenceIndex(sentence)
      // A command shape's negation window reads the sentence without its false negations (don't forget to).
      const shapeIx = once(() => {
        const masked = withoutFalseNegations(sentence)
        return masked === sentence ? ix : sentenceIndex(masked)
      })
      for (const action of isBlockLine ? [] : actionsOf(ix)) {
        if (!action.isShape && !readsWords) continue
        if (negatedAt(action.isShape ? shapeIx() : ix, action.at, action.end, action.from)) continue
        if ((action.isShape ? isShapeListed : isListed) && !hasContrastBefore(lx, range.start + action.at)) continue
        if (isQuotedExample(lx, range.start, range.start + action.at)) continue
        // One cause of each kind per label and line: the shortest text, so a flag two verbs reach is named with the nearer.
        const causeKey = `${action.label}\n${index + 1}\n${action.isShape}`
        const cause = { isShape: action.isShape, text: sentence.slice(action.isShape ? action.from : action.at, action.end), line: index + 1 }
        const known = causeKeys.get(causeKey)
        if (known === undefined) {
          causeKeys.set(causeKey, causes.length)
          causes.push(cause)
        } else if (cause.text.length < (causes[known]?.text.length ?? 0)) causes[known] = cause
        const key = `${action.label}\n${index + 1}`
        if (foundKeys.has(key)) continue
        foundKeys.add(key)
        found.push({ label: action.label, line: index + 1 })
      }
      for (const match of ix.text.matchAll(PROTECTED_PUSH)) {
        const at = match.index ?? 0
        if (!negatedAt(ix, at, at + match[0].length, at)) warned.add((match[1] ?? match[2] ?? '').toLowerCase())
      }
    }
    if (isNegatingHead(line)) list = { headIndent: bullet === null ? -1 : indent, negatesShapes: isNegatingHead(withoutFalseNegations(line)) }
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
    detail: refusalDetail(causes),
    warnings,
  }
}

/** What made a refusal: the force-push words or a command shape, its text and its line. */
type Cause = { isShape: boolean; text: string; line: number }

/** How many causes of each kind the detail of a refusal names before `and N more`. */
const CAUSES_NAMED = 5

/** The longest text of a cause the detail names, in characters, before an ellipsis. */
const CAUSE_MAX_CHARS = 60

/** Causes of one kind, named: each text between `open` and `close` with its line, the first CAUSES_NAMED of them. */
function causesNamed(causes: readonly Cause[], open: string, close: string): string {
  const named = causes.slice(0, CAUSES_NAMED).map(one => {
    const text = one.text.replace(/\s+/g, ' ')
    return `${open}${text.length > CAUSE_MAX_CHARS ? `${text.slice(0, CAUSE_MAX_CHARS)}…` : text}${close} on line ${one.line}`
  })
  return causes.length > CAUSES_NAMED ? `${named.join(', ')} and ${causes.length - CAUSES_NAMED} more` : named.join(', ')
}

/**
 * The detail of a refusal, which the launch's denial carries after it: the force-push words and the command shapes that
 * made it, each with its line, and the way out of each: a describe block for the words (an example of its two fence
 * lines), a signoff block when the action is meant, and quoting that does not help; a negation or a signoff block for a
 * command shape, which a describe block does not lift.
 */
function refusalDetail(causes: readonly Cause[]): string {
  const words = causes.filter(one => !one.isShape)
  const shapes = causes.filter(one => one.isShape)
  const parts: string[] = []
  if (words.length > 0) {
    parts.push(
      `The words ${causesNamed(words, '«', '»')} read as a step. A text that describes the action and asks for none goes in a fenced block whose info string is exactly describe, between these two lines:\n` +
        `${DESCRIBE_EXAMPLE}\n` +
        'the words inside it are not read (its command shapes are); when the action is meant, write its commands in a signoff block instead. Quoting the words alone (backticks, quotes, guillemets) does not help',
    )
  }
  if (shapes.length > 0) {
    parts.push(
      `The command shape ${causesNamed(shapes, '`', '`')} is refused wherever it stands, a describe block included; the ways out are a negation in its sentence (never, do not, stop before) or, for a class the user has recorded a Standing go-ahead for (a remote branch deletion, a leased push), its commands in a signoff block`,
    )
  }
  return parts.join('. ')
}
