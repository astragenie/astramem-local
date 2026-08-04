/**
 * tests/consolidate/consolidate-setup-vec-join.test.ts
 *
 * 2026-08-02 live-incident fix: `loadAtomsSetupBounded`'s SETUP-phase page
 * query used to join `memories` to `memories_vec` (existence filter only —
 * see `src/consolidate/consolidate.ts`'s `filterEmbeddedRowids` doc comment
 * for the production measurements). That join was pulled out into a
 * separate batched embedding-existence check run AFTER each page is
 * fetched. This file covers the one correctness hazard that rewrite
 * introduces: whether a page is "the last page" must be decided from the
 * RAW (unfiltered) page size, never the post-filter atom count — a page
 * can legitimately come back short on ATOMS (some of that page's memories
 * have no embedding yet) while the underlying `memories` scan still has
 * more rows waiting on later pages. Getting this boundary wrong silently
 * drops the corpus tail.
 */
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { runConsolidation } from '../../src/consolidate/consolidate.js';

/** Unit vector with all mass on one axis — used so seeded atoms are either
 *  orthogonal (never merge/propose) or identical (always merge/propose),
 *  giving an unambiguous behavioral signal for "was this atom loaded". */
function vecAt(axis: number): Float32Array {
  const v = new Float32Array(1024);
  v[axis] = 1;
  return v;
}

/** Inserts a memory row WITH a matching memories_vec row. */
async function seedEmbedded(db: DB, text: string, hash: string, vec: Float32Array): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
  await new SqliteVecStore(db).upsert(id, vec);
  return id;
}

/** Inserts a memory row with NO memories_vec row — the exact shape the
 *  embedding-existence filter must exclude (e.g. a just-ingested atom
 *  whose embed step hasn't run yet). */
function seedUnembedded(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

describe('runConsolidation setup phase — page/embedding-existence boundary (2026-08-02 fix)', () => {
  it('does not stop early when a page comes back short on ATOMS but the raw page was full', async () => {
    const db = openDb(':memory:');
    migrate(db);

    // pageSize (setupYieldEveryNAtoms) = 2. Insertion order fixes rowid
    // order (the ORDER BY's final tiebreaker), so pages land exactly as
    // laid out here:
    //   page 1 (offset 0, LIMIT 2): [unembedded, embedded-A]  -> raw len 2 (== pageSize, NOT last page)
    //   page 2 (offset 2, LIMIT 2): [embedded-B]               -> raw len 1 (<  pageSize, last page)
    // Filtered page 1 has only 1 atom (< pageSize) — under the bug this
    // fix closes, that would have been mistaken for "last page" and
    // embedded-B on page 2 would never load.
    seedUnembedded(db, 'no embedding yet', 'h-unembedded');
    await seedEmbedded(db, 'atom A', 'h-embedded-a', vecAt(0));
    await seedEmbedded(db, 'atom B', 'h-embedded-b', vecAt(0)); // identical vector to A -> guaranteed pair

    const summary = await runConsolidation(db, { setupYieldEveryNAtoms: 2 });

    expect(summary.setupBudgetExceeded).toBe(false);
    expect(summary.preemptedForHigherPriority).toBe(false);
    // Both embedded atoms loaded (across the page boundary) and paired —
    // identical vectors merge or propose. If atom B (page 2) had been
    // dropped, this group would have scanned a single atom and produced
    // neither a merge nor a proposal.
    const totalOutcomes = summary.merged.length + summary.proposed.length
      + summary.autoAcceptedProposals.length + summary.contradictionsProposed.length;
    expect(totalOutcomes).toBeGreaterThan(0);
    expect(summary.groupsScanned).toBe(1);
  });

  it('excludes memories with no embedding from the loaded atom set', async () => {
    const db = openDb(':memory:');
    migrate(db);

    // Two orphans (no vec row) sort BETWEEN the two real atoms in
    // (repo, type, created_at, rowid) order, so any accidental inclusion
    // would land them inside the same group as the real pair, not off to
    // the side. If they were wrongly loaded as atoms, either the pairwise
    // scan would produce extra merge/propose records referencing their
    // ids, or crash reading their nonexistent embedding — neither must
    // happen.
    const realA = await seedEmbedded(db, 'real atom A', 'h-real-a', vecAt(7));
    seedUnembedded(db, 'orphan 1', 'h-orphan-1');
    seedUnembedded(db, 'orphan 2', 'h-orphan-2');
    const realB = await seedEmbedded(db, 'real atom B', 'h-real-b', vecAt(7)); // identical vector to A -> guaranteed pair

    const summary = await runConsolidation(db);

    expect(summary.groupsScanned).toBe(1);
    const outcomes = [...summary.merged, ...summary.proposed];
    expect(outcomes.length).toBe(1); // exactly one pair compared — C(2,2), not C(4,2)
    const pairIds = [outcomes[0]!.winner, outcomes[0]!.loser].sort();
    expect(pairIds).toEqual([realA, realB].sort());
  });

  it('a page that is fully embedded behaves identically to before the fix (no regression)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    for (let k = 0; k < 6; k++) {
      await seedEmbedded(db, `atom ${k}`, `h-full-${k}`, vecAt(k)); // orthogonal — no pairs merge/propose
    }

    const summary = await runConsolidation(db, { setupYieldEveryNAtoms: 2 });

    expect(summary.setupBudgetExceeded).toBe(false);
    expect(summary.groupsScanned).toBe(1);
    // All 6 orthogonal atoms loaded and scanned as one group; C(6,2) = 15
    // pairs, none similar enough to merge or propose.
    expect(summary.merged).toEqual([]);
    expect(summary.proposed).toEqual([]);
  });
});
