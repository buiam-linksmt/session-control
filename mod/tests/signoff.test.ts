// The sign-off guard (README, Sign-off guard): the launch_worker prompt that instructs a force-push, a remote branch or
// tag deletion, reset --hard, a forced clean or branch -D as a step is refused, a sentence that says not to do it passes
// (the negation window, both ways), a push to main or develop warns, and a skill test is not exempt; the orchestrator's
// own Bash and PowerShell commands that run one of those git actions are refused in its own session, nowhere else. The
// fix-up's rule: the window counted from the token, governing no and without, gates, negated lists, past forms, short
// flags only after git, quoted examples, and the mirror and pruning pushes, each form both ways.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gitSignoffAction, signoffDenyText, signoffVerdict } from '../hooks/guard'
import { NEGATION_WORDS_AFTER, NEGATION_WORDS_BEFORE, isNegatedAt, signoffLint } from '../hooks/lint'
import { OPTIONS, ORCH, REGISTRY, mockWorld } from './mock-world'
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
        'A sentence that tells the worker not to do it (never, do not, stop before) passes',
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
