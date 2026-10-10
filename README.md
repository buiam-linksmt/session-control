# session-control

An orchestrator kit for Claude Code. One interactive session, the orchestrator, launches and manages headless `claude -p` worker sessions and reports their results.

- `CLAUDE.md` holds the orchestrator's instructions. The session reads it from its working directory.
- `mod/` is the session-control mod. It provides:
  - a side panel with the worker sessions, the queued work and the open points;
  - the worker tools `launch_worker`, `acknowledge_workers` and `retire_workers`;
  - the bookkeeping tools `open_point`, `queue_task` and `record_decision`;
  - a report check that sends a faulty orchestrator report back once.
- `model-complexity-matrix.md` is the lookup table for the model and effort of each worker. `CLAUDE.md` requires it at every launch.

## Requirements

- Linux or WSL with `/proc`.
- POSIX `sh` and the GNU tools the mod's shell scripts call: `jq`, `getconf`, `readlink`, `stat`, `sed`, `tr`, `cut`, `ls`, `head`, `tail`, `cat`, `sleep`, `mv`, `rm`, `mkdir`, `test`. They read process facts and edit the worker registry.
- `git`, to clone the repository and, for workers, to create worktrees.
- A Claude Code build that supports mods. Tested on 2.1.292 and 2.1.295.
- Python 3 (standard library only), only to run the self-tests `mod/tests/probe-selftest.py`. The mod itself runs no Python.
- Optional: Node.js 22 or newer, as `node` on the PATH or named by the `nodePath` option. With it the mod runs its file operations, and on Linux its process probe, through its own helper (`mod/helper/`, see Node helper); without it, or with the `helper` option set to `off`, the built-in `sh` (Linux) and PowerShell (Windows) operations run as before, with nothing to configure. The mod's hooks themselves run inside Claude Code's plugin sandbox, which has no Node.js API. Node.js 22 or newer is also what runs the helper's own tests.
- Optional: a licence picker command, set with the `licencePickCommand` option. `launch_worker` runs it for a fresh launch with `{need}` replaced by the headroom percent (a leading `~/` is expanded); it must print one absolute config directory on stdout and exit 0, or exit 3 when no licence has room. The command is split on blanks (no quoting; a path with spaces is not supported). Without the option a fresh worker gets no `CLAUDE_CONFIG_DIR` of its own and inherits the machine's default configuration: the orchestrator's `CLAUDE_CONFIG_DIR` when that is set, else `~/.claude` with the global config in `~/.claude.json`; the registry records that directory. `CLAUDE.md` leaves licence handling (headroom, reset times, event log) to the user-level instructions in `~/.claude/CLAUDE.md`. On a machine without licence tooling nothing needs configuring: every worker runs under the default config directory, `launch_worker` never refuses for licence room, and the licence steps in `CLAUDE.md` do not apply.

## Setup

1. Clone the repository. `CLAUDE.md` names the clone's parent directory as the workspaces directory: workers are launched in project directories below it.

   ```sh
   git clone git@github.com:llakeethur/session-control.git
   cd session-control
   ```

2. Start Claude Code from the clone's root with the mod loaded from its folder:

   ```sh
   claude --plugin-dir ./mod
   ```

   `CLAUDE.md` is picked up automatically from the working directory. The mod becomes active only in a directory whose `CLAUDE.md` starts with `# Role: Session Orchestrator`, unless the `orchestratorDir` option is set. Elsewhere `/session-control` answers that the directory is not an orchestrator directory and nothing else happens.

   This repository is not installed through the plugin marketplace. The mod is always loaded with `--plugin-dir`.

## First start

When the mod becomes active it creates each missing helper file from scratch and never overwrites an existing one:

| Path | Created as |
| --- | --- |
| `open-points.json` in the clone | an object with a short `_cleanup` text field and an empty `points` array |
| `task-queue.json` in the clone | an object with an empty `tasks` array |
| `agreed-decisions.md` in the clone | the heading `# Agreed decisions` |
| `open-points-archive.md` in the clone | the heading `# Open points archive` |
| `backups/` in the clone | an empty directory |
| `~/.claude/headless-sessions.json` | `[]` |
| `~/.claude/session-control/runs` | an empty directory |

The bookkeeping tools write a backup of the file they change into `backups/`, once per file, tool and day, before the first change of that day. `~/.claude/session-control/runs` receives each worker's result and error file and the log of retired registry entries (`cleared.jsonl`).

## Using it

`/session-control` shows or hides the side panel. The panel has three sections: Sessions, Queued work and Open points. The `[+]` icon in a section's header expands that section to the panel and keeps the other two as one-line headers with their own `[+]`, which expands that section directly (one section is expanded at a time); `[-]` returns to the three boxes, and opening a session's log returns to the log layout (sessions one third, log two thirds); an open log closes by itself, back to the three sections, when its session is no longer in the registry (a registry that cannot be read or parsed, or whose text is empty, keeps the log open). Tracking of runs, the completion handling and the report check run whether the panel is shown or not. The Sessions section lists every registry entry and, as an `orphan` row `(no entry) <cwd>`, each live headless `claude -p` process no entry claims; the licence daemon's own short runs are left out: a process whose prompt argument is `/usage` (the usage probe, `claude -p /usage --output-format json --no-session-persistence`) or `ok` (the token wake, `claude -p ok`), followed only by options, is not an orphan, while a worker whose prompt merely contains those words still is. The elapsed column reads `42s` under a minute, `5m12s` under an hour and `1h05m` from an hour up: a running worker counts from its entry's `started_at`, a finished one shows its run (`ended_at` less `started_at`), and an orphan or an entry without `started_at` shows the process age the probe read plus the time since that probe. While the panel is shown a one-second display tick recomputes that text and redraws, with no process started and no file read; it stops when the panel is hidden or closed, and the process probe keeps its own `pollSeconds` interval.

Worker completion: when a registered worker's process is gone, the mod classifies its result file and its error file (`clean`, `limit`, `login`, `killed`, `error` or `chatter`). `limit`, `login` and a memory kill come only from reliable signals: the API error status (429, 401), the result text and `errors` of a failed run (`is_error` true or a subtype other than `success`), a result file that is not JSON, and the error file; a result that is a success (`subtype` `success`, `is_error` false, no 429 or 401) is `clean` whatever the error file says, so a benign stderr line such as "usage limit reached, retrying" changes nothing, and the error file counts only when the result is not a success. The cost of that rule: a result file carrying `success` that is followed by a crash or an out-of-memory kill afterwards still reads as `clean`, because the successful result wins over the error file. A failed run's message may sit in `errors` (an array of strings) or in a string `error` field instead of `result`; both are read together for `limit`, `login` and a memory kill. The words of a normal report never count, since a report may quote those messages. The mod then shows a toast led by the notification type (`Session finished`, `Usage limit reached`, `Login needed`, `Session killed`, `Session failed`, `Session ended without a report`; the mod's other toasts lead with `Tracking problem`, `Write not atomic` or `Debug trace failed`), then ` · ` and the message (a toast is one line of text: the engine draws no line break in it) and, with `completionWrites` on, merges the outcome into the worker's registry entry (it drops `pid`, sets `reported` to `false` and records the harvest time as `ended_at`, epoch seconds). The outcome reaches the model with the next task notification. For a `clean` outcome the mod also checks the final report: it must carry the output of `git status -sb` (its branch line) and of `git log --oneline @{u}..HEAD`, each with its exit code, as the worker prompts demand; the log's exit code must sit on its command line, in its output block or right after it, and commits are counted only in that block (it ends at a blank line, a code-fence end, an exit marker, the next `git` line or a heading). When one is missing, when that log exited non-zero or when it lists commits (unpushed work), the completion notice gets one more line, `<title>: report check: ...`; the check is tolerant of case, code fences, `$ ` prompts and `exit 0`, `exit=0`, `exit code: 0`, `exit status 0`, `exited 0`, `(exit 0)`, `→ 0`, `-> 0` or `rc=0`, and it is a note only: it never blocks anything and never changes the outcome or the toast. After a context compaction the next prompt carries a digest of the running workers and the open points.

### Tools

The tools are registered when the mod becomes active and are named `mcp__session-control__<tool>` to the model.

| Tool | What it does |
| --- | --- |
| `launch_worker` | Starts or resumes a headless `claude -p` worker as a background task, picks the licence for a fresh launch with the configured licence picker command (or uses the default config directory), finds its pid and session id and registers it in the worker registry. |
| `acknowledge_workers` | Marks finished workers as acknowledged (`reported` true); `keep: true` also marks them as needed for a resume. |
| `retire_workers` | Removes finished, acknowledged, clean workers from the registry and appends the removed entries to `cleared.jsonl`. The optional `reviewed` input maps a session id (full, or the first 8 characters) to a non-empty reason the orchestrator wrote after reading the transcript and finding the stored outcome (`login`, `limit`, `killed`) wrong, or the work deliberately abandoned: for that session only the outcome check is skipped, and the entry's log line gets `reviewed_outcome` (the stored kind) and `reviewed_reason`; the answer says `Retired with review: <id> (was <kind>: <reason>)` and the debug trace's guard line carries both. |
| `open_point` | Adds, answers, closes, holds or releases an entry of `open-points.json`. Settled entries older than 7 days move to `open-points-archive.md`. |
| `queue_task` | Adds, updates or removes a task of `task-queue.json`. |
| `record_decision` | Appends one numbered line to a section of `agreed-decisions.md`; the section is created when missing. |

`launch_worker` refuses, among other cases: a launch directory that is the orchestrator directory or `$HOME`; a missing or empty prompt file; a prompt that lacks a foreground wait, the `git status -sb` report line or the no-attribution instruction (a prompt that says "skill test" is exempt); a resume of a live session; a licence pick that exits 3 or prints nothing usable. A worker is started as `claude -p -n <name> --settings '{"crossSessionInbound":"accept"}' --dangerously-skip-permissions --output-format json` with `CLAUDE_CONFIG_DIR` set to the picked configuration directory and `CLAUDE_CODE_EFFORT_LEVEL` set to the requested effort, through the Bash tool; on native Windows with the `launchRoute` option at `powershell`, through the PowerShell tool instead (see PowerShell launch route).

Inbox: every worker gets a session name with `-n` and accepts messages from other sessions on the machine (`crossSessionInbound` set to `accept` through `--settings`), so the orchestrator can send a running worker a message by its name. The name is `w-`, the slug of the title cut to 24 characters, and the launch time in UTC as `yyMMddHHmmss` (for example `w-fix-the-parser-261010143117`): letters, digits and dashes, at most 39 characters before a uniqueness suffix; a name already in the registry or given out by the same session gets `-2`, `-3` and so on. The uniqueness check covers only the registry and the session's own names, so two orchestrator sessions starting workers with the same title in the same second can still get the same name. A resume passes the same two flags and keeps the entry's name, so a session answers to one name across resumes; an entry without a name (launched before names existed) gets a fresh one. The worker's exit is still detected through the background task's notification.

Registry entry: `launch_worker` records `title`, `pid`, `session_id`, `name`, `socket_path`, `config_dir`, `cwd`, `model`, `effort`, `result_file`, `err_file` and `started_at`, the time the launch started the run in epoch seconds; a resume sets the new run's `started_at` and drops the previous run's `ended_at`. Entries written before these two fields existed stay valid without them. `name` and `socket_path` come from the worker's sessions file `<config_dir>/sessions/<pid>.json` (`name` and `messagingSocketPath`), read with the session id; `name` falls back to the name the launch passed. A claude that writes no socket (an older version) gives an entry without `socket_path`, and a resume then writes `socket_path: null` so the previous run's socket is not kept. The socket is valid only while the pid lives. The launch answer names both.

`acknowledge_workers` and `retire_workers` refuse a worker whose process is alive. `retire_workers` also refuses a worker that is marked keep, whose outcome is not `clean` (unless `reviewed` gives a reason for it) or that a queued or running task names. A `reviewed` entry never lifts the other refusals (a live, kept, unclassified, queue-named or unknown session), and one without a reason, or naming a session that is not in `session_ids`, is refused.

### Options

Defaults are those of `mod/.claude-plugin/plugin.json`.

| Option | Default | Meaning |
| --- | --- | --- |
| `orchestratorDir` | empty | Directory holding `CLAUDE.md` and the helper files. Empty: the session's directory when its `CLAUDE.md` starts with `# Role: Session Orchestrator`. |
| `registryPath` | `~/.claude/headless-sessions.json` | The worker registry, a JSON array. A leading `~` is the home directory. |
| `completionWrites` | `true` | Merge a finished worker's outcome into its registry entry. |
| `pollSeconds` | `5` | How often the session state is gathered. |
| `runsDir` | `~/.claude/session-control/runs` | Directory for the result and error files of launched workers. A leading `~` is the home directory. |
| `licencePickCommand` | empty | Command that picks the licence for a fresh worker launch; `{need}` is replaced by the headroom percent. It prints one absolute config directory and exits 0, or exits 3 when no licence has room. Empty: workers start with the default config directory. |
| `debug` | `false` | Append a debug trace to `trace.log` in the runs directory (see Development). `SESSION_CONTROL_DEBUG=1` in the environment switches it on too. |
| `helper` | `auto` | `auto`: the file operations (and on Linux the process probe) run through the Node helper when Node 22 or newer is found, each call falling back to the built-in operation when the helper fails. `off`: the built-in operations only. Any other value counts as `auto`. |
| `nodePath` | empty | The node executable the helper runs with; a leading `~/` is the home directory. Empty: `node` from the PATH. |
| `launchRoute` | `bash` | `bash`: workers start through the Bash tool (on native Windows Claude Code offers it only when it finds Git Bash). `powershell`: on native Windows they start through the PowerShell tool instead (see PowerShell launch route); on Linux and WSL the option changes nothing. Any other value counts as `bash`. |

Set them in the settings under `pluginConfigs`. A mod loaded with `--plugin-dir` is keyed `session-control@inline`:

```json
{
  "pluginConfigs": {
    "session-control@inline": {
      "options": {
        "pollSeconds": 10
      }
    }
  }
}
```

## Development

Run from the clone's root:

```sh
claude plugin validate ./mod
claude plugin test ./mod
node --test mod/tests/helper.test.mjs
python3 -I mod/tests/probe-selftest.py
```

`claude plugin test` runs the `*.test.ts` files in `mod/tests/` (the Node helper there simulated, see `fake-helper.ts`). `node --test mod/tests/helper.test.mjs` (Node 22 or newer) runs the helper itself as the mod does, one process per request: every operation, the protocol errors and their fixed codes, appends from many processes at once, the tail of a large file against `tail | cut`, and the probe of a fake `/proc` tree against the shell probe's recorded output, with a canary in the fake environment that must never reach an answer. The fake tree is handed to the helper with `SC_HELPER_PROC_ROOT`, which the helper honours only together with `SC_HELPER_TEST=1`; a test checks that the variable alone leaves the live `/proc`. `probe-selftest.py` extracts the process probe from `mod/hooks/host-posix.ts`, checks that it parses under `sh -n` and runs it against a fixture configuration directory. On WSL, `python3 -I mod/tests/windows-selftest.py` runs the Windows PowerShell scripts, the launch line in Git Bash, the PowerShell launch route's command under Windows PowerShell 5.1 and (with `pwsh.exe` on the PATH) PowerShell 7 with `node.exe` standing in for `claude.exe` (see PowerShell launch route; it needs `node` on the WSL side to render the command) and, with `C:\Program Files\nodejs\node.exe` (or `SC_WIN_NODE`), the helper's file operations in a Windows temp folder.

To see what the mod does, set `SESSION_CONTROL_DEBUG=1` in the environment (or the `debug` option). A session where the board is on (the orchestrator directory, or after `/session-control`) then appends one JSON line per event to `trace.log` in the runs directory: commands run (argv with the mod's scripts by name, exit code, duration, stderr size), file writes (path and size), guard verdicts and caught errors (a kind and a message whose quoted text and echoed output become `…`). It never logs credentials, file contents, command output, prompt or transcript text, the environment, a worker's title or the licence picker's command (only whether one is set, and at a launch its executable's name and argument count); text that looks like a token becomes `[redacted]`. Any other session, a worker included, writes nothing. The trace is rotated at about 2 MiB (sessions share it), three files kept.

`sh mod/tests/e2e-smoke.sh` smoke-tests the real `claude` from a scratch directory it removes afterwards: a haiku orchestrator (capped at `--max-budget-usd 0.25`) launches one haiku worker (its launch line with `-n` and the inbox settings, its registry entry with `name` and `socket_path`, and the socket while the worker lives are checked) and, where tmux exists, an interactive session opens the panel; it prints one line per check. It runs under the default configuration (`~/.claude`, `~/.claude.json`): the transcripts, the session files and the trust entry for its scratch folder stay there, and it spends a few cents of the default licence's quota. With Node 22 or newer on the PATH it checks that the trace shows the Node helper in use and no `helper.fallback` line; `HIDE_NODE=1 sh mod/tests/e2e-smoke.sh` starts the claude sessions with every PATH directory holding `node` left out, and checks that the mod found no Node and ran its built-in operations.

After a change to the mod, run the validation and the tests before relying on it.

## Host adapters

Everything the mod does that differs per operating system, or needs a process, goes through one interface, `Host` in `mod/hooks/host.ts`, with two adapters: `host-posix.ts` (Linux and WSL: `sh`, `mv`, `rm`, `tail`, `mkdir`, `sleep`, `/proc`) and `host-windows.ts` (native Windows: Windows PowerShell 5.1 scripts run with `-File`, paths in the `C:/...` form). `selectHost` in `host.ts` is the one platform choice: `OS=Windows_NT` with a drive-letter `USERPROFILE` takes the Windows adapter, anything else the Linux one. `register.tsx` calls it once per load and never branches on the platform itself. Each adapter's scripts sit in its own file; operations both do alike with `$.fs` and plain TypeScript are in `host-shared.ts`.

An adapter never holds `$` (the validator follows `$` only into functions of `register.tsx`): it gets a `HostPort`, the engine facilities `register.tsx` builds over the hook's `$` (`run` and `write`, traced as before; `read`, `exists`, `stat`, `now`, `sleep`, `env` for `HOME`, `USERPROFILE` and `SystemRoot`; the runs directory; `traceError`; `noteDirectWrite`, the once-per-load toast; `noteHelper`, the Node helper's detection and fallbacks). With the `helper` option at `auto` the chosen adapter is wrapped by `withHelper` (`host-helper.ts`, see Node helper).

| Member | What it does |
|---|---|
| `platform` | `linux` or `windows`, as the trace names it |
| `homeDir` | the home directory in the adapter's path form |
| `nativePath` | a path in the form the mod stores (unchanged on Linux) |
| `sessionDir`, `isSameDir` | the session's directory and its comparison with the orchestrator directory |
| `transcriptPath` | where a worker's transcript lives |
| `defaultConfigDir`, `isDefaultConfigDir` | the config directory a launch without a picker inherits, and the test for it |
| `probe` | claude processes, liveness proof by pid and start time, transcript ages (sessions files under the given config dirs on Windows) |
| `findNewWorker`, `workerConfigDir` | the new worker among the probe's facts, and the config directory the probe shows for it |
| `pause` | the wait between discovery checks |
| `launchArgs`, `launchChecks`, `launchFacts` | the launch's paths in stored form, the prompt-file and dir checks, the platform's facts for the launch guard |
| `pickerArgv` | the licence picker's argv as run, or why it is refused |
| `launchTool`, `launchCommand`, `launchToolHint` | the tool a worker starts through (`Bash`, or `PowerShell` on the PowerShell launch route), its command text, the hint when the tool is missing |
| `launchPidFile`, `launchRefusal` | the pid file the command writes (PowerShell route only), and why the route cannot start a launch (PowerShell route only: a prompt file or runs directory with `[`, `]` or a backtick) |
| `createFile`, `prepareHelperDirs`, `prepareRunsDir`, `makeDir` | a missing file with its directory, and the directories a fresh environment and a launch need |
| `writeAtomic`, `renameOver`, `removeFile` | the registry write through a temp file and a rename, the rename, the removal |
| `append` | lines added to a log without reading it |
| `tail` | the last 600 lines of a transcript, each cut to 20000 characters |
| `rotate` | the trace's rotation |
| `rotateAndAppend` | the trace's write: the rotation when one is due, then the append (one process with the helper) |

`mod/tests/host.test.ts` runs one contract against both adapters and the Windows adapter on the PowerShell launch route, each alone and behind the Node helper, and checks the selection. With the `launchRoute` option at `powershell` on native Windows, `withPowerShellLaunch` (`host-powershell.ts`) lays the route over the Windows adapter before the helper wraps it.

## Node helper

`mod/helper/host.mjs` (with `protocol.mjs`, `ops.mjs`, `files.mjs` and `linux.mjs`) does the host operations the engine's `$.fs` lacks in one Node.js process per call: Node 22 or newer, standard library only, no build step. The mod finds it under its own folder (`$.plugin.root`). Its protocol:

1. The mod runs `node <plugin>/helper/host.mjs <op>` by argv, no shell, with one JSON request on stdin.
2. The helper prints one JSON object: `{"ok":true,...}` with the answer's fields, or `{"ok":false,"code":"<CODE>"}`, and exits 0 or 1.
3. Codes are fixed words (`BAD_OP`, `BAD_REQUEST`, `TOO_LARGE`, `UNSUPPORTED`, `NOT_FOUND`, `ACCESS`, `BUSY`, `EXISTS`, `IS_DIR`, `NOT_DIR`, `NO_SPACE`, `READ_ONLY`, `CROSS_DEVICE`, `IO`, `INTERNAL`): no Node error message, path or file content is ever part of an answer.
4. Operations: `probe` (Linux: `/proc` read natively, printed as `PROBE_SCRIPT` prints it, `CLAUDE_CONFIG_DIR` the only value taken from a process environment, `procStart` and `sessionId` the only fields taken from a sessions file), `writeAtomic`, `renameOver`, `removeFile`, `append` (one write on an append descriptor), `tail` (the last 600 lines from the end of the file, each cut to 20000 characters, the answer kept under the engine's 4 MiB output cap by leaving out the oldest lines), `rotate`.
5. `batch` runs a list of file operations in order in one process and stops at the first failure, answering its position.

`withHelper` in `mod/hooks/host-helper.ts` puts the helper in front of the chosen adapter. Node is looked for at the first operation that needs it (`node --version`, untraced): without Node, or with one older than 22, the adapter's own operations run, with a `helper` trace line and no error. While no usable Node was found, the first helper-needing operation 10 minutes or more after the last lookup looks again, so a Node installed meanwhile is taken without a reload; operations at the same moment share one lookup, and a Node once found stays for the load. The `helper` trace line is written once per change of state (not found, too old, found), not at every lookup. A call that fails (Node cannot start or times out, its output is cut, is not one JSON object, or answers `ok:false`) falls back to the adapter's own operation for that call: the trace gets a `helper.fallback` line with the operation and the code, and the first fallback of the load raises one toast (`helper fallback: <op>`). The one exception is an append (a log line, or the trace's own rotate-and-append batch) that timed out: the helper may have written it already, so it is not made again. Its `helper.fallback` line carries `isRepeated: false`, the toast reads `helper fallback: append (timed out, not repeated)`, and the lines may be missing from the log but are never in it twice. Every other failure of an append (Node not starting, an exit code with no answer, an answer that is not JSON, `ok:false`) means nothing was written, and the adapter appends. On Windows the process probe stays `PROBE_PS1` (Node's standard library cannot list processes) and a transcript under the read cap is still read in the engine; the helper replaces the PowerShell file script. The trace's own write goes as one batch (rotation, then append). The built-in adapters stay as the fallback.

Cost measured on the machines it targets (medians: of 100 runs on Linux; on Windows of 20 single operations, 5 batches and one tail, timed from WSL through interop):

| Machine | Operation | Helper | Built-in |
| --- | --- | --- | --- |
| Linux (WSL 2, Node 24.14.0) | process probe, 2 arguments | 31.1 ms (27.6 ms in an earlier run) | 32.9 ms `sh` `PROBE_SCRIPT` (23.7 ms in the earlier run) |
| Linux | registry write | 39.0 ms `writeAtomic` (with fsync) | 1.7 ms for the one `mv -f`, plus the engine's own write of the temp file (not timed) |
| Linux | append | 25.9 ms | 1.3 ms (`sh` `APPEND_SCRIPT`) |
| Linux | bare `node -e 0` | 14.8 ms | |
| Windows (Node 22.10.0) | one file operation | 90 ms | 233 ms (PowerShell file script) |
| Windows | a batch of 20 file operations | 122 ms per batch | |
| Windows | tail of a 3.1 MB file | 100 ms | |

On Linux the helper costs one Node start per call where the built-in operations cost a few milliseconds (the probe is about even); on Windows it is about 2.5 times faster per operation than PowerShell, and a batch costs one Node start for all of its operations.

## PowerShell launch route

On native Windows the engine offers its Bash tool only when it finds Git Bash. With the `launchRoute` option at `powershell`, `launch_worker` starts the worker through the engine's PowerShell tool instead (PowerShell 7 or Windows PowerShell 5.1, whichever the tool runs; the engine offers that tool by default only when it does not find Git Bash, otherwise with `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`). The default, `bash`, is the route described above, unchanged; on Linux and WSL the option changes nothing. `hooks/host-powershell.ts` builds the command; for a fresh launch with a picked config directory it reads:

```powershell
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$env:CLAUDE_CODE_EFFORT_LEVEL = 'high'
$env:CLAUDE_CONFIG_DIR = 'C:/Users/u/.claude/lic-b'
$exe = (Get-Command claude.exe -ErrorAction Stop).Source
$p = Start-Process -FilePath $exe -ArgumentList '-p --model opus -n w-fix-the-parser-261010143117 --settings "{\"crossSessionInbound\":\"accept\"}" --dangerously-skip-permissions --output-format json' -WorkingDirectory 'C:/work/my project' -RedirectStandardInput 'C:/Users/u/scratch/prompt.md' -RedirectStandardOutput 'C:/Users/u/.claude/session-control/runs/20261010143117-fix-the-parser.json' -RedirectStandardError 'C:/Users/u/.claude/session-control/runs/20261010143117-fix-the-parser.err' -NoNewWindow -PassThru
$null = $p.Handle
Set-Content -LiteralPath 'C:/Users/u/.claude/session-control/runs/20261010143117-fix-the-parser.pid' -Value $p.Id -Encoding Ascii
$p.WaitForExit()
exit $p.ExitCode
```

- **Flags**: those of the Bash route, in its order (`--resume <session id>` right after the model for a resume), with no prompt argument: the prompt reaches `claude.exe` on standard input from the prompt file, so it never meets the command-line length limit and no PowerShell encoding touches it. The result and error files are `claude.exe`'s own standard output and error (Start-Process's redirections: the bytes go through as written). `CLAUDE_CONFIG_DIR` is set only when the worker does not inherit the config directory, as on the Bash route.
- **Quoting**: Windows PowerShell 5.1 joins Start-Process's argument list with blanks and quotes nothing, so the arguments go as one string, each quoted by the C runtime's command-line rules that `claude.exe` parses with: a plain word stays as it is (so the probe still finds `--model opus`), anything with a blank or a double quote goes in double quotes with its quotes, and the backslashes before them, escaped. The `--settings` JSON thus arrives as one argument under 5.1 and 7 alike. Every value then sits in a PowerShell literal that keeps the whole command in printable ASCII: single-quoted with its quotes doubled, or, for a value with other characters (a user folder `José`), double-quoted with `$([char]0x....)` for each of them, so the command reads the same whatever encoding the tool hands it on in.
- **Wildcards**: Start-Process reads `-WorkingDirectory` and its redirection paths as wildcard patterns. The launch directory is escaped (each `[`, `]`, `*`, `?` and backtick behind a backtick), which both versions read back as the path. No spelling of a redirection path with `[`, `]` or a backtick reaches both versions (plain, the pattern finds no file; escaped, PowerShell 7 looks for the backticks themselves, and 5.1 does for standard input), so on this route a prompt file or runs directory holding one of them is refused before anything runs, with a message naming the path.
- **Refusal without the tool**: when the session has no PowerShell tool the launch is refused (`the worker could not be started through the PowerShell tool (...); nothing was launched.`) with the hint to start the orchestrator with `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` or to set the option back to `bash`; there is no silent fall back to the Bash tool.
- **Pid**: the launch guards and the pid discovery are the Windows adapter's, unchanged. The command writes `claude.exe`'s pid to `<runs>/<stamp>-<slug>.pid`; after discovery the mod reads it as one more fact: the `worker.found` trace line says whether it matches the probe's pid (`same`, `differs`, `unread`), and the answer names it when it differs. The registry takes the probe's pid either way.
- **Exit**: the command waits for `claude.exe` and exits with its exit code, so the tool's background exit notification carries it.

Verified on the Windows host (Windows PowerShell 5.1.22621, PowerShell 7.6.6), from WSL, with `mod/tests/windows-selftest.py`. It renders the command with the real `powershellLaunchCommand` and runs it as a script under both versions, with `node.exe` and a stub script standing in for `claude.exe`. Three layouts ran under each version: a fresh launch inheriting the config directory, with blanks and a quote in its paths; a picked config directory with brackets, a backtick and non-ASCII letters in the launch directory; and a resume. In each run:
- the argv arrived intact, the name and the settings JSON as single arguments;
- the prompt arrived byte for byte, including non-ASCII text, quotes and CRLF and LF line ends;
- the result file was UTF-8 with no BOM;
- the pid file held the child's pid;
- the exit code came back (0, 3 and 1);
- the working directory was right;
- `CLAUDE_CONFIG_DIR` was inherited or set as asked.

A prompt file under a bracketed folder failed at Start-Process under both versions, as the refusal says. The mocked tests cover the command text (with and without a picker, a resume, blanks and quotes in paths, a title with quotes), the option on Windows and on Linux, and the refusals.

Not verified: no Windows claude session was started through this route by this change (the live proof is the user's to sign off). An earlier scratch variant of this command (the same Start-Process shape, without `-n` and `--settings`) did run one live haiku worker through the PowerShell tool, a fresh launch with a plain ASCII layout. Still unproven live:
- a resume, whose prompt also arrives on standard input;
- non-ASCII or bracketed launch directories;
- the way the tool itself hands the command to PowerShell (the dry runs ran it as a `-File` script);
- whether stopping the background task, or its time limit, also ends the `claude.exe` that Start-Process started.

## Layout

```
CLAUDE.md                       orchestrator instructions
README.md                       this file
model-complexity-matrix.md      model and effort lookup table
.gitignore                      allowlist
mod/
  .claude-plugin/plugin.json    manifest and options
  hooks/hooks.json              names the hooks module
  hooks/register.tsx            hooks, tools, panel
  hooks/core.ts                 pure functions: registry, process facts, launch guard, report check
  hooks/host.ts                 host interface and selectHost, the one platform choice
  hooks/host-shared.ts          host operations both adapters do alike
  hooks/host-posix.ts           Linux and WSL adapter and its sh scripts
  hooks/host-windows.ts         native Windows adapter and its PowerShell scripts
  hooks/host-powershell.ts      the PowerShell launch route over the Windows adapter (launchRoute powershell)
  hooks/host-helper.ts          withHelper: the Node helper in front of an adapter, with fallback
  helper/host.mjs               the Node helper's entry point (protocol.mjs, ops.mjs, files.mjs, linux.mjs)
  hooks/bookkeeping.ts          edits of open points, queue and decisions
  hooks/store.ts                initial helper-file text, dates, paths
  tests/                        *.test.ts (powershell.test.ts among them), fixtures.ts, fake-helper.ts,
                                helper.test.mjs, probe-selftest.py,
                                windows-selftest.py, e2e-smoke.sh
  types/index.d.ts              state contract of the panel
```
