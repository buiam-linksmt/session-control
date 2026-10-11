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

/** The actions on the sign-off list the prompt guard refuses as a step, each with what the refusal calls it. */
/** What may stand between a git verb and its flag: one command's words, no backtick, quote, parenthesis or separator. */
const SPAN = String.raw`[^\n\`'"()|;&]`

const SIGNOFF_ACTIONS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'a force-push', pattern: /\bforce[- ]?push(?:es|ed|ing)?\b/gi },
  { label: 'a force-push', pattern: new RegExp(String.raw`\bpush\b${SPAN}{0,80}?\s(?:--force(?:-with-lease)?(?:=[^\s\`'"]*)?|-[a-zA-Z]*f[a-zA-Z]*|\+[\w./:-]+)(?=[\s\`'",;:.!?)]|$)`, 'gi') },
  { label: 'a remote branch or tag deletion', pattern: new RegExp(String.raw`\bpush\b${SPAN}{0,80}?\s(?:--delete|-[a-zA-Z]*d[a-zA-Z]*)(?=[\s\`'",;:.!?)]|$)`, 'gi') },
  { label: 'a remote branch or tag deletion', pattern: /\bpush\s+(?:-[-\w]*\s+)*[\w.@/-]+\s+:[\w./-]+/gi },
  { label: 'reset --hard', pattern: new RegExp(String.raw`\breset\b${SPAN}{0,40}?\s--hard\b`, 'gi') },
  { label: 'a forced clean', pattern: new RegExp(String.raw`\bclean\b${SPAN}{0,40}?\s(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?=[\s\`'",;:.!?)]|$)`, 'gi') },
  { label: 'branch -D', pattern: new RegExp(String.raw`\bbranch\b${SPAN}{0,40}?\s(?:-D|-[a-zA-Z]*(?:d[a-zA-Z]*f|f[a-zA-Z]*d)[a-zA-Z]*)(?=[\s\`'",;:.!?)]|$)`, 'g') },
  { label: 'branch -D', pattern: new RegExp(String.raw`\bbranch\b${SPAN}{0,40}?\s(?:-d|--delete)\b${SPAN}{0,40}?\s(?:-f|--force)\b`, 'g') },
  { label: 'branch -D', pattern: new RegExp(String.raw`\bbranch\b${SPAN}{0,40}?\s(?:-f|--force)\b${SPAN}{0,40}?\s(?:-d|--delete)\b`, 'g') },
]

/** A push to main or develop named in a sentence: warned, since the project's push policy decides whether it needs a go-ahead. */
const PROTECTED_PUSH = /\bpush(?:es|ed|ing)?\b[^\n]{0,80}?\b(main|develop)\b|\b(main|develop)\b[^\n]{0,40}?\bpush(?:es|ed|ing)?\b/gi

/** Words that turn a clause around: a negation on the other side of one does not cover the action. */
const CONTRAST = /\b(?:but|however|then|instead|yet|otherwise)\b/gi

/** The negation window: this many words before the action, this many after, in its sentence. */
export const NEGATION_WORDS_BEFORE = 12
export const NEGATION_WORDS_AFTER = 6

/**
 * Whether the action at `start` to `end` of a sentence is said not to be done: a negation (NEGATION) in the same
 * sentence, at most NEGATION_WORDS_BEFORE words before it or NEGATION_WORDS_AFTER words after it, with no contrast word
 * (but, however, then, instead, yet, otherwise) between the two.
 */
export function isNegatedAt(sentence: string, start: number, end: number): boolean {
  let before = sentence.slice(0, start)
  const contrasts = [...before.matchAll(CONTRAST)]
  const lastContrast = contrasts[contrasts.length - 1]
  if (lastContrast !== undefined) before = before.slice((lastContrast.index ?? 0) + lastContrast[0].length)
  const beforeWords = before.split(/\s+/).filter(one => one !== '').slice(-NEGATION_WORDS_BEFORE).join(' ')
  let after = sentence.slice(end)
  const firstContrast = after.search(CONTRAST)
  if (firstContrast >= 0) after = after.slice(0, firstContrast)
  const afterWords = after.split(/\s+/).filter(one => one !== '').slice(0, NEGATION_WORDS_AFTER).join(' ')
  return NEGATION.test(beforeWords) || NEGATION.test(afterWords)
}

export type SignoffLint = { refusal?: string; warnings: string[] }

/**
 * The sign-off guard on a worker prompt: each sentence that instructs a force-push, a remote branch or tag deletion,
 * reset --hard, a forced clean or branch -D, with no negation in its window (isNegatedAt), refuses the launch, naming
 * the actions and their lines; a push to main or develop with none warns. A skill test is not exempt.
 */
export function signoffLint(prompt: string): SignoffLint {
  const found: { label: string; line: number }[] = []
  const warned = new Set<string>()
  for (const [index, line] of prompt.split('\n').entries()) {
    for (const sentence of sentencesOf(line)) {
      for (const action of SIGNOFF_ACTIONS) {
        action.pattern.lastIndex = 0
        for (const match of sentence.matchAll(action.pattern)) {
          const at = match.index ?? 0
          if (!isNegatedAt(sentence, at, at + match[0].length) && !found.some(one => one.label === action.label && one.line === index + 1)) found.push({ label: action.label, line: index + 1 })
        }
      }
      for (const match of sentence.matchAll(PROTECTED_PUSH)) {
        const at = match.index ?? 0
        if (!isNegatedAt(sentence, at, at + match[0].length)) warned.add((match[1] ?? match[2] ?? '').toLowerCase())
      }
    }
  }
  const warnings = [...warned].sort().map(branch => `the prompt names a push to ${branch}: a push to a protected branch needs the user's go-ahead where the project's push policy asks (a Standing decision push-<project>); check it before the worker pushes`)
  if (found.length === 0) return { warnings }
  const listed = found.map(one => `${one.label} on line ${one.line}`).join(', ')
  return {
    refusal:
      `refused by the sign-off guard: the prompt instructs ${listed} as a step for the worker; that needs the user's go-ahead in this conversation, a sign-off item the mod cannot see. ` +
      'Raise an open point for the go-ahead and launch without the step; with the go-ahead the user runs it or says how, and a prompt may tell the worker to stop before it and report. ' +
      'A sentence that tells the worker not to do it (never, do not, stop before) passes',
    warnings,
  }
}
