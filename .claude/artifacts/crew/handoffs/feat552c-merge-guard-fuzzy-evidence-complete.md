# FEAT-552 sub-scope C — command merge guard + fuzzy evidence tier — BUILD COMPLETE

- **Worktree**: `C:\work\mega\astramemory-local-wtC`
- **Branch**: `feat/552c-merge-guard` (base `98515925`)
- **Tip SHA**: `598bb5ef`
- **Status**: DONE (review: `approved_with_notes`, MEDIUM-2 fixed, MEDIUM-1 recorded as follow-up below)

## Objective

Implement AC-C1 (command-token merge guard) and AC-C2 (fuzzy evidence tier)
from `.claude/artifacts/loop/backlog/pending/FEAT-552.md` §C.

## Review follow-up (2026-07-18, `crew:reviewer`)

Review artifact:
`.claude/artifacts/crew/reviews/20260718T072849Z-review-result-feat-552c-merge-guard-fuzzy-evidence-review.md`
— decision `approved_with_notes`, 0 HIGH/CRITICAL, 2 MEDIUM, 1 LOW.

**MEDIUM-2 (fixed, this commit)**: the containment auto-merge tier bypassed
the command guard entirely at BOTH of its call sites — `processPair`'s
`autoMergeContained` branch (pairwise scan, first encounter of a pair) and
`sweepContainedProposals` (resolving an EXISTING pending proposal on a
later run). Reviewer's exact repro:
`containment('git checkout -- A.ts', 'git checkout -- A.ts --force')` returns
`'b-contains-a'` (the aggressive containment normalization strips `--`/`.`
punctuation, so the shorter command reads as a "subset" of the longer one)
while `commandGuardBlocksMerge` on the same pair is `true` — before this
fix, the containment tier auto-merged the pair with zero human review, the
exact false-merge class AC-C1 exists to stop.

Fix applies `commandGuardBlocksMerge` at both containment points with the
SAME downgrade-to-pending-proposal behavior + metadata annotation +
`summary.commandGuardBlocked` counter the `>=mergeThreshold` tier already
had:
- `processPair`'s containment branch: guard-blocked pairs now call the
  existing `insertGuardedMergeProposal` (same helper the mergeThreshold tier
  uses) instead of `mergeAsSupersede`.
- `sweepContainedProposals`: its SELECT now also fetches `w.type`/`l.type`
  (needed for the guard, wasn't previously selected) plus `p.loser_id`/
  `p.similarity`; a guard-blocked existing proposal is left pending with
  `annotateCommandGuardBlocked(db, id, { source: 'containment-sweep' })`
  instead of being auto-accepted. `annotateCommandGuardBlocked` was
  generalized to take an `extra` metadata object so both this call site and
  the pre-existing dup-judge call site share one function.

Tests added (regression coverage for the exact repro + the reviewer's LOW):
- `MEDIUM-2 repro: the containment auto-merge tier blocks a command pair the
  reviewer found bypassing the guard` — reviewer's literal fixture,
  pairwise-scan path.
- `LOW: blocks a compound (&&-chained) command pair where one command has an
  extra chained step` — `git add . && git commit -m wip` vs the same plus
  `&& git push`.
- `MEDIUM-2: sweepContainedProposals refuses to auto-accept an EXISTING
  pending command-atom proposal with differing tokens` — mirrors the
  pre-existing "sweeps EXISTING pending proposals" test's two-run shape;
  note the guard fires TWICE in the second run (once from the sweep, once
  more from the pairwise scan re-encountering the same still-valid,
  still-untouched pair) — both refuse, neither merges or double-inserts
  (`insertGuardedMergeProposal`'s existing dedup guard no-ops the second
  attempt), asserted explicitly in the test rather than assumed.

**MEDIUM-1 (recorded as follow-up, no code changed this slice)**: prose
contamination in `tokenizeCommandSurface` — it tokenizes the atom's WHOLE
`.text`, not just the command invocation. A `type='command'` atom is
expected to be a short imperative surface (e.g. `git checkout A.ts`), but if
an atom's stored text ever carries trailing prose (e.g. `git checkout A.ts
— reverting the bad refactor`), two atoms describing the SAME command with
DIFFERENT trailing prose will over-block: their token sets differ on the
prose words even though the command itself is identical, so a legitimate
same-command merge gets needlessly downgraded to a manual proposal.

This is the fail-safe direction (queue noise, not data loss — the opposite
failure mode of the false-merge bug this whole guard exists to prevent), so
it was not treated as blocking. Sketch of the eventual fix, for whoever
picks this up: isolate the command invocation from trailing prose BEFORE
tokenizing — e.g. split on the first sentence-ending punctuation not inside
a quoted/path segment, or (more robustly) have the extraction prompt tag a
command atom's `evidence`/a new `command_surface` field with just the
invocation text, and tokenize THAT instead of `.text`. Needs real
command-atom corpus samples first to confirm the over-blocking rate is
worth the added extraction-schema surface — don't build this speculatively.

## AC-C1 — command-token merge guard

New module `src/consolidate/command-guard.ts`:
- `tokenizeCommandSurface(text)`: whitespace split, backslash→forward-slash
  path normalization, single-layer quote stripping.
- `commandGuardBlocksMerge(a, b)`: `true` iff either atom is `type:
  'command'` AND tokenized surfaces differ as SETS (order-insensitive).
  Returns `false` unconditionally when neither atom is `type: 'command'`
  (non-command pairs unaffected, tested).

Wired into `src/consolidate/consolidate.ts` at the two auto-merge points the
spec names, PLUS the two containment auto-merge points the reviewer found
bypassing the guard (MEDIUM-2, fixed — see the review-follow-up section
above):
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
3. **Containment auto-merge branch** (`processPair`'s `autoMergeContained`
   check): same downgrade-to-pending-proposal treatment as (1) — the
   aggressive containment text normalization otherwise treats two
   differently-tokenized commands as a subset/superset pair.
4. **`sweepContainedProposals`** (resolves EXISTING pending proposals on a
   later run, not just new pairs): guard-blocked rows are left `pending`
   with `annotateCommandGuardBlocked(db, id, { source: 'containment-sweep'
   })` instead of being auto-accepted; its SELECT now also fetches atom
   `type` (needed for the guard, previously absent).

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
  # 34 test files passed, 726 tests passed, 4 skipped (pre-existing
  # intentional skips, unrelated to this slice) — re-run clean after the
  # MEDIUM-2 fix (3 new tests added: repro pair, &&-chained LOW, sweep case)
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
- **MEDIUM-1 (open, tracked above)**: `tokenizeCommandSurface` tokenizes an
  atom's whole `.text`, so a command atom whose stored text carries trailing
  prose can over-block a legitimate same-command merge on prose-word
  differences alone. Fail-safe direction (queue noise, not data loss) — see
  the "Review follow-up" section above for the sketch of a
  command-substring-isolation fix. Not fixed this slice; needs real
  command-atom corpus samples before investing in an extraction-schema
  change.
- Scope was otherwise kept literally to the auto-merge points AC-C1 names
  plus the two containment points the review found (MEDIUM-2, now fixed).
  The `autoAcceptThreshold` path (FEAT-442, default OFF) is still NOT
  guarded — out of AC-C1's literal text and off by default; flag for a
  follow-up if it's later confirmed to reproduce the same false-merge class.
- **Pre-existing, unrelated anomaly noticed in passing**: `src/consolidate/
  consolidate.ts` contains a few literal NUL bytes (U+0000) inside template-
  literal string separators (e.g. `` `${a.id} ${b.id}` `` in
  `buildKnnCandidatePairs` and the `groups` Map key in `runConsolidation`) —
  confirmed via `git show 98515925:src/consolidate/consolidate.ts` that
  these predate this slice and are NOT something this change introduced.
  They don't affect correctness (the separator is internally consistent
  either way) but are worth a dedicated cleanup pass given this repo's own
  documented NUL-byte/jsonb incident history (see MEMORY.md's "Sync wedge:
  NUL byte vs Postgres jsonb"). Out of scope here — flagging only.
- Not committed: no push, no PR opened (per dispatch — local branch only).
