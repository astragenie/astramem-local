# Review: hook_close capture_source provenance widening + profile-learning e2e

**Date:** 2026-07-12T23:30:00Z
**Reviewer:** independent review agent (crew:reviewer role)
**Scope:** Uncommitted working-tree diff (main..working-tree), two builders (builder-capture, builder-profile)
**Verdict: PASS**

## Summary of change

A) New `capture_source = 'hook_close'` provenance value, widening the existing `'auto_capture' | null` union to `'auto_capture' | 'hook_close' | null'` across the full plumbing chain: `src/capture/claude.ts` (envelope type + `buildClaudeEnvelope` param) → `src/cli/capture.ts` (`captureSource` now defaults to `'hook_close'` instead of `undefined`) → `src/server/routes/ingest.ts` (`CanonicalIngestSchema.capture_source` zod enum widened) → `transcripts` table → `src/pipeline/handlers/distill.ts` (reads the column) → `src/distill/pipeline.ts` / `src/distill/stages/08-embed-index.ts` (context plumbing) → `src/storage/memories.ts` (`InsertInput.capture_source`) → `memories` table → `src/doctor/checks.ts` (`checkAutoCapture` counts both values).

B) Two new e2e tests (`tests/e2e/auto-capture-close.e2e.test.ts`, `tests/e2e/profile-learning.e2e.test.ts`) plus targeted additions to three existing unit/integration suites.

## Gate-by-gate findings

1. **Purge scoping (correctness-critical).** Verified in the actual code, not comments. `runAutoCaptureDisable` (`src/cli/capture.ts:216`) hardcodes the literal SQL string `WHERE capture_source = 'auto_capture'` for its local scoping query, and hardcodes the literal JSON body `{ capture_source: 'auto_capture' }` (`src/cli/capture.ts:272`) in its call to `POST /capture/purge`. Neither is parameterized off the new union type, so `'hook_close'` atoms structurally cannot reach either query. The generic `/capture/purge` route (`src/server/routes/capture-purge.ts`) itself accepts an open `z.string().min(1)` and has no branching (by design, per its own doc comment — it's shared with FEAT-458's future `'proxy'` scope), but its only caller today passes the hardcoded literal. **PASS.**

2. **Other consumers of `capture_source`.** Grepped all reads/writes across `src/` (12 files touch the field): the reviewed 9 diff files, plus `src/storage/memory-events.ts` (purge-batch bookkeeping, takes an opaque `captureSource: string` — no branching), `src/server/routes/capture-purge.ts` (reviewed above), and `src/server/lib/wire-meta.ts` (a migration-number comment only, no logic). No sync/export path references the field. **PASS.**

3. **Zod closed enum.** `CanonicalIngestSchema.capture_source` is `z.enum(['auto_capture', 'hook_close']).optional()` — a genuinely invalid value (confirmed by the existing/extended ingest test suite's 400-path assertions) still fails closed, not silently coerced to null. Confirmed via `src/server/routes/ingest.ts:290` that `ingestCanonicalTranscript` (the shared insert function called by both the HTTP route and spool-drain) receives `data.capture_source ?? null` post-parse — same schema instance, no stale copy. **PASS.**

4. **Doctor canary.** `checkAutoCapture` (`src/doctor/checks.ts:1120`) query widened to `capture_source IN ('auto_capture', 'hook_close')`; message/fix wording accurately reflects both provenance values; `ok: true` still returned when auto-capture is disabled (early return unchanged) and when count is 0 below `MEANINGFUL_USAGE_THRESHOLD` (unchanged branch). New doctor unit test covers the previously-uncovered "only hook_close atoms present" case and gets `ok: true`. **PASS.**

5. **Unreachable code (flagged mid-edit around capture.ts:306-319).** Read the current state of `captureCommand` end to end — it's a clean sequential dispatch (`source === 'claude'` → return; `'auto-capture'`/`'disable'` → return; else validate `source === 'codex'` → exit(1); fall through to codex watch/one-shot logic). No unreachable branch in the final state; the diagnostic appears to have been a transient artifact of an intermediate edit state, not a residual defect. **PASS.**

6. **Test quality.**
   - No sleeps-instead-of-polls: `auto-capture-close.e2e.test.ts` uses `pollSearchHits` (the existing poll helper); `profile-learning.e2e.test.ts` is fully synchronous against an in-process Fastify app, no timing dependency at all.
   - No port collisions: `spawnDaemon({ port: 0, ... })` binds an ephemeral port; the profile-learning test also binds `port: 0`.
   - No datadir collisions: `makeIsolatedDaemonEnv` assigns an isolated temp `ASTRA_MEMORY_DATADIR`; profile-learning uses `openDb(':memory:')`. Neither touches the production daemon (7777) or the default datadir.
   - `epsilon: 0.9` in `buildBoostedUsefulnessConfig` is documented inline as a deliberate escape hatch consistent with the existing `usefulness-feedback-loop.e2e.test.ts` pattern, within the real `governance.maxComponentWeight = 1.0` ceiling — same `fuseScores` formula, not a different code path. The test also proves the "before" state isn't rigged (asserts the untouched sibling outranks the correction pre-feedback, then asserts the reorder post-feedback) — this is a real assertion of a real effect, not a tautology.
   - Assertions are behaviorally meaningful throughout (rank movement, profile membership before/after invalidate, provenance value on real DB rows post-distill), not shape-only checks.

7. **Suites run (post `bun run build`, real output, not asserted-from-memory):**
   ```
   bunx vitest run tests/e2e/ tests/cli/capture-claude.test.ts tests/doctor/auto-capture-check.test.ts tests/server/ingest.test.ts
   Test Files  7 passed (7)
        Tests  66 passed (66)
   ```
   Re-ran the two new e2e files alone with `--reporter=verbose` to confirm they actually execute rather than being silently skipped: both show individual `✓` lines (`auto-capture-close.e2e.test.ts` 1125ms — consistent with a real CLI spawn + daemon boot + distill cycle; `profile-learning.e2e.test.ts` 254ms — consistent with an in-process Fastify app, no spawn).

8. **Regressions / out-of-scope behavior.** Diff is fully consistent with the stated scope — no unrelated file touched among the 9 source + 3 test diffs. The legacy `/ingest/transcript` v0.0 envelope path is unaffected: `capture_source` is a canonical-envelope-only field: not read or written on the legacy branch, and the existing "capture_source omitted -> stays NULL" test still passes unchanged.

## Findings requiring action

None. No [SEVERITY] findings.

## Notes for the record

- The `.claude/artifacts/...` and `.claude/state/...` changes in the working tree (handoffs, DEC-014, checkpoint-cadence/cost-hygiene state) are session bookkeeping, out of scope for this code review, and were not evaluated here.
