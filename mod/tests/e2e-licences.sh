#!/bin/sh
# End-to-end test of the licence tools of the session-control mod against the real claude and the real licences of
# this machine, in a scratch directory it makes and removes. A headless haiku orchestrator (capped at --max-budget-usd
# 0.30) runs in a scratch orchestrator directory and is told to (1) list_licences; (2) probe_licence_usage of every
# licence; (3) the same again, which answers from the cache; (4) probe_licence_usage of a directory that is no licence:
# refused; (5) launch_worker with a config_dir that is no licence: refused with the discovered names; (6) launch_worker
# with the explicit config_dir of the main licence (E2E_MAIN_DIR, else ~/.claude) and a prompt that replies PONG, and
# wait for its outcome in the foreground. The licences the tool must find are computed here the same way, by the
# presence of .credentials.json and .claude.json only (test -f): no licence file is ever opened by this script or the
# mod. The probes run `claude -p /usage --no-session-persistence` under each licence (no model turn); they read and
# change nothing of the licences beyond what the CLI itself does. Every tool answer, the final answer and the debug
# trace are checked for an `@` and for the identity strings given in E2E_IDENTITY (comma separated, never written in
# this file), and afterwards no `claude -p /usage --no-session-persistence` process may remain. Everything the mod
# writes is in the scratch directory; the orchestrator's transcript stays under this shell's configuration
# (CLAUDE_CONFIG_DIR, else ~/.claude), the worker's under the main licence. POSIX sh and jq: sh mod/tests/e2e-licences.sh.
# One line per check; exit 1 on a failure. KEEP_OUT=<dir> keeps the tool answers.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
info() { printf 'info %s\n' "$1"; }

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
command -v jq >/dev/null 2>&1 || { fail 'jq is on the PATH'; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e-licences.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
WORK=$S/work
RUNS=$S/runs
REG=$S/headless-sessions.json
TRACE=$RUNS/trace.log
CFG_DEFAULT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
MAIN_DIR=${E2E_MAIN_DIR:-$HOME/.claude}
PROBE_LINE='claude -p /usage --no-session-persistence'
OPID=''

ours() { [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q "$S"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  # The worker the orchestrator launched, while it lives: a claude whose working directory is the scratch work folder.
  for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$WORK" ] && { tr '\0' ' ' < "/proc/$p/cmdline"; } 2>/dev/null | grep -q '^claude ' && kill "$p" 2>/dev/null
  done
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# The licences the tool must find, by presence only: the default (this shell's own directory), ~/.claude, its children
# and the ~/.claude-* folders that hold both files.
isLicence() { [ -d "$1" ] && [ ! -L "${1%/}" ] && test -f "$1/.credentials.json" && test -f "$1/.claude.json"; }
EXPECTED=$(
  printf '%s\n' "$CFG_DEFAULT"
  isLicence "$HOME/.claude" && printf '%s\n' "$HOME/.claude"
  for d in "$HOME"/.claude/*/ "$HOME"/.claude-*/; do isLicence "$d" && printf '%s\n' "${d%/}"; done
)
EXPECTED=$(printf '%s\n' "$EXPECTED" | awk '!seen[$0]++')
COUNT=$(printf '%s\n' "$EXPECTED" | grep -c .)
info "licences expected by presence: $COUNT ($(printf '%s' "$EXPECTED" | tr '\n' ' '))"
isLicence "$MAIN_DIR" || { fail "the main licence $MAIN_DIR holds both files"; exit 1; }

mkdir -p "$ORCH" "$WORK" "$RUNS"
printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control licence tools test: do exactly what the prompt says.' > "$ORCH/CLAUDE.md"
printf '%s\n' '# Agreed decisions' > "$ORCH/agreed-decisions.md"
jq -n '{tasks: []}' > "$ORCH/task-queue.json"
jq -n '{points: []}' > "$ORCH/open-points.json"
printf '%s\n' '# Open points archive' > "$ORCH/open-points-archive.md"
printf '[]\n' > "$REG"
SETTINGS=$(jq -nc --arg o "$ORCH" --arg r "$REG" --arg runs "$RUNS" '{pluginConfigs: {"session-control@inline": {options: {orchestratorDir: $o, registryPath: $r, runsDir: $runs, licencePickCommand: "", completionWrites: true, pollSeconds: 3, debug: false}}}}')
cat > "$S/wait-outcome.sh" <<'EOF'
n=0
until jq -e '.[] | select(.title == "e2e licence pong") | .outcome' "$1" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -gt 100 ] && exit 1; sleep 3; done
EOF
cat > "$S/instruction.txt" <<EOF
This is an automated test of the licence tools. Do exactly these steps, one after the other, each one once, even when a step is refused (then go on with the next step), and nothing else. Give every tool exactly the inputs written here.
1. Call mcp__session-control__list_licences with no input.
2. Call mcp__session-control__probe_licence_usage with no input.
3. Call mcp__session-control__probe_licence_usage with no input again.
4. Call mcp__session-control__probe_licence_usage with config_dir "$S/not-a-licence".
5. Call mcp__session-control__launch_worker with dir "$WORK", model "haiku", effort "low", title "e2e licence refused", timeout_minutes 5, config_dir "$S/not-a-licence", prompt "Reply with the single word PONG and stop. Use no tool."
6. Call mcp__session-control__launch_worker with dir "$WORK", model "haiku", effort "low", title "e2e licence pong", timeout_minutes 5, config_dir "$MAIN_DIR", prompt "Reply with the single word PONG and stop. Use no tool."
7. Run this Bash command and wait for it (it returns when the worker of step 6 has finished): sh $S/wait-outcome.sh $REG
Then answer with one line: done.
EOF

(cd "$ORCH" && SESSION_CONTROL_DEBUG=1 exec claude -p --plugin-dir "$MOD" --model haiku --dangerously-skip-permissions \
  --max-budget-usd 0.30 --output-format json --settings "$SETTINGS" < "$S/instruction.txt" > "$S/orchestrator.json" 2> "$S/orchestrator.err") &
OPID=$!
elapsed=0
while kill -0 "$OPID" 2>/dev/null && [ "$elapsed" -lt 480 ]; do sleep 1; elapsed=$((elapsed + 1)); done
if kill -0 "$OPID" 2>/dev/null; then
  fail 'orchestrator finished within 480 s'
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

# The result of the n-th call (1 first) of a tool whose input matches a jq filter: OK or ERROR, then its text.
result() {
  _id=$(jq -r --arg n "$1" "select(.type == \"assistant\") | .message.content[]? | select(.type == \"tool_use\" and .name == \$n and (.input | $2)) | .id" "$OT" 2>/dev/null | sed -n "${4}p")
  [ -n "$_id" ] || return 1
  jq -r --arg id "$_id" 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .tool_use_id == $id) | (if .is_error == true then "ERROR\n" else "OK\n" end) + (.content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end)' "$OT" > "$S/res-$3.txt" 2>/dev/null
  [ -s "$S/res-$3.txt" ]
}
has() { grep -F -q -- "$2" "$S/res-$1.txt"; }
check() { if has "$1" "$2"; then pass "$1: $3"; else fail "$1: $3 (missing: $2)"; fi; }
lacks() { if has "$1" "$2"; then fail "$1: $3 (found: $2)"; else pass "$1: $3"; fi; }
P=mcp__session-control__probe_licence_usage
L=mcp__session-control__launch_worker
# Each spec: the tool, a jq filter over its input, the name of the check, which call of those; separated by '#'.
for spec in 'mcp__session-control__list_licences#true#list#1' "$P#.config_dir == null#probe#1" "$P#.config_dir == null#again#2" "$P#.config_dir != null#probe-refused#1" \
  "$L#.title == \"e2e licence refused\"#launch-refused#1" "$L#.title == \"e2e licence pong\"#launch#1"; do
  tool=$(printf '%s' "$spec" | cut -d'#' -f1)
  filter=$(printf '%s' "$spec" | cut -d'#' -f2)
  name=$(printf '%s' "$spec" | cut -d'#' -f3)
  nth=$(printf '%s' "$spec" | cut -d'#' -f4)
  if result "$tool" "$filter" "$name" "$nth"; then pass "$name: the $tool call was made and answered"; else fail "$name: the $tool call was made and answered"; : > "$S/res-$name.txt"; fi
done
info "tool calls of the orchestrator: $(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$OT" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')"

# ---------------------------------------------------------------- list_licences
check list "$COUNT licence" '(1) the count of the licences found by presence'
for d in $EXPECTED; do check list "| config_dir $d | source " "(1) $d is listed"; done
check list "- default | config_dir $CFG_DEFAULT | source default | logged_in " "(1) the orchestrator's own directory is the default"
check list "| config_dir $MAIN_DIR | source " '(1) the main licence is listed'
check list 'neither is opened' '(1) the answer says logged_in is presence only'

# ---------------------------------------------------------------- probe_licence_usage
check probe "Usage of $COUNT licence" '(2) every licence answered'
N_FIG=$(grep -c '| five_hour [0-9-]' "$S/res-probe.txt")
N_ERR=$(grep -c '| error ' "$S/res-probe.txt")
[ $((N_FIG + N_ERR)) -eq "$COUNT" ] && pass "(2) one row per licence ($N_FIG with figures, $N_ERR with a code)" || fail "(2) one row per licence ($N_FIG + $N_ERR of $COUNT)"
check probe "(config_dir $MAIN_DIR) | five_hour " '(2) the main licence has its figures'
check probe "can be stale" '(2) the answer says the figures can be stale'
check again "from the cache)" '(3) the second call answers from the cache'
check again "| cached yes" '(3) its rows say cached'
check probe-refused 'not a discovered licence' '(4) a directory that is no licence is refused'
check launch-refused 'refused: config_dir is not a discovered licence (discovered: ' '(5) launch_worker refuses a config_dir that is no licence'
check launch-refused 'nothing was launched' '(5) nothing was launched'

# ---------------------------------------------------------------- launch_worker with the main licence
check launch "config_dir $MAIN_DIR, registered." '(6) launched under the main licence and registered'
check launch '(config_dir given; the licence picker was not run)' '(6) the answer says the picker was not run'
ENTRY_CFG=$(jq -r '(.[] | select(.title == "e2e licence pong")).config_dir // empty' "$REG" 2>/dev/null)
[ "$ENTRY_CFG" = "$MAIN_DIR" ] && pass "(6) the registry entry's config_dir is $MAIN_DIR" || fail "(6) the registry entry's config_dir is $MAIN_DIR (got '$ENTRY_CFG')"
WSID=$(jq -r '(.[] | select(.title == "e2e licence pong")).session_id // empty' "$REG" 2>/dev/null)
OUTCOME=$(jq -r '(.[] | select(.title == "e2e licence pong")).outcome.kind // "none"' "$REG" 2>/dev/null)
[ "$OUTCOME" = clean ] && pass '(6) the worker finished clean' || fail "(6) the worker finished clean (outcome $OUTCOME)"
info "worker session $WSID (config dir $ENTRY_CFG, cwd $WORK), outcome $OUTCOME"
WT=$(ls "$MAIN_DIR"/projects/*/"$WSID".jsonl 2>/dev/null | head -n 1)
[ -n "$WSID" ] && [ -f "$WT" ] && pass "(6) the worker's transcript is under the main licence" || fail "(6) the worker's transcript is under the main licence"
if jq -e '[.[] | .title] | index("e2e licence refused") == null' "$REG" >/dev/null 2>&1; then pass '(5) registry: the refused launch is not registered'; else fail '(5) registry: the refused launch is not registered'; fi

# ---------------------------------------------------------------- no identity, no credential, no figure in the trace
jq -r '.result // ""' "$S/orchestrator.json" > "$S/answer.txt" 2>/dev/null
ALL="$S/answer.txt $TRACE"
for f in "$S"/res-*.txt; do ALL="$ALL $f"; done
AT=$(grep -l -F '@' $ALL 2>/dev/null | tr '\n' ' ')
[ -z "$AT" ] && pass 'no @ in any tool answer, the final answer or the trace' || fail "no @ in any tool answer, the final answer or the trace (found in: $AT)"
LEAK=''
OLD_IFS=$IFS
IFS=','
for word in ${E2E_IDENTITY:-}; do
  [ -n "$word" ] || continue
  IFS=$OLD_IFS
  grep -i -l -F -- "$word" $ALL >/dev/null 2>&1 && LEAK="$LEAK [an identity string]"
  IFS=','
done
IFS=$OLD_IFS
if [ -z "${E2E_IDENTITY:-}" ]; then info 'E2E_IDENTITY not set: only the @ check ran'; elif [ -z "$LEAK" ]; then pass 'no identity string of E2E_IDENTITY in any answer or the trace'; else fail "an identity string of E2E_IDENTITY was found:$LEAK"; fi
TOKEN_SHAPE=$(printf '%s%s' 'sk-' 'ant-')
grep -l -F -- "$TOKEN_SHAPE" $ALL >/dev/null 2>&1 && fail 'no token-shaped text in any answer or the trace' || pass 'no token-shaped text in any answer or the trace'
for word in '% used' 'resets ' 'subscription'; do
  if grep -F -q -- "$word" "$TRACE" 2>/dev/null; then fail "the trace holds no usage text ($word)"; else pass "the trace holds no usage text ($word)"; fi
done
grep -F -q '"event":"tool.result","tool":"probe_licence_usage","resultChars":' "$TRACE" 2>/dev/null && pass 'the trace has the probe answer as a length only' || fail 'the trace has the probe answer as a length only'
grep -F -q '"event":"licences.usage"' "$TRACE" 2>/dev/null && pass 'the trace has a line per probe' || fail 'the trace has a line per probe'
NODE_MAJOR=$(node --version 2>/dev/null | sed -n 's/^v\([0-9]*\)\..*/\1/p')
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 22 ]; then
  if grep -F -q '"helper":"probeUsage"' "$TRACE" && ! grep -F -q '"op":"probeUsage"' "$TRACE"; then pass 'the probes ran through the Node helper, no fallback'; else fail 'the probes ran through the Node helper, no fallback'; fi
fi

if [ -n "${KEEP_OUT:-}" ]; then
  mkdir -p "$KEEP_OUT" && cp "$S"/res-*.txt "$S/answer.txt" "$REG" "$TRACE" "$KEEP_OUT"/ 2>/dev/null
  info "outputs copied to $KEEP_OUT"
fi
# The worker must be gone before the scratch directory goes: wait a little for it, then the cleanup stops what is left.
n=0
while [ "$n" -lt 30 ] && for p in $(ls /proc | grep -E '^[0-9]+$'); do [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$WORK" ] && echo "$p"; done | grep -q .; do sleep 1; n=$((n + 1)); done
PROBES=$(for p in $(ls /proc | grep -E '^[0-9]+$'); do [ "$({ tr '\0' ' ' < "/proc/$p/cmdline"; } 2>/dev/null)" = "$PROBE_LINE " ] && echo "$p"; done)
[ -z "$PROBES" ] && pass "no $PROBE_LINE process remains" || fail "no $PROBE_LINE process remains (pids: $(printf '%s' "$PROBES" | tr '\n' ' '))"
STILL=$(ps -eo pid,args 2>/dev/null | grep -F "$S" | grep -v -e grep -e 'e2e-licences' | head -n 3)
[ -z "$STILL" ] && pass 'no process names the scratch directory' || fail "no process names the scratch directory: $STILL"
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
