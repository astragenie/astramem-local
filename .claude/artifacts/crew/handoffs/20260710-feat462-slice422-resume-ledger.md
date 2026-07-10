---
slice: SLICE-422
feature: FEAT-462
scope: "slice A+C: resume core + kill-resilience test (AC-1, AC-4, AC-5, AC-6, AC-7)"
owner: builder
branch: feat/feat-462a-resume-ledger
worktree: C:\work\mega\astramemory-local-worktrees\w462a
status: implementation complete, awaiting review + validation
---

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
  `ok_count` unchanged, every session POSTed exactly once). Full repo test
  suite run clean: `bun run test` — 202 files, 2372 passed, 6 skipped, 0
  failed. `bunx tsc --noEmit` (root) and `bun run build` both clean.

## Changed files

- `scripts/eval/shared/resume-ledger.ts` (new)
- `scripts/eval/shared/resume-ledger.test.ts` (new)
- `scripts/eval/shared/spawn-daemon.ts` (edit: `command?` override on
  `SpawnDaemonOpts`, `pid` on `DaemonHandle`)
- `scripts/eval/shared/__fixtures__/fake-eval-daemon.mjs` (new)
- `scripts/eval/longmemeval/ingest.mts` (edit: ledger-aware `ingestQuestions`)
- `scripts/eval/longmemeval/ingest.resume.test.ts` (new)
- `scripts/eval/longmemeval/resume-integration.test.ts` (new)
- `scripts/eval/longmemeval/run-smoke.mts` (edit: `--resume` flag)
- `scripts/eval/longmemeval/README.md` (edit: "Resume behavior" section
  rewritten — it previously and incorrectly stated no cross-run resume
  existed)
- `scripts/eval/locomo/ingest.mts` (edit: ledger-aware `ingestConversations`)
- `scripts/eval/locomo/ingest.resume.test.ts` (new)
- `scripts/eval/locomo/run.mts` (edit: `--resume` flag)
- `scripts/eval/locomo/README.md` (edit: new "Resume behavior" section +
  flags table row)

## Confidence

High on AC-1/AC-4/AC-6/AC-7 (directly tested, including a real
kill-and-respawn integration test). Medium-high on AC-5's "deterministic in
CI" claim specifically — the fake daemon and delays were chosen with
generous margins and passed repeatedly locally, but this hasn't yet run
inside the actual CI environment (different scheduling/load
characteristics from a dev box are the standard source of timing flakiness
if any remains).

## Risks / open questions

- The mid-ingest kill test's timing margins (`--ingest-delay-ms 80`, kill at
  200ms) are generous but not physically impossible to violate under severe
  CI contention. If this ever flakes, widen the margins rather than
  removing the real-process kill (that's the whole point of AC-5).
- `--resume` requires the caller to pass the SAME sampling/sharding flags
  as the original invocation (by design — sampling is a deterministic pure
  function, so nothing needs to be persisted separately). This is
  documented in both READMEs and the CLI header comments, but there's no
  runtime guard that catches a mismatched re-invocation (e.g. a typo'd
  `--seed`) — it would silently produce a different sample and the ledger
  keys just wouldn't match anything, degrading gracefully to "resume found
  nothing to skip" rather than corrupting state, but isn't flagged loudly.
  Not fixed this slice (no AC calls for it); worth a backlog note if it
  bites someone in practice.

## Suggested next handoff

Slice B: `--detach` (AC-2) + PID/port manifest (AC-3), building on the
`command?` override (test-only, unused by real harnesses) and the new `pid`
field on `DaemonHandle` already added as groundwork here.
