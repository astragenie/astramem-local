---
id: PM-REVIEW-FEAT-549
feature: FEAT-549
reviewed_at: 2026-07-18
pm_customer_impact: 0.60
pm_effort_estimate: 0.40
pm_strategic_alignment: 0.70
pm_technical_risk: 0.30
pm_dependency_depth: 0.20
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-549 (deep triage)

## Demand Assessment

Stakeholder: same lineage as FEAT-543 — the consolidation pipeline's own
documented exposure, issue #190 ("334 consolidation-auto corrections with no
quality signal"). FEAT-543 (done, P1, this session) built the eval
scoreboard for the >=0.92 auto-merge band; FEAT-549 extends the same
underlying concern to the 0.85-0.92 PROPOSE band, where pairs "pile up as
pending proposals" today with no resolution mechanism beyond manual review.
Current workaround: proposals sit pending indefinitely, or a human resolves
them manually via `resolve_consolidation_proposal`/`resolve_consolidation_proposals_batch`
(both confirmed as existing MCP tools). Frequency: continuous, every
consolidation pass that produces a propose-band pair. This is real,
evidenced demand, one step removed in urgency from FEAT-543 (which addressed
the already-auto-merged, unaudited band; this FEAT addresses the
still-pending, not-yet-acted-on band — lower urgency because nothing has
been silently lost yet, only queued).

## Scope Challenge

Smallest deliverable: exactly AC-1/AC-2 (batched judge call over pending
proposals, capped, fail-open, default off) plus AC-3 (extend FEAT-543's
eval with a judge-enabled variant) — AC-4 (provenance recording) is small
and already has a template to copy (`ContradictionMetadata`/
`metadata_json`, confirmed present on `ConsolidationProposal` per
`src/consolidate/proposals.ts`, added for the contradiction-judge's own
provenance in PR #373-era work). What I would cut first if forced to halve:
none of the 4 — this FEAT is already minimal (reuses two shipped
subsystems' shapes verbatim). Overlap check: distinct from FEAT-543 (that
FEAT is a read-only EVAL harness measuring the auto-merge band; this FEAT is
a live RESOLUTION mechanism for the propose band) and distinct from
`contradiction-judge.ts` (that judges atom-pair CONTRADICTIONS; this FEAT
judges atom-pair DUPLICATION) — no duplication, but the implementation
should mirror `contradiction-judge.ts`'s exact shape (`CONTRADICTION_JUDGE_MARKER`-
style stable prompt marker, `JudgeVerdict`/`JudgeableAtom` interfaces,
`maxPerRun`/`maxWallClockMs` caps) rather than reinventing a parallel
pattern. AC quality: the 4 existing ACs are concrete; formalized below
citing the real threshold constants (`mergeThreshold` default 0.92,
`proposeThreshold` default 0.85, `NEAR_MERGE_THRESHOLD_MIN` = 0.90, all
confirmed in `src/consolidate/consolidate.ts`).

## Risk Radar

Technical unknowns: none — mirrors `contradiction-judge.ts`'s exact
fail-open/cap/provider-override shape, a proven, shipped repo pattern.
Dependency chain: `depends_on: [FEAT-543]`, confirmed satisfied — FEAT-543
is in `.claude/artifacts/loop/backlog/done/FEAT-543.md` as of this session,
its `tests/eval/consolidation-eval.test.ts` scoreboard exists and is real
(not aspirational — grade SLICE-437 confirms 8/8 ACs evidenced). The
dependency is resolved, not blocking; scored as a real but satisfied
coupling rather than an open one. Blast radius: one new call site over the
existing `ConsolidationProposal` proposal queue + one config block + an
extension to `tests/eval/consolidation-eval.test.ts` — bounded, reuses
existing tables (`metadata_json` already nullable-JSON, no migration).
Failure modes: logic error (judge over-resolves a distinct-fact pair as
same-fact-merge — exactly the false-merge risk FEAT-543's eval weights at
5, the highest weight) — this is the one real risk worth naming explicitly:
a badly-calibrated judge on the PROPOSE band could make things WORSE than
today's do-nothing-and-queue behavior, which is why AC-3's before/after
weighted-error comparison is a hard gate, not just informative.

Grade history: reliability weak (avg 0.425) — fail-open on judge-down
(proposals stay pending, today's behavior) must be regression-tested, not
just asserted in prose.

Pre-mortem: not mandatory (technical_risk 0.30 < 0.6, priority P2).

Injection-defense: scanned FEAT-549's body and triage_notes — no embedded
imperative found.

## Scores

- customer_impact: 0.60 — same evidence lineage as FEAT-543 (issue #190),
  but narrower/lower-urgency band (pending proposals, not already-executed
  unaudited merges) and no default enablement.
- effort_estimate: 0.40 — "similar to SLICE-437 (FEAT-543 eval, $13.83,
  single session) plus reuse of contradiction-judge.ts's exact shape —
  effort 0.40 (5 pts) confirmed; this FEAT has the LOWEST net-new-pattern
  surface of the six/seven in this batch given the double reuse."
- strategic_alignment: 0.70 — directly continues the FEAT-543/482
  data-loss-prevention + local-clerk-model lineage.
- technical_risk: 0.30 — copies an established repo pattern
  (contradiction-judge shape) verbatim to a new call site, no schema
  change beyond an already-nullable metadata column, clean rollback.
- dependency_depth: 0.20 — one formally declared dependency, confirmed
  satisfied (FEAT-543 done); scored above the P2 floor to acknowledge the
  eval-extension coupling (AC-3 requires FEAT-543's file specifically, not
  a generic eval).

## Priority Derivation

composite_priority: P2. P1 requires impact>=0.7 (0.60 fails narrowly).
effort_points via the 0.4-0.6→5 band: **5 points** — no `proposedSlices`
required. autonomous_safe: risk 0.30, effort 0.40, dependency_depth 0.20 all
<=0.6; ACs drafted inline (--deep) → **true**.

## Apply — frontmatter patch for FEAT-549.md

```yaml
priority: P2
autonomous_safe: true
updated: 2026-07-18
triage_notes: |
  Filed 2026-07-18. 2026-07-18 phi-role analysis; scoreboard = FEAT-543's
  consolidation eval (confirmed done, tests/eval/consolidation-eval.test.ts
  real per grade SLICE-437).
  ---
  2026-07-18 PM deep triage: P2, autonomous_safe=true. customer_impact 0.60
  (same issue-#190 lineage as FEAT-543, narrower propose-band scope), effort
  0.40 (5 pts, analog SLICE-437 + contradiction-judge.ts pattern reuse),
  strategic_alignment 0.70, technical_risk 0.30 (verbatim reuse of
  contradiction-judge.ts's fail-open/cap shape, no schema change),
  dependency_depth 0.20 (depends_on FEAT-543, CONFIRMED satisfied/done).
  Recommended build order: after FEAT-551/547 (P1s); can run in parallel
  with FEAT-548/546 (no shared surface).
```

## Apply — body section replacement for FEAT-549.md

```markdown
## Acceptance criteria (Given-When-Then)

- AC-1: Given pending `ConsolidationProposal` rows with `similarity` in the
  propose band `[proposeThreshold, mergeThreshold)` (default `[0.85, 0.92)`,
  the exact band `consolidate.ts` documents as containing distinct facts at
  its upper edge), When the dup-judge call runs in a batch over those
  proposals, Then it returns one of `same-fact-merge | distinct-keep-separate
  | unclear-leave-pending` per proposal; Given the judge provider throws,
  times out, or returns an unparsable response, Then every proposal in the
  affected batch remains `pending` (today's exact behavior) — fail-open
  mirrors `contradiction-judge.ts`'s posture exactly, proven by a test that
  forces the provider to throw and asserts proposal status is unchanged.
- AC-2: Given `consolidation.dupJudge.mode: 'off'` (the shipped default),
  When consolidation runs, Then no dup-judge call is ever made and pending
  proposals behave byte-identically to pre-FEAT-549; Given `mode: 'dry-run'`,
  When the judge produces a verdict, Then it is logged (structured,
  proposal id + verdict + confidence) but NO proposal status changes; Given
  `mode: 'enabled'`, When a high-confidence `same-fact-merge` or
  `distinct-keep-separate` verdict is produced, Then the proposal is
  auto-resolved accordingly (both directions — `same-fact-merge` executes
  the existing non-destructive merge-as-supersede path, `distinct-keep-
  separate` marks it resolved without merging); Given `unclear-leave-
  pending` or low confidence, Then the proposal is left `pending`
  unchanged.
- AC-3: Given `tests/eval/consolidation-eval.test.ts` (FEAT-543's shipped
  scoreboard), When a judge-enabled variant run is added alongside the
  existing no-judge baseline run, Then it reports the false-merge (weight 5)
  and missed-merge (weight 1) delta between the two runs on the SAME
  15-fixture gold set, and the enablement criterion is documented in the
  test's own output: no false-merge regressions AND net weighted-error
  improvement — this comparison is the hard gate any future `mode: 'enabled'`
  default-flip FEAT must cite, not a one-time measurement that goes stale.
- AC-4: Given a proposal resolved by the dup-judge (either direction), When
  its `metadata_json` is inspected, Then it records resolver provenance
  (`resolved_by: 'dup-judge'`, the verdict, confidence, and model/provider
  used) in the same additive-JSON-column shape `ContradictionMetadata`
  already establishes for the contradiction-judge path — auditable, and
  distinguishable from a human-resolved proposal (`resolve_consolidation_proposal`)
  in the same query.

## Options considered

- Apply the dup-judge to the >=0.92 auto-merge band too (closing issue #190
  fully in one FEAT) — rejected, explicitly out of scope: "the >=0.92
  auto-merge path is untouched this FEAT (its audit = FEAT-543 eval data)";
  auditing that band is a separate, higher-stakes FEAT once FEAT-543's
  measured baseline exists to compare against.
- Reimplement a bespoke prompt/schema for the dup-judge instead of mirroring
  `contradiction-judge.ts` — rejected: the two judges solve structurally
  identical problems (batched pairwise semantic verdict, fail-open, capped)
  and diverging patterns for no reason increases maintenance surface for
  zero benefit.
- Default-enable immediately given FEAT-543's eval already exists — rejected,
  explicitly out of scope: "No default enablement (off until the 543-eval
  shows weighted-error improvement)" — AC-3 produces that evidence, it does
  not substitute for the actual enablement decision.
```
