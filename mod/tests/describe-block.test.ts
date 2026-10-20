// A describe block in a worker prompt (README, Sign-off guard): the words of a fenced block whose info string is
// exactly describe are not read for a force-push, its command shapes are, as any line's; a block that is not closed, or
// whose opening line is anything else, lifts nothing, and the prose around it gets main's verdicts. Also the two
// tightenings of the command shapes: their negation read without false negations (don't forget to), and a forced
// worktree remove. Each hostile prompt carries the verdict chosen and why; when in doubt it is refused.

import { describe, expect, test } from 'claude-code/testing'

import { BLOCK_HINT, describeBlocks, signoffLint } from '../hooks/lint'
import type { StandingRead } from '../hooks/lint'

const ITEMS = 'Wait for long runs in the foreground. Report git status -sb last. No AI attribution trailer in commits. Work on branch `feature/x`.\n'
const B = '```'
const T = '~~~'
/** A describe block holding these lines. */
const described = (...lines: string[]) => `${B}describe\n${lines.join('\n')}\n${B}`
/** A step in prose and a command shape. */
const P = 'Force-push the branch now.'
const S = 'git push --force origin feature/x'

/** The refusal main gives for these actions: the text of the refusal is unchanged; the detail goes beside it. */
const mainRefusal = (listed: string, isCoverable = true) =>
  `refused by the sign-off guard: the prompt instructs ${listed} as a step for the worker; that needs the user's go-ahead in this conversation, a sign-off item the mod cannot see. ` +
  'Raise an open point for the go-ahead and launch without the step; with the go-ahead the user runs it or says how, and a prompt may tell the worker to stop before it and report. ' +
  `A sentence that tells the worker not to do it (never, do not, stop before) passes${isCoverable ? `; ${BLOCK_HINT}` : ''}`
const listedOf = (lint: { refusal?: string }) => /instructs (.*?) as a step/.exec(lint.refusal ?? '')?.[1]
const verdictOf = (lint: { refusal?: string }) => (lint.refusal === undefined ? 'accepted' : 'refused')

const STANDING: StandingRead = {
  text: [
    '## Standing',
    'signoff-feature-lease. [signoff:force-push] User: force-push with lease any feature/* or bugfix/* branch; never main, develop, master, release/* or hotfix/*.',
    'signoff-delete-merged. [signoff:delete-branch] User: delete merged branches from both remotes; never main.',
    '',
  ].join('\n'),
}

/** The five prompts main refused on 2026-10-20 that only described the action (scratch spec of the change). */
const FALSE_POSITIVES: readonly (readonly [string, string])[] = [
  ['a description of the class', 'A signoff block of the force-push class may name one feature or bugfix branch.'],
  ['a commit subject in backticks', 'Commit with the subject `feat(mod): accept a force-push signoff for one named feature branch`.'],
  ['a report instruction', 'Report every Standing line that carries the force-push marker.'],
  ["the user's words quoted as a reason", "Decision mod-46 rests on the user's words «you can force push on feature branches»."],
  ['a long line mixing a never-instruction, the class and a branch', 'Never force-push main or develop; a force-push signoff names exactly one branch such as feature/launch-check-intent, the force-push class covers only feature/* and bugfix/*, and the worker reports every force-push block it saw.'],
]

/** The instructions the first independent check found a clause-reading rule accepted: main refuses all but one. */
const HOLES_FIRST: readonly string[] = [
  'Optionally force-push the branch.', 'Promptly force-push the branch.', 'Additionally force-push the branch.', 'Subsequently force-push the branch.', 'Ideally force-push the branch.', 'Then safely force-push the branch.', 'Rebase on main and quietly force-push the branch.', 'Finally, manually force-push feature/x.',
  'Start by force-pushing the branch.', 'Would you mind force-pushing the branch?', 'Finish with a force-push of feature/x.', 'The branch needs a force-push.',
  'Unless told otherwise force-push the branch.', 'In case the rebase rewrote commits force-push the branch.', 'For feature/x force-push the branch.', 'With the lease force-push feature/x.',
  'Then force-push test to origin.', 'Then delete the remote branch test.',
  '<!--force-push the branch-->', 'Rebase it—force-push the branch.', 'Rebase it–force-push the branch.', '-force-push the branch', '1.force-push the branch', '#force-push the branch',
  'a) Force-push the branch.', '(a) force-push the branch.', 'Step 3 force-push the branch.', '« force-push the branch.', '" force-push the branch.', '→ force-push the branch.', '✓ force-push the branch.', 'TODO force-push the branch.', 'NOTE force-push the branch.',
  'The agent force-pushes the branch at the end.', "Then you'd better force-push the branch.", 'The worker force-pushes the branch.',
]

/** The instructions the second independent check found accepted: main refuses each. */
const HOLES_SECOND: readonly string[] = [
  'A force-push of feature/x to origin is the last step.', 'Last step: a force-push of feature/x to origin.', 'Complete the force-push of feature/x.', 'Initiate a force-push of feature/x to origin.', 'Schedule a force-push of feature/x for tonight.', 'Repeat the force-push of feature/x if CI fails.', 'Handle the force-push of feature/x yourself.', 'Kick off a force-push to origin feature/x.', 'Now comes the force-push of feature/x.', 'Next up: the force-push of feature/x.', 'Then the force-push: feature/x to origin.', 'Remember the force-push to origin.',
  'Force-push test fixes to origin.', 'Force-push check results to feature/x.', 'Force-push example changes now.',
  'You must and can force-push feature/x.', 'You should and may force-push feature/x today.', 'In May force-push feature/x.',
  'Execute the step "force-push feature/x to origin".', 'Your next step is «force-push feature/x».',
  'Then `force-push` feature/x.',
  'You are allowed to force-push feature/x, and should do so now.', 'You may force-push feature/x. Do it right after the tests.',
]

/** The one hole prompt main accepts: it names no force-push word and no command shape; outside a block it keeps main's verdict. */
const MAIN_ACCEPTS = 'Then delete the remote branch test.'

/**
 * Hostile prompts around the fence rules: the label, the prompt, the verdict chosen and why. Each is read with a
 * decisions file that holds a force-push go-ahead for feature branches, so a signoff block could pass where it counts.
 */
const HOSTILE: readonly (readonly [string, string, 'refused' | 'accepted', string])[] = [
  ['CRLF line ends', `${B}describe\r\n${P}\r\n${B}\r\n`, 'refused', 'the opening line ends with a carriage return, so its info string is not exactly describe'],
  ['LF opening, CRLF closing line', `${B}describe\n${P}\n${B}\r\nReport.`, 'accepted', 'a carriage return after the closing marks is a blank: the line closes the block'],
  ['a tab after the info string', `${B}describe\t\n${P}\n${B}`, 'refused', 'the info string is not exactly describe'],
  ['a trailing space after the info string', `${B}describe \n${P}\n${B}`, 'refused', 'the info string is not exactly describe'],
  ['a blank between the fence and the word', `${B} describe\n${P}\n${B}`, 'refused', 'the word must follow the marks at once'],
  ['a tab between the fence and the word', `${B}\tdescribe\n${P}\n${B}`, 'refused', 'the word must follow the marks at once'],
  ['a tab as indentation', `\t${B}describe\n${P}\n${B}`, 'refused', 'only up to three spaces indent an opening line'],
  ['fullwidth backticks', `｀｀｀describe\n${P}\n｀｀｀`, 'refused', 'a lookalike of a backtick opens nothing'],
  ['modifier grave accents', `ˋˋˋdescribe\n${P}\nˋˋˋ`, 'refused', 'a lookalike of a backtick opens nothing'],
  ['describe with a Cyrillic e', `${B}dеscribe\n${P}\n${B}`, 'refused', 'a Cyrillic letter is not the word describe'],
  ['describe with a Cyrillic s', `${B}desсribe\n${P}\n${B}`, 'refused', 'a Cyrillic letter is not the word describe'],
  ['describe in fullwidth letters', `${B}ｄｅｓｃｒｉｂｅ\n${P}\n${B}`, 'refused', 'fullwidth letters are not the word describe'],
  ['a zero-width space inside the info string', `${B}desc​ribe\n${P}\n${B}`, 'refused', 'an invisible character makes the info string something else'],
  ['a zero-width joiner before the info string', `${B}‍describe\n${P}\n${B}`, 'refused', 'an invisible character makes the info string something else'],
  ['a zero-width space inside the fence', `${'`'}​${'``'}describe\n${P}\n${B}`, 'refused', 'the marks must be one run of backticks'],
  ['a no-break space after the info string', `${B}describe \n${P}\n${B}`, 'refused', 'the info string is not exactly describe'],
  ['a byte order mark before the opening line', `﻿${B}describe\n${P}\n${B}`, 'refused', 'the opening line must start with blanks or the marks'],
  ['DESCRIBE in capitals', `${B}DESCRIBE\n${P}\n${B}`, 'refused', 'the info string is the word in lower case'],
  ['the info string closed on its own line', `${B}describe${B}\n${P}\n${B}`, 'refused', 'the info string is not exactly describe'],
  ['two backticks', `\`\`describe\n${P}\n\`\``, 'refused', 'a fence has three marks or more'],
  ['mixed marks', `\`\`~describe\n${P}\n${B}`, 'refused', 'the marks must be one run of one kind'],
  ['inside a blockquote', `> ${B}describe\n> ${P}\n> ${B}`, 'refused', 'a quoted opening line opens nothing'],
  ['four spaces of indentation', `    ${B}describe\n${P}\n    ${B}`, 'refused', 'four spaces make an indented code line, no opening line'],
  ['a CR-only prompt', `${B}describe\r${P}\r${B}`, 'accepted', 'with no line feed the prompt is one line that starts with a fence mark, which the guard never reads, as on main (a gap of main outside describe blocks)'],
  ['nested: a shorter describe fence inside a longer one', `\`\`\`\`describe\n${B}describe\n${P}\n${B}\n\`\`\`\``, 'accepted', 'the inner fence lines are shorter, so they are text of the outer block'],
  ['overlapping: a tilde block opened inside a backtick block', `${B}describe\nx\n${T}describe\n${B}\n${P}\n${T}`, 'refused', 'the backtick line closes the first block; the tilde block opened inside it is text, and the step after the close is prose'],
  ['a shorter closing line only', `\`\`\`\`describe\n${P}\n${B}`, 'refused', 'a shorter fence does not close the block, so it is never closed and nothing is lifted'],
  ['a longer closing line', `${B}describe\n${P}\n\`\`\`\`\`\nReport.`, 'accepted', 'a closing fence at least as long closes'],
  ['a tilde line inside a backtick block', `${B}describe\n${T}\n${P}\n${B}`, 'accepted', 'a fence of the other mark does not close the block (CommonMark); the step is inside'],
  ['a lookalike closing line, then the step', `${B}describe\nx\n｀｀｀\n${P}\n${B}`, 'refused', 'a line a reader may take for the closing line ends the block'],
  ['an indented closing line, then the step', `${B}describe\nx\n        ${B}\n${P}\n${B}`, 'refused', 'a closing line is read at any indentation, so the block ends there'],
  ['a quoted closing line, then the step', `${B}describe\nx\n> ${B}\n${P}\n${B}`, 'refused', 'a closing line after > ends the block'],
  ['a zero-width space in the closing line, then the step', `${B}describe\nx\n\`​\`\`\n${P}\n${B}`, 'refused', 'format characters in the closing marks are passed over'],
  ['the step after the closing marks on their line', `${B}describe\nx\n${B} ${P}`, 'refused', 'the closing line ends the block and the rest of it is prose'],
  ['the step after the closing marks and a zero-width space', `${B}describe\nx\n${B}​ ${P}`, 'refused', 'the closing line ends the block and the rest of it is prose'],
  ['the step after a longer closing run', `${B}describe\nx\n\`\`\`\`${P}`, 'refused', 'the closing line ends the block and the rest of it is prose'],
  ['a fence opened inside quotes, on the same line as the step', `Write "${B}describe" and then: ${P}`, 'refused', 'no fence line at all'],
  ['quoted fence lines around the step', `"${B}describe"\n${P}\n"${B}"`, 'refused', 'a quote mark before the marks: no opening line'],
  ['an HTML comment holding the opening fence', `<!--\n${B}describe\n-->\n${P}\n${B}`, 'refused', 'an opening line inside an open HTML comment opens nothing'],
  ['an HTML comment closed on its line before the block', `<!-- note -->\n${B}describe\n${P}\n${B}`, 'accepted', 'the comment is closed before the opening line'],
  ['an HTML comment opened inside the block', `${B}describe\n<!--\n${B}\n${P}\n-->`, 'refused', 'the block closes at its closing line; the comment mark inside the block is text'],
  ['an opening fence inside a regular fenced block', `\`\`\`\`text\n${B}describe\n${P}\n${B}\n\`\`\`\``, 'refused', 'an opening line inside another fenced block opens nothing; the step is a line of a plain fenced block, read as on main'],
  ['a regular block, then a describe block', `${B}bash\nls\n${B}\n${B}describe\n${P}\n${B}`, 'accepted', 'the regular block is closed before the opening line'],
  ['an opening line with 1000 backticks', `${'`'.repeat(1000)}describe\n${P}\n${'`'.repeat(1000)}`, 'accepted', 'any run of three or more opens'],
  ['an empty describe block, then the step', `${B}describe\n${B}\n${P}`, 'refused', 'the step is after the block'],
  ['the opening line last, the step before', `${P}\n${B}describe`, 'refused', 'the step is before the block, which no line closes'],
  ['a tilde block closed by a backtick line only', `${T}describe\n${P}\n${B}`, 'refused', 'a backtick line does not close a tilde block: never closed, nothing lifted'],
  ['a tilde block closed by a longer tilde line', `${T}describe\n${P}\n~~~~`, 'accepted', 'the same mark, at least as long'],
  ['a command shape inside the block', `${B}describe\nThe class is described here.\n${S}\n${B}`, 'refused', 'command shapes are read inside a describe block'],
  ['a command shape after a contrast word inside the block', `${B}describe\nNever run git push --force, but run git reset --hard.\n${B}`, 'refused', 'the contrast word ends the negation; the reset is a step'],
  ['a false negation before a command shape inside the block', `${B}describe\nDon't forget to run ${S}.\n${B}`, 'refused', "don't forget to is no negation"],
  ['a real negation before a command shape inside the block', `${B}describe\nNever run ${S}.\n${B}`, 'accepted', 'the negation rule applies inside the block as outside'],
  ['an example fence inside the block', `\`\`\`\`describe\nFor example:\n${B}\n${S}\n${B}\n\`\`\`\``, 'refused', 'inside a describe block every line is read for command shapes; an example fence lifts nothing there'],
  ['a quoted example inside the block', `${B}describe\nThe guard refuses \`${S}\`.\n${B}`, 'accepted', 'a quoted example after an introducing word passes, as outside'],
  ['a signoff block quoted in a longer describe block', `\`\`\`\`describe\n${B}signoff signoff-feature-lease\ngit push --force-with-lease origin feature/x\n${B}\n\`\`\`\``, 'refused', 'a signoff block inside a describe block is not honoured: its command is read as a command shape'],
  ['a signoff block inside a shorter-fenced describe block', `${B}describe\n${B}signoff signoff-feature-lease\ngit push --force-with-lease origin feature/x\n${B}\n${B}`, 'refused', 'the inner fence line closes the describe block; the command after it is outside every block'],
  ['the step after the block, in the same paragraph', `${B}describe\nThe force-push class.\n${B}\nThen ${P.toLowerCase()}`, 'refused', 'text after the closing line is prose'],
  ['a soft hyphen in the word describe', `${B}de­scribe\n${P}\n${B}`, 'refused', 'an invisible character makes the info string something else'],
]

describe('a describe block lifts the words, never the command shapes (lint.ts)', () => {
  test('the five original false positives: refused unwrapped with main\'s text, accepted in a describe block', () => {
    for (const [name, prompt] of FALSE_POSITIVES) {
      expect({ name, refusal: signoffLint(prompt).refusal }).toEqual({ name, refusal: mainRefusal('a force-push on line 1') })
      expect({ name, refusal: signoffLint(`${ITEMS}${described(prompt)}`).refusal }).toEqual({ name, refusal: undefined })
      expect({ name, refusal: signoffLint(described(prompt), STANDING).refusal }).toEqual({ name, refusal: undefined })
    }
  })

  test('each hole prompt of both checks: refused outside a block as on main, accepted inside one, refused again with a command shape beside it in the block', () => {
    for (const prompt of [...HOLES_FIRST, ...HOLES_SECOND]) {
      const outside = signoffLint(`${ITEMS}${prompt}`)
      if (prompt === MAIN_ACCEPTS) expect({ prompt, outside: outside.refusal }).toEqual({ prompt, outside: undefined })
      else expect({ prompt, outside: outside.refusal }).toEqual({ prompt, outside: mainRefusal('a force-push on line 2') })
      expect({ prompt, inside: signoffLint(`${ITEMS}${described(prompt)}`).refusal }).toEqual({ prompt, inside: undefined })
      expect({ prompt, shaped: listedOf(signoffLint(`${ITEMS}${described(prompt, S)}`)) }).toEqual({ prompt, shaped: 'a force-push on line 4' })
      expect({ prompt, reset: listedOf(signoffLint(`${ITEMS}${described('git reset --hard origin/main', prompt)}`)) }).toEqual({ prompt, reset: 'reset --hard on line 3' })
    }
    expect(HOLES_FIRST.length + HOLES_SECOND.length).toBe(59)
  })

  test('the opening line: three or more backticks or tildes, up to three spaces before, then exactly describe; any other info string is no escape', () => {
    for (const indent of ['', ' ', '  ', '   ']) expect({ indent, refusal: signoffLint(`${indent}${B}describe\n${P}\n${indent}${B}`).refusal }).toEqual({ indent, refusal: undefined })
    expect(listedOf(signoffLint(`    ${B}describe\n${P}\n    ${B}`))).toBe('a force-push on line 2')
    for (const info of ['Describe', 'describe:', 'describe x', '', 'description', 'desc', 'DESCRIBE', ' describe', 'describe ', 'describe\t', 'describe\r', 'de-scribe', 'describe`', "'describe'"]) {
      expect({ info, listed: listedOf(signoffLint(`${B}${info}\n${P}\n${B}`)) }).toEqual({ info, listed: 'a force-push on line 2' })
    }
    for (const fence of [T, '~~~~', '````', '`````````']) expect({ fence, refusal: signoffLint(`${fence}describe\n${P}\n${fence}`).refusal }).toEqual({ fence, refusal: undefined })
  })

  test('a block not closed before the end of the prompt is no escape: the lines after the opening line are read as prose', () => {
    expect(listedOf(signoffLint(`${ITEMS}${B}describe\nThe force-push class.\n${P}`))).toBe('a force-push on line 3, a force-push on line 4')
    expect(listedOf(signoffLint(`${ITEMS}\`\`\`\`describe\n${P}\n${B}`))).toBe('a force-push on line 3')
    expect(listedOf(signoffLint(`${ITEMS}${T}describe\n${P}\n${B}`))).toBe('a force-push on line 3')
  })

  test('a fence closes the block only when it is of the same mark and at least as long: a longer opening fence quotes a shorter one', () => {
    const quoting = `\`\`\`\`describe\nA fenced block opens with three backticks:\n${B}text\nthe force-push class\n${B}\n\`\`\`\``
    expect(signoffLint(quoting).refusal).toBeUndefined()
    expect(describeBlocks(quoting.split('\n'))).toEqual(new Uint8Array([1, 2, 2, 2, 2, 3]))
    expect(signoffLint(`${T}describe\n${B}\n${P}\n${T}`).refusal).toBeUndefined()
    expect(signoffLint(`${B}describe\n${T}\n${P}\n${B}`).refusal).toBeUndefined()
    expect(signoffLint(`${B}describe\n${P}\n\`\`\`\`\`\``).refusal).toBeUndefined()
  })

  test('a describe block inside a list item, two blocks, and an instruction outside or after the closing fence', () => {
    expect(signoffLint(`${ITEMS}- The class:\n  ${B}describe\n  A force-push signoff names one branch.\n  ${B}\n- Report.`).refusal).toBeUndefined()
    expect(signoffLint(`${described('the force-push class')}\nSome text.\n${described('the force-push marker')}`).refusal).toBeUndefined()
    expect(listedOf(signoffLint(`${described('the force-push class')}\n${P}\n${described('the force-push marker')}`))).toBe('a force-push on line 4')
    expect(listedOf(signoffLint(`${ITEMS}${described('the force-push class')}\nThen force-push feature/x.`))).toBe('a force-push on line 5')
    expect(listedOf(signoffLint(`${ITEMS}${B}describe\nthe force-push class\n${B} ${P}`))).toBe('a force-push on line 4')
    expect(listedOf(signoffLint(`${ITEMS}${B}describe\nthe force-push class\n\`\`\`\` and force-push the branch`))).toBe('a force-push on line 4')
  })

  test('a signoff block inside a describe block is not honoured: its commands are read as command shapes; a describe block with signoff lines is no signoff block', () => {
    const inner = `${B}signoff signoff-feature-lease\ngit push --force-with-lease origin feature/x\n${B}`
    expect(signoffLint(`${ITEMS}${inner}`, STANDING)).toEqual({ warnings: ['sign-off allowed by signoff-feature-lease: force-push: git push --force-with-lease origin feature/x'], allowed: [{ id: 'signoff-feature-lease', actionClass: 'force-push', commands: ['git push --force-with-lease origin feature/x'] }] })
    expect(listedOf(signoffLint(`${ITEMS}\`\`\`\`describe\n${inner}\n\`\`\`\``, STANDING))).toBe('a force-push on line 4')
    expect(listedOf(signoffLint(`${ITEMS}${T}describe\n${inner}\n${T}`, STANDING))).toBe('a force-push on line 4')
    // No decisions file is needed for the signoff lines of a describe block: they open no block.
    const words = `${ITEMS}\`\`\`\`describe\n${B}signoff <id>\nA signoff block cites a Standing go-ahead; its class is force-push or delete-branch.\n${B}\n\`\`\`\``
    expect(signoffLint(words)).toEqual({ warnings: [] })
    expect(signoffLint(`${ITEMS}${described('signoff signoff-feature-lease', 'the force-push class')}`)).toEqual({ warnings: [] })
    // The fences overlap so that the signoff parser leaves a fence inside the describe block: the block is still no block.
    const overlap = ['````describe', '```` x', '~~~~describe', '````', '```signoff signoff-feature-lease', 'git push --force-with-lease origin feature/x', '```', '~~~~'].join('\n')
    expect(listedOf(signoffLint(overlap, STANDING))).toBe('a force-push on line 6')
  })

  test('the signoff blocks of a prompt keep their verdicts beside a describe block', () => {
    const lease = `${B}signoff signoff-feature-lease\ngit push --force-with-lease origin feature/x\n${B}`
    const both = signoffLint(`${ITEMS}${described('A force-push signoff names one branch.')}\n${lease}`, STANDING)
    expect(both.refusal).toBeUndefined()
    expect(both.allowed).toEqual([{ id: 'signoff-feature-lease', actionClass: 'force-push', commands: ['git push --force-with-lease origin feature/x'] }])
    expect(signoffLint(`${ITEMS}${described('the class')}\n${B}signoff signoff-feature-lease\ngit push --force-with-lease origin main\n${B}`, STANDING).refusal).toStartWith('refused by the sign-off guard: the signoff block on line 5 (signoff signoff-feature-lease):')
    expect(signoffLint(`${ITEMS}${described('the class')}\n${B}signoff signoff-feature-lease\ngit push --force-with-lease origin feature/x\n${B}`).refusal).toStartWith('refused by the sign-off guard: the signoff block on line 5 cannot be checked')
  })

  test('a describe block counts only in the prompt as given: one closed in the appended part is no escape', () => {
    const given = `${ITEMS}${B}describe\nThe force-push class.`
    expect(listedOf(signoffLint(`${given}\n${B}\nReport.`, undefined, 3))).toBe('a force-push on line 3')
    expect(signoffLint(`${given}\n${B}\nReport.`, undefined, 4)).toEqual({ warnings: [] })
  })

  test('describeBlocks: the kind of each line; a fence or an open HTML comment before an opening line, or no closing line, makes no block', () => {
    expect(describeBlocks(['a', '```describe', 'b', '```', 'c'])).toEqual(new Uint8Array([0, 1, 2, 3, 0]))
    expect(describeBlocks(['```describe', 'b', '``` more'])).toEqual(new Uint8Array([1, 2, 4]))
    expect(describeBlocks(['```describe', 'b'])).toEqual(new Uint8Array([0, 0]))
    expect(describeBlocks(['```js', '```describe', 'b', '```', '```'])).toEqual(new Uint8Array([0, 0, 0, 0, 0]))
    expect(describeBlocks(['<!--', '```describe', 'b', '-->', '```'])).toEqual(new Uint8Array([0, 0, 0, 0, 0]))
    expect(describeBlocks(['<!-- x --> <!--', '```describe', '-->', '```describe', 'b', '```'])).toEqual(new Uint8Array([0, 0, 0, 1, 2, 3]))
    expect(describeBlocks(['<!-->', '```describe', 'b', '```'])).toEqual(new Uint8Array([0, 1, 2, 3]))
  })

  test(`the hostile prompts around the fence rules: ${HOSTILE.length}, each with its verdict and reason`, () => {
    const STANDING_LEASE: StandingRead = STANDING
    for (const [label, prompt, verdict, reason] of HOSTILE) expect({ label, reason, verdict: verdictOf(signoffLint(prompt, STANDING_LEASE)) }).toEqual({ label, reason, verdict })
    expect(HOSTILE.length).toBeGreaterThanOrEqual(40)
  })
})

describe('the denial detail: the words or the shape, the line, the way out (lint.ts)', () => {
  test('a refusal by the words names them and their line, shows the two fence lines of a describe block, and says a signoff block is for a meant action and quoting does not help', () => {
    const lint = signoffLint(`${ITEMS}Rebase first.\nThen force-push the branch.`)
    expect(lint.refusal).toBe(mainRefusal('a force-push on line 3'))
    expect(lint.detail).toBe(
      'The words «force-push» on line 3 read as a step. A text that describes the action and asks for none goes in a fenced block whose info string is exactly describe, between these two lines:\n' +
        '```describe\n```\n' +
        'the words inside it are not read (its command shapes are); when the action is meant, write its commands in a signoff block instead. Quoting the words alone (backticks, quotes, guillemets) does not help',
    )
  })

  test('a refusal by a command shape names the shape and its line and the ways out: a negation or a signoff block; a describe block is no way out', () => {
    const lint = signoffLint(`${ITEMS}${described('the class', 'git -C /r push origin --delete feature/old')}`)
    expect(lint.refusal).toBe(mainRefusal('a remote branch or tag deletion on line 4'))
    expect(lint.detail).toBe(
      'The command shape `git -C /r push origin --delete` on line 4 is refused wherever it stands, a describe block included; the ways out are a negation in its sentence (never, do not, stop before) or, for a class the user has recorded a Standing go-ahead for (a remote branch deletion, a leased push), its commands in a signoff block',
    )
    expect(signoffLint(`${ITEMS}git reset --hard`).refusal).toBe(mainRefusal('reset --hard on line 2', false))
  })

  test('both kinds on one line are both named; past five of a kind the rest are counted; a long shape is cut', () => {
    const both = signoffLint('Force-push it with git push --force origin x.').detail ?? ''
    expect(both).toStartWith('The words «Force-push» on line 1 read as a step.')
    expect(both).toContain('. The command shape `git push --force` on line 1 is refused wherever it stands')
    const many = signoffLint(Array.from({ length: 7 }, (_, at) => `git push origin --delete b${at}`).join('\n')).detail ?? ''
    expect(many).toStartWith('The command shapes `git push origin --delete` on line 1, `git push origin --delete` on line 2, `git push origin --delete` on line 3, `git push origin --delete` on line 4, `git push origin --delete` on line 5 and 2 more are refused')
    const long = signoffLint(`git push ${'origin '.repeat(4)}${'x'.repeat(80)} --force`).detail ?? ''
    expect(long).toStartWith(`The command shape \`git push origin origin origin origin ${'x'.repeat(23)}…\` on line 1`)
    expect(signoffLint('Never force-push.').detail).toBeUndefined()
  })
})

describe('the command shapes read their negation without false negations (lint.ts)', () => {
  const REFUSED: readonly (readonly [string, string])[] = [
    ["Don't forget to run git push --force origin feature/x.", 'a force-push on line 1'],
    ['Never skip running git push --force origin feature/x.', 'a force-push on line 1'],
    ["Don't forget: git reset --hard origin/main", 'reset --hard on line 1'],
    ['Never forget git branch -D x', 'branch -D on line 1'],
    ['Do not fail to run git push origin --delete feature/x', 'a remote branch or tag deletion on line 1'],
    ["Don't hesitate to run git clean -fdx.", 'a forced clean on line 1'],
    ['Do not omit git push --mirror backup.', 'a mirror push on line 1'],
    ['Why not run git push --force origin x?', 'a force-push on line 1'],
    ["Don't forget:\n- git push --force origin x", 'a force-push on line 2'],
    ["Don't forget:\n```\ngit push --force origin x\n```", 'a force-push on line 3'],
    [`${B}describe\nDon't forget to run git push --force origin x.\n${B}`, 'a force-push on line 2'],
  ]
  const ACCEPTED: readonly string[] = [
    'Never run git push --force origin x.',
    "Don't forget the tests, and never run git push --force origin x.",
    'Do not fail the build; do not run git reset --hard.',
    'Never skip the tests. Never run git branch -D x.',
    "Don't forget that you must not run git push --force.",
    'Never run these:\n- git push --force origin x',
    'For example:\n```\ngit push --force origin x\n```',
  ]
  test('the five prompts of the third check and their kin are refused', () => {
    for (const [prompt, listed] of REFUSED) expect({ prompt, listed: listedOf(signoffLint(prompt)) }).toEqual({ prompt, listed })
  })
  test('real negations, negating heads and introduced examples still pass', () => {
    for (const prompt of ACCEPTED) expect({ prompt, lint: signoffLint(prompt) }).toEqual({ prompt, lint: { warnings: [] } })
  })
  test('the words keep main\'s reading: a false negation before the force-push words still passes, as on main', () => {
    expect(signoffLint("Don't forget to force-push the branch.").refusal).toBeUndefined()
    expect(signoffLint("Don't forget:\n- force-push the branch").refusal).toBeUndefined()
  })
})

describe('a forced worktree remove is a command shape (lint.ts)', () => {
  const REFUSED: readonly string[] = [
    'git worktree remove --force ../x',
    'git worktree remove -f ../x',
    'git -C /repo worktree remove --force ../x',
    'git -C x worktree remove -f y',
    'Run `git worktree remove --force ../x` now.',
    'Clean up with worktree remove --force ../x.',
    `${B}describe\nThe old tree goes: git worktree remove -ff ../x\n${B}`,
  ]
  const ACCEPTED: readonly string[] = [
    'git worktree remove ../x',
    'git worktree list',
    'git worktree prune',
    'git worktree add ../x -b feature/x',
    'Never run git worktree remove --force ../x.',
    'Do not use `git -C x worktree remove -f y`.',
    'The guard refuses `git worktree remove --force ../x`.',
    'The tree was removed with --force yesterday.',
    'git worktree removed --force',
    'worktree remove -f ../x',
  ]
  test('the forms with --force or -f, after git, git -C <dir>, in backticks, bare with the long flag and in a describe block, are refused', () => {
    for (const prompt of REFUSED) expect({ prompt, listed: listedOf(signoffLint(prompt)) }).toEqual({ prompt, listed: `a forced worktree remove on line ${prompt.startsWith(B) ? 2 : 1}` })
    expect(signoffLint('git worktree remove --force ../x').refusal).toBe(mainRefusal('a forced worktree remove on line 1', false))
  })
  test('a plain remove, list, prune and add pass; so do a negation, an introduced example, a past form, another word than remove and a bare short flag', () => {
    for (const prompt of ACCEPTED) expect({ prompt, lint: signoffLint(prompt) }).toEqual({ prompt, lint: { warnings: [] } })
  })
})

// The hole the independent check of the describe block found: a fence-looking line that the describe blocks do not read
// as a fence (four or more spaces, a tab, a no-break or em space before the marks, a backtick in a backtick fence's info
// string) opened an example fence in the guard's reading that the block's own fence lines left open, so every line after
// the block went unread. The guard now reads a prompt with a describe block three ways and refuses what any refuses: as
// the describe blocks read, no fenced block open across a block; as main reads it, the block's fence lines toggling; and
// with the block's lines as blank lines. A describe block hides only the words of its own lines.

/** The prompt with every describe opening line renamed, so it holds no describe block and is read as main reads it. */
const asMain = (prompt: string) => prompt.replace(/^( {0,3}(?:`{3,}|~{3,}))describe$/gm, '$1descrive')
/** The prompt with the lines of its describe blocks as blank lines. */
const blanked = (prompt: string) => {
  const lines = prompt.split('\n')
  const kinds = describeBlocks(lines)
  return lines.map((line, at) => (kinds[at] === 0 ? line : '')).join('\n')
}

/** The fence-looking lines that are no fence for the describe blocks and are one for the guard's reading. */
const STRAY: readonly (readonly [string, string])[] = [
  ['four spaces', `    ${B}`],
  ['six spaces', `      ${B}`],
  ['a tab', `\t${B}`],
  ['a no-break space', ` ${B}`],
  ['an em space', ` ${B}`],
  ['a backtick in the info string', `${B}a\`b`],
  ['a tilde fence with extra marks, indented four spaces', '    ~~~~~~'],
]
/** The lines that make the fence after them an example: introducing words and negating heads. */
const HEADS: readonly string[] = ['Example:', 'For example:', 'e.g.', "Don't forget:", 'Never skip these:', 'Steps:']
/** What the lines after the block instruct. */
const PAYLOADS: readonly (readonly [string, string])[] = [
  ['a command shape', S],
  ['prose', 'Force-push the branch feature/x.'],
  ['both', `${S}\nForce-push the branch feature/x.`],
]

describe('a describe block hides only its own lines: no fence-looking line around it hides the lines after it (lint.ts)', () => {
  test('the minimal case of the check is refused, as on main', () => {
    const prompt = `Example:\n    ${B}\n${described('harmless')}\n${S}\nForce-push the branch feature/x.`
    expect(listedOf(signoffLint(prompt))).toBe('a force-push on line 6, a force-push on line 7')
    expect(listedOf(signoffLint(asMain(prompt)))).toBe('a force-push on line 6, a force-push on line 7')
  })

  test('each of 7 stray lines x 6 heads x 3 payloads before a closed describe block: refused, with main\'s verdict', () => {
    let count = 0
    for (const [stray, line] of STRAY) {
      for (const head of HEADS) {
        for (const [payload, text] of PAYLOADS) {
          const prompt = `${ITEMS}${head}\n${line}\n${described('harmless')}\n${text}`
          const main = signoffLint(asMain(prompt))
          expect({ stray, head, payload, verdict: verdictOf(signoffLint(prompt)) }).toEqual({ stray, head, payload, verdict: 'refused' })
          expect({ stray, head, payload, listed: listedOf(signoffLint(prompt)) }).toEqual({ stray, head, payload, listed: listedOf(main) })
          count++
        }
      }
    }
    expect(count).toBe(126)
  })

  test('the stray line inside an HTML comment, the payload 200 lines later, a tail of 3000 force-pushes, and the numbered list of the check', () => {
    expect(listedOf(signoffLint(`<!-- For example:\n    ${B}\n-->\n${described('harmless')}\n${S}`))).toBe('a force-push on line 7')
    const later = `Example:\n    ${B}\n${described('harmless')}\n${Array.from({ length: 200 }, () => 'The worker reads the files.').join('\n')}\n${S}`
    expect(listedOf(signoffLint(later))).toBe('a force-push on line 206')
    const tail = `Example:\n\t${B}\n${described('harmless')}\n${Array.from({ length: 3000 }, () => S).join('\n')}`
    expect(signoffLint(tail).refusal).toStartWith('refused by the sign-off guard: the prompt instructs a force-push on line 6, a force-push on line 7')
    const list = [
      '1. Prepare the release, for example:',
      `    ${B}`,
      '    make release',
      '2. The class:',
      described('the force-push class'),
      '3. Force-push the branch feature/x.',
      `4. Run ${S}.`,
    ].join('\n')
    expect(listedOf(signoffLint(list))).toBe('a force-push on line 8, a force-push on line 9')
    // Main reads the block's words too.
    expect(listedOf(signoffLint(asMain(list)))).toBe('a force-push on line 6, a force-push on line 8, a force-push on line 9')
  })

  test('the stray line before the first of two blocks, between them, and inside the second: the lines after both are read', () => {
    for (const [stray, line] of STRAY) {
      const variants: Record<string, string> = {
        before: `Example:\n${line}\n${described('one')}\n${described('two')}\n${S}`,
        between: `${described('one')}\nExample:\n${line}\n${described('two')}\n${S}`,
        inside: `${described('one')}\n\`\`\`\`describe\nExample:\n${line}\n\`\`\`\`\n${S}`,
      }
      for (const [where, prompt] of Object.entries(variants)) {
        expect({ stray, where, verdict: verdictOf(signoffLint(prompt)) }).toEqual({ stray, where, verdict: 'refused' })
      }
    }
  })

  test('the parity of fences across a block: a stray line after it closes the fence main still holds open, and one before it opens one main reads', () => {
    // As main reads it: the longer block's inner fence line closes the block's fence and its closing line opens another,
    // which the stray line after the block closes.
    expect(listedOf(signoffLint(`\`\`\`\`describe\n${B}\n\`\`\`\`\nExample:\n    ${B}\n${S}`))).toBe('a force-push on line 6')
    // With the block's lines blank: the stray line before the block opens a fence the stray line after it closes.
    expect(listedOf(signoffLint(`Do this:\n    ${B}\n${described('x')}\nExample:\n    ${B}\n${S}`))).toBe('a force-push on line 8')
  })

  test('the descriptions stay accepted: a valid block with nothing stray before it, a stray line with no step after the block, and the spec\'s wrapped false positives', () => {
    expect(signoffLint(`${ITEMS}${described('A force-push signoff names one branch.')}\nReport.`)).toEqual({ warnings: [] })
    expect(signoffLint(`${ITEMS}Example:\n    ${B}\n${described('the force-push class')}\nReport.`)).toEqual({ warnings: [] })
    for (const [name, prompt] of FALSE_POSITIVES) expect({ name, refusal: signoffLint(`${ITEMS}Example:\n    ${B}\n${described(prompt)}\nReport.`).refusal }).toEqual({ name, refusal: undefined })
  })

  test('the property: over 300 generated prompts, a prompt main refuses with its describe blocks blank, or with its blocks read as fences, is refused', () => {
    const random = seeded(20261020)
    const harmless = ['The worker reads the files.', 'Report what you found.', '', '- a list item', '<!-- a note -->']
    const fenceLike = [...STRAY.map(([, line]) => line), B, T, '````', `${B}text`, '> ```', '｀｀｀']
    const openings = [`${B}describe`, `${T}describe`, '````describe', '  ```describe']
    const payloads = [...PAYLOADS.map(([, text]) => text), `Run ${S} now.`, 'git reset --hard origin/main']
    let refused = 0
    let withBlock = 0
    for (let at = 0; at < 300; at++) {
      const parts: string[] = []
      for (let part = 0, parts_ = 4 + Math.floor(random.next() * 8); part < parts_; part++) {
        const roll = random.next()
        if (roll < 0.2) parts.push(random.pick(HEADS))
        else if (roll < 0.45) parts.push(random.pick(fenceLike))
        else if (roll < 0.65) {
          const open = random.pick(openings)
          const marks = (/^ *([`~]+)/.exec(open)?.[1] ?? B)
          const body = Array.from({ length: Math.floor(random.next() * 4) }, () => (random.next() < 0.5 ? random.pick(fenceLike) : random.pick([...HEADS, 'the force-push class', 'harmless'])))
          parts.push([open, ...body.filter(line => !line.startsWith(marks[0] === '`' ? '```' : '~~~') && !line.includes('｀') && !line.startsWith('> ')), marks].join('\n'))
        } else if (roll < 0.85) parts.push(random.pick(payloads))
        else parts.push(random.pick(harmless))
      }
      const prompt = parts.join('\n')
      const kinds = describeBlocks(prompt.split('\n'))
      const blank = blanked(prompt)
      // The blanked prompt and the renamed one hold no describe block: the guard reads them as main does.
      expect(describeBlocks(blank.split('\n')).every(kind => kind === 0)).toBe(true)
      expect(describeBlocks(asMain(prompt).split('\n')).every(kind => kind === 0)).toBe(true)
      const verdict = verdictOf(signoffLint(prompt))
      if (verdict === 'refused') refused++
      if (kinds.some(kind => kind !== 0)) withBlock++
      if (verdictOf(signoffLint(blank)) === 'refused') expect({ prompt, blank: verdict }).toEqual({ prompt, blank: 'refused' })
      // A block's lines hold no force-push word outside 'the force-push class', which main reads: the renamed prompt is
      // compared only when its blocks hold none.
      const words = prompt.split('\n').some((line, index) => kinds[index] === 2 && /force-push/.test(line))
      if (!words && verdictOf(signoffLint(asMain(prompt))) === 'refused') expect({ prompt, main: verdict }).toEqual({ prompt, main: 'refused' })
    }
    expect(withBlock).toBeGreaterThan(150)
    expect(refused).toBeGreaterThan(100)
  })
})

/** A seeded generator (xorshift32): the same prompts at every run. */
function seeded(seed: number) {
  let state = seed
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
  return { next, pick: <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T }
}

describe('the denial detail: the number of the shapes, the ways out of a shape no signoff block covers, a describe block that did not count (lint.ts)', () => {
  test('two or more shapes are refused, in the plural', () => {
    const detail = signoffLint('git push origin --delete a\ngit push origin --delete b').detail ?? ''
    expect(detail).toBe(
      'The command shapes `git push origin --delete` on line 1, `git push origin --delete` on line 2 are refused wherever they stand, a describe block included; the ways out are a negation in each one\'s sentence (never, do not, stop before) or, for a class the user has recorded a Standing go-ahead for (a remote branch deletion, a leased push), its commands in a signoff block',
    )
  })

  test('a shape of no class a signoff block covers offers a negation, an introduced example or leaving the step out', () => {
    expect(signoffLint('git reset --hard origin/main').detail).toBe(
      'The command shape `git reset --hard` on line 1 is refused wherever it stands, a describe block included; the ways out are a negation in its sentence (never, do not, stop before), a quoted example after an introducing word (for example, such as), or leaving the step out; no signoff block covers it',
    )
    expect(signoffLint('git clean -fdx\ngit branch -D x\ngit worktree remove --force ../x').detail).toEndWith('; no signoff block covers them')
    expect(signoffLint('git reset --hard\ngit push --force-with-lease origin feature/x').detail).toEndWith('its commands in a signoff block')
  })

  test('a describe block that did not count is named with its line and why, after the words', () => {
    const missOf = (prompt: string) => /\. (A describe block opens on line \d+ and was not honoured: [^.]*|Line \d+ closes a describe block[^.]*)/.exec(signoffLint(prompt).detail ?? '')?.[1]
    expect(missOf(`Intro.\n${B}describe\n${P}`)).toBe('A describe block opens on line 2 and was not honoured: no line closes it before the end of the prompt as given, and a block that is not closed lifts nothing')
    expect(missOf(`${B}Describe\n${P}\n${B}`)).toBe('A describe block opens on line 1 and was not honoured: its info string is not exactly describe (in lower case, right after three or more backticks or tildes, with nothing after it)')
    expect(missOf(`${B}describe:\n${P}\n${B}`)).toStartWith('A describe block opens on line 1 and was not honoured: its info string is not exactly describe')
    expect(missOf(`${B}describe\r\n${P}\r\n${B}\r\n`)).toBe('A describe block opens on line 1 and was not honoured: its opening line ends with a carriage return (CRLF line ends); write the prompt with LF line ends')
    for (const open of [`${B}describe `, `    ${B}describe`, `\t${B}describe`, `${B}desc​ribe`, `> ${B}describe`]) {
      expect({ open, miss: missOf(`${open}\n${P}\n${B}`) }).toEqual({ open, miss: 'A describe block opens on line 1 and was not honoured: its opening line has extra characters (a blank, a tab, an invisible character, a > quote or more than three blanks before the marks); it holds up to three blanks, three or more backticks or tildes and the word describe, nothing else' })
    }
    expect(missOf(`${B}text\n${B}describe\n${P}\n${B}\n${B}`)).toBe('A describe block opens on line 2 and was not honoured: its opening line stands inside another fenced block or an HTML comment, where it opens nothing')
    expect(missOf(`${B}describe\nx\n${B} ${P}`)).toBe('Line 3 closes a describe block and the text after its closing marks is read as prose')
    expect(missOf(`${described('x')}\n${P}`)).toBeUndefined()
    expect(signoffLint(`${B}describe\ngit reset --hard`).detail).not.toContain('was not honoured')
  })
})
