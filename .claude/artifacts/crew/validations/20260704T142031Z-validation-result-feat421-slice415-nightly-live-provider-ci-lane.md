---
status: PASS
---
# Validation Result: FEAT421 SLICE415: nightly live-provider CI lane

- Created: 2026-07-04T14:20:31.799Z
- Validator: verifier
- Environment: -
- Decision: passed_with_notes
- Status: PASS
- Scenario: Behavior validated by 4 real workflow runs (URLs in review artifact + workflow README): live subset executed against real Ollama (not skipped — real HTTP calls, real dim-mismatch error from stale test model), issue automation exercised on genuine red, cache entry 5.65GiB exists (gh cache list), concurrency group + singleton probe prevent shared-host races. AC-1..5 PASS; AC-2/AC-3 satisfied with live evidence rather than dry-runs.
- Evidence Collected: -
- Files / Surfaces Checked: -
- Risks: -
- Required Follow-up: -

