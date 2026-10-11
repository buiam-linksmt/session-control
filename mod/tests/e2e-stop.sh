#!/bin/sh
# End-to-end test of stop_worker against the real claude, in a scratch directory it makes and removes. A headless haiku
# orchestrator (capped at --max-budget-usd 0.25) launches one haiku worker through launch_worker whose task is to run
# foreground `sleep 20` calls for a few minutes, waits in the foreground until the scratch registry shows the worker
# alive with a `sleep` below it (the tree is recorded from /proc at that moment, with each start time), calls stop_worker
# on it, then on an unknown id and on a finished entry (both refused), and answers. From outside, /proc must show the
# worker pid and every process of its tree gone (or its pid with another start), while a bystander sleep of this script,
# the orchestrator itself and every other claude process alive before the stop are still there. The proof text the
# tool answered is read from the orchestrator's transcript and checked, and kept for the report with KEEP_OUT=<dir>.
# Everything the mod reads or writes is in the scratch directory (registry, helper files, runs directory, trace); the
# real registry is never touched and the licence picker option is empty: the worker inherits the default
# configuration, where both transcripts stay. POSIX sh, jq and Linux /proc: sh mod/tests/e2e-stop.sh. One line per
# check; exit 1 on a failure.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
info() { printf 'info %s\n' "$1"; }

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
command -v jq >/dev/null 2>&1 || { fail 'jq is on the PATH'; exit 1; }
[ -d /proc/self ] || { fail 'Linux /proc'; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e-stop.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
WORK=$S/work
RUNS=$S/runs
REG=$S/headless-sessions.json
TRACE=$RUNS/trace.log
CFG_DEFAULT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
OPID=''
BYSTANDER=''

start_of() { sed -n 's/^.*) //p' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
# A process of this test: its command line names the scratch directory (the orchestrator, the worker's shell).
ours() { [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q "$S"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  # The worker's tree as recorded, only while each pid still has its recorded start (never another process).
  if [ -f "$S/tree-before.txt" ]; then
    while read -r p st _; do [ -n "$p" ] && [ "$(start_of "$p")" = "$st" ] && kill -KILL "$p" 2>/dev/null; done < "$S/tree-before.txt"
  fi
  [ -n "$BYSTANDER" ] && [ "$(start_of "$BYSTANDER")" = "${BYSTANDER_START:-x}" ] && kill "$BYSTANDER" 2>/dev/null
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir -p "$ORCH" "$WORK" "$RUNS"
printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control stop_worker test: do exactly what the prompt says.' > "$ORCH/CLAUDE.md"
printf '%s\n' '# Agreed decisions' > "$ORCH/agreed-decisions.md"
jq -n '{tasks: []}' > "$ORCH/task-queue.json"
jq -n '{points: []}' > "$ORCH/open-points.json"
printf '%s\n' '# Open points archive' > "$ORCH/open-points-archive.md"
FIN=5f5f5f5f-0005-4005-8005-000000000005
jq -n --arg cwd "$WORK" --arg cfg "$CFG_DEFAULT" --arg f "$FIN" '[{title: "e2e finished entry", session_id: $f, config_dir: $cfg, cwd: $cwd, reported: true, outcome: {kind: "clean", summary: "clean: seeded"}}]' > "$REG"

# A bystander of this script's own, outside every tree the stop sees.
sleep 900 &
BYSTANDER=$!
BYSTANDER_START=$(start_of "$BYSTANDER")

# Waits until the worker is alive with a sleep below it, then records its tree (pid, start, name per line), the claude
# processes alive at that moment, and prints the worker's pid. A pid of the tree whose start cannot be read when it is
# recorded has ended meanwhile: it is no member of the tree and goes to tree-dropped.txt instead. The worker itself
# must still have its start, or the wait fails.
cat > "$S/wait-alive.sh" <<'EOF'
reg=$1; out=$2; n=0
start_of() { sed -n 's/^.*) //p' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
kids() { for d in /proc/[0-9]*; do pp=$(sed -n 's/^PPid:[[:space:]]*//p' "$d/status" 2>/dev/null); [ "$pp" = "$1" ] && echo "${d#/proc/}"; done; }
tree() { echo "$1"; for c in $(kids "$1"); do tree "$c"; done; }
while :; do
  n=$((n + 1)); [ "$n" -gt 120 ] && { echo 'the worker never showed a sleep'; exit 1; }
  pid=$(jq -r '(.[] | select(.title == "e2e sleeper")).pid // empty' "$reg" 2>/dev/null)
  if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
    t=$(tree "$pid")
    for p in $t; do [ "$(cat "/proc/$p/comm" 2>/dev/null)" = sleep ] && break 2; done
  fi
  sleep 2
done
: > "$out/tree-dropped.txt"
for p in $t; do
  st=$(start_of "$p")
  if [ -n "$st" ]; then printf '%s %s %s\n' "$p" "$st" "$(cat "/proc/$p/comm" 2>/dev/null)"; else echo "$p" >> "$out/tree-dropped.txt"; fi
done > "$out/tree-before.txt"
grep -q "^$pid " "$out/tree-before.txt" || { echo "the worker pid $pid ended while its tree was recorded"; exit 1; }
for d in /proc/[0-9]*; do [ "$(cat "$d/comm" 2>/dev/null)" = claude ] && printf '%s %s %s\n' "${d#/proc/}" "$(start_of "${d#/proc/}")" "$(tr '\0\n\t' '   ' < "$d/cmdline" 2>/dev/null | cut -d' ' -f1-3)"; done > "$out/claude-before.txt"
echo "worker pid $pid is alive with $(grep -c . "$out/tree-before.txt") processes in its tree, a sleep among them"
EOF
# The worker's descendants seen from outside after the tree was recorded, until the orchestrator has ended: about three
# times a second /proc is read, and a process whose parent is a member is a member (the members to start from: every
# recorded or already seen pid that still has its start). The new members go to tree-seen.txt (pid, start per line).
# A signal of the proof to a pid outside the recorded tree is excused only when this watch saw that pid in the tree: a
# child the worker spawned after the recording. It runs in the scratch directory, so no command line names it.
watch_tree() {
  cd "$S" || return 0
  while [ -e watch.on ]; do
    [ -s tree-before.txt ] && cat /proc/[0-9]*/stat 2>/dev/null | awk '
      BEGIN {
        while ((getline l < "tree-before.txt") > 0) { split(l, k, " "); want[k[1]] = k[2]; known[k[1]] = 1 }
        while ((getline l < "tree-seen.txt") > 0) { split(l, k, " "); want[k[1]] = k[2]; known[k[1]] = 1 }
      }
      { r = $0; sub(/^.*\) /, "", r); split(r, f, " "); par[$1] = f[2]; st[$1] = f[20] }
      END {
        for (p in want) if ((p in st) && st[p] == want[p]) mem[p] = 1
        do { n = 0; for (p in par) if (!(p in mem) && ((par[p]) in mem)) { mem[p] = 1; n++ } } while (n > 0)
        for (p in mem) if (!(p in known)) print p, st[p]
      }' >> tree-seen.txt
    sleep 0.3 2>/dev/null || sleep 1
  done
}
SETTINGS=$(jq -nc --arg o "$ORCH" --arg r "$REG" --arg runs "$RUNS" '{pluginConfigs: {"session-control@inline": {options: {orchestratorDir: $o, registryPath: $r, runsDir: $runs, licencePickCommand: "", completionWrites: true, pollSeconds: 2, debug: false}}}}')
WORKER_PROMPT="This is a process test, scratch directory $S. Run the Bash command: sleep 20 (in the foreground, with a timeout of 60000 ms), and when it ends run it again, twelve times in all, one call after the other. Do nothing else and write no file. When all twelve are done answer with the word done."
cat > "$S/instruction.txt" <<EOF
This is an automated test of the session-control mod's stop_worker tool. Do exactly these steps, one after the other, and nothing else:
1. Call mcp__session-control__launch_worker once with exactly these inputs and no others: dir "$WORK", model "haiku", effort "low", title "e2e sleeper", timeout_minutes 10, prompt "$WORKER_PROMPT". Give no prompt_file, no section and no rules.
2. Run this one Bash command in the foreground, with a timeout of 300000 ms, and wait for it to finish: sh "$S/wait-alive.sh" "$REG" "$S"
3. Call mcp__session-control__stop_worker with session_id set to the full session id the launch tool returned in step 1 and reason "e2e stop test".
4. Call mcp__session-control__stop_worker with session_id "deadbeef".
5. Call mcp__session-control__stop_worker with session_id "$FIN".
Then answer with one line: done.
EOF

: > "$S/tree-seen.txt"
touch "$S/watch.on"
watch_tree &
WATCHER=$!
(cd "$ORCH" && SESSION_CONTROL_DEBUG=1 exec claude -p --plugin-dir "$MOD" --model haiku --dangerously-skip-permissions \
  --max-budget-usd 0.25 --output-format json --settings "$SETTINGS" < "$S/instruction.txt" > "$S/orchestrator.json" 2> "$S/orchestrator.err") &
OPID=$!
elapsed=0
GONE_AT=''
while kill -0 "$OPID" 2>/dev/null && [ "$elapsed" -lt 540 ]; do
  sleep 1
  elapsed=$((elapsed + 1))
done
if kill -0 "$OPID" 2>/dev/null; then
  fail 'orchestrator finished within 540 s'
  kill "$OPID" 2>/dev/null
  wait "$OPID" 2>/dev/null
else
  wait "$OPID"
  code=$?
  if [ "$code" -eq 0 ] && jq -e '.is_error == false' "$S/orchestrator.json" >/dev/null 2>&1; then pass "orchestrator finished in ${elapsed} s, exit 0"; else fail "orchestrator finished, exit $code: $(head -c 300 "$S/orchestrator.err" "$S/orchestrator.json" 2>/dev/null | tr '\n' ' ')"; fi
fi
OPID_DONE=$OPID
OPID=''
rm -f "$S/watch.on"
wait "$WATCHER" 2>/dev/null
OSID=$(jq -r '.session_id // empty' "$S/orchestrator.json" 2>/dev/null)
info "orchestrator cost USD $(jq -r '.total_cost_usd // "?"' "$S/orchestrator.json" 2>/dev/null), session $OSID (config dir $CFG_DEFAULT, cwd $ORCH)"
OT=$(ls "$CFG_DEFAULT"/projects/*/"$OSID".jsonl 2>/dev/null | head -n 1)
[ -n "$OSID" ] && [ -f "$OT" ] && pass "orchestrator transcript found ($OT)" || fail "orchestrator transcript found (session '$OSID')"

# The output of the n-th call of a tool, from the transcript's tool_result of that call.
out() {
  _id=$(jq -r --arg n "$1" 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == $n) | .id' "$OT" 2>/dev/null | sed -n "${2:-1}p")
  [ -n "$_id" ] || return 1
  jq -r --arg id "$_id" 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .tool_use_id == $id) | .content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end' "$OT" > "$S/out-$3.txt" 2>/dev/null
  [ -s "$S/out-$3.txt" ]
}
has() { grep -F -q -- "$2" "$S/out-$1.txt"; }
check() { if has "$1" "$2"; then pass "$1: $3"; else fail "$1: $3 (missing: $2)"; fi; }
for spec in 'mcp__session-control__launch_worker 1 launch' 'Bash 1 wait' 'mcp__session-control__stop_worker 1 stop' 'mcp__session-control__stop_worker 2 unknown' 'mcp__session-control__stop_worker 3 finished'; do
  set -- $spec
  if out "$1" "$2" "$3"; then pass "$3: $1 call $2 was made and answered ($(wc -c < "$S/out-$3.txt" | tr -d ' ') bytes)"; else fail "$3: $1 call $2 was made and answered"; : > "$S/out-$3.txt"; fi
done
info "tool calls of the orchestrator: $(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$OT" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')"

# ---------------------------------------------------------------- the worker and its tree before the stop
check wait 'is alive with' 'the worker was alive with a sleep below it before the stop'
WPID=$(head -n 1 "$S/tree-before.txt" 2>/dev/null | cut -d' ' -f1)
WSID=$(jq -r '(.[] | select(.title == "e2e sleeper")).session_id // empty' "$REG" 2>/dev/null)
info "worker session $WSID, pid $WPID (config dir $CFG_DEFAULT, cwd $WORK); tree before the stop: $(tr '\n' ';' < "$S/tree-before.txt" 2>/dev/null)"
info "$(cat "$S/tree-dropped.txt" 2>/dev/null | grep -c .) pids of the tree had no readable start when it was recorded (they had ended): dropped from the recorded set$(tr '\n' ' ' < "$S/tree-dropped.txt" 2>/dev/null | sed 's/^./: &/')"
check launch "Launched pid $WPID, session $WSID" 'the launch registered the worker the tree was read from'

# ---------------------------------------------------------------- the proof
check stop "stop_worker: session $WSID \"e2e sleeper\"" 'the proof names the session'
check stop ", pid $WPID." 'and the pid'
check stop 'Reason given: e2e stop test' 'the reason'
check stop "Abort check before: alive: $CFG_DEFAULT/sessions/$WPID.json names session $WSID with procStart" 'the Abort check before: alive, by the sessions file and /proc'
check stop 'Descendants listed before the first signal (' 'the descendants listed before the first signal'
check stop "SIGTERM to $WPID (claude): exit code 0" 'SIGTERM to the worker, with its time'
check stop "Abort check after: dead: pid $WPID is gone (no /proc/$WPID)." 'the Abort check after: dead'
check stop "Result: pid $WPID is dead" 'the result'
check stop 'Surviving descendants: none.' 'no survivor'
check stop 'The registry is unchanged' 'no registry field written'
# Every signal went to a pid of the tree recorded before the stop, or to a child the worker spawned after the recording
# that the outside watch saw in its tree (such a pid is not required dead either); any other pid is a stray signal.
STRAY=''
LATE=''
for p in $(grep -E '^- [0-9TZ:.-]+ (SIGTERM|SIGKILL) to [0-9]+' "$S/out-stop.txt" | sed -E 's/^.* to ([0-9]+).*$/\1/'); do
  if grep -q "^$p " "$S/tree-before.txt"; then :
  elif grep -q "^$p " "$S/tree-seen.txt" 2>/dev/null; then case " $LATE " in *" $p "*) ;; *) LATE="$LATE $p" ;; esac
  else STRAY="$STRAY $p"; fi
done
info "signalled pids outside the recorded tree that the outside watch saw in the worker's tree after the recording (not required dead, not stray):${LATE:- none}"
[ -z "$STRAY" ] && pass "every signal of the proof went to a process of the worker's tree ($(grep -c -E 'SIG(TERM|KILL) to' "$S/out-stop.txt") signals)" || fail "a signal went outside the recorded tree:$STRAY"

# ---------------------------------------------------------------- /proc from outside
LEFT=''
while read -r p st name; do
  [ -n "$p" ] || continue
  if [ "$(start_of "$p")" = "$st" ]; then LEFT="$LEFT $p($name)"; fi
done < "$S/tree-before.txt"
[ -z "$LEFT" ] && pass "/proc: the worker pid and every process of its tree are gone or have another start ($(wc -l < "$S/tree-before.txt" | tr -d ' ') processes, $(grep -c ' sleep$' "$S/tree-before.txt") sleep)" || fail "/proc: still there:$LEFT"
[ "$(start_of "$BYSTANDER")" = "$BYSTANDER_START" ] && pass "/proc: the bystander sleep $BYSTANDER of this script is untouched" || fail '/proc: the bystander sleep of this script is untouched'
# The orchestrator (the backgrounded shell exec'd claude, so its pid is OPID) has ended by itself. Any other claude
# process alive before the stop is still there, or it was another session's run that ended on its own: it is named
# with the first three words of its command line as read before the stop (never its prompt), and no signal of the
# proof went to it (checked above).
MISSING=''
while read -r p st cmd; do
  grep -q "^$p " "$S/tree-before.txt" && continue
  [ "$p" = "$OPID_DONE" ] && continue
  [ "$(start_of "$p")" = "$st" ] || MISSING="$MISSING $p ($cmd);"
done < "$S/claude-before.txt"
grep -q "^$OPID_DONE " "$S/claude-before.txt" && info "the orchestrator $OPID_DONE was alive at the stop and has ended by itself since"
[ -z "$MISSING" ] && pass "/proc: every other claude process alive before the stop is still there ($(grep -c . "$S/claude-before.txt") claude processes before, the worker and the orchestrator among them)" || info "claude processes of other sessions alive before the stop and gone now (no signal of the proof went to them; they ended on their own):$MISSING"
grep -q "\"guard\".*\"tool\":\"stop_worker\".*\"isOk\":true" "$TRACE" 2>/dev/null && pass 'the trace has the stop_worker guard line' || fail 'the trace has the stop_worker guard line'
grep -F -q 'e2e stop test' "$TRACE" 2>/dev/null && fail 'the trace does not hold the reason' || pass 'the trace does not hold the reason'

# ---------------------------------------------------------------- the refusals
check unknown 'no registry entry has the session id deadbeef' 'an unknown id is refused'
check finished "refused: session $FIN is not alive: its entry records no pid" 'a finished entry is refused: not alive'
check finished 'nothing was signalled' 'and nothing is signalled'

if [ -n "${KEEP_OUT:-}" ]; then
  mkdir -p "$KEEP_OUT" && cp "$S"/out-*.txt "$S/tree-before.txt" "$S/tree-dropped.txt" "$S/tree-seen.txt" "$S/claude-before.txt" "$S/orchestrator.json" "$TRACE" "$KEEP_OUT"/ 2>/dev/null
  info "outputs copied to $KEEP_OUT"
fi
STILL=$(ps -eo pid,args 2>/dev/null | grep -F "$S" | grep -v -e grep -e 'e2e-stop' | head -n 3)
[ -z "$STILL" ] && pass 'no process names the scratch directory' || fail "no process names the scratch directory: $STILL"
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
