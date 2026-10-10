#!/usr/bin/env python3
"""Run with `python3 -I tests/windows-selftest.py` from WSL, where Windows PowerShell is reachable.

Extracts the Windows PowerShell scripts from hooks/host-windows.ts, writes them to a scratch directory on the Windows
side and runs them through powershell.exe, the way the mod runs them on native Windows (absolute path, -File).
It proves the scripts' own behaviour on this host's PowerShell and file system only: not what the Windows engine
passes them, nor a real claude.exe. NEWER_PS1 (the listing of the files written after a time) runs over a scratch
tree holding a .git folder and a junction out of the tree. The scratch directory is a new folder under SC_WIN_SCRATCH (a Windows path)
or under the Windows %TEMP%, and is removed at the end. Without powershell.exe it prints `skipped`.

Its last part copies the Node helper (mod/helper/*.mjs) to the scratch directory and runs its file operations with
the Windows node.exe (SC_WIN_NODE, else C:\\Program Files\\nodejs\\node.exe), as the mod does on native Windows:
rename over an existing file (also while another process holds it open), append, remove, the tail of a 3 MB UTF-8
file with CRLF line ends and non-ASCII text, filesNewerThan over the tree NEWER_PS1 listed (the junction neither
followed nor listed), and a batch of 20 operations, with the time per batch. Without that
node.exe it prints `skipped`."""
import ast, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, '..', 'hooks', 'core.ts'), encoding='utf-8').read()
# The scripts the Windows adapter runs (FILES_PS1, PROBE_PS1) live in hooks/host-windows.ts.
WIN_SRC = open(os.path.join(HERE, '..', 'hooks', 'host-windows.ts'), encoding='utf-8').read()
PS = shutil.which('powershell.exe') or '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
if not os.path.exists(PS):
    print('windows-selftest: skipped (no powershell.exe)')
    sys.exit(0)


def constant(name):
    """A `[...].join('\\r\\n')` constant of host-windows.ts, as the text the mod writes."""
    body = WIN_SRC.split(f'export const {name} = [', 1)[1].split("].join('\\r\\n')", 1)[0]
    lines = [l.strip() for l in body.strip().splitlines()]
    return '\r\n'.join(ast.literal_eval(l.rstrip(',')) for l in lines if l and not l.startswith('//'))


def to_wsl(win):
    return subprocess.run(['wslpath', '-u', win], capture_output=True, text=True, check=True).stdout.strip()


def to_win(path, slash='/'):
    return subprocess.run(['wslpath', '-m' if slash == '/' else '-w', path], capture_output=True, text=True, check=True).stdout.strip()


base_win = os.environ.get('SC_WIN_SCRATCH') or subprocess.run(
    [PS, '-NoProfile', '-NonInteractive', '-Command', '[IO.Path]::GetTempPath()'], capture_output=True, text=True, cwd='/mnt/c').stdout.strip()
base = to_wsl(base_win)
os.makedirs(base, exist_ok=True)
work = tempfile.mkdtemp(prefix='sc-selftest-', dir=base)
win = to_win(work)


def run(script_name, text, *args, timeout=60):
    path = os.path.join(work, script_name)
    open(path, 'w', encoding='utf-8', newline='').write(text)
    argv = [PS, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f'{win}/{script_name}', *args]
    r = subprocess.run(argv, capture_output=True, timeout=timeout, cwd=work)
    return r.returncode, r.stdout.decode('utf-8'), r.stderr.decode('utf-8', 'replace')


def put(name, text):
    open(os.path.join(work, name), 'w', encoding='utf-8', newline='').write(text)


def get(name):
    path = os.path.join(work, name)
    return open(path, encoding='utf-8', newline='').read() if os.path.exists(path) else None


try:
    files = constant('FILES_PS1')
    # move onto a name that is not there yet; spaces and brackets stay literal
    put('a b [1].tmp', 'one')
    code, out, err = run('files.ps1', files, 'move', f'{win}/a b [1].tmp', f'{win}/reg [x].json')
    assert code == 0 and err == '', (code, err)
    assert get('reg [x].json') == 'one' and get('a b [1].tmp') is None
    # move over an existing file: replaced in one step
    put('reg [x].json.tmp.1', 'two')
    code, out, err = run('files.ps1', files, 'move', f'{win}/reg [x].json.tmp.1', f'{win}/reg [x].json')
    assert code == 0 and get('reg [x].json') == 'two' and get('reg [x].json.tmp.1') is None, (code, err)
    # backslash paths work the same
    put('c.tmp', 'three')
    code, out, err = run('files.ps1', files, 'move', to_win(os.path.join(work, 'c.tmp'), '\\'), to_win(os.path.join(work, 'reg [x].json'), '\\'))
    assert code == 0 and get('reg [x].json') == 'three', (code, err)
    # a failed move exits 1 with the reason and leaves the target alone
    code, out, err = run('files.ps1', files, 'move', f'{win}/missing.tmp', f'{win}/reg [x].json')
    assert code == 1 and err.strip() != '' and get('reg [x].json') == 'three', (code, err)
    # remove: a file goes, a missing one is no error
    put('gone.tmp', 'x')
    assert run('files.ps1', files, 'remove', f'{win}/gone.tmp')[0] == 0 and get('gone.tmp') is None
    assert run('files.ps1', files, 'remove', f'{win}/gone.tmp')[0] == 0
    # tail: the last lines, each cut to the width, as UTF-8
    lines = [json.dumps({'n': i, 'text': 'café ☕ \U0001F600'}) for i in range(700)]
    lines[650] = 'x' * 25000
    put('t.jsonl', '\n'.join(lines) + '\n')
    code, out, err = run('files.ps1', files, 'tail', f'{win}/t.jsonl', '600', '20000')
    assert code == 0, err
    want = ''.join(line[:20000] + '\n' for line in lines[-600:])
    assert out == want, (len(out), len(want), out[:200])
    # append: the text of one file goes to the end of another, which is not read; the first is removed
    put('log.jsonl', 'old line\n')
    put('add.tmp', '{"t":"caf\u00e9 \u2615"}\n{"t":"b"}\n')
    code, out, err = run('files.ps1', files, 'append', f'{win}/add.tmp', f'{win}/log.jsonl')
    assert code == 0 and err == '', (code, err)
    assert get('log.jsonl') == 'old line\n{"t":"caf\u00e9 \u2615"}\n{"t":"b"}\n' and get('add.tmp') is None
    put('add.tmp', 'x\n')
    code, out, err = run('files.ps1', files, 'append', f'{win}/add.tmp', f'{win}/new dir/fresh.jsonl')
    assert code == 0 and get('new dir/fresh.jsonl') == 'x\n', (code, err)
    code, out, err = run('files.ps1', files, 'append', f'{win}/missing.tmp', f'{win}/log.jsonl')
    assert code == 1 and get('log.jsonl').startswith('old line'), (code, err)
    code, out, err = run('files.ps1', files, 'nonsense')
    assert code == 1 and 'unknown operation' in err, (code, err)
    print('windows-files-selftest: ok')

    # --- NEWER_PS1: the files under a folder written after a time. A junction out of the tree (made with New-Item, no
    # admin right needed) is neither followed nor listed, no .git folder is entered, the newest come first and the
    # count covers what the cap leaves out.
    newer = constant('NEWER_PS1')
    T = 1_790_000_000

    def stamp(name, sec, text='x'):
        os.makedirs(os.path.dirname(os.path.join(work, name)), exist_ok=True)
        put(name, text)
        os.utime(os.path.join(work, name), (sec, sec))

    stamp('newer/a.txt', T + 30)
    stamp('newer/sub [1]/b b.txt', T + 20)
    stamp('newer/caf\u00e9.txt', T + 25)
    stamp('newer/old.txt', T - 100)
    stamp('newer/.git/HEAD', T + 50)
    stamp('outside/secret.txt', T + 40, 'canary-outside')
    code, out, err = run('junction.ps1', "param([string]$L, [string]$T)\r\n$null = New-Item -ItemType Junction -Path $L -Target $T\r\n",
                         to_win(os.path.join(work, 'newer', 'j'), '\\'), to_win(os.path.join(work, 'outside'), '\\'))
    assert code == 0, (code, err)
    assert os.path.exists(os.path.join(work, 'newer', 'j', 'secret.txt')), 'the junction does not lead out of the tree'
    want_newer = [('a.txt', (T + 30) * 1000), ('caf\u00e9.txt', (T + 25) * 1000), ('sub [1]/b b.txt', (T + 20) * 1000)]

    def newer_lines(out):
        lines = out.replace('\r\n', '\n').rstrip('\n').split('\n')
        total = lines.pop()
        assert total.startswith('N\t'), out
        found = []
        for line in lines:
            sec, path = line.split('\t', 1)
            whole, _, fraction = sec.partition('.')
            found.append((path.replace('\\', '/'), int(whole) * 1000 + int((fraction + '000')[:3])))
        return found, int(total[2:])

    code, out, err = run('newer.ps1', newer, f'{win}/newer', str(T), '200')
    assert code == 0 and err == '', (code, err)
    found, total = newer_lines(out)
    root = to_win(os.path.join(work, 'newer')).rstrip('/')
    assert [(p[len(root) + 1:], ms) for p, ms in found] == want_newer and total == 3, (found, total)
    assert 'outside' not in out and 'secret' not in out, out
    code, out, err = run('newer.ps1', newer, f'{win}/newer', str(T), '1')
    found, total = newer_lines(out)
    assert code == 0 and len(found) == 1 and found[0][0].endswith('/a.txt') and total == 3, (code, out, err)
    code, out, err = run('newer.ps1', newer, f'{win}/no such folder', str(T), '200')
    assert code == 3 and out == '', (code, out, err)
    print('windows-newer-selftest: ok (NEWER_PS1: newest first, the cap and the count, no .git, the junction neither followed nor listed)')

    # --- PROBE_PS1, with its process name swapped to powershell.exe: a sleeping powershell.exe of this test's own
    # plays the worker, and fake sessions files under the scratch directory play the engine's. This verifies the
    # script's own arithmetic and output only, never a real claude.exe or a real sessions file.
    probe = constant('PROBE_PS1')
    assert probe.count("$name = 'claude.exe'") == 1
    probe = probe.replace("$name = 'claude.exe'", "$name = 'powershell.exe'")
    to_ms = '[long][Math]::Floor(($t.ToUniversalTime() - (New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc))).TotalMilliseconds)'

    def ps(command):
        r = subprocess.run([PS, '-NoProfile', '-NonInteractive', '-Command', command], capture_output=True, text=True, timeout=60, cwd=work)
        assert r.returncode == 0, r.stderr
        return r.stdout.strip()

    def sleeper(seconds):
        marker = os.path.join(work, f'pid-{seconds}.txt')
        proc = subprocess.Popen([PS, '-NoProfile', '-NonInteractive', '-Command', f"$PID | Set-Content -Encoding ascii '{to_win(marker)}'; Start-Sleep {seconds}"], cwd=work)
        for _ in range(300):
            if os.path.exists(marker) and open(marker).read().strip():
                return proc, int(open(marker).read().strip())
            subprocess.run(['sleep', '0.1'])
        raise AssertionError('the sleeper did not start')

    live, pid = sleeper(120)
    gone, gone_pid = sleeper(0)
    gone.wait(timeout=60)
    try:
        created = int(ps(f'$t = (Get-CimInstance Win32_Process -Filter "ProcessId={pid}").CreationDate; {to_ms}'))
        sid, sid2 = '11111111-2222-4333-8444-555555555555', '99999999-2222-4333-8444-555555555555'

        def session_dir(name, **fields):
            cfg = os.path.join(work, name)
            os.makedirs(os.path.join(cfg, 'sessions'), exist_ok=True)
            json.dump(fields, open(os.path.join(cfg, 'sessions', f'{pid}.json'), 'w'))
            return to_win(cfg)

        good = session_dir('cfg good', pid=pid, sessionId=sid, cwd='C:\\fake\\cwd', startedAt=created + 1500)
        os.makedirs(os.path.join(work, 'cfg good', 'projects', 'C--fake-cwd'))
        transcript = os.path.join(work, 'cfg good', 'projects', 'C--fake-cwd', f'{sid}.jsonl')
        open(transcript, 'w').write('{}\n')
        os.utime(transcript, (1_700_000_000, 1_700_000_000))
        os.makedirs(os.path.join(work, 'cfg good', 'projects', 'other'))
        older = os.path.join(work, 'cfg good', 'projects', 'other', f'{sid}.jsonl')
        open(older, 'w').write('{}\n')
        os.utime(older, (1_600_000_000, 1_600_000_000))
        stale = session_dir('cfg stale', pid=pid, sessionId=sid2, cwd='C:\\old', startedAt=created - 3_600_000)
        late = session_dir('cfg late', pid=pid, sessionId=sid2, cwd='C:\\late', startedAt=created + 600_001)
        other = session_dir('cfg other pid', pid=pid + 1, sessionId=sid2, cwd='C:\\x', startedAt=created + 10)
        empty = to_win(os.path.join(work, 'cfg empty'))

        def lines(*args):
            code, out, err = run('probe.ps1', probe, *args)
            assert code == 0 and err == '', (code, err)
            assert '\r' not in out
            return [line.split('\t') for line in out.splitlines()]

        started = __import__('time').time()
        got = lines(f'pid:{pid}|{good}', f't:{sid}|{good}', f'c:{stale}', f'pid:{gone_pid}|{good}')
        took = __import__('time').time() - started
        mine = [cols for cols in got if cols[0] == 'P' and cols[1] == str(pid)]
        assert len(mine) == 1 and mine[0][2] == 'claude' and mine[0][4] == 'C:\\fake\\cwd' and mine[0][5] == good, mine
        assert int(mine[0][3]) >= 0 and 'Start-Sleep 120' in mine[0][6], mine
        assert [cols for cols in got if cols[0] == 'A'] == [['A', str(pid), 'powershell', str(created), str(created), sid]], got
        assert [cols for cols in got if cols[0] == 'T'] == [['T', sid, '1700000000']], got
        # a sessions file from before the process (a reused pid), one written too long after it, one naming another
        # pid, and none at all: the start columns differ or the file's is empty, so the pid is not alive
        for cfg, want in ((stale, str(created - 3_600_000)), (late, str(created + 600_001)), (other, str(created + 10)), (empty, '')):
            got = lines(f'pid:{pid}|{cfg}', f'c:{cfg}')
            assert [cols for cols in got if cols[0] == 'A'] == [['A', str(pid), 'powershell', str(created), want, sid2 if cfg in (stale, late, other) else '']], (cfg, got)
            assert [cols[4:6] for cols in got if cols[0] == 'P' and cols[1] == str(pid)] == [['', '']], (cfg, got)
        # an empty registry: P lines only; a config dir of '~' is never searched
        assert all(cols[0] == 'P' for cols in lines('pid:1|~', 't:x|~') if cols[1] != '1')
        print(f'windows-probe-selftest: ok (verifies our arithmetic only; one probe took {took:.2f} s)')
    finally:
        subprocess.run([PS, '-NoProfile', '-NonInteractive', '-Command', f'Stop-Process -Id {pid} -ErrorAction SilentlyContinue'], capture_output=True, timeout=60, cwd=work)
        live.wait(timeout=60)

    # --- the launch line in Git Bash, the Bash tool's shell on Windows, with claude() a node.exe that echoes what it
    # gets: no claude starts. The line has the shape buildLaunchArgv returns (pinned by its golden tests); this checks
    # what Git Bash makes of it: cd into a path with a blank and a quote, CLAUDE_CONFIG_DIR as written, the -n name and
    # the --settings JSON reaching the program as single arguments with their double quotes, $(cat) of the
    # prompt, the redirections, and which prompts MSYS rewrites (MSYS_PROMPTS in tests/fixtures.ts).
    def where(exe):
        r = subprocess.run([PS, '-NoProfile', '-NonInteractive', '-Command', f'(Get-Command {exe} -ErrorAction SilentlyContinue).Source'], capture_output=True, text=True, timeout=60, cwd=work)
        return r.stdout.strip()

    git = where('git.exe')
    bash = to_wsl(git.rsplit('\\cmd\\', 1)[0] + '\\bin\\bash.exe') if git.lower().endswith('\\cmd\\git.exe') else ''
    if not bash or not os.path.exists(bash) or not where('node.exe'):
        print('windows-launch-selftest: skipped (no Git Bash or no node.exe)')
    else:
        fx = open(os.path.join(HERE, 'fixtures.ts'), encoding='utf-8').read()
        block = fx.split('// MSYS_PROMPTS:BEGIN', 1)[1].split('// MSYS_PROMPTS:END', 1)[0]
        prompts = json.loads(block.split(' = ', 1)[1])
        shq = lambda v: "'" + v.replace("'", "'\\''") + "'"
        # The session name and the settings JSON buildLaunchArgv adds (WORKER_SETTINGS in hooks/core.ts).
        settings = SRC.split("export const WORKER_SETTINGS = '", 1)[1].split("'", 1)[0]
        name = 'w-selftest-261010120000'
        proj, cfg, runs = (os.path.join(work, name) for name in ("proj o'k", 'cfg dir', 'runs dir'))
        for d in (proj, cfg, runs):
            os.makedirs(d)
        echo = ("claude() { node.exe -e 'process.stdout.write(JSON.stringify({argv: process.argv.slice(1), "
                "cfg: process.env.CLAUDE_CONFIG_DIR, effort: process.env.CLAUDE_CODE_EFFORT_LEVEL, cwd: process.cwd()}))' -- \"$@\"; }\n")
        for n, one in enumerate(prompts):
            prompt, result, err = os.path.join(work, f'prompt {n}.md'), os.path.join(runs, f'{n}.json'), os.path.join(runs, f'{n}.err')
            open(prompt, 'w', encoding='utf-8', newline='').write(one['text'] + '\n')
            line = (f"cd {shq(to_win(proj))} && CLAUDE_CONFIG_DIR={shq(to_win(cfg))} CLAUDE_CODE_EFFORT_LEVEL={shq('high')} "
                    f"claude -p --model {shq('opus')} -n {shq(name)} --settings {shq(settings)} --dangerously-skip-permissions --output-format json "
                    f"-- \"$(cat {shq(to_win(prompt))})\" > {shq(to_win(result))} 2> {shq(to_win(err))}")
            script = os.path.join(work, f'launch {n}.sh')
            open(script, 'w', newline='').write(echo + line + '\n')
            r = subprocess.run([bash, to_win(script)], capture_output=True, timeout=60, cwd=work)
            assert r.returncode == 0 and r.stderr == b'' and open(err).read() == '', (one, r.returncode, r.stderr)
            got = json.load(open(result, encoding='utf-8'))
            assert got['argv'][:11] == ['-p', '--model', 'opus', '-n', name, '--settings', settings, '--dangerously-skip-permissions', '--output-format', 'json', '--'], got
            assert got['cfg'] == to_win(cfg) and got['effort'] == 'high' and got['cwd'] == to_win(proj, '\\'), got
            assert (got['argv'][11] != one['text']) == one['rewritten'], (one, got['argv'][11])
        print(f'windows-launch-selftest: ok ({len(prompts)} prompts through Git Bash)')

    # --- the PowerShell launch route (the launchRoute option at powershell): the command rendered by the real
    # powershellLaunchCommand of hooks/host-powershell.ts (the Linux node loads the TypeScript itself), then run as a
    # script by Windows PowerShell 5.1 and by PowerShell 7, as the engine's PowerShell tool would run it. node.exe with a
    # stub script stands in for claude.exe: the test swaps `Get-Command claude.exe` for `Get-Command node.exe` and puts
    # the stub's path first in the argument string, and checks no claude.exe is left in the text before anything runs.
    # The stub prints its argv, working directory, the two variables and its pid as JSON on stdout (with the prompt it
    # read, so the result file holds non-ASCII text), copies its stdin byte for byte to a file, writes a line to stderr
    # and exits with the code it is given. The only process cmdlets are the command's own Start-Process and Get-Command.
    linux_node = shutil.which('node')
    shells = [('Windows PowerShell 5.1', PS)]
    pwsh = shutil.which('pwsh.exe')
    if pwsh:
        shells.append(('PowerShell 7', pwsh))
    node_exe_win = where('node.exe')
    if not linux_node or not node_exe_win:
        print('windows-powershell-launch-selftest: skipped (no node on Linux to render the command, or no node.exe on Windows)')
    else:
        hooks = os.path.join(HERE, '..', 'hooks')
        # Relative imports without an extension (./core) resolve to the .ts file beside them, as the engine resolves them.
        resolve_hook = ("data:text/javascript,import{registerHooks}from'node:module';registerHooks({resolve(s,c,n){try{return n(s,c)}"
                        "catch(e){if(/^\\.\\.?\\//.test(s))return n(s+'.ts',c);throw e}}})")
        render_js = ("import{readFileSync}from'node:fs';"
                     f"const m=await import({json.dumps('file://' + os.path.abspath(os.path.join(hooks, 'host-powershell.ts')))});"
                     "const cases=JSON.parse(readFileSync(0,'utf8'));"
                     "process.stdout.write(JSON.stringify(cases.map(c=>({command:m.powershellLaunchCommand(c.args,c.target,c.result,c.err),"
                     "argv:m.powershellLaunchArgs(c.args,c.target),pidFile:m.launchPidFile(c.result),refusal:m.powershellLaunchRefusal(c.args,c.runsDir)??null}))))")

        def render(cases):
            r = subprocess.run([linux_node, '--no-warnings', '--experimental-strip-types', '--import', resolve_hook, '--input-type=module', '-e', render_js],
                               input=json.dumps(cases).encode('utf-8'), capture_output=True, timeout=120)
            assert r.returncode == 0, r.stderr.decode('utf-8', 'replace')[:2000]
            return json.loads(r.stdout.decode('utf-8'))

        stub_dir = os.path.join(work, 'stub')
        os.makedirs(stub_dir)
        stub = os.path.join(stub_dir, 'claude-stub.js')
        open(stub, 'w', encoding='utf-8', newline='').write(
            "const fs = require('fs')\n"
            "const input = fs.readFileSync(0)\n"
            "fs.writeFileSync(process.env.SC_STUB_STDIN_COPY, input)\n"
            "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), cfg: process.env.CLAUDE_CONFIG_DIR ?? null,\n"
            "  effort: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null, pid: process.pid, prompt: input.toString('utf8') }))\n"
            "process.stderr.write('stub stderr caf\\u00e9\\n')\n"
            "process.exitCode = Number(process.env.SC_STUB_EXIT)\n")
        stub_arg = to_win(stub)
        if ' ' in stub_arg or '"' in stub_arg:
            stub_arg = '"' + stub_arg + '"'
        sid = 'bbbbbbbb-2222-4222-8222-222222222222'
        prompt_text = ('Goal: check the "launch" route\'s quoting\r\nline two: caf\u00e9 \u2615 \u65e5\u672c \U0001F600\n'
                       '$env:PATH `backtick` %PATH% & | < > ^ ; \' "" \\" \\\\\nlast line without newline \u2019 end')
        # (label, launch dir, prompt file, runs dir, config dir picked (None: inherited), resume sid, exit code)
        layouts = [
            ('fresh, config inherited, blanks and a quote', "proj o'k dir", 'prompt one.md', "runs o'k", None, None, 0),
            ('picked config dir; brackets, a backtick and non-ASCII in the launch dir', 'proj [1] Jos`\u00e9', 'prompt \u00e9 \u2019.md', 'runs \u00e8 dir', 'cfg \u00e9 dir', None, 3),
            ('a resume under a picked config dir', 'proj resume', 'p.md', 'runs-r', 'cfg-r', sid, 1),
        ]
        cases, prepared = [], []
        for n, (label, d, p, r, cfg, resume, code) in enumerate(layouts):
            base_dir = os.path.join(work, f'ps{n}')
            proj, runs_dir = os.path.join(base_dir, d), os.path.join(base_dir, r)
            os.makedirs(proj)
            os.makedirs(runs_dir)
            prompt_path = os.path.join(base_dir, p)
            open(prompt_path, 'wb').write(prompt_text.encode('utf-8'))
            cfg_win = to_win(os.path.join(base_dir, cfg)) if cfg else 'C:/inherited/never/written'
            name = f'w-selftest-{n}-261010120000'
            result = to_win(os.path.join(runs_dir, f'20261010120000-ps-{n}.json'))
            err = to_win(os.path.join(runs_dir, f'20261010120000-ps-{n}.err'))
            target = {'configDir': cfg_win, 'name': name, **({'isConfigInherited': True} if cfg is None else {}), **({'resumeSid': resume} if resume else {})}
            cases.append({'args': {'dir': to_win(proj), 'prompt_file': to_win(prompt_path), 'model': 'opus', 'effort': 'high', 'title': 'ps'},
                          'target': target, 'result': result, 'err': err, 'runsDir': to_win(runs_dir)})
            prepared.append((label, proj, prompt_path, runs_dir, cfg_win if cfg else None, code, base_dir))
        # Why a prompt file (or a run file) with brackets is refused on this route: rendered as it would be, it fails at
        # Start-Process under both versions before anything starts; the real refusal names it.
        wild_dir = os.path.join(work, 'ps-wild', 'p [x]')
        os.makedirs(wild_dir)
        open(os.path.join(wild_dir, 'prompt.md'), 'w', encoding='utf-8').write('x\n')
        wild_runs = os.path.join(work, 'ps-wild', 'runs')
        os.makedirs(wild_runs)
        cases.append({'args': {'dir': to_win(os.path.join(work, 'ps-wild')), 'prompt_file': to_win(os.path.join(wild_dir, 'prompt.md')), 'model': 'opus', 'effort': 'high', 'title': 'ps'},
                      'target': {'configDir': 'C:/x', 'isConfigInherited': True, 'name': 'w-wild-1'}, 'result': to_win(os.path.join(wild_runs, 'w.json')),
                      'err': to_win(os.path.join(wild_runs, 'w.err')), 'runsDir': to_win(wild_runs)})
        rendered = render(cases)
        assert [one['refusal'] is None for one in rendered] == [True, True, True, False], [one['refusal'] for one in rendered]
        wild = rendered.pop()
        cases.pop()
        settings = SRC.split("export const WORKER_SETTINGS = '", 1)[1].split("'", 1)[0]
        lines_out = []
        for shell_name, shell in shells:
            for n, (label, proj, prompt_path, runs_dir, cfg_win, code, base_dir) in enumerate(prepared):
                one = rendered[n]
                command = one['command']
                assert command.count('Get-Command claude.exe ') == 1 and command.count("-ArgumentList '-p --model ") == 1, command
                assert all(0x20 <= ord(ch) <= 0x7e or ch == '\n' for ch in command), 'the command is not printable ASCII'
                want_argv = ['-p', '--model', 'opus', *(['--resume', sid] if n == 2 else []), '-n', f'w-selftest-{n}-261010120000', '--settings', settings,
                             '--dangerously-skip-permissions', '--output-format', 'json']
                assert one['argv'] == want_argv, one['argv']
                run_cmd = command.replace('Get-Command claude.exe ', 'Get-Command node.exe ').replace("-ArgumentList '-p --model ", f"-ArgumentList '{stub_arg} -p --model ")
                assert 'claude.exe' not in run_cmd
                copy = os.path.join(base_dir, f'stdin-copy-{len(lines_out)}.bin')
                for leftover in (cases[n]['result'], cases[n]['err'], one['pidFile']):
                    if os.path.exists(to_wsl(leftover)):
                        os.remove(to_wsl(leftover))
                # The tool's own process: node.exe found on its PATH, a parent CLAUDE_CONFIG_DIR that an inherited launch keeps
                # and a picked one replaces, the stub's knobs. Then the rendered command, unchanged but for the stand-in.
                preamble = '\n'.join([
                    f"$env:Path = '{node_exe_win.rsplit(chr(92), 1)[0]};' + $env:Path",
                    "$env:CLAUDE_CONFIG_DIR = 'C:/parent/config'",
                    "Remove-Item Env:CLAUDE_CODE_EFFORT_LEVEL -ErrorAction SilentlyContinue",
                    f"$env:SC_STUB_STDIN_COPY = '{to_win(copy)}'",
                    f"$env:SC_STUB_EXIT = '{code}'",
                ])
                script = os.path.join(base_dir, f'launch-{len(lines_out)}.ps1')
                open(script, 'w', encoding='ascii', newline='').write(preamble + '\n' + run_cmd + '\n')
                r = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', to_win(script)], capture_output=True, timeout=120, cwd=work)
                stderr = r.stderr.decode('utf-8', 'replace')
                assert r.returncode == code, (shell_name, label, r.returncode, stderr[:1500], r.stdout[:500])
                raw = open(to_wsl(cases[n]['result']), 'rb').read()
                assert not raw.startswith(b'\xef\xbb\xbf'), 'the result file has a BOM'
                got = json.loads(raw.decode('utf-8'))
                assert got['argv'] == want_argv, (shell_name, label, got['argv'])
                assert open(copy, 'rb').read() == prompt_text.encode('utf-8'), 'stdin changed on the way'
                assert got['prompt'] == prompt_text
                assert got['cwd'].lower() == to_win(proj, '\\').lower(), (got['cwd'], proj)
                assert got['effort'] == 'high', got
                assert got['cfg'] == (cfg_win if cfg_win else 'C:/parent/config'), (label, got['cfg'])
                pid_text = open(to_wsl(one['pidFile']), 'rb').read()
                assert pid_text.decode('ascii').strip() == str(got['pid']), (pid_text, got['pid'])
                assert open(to_wsl(cases[n]['err']), 'rb').read() == 'stub stderr caf\u00e9\n'.encode('utf-8')
                lines_out.append(f'  {shell_name}: {label}: exit {r.returncode} = {code}; argv {len(got["argv"])} intact (name and settings JSON single); '
                                 f'stdin {len(prompt_text.encode("utf-8"))} bytes intact; result UTF-8, no BOM; pid file {got["pid"]} = child pid; '
                                 f'cwd ok; CLAUDE_CONFIG_DIR {"set to the picked dir" if cfg_win else "inherited from the parent"}')
        for shell_name, shell in shells:
            run_cmd = wild['command'].replace('Get-Command claude.exe ', 'Get-Command node.exe ').replace("-ArgumentList '-p --model ", f"-ArgumentList '{stub_arg} -p --model ")
            assert 'claude.exe' not in run_cmd
            script = os.path.join(work, 'ps-wild', f'wild-{len(lines_out)}.ps1')
            open(script, 'w', encoding='ascii', newline='').write(f"$env:Path = '{node_exe_win.rsplit(chr(92), 1)[0]};' + $env:Path\n" + run_cmd + '\n')
            r = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', to_win(script)], capture_output=True, timeout=120, cwd=work)
            stderr = r.stderr.decode('utf-8', 'replace')
            assert r.returncode == 1 and 'Start-Process' in stderr and not os.path.exists(os.path.join(wild_runs, 'w.json')), (shell_name, r.returncode, stderr[:600])
            lines_out.append(f'  {shell_name}: a prompt file under "p [x]": Start-Process fails (exit 1, nothing started), as powershellLaunchRefusal says')
        print(f'windows-powershell-launch-selftest: ok ({len(lines_out)} runs under {", ".join(name for name, _ in shells)})')
        print('\n'.join(lines_out))
        if not pwsh:
            print('windows-powershell-launch-selftest: PowerShell 7 skipped (no pwsh.exe)')

    # --- the Node helper's file operations with the Windows node.exe, from a copy of mod/helper in the scratch
    # directory (a script on the WSL file system would be read over \\wsl$). No claude starts; no PowerShell script
    # of this test calls a process API.
    node_win = os.environ.get('SC_WIN_NODE') or 'C:\\Program Files\\nodejs\\node.exe'
    node = to_wsl(node_win)
    if not os.path.exists(node):
        print(f'windows-helper-selftest: skipped (no {node_win})')
    else:
        import statistics, time
        helper_dir = os.path.join(work, 'helper')
        os.makedirs(helper_dir)
        for name in os.listdir(os.path.join(HERE, '..', 'helper')):
            if name.endswith('.mjs'):
                shutil.copy(os.path.join(HERE, '..', 'helper', name), helper_dir)
        host = f'{win}/helper/host.mjs'

        def helper(op, request):
            started = time.perf_counter()
            r = subprocess.run([node, host, op], input=json.dumps(request).encode('utf-8'), capture_output=True, timeout=120, cwd=work)
            took = (time.perf_counter() - started) * 1000
            assert r.stderr == b'', (op, r.stderr[:500])
            answer = json.loads(r.stdout.decode('utf-8'))
            assert r.returncode == (0 if answer.get('ok') is True else 1), (op, r.returncode, answer)
            return answer, took

        version = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=60, cwd=work).stdout.strip()
        w = lambda name: f'{win}/{name}'
        # rename over an existing file: replaced in one step, the temp file gone
        put('reg.json', 'old')
        put('reg.json.tmp.1', 'new \u00e9')
        answer, _ = helper('renameOver', {'from': w('reg.json.tmp.1'), 'to': w('reg.json')})
        assert answer == {'ok': True} and get('reg.json') == 'new \u00e9' and get('reg.json.tmp.1') is None, answer
        # ... while another process holds the target open without delete sharing (a reader): the helper tries again
        # until the holder lets go (here after 0.6 s; it gives up after 1 s)
        put('held.json', 'old')
        put('held.json.tmp', 'new')
        holder = subprocess.Popen([PS, '-NoProfile', '-NonInteractive', '-Command',
                                   f"$f = [System.IO.File]::Open('{to_win(os.path.join(work, 'held.json'), chr(92))}', 'Open', 'Read', 'Read'); "
                                   f"'held' | Set-Content -Encoding ascii '{to_win(os.path.join(work, 'held.flag'), chr(92))}'; Start-Sleep -Milliseconds 600; $f.Close()"], cwd=work)
        for _ in range(300):
            if get('held.flag'):
                break
            time.sleep(0.05)
        assert get('held.flag'), 'the holder did not open the file'
        answer, held_ms = helper('renameOver', {'from': w('held.json.tmp'), 'to': w('held.json')})
        holder.wait(timeout=60)
        assert answer == {'ok': True} and get('held.json') == 'new', answer
        # writeAtomic: a new file and its directory, a replaced one, a changed one left alone, no temp file left
        assert helper('writeAtomic', {'path': w('deep dir/reg [1].json'), 'text': '[]\n'})[0] == {'ok': True, 'written': True}
        assert helper('writeAtomic', {'path': w('deep dir/reg [1].json'), 'text': '[1]\n', 'expected': '[]\n'})[0] == {'ok': True, 'written': True}
        assert helper('writeAtomic', {'path': w('deep dir/reg [1].json'), 'text': '[2]\n', 'expected': '[]\n'})[0] == {'ok': True, 'written': False}
        assert get('deep dir/reg [1].json') == '[1]\n' and os.listdir(os.path.join(work, 'deep dir')) == ['reg [1].json']
        # append: to the end, never read; a new directory made; remove: a file goes, a missing one is no failure
        put('log.jsonl', 'old line\n')
        assert helper('append', {'path': w('log.jsonl'), 'text': '{"t":"caf\u00e9 \u2615"}\n{"t":"b"}\n'})[0]['ok'] is True
        assert get('log.jsonl') == 'old line\n{"t":"caf\u00e9 \u2615"}\n{"t":"b"}\n'
        assert helper('append', {'path': w('node dir/fresh.jsonl'), 'text': 'x\n'})[0]['ok'] is True and get('node dir/fresh.jsonl') == 'x\n'
        assert helper('removeFile', {'path': w('log.jsonl')})[0] == {'ok': True, 'removed': True} and get('log.jsonl') is None
        assert helper('removeFile', {'path': w('log.jsonl')})[0] == {'ok': True, 'removed': False}
        # a failure is a fixed code, with no path or message
        answer, _ = helper('tail', {'path': w('missing.jsonl'), 'lines': 600, 'width': 20000})
        assert answer == {'ok': False, 'code': 'NOT_FOUND'}, answer
        # tail of a 3 MB UTF-8 file with CRLF line ends and non-ASCII text (4000 rows): the last 600 lines, each cut to 20000
        # UTF-16 units (tailLines of hooks/core.ts; the \r stays, as in tailLines and tail | cut)
        def utf16_cut(line, width):
            units = line.encode('utf-16-le')
            return units[:2 * width].decode('utf-16-le')
        rows = []
        for i in range(4000):
            if i % 211 == 0:
                rows.append(json.dumps({'i': i, 'big': 'caf\u00e9 ' * 4000 + '\u00fc' * 30}, ensure_ascii=False))
            elif i % 3 == 0:
                rows.append(json.dumps({'i': i, 't': 'r\u00e9sum\u00e9 \u2615 \u65e5\u672c\u8a9e \U0001F600 ' * (i % 40)}, ensure_ascii=False))
            else:
                rows.append(json.dumps({'i': i, 't': 'x' * (i % 1500)}))
        text = ''.join(row + '\r\n' for row in rows)
        open(os.path.join(work, 'big.jsonl'), 'w', encoding='utf-8', newline='').write(text)
        size = os.path.getsize(os.path.join(work, 'big.jsonl'))
        assert size >= 3_000_000, size
        lines = text.split('\n')
        if lines[-1] == '':
            lines.pop()
        want = ''.join(utf16_cut(line, 20000) + '\n' for line in lines[-600:])
        answer, tail_ms = helper('tail', {'path': w('big.jsonl'), 'lines': 600, 'width': 20000})
        assert answer['ok'] is True and answer['dropped'] == 0, {k: v for k, v in answer.items() if k != 'text'}
        assert answer['text'] == want, (len(answer['text']), len(want))
        # the file script's tail of the same file: Get-Content drops the \r, otherwise the same lines
        code, out, err = run('files.ps1', files, 'tail', w('big.jsonl'), '600', '20000')
        assert code == 0 and out == want.replace('\r\n', '\n'), (code, err[:200])
        # filesNewerThan: the same files as NEWER_PS1 over the same tree, the junction out of it neither followed nor
        # listed, paths in the stored C:/... form, mtimes in ms; a missing folder is a fixed code
        answer, newer_ms = helper('filesNewerThan', {'dir': w('newer'), 'since': T, 'max': 200})
        assert answer['ok'] is True and answer['total'] == 3, answer
        assert [(one['path'][len(w('newer')) + 1:], one['mtimeMs']) for one in answer['files']] == want_newer, answer
        assert 'outside' not in json.dumps(answer), answer
        answer, _ = helper('filesNewerThan', {'dir': w('newer'), 'since': T, 'max': 1})
        assert answer['total'] == 3 and len(answer['files']) == 1, answer
        answer, _ = helper('filesNewerThan', {'dir': w('no such folder'), 'since': T, 'max': 1})
        assert answer == {'ok': False, 'code': 'NOT_FOUND'}, answer
        # a batch of 20 file operations in one process, in order; timed against 20 helper runs and 20 file-script runs
        def batch_ops(n):
            ops = []
            for k in range(5):
                ops += [{'op': 'writeAtomic', 'path': w(f'b{n}/reg.json'), 'text': f'[{k}]\n'},
                        {'op': 'append', 'path': w(f'b{n}/log.jsonl'), 'text': f'{{"k":{k}}}\n'},
                        {'op': 'tail', 'path': w(f'b{n}/log.jsonl'), 'lines': 2, 'width': 100},
                        {'op': 'rotate', 'path': w(f'b{n}/log.jsonl'), 'adding': 1, 'maxBytes': 1000, 'moves': [[w(f'b{n}/log.jsonl'), w(f'b{n}/log.jsonl.1')]]}]
            return ops
        batch_ms = []
        for n in range(5):
            answer, took = helper('batch', {'ops': batch_ops(n)})
            assert answer['ok'] is True and len(answer['results']) == 20, answer
            assert answer['results'][18]['text'] == '{"k":3}\n{"k":4}\n' and get(f'b{n}/reg.json') == '[4]\n', answer['results'][18]
            batch_ms.append(took)
        single_ms = []
        for step in batch_ops(9):
            answer, took = helper(step['op'], {key: value for key, value in step.items() if key != 'op'})
            assert answer['ok'] is True, answer
            single_ms.append(took)
        ps_ms = []
        put('ps.log', '')
        for k in range(20):
            put('ps.add', f'{{"k":{k}}}\n')
            started = time.perf_counter()
            code, out, err = run('files.ps1', files, 'append', w('ps.add'), w('ps.log'))
            ps_ms.append((time.perf_counter() - started) * 1000)
            assert code == 0, err
        print(f'windows-helper-selftest: ok (node {version}; rename over a held file {held_ms:.0f} ms; tail of {size / 1e6:.1f} MB {tail_ms:.0f} ms; filesNewerThan {newer_ms:.0f} ms; '
              f'a batch of 20 operations: median {statistics.median(batch_ms):.0f} ms per batch (runs {", ".join(f"{one:.0f}" for one in batch_ms)}); '
              f'the same 20 as single helper runs {sum(single_ms):.0f} ms in all (median {statistics.median(single_ms):.0f} ms each); '
              f'20 file-script appends {sum(ps_ms):.0f} ms in all (median {statistics.median(ps_ms):.0f} ms each); timed from WSL through interop)')
finally:
    shutil.rmtree(work)
