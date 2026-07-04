---
id: FEAT-420
status: triaged
priority: P1
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: test-inventory-2026-07-04
pm_customer_impact: 0.80
pm_effort_estimate: 0.60
pm_strategic_alignment: 0.65
pm_technical_risk: 0.55
pm_dependency_depth: 0.35
pm_effort_points: 8
composite_score: 0.64
composite_priority: P1
autonomous_safe: false
pm_demand_evidence: "CLAUDE.md documents git pull && bun run build && reinstall as THE supported upgrade path, yet storage/migrate.test.ts only builds schema from scratch — zero coverage of a real released-version datadir being opened by a newer build."
pm_scope_notes: "Start with ONE frozen fixture at the most recent prior schema version (not a matrix of every historical version) to bound scope; document the regeneration procedure so future schema bumps add fixtures incrementally rather than this slice trying to backfill full history."
pm_risks:
  - "Fixture maintenance cost: frozen binary/db fixtures rot and need regeneration discipline every schema bump, or the test silently stops testing anything meaningful."
  - "A real migration-order or backfill bug found here likely needs a production fix in the same slice — for a local-first product, an unrecoverable user datadir is the worst-case outcome this FEAT exists to catch."
  - "Corrupt/half-migrated datadir handling (fail loud, not silent partial open) may not exist yet and could itself require new production code, not just a test."
reasoning: "Highest customer-impact FEAT in this batch: for a local-first product the user's SQLite file IS the product, and an untested upgrade path risks unrecoverable data loss. P1 despite higher effort (fixture creation + a maintenance procedure) because the downside of skipping it is catastrophic and asymmetric to the cost of testing it. autonomous_safe=false because a real migration bug found here needs a production fix, not just a red test left in place."
---
# FEAT-420: Upgrade-path e2e — old-schema datadir opens clean on current build

## Problem
storage/migrate.test.ts covers individual migration steps as units. Nothing tests the real user upgrade flow: a datadir created by an OLDER released daemon version, opened by the CURRENT build (the exact `git pull && bun run build && reinstall` path CLAUDE.md documents). Migration-order bugs, missed backfills, or vec-table dim mismatches on real historical data ship untested. This is a local-first product — the user's SQLite file IS the product; a bad migration is unrecoverable without backup.

## Proposal
Fixture-based upgrade test: commit one (or more) small pre-built memory.sqlite fixtures generated at known schema versions (mock-provider data, encryption off, tiny). Test copies fixture to temp datadir, boots current daemon against it, asserts: migrations run to current version, memory/entity/event counts preserved, search returns pre-upgrade content, vec index rebuilt or intact. Regenerate fixture procedure documented so future schema bumps add a new frozen fixture.

## Acceptance (PM GWT)
1. Given a frozen memory.sqlite fixture built at schema version N-1 (mock-provider data, plaintext, small), When the current daemon build opens it, Then migrations run to the current schema_version with zero data loss — memory/entity/event counts and spot-checked ids match the fixture's known values.
2. Given the migrated fixture datadir, When a search query is run against pre-upgrade content, Then it returns the expected pre-upgrade results (vec index rebuilt or intact).
3. Given a deliberately corrupted or half-migrated fixture datadir, When the daemon attempts to open it, Then it fails loud with an actionable error message and never silently opens in a partial state.
4. Given this test exists, When CI runs, Then it runs on every push, not just nightly or on manual trigger.
5. Given a future schema bump lands, When a contributor needs to add fixture coverage, Then a documented regeneration procedure exists so adding the new frozen fixture is a bounded, repeatable step.

## Evidence
Test-inventory review 2026-07-04. Upgrade flow is documented as THE supported path (CLAUDE.md reinstall section) yet has zero coverage; unit migrate tests build schema from scratch, never from a released artifact.
