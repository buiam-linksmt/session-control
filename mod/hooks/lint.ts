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
export const NEGATION = /\b(?:no|not|never|nothing|neither|nor|without|don't|doesn't|mustn't|shan't|cannot|can't|refrain|avoid|forbidden|prohibited|disallowed)\b|\bstop before\b|\bsign-?off\b|\bgo-ahead\b/i

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
