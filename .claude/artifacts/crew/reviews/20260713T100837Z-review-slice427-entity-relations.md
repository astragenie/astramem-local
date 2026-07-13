# Review: SLICE-427 — Migration 027 + EntityRelationRepo (FEAT-481)

**Verdict: PASS**

Scope reviewed: uncommitted working-tree changes for AC-1..AC-5 only
(`migrations/027-entity-relations.sql`, `src/storage/entity-relations.ts`,
`src/storage/memory-events.ts` supersede() cascade, `src/server/lib/wire-meta.ts`
SCHEMA_VERSION bump, `tests/storage/entity-relations.test.ts`, mechanical
26→27 fallout in 6 other test files). Reviewed against the ACs directly, not
the builder's handoff claims.

## AC-1 (migration 027 schema) — PASS
- Column set exact match to design doc §1: `id, subject_entity_id, predicate,
  object_entity_id, evidence_memory_id, source_excerpt NOT NULL, confidence
  REAL NOT NULL DEFAULT 0.5, valid_from NOT NULL, valid_to, invalidated_by,
  created_at`. Verified byte-for-byte against `docs/specs/FEAT-481-design.md`
  lines 184-196 — identical.
- CASCADE (not RESTRICT) on all three FKs, as specified (deliberate cloud
  divergence, documented rationale in the migration header).
- 4 indexes present: `(subject_entity_id, predicate)`, `(object_entity_id,
  predicate)`, `(valid_to)`, `(evidence_memory_id)` — `migrations/027-entity-relations.sql:71-81`.
- Migration style matches the established convention exactly: pure additive
  `CREATE TABLE` + indexes, `NNN-description.sql` naming, version parsed from
  the filename prefix by `migrate.ts:63-64`. This repo has no rollback
  mechanism for any migration (confirmed by reading `migrate.ts` — forward-only,
  transaction-wrapped, `schema_version` table tracks applied versions) so
  "rollback consistency" doesn't apply here any differently than to 023-026.
- `SCHEMA_VERSION` bumped 26→27 in `wire-meta.ts` with a changelog comment.
  Grepped the whole repo for stragglers: every other `SCHEMA_VERSION`/`26`
  reference is either the dynamic constant import (`doctor/checks.ts`,
  `routes/health.ts`, `routes/version.ts`, `migrate.ts`) or unrelated date
  substrings ("2026-07-...", "atom@2 (2026-07-09)") — no hardcoded stragglers
  left behind. The 6 test files with hardcoded `26` were all updated to `27`,
  and diffing confirms those are the *only* changes in those files (pure
  mechanical bump, no logic drift).

## AC-2 (atomic dedup guard) — PASS
`EntityRelationRepo.insert()` (`src/storage/entity-relations.ts:103-134`) is
genuinely one `db.prepare(...).run(...)` call — a single `INSERT ... SELECT
... WHERE NOT EXISTS`, no intervening `.get()`. This is real
check-and-insert-in-one-statement, not check-then-insert: SQLite evaluates
the `SELECT`'s `WHERE NOT EXISTS` guard as part of the same statement
execution, under the same write lock the `INSERT` itself takes, so there is
no window between "check" and "write" for a second writer to interleave —
that's what makes it race-safe under SQLite's single-writer model. A
required call-site comment is present (lines 87-101) explaining exactly this.

"Currently-valid duplicate" is precisely defined as `valid_to IS NULL` on
`entity_relations` itself (not the memories-joined effective validity used
for reads) — confirmed correct per design doc §3.4's "corroborating
evidence" framing, and distinct from AC-3's join semantics deliberately.
Tests cover: new insert (`inserted: true`), duplicate-same-tuple skip,
different-predicate-not-deduped, and closed-row-doesn't-block — all four
pass.

## AC-3 (JOIN-with-memories effective validity) — PASS
`getForSubject`/`getForObject`/`getForEntity` all join `memories` and apply
the `MAX`/`MIN` two-value scalar form (SQLite treats `MAX(a,b)`/`MIN(a,b)`
with 2+ args as scalar, not aggregate — confirmed this composes correctly)
with the `9223372036854775807` +inf sentinel for open ends, exactly mirroring
`memoryIdsForEntitiesAsOf` (`src/storage/entities.ts:223-238`) — same shape,
substituting `er.evidence_memory_id` for `me.entity_id`'s join target. The
"redundant" `COALESCE(er.valid_from, m.valid_from)` the builder flagged: `er.valid_from`
is `NOT NULL` so the COALESCE is provably a no-op — confirmed inert, and it's
literally what the design doc's own §4.1 SQL snippet specifies verbatim, so
keeping it is correct parity, not a bug.

Verified the asOf-exclusion negative case is actually tested, not just
claimed: `tests/storage/entity-relations.test.ts:279-304` inserts a relation,
calls `events.invalidate()` on its evidence memory, confirms
`entity_relations.valid_to` stays NULL (proving exclusion isn't a filter on
the relation row), and checks both sides of the boundary — visible for
`asOf` strictly before the memory's `valid_to`, excluded for `asOf` after it.
(Minor, non-blocking gap: the exact `asOf === valid_to` boundary itself isn't
tested — untested edge, not a wrong behavior, since the `> ?` predicate
correctly makes that boundary exclusive per the half-open convention used
throughout this codebase.)

## AC-4 (supersede() cascade, same transaction) — PASS
`src/storage/memory-events.ts:307`: `DELETE FROM entity_relations WHERE
evidence_memory_id = ?` sits inside `supersede()`'s existing
`this.db.transaction(() => {...})` closure (lines 273-324), directly after
the pre-existing `memory_entities` unlink (line 300) and before the event
append — genuinely the same transaction, not a follow-up call. Test confirms
both the positive case (old memory's relations deleted) and the negative
case (a different memory's relations untouched by an unrelated supersede).

## AC-5 (erase_memory CASCADE) — PASS
Confirmed `PRAGMA foreign_keys = ON` is set at connection setup
(`src/storage/db.ts:92`), which is the precondition for CASCADE to fire at
all — without it, CASCADE silently no-ops, which would have made this AC
false despite the schema looking correct. `MemoryEventRepo.erase()`
(`memory-events.ts:662-682`) has no explicit `entity_relations` cleanup code,
relying entirely on `ON DELETE CASCADE` — correct, since the FK is real and
enforcement is on. Test confirms: `erase()` doesn't throw, citing rows are
gone, and an explicit orphan-check query (`LEFT JOIN memories ... WHERE m.id
IS NULL`) returns zero rows.

## Verification run myself
```
$ bunx tsc --noEmit -p .
(clean, exit 0)

$ bunx vitest run tests/storage/
Test Files  15 passed (15)
     Tests  246 passed (246)

$ bunx vitest run tests/server/version.test.ts tests/integration/ingest-e2e.test.ts tests/doctor/
Test Files  17 passed (17)
     Tests  121 passed (121)
```
All green, matching the builder's reported numbers.

## Additional finding (post-verdict follow-up check)

**[LOW] `src/storage/entity-relations.ts:19`** — `OPEN_END_SENTINEL =
9223372036854775807` is a JS numeric literal for a value beyond
`Number.MAX_SAFE_INTEGER` (2^53-1), which is exactly what the TS diagnostic
("numeric literals with absolute values equal to 2^53 or greater are too
large to be represented accurately as integers") is warning about — this is
a real, verified precision defect, not a false positive. Confirmed with
node:

```
const OPEN_END_SENTINEL = 9223372036854775807;
OPEN_END_SENTINEL           -> 9223372036854776000   (JS stores it as 2^63 exactly, 9223372036854775808)
`${OPEN_END_SENTINEL}`      -> "9223372036854776000"  <- what actually gets spliced into the SQL text
```

So the SQL emitted by `VALIDITY_PREDICATE` never contains the digit
sequence the source declares (`...775807`) — it contains `...776000`, a
third, different, larger number produced by JS's shortest-round-trip
double-to-string conversion. `9223372036854776000` also exceeds SQLite's
real int64 max (`9223372036854775807`), so SQLite parses it as a REAL
literal rather than an INTEGER when it lands in that branch of `COALESCE`
(harmless — SQLite compares INTEGER/REAL by numeric value across type
affinities — but it's a type/value mismatch versus the intended sentinel).

**Does this change comparison semantics anywhere?** No, and it can't at any
value this codebase will ever produce: epoch-ms timestamps are ~1.7×10^12
today, twelve orders of magnitude below any of the three candidate "+inf"
values in play (source-declared 9223372036854775807, JS's actual stored
double 9223372036854775808, or the stringified 9223372036854776000). All
three are equally "infinity" for any real `valid_to`/`valid_from` this
repo will ever write. Confirmed no test exercises a value anywhere near
this magnitude — the discrepancy is real but currently unobservable.

**Does `memoryIdsForEntitiesAsOf` have the same construct?** No, and that's
the actual bug worth fixing. `src/storage/entities.ts:233-234` writes
`9223372036854775807` directly as literal text *inside* the SQL template
string (never as a standalone JS numeric expression) — TypeScript never
parses digits embedded in string-literal text as a numeric literal, so that
call site is immune to this problem entirely and reaches SQLite as the
exact, correct `9223372036854775807`. `entity-relations.ts` introduced a
regression relative to that established pattern by pulling the sentinel out
into a named top-level `const` and reaching it via `${...}` interpolation —
better intent (named, documented, no duplicated magic number across two
`COALESCE` calls) but it silently round-trips through a lossy JS `Number`
in the process.

**Recommended fix:** make `OPEN_END_SENTINEL` a **string** constant instead
of a number — `const OPEN_END_SENTINEL = '9223372036854775807';` — so no JS
numeric literal or `Number` value is ever created, template interpolation
splices the exact digit sequence verbatim, and the TS diagnostic disappears
because there is no numeric literal to warn about. This is strictly better
than either alternative floated: `Number.MAX_SAFE_INTEGER` would work
(still dwarfs any real timestamp) but silently changes the sentinel's
*meaning* away from "SQLite's actual max representable value," diverging
from the established convention for no benefit; a bare `COALESCE`-only
rewrite would need a different NULL-handling shape than the rest of this
codebase's bitemporal machinery already uses. Matching
`memoryIdsForEntitiesAsOf`'s literal-text convention (via a string, not a
duplicated magic number) is the right call — one line, `entity-relations.ts:19`.

**Verdict impact:** does not change the PASS — zero observable behavior
change today (verified above), not exercised by any test, and a trivial
one-line fix. Recommend fixing before merge as a correctness-of-intent
matter (self-inconsistent constant, diverges from house convention), not
as a blocking defect.

## Notes (non-blocking)
- Exact-boundary `asOf === valid_to` case is untested (see AC-3 above) —
  worth a follow-up assertion, not a gate blocker.
- Everything else in the handoff's "risks/open questions" section checks out
  as described.

## Findings summary
- [LOW] `src/storage/entity-relations.ts:19` — `OPEN_END_SENTINEL` numeric
  literal loses precision and round-trips to a different, wrong digit
  string when interpolated into SQL; recommend a one-line fix (string
  constant) to match `entities.ts`'s convention. Zero behavioral impact at
  any realistic timestamp magnitude; does not block PASS.

Verdict remains **PASS** — AC-1 through AC-5 are all correctly implemented
and independently verified; the one LOW finding above is a recommended
pre-merge cleanup, not a gate failure.
