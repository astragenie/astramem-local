---
id: PM-REVIEW-FEAT-459
feature: FEAT-459
reviewed_at: 2026-07-10
pm_customer_impact: 0.7
pm_effort_estimate: 0.28
pm_strategic_alignment: 0.85
pm_technical_risk: 0.3
pm_dependency_depth: 0.1
composite_priority: P1
autonomous_safe: true
---
# PM Review — FEAT-459

## Demand Assessment

- **Evidence:** Two measured, pre-existing redaction gaps with committed FAILING-shape tests already on disk at tests/security/redact-autocapture.test.ts (verified by direct read): line ~90-99 'GAP: a SHORTER truncation... falls below the entropy detector's MIN_TOKEN_LENGTH floor... is not redacted by anything' (asserts events.length===0), and line ~156-164 'GAP: INTERNAL_SECRET=<value> is not rescued by anything' (asserts events.length===0, text unchanged). Confirmed against source: src/redact/entropy.ts:10 `const MIN_TOKEN_LENGTH = 20;` and src/redact/detectors.ts:76-80 generic_credential pattern `\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*(\S+)` which requires a \b boundary that does not fire between two word characters (e.g. the '_' before 'SECRET' in INTERNAL_SECRET=), confirming the compound-label miss is real, not hypothetical. Internal stakeholder: the ADR-012 ship-gate owner (docs/specs/FEAT-455-spike-results.md) — stage-0 redaction is the gate's enforcement point, and FEAT-455 hook-tap is currently BUILDING (branch feat/feat-455-hook-tap, worktree feat-455-build, latest commit 'ADR-012 accepted — spike PASS, owner sign-off; hook-tap build unblocked'), so shipping without this hardening widens exposure on a path about to go live.

## Scope Challenge

- **Scope notes:** AC clarity: FEAT body has no formal Given-When-Then ACs (prose scope bullets only) -- vague per the authoring.md checklist, so I am drafting 5 GWT ACs inline per FEAT-277 (compositePriority=P1 triggers the inline-AC gate). Weak grade dimensions (true last-5 grade average, recomputed directly from the 5 most recent files under .claude/artifacts/loop/grades/: 20260704T142054Z-feat421-slice415, 20260707T122259Z-feat438-slice416, 20260707T130414Z-feat438-slice417, 20260709T110626Z-feat441-slice419, 20260709T144335Z-feat449-slice419): architecture_quality 0.51, observability 0.654, production_readiness 0.504, security 0.51, product_completeness 0.504 all below 0.80 (reliability 0.846 and test_confidence 0.854 are NOT weak). Security is directly this FEAT's domain -- AC-1..AC-4 target it head-on. Observability (0.654, weak) is targeted by AC-5 (perf-smoke must log a concrete before/after latency figure, not just pass/fail). Effort calibration: no exact redaction-tuning cost analog on file; nearest shape is FEAT-449 SLICE-419 (single-module spool change, $72.34 / 1 session / 84 msgs, .claude/artifacts/crew/cost/20260709T144324Z-cost-report-slice-feat449-slice419.md) and the FEAT-448 precedent ('regex tightening inside one existing function... effort 0.18 confirmed'). FEAT-459 touches TWO files (detectors.ts regex fix + entropy.ts short-fragment policy) plus a false-positive sweep and a perf-smoke re-run, so scored slightly above the FEAT-448 floor at 0.28 -> 3 effort_points (FEAT-167 band [0.25,0.4)), well under the FEAT-168 8-point decomposition gate -- no proposed_slices needed. technical_risk banded at 0.30 (bottom of the 0.3-0.5 'new pattern in repo OR one module, no contract change, clean rollback' band): tuning EXISTING detectors in an already-isolated module (src/redact/), no new dependency, no schema/contract change, trivially git-revertable; not banded at the lowest 0.0-0.2 tier because a short-fragment threshold override on a security-sensitive hot path carries real false-positive risk if the label-context condition is under-specified. Coordinator's supplied steer (P0/P1, low-friction, empty depends_on) is confirmed by direct evidence, not taken on faith.

## Scores

- customer_impact: 0.70
- effort_estimate: 0.28
- strategic_alignment: 0.85
- technical_risk: 0.30
- dependency_depth: 0.10

## Priority Derivation

composite_priority: P1
autonomous_safe: true
reasoning: P1 via formula: impact 0.70 >= 0.70 AND alignment 0.85 >= 0.60 fires the P1 branch. composite_score = 0.70*0.35 + 0.85*0.30 + (1-0.28)*0.20 + (1-0.30)*0.10 + (1-0.10)*0.05 = 0.759. autonomousSafe=true: all three mechanical thresholds pass (risk 0.30, effort 0.28, dependency 0.10 all <=0.6) and P1 triggers inline AC drafting (acs below) satisfying the hasAcceptanceCriteria gate. Security category + evidenced gaps + low friction + empty depends_on = the coordinator's steer, confirmed by direct code/test verification rather than taken on faith.

## Risks

- Pre-mortem Q1 (review/validation failure cause): the short-fragment threshold override (lowering the effective floor when a label is present) introduces new false positives on legitimate short labeled strings that were previously untouched, and the false-positive sweep the FEAT's own scope calls for is skipped or under-scoped -- reviewer flags a regression against tests/security/redact.test.ts's existing 25+ true/false-positive table.
- Pre-momentum Q2 (rollback mechanics): revert-only. The change is confined to src/redact/detectors.ts + src/redact/entropy.ts + test files, no schema/migration, no cross-plugin coordination -- a plain `git revert` restores prior (leakier) behavior. Caveat: if FEAT-455 hook-tap has shipped by the time this needs reverting, a revert re-opens the ADR-012 ship-gate hole on an already-live capture path, so any revert must be paired with a fast-follow re-fix rather than left open.
- Pre-mortem Q3 (coverage gap): tests/security/redact.test.ts's existing 25+ true/false-positive table predates auto-capture's higher-frequency/partial-turn shapes and would NOT catch a regression specific to those shapes (e.g. a new false-positive on a legitimate short SCREAMING_SNAKE_CASE non-secret env var mid-burst) -- that coverage exists only in tests/security/redact-autocapture.test.ts, which is exactly the file this slice must extend.
- Cascade note: stage-0 redaction sits on every ingest path (transcripts, remember, spool) -- a latency regression here (not just a correctness regression) has broad blast radius across the whole daemon, not just the auto-capture path; the FEAT's own scope correctly calls for a perf-smoke re-run.
- Injection-defense check: FEAT body and linked test file read in full -- no embedded imperative instructions found (e.g. no 'ignore prior scoring rules' or similar); nothing to quote here.
