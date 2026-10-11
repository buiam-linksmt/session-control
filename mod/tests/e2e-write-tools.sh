#!/bin/sh
# End-to-end test of the write-side tools of the session-control mod against the real claude, in a scratch directory
# it makes and removes. A headless haiku orchestrator (capped at --max-budget-usd 0.25) launches one tiny haiku worker
# ("reply PONG") through launch_worker with an inline prompt, a decisions section and the default rules, waits for it
# in the foreground, closes it with close_worker, retires three hostile registry entries (a result file that is a
# symbolic link out of the runs folder, one named through a `..` path, one named through a symbolic link to a folder)
# with retire_workers, calls archive_decisions on a scratch decisions file with two sections (one named by a queue task:
# refused; one free: archived) and calls list_sessions. Each tool's output is read
# from the orchestrator's own transcript and checked against the seeded data; the prompt file the mod wrote is copied
# the moment the worker's outcome is in the registry and checked for the section text and one rules block; the run
# files the retire deleted, the files the hostile entries name and the symbolic links (all outside the runs folder, all
# still there with their content), the archive, the summary line and the backup are checked on disk.
# Everything the mod reads or writes is in the scratch directory (registry, helper files, runs directory, trace); the
# real registry, helper files and runs directory are never touched, and the licence picker option is empty: the worker
# inherits the default configuration (this shell's CLAUDE_CONFIG_DIR, else ~/.claude), where both transcripts stay.
# POSIX sh and jq, Linux: sh mod/tests/e2e-write-tools.sh. One line per check; exit 1 on a failure. KEEP_OUT=<dir>
# copies the outputs, the prompt copy and the answer there before the scratch directory goes.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
info() { printf 'info %s\n' "$1"; }

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
command -v jq >/dev/null 2>&1 || { fail 'jq is on the PATH'; exit 1; }
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e-write.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
WORK=$S/work
RUNS=$S/runs
REG=$S/headless-sessions.json
TRACE=$RUNS/trace.log
CFG_DEFAULT=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
OPID=''
WPID=''

ours() { [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q "$S"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  ours "$WPID" && kill "$WPID" 2>/dev/null
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir -p "$ORCH" "$WORK" "$RUNS"
TODAY=$(date +%Y-%m-%d)
FREE='E2E free unit'
QUEUED='E2E queued unit - branch feature/e2e-queued'
SECTION_MARKER='SECTION-MARKER-7f3a'
PROMPT_MARKER='PROMPT-MARKER-c41e'

# ---------------------------------------------------------------- the seeded files
printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control write-tools test: do exactly what the prompt says.' > "$ORCH/CLAUDE.md"
printf '%s\n' '# Agreed decisions' '' 'Scratch decisions of the write-tools test.' '' \
  "## $FREE" "e2efree-1. The worker replies PONG and nothing else." "e2efree-2. $SECTION_MARKER: this line reaches the worker prompt." '' \
  "## $QUEUED" 'e2eq-1. A queue task still names this unit.' > "$ORCH/agreed-decisions.md"
cp "$ORCH/agreed-decisions.md" "$S/decisions-before.md"
# The free section's lines as the file holds them (heading line to the next heading, its last blank line aside).
FREE_TEXT=$(printf '%s\n' "## $FREE" "e2efree-1. The worker replies PONG and nothing else." "e2efree-2. $SECTION_MARKER: this line reaches the worker prompt." '')
jq -n '{tasks: [{id: "e2e-q", status: "queued", title: "Follow-up on feature/e2e-queued"}]}' > "$ORCH/task-queue.json"
jq -n '{points: []}' > "$ORCH/open-points.json"
printf '%s\n' '# Open points archive' > "$ORCH/open-points-archive.md"
# Three hostile entries, finished and reported with a clean outcome, whose run files lead out of the runs folder; the
# files they lead to are scratch files of this test, with content to compare.
OUT=$S/outside
mkdir -p "$OUT" "$S/outside-dir"
printf 'outside secret 1\n' > "$OUT/secret1.txt"
printf 'outside secret 2\n' > "$OUT/secret2.txt"
printf 'outside secret 3\n' > "$S/outside-dir/secret3.txt"
ln -s "$OUT/secret1.txt" "$RUNS/hostile-link.json"
ln -s "$S/outside-dir" "$RUNS/hostile-dir"
H1=1a1a1a1a-0001-4001-8001-000000000001
H2=2b2b2b2b-0002-4002-8002-000000000002
H3=3c3c3c3c-0003-4003-8003-000000000003
jq -n --arg cwd "$WORK" --arg cfg "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" --arg runs "$RUNS" --arg h1 "$H1" --arg h2 "$H2" --arg h3 "$H3" '
  def hostile($id; $title; $fields): {title: $title, session_id: $id, config_dir: $cfg, cwd: $cwd, reported: true, outcome: {kind: "clean", summary: "clean: hostile"}} + $fields;
  [hostile($h1; "hostile link"; {result_file: ($runs + "/hostile-link.json")}),
   hostile($h2; "hostile dots"; {result_file: ($runs + "/../outside/secret2.txt")}),
   hostile($h3; "hostile folder"; {err_file: ($runs + "/hostile-dir/secret3.txt")})]' > "$REG"

# Once the worker's outcome is in the registry: a copy of the prompt file the mod wrote and the runs directory's
# listing, before close_worker deletes the run files.
cat > "$S/wait-outcome.sh" <<'EOF'
n=0
until jq -e '.[] | select(.title == "e2e pong worker") | .outcome' "$1" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -gt 100 ] && exit 1; sleep 3; done
p=$(jq -r '(.[] | select(.title == "e2e pong worker")).prompt_file // empty' "$1")
[ -n "$p" ] && cp "$p" "$2/prompt-copy.md"
cp "$1" "$2/registry-at-outcome.json"
ls "$3" > "$2/runs-at-outcome.txt"
EOF
SETTINGS=$(jq -nc --arg o "$ORCH" --arg r "$REG" --arg runs "$RUNS" '{pluginConfigs: {"session-control@inline": {options: {orchestratorDir: $o, registryPath: $r, runsDir: $runs, licencePickCommand: "", completionWrites: true, pollSeconds: 2, debug: false}}}}')
WORKER_PROMPT="Reply with exactly the word PONG and nothing else. $PROMPT_MARKER (scratch directory $S)."
cat > "$S/instruction.txt" <<EOF
This is an automated test of the session-control mod's write-side tools. Do exactly these steps, one after the other, and nothing else:
1. Call mcp__session-control__launch_worker once with exactly these inputs and no others: dir "$WORK", model "haiku", effort "low", title "e2e pong worker", timeout_minutes 5, section "$FREE", prompt "$WORKER_PROMPT". Give no prompt_file and no rules.
2. Run this one Bash command in the foreground, with a timeout of 600000 ms, and wait for it to finish: sh "$S/wait-outcome.sh" "$REG" "$S" "$RUNS"
3. Call mcp__session-control__close_worker with session_ids set to a list holding the full session id the launch tool returned in step 1.
4. Call mcp__session-control__retire_workers with session_ids ["$H1", "$H2", "$H3"].
5. Call mcp__session-control__archive_decisions with sections ["$QUEUED"].
6. Call mcp__session-control__archive_decisions with sections ["$FREE"].
7. Call mcp__session-control__list_sessions with no input.
Then answer with one line: done.
EOF

# ---------------------------------------------------------------- the orchestrator
(cd "$ORCH" && SESSION_CONTROL_DEBUG=1 exec claude -p --plugin-dir "$MOD" --model haiku --dangerously-skip-permissions \
  --max-budget-usd 0.25 --output-format json --settings "$SETTINGS" < "$S/instruction.txt" > "$S/orchestrator.json" 2> "$S/orchestrator.err") &
OPID=$!
elapsed=0
while kill -0 "$OPID" 2>/dev/null && [ "$elapsed" -lt 540 ]; do
  [ -z "$WPID" ] && WPID=$(jq -r '(.[] | select(.title == "e2e pong worker")).pid // empty' "$REG" 2>/dev/null)
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
OPID=''
OSID=$(jq -r '.session_id // empty' "$S/orchestrator.json" 2>/dev/null)
info "orchestrator cost USD $(jq -r '.total_cost_usd // "?"' "$S/orchestrator.json" 2>/dev/null), session $OSID (config dir $CFG_DEFAULT, cwd $ORCH)"
OT=$(ls "$CFG_DEFAULT"/projects/*/"$OSID".jsonl 2>/dev/null | head -n 1)
[ -n "$OSID" ] && [ -f "$OT" ] && pass "orchestrator transcript found ($OT)" || fail "orchestrator transcript found (session '$OSID')"

# The output of the n-th call of a tool, from the transcript's tool_result of that call.
out() {
  _id=$(jq -r --arg n "mcp__session-control__$1" 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == $n) | .id' "$OT" 2>/dev/null | sed -n "${2:-1}p")
  [ -n "$_id" ] || return 1
  jq -r --arg id "$_id" 'select(.type == "user") | .message.content[]? | select(.type == "tool_result" and .tool_use_id == $id) | .content | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end' "$OT" > "$S/out-$3.txt" 2>/dev/null
  [ -s "$S/out-$3.txt" ]
}
has() { grep -F -q -- "$2" "$S/out-$1.txt"; }
check() { if has "$1" "$2"; then pass "$1: $3"; else fail "$1: $3 (missing: $2)"; fi; }
lacks() { if has "$1" "$2"; then fail "$1: $3 (found: $2)"; else pass "$1: $3"; fi; }
for spec in 'launch_worker 1 launch' 'close_worker 1 close' 'retire_workers 1 hostile' 'archive_decisions 1 archive-refused' 'archive_decisions 2 archive' 'list_sessions 1 list'; do
  set -- $spec
  if out "$1" "$2" "$3"; then pass "$3: $1 call $2 was made and answered ($(wc -c < "$S/out-$3.txt" | tr -d ' ') bytes)"; else fail "$3: $1 call $2 was made and answered"; : > "$S/out-$3.txt"; fi
done
CALLS=$(jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$OT" 2>/dev/null | sort | uniq -c | tr -s ' ' | tr '\n' ';')
info "tool calls of the orchestrator: $CALLS"
INPUT=$(jq -c 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == "mcp__session-control__launch_worker") | .input' "$OT" 2>/dev/null | head -n 1)
if printf '%s' "$INPUT" | jq -e --arg s "$FREE" '.prompt != null and .prompt_file == null and .section == $s and .rules == null' >/dev/null 2>&1; then pass 'launch: called with an inline prompt and the section, no prompt_file, rules left to the default'; else fail "launch: called with an inline prompt and the section, no prompt_file, rules left to the default: $INPUT"; fi

# ---------------------------------------------------------------- launch_worker and the prompt file it wrote
SID=$(jq -r '(.[] | select(.title == "e2e pong worker")).session_id // empty' "$S/registry-at-outcome.json" 2>/dev/null)
SID8=$(printf '%s' "$SID" | cut -c1-8)
RESULT_FILE=$(jq -r '(.[] | select(.title == "e2e pong worker")).result_file // empty' "$S/registry-at-outcome.json" 2>/dev/null)
ERR_FILE=$(jq -r '(.[] | select(.title == "e2e pong worker")).err_file // empty' "$S/registry-at-outcome.json" 2>/dev/null)
PROMPT_FILE=$(jq -r '(.[] | select(.title == "e2e pong worker")).prompt_file // empty' "$S/registry-at-outcome.json" 2>/dev/null)
WORKER_NAME=$(jq -r '(.[] | select(.title == "e2e pong worker")).name // empty' "$S/registry-at-outcome.json" 2>/dev/null)
OWN_PROMPT=$RUNS/$WORKER_NAME.prompt.md
check launch "Launched pid " 'the worker was launched'
check launch ", registered. Name: w-e2e-pong-worker-" 'registered under its session name'
check launch "Prompt: $OWN_PROMPT (written by the mod; section \"$FREE\" appended; rules block appended)." 'the answer names the prompt file and what was appended'
if [ -n "$WORKER_NAME" ] && [ "$PROMPT_FILE" = "$OWN_PROMPT" ]; then pass "registry: prompt_file is the mod's file in the runs directory, named by the session name ($PROMPT_FILE)"; else fail "registry: prompt_file is the mod's file in the runs directory, named by the session name (got '$PROMPT_FILE', name '$WORKER_NAME')"; fi
if jq -e --arg s "$FREE" '(.[] | select(.title == "e2e pong worker")) | .section == $s and .outcome.kind == "clean" and (has("pid") | not)' "$S/registry-at-outcome.json" >/dev/null 2>&1; then pass 'registry: section recorded, outcome clean, pid dropped at the harvest'; else fail "registry: section recorded, outcome clean, pid dropped at the harvest: $(head -c 400 "$S/registry-at-outcome.json" 2>/dev/null)"; fi
P=$S/prompt-copy.md
if [ -s "$P" ]; then
  pass "the prompt file was there at the worker's outcome ($(wc -c < "$P" | tr -d ' ') bytes)"
  if head -n 1 "$P" | grep -F -q "$WORKER_PROMPT"; then pass 'prompt file: starts with the prompt given'; else fail "prompt file: starts with the prompt given: $(head -n 1 "$P")"; fi
  if grep -F -x -q "## Binding decisions (section $FREE)" "$P"; then pass 'prompt file: the section block title'; else fail 'prompt file: the section block title'; fi
  if grep -F -x -q "e2efree-2. $SECTION_MARKER: this line reaches the worker prompt." "$P" && grep -F -x -q 'e2efree-1. The worker replies PONG and nothing else.' "$P"; then pass "prompt file: the section's two decision lines as the file holds them"; else fail "prompt file: the section's two decision lines as the file holds them"; fi
  lacks_p() { if grep -F -q -- "$1" "$P"; then fail "prompt file: $2"; else pass "prompt file: $2"; fi; }
  lacks_p 'e2eq-1.' "the other section's text is not in it"
  N=$(grep -c -F -x '## Standard rules (session-control)' "$P")
  [ "$N" = 1 ] && pass 'prompt file: the rules block once' || fail "prompt file: the rules block once (found $N)"
  MISSING=''
  for phrase in 'no AI attribution trailer' 'never mention an agent' 'No human answers during the run' 'never for a sign-off item' 'Never read, print or pass a credential' 'run_in_background: true' 'foreground calls under ten minutes' 'Never end the turn while a run' '`git status -sb`' '`git log --oneline @{u}..HEAD`' 'exit code'; do
    grep -F -q -- "$phrase" "$P" || MISSING="$MISSING \"$phrase\""
  done
  [ -z "$MISSING" ] && pass 'prompt file: the rules block carries each item' || fail "prompt file: the rules block lacks$MISSING"
  if grep -n -F "## Binding decisions" "$P" | cut -d: -f1 | { read -r a; b=$(grep -n -F '## Standard rules' "$P" | cut -d: -f1); [ "$a" -lt "$b" ]; }; then pass 'prompt file: the section block comes before the rules block'; else fail 'prompt file: the section block comes before the rules block'; fi
else
  fail 'the prompt file was there at the worker outcome'
fi
info "run files at the outcome: $(tr '\n' ' ' < "$S/runs-at-outcome.txt" 2>/dev/null)"
[ -n "$RESULT_FILE" ] && info "worker session $SID (config dir $CFG_DEFAULT, cwd $WORK)"

# ---------------------------------------------------------------- close_worker and the run files
NAME_JSON=$(basename "$RESULT_FILE")
NAME_ERR=$(basename "$ERR_FILE")
NAME_PROMPT=$(basename "$PROMPT_FILE")
check close "Acknowledged: $SID8. Retired: $SID8." 'acknowledged, then retired'
check close "Run files deleted from $RUNS: $SID8 ($NAME_JSON, $NAME_ERR, $NAME_PROMPT)." 'the answer lists the run files deleted'
for f in "$RESULT_FILE" "$ERR_FILE" "$PROMPT_FILE"; do
  if [ -n "$f" ] && [ ! -e "$f" ]; then pass "run file deleted: $(basename "$f")"; else fail "run file deleted: $f"; fi
done
WT=$(ls "$CFG_DEFAULT"/projects/*/"$SID".jsonl 2>/dev/null | head -n 1)
[ -n "$SID" ] && [ -s "$WT" ] && pass "the worker's transcript stays ($WT)" || fail "the worker's transcript stays (session '$SID')"
if jq -e 'length == 0' "$REG" >/dev/null 2>&1; then pass 'registry: the entry is gone'; else fail "registry: the entry is gone: $(head -c 300 "$REG")"; fi
CL=$(head -n 1 "$RUNS/cleared.jsonl" 2>/dev/null)
if printf '%s' "$CL" | jq -e --arg s "$SID" '.session_id == $s and .outcome.kind == "clean" and (.cost_usd | type) == "number" and (.duration_ms | type) == "number" and (.prompt_file | type) == "string"' >/dev/null 2>&1; then
  pass "cleared.jsonl: the entry with its outcome, cost_usd $(printf '%s' "$CL" | jq -r .cost_usd) and duration_ms $(printf '%s' "$CL" | jq -r .duration_ms)"
else
  fail "cleared.jsonl: the entry with its outcome, cost_usd and duration_ms: $(printf '%s' "$CL" | head -c 400)"
fi

# ---------------------------------------------------------------- retire_workers over entries whose files lead out of the runs folder
check hostile "Retired: ${H1%%-*}, ${H2%%-*}, ${H3%%-*}." 'the three hostile entries are retired'
check hostile 'not deleted: hostile-link.json: is a symbolic link' 'the symbolic link as a result file is named and kept'
check hostile 'not deleted: secret2.txt: the path has . or .. segments' 'the .. path is named and refused'
check hostile 'not deleted: secret3.txt: not directly in the runs folder' 'the file named through a linked folder is named and refused'
lacks hostile 'Run files deleted' 'nothing is reported deleted for them'
[ "$(cat "$OUT/secret1.txt" 2>/dev/null)" = 'outside secret 1' ] && pass 'outside: the file the symbolic link leads to is intact' || fail 'outside: the file the symbolic link leads to is intact'
[ "$(cat "$OUT/secret2.txt" 2>/dev/null)" = 'outside secret 2' ] && pass 'outside: the file the .. path names is intact' || fail 'outside: the file the .. path names is intact'
[ "$(cat "$S/outside-dir/secret3.txt" 2>/dev/null)" = 'outside secret 3' ] && pass 'outside: the file behind the linked folder is intact' || fail 'outside: the file behind the linked folder is intact'
if [ -L "$RUNS/hostile-link.json" ] && [ -L "$RUNS/hostile-dir" ]; then pass 'the two symbolic links in the runs folder are still links'; else fail 'the two symbolic links in the runs folder are still links'; fi
[ "$(jq -s -r 'map(select(.title | startswith("hostile"))) | length' "$RUNS/cleared.jsonl" 2>/dev/null)" = 3 ] && pass 'cleared.jsonl: the three hostile entries are logged' || fail 'cleared.jsonl: the three hostile entries are logged'

# ---------------------------------------------------------------- archive_decisions
check archive-refused "nothing archived: \"$QUEUED\" is still named: queue task e2e-q (queued) names it by feature/e2e-queued" 'the section a queue task names is refused, saying which'
SUMMARY="- $FREE (ids e2efree-1 to e2efree-2): archived $TODAY to agreed-decisions-archive.md"
check archive "agreed-decisions.md: archived \"$FREE\" to agreed-decisions-archive.md; the summary lines under \"## Archived sections\": $SUMMARY. Backup: backups/agreed-decisions-before-archive-decisions-$TODAY.md (once per day)." 'the free section is archived'
# The section ends with the blank line before the next heading ($(...) dropped it from FREE_TEXT).
printf '# Agreed decisions archive\n\n# Archived %s from agreed-decisions.md\n\n%s\n\n' "$TODAY" "$FREE_TEXT" > "$S/archive-want.md"
if cmp -s "$S/archive-want.md" "$ORCH/agreed-decisions-archive.md"; then pass 'the archive file: its header, a dated header line, the section byte for byte'; else fail "the archive file: $(head -c 400 "$ORCH/agreed-decisions-archive.md" 2>/dev/null | tr '\n' '|')"; fi
printf '%s\n' '# Agreed decisions' '' 'Scratch decisions of the write-tools test.' '' '## Archived sections' "$SUMMARY" '' "## $QUEUED" 'e2eq-1. A queue task still names this unit.' > "$S/decisions-want.md"
if cmp -s "$S/decisions-want.md" "$ORCH/agreed-decisions.md"; then pass 'the decisions file: one summary line under Archived sections, the queued section kept'; else fail "the decisions file: $(head -c 400 "$ORCH/agreed-decisions.md" | tr '\n' '|')"; fi
if cmp -s "$S/decisions-before.md" "$ORCH/backups/agreed-decisions-before-archive-decisions-$TODAY.md"; then pass 'the backup holds the decisions file as it was'; else fail 'the backup holds the decisions file as it was'; fi
if ls "$ORCH"/*.tmp.* >/dev/null 2>&1; then fail 'no temporary file left in the orchestrator directory'; else pass 'no temporary file left in the orchestrator directory'; fi

# ---------------------------------------------------------------- list_sessions
check list 'session row' 'the count line'
lacks list "$SID" 'the retired worker is no row'
check list "| cwd $ORCH | config_dir " 'the orchestrator itself is the orphan row'

# ---------------------------------------------------------------- the trace keeps no prompt or section text
for marker in "$PROMPT_MARKER" "$SECTION_MARKER" "$FREE"; do
  if grep -F -q -- "$marker" "$TRACE" 2>/dev/null; then fail "the trace does not hold \"$marker\""; else pass "the trace does not hold \"$marker\""; fi
done
if grep -F -q '"event":"launch.prompt"' "$TRACE" && grep -F -q '"event":"retire.cleanup","deleted":1,"failed":0' "$TRACE"; then pass 'the trace has the launch.prompt and retire.cleanup lines'; else fail 'the trace has the launch.prompt and retire.cleanup lines'; fi

if [ -n "${KEEP_OUT:-}" ]; then
  mkdir -p "$KEEP_OUT" && cp "$S"/out-*.txt "$S/prompt-copy.md" "$S/registry-at-outcome.json" "$S/runs-at-outcome.txt" "$S/orchestrator.json" "$RUNS/cleared.jsonl" "$TRACE" "$KEEP_OUT"/ 2>/dev/null
  cp "$ORCH/agreed-decisions.md" "$KEEP_OUT/agreed-decisions.after.md" 2>/dev/null
  cp "$ORCH/agreed-decisions-archive.md" "$KEEP_OUT"/ 2>/dev/null
  info "outputs copied to $KEEP_OUT"
fi
LEFT=$(ps -eo pid,args 2>/dev/null | grep -F "$S" | grep -v -e grep -e 'e2e-write-tools' | head -n 3)
[ -z "$LEFT" ] && pass 'no process names the scratch directory' || fail "no process names the scratch directory: $LEFT"
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
