---
id: FEAT-459
status: pending
priority: null
category: security
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: docs/specs/FEAT-455-spike-results.md
cross_product: [astramem-local]
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
