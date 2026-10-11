#!/bin/sh
# End-to-end test of the helper-file edit guard against the real claude, in a scratch directory it makes and removes.
# A headless haiku orchestrator (capped at --max-budget-usd 0.25) runs in a scratch orchestrator directory and is told
# to (1) Write over open-points.json, (2) run `sed -i` on task-queue.json through Bash, (3) run `cat task-queue.json`
# and (4) `jq` over it, (5) Read and then Edit its CLAUDE.md, (6) call open_point add. Its transcript must show (1) and
# (2) refused with the guard's text naming open_point and queue_task, (3) to (5) run, (6) answered by the tool; on
# disk task-queue.json must be byte for byte as seeded, open-points.json must hold the point the tool added and not
# the Write's text, and CLAUDE.md the edit. Everything is in the scratch directory; the transcript stays under the
# default configuration. POSIX sh and jq: sh mod/tests/e2e-guard.sh. One line per check; exit 1 on a failure.
# KEEP_OUT=<dir> keeps the tool results.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
info() { printf 'info %s\n' "$1"; }
# The first three processes other than this script ($$) and its parent ($PPID) whose command line or working
# directory names a directory, one per line into OTHERS: "<pid> <command line>", then " (cwd <dir>)" when the working
# directory names it. Only those two pids are left out, never a process by a name, so every other process of this run
# still there is seen. It runs in this shell, with no pipeline and no grep that would name the directory itself. /proc
# where it lists the processes; elsewhere the command lines from ps.
others_naming() {
  OTHERS=''
  _on_n=0
  if [ -d /proc/self ] && ! command -v cygpath >/dev/null 2>&1; then
    for _on_d in /proc/[0-9]*; do
      _on_p=${_on_d#/proc/}
      if [ "$_on_p" = "$$" ] || [ "$_on_p" = "$PPID" ]; then continue; fi
      _on_a=$({ tr '\0' ' ' < "$_on_d/cmdline"; } 2>/dev/null)
      _on_c=$(readlink "$_on_d/cwd" 2>/dev/null)
      _on_w=''
      case "$_on_c" in *"$1"*) _on_w=" (cwd $_on_c)" ;; esac
      case "$_on_a" in *"$1"*) ;; *) [ -n "$_on_w" ] || continue ;; esac
      OTHERS="$OTHERS${OTHERS:+
}$_on_p $_on_a$_on_w"
      _on_n=$((_on_n + 1))
      [ "$_on_n" -lt 3 ] || break
    done
  else
    _on_ps=$(ps -eo pid=,args= 2>/dev/null)
    while read -r _on_p _on_a; do
      if [ -z "$_on_p" ] || [ "$_on_p" = "$$" ] || [ "$_on_p" = "$PPID" ]; then continue; fi
      case "$_on_a" in *"$1"*) ;; *) continue ;; esac
      OTHERS="$OTHERS${OTHERS:+
}$_on_p $_on_a"
      _on_n=$((_on_n + 1))
      [ "$_on_n" -lt 3 ] || break
    done <<PS_EOF
$_on_ps
PS_EOF
  fi
}

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
command -v jq >/dev/null 2>&1 || { fail 'jq is on the PATH'; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e-guard.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
RUNS=$S/runs
REG=$S/headless-sessions.json
CFG_DEFAULT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
OPID=''

ours() { [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q "$S"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir -p "$ORCH" "$RUNS"
printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control guard test: do exactly what the prompt says.' 'SCRATCH-LINE-ONE' > "$ORCH/CLAUDE.md"
printf '%s\n' '# Agreed decisions' > "$ORCH/agreed-decisions.md"
jq -n '{tasks: [{id: "e2e-t", status: "queued", title: "A queued task"}]}' > "$ORCH/task-queue.json"
jq -n '{points: []}' > "$ORCH/open-points.json"
printf '%s\n' '# Open points archive' > "$ORCH/open-points-archive.md"
printf '[]\n' > "$REG"
cp "$ORCH/task-queue.json" "$S/queue-before.json"
SETTINGS=$(jq -nc --arg o "$ORCH" --arg r "$REG" --arg runs "$RUNS" '{pluginConfigs: {"session-control@inline": {options: {orchestratorDir: $o, registryPath: $r, runsDir: $runs, licencePickCommand: "", completionWrites: true, pollSeconds: 5, debug: false}}}}')
cat > "$S/instruction.txt" <<EOF
This is an automated test of a guard. Do exactly these six steps, one after the other, each one once, even when a step is refused (then go on with the next step), and nothing else:
1. Use the Write tool to write the text {"points": [], "e2e": "WRITE-BY-HAND"} to the file $ORCH/open-points.json
2. Run this Bash command: sed -i 's/queued/done/' $ORCH/task-queue.json
3. Run this Bash command: cat $ORCH/task-queue.json
4. Run this Bash command: jq '.tasks | length' $ORCH/task-queue.json
5. Use the Read tool on $ORCH/CLAUDE.md, then the Edit tool on $ORCH/CLAUDE.md to replace SCRATCH-LINE-ONE with SCRATCH-LINE-EDITED.
6. Call mcp__session-control__open_point with action "add", id "e2e-p1", title "A test point.", detail "Added by the guard test.", recommendation "None."
Then answer with one line: done.
EOF

(cd "$ORCH" && exec claude -p --plugin-dir "$MOD" --model haiku --dangerously-skip-permissions \
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

# The result of the first call of a tool whose input matches a jq filter: its text and whether it was an error.
result() {
  _id=$(jq -r --arg n "$1" "select(.type == \"assistant\") | .message.content[]? | select(.type == \"tool_use\" and .name == \$n and (.input | $2)) | .id" "$OT" 2>/dev/null | head -n 1)
  [ -n "$_id" ] || return 1
  jq -r --arg id "$_id" 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .tool_use_id == $id) | (if .is_error == true then "ERROR\n" else "OK\n" end) + (.content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end)' "$OT" > "$S/res-$3.txt" 2>/dev/null
  [ -s "$S/res-$3.txt" ]
}
has() { grep -F -q -- "$2" "$S/res-$1.txt"; }
check() { if has "$1" "$2"; then pass "$1: $3"; else fail "$1: $3 (missing: $2)"; fi; }
for spec in 'Write|.file_path|endswith("open-points.json")|write' 'Bash|.command|startswith("sed -i")|sed' 'Bash|.command|startswith("cat ")|cat' 'Bash|.command|startswith("jq ")|jq' 'Edit|.file_path|endswith("CLAUDE.md")|edit' 'mcp__session-control__open_point|.id == "e2e-p1"||point'; do
  tool=$(printf '%s' "$spec" | cut -d'|' -f1)
  key=$(printf '%s' "$spec" | cut -d'|' -f2)
  test2=$(printf '%s' "$spec" | cut -d'|' -f3)
  name=$(printf '%s' "$spec" | cut -d'|' -f4)
  filter=$key
  [ -n "$test2" ] && [ "$tool" != 'mcp__session-control__open_point' ] && filter="($key // \"\") | $test2"
  if result "$tool" "$filter" "$name"; then pass "$name: the $tool call was made and answered"; else fail "$name: the $tool call was made and answered"; : > "$S/res-$name.txt"; fi
done
info "tool calls of the orchestrator: $(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$OT" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')"

check write 'ERROR' '(1) Write over open-points.json is refused'
check write 'refused by the helper-file guard: open-points.json is a helper file' '(1) by the guard'
check write 'session-control tool open_point, never by hand (Write: a write of' '(1) naming open_point'
check sed 'ERROR' '(2) sed -i on task-queue.json through Bash is refused'
check sed 'session-control tool queue_task, never by hand (Bash: sed -i)' '(2) naming queue_task and sed -i'
check cat 'OK' '(3) cat task-queue.json runs'
check cat '"e2e-t"' '(3) and shows the file'
check jq 'OK' '(4) jq over task-queue.json runs'
check jq '1' '(4) and answers'
check edit 'OK' '(5) Edit of CLAUDE.md runs'
check point 'OK' '(6) open_point add runs'
check point 'open-points.json: added e2e-p1' '(6) the tool added the point'

cmp -s "$S/queue-before.json" "$ORCH/task-queue.json" && pass 'disk: task-queue.json is byte for byte as seeded' || fail "disk: task-queue.json changed: $(head -c 300 "$ORCH/task-queue.json")"
if jq -e '(.points | map(.id) | index("e2e-p1")) != null and (has("e2e") | not)' "$ORCH/open-points.json" >/dev/null 2>&1; then pass 'disk: open-points.json holds the point the tool added, not the hand-written text'; else fail "disk: open-points.json: $(head -c 300 "$ORCH/open-points.json")"; fi
grep -F -q 'SCRATCH-LINE-EDITED' "$ORCH/CLAUDE.md" && pass 'disk: CLAUDE.md holds the edit' || fail 'disk: CLAUDE.md holds the edit'

if [ -n "${KEEP_OUT:-}" ]; then
  mkdir -p "$KEEP_OUT" && cp "$S"/res-*.txt "$S/orchestrator.json" "$KEEP_OUT"/ 2>/dev/null
  cp "$ORCH/open-points.json" "$ORCH/task-queue.json" "$ORCH/CLAUDE.md" "$KEEP_OUT"/ 2>/dev/null
  info "outputs copied to $KEEP_OUT"
fi
others_naming "$S"
STILL=$OTHERS
[ -z "$STILL" ] && pass 'no process names the scratch directory' || fail "no process names the scratch directory: $STILL"
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
