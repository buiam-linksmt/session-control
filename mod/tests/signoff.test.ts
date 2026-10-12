// The sign-off guard (README, Sign-off guard): the launch_worker prompt that instructs a force-push, a remote branch or
// tag deletion, reset --hard, a forced clean or branch -D as a step is refused, a sentence that says not to do it passes
// (the negation window, both ways), a push to main or develop warns, and a skill test is not exempt; the orchestrator's
// own Bash and PowerShell commands that run one of those git actions are refused in its own session, nowhere else. The
// fix-up's rule: the window counted from the token, governing no and without, gates, negated lists, past forms, short
// flags only after git, quoted examples, and the mirror and pruning pushes, each form both ways. A cited Standing
// go-ahead: each allowed form of its two classes and each refused neighbour, the Standing lookup, the warning and the trace.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gitSignoffAction, signoffDenyText, signoffVerdict } from '../hooks/guard'
import { CITE_HINT, NEGATION_WORDS_AFTER, NEGATION_WORDS_BEFORE, isNegatedAt, signoffGrants, signoffLint } from '../hooks/lint'
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
        'A sentence that tells the worker not to do it (never, do not, stop before) passes; to authorise a class the user has recorded a Standing go-ahead for, cite its decision id in the prompt',
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

// ---------------------------------------------------------------- a cited Standing go-ahead

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
const CITE_DELETE = 'Cited: signoff-delete-branches.\n'
const CITE_LEASE = 'Cited: signoff-rewrite-root-author.\n'
const MAIN_WARNING = "the prompt names a push to main: a push to a protected branch needs the user's go-ahead where the project's push policy asks (a Standing decision push-<project>); check it before the worker pushes"

/** The guard on a prompt with the go-ahead lines it cites in DECISIONS (or in the text given). */
const citedWith = (prompt: string, decisions: string | undefined) => signoffLint(prompt, signoffGrants(prompt, decisions))
const cited = (prompt: string) => citedWith(prompt, DECISIONS)
/** A command as the warning names it: up to where it ends. */
const shown = (command: string) => command.replace(/(?:,|\s(?:and|or)\b).*$/, '')
const refusedWith = (prompt: string, decisions: string | undefined) => /instructs (.*?) as a step/.exec(citedWith(prompt, decisions).refusal ?? '')?.[1]
const refusedCited = (prompt: string) => refusedWith(prompt, DECISIONS)

describe('a cited Standing go-ahead (lint.ts)', () => {
  test('signoffGrants: a marked line of a Standing section whose id the prompt holds as a whole word; nothing else', () => {
    expect(signoffGrants('signoff-delete-branches and signoff-rewrite-root-author', DECISIONS)).toEqual([
      { id: 'signoff-delete-branches', actionClass: 'delete-branch', text: ' User: delete merged branches from both remotes and locally; never main, develop or release/*.' },
      { id: 'signoff-rewrite-root-author', actionClass: 'force-push', text: ' User: rewrite the root author and push main to both remotes (origin and backup) with --force-with-lease.' },
    ])
    for (const prompt of ['signoff-in-unit', 'signoff-after-standing', 'signoff-no-marker', 'signoff-unknown', 'signoff-delete-branches-old', 'xsignoff-delete-branches', 'signoff-delete-branches_2', '[signoff:delete-branch]', 'signoff-delete']) {
      expect({ prompt, grants: signoffGrants(prompt, DECISIONS) }).toEqual({ prompt, grants: [] })
    }
    expect(signoffGrants('signoff-delete-branches', undefined)).toEqual([])
    expect(signoffGrants('signoff-delete-branches', '')).toEqual([])
    // A heading that starts with Standing is a Standing section; CRLF line ends are read too.
    expect(signoffGrants('del-x', '## Standing: the scratch mod (user)\r\ndel-x. [signoff:delete-branch] go.\r\n').map(one => one.id)).toEqual(['del-x'])
    expect(signoffGrants('del-x.', '## Standing\ndel-x. [signoff:delete-branch] go.\n').map(one => one.id)).toEqual(['del-x'])
  })

  test('delete-branch: every allowed remote and local form passes, named in one warning line with its id, class and commands', () => {
    for (const command of [
      'git push origin --delete feature/old',
      'git push --delete origin feature/old',
      'git push origin -d feature/old',
      'git push origin :feature/old',
      'git push origin :refs/heads/feature/old',
      'git push origin --delete refs/heads/feature/old',
      'git push backup --delete feature/a bugfix/b-2',
      'git push origin :feature/a :feature/b',
      'git -C /tmp/scratch push origin --delete feature/old',
      'git push /tmp/scratch-remote.git --delete feature/old',
      'git push origin --delete maintenance',
      'git push origin --delete feature/old and report',
      'git push origin --delete feature/old, then report',
    ]) {
      expect({ command, lint: cited(`${ITEMS}${CITE_DELETE}${command}`) }).toEqual({
        command,
        lint: { warnings: [`sign-off allowed by signoff-delete-branches: delete-branch: ${shown(command)}`], allowed: [{ id: 'signoff-delete-branches', actionClass: 'delete-branch', commands: [shown(command)] }] },
      })
    }
    // In backticks, in a sentence, several commands on several lines: one warning line, each command once.
    const prompt = `${ITEMS}${CITE_DELETE}Run \`git push origin --delete feature/a\` now.\nThen git push backup :feature/a.\nRun \`git push origin --delete feature/a\` again.\ngit branch -d feature/a\ngit branch --delete feature/a`
    expect(cited(prompt).warnings).toEqual(['sign-off allowed by signoff-delete-branches: delete-branch: git push origin --delete feature/a; git push backup :feature/a'])
  })

  test('delete-branch: a protected name, a glob, a variable, a tag, -D, --force, a mirror or pruning push, an extra option, no branch and a bare push stay refused', () => {
    // A `:` refspec with a glob is no deletion the guard reads, with or without the id, as before.
    expect([signoffLint(`${ITEMS}git push origin :feature/*`).refusal, refusedCited(`${ITEMS}${CITE_DELETE}git push origin :feature/*`)]).toEqual([undefined, undefined])
    const DELETION = 'a remote branch or tag deletion on line 3'
    for (const [command, refused] of [
      ['git push origin --delete main', DELETION],
      ['git push origin --delete Main', DELETION],
      ['git push origin --delete MASTER', DELETION],
      ['git push origin --delete refs/heads/main', DELETION],
      ['git push origin :main', DELETION],
      ['git push origin :refs/heads/develop', DELETION],
      ['git push origin --delete release/1.2', DELETION],
      ['git push origin --delete Release/x', DELETION],
      ['git push origin --delete release', DELETION],
      ['git push origin --delete HEAD', DELETION],
      ['git push origin --delete feature/a main', DELETION],
      ['git push origin --delete feature/a, main', DELETION],
      ['git push origin --delete feature/a and main.', DELETION],
      ['git push origin --delete feature/a or `develop`', DELETION],
      ['git push origin :feature/a, refs/heads/master', DELETION],
      ['git push origin --delete feature/a, feature/*', DELETION],
      ['git push origin --delete feature/*', DELETION],
      ['git push origin --delete $BRANCH', DELETION],
      ['git push origin --delete feature/$X', DELETION],
      ['git push origin --delete `git branch --show-current`', DELETION],
      ['git push origin --delete refs/tags/v1', DELETION],
      ['git push origin :refs/tags/v1', DELETION],
      ['git push origin --delete tag v1', DELETION],
      ['git push origin --delete refs/remotes/origin/x', DELETION],
      ['git push --tags origin --delete v1', DELETION],
      ['git push origin --delete', DELETION],
      ['git push origin --delete feature/a --no-verify', DELETION],
      ['git push origin --delete ../x', DELETION],
      ['push origin --delete feature/old', DELETION],
      ['git push --force origin --delete feature/x', 'a force-push on line 3, a remote branch or tag deletion on line 3'],
      ['git push -df origin feature/x', 'a force-push on line 3, a remote branch or tag deletion on line 3'],
      ['git branch -D feature/old', 'branch -D on line 3'],
      ['git branch -d -f feature/old', 'branch -D on line 3'],
      ['git branch --delete --force feature/old', 'branch -D on line 3'],
      ['git push --mirror origin', 'a mirror push on line 3'],
      ['git push --prune origin refs/heads/*:refs/heads/*', 'a pruning push on line 3'],
      ['git reset --hard origin/main', 'reset --hard on line 3'],
      ['git clean -fdx', 'a forced clean on line 3'],
    ] as const) {
      expect({ command, refused: refusedCited(`${ITEMS}${CITE_DELETE}${command}`) }).toEqual({ command, refused })
    }
  })

  test('force-push: git push --force-with-lease[=main[:<expect>]] <a remote the line names> main or main:main passes, with the push-to-main warning', () => {
    for (const command of [
      'git push --force-with-lease origin main',
      'git push --force-with-lease backup main:main',
      'git push origin main --force-with-lease',
      'git push --force-with-lease=main origin main',
      'git push --force-with-lease=main:0123abc origin main',
      'git push --force-with-lease=refs/heads/main:origin/main backup main',
      'git -C /tmp/scratch push --force-with-lease origin main',
      'git push --force-with-lease origin main and report',
    ]) {
      expect({ command, lint: cited(`${ITEMS}${CITE_LEASE}${command}`) }).toEqual({
        command,
        lint: { warnings: [MAIN_WARNING, `sign-off allowed by signoff-rewrite-root-author: force-push: ${shown(command)}`], allowed: [{ id: 'signoff-rewrite-root-author', actionClass: 'force-push', commands: [shown(command)] }] },
      })
    }
  })

  test('force-push: the unleased and + forms, another branch, another or no remote, more words and the force-push words stay refused', () => {
    for (const command of [
      'git push --force origin main',
      'git push -f origin main',
      'git push origin +main',
      'git push --force-with-lease origin +main',
      'git push --force-with-lease origin +main:main',
      'git push --force-with-lease --force origin main',
      'git push --force-with-lease origin feature/x',
      'git push --force-with-lease origin develop',
      'git push --force-with-lease origin HEAD:main',
      'git push --force-with-lease origin refs/heads/main',
      'git push --force-with-lease origin main:develop',
      'git push --force-with-lease main',
      'git push --force-with-lease',
      'git push --force-with-lease upstream main',
      'git push --force-with-lease $REMOTE main',
      'git push --force-with-lease origin main feature/x',
      'git push --force-with-lease origin main --no-verify',
      'git push --force-with-lease origin main, feature/x',
      'git push --force-with-lease origin main and develop',
      'git push --force-with-lease origin main, +main',
      'git push --force-with-lease=develop origin main',
      'git push --force-with-lease=main:$SHA origin main',
      'push --force-with-lease origin main',
      'Then force-push main to origin',
    ]) {
      expect({ command, refused: refusedCited(`${ITEMS}${CITE_LEASE}${command}`) }).toEqual({ command, refused: 'a force-push on line 3' })
    }
    expect(refusedCited(`${ITEMS}${CITE_LEASE}git push --mirror --force-with-lease origin`)).toBe('a force-push on line 3, a mirror push on line 3')
  })

  test('the class must match, the id must be cited whole, in a Standing section, its line must carry the marker; no file is no citation', () => {
    const deletion = 'git push origin --delete feature/old'
    const lease = 'git push --force-with-lease origin main'
    expect(refusedCited(`${ITEMS}${CITE_LEASE}${deletion}`)).toBe('a remote branch or tag deletion on line 3')
    expect(refusedCited(`${ITEMS}${CITE_DELETE}${lease}`)).toBe('a force-push on line 3')
    for (const citation of ['signoff-in-unit', 'signoff-after-standing', 'signoff-no-marker', 'signoff-unknown', 'signoff-delete-branches-old', 'xsignoff-delete-branches', 'signoff-delete-branches_2', '[signoff:delete-branch]']) {
      const prompt = `${ITEMS}Cited: ${citation}.\n${deletion}`
      expect({ citation, refused: refusedCited(prompt) }).toEqual({ citation, refused: 'a remote branch or tag deletion on line 3' })
    }
    expect(refusedWith(`${ITEMS}${CITE_DELETE}${deletion}`, undefined)).toBe('a remote branch or tag deletion on line 3')
    expect(refusedWith(`${ITEMS}${CITE_DELETE}${deletion}`, '')).toBe('a remote branch or tag deletion on line 3')
    // Both ids cited: each class by its own line.
    const both = cited(`${ITEMS}Cited: signoff-delete-branches, signoff-rewrite-root-author.\n${deletion}\n${lease}`)
    expect(both).toEqual({
      warnings: [MAIN_WARNING, `sign-off allowed by signoff-delete-branches: delete-branch: ${deletion}`, `sign-off allowed by signoff-rewrite-root-author: force-push: ${lease}`],
      allowed: [
        { id: 'signoff-delete-branches', actionClass: 'delete-branch', commands: [deletion] },
        { id: 'signoff-rewrite-root-author', actionClass: 'force-push', commands: [lease] },
      ],
    })
  })

  test('a negated sentence still passes as before, with or without the id, and is named in no warning', () => {
    for (const prompt of [`${ITEMS}${CITE_DELETE}Never run git push origin --delete main.`, `${ITEMS}${CITE_DELETE}Do not run git push origin --delete feature/x.`, `${ITEMS}${CITE_LEASE}Never git push --force origin main.`]) {
      expect({ prompt, lint: cited(prompt) }).toEqual({ prompt, lint: { warnings: [] } })
    }
  })

  test('the refusal of a deletion or a force-push ends with how to cite a go-ahead; one of only other actions does not', () => {
    for (const prompt of [`${ITEMS}git push origin --delete feature/x`, `${ITEMS}git push --force-with-lease origin main`, `${ITEMS}${CITE_DELETE}git push origin --delete main`]) {
      expect({ prompt, refusal: cited(prompt).refusal }).toEqual({ prompt, refusal: expect.stringMatching(new RegExp(`\\(never, do not, stop before\\) passes; ${CITE_HINT}$`)) as never })
      expect(cited(prompt).isCitable).toBe(true)
    }
    for (const prompt of [`${ITEMS}git reset --hard`, `${ITEMS}git branch -D x`, `${ITEMS}git push --mirror origin`]) {
      const lint = cited(prompt)
      expect({ prompt, ends: lint.refusal?.endsWith('(never, do not, stop before) passes'), isCitable: lint.isCitable }).toEqual({ prompt, ends: true, isCitable: undefined })
    }
  })

  test('100 lines mixing allowed and refused steps: the refusal names the refused steps from the first, never an allowed one', () => {
    const lines = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? `git push origin --delete feature/n${i}` : `Step ${i}: look at the log.`))
    lines[0] = 'Cited: signoff-delete-branches.'
    lines[36] = 'git reset --hard origin/main'
    lines[61] = 'git push backup :main'
    lines[90] = 'git branch -D feature/n90'
    const lint = cited(lines.join('\n'))
    expect(lint.refusal).toStartWith('refused by the sign-off guard: the prompt instructs reset --hard on line 37, a remote branch or tag deletion on line 62, branch -D on line 91 as a step for the worker;')
    expect(lint.refusal).toEndWith(CITE_HINT)
    // Without its three refused steps, the same prompt is allowed: one warning line naming every deletion once.
    const clean = lines.filter((_, i) => ![36, 61, 90].includes(i))
    const allowedLint = cited(clean.join('\n'))
    expect(allowedLint.refusal).toBeUndefined()
    expect(allowedLint.allowed?.[0]?.commands.length).toBe(31)
    // Without the citation, the first deletion is refused, then each other.
    expect(signoffLint(clean.join('\n')).refusal).toStartWith('refused by the sign-off guard: the prompt instructs a remote branch or tag deletion on line 4, a remote branch or tag deletion on line 7,')
  })
})

describe('a cited Standing go-ahead through the plugin', () => {
  const seedDecisions = (world: World) => world.files.set(`${ORCH}/agreed-decisions.md`, DECISIONS)
  const launchOf = (call: (tool: string, input: Record<string, unknown>) => Promise<{ deny?: string; isPassed: boolean; result?: unknown }>) => (prompt: string, title = 'cited case') =>
    call('mcp__session-control__launch_worker', { dir: '/w/work', model: 'haiku', effort: 'low', title, prompt })

  test('launch_worker: the cited deletion is launched with the WARNING line; a protected name, no citation, another class and no decisions file are refused', { options: { ...OPTIONS, debug: true } }, async ($, on) => {
    const { world, call } = await started($, on)
    seedDecisions(world)
    const launch = launchOf(call)
    const steps = 'git push origin --delete feature/a\ngit push origin :feature/b'
    const accepted = await launch(`${ITEMS}${CITE_DELETE}${steps}`)
    expect(accepted.deny).toBeUndefined()
    expect(String(accepted.result)).toContain('\nWARNING: sign-off allowed by signoff-delete-branches: delete-branch: git push origin --delete feature/a; git push origin :feature/b')
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
    for (const [prompt, title, listed, end] of [
      [`${ITEMS}${CITE_DELETE}git push origin --delete main`, 'protected', 'a remote branch or tag deletion on line 3', CITE_HINT],
      [`${ITEMS}${steps}`, 'uncited', 'a remote branch or tag deletion on line 2, a remote branch or tag deletion on line 3', CITE_HINT],
      [`${ITEMS}${CITE_LEASE}${steps}`, 'other class', 'a remote branch or tag deletion on line 3, a remote branch or tag deletion on line 4', CITE_HINT],
      [`${ITEMS}${CITE_DELETE}git push origin --delete feature/a\ngit branch -D feature/a`, 'branch -D', 'branch -D on line 4', '(never, do not, stop before) passes'],
    ] as const) {
      const refused = await launch(prompt, title)
      expect({ title, deny: refused.deny }).toEqual({ title, deny: expect.stringMatching(new RegExp(`^session-control: refused by the sign-off guard: the prompt instructs ${listed} as a step for the worker;.*${end.replace(/[()]/g, '\\$&')}; nothing was launched$`)) as never })
    }
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
    world.files.delete(`${ORCH}/agreed-decisions.md`)
    expect((await launch(`${ITEMS}${CITE_DELETE}${steps}`, 'no file')).deny).toContain('the prompt instructs a remote branch or tag deletion on line 3, a remote branch or tag deletion on line 4 as a step')
    expect(world.passed.filter(one => one.tool === 'Bash').length).toBe(1)
    // The trace: the id, the class and the count; never a branch or a command.
    const trace = world.files.get(`${RUNS}/trace.log`) ?? ''
    const lines = trace.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const allowed = lines.filter(line => line.event === 'guard' && line.allowedBy !== undefined)
    expect(allowed.map(({ tool, isOk, check, allowedBy, actionClass, commands }) => ({ tool, isOk, check, allowedBy, actionClass, commands }))).toEqual([
      { tool: 'launch_worker', isOk: true, check: 'sign-off', allowedBy: 'signoff-delete-branches', actionClass: 'delete-branch', commands: 2 },
    ])
    expect(JSON.stringify(allowed)).not.toContain('feature/')
  })

  test('the orchestrator session: its own deletion and force-push stay refused with the id in the command text', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    seedDecisions(world)
    for (const command of [
      'git push origin --delete feature/old # signoff-delete-branches',
      'echo signoff-delete-branches && git push origin :feature/old',
      'git push --force-with-lease origin main # signoff-rewrite-root-author',
      'git branch -D feature/old # signoff-delete-branches',
    ]) {
      const answer = await call('Bash', { command })
      expect({ command, isPassed: answer.isPassed, refused: answer.deny?.startsWith('session-control: refused by the sign-off guard: git ') }).toEqual({ command, isPassed: false, refused: true })
    }
    expect((await call('PowerShell', { command: 'git push origin --delete feature/old # signoff-delete-branches' })).deny).toContain('(PowerShell)')
  })
})
