# Task-complexity-to-model matrix

Reference for the session orchestrator's model/effort dispatch decision when launching a worker.
`session_control/CLAUDE.md` owns the procedure; this file is the lookup table.

## The matrix

Model and effort are **two independent axes**, not one derived from the other. Model answers "how
much raw capability/context/cost-tier does this task's *scope* need" — effort answers "how much
deliberation does correctness on *this specific task* benefit from," regardless of which model
runs it. A big-context endurance run can still be mechanical per turn (`fable` + `medium`); a
single narrow question can still be worth maximum deliberation on a cheap model (`sonnet` +
`max`). Pick a row and a column independently — don't default to reading one off the other.

**Model axis — what determines the row:**
- `claude-haiku-5-5` — the answer comes from a command, not judgement; a wrong answer is caught
  immediately by the same tool that produced it. Build/test re-runs, `find`/`grep` inventories,
  container/port liveness checks, byte-identical propagation across repos, `CURRENT STATUS`
  file listings.
- `sonnet` — target shape given in advance (schema, sibling file, stated criterion); correctness
  checkable without understanding the wider system. A dashboard panel from a named metric, an
  OTTL/CEL block following existing statements, a test mirroring an existing test, a single-file
  change with a stated acceptance criterion.
- `opus` — must stay consistent across places the worker has to find for itself (call sites, a
  patch series, a worktree reconciled with its source). Rewriting call sites to a new signature,
  porting an already-merged fix into a worktree after its source moved, a refactor that must find
  every consumer. Also: why a count doesn't reconcile, why a field captures nothing, why a
  resume/hang has no visible cause, whether a symptom reproduced elsewhere is actually confirming
  evidence — diagnosis work is Opus's row regardless of file count, just pushed to `xhigh`/`max`.
  **Updated 2026-09-24: `claude --model opus` now resolves to Opus 5.5** (`claude-opus-5-5`,
  confirmed live on this host via `canonicalModel`) — 1M context, $4/$20, cache reads $0.20 (20%/
  60% below Opus 5), 30%+ faster output, and reported to match Fable 5.1 on most tasks. This
  narrows the real gap to Fable's row down to genuinely endurance/context-survival-shaped work,
  not general capability — don't reach for Fable on capability grounds alone anymore.
- `fable` — the run spans hours, must survive its own context filling up, or is the final word on
  something costly; chosen for endurance/context/frontier ceiling, not necessarily per-turn depth.
  A whole-lab convergence pass, a skill-under-test run (no policy layered on top), a
  security-relevant number needing adversarial verification, a run expected to hit the usage limit
  and resume.

**Effort axis — what determines the column, independent of model:**
- unset/`low` — default reasoning is enough; extra deliberation buys nothing on a mechanical or
  directly-matched-shape task.
- `medium` — some judgement, not high-stakes; a task holding a plan across many turns but where
  each individual step is fairly mechanical once oriented.
- `high` — real hypothesis-forming needed, not yet at the "gets acted on as fact" stakes.
- `xhigh` — the documented sweet spot for sustained agentic coding: holding a plan across many
  tool calls where an incomplete job looks identical to a complete one until something breaks.
- `max` — correctness matters more than cost: a consequential claim about to be relayed as fact, a
  root-cause hunt already burned by one wrong hypothesis, the final word on something costly.

| Model ↓ / Effort → | unset / low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| `claude-haiku-5-5` | **default.** Build/test re-run, inventory sweep, port liveness check. | — | — | — | rare — if this seems needed, the task probably belongs on Opus's row instead |
| `sonnet` | **default.** Schema-bound single-file authoring, a test mirroring an existing test. | A bounded task with real but modest judgement — choosing between two already-scoped implementation options. | Sonnet-fallback-on-overload work that would normally be `opus` `xhigh`, downgraded on Opus overload. | Sustained plan-holding on a schema-bound task that runs many turns (rare — usually signals it's actually T2). | A narrow, well-scoped, high-stakes check where the *scope* doesn't need Opus — e.g. independently re-verifying one specific claimed fact or number, not a broad investigation. |
| `opus` | — | An endurance-shaped task cut down to fit T2 (needs Opus's breadth, not extra deliberation per step). | Real judgement needed, not yet consequential enough for `xhigh`. | **default.** Multi-file/cross-repo consistency work, a worktree resync. | Consequential-claim verification; a T3 root-cause hunt already burned by a wrong hypothesis. |
| `fable` | — | A long-horizon/endurance run (hours, huge context, survives compaction) whose per-turn reasoning is actually repetitive once oriented — Fable chosen for stamina/context, not depth. | — | A frontier-grade task that isn't yet the final word on something costly. | **default.** Whole-lab convergence pass, a skill-under-test run, adversarial verification at the highest stakes. |

Model-axis activation is by the task's **weakest** property: a one-file edit whose correctness
can't be checked mechanically needs Opus's row, not Haiku's, regardless of file count.

**Effort goes through `CLAUDE_CODE_EFFORT_LEVEL`, never `--effort`** — confirmed 2026-09-24: the
CLI flag is documented but doesn't reliably take hold; the env var is the same real mechanism
(Claude Code's own changelog fixed `/effort`'s picker to reflect it) and takes the same names
(`low`/`medium`/`high`/`xhigh`/`max`).

```bash
CLAUDE_CODE_EFFORT_LEVEL=<level> claude -p --model <model> ...   # omit the env var entirely for unset/low
```

**Standing overrides, outrank any cell above:**
- Usage headroom decides the launch, not the matrix. A launch refused for licence room is a real
  answer, not a blocker to route around.
- Opus returning overload errors drops Opus-row work to `sonnet` at the same effort level where
  reasonable (`sonnet-fallback-on-overload` memory) — check `overloaded_error` count in recent
  transcripts before switching blind.
