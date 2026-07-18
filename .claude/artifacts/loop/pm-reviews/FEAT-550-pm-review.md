---
id: PM-REVIEW-FEAT-550
feature: FEAT-550
reviewed_at: 2026-07-18
pm_customer_impact: 0.45
pm_effort_estimate: 0.40
pm_strategic_alignment: 0.50
pm_technical_risk: 0.40
pm_dependency_depth: 0.15
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-550 (deep triage)

## Demand Assessment

Stakeholder: the repo's own retrieval-quality investigation, evidenced by
the operator's briefing: "rank-miss bucket (13% of LoCoMo misses)." That is
real, measured evidence — but this session's own recall memory
(`locomo-recall-vs-extraction-measured.md`, `locomo-is-an-extraction-benchmark.md`)
is directly on point and gives a countervailing signal: "not-in-db=55%
(EXTRACTION dominant), rank-miss=13% (recall ranking small)... invest
extraction not ranking" and "rerank-mock BACKFIRE." FEAT-550 is explicitly
NOT a rerank (it stays on the query side, fenced from result re-ordering),
so it avoids the specific mechanism that backfired — but it still targets
the smaller of the two measured buckets (13% vs the 55% FEAT-551 targets),
and the repo's own prior guidance is to prioritize extraction levers over
recall levers. Current workaround: none — queries run as typed today, no
alias/synonym/decomposition expansion. Frequency: continuous, every recall
call, though the specific rank-miss failure mode (phrasing mismatch between
query and stored atom text) is presumably a minority of even the 13% bucket.

## Scope Challenge

Smallest deliverable: exactly AC-1/AC-2 (rewrite behind config, fail-open
with original query always in the union) — AC-3 (fusion by atom id) is
required for AC-1 to be meaningful (a rewrite with no fusion strategy is
incomplete), so it is not separately cuttable. What I would cut first if
forced to halve: the "decompositions" sub-case ("when did X move?" → also
"X new apartment date") is the most speculative/hardest-to-get-right rewrite
class; alias/synonym expansion is the safer, more mechanical starting
subset. Overlap check: distinct from FEAT-547/549 (both post-storage
quality levers) and explicitly fenced from reranking (the FEAT body reasserts
this three times — description, out-of-scope, and the triage_notes'
"CAUTION... rerank-mock BACKFIRED... rewrite expands retrieval INPUT, it
must not re-order results"); no duplication risk once the fusion rule
(max-score-by-atom-id, no new ranking model) is enforced as a hard AC, not
just a design note. AC quality: the 4 existing ACs are concrete; formalized
below with the real `search()` signature
(`search(query, filters, limit, opts)`, confirmed in `src/search/search.ts`)
so the builder has a citation for the call site the union/fusion logic
wraps.

## Risk Radar

Technical unknowns: none new (uses an existing local-model provider
pattern), but this is the only FEAT in the 2026-07-18 batch that touches the
**interactive, latency-sensitive** recall hot path directly (the FEAT body
itself names this: "needs a latency gate for interactive use"). Dependency
chain: `depends_on: []`, genuinely independent of the other five/six FEATs
in this batch — no type-quality or eval-scoreboard coupling. Blast radius:
`search.ts`'s `search()` entrypoint (one additional pre-call step) + one
config block + fusion logic — small in file count, but the ONE path here
that is user-facing-latency-sensitive rather than background/batch, which is
why technical_risk is banded slightly above the other five P2 FEATs in this
batch despite similar file-count scope. Failure modes: timeout/latency
regression on the interactive path if the "tight, ~1-2s cap" is not
actually enforced with a hard timeout (not just a soft target) — this is the
one failure mode worth naming explicitly, since a query-rewrite call that
occasionally hangs would degrade EVERY recall call's perceived latency, not
just the anomaly/quota-saver FEATs' background jobs.

Grade history: reliability weak (avg 0.425) — the fail-open + tight-timeout
contract (AC-2) is exactly the kind of behavior that must be regression-
tested with an actual induced-timeout test, not just documented as a design
intent.

Pre-mortem: not mandatory (technical_risk 0.40 < 0.6, priority P2).

Injection-defense: scanned FEAT-550's body and triage_notes — no embedded
imperative found.

## Scores

- customer_impact: 0.45 — real, measured bucket (13% rank-miss) but the
  smaller of the two measured LoCoMo loss buckets, and this repo's own
  prior lesson explicitly deprioritizes ranking/recall-side investment
  relative to extraction-side investment for this exact benchmark.
- effort_estimate: 0.40 — "similar to SLICE-437/438/439 (2026-07-18,
  $10.75-$13.83, single session): bounded config-gate + fusion-logic + A/B
  harness reuse (existing `--diagnose` tooling) — effort 0.40 (5 pts)
  confirmed."
- strategic_alignment: 0.50 — fits the "local model = clerk" design rule,
  but the repo's own measured guidance ("invest extraction not ranking")
  tempers how central this is to the current roadmap relative to the other
  five FEATs in this batch.
- technical_risk: 0.40 — banded at the top of the low-risk range because
  this is the one FEAT touching the interactive/latency-sensitive recall
  path directly, rather than a background/batch job; still no schema
  change, no new external dependency, clean rollback via config flip.
- dependency_depth: 0.15 — genuinely independent.

## Priority Derivation

composite_priority: P2. P1 requires impact>=0.7 AND alignment>=0.6 (both
fail here: 0.45 and 0.50). effort_points via the 0.4-0.6→5 band: **5
points** — no `proposedSlices` required. autonomous_safe: risk 0.40, effort
0.40, dependency_depth 0.15 all <=0.6; ACs drafted inline (--deep) →
**true**.

## Apply — frontmatter patch for FEAT-550.md

```yaml
priority: P2
autonomous_safe: true
updated: 2026-07-18
triage_notes: |
  Filed 2026-07-18. 2026-07-18 phi-role analysis.
  ---
  2026-07-18 PM deep triage: P2, autonomous_safe=true. customer_impact 0.45
  (real but smaller measured bucket — 13% rank-miss vs FEAT-551's 55%
  not-in-db; repo's own locomo-recall-vs-extraction-measured lesson
  deprioritizes ranking-side work), effort 0.40 (5 pts, analog SLICE-437/
  438/439), strategic_alignment 0.50, technical_risk 0.40 (only FEAT in this
  batch touching the interactive/latency-sensitive recall path directly —
  banded at the top of the low-risk range for that reason), dependency_depth
  0.15 (genuinely independent). Recommended build order: lowest strategic
  urgency of the seven in this 2026-07-18 batch — build last, after the
  extraction-side levers (FEAT-551/547) and the other independent P2s.
```

## Apply — body section replacement for FEAT-550.md

```markdown
## Acceptance criteria (Given-When-Then)

- AC-1: Given `search.queryRewrite.mode: 'off'` (the shipped default), When
  `search(query, filters, limit, opts)` (`src/search/search.ts`) is called,
  Then no rewrite call is made and behavior is byte-identical to
  pre-FEAT-550; Given `mode: 'enabled'` and a caller passes `expand: true`
  (or the feature is invoked via its own opt-in path, per the FEAT's latency
  gating requirement), When the rewrite call succeeds, Then it produces at
  most `maxVariants` alias/synonym/decomposition query strings.
- AC-2: Given the rewrite call throws, times out, or exceeds a hard ~1-2s
  cap (a real enforced timeout, not a soft target), When `search()` proceeds,
  Then retrieval runs over the ORIGINAL query only — degrading exactly to
  pre-FEAT-550 behavior — and a test that forces the rewrite provider to
  hang past the cap asserts the search call still returns within a bounded
  total time and uses only the original query's hits.
- AC-3: Given the original query and N rewritten variants each produce their
  own hit set, When results are fused, Then hits are merged by atom id
  keeping the MAX score across all variant hit sets (no new ranking model,
  no re-ordering within a single variant's own result list), and the fused
  candidate set is capped at a configured total (bounding cost) — the
  original query's hits are ALWAYS included in the union even when a
  rewrite variant returns zero hits.
- AC-4: Given the LoCoMo `--diagnose` harness (existing tooling), When an
  A/B run compares query-rewrite-enabled vs baseline, Then the rank-miss
  bucket size is reported before/after AND the ADR-005 recall@10/NDCG@10
  floors (>=0.9 / >=0.7) are asserted to hold or improve — a regression on
  either floor is a hard stop on enablement, documented in the run's own
  evidence artifact, not just narrated.
- AC-5: Given `mode: 'enabled'` but no rewrite variants clear a minimum
  relevance bar (e.g. the local model returns an empty or degenerate
  rewrite), When `search()` runs, Then it falls back to the original-query-
  only path silently (not an error) — this is the same fail-open contract
  as AC-2 but for the "succeeded but useless" case rather than the "failed"
  case, closing a gap the existing 4 ACs left implicit.

## Options considered

- Feed rewrite variants into a reranking pass instead of a pure-union fusion
  — rejected, explicitly out of scope and directly contraindicated by this
  session's own measurement: "rerank-mock BACKFIRED
  (locomo-recall-vs-extraction-measured)" — conflating rewrite (input
  expansion) with rerank (output re-ordering) would reintroduce the exact
  failure mode this FEAT is designed to avoid.
- Default `mode: 'enabled'` for all interactive recall calls — rejected,
  explicitly out of scope: "No default-on for interactive recall until
  latency measured"; the AC-2/AC-5 fail-open contracts exist precisely
  because a synchronous local-model call on the hot path is a real latency
  risk until proven otherwise.
- Skip the `--diagnose` A/B and ship on code-review confidence alone —
  rejected: this repo's own measured history (rerank-mock backfiring
  despite looking reasonable) is the direct precedent for why AC-4's
  measured gate is required before enablement, not optional.
```
