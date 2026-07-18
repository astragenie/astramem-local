---
id: PM-REVIEW-FEAT-546
feature: FEAT-546
reviewed_at: 2026-07-18
pm_customer_impact: 0.55
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.60
pm_technical_risk: 0.30
pm_dependency_depth: 0.15
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-546 (deep triage)

## Demand Assessment

Stakeholder: the loop/repo's own operational history, cited directly in
frontmatter triage_notes: "Reuse the rate-canary discipline
(canary-must-measure-rate-not-existence)." This is not a hypothetical
principle — the repo's own memory (`canary-must-measure-rate-not-existence.md`)
records "entity extraction was 87% broken for WEEKS behind a green
existence-check; the rate canary is what made the fix provable." That is a
real, prior, paid-for incident this FEAT generalizes the fix for. Current
workaround: none for content/behavior anomalies — doctor watches system
health (LLM probe, DB reachability) but nothing watches whether the memory
*stream itself* silently degrades (a broken extraction model still returns
`{atoms:[]}` cleanly, no exception). Frequency: continuous — every ingest
session is a chance for a silent regression to go undetected until a human
notices retrieval quality dropped.

## Scope Challenge

Smallest deliverable: the ≥4 detectors named in AC-1, each rate-vs-baseline,
each with a not-enough-data floor — SQL-only, no LLM (explicitly fenced).
What I would cut first: provenance anomalies and usage anomalies (recall-
served-vs-used) are the two that most overlap conceptually with existing
signals (fuse's usefulness epsilon, doctor's `spool-quarantine` provenance
work) — ingest-shape and contradiction-spike detectors are the two most
novel and highest-value, so if forced to halve scope those two ship first.
Overlap check: `src/doctor/checks/extraction-yield.ts` (zero-yield rate
canary) and `memory-health.ts` (poison-rate) already exist and are
`tier: 'full'` (24h cadence) per CLAUDE.md's "Known open gaps" section — this
FEAT's ingest-shape/type-mix detectors are adjacent but distinct (rolling
28d baseline vs those checks' fixed-threshold alarms); no duplication, but
the doctor integration (AC-2) should reuse the existing `Check`/`CheckResult`
shape (`src/doctor/types.ts`, confirmed via `spool-quarantine.ts`'s
`tier: 'cheap'` pattern) rather than inventing a new registration mechanism.
AC quality: the 4 ACs are concrete and testable ("seeded histories proving
each detector fires... and stays silent on baseline drift within tolerance"
is directly Given-When-Then-able); no rewrite needed beyond formalizing the
GWT wording below.

## Risk Radar

Technical unknowns: none — SQL-only, DB-only reads over existing tables,
explicitly fenced away from LLM calls. Dependency chain: `depends_on: []`;
soft coupling to FEAT-547 exists (the FEAT's own body lists "type-mix shift
(e.g. decisions vanishing)" as a detector — this reads the same noisy
`type` classification FEAT-547 targets, so a type-mix detector built before
FEAT-547 lands will alarm on noise it cannot distinguish from a real content
shift). Blast radius: one new module (anomaly-detector set) + doctor
registration (additive `Check` entries) + new CLI subcommand + JSON output —
bounded, single-service. Failure modes: logic error (false-positive alarm
on legitimate baseline drift — AC-4 explicitly requires the negative-case
test), resource exhaustion is fenced (index-backed bounded reads only, per
the 'cheap' tier discipline this repo already enforces). No dispatch/halt/
retry path touched.

Grade history: last-5 average (loop-snapshot.md, 2026-07-13, all ⚠) —
observability 0.325 is the single weakest dimension recorded; this FEAT's
entire purpose is closing exactly that gap, so ACs below require the
JSON/CLI observability surface to be a first-class, tested requirement
(already AC-3, formalized below), not incidental.

Pre-mortem: not mandatory (technical_risk 0.30 < 0.6, priority P2).

Injection-defense: scanned FEAT-546's body and triage_notes — no embedded
imperative found.

## Scores

- customer_impact: 0.55 — real, evidenced precedent (the 87%-broken-for-weeks
  incident this generalizes the fix for) but internal/operator-facing, not
  directly user-visible.
- effort_estimate: 0.45 — "similar to SLICE-437/438/439 (FEAT-543/542/544,
  2026-07-18): single-session, $10.75-$13.83, bounded eval/test-infra scope,
  no LLM cost, no schema change — this FEAT's 4-detector + doctor + CLI +
  JSON scope sits in the same bracket; effort 0.45 confirmed against that
  analog cluster."
- strategic_alignment: 0.60 — directly serves the repo's own
  canary-must-measure-rate doctrine; a real, previously-validated pattern
  being generalized, not aspirational.
- technical_risk: 0.30 — SQL-only, DB-only, new module but single-area,
  no contract change, plain `git revert` rollback.
- dependency_depth: 0.15 — formally independent; soft coupling to FEAT-547's
  type-quality noted but does not block the other 3+ detectors.

## Priority Derivation

composite_priority: P2. P1 requires impact>=0.7 AND alignment>=0.6 — impact
0.55 fails the bar. effort_points via the 0.4-0.6→5 band: **5 points** — under
the FEAT-168 >=8 gate, no `proposedSlices` required. autonomous_safe: risk
0.30, effort 0.45, dependency_depth 0.15 all <=0.6; ACs drafted inline
(--deep) → **true**.

## Apply — frontmatter patch for FEAT-546.md

```yaml
priority: P2
autonomous_safe: true
updated: 2026-07-18
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
```

## Apply — body section replacement for FEAT-546.md

```markdown
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
```
