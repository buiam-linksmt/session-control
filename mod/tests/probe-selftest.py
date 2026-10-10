#!/usr/bin/env python3
"""Run with `python3 -I tests/probe-selftest.py` from the plugin folder.

Extracts PROBE_SCRIPT from hooks/core.ts, checks it parses under `sh -n` and runs it against a
fixture config dir: a transcript with a known mtime and a sessions file whose procStart matches this
process. The plugin tests cannot import node modules, so this check lives beside them."""
import ast, os, subprocess, sys, tempfile, json

src = open(os.path.join(os.path.dirname(__file__), '..', 'hooks', 'core.ts')).read()
body = src.split("export const PROBE_SCRIPT = [", 1)[1].split("].join('\\n')", 1)[0]
script = '\n'.join(ast.literal_eval(l.strip().rstrip(',')) for l in body.strip().splitlines() if l.strip())

syntax = subprocess.run(['sh', '-n', '-c', script], capture_output=True, text=True)
assert syntax.returncode == 0, f'sh -n failed: {syntax.stderr}'

cfg = tempfile.mkdtemp(prefix='session-probe-')
sid = '11111111-2222-4333-8444-555555555555'
os.makedirs(f'{cfg}/projects/-some-cwd'); os.makedirs(f'{cfg}/sessions')
tr = f'{cfg}/projects/-some-cwd/{sid}.jsonl'
open(tr, 'w').write('{}\n'); os.utime(tr, (1_700_000_000, 1_700_000_000))
pid = os.getpid()
stat = open(f'/proc/{pid}/stat').read()
proc_start = stat.rsplit(') ', 1)[1].split(' ')[19]
json.dump({'sessionId': sid, 'procStart': proc_start}, open(f'{cfg}/sessions/{pid}.json', 'w'))

run = subprocess.run(['sh', '-c', script, 'session-probe', f't:{sid}|{cfg}', f'pid:{pid}|{cfg}'], capture_output=True, text=True, timeout=60)
assert run.returncode == 0 and run.stderr == '', f'probe failed: {run.returncode} {run.stderr!r}'
assert f'T\t{sid}\t1700000000' in run.stdout, run.stdout
proof = [l for l in run.stdout.splitlines() if l.startswith(f'A\t{pid}\t')]
assert proof, run.stdout
cols = proof[0].split('\t')
assert cols[3] == proc_start and cols[4] == proc_start and cols[5] == sid, cols
print('probe-selftest: ok')

# --- the P lines carry elapsed seconds without `ps`
elapsed_run = subprocess.run(['sh', '-c', script, 'session-probe'], capture_output=True, text=True, timeout=60)
plines = [l.split('\t') for l in elapsed_run.stdout.splitlines() if l.startswith('P\t')]
assert plines, 'no claude process seen'
assert all(c[3].isdigit() for c in plines), plines

# --- REGISTER_SCRIPT appends and updates in place through a temp file and mv
raw = src.split("export const REGISTER_SCRIPT = String.raw`", 1)[1].split("`\n", 1)[0]
reg = os.path.join(tempfile.mkdtemp(prefix='session-reg-'), 'headless-sessions.json')
json.dump([{'session_id': 'old', 'title': 'x', 'reported': False, 'outcome': {'kind': 'clean'}, 'resume': {'keep': 1}, 'pid': None}], open(reg, 'w'))
new = {'title': 'n', 'pid': 7, 'session_id': 'new-sid', 'config_dir': '/c', 'cwd': '/w', 'model': 'm', 'effort': 'e'}
r1 = subprocess.run(['sh', '-c', raw, 'session-register', reg, json.dumps(new), 'new'], capture_output=True, text=True)
assert r1.returncode == 0, r1.stderr
data = json.load(open(reg))
assert [e['session_id'] for e in data] == ['old', 'new-sid'] and data[0]['resume'] == {'keep': 1}, data
upd = {'session_id': 'old', 'pid': 9, 'result_file': '/r.json'}
r2 = subprocess.run(['sh', '-c', raw, 'session-register', reg, json.dumps(upd), 'resume'], capture_output=True, text=True)
assert r2.returncode == 0, r2.stderr
data = json.load(open(reg))
assert data[0]['pid'] == 9 and data[0]['result_file'] == '/r.json' and 'reported' not in data[0] and 'outcome' not in data[0] and data[0]['resume'] == {'keep': 1}, data[0]
assert data[1]['session_id'] == 'new-sid', data
assert not [f for f in os.listdir(os.path.dirname(reg)) if '.tmp.' in f]
print('register-selftest: ok')



# Static guard: the user's engine (2.1.292) refuses a <Button> whose child is an element; a Button takes a label or one string.
import re as _re
_src = open(__file__.replace('tests/probe-selftest.py', 'hooks/register.tsx')).read()
for _m in _re.finditer(r'<Button\b[^>]*?(/>|>)', _src, _re.S):
    if _m.group(1) == '>':
        _after = _src[_m.end():_m.end() + 80].lstrip()
        assert not _after.startswith('<'), 'a <Button> holds an element child: ' + _after[:40]
print('button-shape-selftest: ok')

# --- CLEAR_SCRIPT removes the named sessions, logs them first, leaves the rest untouched
clear = src.split("export const CLEAR_SCRIPT = String.raw`", 1)[1].split("`\n", 1)[0].replace('\\n', '\n')
assert subprocess.run(['sh', '-n', '-c', clear], capture_output=True, text=True).returncode == 0
d = tempfile.mkdtemp(prefix='session-clear-')
reg, log = f'{d}/reg.json', f'{d}/cleared.jsonl'
json.dump([{'title': 'a', 'session_id': 'aaa', 'reported': False, 'resume': {'strikes': 2}},
           {'title': 'b', 'session_id': 'bbb', 'unknown': [1, 2]},
           {'title': 'c', 'session_id': 'ccc'}], open(reg, 'w'))
r = subprocess.run(['sh', '-c', clear, 'session-clear', reg, log, 'aaa', 'ccc'], capture_output=True, text=True, timeout=30)
assert r.returncode == 0 and r.stderr == '', r.stderr
left = json.load(open(reg))
assert [e['session_id'] for e in left] == ['bbb'] and left[0]['unknown'] == [1, 2], left
logged = [json.loads(l) for l in open(log)]
assert [e['session_id'] for e in logged] == ['aaa', 'ccc'] and logged[0]['resume'] == {'strikes': 2}, logged
assert not any(f.startswith('reg.json.tmp') for f in os.listdir(d))
nothing = subprocess.run(['sh', '-c', clear, 'session-clear', reg, log], capture_output=True, text=True, timeout=30)
assert nothing.returncode == 0 and json.load(open(reg)) == left
print('clear-selftest: ok')

# --- ACK_SCRIPT marks sessions acknowledged (and kept on request), leaving the rest untouched
ack = src.split("export const ACK_SCRIPT = String.raw`", 1)[1].split("`\n", 1)[0].replace('\\n', '\n')
assert subprocess.run(['sh', '-n', '-c', ack], capture_output=True, text=True).returncode == 0
d2 = tempfile.mkdtemp(prefix='session-ack-')
reg2 = f'{d2}/reg.json'
json.dump([{'title': 'a', 'session_id': 'aaa', 'reported': False, 'resume': {'strikes': 2}},
           {'title': 'b', 'session_id': 'bbb', 'reported': False}], open(reg2, 'w'))
r = subprocess.run(['sh', '-c', ack, 'session-ack', reg2, 'keep', 'aaa'], capture_output=True, text=True, timeout=30)
assert r.returncode == 0 and r.stderr == '', r.stderr
got = json.load(open(reg2))
assert got[0]['reported'] is True and got[0]['keep'] is True and got[0]['resume'] == {'strikes': 2}, got
assert got[1]['reported'] is False and 'keep' not in got[1], got
subprocess.run(['sh', '-c', ack, 'session-ack', reg2, 'plain', 'bbb'], capture_output=True, text=True, timeout=30)
got = json.load(open(reg2))
assert got[1]['reported'] is True and 'keep' not in got[1], got
subprocess.run(['sh', '-c', ack, 'session-ack', reg2, 'plain', 'aaa'], capture_output=True, text=True, timeout=30)
got = json.load(open(reg2))
assert got[0]['reported'] is True and 'keep' not in got[0], got
print('ack-selftest: ok')

# --- registry edits: REGISTER_SCRIPT, CLEAR_SCRIPT and ACK_SCRIPT against the differential cases the TypeScript
# edits are tested on (REGISTRY_GOLDEN in tests/fixtures.ts); together they prove both write the same bytes.
import shutil
fx = open(os.path.join(os.path.dirname(__file__), 'fixtures.ts'), encoding='utf-8').read()
golden_block = fx.split('// REGISTRY_GOLDEN:BEGIN', 1)[1].split('// REGISTRY_GOLDEN:END', 1)[0]
golden = json.loads(golden_block.split(' = ', 1)[1])
scripts = {
    'register': raw,
    'clear': clear,
    'ack': ack,
}
gold_dir = tempfile.mkdtemp(prefix='session-golden-')
try:
    for n, case in enumerate(golden):
        reg, log = f'{gold_dir}/{n}.json', f'{gold_dir}/{n}.cleared.jsonl'
        if case['registry'] is not None:
            open(reg, 'w', encoding='utf-8', newline='').write(case['registry'])
        if case['op'] == 'register':
            argv = ['session-register', reg, json.dumps(case['entry'], separators=(',', ':'), ensure_ascii=False), case['mode']]
        elif case['op'] == 'clear':
            argv = ['session-clear', reg, log, *case['ids']]
        else:
            argv = ['session-ack', reg, 'keep' if case['keep'] else 'plain', *case['ids']]
        r = subprocess.run(['sh', '-c', scripts[case['op']], *argv], capture_output=True, timeout=30)
        text = open(reg, encoding='utf-8', newline='').read() if os.path.exists(reg) else None
        logged = open(log, encoding='utf-8', newline='').read() if os.path.exists(log) else ''
        want = case.get('old') or case['expect']
        where = f"{case['name']}: exit {r.returncode}, {text!r:.200}, log {logged!r:.200}"
        if want.get('refused') or want.get('fails'):
            assert r.returncode != 0 and text == case['registry'], where
        elif want.get('unchanged'):
            assert r.returncode == 0 and text == case['registry'], where
        elif want.get('sameValue'):
            assert r.returncode == 0 and json.loads(text) == json.loads(case['expect']['text']), where
        else:
            assert r.returncode == 0 and text == want['text'], where
        assert logged == want.get('log', ''), where
finally:
    shutil.rmtree(gold_dir)
print(f'registry-golden-selftest: ok ({len(golden)} cases)')
