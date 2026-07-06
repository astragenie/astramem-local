---
feature: FEAT-420
status: active
---
# Run Brief: FEAT420 SLICE414: Upgrade-path e2e — old-schema datadir opens clean on current build

- Created: 2026-07-04T12:44:30.872Z
- Tier: full
- Goal: Cover the documented upgrade path (`git pull && build && reinstall`) with a fixture-based e2e: a schema-v12 datadir must open clean on the current (v13) build with zero data loss, and corrupt/half-migrated datadirs must fail loud — never silently partial-open. The user's SQLite file IS the product.
- Mode: autonomous
- Pace: unattended
- Owner: loop
- Status: active
- Summary: -
- Scope:
  - - scripts/gen-upgrade-fixture.mts (new): builds a datadir at a given
  migration prefix (apply migrations[0..N-1] via the existing stepwise
  migrate machinery)
  - seeds deterministic mock data (plaintext
  - no cipher
  - ~10 memories + entities + events + vec rows)
  - writes manifest.json
  (counts + spot-check ids + expected search hits).
- tests/storage/fixtures/datadir-v12/: committed binary memory.sqlite +
  manifest.json + README.md (regeneration procedure: on schema bump N->N+1
  run the generator --at N
  - commit fixture + manifest). Requires a SCOPED
  .gitignore exception for this directory ONLY — do not weaken ignore rules
  for real datadir paths or secrets.
- tests/storage/upgrade-path.test.ts (new): copy fixture -> temp dir -> open
  via the same openDb+migrate path serve uses -> asse
- Out Of Scope: -
- Planned Files: -
- Next Step: Begin implementation

