---
id: FEAT-468
status: triaged
priority: P2
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-12
depends_on: []
slices: []
derived_from: .claude/artifacts/crew/reviews/20260710T130230Z-review-result-slice-421-feat-463-quoted-labels.md (final re-review, orthogonal finding)
cross_product: [astramem-local]
tags: ["concern:security", "surface:daemon", "stack:typescript"]
pm_customer_impact: 0.5
pm_effort_estimate: 0.6
pm_strategic_alignment: 0.65
pm_technical_risk: 0.55
pm_dependency_depth: 0.5
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-12
autonomous_safe: false
composite_score: 0.52
triage_notes: "P2 via formula: impact 0.5<0.7 so the (impact>=0.7 AND alignment>=0.6) P1 branch doesn't fire; alignment 0.65<0.8 so the (alignment>=0.8 AND effort<=0.4) P1 branch doesn't fire either; effort 0.6<0.7 so P3 doesn't fire. composite_score = 0.5*0.35 + 0.65*0.30 + (1-0.6)*0.20 + (1-0.55)*0.10 + (1-0.5)*0.05 = 0.52. customer_impact banded moderate (0.5): a real detection gap (digit-only secrets structurally invisible to the entropy stage), but the FEAT's own text narrows practical exposure to unlabeled numeric secrets only — labeled numeric tokens are already caught by the pattern detectors. strategic_alignment 0.65: redaction correctness is core to this daemon's trust proposition, same territory as FEAT-466. technical_risk banded 0.55: the scope itself flags false-positive risk as 'the hard part' (phone numbers, timestamps, IDs, numeric tables must stay unredacted) — this is genuine threshold-tuning design work needing a corpus-driven fixture set, not a mechanical patch. dependency_depth scored 0.5: depends_on is empty, but this FEAT's fix lives in the same src/redact/entropy.ts chain FEAT-470 needs to land first per the coordinator's context — a real soft blocker not captured by depends_on. autonomous_safe=false: forced by the FEAT-470 chain blocker (entropy.ts not yet mergeable target) plus the FP-risk design work still being open-ended (corpus/threshold choice deferred, no ACs drafted this pass) — not a same-day unattended build even though effort/risk/dependency all individually sit at or under the 0.6 mechanical ceiling. One-line entropy.ts doc-comment acknowledging the ceiling (flagged in Scope as cheap/independent) could ship standalone ahead of the rest if a quick low-risk win is wanted."
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
