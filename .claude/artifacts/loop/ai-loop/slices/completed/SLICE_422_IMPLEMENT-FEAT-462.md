---
id: SLICE-422
title: Implement FEAT-462
status: completed
feature: FEAT-462
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-10
updated: 2026-07-10
completed_at: 2026-07-10
badges: [serial-reviewer-warning]
---
# SLICE-422: Implement FEAT-462

Implements FEAT-462. See [feature file](../../../backlog/in-progress/FEAT-462.md) for product context.

## Objective



## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] **AC-1:** Given an existing run dir from a prior `run-smoke.mts` or `run.mts` invocation whose per-shard `ingest-manifest.json` is only written once, at end-of-phase, after `ingestQuestions`/`ingestConversations` returns (`scripts/eval/longmemeval/run-smoke.mts:135`, `scripts/eval/locomo/run.mts:115`) — so a mid-ingest crash today leaves no record distinguishing "never attempted" from "in flight" — When the harness is re-launched with `--resume <run-dir>`, Then it respawns each shard daemon pointed at its existing `datadir` (already durable SQLite; daemon distill state is read live via `GET /sessions/:id/digest`, `scripts/eval/shared/daemon-client.ts:75`, so in-flight distill work resumes automatically on respawn with no extra logic), reads a crash-safe append-only ledger to skip re-POSTing every session already recorded ok, and resumes `waitForQuestionsDistilled`/`waitForSamplesDistilled` against the merged old+new manifest.
- [ ] **AC-2:** Given the harness is launched with `--detach` on Windows, When the invoking terminal or Claude Code session that spawned it ends, Then the orchestrator process and its child shard daemons continue running under a detached mechanism equivalent to the `AstraMemoryD` schtasks keepalive pattern (CLAUDE.md "Service / upgrade" section), and a status file in the run dir is updated with machine-readable state (running/completed/failed) and progress counts that a later `--resume` or a plain status-check can read without the original process's stdout.
- [ ] **AC-3:** Given shard daemons are spawned for a run (`spawnEvalDaemon` calls at `run-smoke.mts:122` / `run.mts:102`), When each daemon starts, Then its PID (the `ChildProcess.pid` — not currently captured anywhere on `DaemonHandle`, `scripts/eval/shared/spawn-daemon.ts:95-103`) and bound port are written to a manifest file in the run dir, so a cleanup script can target only those PIDs — satisfying CLAUDE.md's "Do NOT kill processes machine-wide by image name" rule this FEAT exists to support.
- [ ] **AC-4:** Given a shard daemon process is SIGKILLed mid-distill (simulating the 2026-07-10 taskkill incident CLAUDE.md's Do-NOT section records), When the harness is re-launched with `--resume <run-dir>`, Then the merged `ingest-manifest.json` shows every session ingested exactly once — verified by counting manifest entries directly, not merely inferred from `Idempotency-Key` replay behavior (`scripts/eval/longmemeval/ingest.mts:1-6` notes ingest is "resume-safe" via the session-id idempotency key alone, which this AC treats as a safety net, not the resume mechanism) — and the run reaches a final `hypotheses.jsonl`/`run-manifest.json` with no question's session count double-counted in the totals.
- [ ] **AC-5:** Given a fake/stub daemon or provider (no live LLM, no live Ollama) wired into a unit/integration test, When the test kills the stubbed shard process mid-distill and re-invokes the resume path, Then the test deterministically asserts resume correctness in CI — this exercise does not exist anywhere in the harness today (no test kills a daemon mid-distill and asserts on the aftermath).
- [ ] **AC-6:** Given `scripts/eval/locomo/run.mts` already exists as a complete, merged implementation (commit `480d870`, "feat(eval): add LoCoMo benchmark harness alongside LongMemEval (FEAT-457)") mirroring `run-smoke.mts`'s shard/ingest/distill-wait shape line for line, When `--resume`, `--detach`, and the PID/port manifest are implemented, Then the implementation lives in `scripts/eval/shared/` (new module alongside `spawn-daemon.ts`/`shard.ts`/`concurrency.ts`) and both `run-smoke.mts` and `run.mts` consume it identically in the same slice — this corrects the PM triage's "defer LoCoMo wiring until FEAT-457 merges" recommendation below, which rests on `FEAT-457.md`'s stale `status: triaged` frontmatter even though the code has already landed on `main`.
- [ ] **AC-7:** Given no `--resume` or `--detach` flag is passed, When `run-smoke.mts` or `run.mts` is invoked exactly as today, Then run-dir naming, the shape of `ingest-manifest.json`/`distill-wait-result.json`/`run-manifest.json`/`hypotheses.jsonl`, exit-code semantics, and the existing `--dry-run-throughput` mode are all unchanged.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-462 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
