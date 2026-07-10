---
slice: SLICE-422
feature: FEAT-462
scope: "slice A+C: resume core + kill-resilience test (AC-1, AC-4, AC-5, AC-6, AC-7)"
owner: builder
branch: feat/feat-462a-resume-ledger
worktree: C:\work\mega\astramemory-local-worktrees\w462a
status: fix round complete (review 20260710T143157Z findings 1 and 2 addressed) — awaiting re-review + validation
---

## Fix round (2026-07-10, addressing review 20260710T143157Z)

Review verdict was `needs_fix` on one blocking finding; everything else in
the review (exactly-once accounting, torn-tail tolerance, kill-test
determinism, spawn-daemon/pid groundwork) was independently verified solid
and required no changes.

**Finding 1 (MEDIUM-HIGH, blocking) — fixed.** The reviewer proved
`sampleStratified(n=30, seed)` is a strict subset of `sampleStratified(n=50,
seed)` under the same seed (seeded shuffle-then-slice), so a `--resume`
launched with a smaller `--n` than the original run would silently replay
every session from the ledger, complete with zero failures, and produce a
`run-manifest.json` that *looks* fully successful with a scope that quietly
narrowed — the opposite and more dangerous direction from "wasteful but
correct" that the original handoff's risk section anticipated. Adopted the
reviewer's own recommended fix, REFUSE (not warn): new module
`scripts/eval/shared/run-params.ts` persists the scope-determining flags
(`--dataset` path + a sha256 content hash, `--seed`, `--n`, `--shards`, plus
LoCoMo's `--qa-per-sample`) to `run-params.json` on the first (non-`--resume`)
invocation; `evaluateResumeGuard` — the single decision point both
`run-smoke.mts` and `run.mts` call — loads and compares it on `--resume`,
hard-refusing (non-zero exit, message naming every differing param + its
original value) on ANY mismatch, and also refusing when `run-params.json`
is missing entirely (a pre-462a run dir, honestly reported as unresumable
rather than silently allowed). No override flag, by design — an operator
who wants different params starts a fresh run dir.

**Finding 2 (MEDIUM) — fixed.** `appendLedgerEntry`'s call site in both
`ingest.mts` files now has its own try/catch (log-and-continue): a ledger
disk/permission failure can no longer fail an otherwise-successful ingest
job, matching the repo's existing "never let auxiliary bookkeeping crash
the real work" posture. Also noted the new `ingest-ledger.jsonl` +
`run-params.json` files in both READMEs' run-dir layout sections per the
reviewer's explicit call-out (accepted as additive, per the reviewer's own
judgment call).

New files: `scripts/eval/shared/run-params.ts`,
`scripts/eval/shared/run-params.test.ts` (15 tests covering
`hashDatasetFile`/`writeRunParams`/`checkRunParams`/`evaluateResumeGuard`,
including the review's requested scenarios: mismatched `--n`/`--seed`/
`--shards`/dataset-hash, matching-params proceed-and-don't-rewrite, and a
missing-file pre-462a run dir). Both `ingest.resume.test.ts` files gained a
ledger-write-failure test (mkdirSync-blocking file trick) proving the job
still succeeds with a warning logged.

Gates re-run clean after the fix round: ad hoc strict tsc over touched
files, root `tsc --noEmit`, `bun run build`, `bunx vitest run scripts/eval/`
(13 files / 110 tests), full `bun run test` (203 files / 2390 passed / 6
skipped / 0 failed — 18 tests more than the pre-fix 2372, all new, no
regressions).

## Objective

Close the resume gap in the LongMemEval/LoCoMo eval harnesses: `ingest-manifest.json`
was only written once, at end-of-phase, after ingest fully returns — so a
mid-phase kill (the 2026-07-10 taskkill incident, three failed multi-hour
runs in two days) left no durable record of which sessions had already
succeeded, forcing every restart from zero. Out of scope this slice:
`--detach` (AC-2) and the PID/port manifest (AC-3) — those are slice B.

## What was built

**New shared module** `scripts/eval/shared/resume-ledger.ts` — a crash-safe
append-only JSONL ledger (`LedgerEntry { session_id, owner_id, ok,
idempotent, error?, ts }`), with `appendLedgerEntry` (sync, one write per
completed job), `readLedger` (tolerant of a torn trailing line from a
mid-write kill), and `ledgerCompletedMap` (last-write-wins per session_id).

**Both harnesses' ingest modules** (`scripts/eval/longmemeval/ingest.mts`'s
`ingestQuestions`, `scripts/eval/locomo/ingest.mts`'s `ingestConversations`)
now accept optional `ledgerPath` (append durably as each job settles) and
`resumeCompleted: Map<string, LedgerEntry>` (skip re-POSTing any session
whose latest ledger entry is `ok: true`; a session whose latest entry is
`ok: false` is retried). Both options default to `undefined` — omitted
entirely, behavior is byte-identical to before (AC-7).

**Both orchestrators** (`run-smoke.mts`, `run.mts`) gained `--resume
<run-dir>`: re-attaches to an existing run dir (errors if it doesn't
exist), always writes a per-shard `ingest-ledger.jsonl` (cheap, additive —
so any run dir is resumable later even if `--resume` wasn't anticipated at
launch), and only *reads* the ledger (to skip already-done sessions) when
`--resume` is passed. Sample/shard partitioning are deterministic given the
same `--dataset/--seed/--n/--shards` flags, so nothing needs to be
persisted separately to reproduce them. `distill-wait.mts` needed **no
changes** — distill state is read live from the respawned daemon
(`GET /sessions/:id/digest`), so in-flight distill work resumes
automatically once ingest-driven session identity lines back up (the FEAT's
own stated premise, verified true by the integration test below).

**Test fixture** `scripts/eval/shared/__fixtures__/fake-eval-daemon.mjs` — a
plain-Node stub daemon (no live LLM/Ollama, no `dist/` build) implementing
`GET /health` (public, no bearer — matches the real daemon), `POST
/ingest/transcript`, and `GET /sessions/:id/digest`, with state persisted to
a `--state-file` JSON so a second process pointed at the same file resumes
exactly where a killed instance left off (standing in for the real
daemon's durable SQLite datadir). Supports `--ingest-delay-ms` (lets a test
deterministically land a SIGKILL mid-request) and `--distill-delay-ms`
(simulates distill taking time). Reached via a new **optional**
`command?: string[]` override on `spawnEvalDaemon`'s `SpawnDaemonOpts`
(`scripts/eval/shared/spawn-daemon.ts`) — default path (real daemon)
unchanged; tests reuse the exact same spawn/health-wait/kill machinery the
real harnesses use.

**Groundwork (flagged per dispatch instructions):** `DaemonHandle` now also
exposes `pid: number | undefined` (from `proc.pid`) — not written anywhere
yet, just unblocked for slice B's PID/port manifest (AC-3). Zero behavior
change.

## Evidence by AC

- **AC-1 (resume core):** `scripts/eval/longmemeval/ingest.resume.test.ts`
  and `scripts/eval/locomo/ingest.resume.test.ts` (unit, mocked fetch) prove
  `resumeCompleted` sessions are replayed without a network call and the
  merged manifest has every session exactly once.
  `scripts/eval/longmemeval/resume-integration.test.ts` proves it end-to-end
  against a real spawned+killed+respawned process.
- **AC-4 (kill-resilience / exactly-once):**
  `resume-integration.test.ts`'s first test SIGKILLs a real daemon process
  mid-ingest (`--ingest-delay-ms 80`, kill scheduled at 200ms so ~2 of 6
  sessions complete before the kill), then resumes against a second daemon
  instance sharing the same persisted state file. Asserts (a) the merged
  manifest counts every one of 6 sessions exactly once with zero
  duplicates, and (b) the daemon-side `ingestCallCount` counter (persisted
  across both process lifetimes) equals exactly 6 — the strongest possible
  signal that no already-ok session was ever re-POSTed.
- **AC-5 (deterministic CI kill-sim test):** both
  `resume-integration.test.ts` tests spawn a real child process via the
  fake daemon fixture, `SIGKILL` it (once mid-ingest, once mid-distill-wait
  window), and re-invoke the resume path — no live LLM, no live Ollama,
  runs in <1s, fully deterministic (no timing races beyond generous
  relative margins already exercised in CI here: `bunx vitest run
  scripts/eval/longmemeval/resume-integration.test.ts` — 2 passed, 867ms).
- **AC-6 (shared-layer placement, both harnesses):**
  `scripts/eval/shared/resume-ledger.ts` is the new shared module; both
  `ingest.mts` files consume the identical `ledgerPath`/`resumeCompleted`
  contract, and both `run-smoke.mts`/`run.mts` wire `--resume` through
  `runShard` identically (`locomo/ingest.resume.test.ts`'s second test
  explicitly mirrors the LongMemEval one to prove parity).
- **AC-7 (no-regression):** every new option defaults to `undefined`/`false`
  with zero side effects when omitted — proven directly by each test
  suite's "AC-7" test case (no ledger file created, `total_sessions`/
  `ok_count` unchanged, every session POSTed exactly once). The four named
  files' schemas (`ingest-manifest.json`, `distill-wait-result.json`,
  `run-manifest.json`, `hypotheses.jsonl`) and exit-code semantics are
  unchanged; two new additive files (`ingest-ledger.jsonl` per shard,
  `run-params.json` at the run-dir root) now appear on every invocation —
  reviewed and accepted as in-scope-additive, now documented in both
  READMEs' run-dir layout sections per the reviewer's explicit call-out.

## Changed files

- `scripts/eval/shared/resume-ledger.ts` (new)
- `scripts/eval/shared/resume-ledger.test.ts` (new)
- `scripts/eval/shared/run-params.ts` (new — fix round: scope guard,
  `hashDatasetFile`/`writeRunParams`/`checkRunParams`/`evaluateResumeGuard`)
- `scripts/eval/shared/run-params.test.ts` (new — fix round, 15 tests)
- `scripts/eval/shared/spawn-daemon.ts` (edit: `command?` override on
  `SpawnDaemonOpts`, `pid` on `DaemonHandle`)
- `scripts/eval/shared/__fixtures__/fake-eval-daemon.mjs` (new)
- `scripts/eval/longmemeval/ingest.mts` (edit: ledger-aware `ingestQuestions`;
  fix round: `appendLedgerEntry` call site wrapped in its own try/catch)
- `scripts/eval/longmemeval/ingest.resume.test.ts` (new; fix round: added
  ledger-write-failure test)
- `scripts/eval/longmemeval/resume-integration.test.ts` (new)
- `scripts/eval/longmemeval/run-smoke.mts` (edit: `--resume` flag; fix
  round: wired through `evaluateResumeGuard`)
- `scripts/eval/longmemeval/README.md` (edit: "Resume behavior" section
  rewritten — it previously and incorrectly stated no cross-run resume
  existed; fix round: scope-guard paragraph + run-dir layout note added)
- `scripts/eval/locomo/ingest.mts` (edit: ledger-aware `ingestConversations`;
  fix round: try/catch wrap)
- `scripts/eval/locomo/ingest.resume.test.ts` (new; fix round: added
  ledger-write-failure test)
- `scripts/eval/locomo/run.mts` (edit: `--resume` flag; fix round: wired
  through `evaluateResumeGuard`)
- `scripts/eval/locomo/README.md` (edit: new "Resume behavior" section +
  flags table row; fix round: scope-guard paragraph + run-dir layout note)

## Confidence

High on AC-1/AC-4/AC-6/AC-7 (directly tested, including a real
kill-and-respawn integration test) and on the fix-round scope guard (15
unit tests cover every scenario the review asked for — mismatched `--n`/
`--seed`/`--shards`/dataset-hash, matching-params proceed, missing-file
refusal — at the exact decision-point function both CLIs call, so there's
no gap between "what's tested" and "what the CLI actually calls"). Medium-
high on AC-5's "deterministic in CI" claim specifically — the fake daemon
and delays were chosen with generous margins and passed repeatedly
locally (the reviewer independently re-ran it 5x and confirmed the
assertions are range-based, not exact-count, making it more CI-robust than
a naive reading suggests), but this hasn't yet run inside the actual CI
environment.

## Risks / open questions

- The mid-ingest kill test's timing margins (`--ingest-delay-ms 80`, kill at
  200ms) are generous but not physically impossible to violate under severe
  CI contention. If this ever flakes, widen the margins rather than
  removing the real-process kill (that's the whole point of AC-5).
- (Resolved this fix round) `--resume` with mismatched sampling flags used
  to degrade silently; it now hard-refuses via `evaluateResumeGuard`. No
  override flag exists — an operator who wants different params must start
  a fresh run dir. This is intentional (per team lead's explicit direction)
  but is a real ergonomics cost if someone frequently needs to resume with
  intentionally-varied params; not expected to come up in practice since
  `--resume`'s whole point is reproducing the SAME run.

## Suggested next handoff

Slice B: `--detach` (AC-2) + PID/port manifest (AC-3), building on the
`command?` override (test-only, unused by real harnesses) and the new `pid`
field on `DaemonHandle` already added as groundwork here.
