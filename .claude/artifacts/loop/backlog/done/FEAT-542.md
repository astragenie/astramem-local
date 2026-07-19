---
id: FEAT-542
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-17
updated: 2026-07-18
depends_on: []
slices: [SLICE-438]
derived_from: "external eval-spec review 2026-07-17 (operator-supplied \"Fable Task\" doc) + extraction-bench sweep results 2026-07-17"
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
started_at: 2026-07-18
slices_complete: [SLICE-438]
completed_at: 2026-07-18
---
## Description

**Hard-fixture pack + evidence-accuracy scoring for the extraction bench.**

The 43-fixture extraction bench covers clean/noisy/long/nothing/contradiction/todo/command/entity/secrets/ambiguous — but has ZERO coverage for four failure dimensions a memory system must not get wrong, and never scores evidence accuracy at all:

1. **Negation** — "we are NOT using Redis" must survive as a negative fact (meaning-reversal is the worst extraction failure class).
2. **Uncertainty preservation** — hypothesis vs confirmed cause ("may be DNS" vs "logs confirm cert expiry"); speculation must not harden into fact.
3. **Hypothesis-later-confirmed / status transitions** — blocked → unblocked → running; latest state wins without deleting history.
4. **Cross-chunk dependency** — owner in one turn, task in the next, deadline two turns later, correction landing at a chunk boundary (measured LoCoMo miss class: not-in-db = 55%).

Plus one new metric: **evidence accuracy** — for atoms carrying `evidence`, the quote must actually appear (normalized whitespace) in the source transcript. We store `evidence[]` (FEAT-485 surfaced it in the dashboard) but have never scored whether it is REAL — a fabricated quote currently costs nothing in the bench.

## Acceptance criteria (Given-When-Then)

- AC-1: Given the `fixtures/` directory under `scripts/eval/extraction-bench/`
  (43 fixtures today, confirmed this session), When >=10 new gold
  `GoldFixture` JSON files are added tagged `difficulty:
  negation|uncertainty|status-transition|cross-chunk` (>=2 each), Then
  `loadFixtures()` returns 53+ total fixtures with schema-valid shape
  identical to existing fixtures, and the README's category table lists all
  four new difficulty tags with one example each.
- AC-2: Given a new fixture's `forbidden_items` array (e.g. the superseded
  Friday date, or the positive-polarity restatement of a negated fact), When
  the bench evaluator diffs extracted atoms against gold, Then forbidden-item
  detection runs as a MECHANICAL post-judge string/normalized-semantic match
  between each extracted atom's text and the fixture's `forbidden_items`
  entries — NOT a change to `judge.ts`'s LLM prompt or `JudgeResult` schema —
  because a deterministic match is judge-free and zero-cost, avoiding
  coupling a new failure mode to judge non-determinism (+/-7 F1 points,
  FEAT-450); any extracted atom matching a `forbidden_items` entry is scored
  as a precision failure in the fixture's `FixtureScore`, independent of the
  LLM judge's own verdict.
- AC-3: Given an atom carrying a non-empty `evidence` string, When the daemon
  serves it via `GET /sessions/:id/digest`, Then `DigestMemRow`
  (`src/server/queries/provenance.ts`, currently `{id, type, text}` only,
  verified this session) and the digest route additively expose an optional
  `evidence?: string` field (same pattern as the existing
  `poison_jobs`/`pending_contradictions` additive fields in that file),
  `daemon-runner.ts`'s `DaemonAtom` type reads it, and report.md's new
  "Evidence acc" column computes, per model, the percentage of
  evidence-bearing atoms whose quote string-matches the source transcript
  after whitespace normalization. Given an atom with NO `evidence` field,
  When the Evidence-acc column is computed, Then that atom is excluded from
  the denominator, not counted as a failure.
- AC-4: Given the expanded fixture set (43 + >=10 new), When the bench is
  rerun with `--runs 3` against `qwen2.5:7b` and `qwen3.5:9b`, Then
  report.md's committed results include a fresh dated baseline run under
  `scripts/eval/extraction-bench/results/` recording mean +/- stdev per
  FEAT-450's noise-floor convention for F1/typeAcc/Evidence-acc.
- AC-5: Given the new fixture categories and forbidden_items convention,
  When README.md is updated, Then it documents each of the 4 new difficulty
  tags with one example each, defines `forbidden_items` semantics precisely,
  and cross-references AC-3's mechanical evidence-acc definition.
- AC-6: Given a fixture whose `forbidden_items` entry is a SUBSTRING of a
  legitimately-extracted correct atom (e.g. forbidden item "Friday"
  appearing inside a correct atom mentioning "next Friday's release"), When
  the mechanical forbidden-item matcher runs, Then it matches on the full
  normalized claim text, not a bare substring, and the matcher's test suite
  includes this exact adversarial case asserting it does NOT trigger a false
  precision failure.
- AC-7: Given a bench run computing Evidence-acc and forbidden-item hits,
  When results are written to report.md, Then the bench process also writes
  a structured `results/<run>/summary.json` (or equivalent field) recording
  per-model `forbidden_item_hits` and
  `evidence_acc_denominator`/`evidence_acc_numerator` counts — closing the
  observability gap (avg 0.69 across the last 5 real slice grades, weakest of
  7 dimensions) by making the new metrics' raw inputs inspectable, not just
  the final percentage.

## Options considered

- Score forbidden_items inside `judge.ts`'s LLM prompt (ask the judge model
  to flag forbidden claims) — rejected: couples a new failure mode to judge
  non-determinism when a deterministic string/quote match is judge-free and
  zero-cost (AC-2 decision, per architect-reviewer follow-up 2026-07-17).
- Add the `evidence` field only to the direct-pipeline path (skip the daemon
  HTTP wire) — rejected: renders Evidence-acc real for exactly one reference
  model (azure:gpt-5-mini) and a permanent dash for every Ollama candidate,
  defeating the comparison's purpose (architect correction already baked
  into AC-3 in the FEAT body).

## Explicitly out of scope

- SPO subject/predicate/object schema, 12-type taxonomy (rejected — H2 teardown verdict: do not re-litigate the atom ontology).
- Chunking-strategy matrix (PR #282 already measured speaker-aware boundaries).
- New models; this is fixture+metric work only (with the one additive digest-wire exception AC-3 now calls out above).
