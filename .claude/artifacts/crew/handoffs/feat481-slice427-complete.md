# SLICE-427 build handoff: Migration 027 + EntityRelationRepo

## Objective
Storage primitive for FEAT-481 (entity-to-entity relations): migration 027
(`entity_relations` table), `EntityRelationRepo`, JOIN-with-memories
effective-validity contract, atomic dedup guard, cascade semantics. Scope
is AC-1 through AC-5 only (the slice file's AC-6..AC-13 belong to later
sibling slices — extraction/MCP/eval — and were not touched).

## Owner
builder (this session) — implementation only, no review/commit performed.

## Deliverable
- `migrations/027-entity-relations.sql` — new table, per
  `docs/specs/FEAT-481-design.md` §1 verbatim (predicate/evidence_memory_id
  naming, `ON DELETE CASCADE` divergence from cloud's `RESTRICT`, 4 indexes).
- `src/storage/entity-relations.ts` — new `EntityRelationRepo`:
  `insert()` (atomic `INSERT...SELECT...WHERE NOT EXISTS` dedup guard, one
  `db.prepare().run()` call, comment at the call site per design doc §3.4),
  `getForSubject`/`getForObject`/`getForEntity` (JOIN `memories`, MAX/MIN
  `+inf`-sentinel effective-validity predicate modeled on
  `memoryIdsForEntitiesAsOf`, `src/storage/entities.ts:223-238`).
- `src/storage/memory-events.ts` — one-line cascade addition in
  `supersede()`: `DELETE FROM entity_relations WHERE evidence_memory_id = ?`
  in the same transaction as the existing `memory_entities` unlink.
- `src/server/lib/wire-meta.ts` — `SCHEMA_VERSION` bumped 26 → 27 with a
  changelog comment entry.
- `tests/storage/entity-relations.test.ts` (new) — AC-1 through AC-5
  coverage, TDD-first.
- Updated every pre-existing hardcoded `schema_version === 26` assertion
  to 27 across `tests/storage/{migrate,entities,entity-validity,atom-v3,
  upgrade-path}.test.ts`, `tests/server/version.test.ts`,
  `tests/integration/ingest-e2e.test.ts` (this is mechanical fallout of the
  version bump, not new behavior).
- `.claude/artifacts/loop/ai-loop/slices/pending/SLICE_427_*.md` — AC list
  was already scoped down to AC-1..AC-5 by the time I read it (done by a
  prior pass, not by me this session) — left as-is.

No changes to `src/distill/**` or `src/mcp/**` (out of scope per dispatch).

## AC evidence

[MODE] TDD — wrote `tests/storage/entity-relations.test.ts` before
`src/storage/entity-relations.ts` existed, then implemented until green.

- [CHECKPOINT] AC-1: pass — migration 027 creates `entity_relations` with
  the exact column set/nullability and the 4 required indexes; FK-cascade
  test confirms deleting a `memories` row cascade-deletes the citing
  relation row rather than throwing. Verified via `PRAGMA table_info` +
  `sqlite_master` index-SQL inspection in the test file.
- [CHECKPOINT] AC-2: pass — `insert()`'s dedup guard is a single
  `db.prepare(...).run(...)` call (`INSERT...SELECT...WHERE NOT EXISTS`);
  test asserts a second memory asserting the identical currently-valid
  triple is skipped (`inserted: false`, row count stays 1), a different
  predicate for the same pair is NOT deduped (distinct tuple), and a
  **closed** (`valid_to` set) prior row does not block a fresh insert —
  confirming the guard only checks `valid_to IS NULL` rows, matching
  design doc §3.4's "corroborating evidence" intent.
- [CHECKPOINT] AC-3: pass — `getForSubject`/`getForObject`/`getForEntity`
  join `memories` and compute effective validity via the MAX/MIN
  `+inf`-sentinel predicate (not `entity_relations.valid_to` alone). Test
  inserts a relation, calls `events.invalidate()` on its evidence memory,
  and confirms the relation is excluded once `asOf` passes the memory's own
  `valid_to` — while `entity_relations.valid_to` itself stays NULL,
  proving the exclusion comes from the join, not a filter on the relation
  row.
- [CHECKPOINT] AC-4: pass — `supersede()` now deletes every
  `entity_relations` row citing the old memory in the same transaction;
  test confirms rows citing a *different* memory are untouched by an
  unrelated `supersede()` call.
- [CHECKPOINT] AC-5: pass — `erase()` hard-deletes the memory; citing
  `entity_relations` rows are gone afterward with no FK-violation thrown
  (verified `not.toThrow()` plus a zero-orphan-rows check), confirming
  `ON DELETE CASCADE` + `foreign_keys=ON` handles this with no code in
  `erase()` itself — same shape as the existing `memory_entities` cascade
  test in `tests/storage/erasure.test.ts`.

## Verification commands run (real output)

```
$ bunx vitest run tests/storage/ tests/server/version.test.ts tests/integration/ingest-e2e.test.ts tests/doctor/schema-drift-check.test.ts
 Test Files  18 passed (18)
      Tests  274 passed (274)
```

```
$ bun run build   # tsc -p . — required before the daemon-spawn smoke test
                   # in ingest-e2e.test.ts, which execs dist/, not src/
$ (clean, no tsc errors)
```

```
$ bunx tsc --noEmit -p .
(clean — no output, exit 0)
```

```
$ bunx vitest run   # full repo suite, post-build
 Test Files  241 passed (241)
      Tests  2875 passed | 6 skipped (2881)
```

## Confidence
High for AC-1..AC-5 as scoped. The dedup-guard "atomicity" requirement
(AC-2) is verified by code inspection (single prepared statement, no
intervening `.get()`) plus behavioral tests — true concurrent-process
TOCTOU racing isn't exercised (would need a multi-process harness), but
that's consistent with how the sibling `memory_entities` partial-unique-index
guard is tested in this repo (`tests/storage/entity-validity.test.ts`).

## Risks / open questions
- None blocking. Two schema-version-bump side effects were fixed
  mechanically (test assertions, drift-guard error-message regex) — no
  behavior change beyond the new table.
- `docs/specs/FEAT-481-design.md` §4.1's exact SQL snippet has a redundant
  `MAX(COALESCE(er.valid_from, m.valid_from), m.valid_from)` (er.valid_from
  is NOT NULL so the COALESCE is a no-op) — kept as specified for literal
  parity with the design doc and with `memoryIdsForEntitiesAsOf`'s own
  shape, not a bug.

## Suggested next handoff
SLICE-2 (extraction wiring, `AtomRelationSchema` + `src/distill/prompts/
extract.ts`) is blocked on FEAT-479 per DEC-015/AC-8 — do not dispatch it
as an independent parallel builder. SLICE-3 (MCP tool surface,
`get_entity_related`/`get_entity_timeline`) only depends on this slice and
can proceed independently once ready.
