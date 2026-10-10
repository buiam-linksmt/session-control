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
- Node.js is not required. The mod runs inside Claude Code's plugin sandbox, which has no Node.js API; Node.js is needed only if Claude Code itself is installed through npm.
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

`/session-control` shows or hides the side panel. The panel has three sections: Sessions, Queued work and Open points. The `[+]` icon in a section's header expands that section to the panel and keeps the other two as one-line headers with their own `[+]`, which expands that section directly (one section is expanded at a time); `[-]` returns to the three boxes, and opening a session's log returns to the log layout (sessions one third, log two thirds). Tracking of runs, the completion handling and the report check run whether the panel is shown or not.

Worker completion: when a registered worker's process is gone, the mod classifies its result file (`clean`, `limit`, `login`, `killed`, `error` or `chatter`), shows a toast led by the notification type (`Session finished`, `Usage limit reached`, `Login needed`, `Session killed`, `Session failed`, `Session ended without a report`; the mod's other toasts lead with `Tracking problem`, `Write not atomic` or `Debug trace failed`), then ` · ` and the message (a toast is one line of text: the engine draws no line break in it) and, with `completionWrites` on, merges the outcome into the worker's registry entry (it drops `pid` and sets `reported` to `false`). The outcome reaches the model with the next task notification. After a context compaction the next prompt carries a digest of the running workers and the open points.

### Tools

The tools are registered when the mod becomes active and are named `mcp__session-control__<tool>` to the model.

| Tool | What it does |
| --- | --- |
| `launch_worker` | Starts or resumes a headless `claude -p` worker as a background task, picks the licence for a fresh launch with the configured licence picker command (or uses the default config directory), finds its pid and session id and registers it in the worker registry. |
| `acknowledge_workers` | Marks finished workers as acknowledged (`reported` true); `keep: true` also marks them as needed for a resume. |
| `retire_workers` | Removes finished, acknowledged, clean workers from the registry and appends the removed entries to `cleared.jsonl`. |
| `open_point` | Adds, answers, closes, holds or releases an entry of `open-points.json`. Settled entries older than 7 days move to `open-points-archive.md`. |
| `queue_task` | Adds, updates or removes a task of `task-queue.json`. |
| `record_decision` | Appends one numbered line to a section of `agreed-decisions.md`; the section is created when missing. |

`launch_worker` refuses, among other cases: a launch directory that is the orchestrator directory or `$HOME`; a missing or empty prompt file; a prompt that lacks a foreground wait, the `git status -sb` report line or the no-attribution instruction (a prompt that says "skill test" is exempt); a resume of a live session; a licence pick that exits 3 or prints nothing usable. A worker is started as `claude -p -n <name> --settings '{"crossSessionInbound":"accept"}' --dangerously-skip-permissions --output-format json` with `CLAUDE_CONFIG_DIR` set to the picked configuration directory and `CLAUDE_CODE_EFFORT_LEVEL` set to the requested effort.

Inbox: every worker gets a session name with `-n` and accepts messages from other sessions on the machine (`crossSessionInbound` set to `accept` through `--settings`), so the orchestrator can send a running worker a message by its name. The name is `w-`, the slug of the title cut to 24 characters, and the launch time in UTC as `yyMMddHHmmss` (for example `w-fix-the-parser-261010143117`): letters, digits and dashes, at most 39 characters; a name already in the registry or given out by the same session gets `-2`, `-3` and so on. A resume passes the same two flags and keeps the entry's name, so a session answers to one name across resumes; an entry without a name (launched before names existed) gets a fresh one. The worker's exit is still detected through the background task's notification.

`acknowledge_workers` and `retire_workers` refuse a worker whose process is alive. `retire_workers` also refuses a worker that is marked keep, whose outcome is not `clean` or that a queued or running task names.

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
python3 -I mod/tests/probe-selftest.py
```

`claude plugin test` runs the `*.test.ts` files in `mod/tests/`. `probe-selftest.py` extracts the process probe from `mod/hooks/core.ts`, checks that it parses under `sh -n` and runs it against a fixture configuration directory.

To see what the mod does, set `SESSION_CONTROL_DEBUG=1` in the environment (or the `debug` option). A session where the board is on (the orchestrator directory, or after `/session-control`) then appends one JSON line per event to `trace.log` in the runs directory: commands run (argv with the mod's scripts by name, exit code, duration, stderr size), file writes (path and size), guard verdicts and caught errors (a kind and a message whose quoted text and echoed output become `…`). It never logs credentials, file contents, command output, prompt or transcript text, the environment, a worker's title or the licence picker's command (only whether one is set, and at a launch its executable's name and argument count); text that looks like a token becomes `[redacted]`. Any other session, a worker included, writes nothing. The trace is rotated at about 2 MiB (sessions share it), three files kept.

`sh mod/tests/e2e-smoke.sh` smoke-tests the real `claude` from a scratch directory it removes afterwards: a haiku orchestrator (capped at `--max-budget-usd 0.25`) launches one haiku worker and, where tmux exists, an interactive session opens the panel; it prints one line per check. It runs under the default configuration (`~/.claude`, `~/.claude.json`): the transcripts, the session files and the trust entry for its scratch folder stay there, and it spends a few cents of the default licence's quota.

After a change to the mod, run the validation and the tests before relying on it.

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
  hooks/bookkeeping.ts          edits of open points, queue and decisions
  hooks/store.ts                initial helper-file text, dates, paths
  tests/                        *.test.ts, fixtures.ts, probe-selftest.py
  types/index.d.ts              state contract of the panel
```
