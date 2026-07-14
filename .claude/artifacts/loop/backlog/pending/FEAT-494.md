---
id: FEAT-494
status: pending
priority: null
category: observability
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: []
slices: []
derived_from: memory repo docs/research/2026-07-14-screenpipe-deep-dive.md
---
# FEAT-494: Memory-leak sentinel doctor check (least-squares RSS growth)

## Description

A statistically-grounded leak detector for the always-on daemon, added to `src/doctor/checks/`:
roll a window of (uptime, RSS) samples, fit a least-squares line, alert only on SUSTAINED linear
growth (slope threshold + r² fit quality + minimum fitted growth + minimum absolute RSS + minimum
window hours + minimum sample count, first ~30 min ignored for model/cache warmup). Avoids both
false positives from spiky samples and false negatives from noisy short windows — same
statistical-rigor bar as the existing usefulness-feedback-loop canary. Design independently
reimplemented from the shape studied in Screenpipe's resource monitor (study only — no code
reuse; pick our own thresholds empirically).

## Acceptance hints

- Sampler persists (uptime, RSS) at a low cadence; check computes fit on demand.
- Unit tests: flat, spiky-but-flat, and genuinely-growing synthetic series → ok/ok/warn.
- Warmup window excluded; thresholds config-tunable with documented defaults.

## Notes

Pure doctor-check work, no dependencies, S effort. Especially relevant once FEAT-489 audio adds
native add-on memory pressure.
