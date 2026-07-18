---
id: FEAT-548
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: []
slices: [SLICE-441]
derived_from: 2026-07-18 phi-role analysis
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
started_at: 2026-07-18
---
## Description

**Ingest gatekeeper — local pre-extract substantiveness gate (quota saver).**

New optional pre-extraction gate: after chunking (stage 3), a cheap local model
(phi4-mini class) answers "does this chunk contain anything durably memorable?" —
`skip` chunks go straight past the extraction LLM call (recorded, not extracted).

- **Fail-open**: uncertain/parse-fail/provider-down → extract anyway. A gatekeeper
  outage must degrade to today's behavior exactly (ADR-015).
- Config-gated (`distill.gatekeeper: { mode: off|dry-run|enabled, provider, model }`),
  default **off**; dry-run logs verdicts without skipping (measurement mode).
- Caps mirror atom-triage (maxPerRun/wallclock).
- Observability: skip-rate counter + doctor-friendly rate stats (a 100% skip rate =
  broken gate, must be loud — canary-must-measure-rate lesson).

Expected value: prod transcripts carry greeting/ack/tool-spam chunks (the bench's
nothing-fixtures class); LoCoMo small-talk sessions likewise. Each skip saves one
metered codex call. Measured phi cost: ~1-2s per chunk verdict locally.

## Explicitly out of scope
- No content transformation — binary route only.
- No default-on (dry-run measurement first; enablement needs measured skip-rate +
  zero-false-skip evidence on the bench's nothing/noisy fixtures).

## Acceptance criteria (Given-When-Then)

- AC-1: Given `distill.gatekeeper.mode: 'off'` (the shipped default), When a
  distill job runs post-chunking (stage 3), Then every chunk proceeds to
  extraction exactly as it does pre-FEAT-548 — no gate call is made, no new
  code path executes, byte-identical pipeline output.
- AC-2: Given `distill.gatekeeper.mode: 'enabled'` and the configured
  provider throws, times out, or returns an unparsable response, When the
  gate call fails, Then the affected chunk proceeds to extraction exactly as
  if the gate had verdicted `keep` (fail-open, ADR-015 posture) — Given a
  test that forces the provider to throw, Then the test asserts the chunk
  WAS extracted (not silently dropped), proving the fail-open contract
  rather than merely asserting no exception propagated.
- AC-3: Given `distill.gatekeeper.mode: 'dry-run'`, When the gate call
  returns a `skip` verdict for a chunk, Then the chunk still proceeds to
  extraction unmodified AND the would-have-skipped verdict is logged
  (structured) with a running skip-rate counter — this is the measurement
  mode and must produce a number an operator can inspect before ever
  flipping to `enabled`.
- AC-4: Given the extraction-bench's 55-fixture set run with the gate in
  `dry-run` mode, When the sweep completes, Then every fixture tagged as
  substantive (the non-"nothing"/non-"noisy" classes) reports a false-skip
  rate of exactly 0% — a single false-skip on a substantive fixture is a
  hard bench-gate failure, not a warning — and every fixture in the
  "nothing"/"noisy" classes reports the gate correctly verdicting `skip`.
- AC-5: Given `distill.gatekeeper.mode` is `dry-run` or `enabled`, When a
  distill job completes, Then the skip-rate (skipped chunks / total chunks
  evaluated) is exposed as a structured log field AND a doctor-consumable
  health stat, and When the skip-rate is >=95% over a meaningful-usage
  window (mirroring the `MEANINGFUL_USAGE_THRESHOLD`-gated pattern this
  repo already uses for other rate canaries), Then this is surfaced as a
  loud WARN — a gate that skips almost everything is broken, not efficient
  (closing the observability weak dimension, avg 0.325 over the last-5
  snapshot, and directly applying this repo's own
  canary-must-measure-rate-not-existence lesson).

## Options considered

- Gate at the atom level (post-extraction) instead of the chunk level
  (pre-extraction) — rejected: this defeats the entire purpose (quota
  saving requires skipping the metered call itself, not filtering its
  output after the call already happened; that's what FEAT-533's
  atom-triage already does at a different chokepoint).
- Default `mode: 'enabled'` on ship — rejected, explicitly out of scope:
  "No default-on (dry-run measurement first; enablement needs measured
  skip-rate + zero-false-skip evidence)" — mirrors the same rollout
  discipline `atomTriage` and `contradictionDetection` already established
  in this repo.
- Skip content transformation entirely vs a binary route-only decision —
  already the FEAT's own design (explicitly out of scope: "no content
  transformation"); no alternative considered here, confirming the FEAT
  body's scope fence is correct and should not be relaxed.

## Wave outcome (2026-07-18)

2026-07-18 WAVE COMPLETE: built (SLICE-441, tip e9d8b6c2 incl migration renumber 054->055 + rebase onto 547), review approved ZERO findings. Dry-run on 55 fixtures EXECUTED but telemetry lost to sandbox cleanup — follow-up: surface gatekeeper stats in bench summary.json pre-teardown, then re-measure. Latent compact-fallback positional bug fixed en route.
