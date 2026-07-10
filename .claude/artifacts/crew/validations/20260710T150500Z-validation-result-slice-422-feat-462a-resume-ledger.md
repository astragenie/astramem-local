---
status: PASS
---

# Validation Result — SLICE-422 / FEAT-462a (eval resume ledger + kill-resilience + scope guard)

Worktree: `C:\work\mega\astramemory-local-worktrees\w462a`, branch `feat/feat-462a-resume-ledger`
(head `9cfd2f3`, not switched, no source edits made). Review PASS after 1 fix round.

`bun install` (no changes) + `bun run build` (`tsc -p .`): clean.

## Method note (read before the scenario evidence)

`run-smoke.mts`/`run.mts` hardcode the real daemon command (`dist/cli/index.js serve`) with no
CLI flag to substitute a fake daemon — `spawnEvalDaemon`'s `command` override is a library-level
"test-only escape hatch" (per its own doc comment), never wired to either harness's CLI surface.
So for Scenarios 1/2/5-fresh (which need a running daemon to ingest against), I wrote two small
validation-only driver scripts (`driver.mts`, `driver-locomo.mts`, living entirely in the session
scratchpad, never inside the repo tree — confirmed clean `git status` at the end) that call the
exact same exported functions `run-smoke.mts`/`run.mts` themselves call
(`evaluateResumeGuard`, `loadDataset`/`sampleStratified`/`sampleLocomo`, `spawnEvalDaemon`,
`ingestQuestions`/`ingestConversations`, `waitForQuestionsDistilled`/`waitForSamplesDistilled`,
`ledgerCompletedMap`, `killDaemon`), substituting the fake daemon fixture via the documented
`command` override. This is materially equivalent to exercising the harness end-to-end — every
line of FEAT-462a's actual logic lives in these shared/library modules, not in either CLI file's
thin orchestration glue (already independently confirmed by the review's own re-review, which
verified the CLI glue places the guard correctly and does nothing else non-trivial).

For Scenarios 3, 4, and 5's guard-refusal check, the guard fires **before** any dataset-content
parsing or daemon spawn, so these ran the **real, unmodified `run-smoke.mts`/`run.mts` as literal
`bun` subprocesses** — genuinely "the real CLI entrypoints," matching exactly the method the
reviewer used in their own re-review (a throwaway 1-byte/small dataset file, since the guard
never reaches dataset parsing on a refusal).

Safety rails followed throughout: fake daemon fixture only, never the real daemon, never real
Ollama/Azure (the driver scripts skip the answer/judge step entirely — out of FEAT-462a's scope
and not needed to validate resume/kill-resilience/scope-guard), literal `node` (via
`spawnEvalDaemon`'s own hardcoded `'node'`, unchanged), own PIDs only, sandbox run dirs under the
scratchpad. Production daemon (port 7777) confirmed running throughout and at the end.

## Scenario 1 — Fresh run baseline

Synthetic 2-question/6-session LongMemEval-shaped dataset. Ran the driver (fresh, no `--resume`):
```
Run dir: <sandbox>/run1
Sample: 2 question(s), 6 sessions.
fake daemon up at http://127.0.0.1:...
ingest done: 6 ok, 0 failed.
distill-wait done: 2 ready, 0 timed out.
DRIVER DONE
```
Exit 0. Run dir contains `run-params.json`, `sample.json`, `ingest-ledger.jsonl` (6 lines, one per
session, all `ok:true`), `ingest-manifest.json`, `distill-wait-result.json`, `run-manifest.json` —
the standard file set (AC-7's four named files plus the new, additive `ingest-ledger.jsonl` and
`run-params.json`).

## Scenario 2 — Kill + resume (orchestrator killed, not just the daemon)

Relaunched the same config in the background with a 600ms per-job ingest delay, polled the ledger
file until it showed **exactly 1** completed session, then `kill -9`'d the **orchestrator**
process itself (not the daemon) — confirmed dead via `kill -0`. Checking the daemon's own
recorded PID afterward showed **it died too** (`Get-Process` found nothing) — this is a faithful,
unplanned-but-realistic reproduction of the actual 2026-07-10 incident class (CLAUDE.md: "killed a
40-min LongMemEval run + prod daemon" — killing the orchestrator process took the daemon with it),
which is a *more* severe failure mode than either existing unit/integration test exercises (both
only SIGKILL the daemon directly, with the orchestrator's own process surviving throughout).

State after the kill: ledger had exactly 1 line (`lme-q1-q1-hs-0`, `ok:true`); the fake daemon's
own `state.json` independently confirmed exactly 1 session persisted
(`ingestCallCount:1`) — ledger and daemon-side durable state agreed.

Relaunched with `--resume`, **identical** `--dataset/--n/--seed/--run-dir` flags, pointed at the
**same** `--state-file` (a fresh daemon process, respawned against the persisted state — mirrors
"shard datadirs already hold all distill progress"):
```
Resuming run dir: <sandbox>/run2
Sample: 2 question(s), 6 sessions.
fake daemon up at http://127.0.0.1:... (fresh pid)
  1/6 ... 6/6 sessions ingested
ingest done: 6 ok, 0 failed.
distill-wait done: 2 ready, 0 timed out.
DRIVER DONE
```
Exit 0. Final ledger: **exactly 6 lines, one per unique `session_id`, all `ok:true`** (the
original pre-kill entry preserved with its original timestamp; the remaining 5 appended fresh).
Final daemon `state.json`: `sessions` map has exactly 6 keys, **and critically `ingestCallCount`
is exactly 6, not 7** — this is the decisive exactly-once proof: if the resumed run had re-POSTed
the 1 already-ledger-recorded session instead of skipping it via `resumeCompleted`, the call
count would be 7 against only 6 ever-attempted sessions. It wasn't — the ledger genuinely drove
the skip, not merely "happened to avoid a duplicate."

## Scenario 3 — Scope guard live

Took the completed `run1` (original `--n 2`), captured MD5 checksums + mtimes of every file in
the run dir, then ran the **real, unmodified** `run-smoke.mts` as a literal `bun` subprocess:
```
$ bun scripts/eval/longmemeval/run-smoke.mts --dataset <path> --n 1 --seed 42 --resume <run1>
Resuming run dir: <run1> (ledger-driven skip of already-ingested sessions)
--resume <run1>: refusing to resume -- these params differ from the original invocation
(resuming anyway could silently narrow or change the run's scope):
  n: original=2, current=1
Start a fresh run dir if you intend different params.
$ echo $?
1
```
Re-checksummed every file in the run dir afterward: **byte-identical MD5s and mtimes to before**
(`diff` of the two checksum listings: exit 0) — the refused attempt made zero modifications.

## Scenario 4 — Pre-462a run dir

Built a run dir containing `sample.json`/`ingest-ledger.jsonl`/`ingest-manifest.json` but
deliberately **no** `run-params.json` (simulating a run dir from before this FEAT existed). Ran
the real `run-smoke.mts` subprocess with `--resume` pointed at it:
```
--resume <dir>: no run-params.json found in this run dir -- it predates FEAT-462's resume
support, so there is no record of the original sampling flags to verify against. Refusing to
resume; start a fresh run dir.
```
Exit 1 — exact match to the documented "predates" message.

## Scenario 5 — LoCoMo parity (shared guard proven live on both harnesses)

Built a small LoCoMo-shaped dataset (2 conversations, 4 sessions total) using the exact schema
from the repo's own `scripts/eval/locomo/lib/dataset.test.ts` fixture (`fakeSample` helper,
copied verbatim in shape) at a local path, so `ensureDatasetDownloaded` sees the file already
exists and never attempts a network fetch (confirmed by its own logged output, "Using existing
dataset at ...", not "Downloaded").

**Fresh run** (via the LoCoMo driver, real `ingestConversations`/`waitForSamplesDistilled`/fake
daemon): `ingest done: 4 ok, 0 failed. distill-wait done: 2 ready, 0 timed out.` Exit 0.
`ingest-ledger.jsonl` has exactly 4 lines (2 sessions x 2 conversations), all `ok:true`.

**Guard refusal**, via the **real, unmodified `run.mts`** as a literal subprocess:
```
$ bun scripts/eval/locomo/run.mts --dataset <path> --n 1 --seed 42 --resume <locomo-run1>
Resuming run dir: <locomo-run1> (ledger-driven skip of already-ingested sessions)
Using existing dataset at <path>
--resume <locomo-run1>: refusing to resume -- these params differ from the original invocation
(resuming anyway could silently narrow or change the run's scope):
  n: original=2, current=1
Start a fresh run dir if you intend different params.
$ echo $?
1
```
Run dir MD5-checksum diff before/after: exit 0 (unmodified). This is a live, not merely
code-reading, confirmation that `evaluateResumeGuard` is genuinely the same shared decision point
producing identical refusal behavior on both harnesses (AC-6), not a per-harness reimplementation
that happens to look similar.

## Cleanup

No daemon or orchestrator processes left running (`Get-CimInstance` search for
`fake-eval-daemon` processes: none found). `git status` in the worktree shows only pre-existing,
unrelated loop-bookkeeping churn (`.claude/artifacts/loop/*`, `.claude/state/*`) — zero files
under `scripts/` or `src/` touched, confirming no source edits. The two validation driver scripts
and all synthetic datasets/run dirs live entirely under the session scratchpad, outside the repo
tree. Production daemon (port 7777) confirmed running and undisturbed throughout.

## Overall

**PASS.** All 5 scenarios behave correctly through genuine execution of the real, shared library
functions (not reimplemented logic) and, where directly feasible (the scope-guard scenarios), the
real unmodified CLI subprocess itself. Scenario 2 in particular exercised a more severe failure
mode than either existing test covers — killing the orchestrator process (which took the fake
daemon down with it too, mirroring the actual 2026-07-10 incident more closely than a
daemon-only kill) — and the resume still recovered to an exact, provably-non-duplicated
state (ledger session count matches the daemon's own independent call counter exactly). This
run is ready to merge; v0.13.0 cut is unblocked from this validation's perspective.
