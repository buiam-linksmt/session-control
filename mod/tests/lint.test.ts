// The prompt lint of launch_worker (lint.ts, decision win-22): the size cap, a likely secret in the prompt (refused
// with its kind and line, never its value) and the warning for a prompt that asks to commit or push but names no branch
// and no decision section; the skill-test exemption of the size cap and the warning, never of the secret refusal. Pure,
// then through the plugin on the mock world: a refusal launches nothing and writes no prompt file, a warning comes as a
// line of the launch's answer. Every canary is an invented string, joined at run time.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RULES_BLOCK, composePrompt } from '../hooks/core'
import { NEGATION, PROMPT_MAX_CHARS, isSkillTest, promptLint, sentencesOf } from '../hooks/lint'
import { OPTIONS, ORCH, REGISTRY, RUNS, mockWorld } from './mock-world'
import type { World } from './mock-world'

/** A prompt with the three items the launch guard checks, so only the lint decides. */
const ITEMS = 'Wait for long runs in the foreground. Report git status -sb last. No AI attribution trailer in commits.\n'
const GH_CANARY = ['ghp', 'CANARYcanary0000000000000000000000'].join('_')
const AWS_CANARY = ['AKIA', 'CANARY0000000000'].join('')
const WARNING = 'the prompt asks to commit, push or work on a branch but names no branch (an existing one by exact name, or "create one" with its gitflow prefix) and no decision section; the worker may pick one itself'

describe('lint.ts', () => {
  test('a likely secret is refused with its kind and line, never its value; several are counted', () => {
    const one = promptLint(`${ITEMS}Use the token below.\nexport GITHUB_TOKEN=${GH_CANARY}\n`)
    expect(one.refusal).toBe('refused: the prompt holds a likely secret (github-token on line 3); a prompt never carries a credential: name where the worker finds it (an environment variable, a credential helper), never the value')
    expect(one.refusal).not.toContain(GH_CANARY)
    const many = promptLint(`${ITEMS}${Array.from({ length: 7 }, () => `id ${AWS_CANARY}`).join('\n')}`)
    expect(many.refusal).toStartWith('refused: the prompt holds 7 likely secrets (aws-key on line 2, aws-key on line 3, aws-key on line 4, aws-key on line 5, aws-key on line 6 and 2 more)')
    // A skill test is not exempt from the secret refusal.
    expect(promptLint(`skill test: run it with ${GH_CANARY}`).refusal).toContain('github-token on line 1')
  })

  test('the size cap: above 60000 characters refused with the hint to reference the document by path; at the cap it passes; a skill test is exempt', () => {
    expect(PROMPT_MAX_CHARS).toBe(60_000)
    const over = `${ITEMS}${'x'.repeat(PROMPT_MAX_CHARS)}`
    expect(promptLint(over).refusal).toBe(`refused: the prompt has ${over.length} characters, the limit is 60000: reference a long document by its file path for the worker to read instead of pasting it into the prompt`)
    expect(promptLint(`${ITEMS}${'x'.repeat(PROMPT_MAX_CHARS - ITEMS.length)}`).refusal).toBeUndefined()
    expect(promptLint(`skill test ${'x'.repeat(PROMPT_MAX_CHARS)}`).refusal).toBeUndefined()
  })

  test('the branch warning: a prompt that asks to commit or push and names no branch, no "create one" and no decision section', () => {
    for (const text of ['Fix the parser and commit it, then push.', 'Work on a branch of your choice.', 'Push the fix when the tests pass.']) {
      expect({ text, warnings: promptLint(`${ITEMS}${text}`).warnings }).toEqual({ text, warnings: [WARNING] })
    }
    for (const text of [
      'Fix the parser and commit it on branch `feature/parser`, then push.',
      'Commit on the branch "bugfix/x" and push it.',
      'Branch feature/req-1 exists: commit there.',
      'Push to branch develop after the review.',
      'Fix it on a new branch: create one with the feature/ prefix; commit and push.',
      'Commit it. The decisions in agreed-decisions.md section "Parser" are binding.',
      // Negated mentions ask for nothing.
      'Use no tool. No commit, no push.',
      'Never push anything; do not commit.',
      // No git work at all.
      'Read the logs and report.',
      // A skill test is exempt.
      'skill test: commit and push whatever the skill says.',
    ]) {
      expect({ text, warnings: promptLint(`${ITEMS}${text}`).warnings }).toEqual({ text, warnings: [] })
    }
    // The section block a launch appends names a decision section.
    expect(promptLint(composePrompt(`${ITEMS}Commit and push.`, { heading: 'Unit', body: 'u-1. A decision.' }, false).text).warnings).toEqual([])
    // The rules block's own words about commits and branches do not count.
    expect(promptLint(`${ITEMS}Read the logs and report.\n\n${RULES_BLOCK}`).warnings).toEqual([])
  })

  test('sentences, negations and the skill-test phrase', () => {
    expect(sentencesOf('One. Two; three!\n- four\n\nfive?')).toEqual(['One.', 'Two;', 'three!', '- four', 'five?'])
    for (const text of ['no push', 'do not commit', 'never force-push', 'stop before the push', 'the push needs a sign-off', 'without a commit']) expect({ text, isNegated: NEGATION.test(text) }).toEqual({ text, isNegated: true })
    for (const text of ['commit and push', 'push the branch now', 'note the push']) expect({ text, isNegated: NEGATION.test(text) }).toEqual({ text, isNegated: false })
    expect(isSkillTest('This is a Skill-Test run')).toBe(true)
    expect(isSkillTest('a test of the skill')).toBe(false)
  })
})

const TOOL = 'mcp__session-control__launch_worker'

async function orchestrator($: { session: { start: (e: never) => Promise<unknown> } }, on: On): Promise<World> {
  const world = mockWorld(on)
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  world.files.set(REGISTRY, '[]\n')
  world.files.set('/w/work/keep', 'x')
  await $.session.start({ cwd: ORCH, surface: null, isInteractive: true } as never)
  return world
}

const launch = async ($: { tool: { call: (e: never) => Promise<unknown> } }, prompt: string) =>
  (await $.tool.call({ tool: TOOL, dir: '/w/work', model: 'haiku', effort: 'low', title: 'lint case', prompt } as never)) as { result?: unknown; deny?: unknown }

describe('the prompt lint through launch_worker', () => {
  test('a secret in an inline prompt: refused before anything runs; no worker, no prompt file, no registry entry; the value nowhere', { options: OPTIONS }, async ($, on) => {
    const world = await orchestrator($, on)
    const out = await launch($, `${ITEMS}Deploy with\nexport KEY=${AWS_CANARY}`)
    expect(String(out.deny)).toBe('session-control: refused: the prompt holds a likely secret (aws-key on line 3); a prompt never carries a credential: name where the worker finds it (an environment variable, a credential helper), never the value; nothing was launched')
    expect(world.passed.filter(one => one.tool === 'Bash')).toEqual([])
    expect([...world.files.keys()].filter(path => path.startsWith(`${RUNS}/`) && path.endsWith('.prompt.md'))).toEqual([])
    expect(world.files.get(REGISTRY)).toBe('[]\n')
    expect(JSON.stringify([...world.files.values(), world.toasts])).not.toContain(AWS_CANARY)
  })

  test('a secret in a prompt file, and a prompt file over the size cap: refused', { options: OPTIONS }, async ($, on) => {
    const world = await orchestrator($, on)
    world.files.set('/w/scratch/secret.md', `${ITEMS}clone https://alice:${'canary0'}pass@example.com/r.git\n`)
    world.files.set('/w/scratch/long.md', `${ITEMS}${'y'.repeat(PROMPT_MAX_CHARS)}`)
    const call = (file: string) => $.tool.call({ tool: TOOL, dir: '/w/work', model: 'haiku', effort: 'low', title: 'lint case', prompt_file: file } as never) as Promise<{ deny?: unknown }>
    expect(String((await call('/w/scratch/secret.md')).deny)).toContain('refused: the prompt holds a likely secret (url-credentials on line 2)')
    expect(String((await call('/w/scratch/long.md')).deny)).toContain(`refused: the prompt has ${ITEMS.length + PROMPT_MAX_CHARS} characters, the limit is 60000`)
    expect(world.passed.filter(one => one.tool === 'Bash')).toEqual([])
  })

  // The mock world starts the worker (the Bash call) but registers none, so the answer is the one of a start without a
  // registration; the warning lines follow every answer of a started launch alike.
  test('a prompt that asks to push and names no branch: the worker is started, and the answer ends with one WARNING line; with a branch named, no warning', { options: OPTIONS }, async ($, on) => {
    const world = await orchestrator($, on)
    const warned = await launch($, `${ITEMS}Fix the parser, commit and push.`)
    expect(warned.deny).toBeUndefined()
    expect(String(warned.result).split('\n').slice(1)).toEqual([`WARNING: ${WARNING}`])
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
    const quiet = await launch($, `${ITEMS}Fix the parser on branch \`feature/parser\`, commit and push.`)
    expect(quiet.deny).toBeUndefined()
    expect(String(quiet.result)).not.toContain('WARNING')
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(2)
  })
})
