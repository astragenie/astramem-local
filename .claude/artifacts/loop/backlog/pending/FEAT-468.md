---
id: FEAT-468
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: .claude/artifacts/crew/reviews/20260710T130230Z-review-result-slice-421-feat-463-quoted-labels.md (final re-review, orthogonal finding)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:security", "surface:daemon", "stack:typescript"]
---
## Description

**Entropy detector numeric-secret blind spot (pre-existing)** — Shannon
entropy over a 10-symbol numeric alphabet caps at ~3.32 bits/char (uniform),
below the 4.0 detection threshold, so digit-only or digit-heavy secrets
(e.g. legacy/numeric API tokens) are structurally invisible to the
high-entropy stage regardless of length. Proven during the FEAT-463 final
review: a bare unlabeled 26-digit string scores 3.295 and leaks; identical
behavior with or without labels/decoys — independent of the FEAT-463 guard
logic, predates it entirely.

Practical exposure is narrowed by the pattern detectors (a numeric secret
with a recognizable label like `TOKEN=1234...` IS caught), so the gap is
unlabeled numeric secrets only.

### Scope

- Consider per-alphabet thresholds (normalize entropy by alphabet-class
  ceiling: digits-only, hex, base32, base62) or a digit-run length heuristic
  (N+ consecutive digits with no separators → candidate).
- False-positive risk is the hard part: phone numbers, timestamps, IDs,
  numeric data tables — must stay unredacted. Needs a corpus-driven fixture
  set before any threshold change.
- One-line doc comment in src/redact/entropy.ts acknowledging the ceiling
  (cheap, immediate; can ship independently).

### Non-goals

- Not part of FEAT-463 (shipped with this documented limitation).
