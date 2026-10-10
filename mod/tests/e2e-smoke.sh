#!/bin/sh
# End-to-end smoke test of the session-control mod against the real claude, in a scratch directory it makes and
# removes: (a) one headless haiku orchestrator launches one haiku worker through launch_worker and waits for it in the
# foreground; (b) where tmux exists, an interactive claude opens the panel with /session-control (no model call).
# Everything goes to the scratch directory (registry, runs directory, trace); the real registry, helper files and runs
# directory are never touched, and the licence picker option is empty: the worker gets no CLAUDE_CONFIG_DIR and
# inherits the default configuration (this shell's CLAUDE_CONFIG_DIR, else ~/.claude), which the registry records.
# POSIX sh, for Linux and Git Bash: sh mod/tests/e2e-smoke.sh. A few cents of haiku (the orchestrator is capped at
# USD 0.25). One line per check; exit 1 on a failure. KEEP_TRACE=<file> copies the trace there before the scratch
# directory goes.
set -u

MOD=$(cd "$(dirname "$0")/.." && pwd -P)
FAILED=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=1; }
skip() { printf 'skip %s\n' "$1"; }
info() { printf 'info %s\n' "$1"; }
# A path as claude and the mod take it: native C:/... in Git Bash, unchanged elsewhere; msys() is its /c/... form.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
msys() { native "$1" | sed -E 's#^([A-Za-z]):/#/\1/#'; }

command -v claude >/dev/null 2>&1 || { fail 'claude is on the PATH'; exit 1; }
# Git Bash: the Windows claude.exe offers its Bash tool only when it finds Git Bash, and started from Git Bash (its
# mingw64 git.exe first on the PATH) it can miss a per-user Git: point it at this Git's bin\bash.exe.
if command -v cygpath >/dev/null 2>&1 && [ -z "${CLAUDE_CODE_GIT_BASH_PATH:-}" ] && [ -f "$(cygpath -u "$(cygpath -w /)")bin/bash.exe" ]; then
  CLAUDE_CODE_GIT_BASH_PATH="$(cygpath -w /)bin\\bash.exe"
  export CLAUDE_CODE_GIT_BASH_PATH
  info "CLAUDE_CODE_GIT_BASH_PATH set to $CLAUDE_CODE_GIT_BASH_PATH"
fi
S=$(mktemp -d "${TMPDIR:-/tmp}/session-control-e2e.XXXXXX") || { fail 'scratch directory made'; exit 1; }
S=$(cd "$S" && pwd -P)
ORCH=$S/orch
# The worker's directory carries a canary that looks like a key: the trace must show it as [redacted].
CANARY=sk-e2ecanary00000000
WORK=$S/work-$CANARY
RUNS=$S/runs
REG=$S/headless-sessions.json
PROMPT=$S/worker-prompt.md
TRACE=$RUNS/trace.log
OPID=''
WPID=''
TSOCK=''

# Whether a pid is still one this test started: its command line names the scratch directory (a pid the system has
# handed to another process since is never killed).
ours() { [ -n "$1" ] && tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -F -q -e "$S" -e "$(native "$S")"; }
cleanup() {
  ours "$OPID" && kill "$OPID" 2>/dev/null
  ours "$WPID" && kill "$WPID" 2>/dev/null
  [ -n "$TSOCK" ] && tmux -L "$TSOCK" kill-server 2>/dev/null
  rm -rf "$S"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

mkdir -p "$ORCH" "$WORK" "$RUNS"
printf '%s\n' '# Role: Session Orchestrator' '' 'Scratch orchestrator of the session-control smoke test: do exactly what the prompt says.' > "$ORCH/CLAUDE.md"
# The launch guard wants the prompt to name a foreground wait, the git status -sb report and no AI attribution.
cat > "$PROMPT" <<'EOF'
Smoke test of a worker launch: reply with the single word PONG and stop.
Use no tool. There is nothing to wait for in the foreground, no git status -sb to report and no commit, so no AI attribution question arises.
EOF
# The worker's command line carries its prompt: with the scratch path in it, the exit trap can tell the worker is ours.
printf 'Scratch directory of this smoke test: %s\n' "$S" >> "$PROMPT"
PROMPT_PHRASE='reply with the single word PONG'
cat > "$S/wait-outcome.sh" <<'EOF'
n=0
until grep -q '"outcome"' "$1" 2>/dev/null; do n=$((n + 1)); [ "$n" -gt 100 ] && exit 1; sleep 3; done
EOF
SETTINGS=$(printf '{"pluginConfigs":{"session-control@inline":{"options":{"orchestratorDir":"%s","registryPath":"%s","runsDir":"%s","licencePickCommand":"","completionWrites":true,"pollSeconds":2,"debug":false}}}}' \
  "$(native "$ORCH")" "$(native "$REG")" "$(native "$RUNS")")
cat > "$S/instruction.txt" <<EOF
This is an automated smoke test of the session-control mod. Do exactly these three steps and nothing else:
1. Call the tool mcp__session-control__launch_worker once, with dir "$(msys "$WORK")", prompt_file "$(msys "$PROMPT")", model "haiku", effort "low", title "e2e smoke worker" and timeout_minutes 5.
2. Run this one Bash command in the foreground, with a timeout of 600000 ms, and wait for it to finish: sh "$(native "$S/wait-outcome.sh")" "$(native "$REG")"
3. Answer with one line: the text the launch tool returned.
EOF

# ---------------------------------------------------------------- (a) headless orchestrator and worker
(cd "$ORCH" && SESSION_CONTROL_DEBUG=1 exec claude -p --plugin-dir "$(native "$MOD")" --model haiku --dangerously-skip-permissions \
  --max-budget-usd 0.25 --output-format json --settings "$SETTINGS" < "$S/instruction.txt" > "$S/orchestrator.json" 2> "$S/orchestrator.err") &
OPID=$!
SEEN_PID=''
# The worker's launch line, read off the command line of the shell that runs it, where /proc shows the worker (not
# in Git Bash, whose /proc does not list a native claude.exe). A haiku worker lives a few seconds: looked for 4 times
# a second.
WLINE=''
catch_worker() {
  for _d in /proc/[0-9]*; do
    [ "$(readlink "$_d/cwd" 2>/dev/null)" = "$WORK" ] && [ "$(cat "$_d/comm" 2>/dev/null)" = claude ] || continue
    _pp=$(sed -n 's/^PPid:[[:space:]]*//p' "$_d/status" 2>/dev/null)
    WLINE=$(tr '\0' ' ' < "/proc/$_pp/cmdline" 2>/dev/null)
    return
  done
}
elapsed=0
while kill -0 "$OPID" 2>/dev/null && [ "$elapsed" -lt 480 ]; do
  if [ -z "$SEEN_PID" ] && [ -f "$REG" ]; then
    SEEN_PID=$(grep -o '"pid": *[0-9]*' "$REG" | head -n 1 | grep -o '[0-9]*$')
    [ -n "$SEEN_PID" ] && WPID=$SEEN_PID
  fi
  for _q in 1 2 3 4; do
    [ -z "$WLINE" ] && [ -d /proc/self ] && ! command -v cygpath >/dev/null 2>&1 && catch_worker
    sleep 0.25
  done
  elapsed=$((elapsed + 1))
done
if kill -0 "$OPID" 2>/dev/null; then
  fail "orchestrator finished within 480 s"
  kill "$OPID" 2>/dev/null
  wait "$OPID" 2>/dev/null
else
  wait "$OPID"
  code=$?
  if [ "$code" -eq 0 ] && grep -q '"is_error": *false' "$S/orchestrator.json"; then pass "orchestrator finished in ${elapsed} s, exit 0"; else fail "orchestrator finished, exit $code: $(head -c 300 "$S/orchestrator.err" "$S/orchestrator.json" 2>/dev/null | tr '\n' ' ')"; fi
fi
OPID=''
info "orchestrator cost USD $(grep -o '"total_cost_usd": *[0-9.e-]*' "$S/orchestrator.json" | grep -o '[0-9.e-]*$')"

field() { grep -o "\"$1\": *\"[^\"]*\"" "$REG" 2>/dev/null | head -n 1 | sed 's/.*: *"//; s/"$//'; }
if [ -n "$SEEN_PID" ]; then pass "registry entry had a pid while the worker ran ($SEEN_PID)"; else fail 'registry entry had a pid while the worker ran'; fi
SID=$(field session_id)
if printf '%s' "$SID" | grep -Eq '^[0-9a-f-]{36}$'; then pass "registry entry has a session_id ($SID)"; else fail "registry entry has a session_id (got '$SID')"; fi
KIND=$(grep -o '"kind": *"[a-z]*"' "$REG" 2>/dev/null | head -n 1 | sed 's/.*: *"//; s/"$//')
if [ "$KIND" = clean ]; then pass 'registry entry has the outcome clean'; else fail "registry entry has the outcome clean (got '$KIND')"; fi
RESULT_FILE=$(field result_file)
ERR_FILE=$(field err_file)
if [ -n "$RESULT_FILE" ] && [ -s "$RESULT_FILE" ]; then pass 'worker result file exists'; else fail "worker result file exists ('$RESULT_FILE')"; fi
if [ -n "$ERR_FILE" ] && [ -e "$ERR_FILE" ]; then pass 'worker error file exists'; else fail "worker error file exists ('$ERR_FILE')"; fi
# No picker: the registry records the configuration the worker inherited.
WANT_CFG=$(native "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")
CFG=$(field config_dir)
if [ "$CFG" = "$WANT_CFG" ]; then pass "registry entry has the inherited config_dir ($CFG)"; else fail "registry entry has the inherited config_dir $WANT_CFG (got '$CFG')"; fi
if [ -n "$WLINE" ]; then
  if printf '%s' "$WLINE" | grep -F -q 'claude -p' && ! printf '%s' "$WLINE" | grep -F -q 'CLAUDE_CONFIG_DIR='; then pass "worker's launch line sets no CLAUDE_CONFIG_DIR"; else fail "worker's launch line sets no CLAUDE_CONFIG_DIR: $(printf '%s' "$WLINE" | head -c 300)"; fi
else
  skip "worker's launch line (its shell not seen in /proc)"
fi
[ -n "$RESULT_FILE" ] && info "worker cost USD $(grep -o '"total_cost_usd": *[0-9.e-]*' "$RESULT_FILE" 2>/dev/null | grep -o '[0-9.e-]*$')"

has() { grep -F -q -- "$1" "$TRACE" 2>/dev/null; }
if has '"event":"tool.call","tool":"launch_worker"'; then pass 'trace has the launch tool.call line'; else fail 'trace has the launch tool.call line'; fi
if has '"event":"process.run","argv":["sh","-c","<PROBE_SCRIPT>"' || grep -F '"event":"process.run"' "$TRACE" 2>/dev/null | grep -F -q 'probe.ps1'; then pass 'trace has the process.run line of the probe'; else fail 'trace has the process.run line of the probe'; fi
REGN=$(native "$REG")
if has "\"event\":\"fs.write\",\"path\":\"$REGN.tmp." && grep -F '"event":"process.run"' "$TRACE" | grep -F -q "$REGN.tmp." && has '"event":"worker.registered"'; then
  pass 'trace has the register write: its temp file and the process.run of the rename'
else
  fail 'trace has the register write: its temp file and the process.run of the rename'
fi
if has '"event":"worker.start"' && has '"isConfigDirSet":false'; then pass 'trace: the worker.start line sets no CLAUDE_CONFIG_DIR'; else fail 'trace: the worker.start line sets no CLAUDE_CONFIG_DIR'; fi
if has '"licencePickCommand":"empty"' && has "\"registryPath\":\"$REGN\""; then pass 'trace shows the scratch options (scratch registry, no licence picker)'; else fail 'trace shows the scratch options (scratch registry, no licence picker)'; fi
SN=$(native "$S")
OUTSIDE=$(grep -E -o '"event":"fs\.(write|append)","path":"[^"]*"' "$TRACE" 2>/dev/null | sed 's/.*"path":"//; s/"$//' | grep -v -F "$SN/" | head -n 3)
if has '"event":"fs.write"' && [ -z "$OUTSIDE" ]; then pass 'trace: every file write is inside the scratch directory'; else fail "trace: every file write is inside the scratch directory (outside: $OUTSIDE)"; fi
if has 'work-[redacted]' && ! has "$CANARY"; then pass 'trace: the key-like canary in the worker directory is [redacted]'; else fail 'trace: the key-like canary in the worker directory is [redacted]'; fi
if command -v jq >/dev/null 2>&1; then
  if jq -e . "$TRACE" >/dev/null 2>&1; then pass "trace: all $(wc -l < "$TRACE" | tr -d ' ') lines are JSON"; else fail 'trace: all lines are JSON'; fi
else
  skip 'trace: all lines are JSON (no jq)'
fi

# ---------------------------------------------------------------- (b) interactive panel in tmux
if command -v tmux >/dev/null 2>&1; then
  TSOCK=session-control-e2e-$$
  ISETTINGS=$(printf '%s' "$SETTINGS" | sed 's/^{/{"tui":"fullscreen",/')
  printf "cd '%s' && SESSION_CONTROL_DEBUG=1 claude --plugin-dir '%s' --model haiku --settings '%s'\necho \"claude exited with \$?\"\nexec sleep 300\n" "$ORCH" "$MOD" "$ISETTINGS" > "$S/interactive.sh"
  # The pane stays after claude exits (the script sleeps on), so a failure can show what it said.
  tmux -L "$TSOCK" -f /dev/null new-session -d -s e2e -x 200 -y 50 "sh '$S/interactive.sh'"
  pane() { tmux -L "$TSOCK" capture-pane -p -t e2e 2>/dev/null; }
  # sh has no local variables: the wait counts with a name of its own.
  wait_for() { _w=0; while [ "$_w" -lt "$2" ]; do pane | grep -E -q -i -- "$1" && return 0; sleep 1; _w=$((_w + 1)); done; return 1; }
  # A folder seen for the first time asks for trust first, with "No, exit" selected: the cursor goes down to the
  # option that trusts it, then Enter.
  if wait_for 'trust this folder|shortcuts' 40 && pane | grep -q 'Yes, I trust this folder'; then
    sleep 1
    _d=0
    while ! pane | grep -q '❯ *Yes, I trust this folder' && [ "$_d" -lt 3 ]; do tmux -L "$TSOCK" send-keys -t e2e Down; sleep 1; _d=$((_d + 1)); done
    if pane | grep -q '❯ *Yes, I trust this folder'; then
      tmux -L "$TSOCK" send-keys -t e2e Enter
      info 'answered the folder trust question: Yes, I trust this folder'
    else
      info 'the trust question has no selectable "Yes, I trust this folder":'
      pane | sed 's/^/     | /' | grep -v '^     | *$' | head -n 30
    fi
  fi
  # Typed again (the line cleared first) until the prompt shows it: keys sent while the screen starts are lost.
  n=0
  while [ "$n" -lt 6 ]; do
    sleep 3
    tmux -L "$TSOCK" send-keys -t e2e C-u
    tmux -L "$TSOCK" send-keys -t e2e -l '/session-control'
    sleep 2
    pane | grep -F -q '/session-control' && break
    n=$((n + 1))
  done
  tmux -L "$TSOCK" send-keys -t e2e Enter
  wait_for 'QUEUED WORK' 15 || { tmux -L "$TSOCK" send-keys -t e2e Enter; wait_for 'QUEUED WORK' 30; }
  sleep 2
  pane > "$S/pane.txt"
  missing=''
  for title in 'SESSIONS' 'QUEUED WORK' 'OPEN POINTS'; do grep -F -q "$title" "$S/pane.txt" || missing="$missing $title"; done
  if [ -z "$missing" ]; then
    pass 'interactive panel shows SESSIONS, QUEUED WORK and OPEN POINTS'
  else
    fail "interactive panel shows SESSIONS, QUEUED WORK and OPEN POINTS (missing:$missing); the pane:"
    sed 's/^/     | /' "$S/pane.txt" | grep -v '^     | *$' | head -n 50
  fi
  if [ "$(grep -F -c '"event":"session.start"' "$TRACE" 2>/dev/null)" -ge 2 ] && has '"event":"command.run","command":"session-control"'; then pass 'trace has the interactive session start and its /session-control line'; else fail 'trace has the interactive session start and its /session-control line'; fi
  # /exit is the engine's own command (no model call); two ctrl+c are the fallback.
  tmux -L "$TSOCK" send-keys -t e2e C-u
  tmux -L "$TSOCK" send-keys -t e2e -l '/exit'
  sleep 2
  tmux -L "$TSOCK" send-keys -t e2e Enter
  if ! wait_for 'claude exited with' 15; then
    tmux -L "$TSOCK" send-keys -t e2e C-c
    sleep 1
    tmux -L "$TSOCK" send-keys -t e2e C-c
    wait_for 'claude exited with' 10
  fi
  if pane | grep -q 'claude exited with'; then pass "interactive session closed ($(pane | grep -o 'claude exited with [0-9]*'))"; else fail 'interactive session closed with /exit or ctrl+c'; pane | sed 's/^/     | /' | grep -v '^     | *$' | tail -n 15; fi
  tmux -L "$TSOCK" kill-server 2>/dev/null
  TSOCK=''
else
  skip 'interactive panel (no tmux)'
fi

# ---------------------------------------------------------------- (c) the prompt never in the trace; clean up
if [ -s "$TRACE" ] && ! grep -F -q -- "$PROMPT_PHRASE" "$TRACE" && ! grep -F -q -- 'nothing to wait for in the foreground' "$TRACE"; then pass 'trace: no line contains the prompt text'; else fail 'trace: no line contains the prompt text'; fi
# A process ended by the tmux server's exit may take a moment to go.
_l=0
while :; do
  LEFT=$(ps -eo pid,args 2>/dev/null | grep -F "$S" | grep -v -e grep -e "e2e-smoke" | head -n 3)
  [ -z "$LEFT" ] || [ "$_l" -ge 10 ] && break
  sleep 1
  _l=$((_l + 1))
done
if [ -n "$WPID" ] && kill -0 "$WPID" 2>/dev/null; then
  fail "worker pid $WPID has exited"
elif [ -n "$LEFT" ]; then
  fail "no process names the scratch directory: $LEFT"
else
  pass 'no orchestrator, worker, interactive claude or tmux process left'
fi
WPID=''
if [ "${KEEP_TRACE:-}" != '' ] && [ -f "$TRACE" ]; then cp "$TRACE" "$KEEP_TRACE" && info "trace copied to $KEEP_TRACE"; fi
trap - EXIT
cleanup
if [ -e "$S" ]; then fail "scratch directory $S removed"; else pass 'scratch directory removed'; fi
exit "$FAILED"
