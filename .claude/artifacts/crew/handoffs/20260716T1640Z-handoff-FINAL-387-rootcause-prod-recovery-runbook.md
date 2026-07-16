# FINAL handoff 2026-07-16 — #387 root-caused; prod recovery runbook; wave/eval state

owner: next session. Read this FIRST, then `20260716T162439Z-handoff-387-health-starvation-boot-consolidate-freeze.md` (investigator's full write-up) and the #387 issue comment.

## PROD IS CURRENTLY DOWN-ISH — recovery runbook (do this first)

State at handoff: no daemon answering :7777. Poisoned job REMOVED (see below) but the last `service start` still didn't answer within 120s — likely EADDRINUSE cascade (finding 2) from a half-dead predecessor, NOT the job (which is gone). Steps:

1. `Get-NetTCPConnection -LocalPort 7777` + `Get-Process node` — kill ANY node holding 7777 or matching daemon.lock's pid (check start-time vs lock's startedAt; the #328 drift guard false-refuses at 60s drift — Stop-Process directly after confirming ProcessName=node).
2. Confirm jobs table clean: `SELECT id,state FROM jobs WHERE kind='consolidate' AND state IN ('running','pending')` → must be empty (I failed out `dcbf6a61-948f-4ecc-9392-2c2f1c39a266` — evidence snapshot: `%TEMP%/387-poisoned-jobs.json`).
3. `service start` (shim currently injects `ASTRA_SKIP_CONSOLIDATE=1` — TEMP edit, see below) → health should answer in <60s. If it STILL doesn't: the investigator's finding-2 loop (zombie takeover w/o port verify) or a SECOND orphan mechanism — attach CDP per the saturation ladder (memory: daemon-event-loop-saturation-triad).
4. Once healthy: prod serves release cf055eef (wave-1 code, schema 51) via the manually-repointed current.json.

## #387 ROOT CAUSE (investigator-verified, high confidence)

1. **`JobRepo.recoverOrphans()` (job-repo.ts:123-134) runs unconditionally at boot BEFORE listen()** and requeues any `running` job — including the consolidate job the killed 14:45Z knn run left behind. Worker's first pickup re-runs the unbounded knn scan setup → blocks before/through `app.listen()` (live-corroborated: holder had NO listener, zero CPU delta, held sqlite exclusively). `ASTRA_SKIP_CONSOLIDATE` gates the handler but evidently not this freeze path — treat env gate as insufficient.
2. **`instance-lock.ts:344-360` zombie takeover never verifies the holder died or the port freed** → new boot EADDRINUSE exit-1 → keepalive respawns → crash loop (dozens of exit-1 at 5-min cadence in exit-history.jsonl today).

**Fixes to build (small, well-scoped):** (a) recoverOrphans must not blind-requeue consolidate jobs (poison after one recover cycle / require explicit re-enqueue); (b) instance-lock steal path verifies port free or uses stopLockHolder's identity-checked kill; (c) bound/yield consolidate scan setup (the original P2.1 debt). File as PRs against #387.

## TEMP states to unwind later (all documented in-place)

- Shim `%LOCALAPPDATA%\Astramem\bin\astramemd.cmd`: injects ASTRA_SKIP_CONSOLIDATE=1 (next reinstall overwrites).
- User env: ASTRA_SKIP_CONSOLIDATE=1 re-set via setx (remove when #387 fixed).
- config.yaml: compaction TEMP on codex (flip back to ollama/qwen3:8b after LoCoMo done); candidateSelection reverted to full; judge dry-run ollama/qwen3:8b.
- current.json: hand-repointed to cf055eef (reinstall will normalize).

## Wave plan / eval state

- Wave 1: ALL MERGED (#376/#381, #377/#380/#383, #378/#382, #379/#384 operator-approved). Exit gate incomplete: reinstall+doctor blocked on #387 → after recovery, rerun `reinstall` (should pass with job gone) → doctor → dispatch Wave 2 (FEAT-533, #341) per plan `.claude/artifacts/loop/plans/20260716-wave-plan-local-llm-quality-and-reliability.md`. REMEMBER: hold-label rule for carve-out PRs (memory: automerge-optout-hold-label).
- **LoCoMo run 3 in flight**: wt-jsonschema, `runs/2026-07-16T15-21-49-492Z`, 6h distill budget, ~verdict 22:00-23:00Z. On completion run the printed judge.mts command, compare vs 0.5549 codex baseline → decides extraction→local flip (+passes→2 +compaction back local, one coherent operator-approved change).
- E3/E4 (#385/#386) — sibling session owns filing; coordinate before building (same distill files as FEAT-533).
- Bench artifacts: `wt-jsonschema/scripts/eval/extraction-bench/results/qwen3x-schema-20260716/` + `codex-gpt54mini-20260716/` (qwen3:8b F1 76 / codex 64).

## Operator decision queue
1. #387 fix PRs (a)+(b) above — small, dispatch as one slice.
2. LoCoMo verdict → the coherent local-extraction flip.
3. Judge dry-run review → enabled; FEAT-533 build (wave 2).
