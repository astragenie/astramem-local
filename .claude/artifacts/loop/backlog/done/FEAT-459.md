---
id: FEAT-459
status: triaged
priority: P1
category: security
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: docs/specs/FEAT-455-spike-results.md
cross_product: [astramem-local]
pm_customer_impact: 0.7
pm_effort_estimate: 0.28
pm_strategic_alignment: 0.85
pm_technical_risk: 0.3
pm_dependency_depth: 0.1
pm_composite_priority: P1
pm_autonomous_safe: true
pm_reviewed: 2026-07-10
autonomous_safe: true
triage_notes: "P1 via formula: impact 0.70 >= 0.70 AND alignment 0.85 >= 0.60 fires the P1 branch. composite_score = 0.70*0.35 + 0.85*0.30 + (1-0.28)*0.20 + (1-0.30)*0.10 + (1-0.10)*0.05 = 0.759. autonomousSafe=true: all three mechanical thresholds pass (risk 0.30, effort 0.28, dependency 0.10 all <=0.6) and P1 triggers inline AC drafting (acs below) satisfying the hasAcceptanceCriteria gate. Security category + evidenced gaps + low friction + empty depends_on = the coordinator's steer, confirmed by direct code/test verification rather than taken on faith."
---
## Description

**Stage-0 redaction hardening** — close two measured, pre-existing gaps in the
daemon's redaction layer, found (and demonstrated by committed failing-shape
tests) during the FEAT-455 security spike:

1. **Short secret fragments pass through** — secrets <20 chars with no
   recognizable label are never redacted (entropy detector's
   `MIN_TOKEN_LENGTH` floor). E.g. a 16-char API key fragment survives.
2. **Compound-label detection miss** — `\b` word-boundary regex fails on
   labels like `INTERNAL_SECRET=` / `OPENAI_API_KEY=` (the generic_credential
   detector never matches; entropy fallback rescues only some — measured
   `INTERNAL_SECRET=abc123` at 3.97 bits/char, just under the 4.0 threshold,
   persists unredacted).

**Why now:** these are not auto-capture bugs — every ingest path (transcripts,
remember, spool) shares stage-0. Auto-capture (FEAT-455) raises exercise
frequency, and stage-0 is the ADR-012 ship gate's enforcement point, so the
hardening directly strengthens that gate. Evidence + reproducing fixtures
already live in `tests/security/redact-autocapture.test.ts` (spike commit).

### Scope
- Tune/extend the generic_credential label patterns (compound `X_SECRET=`,
  `X_API_KEY=`, `X_TOKEN=` forms; `=`/`:` separators; no `\b` reliance).
- Decide + implement short-fragment policy: lower MIN_TOKEN_LENGTH when a
  label context is present (labeled short secrets are high-confidence), keep
  the floor for unlabeled entropy-only matches (false-positive control).
- Flip the spike's documented-gap tests from "documents the miss" to asserting
  redaction; add regression fixtures for both classes.
- Re-run the redaction perf smoke (stage-0 is on the hot ingest path — no
  significant latency regression).

### Non-goals
Client-side scrub (tracked separately per ADR-012); redaction of already-
persisted historical content.

### Approximate ETA
**~2-3 days** (detector tuning + false-positive sweep + tests + perf check).

## Intake notes
Filed 2026-07-10 from FEAT-455 spike findings 1-3. Security-category — suggest
priority bump at triage. Unscored; run `/runner:triage`.

## Acceptance criteria (Given-When-Then)

- AC-1: Given a text payload containing the literal string `INTERNAL_SECRET=abc123` (the exact fixture asserting a gap today in tests/security/redact-autocapture.test.ts), When `redactText` from src/redact/index.ts processes it, Then the returned `events` array contains at least one event whose `type` is a labeled-credential type (e.g. `generic_credential`) and the returned `text` does not contain the literal substring `abc123`.
- AC-2: Given a text payload containing `OPENAI_API_KEY=sk-proj-9f8e7d6c5b4a3210` (a SCREAMING_SNAKE_CASE label compounded onto `_KEY`, which the current `\b`-anchored generic_credential regex at src/redact/detectors.ts:76-80 does not match), When `redactText` processes it, Then `events` contains a labeled-credential event matched via the underscore-tolerant pattern, independent of whether the entropy fallback also fires on the same value.
- AC-3 (edge/failure path): Given a text payload containing a labeled 17-character token fragment (e.g. `token=<17-char-fragment>`, below the current `MIN_TOKEN_LENGTH = 20` floor at src/redact/entropy.ts:10), When `redactText` processes it under the new labeled-short-fragment policy, Then the fragment IS redacted (an event is emitted and the literal fragment is absent from `text`); AND Given the SAME 17-character fragment with NO adjacent credential-keyword label, When `redactText` processes it, Then the fragment is NOT redacted (the unlabeled floor still applies, preserving false-positive control).
- AC-4 (regression flip): Given the two existing GAP-labeled tests in tests/security/redact-autocapture.test.ts (currently asserting `events.length === 0` and `text === partial`/`text === line`), When the hardening lands, Then both tests are flipped to assert redaction occurred (`events.length > 0` and the secret substring absent from `text`), AND the full existing suite in tests/security/redact.test.ts (25+ true/false-positive fixtures) remains green with zero new false positives.
- AC-5 (observability -- weak grade dimension): Given the redaction perf-smoke check the FEAT's own scope requires re-running ('no significant latency regression'), When the hardened detector/entropy path executes against the existing perf-smoke fixture, Then the smoke check logs a concrete before/after latency figure (not merely pass/fail) so a production-readiness or observability regression is visible in CI output rather than silently swallowed.
