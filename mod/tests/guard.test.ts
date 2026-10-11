// The helper-file edit guard (guard.ts, decision mod-2). First the test that keeps the guard in step with the tools:
// every registered tool runs on the mock world (mock-world.ts) and every file it writes must be in HELPER_FILES or in
// UNGUARDED_FILES with its reason, so a tool that writes a new file fails here until the list says what it is. Then
// the guard itself through the plugin: what it refuses and what it lets through, in the orchestrator's session and
// nowhere else; and the Windows and PowerShell cases of its pure parts.

import { describe, expect, test } from 'claude-code/testing'

import { HELPER_FILES, UNGUARDED_FILES, commandVerdict, cutHeredocs, denyText, normalPath, pathVerdict, protectedFiles, substitutionsOf, writeKind } from '../hooks/guard'
import { NOW_MS } from './fixtures'
import { HOME, OPTIONS, ORCH, REGISTRY, RUNS, mockWorld, seedLiveWorker } from './mock-world'
import type { World } from './mock-world'

const SID_LIVE = '10000000-aaaa-4bbb-8ccc-000000000001'
const SID_ACK = '20000000-aaaa-4bbb-8ccc-000000000002'
const SID_RETIRE = '30000000-aaaa-4bbb-8ccc-000000000003'
const SID_CLOSE = '40000000-aaaa-4bbb-8ccc-000000000004'
const PLACES = { orchestratorDir: ORCH, registryPath: REGISTRY, runsDir: RUNS }
const CLEAN = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done. git status -sb exit 0', total_cost_usd: 0.1, duration_ms: 2000 })

/** A finished, clean entry with its result file and a transcript in the default config directory. */
function finished(world: World, sid: string, title: string, reported: boolean): Record<string, unknown> {
  world.files.set(`${RUNS}/${title}.json`, CLEAN)
  world.files.set(`${RUNS}/${title}.err`, '')
  const row = { type: 'assistant', timestamp: new Date(NOW_MS - 600_000).toISOString(), message: { content: [{ type: 'text', text: `Report of ${title}. ${'x'.repeat(220)}` }] } }
  world.files.set(`${HOME}/.claude/projects/-w-work/${sid}.jsonl`, `${JSON.stringify(row)}\n`)
  return { title, session_id: sid, config_dir: `${HOME}/.claude`, cwd: '/w/work', model: 'haiku', effort: 'low', result_file: `${RUNS}/${title}.json`, err_file: `${RUNS}/${title}.err`, outcome: { kind: 'clean', summary: 'clean' }, reported, started_at: Math.floor(NOW_MS / 1000) - 900 }
}

/** The orchestrator directory, the registry and the runs directory as a working orchestrator has them. */
function seedOrchestrator(world: World): void {
  world.files.set(`${ORCH}/CLAUDE.md`, '# Role: Session Orchestrator\n')
  world.files.set(`${ORCH}/open-points.json`, `${JSON.stringify({ points: [{ id: 'old', status: 'closed', title: 'Settled long ago', closed: '2026-01-01', resolution: 'done' }] }, null, 2)}\n`)
  world.files.set(`${ORCH}/task-queue.json`, `${JSON.stringify({ tasks: [] }, null, 2)}\n`)
  world.files.set(`${ORCH}/agreed-decisions.md`, '# Agreed decisions\n\n## Free unit\nfree-1. A decision.\n\n## Old unit\nold-1. An old decision.\n')
  world.files.set(`${ORCH}/open-points-archive.md`, '# Open points archive\n')
  const entries = [seedLiveWorker(world, SID_LIVE), finished(world, SID_ACK, 'ack', false), finished(world, SID_RETIRE, 'retire', true), finished(world, SID_CLOSE, 'close', false)]
  world.files.set(REGISTRY, `${JSON.stringify(entries, null, 2)}\n`)
}

/**
 * One call per registered tool, in this order, each made so that it writes what it writes (a launch, a stop, an
 * acknowledgement, a retire, a close, each bookkeeping edit, the archive, the read-only tools). A tool that is not here
 * fails the coverage test: add its call, then the files it writes to HELPER_FILES (or UNGUARDED_FILES, with a reason).
 */
const SCENARIOS: Record<string, Record<string, unknown>> = {
  launch_worker: { dir: '/w/work', model: 'haiku', effort: 'low', title: 'cover launch', prompt: 'Reply PONG.' },
  stop_worker: { session_id: SID_LIVE, reason: 'coverage' },
  acknowledge_workers: { session_ids: [SID_ACK] },
  retire_workers: { session_ids: [SID_RETIRE] },
  close_worker: { session_ids: [SID_CLOSE] },
  open_point: { action: 'add', id: 'p1', title: 'A question for the user.', detail: 'What is blocked.', recommendation: 'Do A.' },
  queue_task: { action: 'add', id: 't1', title: 'A task', status: 'queued' },
  record_decision: { section: 'Free unit', id: 'free-2', text: 'Another decision.' },
  archive_decisions: { sections: ['Old unit'] },
  list_sessions: {},
  read_result: { session_id: SID_ACK },
  worker_tail: { session_id: SID_ACK },
  session_writes: { session_id: SID_ACK },
  panel_snapshot: {},
  audit_state: {},
  // Writes no file: the time of the call goes to $.store, which is no file the guard could protect.
  turn_digest: {},
}

const answerOf = (answer: unknown) => {
  const one = answer as { result?: unknown; deny?: unknown; text?: unknown; isError?: unknown }
  return { text: String(one.deny ?? one.result ?? one.text ?? ''), isRefused: one.deny !== undefined || one.isError === true }
}

describe('the shared list keeps the guard in step with the tools', () => {
  test('the list: each helper file once, with its place and its writers; the registry and cleared.jsonl name the registry tools', () => {
    expect(HELPER_FILES.map(one => `${one.place}:${one.name}`)).toEqual([
      'orchestrator:open-points.json',
      'orchestrator:open-points-archive.md',
      'orchestrator:task-queue.json',
      'orchestrator:agreed-decisions.md',
      'orchestrator:agreed-decisions-archive.md',
      'registry:headless-sessions.json',
      'runs:cleared.jsonl',
    ])
    expect(protectedFiles(PLACES).map(one => one.path)).toEqual([...['open-points.json', 'open-points-archive.md', 'task-queue.json', 'agreed-decisions.md', 'agreed-decisions-archive.md'].map(name => `${ORCH}/${name}`), REGISTRY, `${RUNS}/cleared.jsonl`])
    // Not protected: CLAUDE.md, backups/, reports/, the run files of a launch.
    for (const path of [`${ORCH}/CLAUDE.md`, `${ORCH}/backups/open-points-before-open-point-2026-10-11.json`, `${ORCH}/reports/r.md`, `${RUNS}/x.json`, `${RUNS}/w-x-261011000000.prompt.md`]) expect(writeKind(path, PLACES).kind === 'protected').toBe(false)
    expect(UNGUARDED_FILES.every(one => one.reason.length > 20)).toBe(true)
  })

  for (const isHelper of [false, true]) {
    test(`${isHelper ? 'with the helper' : 'without the helper'}: every registered tool runs, and every file it writes is a protected helper file or listed as unguarded with its reason`, { options: OPTIONS }, async ($, on) => {
      const world = mockWorld(on, { isHelper })
      seedOrchestrator(world)
      await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
      const names = world.tools.map(one => one.name)
      // A tool with no scenario fails here: it may write a file the guard does not know.
      expect(names.filter(name => SCENARIOS[name] === undefined)).toEqual([])
      const byTool = new Map<string, string[]>()
      for (const name of Object.keys(SCENARIOS)) {
        expect(names).toContain(name)
        const from = world.written.length
        const { text, isRefused } = answerOf(await $.tool.call({ tool: `mcp__session-control__${name}`, ...SCENARIOS[name] } as never))
        expect({ name, isRefused, text: isRefused ? text : '' }).toEqual({ name, isRefused: false, text: '' })
        byTool.set(name, world.written.slice(from).map(one => one.path))
      }
      const unlisted = [...byTool].flatMap(([name, paths]) => paths.filter(path => writeKind(path, PLACES).kind === 'unlisted').map(path => `${name} wrote ${path}`))
      expect(unlisted).toEqual([])
      // Each protected file was written by one of its own writers in this run (so the list names the right tools).
      for (const rule of HELPER_FILES) {
        const path = protectedFiles(PLACES)[HELPER_FILES.indexOf(rule)]?.path ?? ''
        expect({ path, isWritten: rule.writers.some(tool => (byTool.get(tool) ?? []).includes(path)) }).toEqual({ path, isWritten: true })
      }
      // The launch's own Bash call went through the guard untouched.
      expect(world.passed.some(one => one.tool === 'Bash' && String(one.input.command).includes('claude -p'))).toBe(true)
    })
  }
})

/** The plugin started in the orchestrator directory on the mock world, and a call of an engine tool through it. */
async function started($: Parameters<Parameters<typeof test>[2]>[0], on: Parameters<Parameters<typeof test>[2]>[1], cwd = ORCH) {
  const world = mockWorld(on)
  seedOrchestrator(world)
  world.files.set('/w/work/notes.md', 'x')
  await $.session.start({ cwd, surface: null, isInteractive: true })
  const call = async (tool: string, input: Record<string, unknown>) => {
    const before = world.passed.length
    const answer = answerOf(await $.tool.call({ tool, ...input } as never))
    return { ...answer, isPassed: world.passed.length > before }
  }
  return { world, call }
}

describe('the helper-file guard in the orchestrator session', () => {
  test('Write, Edit, MultiEdit and NotebookEdit of a helper file are refused with the tool to use instead; CLAUDE.md, backups/, reports/ and the run files are not', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on)
    const refused = [
      ['Write', { file_path: `${ORCH}/open-points.json`, content: '{}' }, 'open_point'],
      ['Edit', { file_path: `${ORCH}/task-queue.json`, old_string: 'a', new_string: 'b' }, 'queue_task'],
      ['MultiEdit', { file_path: `${ORCH}/agreed-decisions.md`, edits: [] }, 'record_decision or archive_decisions'],
      ['NotebookEdit', { notebook_path: `${ORCH}/agreed-decisions-archive.md`, new_source: 'x' }, 'record_decision or archive_decisions'],
      ['Write', { file_path: `${ORCH}/open-points-archive.md`, content: 'x' }, 'open_point'],
      ['Write', { file_path: REGISTRY, content: '[]' }, 'launch_worker, acknowledge_workers, retire_workers or close_worker'],
      ['Edit', { file_path: `${RUNS}/cleared.jsonl`, old_string: 'a', new_string: 'b' }, 'launch_worker, acknowledge_workers, retire_workers or close_worker'],
    ] as const
    for (const [tool, input, useInstead] of refused) {
      const answer = await call(tool, input)
      expect({ tool, isRefused: answer.isRefused, isPassed: answer.isPassed }).toEqual({ tool, isRefused: true, isPassed: false })
      expect(answer.text).toContain(`changes only through the session-control tool ${useInstead}, never by hand`)
    }
    for (const path of [`${ORCH}/CLAUDE.md`, `${ORCH}/backups/open-points-before-x.json`, `${ORCH}/reports/r.md`, `${RUNS}/x.json`, `${RUNS}/w-x-261011000000.prompt.md`, `${RUNS}/trace.log`, '/w/work/notes.md', `${ORCH}/open-points.json.bak`]) {
      const answer = await call('Write', { file_path: path, content: 'x' })
      expect({ path, isRefused: answer.isRefused, isPassed: answer.isPassed }).toEqual({ path, isRefused: false, isPassed: true })
    }
    expect((await call('Edit', { file_path: `${ORCH}/CLAUDE.md`, old_string: 'Role', new_string: 'Role' })).isPassed).toBe(true)
  })

  test('the refusal text in full', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on)
    const answer = await call('Write', { file_path: `${ORCH}/open-points.json`, content: '{}' })
    expect(answer.text).toContain(
      'session-control: refused by the helper-file guard: open-points.json is a helper file the mod\'s tools write; in this session it changes only through the session-control tool open_point, never by hand (Write: a write of /w/orch/open-points.json). Use open_point instead. Reading it is fine (cat, head, tail, grep, jq without an output redirection); CLAUDE.md, backups/ and reports/ stay editable by hand.',
    )
  })

  test('a relative path, a path with .., a symbolic link to a helper file and a path through a linked folder are refused; a new file through the linked folder is not', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    world.links.set('/w/work/alias.json', `${ORCH}/task-queue.json`)
    world.links.set('/w/work/orchlink', ORCH)
    expect((await call('Write', { file_path: 'open-points.json', content: '{}' })).isRefused).toBe(true)
    expect((await call('Write', { file_path: './sub/../task-queue.json', content: '{}' })).isRefused).toBe(true)
    expect((await call('Write', { file_path: `${ORCH}/reports/../agreed-decisions.md`, content: 'x' })).isRefused).toBe(true)
    expect((await call('Write', { file_path: '/w/work/../orch/./task-queue.json', content: 'x' })).isRefused).toBe(true)
    const viaLink = await call('Edit', { file_path: '/w/work/alias.json', old_string: 'a', new_string: 'b' })
    expect(viaLink.isRefused).toBe(true)
    expect(viaLink.text).toContain('task-queue.json is a helper file')
    expect((await call('Write', { file_path: '/w/work/orchlink/open-points.json', content: 'x' })).isRefused).toBe(true)
    expect((await call('Write', { file_path: '/w/work/orchlink/fresh-notes.md', content: 'x' })).isPassed).toBe(true)
  })

  const BASH_REFUSED = [
    ["sed -i 's/queued/done/' task-queue.json", 'sed -i'],
    ['echo x > open-points.json', 'an output redirection (>)'],
    [`echo '{}' >> ${ORCH}/agreed-decisions.md`, 'an output redirection (>)'],
    ['jq \'.tasks=[]\' task-queue.json > /tmp/q && mv /tmp/q task-queue.json', 'mv'],
    ['jq . /tmp/q > task-queue.json', 'an output redirection (>)'],
    ['tee -a agreed-decisions.md < /tmp/x', 'tee'],
    ['cp /tmp/x task-queue.json', 'cp'],
    ['rm -f cleared.jsonl', 'rm'],
    [`truncate -s 0 ${REGISTRY}`, 'truncate'],
    ['dd if=/dev/null of=open-points-archive.md', 'dd of='],
    ['install -m 644 /tmp/x task-queue.json', 'install'],
    ['ln -sf /tmp/x task-queue.json', 'ln'],
    ['python3 -c "open(\'task-queue.json\', \'w\').write(\'{}\')"', 'python3 code that writes it'],
    ['node -e "require(\'fs\').writeFileSync(\'open-points.json\', \'{}\')"', 'node code that writes it'],
    ['f=task-queue.json; echo x > "$f"', 'an output redirection to a variable, in a command that names the file'],
    ['bash -c "sed -i s/a/b/ task-queue.json"', 'sed -i'],
    ['cat <<EOF > task-queue.json\n{}\nEOF', 'an output redirection (>)'],
    ['git checkout -- agreed-decisions.md', 'git checkout'],
    ['find . -name task-queue.json -delete', 'find -delete or -exec'],
    ['perl -pi -e s/a/b/ task-queue.json', 'perl -i'],
  ] as const
  const BASH_ALLOWED = [
    'cat task-queue.json',
    'head -n 20 open-points.json',
    'tail -5 agreed-decisions.md',
    'grep -n queued task-queue.json',
    "jq '.tasks[] | .id' task-queue.json",
    'jq . task-queue.json > /tmp/copy.json',
    'wc -l open-points.json',
    'ls -la task-queue.json',
    'stat headless-sessions.json',
    'sha256sum agreed-decisions.md',
    'diff open-points.json /tmp/x',
    'cat task-queue.json 2>&1 | grep id',
    'python3 -c "import json; print(json.load(open(\'task-queue.json\')))"',
    'echo x > task-queue.json.bak',
    'git status -sb && git log --oneline -3',
    'sed -n 1,5p task-queue.json',
  ]

  test('Bash: a command that writes a helper file is refused, naming the construct; a reading command runs', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on)
    for (const [command, how] of BASH_REFUSED) {
      const answer = await call('Bash', { command })
      expect({ command, isRefused: answer.isRefused, isPassed: answer.isPassed }).toEqual({ command, isRefused: true, isPassed: false })
      expect(answer.text).toContain(`(Bash: ${how})`)
    }
    for (const command of BASH_ALLOWED) {
      const answer = await call('Bash', { command })
      expect({ command, isRefused: answer.isRefused, isPassed: answer.isPassed }).toEqual({ command, isRefused: false, isPassed: true })
    }
  })

  test('PowerShell: Set-Content, Out-File, Add-Content, Remove-Item, Move-Item, a redirection and a .NET write are refused in any case; reading runs', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on)
    for (const command of [
      'Set-Content -Path .\\task-queue.json -Value "{}"',
      'SET-CONTENT task-queue.json x',
      'set-content -LiteralPath C:\\orch\\open-points.json -Value x',
      "'x' | Out-File -FilePath open-points.json -Encoding utf8",
      'Add-Content agreed-decisions.md "x"',
      'Remove-Item cleared.jsonl',
      'Move-Item C:\\tmp\\q.json task-queue.json -Force',
      '"x" > task-queue.json',
      "[System.IO.File]::WriteAllText('task-queue.json', 'x')",
      'Copy-Item C:\\tmp\\q.json task-queue.json',
      'Get-Content task-queue.json | ConvertFrom-Json | ConvertTo-Json | Set-Content task-queue.json',
    ]) {
      const answer = await call('PowerShell', { command })
      expect({ command, isRefused: answer.isRefused }).toEqual({ command, isRefused: true })
    }
    for (const command of ['Get-Content task-queue.json', 'Get-Content open-points.json | ConvertFrom-Json', 'Select-String -Path agreed-decisions.md -Pattern x', 'Test-Path task-queue.json', 'cat task-queue.json']) {
      const answer = await call('PowerShell', { command })
      expect({ command, isPassed: answer.isPassed }).toEqual({ command, isPassed: true })
    }
  })

  test('the mod\'s own tools still write the helper files (they do not go through a tool call)', { options: OPTIONS }, async ($, on) => {
    const { world, call } = await started($, on)
    const answer = await call('mcp__session-control__queue_task', { action: 'add', id: 'mine', title: 'Mine', status: 'queued' })
    expect(answer.isRefused).toBe(false)
    expect(world.files.get(`${ORCH}/task-queue.json`)).toContain('"mine"')
  })
})

describe('the guard is inert outside the orchestrator directory\'s own session', () => {
  test('a session in another directory, with the orchestratorDir option set, writes the helper files by hand unchecked', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on, '/w/work')
    expect((await call('Write', { file_path: `${ORCH}/open-points.json`, content: '{}' })).isPassed).toBe(true)
    expect((await call('Bash', { command: `sed -i s/a/b/ ${ORCH}/task-queue.json` })).isPassed).toBe(true)
  })

  test('a directory whose CLAUDE.md is no orchestrator\'s, without the option: nothing is checked', { options: { registryPath: '~/.claude/headless-sessions.json' } }, async ($, on) => {
    const world = mockWorld(on)
    world.files.set('/w/work/CLAUDE.md', '# A project\n')
    await $.session.start({ cwd: '/w/work', surface: null, isInteractive: true })
    const answer = answerOf(await $.tool.call({ tool: 'Write', file_path: '/w/work/task-queue.json', content: '{}' } as never))
    expect(answer.isRefused).toBe(false)
    expect(world.passed.some(one => one.tool === 'Write')).toBe(true)
  })
})

describe('guard.ts on Windows paths and PowerShell', () => {
  const WIN = { orchestratorDir: 'C:/Users/u/orch', registryPath: 'C:/Users/u/.claude/headless-sessions.json', runsDir: 'C:/Users/u/.claude/session-control/runs' }
  const files = protectedFiles(WIN).map(one => ({ ...one, spellings: [] }))
  const cwd = 'C:/Users/u/orch'

  test('a Windows path in another case, with backslashes, in the Git Bash /c/ form, relative or with .. names the same file', () => {
    for (const target of ['C:\\Users\\u\\orch\\task-queue.json', 'c:/users/U/ORCH/Task-Queue.JSON', '/c/Users/u/orch/task-queue.json', 'task-queue.json', '.\\sub\\..\\TASK-QUEUE.json', 'C:\\Users\\u\\.claude\\HEADLESS-sessions.json']) {
      expect({ target, hit: pathVerdict([target], files, cwd, true)?.name !== undefined }).toEqual({ target, hit: true })
    }
    for (const target of ['C:\\Users\\u\\orch\\CLAUDE.md', 'C:\\Users\\u\\orch\\backups\\task-queue-before-x.json', 'D:\\Users\\u\\orch\\task-queue.json', 'C:\\Users\\u\\orch\\task-queue.json.bak']) {
      expect({ target, hit: pathVerdict([target], files, cwd, true) }).toEqual({ target, hit: undefined })
    }
    expect(normalPath('C:\\A\\b\\..\\C.txt', 'C:/x', true)).toBe('c:/a/c.txt')
    // On Linux the case counts: another file.
    expect(pathVerdict(['/o/Task-Queue.json'], protectedFiles({ orchestratorDir: '/o', registryPath: '/h/r.json', runsDir: '/h/runs' }).map(one => ({ ...one, spellings: [] })), '/o', false)).toBeUndefined()
  })

  test('the PowerShell tool variants: cmdlets and aliases in any case, nested in powershell -Command from Bash, .NET calls; reading passes', () => {
    const raw = protectedFiles(WIN)
    const refused = ['sc task-queue.json x', 'ac agreed-decisions.md x', 'ri cleared.jsonl', 'mi a open-points.json', 'Out-File -InputObject x C:\\Users\\u\\orch\\open-points.json', 'Clear-Content task-queue.json', 'New-Item -Force task-queue.json', 'Rename-Item open-points.json x.json', '"x" >> task-queue.json', '[IO.File]::AppendAllText("task-queue.json", "x")', 'Tee-Object -FilePath task-queue.json']
    for (const command of refused) expect({ command, hit: commandVerdict(command, raw, 'powershell')?.file.name !== undefined }).toEqual({ command, hit: true })
    expect(commandVerdict('powershell.exe -NoProfile -Command "Set-Content task-queue.json x"', raw, 'bash')?.how).toBe('Set-Content')
    expect(commandVerdict('pwsh -c "Remove-Item open-points.json"', raw, 'bash')?.how).toBe('Remove-Item')
    expect(commandVerdict('cmd /c "del task-queue.json"', raw, 'bash')?.how).toBe('del')
    for (const command of ['Get-Content task-queue.json -Raw', 'gc task-queue.json', 'type task-queue.json', 'Get-Item open-points.json | Select-Object Length', 'Get-FileHash agreed-decisions.md']) {
      expect({ command, hit: commandVerdict(command, raw, 'powershell') }).toEqual({ command, hit: undefined })
    }
    expect(denyText('PowerShell', raw[2] ?? raw[0]!, 'Set-Content')).toContain('session-control tool queue_task, never by hand (PowerShell: Set-Content)')
  })
})

describe('heredocs, quoted arguments and substitutions (decision mod-20: a prompt-file heredoc that only names a helper file runs)', () => {
  const files = protectedFiles(PLACES)
  const verdict = (command: string) => commandVerdict(command, files, 'bash')
  const PROMPT_BODY = [
    'Update task-queue.json only through queue_task; never edit open-points.json by hand.',
    'cp x task-queue.json',
    '> open-points.json',
    "node writes agreed-decisions.md, the worker's task-queue.json",
    'sed -i s/a/b/ task-queue.json',
  ].join('\n')

  test('the reported case through the plugin: a prompt file written by a heredoc to a variable path runs; a redirect to a helper file in the same form is refused', { options: OPTIONS }, async ($, on) => {
    const { call } = await started($, on)
    const allowed = `SCRATCH=/tmp/scratch\ncat > "$SCRATCH/prompt.md" <<'PROMPT_EOF'\n${PROMPT_BODY}\nPROMPT_EOF\ntest -s "$SCRATCH/prompt.md"`
    const answer = await call('Bash', { command: allowed })
    expect({ isRefused: answer.isRefused, isPassed: answer.isPassed }).toEqual({ isRefused: false, isPassed: true })
    const refused = await call('Bash', { command: `cat > task-queue.json <<'EOF'\n{}\nEOF` })
    expect(refused.isRefused).toBe(true)
    expect(refused.text).toContain('(Bash: an output redirection (>))')
  })

  test('allowed: a heredoc body (quoted or not, <<- too) that data sinks read only names a helper file, whatever its lines look like; a quoted plain argument names one beside a redirect to a variable', () => {
    for (const command of [
      `cat > /tmp/p.md <<'EOF'\n${PROMPT_BODY}\nEOF`,
      `cat > /tmp/p.md <<"EOF"\n${PROMPT_BODY}\nEOF`,
      `cat > /tmp/p.md <<\\EOF\n${PROMPT_BODY}\nEOF`,
      `cat > /tmp/p.md <<EOF\nplain mention of task-queue.json and $HOME\nEOF`,
      `cat <<-EOF > /tmp/p.md\n\trm task-queue.json\n\tEOF`,
      `tee /tmp/p.md <<'EOF' >/dev/null\n${PROMPT_BODY}\nEOF`,
      `cat <<'EOF' | grep task | wc -l\nrm task-queue.json\nEOF`,
      `git commit -F - <<'EOF'\nfix: rm task-queue.json handling\nEOF`,
      // A terminator line in quotes is no terminator: the rm line is still body.
      `cat > /tmp/p <<'EOF'\nx\n'EOF'\nrm task-queue.json\nEOF`,
      // Two heredocs on one line, each body to its own delimiter.
      `cat > /tmp/p <<'A'; cat > /tmp/q <<'B'\nrm task-queue.json\nA\nrm open-points.json\nB`,
      // An unquoted heredoc's substitution that only reads.
      `cat > /tmp/p <<EOF\n$(cat task-queue.json)\nEOF`,
      // A quoted heredoc's substitution is text.
      `cat > /tmp/p <<'EOF'\n$(sed -i s/a/b/ task-queue.json)\n\`rm open-points.json\`\nEOF`,
      // A quoted plain argument names it; the redirect goes to a variable.
      'echo "Use queue_task, never task-queue.json by hand" > "$OUT"',
      `printf '%s\\n' 'edit open-points.json only by open_point' >> "$P"`,
      // Single quotes keep a substitution as text.
      "echo '$(rm task-queue.json)'",
      'grep queued <<< "$(cat task-queue.json)"',
      // A here-string a reading command takes.
      'cat <<< "see task-queue.json" > /tmp/x',
      // A python heredoc that only reads.
      `python3 - <<'EOF'\nprint(open('task-queue.json').read())\nEOF`,
    ]) {
      expect({ command, hit: verdict(command) }).toEqual({ command, hit: undefined })
    }
  })

  test('still denied: a redirect, tee, sed -i, cp or mv onto a helper file, a python -c or node -e write, after or around a heredoc; a body a shell, an interpreter or xargs reads', () => {
    const cases: readonly (readonly [string, string])[] = [
      [`cat <<'EOF' > task-queue.json\n{}\nEOF`, 'an output redirection (>)'],
      [`cat > /tmp/p <<'EOF'\nhello\nEOF\nsed -i s/a/b/ task-queue.json`, 'sed -i'],
      [`cat > /tmp/p <<'EOF'\nhello\nEOF\ntee open-points.json < /tmp/p`, 'tee'],
      [`cat > /tmp/p <<'EOF'\nhello\nEOF\ncp /tmp/p task-queue.json`, 'cp'],
      [`cat > /tmp/p <<'EOF'\nhello\nEOF\nmv /tmp/p task-queue.json`, 'mv'],
      [`cat > /tmp/p <<'EOF'\nx\nEOF\npython3 -c "open('task-queue.json','w').write('{}')"`, 'python3 code that writes it'],
      [`cat > /tmp/p <<'EOF'\nx\nEOF\nnode -e "require('fs').writeFileSync('open-points.json','{}')"`, 'node code that writes it'],
      // A terminator with a blank after it is no terminator; the real one ends the body, the rm after it runs.
      [`cat > /tmp/p <<'EOF'\nEOF \nEOF\nrm task-queue.json`, 'rm'],
      // `<<` inside a string is no heredoc: the next line is a command.
      ['echo "a <<EOF b"\nrm task-queue.json\nEOF', 'rm'],
      // An arithmetic shift is no heredoc either.
      ['echo $((1<<2))\nrm task-queue.json', 'rm'],
      // <<- strips the tabs of the terminator only; what follows it runs.
      [`cat <<-EOF > /tmp/x\n\tmention task-queue.json\n\tEOF\nrm task-queue.json`, 'rm'],
      // Substitutions run: in an unquoted heredoc, in double quotes, in backticks.
      [`cat > /tmp/p <<EOF\n$(sed -i s/a/b/ task-queue.json)\nEOF`, 'sed -i'],
      ['cat > /tmp/p <<EOF\n`rm task-queue.json`\nEOF', 'rm'],
      ['echo "$(rm task-queue.json)"', 'rm'],
      ['echo "`rm task-queue.json`"', 'rm'],
      ['echo `rm task-queue.json`', 'rm'],
      // A here-string or heredoc a shell or an interpreter reads is code.
      ['bash <<< "sed -i s/a/b/ task-queue.json"', 'sed -i'],
      [`python3 <<< "open('task-queue.json','w').write('x')"`, 'python3 code that writes it (a here-string)'],
      [`bash <<'EOF'\nsed -i s/a/b/ task-queue.json\nEOF`, 'sed -i'],
      [`cat <<'EOF' | sh\nrm open-points.json\nEOF`, 'rm'],
      [`python3 - <<'EOF'\nimport json\njson.dump({}, open('task-queue.json', 'w'))\nEOF`, 'python3 code that writes it (a heredoc)'],
      [`xargs rm <<'EOF'\ntask-queue.json\nEOF`, 'a heredoc fed to xargs rm'],
      // A heredoc that writes a script the same command runs is read as before.
      [`cat > /tmp/fix.py <<'EOF'\nimport json\njson.dump({}, open('open-points.json', 'w'))\nEOF\npython3 /tmp/fix.py`, 'python3 code that writes it'],
      [`cat > /tmp/fix.sh <<'EOF'\nsed -i s/a/b/ task-queue.json\nEOF\nbash /tmp/fix.sh`, 'sed -i'],
      // A consumer the guard does not know: the body is read as command lines, as before.
      [`mycmd <<'EOF'\nsed -i s/a/b/ task-queue.json\nEOF`, 'sed -i'],
      // The name kept by the shell: an assignment, a for list, a substitution's output.
      ['f="task-queue.json"; echo x > "$f"', 'an output redirection to a variable, in a command that names the file'],
      ['for f in "task-queue.json"; do echo x > "$f"; done', 'an output redirection to a variable, in a command that names the file'],
      ['f=$(echo "task-queue.json"); echo x > "$f"', 'an output redirection to a variable, in a command that names the file'],
      ['read f <<< "task-queue.json"; echo x > "$f"', 'an output redirection to a variable, in a command that names the file'],
      // A shell keyword before the command.
      ['for f in a; do sed -i s/a/b/ task-queue.json; done', 'sed -i'],
      ['if true; then rm open-points.json; fi', 'rm'],
    ]
    for (const [command, how] of cases) expect({ command, how: verdict(command)?.how }).toEqual({ command, how })
  })

  test('cutHeredocs and substitutionsOf: bodies as Bash reads them, a mark each; substitutions outside single quotes', () => {
    const cut = cutHeredocs("cat > a <<'X'; cat > b <<Y\none\nX\ntwo $(date)\nY\necho after")
    expect(cut.heredocs.map(one => [one.body, one.isQuoted])).toEqual([['one', true], ['two $(date)', false]])
    expect(cut.text).not.toContain('one')
    expect(cut.text).toContain('echo after')
    expect(cutHeredocs('echo "<<X"\nx\nX').heredocs).toEqual([])
    expect(cutHeredocs('cat <<EOF\nno end').heredocs.map(one => one.body)).toEqual(['no end'])
    expect(substitutionsOf('a $(b "c") `d` \'$(e)\' "$(f)" $((1+2))')).toEqual(['b "c"', 'd', 'f'])
    expect(substitutionsOf("it's $(g)", true)).toEqual(['g'])
  })
})

describe('the documented limits of the command check (README, Helper-file guard: a slip guard, not a boundary)', () => {
  const files = protectedFiles(PLACES)
  const verdict = (command: string) => commandVerdict(command, files, 'bash')

  test('the forms the README lists as not caught run, the documented false positive is refused, and the backup the README suggests runs', () => {
    for (const command of [
      "sed -i 's/a/b/' task-qu''eue.json",
      'sed -i s/a/b/ task-"queue".json',
      'sed -i s/a/b/ task\\-queue.json',
      'rm task-{queue,x}.json',
      "rm $'task-queue\\x2ejson'",
      'rm task-*.json',
      'ls | grep queue | xargs rm',
      'f=task; sed -i x "$f-queue.json"',
      'sed -i x q',
      'python3 fix.py',
    ]) {
      expect({ command, hit: verdict(command) }).toEqual({ command, hit: undefined })
    }
    expect(verdict('cp task-queue.json backups/task-queue-copy.json')?.file.name).toBe('task-queue.json')
    expect(verdict('cat task-queue.json > backups/task-queue-copy.json')).toBeUndefined()
  })
})

describe('record_decision and the decisions archive', () => {
  test('an id an archived section holds is refused with the reason; a new id is recorded; an unreadable archive refuses; no archive, no check', { options: OPTIONS }, async ($, on) => {
    const world = mockWorld(on)
    seedOrchestrator(world)
    await $.session.start({ cwd: ORCH, surface: null, isInteractive: true })
    const record = async (id: string) => answerOf(await $.tool.call({ tool: 'mcp__session-control__record_decision', section: 'Free unit', id, text: 'A line.' } as never))
    // No archive yet: only the file's own ids count.
    expect((await record('arch-1')).isRefused).toBe(false)
    world.files.set(`${ORCH}/agreed-decisions-archive.md`, '# Agreed decisions archive\n# Archived 2026-09-20 from agreed-decisions.md\n## Gone unit\ngone-1. Archived.\n')
    const refused = await record('gone-1')
    expect(refused.isRefused).toBe(true)
    expect(refused.text).toContain("decision gone-1 already exists in agreed-decisions-archive.md (an archived section's ids stay taken); choose another id")
    expect(world.files.get(`${ORCH}/agreed-decisions.md`)).not.toContain('gone-1.')
    expect((await record('free-9')).isRefused).toBe(false)
    expect(world.files.get(`${ORCH}/agreed-decisions.md`)).toContain('free-9. A line.')
    world.unreadable.add(`${ORCH}/agreed-decisions-archive.md`)
    const unreadable = await record('free-10')
    expect(unreadable.isRefused).toBe(true)
    expect(unreadable.text).toContain('agreed-decisions-archive.md is there but cannot be read, so the id cannot be checked')
    expect(world.files.get(`${ORCH}/agreed-decisions.md`)).not.toContain('free-10.')
  })
})
