---
id: SLICE-414
title: Upgrade-path e2e — old-schema datadir opens clean on current build
status: completed
feature: FEAT-420
phase: null
priority: P1
target_release: null
requires_validation: true
risk: high
created: 2026-07-04
updated: 2026-07-04
touches_files: [scripts/gen-upgrade-fixture.mts, tests/storage/fixtures/datadir-v12/, tests/storage/upgrade-path.test.ts, src/storage/migrate.ts, .gitignore]
completed_at: 2026-07-04
---
# SLICE-414: Upgrade-path e2e — old-schema datadir opens clean on current build

Implements FEAT-420 per the user-approved preflight plan
`.claude/artifacts/loop/plans/20260704T-preflight-FEAT-420.md` (READ IT FIRST).

## Objective

Cover the documented upgrade path (`git pull && build && reinstall`) with a
fixture-based e2e: a schema-v12 datadir must open clean on the current
(v13) build with zero data loss, and corrupt/half-migrated datadirs must fail
loud — never silently partial-open. The user's SQLite file IS the product.

## In scope

- scripts/gen-upgrade-fixture.mts (new): builds a datadir at a given
  migration prefix (apply migrations[0..N-1] via the existing stepwise
  migrate machinery), seeds deterministic mock data (plaintext, no cipher,
  ~10 memories + entities + events + vec rows), writes manifest.json
  (counts + spot-check ids + expected search hits).
- tests/storage/fixtures/datadir-v12/: committed binary memory.sqlite +
  manifest.json + README.md (regeneration procedure: on schema bump N->N+1
  run the generator --at N, commit fixture + manifest). Requires a SCOPED
  .gitignore exception for this directory ONLY — do not weaken ignore rules
  for real datadir paths or secrets.
- tests/storage/upgrade-path.test.ts (new): copy fixture -> temp dir -> open
  via the same openDb+migrate path serve uses -> assert schema_version==13,
  counts/ids match manifest, search over pre-upgrade content returns
  manifest-expected hits; ALSO regenerate via script in-test and assert
  generator output matches committed fixture semantics (anti-rot check).
- Corrupt-datadir fail-loud: three inputs (truncated file, garbage bytes,
  half-migrated with last schema_version row deleted) -> actionable typed
  error, refuse to serve. If today's code silently partial-opens, add a
  minimal integrity gate (PRAGMA quick_check + existing drift guard) in
  src/storage — guard only, NO migration-semantics changes.

## Out of scope / STOP-POINT

- Any change to migration SEMANTICS (order, content, backfills) — if a real
  migration bug is found, STOP and surface to the parent loop with evidence
  before fixing.
- Historical fixture matrix (v1..v11) — one v12 fixture only.
- Encrypted-fixture coverage (FEAT-415 territory, owned by the other session).

## Acceptance criteria

- [ ] AC-1: Given the frozen v12 fixture, when the current build opens it,
      then migrations run to schema_version 13 with zero data loss —
      memory/entity/event counts and spot-checked ids match manifest.json.
- [ ] AC-2: Given the migrated datadir, when a search runs against
      pre-upgrade content, then it returns the manifest-expected results.
- [ ] AC-3: Given truncated, garbage, and half-migrated datadirs, when the
      daemon open path runs, then each fails loud with an actionable error
      and never silently opens partial — test-verified for all three.
- [ ] AC-4: The new test runs in the default vitest suite (every push), no
      special trigger.
- [ ] AC-5: Regeneration procedure documented (fixture README) and
      exercised: the generator script reproduces a fixture whose manifest
      matches the committed one (anti-rot assertion in the test).
- [ ] AC-6: All tests pass (`bunx vitest run`), typecheck clean
      (`bun run build`); .gitignore exception is scoped to
      tests/storage/fixtures/ only.

## Done When

- all ACs PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- feature FEAT-420 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written

## Reviewer ladder

- Reviewer A: crew:reviewer (correctness/regressions)
- Reviewer B: crew:typescript-reviewer (only if Reviewer A flags depth)
