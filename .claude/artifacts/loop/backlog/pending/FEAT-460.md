---
id: FEAT-460
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: .claude/artifacts/loop/backlog/done/FEAT-454.md
cross_product: [astramem-cloud]
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
