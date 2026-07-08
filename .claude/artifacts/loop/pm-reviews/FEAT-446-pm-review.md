---
id: PM-REVIEW-FEAT-446
feature: FEAT-446
reviewed_at: 2026-07-08
pm_customer_impact: 0.35
pm_effort_estimate: 0.7
pm_strategic_alignment: 0.4
pm_technical_risk: 0.85
pm_dependency_depth: 0.5
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-446

## Demand Assessment

- **Evidence:** No direct end-user complaint (SDK has never been tagged/published, so there is no existing SDK consumer to be underserved today). Evidence is a prospective-risk finding, quoted directly from docs/research/2026-07-08-astramem-ecosystem-report.md line 112 ('SaaS audit finding C'): 'SDKs: real code + real publish CI (sdk-publish.yml on sdk-v* tags) but no tag ever pushed — and TS SDK wraps only 4 methods (create/search/get/delete) vs the API.' The risk is prospective/reputational (a 4-method tag today would understate the platform's real surface to future adopters), not an active blocked user.

## Scope Challenge

- **Scope notes:** STRUCTURAL FLAG (read before triage): this FEAT's entire execution surface — astramem-sdk (TypeScript), astramem-py, the sdk-publish.yml CI, and the @astragenie/astramem-client package it must align with — lives in the sibling `memory` repo, not astramemory-local. This repo's `/runner:slice from-feature` cannot act on it at all regardless of scoring; I recommend an operator re-file this as a FEAT/issue in the `memory` repo's own backlog and let that repo's own PM triage size it, since I have no code-level visibility into that repo's SDK source, contracts alignment state, or team capacity from here. SECOND DISAGREEMENT WITH SUPPLIED FRAMING: two independent docs place this later than 'Month 3' the way the operator's brief buckets all five FEATs. docs/research/2026-07-08-astramem-ecosystem-report.md line 161 places it under 'Month 6 — convergence': 'grow the SDKs past 4 methods before any sdk-v* tag.' docs/research/2026-07-08-tri-repo-plan.md line 88 lists it as item 5 under an explicit 'Later' tier, and line 77 states plainly: 'Cut from the week (unchanged from report): CI runners for Win/macOS, SDK work, sync completion...' — SDK work is explicitly named as cut from the current sprint in both docs I read. I've scored strategic_alignment at 0.40 (lower than FEAT-442/444's Month-3 items) to reflect this. FEAT-168 DECOMPOSITION GATE — TOOLING CONSTRAINT FOUND: pm_effort_estimate 0.70 maps to effort_points=8 (band [0.6,0.85)), tripping the gate. Framework 6's option 2 (set composite_priority=needs-review when a FEAT resists decomposition) is the honest answer here — I lack the cross-repo visibility to responsibly propose a slice split for code I have not read. However, I read the actual validation source for this runner version (C:/Users/serge/.claude/plugins/cache/astra/runner/0.61.0/src/scripts/lib/pm-apply.mts, `VALID_PRIORITIES = new Set(["P0","P1","P2","P3","P4"])`) and confirmed 'needs-review' is NOT an accepted value — an entry submitting it would fail validation and write NOTHING (a worse outcome than submitting P2 with this flag attached). I am therefore submitting compositePriority=P2 (the formula's own output) WITHOUT proposed_slices, and explicitly flagging that this FEAT needs human decomposition (or an explicit priority downgrade) before slicing — this is a real gap in the current triage tooling that the operator should be aware of, not a silent workaround. Effort calibration (Framework 5): no cost analog exists in this repo's .claude/artifacts/crew/cost/ for cross-repo SDK work; the scope itself (full CRUD+search+entities+decisions+session-digest surface, mirrored to a second language, aligned against an existing client package, culminating in a first-ever public release) is comparable to or larger than FEAT-443's decomposed 8/5-point split, justifying 0.70. Weak grade dimensions (loop-snapshot.md) are this-repo grades and do not transfer meaningfully to sibling-repo work; I am naming them for completeness per Framework 4 (architecture_quality 0.53, observability 0.68, production_readiness 0.53, security 0.52, product_completeness 0.55, all below 0.80) but they should not be read as evidence about the `memory` repo's own quality bar.

## Scores

- customer_impact: 0.35
- effort_estimate: 0.70
- strategic_alignment: 0.40
- technical_risk: 0.85
- dependency_depth: 0.50

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: P2 via formula: impact 0.35 and alignment 0.40 are both below the P1 thresholds; effort 0.70 >= 0.70 satisfies half of the P3 condition but impact 0.35 is NOT <= 0.30 (a genuine near-miss on real numbers, not adjusted), so P3 doesn't fire either — lands P2 by default. composite_score=0.3425 (lowest of the five FEATs). technical_risk banded at 0.85 (top rubric band: 'Public/cross-plugin contract change... published artifact, hard-to-reverse effects') because the FEAT's own final step is cutting the first-ever sdk-v1 tag — an irreversible public action, independent of how well-tested the code underneath is. dependency_depth=0.50 reflects cross-repo execution plus coordination with the still-unresolved contracts/pgvector-vs-Qdrant convergence work named in tri-repo-plan.md. pm_effort_points=8 trips the FEAT-168 gate; I am NOT supplying proposed_slices (lack of cross-repo code visibility to responsibly decompose) and NOT setting composite_priority=needs-review (confirmed rejected by this runner version's VALID_PRIORITIES set) — submitting P2 with this gate-violation explicitly flagged in scopeNotes is the least-bad option among the three, and I am surfacing it rather than silently resolving it either direction. autonomous_safe=false is forced by technical_risk=0.85 > 0.6 alone (mechanical trigger, independent of the missing-AC rule), on top of being cross-repo work this loop cannot execute regardless.

## Risks

- Pre-mortem Q1 (two weeks later, review/validation failure — MANDATORY, technical_risk >= 0.6): most likely cause is publishing sdk-v1 with a surface that doesn't actually match @astragenie/astramem-client's daemon-compatible subset in practice — the alignment claim ('one SDK story covers both baseURLs') is exactly the kind of cross-package contract assumption that looks right in a design doc and diverges in the implementation details (auth header shape, error envelope shape, pagination) discovered only after real consumers hit both baseURLs.
- Pre-mortem Q2 (rollback after a bad merge — MANDATORY): the CODE can be reverted with a plain git revert in the `memory` repo, but the PUBLISHED ARTIFACT cannot be meaningfully un-published — once `sdk-v1` is tagged and npm-published, semver and existing installs mean a 'wrong first surface' mistake persists for every consumer who already installed it; the only real fix is a fast-follow sdk-v1.x/v2 release, not a rollback. This is exactly the rubric's 0.9-1.0 trigger ('published artifact, hard-to-reverse effects'), which is why technical_risk is banded at 0.85 rather than the 0.6-0.8 band.
- Pre-mortem Q3 (existing test that would NOT catch a regression — MANDATORY): I have no visibility into the `memory` repo's test suite from this repo, so I cannot name a specific existing test with confidence — flagging this itself as a gap: whoever triages this in the `memory` repo must identify what currently tests sdk-publish.yml / the SDK's own test suite (if any) before treating this as ready to build, since I cannot certify test coverage for code I have not read.
- Contracts-SoT dependency: docs/research/2026-07-08-tri-repo-plan.md line 88 lists 'pgvector-vs-Qdrant decision' as still undecided and separately un-merged 'contracts 1.2.0 publish' work — an SDK surface aligned today against an unsettled contracts baseline risks needing rework once that convergence work lands, contributing to the dependency_depth=0.50 score.
