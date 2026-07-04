# Preflight plan — FEAT-420: Upgrade-path e2e, old-schema datadir opens clean on current build

status: awaiting-user-approval
prepared: 2026-07-04 (second orchestrator session)
slice shape: ONE slice, but with an internal stop-point (see Risks)

## Code findings (read-only investigation)

- `src/storage/migrate.ts`: versioned migration list, per-version rows in
  `schema_version` table, already-applied skipped; boot drift-guard fails
  when MAX(version) != SCHEMA_VERSION (currently 13, src/server/lib/wire-meta.ts).
- No historical fixture exists anywhere in tests/. migrate tests build from
  scratch only.
- Corrupt / half-migrated datadir behavior: unverified — likely no explicit
  fail-loud path today (AC-3 probably needs production code in the db-open
  or migrate path).

## Plan

1. **Fixture generation, reproducible not hand-frozen**: add
   `scripts/gen-upgrade-fixture.mts` that builds a datadir AT A GIVEN
   MIGRATION PREFIX (run migrations[0..N-1] only — migrate.ts already
   supports stepwise application) and seeds deterministic mock-provider
   data (plaintext, no cipher, ~10 memories + entities + events + vec rows).
   Commit BOTH the script and one generated binary fixture at v12
   (`tests/storage/fixtures/datadir-v12/memory.sqlite`, small).
   Rationale: script gives the documented regeneration procedure (AC-5)
   and reviewers can diff logic; binary gives CI a true frozen artifact
   immune to "the generator drifted with the code" (both compared in test).
2. **Upgrade test** (`tests/storage/upgrade-path.test.ts`): copy fixture →
   temp dir → open with current build (same entry serve uses: openDb +
   migrate) → assert schema_version == 13, memory/entity/event counts and
   spot-checked ids match fixture manifest (JSON alongside fixture), search
   over pre-upgrade content returns expected hits (vec index intact or
   rebuilt).
3. **Corrupt-datadir fail-loud (AC-3)**: test three inputs — truncated
   file, garbage bytes, half-migrated (schema_version row deleted for the
   last applied migration). Expected: actionable error, process refuses to
   serve. If current code silently partial-opens → production fix: wrap
   migrate/open in an integrity gate (PRAGMA quick_check + drift guard
   already half-exists) that throws a typed, actionable error.
4. **CI**: plain vitest file — runs on every push automatically (AC-4), no
   workflow changes needed.
5. **Docs**: short section in migrate.ts header + fixture README: "on
   schema bump N→N+1, run gen-upgrade-fixture --at N, commit fixture +
   manifest" (AC-5).

## touches_files

- scripts/gen-upgrade-fixture.mts (new)
- tests/storage/fixtures/datadir-v12/* (new, binary + manifest.json + README)
- tests/storage/upgrade-path.test.ts (new)
- src/storage/migrate.ts / db.ts (only if AC-3 fail-loud gap confirmed)

## Risks / stop-points

- Fixture rot: mitigated by generator script + manifest assert (test fails
  loudly if fixture and manifest disagree).
- .gitignore currently blocks *.sqlite? — must verify and add a scoped
  exception for tests/storage/fixtures/ only (NEVER weaken the ignore for
  the real datadir paths).
- STOP-POINT: if the AC-3 fix requires changing migration semantics (not
  just adding a guard), pause and surface — migration behavior changes on
  a local-first product need user eyes.

## Estimate

8 pts. One builder dispatch; validation includes a real
fixture→current-build boot.
