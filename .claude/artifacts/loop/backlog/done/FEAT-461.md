---
id: FEAT-461
status: done
priority: P1
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: [SLICE-420]
derived_from: "FEAT-455 build (build-455 finding, 2026-07-10)"
cross_product: [astramem-local]
pm_user_value: 0.65
pm_strategic_fit: 0.55
pm_effort_inverse: 0.8
pm_risk_inverse: 0.85
pm_confidence: 0.85
composite_score: 0.74
composite_priority: P1
autonomous_safe: true
triaged_at: 2026-07-10
started_at: 2026-07-10
slices_complete: [SLICE-420]
completed_at: 2026-07-10
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

## PM triage (2026-07-10)

### Demand assessment
**Who wants this?** Any local daemon operator who hand-tunes advanced config
blocks (`distill`, `ingest`, `memoryHealth`, `ingestIdempotency`) and later
runs a common maintenance command. **Evidence:** verified directly —
`src/config/writer.ts` (188 lines, read in full) has a `capture` block (lines
146-156, the FEAT-455 fix) but genuinely no emit blocks for `distill`,
`ingest`, `memoryHealth`, or `ingestIdempotency` — confirms the bug exactly as
described, not just as claimed. `CLAUDE.md`'s own "Config reload (FEAT-433,
resolved)" section documents the project's stated bar for config-write
correctness ("writeConfig ... now writes atomically"), so an emit-completeness
gap contradicts the project's own resolved-hazard narrative.
**Workaround:** none — silent, no warning today; the only mitigation is
hand-re-editing config.yaml after every `writeConfig()`-triggering command,
which `CLAUDE.md` itself warns is risky ("Stop the service before hand-editing
config.yaml").
**Frequency:** triggered only when a user has customized one of the four
affected blocks AND runs `init`/`reembed-dim`/`pair`/capture-disable
afterward — a real but narrower slice of "every write" than the FEAT's
framing implies, since most users likely run with code-defaults for these
specific advanced blocks.

### Scope challenge
**Smallest deliverable:** add the four missing YAML blocks to
`configToYaml()` + the round-trip property test — the FEAT's own "OR (better,
root-cause)" schema-driven rewrite is a stretch goal, not required for this
slice, and should be deferred to avoid inflating blast radius/risk.
**What to cut if halved:** drop the CHANGELOG git-history audit line item;
keep the fix + regression test (the test is the load-bearing deliverable per
the FEAT's own claim: "this single test would have caught every instance of
this bug class").
**Overlap:** none — FEAT-433 (resolved) covers write atomicity, a different
concern from emit completeness; FEAT-455 (done) added only the `capture`
block.
**AC clarity:** original scope is clear on the fix but ambiguous between two
implementation strategies (minimal patch vs. schema-driven rewrite) — ACs
below resolve this by scoping to the minimal patch + regression test as the
required deliverable.

### Risk radar
**Technical unknowns:** none — pure function, one file, existing test file
(`tests/config/writer.test.ts`) to extend.
**Dependency chain:** `depends_on: []`, confirmed no other pending/triaged FEAT
references this domain.
**Blast radius:** 1-2 files (`src/config/writer.ts` + its test file).
**Failure modes:** data/shape corruption (the bug itself — silent field
loss); this is a fix for a corruption-class bug, not an introduction of one.
**technical_risk band:** 0.0–0.2 (known repo pattern — extending an existing
hand-rolled emitter function with more field blocks — 1-2 files, trivially
`git revert`-able). Scored `pm_risk_inverse: 0.85` (≈0.15 direct risk).

**Pre-mortem (mandatory: P1):**
1. *Two weeks later, review/validation failure — most likely cause:* the
   round-trip property test is written too narrowly (e.g. only exercises
   default values rather than a fully non-default-populated `Config`), so it
   passes green while still missing one of the four fields; alternatively, a
   builder reaches for the "better, root-cause" schema-driven rewrite instead
   of the minimal patch and it breaks comment preservation (the emitter has
   inline comments like the FEAT-455 `// Automatic memory capture (FEAT-455,
   ADR-012)` block at line 146 that a generic schema-walker would need to
   reproduce or the diff becomes unreviewable).
2. *If this merged and broke the loop — rollback:* revert-only. Pure
   additive fix to a pure-function emitter; no migration, no schema change,
   no cross-plugin coordination.
3. *Existing test that would NOT catch a regression:* `tests/config/writer.test.ts`
   currently exercises the fields it already knows about (including
   `capture`, FEAT-455's fix) but has no round-trip assertion covering
   `distill`/`ingest`/`memoryHealth`/`ingestIdempotency` — a regression
   dropping one of those blocks again would slip through without this FEAT's
   new round-trip test landing.

### Grade feedback
Weak dimensions per last 5 grades: `architecture_quality` (0.51),
`observability` (0.654), `production_readiness` (0.504), `security` (0.51),
`product_completeness` (0.504) — all below 0.80 (source:
`.claude/artifacts/loop/grades/20260709T144335Z-feat449-slice419-grade.md`,
`20260709T110626Z-feat441-slice419-grade.md`,
`20260707T130414Z-feat438-slice417-grade.md`,
`20260707T122259Z-feat438-slice416-grade.md`,
`20260704T142054Z-feat421-slice415-grade.md`). Observability is directly
relevant here (silent-failure bug class) — AC-3 below requires a structured
warning log so a future field addition that isn't wired into the emitter
surfaces immediately rather than silently, satisfying the weak-dimension rule
for `autonomous_safe: true`.

### Effort calibration
No exact analog (no FEAT-455 cost report found under
`.claude/artifacts/crew/cost/`). Closest single-project bounded slice on
record is FEAT-449 (`20260709T144324Z-cost-report-slice-feat449-slice419.md`:
$72.34, 56 min, "medium" shape) for a materially larger scope (a whole
filesystem spool subsystem). FEAT-461 is a narrower single-function emitter
fix + one property test — expect materially below that ceiling. Scored
`pm_effort_inverse: 0.8` (≈0.2 direct effort), consistent with the FEAT's own
~0.5-1 day ETA and a single-file blast radius smaller than the FEAT-449
analog.

### Decomposition gate
Effort well below the 8-point threshold (single-file fix + one test) — no
`proposed_slices` needed.

```json
{
  "featureId": "FEAT-461",
  "scores": {
    "customer_impact": 0.65,
    "effort_estimate": 0.2,
    "strategic_alignment": 0.55,
    "technical_risk": 0.15,
    "dependency_depth": 0.1
  },
  "compositePriority": "P1",
  "autonomousSafe": true,
  "demandEvidence": "Verified directly in src/config/writer.ts: capture block present (FEAT-455 fix, lines 146-156) but distill/ingest/memoryHealth/ingestIdempotency blocks genuinely absent, confirming the reported silent-drop bug as described.",
  "scopeNotes": "Smallest deliverable is the minimal emitter patch (four missing blocks) + round-trip property test; the FEAT's own 'better, root-cause' schema-driven rewrite is a stretch goal, not required — scoping to the minimal patch keeps blast radius at 1-2 files. Weak grade dimension observability (0.654 avg) addressed via AC-3 (structured warning log on incomplete emit).",
  "risks": [
    "Pre-mortem 1: round-trip test written too narrowly (defaults-only) could pass green while still missing a field, or a builder over-reaches into the schema-driven rewrite and breaks comment preservation.",
    "Pre-mortem 2: rollback is revert-only — pure additive emitter fix, no migration, no cross-plugin coordination.",
    "Pre-mortem 3: tests/config/writer.test.ts today has no round-trip assertion over distill/ingest/memoryHealth/ingestIdempotency — this exact regression class would not be caught without the new test."
  ],
  "reasoning": "P1: verified, currently-live silent data-loss bug on common maintenance commands (reembed-dim, init, pair), single-file fix with a precise regression-test recipe already specified — high confidence, low risk, bounded effort.",
  "acs": [
    "AC-1: Given a fully-populated Config object including non-default values for distill, ingest, memoryHealth, and ingestIdempotency, When configToYaml(cfg) is called and the result is parsed back via loadConfig(), Then the round-tripped config deep-equals the original cfg for every one of those four blocks.",
    "AC-2: Given a config.yaml previously written by a version of configToYaml() that omits the distill block, When reembed-dim (or init, pair, or auto-capture disable) triggers a fresh writeConfig() call on the in-memory Config, Then the newly-written config.yaml contains the distill block with its current in-memory values, not silently reverted to defaults.",
    "AC-3: Given configToYaml(cfg) would emit fewer top-level keys than Object.keys(cfg) contains, When the emit completes, Then a structured warning is logged (e.g. logger.warn({ missingKeys }, 'configToYaml: emitted config is missing known Config keys')) so a future field addition not wired into the emitter surfaces immediately instead of silently.",
    "AC-4: Given an optional sub-block is undefined at emit time (e.g. cfg.ingestIdempotency is undefined because a pre-FEAT-455 config was loaded with defaults applied), When configToYaml(cfg) runs, Then it emits that block using the defaulted value rather than throwing or silently omitting the key entirely."
  ]
}
```

## Acceptance criteria

**Re-verified against current code** (`src/config/config.ts`, `src/config/writer.ts`,
`src/config/loader.ts`, all read in full 2026-07-10). The drop is **wider than the
FEAT body and PM triage above describe**: `configToYaml()` (src/config/writer.ts:45-160)
today emits `port, dataDir, network, llm, embedding, vector, budget, ollama, azure,
openaiCompatible, codexSubscription, search, crossEncoder, recallPack, security,
tagHygiene, pipeline, consolidation (autoAcceptThreshold only), capture` and
deliberately skips `sync` (writer.ts:122-123 comment — owned by `sync.json`,
intentional, not a bug). Confirmed **completely absent** from the emitter, cross-checked
against every top-level key on the `Config` interface (config.ts:5-318):
- `archival` (config.ts:157-167) — **missing from the FEAT's own list of four**; neither
  the original filer nor the PM triage caught this fifth fully-dropped block.
- `ingestIdempotency` (config.ts:178-182)
- `distill` (config.ts:268-270)
- `memoryHealth` (config.ts:279-283)
- `ingest` (config.ts:290-296)

Also confirmed dropped **inside** an otherwise-emitted block (writer.ts:143-144 only
emits `consolidation.autoAcceptThreshold`):
- `consolidation.contradictionDetection` (mode/minSimilarity/minConfidence/maxPerRun,
  config.ts:241-257) — a nested partial drop a naive "add the missing top-level blocks"
  patch could still miss.

Two more field-level omissions inside emitted blocks (lower severity, same bug class):
`crossEncoder.model` (config.ts:101-103, writer only emits enabled/provider/topK/
timeoutMs/sidecarUrl) and `security.redaction.customPatterns` (config.ts:133, writer
only emits enabled/entropyThreshold).

`loader.ts:147-201` confirms the mechanism: `loadConfigFromDisk` deep-merges parsed
YAML **over `defaultConfig()`**, so any key `configToYaml` failed to emit silently
reverts to the code default on next load — exactly the reported behavior. Note the
correct read-back entry point is `loadConfigFromDisk(configDir)` (loader.ts), not
`loadConfig()` (config.ts — that one takes an in-memory `Partial<Config>`, not YAML
text); the round-trip test must go through `writeConfig` → `loadConfigFromDisk`.

- **AC-1 (exhaustive round-trip fidelity).** Given a fully-populated `Config` object
   with an explicit non-default value assigned to *every* top-level field — including
   `archival`, `ingestIdempotency`, `distill`, `memoryHealth`, `ingest`, and
   `consolidation.contradictionDetection` (not only the four blocks named in the
   original report) — When `writeConfig(cfg, path)` writes it and `loadConfigFromDisk(configDir)`
   reads it back, Then the result deep-equals `cfg` for every field. The test must build
   `cfg` field-by-field with non-default values (not start from `defaultConfig()` and
   leave fields untouched), otherwise a still-missing block round-trips "successfully"
   by accident (default in, default out).

- **AC-2 (regression guard, not a fixed field list).** Given a new field is added to
   the `Config` type in `src/config/config.ts` but `configToYaml()` in
   `src/config/writer.ts` is not updated to emit it, When the test suite runs, Then a
   test fails — implemented as a structural key-diff (top level, and one level of
   nesting for object-valued fields) between `Object.keys` of a fully-populated `Config`
   and the keys actually present in the parsed emitted YAML, with `sync` as the one
   documented, intentional exclusion. A test that only asserts the four originally-named
   fields would not have caught the `archival` or `consolidation.contradictionDetection`
   gaps found above and does not satisfy this AC.

- **AC-3 (observability on incomplete emit).** Given `configToYaml(cfg)` is about to
   return and the same key-diff from AC-2 finds `cfg` keys (top-level or one level
   nested) that were not written, When the emit completes, Then a structured warning is
   logged naming the missing keys (e.g. `logger.warn({ missingKeys }, 'configToYaml:
   emitted config is missing known Config keys')), so a future field addition not wired
   into the emitter surfaces immediately at write time rather than silently at next load.

- **AC-4 (defaulted-undefined sub-block).** Given an optional sub-block is `undefined`
   on the in-memory `Config` at emit time (e.g. a config object built before a newer
   field's default existed), When `configToYaml(cfg)` runs, Then it emits that block
   using its documented default rather than throwing a `TypeError` or silently omitting
   the key.

- **AC-5 (no behavior change for existing valid configs).** Given a `Config` object
   using only the fields `configToYaml` already emits correctly today (`port` through
   `capture`, per the current writer.ts), When `configToYaml` runs before and after this
   fix, Then the emitted YAML for those already-covered blocks is byte-identical, and
   `sync` remains excluded from the output (its exclusion is an intentional design
   decision per writer.ts:122-123, not part of this bug) — a generic/schema-driven
   emitter must not start emitting `sync` as an unintended side effect.
