---
id: FEAT-461
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: FEAT-455 build (build-455 finding, 2026-07-10)
cross_product: [astramem-local]
---
## Description

**configToYaml() silently drops newer Config fields on every writeConfig()** —
`src/config/writer.ts`'s hand-rolled YAML emitter never gained blocks for
several fields added to `Config` after it was written: `distill`, `ingest`,
`memoryHealth`, `ingestIdempotency` (and until FEAT-455 fixed its own slice,
`capture`). Any `writeConfig()` call (`init`, `reembed-dim`, `pair`,
auto-capture disable) re-emits config.yaml WITHOUT those blocks — a user who
hand-tuned e.g. `distill.*` and later runs `reembed-dim` loses those settings
silently (loader then falls back to defaults, no warning: the file parses
fine, keys are simply gone).

**Found during** FEAT-455 build: the wizard's auto-capture opt-in silently
no-op'd until the `capture` block was added to the emitter. The remaining
fields are the same latent bug, out of that slice's scope.

### Scope
- Fix: either add the missing blocks to `configToYaml()` OR (better,
  root-cause) replace the hand-rolled emitter with a schema-driven emit that
  walks the Config zod/type shape so new fields can never be dropped again.
- Regression test: round-trip property — `loadConfig(configToYaml(cfg))`
  deep-equals `cfg` for a fully-populated Config (this single test would have
  caught every instance of this bug class).
- Audit git history for users' likely-lost fields; note in CHANGELOG.

### Non-goals
Live config reload (FEAT-433 resolved the atomicity side; this is emit
completeness).

### Approximate ETA
**~0.5-1 day.**

## Intake notes
Filed 2026-07-10 from build-455 report. Data-loss-shaped (user config
settings silently dropped) — suggest priority consideration at triage.
Unscored; run `/runner:triage`.
