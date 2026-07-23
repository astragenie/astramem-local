# Review result — Track E: LoCoMo noise-sampling measurement harness

- **Branch/commit:** `track/e` @ `479c0903` (single commit on top of `feat/retrieval-overhaul` @ `b2b9f008`)
- **Worktree:** `C:/work/mega/astra-wt/track-e`
- **Reviewer:** independent read-only review (team-lead dispatch)
- **Scope:** `scripts/eval/locomo/judge/robust-stats.{ts,test.ts}`, `scripts/eval/locomo/repeat-run.{mts,test.ts}`, `scripts/eval/locomo/full-suite.{mts,test.ts}` (6 files, +913/-0)

## Verdict: **PASS** (one MEDIUM finding, non-blocking; recommend a fast-follow, not a re-spin)

## What was verified

1. **Base/additive discipline** — `git diff feat/retrieval-overhaul..track/e --stat` shows exactly the 6 claimed new files, 913 insertions, 0 deletions, 0 modified existing files. `track/e`'s merge-base with `feat/retrieval-overhaul` is `b2b9f008` (branch HEAD) — correctly based, one commit ahead. Main checkout (`C:/work/mega/astramem-local`) was untouched by this work (its pre-existing dirty state is unrelated background noise from other tracks/sessions).
2. **Typecheck + tests** — `bunx tsc --noEmit -p tsconfig.json` clean (no output/errors). `npx vitest run scripts/eval/locomo` → **14 files / 172 tests, all passing**. Counted `it(` blocks in the 3 new test files independently: 17 (robust-stats) + 21 (repeat-run) + 5 (full-suite) = **43**, matching the claimed "43 new" exactly.
3. **Statistical correctness (`robust-stats.ts`)** — `median()` uses the standard definition (average of two middle values on even length), correctly filters non-finite values (`NaN`/`Infinity`) via `Number.isFinite`, consistent with how `combineMetricsReports`'s NaN-when-zero-scores sentinel already works (`metrics.mts:144-145`), so both aggregations drop the same "n/a" cases the same way. `computeRobustStats` handles empty (`n=0`, all null), single-value (`range: null`, not `0` — correctly means "nothing to spread over" rather than "zero spread"), and multi-value cases correctly. The outlier-resistance tests (`robust-stats.test.ts:56-65`, `112-119`) genuinely assert `median > mean` on a constructed 2-good/1-bad-outlier sample rather than just checking happy-path shape — this is a real (if narrow) integration check of the module's stated purpose, not a tautology.
4. **reingest vs. reanswer separation** — traced end-to-end through `run.mts`:
   - `--resume` (`run.mts:245,331,575`) loads a per-shard ingest ledger and only re-POSTs sessions not already marked complete; since a reanswer base dir is fully ingested, **zero new ingest/extraction calls occur** — confirmed by reading `runShard`'s `resumeCompleted` wiring, not just trusting the comment.
   - `writeHypothesesJsonl` (`answer.mts:406-409`) uses `writeFileSync` (overwrite, not append), so every `--resume` invocation fully rewrites `hypotheses.jsonl` in the base dir with that pass's answers.
   - `repeat-run.mts`'s `runReanswer` loop calls `runChild` (blocking `spawnSync`, no async race possible) then `snapshotAnswerOutputs` **immediately after**, before the next loop iteration's `--resume` invocation overwrites the file again — order is correct and race-free by construction (single-threaded, synchronous).
   - Live-verified with a real archived run dir (`.eval-data/locomo/runs/20260720-baseline-v2`): ran `--mode reanswer --print-only` against it, confirmed the resolved child command derives `--dataset/--seed/--n/--shards` correctly from its `run-params.json`, confirmed via sha256 that the base dir's `hypotheses.jsonl`/`run-params.json` were byte-identical before and after, and confirmed no `-reanswer1`/`-reanswer2` snapshot dirs were created (print-only truly no-ops before `spawnSync`).
   - `reingestRunDirs` forwards the **identical** `passthrough` array to every fresh repeat by construction, so "same dataset/seed/n/qaPerSample/shards across repeats" holds trivially for reingest mode — no separate check needed there.
5. **Guard reuse** — `evaluateMultiRunParamsGuard` (`scripts/eval/shared/run-params.ts:148`) is called unmodified inside `aggregateRunDirs` before any scoring, and a real negative-path test (`repeat-run.test.ts:128-135`) constructs two run dirs differing only in `seed` and confirms a hard refusal naming the mismatch — not just a mock/stub check.
6. **Box/cost safety** — `--print-only` on both `repeat-run.mts` and `full-suite.mts` returns before the only `spawnSync` call in each file; live-smoke-tested both (reingest print-only, reanswer print-only against a real dir, full-suite print-only) and confirmed zero directories created, zero file mutations, zero child processes spawned. `full-suite.mts`'s `FULL_SUITE_DEFAULT_FLAGS` (`full-suite.mts:54-65`) contains no `--shards` entry, and `buildFullSuiteArgs`'s override logic is separately unit-tested for the no-shards-default guarantee.

## Findings

### [MEDIUM] `--mode reanswer` silently drops the base run's `--k` (and other non-scope-guarded answer-time flags) unless the operator manually re-supplies them
**Where:** `scripts/eval/locomo/repeat-run.mts:113-127` (`deriveResumeSamplingArgs`), `275-293` (`runReanswer`)

`deriveResumeSamplingArgs` only re-derives the 5 fields tracked by `RunParams` (`datasetPath, seed, n, qaPerSample, shards`) — the exact set `evaluateResumeGuard`/`evaluateMultiRunParamsGuard` already protect. It does **not** re-derive `--k` (retrieval depth) or `--answer-concurrency`, both of which are answer-time parameters that materially affect the score and are **not** covered by either guard (`run.mts:120`: `const k = Number(get('--k') ?? '10')`, parsed fresh on every invocation with no persistence). If a base run was ingested at a non-default `k` (e.g. `full-suite.mts`'s own tuned baseline pins `k=15`, `full-suite.mts:59`) and an operator runs `repeat-run.mts --mode reanswer --base-run-dir <dir> --runs 3` without separately re-adding `--k 15` to the trailing passthrough args, every reanswer repeat silently runs at `k=10` instead of `k=15` — a genuine retrieval-depth change masquerading as "answerer noise," which is exactly the class of mis-attribution this tool exists to prevent (the file's own header cites the 2026-07-20 multihop-v2 LEDGER incident as precedent for this exact failure mode). Neither guard catches it because `k` was never a `RunParams` field.

The data needed to prevent this is already sitting one step away: `snapshotAnswerOutputs` (`repeat-run.mts:135-144`) copies the base run's `run-manifest.json` into every snapshot dir "best-effort... purely informational" — and that manifest **does** record `k` (confirmed live: `.eval-data/locomo/runs/20260720-baseline-v2/run-manifest.json` has `"k": 15`). It's copied for inspection but never read back to auto-derive the child's `--k`, and there's no warning when the passthrough omits it.

No test constructs a non-default-`k` base manifest and checks it's preserved or warned about — this gap has no counter-evidence in the test suite either.

**Suggested fix (either is sufficient, not both required):**
- (a) Extend `deriveResumeSamplingArgs` (or add a sibling helper) to also read `run-manifest.json` and auto-derive `--k`/`--answer-concurrency` the same way it derives the `RunParams` fields, so an operator never has to remember them, or
- (b) At minimum, read the base manifest's `k` in `runReanswer` and print a loud, impossible-to-miss warning (not just silent proceed) when the passthrough doesn't include an explicit `--k` and the manifest's value differs from `run.mts`'s hardcoded default.

This is not a blocker — the tool is explicitly documented as "pass any run.mts flag yourself," so an operator who reads the header carefully and remembers to restate `--k` gets a correct result — but given this harness's entire purpose is guarding against exactly this class of silent mis-measurement, it's worth a fast-follow before this tool is used to gate a real lever decision.

## Non-findings worth recording (checked, no issue)
- `--flag=value` equals-syntax can't bypass the `RESERVED_REINGEST_FLAGS`/`RESERVED_REANSWER_FLAGS` string-match check, because this codebase's CLI convention (including `run.mts`'s own `get()`) is consistently space-separated flags throughout — not a realistic input pattern here.
- `run.mts`'s pre-existing "`AllSkippedError`-adjacent, exits 0 even when all questions were skipped" class of issue (referenced in `answer.mts`'s own comments) is inherited by both new entry points unchanged — it's a pre-existing `run.mts` behavior, out of scope for this additive diff, not introduced or worsened here.
- Double-sorting inside `computeRobustStats`→`median()` (sorts once, then `median()` re-sorts the already-sorted array) is a harmless inefficiency at this array size (N=3–5), not worth a finding.

## Evidence trail
- `git diff feat/retrieval-overhaul..track/e --stat` → 6 files, +913/-0
- `bunx tsc --noEmit -p tsconfig.json` → clean
- `npx vitest run scripts/eval/locomo` → 14 files, 172 tests passed
- Live smoke: `repeat-run.mts --mode reingest --print-only`, `--mode reanswer --print-only` (against both a missing dir and a real archived dir, sha256-verified untouched), `full-suite.mts --print-only --shards 2` — all confirmed side-effect-free
