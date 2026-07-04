---
feature: FEAT-413
status: active
---
# Run Brief: FEAT413 SLICE411: Response-side score contract enforcement at daemon serialization boundary

- Created: 2026-07-04T10:29:08.343Z
- Tier: full
- Goal: Enforce the [0,1] score wire contract at the daemon's response serialization boundary, independent of fuseScores() internal math. Any future path that constructs a hit score outside fuseScores (second fusion strategy, manual override, stale cache) must be clamped and logged server-side instead of shipping invalid wire data that only the plugin's client-side Zod rejects (the cedc8a9 failure mode: plugin exit 3, daemon oblivious).
- Mode: autonomous
- Pace: unattended
- Owner: loop
- Status: active
- Summary: -
- Scope:
  - - One small shared helper (e.g. `clampScore(value
  - ctx)`) that clamps a score
  into [0
  - 1]
  - maps non-finite values (NaN/Infinity) to a safe bound
  - and emits
  a structured pino warning with route + memory id context when it fires.
- Apply it exactly where search/recall hits serialize to JSON:
  `src/server/routes/search.ts` (both response sites) and
  `src/server/routes/recall.ts` (memories score site).
- Tests: hand-crafted out-of-contract scores (>1
  - <0
  - NaN) pushed through the
  serialization path → response carries clamped values
  - warning logged
  - status stays 200.
- Out Of Scope:
  - - Any general response-validation framework or schema middleware (explicit
  pm_scope_notes guard).
- Changes to fuseScores() or search ranking math.
- Plugin/SaaS-side changes.
- Planned Files: -
- Next Step: Begin implementation

