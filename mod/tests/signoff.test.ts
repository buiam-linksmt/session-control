// The sign-off guard (README, Sign-off guard): a launch_worker prompt that instructs a force-push, a remote branch or
// tag deletion, reset --hard, a forced clean or branch -D as a step is refused, a sentence that says not to do it
// passes (the negation window, both ways), a push to main or develop warns, a skill test is not exempt; the
// orchestrator's own Bash and PowerShell commands running one are refused in its own session only. Each form is tested
// both ways. A signoff block lifts a refusal only for the line forms its grammar takes; a decision id in prose lifts
// nothing (the checker's 202 cited cases), and a prompt without a block gets main's verdicts.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gitSignoffAction, signoffDenyText, signoffVerdict } from '../hooks/guard'
import { BLOCK_HINT, BLOCK_MAX_LINES, NEGATION_WORDS_AFTER, NEGATION_WORDS_BEFORE, WARNED_COMMANDS, coversBranch, isNegatedAt, mainRemotes, signoffLint, standingGrants } from '../hooks/lint'
import type { StandingRead } from '../hooks/lint'
import { OPTIONS, ORCH, REGISTRY, RUNS, mockWorld } from './mock-world'
import type { World } from './mock-world'

const ITEMS = 'Wait for long runs in the foreground. Report git status -sb last. No AI attribution trailer in commits. Work on branch `feature/x`.\n'

describe('the prompt guard (lint.ts)', () => {
  const REFUSED: readonly (readonly [string, string])[] = [
    ['Rebase on main, then force-push the branch.', 'a force-push'],
    ['Then force push it.', 'a force-push'],
    ['Run `git push --force origin feature/x` when done.', 'a force-push'],
    ['Run git push --force-with-lease origin feature/x.', 'a force-push'],
    ['git push --force-with-lease=main:abc1234 origin main', 'a force-push'],
    ['git push -f origin feature/x', 'a force-push'],
    ['git push origin +feature/x', 'a force-push'],
    ['git push --no-verify --force origin x', 'a force-push'],
    ['git push origin --delete old-branch', 'a remote branch or tag deletion'],
    ['git push -d origin old-branch', 'a remote branch or tag deletion'],
    ['git push origin :refs/tags/v1', 'a remote branch or tag deletion'],
    ['Then git reset --hard origin/main.', 'reset --hard'],
    ['Clean the tree with git clean -fd.', 'a forced clean'],
    ['git clean --force -d', 'a forced clean'],
    ['Delete it with git branch -D old.', 'branch -D'],
    ['git branch --delete --force old', 'branch -D'],
    ['git branch -f -d old', 'branch -D'],
    // A negation on the other side of a contrast word does not cover the action.
    ['Do not force-push, but run git reset --hard.', 'reset --hard'],
    ['Never push to main; then git push --force origin feature/x.', 'a force-push'],
    // A skill test is not exempt.
    ['skill test: force-push the result as the skill says.', 'a force-push'],
  ]
  const ALLOWED: readonly string[] = [
    'Never force-push.',
    'no force-push, no branch deletion, no other push',
    'Never run `git reset --hard`, `git clean -fd` or `git branch -D`.',
    'Stop before any `git push --force` and report.',
    "A force-push needs the user's go-ahead: stop and report.",
    'Force-push is a sign-off item.',
    'You must not use git reset --hard on this tree.',
    "Don't delete the remote branch with git push origin --delete x.",
    'Push the branch to origin fast-forward only.',
    'git push -u origin feature/x',
    'git clean -n',
    'git branch -d merged',
    'git reset --soft HEAD~1',
    // A flag in another command span (a quoted string, a backtick span) belongs to no git verb.
    'clean `db/` with `make down && sudo rm -rf db/`',
  ]

  test('refused: each action as a step, by its words and its flags, with its line; the way out in the text', () => {
    for (const [sentence, label] of REFUSED) {
      const lint = signoffLint(`${ITEMS}${sentence}`)
      const prefix = `refused by the sign-off guard: the prompt instructs ${label} on line 2 as a step`
      expect({ sentence, refusal: lint.refusal?.slice(0, prefix.length) }).toEqual({ sentence, refusal: prefix })
    }
    expect(signoffLint(`${ITEMS}git push -f origin x\ngit reset --hard`).refusal).toBe(
      "refused by the sign-off guard: the prompt instructs a force-push on line 2, reset --hard on line 3 as a step for the worker; that needs the user's go-ahead in this conversation, a sign-off item the mod cannot see. " +
        'Raise an open point for the go-ahead and launch without the step; with the go-ahead the user runs it or says how, and a prompt may tell the worker to stop before it and report. ' +
        'A sentence that tells the worker not to do it (never, do not, stop before) passes; to authorise a class the user has recorded a Standing go-ahead for, write its commands, one per line, in a fenced block whose info line is signoff <id>',
    )
  })

  test('allowed: a sentence that says not to (never, do not, stop before, a sign-off, a go-ahead), and git commands that are not on the list', () => {
    for (const sentence of ALLOWED) expect({ sentence, lint: signoffLint(`${ITEMS}${sentence}`) }).toEqual({ sentence, lint: { warnings: [] } })
  })

  test('the negation window: 12 words before, 6 after, in the sentence; a negation further away does not cover the action', () => {
    // Widened to 20 words before, counted from the action's token (here `--force`), by the fix-up of the check.
    expect([NEGATION_WORDS_BEFORE, NEGATION_WORDS_AFTER]).toEqual([20, 6])
    const far = `Never ${'word '.repeat(18)}git push --force origin x`
    expect(signoffLint(far).refusal).toContain('a force-push on line 1')
    const near = `Never ${'word '.repeat(17)}git push --force origin x`
    expect(signoffLint(near).refusal).toBeUndefined()
    const after = 'git push --force origin x is never allowed'
    expect(signoffLint(after).refusal).toBeUndefined()
    const late = `git push --force origin x ${'word '.repeat(6)}never`
    expect(signoffLint(late).refusal).toContain('a force-push on line 1')
    expect(isNegatedAt('do not, however, run it', 16, 23)).toBe(false)
  })

  test('a push to main or develop warns (once per branch), unless negated; a skill test warns too', () => {
    expect(signoffLint(`${ITEMS}Push to main after the check. Then push develop.`).warnings).toEqual([
      "the prompt names a push to develop: a push to a protected branch needs the user's go-ahead where the project's push policy asks (a Standing decision push-<project>); check it before the worker pushes",
      "the prompt names a push to main: a push to a protected branch needs the user's go-ahead where the project's push policy asks (a Standing decision push-<project>); check it before the worker pushes",
    ])
    expect(signoffLint(`${ITEMS}Do not push to main. Never merge to develop.`).warnings).toEqual([])
    expect(signoffLint('skill test: git push origin main').warnings).toHaveLength(1)
  })
})

describe('the prompt guard: the negation rule of the fix-up (lint.ts)', () => {
  const refusedAs = (prompt: string) => /instructs (.*?) as a step/.exec(signoffLint(prompt).refusal ?? '')?.[1]

  test('the window is counted from the forbidden token, 20 words before and 6 after: a "never --force" after a push and a long "You may NOT" list pass', () => {
    for (const prompt of [
      'Push main to both remotes, fast-forward only, never --force.',
      'You may NOT merge to main, push to another remote, rewrite history, delete a branch, or force-push.',
      'You may NOT merge to main, push to any other remote, rewrite pushed history, delete a tag, or force-push the branch.',
    ]) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: undefined })
    }
    // 21 words between the negation and the token: out of the window.
    expect(refusedAs('You may NOT merge to main, push to any other remote, rewrite pushed history, delete any branch or tag, open a PR, or force-push the branch.')).toBe('a force-push on line 1')
    expect(isNegatedAt('never --force', 6, 13, 6)).toBe(true)
  })

  test('a past-tense mention describes and passes; the present and -ing forms still count', () => {
    for (const prompt of ['The branch was force-pushed by the user yesterday.', 'The tree was reset --hard before the run.', 'feature/x had been force-pushed twice.']) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: undefined })
    }
    expect(refusedAs('Force-push is fine here.')).toBe('a force-push on line 1')
    expect(refusedAs('Then force-pushing the branch is expected.')).toBe('a force-push on line 1')
  })

  test('a short flag counts only after git push or git clean: make -f, tail -f and rm -rf pass; git push -f and git clean -fdx do not', () => {
    for (const prompt of [
      'Clean up the scratch dir with rm -rf /tmp/x.',
      'Push the branch, then make -f build.mk.',
      'Push the branch, then tail -f the log.',
      'Push the branch and tail -f /tmp/log.',
      'Clean up the stale files: rm -rf build/ && make -f Makefile.ci',
      'git push -u origin feature/x',
      'git fetch --prune origin',
    ]) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: undefined })
    }
    for (const [prompt, label] of [
      ['Run git push -f origin x.', 'a force-push'],
      ['git -C /r push -f origin x', 'a force-push'],
      ['git push origin x -f', 'a force-push'],
      ['git clean -fdx', 'a forced clean'],
    ] as const) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: `${label} on line 1` })
    }
  })

  test('no and without count only when they govern the action; a go-ahead or a sign-off counts only as a gate on it', () => {
    for (const prompt of ['no force-push', 'Finish without force-pushing.', 'no `git push --force`', 'Finish without any git push --force.', "A force-push needs the user's go-ahead: stop and report.", 'Force-push is a sign-off item.']) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: undefined })
    }
    for (const prompt of ['Run git push --force with no prompt.', 'Without waiting for the check, git push --force origin x.', 'Get the go-ahead, then force-push.', "With the user's sign-off, force-push the branch.", 'You have the go-ahead: force-push.']) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: 'a force-push on line 1' })
    }
  })

  test('a negated list: each item of "never: a, b, c" and of a bullet list under a negating head line; a contrast word in an item does not pass', () => {
    for (const prompt of [
      'never: force-push, reset --hard, branch -D',
      'You may NOT:\n- force-push\n- git reset --hard\n- git branch -D x\n- git push origin --delete x',
      'Rules:\n- Never run these:\n  - git push --force\n  - git clean -fdx',
      "Actions that need the user's go-ahead (a push to a protected branch where the policy asks, a rewrite of pushed history, a deletion of a remote branch, `reset --hard`, `clean`, `branch -D`).",
    ]) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: undefined })
    }
    expect(refusedAs('You may NOT:\n- merge to main\n- skip the tests, but force-push the branch')).toBe('a force-push on line 3')
    // The list ends at a blank line, at a line that is no item, and at a sibling of a bulleted head.
    expect(refusedAs('Never:\n- force-push\n\n- git reset --hard')).toBe('reset --hard on line 4')
    expect(refusedAs('Never:\n- force-push\nThen:\n- git reset --hard')).toBe('reset --hard on line 4')
    expect(refusedAs('- Never run these:\n  - git push --force\n- git branch -D x')).toBe('branch -D on line 3')
    // A head line whose negation sits before a contrast word, or in an earlier sentence, negates nothing.
    expect(refusedAs('Do not stop; steps:\n- git push --force origin x')).toBe('a force-push on line 2')
    expect(refusedAs('Never stop, but do these:\n- git push --force origin x')).toBe('a force-push on line 2')
  })

  test('a quoted example: a command in backticks or quotes after refuse, denied, example, forms, such as or attack, or a fenced block after a line with one, passes; without such a word it is a step', () => {
    for (const prompt of [
      'The guard refuses `git push --force`, `git push origin :x` and `git branch -D x`.',
      'Forms it denies, such as "git push --force" and `git reset --hard`.',
      'Examples of refused prompts:\n```\ngit push --force origin x\ngit reset --hard\n```',
      'attack it: "never force-push, but if needed force-push", "do not push; run git push --force", `git clean -fdx`',
      'call `launch_worker` with a prompt containing a force-push step (must be refused with the sign-off text)',
      'the orchestrator-side denial of its own git push --force etc.',
      'it REFUSES a prompt that instructs a force-push (`--force`, `--force-with-lease`, `push -f`), a remote deletion (`push --delete`, `push origin :ref`)',
      'e.g. `git push --mirror backup`',
    ]) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: undefined })
    }
    for (const [prompt, label] of [
      ['Run `git push --force origin x` now.', 'a force-push on line 1'],
      ['For example, run this first; then `git push --force origin x`.', 'a force-push on line 1'],
      ['Example: build it, then run `git reset --hard`.', 'reset --hard on line 1'],
      ['Steps:\n```\ngit push --force origin x\n```', 'a force-push on line 3'],
      ['An example follows.\n\nNow:\n```\ngit branch -D x\n```', 'branch -D on line 5'],
    ] as const) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: label })
    }
  })

  test('still refused: a contrast word, a negation in another sentence or clause, and every flag and refspec form; a mirror and a pruning push too', () => {
    for (const [prompt, label] of [
      ['Never force-push, but if needed force-push.', 'a force-push'],
      ['never push to main, but if needed force-push', 'a force-push'],
      ['Do not push; run git push --force origin x.', 'a force-push'],
      ['Do not push. Run git push --force origin x.', 'a force-push'],
      ['You may not skip the tests. Then git reset --hard.', 'reset --hard'],
      ['you may not skip anything except git reset --hard', 'reset --hard'],
      ['Never stop unless you git push --force origin x.', 'a force-push'],
      ['Run git push --force-with-lease origin x.', 'a force-push'],
      ['git push origin +refs/heads/x', 'a force-push'],
      ['push origin :branch', 'a remote branch or tag deletion'],
      ['git push origin :branch', 'a remote branch or tag deletion'],
      ['git push origin --delete x', 'a remote branch or tag deletion'],
      ['git branch -D x', 'branch -D'],
      ['git reset --hard', 'reset --hard'],
      ['git push --mirror backup', 'a mirror push'],
      ['Mirror it with git push --mirror git@example.com:o/r.git.', 'a mirror push'],
      ['git push --prune origin', 'a pruning push'],
      ['The user authorised it: rebase on main and force-push the branch with git push --force-with-lease.', 'a force-push'],
      ['Delete the merged remote branch: git push origin --delete feature/old.', 'a remote branch or tag deletion'],
      ['After the merge, run git branch -D feature/old.', 'branch -D'],
    ] as const) {
      expect({ prompt, refused: refusedAs(prompt) }).toEqual({ prompt, refused: `${label} on line 1` })
    }
  })
})

describe('the orchestrator command guard (guard.ts)', () => {
  test('gitSignoffAction: each action, git options before the subcommand passed over; others pass', () => {
    const verdict = (line: string) => gitSignoffAction(line.split(' '))?.how
    for (const [line, how] of [
      ['push --force origin x', 'git push --force'],
      ['-C /r push -uf origin x', 'git push --force'],
      ['-c core.x=1 push origin +main', 'git push --force'],
      ['--git-dir /r/.git push --force-with-lease origin x', 'git push --force'],
      ['push origin --delete x', 'git push --delete'],
      ['push origin :refs/tags/v1', 'git push --delete'],
      ['reset --hard origin/main', 'git reset --hard'],
      ['clean -xfd', 'git clean -f'],
      ['branch -D x', 'git branch -D'],
      ['branch -df x', 'git branch -D'],
      ['branch --delete --force x', 'git branch -D'],
    ] as const) {
      expect({ line, how: verdict(line) }).toEqual({ line, how })
    }
    for (const line of ['push origin feature/x', 'push -u origin HEAD:refs/heads/x', 'reset --soft HEAD~1', 'clean -n', 'branch -d x', 'log --oneline', 'worktree remove /w/x --force']) {
      expect({ line, how: verdict(line) }).toEqual({ line, how: undefined })
    }
  })

  test('gitSignoffAction: a mirror push and a pruning push are refused; fetch --prune and remote prune are not', () => {
    const verdict = (line: string) => gitSignoffAction(line.split(' '))?.how
    for (const [line, how] of [
      ['push --mirror backup', 'git push --mirror'],
      ['-C /r push --mirror git@example.com:o/r.git', 'git push --mirror'],
      ['push --prune origin refs/heads/*:refs/heads/*', 'git push --prune'],
    ] as const) {
      expect({ line, how: verdict(line) }).toEqual({ line, how })
    }
    for (const line of ['fetch --prune origin', 'remote prune origin', 'push origin feature/x']) expect({ line, how: verdict(line) }).toEqual({ line, how: undefined })
    expect(signoffVerdict('cd /r && git push --mirror backup', 'bash')?.what).toBe('a mirror push, which overwrites and deletes remote refs')
    expect(signoffVerdict('git push --prune origin', 'powershell')?.how).toBe('git push --prune')
  })

  test('signoffVerdict reads the command as the helper-file guard does: nested shells and substitutions are code; heredoc bodies and quoted arguments are text', () => {
    for (const command of ['cd /r && git push --force', 'bash -c "git push -f origin x"', 'echo "$(git reset --hard)"', "bash <<'EOF'\ngit reset --hard\nEOF", 'pwsh -c "git branch -D x"', 'sudo git clean -fd']) {
      expect({ command, isRefused: signoffVerdict(command, 'bash') !== undefined }).toEqual({ command, isRefused: true })
    }
    for (const command of ["cat > /tmp/p.md <<'EOF'\nnever run git push --force\nEOF", 'echo "git push --force is forbidden"', 'git commit -m "docs: never git push --force"', 'grep -n "reset --hard" CLAUDE.md']) {
      expect({ command, isRefused: signoffVerdict(command, 'bash') !== undefined }).toEqual({ command, isRefused: false })
    }
    expect(signoffVerdict('git push --force origin x', 'powershell')?.how).toBe('git push --force')
    expect(signoffDenyText('Bash', { how: 'git push --force', what: 'a force-push or history rewrite' })).toBe(
      "session-control: refused by the sign-off guard: git push --force is a force-push or history rewrite, an action on the sign-off list (Bash). The orchestrator never runs it itself: this repository's rules give pushes and resets to workers, and this one needs the user's go-ahead in this conversation, which the mod cannot see. Raise an open point for the go-ahead; with it the user runs the step or says how.",
    )
  })
})

async function started($: { session: { start: (e: never) => Promise<unknown> }; tool: { call: (e: never) => Promise<unknown> } }, on: On, cwd = ORCH): Promise<{ world: World; call: (tool: string, input: Record<string, unknown>) => Promise<{ deny?: string; isPassed: boolean; result?: unknown }> }> {
  const world = mockWorld(on)
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  world.files.set(REGISTRY, '[]\n')
  world.files.set('/w/work/keep', 'x')
  await $.session.start({ cwd, surface: null, isInteractive: true } as never)
  const call = async (tool: string, input: Record<string, unknown>) => {
    const before = world.passed.length
    const answer = (await $.tool.call({ tool, ...input } as never)) as { deny?: unknown; result?: unknown }
    return { ...(answer.deny === undefined ? {} : { deny: String(answer.deny) }), result: answer.result, isPassed: world.passed.length > before }
  }
  return { world, call }
}

describe('the sign-off guard through the plugin', () => {
  test('the orchestrator session: a force-push, a remote deletion, a hard reset, a forced clean and branch -D are refused; a plain push and a heredoc that names one run', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on)
    for (const command of ['git push --force-with-lease origin feature/x', 'git push origin --delete old', 'git -C /w/work reset --hard origin/main', 'git clean -fdx', 'git branch -D merged-already']) {
      const answer = await call('Bash', { command })
      const prefix = 'session-control: refused by the sign-off guard: git '
      expect({ command, isPassed: answer.isPassed, deny: answer.deny?.slice(0, prefix.length) }).toEqual({ command, isPassed: false, deny: prefix })
    }
    expect((await call('PowerShell', { command: 'git push -f origin x' })).deny).toContain('(PowerShell)')
    for (const command of ['git push origin feature/x', "cat > /tmp/p.md <<'EOF'\nNever run git push --force.\nEOF", 'git status -sb']) {
      expect({ command, isPassed: (await call('Bash', { command })).isPassed }).toEqual({ command, isPassed: true })
    }
  })

  test('the orchestrator session: a mirror push and a pruning push are refused; git fetch --prune runs', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on)
    expect((await call('Bash', { command: 'git push --mirror backup' })).deny).toStartWith('session-control: refused by the sign-off guard: git push --mirror is a mirror push')
    expect((await call('Bash', { command: 'git -C /w/work push --prune origin' })).deny).toStartWith('session-control: refused by the sign-off guard: git push --prune is deleting')
    expect((await call('Bash', { command: 'git fetch --prune origin' })).isPassed).toBe(true)
  })

  test('another directory\'s session: the command guard does nothing', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on, '/w/work')
    expect((await call('Bash', { command: 'git push --force origin x' })).isPassed).toBe(true)
  })

  test('launch_worker: a prompt with a force-push step is refused, nothing launched; "never force-push" is launched; a skill test is not exempt; a push to main warns', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    const launch = (prompt: string) => call('mcp__session-control__launch_worker', { dir: '/w/work', model: 'haiku', effort: 'low', title: 'signoff case', prompt })
    const refused = await launch(`${ITEMS}Rebase, then git push --force-with-lease origin feature/x.`)
    expect(refused.deny).toStartWith('session-control: refused by the sign-off guard: the prompt instructs a force-push on line 2 as a step for the worker;')
    expect(refused.deny).toEndWith('; nothing was launched')
    expect((await launch(`skill test: force-push the branch.`)).deny).toContain('refused by the sign-off guard')
    expect(world.passed.filter(one => one.tool === 'Bash')).toEqual([])
    const allowed = await launch(`${ITEMS}Commit and push fast-forward only; never force-push.`)
    expect(allowed.deny).toBeUndefined()
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
    const warned = await launch(`${ITEMS}Merge and push to main when green.`)
    expect(warned.deny).toBeUndefined()
    expect(String(warned.result)).toContain('\nWARNING: the prompt names a push to main:')
  })
})

// ---------------------------------------------------------------- a signoff block

const DECISIONS = [
  '# Agreed decisions',
  '',
  '## A unit (user, 2026-10-12)',
  'unit-1. Something decided.',
  'signoff-in-unit. [signoff:delete-branch] A marked line outside a Standing section.',
  '',
  '## Standing',
  'push-scratch. Pushes to main need no go-ahead.',
  'signoff-delete-branches. [signoff:delete-branch] User: delete merged branches from both remotes and locally; never main, develop or release/*.',
  'signoff-rewrite-root-author. [signoff:force-push] User: rewrite the root author and push main to both remotes (origin and backup) with --force-with-lease.',
  'signoff-no-marker. User: a go-ahead whose line carries no marker at its start [signoff:delete-branch].',
  '',
  '## Session-control mod',
  'signoff-after-standing. [signoff:delete-branch] A marked line after the Standing section ended.',
  '',
].join('\n')
const STANDING: StandingRead = { text: DECISIONS }
const DELETE_ID = 'signoff-delete-branches'
const LEASE_ID = 'signoff-rewrite-root-author'
const MAIN_WARNING = "the prompt names a push to main: a push to a protected branch needs the user's go-ahead where the project's push policy asks (a Standing decision push-<project>); check it before the worker pushes"
const FORMS_TEXT =
  'a signoff block holds one command per line, nothing else, each of the class of its go-ahead: git push <remote> --delete refs/heads/<name>, git push <remote> :refs/heads/<name> or git branch -d <name> for delete-branch, git push --force-with-lease <remote> main or git push --force-with-lease <remote> <branch> (also refs/heads/<branch>), <branch> one feature/... or bugfix/... branch the go-ahead\'s line names or covers with feature/* or bugfix/*, for force-push (README, Sign-off guard)'

/** A signoff block citing `id`, with these lines. */
const block = (id: string, ...lines: string[]) => `\`\`\`signoff ${id}\n${lines.join('\n')}\n\`\`\``
/** The guard with the decisions file of this test read (STANDING), or the one given. */
const guarded = (prompt: string, standing: StandingRead = STANDING, ownLines?: number) => signoffLint(prompt, standing, ownLines)
/** What a block's refusal says is wrong: the text between `(signoff <id>): ` and the forms. */
const faultOf = (prompt: string, standing: StandingRead = STANDING) => /^refused by the sign-off guard: the signoff block on line \d+ \(signoff [^)]*\): (.*); a signoff block holds/.exec(guarded(prompt, standing).refusal ?? '')?.[1]
/** What a syntax refusal says: the text after `line <n> ` up to the forms. */
const brokenOf = (prompt: string) => /^refused by the sign-off guard: (line \d+ .*); a signoff block holds/.exec(guarded(prompt).refusal ?? '')?.[1]
/** The actions a refusal of the check outside the blocks lists. */
const listedOf = (lint: { refusal?: string }) => /instructs (.*?) as a step/.exec(lint.refusal ?? '')?.[1]
const notAForm = (cls: string, at = 1, line = 3) => `its line ${at} (line ${line} of the prompt) is not one command in a form of the ${cls} class`

describe('a signoff block (lint.ts)', () => {
  test('standingGrants: the marked lines of Standing sections only (## Standing, ## Standing:..., ## Standing <text>, in that case), none inside a fenced block; a BOM, CRLF and CR read', () => {
    expect(standingGrants(DECISIONS)).toEqual([
      { id: DELETE_ID, actionClass: 'delete-branch', text: ' User: delete merged branches from both remotes and locally; never main, develop or release/*.' },
      { id: LEASE_ID, actionClass: 'force-push', text: ' User: rewrite the root author and push main to both remotes (origin and backup) with --force-with-lease.' },
    ])
    const marked = (id: string) => `${id}. [signoff:delete-branch] go.`
    const ids = (text: string) => standingGrants(text).map(one => one.id)
    for (const [name, text, expected] of [
      ['## Standing', `## Standing\n${marked('s1')}\n`, ['s1']],
      ['## Standing: text', `## Standing: the mod (user)\n${marked('s1')}\n`, ['s1']],
      ['## Standing text', `## Standing for the repo\n${marked('s1')}\n`, ['s1']],
      ['## standing', `## standing\n${marked('s1')}\n`, []],
      ['## Standing-ish', `## Standing-ish\n${marked('s1')}\n`, []],
      ['## Standings', `## Standings\n${marked('s1')}\n`, []],
      ['## Standing and a blank only', `## Standing \n${marked('s1')}\n`, []],
      ['##Standing', `##Standing\n${marked('s1')}\n`, []],
      ['### Standing under a unit', `## Unit\n### Standing\n${marked('s1')}\n`, []],
      ['# Standing', `# Standing\n${marked('s1')}\n`, []],
      ['a ### heading stays inside', `## Standing\n### More\n${marked('s1')}\n`, ['s1']],
      ['##Other stays inside', `## Standing\n##Other\n${marked('s1')}\n`, ['s1']],
      ['a # heading ends it', `## Standing\n# Other\n${marked('s1')}\n`, []],
      ['a ## heading ends it', `## Standing\nx. y\n## Unit\n${marked('s1')}\n`, []],
      ['## Standing inside a fence of a unit', `## Unit\n\`\`\`\n## Standing\n\`\`\`\n${marked('s1')}\n`, []],
      ['## Standing inside a tilde fence', `## Unit\n~~~\n## Standing\n${marked('s1')}\n~~~\n`, []],
      ['a marked line inside a fence of a Standing section', `## Standing\n\`\`\`\n${marked('s1')}\n\`\`\`\n${marked('s2')}\n`, ['s2']],
      ['a ## heading inside a fence does not end it', `## Standing\n\`\`\`md\n## Unit\n\`\`\`\n${marked('s1')}\n`, ['s1']],
      ['the marker not right after the id', '## Standing\ns1. User [signoff:delete-branch]\n', []],
      ['the marker misspelt', '## Standing\ns1. [signoff:delete-branches] User\n', []],
      ['the marker in upper case', '## Standing\ns1. [SIGNOFF:delete-branch] User\n', []],
      ['no blank after the dot', '## Standing\ns1.[signoff:delete-branch] User\n', []],
      ['a bullet before the id', `## Standing\n- ${marked('s1')}\n`, []],
      ['indented', `## Standing\n  ${marked('s1')}\n`, []],
      ['two Standing sections', `## Standing\n${marked('s1')}\n## Unit\n${marked('u1')}\n## Standing: more\n${marked('s2')}\n`, ['s1', 's2']],
      ['an id once, from its first marked line', `## Standing\ns1. User: plain\n${marked('s1')}\ns1. [signoff:force-push] later\n`, ['s1']],
      ['CRLF', `# D\r\n\r\n## Standing\r\n${marked('s1')}\r\n`, ['s1']],
      ['CR', `# D\r\r## Standing\r${marked('s1')}\r`, ['s1']],
      ['a BOM before the heading', `\ufeff## Standing\n${marked('s1')}\n`, ['s1']],
      ['empty', '', []],
    ] as const) {
      expect({ name, ids: ids(text) }).toEqual({ name, ids: [...expected] })
    }
    expect(standingGrants(`## Standing\ns1. User: plain\n${marked('s1')}\ns1. [signoff:force-push] later\n`)[0]?.actionClass).toBe('delete-branch')
    // A file of more than 3 MB with its Standing section at the end is read whole (the read cap is the engine's, below).
    const big = `# D\n\n## Unit\n${'u-1. x\n'.repeat(450_000)}## Standing\n${marked('s-big')}\n`
    expect(big.length).toBeGreaterThan(3_000_000)
    expect(ids(big)).toEqual(['s-big'])
  })

  test('delete-branch: each line form passes, every line named in one warning line with the id and the class', () => {
    const lines = [
      'git push origin --delete refs/heads/feature/old',
      'git push backup :refs/heads/feature/old',
      'git branch -d feature/old',
      'git push origin --delete refs/heads/bugfix/a-1.2_b',
      'git push upstream-2 :refs/heads/x',
      'git branch -d maintenance',
      'git branch -d mainline',
      'git push origin --delete refs/heads/releases',
      'git push origin --delete refs/heads/developer-notes',
      'git branch -d Feature/A',
      'git push my.remote --delete refs/heads/a/b/c',
    ]
    for (const line of [...lines, `git push origin --delete refs/heads/feature/${'x'.repeat(5000)}`]) {
      expect({ line, lint: guarded(`${ITEMS}${block(DELETE_ID, line)}`) }).toEqual({ line, lint: { warnings: [`sign-off allowed by ${DELETE_ID}: delete-branch: ${line}`], allowed: [{ id: DELETE_ID, actionClass: 'delete-branch', commands: [line] }] } })
    }
    const all = guarded(`${ITEMS}Delete the merged branches:\n${block(DELETE_ID, ...lines)}\nThen report.`)
    expect(all).toEqual({ warnings: [`sign-off allowed by ${DELETE_ID}: delete-branch: ${lines.join('; ')}`], allowed: [{ id: DELETE_ID, actionClass: 'delete-branch', commands: lines }] })
  })

  test('force-push: git push --force-with-lease[=main|=refs/heads/main] <a remote its line holds as a word> main passes, with the push-to-main warning', () => {
    for (const line of ['git push --force-with-lease origin main', 'git push --force-with-lease backup main', 'git push --force-with-lease=main origin main', 'git push --force-with-lease=refs/heads/main backup main']) {
      expect({ line, lint: guarded(`${ITEMS}${block(LEASE_ID, line)}`) }).toEqual({ line, lint: { warnings: [MAIN_WARNING, `sign-off allowed by ${LEASE_ID}: force-push: ${line}`], allowed: [{ id: LEASE_ID, actionClass: 'force-push', commands: [line] }] } })
    }
  })

  test('a line no form takes whole refuses its block, naming the line: protected names, short ref paths of each namespace, the bare remote form, globs, variables, options, more refs, other remotes and forms', () => {
    const DELETE_REFUSED = [
      'git push origin --delete refs/heads/main', 'git push origin --delete refs/heads/Main', 'git push origin --delete refs/heads/MASTER', 'git push origin --delete refs/heads/develop', 'git push origin --delete refs/heads/release',
      'git push origin --delete refs/heads/release/1.0', 'git push origin --delete refs/heads/Release/x', 'git push origin --delete refs/heads/HEAD', 'git push origin :refs/heads/main', 'git push origin :refs/heads/develop',
      'git branch -d main', 'git branch -d Develop', 'git branch -d release/2', 'git branch -d RELEASE', 'git branch -d master', 'git branch -d head',
      // The bare remote form: git resolves a bare name against every ref of the remote.
      'git push origin --delete feature/old', 'git push origin :feature/old', 'git push origin --delete x', 'git push origin --delete main',
      // git's short ref paths and special refs, under refs/heads/ and bare.
      ...['heads/main', 'heads/feature/a', 'tags/x', 'remotes/origin/x', 'for/x', 'pull/1/head', 'notes/commits', 'refs/tags/x', 'refs/remotes/origin/x', 'refs/notes/x', 'changes/1', 'HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'Tags/x', 'HEADS/main'].flatMap(ref => [
        `git push origin --delete refs/heads/${ref}`,
        `git push origin :refs/heads/${ref}`,
        `git branch -d ${ref}`,
      ]),
      'git push origin --delete refs/heads/feature/*', 'git push origin --delete refs/heads/a?', 'git push origin --delete refs/heads/[ab]', 'git push origin --delete refs/heads/$B', 'git push origin --delete refs/heads/${B}',
      'git push origin --delete "refs/heads/a"', "git branch -d 'a'", 'git branch -d `a`', 'git branch -d $(echo a)', 'git branch -d a~1', 'git branch -d a^', 'git branch -d a..b', 'git branch -d a//b', 'git branch -d a/', 'git branch -d a.',
      'git branch -d a./b', 'git branch -d a.lock', 'git branch -d a.LOCK/b', 'git branch -d .a', 'git branch -d -a', 'git branch -d a@{1}', 'git branch -d @', 'git branch -d a:b', 'git branch -d +a', 'git branch -d refs/heads/a',
      'git push origin --delete refs/heads/a refs/heads/b', 'git push origin :refs/heads/a :refs/heads/b', 'git branch -d a b', 'git push --delete origin refs/heads/a', 'git push -d origin refs/heads/a', 'git push origin -d refs/heads/a',
      'git push origin --delete refs/heads/a --no-verify', 'git push --no-verify origin --delete refs/heads/a', 'git push origin --delete --force refs/heads/a', 'git branch --delete a', 'git branch -D a', 'git branch -d -f a', 'git branch -df a',
      'git -C /r push origin --delete refs/heads/a', 'git -c x=y branch -d a', 'push origin --delete refs/heads/a', 'git push origin --delete', 'git push origin :', 'git branch -d',
      'git push /tmp/r.git --delete refs/heads/a', 'git push ../r --delete refs/heads/a', 'git push . --delete refs/heads/a', 'git push https://example.invalid/r.git --delete refs/heads/a', 'git push git@example.invalid:r.git --delete refs/heads/a',
      'git push $REMOTE --delete refs/heads/a', 'git push "origin" --delete refs/heads/a', 'git push main --delete refs/heads/a', 'git push heads --delete refs/heads/a', 'git push -q --delete refs/heads/a',
      ' git push origin --delete refs/heads/a', 'git push origin --delete refs/heads/a ', 'git push  origin --delete refs/heads/a', 'git\tpush origin --delete refs/heads/a', 'git push origin --delete refs/heads/a\r',
      'GIT push origin --delete refs/heads/a', 'git PUSH origin --delete refs/heads/a', 'git push origin --DELETE refs/heads/a', 'git push origin --delete REFS/HEADS/a', 'git push origin \u2010\u2010delete refs/heads/a',
      'git push origin --delete refs/heads/\u200ba', 'git push origin --delete refs/heads/caf\u00e9',
    ]
    for (const line of DELETE_REFUSED) expect({ line, fault: faultOf(`${ITEMS}${block(DELETE_ID, line)}`) }).toEqual({ line, fault: notAForm('delete-branch') })
    const LEASE_REFUSED = [
      'git push --force-with-lease origin main:main', 'git push --force-with-lease origin +main', 'git push --force-with-lease origin refs/heads/main', 'git push --force-with-lease origin HEAD:main', 'git push --force-with-lease origin main:develop',
      'git push --force-with-lease origin develop', 'git push --force-with-lease origin feature/x', 'git push --force-with-lease origin', 'git push --force-with-lease main', 'git push --force-with-lease', 'git push --force-with-lease main main',
      'git push --force-with-lease remotes main', 'git push origin main --force-with-lease', 'git push origin --force-with-lease main', 'git push --force-with-lease=main:abc123 origin main', 'git push --force-with-lease=develop origin main',
      'git push --force-with-lease=origin/main origin main', 'git push --force-with-lease= origin main', 'git push --force-with-lease=main:$SHA origin main', 'git push --force origin main', 'git push -f origin main', 'git push origin +main',
      'git push --force-with-lease --force origin main', 'git push --force-with-lease --force-if-includes origin main', 'git push --force-with-lease --no-verify origin main', 'git push --force-with-lease origin main --no-verify',
      'git push --force-with-lease origin main develop', 'git push --force-with-lease origin main +develop', 'git push --force-with-lease origin main "+develop"', 'git push --force-with-lease /tmp/r.git main', 'git push --force-with-lease $REMOTE main',
      'git -C /r push --force-with-lease origin main', 'git -c remote.origin.url=/tmp/x push --force-with-lease origin main', 'push --force-with-lease origin main', 'force-push main to origin', 'git push --mirror --force-with-lease origin',
    ]
    for (const line of LEASE_REFUSED) expect({ line, fault: faultOf(`${ITEMS}${block(LEASE_ID, line)}`) }).toEqual({ line, fault: notAForm('force-push') })
    // A remote the go-ahead's line does not hold as a word (in this case).
    for (const remote of ['upstream', 'Origin', 'mirror', 'orig']) {
      expect(faultOf(`${ITEMS}${block(LEASE_ID, `git push --force-with-lease ${remote} main`)}`)).toBe(`its line 1 (line 3 of the prompt) pushes to ${remote}, a word the line of ${LEASE_ID} does not hold`)
    }
    // The first line that fails is named, by its place in the block and in the prompt.
    expect(faultOf(`${ITEMS}${block(DELETE_ID, 'git push origin --delete refs/heads/a', 'git branch -d b', 'git push origin --delete refs/heads/main', 'git push origin --delete x')}`)).toBe(notAForm('delete-branch', 3, 5))
    expect(guarded(`${ITEMS}${block(DELETE_ID, 'git push origin --delete refs/heads/main')}`)).toEqual({ refusal: `refused by the sign-off guard: the signoff block on line 2 (signoff ${DELETE_ID}): ${notAForm('delete-branch')}; ${FORMS_TEXT}`, warnings: [] })
  })

  // The checker's bypass families: what a shell or git reads beyond what a word-reading parser read.
  const FAMILIES: readonly (readonly [string, string, 'delete' | 'lease'])[] = [
    ['an extra quoted name', 'git push origin --delete refs/heads/feature/a "develop"', 'delete'],
    ['an extra quoted name', "git push origin --delete refs/heads/feature/a 'develop'", 'delete'],
    ['a substitution', 'git push origin --delete refs/heads/feature/a `printf develop`', 'delete'],
    ['a substitution', 'git push origin --delete refs/heads/feature/a $(printf develop)', 'delete'],
    ['a substitution', 'git push origin --delete refs/heads/feature/a "$B"', 'delete'],
    ['a substitution', 'git push origin --delete refs/heads/$B', 'delete'],
    ['an extra plus refspec', 'git push --force-with-lease origin main "+develop"', 'lease'],
    ['an extra plus refspec', 'git push --force-with-lease origin main +develop', 'lease'],
    ['an extra plus refspec', 'git push --force-with-lease origin +main', 'lease'],
    ['xargs', 'echo develop | xargs git push origin --delete refs/heads/feature/a', 'delete'],
    ['xargs', "printf 'main\\n' | xargs -n1 git push origin --delete", 'delete'],
    ['a prose list', 'git push origin --delete refs/heads/feature/a, refs/heads/feature/b and develop', 'delete'],
    ['a prose list', 'git push origin --delete refs/heads/feature/a and develop', 'delete'],
    ...['heads/main', 'heads/develop', 'heads/release/1.0', 'tags/x', 'remotes/origin/main', 'for/main', 'pull/1/head', 'notes/commits'].flatMap(ref => [
      ['a short ref path', `git push origin --delete ${ref}`, 'delete'] as const,
      ['a short ref path', `git push origin :${ref}`, 'delete'] as const,
      ['a short ref path', `git push origin --delete refs/heads/${ref}`, 'delete'] as const,
    ]),
    ...['then', 'if', 'so', 'but', 'until', 'while', 'once', 'unless', 'except', 'after', 'before', 'when', 'and', 'or'].map(word => ['a clause word', `git push origin --delete refs/heads/feature/a ${word} develop`, 'delete'] as const),
    ...['.', '!', '?', ':', ',', ';'].map(mark => ['punctuation', `git push origin --delete refs/heads/feature/a${mark} develop`, 'delete'] as const),
    ['punctuation', 'git push origin --delete refs/heads/feature/a (develop)', 'delete'],
    ['a clause word', 'git push --force-with-lease origin main then develop', 'lease'],
    ['punctuation', 'git push --force-with-lease origin main, develop', 'lease'],
  ]

  test('the bypass families inside a block: each line is refused, named by its place', () => {
    for (const [family, line, kind] of FAMILIES) {
      const prompt = `${ITEMS}${block(kind === 'delete' ? DELETE_ID : LEASE_ID, kind === 'delete' ? 'git branch -d feature/ok' : 'git push --force-with-lease origin main', line)}`
      expect({ family, line, fault: faultOf(prompt) }).toEqual({ family, line, fault: notAForm(kind === 'delete' ? 'delete-branch' : 'force-push', 2, 4) })
    }
  })

  test('the bypass families outside a block, after a valid one: refused as without a block, with the same text', () => {
    const valid = block(DELETE_ID, 'git push origin --delete refs/heads/feature/ok')
    for (const [family, line] of FAMILIES) {
      for (const shape of [(one: string) => one, (one: string) => `Then run ${one} as well.`, (one: string) => `Run \`${one}\`.`]) {
        const after = guarded(`${ITEMS}${valid}\n${shape(line)}`)
        // The same line on the same line number with no block before it: main's check.
        const alone = signoffLint(`${ITEMS}x\nx\nx\n${shape(line)}`)
        expect({ family, line: shape(line), refusal: after.refusal }).toEqual({ family, line: shape(line), refusal: alone.refusal })
        expect({ family, line: shape(line), refused: after.refusal?.startsWith('refused by the sign-off guard: the prompt instructs ') }).toEqual({ family, line: shape(line), refused: true })
      }
    }
    // A step in other words, after a valid block: the guard reads commands, as without a block.
    expect(guarded(`${ITEMS}${valid}\nThen delete develop on origin too.`)).toEqual({ warnings: [`sign-off allowed by ${DELETE_ID}: delete-branch: git push origin --delete refs/heads/feature/ok`], allowed: [{ id: DELETE_ID, actionClass: 'delete-branch', commands: ['git push origin --delete refs/heads/feature/ok'] }] })
  })

  test('the block syntax: unterminated, nested, four backticks or tildes, info line faults, quoted or indented, CR, tabs, lookalikes and zero-width characters refuse; two blocks pass; an empty line or 101 lines refuse', () => {
    const line = 'git push origin --delete refs/heads/a'
    const opener = `\`\`\`signoff ${DELETE_ID}`
    const prefix = "line 2 is written as a signoff block's opening line but is not exactly ```signoff <id>: "
    for (const [name, prompt, broken] of [
      ['unterminated', `${ITEMS}${opener}\n${line}\n`, 'line 2 opens a signoff block that no line of exactly three backticks closes'],
      ['closed by four backticks only', `${ITEMS}${opener}\n${line}\n\`\`\`\``, 'line 2 opens a signoff block that no line of exactly three backticks closes'],
      ['closed by three backticks and a blank only', `${ITEMS}${opener}\n${line}\n\`\`\` `, 'line 2 opens a signoff block that no line of exactly three backticks closes'],
      ['four backticks', `${ITEMS}\`\`\`\`signoff ${DELETE_ID}\n${line}\n\`\`\`\``, `${prefix}its fence has more than three backticks`],
      ['tildes', `${ITEMS}~~~signoff ${DELETE_ID}\n${line}\n~~~`, `${prefix}its fence is not three backticks`],
      ['a second word', `${ITEMS}${opener} now\n${line}\n\`\`\``, `${prefix}its info line is not exactly the word signoff, one blank and one decision id (no other word, no trailing blank)`],
      ['a trailing blank', `${ITEMS}${opener} \n${line}\n\`\`\``, `${prefix}its info line is not exactly the word signoff, one blank and one decision id (no other word, no trailing blank)`],
      ['two blanks', `${ITEMS}\`\`\`signoff  ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}its info line is not exactly the word signoff, one blank and one decision id (no other word, no trailing blank)`],
      ['no id', `${ITEMS}\`\`\`signoff\n${line}\n\`\`\``, `${prefix}its info line is not exactly the word signoff, one blank and one decision id (no other word, no trailing blank)`],
      ['a blank after the fence', `${ITEMS}\`\`\` signoff ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}its info line does not start with the word signoff, in lower case, right after the backticks`],
      ['Signoff', `${ITEMS}\`\`\`Signoff ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}its info line does not start with the word signoff, in lower case, right after the backticks`],
      ['sign-off', `${ITEMS}\`\`\`sign-off ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}its info line does not start with the word signoff, in lower case, right after the backticks`],
      ['quoted', `${ITEMS}> ${opener}\n> ${line}\n> \`\`\``, `${prefix}it does not start at the start of the line (an indented or quoted fence)`],
      ['indented', `${ITEMS}  ${opener}\n  ${line}\n  \`\`\``, `${prefix}it does not start at the start of the line (an indented or quoted fence)`],
      ['CRLF', `${ITEMS.replace('\n', '\r\n')}${opener}\r\n${line}\r\n\`\`\`\r\n`, `${prefix}it ends with a carriage return (a prompt with CRLF line ends holds no signoff block)`],
      ['a tab', `${ITEMS}\`\`\`signoff\t${DELETE_ID}\n${line}\n\`\`\``, `${prefix}it holds a tab`],
      ['a zero-width space in the info line', `${ITEMS}\`\`\`signoff\u200b ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}it holds an invisible format character (a zero-width space, say)`],
      ['a zero-width space in the fence', `${ITEMS}\`\`\u200b\`signoff ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}it holds an invisible format character (a zero-width space, say)`],
      ['fullwidth backticks', `${ITEMS}\uff40\uff40\uff40signoff ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}it holds a character that is not printable ASCII (a lookalike of a backtick, a letter or a blank)`],
      ['modifier grave accents', `${ITEMS}\u02cb\u02cb\u02cbsignoff ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}it holds a character that is not printable ASCII (a lookalike of a backtick, a letter or a blank)`],
      ['a lookalike hyphen', `${ITEMS}\`\`\`sign\u2010off ${DELETE_ID}\n${line}\n\`\`\``, `${prefix}it holds a character that is not printable ASCII (a lookalike of a backtick, a letter or a blank)`],
      ['a no-break space', `${ITEMS}\`\`\`signoff\u00a0${DELETE_ID}\n${line}\n\`\`\``, `${prefix}it holds a character that is not printable ASCII (a lookalike of a backtick, a letter or a blank)`],
    ] as const) {
      expect({ name, broken: brokenOf(prompt) }).toEqual({ name, broken })
    }
    // Inside another fenced block an opening line is no block: its lines are read as without one, and refused.
    for (const [name, prompt] of [
      ['in a four-backtick fence', `${ITEMS}\`\`\`\`\n${opener}\n${line}\n\`\`\`\n\`\`\`\``],
      ['in a tilde fence', `${ITEMS}~~~\n${opener}\n${line}\n\`\`\`\n~~~`],
      ['in a backtick fence', `${ITEMS}\`\`\`text\n${opener}\n${line}\n\`\`\``],
    ] as const) {
      const lint = guarded(prompt)
      expect({ name, lint }).toEqual({ name, lint: signoffLint(prompt) })
      expect({ name, listed: listedOf(lint) }).toEqual({ name, listed: 'a remote branch or tag deletion on line 4' })
    }
    // A sound block after a line that introduces an example is a block all the same, and named in the warning.
    expect(guarded(`${ITEMS}For example:\n${block(DELETE_ID, line)}`).warnings).toEqual([`sign-off allowed by ${DELETE_ID}: delete-branch: ${line}`])
    // Two blocks: each go-ahead its own warning line, a go-ahead's blocks in one, in order.
    expect(guarded(`${ITEMS}${block(DELETE_ID, line)}\nThen:\n${block(LEASE_ID, 'git push --force-with-lease origin main')}\nAnd:\n${block(DELETE_ID, 'git branch -d a')}`)).toEqual({
      warnings: [MAIN_WARNING, `sign-off allowed by ${DELETE_ID}: delete-branch: ${line}; git branch -d a`, `sign-off allowed by ${LEASE_ID}: force-push: git push --force-with-lease origin main`],
      allowed: [
        { id: DELETE_ID, actionClass: 'delete-branch', commands: [line, 'git branch -d a'] },
        { id: LEASE_ID, actionClass: 'force-push', commands: ['git push --force-with-lease origin main'] },
      ],
    })
    expect(faultOf(`${ITEMS}${block(DELETE_ID, line)}\n${block(DELETE_ID, 'git branch -d main')}`)).toBe(notAForm('delete-branch', 1, 6))
    for (const [name, lines, fault] of [
      ['an empty line', [line, '', 'git branch -d a'], 'its line 2 (line 4 of the prompt) is empty'],
      ['a line of blanks', [line, '   '], notAForm('delete-branch', 2, 4)],
      ['a comment', [line, '# the merged ones'], notAForm('delete-branch', 2, 4)],
      ['prose', [line, 'and the other merged ones'], notAForm('delete-branch', 2, 4)],
      ['a continued line', ['git push origin --delete \\', 'refs/heads/a'], notAForm('delete-branch', 1, 3)],
      ['a carriage return in a line', [`${line}\r`], notAForm('delete-branch')],
      ['a tab in a line', ['git branch -d\ta'], notAForm('delete-branch')],
      ['no line', [], 'it holds no command'],
    ] as const) {
      const prompt = (lines as readonly string[]).length === 0 ? `${ITEMS}\`\`\`signoff ${DELETE_ID}\n\`\`\`` : `${ITEMS}${block(DELETE_ID, ...lines)}`
      expect({ name, fault: faultOf(prompt) }).toEqual({ name, fault })
    }
    const many = (count: number) => block(DELETE_ID, ...Array.from({ length: count }, (_, at) => `git push origin --delete refs/heads/feature/n${at}`))
    expect(guarded(`${ITEMS}${many(BLOCK_MAX_LINES)}`).allowed?.[0]?.commands.length).toBe(100)
    expect(faultOf(`${ITEMS}${many(BLOCK_MAX_LINES + 1)}`)).toBe('it holds 101 lines, more than 100')
  })

  test('the id must be on a marked line of a Standing section, of the class of every line; a decisions file not read refuses with its reason, before any other check', () => {
    const deletion = 'git push origin --delete refs/heads/feature/old'
    const lease = 'git push --force-with-lease origin main'
    for (const id of ['signoff-in-unit', 'signoff-after-standing', 'signoff-no-marker', 'signoff-unknown', 'Signoff-delete-branches', 'push-scratch']) {
      expect({ id, fault: faultOf(`${ITEMS}${block(id, deletion)}`) }).toEqual({ id, fault: `${id} is on no line of a Standing section as \`${id}. [signoff:<class>] <text>\` (the marker right after the id)` })
    }
    expect(faultOf(`${ITEMS}${block(LEASE_ID, deletion)}`)).toBe(`its line 1 (line 3 of the prompt) is a delete-branch command, and ${LEASE_ID} covers force-push`)
    expect(faultOf(`${ITEMS}${block(DELETE_ID, lease)}`)).toBe(`its line 1 (line 3 of the prompt) is a force-push command, and ${DELETE_ID} covers delete-branch`)
    expect(faultOf(`${ITEMS}${block(DELETE_ID, deletion, lease)}`)).toBe(`its line 2 (line 4 of the prompt) is a force-push command, and ${DELETE_ID} covers delete-branch`)
    for (const [standing, why] of [
      [undefined, 'it was not read'],
      [{ unreadable: '/o/agreed-decisions.md holds 5000000 bytes, over the engine\'s read cap of 4194304 bytes' }, '/o/agreed-decisions.md holds 5000000 bytes, over the engine\'s read cap of 4194304 bytes'],
      [{ unreadable: '/o/agreed-decisions.md is not there' }, '/o/agreed-decisions.md is not there'],
    ] as const) {
      for (const prompt of [`${ITEMS}${block(DELETE_ID, deletion)}`, `${ITEMS}${block('signoff-unknown', 'git branch -d main')}`]) {
        expect(signoffLint(prompt, standing)).toEqual({ refusal: `refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: ${why}`, warnings: [] })
      }
    }
    // A prompt without a block needs no decisions file.
    expect(signoffLint(`${ITEMS}Commit and push.`)).toEqual({ warnings: [] })
  })

  test('a negated sentence still passes as before, with or without the id, and is named in no warning', () => {
    for (const prompt of [`${ITEMS}Per ${DELETE_ID}: never run git push origin --delete main.`, `${ITEMS}Do not run git push origin --delete feature/x.`, `${ITEMS}Per ${LEASE_ID}: never git push --force origin main.`]) {
      expect({ prompt, lint: guarded(prompt) }).toEqual({ prompt, lint: { warnings: [] } })
    }
    expect(guarded(`${ITEMS}${block(DELETE_ID, 'git branch -d a')}\nNever run git push origin --delete main.`)).toEqual({ warnings: [`sign-off allowed by ${DELETE_ID}: delete-branch: git branch -d a`], allowed: [{ id: DELETE_ID, actionClass: 'delete-branch', commands: ['git branch -d a'] }] })
  })

  test('a decision id in prose lifts nothing: the old citation is refused as without one; the refusal of a deletion or a force-push ends with how to write a block, one of only other actions does not', () => {
    for (const prompt of [
      `${ITEMS}Per ${DELETE_ID}: git push origin --delete feature/old`,
      `${ITEMS}Per ${DELETE_ID}: git push origin --delete refs/heads/feature/old`,
      `${ITEMS}Cited: ${DELETE_ID}.\ngit push origin :refs/heads/feature/old`,
      `${ITEMS}Per ${LEASE_ID}: git push --force-with-lease origin main`,
      `${ITEMS}signoff ${DELETE_ID}: git push origin --delete refs/heads/feature/old`,
      `${ITEMS}\`\`\`\n${DELETE_ID}\n\`\`\`\ngit push origin --delete refs/heads/feature/old`,
    ]) {
      const lint = guarded(prompt)
      expect({ prompt, lint }).toEqual({ prompt, lint: signoffLint(prompt) })
      expect({ prompt, ends: lint.refusal?.endsWith(`(never, do not, stop before) passes; ${BLOCK_HINT}`) }).toEqual({ prompt, ends: true })
    }
    for (const prompt of [`${ITEMS}git reset --hard`, `${ITEMS}git branch -D x`, `${ITEMS}git push --mirror origin`]) {
      expect({ prompt, ends: guarded(prompt).refusal?.endsWith('(never, do not, stop before) passes') }).toEqual({ prompt, ends: true })
    }
  })

  test('100 lines mixing a block and prose steps: the refusal names the refused prose steps from the first, never a block line', () => {
    const blockLines = Array.from({ length: 30 }, (_, at) => `git push origin --delete refs/heads/feature/n${at}`)
    const prose = Array.from({ length: 66 }, (_, at) => `Step ${at}: look at the log.`)
    prose[20] = 'git reset --hard origin/main'
    prose[41] = 'git push backup :refs/heads/main'
    prose[60] = 'git branch -D feature/n90'
    const prompt = [ITEMS.trimEnd(), block(DELETE_ID, ...blockLines), ...prose].join('\n')
    expect(prompt.split('\n').length).toBe(99)
    const lint = guarded(prompt)
    expect(lint.refusal).toStartWith('refused by the sign-off guard: the prompt instructs reset --hard on line 54, a remote branch or tag deletion on line 75, branch -D on line 94 as a step for the worker;')
    expect(lint.refusal).toEndWith(BLOCK_HINT)
    const clean = [ITEMS.trimEnd(), block(DELETE_ID, ...blockLines), ...prose.filter((_, at) => ![20, 41, 60].includes(at))].join('\n')
    const allowed = guarded(clean)
    expect(allowed.refusal).toBeUndefined()
    expect(allowed.allowed?.[0]?.commands).toEqual(blockLines)
    expect(allowed.warnings).toEqual([`sign-off allowed by ${DELETE_ID}: delete-branch: ${blockLines.slice(0, WARNED_COMMANDS).join('; ')}; and 10 more (30 in all)`])
    // Without the decisions file read, the same block is refused; without the block, each deletion is a refused step.
    expect(signoffLint(clean).refusal).toContain('could not be read: it was not read')
    expect(signoffLint(clean.replace(/^```.*$/gm, '')).refusal).toStartWith('refused by the sign-off guard: the prompt instructs a remote branch or tag deletion on line 3, a remote branch or tag deletion on line 4,')
  })

  test('a block counts only in the prompt as given: past `ownLines` (the section\'s block, the rules block) its lines are read as without a block', () => {
    const given = `${ITEMS}Do the work.`
    const appended = `\n\n## Binding decisions (section x)\n\n${block(DELETE_ID, 'git push origin --delete refs/heads/a')}\n`
    const prompt = `${given}${appended}`
    const lint = guarded(prompt, STANDING, given.split('\n').length)
    expect(lint).toEqual(signoffLint(prompt.replace(/^```.*$/gm, 'x')))
    expect(listedOf(lint)).toBe('a remote branch or tag deletion on line 7')
    // A line written as an opening line out there is not read as one either.
    expect(guarded(`${given}\n\n\`\`\`signoff ${DELETE_ID} now\ngit branch -d a\n\`\`\``, STANDING, given.split('\n').length)).toEqual({ warnings: [] })
    // In the prompt as given, the same block passes.
    expect(guarded(`${given}\n${block(DELETE_ID, 'git push origin --delete refs/heads/a')}`, STANDING, 5).refusal).toBeUndefined()
  })
})

// The leased push of one feature or bugfix branch: a form of the force-push class only for a go-ahead whose line names
// that branch or holds the pattern feature/* or bugfix/* as a word; every refusal above stays.
const BRANCH_DECISIONS = [
  '# Agreed decisions',
  '',
  '## A unit',
  'signoff-unit-force. [signoff:force-push] Not standing: feature/* and bugfix/*.',
  '',
  '## Standing: force-push of feature branches',
  'signoff-force-push-feature-branches. [signoff:force-push] User (2026-10-20), «the guard is too strict, you can force push on feature branches»: a push with lease that rewrites a feature/* or bugfix/* branch is allowed without asking again, on every repository; never main, develop, master, release/* or hotfix/*. Orchestrator reading, not asked: the guard keeps the signoff block (one exact branch per line, never a wildcard in the command) and the decision covers any branch matching the two patterns feature/* and bugfix/*; it also covers feature/italian-writing-skill.',
  '',
  '## Standing',
  'signoff-bugfix-only. [signoff:force-push] User: force-push with lease any bugfix/* branch; never a feature branch.',
  'signoff-named-branch. [signoff:force-push] User: force-push `feature/one-off` with lease, once.',
  'signoff-other-wildcards. [signoff:force-push] User: force-push any branch: *, feature/**, feat*/*, */*, feature/?, feature/x*, bugfix/**, refs/heads/feature/*, feature/[a-z]*.',
  'signoff-main-only. [signoff:force-push] User: rewrite the root author and push main to origin with --force-with-lease.',
  'signoff-delete-features. [signoff:delete-branch] User: delete merged feature/* and bugfix/* branches.',
  'signoff-plain-feature. User: force-push feature/* with lease (no marker).',
  '',
].join('\n')
const BRANCH_STANDING: StandingRead = { text: BRANCH_DECISIONS }
const FEATURES_ID = 'signoff-force-push-feature-branches'

describe('a signoff block: the leased push of one feature or bugfix branch (lint.ts)', () => {
  const branchLint = (id: string, ...lines: string[]) => signoffLint(`${ITEMS}${block(id, ...lines)}`, BRANCH_STANDING)
  const branchFault = (id: string, ...lines: string[]) => faultOf(`${ITEMS}${block(id, ...lines)}`, BRANCH_STANDING)
  const passes = (id: string, lines: string[]) => ({ warnings: [`sign-off allowed by ${id}: force-push: ${lines.join('; ')}`], allowed: [{ id, actionClass: 'force-push', commands: lines }] })

  test('both spellings pass for a branch the cited line names, to any plain remote, which the line need not hold', () => {
    for (const [id, branch] of [[FEATURES_ID, 'feature/italian-writing-skill'], ['signoff-named-branch', 'feature/one-off']] as const) {
      for (const remote of ['origin', 'linksmt', 'upstream-2', 'my.remote']) {
        for (const line of [`git push --force-with-lease ${remote} ${branch}`, `git push --force-with-lease ${remote} refs/heads/${branch}`]) {
          expect({ line, lint: branchLint(id, line) }).toEqual({ line, lint: passes(id, [line]) })
        }
      }
    }
  })

  test('a branch the pattern feature/* or bugfix/* of the cited line covers passes; one block may hold several, one per line', () => {
    const branches = ['feature/x', 'feature/a/b-1.2_c', 'feature/JIRA-12', 'feature/0', 'bugfix/y', 'bugfix/a.b/c_d', 'bugfix/HEAD', `feature/${'x'.repeat(5000)}`]
    for (const branch of branches) {
      for (const line of [`git push --force-with-lease origin ${branch}`, `git push --force-with-lease origin refs/heads/${branch}`]) {
        expect({ line, lint: branchLint(FEATURES_ID, line) }).toEqual({ line, lint: passes(FEATURES_ID, [line]) })
      }
    }
    for (const line of ['git push --force-with-lease origin bugfix/z', 'git push --force-with-lease origin refs/heads/bugfix/a/b']) {
      expect({ line, lint: branchLint('signoff-bugfix-only', line) }).toEqual({ line, lint: passes('signoff-bugfix-only', [line]) })
    }
    const lines = ['git push --force-with-lease origin feature/x', 'git push --force-with-lease linksmt feature/x', 'git push --force-with-lease origin refs/heads/bugfix/y']
    expect(branchLint(FEATURES_ID, ...lines)).toEqual(passes(FEATURES_ID, lines))
    // Prose around the block is checked as before: a force-push step outside it is refused.
    expect(listedOf(signoffLint(`${ITEMS}${block(FEATURES_ID, lines[0] ?? '')}\nThen git push --force-with-lease origin feature/other.`, BRANCH_STANDING))).toBe('a force-push on line 5')
  })

  test('a branch the cited line neither names nor covers by feature/* or bugfix/* is refused', () => {
    for (const [id, branch] of [
      [FEATURES_ID, 'release/1'], [FEATURES_ID, 'fix/x'], [FEATURES_ID, 'hotfix/x'], [FEATURES_ID, 'feat/x'], [FEATURES_ID, 'features/x'], [FEATURES_ID, 'x'],
      ['signoff-bugfix-only', 'feature/x'], ['signoff-bugfix-only', 'feature/bugfix'],
      ['signoff-named-branch', 'feature/other'], ['signoff-named-branch', 'feature/one-off-2'], ['signoff-named-branch', 'feature/one'], ['signoff-named-branch', 'bugfix/one-off'], ['signoff-named-branch', 'feature/one-off/x'],
      ['signoff-main-only', 'feature/x'], ['signoff-main-only', 'bugfix/x'],
    ] as const) {
      for (const line of [`git push --force-with-lease origin ${branch}`, `git push --force-with-lease origin refs/heads/${branch}`]) {
        expect({ id, line, fault: branchFault(id, line) }).toEqual({ id, line, fault: notAForm('force-push') })
      }
    }
    // The first line that fails is named, after one that passes.
    expect(branchFault('signoff-bugfix-only', 'git push --force-with-lease origin bugfix/a', 'git push --force-with-lease origin feature/a')).toBe(notAForm('force-push', 2, 4))
  })

  test('no other wildcard of the cited line covers a branch: *, feature/**, feat*/*, */*, feature/?, feature/x*, bugfix/**, refs/heads/feature/*, feature/[a-z]*', () => {
    for (const branch of ['feature/x', 'feature/xy', 'feature/a', 'bugfix/x', 'feat/x', 'feature/[a-z]*']) {
      expect({ branch, fault: branchFault('signoff-other-wildcards', `git push --force-with-lease origin ${branch}`) }).toEqual({ branch, fault: notAForm('force-push') })
    }
    for (const [text, branch, covered] of [
      ['feature/*', 'feature/x', true], ['(feature/*,', 'feature/x', true], ['`feature/x`.', 'feature/x', true], ['«bugfix/*»', 'bugfix/a/b', true],
      ['feature/* only', 'bugfix/x', false], ['feature/x/y', 'feature/x', false], ['feature/xy', 'feature/x', false], ['feature/x-y', 'feature/x', false], ['refs/heads/feature/x', 'feature/x', false],
      ['*', 'feature/x', false], ['feature/**', 'feature/x', false], ['feat*/*', 'feature/x', false], ['*/*', 'feature/x', false], ['feature/x*', 'feature/xy', false], ['Feature/*', 'feature/x', false], ['FEATURE/X', 'feature/x', false],
    ] as const) {
      expect({ text, branch, covered: coversBranch(text, branch) }).toEqual({ text, branch, covered })
    }
  })

  test('main-like protected names in the branch form are refused under a line that names them too', () => {
    const naming = `${BRANCH_DECISIONS}\n## Standing: names\nsignoff-names-protected. [signoff:force-push] User: develop, master, main, release/1, hotfix/x, HEAD, feature/*.\n`
    for (const branch of ['develop', 'master', 'release/1', 'hotfix/x', 'HEAD', 'Develop', 'MASTER', 'Release/1', 'Hotfix/x', 'feature', 'bugfix', 'Feature/x', 'BUGFIX/x', 'heads/feature/x', 'refs/heads/develop', 'refs/heads/release/1', 'refs/heads/hotfix/x']) {
      for (const id of [FEATURES_ID, 'signoff-names-protected']) {
        expect({ id, branch, fault: faultOf(`${ITEMS}${block(id, `git push --force-with-lease origin ${branch}`)}`, { text: naming }) }).toEqual({ id, branch, fault: notAForm('force-push') })
      }
    }
    // The main form keeps its own rule: the remote is a word of the cited line, which the feature line does not hold.
    expect(branchFault(FEATURES_ID, 'git push --force-with-lease origin main')).toBe(`its line 1 (line 3 of the prompt) pushes to origin, a word the line of ${FEATURES_ID} does not hold`)
    expect(branchLint('signoff-main-only', 'git push --force-with-lease origin main').refusal).toBeUndefined()
  })

  // The main form under a line that is no go-ahead for main: the remote of a leased push of main is a remote the line
  // names after `main to`, in a clause with no negation before main, and the line names no feature or bugfix branch.
  const ROOT_AUTHOR_ID = 'signoff-rewrite-root-author'
  const SQUASH_ID = 'signoff-squash-shaped'
  const SQUASH_PLAIN_ID = 'signoff-squash-no-branch'
  const MAIN_DECISIONS = [
    BRANCH_DECISIONS,
    '## Standing: main',
    `${ROOT_AUTHOR_ID}. [signoff:force-push] User (2026-10-12), explicit permission and agreed order (after the branch cleanup): rewrite the author of the root commit of the session-control repository (8d0b3e9, Initial commit, authored by 1af10f2404) to Matteo Buia <matteo.buia@linksmt.it>, which changes every later hash, and force-push main to both remotes (origin and linksmt) with --force-with-lease so that both hold the same commits; the worker verifies the trees of all commits are identical before and after, backs up the old history in a local bundle outside the repository, and touches nothing else. Cited by this id, a worker prompt may instruct that one force-push (--force-with-lease only, to main of the two named remotes); the mod accepts the citation only for this action class. Mine, flagged: other clones of the repository diverge and must be re-fetched; GitHub may show the old contributor in cached statistics for a while.`,
    `${SQUASH_ID}. [signoff:force-push] User (2026-10-20), «squash the two commits into one»: on the branch feature/italian-writing-skill of ai-process-transformation (created by this work, not merged, not protected, pushed with commits 311c310 and 850ea28 on top of origin/develop d921277) the two commits are squashed into one and the branch is force-pushed with lease to origin; nothing else is rewritten.`,
    `${SQUASH_PLAIN_ID}. [signoff:force-push] User: squash the two commits of topic-x on top of origin/develop and force-push it with lease to origin and linksmt.`,
    'signoff-main-and-branch. [signoff:force-push] User: push main to origin and feature/x with --force-with-lease.',
    'signoff-never-main. [signoff:force-push] User: rewrite develop with lease to origin; never push main to origin.',
    'signoff-not-main. [signoff:force-push] User: do not force-push main to origin or linksmt.',
    'signoff-main-then-never. [signoff:force-push] User: push main to origin with lease; never develop.',
    'signoff-main-list. [signoff:force-push] User: push `main` to origin, backup and mirror with --force-with-lease.',
    '',
  ].join('\n')
  const mainFault = (id: string, ...lines: string[]) => faultOf(`${ITEMS}${block(id, ...lines)}`, { text: MAIN_DECISIONS })
  const mainLint = (id: string, ...lines: string[]) => signoffLint(`${ITEMS}${block(id, ...lines)}`, { text: MAIN_DECISIONS })
  const notNamed = (id: string, remote: string) => `its line 1 (line 3 of the prompt) pushes main to ${remote}, which the line of ${id} does not name after main to (main to <remote>, main to <remote> and <remote>, main to the remotes (<remote> and <remote>)) in a clause with no negation before main`
  const notHeld = (id: string, remote: string) => `its line 1 (line 3 of the prompt) pushes to ${remote}, a word the line of ${id} does not hold`
  const besideBranch = (id: string) => `its line 1 (line 3 of the prompt) pushes main, and the line of ${id} names a feature or bugfix branch`

  test('a main block citing the feature-branch go-ahead is refused to every remote: with, feature, lease, branch (words of its line), origin, linksmt', () => {
    for (const [remote, fault] of [
      ['with', besideBranch(FEATURES_ID)], ['feature', besideBranch(FEATURES_ID)], ['lease', besideBranch(FEATURES_ID)], ['branch', besideBranch(FEATURES_ID)],
      ['origin', notHeld(FEATURES_ID, 'origin')], ['linksmt', notHeld(FEATURES_ID, 'linksmt')],
    ] as const) {
      for (const line of [`git push --force-with-lease ${remote} main`, `git push --force-with-lease=main ${remote} main`, `git push --force-with-lease=refs/heads/main ${remote} main`]) {
        expect({ line, fault: mainFault(FEATURES_ID, line) }).toEqual({ line, fault })
      }
    }
  })

  test('a main block citing a squash go-ahead for one branch (origin/develop, to origin, no main) is refused to origin, with or without a feature branch on the line', () => {
    expect(mainFault(SQUASH_ID, 'git push --force-with-lease origin main')).toBe(besideBranch(SQUASH_ID))
    for (const remote of ['with', 'lease', 'branch']) expect(mainFault(SQUASH_ID, `git push --force-with-lease ${remote} main`)).toBe(besideBranch(SQUASH_ID))
    for (const remote of ['origin', 'linksmt', 'and', 'to']) expect({ remote, fault: mainFault(SQUASH_PLAIN_ID, `git push --force-with-lease ${remote} main`) }).toEqual({ remote, fault: notNamed(SQUASH_PLAIN_ID, remote) })
  })

  test('the root-author go-ahead still passes its own block, main to origin and linksmt; every other word of its line is refused as the remote', () => {
    const lines = ['git push --force-with-lease origin main', 'git push --force-with-lease linksmt main']
    expect(mainLint(ROOT_AUTHOR_ID, ...lines)).toEqual({ warnings: [MAIN_WARNING, `sign-off allowed by ${ROOT_AUTHOR_ID}: force-push: ${lines.join('; ')}`], allowed: [{ id: ROOT_AUTHOR_ID, actionClass: 'force-push', commands: lines }] })
    for (const line of ['git push --force-with-lease=main origin main', 'git push --force-with-lease=refs/heads/main linksmt main']) expect(mainLint(ROOT_AUTHOR_ID, line).refusal).toBeUndefined()
    for (const remote of ['with', 'both', 'and', 'Matteo', 'Buia', 'author', 'the', 'repository', 'mod', 'GitHub', 'bundle', 'commits']) {
      expect({ remote, fault: mainFault(ROOT_AUTHOR_ID, `git push --force-with-lease ${remote} main`) }).toEqual({ remote, fault: notNamed(ROOT_AUTHOR_ID, remote) })
    }
    expect(mainFault(ROOT_AUTHOR_ID, 'git push --force-with-lease upstream main')).toBe(notHeld(ROOT_AUTHOR_ID, 'upstream'))
  })

  test('a line that names main to a remote beside a feature branch, or only in a negated clause, is no go-ahead for main; a negation in a later clause is', () => {
    expect(mainFault('signoff-main-and-branch', 'git push --force-with-lease origin main')).toBe(besideBranch('signoff-main-and-branch'))
    expect(mainFault('signoff-never-main', 'git push --force-with-lease origin main')).toBe(notNamed('signoff-never-main', 'origin'))
    for (const remote of ['origin', 'linksmt']) expect(mainFault('signoff-not-main', `git push --force-with-lease ${remote} main`)).toBe(notNamed('signoff-not-main', remote))
    expect(mainLint('signoff-main-then-never', 'git push --force-with-lease origin main').refusal).toBeUndefined()
    for (const remote of ['origin', 'backup', 'mirror']) expect(mainLint('signoff-main-list', `git push --force-with-lease ${remote} main`).refusal).toBeUndefined()
    expect(mainFault('signoff-main-list', 'git push --force-with-lease with main')).toBe(notNamed('signoff-main-list', 'with'))
  })

  test('mainRemotes: the remotes after main to, plain or in parentheses after remote(s), each clause with a negation before main left out', () => {
    for (const [text, remotes] of [
      ['push main to origin with lease.', ['origin']],
      ['push main to origin.', ['origin']],
      ['push main to origin and backup with lease', ['origin', 'backup']],
      ['push main to origin, backup, and mirror', ['origin', 'backup', 'mirror']],
      ['force-push main to both remotes (origin and linksmt) with lease', ['origin', 'linksmt']],
      ['force-push main to the two named remotes (origin, linksmt)', ['origin', 'linksmt']],
      ['push `main` to origin; push "main" to backup', ['origin', 'backup']],
      ['never push main to origin', []],
      ['rewrite develop; never main to origin. Then push main to backup', ['backup']],
      ['do not push main to origin, but push main to backup', []],
      ['push origin/main to origin', []],
      ['push main into origin', []],
      ['force-push main, develop and master to origin', []],
      ['', []],
    ] as const) {
      expect({ text, remotes: [...mainRemotes(text)] }).toEqual({ text, remotes: [...remotes] })
    }
  })

  test('the malformed branch forms are refused: .., slashes, +, :, wildcards, a second name, quoting, variables, substitutions, --force, -f, a plus refspec, the lease with a value, other remotes and options', () => {
    const REFUSED = [
      'feature/..', 'feature/a..b', 'feature/../main', 'feature/x/', 'feature/', 'feature//x', 'feature/.x', 'feature/x.', 'feature/x.lock', 'feature/x.LOCK/y', 'feature/-x', 'feature/x/_y',
      'feature/+x', '+feature/x', '+refs/heads/feature/x', 'feature/x:feature/x', 'feature/x:main', 'HEAD:feature/x', 'refs/heads/feature/x:refs/heads/feature/x', ':feature/x',
      'feature/*', 'feature/x*', 'feature/?', 'feature/[ab]', 'feature/{a,b}', 'feature/x~1', 'feature/x^', 'feature/x@{1}', 'feature/café', 'feature/​x',
      'feature/x feature/y', 'feature/x bugfix/y', 'feature/x main', 'feature/x +develop', 'feature/x "+develop"', 'feature/x, develop', 'feature/x and develop', 'feature/x then develop', 'feature/x; git push --force origin main',
      '"feature/x"', "'feature/x'", '`feature/x`', 'feature/$B', '$B', '${B}', 'feature/${B}', '"$B"', '$(echo feature/x)', 'feature/$(echo x)', '`echo feature/x`',
      'feature/x --no-verify', 'feature/x --force', 'feature/x ', ' feature/x', 'feature/x\r', 'refs/heads/feature/*', 'refs/heads/ feature/x', 'refs/tags/feature/x', 'refs/remotes/origin/feature/x', 'heads/feature/x',
    ]
    for (const branch of REFUSED) {
      const line = `git push --force-with-lease origin ${branch}`
      expect({ line, fault: branchFault(FEATURES_ID, line) }).toEqual({ line, fault: notAForm('force-push') })
    }
    const COMMANDS = [
      'git push --force origin feature/x', 'git push -f origin feature/x', 'git push origin +feature/x', 'git push origin +refs/heads/feature/x', 'git push --force-with-lease --force origin feature/x',
      'git push --force-with-lease=feature/x:abc1234 origin feature/x', 'git push --force-with-lease=refs/heads/feature/x:abc1234 origin feature/x', 'git push --force-with-lease=feature/x origin feature/x',
      'git push --force-with-lease=refs/heads/feature/x origin feature/x', 'git push --force-with-lease=main origin feature/x', 'git push --force-with-lease=feature/x:$SHA origin feature/x', 'git push --force-with-lease --force-if-includes origin feature/x',
      'git push origin feature/x --force-with-lease', 'git push origin --force-with-lease feature/x', 'git push --force-with-lease feature/x', 'git push --force-with-lease origin', 'git push --force-with-lease',
      'git push --force-with-lease /tmp/r.git feature/x', 'git push --force-with-lease ../r feature/x', 'git push --force-with-lease . feature/x', 'git push --force-with-lease https://example.invalid/r.git feature/x',
      'git push --force-with-lease git@example.invalid:r.git feature/x', 'git push --force-with-lease $REMOTE feature/x', 'git push --force-with-lease "origin" feature/x', 'git push --force-with-lease main feature/x',
      'git push --force-with-lease heads feature/x', 'git push --force-with-lease Develop feature/x', 'git -C /r push --force-with-lease origin feature/x', 'git -c remote.origin.url=/tmp/x push --force-with-lease origin feature/x',
      'push --force-with-lease origin feature/x', 'git push  --force-with-lease origin feature/x', 'git push --force-with-lease  origin feature/x', 'git\tpush --force-with-lease origin feature/x', 'GIT push --force-with-lease origin feature/x',
      'git push --FORCE-WITH-LEASE origin feature/x', 'git push --mirror --force-with-lease origin', 'git push --force-with-lease origin feature/x --delete x', 'force-push feature/x to origin', 'echo feature/x | xargs git push --force-with-lease origin',
    ]
    for (const line of COMMANDS) expect({ line, fault: branchFault(FEATURES_ID, line) }).toEqual({ line, fault: notAForm('force-push') })
  })

  test('a wrong class, a missing or a non-Standing decision refuse; a deletion under the feature line is of the other class', () => {
    const line = 'git push --force-with-lease origin feature/x'
    expect(branchFault('signoff-delete-features', line)).toBe('its line 1 (line 3 of the prompt) is a force-push command, and signoff-delete-features covers delete-branch')
    expect(branchFault(FEATURES_ID, 'git push origin --delete refs/heads/feature/x')).toBe(`its line 1 (line 3 of the prompt) is a delete-branch command, and ${FEATURES_ID} covers force-push`)
    for (const id of ['signoff-unit-force', 'signoff-plain-feature', 'signoff-unknown', 'Signoff-force-push-feature-branches']) {
      expect({ id, fault: branchFault(id, line) }).toEqual({ id, fault: `${id} is on no line of a Standing section as \`${id}. [signoff:<class>] <text>\` (the marker right after the id)` })
    }
    expect(signoffLint(`${ITEMS}${block(FEATURES_ID, line)}`)).toEqual({ refusal: `refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: it was not read`, warnings: [] })
    // The id in prose lifts nothing, as for the other forms.
    expect(listedOf(signoffLint(`${ITEMS}Per ${FEATURES_ID}: ${line}`, BRANCH_STANDING))).toBe('a force-push on line 2')
  })
})

// The checker's attack set: 202 prompts that cite a go-ahead in prose, each with the old design's verdict (A accepted,
// R refused). As prose each is now refused, or accepted as main accepts it; as a signoff block with the same id and
// text each is refused, but for the lines the grammar takes.
describe('the checker\'s 202 cited cases (lint.ts)', () => {
  const CHECK_DECISIONS = [
    '# Agreed decisions',
    '',
    '## Unit with a duplicate',
    'zz-dup-go. [signoff:delete-branch] Not standing: must not count.',
    '',
    '## Standing',
    'zz-del-go. [signoff:delete-branch] User (2026-10-12): delete merged scratch branches from origin and backup; never main.',
    'zz-lease-go. [signoff:force-push] User (2026-10-12): rewrite the root author and force-push main to origin and backup with --force-with-lease.',
    'zz-plain. User: no marker on this line.',
    'zz-late. User: the marker stands late [signoff:delete-branch] here.',
    'zz-typo. [signof:delete-branch] User: misspelt marker.',
    'zz-twomark. [signoff:delete-branch] [signoff:force-push] User: two markers.',
    '',
  ].join('\n')
  const D = 'zz-del-go'
  const L = 'zz-lease-go'
  const C: string[] = []
  const add = (p: string) => C.push(p)
  add(`Per ${D}: git push origin --delete feature/a feature/b`)
  add(`Per ${D}: git push --delete origin feature/a`)
  add(`Per ${D}: git push -d origin feature/a`)
  add(`Per ${D}: git push origin :feature/a :feature/b`)
  add(`Per ${D}: git push origin --delete refs/heads/feature/a`)
  add(`Per ${D}: git -C /tmp/r push origin --delete feature/a`)
  add(`Per ${L}: git push --force-with-lease origin main`)
  add(`Per ${L}: git push --force-with-lease=main:abc123 backup main:main`)
  add(`Per ${L}: git push origin main --force-with-lease=refs/heads/main`)
  for (const b of ['main', 'Main', 'MAIN', 'refs/heads/main', 'heads/main', 'refs/heads/Main', '+main', ':main', 'main:', 'origin/main', 'HEAD', 'head', '@', 'master', 'develop', 'release', 'release/1.0', 'Release', 'Release/2', 'heads/master', 'heads/develop', 'heads/release/1.0', 'refs/heads/heads/main']) add(`Per ${D}: git push origin --delete ${b}`)
  for (const b of ['main', 'refs/heads/main', 'heads/main', 'HEAD', 'develop', 'release/1.0']) add(`Per ${D}: git push origin :${b}`)
  for (const b of ['refs/tags/x', 'tags/x', 'refs/remotes/origin/x', 'remotes/origin/x', 'refs/for/x', 'for/x', 'refs/pull/1/head', 'pull/1/head', 'refs/notes/commits', 'notes/commits', 'tag', 'TAG']) add(`Per ${D}: git push origin --delete ${b}`)
  for (const b of ['*', 'feature/*', 'a?', '[a-z]', '{a,b}', '$B', '${B}', '$(echo main)', '`echo main`', '~', 'a~1', 'a^', 'a..b', 'a//b', 'a/', 'a.', 'a.lock', '"$B"', "'main'", '"main"']) add(`Per ${D}: git push origin --delete feature/a ${b}`)
  for (const o of ['--delete --force', '-d -f', '--mirror', '--prune', '--all', '--tags', '--no-verify', '-o ci.skip', '--receive-pack=/tmp/x', '--exec=/tmp/x', '--repo=/tmp/x', '-n', '--atomic', '--', '-q', '--porcelain', '--force-with-lease']) add(`Per ${D}: git push origin --delete feature/a ${o}`)
  for (const o of ['--force', '--mirror', '--prune', '--all']) add(`Per ${D}: git push ${o} origin --delete feature/a`)
  add(`Per ${D}: git push /tmp/remote.git --delete feature/a`)
  add(`Per ${D}: git push https://example.invalid/r.git --delete feature/a`)
  add(`Per ${D}: git push /tmp/x;rm --delete feature/a`)
  add(`Per ${D}: git push "/tmp/x" --delete feature/a`)
  add(`Per ${D}: git push $REMOTE --delete feature/a`)
  for (const tail of ['; git push origin --delete main', ' && git push origin --delete main', ' || git push origin --delete main', ' | git push origin --delete main', ' & git push origin --delete main', '\ngit push origin --delete main', ' \\\nmain', ' git push origin --delete main', ' then main', ' and main', ' or main', ', main', ' if main', ' so main', ' but main', ' until main', ' while main', ' once main', ' unless main', ' except main', ' after main', ' before main', ' when main', '. main', '! main', '? main', ': main', ', feature/b and main', ', feature/b, main', ' "main"', " 'main'", ' `printf main`', ' "$B"', ' (main)', '; git reset --hard', ' && git clean -fdx', '; git branch -D x', '; git push --force origin x'])
    add(`Per ${D}: git push origin --delete feature/a${tail}`)
  add(`Per ${D}: delete a, b and main: git push origin --delete feature/a, feature/b and main`)
  add(`Per ${D}: echo main | xargs git push origin --delete feature/a`)
  add(`Per ${D}: printf 'main\\n' | xargs -n1 git push origin --delete`)
  add(`Per ${D}:\n\`\`\`\ngit push origin --delete feature/a then \\\n  main\n\`\`\``)
  add(`Per ${D}: git push origin --delete ${Array.from({ length: 1000 }, (_, i) => `feature/b${i}`).join(' ')}`)
  add(`Per ${D}: git push origin --delete ${Array.from({ length: 1000 }, (_, i) => `feature/b${i}`).join(' ')} main`)
  add(`Per ${D}: git push origin --delete feature/${'x'.repeat(5000)}`)
  for (const b of ['-x', '--force', '', 'a:b', '+a', 'a@{1}', '@{u}']) add(`Per ${D}: git push origin --delete ${b}`)
  add(`Per ${D}: git push origin --delete`)
  add(`Per ${D}: git push origin :`)
  for (const c of ['git push --force-with-lease other main', 'git push --force-with-lease main main', 'git push --force-with-lease origin main --no-verify', 'git push --force-with-lease --force origin main',
    'git push --force-with-lease=other origin main', 'git push --force-with-lease=other:abc origin main', 'git push --force-with-lease origin main:other', 'git push --force-with-lease origin +main',
    'git push --force-with-lease origin HEAD:main', 'git push --force-with-lease origin main:refs/heads/other', 'git push --force-with-lease origin feature/x', 'git push --force-with-lease origin',
    'git push --force-with-lease origin main develop', 'git push --force origin main', 'git push -f origin main', 'git push origin +main', 'force-push main to origin', 'git push --force-with-lease origin main "+develop"',
    'git push --force-with-lease origin main then develop', 'git push --force-with-lease origin main and feature', 'git push --force-with-lease origin main, develop', 'git push --force-with-lease origin main --delete x',
    'git push --force-with-lease --mirror origin', 'git push --force-with-lease origin main; git push --force-with-lease origin develop', 'git push --force-with-lease origin main --force-if-includes',
    'git push --force-with-lease origin main:main', 'git push --force-with-lease=main origin main', 'git -c remote.origin.url=/tmp/elsewhere push --force-with-lease origin main', 'git -C /tmp/other push --force-with-lease origin main'])
    add(`Per ${L}: ${c}`)
  for (const p of [`Never use ${D}. git push origin --delete feature/a`, `\`${D}\`: git push origin --delete feature/a`, `"${D}" git push origin --delete feature/a`, `\`\`\`\n${D}\n\`\`\`\ngit push origin --delete feature/a`, `${D}.md: git push origin --delete feature/a`]) add(p)
  for (const p of [`pre-${D}: git push origin --delete feature/a`, `${D}-x: git push origin --delete feature/a`, `${D}_x: git push origin --delete feature/a`, `${D.toUpperCase()}: git push origin --delete feature/a`, `Zz-del-go: git push origin --delete feature/a`,
    `Per ${L}: git push origin --delete feature/a`, `Per ${D}: git push --force-with-lease origin main`, `Per ${D}: git push origin --delete feature/a; git reset --hard`, `Per ${D}: git push origin --delete feature/a. Then git clean -fdx.`,
    `Per zz-dup-go: git push origin --delete feature/a`, `Per zz-plain: git push origin --delete feature/a`, `Per zz-late: git push origin --delete feature/a`, `Per zz-typo: git push origin --delete feature/a`, `[signoff:delete-branch] git push origin --delete feature/a`])
    add(p)
  add('Per zz-twomark: git push origin --delete feature/a')
  add(`Per ${D} and ${L}: git push origin --delete feature/a; git push --force-with-lease origin main`)
  add(`Per ${D}: git push origin --delete feature/a and git push origin --delete feature/b`)
  add(`Per ${D}: Never run git push origin --delete main.`)
  /** The old design's verdicts (the branch before this change), case by case, in groups of ten. */
  const OLD = 'AAAAAAAAAR RRRARRRRAR RRRRRRRRAA AARRARRRRA RARARARARR RRARRRRRAR RRRRRARAAA RRRRRRRRRR RRRRRRRRRR RAAAARRRRR RRRRARRRAA AAAAAAAAAA AAAAAAAAAA RRRRAARAAR ARRRRRRRRA RARRRRRRRR RRRRRRRAAA RRRRRAAAAA AAAARRRRRR RRRRRRRRAA AA'.replace(/ /g, '')
  /** The id and the text a case writes, as a block would carry them. */
  const parts = (p: string) => {
    const per = /^Per (.+?):[ \n]?([\s\S]*)$/.exec(p)
    if (per !== null) return { id: (per[1] ?? '').split(' and ')[0] ?? '', body: per[2] ?? '' }
    const at = p.indexOf('git push')
    return { id: p.slice(0, at).replace(/^Never use /, '').replace(/[`"]/g, '').replace(/[:.\s]+$/, '').trim(), body: p.slice(at) }
  }
  /** As prose, these four pass as on main: three commands main's reading cuts short, and a negated sentence. */
  const PROSE_PASSES = [`Per ${D}: git push /tmp/x;rm --delete feature/a`, `Per ${D}: git push "/tmp/x" --delete feature/a`, `Per ${D}: git push origin :`, `Per ${D}: Never run git push origin --delete main.`]
  /** As a block, these pass: the lines the grammar takes, with an id of their class. */
  const BLOCK_PASSES = [`${D}|git push origin --delete refs/heads/feature/a`, `${L}|git push --force-with-lease origin main`, `${L}|git push --force-with-lease=main origin main`]

  test('each case as prose (main\'s verdict, refused unless main passes it) and as a signoff block (refused but for the lines the grammar takes)', () => {
    expect([C.length, OLD.length]).toEqual([202, 202])
    const standing = { text: CHECK_DECISIONS }
    const rows = C.map((p, at) => {
      const { id, body } = parts(p)
      const prose = signoffLint(p, standing)
      const blocked = signoffLint(`\`\`\`signoff ${id}\n${body}\n\`\`\``, standing)
      expect({ p, prose }).toEqual({ p, prose: signoffLint(p) })
      return { at: at + 1, old: OLD[at], prose: prose.refusal === undefined ? 'A' : 'R', block: blocked.refusal === undefined ? 'A' : 'R', p, key: `${id}|${body}` }
    })
    expect(rows.filter(one => one.prose === 'A').map(one => one.p)).toEqual(PROSE_PASSES)
    expect(rows.filter(one => one.block === 'A').map(one => one.key)).toEqual(BLOCK_PASSES)
    // The old design accepted 77; 73 of them are now refused as prose, and 74 as a block.
    expect(rows.filter(one => one.old === 'A').length).toBe(77)
    expect(rows.filter(one => one.old === 'A' && one.prose === 'R').length).toBe(73)
    expect(rows.filter(one => one.old === 'A' && one.block === 'R').length).toBe(74)
  })
})

describe('a prompt without a signoff block gets main\'s verdicts (lint.ts)', () => {
  // The generated part of the checker's uncited corpus: 44 commands in 32 shapes, 1397 prompts. The hash of main's
  // verdicts (the refusal less its last clause, and the warnings) was taken with main's lint.ts.
  const BASE = [
    'git push --force origin feature/x', 'git push -f origin x', 'git push --force-with-lease origin main', 'git push --force-with-lease=main:abc origin main',
    'git push origin +x', 'git push origin --delete x', 'git push --delete origin a', 'git push -d origin a', 'git push origin :x',
    'git push origin HEAD:refs/heads/x --delete', 'git push --mirror origin', 'git push --prune origin', 'git reset --hard origin/main', 'git clean -fdx',
    'git clean --force', 'git branch -D x', 'git branch -d -f x', 'git branch --delete --force x', 'force-push the branch', 'git -C /r push -f origin x',
    'git -c core.x=y push --delete origin a', 'git --no-pager push origin --delete a', 'git push origin --delete main', 'git push origin --delete feature/a feature/b',
    'git push origin :refs/heads/x', 'git push origin --delete refs/tags/v1', 'git push --force-with-lease origin main:main',
    'git push origin --delete a; git push origin --delete main', 'git push origin --delete a && git push --force origin main', 'git push origin --delete feature/a, feature/b and main',
    'git push origin --delete feature/a "main"', 'git push origin --delete feature/a then main', 'git push origin --delete $B', 'git push origin --delete "$B"',
    'git push origin --delete heads/main', 'git push origin --delete tags/v1', 'git push origin -d -f a', 'git push origin --delete --force a', 'git push --all --prune origin',
    'git push origin --delete feature/*', 'git branch -d feature/a', 'git push --force-with-lease origin main "+develop"', 'push --delete origin a', 'push -f origin a',
  ]
  const WRAP: readonly ((c: string) => string)[] = [
    c => c, c => `Run ${c} now.`, c => `Run \`${c}\` now.`, c => `Run "${c}" now.`, c => `Run '${c}' now.`, c => `Steps:\n\`\`\`\n${c}\n\`\`\``,
    c => `\`\`\`bash\n${c}\n\`\`\``, c => `sh -c "${c}"`, c => `bash -lc '${c}'`, c => `cd repo && ${c}`, c => `${c} | tee log`, c => `${c} || true`,
    c => `true; ${c}`, c => `GIT_TRACE=1 ${c}`, c => `echo x | xargs ${c}`, c => `sh <<'EOF'\n${c}\nEOF`,
    c => {
      const i = c.lastIndexOf(' ')
      return i < 0 ? c : `${c.slice(0, i)} \\\n  ${c.slice(i + 1)}`
    },
    c => `${c}\r\nThen report.\r\n`, c => c.replace(/ /g, '\t'), c => c.toUpperCase(), c => c.replace('git', 'gi\u200bt'), c => c.replace('push', 'pu\u0455h'),
    c => `Never ${c}.`, c => `Do not run ${c}.`, c => ITEMS + c, c => `- ${c}`, c => `You may NOT:\n- ${c}`, c => `Then, ${c} and report.`, c => `${c}\n${c}`,
    c => `1. ${c}\n2. report`, c => `For example, \`${c}\` is refused.`, c => `Use git -C /tmp/r ${c.replace(/^git /, '')}`,
  ]
  const fnv = (text: string) => {
    let hash = 0x811c9dc5
    for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193) >>> 0
    return hash.toString(16).padStart(8, '0')
  }

  test('the generated corpus: 1397 prompts, 1088 refused, the same verdicts as main (hash 3e486e10), with or without a decisions file', () => {
    const prompts = [...new Set(BASE.flatMap(command => WRAP.map(wrap => wrap(command))))]
    expect(prompts.length).toBe(1397)
    for (const standing of [undefined, STANDING]) {
      const verdicts = prompts.map(prompt => signoffLint(prompt, standing)).map(lint => `${(lint.refusal ?? '-').replace(`; ${BLOCK_HINT}`, '')}\u0001${lint.warnings.join('\u0002')}`)
      expect(verdicts.filter(one => !one.startsWith('-\u0001')).length).toBe(1088)
      expect(fnv(verdicts.join('\n'))).toBe('3e486e10')
    }
  })
})

describe('a signoff block through the plugin', () => {
  const seedDecisions = (world: World, text = DECISIONS) => world.files.set(`${ORCH}/agreed-decisions.md`, text)
  const launchOf = (call: (tool: string, input: Record<string, unknown>) => Promise<{ deny?: string; isPassed: boolean; result?: unknown }>) => (prompt: string, title = 'block case') =>
    call('mcp__session-control__launch_worker', { dir: '/w/work', model: 'haiku', effort: 'low', title, prompt })
  const launched = (world: World) => world.passed.filter(one => one.tool === 'Bash').length

  test('launch_worker: a valid block is launched with the WARNING line; a stray prose deletion, a bad line, the old citation and a decisions file over the read cap, missing or a folder are refused', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const { world, call } = await started($, on)
    seedDecisions(world)
    const launch = launchOf(call)
    const lines = ['git push origin --delete refs/heads/feature/a', 'git push origin :refs/heads/feature/b', 'git branch -d feature/a']
    const valid = `${ITEMS}${block(DELETE_ID, ...lines)}\nReport.`
    const accepted = await launch(valid)
    expect(accepted.deny).toBeUndefined()
    expect(String(accepted.result).split('\n')).toContain(`WARNING: sign-off allowed by ${DELETE_ID}: delete-branch: ${lines.join('; ')}`)
    expect(launched(world)).toBe(1)
    for (const [prompt, title, deny] of [
      [`${valid}\nThen git push origin --delete main.`, 'stray', `refused by the sign-off guard: the prompt instructs a remote branch or tag deletion on line 8 as a step for the worker;`],
      [`${ITEMS}${block(DELETE_ID, lines[0] ?? '', 'git push origin --delete refs/heads/feature/a "develop"')}`, 'bad line', `refused by the sign-off guard: the signoff block on line 2 (signoff ${DELETE_ID}): its line 2 (line 4 of the prompt) is not one command in a form of the delete-branch class;`],
      [`${ITEMS}Per ${DELETE_ID}: git push origin --delete refs/heads/feature/a`, 'old citation', 'refused by the sign-off guard: the prompt instructs a remote branch or tag deletion on line 2 as a step for the worker;'],
      [`${ITEMS}${block(LEASE_ID, lines[0] ?? '')}`, 'other class', `refused by the sign-off guard: the signoff block on line 2 (signoff ${LEASE_ID}): its line 1 (line 3 of the prompt) is a delete-branch command, and ${LEASE_ID} covers force-push;`],
    ] as const) {
      const refused = await launch(prompt, title)
      expect({ title, deny: refused.deny?.slice(0, 'session-control: '.length + deny.length) }).toEqual({ title, deny: `session-control: ${deny}` })
      expect({ title, end: refused.deny?.endsWith('; nothing was launched') }).toEqual({ title, end: true })
    }
    expect(launched(world)).toBe(1)
    const path = `${ORCH}/agreed-decisions.md`
    const cannot = (why: string) => `session-control: refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: ${why}; nothing was launched`
    // Over the read cap: the engine's read refuses it; its size says why.
    seedDecisions(world, `${DECISIONS}${'x'.repeat(5_000_000)}`)
    world.unreadable.add(path)
    expect((await launch(valid, 'over the cap')).deny).toBe(cannot(`${path} holds 5000740 bytes, over the engine's read cap of 4194304 bytes`))
    world.unreadable.delete(path)
    world.files.delete(path)
    expect((await launch(valid, 'missing')).deny).toBe(cannot(`${path} is not there`))
    world.files.set(`${path}/inner`, 'x')
    expect((await launch(valid, 'a folder')).deny).toBe(cannot(`${path} is no regular file (dir)`))
    expect(launched(world)).toBe(1)
    // The trace: the id, the class and the count; never a branch or a command.
    const trace = world.files.get(`${RUNS}/trace.log`) ?? ''
    const traced = trace.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const allowed = traced.filter(line => line.event === 'guard' && line.allowedBy !== undefined)
    expect(allowed.map(({ tool, isOk, check, allowedBy, actionClass, commands }) => ({ tool, isOk, check, allowedBy, actionClass, commands }))).toEqual([
      { tool: 'launch_worker', isOk: true, check: 'sign-off', allowedBy: DELETE_ID, actionClass: 'delete-branch', commands: 3 },
    ])
    expect(JSON.stringify(allowed)).not.toContain('feature/')
  })

  test('launch_worker: a decisions file that is a named pipe is refused as no regular file, from its stat, and never opened (its open waits for a writer)', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    const path = `${ORCH}/agreed-decisions.md`
    world.fifos.add(path)
    const valid = `${ITEMS}${block(DELETE_ID, 'git push origin --delete refs/heads/feature/a')}\nReport.`
    const refused = await launchOf(call)(valid, 'a named pipe')
    expect(refused.deny).toBe(`session-control: refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: ${path} is no regular file (other); nothing was launched`)
    expect(world.fifoReads).toEqual([])
    expect(world.statted).toContain(path)
    expect(launched(world)).toBe(0)
    // A regular file there again is read and the block launched.
    world.fifos.delete(path)
    seedDecisions(world)
    expect((await launchOf(call)(valid, 'a file again')).deny).toBeUndefined()
    expect(launched(world)).toBe(1)
  })

  test('launch_worker: a block of 25 lines is named with 20 commands and the count; the trace counts all 25', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const { world, call } = await started($, on)
    seedDecisions(world)
    const lines = Array.from({ length: 25 }, (_, at) => `git push origin --delete refs/heads/feature/n${at}`)
    const answer = await launchOf(call)(`${ITEMS}${block(DELETE_ID, ...lines)}`)
    expect(String(answer.result).split('\n')).toContain(`WARNING: sign-off allowed by ${DELETE_ID}: delete-branch: ${lines.slice(0, 20).join('; ')}; and 5 more (25 in all)`)
    const traced = (world.files.get(`${RUNS}/trace.log`) ?? '').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(traced.filter(line => line.allowedBy !== undefined).map(line => line.commands)).toEqual([25])
  })

  test('the orchestrator session: its own deletion and force-push stay refused with the id in the command text', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    seedDecisions(world)
    for (const command of [
      'git push origin --delete feature/old # signoff-delete-branches',
      'echo signoff-delete-branches && git push origin :feature/old',
      'git push --force-with-lease origin main # signoff-rewrite-root-author',
      'git branch -D feature/old # signoff-delete-branches',
      `cat <<'EOF'\n\`\`\`signoff signoff-delete-branches\ngit push origin --delete refs/heads/feature/old\n\`\`\`\nEOF\ngit push origin --delete refs/heads/feature/old`,
    ]) {
      const answer = await call('Bash', { command })
      expect({ command, isPassed: answer.isPassed, refused: answer.deny?.startsWith('session-control: refused by the sign-off guard: git ') }).toEqual({ command, isPassed: false, refused: true })
    }
    expect((await call('PowerShell', { command: 'git push origin --delete feature/old # signoff-delete-branches' })).deny).toContain('(PowerShell)')
  })
})

describe('the leased push of one feature or bugfix branch through the plugin', () => {
  test('launch_worker: a block under the feature-branch go-ahead is launched with its WARNING line; an uncovered branch is refused, nothing launched', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    world.files.set(`${ORCH}/agreed-decisions.md`, BRANCH_DECISIONS)
    const launch = (prompt: string, title: string) => call('mcp__session-control__launch_worker', { dir: '/w/work', model: 'haiku', effort: 'low', title, prompt })
    const lines = ['git push --force-with-lease origin feature/italian-writing-skill', 'git push --force-with-lease linksmt refs/heads/feature/italian-writing-skill']
    const accepted = await launch(`${ITEMS}${block(FEATURES_ID, ...lines)}\nReport.`, 'feature lease')
    expect(accepted.deny).toBeUndefined()
    expect(String(accepted.result).split('\n')).toContain(`WARNING: sign-off allowed by ${FEATURES_ID}: force-push: ${lines.join('; ')}`)
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
    const refused = await launch(`${ITEMS}${block(FEATURES_ID, 'git push --force-with-lease origin release/1')}`, 'release lease')
    expect(refused.deny).toStartWith(`session-control: refused by the sign-off guard: the signoff block on line 2 (signoff ${FEATURES_ID}): ${notAForm('force-push')};`)
    expect(refused.deny).toEndWith('; nothing was launched')
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
  })

  test('the orchestrator session: its own leased push of a feature branch stays refused, whatever id or block its command text holds', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    world.files.set(`${ORCH}/agreed-decisions.md`, BRANCH_DECISIONS)
    for (const command of [
      'git push --force-with-lease origin feature/italian-writing-skill',
      `git push --force-with-lease origin feature/italian-writing-skill # ${FEATURES_ID}`,
      `cat <<'EOF'\n\`\`\`signoff ${FEATURES_ID}\ngit push --force-with-lease origin feature/x\n\`\`\`\nEOF\ngit push --force-with-lease origin feature/x`,
    ]) {
      const answer = await call('Bash', { command })
      expect({ command, isPassed: answer.isPassed, refused: answer.deny?.startsWith('session-control: refused by the sign-off guard: git push --force') }).toEqual({ command, isPassed: false, refused: true })
    }
  })
})
