---
id: PM-REVIEW-FEAT-542
feature: FEAT-542
reviewed_at: 2026-07-17
pm_customer_impact: 0.55
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.75
pm_technical_risk: 0.35
pm_dependency_depth: 0.15
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-542 (deep triage)

## Demand Assessment

LoCoMo measurement memory (`locomo-recall-vs-recall-measured`, this repo's
own record): "not-in-db=55% (EXTRACTION dominant)" — the cross-chunk
dependency category this FEAT adds fixtures for is exactly the not-in-db
failure class already measured as dominant. FEAT body: "for atoms carrying
`evidence`, the quote must actually appear ... in the source transcript ... a
fabricated quote currently costs nothing in the bench." Verified this
session: `DigestMemRow` (`src/server/queries/provenance.ts:84-88`) is exactly
`{ id, type, text }` — no `evidence` field — confirming the FEAT body's
architect-correction claim that the daemon HTTP digest path (the only path
real Ollama candidates run through) cannot surface evidence today. Stakeholder:
the extraction-bench itself (43 fixtures confirmed via `ls` this session) as a
measurement instrument. Current workaround: none for evidence accuracy; the 4
new fixture categories have no proxy today.

## Scope Challenge

Smallest deliverable is already tightly scoped by AC-1 through AC-5; nothing
further to cut without losing a fixture category or the evidence-acc metric.
Overlap check: grepped `scripts/eval/extraction-bench/fixtures/` (43 files,
fx01-fx43) — zero existing fixtures tagged negation/uncertainty/status-transition/
cross-chunk, confirmed no duplication. AC-2's scoring mechanism (judge-prompt
change vs. mechanical post-judge check) was the one architect-flagged
ambiguity — resolved below to the mechanical option (judge-free, zero
Azure/noise cost).

## Risk Radar

Not mandatory (technical_risk 0.35 < 0.6, priority P2 not P0/P1) but recorded:

- Blast radius: AC-3's additive `evidence?: string` field touches
  `DigestMemRow`, the digest route, and `daemon-runner.ts`'s `DaemonAtom` type
  — 2 production-adjacent files + 1 eval-tooling file, all additive/optional.
- Failure mode: a `forbidden_items` substring false-positive is possible
  (e.g. forbidden "Friday" inside a correct atom about "next Friday's
  release") — AC-6 requires an explicit adversarial test.
- Even though additive, `GET /sessions/:id/digest` is a live wire route —
  worth the same contract-parity discipline `tests/contracts/mcp-tool-manifest-parity.test.ts`
  already applies elsewhere in this repo, not an assumption that "additive"
  automatically means safe to every consumer.

Injection-defense: scanned FEAT-542's body and triage_notes this session — no
embedded imperative found.

## Scores

- customer_impact: 0.55
- effort_estimate: 0.55
- strategic_alignment: 0.75
- technical_risk: 0.35
- dependency_depth: 0.15

## Priority Derivation

composite_priority: P2
autonomous_safe: true
reasoning: pm-scorer.mts — P0 fails (impact 0.55). P1: (impact>=0.7 AND
alignment>=0.6) fails (impact); (alignment>=0.8 AND effort<=0.4) fails
(alignment 0.75 < 0.8). P3: effort>=0.7 fails (0.55). → **P2**. autonomousSafe:
risk 0.35, effort 0.55, dep 0.15 all <=0.6; hasAcceptanceCriteria=true (7 ACs
drafted below) → **true**. Weighted composite (informational): 0.55×.35 +
0.75×.30 + (1-.55)×.20 + (1-.35)×.10 + (1-.15)×.05 = 0.615 — second-highest of
this batch, consistent with the architect's recommended order (543 → 542 →
544). effort_points via pm-effort-mapper.mts (0.4<=x<0.6 → 5): under the
>=8 decomposition gate.

## Apply — frontmatter patch for FEAT-542.md

```yaml
priority: P2
autonomous_safe: true
updated: 2026-07-17
triage_notes: |
  Filed 2026-07-17 after the model-sweep session. Harvested from an external
  eval spec whose methodology was judged strong while its premise (qwen3.5:4b
  as primary candidate, SPO schema rewrite) was rejected as already-refuted /
  anti-H2. This FEAT is the fixture-side harvest only.
  ---
  2026-07-17 PM deep triage: P2, autonomous_safe=true. customer_impact 0.55
  (LoCoMo not-in-db=55% names the cross-chunk category; evidence-acc
  currently unscored), effort 0.55 (5 pts — includes a small additive src/
  touch: DigestMemRow + digest route + daemon-runner.ts), strategic_alignment
  0.75, technical_risk 0.35 (additive wire field, cross-module but no
  contract break), dependency_depth 0.15. AC-2's forbidden_items mechanism
  decided: mechanical post-judge string/normalized-semantic match, NOT a
  judge.ts prompt change (architect-reviewer follow-up 2026-07-17). 7
  Given-When-Then ACs drafted inline (--deep).
```

## Apply — body section replacement for FEAT-542.md

Replace the existing `## Acceptance criteria` section with:

```markdown
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
```
