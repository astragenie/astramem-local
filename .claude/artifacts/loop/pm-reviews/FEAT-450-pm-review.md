---
id: PM-REVIEW-FEAT-450
feature: FEAT-450
reviewed_at: 2026-07-09
pm_customer_impact: 0.3
pm_effort_estimate: 0.42
pm_strategic_alignment: 0.55
pm_technical_risk: 0.15
pm_dependency_depth: 0.1
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-450

## Demand Assessment

- **Evidence:** Internal engineering-velocity evidence, quoted directly from the FEAT body: 'qwen2.5:7b scored 50/53/58/59/61/61/67/72 F1 across runs on near-identical configs (+/-14 swing)... every prompt (v1/v2/v2.1) and temperature (0/0.1) a/b landed inside that band -> indistinguishable from noise.' This blocks the ASTRA_EXTRACT_PROMPT/ASTRA_EXTRACT_TEMP selectors (already shipped per commit 1915521 'Extraction: codex/qwen3 fixes + eval infra') from ever being evaluated -- not a user complaint, an eng-tooling gap.

## Scope Challenge

- **Scope notes:** Effort 0.42 -> 5 points (FEAT-167 table). No close cost analog on file for eval-bench hardening specifically; nearest shape by module count is FEAT-449 (single-module, $72.34/1 session) but FEAT-450 spans more ACs (multi-run averaging + significance gate + fixture expansion 15->40+ + judge stability), so scored above that floor rather than at it. Weak grade dimensions apply as noted on FEAT-447/448 (architecture_quality, observability, production_readiness, security, product_completeness < 0.80 over true last-5 grades) but this FEAT touches only scripts/eval/**, never a served code path, so weak-dimension AC coverage is not load-bearing here. Body already has 5 concrete Given-When-Then ACs with numeric targets (>= 40 fixtures, >= 3 judge samples) -- clears the AC-quality bar without rewrite; not P0/P1 so rewrite isn't triggered anyway.

## Scores

- customer_impact: 0.30
- effort_estimate: 0.42
- strategic_alignment: 0.55
- technical_risk: 0.15
- dependency_depth: 0.10

## Priority Derivation

composite_priority: P2
autonomous_safe: true
reasoning: technical_risk 0.15, band 0.0-0.2 (bench-script-only change under scripts/eval, no production code path, git-revertable, existing --runs 1 default preserved per AC-5). Not urgent (nothing is currently broken in production) but blocks a just-landed capability (prompt/temp selectors) from ever being tunable -- P2, autonomous-safe, matching the FEAT's own pre-existing triage_notes classification.

## Risks

- Expanding the gold fixture set to 40+ requires curating real-work chunks by hand -- if that curation is rushed, the new fixtures could themselves be noisy/mislabeled, defeating the point of the significance gate (AC-2) before it ever runs.
