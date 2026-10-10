#!/usr/bin/env python3
"""Run with `python3 -I tests/windows-selftest.py` from WSL, where Windows PowerShell is reachable.

Extracts the Windows PowerShell scripts from hooks/core.ts, writes them to a scratch directory on the Windows
side and runs them through powershell.exe, the way the mod runs them on native Windows (absolute path, -File).
It proves the scripts' own behaviour on this host's PowerShell and file system only: not what the Windows engine
passes them, nor a real claude.exe. The scratch directory is a new folder under SC_WIN_SCRATCH (a Windows path)
or under the Windows %TEMP%, and is removed at the end. Without powershell.exe it prints `skipped`."""
import ast, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, '..', 'hooks', 'core.ts'), encoding='utf-8').read()
PS = shutil.which('powershell.exe') or '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
if not os.path.exists(PS):
    print('windows-selftest: skipped (no powershell.exe)')
    sys.exit(0)


def constant(name):
    """A `[...].join('\\r\\n')` constant of core.ts, as the text the mod writes."""
    body = SRC.split(f'export const {name} = [', 1)[1].split("].join('\\r\\n')", 1)[0]
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
    code, out, err = run('files.ps1', files, 'nonsense')
    assert code == 1 and 'unknown operation' in err, (code, err)
    print('windows-files-selftest: ok')

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
finally:
    shutil.rmtree(work)
