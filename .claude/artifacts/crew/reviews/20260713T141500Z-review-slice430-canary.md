# Review: FEAT-481 SLICE-430 — "Entity relations extraction" doctor canary + relation_guard_drops

**Reviewer**: crew:reviewer (independent, read-only)
**Worktree reviewed**: `C:\work\mega\astramemory-local\.claude\worktrees\agent-aa6b733f1bc85f9ad` (uncommitted; ancestors `a3138a2`/`e78a2f4`)
**Verdict: NEEDS_FIX** (one real correctness bug; everything else checks out)

## Scope reviewed

- `migrations/029-relation-guard-drops.sql` (new)
- `src/storage/relation-guard-log.ts` (new)
- `src/server/lib/wire-meta.ts` (SCHEMA_VERSION 28→29)
- `src/doctor/checks.ts` (new `checkEntityRelations`)
- `src/distill/pipeline.ts`, `src/distill/stages/05-extract.ts`, `src/distill/stages/08-embed-index.ts` (guard-drop counter wiring)
- `tests/doctor/entity-relations-check.test.ts` (new), plus mechanical 28→29 edits across 8 test files
- `README.md`, `CLAUDE.md` (docs)

## 1. Is the migration + schema bump justified?

**Yes, on both counts.**

- The persistent table is the right call, not a cheaper substitute: doctor runs in a **separate CLI process** from the daemon, so an in-memory counter would never be visible to it. The 7-day-window query (`totalRelationGuardDrops(db, since)`, used at `src/doctor/checks.ts:1247`) needs to survive process restarts and be queryable cross-process — only a table does that. The design mirrors the existing `redaction_log` (migration 005) precedent field-for-field (`src/storage/relation-guard-log.ts:1-9` says so explicitly, and I diffed it against `src/storage/redaction-log.ts` — same shape, same "counts + reason only, never raw values" discipline).
- The SCHEMA_VERSION bump is **not a discretionary choice the builder made** — it's mechanically enforced. `tests/storage/migrate.test.ts:938-943` ("schema-version drift guard") asserts `migrate()` throws if the `SCHEMA_VERSION` constant doesn't match the DB's actual max applied version. Any new migration file *requires* this bump; every one of migrations 023-028 did the same. There was no separate judgment call to flag here beyond "should this be a migration at all" (answered above: yes).
- Wire-visibility: `schema_version` is exposed via `GET /health`/`GET /version` (verified in `tests/integration/ingest-e2e.test.ts` and `tests/server/version.test.ts`) but is informational metadata, not a protocol-compat gate (that's `wire_version`, per CLAUDE.md's wire contract section) — consistent with how 023-028 already moved this number without incident.

## 2. Migration correctness

- **Idempotent**: yes — `migrate()`'s per-file `applied` set (`src/storage/migrate.ts`) skips already-applied versions; 029 is a plain `CREATE TABLE`/`CREATE INDEX`, nothing conditional to get wrong.
- **Fresh DB**: exercised by every `migrate.test.ts` test that calls `migrate(openDb(':memory:'))` and asserts `MAX(version) === 29`.
- **Upgrade from 28 with data present**: `tests/storage/upgrade-path.test.ts` runs the real v12→current fixture (`datadir-v12`, real memories/entities/memory_events rows) through `migrate()` and asserts `versionRow.v === 29` plus zero data loss on the pre-existing tables (`AC-1`). It does *not* specifically assert data survives a 28→29 hop with existing `relation_guard_drops` rows — but 029 has no data-migration step (just `CREATE TABLE`), so there's nothing there to lose. This is adequate.
- **No vec-table hand-edit**: confirmed — 029 touches nothing under `memories_vec`; `DEFAULT_EMBED_DIM`/`__EMBED_DIM__` are irrelevant here and untouched.

## 3. The 8 mechanical 28→29 test edits

Diffed every hunk in `tests/storage/migrate.test.ts`, `upgrade-path.test.ts`, `atom-v3.test.ts`, `entities.test.ts`, `entity-relations.test.ts`, `entity-validity.test.ts`, `tests/server/version.test.ts`, `tests/integration/ingest-e2e.test.ts`. **Every single changed `28`→`29` is a genuine schema-version assertion** (`MAX(version)`, `schema_version` field, or a comment enumerating migration history). No coincidental unrelated literal `28` was touched. Comments were updated in lockstep with the assertions (e.g. `migrate.test.ts:41-49`, `entity-validity.test.ts:50`).

## 4. `checkEntityRelations` logic

State machine verified against `tests/doctor/entity-relations-check.test.ts` (5 cases, all passing for real — see below) and against the source:
- No DB yet → `ok:true` informational.
- Below `MEANINGFUL_USAGE_THRESHOLD` (20, same constant `checkAutoCapture`/`checkUsefulnessFeedbackLoop` already gate on) → `ok:true`, not enough signal.
- `entity_relations` has rows → `ok:true`, reports total/7d/newest-age.
- Zero rows, threshold crossed → `ok:false` WARN, message branches on `guardDrops7d` (`> 0` → "guard is dropping every one" vs `=== 0` → "model itself is not emitting") — correct and matches the two-file-write design.
- `extractProfile === 'conversational'` → stays `ok:true` regardless of activity. I checked this against `src/distill/prompts/extract.ts`'s own SLICE-435 update comment (line ~499-511): `relations[]` guidance was added to the engineering prompt **only**, explicitly not extended to the conversational profile ("no design-doc direction to add it there"). The exemption is factually correct, not a guess.
- WARN threshold of 20 is reused from existing precedent in the same file, not a new number invented for this check — defensible.

No false-WARN risk identified for a legitimately quiet store (the 20-memory floor gates that).

## 5. Counter write sites — no double-count, but **one real non-fatal-write gap**

Aggregation logic is correct:
- `filterAtomRelations` (`05-extract.ts`) mutates one shared `dropCounts` object per **chunk**, across all atoms in that chunk — no double counting within a chunk.
- `pipeline.ts:149-159` sums `relationDropCounts` across **all chunks** in the run and writes once per run, keyed by reason.
- `08-embed-index.ts` accumulates `unresolvableRelationDrops` as a single scalar across the whole per-memory loop and writes once (only if `>0`) under its own distinct reason (`unresolvable_at_write`), so it can never double-count against the stage-5 reasons.

**However — the "must never take down the pipeline" requirement is not met.** Both call sites invoke `recordRelationGuardDrops(ctx.db, ...)` with no surrounding `try/catch`:

- `src/distill/pipeline.ts:155-159` — this call sits *inside* the stage-5 `try` block (`pipeline.ts:139-167`). If the INSERT throws (SQLITE_BUSY under contention, disk-full, etc. — this repo's own CLAUDE.md notes concurrent daemons/eval shards on the same box), the exception is caught by the stage's own catch handler, logged as `'stage failed'` with `error_kind` from the driver error (not `ExtractBudgetExceeded`), and **re-thrown** (`pipeline.ts:166`). That discards a **successful** extraction — real atoms were produced, LLM cost was already spent — and surfaces it to the caller as an extract-stage failure, presumably triggering the job-level retry the code comments describe for parse failures. A diagnostic counter write is not supposed to be able to cause that.
- `src/distill/stages/08-embed-index.ts:282-288` — this call happens *after* the entire per-memory loop (memories, entities, vec upserts, `entity_relations` rows) has already been written successfully. It's still unguarded, so a write failure here throws out of `embedAndIndex()` even though every real write for the stage already landed — same class of spurious-failure risk, now for stage 8.

This directly contradicts the review brief's own framing ("a diagnostic must never take down the pipeline") and the discipline the new doctor check itself follows one function over — `checkEntityRelations`'s own catch-all (`src/doctor/checks.ts` bottom of the function) explicitly treats any query error as non-fatal ("never fail doctor over a metric query error"). The write side should hold itself to the same standard and currently doesn't.

**[MEDIUM] `src/distill/pipeline.ts:155-159` and `src/distill/stages/08-embed-index.ts:282-288`: `recordRelationGuardDrops` calls are unguarded — a DB write failure on this diagnostic counter can fail/retry an otherwise-successful extract or embed-index stage. Fix: wrap each call in its own `try { ... } catch (err) { pipeLog.warn(...); }` (or equivalent) so a counter-write failure is logged and swallowed, never propagated.**

This is not a hypothetical-only concern — it's the exact question the task brief asked me to check, and the answer is that it currently fails that bar.

## 6. README / CLAUDE.md accuracy

- **"29 migrations"**: `ls migrations/*.sql` = 29 files on disk. Matches.
- **"20-tool MCP surface"**: the full `contracts/manifests/mcp-tools.v1.json` has 36 entries total, but that count includes 16 `owner: "cloud"`-only tools not registered by this daemon. Filtering to `owner === 'local' || owner === 'both'` gives exactly **20**, and that 20-name set is byte-for-byte identical to the 20 rows in README's own MCP tools table (`README.md:260-279`, including the two new rows `get_entity_related`/`get_entity_timeline`). Claim is accurate — my first pass miscounted by using the raw manifest total instead of filtering by owner.
- CLAUDE.md's new "Entity relations (FEAT-481)" section accurately describes the table, the two MCP tools, the canary, and the drop-reason distinction — consistent with the code.

## 7. Real command output

Ran both in the worktree, not trusted from the builder's claim:

```
$ bunx tsc --noEmit -p .
(no output — clean)

$ bunx vitest run
 Test Files  248 passed (248)
      Tests  3013 passed | 6 skipped (3019)
   Duration  42.31s
```

Matches the builder's claimed 248 files / 3013 pass exactly.

## Summary

Everything except item 5 is solid: the migration is justified and correct, the schema bump is an unavoidable mechanical consequence (not a discretionary risk), all 8 mechanical test edits are genuine, the doctor state machine and its conversational-profile exemption are factually grounded in the actual prompt code, fixtures cover all three AC-13 cases, and both README/CLAUDE.md claims check out against real counts. Tests and typecheck are green for real.

The one finding is real and actionable: **wrap the two `recordRelationGuardDrops` call sites in non-fatal error handling** before this ships, so a diagnostic-counter write can never turn a successful extraction or embed-index run into a spurious pipeline failure/retry.
