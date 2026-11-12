// A regression corpus of acceptable worker prompts for the sign-off guard and the prompt lint (README, Sign-off guard;
// decisions gh-1 and gh-2): closed example fences after each introducing word, quoted examples in backticks and double
// quotes, describe blocks, signoff blocks of a recorded Standing go-ahead, prose that names the guard or its classes
// and asks for no action, a quoted decision inside a describe block, CRLF line ends, nested and adjacent fences, fences
// closed with tildes, fences that never close and hold nothing refused, and long prompts near the size cap. Each
// answer was recorded on main at bb46144 before the unclosed-fence change and is frozen here: the corpus must give the
// same answers before and after any change to the guard.

import { describe, expect, test } from 'claude-code/testing'

import { promptLint, signoffLint } from '../hooks/lint'

/** The fence marks. */
const B = '```'
const T = '~~~'
/** Refused when written as a step: phrases of the existing guard tests (signoff.test.ts, describe-block.test.ts). */
const FORCE = 'git push --force origin x'
const RESET = 'git reset --hard'
const BRANCH_D = 'git branch -D x'
const DELETE = 'git push origin --delete old-branch'
const CLEAN = 'Clean the tree with git clean -fd.'
const WORDS = 'Rebase on main, then force-push the branch.'
const HEAD = 'Goal: tidy the parser on branch `feature/x`. Wait in the foreground; report git status -sb; no AI attribution trailer.'
const TAIL = 'Report what you changed.'
/** A closed fence after a line, holding these lines. */
const fenced = (before: string, ...lines: string[]) => `${before}\n${B}\n${lines.join('\n')}\n${B}`
/** A prompt of `chars` characters: the head, the body, then filler prose up to the length. */
const padded = (body: string, chars: number) => {
  const text = `${HEAD}\n${body}\n`
  const filler = 'Read the parser module and report what each function does. '
  let out = text
  while (out.length + filler.length <= chars - 1) out += filler
  return `${out}${'.'.repeat(chars - 1 - out.length)}\n`
}

/** The Standing decisions file the signoff blocks of the corpus are checked against. */
const CORPUS_STANDING = {
  text: [
    '# Agreed decisions',
    '',
    '## Standing',
    'signoff-delete-merged. [signoff:delete-branch] User: delete merged branches from both remotes; never main.',
    'signoff-feature-lease. [signoff:force-push] User: force-push with lease any feature/* or bugfix/* branch; never main, develop, master, release/* or hotfix/*.',
    'signoff-main-lease. [signoff:force-push] User: force-push with lease main to origin and backup after the history repair.',
    '',
  ].join('\n'),
}

/** The introducing words of a quoted example (README, Sign-off guard), each in a line before a closed fence. */
const INTRODUCING_LINES: readonly (readonly [string, string, string])[] = [
  ['refuse', 'The guard must refuse a prompt with this step:', FORCE],
  ['refuses', 'The guard refuses these lines:', RESET],
  ['refused', 'These were refused:', BRANCH_D],
  ['refusing', 'It keeps refusing this:', DELETE],
  ['refusal', 'The refusal reads this step:', FORCE],
  ['deny', 'Deny this form of prompt:', RESET],
  ['denies', 'The mod denies the following:', BRANCH_D],
  ['denied', 'Denied steps:', FORCE],
  ['denial', 'The denial quotes:', DELETE],
  ['reject', 'Reject a prompt like this:', CLEAN],
  ['rejects', 'The launch rejects:', FORCE],
  ['rejected', 'Rejected lines:', RESET],
  ['rejecting', 'The guard is rejecting:', BRANCH_D],
  ['example', 'For example:', FORCE],
  ['examples', 'Examples of refused prompts:', `${FORCE}\n${RESET}`],
  ['e.g.', 'Steps the mod refuses, e.g.:', DELETE],
  ['for instance', 'For instance:', BRANCH_D],
  ['form', 'The form of the refused step:', FORCE],
  ['forms', 'Forms of it:', RESET],
  ['such as', 'Steps such as:', CLEAN],
  ['attack', 'An attack prompt:', WORDS],
  ['attacks', 'Attacks the check covers:', `${FORCE}\n${WORDS}`],
]

const CORPUS: readonly (readonly [string, string])[] = [
  // Closed example fences after each introducing word, and after a negating head line.
  ...INTRODUCING_LINES.map(([word, line, body]) => [`closed fence after «${word}»`, `${HEAD}\n${fenced(line, body)}\n${TAIL}`] as const),
  ['closed fence after a negating head', `${HEAD}\n${fenced('Never run these:', RESET, BRANCH_D)}\n${TAIL}`],
  ['closed fence with an info string after an introducing word', `${HEAD}\nFor example:\n${B}bash\n${FORCE}\n${B}\n${TAIL}`],
  ['closed fence after an introducing word and a blank line', `${HEAD}\nFor example:\n\n${B}\n${RESET}\n${B}\n${TAIL}`],
  // Quoted examples in backticks and double quotes.
  ['backticks after refuses', `${HEAD}\nThe guard refuses \`git push --force\`, \`git push origin :x\` and \`git branch -D x\`.`],
  ['double quotes after such as', `${HEAD}\nForms it denies, such as "git push --force" and \`git reset --hard\`.`],
  ['curly quotes after for instance', `${HEAD}\nFor instance, “${FORCE}” is refused.`],
  ['e.g. before a backtick span', `${HEAD}\ne.g. \`git push --mirror backup\``],
  ['an attack quoted', `${HEAD}\nattack it: "never force-push, but if needed force-push", "do not push; run git push --force", \`git clean -fdx\``],
  // Describe blocks.
  ['describe block of force-push words', `${HEAD}\n${B}describe\nA signoff block of the force-push class names one feature branch.\n${B}\n${TAIL}`],
  ['tilde describe block', `${HEAD}\n${T}describe\nReport every Standing line that carries the force-push marker.\n${T}\n${TAIL}`],
  ['describe block with a longer fence', `${HEAD}\n\`\`\`\`describe\nCommit with the subject \`feat(mod): accept a force-push signoff\`.\n\`\`\`\`\n${TAIL}`],
  ['a quoted decision inside a describe block', `${HEAD}\n${B}describe\ngh-1. User (2026-11-12): the force-push of feature/x was approved for the history repair.\n${B}\n${TAIL}`],
  ['an example fence, then a describe block', `${HEAD}\n${fenced('For example:', FORCE)}\n${B}describe\nThe user's words: you can force push on feature branches.\n${B}\n${TAIL}`],
  // Signoff blocks of a recorded Standing decision.
  ['signoff block of a branch deletion', `${HEAD}\n${B}signoff signoff-delete-merged\ngit push origin --delete refs/heads/feature/old\ngit branch -d feature/old\n${B}\n${TAIL}`],
  ['signoff block of a feature lease', `${HEAD}\n${B}signoff signoff-feature-lease\ngit push --force-with-lease origin feature/x\n${B}\n${TAIL}`],
  ['signoff block of the main lease', `${HEAD}\n${B}signoff signoff-main-lease\ngit push --force-with-lease origin main\ngit push --force-with-lease backup main\n${B}\n${TAIL}`],
  ['signoff block after an introducing line', `${HEAD}\nFor example:\n${B}signoff signoff-delete-merged\ngit push backup :refs/heads/feature/old\n${B}\n${TAIL}`],
  // Prose that names the guard or the classes and asks for no action.
  ['the standard never-sentence', `${HEAD}\nYou may NOT merge to main, push to another remote, rewrite history, delete a branch, or force-push.`],
  ['a gate sentence', `${HEAD}\nA force-push needs the user's go-ahead: stop and report.`],
  ['the guard named', `${HEAD}\nThe sign-off guard refuses a prompt that instructs a force-push; never force-push.`],
  ['a negated list', `${HEAD}\nNever: force-push, ${RESET}, git branch -D x.`],
  ['a negating head over a list', `${HEAD}\nYou may NOT:\n- ${FORCE}\n- ${RESET}\n- delete a remote branch`],
  ['push to main fast-forward only', `${HEAD}\nPush main to both remotes, fast-forward only, never --force.`],
  // CRLF line ends.
  ['CRLF closed example fence', `${HEAD}\r\nFor example:\r\n${B}\r\n${FORCE}\r\n${B}\r\n${TAIL}\r\n`],
  ['CRLF negated prose', `${HEAD}\r\nNever force-push; do not run ${RESET}.\r\n${TAIL}\r\n`],
  ['CRLF quoted example', `${HEAD}\r\nThe guard refuses \`${BRANCH_D}\`.\r\n`],
  // Nested and adjacent fences.
  ['nested fences with a harmless inner block', `${HEAD}\nExamples of refused prompts:\n\`\`\`\`markdown\nSteps:\n${B}\nnpm test\n${B}\n\`\`\`\`\n${TAIL}`],
  ['two adjacent example fences', `${HEAD}\n${fenced('Examples:', FORCE)}\n${fenced('For instance:', RESET)}\n${TAIL}`],
  ['an example fence, then a plain fence right after', `${HEAD}\n${fenced('For example:', BRANCH_D)}\n${B}\nnpm test\n${B}\n${TAIL}`],
  ['an example fence closed on the last line', `${HEAD}\n${fenced('For example:', FORCE)}`],
  // Fences closed with tildes.
  ['tilde fence after an introducing word', `${HEAD}\nFor example:\n${T}\n${RESET}\n${T}\n${TAIL}`],
  ['tilde fence with an info string', `${HEAD}\nThe guard refuses:\n${T}bash\n${FORCE}\n${T}\n${TAIL}`],
  ['backtick fence closed by tildes', `${HEAD}\nFor example:\n${B}\n${DELETE}\n${T}\n${TAIL}`],
  // Fences that never close and hold nothing refused (accepted on main, accepted after).
  ['an unclosed plain fence at the end', `${HEAD}\nRun the build:\n${B}\nnpm run build\n`],
  ['an unclosed example fence of a harmless command', `${HEAD}\nFor example:\n${B}\nnpm test`],
  ['a closed example, then an unclosed harmless fence', `${HEAD}\n${fenced('For example:', FORCE)}\nThen report.\n${B}\nthe status output here`],
  // Long prompts near the size cap.
  ['long prompt just under the cap with an example fence', padded(fenced('For example:', FORCE), 59_990)],
  ['long prompt at the cap with a describe block', padded(`${B}describe\nA force-push signoff names one feature branch.\n${B}`, 60_000)],
  ['long prompt at the cap with quoted examples', padded('The guard refuses `git push --force` and `git reset --hard`.', 60_000)],
]

/** The guard's answer to a prompt: the sign-off guard's verdict and warnings, and the prompt lint's. */
function answerOf(prompt: string) {
  const signoff = signoffLint(prompt, CORPUS_STANDING)
  const prompted = promptLint(prompt)
  return { signoff: signoff.refusal ?? 'accepted', signoffWarnings: signoff.warnings, lint: prompted.refusal ?? 'accepted', lintWarnings: prompted.warnings }
}

/** The answers main gave (recorded on a copy of main at bb46144), by the corpus entry's name. */
const EXPECTED: Readonly<Record<string, ReturnType<typeof answerOf>>> = {
  "closed fence after «refuse»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «refuses»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «refused»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «refusing»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «refusal»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «deny»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «denies»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «denied»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «denial»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «reject»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «rejects»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «rejected»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «rejecting»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «example»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «examples»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «e.g.»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «for instance»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «form»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «forms»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «such as»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «attack»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after «attacks»": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after a negating head": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence with an info string after an introducing word": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "closed fence after an introducing word and a blank line": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "backticks after refuses": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "double quotes after such as": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "curly quotes after for instance": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "e.g. before a backtick span": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "an attack quoted": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "describe block of force-push words": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "tilde describe block": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "describe block with a longer fence": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "a quoted decision inside a describe block": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "an example fence, then a describe block": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "signoff block of a branch deletion": {
    "signoff": "accepted",
    "signoffWarnings": [
      "sign-off allowed by signoff-delete-merged: delete-branch: git push origin --delete refs/heads/feature/old; git branch -d feature/old"
    ],
    "lint": "accepted",
    "lintWarnings": []
  },
  "signoff block of a feature lease": {
    "signoff": "accepted",
    "signoffWarnings": [
      "sign-off allowed by signoff-feature-lease: force-push: git push --force-with-lease origin feature/x"
    ],
    "lint": "accepted",
    "lintWarnings": []
  },
  "signoff block of the main lease": {
    "signoff": "accepted",
    "signoffWarnings": [
      "the prompt names a push to main: a push to a protected branch needs the user's go-ahead where the project's push policy asks (a Standing decision push-<project>); check it before the worker pushes",
      "sign-off allowed by signoff-main-lease: force-push: git push --force-with-lease origin main; git push --force-with-lease backup main"
    ],
    "lint": "accepted",
    "lintWarnings": []
  },
  "signoff block after an introducing line": {
    "signoff": "accepted",
    "signoffWarnings": [
      "sign-off allowed by signoff-delete-merged: delete-branch: git push backup :refs/heads/feature/old"
    ],
    "lint": "accepted",
    "lintWarnings": []
  },
  "the standard never-sentence": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "a gate sentence": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "the guard named": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "a negated list": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "a negating head over a list": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "push to main fast-forward only": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "CRLF closed example fence": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "CRLF negated prose": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "CRLF quoted example": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "nested fences with a harmless inner block": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "two adjacent example fences": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "an example fence, then a plain fence right after": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "an example fence closed on the last line": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "tilde fence after an introducing word": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "tilde fence with an info string": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "backtick fence closed by tildes": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "an unclosed plain fence at the end": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "an unclosed example fence of a harmless command": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "a closed example, then an unclosed harmless fence": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "long prompt just under the cap with an example fence": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "long prompt at the cap with a describe block": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  },
  "long prompt at the cap with quoted examples": {
    "signoff": "accepted",
    "signoffWarnings": [],
    "lint": "accepted",
    "lintWarnings": []
  }
}

describe('the guard corpus: acceptable prompts keep main\'s answers', () => {
  test('the corpus holds at least 40 prompts, each named once, each with a recorded answer', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40)
    expect(new Set(CORPUS.map(([name]) => name)).size).toBe(CORPUS.length)
    expect(CORPUS.map(([name]) => name).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  test('every prompt of the corpus is accepted, with the warnings main gave', () => {
    for (const [name, prompt] of CORPUS) expect({ name, answer: answerOf(prompt) }).toEqual({ name, answer: EXPECTED[name] })
  })

  test('the long prompts sit at the size cap or just under it', () => {
    for (const [name, prompt] of CORPUS.filter(([one]) => one.startsWith('long prompt'))) expect({ name, isNear: prompt.length >= 59_900 && prompt.length <= 60_000 }).toEqual({ name, isNear: true })
  })
})
