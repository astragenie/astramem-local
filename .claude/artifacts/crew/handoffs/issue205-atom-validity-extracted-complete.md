# Handoff: issue #205 — atom-level validity extraction (COMPLETE, PR open)

## Objective
Fix issue #205: extracted facts never carried a validity interval, so a
fact true Jan-Mar and false since read as eternally valid. Storage
(`valid_from`/`valid_to`) and retrieval (`validityFilterClause()`) were
already correct — nothing on the write side populated `valid_to` from
extraction.

## Owner
fix-205-validity (this session), branch `fix/205-atom-validity-extracted`,
worktree `C:\work\mega\astramemory-local-worktrees\fix205`.

## Operator decision followed (not re-litigated)
`valid_to` semantics unchanged — `NULL` = valid now. `validityFilterClause()`
NOT touched. Added a separate `validity_extracted` provenance column
(default 0) instead of overloading NULL — see issue #205's pinned comment
and this PR's description for the full reasoning (why redefining NULL was
a trap: either nukes 15,492 existing memories from `as_of` queries, or is
byte-identical to today).

## Deliverable
PR #216: https://github.com/astragenie/astramem-local/pull/216

## Migration number
**036** (`migrations/036-atom-validity-extracted.sql`), `SCHEMA_VERSION`
32 -> 36. Renumbered THREE times as concurrent migration-adding PRs kept
landing first for whatever number this branch had most recently claimed —
each renumber was caught by re-verifying directly against `origin/main`
(`git ls-tree origin/main -- migrations/`), never by trusting a prior
assignment (including my own earlier messages):
1. Claimed 033 — lost to PR #208 (silent-error audit,
   `033-consolidation-judge-errors.sql`), which merged first.
2. Reassigned to 035 by the coordinator (team-lead), on the belief that
   034 belonged to `fix-188-schema-hash` (PR #212, then still open).
   Rebased onto that assumption and pushed — but a re-check turned up
   that 034 had ALREADY been taken by a third concurrent PR, #218
   (`fix-207-entity-quality`, merged `034-entity-name-drops.sql`) before
   the assumption was made. Reported this immediately (it meant #212 was
   about to collide with an already-merged 034) and rebased again onto
   the corrected main tip.
3. Rebased and pushed at 035 — then #212 (`fix-188`) itself merged
   `035-schema-version-content-hash.sql` moments later, colliding with
   the exact number I'd just landed on. Renumbered a third time to
   **036**, rebasing onto that final main tip (`5672fec`, includes PRs
   #208/#218/#212/#219).
`main` is now contiguous 001-035; this branch adds 036 on top with no
missing number. Any FOURTH concurrent migration PR must re-verify against
`origin/main` live before picking a number — do not reuse any number
mentioned anywhere in this doc's history above, all of them are now taken.

## Changed files
- `migrations/036-atom-validity-extracted.sql` (new, renumbered 033 -> 035
  -> 036 mid-flight — see Migration number above)
- `src/server/lib/wire-meta.ts` — SCHEMA_VERSION 32 -> 36
- `src/contracts/memory.ts` — `Memory.validity_extracted: boolean`
- `src/storage/memories.ts` — `InsertInput.valid_to`/`validity_extracted`,
  `insertRow` SQL now includes both (valid_to was previously omitted from
  the INSERT entirely — unwritable through the repo regardless of caller
  intent), hydrate() converts the INTEGER 0/1 to boolean
- `src/distill/prompts/extract.ts` — `AtomSchema.valid_at`/`invalid_at`;
  prompt guidance + few-shot examples (Postgres->Kafka / life-timeline) in
  both the engineering v3 default and the conversational profile; explicit
  distinction from the pre-existing "final state only" rule. v1/v2 (legacy
  rollback prompts) deliberately left untouched — scoped out, documented.
- `src/distill/stages/08-embed-index.ts` — wires `mem.valid_at`/`invalid_at`
  into `InsertInput.valid_from`/`valid_to`, passes `validity_extracted: true`
  unconditionally (every atom through this pipeline now has the schema
  field available, regardless of whether a bound was found)
- `src/doctor/checks.ts` — new "Atom validity extraction" canary (rate-based,
  ADR-015-compliant; WARNs only on real activity + flat 0%)
- Tests: `tests/distill/prompts/extract.test.ts`,
  `tests/search/as-of.test.ts` (Postgres->Kafka AC-6 scenario + unbounded +
  legacy-row tests), `tests/storage/memories.test.ts`,
  `tests/doctor/atom-validity-extraction-check.test.ts` (new)
- Repo-wide: every hardcoded `schema_version`/`MAX(version)` test literal
  bumped to 36 (9 files, across three rounds tracking the 033 -> 035 -> 036
  renumbers) after confirming each was schema-version-related, not an
  incidental numeric coincidence

## Confidence
High. `validityFilterClause()` byte-diff confirmed unchanged; full
`tests/search/as-of.test.ts` FEAT-401 suite (pre-existing, untouched logic)
passes unmodified alongside new issue-#205 tests in the same file.

## Verification (post-rebase onto main @ 5672fec, includes PRs #208/#218/#212/#219)
- `bunx tsc --noEmit` — clean
- `bun run build` — clean
- `bunx vitest run` — re-run pending as of this edit; prior run at the 035
  rebase point was 266 files, 265 passed, 1 pre-existing unrelated flaky
  failure, 6 skipped, with `tests/storage/migration-renumber.test.ts`
  green (contiguous, no gap). Re-verifying at 036 next.
- Merged conflicting file changes cleanly across BOTH rebases: PR #218
  touched `src/distill/prompts/extract.ts`, `src/doctor/checks.ts` (added
  `checkEntityNameQuality`, interleaved with my `checkAtomValidityExtraction`
  at the same insertion point — reconstructed both as separate complete
  functions, both now registered in `coreChecks`), `src/server/lib/
  wire-meta.ts`, and most of the schema-version-literal test files. PR
  #212 (fix-188) touched `src/server/lib/wire-meta.ts` and the same test
  files again for its own 035 entry — resolved by keeping #212's real 035
  content and appending mine as 036 immediately after.

## Risks / open questions
- All of 033/034/035 are now taken (PR #208, PR #218, PR #212
  respectively) and 036 is this branch's. Any further concurrent migration
  PR must re-verify against `origin/main` live at push time — do not trust
  any number mentioned in this document, including this line, without
  re-checking `git ls-tree origin/main -- migrations/` first.
- The doctor canary's denominator (all recent memories, not just
  distill-sourced ones) is a documented caveat in its own doc comment — a
  `/remember`-heavy repo will show a rate below 100% even when healthy;
  this is intentional (no discriminator column exists to separate the two
  populations without scope creep).

## Suggested next handoff
Reviewer pass on PR #216. Migration numbering is now fully resolved and
green (no outstanding gap) — the only remaining external dependency is
making sure `fix-188` picks a genuinely free number on their next push.
