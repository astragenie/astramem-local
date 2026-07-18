---
id: FEAT-546
status: pending
priority: P2
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: []
slices: []
derived_from: operator request 2026-07-18 (mid model-sweep session)
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
  Filed 2026-07-18 per operator, mid model-sweep session.
  ---
  2026-07-18 PM deep triage: P2, autonomous_safe=true. customer_impact 0.55
  (generalizes the repo's own proven canary-must-measure-rate fix — see
  entity-extraction 87%-broken-for-weeks precedent), effort 0.45 (5 pts,
  analog: SLICE-437/438/439 single-session bounded eval/test-infra work),
  strategic_alignment 0.60, technical_risk 0.30 (SQL-only, no LLM, no schema
  change), dependency_depth 0.15 (independent; soft coupling to FEAT-547's
  type-quality noted for the type-mix detector specifically — build the
  other 3+ detectors first if sequencing before FEAT-547). Recommended build
  order across the 2026-07-18 batch: after FEAT-547 (for full detector
  accuracy) but the non-type detectors can ship independently.
---
## Description

**Memory-stream anomaly detection.**

Doctor watches system health; nothing watches the *content* stream. Add cheap,
DB-only detectors over rolling windows that flag when the memory stream departs its
learned baseline:

- **Ingest-shape anomalies**: atoms/session collapsing (broken extraction upstream of
  the yield canary), type-mix shift (e.g. decisions vanishing), entity-link rate drop.
- **Contradiction spikes**: corrections/supersedes per window jumping above baseline —
  either the user's world changed or extraction started hallucinating.
- **Duplicate-pressure spikes**: consolidation proposal rate surging (extraction
  suddenly redundant, or an ingest loop).
- **Provenance anomalies**: capture-source mix shifts (a source went silent / a new one
  flooded), sessions with 0 evidence-bearing atoms.
- **Usage anomalies**: recall-served-vs-used rate collapse for a repo that was
  previously healthy (memories going stale or ranking regressing).

Surface: a `memory anomalies` CLI + doctor rows (WARN tier, rate-based with
MEANINGFUL_USAGE_THRESHOLD-style floors), and machine-readable output for the
dashboard. Baselines learned from the install's own trailing window (e.g. 28d median ±
MAD), never hardcoded absolutes — every install's normal differs.

## Explicitly out of scope

- No LLM calls — all detectors are SQL over existing tables/indexes ('cheap' tier
  discipline; index-backed bounded reads only).
- No auto-remediation — detect + surface only.

## Acceptance criteria (Given-When-Then)

- AC-1: Given a seeded 28-day history of ingest sessions in a `:memory:` DB,
  When each of at least 4 detectors runs (ingest-shape/atoms-per-session
  collapse, contradiction/correction-rate spike, duplicate-pressure/
  consolidation-proposal-rate surge, provenance/capture-source-mix shift),
  Then each computes a rate against its own trailing-window baseline
  (28-day median ± MAD, or an equivalent robust-statistic baseline) rather
  than a hardcoded absolute threshold.
- AC-2: Given fewer than a configured minimum number of historical windows
  (a not-enough-data floor, e.g. <7 days of history), When a detector runs,
  Then it reports `inconclusive: true` with the reason ("denominator
  unavailable") rather than fabricating a false-negative "no anomaly" or a
  false-positive alarm off an unstable baseline — mirroring the
  `spool-quarantine.ts` `statsHealthy` pattern already in this repo.
- AC-3: Given the anomaly detectors, When `doctor` runs, Then each detector
  is registered as a `Check` (`src/doctor/types.ts` shape) tagged `tier:
  'cheap'` where the read is index-backed and bounded, or `tier: 'full'`
  otherwise, and When `astramem-local memory anomalies` CLI runs, Then it
  lists every currently-firing anomaly with the numbers behind each (K of N,
  never a bare boolean) plus a structured JSON output mode consumable by the
  dashboard — closing the observability weak dimension (avg 0.325 over the
  last-5 grade snapshot).
- AC-4: Given a seeded history engineered to contain exactly one anomaly
  (e.g. atoms/session dropping from a stable baseline of ~8/session to 1/
  session for the trailing 3 days), When the corresponding detector runs,
  Then it fires; Given a seeded history with normal day-to-day variance
  within the learned MAD tolerance (no true anomaly), When the same detector
  runs, Then it stays silent — both cases asserted in the same unit test
  file so a future change cannot silently widen or narrow the tolerance
  without a visible test diff.
- AC-5: Given a detector fires, When it logs, Then the log entry is
  structured (not prose-only) and includes the detector name, the measured
  rate, the learned baseline, and the deviation magnitude (e.g. in MADs) —
  reliability/observability weak-dimension target (avg 0.425/0.325) —
  ensuring a future dashboard or alert pipeline can consume the signal
  without re-parsing text.

## Options considered

- Hardcode absolute thresholds (e.g. "alarm if atoms/session < 2") instead
  of a learned baseline — rejected: the FEAT's own triage_notes and this
  repo's own lesson (`canary-must-measure-rate-not-existence`) explicitly
  reject existence/fixed-threshold checks; every install's normal differs
  (a low-volume personal install and a high-volume team install have
  different legitimate baselines).
- Add an LLM-based semantic anomaly judge (e.g. "does this session's content
  look unusual?") — rejected: FEAT body explicitly fences this out (SQL-only,
  cheap-tier discipline); would also violate the FEAT-482 metered-call
  caution this session's context repeatedly cites.
- Auto-remediate on a detected anomaly (e.g. auto-pause ingest) — rejected:
  FEAT body explicitly scopes this to detect-and-surface only; auto-
  remediation on an unproven detector risks a worse outage than the anomaly
  itself (a false-positive pause is a self-inflicted incident).
