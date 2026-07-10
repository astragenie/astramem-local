---
id: FEAT-460
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: .claude/artifacts/loop/backlog/done/FEAT-454.md
cross_product: [astramem-cloud]
pm_user_value: 0.35
pm_strategic_fit: 0.35
pm_effort_inverse: 0.62
pm_risk_inverse: 0.65
pm_confidence: 0.40
composite_score: 0.474
composite_priority: P2
autonomous_safe: false
triaged_at: 2026-07-10
---
## Description

**Cloud-native retrieval presets (SaaS)** — bring FEAT-454's preset UX to the
memory SaaS backend as its OWN contract surface, per the 2026-07-09
architecture review that explicitly descoped cloud from FEAT-454.

**Why a separate FEAT (the collision that forced the split):** cloud already
has a live, required `mode` field — enum `["keyword","semantic","hybrid"]` —
driving real routing + OTel in production (`SearchQuery.cs:53`,
`MemoryQueryService.cs:91-103`). Local presets are *tuning bundles* (fusion
weights, k, filters), a different axis than cloud's *routing* enum. Grafting
preset semantics onto FEAT-454 would have created two same-named concepts with
different meanings across products.

### Design constraints (from the arch review — binding)
- NEW optional field (working name `preset`) alongside `mode`, never replacing
  or aliasing it. Absent `preset` = byte-identical current behavior.
- Cloud preset = bundle of {mode + tuning params}, i.e. a preset MAY set mode;
  explicit `mode` in the same request wins over the preset's mode (document
  precedence, add a test).
- Preset NAME vocabulary matches local (`presets.ts`) so the plugin can send
  the same value to either backend — but the semantics doc must state cloud
  maps intent (e.g. "precision" = tighter k + keyword-lean) rather than
  guaranteeing identical ranking math.
- Unknown preset → 400 with clear message (mirror local validation).
- Wire contract PR must update the shared contract docs
  (IngestTranscriptRequest-adjacent search DTOs) + plugin compatibility note.

### Scope
- Search/recall request DTO: optional `preset` + validation.
- Preset application in `MemoryQueryService` (or equivalent) mapping local
  preset intents to cloud fusion/routing knobs.
- Precedence rule (`mode` beats preset's implied mode) + tests.
- OTel: tag queries with preset name (matches existing mode tagging).
- Contract/docs update + plugin compat note.

### Non-goals
Changing `mode` semantics; local daemon changes (FEAT-454 shipped); UI.

### Approximate ETA
**~2 days** (1 dev): DTO + validation ~0.5d, pipeline mapping + precedence
~0.5d, tests + OTel + docs ~1d.

## Intake notes
Filed 2026-07-10 after build-454-cloud dispatch was halted: builder correctly
flagged that FEAT-454's arch-review corrections removed cloud scope and
mandated a fresh FEAT with its own contract field. Needs design-pass sign-off
on the precedence rule before slicing. Unscored; run `/runner:triage`.

## PM triage (2026-07-10)

### Demand assessment
**Who wants this?** No direct customer quote. Demand is internally
architecture-driven: the 2026-07-09 review that split cloud out of FEAT-454
(quoted in this FEAT's own body: "the 2026-07-09 architecture review that
explicitly descoped cloud from FEAT-454"). FEAT-454 itself (read at
`.claude/artifacts/loop/backlog/done/FEAT-454.md`) was scored `pm_customer_impact: 0.3`
("Cheapest and least differentiated of the six competitor-gap FEATs") with
demand traced to `docs/research/2026-07-09-competitor-gap-analysis.md`, not a
user complaint. `demandEvidence: "none (architecture-decision-driven parity
work, no customer quote)"`.
**Workaround today:** cloud SaaS users get no preset UX at all; they already
have `mode` (keyword/semantic/hybrid) which covers routing, just not local's
tuning-bundle concept. Tolerable — cloud ships without this today with no
recorded complaint.
**Frequency:** N/A — no observed pain, purely a parity/consistency play.

### Scope challenge
**Smallest deliverable:** the DTO + precedence rule + one preset (`default`)
proving the field doesn't collide with `mode`, deferring full preset-vocabulary
parity.
**Overlap check:** none found in `triaged/` or `done/` — FEAT-454 (done) is the
sibling this derives from; no other FEAT references `preset` cloud-side.
**Scope/repo mismatch (important):** Every implementation line item in this
FEAT's Scope section lives in the **`memory`** repo (C#/.NET: `SearchQuery.cs`,
`MemoryQueryService.cs`) — this repo's own `.claude/loop.json` stack is
`bun`/TypeScript only (`"build": [{"cmd":"bun","args":["run","build"]}]`,
`"test": [{"cmd":"bun","args":["run","test"]}]`). This repo's crew agents
cannot build or validate FEAT-460's actual deliverable; it is filed here only
via the `cross_product` convention (mirrors FEAT-454's own
`cross_product: [astramem-local, memory]`, though written here as
`astramem-cloud`, a naming drift worth a human check). **Recommend a human
confirm whether this FEAT should instead be re-filed in the `memory` repo's own
backlog**, with only a tracking stub + plugin-compat note left here.
**AC clarity:** the FEAT already carries 3 concrete ACs
(byte-identical-default snapshot test, precedence test, unknown-preset 400),
inherited verbatim from the FEAT-454 pattern — clear and testable. No
autonomous-safe P0/P1 trigger here, so no inline AC rewrite performed (P2, no
`--deep`/`--spec`).

### Risk radar
**Technical unknowns:** cross-repo, cross-language (TS local pattern → C#
cloud implementation) — a genuinely new pattern for a team whose autonomous
loop here only builds TypeScript.
**Dependency chain:** `depends_on: []` in frontmatter, but the FEAT's own
intake notes state "Needs design-pass sign-off on the precedence rule before
slicing" — an unresolved human-decision dependency not reflected in
`depends_on`.
**Blast radius:** cloud DTO + `MemoryQueryService` + contract docs + plugin
compat note — cross-service, moderate.
**Failure modes:** logic error (precedence rule misapplied — `mode` should
always win but a preset accidentally overriding it would silently change
production routing for cloud users); integration failure (contract drift
between local `presets.ts` vocabulary and cloud's mapped intents).
**technical_risk band:** 0.3–0.5 (new pattern in a different codebase, no
existing contract field replaced/broken, additive + defaulted, clean rollback
via revert) — matches FEAT-454's own scored `pm_technical_risk: 0.3` for the
analogous local slice; scored `pm_risk_inverse: 0.65` here (≈0.35 direct risk,
slightly higher than FEAT-454's local slice given the cross-repo hop).

### Grade feedback
Weak dimensions per last 5 grades (`.claude/artifacts/loop/grades/`,
`20260709T144335Z`, `20260709T110626Z`, `20260707T130414Z`, `20260707T122259Z`,
`20260704T142054Z`): `architecture_quality` (0.51 avg), `observability` (0.654
avg), `production_readiness` (0.504 avg), `security` (0.51 avg),
`product_completeness` (0.504 avg). Note: two of the five inputs
(FEAT-438/SLICE-416, SLICE-417) are largely unfilled grade templates (several
literal `0` placeholders for architecture_quality/production_readiness/
security/product_completeness) — this likely drags the average down further
than real quality, but it is the recorded signal in `loop-snapshot.md` and I
report it as-is. Not directly actionable here since this FEAT is P2 (no
inline-AC trigger), but a human slicing this later should require an OTel/log
AC for the new `preset` field (the FEAT's own scope already lists "OTel: tag
queries with preset name," which would satisfy the observability gap once
scored at P0/P1).

### Effort calibration
No cost-report analog exists for a cross-repo, cross-language FEAT of this
shape. Closest comparably-scoped local slice (FEAT-454, same design family, TS
only, single-repo) was estimated at effort 0.32 and shipped as a fast, cheap
slice per its own triage notes ("Lowest-effort of the six ... good warm-up").
FEAT-460 is scored higher-effort (`pm_effort_inverse: 0.62` ⇒ ≈0.38 direct
effort) than FEAT-454's 0.32 because of the added cross-repo contract-doc and
precedence-test surface. Noted in `reasoning`: "no cost analog; effort
calibrated relative to FEAT-454's actual scored effort, not an independent
cost report."

### Decomposition gate
Effort maps well below the 8-point decomposition threshold (single ~2-day
slice, one contract field) — no `proposed_slices` needed.

```json
{
  "featureId": "FEAT-460",
  "scores": {
    "customer_impact": 0.35,
    "effort_estimate": 0.38,
    "strategic_alignment": 0.35,
    "technical_risk": 0.35,
    "dependency_depth": 0.45
  },
  "compositePriority": "P2",
  "autonomousSafe": false,
  "demandEvidence": "none (architecture-decision-driven parity work; FEAT-454's own demand trace was docs/research/2026-07-09-competitor-gap-analysis.md, not a customer quote)",
  "scopeNotes": "Every implementation line item (DTO, MemoryQueryService mapping, contract docs) lives in the sibling `memory` (.NET) repo, not this TypeScript-only repo's build/test stack — recommend a human confirm this should be filed in `memory`'s own backlog instead. Weak grade dimensions (architecture_quality, observability, production_readiness, security, product_completeness, all <0.80 over last 5 grades) noted per Framework 4 but not actionable at P2 (no inline-AC trigger).",
  "risks": [
    "Cross-repo/cross-language implementation surface: this repo's crew agents cannot build or validate C#/.NET code in `memory`; autonomous dispatch from this repo's loop would stall or require a hand-off this loop cannot perform.",
    "Unresolved human-decision dependency not captured in `depends_on: []`: the FEAT's own intake notes require design-pass sign-off on the mode-vs-preset precedence rule before slicing.",
    "Naming drift: `cross_product: [astramem-cloud]` here vs. FEAT-454's `cross_product: [astramem-local, memory]` — unclear if 'astramem-cloud' resolves to the same `memory` repo; needs a human check, not assumed."
  ],
  "reasoning": "P2: real but low-evidence parity feature entirely implemented outside this repo's stack, with an open design-sign-off dependency; not autonomous-safe from this repo's loop. No cost analog; effort calibrated relative to FEAT-454's actual scored effort (0.32), bumped for cross-repo overhead."
}
```
