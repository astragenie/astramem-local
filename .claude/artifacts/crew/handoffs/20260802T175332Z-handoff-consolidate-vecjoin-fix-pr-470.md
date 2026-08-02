# Handoff: consolidate setup-phase vec-join wedge — fix implemented, PR open

**Objective:** Fix live incident — production daemon hard-wedges at boot because `loadAtomsSetupBounded`'s paged atom-load query (`src/consolidate/consolidate.ts`) joins `memories` to `memories_vec` as a pure existence filter, and that join plan scans the vec0 virtual table per outer row instead of using an efficient rowid probe.

**Owner:** builder (this session), worktree `C:\work\mega\wt-vecjoin`, branch `fix/consolidate-setup-vec-join`.

**Allowed scope:** `loadAtomsSetupBounded` and its paged query only. Migration 062's index stays unchanged (it becomes exactly right once the vec join is removed from the paged query). Did not touch the 3 stray NUL bytes in `consolidate.ts` (separate concern, left the diff reviewable per instruction).

**Forbidden scope:** did not touch the running daemon, real dataDir, or any other consolidate.ts logic (pairwise scan, contradiction detection, dup-judge, cursor rotation) — none of that was in play.

**Deliverable:** [PR #470](https://github.com/astragenie/astramem-local/pull/470) (draft), branch pushed to origin.

## What changed

- `src/consolidate/consolidate.ts`:
  - `loadAtomsSetupBounded`'s query no longer joins `memories_vec` — pages `memories` alone (migration 062's covering index drives a pure index walk).
  - New `filterEmbeddedRowids(db, rowids)` helper: batched `SELECT rowid FROM memories_vec WHERE rowid IN (...)`, capped at 500 rowids/batch (`VEC_EXISTENCE_CHECK_BATCH_SIZE`), run once per page AFTER the page is fetched.
  - Boundary fix: "last page" is decided from the RAW (unfiltered) page length, never the post-filter atom count — a page can come back short on atoms (some memories in it lack an embedding) while more pages remain; deciding from the filtered count would have silently dropped the corpus tail.
- `tests/storage/migrate.test.ts`: migration 062's test updated — the "exact query text from loadAtomsSetupBounded" comment now matches the new memories-only query (the old version tested a now-dead JOIN shape). Added an assertion that `memories_vec`/`v` never appears in the paged statement's `EXPLAIN QUERY PLAN`.
- `tests/consolidate/consolidate-setup-vec-join.test.ts` (new): 3 tests against the real `runConsolidation` covering the page/filter boundary, embedding-existence exclusion (proven via merge/propose winner/loser ids, not just counts), and a no-regression check for a fully-embedded corpus.

## Measurements (see PR body for full detail)

- Old JOIN query on a 90k-row synthetic corpus: page 1 = 66ms, offset 25,000 = 3,448ms, offset 60,000 = **13,297ms** (one sync call per page — this is what wedged the daemon).
- New query alone: 53–92ms per page regardless of offset.
- IN-batch existence filter (500 rowids): 21ms. Per-rowid point-probe loop: 153ms (~7x slower) — IN-batch shipped.
- Validated against the REAL shipped code (not a hand-copied query): `runConsolidation` over a 90k-row DB, single-atom groups to isolate the setup phase from the unrelated O(n²) pairwise scan — 180 pages, max single page 42ms, 4.8s total, zero pages over 250ms or 1000ms.

## Test evidence

- Full suite: 5669 tests. 4 failures on first full-suite run (`tests/doctor/migration-self-heal-check.test.ts`, `tests/tag-hygiene/repo-identity-backfill.test.ts`, `scripts/eval/shared/detach.test.ts`) — all timeouts/flakes unrelated to this diff (different subsystems), confirmed passing in isolation on rerun. Resource contention from the full parallel run, not caused by this change.
- `bun run build` clean.

## Confidence level

High on correctness and the timing fix itself (measured against real 90k-row data through the actual shipped code path, not synthetic assumptions). Medium on "this fully resolves the live incident" — that requires the deployer to actually ship this and confirm the production daemon no longer wedges at boot; this session did not touch the running daemon or deploy anything (out of scope per the dispatch).

## Risks / open questions

- OFFSET's own O(offset) row-skip cost is still present (deliberately out of scope, per migration 062's own doc comment — tracked as a 0.22.1 follow-up for keyset pagination). Not a regression from this fix; pre-existing and still fast enough at current corpus sizes (measured 42ms max at 90k rows).
- `VEC_EXISTENCE_CHECK_BATCH_SIZE = 500` is a new constant, independent of `setupYieldEveryNAtoms`. If a caller ever configures a much larger yield/page size, the existence check still safely batches at 500 regardless — no risk of exceeding SQLite's bound-parameter limit.

## Suggested next handoff

Reviewer → `crew:reviewer` (or `/crew:review`) on PR #470, focusing on: the boundary-semantics correctness (raw vs filtered page length), the IN-batch parameter-batching safety, and whether the doc-comment measurements are trustworthy evidence for a live-incident fix. After review PASS, deployer: ship + verify the production daemon boots cleanly (this is the step that actually closes the incident — this handoff only closes the code fix).
