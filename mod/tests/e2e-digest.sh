#!/bin/sh
# End-to-end test of turn_digest against the real claude, in a scratch directory it makes and removes. It seeds a
# scratch registry with one worker whose recorded pid is gone and whose result file is a clean report (the first poll
# harvests it), a queue task waiting for that worker, and an open point raised ten days ago. A headless haiku
# orchestrator (capped at --max-budget-usd 0.25) calls turn_digest twice in a row and answers with both outputs; each
# output is read from the orchestrator's own transcript: the first reports from the mod's load (the completion, the
# ready task, the aged point, the notices by kind, the state line), the second has nothing new; no output and no trace
# line holds the canary secret seeded in the worker's title, and the tool wrote no file.
# Everything the mod reads or writes is in the scratch directory (registry, helper files, runs directory, trace); the
# real registry, helper files and runs directory are never touched, and the licence picker option is empty. The
# orchestrator runs under the default configuration (this shell's CLAUDE_CONFIG_DIR, else ~/.claude): its transcript
# stays there. POSIX sh and jq: sh mod/tests/e2e-digest.sh. One line per check; exit 1 on a failure. KEEP_OUT=<dir>
# copies the two outputs there before the scratch directory goes.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
info() { printf 'info %s\n' "$1"; }

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
command -v jq >/dev/null 2>&1 || { fail 'jq is on the PATH'; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e-digest.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
RUNS=$S/runs
REG=$S/headless-sessions.json
TRACE=$RUNS/trace.log
CFG_DEFAULT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
# A text the redaction takes for a key: no output may show it.
CANARY=sk-e2ecanary0123456789digest
OPID=''

ours() { [ -n "$1" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q "$S"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

SID_DONE=e2e0d16e-1111-4111-8111-111111111111
# A pid no process has: the worker's recorded pid is gone, so the first poll harvests it.
DEAD=4194000
while [ -d "/proc/$DEAD" ]; do DEAD=$((DEAD + 1)); done
mkdir -p "$ORCH" "$RUNS" "$S/work"

printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control turn_digest test: do exactly what the prompt says.' > "$ORCH/CLAUDE.md"
jq -n '{tasks: [{id: "e2e-next", title: "E2E next step", status: "queued", waits_for: "w-e2e-digest-worker-1 to finish"}]}' > "$ORCH/task-queue.json"
RAISED=$(date -d '10 days ago' +%Y-%m-%d)
jq -n --arg raised "$RAISED" '{points: [{id: "e2e-old-point", status: "open", raised: $raised, title: "E2E point waiting for the user", detail: "Seeded by the test.", recommendation: "Close it."}]}' > "$ORCH/open-points.json"
printf '%s\n' '# Agreed decisions' > "$ORCH/agreed-decisions.md"
printf '%s\n' '# Open points archive' > "$ORCH/open-points-archive.md"
jq -n '{type: "result", subtype: "success", is_error: false, result: "## Report\nThe digest worker is done; 3 tests pass.\n\ngit status -sb\n## main...origin/main\nexit 0\ngit log --oneline @{u}..HEAD\nexit 0", total_cost_usd: 0.01, duration_ms: 4000, num_turns: 2}' > "$RUNS/done.json"
: > "$RUNS/done.err"
jq -n --arg s "$S" --arg runs "$RUNS" --arg sid "$SID_DONE" --argjson pid "$DEAD" --arg cfg "$CFG_DEFAULT" --arg title "e2e digest worker $CANARY" '[
  {title: $title, pid: $pid, session_id: $sid, name: "w-e2e-digest-worker-1", config_dir: $cfg, cwd: ($s + "/work"), model: "haiku", effort: "low",
   result_file: ($runs + "/done.json"), err_file: ($runs + "/done.err"), started_at: ((now | floor) - 60)}
]' > "$REG"

SETTINGS=$(jq -nc --arg o "$ORCH" --arg r "$REG" --arg runs "$RUNS" '{pluginConfigs: {"session-control@inline": {options: {orchestratorDir: $o, registryPath: $r, runsDir: $runs, licencePickCommand: "", completionWrites: true, pollSeconds: 2, debug: false}}}}')
cat > "$S/instruction.txt" <<EOF
This is an automated test of the session-control mod's turn_digest tool. Do exactly this and nothing else:
1. Call mcp__session-control__turn_digest with no input.
2. Right after it answers, call mcp__session-control__turn_digest again with no input.
Use no other tool. Then answer with the two outputs verbatim, the first after a line "=== first ===" and the second after a line "=== second ===", and nothing else.
EOF
find "$S" -type f | sort > "$S/files-before.txt"

# ---------------------------------------------------------------- the orchestrator
(cd "$ORCH" && SESSION_CONTROL_DEBUG=1 exec claude -p --plugin-dir "$MOD" --model haiku --dangerously-skip-permissions \
  --max-budget-usd 0.25 --output-format json --settings "$SETTINGS" < "$S/instruction.txt" > "$S/orchestrator.json" 2> "$S/orchestrator.err") &
OPID=$!
elapsed=0
while kill -0 "$OPID" 2>/dev/null && [ "$elapsed" -lt 300 ]; do sleep 1; elapsed=$((elapsed + 1)); done
if kill -0 "$OPID" 2>/dev/null; then
  fail 'orchestrator finished within 300 s'
  kill "$OPID" 2>/dev/null
  wait "$OPID" 2>/dev/null
else
  wait "$OPID"
  code=$?
  if [ "$code" -eq 0 ] && jq -e '.is_error == false' "$S/orchestrator.json" >/dev/null 2>&1; then pass "orchestrator finished in ${elapsed} s, exit 0"; else fail "orchestrator finished, exit $code: $(head -c 300 "$S/orchestrator.err" "$S/orchestrator.json" 2>/dev/null | tr '\n' ' ')"; fi
fi
OPID=''
OSID=$(jq -r '.session_id // empty' "$S/orchestrator.json" 2>/dev/null)
info "orchestrator cost USD $(jq -r '.total_cost_usd // "?"' "$S/orchestrator.json" 2>/dev/null), session $OSID (config dir $CFG_DEFAULT, cwd $ORCH)"
OT=$(ls "$CFG_DEFAULT"/projects/*/"$OSID".jsonl 2>/dev/null | head -n 1)
[ -n "$OSID" ] && [ -f "$OT" ] && pass "orchestrator transcript found ($OT)" || fail "orchestrator transcript found (session '$OSID')"

# The outputs of the tool's calls as the tool returned them, from the transcript's tool_results, in order.
IDS=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == "mcp__session-control__turn_digest") | .id' "$OT" 2>/dev/null)
N=0
for id in $IDS; do
  N=$((N + 1))
  jq -r --arg id "$id" 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .tool_use_id == $id) | .content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end' "$OT" > "$S/out-$N.txt" 2>/dev/null
done
[ "$N" = 2 ] && pass 'turn_digest was called twice' || fail "turn_digest was called twice (called $N times)"
OTHER=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name != "mcp__session-control__turn_digest") | .name' "$OT" 2>/dev/null | sort -u | tr '\n' ' ')
[ -z "$OTHER" ] && pass 'no other tool was called' || info "other tools the orchestrator called: $OTHER"
for n in 1 2; do [ -s "$S/out-$n.txt" ] || : > "$S/out-$n.txt"; done
info "first output:"; sed 's/^/  | /' "$S/out-1.txt"
info "second output:"; sed 's/^/  | /' "$S/out-2.txt"

has() { grep -F -q -- "$2" "$S/out-$1.txt"; }
check() { if has "$1" "$2"; then pass "call $1: $3"; else fail "call $1: $3 (missing: $2)"; fi; }
lacks() { if has "$1" "$2"; then fail "call $1: $3 (found: $2)"; else pass "call $1: $3"; fi; }

FIRST_HEAD=$(head -n 1 "$S/out-1.txt")
case "$FIRST_HEAD" in "turn_digest: since the mod's load at "*"; first call)") pass "call 1: reports from the mod's load ($FIRST_HEAD)" ;; *) fail "call 1: reports from the mod's load (got '$FIRST_HEAD')" ;; esac
check 1 'worker completions harvested: 1' 'the harvested completion counted'
check 1 '- e2e digest worker [redacted]: clean' "the completion's line, its title redacted"
check 1 'queue tasks that became ready: 1' 'the ready task counted'
check 1 '- queued task e2e-next waited for w-e2e-digest-worker-1, which finished' "the ready task's line"
check 1 'open points that aged past 24 h: 1' 'the aged point counted'
check 1 '- open point e2e-old-point' "the aged point's line"
check 1 'notices fired: ' 'the notices by kind and count'
check 1 'queue-ready 1' 'queue-ready counted'
check 1 'open-point-age 1' 'open-point-age counted'
[ "$(tail -n 1 "$S/out-1.txt")" = 'state: 0 alive, 1 finished; queue 1 queued, 0 running; 1 open point' ] && pass 'call 1: the state line last' || fail "call 1: the state line last (got '$(tail -n 1 "$S/out-1.txt")')"
[ "$(wc -l < "$S/out-1.txt")" -le 40 ] && pass "call 1: at most 40 lines ($(wc -l < "$S/out-1.txt" | tr -d ' '))" || fail 'call 1: at most 40 lines'

SECOND_HEAD=$(head -n 1 "$S/out-2.txt")
case "$SECOND_HEAD" in "turn_digest: since the last call at "*" ago)") pass "call 2: since the last call ($SECOND_HEAD)" ;; *) fail "call 2: since the last call (got '$SECOND_HEAD')" ;; esac
[ "$(sed -n 2p "$S/out-2.txt")" = 'nothing new' ] && pass 'call 2: nothing new' || fail "call 2: nothing new (got '$(sed -n 2p "$S/out-2.txt")')"
lacks 2 'worker completions harvested' 'the completion is not reported again'
lacks 2 'notices fired' 'no notice reported again'
[ "$(wc -l < "$S/out-2.txt")" -eq 3 ] && pass 'call 2: three lines (since, nothing new, the state line)' || fail "call 2: three lines (got $(wc -l < "$S/out-2.txt"))"

# ---------------------------------------------------------------- no secret; no file written by the tool
LEAK=''
for f in "$S"/out-*.txt "$S/orchestrator.json" "$TRACE"; do grep -F -q -- "$CANARY" "$f" 2>/dev/null && LEAK="$LEAK $(basename "$f")"; done
[ -z "$LEAK" ] && pass 'the canary secret is in no output, no answer and no trace line' || fail "the canary secret leaked into:$LEAK"
if grep -F -q '"event":"tool.result","tool":"turn_digest","resultChars":' "$TRACE" 2>/dev/null; then pass 'the trace has the length of the answers only'; else fail 'the trace has the length of the answers only'; fi
DIGEST_LINES=$(grep -c '"event":"digest"' "$TRACE" 2>/dev/null)
[ "$DIGEST_LINES" = 2 ] && pass 'the trace has one digest line per call (counts only)' || fail "the trace has one digest line per call (got $DIGEST_LINES)"
# The files written during the run: the registry (the completion merged), the trace, a backup of the registry, and
# what the board makes at its start; none by turn_digest, which keeps its time in the engine's store.
find "$S" -type f | sort > "$S/files-after.txt"
NEW=$(comm -13 "$S/files-before.txt" "$S/files-after.txt" | grep -v -e '/runs/trace\.log' -e '/orch/backups/' -e '/files-before\.txt$' -e '/files-after\.txt$' -e '/orchestrator\.\(json\|err\)$' -e '/out-[12]\.txt$')
[ -z "$NEW" ] && pass 'no file besides the trace, the registry backup and the run outputs was created' || fail "no file besides the trace, the registry backup and the run outputs was created: $NEW"
if grep -F -q '"event":"tool.call","tool":"turn_digest"' "$TRACE" 2>/dev/null && ! awk '/"event":"tool.call","tool":"turn_digest"/{on=1} /"event":"tool.result","tool":"turn_digest"/{on=0} on && /"event":"fs\.(write|append)"|"helper":"(writeAtomic|append)"/{found=1} END{exit !found}' "$TRACE"; then pass 'the trace shows no write between a turn_digest call and its answer'; else fail 'the trace shows no write between a turn_digest call and its answer'; fi
jq -e 'length == 1 and .[0].outcome.kind == "clean"' "$REG" >/dev/null 2>&1 && pass 'the registry holds the harvested entry, outcome clean' || fail 'the registry holds the harvested entry, outcome clean'
if [ -n "${KEEP_OUT:-}" ]; then mkdir -p "$KEEP_OUT" && cp "$S"/out-*.txt "$KEEP_OUT"/ && info "outputs copied to $KEEP_OUT"; fi

LEFT=$(ps -eo pid,args 2>/dev/null | grep -F "$S" | grep -v -e grep -e 'e2e-digest' | head -n 3)
[ -z "$LEFT" ] && pass 'no process names the scratch directory' || fail "no process names the scratch directory: $LEFT"
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
