---
id: FEAT-473
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: FEAT-463 review LOW finding #2 (2026-07-10)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:security", "stack:typescript", "surface:daemon"]
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
