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
finally:
    shutil.rmtree(work)
