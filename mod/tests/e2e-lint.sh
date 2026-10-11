#!/bin/sh
# End-to-end test of the T3b checks against the real claude, in a scratch directory it makes and removes. A headless
# haiku orchestrator (capped at --max-budget-usd 0.30) runs in a scratch orchestrator directory and is told to
# (1) launch_worker with a prompt that has a force-push step: refused by the sign-off guard, nothing launched;
# (2) launch_worker with a prompt that holds a secret canary: refused naming the kind and the line, never the value;
# (3) launch_worker with a prompt that says "never force-push": launched (one tiny haiku worker that replies PONG), and
# wait for its outcome in the foreground; (4) run a Bash heredoc that names task-queue.json only in its body: it runs;
# (5) run a Bash redirect onto task-queue.json: refused by the helper-file guard; (6) run `git push --force` itself:
# refused by the sign-off guard; (7) call read_result on a seeded finished session whose result holds a canary token:
# its answer ends with the `secret scan:` line, and the canary is in no answer. The canaries are joined at run time, so
# this file holds no string in a token's shape. Everything is in the scratch directory; both transcripts stay under the
# default configuration. POSIX sh and jq: sh mod/tests/e2e-lint.sh. One line per check; exit 1 on a failure.
# KEEP_OUT=<dir> keeps the tool results.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
info() { printf 'info %s\n' "$1"; }

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
command -v jq >/dev/null 2>&1 || { fail 'jq is on the PATH'; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e-lint.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
WORK=$S/work
RUNS=$S/runs
REG=$S/headless-sessions.json
CFG_DEFAULT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
OPID=''
# The canaries, joined here: an AWS-shaped key id for the prompt, a GitHub-shaped token for the seeded result.
PROMPT_CANARY=$(printf '%s%s' 'AKIA' 'E2ELINTCANARY000')
RESULT_CANARY=$(printf '%s_%s' 'ghp' 'E2ELINTcanary000000000000000000000')
LEAKY_SID=6e2e0000-aaaa-4bbb-8ccc-000000000077
# A pid no process has: the first poll harvests the seeded entry.
DEAD_PID=4194301
[ -d "/proc/$DEAD_PID" ] && DEAD_PID=4194297

ours() { [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q "$S"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  # The worker the orchestrator launched, while it lives: a claude whose working directory is the scratch work folder.
  for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$WORK" ] && tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q '^claude ' && kill "$p" 2>/dev/null
  done
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir -p "$ORCH" "$WORK" "$RUNS"
printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control lint test: do exactly what the prompt says.' > "$ORCH/CLAUDE.md"
printf '%s\n' '# Agreed decisions' > "$ORCH/agreed-decisions.md"
jq -n '{tasks: [{id: "e2e-t", status: "queued", title: "A queued task"}]}' > "$ORCH/task-queue.json"
jq -n '{points: []}' > "$ORCH/open-points.json"
printf '%s\n' '# Open points archive' > "$ORCH/open-points-archive.md"
cp "$ORCH/task-queue.json" "$S/queue-before.json"
jq -n --arg r "Done. The build log printed $RESULT_CANARY by mistake.\n## main...origin/main\nexit 0" '{type: "result", subtype: "success", is_error: false, result: $r, total_cost_usd: 0.01, duration_ms: 1000, num_turns: 2}' > "$RUNS/leaky.json"
: > "$RUNS/leaky.err"
jq -n --arg sid "$LEAKY_SID" --arg cfg "$CFG_DEFAULT" --arg cwd "$WORK" --arg res "$RUNS/leaky.json" --arg err "$RUNS/leaky.err" --argjson pid "$DEAD_PID" \
  '[{title: "e2e leaky worker", pid: $pid, session_id: $sid, name: "w-e2e-leaky-worker-261011090000", config_dir: $cfg, cwd: $cwd, model: "haiku", effort: "low", result_file: $res, err_file: $err, started_at: 1790000000}]' > "$REG"
SETTINGS=$(jq -nc --arg o "$ORCH" --arg r "$REG" --arg runs "$RUNS" '{pluginConfigs: {"session-control@inline": {options: {orchestratorDir: $o, registryPath: $r, runsDir: $runs, licencePickCommand: "", completionWrites: true, pollSeconds: 3, debug: false}}}}')
cat > "$S/wait-outcome.sh" <<'EOF'
n=0
until jq -e '.[] | select(.title == "e2e lint pong") | .outcome' "$1" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -gt 100 ] && exit 1; sleep 3; done
EOF
cat > "$S/instruction.txt" <<EOF
This is an automated test of guards. Do exactly these steps, one after the other, each one once, even when a step is refused (then go on with the next step), and nothing else. Give every tool exactly the inputs written here.
1. Call mcp__session-control__launch_worker with dir "$WORK", model "haiku", effort "low", title "e2e lint force", timeout_minutes 5, prompt "Rebase the branch on main. Then run git push --force-with-lease origin feature/x and report."
2. Call mcp__session-control__launch_worker with dir "$WORK", model "haiku", effort "low", title "e2e lint secret", timeout_minutes 5, prompt "Deploy the build.\nUse the key id $PROMPT_CANARY for the upload."
3. Call mcp__session-control__launch_worker with dir "$WORK", model "haiku", effort "low", title "e2e lint pong", timeout_minutes 5, prompt "Reply with the single word PONG and stop. Use no tool. Never force-push; there is nothing to commit."
4. Run this Bash command and wait for it (it returns when the worker of step 3 has finished): sh $S/wait-outcome.sh $REG
5. Run this exact Bash command (three lines, a heredoc):
cat > $S/prompt-note.md <<'NOTE_EOF'
Update task-queue.json only through queue_task; cp x task-queue.json is never run by hand.
NOTE_EOF
6. Run this Bash command: echo '{}' > $ORCH/task-queue.json
7. Run this Bash command: git -C $WORK push --force origin feature/x
8. Call mcp__session-control__read_result with session_id "$LEAKY_SID".
Then answer with one line: done.
EOF

(cd "$ORCH" && exec claude -p --plugin-dir "$MOD" --model haiku --dangerously-skip-permissions \
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

# The result of the first call of a tool whose input matches a jq filter: OK or ERROR, then its text.
result() {
  _id=$(jq -r --arg n "$1" "select(.type == \"assistant\") | .message.content[]? | select(.type == \"tool_use\" and .name == \$n and (.input | $2)) | .id" "$OT" 2>/dev/null | head -n 1)
  [ -n "$_id" ] || return 1
  jq -r --arg id "$_id" 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .tool_use_id == $id) | (if .is_error == true then "ERROR\n" else "OK\n" end) + (.content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end)' "$OT" > "$S/res-$3.txt" 2>/dev/null
  [ -s "$S/res-$3.txt" ]
}
has() { grep -F -q -- "$2" "$S/res-$1.txt"; }
check() { if has "$1" "$2"; then pass "$1: $3"; else fail "$1: $3 (missing: $2)"; fi; }
lacks() { if has "$1" "$2"; then fail "$1: $3 (found: $2)"; else pass "$1: $3"; fi; }
L=mcp__session-control__launch_worker
# Each spec: the tool, a jq filter over its input, the name of the check; separated by '#', since a filter holds '|'.
for spec in "$L#.title == \"e2e lint force\"#force" "$L#.title == \"e2e lint secret\"#secret" "$L#.title == \"e2e lint pong\"#pong" \
  'Bash#(.command // "") | startswith("cat > ")#heredoc' 'Bash#(.command // "") | startswith("echo ")#redirect' 'Bash#(.command // "") | startswith("git ")#push' \
  'mcp__session-control__read_result#.session_id != null#read'; do
  tool=$(printf '%s' "$spec" | cut -d'#' -f1)
  filter=$(printf '%s' "$spec" | cut -d'#' -f2)
  name=$(printf '%s' "$spec" | cut -d'#' -f3)
  if result "$tool" "$filter" "$name"; then pass "$name: the $tool call was made and answered"; else fail "$name: the $tool call was made and answered"; : > "$S/res-$name.txt"; fi
done
info "tool calls of the orchestrator: $(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$OT" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')"

check force 'refused by the sign-off guard: the prompt instructs a force-push on line ' '(1) a prompt with a force-push step is refused by the sign-off guard'
check force "user's go-ahead" '(1) the refusal says the go-ahead is a sign-off item'
check force 'nothing was launched' '(1) nothing was launched'
check secret 'refused: the prompt holds a likely secret (aws-key on line ' '(2) a prompt with a secret canary is refused, naming the kind and the line'
lacks secret "$PROMPT_CANARY" '(2) the refusal never holds the value'
check pong 'Launched pid ' '(3) a prompt that says never force-push is launched'
lacks pong 'WARNING' '(3) with no warning (it names no git work to do)'
check heredoc 'OK' '(4) a heredoc that names task-queue.json only in its body runs'
grep -F -q 'cp x task-queue.json is never run by hand' "$S/prompt-note.md" 2>/dev/null && pass '(4) disk: the heredoc wrote its file' || fail '(4) disk: the heredoc wrote its file'
check redirect 'refused by the helper-file guard: task-queue.json is a helper file' '(5) a redirect onto task-queue.json is refused'
check redirect '(Bash: an output redirection (>))' '(5) naming the redirection'
check push 'refused by the sign-off guard: git push --force is a force-push or history rewrite' '(6) the orchestrator'"'"'s own git push --force is refused'
check read "secret scan: 1 likely secret redacted (kinds: github-token)" '(7) read_result ends with the secret scan line'
LAST=$(tail -n 1 "$S/res-read.txt" 2>/dev/null)
[ "$LAST" = 'secret scan: 1 likely secret redacted (kinds: github-token)' ] && pass '(7) as its last line' || fail "(7) as its last line (last: $LAST)"
lacks read "$RESULT_CANARY" '(7) the canary is redacted'

cmp -s "$S/queue-before.json" "$ORCH/task-queue.json" && pass 'disk: task-queue.json is byte for byte as seeded' || fail "disk: task-queue.json changed: $(head -c 300 "$ORCH/task-queue.json")"
if jq -e '[.[] | .title] | (index("e2e lint force") == null) and (index("e2e lint secret") == null) and (index("e2e lint pong") != null)' "$REG" >/dev/null 2>&1; then pass 'registry: only the accepted launch is registered'; else fail "registry: $(jq -c '[.[] | .title]' "$REG" 2>/dev/null)"; fi
if jq -e --arg sid "$LEAKY_SID" '.[] | select(.session_id == $sid) | .outcome.kind == "clean" and (has("pid") | not)' "$REG" >/dev/null 2>&1; then pass 'registry: the seeded leaky entry was harvested'; else fail 'registry: the seeded leaky entry was harvested'; fi
WSID=$(jq -r '(.[] | select(.title == "e2e lint pong")).session_id // empty' "$REG" 2>/dev/null)
info "worker session $WSID (config dir $(jq -r '(.[] | select(.title == "e2e lint pong")).config_dir // empty' "$REG" 2>/dev/null), cwd $WORK), outcome $(jq -r '(.[] | select(.title == "e2e lint pong")).outcome.kind // "none"' "$REG" 2>/dev/null)"
EVERYTHING=$(cat "$S"/res-*.txt "$S/orchestrator.json" 2>/dev/null)
case "$EVERYTHING" in
  *"$PROMPT_CANARY"* | *"$RESULT_CANARY"*) fail 'no canary in any tool answer or the final answer' ;;
  *) pass 'no canary in any tool answer or the final answer' ;;
esac

if [ -n "${KEEP_OUT:-}" ]; then
  mkdir -p "$KEEP_OUT" && cp "$S"/res-*.txt "$S/orchestrator.json" "$REG" "$KEEP_OUT"/ 2>/dev/null
  info "outputs copied to $KEEP_OUT"
fi
# The worker must be gone before the scratch directory goes: wait a little for it, then the cleanup stops what is left.
n=0
while [ "$n" -lt 30 ] && for p in $(ls /proc | grep -E '^[0-9]+$'); do [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$WORK" ] && echo "$p"; done | grep -q .; do sleep 1; n=$((n + 1)); done
STILL=$(ps -eo pid,args 2>/dev/null | grep -F "$S" | grep -v -e grep -e 'e2e-lint' | head -n 3)
[ -z "$STILL" ] && pass 'no process names the scratch directory' || fail "no process names the scratch directory: $STILL"
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
