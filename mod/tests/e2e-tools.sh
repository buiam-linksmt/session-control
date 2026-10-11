#!/bin/sh
# End-to-end test of the six read-only inspection tools of the session-control mod against the real claude, in a
# scratch directory it makes and removes. It seeds a scratch registry with three finished sessions (a clean one with
# its result file; a chatter one whose result file says "Done." and whose transcript holds the real report; one whose
# cwd is the scratch root, which holds the orchestrator directory and the registry), their transcripts under a scratch
# config directory, run files, a queue with one stale and one fine task, an open point raised ten days ago, a
# decisions section and two backups of one kind. A headless haiku orchestrator (capped at --max-budget-usd 0.25) is
# asked to call each tool once and to answer with their outputs verbatim; each output is then read from the
# orchestrator's own transcript and checked against the seeded data, and no output, no answer and no trace line may
# hold the canary secret. The orphan row is the orchestrator itself, a live claude -p no registry entry claims; the
# other live claude processes of the machine show as they are and are never touched.
# Everything the mod reads or writes is in the scratch directory (registry, helper files, runs directory, trace); the
# real registry, helper files and runs directory are never touched, and the licence picker option is empty. The
# orchestrator runs under the default configuration (this shell's CLAUDE_CONFIG_DIR, else ~/.claude): its transcript
# stays there. POSIX sh and jq: sh mod/tests/e2e-tools.sh. One line per check; exit 1 on a failure. KEEP_OUT=<dir>
# copies the six outputs there before the scratch directory goes.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
info() { printf 'info %s\n' "$1"; }

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
command -v jq >/dev/null 2>&1 || { fail 'jq is on the PATH'; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e-tools.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
CFG=$S/cfg
RUNS=$S/runs
REG=$S/headless-sessions.json
TRACE=$RUNS/trace.log
CFG_DEFAULT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
# A text the trace's redaction takes for a key: no output may show it.
# Joined from two parts, so the file holds no complete key-shaped string.
CANARY="sk-""e2ecanary0123456789abcdef"
OPID=''

ours() { [ -n "$1" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q "$S"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

NOW=$(date +%s)
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z; }
sanitized() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
SID_CLEAN=e2e0c1ea-1111-4111-8111-111111111111
SID_CHATTER=e2e0c4a7-2222-4222-8222-222222222222
SID_WRITER=e2e0e7e7-3333-4333-8333-333333333333
mkdir -p "$ORCH/backups" "$CFG" "$RUNS" "$S/work-clean" "$S/work-chatter" "$S/work" "$S/.git"

# ---------------------------------------------------------------- the seeded files
printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control tools test: do exactly what the prompt says.' > "$ORCH/CLAUDE.md"
jq -n '{tasks: [{id: "e2e-stale", title: "E2E stale task", status: "blocked"}, {id: "e2e-fine", title: "E2E fine task", status: "queued"}]}' > "$ORCH/task-queue.json"
RAISED=$(date -d '10 days ago' +%Y-%m-%d)
jq -n --arg raised "$RAISED" '{points: [{id: "e2e-point", status: "open", raised: $raised, title: "E2E open point about the parser", detail: "Seeded by the test.", recommendation: "Close it."}]}' > "$ORCH/open-points.json"
printf '%s\n' '# Agreed decisions' '' '## E2E unit - branch feature/e2e-gone' '1. a decision of a closed unit' > "$ORCH/agreed-decisions.md"
printf '%s\n' '# Open points archive' > "$ORCH/open-points-archive.md"
printf 'old\n' > "$ORCH/backups/task-queue-before-queue-task-2026-01-01.json"
touch -d '5 days ago' "$ORCH/backups/task-queue-before-queue-task-2026-01-01.json"
printf 'new\n' > "$ORCH/backups/task-queue-before-queue-task-2026-01-09.json"

REPORT="## Final report of the clean worker\nThe parser is done; 14 tests pass. A key $CANARY was found in an old fixture and is reported as an open point."
jq -n --arg r "$(printf "$REPORT")" '{type: "result", subtype: "success", is_error: false, result: $r, total_cost_usd: 0.42, duration_ms: 312000, num_turns: 41}' > "$RUNS/clean.json"
: > "$RUNS/clean.err"
jq -n '{type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 7.2, duration_ms: 1800000, num_turns: 60}' > "$RUNS/chatter.json"
printf '{}\n' > "$RUNS/20250101000000-loose.json"
touch -d '3 days ago' "$RUNS/20250101000000-loose.json"

transcript() { _d="$CFG/projects/$(sanitized "$1")"; mkdir -p "$_d"; printf '%s\n' "$_d/$2.jsonl"; }
REAL="E2E-REAL-REPORT-MARKER: the suite was rewritten and every case passes; the branch is pushed to both remotes. The token $CANARY sat in .env.example and is reported. $(printf 'More detail of the real report. %.0s' 1 2 3 4 5 6)"
T_CHATTER=$(transcript "$S/work-chatter" "$SID_CHATTER")
{
  jq -nc --arg at "$(iso $((NOW - 1800)))" '{type: "user", timestamp: $at, message: {content: "Do the work."}}'
  jq -nc --arg at "$(iso $((NOW - 1790)))" '{type: "assistant", timestamp: $at, message: {id: "m1", content: [{type: "text", text: "Starting."}]}}'
  jq -nc --arg at "$(iso $((NOW - 1700)))" --arg t "$REAL" '{type: "assistant", timestamp: $at, message: {id: "m2", content: [{type: "text", text: $t}]}}'
  jq -nc --arg at "$(iso $((NOW - 1690)))" '{type: "user", timestamp: $at, message: {content: [{type: "tool_result", tool_use_id: "x", content: "<task-notification>done</task-notification>"}]}}'
  jq -nc --arg at "$(iso $((NOW - 1680)))" '{type: "assistant", timestamp: $at, message: {id: "m3", content: [{type: "text", text: "Done."}]}}'
} > "$T_CHATTER"
T_CLEAN=$(transcript "$S/work-clean" "$SID_CLEAN")
jq -nc --arg at "$(iso $((NOW - 7200)))" '{type: "user", timestamp: $at, message: {content: "Go."}}' > "$T_CLEAN"
# The writer's transcript starts 10 minutes ago and edits a helper file of the orchestrator directory.
T_WRITER=$(transcript "$S" "$SID_WRITER")
{
  jq -nc --arg at "$(iso $((NOW - 600)))" '{type: "user", timestamp: $at, message: {content: "Write things."}}'
  jq -nc --arg at "$(iso $((NOW - 590)))" --arg f "$ORCH/open-points.json" '{type: "assistant", timestamp: $at, message: {id: "w1", content: [{type: "tool_use", id: "t1", name: "Edit", input: {file_path: $f, old_string: "a", new_string: "b"}}]}}'
} > "$T_WRITER"
# Under the writer's cwd: one file before its start, one after, one inside a .git folder.
printf 'x\n' > "$S/work/old.txt"
touch -d '1 hour ago' "$S/work/old.txt"
printf 'x\n' > "$S/work/new.txt"
printf 'x\n' > "$S/.git/index"

jq -n --arg cfg "$CFG" --arg s "$S" --arg runs "$RUNS" --argjson now "$NOW" \
  --arg c "$SID_CLEAN" --arg h "$SID_CHATTER" --arg w "$SID_WRITER" '[
  {title: "e2e clean worker", session_id: $c, name: "w-e2e-clean-1", config_dir: $cfg, cwd: ($s + "/work-clean"), model: "haiku", effort: "low",
   reported: true, result_file: ($runs + "/clean.json"), err_file: ($runs + "/clean.err"), started_at: ($now - 7200), ended_at: ($now - 6900),
   outcome: {kind: "clean", summary: "clean: The parser is done; 14 tests pass.", costUsd: 0.42}},
  {title: "e2e chatter worker", session_id: $h, config_dir: $cfg, cwd: ($s + "/work-chatter"), model: "sonnet", effort: "medium",
   reported: false, result_file: ($runs + "/chatter.json"), started_at: ($now - 1800), ended_at: ($now - 1600),
   outcome: {kind: "chatter", summary: "chatter: short result \"Done.\" after a substantial run", costUsd: 7.2}},
  {title: "e2e writer", session_id: $w, config_dir: $cfg, cwd: $s, model: "opus", effort: "high", reported: true, keep: true, started_at: ($now - 600), ended_at: ($now - 300)}
]' > "$REG"

SETTINGS=$(jq -nc --arg o "$ORCH" --arg r "$REG" --arg runs "$RUNS" '{pluginConfigs: {"session-control@inline": {options: {orchestratorDir: $o, registryPath: $r, runsDir: $runs, licencePickCommand: "", completionWrites: true, pollSeconds: 2, debug: false}}}}')
cat > "$S/instruction.txt" <<EOF
This is an automated test of the session-control mod's read-only tools. Use no other tool than these six, each exactly once, in this order (you may call them all in one turn):
1. mcp__session-control__list_sessions with no input.
2. mcp__session-control__read_result with session_id "$SID_CHATTER".
3. mcp__session-control__worker_tail with session_id "$SID_CHATTER" and lines 5.
4. mcp__session-control__session_writes with session_id "$SID_WRITER".
5. mcp__session-control__panel_snapshot with no input.
6. mcp__session-control__audit_state with no input.
Then answer with the six outputs verbatim, each after a line "=== <tool name> ===" (the short name, for example "=== list_sessions ==="), and nothing else.
EOF

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

# Each tool's output as the tool returned it, from the transcript's tool_result of its first call.
out() {
  _id=$(jq -r --arg n "mcp__session-control__$1" 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == $n) | .id' "$OT" 2>/dev/null | head -n 1)
  [ -n "$_id" ] || return 1
  jq -r --arg id "$_id" 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .tool_use_id == $id) | .content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end' "$OT" > "$S/out-$1.txt" 2>/dev/null
  [ -s "$S/out-$1.txt" ]
}
has() { grep -F -q -- "$2" "$S/out-$1.txt"; }
check() { if has "$1" "$2"; then pass "$1: $3"; else fail "$1: $3 (missing: $2)"; fi; }
lacks() { if has "$1" "$2"; then fail "$1: $3 (found: $2)"; else pass "$1: $3"; fi; }
for t in list_sessions read_result worker_tail session_writes panel_snapshot audit_state; do
  if out "$t"; then pass "$t was called and answered ($(wc -c < "$S/out-$t.txt" | tr -d ' ') bytes)"; else fail "$t was called and answered"; : > "$S/out-$t.txt"; fi
done
CALLS=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$OT" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')
info "tool calls of the orchestrator: $CALLS"

# ---------------------------------------------------------------- each output against the seeded data
check list_sessions 'session rows:' 'the count line comes first'
[ "$(head -n 1 "$S/out-list_sessions.txt" | grep -c 'session rows*:')" = 1 ] && pass 'list_sessions: the first line is the count' || fail 'list_sessions: the first line is the count'
check list_sessions "- finished | e2e clean worker | session_id $SID_CLEAN | name w-e2e-clean-1 | pid - | elapsed 5m00s | model haiku/low | cwd $S/work-clean | config_dir $CFG | outcome clean (clean: The parser is done; 14 tests pass.) | cost USD 0.42" 'the clean row with every field'
check list_sessions "- finished-unreported | e2e chatter worker | session_id $SID_CHATTER |" 'the chatter row, finished-unreported'
check list_sessions "| e2e writer | session_id $SID_WRITER |" 'the writer row'
check list_sessions "| cwd $ORCH | config_dir " 'the orchestrator itself is an orphan row (a live claude -p no entry claims), with its cwd'

check read_result 'source: the transcript, its last substantial assistant message' 'the chatter fallback reads the transcript'
check read_result 'because the result file .result is chatter (Done.)' 'it says why'
check read_result 'outcome: chatter: short result "Done." after a substantial run' 'the outcome label'
check read_result 'run: cost USD 7.20, duration 30m00s, turns 60, is_error false, subtype success' 'cost, duration, turns, is_error, subtype'
check read_result 'redaction: 1 replacement' 'the redaction count'
check read_result 'E2E-REAL-REPORT-MARKER' 'the real report, not the chatter'
check read_result 'truncated: no' 'no truncation said'

check worker_tail "worker_tail for session $SID_CHATTER" 'the session named'
check worker_tail 'process: not alive (no pid recorded' 'the process state'
check worker_tail ' s ago' 'the transcript age in seconds'
check worker_tail 'last 4 lines (of 5 asked)' 'the summarised lines, as many as there are'
check worker_tail '  < <task-notification>done</task-notification>' 'a tool result as the log pane shows it'

check session_writes "since: $(iso $((NOW - 600)) | sed 's/\.000Z$/Z/') (the transcript's first timestamp" 'the start is the first transcript timestamp'
check session_writes "  $ORCH/task-queue.json  [ORCHESTRATOR DIR]" 'a helper file under the orchestrator directory is flagged'
check session_writes "  $REG  [REGISTRY]" 'the registry is flagged'
check session_writes "  $S/work/new.txt" 'a file written after the start is listed'
lacks session_writes "$S/work/old.txt" 'a file older than the start is not'
lacks session_writes "$S/.git/" 'nothing under .git'
check session_writes "- Edit of $ORCH/open-points.json" "the transcript's own write under the orchestrator directory"

check panel_snapshot 'SESSIONS' 'the sessions section'
check panel_snapshot 'e2e chatter worker' 'a session row'
check panel_snapshot 'QUEUED WORK' 'the queued work section'
check panel_snapshot "$(printf '\342\200\242') E2E fine task" 'the fine task'
lacks panel_snapshot 'E2E stale task' 'the stale task (status blocked) is not queued work'
check panel_snapshot '1. E2E open point about the parser' 'the open point'

check audit_state 'nothing was changed.' 'the count line'
check audit_state '[high] queue-status | task e2e-stale "E2E stale task" | status "blocked" is not exactly queued, running or done' 'the stale queue entry'
lacks audit_state 'task e2e-fine' 'the fine queue entry is no finding'
check audit_state "[medium] unacknowledged | session ${SID_CHATTER%%-*} \"e2e chatter worker\"" 'the unacknowledged chatter session'
check audit_state "[medium] retirable | session ${SID_CLEAN%%-*} \"e2e clean worker\"" 'the retirable clean session'
check audit_state '[medium] open-point-old | open point e2e-point' 'the open point raised ten days ago'
check audit_state '[low] backups | backups of kind task-queue-before-queue-task.json | 2 files; 1 is older than 2 days besides the newest' 'the spent backup'
check audit_state '20250101000000-loose.json' 'the run file no entry names'
check audit_state '"E2E unit - branch feature/e2e-gone"' 'the decision section of a closed unit'
lacks audit_state 'git-' 'git is silent: the scratch directory is no repository'

# ---------------------------------------------------------------- no secret anywhere; the trace keeps no report text
LEAK=''
for f in "$S"/out-*.txt "$S/orchestrator.json" "$TRACE"; do grep -F -q -- "$CANARY" "$f" 2>/dev/null && LEAK="$LEAK $(basename "$f")"; done
[ -z "$LEAK" ] && pass 'the canary secret is in no output, no answer and no trace line' || fail "the canary secret leaked into:$LEAK"
if grep -F -q 'E2E-REAL-REPORT-MARKER' "$TRACE" 2>/dev/null; then fail 'the trace holds no report text'; else pass 'the trace holds no report text'; fi
if grep -F -q '"event":"tool.result","tool":"read_result","resultChars":' "$TRACE" 2>/dev/null; then pass 'the trace has the length of the answer only'; else fail 'the trace has the length of the answer only'; fi
NODE_MAJOR=$(node --version 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p')
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 22 ]; then
  if grep -F -q '"event":"process.run","helper":"filesNewerThan"' "$TRACE" && ! grep -F -q '"event":"helper.fallback"' "$TRACE"; then pass 'the listing ran through the Node helper, no fallback'; else fail 'the listing ran through the Node helper, no fallback'; fi
fi
# The answer: the six outputs verbatim, each after its line.
jq -r '.result // ""' "$S/orchestrator.json" > "$S/answer.txt" 2>/dev/null
N=0
for t in list_sessions read_result worker_tail session_writes panel_snapshot audit_state; do
  grep -E -q "=== (mcp__session-control__)?$t ===" "$S/answer.txt" && grep -F -q -- "$(head -n 1 "$S/out-$t.txt")" "$S/answer.txt" && N=$((N + 1))
done
[ "$N" = 6 ] && pass 'the answer gives the six outputs, each after its line' || info "the answer gives $N of the six outputs with their first line verbatim (the model's copy, not the tools')"
# Nothing changed by the tools: the seeded helper files are as written (the mod creates none: all are there).
if jq -e '.tasks | length == 2' "$ORCH/task-queue.json" >/dev/null && jq -e 'length == 3' "$REG" >/dev/null && [ "$(ls "$ORCH/backups" | wc -l)" -eq 2 ]; then pass 'the queue, the registry and backups/ are as seeded'; else fail 'the queue, the registry and backups/ are as seeded'; fi
if [ -n "${KEEP_OUT:-}" ]; then mkdir -p "$KEEP_OUT" && cp "$S"/out-*.txt "$S/answer.txt" "$KEEP_OUT"/ && info "outputs copied to $KEEP_OUT"; fi

LEFT=$(ps -eo pid,args 2>/dev/null | grep -F "$S" | grep -v -e grep -e 'e2e-tools' | head -n 3)
[ -z "$LEFT" ] && pass 'no process names the scratch directory' || fail "no process names the scratch directory: $LEFT"
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
