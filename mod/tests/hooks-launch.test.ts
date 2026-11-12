// Integration: the plugin's hooks against the engine's test kit, the tools: the scope, the tool surface, a fresh
// environment, the errors, the board command, completions, launch_worker (fresh, resume, inline prompt, the sign-off
// guard) and close_worker. The world and its knobs are hooks-kit.ts'.

import { describe, expect, test } from 'claude-code/testing'

import { auditFindings } from '../hooks/audit'
import { missingPromptItems, parseProcFacts, parseRegistry, rowStatus, RULES_BLOCK } from '../hooks/core'
import { signoffLint } from '../hooks/lint'
import { isRegistrySound } from '../hooks/notices'

import {
  HOME,
  NOW_MS,
  ORCH_DIR,
  REGISTRY_PATH,
  REGISTRY_TEXT,
  SID_ALIVE,
  SID_DEAD,
  SID_UNREPORTED,
  TASK_NOTIFICATION_KILLED,
} from './fixtures'
import {
  boot,
  DECISIONS,
  fingerprint,
  fixture,
  HELD,
  lastRegistry,
  LATE,
  launchTool,
  LINUX_FIXTURE,
  MISSING,
  mountPane,
  OPEN_POINTS_TEXT,
  OPTIONS,
  PANE_PROPS,
  POWERSHELL,
  PROMPT_HARVEST_SEC,
  QUEUE,
  QUEUE_TEXT,
  REGISTRY_READS,
  runCommand,
  stubPanel,
  traceOf,
  UNREADABLE,
  WINDOWS,
  withoutFinishedOpen,
  WORKER,
  world,
} from './hooks-kit'
import type { World } from './hooks-kit'
import { echoPrompt } from './notice-kit'

describe('scope', () => {
  test('a no-op outside the orchestrator dir', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($, '/work/elsewhere')
    expect(w.runs.length).toBe(0)
    expect(w.registered).toEqual(['/session-control'])
  })

  test('without the orchestratorDir option the board starts where CLAUDE.md is the orchestrator, and the command refuses elsewhere', { options: { registryPath: '~/.claude/headless-sessions.json', completionWrites: true } }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($, '/work/elsewhere')
    expect(w.registered).toEqual(['/session-control'])
    const refused = await runCommand($, '')
    expect(refused.text).toContain('not an orchestrator directory')
    await boot($, '/work/orch/')
    expect(w.registered).toContain('launch_worker')
    expect(w.writes.some(one => one.path === '/work/orch/open-points.json')).toBe(true)
  })
})

describe('tool surface', () => {
  test('the six tools keep their names, descriptions and schemas', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    // The first six as they were; later tools come after them.
    expect(w.tools.slice(0, 6).map(tool => tool.name)).toEqual(['launch_worker', 'acknowledge_workers', 'retire_workers', 'open_point', 'queue_task', 'record_decision'])
    // The whole tool surface in one pin: it moves only on purpose (each past move and its old value is in git log).
    expect(fingerprint(JSON.stringify(w.tools))).toBe('19900:e1f52e89')
  })

  test('the open_point and queue_task descriptions say the list action does not redact', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    for (const name of ['open_point', 'queue_task']) {
      const tool = w.tools.find(one => one.name === name)
      expect(JSON.stringify(tool)).toContain('The list action does not redact secrets; ids, session ids and paths stay readable.')
    }
  })
})

describe('fresh environment', () => {
  test('missing helper files are created from scratch, nothing warns, and the tools work on them', { options: OPTIONS }, async ($, on) => {
    for (const file of ['open-points.json', 'task-queue.json']) MISSING.add(`${ORCH_DIR}/${file}`)
    const w = world(on)
    try {
      await boot($)
      const created = (file: string) => w.writes.find(one => one.path === `${ORCH_DIR}/${file}`)?.text
      expect(JSON.parse(created('open-points.json') ?? '{}')).toMatchObject({ points: [] })
      expect(JSON.parse(created('task-queue.json') ?? '{}')).toEqual({ tasks: [] })
      expect(created('agreed-decisions.md')).toBe('# Agreed decisions\n')
      expect(created('open-points-archive.md')).toBe('# Open points archive\n')
      expect(w.runs.some(argv => argv[0] === 'mkdir' && argv.includes(`${ORCH_DIR}/backups`))).toBe(true)
      expect(w.toasts.every(text => text.includes('limited worker'))).toBe(true)
    } finally {
      MISSING.clear()
    }
  })
})

describe('errors', () => {
  test('an unreadable registry is toasted once and the panel shows the warning in the sessions box', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, 'not json')
    stubPanel(on)
    await boot($)
    expect(w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 ')).length).toBe(1)
    await runCommand($, '')
    expect(w.toasts.filter(text => text.startsWith('Tracking problem \u00B7 ')).length).toBe(1)
    const ui = await mountPane($)
    const all = String(((await ui.findAll({}))[0] as { text?: string }).text ?? '')
    expect(all).toContain('! session-control:')
    expect(all).toContain('SESSIONS')
    expect(all).toContain('QUEUED WORK')
  })
})

describe('session-control board', () => {
  test('session.start registers, gathers with one probe call, gathers the rows', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($, ORCH_DIR + '/')
    // The command and the first six tools; the later ones are pinned by 'tool surface > the six tools keep their names, descriptions and schemas'.
    expect(w.registered.slice(0, 7)).toEqual(['/session-control', 'launch_worker', 'acknowledge_workers', 'retire_workers', 'open_point', 'queue_task', 'record_decision'])
    const probes = w.calls.filter(one => one.op === 'probe')
    expect(probes.length).toBe(1)
    expect(probes[0]?.request.args).toContain(`pid:4101|/fixture/lic/a`)
  })

  test('/session-control side opens one panel: sessions, queued work, open points, in that order', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await boot($)
    const ran = await runCommand($, 'side')
    expect(ran.text).toBe('Session-control panel opened.')
    const ui = await $.ui.mount({
      plugin: 'session-control',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'session-control',
      props: PANE_PROPS as never,
    })
    const all = String(((await ui.findAll({}))[0] as { text?: string }).text ?? '')
    const at = (needle: string) => all.indexOf(needle)
    expect(at('SESSIONS')).toBe(0)
    expect(at('SESSIONS')).toBeLessThan(at('alive worker'))
    expect(at('alive worker')).toBeLessThan(at('QUEUED WORK'))
    expect(at('QUEUED WORK')).toBeLessThan(at('General (1)'))
    expect(at('General (1)')).toBeLessThan(at('OPEN POINTS'))
    expect(at('OPEN POINTS')).toBeLessThan(at('1. First question'))
    expect(at('1. First question')).toBeLessThan(at('2. Second question'))
    expect(/Held|Settled/.test(all)).toBe(false)
    expect(/CURRENT STATUS|FINAL STATE|IN FLIGHT/.test(all)).toBe(false)
  })
})

describe('completion', () => {
  test('a dead worker is classified, merged in place once, and toasted', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const regWrites = () => w.writes.filter(one => one.path === REGISTRY_PATH)
    expect(regWrites().length).toBe(1)
    const after = JSON.parse(regWrites()[0]!.text) as Record<string, unknown>[]
    const entry = after.find(one => one.session_id === SID_DEAD)!
    expect('pid' in entry).toBe(false)
    expect(entry.reported).toBe(false)
    expect(entry.resume).toEqual({ parked_until: '2026-10-06T12:00:00Z', strikes: 2, escalated: true })
    expect(w.toasts).toEqual(['Usage limit reached \u00B7 limited worker: limit: rate limit hit'])
    await w.clock.advance(5000)
    expect(regWrites().length).toBe(1)
    expect(w.writes.some(one => one.path.includes('/backups/headless-sessions-before-completion-'))).toBe(true)
  })

  // The toast leads with the notification type, then the message as before.
  for (const [result, title, summary] of [
    ['clean', 'Session finished', 'clean: Implemented the parser, 14 tests pass, committed as feat(parser): add registry reader.'],
    ['limit', 'Usage limit reached', 'limit: rate limit hit'],
    ['login', 'Login needed', 'login: licence needs a re-login'],
    ['oom', 'Session killed', 'killed: killed (memory)'],
    ['error', 'Session failed', 'error: Tool execution failed: ENOSPC while writing the output.'],
    ['chatter', 'Session ended without a report', 'chatter: short result "Let me look at that." after a substantial run'],
  ] as const) {
    test(`a completion toast carries its type as the title: ${title}`, { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT.replace('/fixture/results/limit.json', `/fixture/results/${result}.json`))
      await boot($)
      expect(w.toasts).toEqual([`${title} \u00B7 limited worker: ${summary}`])
    })
  }

  test('a clean report quoting the login message is clean; the err file is read and a login there is a login', { options: OPTIONS }, async ($, on) => {
    const quoting = REGISTRY_TEXT.replace('/fixture/results/limit.json', '/fixture/results/designReport.json')
    const w = world(on, '/fixture/lic/a\n', true, quoting)
    await boot($)
    expect(w.toasts[0]).toStartWith('Session finished · limited worker: clean: ')
    expect(w.reads).not.toContain('/fixture/results/login.err')
  })
  test('the err file of the entry decides a login when the run did not succeed', { options: OPTIONS }, async ($, on) => {
    const withErr = REGISTRY_TEXT.replace('"result_file": "/fixture/results/limit.json"', '"result_file": "/fixture/results/maxTurns.json",\n    "err_file": "/fixture/results/login.err"')
    const w = world(on, '/fixture/lic/a\n', true, withErr)
    await boot($)
    expect(w.reads).toContain('/fixture/results/login.err')
    expect(w.toasts).toEqual(['Login needed · limited worker: login: licence needs a re-login'])
  })
  test('the err file of the entry does not turn a successful run into a login', { options: OPTIONS }, async ($, on) => {
    const withErr = REGISTRY_TEXT.replace('"result_file": "/fixture/results/limit.json"', '"result_file": "/fixture/results/designReport.json",\n    "err_file": "/fixture/results/login.err"')
    const w = world(on, '/fixture/lic/a\n', true, withErr)
    await boot($)
    expect(w.toasts[0]).toStartWith('Session finished · limited worker: clean: ')
    const entry = lastRegistry(w).find(one => one.session_id === SID_DEAD)
    expect((entry?.outcome as { kind?: string }).kind).toBe('clean')
    // The harvest time, in epoch seconds, ends the run's duration.
    expect(entry?.ended_at).toBe(NOW_MS / 1000)
  })

  test('a real report with both reads gets no report-check line', { options: OPTIONS }, async ($, on) => {
    world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT.replace('/fixture/results/limit.json', '/fixture/results/probeReport.json'))
    echoPrompt(on)
    await boot($)
    const sent = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(withoutFinishedOpen(sent.context)?.length).toBe(1)
    expect(String(sent.context?.[0])).not.toContain('report check')
  })

  test('with completionWrites off nothing is written, the toast still shows', { options: { ...OPTIONS, completionWrites: false } }, async ($, on) => {
    const w = world(on)
    await boot($)
    expect(w.writes.filter(one => one.path === REGISTRY_PATH).length).toBe(0)
    expect(w.toasts.length).toBe(1)
  })

  test('a task notification carries the pending completion to the model once', { options: OPTIONS }, async ($, on) => {
    world(on)
    echoPrompt(on)
    await boot($)
    const first = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(withoutFinishedOpen(first.context)).toEqual(['session-control completions: limited worker: limit: rate limit hit'])
    const second = await $.prompt.submit({ text: TASK_NOTIFICATION_KILLED, wait: false, origin: { kind: 'task-notification' } })
    expect(withoutFinishedOpen(second.context)).toBeUndefined()
  })
})

describe('launch_worker', () => {
  const args = { dir: '/work/new', prompt_file: '/work/new/prompt.md', model: 'opus', effort: 'high', title: 'new' }

  test('every launch has a unique session name and accepts messages from other sessions', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    await launchTool($, args)
    expect(String(w.bash[0]?.command)).toContain(`claude -p --model 'opus' -n 'w-new-260921141320' --settings '{"crossSessionInbound":"accept"}' --dangerously-skip-permissions`)
    // A second launch in the same second gets another name.
    await launchTool($, { ...args, dir: '/work/new' })
    expect(String(w.bash[1]?.command)).toContain(`-n 'w-new-260921141320-2' --settings`)
  })

  test('the registry records the session name and the messaging socket from the worker sessions file', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, args)
    expect(String(out.result)).toContain('registered. Name: w-new-260921141320; socket: /run/user/1000/cc-socks/7001.sock. Result: ')
    expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, name: 'w-new-260921141320', socket_path: '/run/user/1000/cc-socks/7001.sock', started_at: NOW_MS / 1000 })
  })

  test('an older claude whose sessions file has no inbox fields: the launch name, no socket_path, still registered', { options: OPTIONS }, async ($, on) => {
    WORKER.isInboxless = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('registered. Name: w-new-260921141320; socket: none.')
      const entry = lastRegistry(w).at(-1) as Record<string, unknown>
      expect(entry).toMatchObject({ pid: 7001, session_id: 'abcdabcd-0000-4000-8000-000000000001', name: 'w-new-260921141320' })
      expect('socket_path' in entry).toBe(false)
      // Three more reads of the sessions file, a second apart, before it goes without the socket.
      expect(w.runs.filter(argv => argv.join(' ') === 'sleep 1').length).toBe(3)
    } finally {
      WORKER.isInboxless = false
    }
  })

  test('without a picker, an orchestrator with its own CLAUDE_CONFIG_DIR: the worker inherits it, and the registry records it', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
    WORKER.linuxConfigDir = '/fixture/lic/own'
    try {
      const w = world(on, '', true, REGISTRY_TEXT, { HOME, CLAUDE_CONFIG_DIR: '/fixture/lic/own' })
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('config_dir /fixture/lic/own, registered.')
      expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
      expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, config_dir: '/fixture/lic/own' })
    } finally {
      WORKER.linuxConfigDir = '/fixture/lic/a'
    }
  })

  /** The text after the reason in the answer to a refused launch: nothing ran, and how a person allows it. */
  const ALLOW_HINT =
    '; the worker was not started and nothing was registered. The launch runs claude -p with --dangerously-skip-permissions through the shell, ' +
    "which a permission mode can refuse (the Auto mode of Claude Desktop's Code tab among them): allow that Bash command when you are asked, or with a permission rule, then launch again."

  test('a launch the Bash tool answers with an error: said with its text, nothing registered, nothing looked for', { options: OPTIONS }, async ($, on) => {
    WORKER.bashAnswer = { isError: true, result: 'Error: spawn failed', text: 'Error: spawn failed' }
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.deny)).toBe(`session-control: the Bash tool answered the launch with an error: Error: spawn failed${ALLOW_HINT}`)
      expect(w.runs.some(argv => argv[0] === 'sleep')).toBe(false)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
    } finally {
      WORKER.bashAnswer = undefined
    }
  })

  // A refusal or an error can come after the command ran (another plugin withholding the result, an interruption): one
  // probe, never repeated, looks for a worker with the launch's name.
  describe('the one probe after a refusal or an error of the launch tool', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: args, configDir: '/fixture/lic/a', runs: `${HOME}/.claude/session-control/runs`, socket: '/run/user/1000/cc-socks/7001.sock' },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        configDir: 'C:/fixture/home/.claude',
        runs: `C:${HOME}/.claude/session-control/runs`,
        socket: 'none',
      },
    ] as const
    /** The process probes so far (the helper's on Linux, PROBE_PS1 runs on Windows) and the waits of a search (2 s each). */
    const probes = (w: World) => w.calls.filter(one => one.op === 'probe').length + w.runs.filter(argv => argv[0] === POWERSHELL && String(argv[6]).endsWith('/probe.ps1')).length
    const searchWaits = (w: World) => w.runs.filter(argv => argv.join(' ') === 'sleep 2').length + w.calls.filter(one => one.op === 'pause' && one.request.ms === 2000).length
    const reset = () => {
      WORKER.bashAnswer = undefined
      WORKER.isAnsweredAfterRun = false
    }

    for (const host of hosts) {
      for (const [what, answer, said] of [
        ['a refusal (another plugin withheld the result)', { deny: 'a plugin withheld the result' }, 'refused the launch (a plugin withheld the result)'],
        ['an error (an interruption)', { isError: true, result: 'Interrupted by user', text: 'Interrupted by user' }, 'answered the launch with an error (Interrupted by user)'],
      ] as const) {
        test(`${host.name}, ${what} after the command ran: the one probe finds the worker by its name; registered, answered as started, with what the tool answered`, { options: host.options }, async ($, on) => {
          WORKER.bashAnswer = answer
          WORKER.isAnsweredAfterRun = true
          try {
            const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
            await boot($, host.dir)
            const before = probes(w)
            const out = await launchTool($, host.launch)
            expect(out.deny).toBeUndefined()
            expect(String(out.result)).toBe(
              `Launched pid 7001, session ${SID_NEW}, config_dir ${host.configDir}, registered. Name: w-new-260921141320; socket: ${host.socket}. ` +
                `Result: ${host.runs}/20260921141320-new.json; errors: ${host.runs}/20260921141320-new.err. The Bash tool ${said}, although the worker started.`,
            )
            expect(lastRegistry(w).at(-1)).toMatchObject({ pid: 7001, session_id: SID_NEW, result_file: `${host.runs}/20260921141320-new.json` })
            // The launch's own check before the call, the one probe after it, and the refresh after the registration: no search.
            expect(probes(w) - before).toBe(3)
            expect(searchWaits(w)).toBe(0)
          } finally {
            reset()
          }
        })
      }
    }
  })

  // A signoff block (lint.ts, README Sign-off guard): checked against the orchestrator's agreed-decisions.md on either
  // host, read only for a prompt that holds one; its lines are launched with a WARNING line; the rest stays refused.
  describe('a signoff block, on both hosts', () => {
    const BLOCK_DECISIONS = '# Agreed decisions\n\n## Standing\nscratch-delete-go. [signoff:delete-branch] User: delete merged scratch branches; never main.\nscratch-lease-go. [signoff:force-push] User: push main to origin with --force-with-lease once.\n'
    const HEAD = 'Wait in the foreground; report git status -sb; no attribution.'
    const LINES = ['git push origin --delete refs/heads/feature/a', 'git push origin :refs/heads/feature/b']
    const BLOCK = `${HEAD}\n\`\`\`signoff scratch-delete-go\n${LINES.join('\n')}\n\`\`\``
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: { dir: '/work/new', model: 'opus', effort: 'high', title: 'new' } },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { dir: '/c/work/new', model: 'opus', effort: 'high', title: 'new' },
      },
    ] as const

    for (const host of hosts) {
      test(`${host.name}: a valid block is launched with the WARNING line; the old citation, a stray deletion, another class, a bad line and a decisions file not there or unreadable are refused and nothing runs`, { options: host.options }, async ($, on) => {
        DECISIONS.text = BLOCK_DECISIONS
        try {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          await boot($, host.dir)
          const decisionReads = () => w.reads.filter(path => fixture(path) === `${ORCH_DIR}/agreed-decisions.md`).length
          const readsBefore = decisionReads()
          const launch = (prompt: string) => launchTool($, { ...host.launch, prompt })
          const DELETION = 'refused by the sign-off guard: the prompt instructs a remote branch or tag deletion'
          for (const [prompt, start] of [
            [`${HEAD}\n${LINES.join('\n')}`, `${DELETION} on line 2, a remote branch or tag deletion on line 3 as a step for the worker;`],
            [`${HEAD}\nPer scratch-delete-go:\n${LINES.join('\n')}`, `${DELETION} on line 3, a remote branch or tag deletion on line 4 as a step for the worker;`],
            [`${BLOCK}\nThen git push origin --delete main.`, `${DELETION} on line 6 as a step for the worker;`],
            [BLOCK.replace('signoff scratch-delete-go', 'signoff scratch-lease-go'), 'refused by the sign-off guard: the signoff block on line 2 (signoff scratch-lease-go): its line 1 (line 3 of the prompt) is a delete-branch command, and scratch-lease-go covers force-push;'],
            [BLOCK.replace('refs/heads/feature/b', 'refs/heads/feature/b "develop"'), 'refused by the sign-off guard: the signoff block on line 2 (signoff scratch-delete-go): its line 2 (line 4 of the prompt) is not one command in a form of the delete-branch class;'],
          ] as const) {
            const deny = String((await launch(prompt)).deny)
            expect({ start, deny: deny.slice(0, 'session-control: '.length + start.length) }).toEqual({ start, deny: `session-control: ${start}` })
            expect({ start, end: deny.endsWith('; nothing was launched') }).toEqual({ start, end: true })
          }
          // A refusal of the check outside the blocks ends with how a block is written when a block could cover the action,
          // then the detail: the command shape and its line, and the ways out.
          const SHAPE_WAYS = 'is refused wherever it stands, a describe block included; the ways out are a negation in its sentence (never, do not, stop before) or, for a class the user has recorded a Standing go-ahead for (a remote branch deletion, a leased push), its commands in a signoff block; nothing was launched'
          expect(String((await launch(`${HEAD}\n${LINES[0]}`)).deny)).toEndWith(`write its commands, one per line, in a fenced block whose info line is signoff <id>. The command shape \`git push origin --delete\` on line 2 ${SHAPE_WAYS}`)
          expect(String((await launch(`${HEAD}\ngit reset --hard`)).deny)).toEndWith('(never, do not, stop before) passes. The command shape `git reset --hard` on line 2 is refused wherever it stands, a describe block included; the ways out are a negation in its sentence (never, do not, stop before), a quoted example after an introducing word (for example, such as), or leaving the step out; no signoff block covers it; nothing was launched')
          expect([w.bash.length, w.powershell.length]).toEqual([0, 0])
          // The decisions file is read for each prompt that holds a well-formed block, and for no other: three of them so far.
          expect(decisionReads() - readsBefore).toBe(3)
          const out = await launch(BLOCK)
          expect(out.deny).toBeUndefined()
          expect(String(out.result)).toContain('Launched pid 7001')
          expect(String(out.result)).toEndWith(`\nWARNING: sign-off allowed by scratch-delete-go: delete-branch: ${LINES.join('; ')}`)
          expect(decisionReads() - readsBefore).toBe(4)
          const path = host.name === 'Windows' ? `C:${ORCH_DIR}/agreed-decisions.md` : `${ORCH_DIR}/agreed-decisions.md`
          DECISIONS.text = undefined
          expect(String((await launch(BLOCK)).deny)).toBe(`session-control: refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: ${path} is not there; nothing was launched`)
          UNREADABLE.add(`${ORCH_DIR}/agreed-decisions.md`)
          try {
            expect(String((await launch(BLOCK)).deny)).toBe(`session-control: refused by the sign-off guard: the signoff block on line 2 cannot be checked: the Standing decisions file could not be read: ${path} is there but its read and its stat both failed; nothing was launched`)
          } finally {
            UNREADABLE.delete(`${ORCH_DIR}/agreed-decisions.md`)
          }
          expect(w.bash.length + w.powershell.length).toBe(1)
        } finally {
          DECISIONS.text = undefined
        }
      })
    }
  })

  test('a settings hook that denies the Bash call (classic PreToolUse) is a refusal of the launch too', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    // Its input is the call's envelope (the tool and its arguments), as a settings hook's PreToolUse sees it.
    on('classic.PreToolUse', ($, e) => (String((e as { tool?: unknown }).tool) === 'Bash' ? { deny: 'blocked by a PreToolUse hook' } : {}))
    await boot($)
    const out = await launchTool($, args)
    expect(String(out.deny)).toBe(`session-control: the Bash tool refused the launch: blocked by a PreToolUse hook${ALLOW_HINT}`)
    expect(w.bash.length).toBe(0)
    expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
  })

  test('a refusal reason past 500 characters is cut there; an empty one is said as none given', { options: OPTIONS }, async ($, on) => {
    WORKER.bashAnswer = { deny: `x${'y'.repeat(700)}` }
    try {
      world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.deny)).toBe(`session-control: the Bash tool refused the launch: x${'y'.repeat(499)}${ALLOW_HINT}`)
      WORKER.bashAnswer = { deny: '  ' }
      const empty = await launchTool($, args)
      expect(String(empty.deny)).toBe(`session-control: the Bash tool refused the launch: no reason given${ALLOW_HINT}`)
    } finally {
      WORKER.bashAnswer = undefined
    }
  })

  test('a Bash tool the session does not offer is a clear refusal, and nothing is registered', { options: OPTIONS }, async ($, on) => {
    WORKER.isBashMissing = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.deny)).toStartWith('session-control: the worker could not be started through the Bash tool (')
      // The engine's reason in the brackets (the kit's own wording for a failed call).
      expect(String(out.deny)).toMatch(/Bash tool \(.+\); nothing/)
      expect(String(out.deny)).toEndWith('nothing was launched.')
      expect(w.bash.length).toBe(0)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
    } finally {
      WORKER.isBashMissing = false
    }
  })

  describe('a resume', () => {
    // The unreported entry: no pid, its transcript seen by the probe.
    const underHome = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? { ...one, config_dir: `${HOME}/.claude` } : one)))
    const resume = { ...args, resume_sid: SID_UNREPORTED }
    test('without a picker, of an entry under the default directory, sets no CLAUDE_CONFIG_DIR', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
      WORKER.linuxConfigDir = ''
      try {
        const w = world(on, '', true, underHome)
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        expect(String(w.bash[0]?.command)).not.toContain('CLAUDE_CONFIG_DIR')
        expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}'`)
      } finally {
        WORKER.linuxConfigDir = '/fixture/lic/a'
      }
    })
    test('without a picker, of an entry under another directory, sets it', { options: { ...OPTIONS, licencePickCommand: '' } }, async ($, on) => {
      const w = world(on, '')
      await boot($)
      expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
      expect(String(w.bash[0]?.command)).toContain(`CLAUDE_CONFIG_DIR='/fixture/lic/a' CLAUDE_CODE_EFFORT_LEVEL='high' claude -p --model 'opus' --resume '${SID_UNREPORTED}'`)
    })
    test('keeps the entry name; an entry without one gets a fresh name', { options: OPTIONS }, async ($, on) => {
      const named = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? { ...one, name: 'w-first-run-260901080000' } : one)))
      const w = world(on, '/fixture/lic/a\n', true, named)
      await boot($)
      expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
      expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}' -n 'w-first-run-260901080000' --settings '{"crossSessionInbound":"accept"}' --dangerously`)
    })
    const stale = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? { ...one, name: 'w-first-run-260901080000', socket_path: '/run/user/1000/cc-socks/1.sock' } : one)))
    test('records the new socket over the old one', { options: OPTIONS }, async ($, on) => {
      WORKER.sid = SID_UNREPORTED
      try {
        const w = world(on, '/fixture/lic/a\n', true, stale)
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        // The name is the one the sessions file holds (the engine's own), the fixture's here.
        expect(lastRegistry(w).find(one => one.session_id === SID_UNREPORTED)).toMatchObject({ pid: 7001, name: 'w-new-260921141320', socket_path: '/run/user/1000/cc-socks/7001.sock' })
      } finally {
        WORKER.sid = 'abcdabcd-0000-4000-8000-000000000001'
      }
    })
    test('a sessions file without a socket writes socket_path null over the dead one, the kept name stays', { options: OPTIONS }, async ($, on) => {
      WORKER.sid = SID_UNREPORTED
      WORKER.isInboxless = true
      try {
        const w = world(on, '/fixture/lic/a\n', true, stale)
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        expect(lastRegistry(w).find(one => one.session_id === SID_UNREPORTED)).toMatchObject({ pid: 7001, name: 'w-first-run-260901080000', socket_path: null })
      } finally {
        WORKER.isInboxless = false
        WORKER.sid = 'abcdabcd-0000-4000-8000-000000000001'
      }
    })
    test('of an entry without a name: a fresh unique name', { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n')
      await boot($)
      expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
      expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}' -n 'w-new-260921141320' --settings`)
    })
    test('with a picker, of an entry under the default directory, sets it as before', { options: OPTIONS }, async ($, on) => {
      WORKER.linuxConfigDir = `${HOME}/.claude`
      try {
        const w = world(on, '/fixture/lic/a\n', true, underHome)
        await boot($)
        expect(String((await launchTool($, resume)).result)).toContain('Launched pid 7001')
        expect(String(w.bash[0]?.command)).toContain(`CLAUDE_CONFIG_DIR='${HOME}/.claude'`)
        expect(w.runs.some(argv => argv[0] === '/fixture/bin/pick')).toBe(false)
      } finally {
        WORKER.linuxConfigDir = '/fixture/lic/a'
      }
    })
  })

  test('a session file that appears late is still read, and the worker is registered', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    LATE.add('/fixture/lic/a/sessions/7001.json')
    try {
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('Launched pid 7001')
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(true)
    } finally {
      LATE.clear()
    }
  })

  const LAUNCH_RUNS = `${HOME}/.claude/session-control/runs`
  test('a worker that appears only after the 30 s of the launch: answered as started and not registered yet, then registered by the poll that finds it', { options: OPTIONS }, async ($, on) => {
    LINUX_FIXTURE.isWorkerHidden = true
    try {
      const w = world(on)
      await boot($)
      const before = lastRegistry(w).length
      const out = await launchTool($, args)
      expect(String(out.result)).toBe(
        'Started in the background, but no claude process for it appeared within 30 s: it is not registered yet. ' +
          "Check it with list_sessions: while it runs unregistered it is an orphan row (cwd /work/new); the mod's poll registers it as soon as it finds it " +
          '(up to 10 min after the launch), and its entry then takes the orphan row\'s place. ' +
          `If neither row appears, it did not start: read ${LAUNCH_RUNS}/20260921141320-new.err. Result: ${LAUNCH_RUNS}/20260921141320-new.json.`,
      )
      // Fifteen checks at most, each after a `sleep 2` process: the Linux wait as it was.
      expect(w.runs.filter(argv => argv.join(' ') === 'sleep 2').length).toBe(15)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
      // The worker shows up: the next poll registers it with what the launch would have written.
      LINUX_FIXTURE.isWorkerHidden = false
      await w.clock.advance(5000)
      const after = lastRegistry(w)
      expect(after.length).toBe(before + 1)
      expect(after.at(-1)).toMatchObject({
        title: 'new',
        pid: 7001,
        session_id: 'abcdabcd-0000-4000-8000-000000000001',
        name: 'w-new-260921141320',
        socket_path: '/run/user/1000/cc-socks/7001.sock',
        config_dir: '/fixture/lic/a',
        cwd: '/work/new',
        model: 'opus',
        effort: 'high',
        result_file: `${LAUNCH_RUNS}/20260921141320-new.json`,
        err_file: `${LAUNCH_RUNS}/20260921141320-new.err`,
        started_at: NOW_MS / 1000,
      })
      // Registered once: later polls leave it as it is.
      await w.clock.advance(5000)
      expect(lastRegistry(w).filter(one => one.pid === 7001).length).toBe(1)
    } finally {
      LINUX_FIXTURE.isWorkerHidden = false
    }
  })

  test('a worker still not seen 10 minutes after its launch is no longer looked for', { options: OPTIONS }, async ($, on) => {
    LINUX_FIXTURE.isWorkerHidden = true
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('it is not registered yet')
      for (let step = 0; step < 121; step++) await w.clock.advance(5000)
      LINUX_FIXTURE.isWorkerHidden = false
      await w.clock.advance(5000)
      expect(lastRegistry(w).some(one => one.pid === 7001)).toBe(false)
    } finally {
      LINUX_FIXTURE.isWorkerHidden = false
    }
  })

  // The registry read back as the plugin wrote it (REGISTRY_READS): the poll that registers a late worker reads its own
  // entry back, and its probe ran before that entry existed.
  describe('a worker the poll registers after the launch\'s 30 s, with the registry read back as written', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const PONG = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', duration_ms: 1300, num_turns: 1, total_cost_usd: 0.0025, session_id: SID_NEW })
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: args, runs: LAUNCH_RUNS, knobs: LINUX_FIXTURE },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        runs: `C:${LAUNCH_RUNS}`,
        knobs: WINDOWS,
      },
    ] as const
    const completions = async ($: { prompt: { submit: (e: never) => Promise<{ context?: readonly unknown[] }> } }) =>
      ((await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)).context ?? []).filter(line => String(line).startsWith('session-control completions: '))

    for (const host of hosts) {
      test(`${host.name}: the poll that registers it does not judge it; it stays registered with its pid while it runs, no toast, no note; when it ends it is harvested once, with its outcome`, { options: host.options }, async ($, on) => {
        REGISTRY_READS.isCurrent = true
        host.knobs.isWorkerHidden = true
        try {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          echoPrompt(on)
          await boot($, host.dir)
          // The start's harvest (the limited worker) rides on a first prompt.
          await completions($ as never)
          const out = await launchTool($, host.launch)
          expect(String(out.result)).toStartWith('Started in the background, but no claude process for it appeared within 30 s: it is not registered yet.')
          const mine = () => lastRegistry(w).filter(one => one.session_id === SID_NEW)
          const told = () => w.toasts.filter(one => one.includes(' \u00B7 new: '))
          // The worker shows and runs on: the next poll registers it and leaves it as it is.
          host.knobs.isWorkerHidden = false
          await w.clock.advance(5000)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001, result_file: `${host.runs}/20260921141320-new.json` })] as never)
          expect(mine().some(one => 'outcome' in one || 'reported' in one)).toBe(false)
          expect(told()).toEqual([])
          expect(await completions($ as never)).toEqual([])
          // The polls after it judge it by its own proof of life: running, still registered with its pid.
          await w.clock.advance(5000)
          await w.clock.advance(5000)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001 })] as never)
          expect(mine().some(one => 'outcome' in one)).toBe(false)
          expect(told()).toEqual([])
          // It ends with its report: harvested once, by the next poll, with the outcome its result file holds.
          WORKER.resultText = PONG
          host.knobs.isWorkerHidden = true
          await w.clock.advance(5000)
          expect(mine()).toEqual([expect.objectContaining({ reported: false, outcome: { kind: 'clean', summary: 'clean: PONG', costUsd: 0.0025 } })] as never)
          expect(mine().some(one => 'pid' in one)).toBe(false)
          await w.clock.advance(5000)
          expect(told()).toEqual(['Session finished \u00B7 new: clean: PONG'])
          const notes = await completions($ as never)
          expect(notes.length).toBe(1)
          expect(String(notes[0])).toStartWith('session-control completions: new: clean: PONG')
          expect(await completions($ as never)).toEqual([])
        } finally {
          REGISTRY_READS.isCurrent = false
          host.knobs.isWorkerHidden = false
          WORKER.resultText = undefined
        }
      })
    }
  })

  // Two launches of the same dir, config dir and model: the first one's worker never appears, so the first launch is on
  // the late list while the second launch reads its own worker's sessions file and a poll comes.
  describe('a launch on the late list and a later launch of the same dir, config dir and model', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const hosts = [
      { name: 'Linux', options: { ...OPTIONS, debug: true }, env: { HOME }, dir: ORCH_DIR, launch: args, configDir: '/fixture/lic/a', trace: `${LAUNCH_RUNS}/trace.log`, knobs: LINUX_FIXTURE },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '', debug: true },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        configDir: 'C:/fixture/home/.claude',
        trace: `C:${LAUNCH_RUNS}/trace.log`,
        knobs: WINDOWS,
      },
    ] as const
    const resultOf = (answer: string) => /Result: (\S+\.json)/.exec(answer)?.[1]

    for (const host of hosts) {
      test(`${host.name}: the later launch's worker is registered once, for the later launch; the first launch never claims it and is dropped after its 10 minutes`, { options: host.options }, async ($, on) => {
        REGISTRY_READS.isCurrent = true
        host.knobs.isWorkerHidden = true
        let release = () => {}
        try {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          await boot($, host.dir)
          const firstAt = w.clock.now()
          const first = String((await launchTool($, host.launch)).result)
          expect(first).toStartWith('Started in the background, but no claude process for it appeared within 30 s: it is not registered yet.')
          await w.clock.advance(5000)
          await w.clock.advance(5000)
          // The first launch's worker never ran. The second launch's worker runs; its launch is held at its sessions file
          // while a poll comes.
          w.spawned = false
          host.knobs.isWorkerHidden = false
          let isHeld = false
          HELD.sessions = new Promise(resolve => {
            release = () => resolve(undefined)
          })
          HELD.heldSessions = () => {
            isHeld = true
          }
          const pending = launchTool($, host.launch)
          for (let step = 0; step < 100 && !isHeld; step++) await w.clock.settle()
          expect(isHeld).toBe(true)
          const polled = w.clock.advance(5000)
          await w.clock.settle()
          release()
          HELD.sessions = undefined
          await polled
          const second = String((await pending).result)
          expect(second).toStartWith(`Launched pid 7001, session ${SID_NEW}, config_dir ${host.configDir}, registered.`)
          const [firstResult, secondResult] = [resultOf(first), resultOf(second)]
          expect(firstResult === undefined || secondResult === undefined || firstResult === secondResult).toBe(false)
          const mine = () => lastRegistry(w).filter(one => one.session_id === SID_NEW || one.pid === 7001)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001, session_id: SID_NEW, result_file: secondResult })] as never)
          expect(lastRegistry(w).some(one => one.result_file === firstResult)).toBe(false)
          expect(traceOf(w, host.trace).filter(line => line.event === 'worker.registered' && line.isLate === true)).toEqual([])
          // The first launch stays looked for until 10 minutes after it, then is dropped; nothing more is registered.
          const dropped = () => traceOf(w, host.trace).filter(line => line.event === 'worker.missing' && line.isLookedFor === false).length
          while (w.clock.now() < firstAt + 595_000) await w.clock.advance(5000)
          expect(dropped()).toBe(0)
          for (let step = 0; step < 3; step++) await w.clock.advance(5000)
          expect(dropped()).toBe(1)
          expect(mine()).toEqual([expect.objectContaining({ pid: 7001, session_id: SID_NEW, result_file: secondResult })] as never)
          expect(lastRegistry(w).some(one => one.result_file === firstResult)).toBe(false)
        } finally {
          release()
          HELD.sessions = undefined
          HELD.heldSessions = undefined
          REGISTRY_READS.isCurrent = false
          host.knobs.isWorkerHidden = false
        }
      })
    }
  })

  describe('a worker that ends before its sessions file is read', () => {
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    /** The result file of a run that finished: the engine's `--output-format json` line with the session id. */
    const FINISHED = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', duration_ms: 1300, num_turns: 1, total_cost_usd: 0.0025, session_id: SID_NEW })
    const NOTE = 'session-control completions: new: clean: PONG; new: report check: report lacks git status -sb and git log --oneline @{u}..HEAD with their exit codes'
    const TOAST = 'Session finished \u00B7 new: clean: PONG'
    const RUNS_DIR = `${HOME}/.claude/session-control/runs`
    const hosts = [
      {
        name: 'Linux',
        options: OPTIONS,
        env: { HOME },
        dir: ORCH_DIR,
        launch: args,
        cwd: '/work/new',
        configDir: '/fixture/lic/a',
        sessions: '/fixture/lic/a/sessions/7001.json',
        sessionsShown: '/fixture/lic/a/sessions/7001.json',
        runs: RUNS_DIR,
        socket: '/run/user/1000/cc-socks/7001.sock',
        knobs: LINUX_FIXTURE,
      },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        cwd: 'C:/work/new',
        configDir: 'C:/fixture/home/.claude',
        sessions: '/fixture/home/.claude/sessions/7001.json',
        sessionsShown: 'C:/fixture/home/.claude/sessions/7001.json',
        runs: `C:${RUNS_DIR}`,
        socket: undefined,
        knobs: WINDOWS,
      },
    ] as const
    const userPrompt = async ($: { prompt: { submit: (e: never) => Promise<{ context?: readonly unknown[] }> } }) => (await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)).context ?? []
    const reset = (host: (typeof hosts)[number]) => {
      MISSING.clear()
      WORKER.resultText = undefined
      host.knobs.isWorkerHidden = false
    }

    for (const host of hosts) {
      const result = `${host.runs}/20260921141320-new.json`
      const err = `${host.runs}/20260921141320-new.err`
      /** The entry the launch writes for a worker registered from its result file, ended at `endedSec`. */
      const finishedEntry = (endedSec: number) => ({
        title: 'new',
        session_id: SID_NEW,
        name: 'w-new-260921141320',
        config_dir: host.configDir,
        cwd: host.cwd,
        model: 'opus',
        effort: 'high',
        result_file: result,
        err_file: err,
        started_at: NOW_MS / 1000,
        reported: false,
        outcome: { kind: 'clean', summary: 'clean: PONG', costUsd: 0.0025 },
        ended_at: endedSec,
      })

      test(`${host.name}: its result file holds the session id: registered at once as a finished entry, harvested once, one completion note, sound and audited as any finished worker`, { options: host.options }, async ($, on) => {
        const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
        echoPrompt(on)
        await boot($, host.dir)
        // The start's harvest (the limited worker) rides on a first prompt.
        await userPrompt($ as never)
        MISSING.add(host.sessions)
        WORKER.resultText = FINISHED
        try {
          const out = await launchTool($, host.launch)
          const endedSec = Math.floor(w.clock.now() / 1000)
          expect(String(out.result)).toBe(
            `Worker pid 7001 started and ended before its sessions file could be read: session ${SID_NEW} (from its result file), config_dir ${host.configDir}, registered as finished, outcome clean. ` +
              `Name: w-new-260921141320; socket: none. Result: ${result}; errors: ${err}.`,
          )
          // The process has gone: later probes do not show it.
          host.knobs.isWorkerHidden = true
          const entries = lastRegistry(w).filter(one => one.session_id === SID_NEW)
          expect(entries).toEqual([finishedEntry(endedSec)])
          expect(w.toasts.filter(one => one === TOAST).length).toBe(1)
          // The next polls neither register it again nor harvest it again.
          await w.clock.advance(5000)
          await w.clock.advance(5000)
          expect(lastRegistry(w).filter(one => one.session_id === SID_NEW)).toEqual([finishedEntry(endedSec)])
          expect(w.toasts.filter(one => one === TOAST).length).toBe(1)
          // One completion note, on the next prompt, and on none after it.
          const completions = (context: readonly unknown[]) => context.filter(line => String(line).startsWith('session-control completions: '))
          expect(completions(await userPrompt($ as never))).toEqual([NOTE])
          expect(completions(await userPrompt($ as never))).toEqual([])
          // The registry is sound; the entry is a finished one not yet reported, and the audit finds of it only what it
          // finds of any finished worker not acknowledged (its run files named by the entry, so no loose file).
          const text = w.writes.filter(one => fixture(one.path) === REGISTRY_PATH).at(-1)?.text
          expect(isRegistrySound(text)).toBe(true)
          const parsed = parseRegistry(text ?? '')
          const entry = (parsed.ok ? parsed.entries : []).find(one => one.session_id === SID_NEW)
          expect(entry === undefined ? undefined : rowStatus(entry, parseProcFacts(''))).toBe('unreported')
          const runFile = (name: string) => ({ name, kind: 'file' as const, size: 10, mtimeMs: NOW_MS })
          const findings = auditFindings({ entries: entry === undefined ? [] : [entry], facts: parseProcFacts(''), nowMs: w.clock.now(), runs: [runFile('20260921141320-new.json'), runFile('20260921141320-new.err')] })
          expect(findings.map(one => [one.kind, one.subject])).toEqual([['unacknowledged', 'session abcdabcd "new"']])
        } finally {
          reset(host)
        }
      })

      for (const [what, text] of [
        ['no result file', undefined],
        ['a result file without a session id', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG' })],
        ['a result file that is not JSON', '{"type":"result","is_error":false,"sess'],
      ] as const) {
        test(`${host.name}: ${what}: not registered, the answer names both files and what the poll does; the poll registers it once a file holds the session id`, { options: host.options }, async ($, on) => {
          const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
          await boot($, host.dir)
          MISSING.add(host.sessions)
          WORKER.resultText = text
          try {
            const out = await launchTool($, host.launch)
            expect(String(out.result)).toBe(
              'Worker pid 7001 started but its session id could not be read; registry NOT written. ' +
                `Neither its sessions file (${host.sessionsShown}) nor its result file (${result}) holds a session id yet. ` +
                "The mod's poll reads them again and registers the worker as soon as one of them holds it (up to 10 min after the launch): " +
                `from the sessions file while it runs, from the result file once it has ended. Until then it is not registered: while it runs it is an orphan row in list_sessions (cwd ${host.cwd}). ` +
                `Errors: ${err}.`,
            )
            expect(lastRegistry(w).some(one => one.cwd === host.cwd)).toBe(false)
            // A poll while neither file holds it registers nothing.
            await w.clock.advance(5000)
            expect(lastRegistry(w).some(one => one.cwd === host.cwd)).toBe(false)
            if (text === undefined) {
              // The sessions file shows while the worker runs: registered with its pid, as the launch registers a worker.
              MISSING.clear()
              await w.clock.advance(5000)
              expect(lastRegistry(w).filter(one => one.cwd === host.cwd)).toEqual([
                expect.objectContaining({ pid: 7001, session_id: SID_NEW, name: 'w-new-260921141320', ...(host.socket === undefined ? {} : { socket_path: host.socket }), result_file: result }),
              ] as never)
            } else {
              // The worker ends and its result file holds the session id: registered as a finished entry, harvested once.
              host.knobs.isWorkerHidden = true
              WORKER.resultText = FINISHED
              const polledSec = Math.floor(w.clock.now() / 1000)
              await w.clock.advance(5000)
              const entries = lastRegistry(w).filter(one => one.cwd === host.cwd)
              // Ended when the poll registered it, within the 5 s the clock moved.
              const endedSec = Number(entries[0]?.ended_at)
              expect(endedSec >= polledSec && endedSec <= Math.floor(w.clock.now() / 1000)).toBe(true)
              expect(entries).toEqual([finishedEntry(endedSec)])
              await w.clock.advance(5000)
              expect(lastRegistry(w).filter(one => one.cwd === host.cwd)).toEqual(entries)
              expect(w.toasts.filter(one => one === TOAST).length).toBe(1)
            }
          } finally {
            reset(host)
          }
        })
      }
    }
  })

  test('a missing registry is registered into as an empty one', { options: OPTIONS }, async ($, on) => {
    MISSING.add(REGISTRY_PATH)
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('registered')
      expect(lastRegistry(w)).toEqual([expect.objectContaining({ pid: 7001, cwd: '/work/new' })] as never)
    } finally {
      MISSING.clear()
    }
  })

  test('a registry that is there but cannot be read is never overwritten', { options: OPTIONS }, async ($, on) => {
    UNREADABLE.add(REGISTRY_PATH)
    try {
      const w = world(on)
      await boot($)
      // The fixture's `test -e` answers every file as missing, so activation's own helper-file creation is not counted.
      const before = w.writes.length
      const out = await launchTool($, args)
      expect(String(out.result)).toContain('registry write FAILED: the registry cannot be read')
      expect(w.writes.slice(before).some(one => one.path.startsWith(REGISTRY_PATH))).toBe(false)
    } finally {
      UNREADABLE.clear()
    }
  })

  for (const [name, pick, input, denied] of <[string, string | undefined, object, string][]>[
    ['refuses the orchestrator dir as cwd', undefined, { ...args, dir: ORCH_DIR }, 'orchestrator dir'],
    ['refuses an empty licence pick', '', args, 'no licence has room'],
    ['refuses a resume of a live session', undefined, { ...args, resume_sid: SID_ALIVE }, 'pid 4101'],
  ]) {
    test(name, { options: OPTIONS }, async ($, on) => {
      world(on, pick)
      await boot($)
      const ran = await launchTool($, input)
      expect(String(ran.deny)).toContain(denied)
    })
  }

  test('the report check sends a faulty report back once, and passes a clean one', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.Stop', () => ({}))
    await boot($)
    const stop = (answer: string, again = false) =>
      ({ hook_event_name: 'Stop', stop_hook_active: again, last_assistant_message: answer, session_id: 's', transcript_path: '/t', cwd: ORCH_DIR }) as never
    const bad = await $.classic.Stop(stop('It is not a bug, but a feature.'))
    expect(bad.block).toContain('Report check failed')
    expect((await $.classic.Stop(stop('It is not a bug, but a feature.', true))).block).toBeUndefined()
    expect((await $.classic.Stop(stop('The worker finished: 3 files changed.'))).block).toBeUndefined()
  })

  test('launch_worker refuses a prompt without the checklist items', { options: OPTIONS }, async ($, on) => {
    world(on)
    await boot($)
    const out = await launchTool($, { ...args, prompt_file: '/work/new/thin.md' })
    expect(JSON.stringify(out)).toContain('the prompt lacks')
  })

  // A task notification's prompt runs the harvest it ran before decision mod-28's prompt fix, bounded: it waits at most
  // PROMPT_HARVEST_SEC (a pause in a process: `sleep` on Linux, the helper's pause on Windows) for that harvest.
  describe('a task notification\'s prompt and the harvest it starts', () => {
    const ALIVE_RESULT = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_ALIVE ? { ...one, result_file: '/fixture/results/alive.json' } : one)))
    const NOTE = 'session-control completions: alive worker: killed: background task killed'
    const KILLED_TOAST = 'Session killed \u00B7 alive worker: killed: background task killed'
    const WIN_ENV = { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' }
    const hosts = [
      { name: 'Linux', options: { ...OPTIONS, debug: true }, dir: ORCH_DIR, env: { HOME }, knobs: LINUX_FIXTURE },
      { name: 'Windows', options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' }, dir: `C:${ORCH_DIR}`, env: WIN_ENV, knobs: WINDOWS },
    ] as const
    /** A prompt submitted and not awaited: whether it has returned yet, and its answer. */
    const submitted = ($: { prompt: { submit: (e: never) => Promise<{ context?: readonly unknown[] }> } }, text: string, kind: string) => {
      const state: { isDone: boolean; sent: Promise<{ context?: readonly unknown[] }> } = { isDone: false, sent: Promise.resolve({}) }
      state.sent = $.prompt.submit({ text, wait: false, origin: { kind } } as never).then(sent => {
        state.isDone = true
        return sent
      })
      return state
    }

    for (const host of hosts) {
      test(`${host.name}: a slow harvest holds the task notification's prompt for its 3 s bound and no longer; the prompt goes on without the note, which rides on the next prompt`, { options: host.options }, async ($, on) => {
        const w = world(on, '/fixture/lic/a\n', true, ALIVE_RESULT, host.env)
        echoPrompt(on)
        await boot($, host.dir)
        await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } } as never)
        host.knobs.isAliveGone = true
        // The harvest's probe answers only 8 s on.
        host.knobs.probeLateMs = 8000
        try {
          const at = w.clock.now()
          const prompt = submitted($ as never, TASK_NOTIFICATION_KILLED, 'task-notification')
          await w.clock.advance(PROMPT_HARVEST_SEC * 1000 - 1)
          expect(prompt.isDone).toBe(false)
          await w.clock.advance(1)
          // Back at the bound, 3000 ms on the clock, without the note: the harvest has not ended.
          expect(prompt.isDone).toBe(true)
          expect(w.clock.now() - at).toBe(PROMPT_HARVEST_SEC * 1000)
          expect(withoutFinishedOpen((await prompt.sent).context)).toBeUndefined()
          expect(w.toasts).not.toContain(KILLED_TOAST)
          if (host.name === 'Linux') expect(traceOf(w).filter(line => line.event === 'prompt.harvest').map(line => [line.isInTime, line.ms])).toEqual([[false, PROMPT_HARVEST_SEC * 1000]])
          // The harvest goes on behind the prompt and ends with its probe; its note rides on the next prompt of any origin.
          host.knobs.probeLateMs = 0
          await w.clock.advance(5000)
          expect(w.toasts).toContain(KILLED_TOAST)
          expect((await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)).context?.[0]).toBe(NOTE)
        } finally {
          host.knobs.isAliveGone = false
          host.knobs.probeLateMs = 0
        }
      })
    }

    test('a prompt of any other origin starts no harvest and waits for nothing: no probe, no bound', { options: OPTIONS }, async ($, on) => {
      const w = world(on, '/fixture/lic/a\n', true, ALIVE_RESULT)
      echoPrompt(on)
      await boot($)
      LINUX_FIXTURE.isAliveGone = true
      try {
        const [calls, runs] = [w.calls.length, w.runs.length]
        for (const kind of ['user', 'composer', 'peer']) await $.prompt.submit({ text: 'hello', wait: false, origin: { kind } } as never)
        expect(w.calls.slice(calls).filter(one => one.op === 'probe')).toEqual([])
        expect(w.runs.slice(runs).filter(argv => argv[0] === 'sleep')).toEqual([])
        expect(w.toasts).not.toContain(KILLED_TOAST)
      } finally {
        LINUX_FIXTURE.isAliveGone = false
      }
    })
  })

  // The registry read back as written (REGISTRY_READS): the worker launched here runs as pid 7001 and its launch's
  // background task is `fixture` (the fixture's Bash answer); the alive worker 4101 is given a result file per test.
  describe('a task notification\'s status and the worker it names', () => {
    const notification = (taskId: string) =>
      `<task-notification>\n<task-id>${taskId}</task-id>\n<output-file>/tmp/tasks/${taskId}.output</output-file>\n<status>killed</status>\n<summary>Background command was killed</summary>\n</task-notification>`
    const SID_NEW = 'abcdabcd-0000-4000-8000-000000000001'
    const aliveWith = (resultFile: string) => JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_ALIVE ? { ...one, result_file: resultFile } : one)))
    const ALIVE_UNWRITTEN = aliveWith('/fixture/results/alive.json')
    const hosts = [
      { name: 'Linux', options: OPTIONS, env: { HOME }, dir: ORCH_DIR, launch: args, knobs: LINUX_FIXTURE },
      {
        name: 'Windows',
        options: { ...OPTIONS, orchestratorDir: `C:${ORCH_DIR}`, licencePickCommand: '' },
        env: { OS: 'Windows_NT', USERPROFILE: 'C:\\fixture\\home' },
        dir: `C:${ORCH_DIR}`,
        launch: { ...args, dir: '/c/work/new', prompt_file: '/c/work/new/prompt.md' },
        knobs: WINDOWS,
      },
    ] as const
    const outcomeOf = (w: World, sid: string) => (lastRegistry(w).find(one => one.session_id === sid)?.outcome as { kind?: string; summary?: string } | undefined)?.summary
    const reset = (host: (typeof hosts)[number]) => {
      REGISTRY_READS.isCurrent = false
      WORKER.resultText = undefined
      host.knobs.isProbeBroken = false
      host.knobs.isWorkerHidden = false
      host.knobs.isAliveGone = false
    }

    for (const host of hosts) {
      test(`${host.name}: a notification that names a launch of this load: its status goes to that worker alone`, { options: host.options }, async ($, on) => {
        REGISTRY_READS.isCurrent = true
        try {
          // The alive worker has no result written either: only the status tells the two apart.
          const w = world(on, '/fixture/lic/a\n', true, ALIVE_UNWRITTEN, host.env)
          echoPrompt(on)
          await boot($, host.dir)
          expect(String((await launchTool($, host.launch)).result)).toStartWith('Launched pid 7001')
          await w.clock.advance(5000)
          // Both workers end; the notification names the launch's task: killed, with no result written.
          host.knobs.isAliveGone = true
          host.knobs.isWorkerHidden = true
          await $.prompt.submit({ text: notification('fixture'), wait: false, origin: { kind: 'task-notification' } })
          expect(outcomeOf(w, SID_NEW)).toBe('killed: background task killed')
          expect(outcomeOf(w, SID_ALIVE)).toBe('killed: no result written')
          expect(w.toasts).toContain('Session killed \u00B7 new: killed: background task killed')
        } finally {
          reset(host)
        }
      })

      for (const [what, resultText, summary] of [
        ['a success', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PONG', session_id: SID_NEW }), 'clean: PONG'],
        ['an error', JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Stopped at the turn limit', session_id: SID_NEW }), 'error: Stopped at the turn limit'],
      ] as const) {
        test(`${host.name}: a killed notification for a launch whose result file holds a finished run, ${what}: the run's outcome`, { options: host.options }, async ($, on) => {
          REGISTRY_READS.isCurrent = true
          try {
            const w = world(on, '/fixture/lic/a\n', true, REGISTRY_TEXT, host.env)
            echoPrompt(on)
            await boot($, host.dir)
            expect(String((await launchTool($, host.launch)).result)).toStartWith('Launched pid 7001')
            await w.clock.advance(5000)
            WORKER.resultText = resultText
            host.knobs.isWorkerHidden = true
            await $.prompt.submit({ text: notification('fixture'), wait: false, origin: { kind: 'task-notification' } })
            expect(outcomeOf(w, SID_NEW)).toBe(summary)
          } finally {
            reset(host)
          }
        })
      }
    }
  })

  test('the first prompt after a compaction carries the state digest, once', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.PostCompact', () => ({}))
    echoPrompt(on)
    await boot($)
    const stop = { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 's', session_id: 's', transcript_path: '/t', cwd: ORCH_DIR }
    await $.classic.PostCompact(stop as never)
    const first = await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'user' } } as never)
    expect(JSON.stringify(first.context)).toContain('after compaction')
    expect(JSON.stringify(first.context)).toContain('1. First question')
    const second = await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'user' } } as never)
    expect(withoutFinishedOpen(second.context)).toBeUndefined()
  })

  test('the ledger opens on a model send to a peer and closes on its reply', { options: OPTIONS }, async ($, on) => {
    world(on)
    on('classic.PostCompact', () => ({}))
    echoPrompt(on)
    on('session.send', () => ({ isDelivered: true }) as never)
    on('session.receive', (_$, e) => ({ text: e.text }))
    await boot($)
    await $.session.send({ to: 'obsidian-manager', text: 'Update the note', origin: { kind: 'model' } } as never)
    await $.classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 's', session_id: 's', transcript_path: '/t', cwd: ORCH_DIR } as never)
    const open = await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'user' } } as never)
    expect(JSON.stringify(open.context)).toContain('have not acknowledged their task: obsidian-manager')
    await $.session.receive({ text: 'obsidian-manager: done', origin: { kind: 'peer' } } as never)
    await $.classic.PostCompact({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 's', session_id: 's', transcript_path: '/t', cwd: ORCH_DIR } as never)
    const closed = await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'user' } } as never)
    expect(JSON.stringify(closed.context)).not.toContain('not acknowledged')
  })

  test('clicking an open point shows its description; clicking the title hides it; the description is not clickable', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = await mountPane($)
    const all = async () => String(((await ui.findAll({}))[0] as { text?: string }).text)
    expect(await all()).not.toContain('Detail one')
    await ui.press({ key: 'p:a:0' })
    expect(await all()).toContain('\u25B8 1. First question')
    expect(await all()).toContain('Detail one')
    expect(await all()).toContain('Recommendation: Do A')
    expect(await all()).not.toContain('Detail two')
    await expect(ui.press({ key: 'p:a:d:0' })).rejects.toThrow()
    expect(await all()).toContain('Detail one')
    await ui.press({ key: 'p:a:t:0' })
    expect(await all()).not.toContain('Detail one')
    await ui.press({ key: 'p:a:0' })
    await ui.press({ key: 'p:a:t:0' })
    expect(await all()).not.toContain('Detail one')
  })

  test('queued work is a bullet list under its group, once the group is pressed', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = await mountPane($)
    expect(await ui.find({ type: 'Text', text: /\u2022 Queued one/ })).toBeUndefined()
    await ui.press({ key: 'q:General:0' })
    expect(await ui.find({ type: 'Text', text: /^ {4}\u2022 Queued one$/ })).toBeDefined()
  })

  describe('retire_workers with reviewed', () => {
    const stuck = (n: number, kind: string, extra: object = {}) => ({ title: `stuck ${kind}`, session_id: `5757575${n}-0000-4000-8000-00000000000${n}`, config_dir: '/fixture/lic/a', reported: true, outcome: { kind, summary: `${kind}: old label` }, ...extra })
    const login = stuck(1, 'login')
    const limit = stuck(2, 'limit')
    const killed = stuck(3, 'killed')
    const kept = stuck(4, 'login', { keep: true })
    // The first eight characters of a queued task's title name this session.
    const queued = { ...stuck(5, 'limit'), session_id: 'Queued o-0000-4000-8000-000000000005' }
    const setup = async (on: Parameters<typeof world>[0], $: Parameters<Parameters<typeof test>[2]>[0]) => {
      const w = world(on, '/fixture/lic/a\n', true, JSON.stringify([...JSON.parse(REGISTRY_TEXT), login, limit, killed, kept, queued]))
      await boot($)
      return w
    }
    const retire = async ($: Parameters<Parameters<typeof test>[2]>[0], input: object) =>
      String((await $.tool.call({ tool: 'mcp__session-control__retire_workers', ...input } as never)).result)
    const clears = (w: World) => w.writes.filter(one => one.path.endsWith('/cleared.jsonl'))

    test('login, limit and killed outcomes are retired on a reason; the log and the answer carry the original outcome and the reason', { options: OPTIONS }, async ($, on) => {
      const w = await setup(on, $)
      const out = await retire($, {
        session_ids: [login.session_id.slice(0, 8), limit.session_id, killed.session_id.slice(0, 8)],
        reviewed: { [login.session_id.slice(0, 8)]: 'run succeeded, label from the old classifier', [limit.session_id]: 'work done, limit text was quoted', [killed.session_id.slice(0, 8)]: 'abandoned on purpose' },
      })
      expect(out).toBe('Retired: 57575751, 57575752, 57575753. Retired with review: 57575751 (was login: run succeeded, label from the old classifier); 57575752 (was limit: work done, limit text was quoted); 57575753 (was killed: abandoned on purpose).')
      expect(clears(w).length).toBe(1)
      const lines = clears(w)[0]?.text.trimEnd().split('\n').map(line => JSON.parse(line)) ?? []
      expect(lines.map(one => [one.session_id, one.outcome.kind, one.reviewed_outcome, one.reviewed_reason])).toEqual([
        [login.session_id, 'login', 'login', 'run succeeded, label from the old classifier'],
        [limit.session_id, 'limit', 'limit', 'work done, limit text was quoted'],
        [killed.session_id, 'killed', 'killed', 'abandoned on purpose'],
      ])
      // The entry is logged as it was, with the two fields appended last.
      expect(Object.keys(lines[0]).slice(-2)).toEqual(['reviewed_outcome', 'reviewed_reason'])
      expect(Object.keys(lines[0]).slice(0, -2)).toEqual(Object.keys(login))
      const left = lastRegistry(w).map(one => one.session_id)
      for (const gone of [login, limit, killed]) expect(left).not.toContain(gone.session_id)
      expect(left).toContain(kept.session_id)
    })
  })

  test('open_point and record_decision edit the helper files, back them up first, and report a refusal', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const added = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'add', id: 'fresh', title: 'T', detail: 'D', recommendation: 'R' } as never)
    expect(String(added.result)).toContain('open-points.json: added fresh.')
    const backup = w.writes.find(one => one.path.includes('/backups/open-points-before-open-point-'))
    expect(backup?.text).toBe(OPEN_POINTS_TEXT)
    const written = w.writes.find(one => one.path === `${ORCH_DIR}/open-points.json`)
    expect(JSON.parse(written?.text ?? '{}').points.some((p: { id: string }) => p.id === 'fresh')).toBe(true)
    const refused = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'close', id: 'nope', resolution: 'x' } as never)
    expect(JSON.stringify(refused)).toContain('no open point nope')
  })

  test('open_point list and queue_task list read the helper files without a write, a backup or a refresh, and the panel shows the same points and tasks', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    stubPanel(on)
    await boot($)
    const before = w.writes.length
    const all = (await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list' } as never)) as { result?: string }
    expect(all.result?.split('\n')[0]).toBe('open-points.json: 3 points (open and held)')
    expect([...String(all.result).matchAll(/^open point (\S+)$/gm)].map(one => one[1])).toEqual(['a', 'c', 'd'])
    expect(all.result).toContain('  held: yes\n  title: Held')
    const open = (await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list', status: 'open' } as never)) as { result?: string }
    const bad = await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list', status: 'archived' } as never)
    expect(JSON.stringify(bad)).toContain('unknown status archived')
    const queue = (await $.tool.call({ tool: 'mcp__session-control__queue_task', action: 'list' } as never)) as { result?: string }
    expect(queue.result).toBe('task-queue.json: 2 tasks\n\ntask q1\n  title: Queued one\n  status: queued\n\ntask q2\n  title: Finished\n  status: done')
    // Nothing was written: no helper file, no backup, no archive.
    expect(w.writes.length).toBe(before)
    // The panel's open points and queued work are what the same readers give.
    const snapshot = String(((await $.tool.call({ tool: 'mcp__session-control__panel_snapshot' } as never)) as { result?: string }).result)
    const titles = (text: string) => [...text.matchAll(/^ {2}title: (.*)$/gm)].map(one => one[1])
    const panel = snapshot.slice(snapshot.indexOf('OPEN POINTS')).split('\n').filter(line => /^ {2}\d+\. /.test(line)).map(line => line.replace(/^ {2}\d+\. /, ''))
    expect(panel).toEqual(titles(String(open.result)))
    expect(snapshot).toContain('QUEUED WORK (every group collapsed)\n  General (1)\n')
  })

  test('open_point list and queue_task list on missing helper files answer empty and create nothing', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    for (const file of ['open-points.json', 'task-queue.json']) MISSING.add(`${ORCH_DIR}/${file}`)
    try {
      const before = w.writes.length
      const points = (await $.tool.call({ tool: 'mcp__session-control__open_point', action: 'list' } as never)) as { result?: string }
      expect(points.result).toBe('open-points.json: 0 points (open and held)')
      const queue = (await $.tool.call({ tool: 'mcp__session-control__queue_task', action: 'list' } as never)) as { result?: string }
      expect(queue.result).toBe('task-queue.json: 0 tasks')
      expect(w.writes.length).toBe(before)
    } finally {
      MISSING.clear()
    }
  })

  test('seated inline the panel is one box behind tabs, at most 11 rows, and a tab switches the box', { options: OPTIONS }, async ($, on) => {
    world(on)
    stubPanel(on)
    await boot($)
    await runCommand($, 'side')
    const ui = await $.ui.mount({
      plugin: 'session-control',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'session-control',
      props: { ...PANE_PROPS, placement: 'inline', scroll: { offset: 0, bodyRows: 40 } } as never,
    })
    const all = async () => String(((await ui.findAll({}))[0] as { text?: string }).text)
    expect(await all()).toContain('[ Sessions 7 ]')
    expect(await all()).toContain('Queued 1')
    expect(await all()).toContain('Open points 2')
    expect(await all()).toContain('alive worker')
    expect(await all()).not.toContain('QUEUED WORK')
    await ui.press({ key: 'tab:points' })
    expect(await all()).toContain('1. First question')
    expect(await all()).not.toContain('alive worker')
    await ui.press({ key: 'tab:queue' })
    expect(await all()).toContain('General (1)')
    expect(await all()).not.toContain('Queued one')
    await ui.press({ key: 'q:General:0' })
    expect(await all()).toContain('\u25B8 General (1)')
    expect(await all()).toContain('    \u2022 Queued one')
    // A session log opens in the same box; the Sessions tab closes it.
    await ui.press({ key: 'tab:sessions' })
    await ui.press({ key: 's:aaaaaaaa-1111-4111-8111-111111111111' })
    expect(await all()).toContain('Reading the suite files')
    expect(await all()).not.toContain('alive worker')
    await ui.press({ key: 'tab:sessions' })
    expect(await all()).not.toContain('Reading the suite files')
    expect(await all()).toContain('alive worker')
  })
})

describe('launch_worker: inline prompt, decisions section, rules block, resume fill', () => {
  const RUNS = `${HOME}/.claude/session-control/runs`
  // The prompt file is named by the launch's unique session name (a resume adds its launch time).
  const OWN = `${RUNS}/w-new-260921141320.prompt.md`
  const fresh = { dir: '/work/new', model: 'opus', effort: 'high', title: 'new' }
  /** A prompt that carries the three items the launch guard checks. */
  const FULL = 'Goal: tidy the parser. Wait in the foreground. Report git status -sb. No AI attribution in commits.'
  const DECISIONS_TEXT = [
    '# Agreed decisions',
    '',
    'Intro.',
    '',
    '## Parser unit (user, 2026-10-11)',
    'parser-1. Keep the grammar.',
    'parser-2. No new dependency.',
    '',
    '## Standing',
    'push-x. Pushes need no go-ahead.',
    '',
  ].join('\n')
  /** What the mod wrote to its own prompt file, if anything. */
  const ownPrompt = (w: World) => w.writes.filter(one => one.path === OWN).at(-1)?.text

  test('an inline prompt that lacks the items gets the rules block once, and then passes the guard', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, { ...fresh, prompt: 'Reply PONG.' })
    expect(String(out.result)).toEndWith(`Prompt: ${OWN} (written by the mod; rules block appended).`)
    expect(ownPrompt(w)).toBe(`Reply PONG.\n\n${RULES_BLOCK}\n`)
    expect(missingPromptItems(ownPrompt(w) ?? '')).toEqual([])
    // Each item of the block, as CLAUDE.md's worker prompt lists them.
    for (const phrase of ['no AI attribution trailer', 'never mention an agent', 'No human answers during the run', 'never for a sign-off item', 'Never read, print or pass a credential', '`run_in_background: true`', 'explicit `timeout`', 'until <check>; do sleep 30; done', 'under ten minutes', 'Never end the turn while a run', '`git status -sb`', '`git log --oneline @{u}..HEAD`', 'exit code']) {
      expect(RULES_BLOCK).toContain(phrase)
    }
  })

  test('rules false: an inline prompt that lacks the items is refused as a prompt file would be, and nothing is written', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, { ...fresh, prompt: 'Reply PONG.', rules: false })
    expect(String(out.deny)).toContain('the prompt lacks: foreground wait')
    expect(ownPrompt(w)).toBeUndefined()
    expect(w.bash.length).toBe(0)
  })

  test('a skill test gets no rules block, as the guard exempts it', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, { ...fresh, prompt: 'skill test: run the procedure and report.' })
    expect(String(out.result)).toEndWith(`Prompt: ${OWN} (written by the mod).`)
    expect(ownPrompt(w)).toBe('skill test: run the procedure and report.')
  })

  test('section: the section text appended as binding, the entry records it; with a full prompt no rules block', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, { ...fresh, prompt: FULL, section: 'Parser unit (user, 2026-10-11)' })
      expect(String(out.result)).toEndWith(`Prompt: ${OWN} (written by the mod; section "Parser unit (user, 2026-10-11)" appended).`)
      expect(ownPrompt(w)).toBe(`${FULL}\n\n## Binding decisions (section Parser unit (user, 2026-10-11))\n\nparser-1. Keep the grammar.\nparser-2. No new dependency.\n`)
      expect(lastRegistry(w).at(-1)).toMatchObject({ prompt_file: OWN, section: 'Parser unit (user, 2026-10-11)' })
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('section with a prompt file: a copy of the file with the section and, as the file lacks the items, the rules block; the file itself untouched', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, { ...fresh, prompt_file: '/work/new/thin.md', section: 'Parser unit (user, 2026-10-11)' })
      expect(String(out.result)).toEndWith(`(written by the mod; section "Parser unit (user, 2026-10-11)" appended; rules block appended).`)
      expect(ownPrompt(w)).toBe(`Just do the work.\n\n## Binding decisions (section Parser unit (user, 2026-10-11))\n\nparser-1. Keep the grammar.\nparser-2. No new dependency.\n\n${RULES_BLOCK}\n`)
      expect(String(w.bash[0]?.command)).toContain(`"$(cat '${OWN}')"`)
      expect(w.writes.some(one => one.path === '/work/new/thin.md')).toBe(false)
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('a prompt file given alone: the worker starts on a copy of exactly the text the guards read, which the entry records; the file itself untouched', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const out = await launchTool($, { ...fresh, prompt_file: '/work/new/big.md' })
    expect(String(w.bash[0]?.command)).toContain(`"$(cat '${OWN}')"`)
    expect(String(w.bash[0]?.command)).not.toContain('/work/new/big.md')
    // The fixture's text of /work/new/big.md (BIG_PROMPT), as the guards read it.
    expect(ownPrompt(w)).toBe(`Wait in the foreground; report git status -sb; no attribution. ${'x'.repeat(30_000)}`)
    expect(String(out.result)).toContain(` Prompt: ${OWN} (written by the mod; a copy of /work/new/big.md as read).`)
    const entry = lastRegistry(w).at(-1) as Record<string, unknown>
    expect(entry).toMatchObject({ prompt_file: OWN })
    expect('section' in entry).toBe(false)
    expect(w.writes.some(one => one.path === '/work/new/big.md')).toBe(false)
  })

  test('"skill test" in an appended section lifts neither the size cap, the three items nor the rules block: the exemption is judged on the text given', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = ['# Agreed decisions', '', '## Skill unit', 'sk-1. This is a skill test of the parser.', ''].join('\n')
    try {
      const w = world(on)
      await boot($)
      // The text given is at the cap; the section's block takes the composed prompt over it.
      const capped = await launchTool($, { ...fresh, prompt: `${FULL} ${'x'.repeat(60_000 - FULL.length - 1)}`, section: 'Skill unit' })
      expect(String(capped.deny)).toStartWith('session-control: refused: the prompt has ')
      expect(String(capped.deny)).toContain(', the limit is 60000:')
      const ruled = await launchTool($, { ...fresh, prompt: 'Reply PONG.', section: 'Skill unit' })
      expect(String(ruled.result)).toContain('(written by the mod; section "Skill unit" appended; rules block appended).')
      const bare = await launchTool($, { ...fresh, prompt: 'Reply PONG.', section: 'Skill unit', rules: false })
      expect(String(bare.deny)).toContain('the prompt lacks: foreground wait')
      expect(w.bash.length).toBe(1)
      // The words in the text given still exempt it, the section appended or not.
      const skill = await launchTool($, { ...fresh, prompt: `skill test: run the procedure. ${'x'.repeat(60_000)}`, section: 'Skill unit' })
      expect(skill.deny).toBeUndefined()
      expect(w.bash.length).toBe(2)
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('section refusals: a heading the file lacks, a missing decisions file, a prompt file that cannot be read; nothing written or started', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    DECISIONS.text = DECISIONS_TEXT
    try {
      const unknown = await launchTool($, { ...fresh, prompt: FULL, section: 'Parser unit' })
      expect(String(unknown.deny)).toBe('session-control: refused: agreed-decisions.md has no section "Parser unit"; nothing was launched')
      const unread = await launchTool($, { ...fresh, prompt_file: '/work/new/prompt.md', section: 'Parser unit (user, 2026-10-11)' })
      expect(String(unread.deny)).toBe('session-control: refused: the prompt file /work/new/prompt.md cannot be read, so the section cannot be appended; nothing was launched')
    } finally {
      DECISIONS.text = undefined
    }
    const missing = await launchTool($, { ...fresh, prompt: FULL, section: 'Parser unit (user, 2026-10-11)' })
    expect(String(missing.deny)).toBe('session-control: refused: agreed-decisions.md cannot be read; nothing was launched')
    expect(w.writes.some(one => one.path.endsWith('.prompt.md'))).toBe(false)
    expect(w.bash.length).toBe(0)
  })

  test('exactly one of prompt and prompt_file: both, or neither, is refused before anything runs', { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await boot($)
    const runs = w.runs.length
    const both = await launchTool($, { ...fresh, prompt: FULL, prompt_file: '/work/new/prompt.md' })
    expect(String(both.deny)).toBe('session-control: refused: give exactly one of prompt and prompt_file, not both')
    const neither = await launchTool($, fresh)
    expect(String(neither.deny)).toBe('session-control: refused: give exactly one of prompt and prompt_file')
    const blank = await launchTool($, { ...fresh, prompt: '   ' })
    expect(String(blank.deny)).toBe('session-control: refused: prompt is empty')
    expect(w.runs.length).toBe(runs)
  })

  test('a fresh launch without model, effort, title or dir is refused as before', { options: OPTIONS }, async ($, on) => {
    world(on)
    await boot($)
    expect(String((await launchTool($, { dir: '/work/new', prompt: FULL, effort: 'high', title: 't' })).deny)).toBe('session-control: model is required')
    expect(String((await launchTool($, { dir: '/work/new', prompt: FULL, model: 'opus', title: 't' })).deny)).toContain('effort is required')
    expect(String((await launchTool($, { dir: '/work/new', prompt: FULL, model: 'opus', effort: 'high' })).deny)).toBe('session-control: title is required')
    expect(String((await launchTool($, { prompt: FULL, model: 'opus', effort: 'high', title: 't' })).deny)).toBe('session-control: dir must be absolute')
  })

  describe('a resume', () => {
    // Its cwd and model are those of the fixture's new worker process, so the launch finds it.
    const entry = { title: 'parser work', session_id: SID_UNREPORTED, name: 'w-parser-work-260920100000', config_dir: '/fixture/lic/a', cwd: '/work/new', model: 'opus', effort: 'medium', reported: false }
    const registry = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? entry : one)))
    test('takes dir, model, effort and title from its entry, and says so', { options: OPTIONS }, async ($, on) => {
      WORKER.sid = SID_UNREPORTED
      try {
        const w = world(on, '/fixture/lic/a\n', true, registry)
        await boot($)
        const out = await launchTool($, { resume_sid: SID_UNREPORTED, prompt: `${FULL} Continue.` })
        expect(String(out.result)).toEndWith('From the entry: dir, model, effort, title.')
        expect(String(w.bash[0]?.command)).toStartWith(`cd '/work/new' && CLAUDE_CONFIG_DIR='/fixture/lic/a' CLAUDE_CODE_EFFORT_LEVEL='medium' claude -p --model 'opus' --resume '${SID_UNREPORTED}' -n 'w-parser-work-260920100000'`)
        expect(lastRegistry(w).find(one => one.session_id === SID_UNREPORTED)).toMatchObject({ title: 'parser work', cwd: '/work/new', model: 'opus', effort: 'medium', pid: 7001 })
        expect(String(w.bash[0]?.command)).toContain(`"$(cat '${RUNS}/w-parser-work-260920100000-260921141320.prompt.md')"`)
        expect(w.runs.some(argv => argv[0] === '/fixture/bin/pick')).toBe(false)
      } finally {
        WORKER.sid = 'abcdabcd-0000-4000-8000-000000000001'
      }
    })
    test('of an entry without those fields, or of an unknown id, is refused as before', { options: OPTIONS }, async ($, on) => {
      world(on)
      await boot($)
      // The fixture's unreported entry has no cwd, model or effort.
      expect(String((await launchTool($, { resume_sid: SID_UNREPORTED, prompt: FULL })).deny)).toBe('session-control: model is required')
      const unknown = await launchTool($, { resume_sid: '99999999-0000-4000-8000-000000000009', prompt: FULL, dir: '/work/new', model: 'opus', effort: 'high', title: 't' })
      expect(String(unknown.deny)).toBe('session-control: no registry entry for 99999999-0000-4000-8000-000000000009')
    })
  })
})

// The sign-off guard reads the prompt as given (README, Sign-off guard; decision gab-1): the section's block and the
// rules block the mod appends after it are never read, so a decision that quotes a refused phrase refuses no launch;
// the same phrase in the prompt body, under a body line that imitates the section's title, or in a prompt_file given
// alone is refused as before, on a fresh launch and on a resume alike.
describe('launch_worker: the sign-off guard reads the prompt as given, never the blocks the mod appends', () => {
  const RUNS = `${HOME}/.claude/session-control/runs`
  const fresh = { dir: '/work/new', model: 'opus', effort: 'high', title: 'new' }
  const FULL = 'Goal: tidy the parser. Wait in the foreground. Report git status -sb. No AI attribution in commits.'
  const HEADING = 'Guard unit (user, 2026-11-12)'
  // Two phrases of the guard tests (signoff.test.ts, the prompt guard): the force-push words and a command shape.
  const WORDS = 'Rebase on main, then force-push the branch.'
  const SHAPE = 'Then git reset --hard origin/main.'
  const DECISIONS_TEXT = ['# Agreed decisions', '', `## ${HEADING}`, `gu-1. The guard test ${WORDS} stays as it is.`, `gu-2. ${SHAPE}`, ''].join('\n')
  const BLOCK = `## Binding decisions (section ${HEADING})\n\ngu-1. The guard test ${WORDS} stays as it is.\ngu-2. ${SHAPE}`
  /** The prompt file the mod wrote last, if any. */
  const written = (w: World) => w.writes.filter(one => one.path.startsWith(`${RUNS}/`) && one.path.endsWith('.prompt.md')).at(-1)
  const refusedFor = (deny: unknown, line: number) => {
    expect(String(deny)).toStartWith(`session-control: refused by the sign-off guard: the prompt instructs a force-push on line ${line} as a step for the worker;`)
    expect(String(deny)).toEndWith('; nothing was launched')
  }

  test('a section whose decisions hold refused phrases is launched with them in the prompt file; the same phrase in the body is refused', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      // The same phrases in the prompt body: refused, nothing written or started.
      refusedFor((await launchTool($, { ...fresh, prompt: `${FULL}\n${WORDS}`, section: HEADING })).deny, 2)
      expect(String((await launchTool($, { ...fresh, prompt: `${FULL}\n${SHAPE}`, section: HEADING })).deny)).toStartWith('session-control: refused by the sign-off guard: the prompt instructs reset --hard on line 2 as a step for the worker;')
      expect(written(w)).toBeUndefined()
      expect(w.bash.length).toBe(0)
      // In the section's block only: launched, and the worker's prompt file holds the block whole.
      const out = await launchTool($, { ...fresh, prompt: FULL, section: HEADING })
      expect(out.deny).toBeUndefined()
      expect(String(out.result)).toContain('Launched pid 7001')
      expect(String(out.result)).not.toContain('WARNING')
      expect(written(w)?.text).toBe(`${FULL}\n\n${BLOCK}\n`)
      expect(String(w.bash[0]?.command)).toContain(`"$(cat '${written(w)?.path}')"`)
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('a body that imitates the section block\'s title line is read whole: a refused phrase under it is refused, with or without a section', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      const imitation = `${FULL}\n\n## Binding decisions (section ${HEADING})\n\n${WORDS}`
      refusedFor((await launchTool($, { ...fresh, prompt: imitation })).deny, 5)
      refusedFor((await launchTool($, { ...fresh, prompt: imitation, section: HEADING })).deny, 5)
      // The imitation followed by a copy of the real block in the body: every line of the body is read, the copy's too.
      expect(String((await launchTool($, { ...fresh, prompt: `${imitation}\n\n${BLOCK}`, section: HEADING })).deny)).toStartWith(
        'session-control: refused by the sign-off guard: the prompt instructs a force-push on line 5, a force-push on line 9, reset --hard on line 10 as a step for the worker;',
      )
      expect(written(w)).toBeUndefined()
      expect(w.bash.length).toBe(0)
      // The real block, appended by the mod, is not read.
      expect((await launchTool($, { ...fresh, prompt: FULL, section: HEADING })).deny).toBeUndefined()
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('the rules block the mod appends does not trip the guard, alone or after a section with refused phrases', { options: OPTIONS }, async ($, on) => {
    // Read by the guard on its own, the rules block refuses nothing and warns of nothing.
    expect(signoffLint(RULES_BLOCK)).toEqual({ warnings: [] })
    expect(signoffLint(`Reply PONG.\n\n${RULES_BLOCK}\n`)).toEqual({ warnings: [] })
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      const out = await launchTool($, { ...fresh, prompt: 'Reply PONG.', section: HEADING })
      expect(out.deny).toBeUndefined()
      expect(String(out.result)).toContain('(written by the mod; section "Guard unit (user, 2026-11-12)" appended; rules block appended).')
      expect(written(w)?.text).toBe(`Reply PONG.\n\n${BLOCK}\n\n${RULES_BLOCK}\n`)
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('a prompt_file given alone is read as written; extended by a section, only the file\'s own lines are read', { options: OPTIONS }, async ($, on) => {
    DECISIONS.text = DECISIONS_TEXT
    try {
      const w = world(on)
      await boot($)
      // The file holds the force-push words on its line 2: refused, the file launched as it is never.
      refusedFor((await launchTool($, { ...fresh, prompt_file: '/work/new/forced.md' })).deny, 2)
      refusedFor((await launchTool($, { ...fresh, prompt_file: '/work/new/forced.md', section: HEADING })).deny, 2)
      expect(w.bash.length).toBe(0)
      // A file without them, extended by the section with them: launched from the mod's copy, the file untouched.
      const out = await launchTool($, { ...fresh, prompt_file: '/work/new/thin.md', section: HEADING })
      expect(out.deny).toBeUndefined()
      expect(written(w)?.text).toBe(`Just do the work.\n\n${BLOCK}\n\n${RULES_BLOCK}\n`)
      expect(w.writes.some(one => one.path === '/work/new/thin.md')).toBe(false)
    } finally {
      DECISIONS.text = undefined
    }
  })

  test('a resume follows the same path: the section\'s refused phrases pass, the same phrase in the body is refused', { options: OPTIONS }, async ($, on) => {
    const entry = { title: 'parser work', session_id: SID_UNREPORTED, name: 'w-parser-work-260920100000', config_dir: '/fixture/lic/a', cwd: '/work/new', model: 'opus', effort: 'medium', reported: false }
    const registry = JSON.stringify(JSON.parse(REGISTRY_TEXT).map((one: { session_id?: string }) => (one.session_id === SID_UNREPORTED ? entry : one)))
    DECISIONS.text = DECISIONS_TEXT
    WORKER.sid = SID_UNREPORTED
    try {
      const w = world(on, '/fixture/lic/a\n', true, registry)
      await boot($)
      refusedFor((await launchTool($, { resume_sid: SID_UNREPORTED, prompt: `${FULL} Continue.\n${WORDS}`, section: HEADING })).deny, 2)
      expect(w.bash.length).toBe(0)
      const out = await launchTool($, { resume_sid: SID_UNREPORTED, prompt: `${FULL} Continue.`, section: HEADING })
      expect(out.deny).toBeUndefined()
      expect(String(out.result)).toContain('From the entry: dir, model, effort, title.')
      const own = `${RUNS}/w-parser-work-260920100000-260921141320.prompt.md`
      expect(written(w)).toEqual({ path: own, text: `${FULL} Continue.\n\n${BLOCK}\n` })
      expect(String(w.bash[0]?.command)).toContain(`--resume '${SID_UNREPORTED}'`)
      expect(String(w.bash[0]?.command)).toContain(`"$(cat '${own}')"`)
    } finally {
      WORKER.sid = 'abcdabcd-0000-4000-8000-000000000001'
      DECISIONS.text = undefined
    }
  })
})

describe('close_worker', () => {
  const CLOSE = 'mcp__session-control__close_worker'
  const finished = { title: 'finished clean', session_id: 'f1f1f1f1-0000-4000-8000-000000000001', config_dir: '/fixture/lic/a', reported: false, outcome: { kind: 'clean', summary: 'clean: done' } }
  const login = { title: 'stuck login', session_id: '57575751-0000-4000-8000-000000000001', config_dir: '/fixture/lic/a', reported: false, outcome: { kind: 'login', summary: 'login: old label' } }
  const kept = { title: 'kept clean', session_id: 'c3c3c3c3-0000-4000-8000-000000000003', config_dir: '/fixture/lic/a', reported: true, keep: true, outcome: { kind: 'clean', summary: 'clean: ok' } }
  const registry = JSON.stringify([...JSON.parse(REGISTRY_TEXT), finished, login, kept])
  const ids = ['f1f1f1f1', '57575751', 'c3c3c3c3', SID_ALIVE, '12345678']
  const reviewed = { '57575751': 'the transcript shows the run succeeded' }

  // The registry is read back as the mod wrote it (REGISTRY_READS), as on a real machine: the acknowledgement with keep
  // false clears the kept entry's mark, so the retire after it removes that entry too.
  const ACK = 'mcp__session-control__acknowledge_workers'
  const RETIRE = 'mcp__session-control__retire_workers'
  const EXPECTED =
    'Acknowledged: f1f1f1f1, 57575751, c3c3c3c3. Refused: aaaaaaaa (its process is alive); 12345678 (no registry entry). ' +
    'Retired: f1f1f1f1, 57575751, c3c3c3c3. Retired with review: 57575751 (was login: the transcript shows the run succeeded). ' +
    'Refused: aaaaaaaa (its process is alive); 12345678 (no registry entry).'
  // close_worker alone ends on the next call for each session it did not retire (decision mod-51).
  const NEXT =
    ' Next: aaaaaaaa: not acknowledged, its process is alive: wait for its exit (stop_worker when it must end), then close_worker with session_ids ["aaaaaaaa"] again; ' +
    '12345678: no registry entry: list_sessions shows the registry, and a retired session is in cleared.jsonl; nothing to retire.'

  test('keep false is acknowledge_workers then retire_workers: their answers one after the other, their writes; a kept session goes in this one call', { options: OPTIONS }, async ($, on) => {
    REGISTRY_READS.isCurrent = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, registry)
      await boot($)
      const out = await $.tool.call({ tool: CLOSE, session_ids: ids, reviewed } as never)
      expect(String(out.result)).toBe(`${EXPECTED}${NEXT}`)
      const after = lastRegistry(w)
      expect(after.some(one => [finished.session_id, login.session_id, kept.session_id].includes(String(one.session_id)))).toBe(false)
      expect(after.some(one => one.session_id === SID_ALIVE)).toBe(true)
      const cleared = w.writes.filter(one => one.path.endsWith('/cleared.jsonl')).map(one => one.text).join('')
      expect(cleared).toContain('"reviewed_outcome":"login","reviewed_reason":"the transcript shows the run succeeded"')
      expect(cleared).toContain(`"session_id":"${kept.session_id}"`)
    } finally {
      REGISTRY_READS.isCurrent = false
    }
  })

  test('a kept session alone: one close_worker call with keep false retires it', { options: OPTIONS }, async ($, on) => {
    REGISTRY_READS.isCurrent = true
    try {
      const w = world(on, '/fixture/lic/a\n', true, registry)
      await boot($)
      const out = await $.tool.call({ tool: CLOSE, session_ids: ['c3c3c3c3'], keep: false } as never)
      expect(String(out.result)).toBe('Acknowledged: c3c3c3c3. Retired: c3c3c3c3.')
      expect(lastRegistry(w).some(one => one.session_id === kept.session_id)).toBe(false)
    } finally {
      REGISTRY_READS.isCurrent = false
    }
  })

  test('the same two calls made one by one answer the same text', { options: OPTIONS }, async ($, on) => {
    REGISTRY_READS.isCurrent = true
    try {
      world(on, '/fixture/lic/a\n', true, registry)
      await boot($)
      const acked = await $.tool.call({ tool: ACK, session_ids: ids } as never)
      const retired = await $.tool.call({ tool: RETIRE, session_ids: ids, reviewed } as never)
      expect(`${String(acked.result)} ${String(retired.result)}`).toBe(EXPECTED)
    } finally {
      REGISTRY_READS.isCurrent = false
    }
  })

  test('retire_workers refuses a session a queued task names by its session name only, and one while the queue file cannot be read', { options: OPTIONS }, async ($, on) => {
    world(on, '/fixture/lic/a\n', true, JSON.stringify([...JSON.parse(REGISTRY_TEXT), { ...finished, reported: true, name: 'w-finished-clean-261020' }]))
    QUEUE.text = JSON.stringify({ tasks: [{ id: 'q1', status: 'queued', title: 'Follow-up', waits_for: 'w-finished-clean-261020' }] })
    try {
      await boot($)
      const named = await $.tool.call({ tool: RETIRE, session_ids: ['f1f1f1f1'] } as never)
      expect(String(named.result)).toBe('Retired: none. Refused: f1f1f1f1 (a queued or running task names it).')
      QUEUE.text = JSON.stringify({ tasks: [] })
      UNREADABLE.add(`${ORCH_DIR}/task-queue.json`)
      const unreadable = await $.tool.call({ tool: RETIRE, session_ids: ['f1f1f1f1'] } as never)
      expect(String(unreadable.result)).toBe('Retired: none. Refused: f1f1f1f1 (task-queue.json cannot be read, so a task may name it).')
    } finally {
      UNREADABLE.delete(`${ORCH_DIR}/task-queue.json`)
      QUEUE.text = QUEUE_TEXT
    }
  })

  test('keep true only acknowledges and keeps; reviewed is then not used, and said so', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, registry)
    await boot($)
    const out = await $.tool.call({ tool: CLOSE, session_ids: ['f1f1f1f1'], keep: true } as never)
    expect(String(out.result)).toBe('Acknowledged and kept: f1f1f1f1.')
    expect(lastRegistry(w).find(one => one.session_id === finished.session_id)).toMatchObject({ reported: true, keep: true })
    expect(w.writes.some(one => one.path.endsWith('/cleared.jsonl'))).toBe(false)
    const noted = await $.tool.call({ tool: CLOSE, session_ids: ['f1f1f1f1'], keep: true, reviewed: { f1f1f1f1: 'x' } } as never)
    expect(String(noted.result)).toBe('Acknowledged and kept: f1f1f1f1. reviewed was not used: keep true retires nothing.')
  })

  test('the retire refusals stay: an outcome that needs a resume without reviewed; the acknowledgement still happens', { options: OPTIONS }, async ($, on) => {
    world(on, '/fixture/lic/a\n', true, registry)
    await boot($)
    const out = await $.tool.call({ tool: CLOSE, session_ids: ['57575751'] } as never)
    expect(String(out.result)).toBe(
      'Acknowledged: 57575751. Retired: none. Refused: 57575751 (outcome login needs a resume). ' +
        'Next: 57575751: outcome login needs a resume: resume it with launch_worker resume_sid when its work is unfinished; else, after reading its transcript, close_worker with session_ids ["57575751"] and reviewed {"57575751": "<reason>"}.',
    )
  })

  test('a call without a usable session_ids is refused with what it gave and the call to make, for the three tools; nothing is written', { options: OPTIONS }, async ($, on) => {
    const w = world(on, '/fixture/lic/a\n', true, registry)
    await boot($)
    const writes = w.writes.length
    const misspelt = await $.tool.call({ tool: CLOSE, session_id: finished.session_id, keep: false } as never)
    expect(String(misspelt.deny)).toBe(
      'session-control: close_worker needs session_ids, a non-empty list of session ids; the call gave no session_ids (it gave session_id, keep), so nothing was acknowledged or retired. Call close_worker with session_ids ["f1f1f1f1"]',
    )
    const empty = await $.tool.call({ tool: ACK, session_ids: [] } as never)
    expect(String(empty.deny)).toBe('session-control: acknowledge_workers needs session_ids, a non-empty list of session ids; the call gave an empty session_ids, so nothing was acknowledged or retired. Call acknowledge_workers with session_ids ["<session id>"]')
    const text = await $.tool.call({ tool: RETIRE, session_ids: 'f1f1f1f1' } as never)
    expect(String(text.deny)).toBe('session-control: retire_workers needs session_ids, a non-empty list of session ids; the call gave a session_ids that is not a list, so nothing was acknowledged or retired. Call retire_workers with session_ids ["<session id>"]')
    expect(w.writes.length).toBe(writes)
  })
})
