# Task Handoff: LoCoMo 0.70 research doc — statistical/methodology audit

- Created: 2026-07-20T00:31:54.414Z
- From: performance-engineer
- To: dispatcher
- Objective: Audit verdict: §6 weighted arithmetic is mechanically SOUND (correctly uses n-weighted overall_accuracy basis throughout); but every input feeding it is UNDERPOWERED or STALE. All day-to-day deltas cited (overall, single-hop, temporal, multi-hop) are statistically indistinguishable from zero (z<0.3). Overall-level MDE at current n=199 unpaired protocol is ~14pts — larger than the plan's own targeted ~11pt gain, meaning the campaign could hit its target and the current protocol would still have <80% odds of confirming it. Only the temporal 0.13->0.68 jump is a trustworthy large effect. Retrieval +7.86 ceiling is stale (computed on a superseded pre-fix pipeline/dataset). conv-1 (n=199) is 1 of ~10 conversation clusters -- effective n for full-suite generalization may be ~1, not 199, the largest unresolved risk in the doc.
- Allowed Scope:
  - Read-only numbers audit of docs/research/20260719-locomo-0.70-research-for-cross-review.md plus raw run data: docs/eval-runs/20260719-chunkab-800tok/metrics.json
  - docs/eval-runs/20260718-control-codex-solo/metrics.json
  - docs/eval-runs/BASELINE-CONSTANTS.md
  - docs/research/20260714-locomo-hypothesis-ledger.md. Recomputed overall_accuracy and category_averaged_accuracy independently from per-category (accuracy
  - n) pairs; recomputed §6 category-lift arithmetic; computed binomial-approximation 95% CIs per category; computed minimum-detectable-effect (MDE) at 80% power/alpha=0.05 for overall and per-category; z-scored every day-to-day delta cited against its own noise SE.
- Forbidden Scope: -
- Deliverable: Findings table (9 rows) with evidence tags (measured/static/hypothesis), severity, confidence, and suggested verification per finding; corrected/verified §6 arithmetic; MDE-based minimum measurement protocol (archive per-question raw scores, >=3 runs/config same-day, prefer paired designs, run >=1 additional conversation before trusting conv-1 tuning, re-measure the +7.86 ceiling on current recipe, per-category n thresholds for 80% power). Full numbers-first verdict delivered inline in final response (no separate report file written per role contract).
- Changed Files:
  - docs/research/20260719-locomo-0.70-research-for-cross-review.md
  - docs/eval-runs/20260719-chunkab-800tok/metrics.json
  - docs/eval-runs/20260718-control-codex-solo/metrics.json
  - docs/eval-runs/BASELINE-CONSTANTS.md
  - docs/research/20260714-locomo-hypothesis-ledger.md
- Confidence: high
- Risks: blocking_risk on treating any single-day category delta or the +7.86 retrieval ceiling as decision-grade evidence; conv-1-to-full-suite generalization is unquantifiable from provided artifacts (cluster-sampling problem, effective n~1 conversation) and is the largest open risk gating the whole 0.70 campaign
- Suggested Next Handoff: Before committing multi-week effort to Tracks A-E: (1) extend archive-run.mts to persist per-question raw scores, (2) rerun the chunk-800-vs-3200 A/B >=3x same-day per the extraction-bench's own existing --runs-3 rule, (3) run >=1 additional LoCoMo conversation under the current recipe to get a first real cross-conversation data point, (4) re-measure the rank-ok/not-in-db/rank-miss retrieval ceiling on the current codex/conv-1 recipe before citing +7.86 again

