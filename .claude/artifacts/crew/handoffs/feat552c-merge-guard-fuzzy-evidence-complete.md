# FEAT-552 sub-scope C — command merge guard + fuzzy evidence tier — BUILD COMPLETE

- **Worktree**: `C:\work\mega\astramemory-local-wtC`
- **Branch**: `feat/552c-merge-guard` (base `98515925`)
- **Tip SHA**: `eae14ff8949edf77f4fa42351699fbdc9eab8c9c`
- **Status**: DONE

## Objective

Implement AC-C1 (command-token merge guard) and AC-C2 (fuzzy evidence tier)
from `.claude/artifacts/loop/backlog/pending/FEAT-552.md` §C.

## AC-C1 — command-token merge guard

New module `src/consolidate/command-guard.ts`:
- `tokenizeCommandSurface(text)`: whitespace split, backslash→forward-slash
  path normalization, single-layer quote stripping.
- `commandGuardBlocksMerge(a, b)`: `true` iff either atom is `type:
  'command'` AND tokenized surfaces differ as SETS (order-insensitive).
  Returns `false` unconditionally when neither atom is `type: 'command'`
  (non-command pairs unaffected, tested).

Wired into `src/consolidate/consolidate.ts` at the two auto-merge points the
spec names:
1. **`sim >= mergeThreshold` auto-merge tier** (`processPair`): a
   guard-blocked pair is downgraded to a pending `kind='merge'` proposal
   (via new `insertGuardedMergeProposal`) instead of auto-merging — nothing
   is lost, a human still sees it. `metadata_json` carries
   `{ command_guard_blocked: true, command_guard_reason:
   'command-token-mismatch' }`.
2. **FEAT-549 dup-judge sweep's auto-resolve step** (`runDupJudgeSweep`): a
   guard-blocked proposal's verdict is still computed/logged, but resolve
   (accept OR reject) is refused — the proposal stays `pending` with a guard
   marker patched onto `metadata_json` (new `annotateCommandGuardBlocked`,
   includes the verdict/confidence that was refused).

Observability (no migration): `ConsolidateSummary.commandGuardBlocked[]` and
`.dupJudgeCommandGuardBlocked` (in-memory counters, same pattern every other
summary counter in this file uses), a structured log line per hit, and the
`metadata_json` DB-row markers above on the EXISTING `consolidation_proposals`
table. No new table — a dedicated guard-drops table would have required a
migration (forbidden this slice); reusing an unrelated domain's `_guard_drops`
table would have corrupted that domain's own doctor canary, so this design
rides `consolidation_proposals.metadata_json` instead.

Measured basis: 2026-07-18 prod audit — phi false-merged `git checkout
A.ts` vs `B.ts` at cosine similarity 1.00.

## AC-C2 — fuzzy evidence tier

`src/distill/evidence-verify.ts`: after the existing exact
whitespace-normalized substring check fails, a new token-window fallback
slides a window (length = quote's own token count) across the transcript
and passes on `>=90%` multiset token overlap (`FUZZY_TOKEN_OVERLAP_MIN`).

- `verifyEvidenceQuoteTier(evidence, transcript): 'exact' | 'fuzzy' | 'none'`
  — the one real implementation.
- `verifyEvidenceQuote(...)` (pre-existing boolean signature, used by the
  extraction bench's `computeEvidenceAccuracy`) now delegates to the tier
  function — **ONE implementation**, so the bench inherits the fuzzy tier
  automatically with zero separate wiring.

`src/distill/evidence-gate.ts`'s `checkEvidenceGate` now calls
`verifyEvidenceQuoteTier` directly and reports `matchTier: 'exact' | 'fuzzy'
| null` on `EvidenceGateCheckResult` so the production caller can count
fuzzy admissions distinctly.

`src/distill/stages/08-embed-index.ts` counts `matchTier === 'fuzzy'`
admissions separately (`passBFuzzyMatched`) and writes them into the
EXISTING `evidence_gate_drops` table (migration 053, already-shipped
generic `TEXT` `reason` column, no CHECK enum) under a new PASS-tier reason
`'evidence-fuzzy-matched'` (`EVIDENCE_FUZZY_MATCHED_REASON`,
`src/storage/evidence-gate-log.ts`) — a fuzzy admission is never added to
`atomsDropped` (that sum still only includes the two real drop reasons), so
the existing drop-rate canary math is unaffected.

Genuinely fabricated quotes still fail both tiers — verified by test
(`we definitely ARE using Redis` against a Redis-negating transcript stays
`'none'`; empirically checked the token-overlap math with a standalone
script before writing the fixture, see commit message).

## Bench/gate agreement (AC-3 regression check)

`scripts/eval/extraction-bench/lib/mechanical-checks.test.ts`'s existing
"tolerates whitespace differences but not a fabricated quote" case (the
fabricated `we definitely ARE using Redis` example) still resolves to
`numerator: 1, denominator: 2` — the fabricated quote shares only 60% of its
tokens with the best-matching transcript window (well under the 90% bar),
so this pre-existing expectation needed NO change.

`tests/distill/evidence-gate.test.ts`'s bench/gate-agreement describe block
required updating three `.toEqual({admitted, reason})` full-object
assertions to also expect the new `matchTier: null` field (additive field,
not a behavior change) — done, noted inline in the diff.

## Tests added/updated

- `tests/consolidate/command-guard.test.ts` (new): tokenizer + guard unit
  tests (path normalization, quote stripping, token-set order-insensitivity,
  non-command bypass).
- `tests/consolidate/consolidate.test.ts`: 5 new integration tests in a
  `command-token merge guard (FEAT-552 sub-scope C, AC-C1)` describe block
  — mergeThreshold-path block+downgrade, identical-token pass-through,
  non-command-pair byte-identical check, dup-judge-sweep refuse-to-resolve
  (both directions covered via the "still pending" assertion), dup-judge
  same-token-set normal-resolve control case.
- `tests/distill/evidence-gate.test.ts`: new fuzzy-tier describe block
  (`verifyEvidenceQuoteTier fuzzy fallback`) plus one new `checkEvidenceGate`
  fuzzy-admission test; existing exact-equality assertions patched for the
  additive `matchTier` field.

## Verification evidence

```
bun run build                                    # tsc -p . — clean
npx tsc -p tsconfig.tests.json                    # clean
npx tsc -p tsconfig.eval.json                     # clean
ASTRA_SKIP_CONSOLIDATE unset (was not set in this shell)
npx vitest run tests/consolidate/ tests/distill/ \
  tests/eval/consolidation-eval.test.ts \
  scripts/eval/extraction-bench/lib/mechanical-checks.test.ts
  # 34 test files passed, 723 tests passed, 4 skipped (pre-existing
  # intentional skips, unrelated to this slice)
```

## Files changed

- `src/consolidate/command-guard.ts` (new)
- `src/consolidate/consolidate.ts`
- `src/distill/evidence-gate.ts`
- `src/distill/evidence-verify.ts`
- `src/distill/stages/08-embed-index.ts`
- `src/storage/evidence-gate-log.ts`
- `tests/consolidate/command-guard.test.ts` (new)
- `tests/consolidate/consolidate.test.ts`
- `tests/distill/evidence-gate.test.ts`

## Risks / follow-ups

- The command guard is unconditional (no config gate) — matches the spec's
  intent (a hard safety rule, not an opt-in feature) but means there is no
  killswitch if it ever needs disabling; a follow-up FEAT could add one if
  a false-positive class turns up in practice (e.g. two genuinely-equivalent
  commands using different but semantically-identical flags).
- Scope was kept literally to the two auto-merge points AC-C1 names
  (`mergeThreshold` tier + dup-judge resolve). The `autoAcceptThreshold`
  path (FEAT-442, default OFF) and the containment tier are NOT guarded —
  both are out of AC-C1's literal text; flag for a follow-up if either path
  is later confirmed to reproduce the same false-merge class.
- Not committed: no push, no PR opened (per dispatch — local branch only).
