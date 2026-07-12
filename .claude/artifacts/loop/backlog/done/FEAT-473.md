---
id: FEAT-473
status: done
priority: P2
category: bug
target_release: v0.15.0
created: 2026-07-10
updated: 2026-07-12
depends_on: []
slices: []
derived_from: FEAT-463 review LOW finding #2 (2026-07-10)
cross_product: [astramem-local]
tags: ["concern:security", "stack:typescript", "surface:daemon"]
pm_customer_impact: 0.4
pm_effort_estimate: 0.3
pm_strategic_alignment: 0.55
pm_technical_risk: 0.25
pm_dependency_depth: 0.45
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-12
autonomous_safe: false
composite_score: 0.5475
triage_notes: "P2 via formula: impact 0.4<0.7 so the first P1 branch doesn't fire; alignment 0.55<0.8 so the second P1 branch doesn't fire; effort 0.3<0.7 so P3 doesn't fire either even with below-median impact. composite_score = 0.4*0.35 + 0.55*0.30 + (1-0.3)*0.20 + (1-0.25)*0.10 + (1-0.45)*0.05 = 0.5475. customer_impact 0.4: disclosed as an out-of-scope LOW finding in the FEAT-463 review — narrow real-world exposure (only SHORT secrets in smart-quoted JSON leak; long secrets are still caught by entropy regardless of quote style). strategic_alignment 0.55: closes a known, already-documented gap in the redaction stack, moderate but not a strategic bet on its own. technical_risk banded low (0.25), the lowest of the three FEAT-470-adjacent items: the Scope frames this as a character-class addition only (extend QUOTED_LABEL detectors with U+2018/2019/201C/201D), ReDoS surface unchanged by construction, and the redact-perf 20ms p95 budget is a known, already-instrumented gate. effort scored low (0.3): narrow, mechanical, with the fixture pattern (expectedEventCount) already established elsewhere in the redaction test suite. dependency_depth scored 0.45 (lowest of the three): depends_on is empty and this FEAT touches the QUOTED_LABEL detector family rather than entropy.ts/keystore.ts directly, but the coordinator's context still places it in the FEAT-470 chain, so a soft blocker is assumed pending confirmation. autonomous_safe=false: forced by the same FEAT-470 chain blocker as FEAT-468/472 (no ACs drafted this pass is secondary) — of the three, this is the fastest to flip true once FEAT-470 merges, given how contained and mechanical the fix is (all three individual thresholds sit well under the 0.6 ceiling: risk 0.25, effort 0.3, dependency 0.45)."
---
## Description

**Stage-0 redaction: unicode smart-quote label forms** — curly/smart quotes
(“ ” ‘ ’) around credential labels are not recognized by the
generic_credential_quoted detectors, so a SHORT secret in smart-quoted JSON
(e.g. pasted from a chat client or word processor that auto-curls quotes)
leaks in full; long ones are still caught by entropy. Disclosed as
out-of-scope in the FEAT-463 review.

### Scope

- Extend QUOTED_LABEL detectors' quote classes with the common unicode pairs
  (U+2018/2019, U+201C/201D), matching mixed straight/curly combinations.
- Fixtures: smart-quoted positive shapes + benign smart-quoted config
  negatives; event-count assertions (expectedEventCount pattern).
- ReDoS check unchanged (character-class addition only).
- Perf: stay within redact-perf 20ms p95 budget.

## Completion (2026-07-12)

Shipped in **v0.15.0** via PR #157 (commit `5d0d8e8` — "fix(FEAT-473):
recognize Unicode smart/curly quotes in credential labels").

Landed signature: `ANY_QUOTE_CHAR` in `src/redact/detectors.ts:60` —
`["'‘’“”]`, consumed by `QUOTED_LABEL_SEP` (line 105) and the
`generic_credential_quoted` detector family (lines 224–274). Character-class
addition only, as scoped; ReDoS surface unchanged.

Closed via housekeeping, not the slice ceremony: the fix was implemented and
merged directly through PR #157 during the v0.15.0 release session and never
had a slice file, so `/runner:slice complete` had nothing to close. The
backlog file was left stranded in `triaged/`. Verified already-landed before
closing — NOT re-implemented.
