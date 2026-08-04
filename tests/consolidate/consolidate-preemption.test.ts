/**
 * tests/consolidate/consolidate-preemption.test.ts
 *
 * FEAT-482 (worker-starvation wave, item 2/3 — the one item the earlier
 * fold left open, see tests/pipeline/queue-liveness-starvation.test.ts's
 * doc comment): priority tiers alone only help a job that is still PENDING
 * at claim time. Once a `consolidate` job is already `running`, nothing let
 * a burst of higher-priority (distill) work interrupt it — a single-lane
 * (or all-lanes-busy) deployment could still starve distill behind a long
 * consolidate pass. `ConsolidateOpts.preemptIfHigherPriorityPending` closes
 * that: checked at the same cadence as the existing cooperative yield
 * points (never on its own timer), it stops the run at a safe checkpoint
 * — same "degraded coverage this pass, remainder picked up next scheduled
 * pass" contract issue #387 already established for `setupBudgetMs` —
 * instead of running to completion.
 *
 * PR #463 review fix: the original version of this PR gated resume-cursor
 * persistence on `maxCandidatePairsPerRun` being configured. Under the
 * shipped default (no ceiling), a preempted run would silently re-scan the
 * exact same deterministic (repo, type, created_at) prefix every pass,
 * permanently starving whichever groups sort last. The tests below also
 * cover that fix directly.
 */
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { runConsolidation } from '../../src/consolidate/consolidate.js';
import { JobRepo, JOB_PRIORITY } from '../../src/pipeline/job-repo.js';
import { getConsolidationCursor } from '../../src/storage/consolidation-cursor.js';

/**
 * consolidate.ts builds each (repo, type) group's Map key by joining the
 * two fields with a literal NUL character (U+0000), not a space. Building
 * it via `String.fromCharCode(0)` here — rather than typing the character
 * directly into this source file — is deliberate: a raw NUL byte embedded
 * in a `.ts` file is invisible in most editors/diffs and is trivially
 * miscopied as a plain space (which happened while drafting this test).
 * Use `groupKey(repo, type)` wherever a test needs to assert against a
 * persisted resume-cursor value.
 */
const GROUP_KEY_SEPARATOR = String.fromCharCode(0);
function groupKey(repo: string, type = 'fact'): string {
  return `${repo}${GROUP_KEY_SEPARATOR}${type}`;
}

/** Unit vector with all mass on one axis — orthogonal atoms never merge or
 *  propose, isolating the preemption/coverage assertions from any
 *  similarity-tier side effect (same technique consolidate.test.ts's own
 *  yield-hook tests use). */
function vecAt(axis: number): Float32Array {
  const v = new Float32Array(1024);
  v[axis] = 1;
  return v;
}

async function seedEmbedded(
  db: DB, text: string, hash: string, vec: Float32Array,
  opts: { repo?: string; type?: 'fact' } = {},
): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: opts.type ?? 'fact', text, normalized_text: text.toLowerCase(),
    repo: opts.repo ?? 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
  await new SqliteVecStore(db).upsert(id, vec);
  return id;
}

describe('runConsolidation preemption — pair-scan phase', () => {
  let db: DB;

  it('stops mid-group once preemption is detected and skips every later group', async () => {
    db = openDb(':memory:');
    migrate(db);
    // Group A ('r1'/'fact'): 10 orthogonal atoms -> C(10,2) = 45 pairs —
    // sorts first (repo 'r1' < 'r2', see the SETUP-phase ORDER BY).
    for (let k = 0; k < 10; k++) {
      await seedEmbedded(db, `a ${k}`, `h-preempt-a-${k}`, vecAt(k), { repo: 'r1' });
    }
    // Group B ('r2'/'fact'): would be scanned next if the run weren't preempted.
    await seedEmbedded(db, 'b0', 'h-preempt-b-0', vecAt(20), { repo: 'r2' });
    await seedEmbedded(db, 'b1', 'h-preempt-b-1', vecAt(21), { repo: 'r2' });

    let checks = 0;
    const summary = await runConsolidation(db, {
      yieldEveryNPairs: 5, // checkpoint every 5 pairs, well inside group A's 45
      preemptIfHigherPriorityPending: () => {
        checks++;
        return checks >= 2; // false on the first checkpoint, true from the second on
      },
    });

    expect(summary.preemptedForHigherPriority).toBe(true);
    expect(summary.setupBudgetExceeded).toBe(false); // distinct reason, not conflated
    expect(summary.groupsScanned).toBe(1); // group B never reached
    expect(checks).toBeGreaterThanOrEqual(2);
    // PR #463 review fix: a resume cursor is now persisted even though no
    // maxCandidatePairsPerRun ceiling is configured — group B is next.
    expect(summary.resumeCursorUpdated).toBe(true);
    expect(getConsolidationCursor(db)?.groupKey).toBe(groupKey('r2'));
  });

  it('never preempts when the callback always returns false — byte-identical to omitting it', async () => {
    db = openDb(':memory:');
    migrate(db);
    for (let k = 0; k < 10; k++) {
      await seedEmbedded(db, `a ${k}`, `h-nopreempt-a-${k}`, vecAt(k), { repo: 'r1' });
    }
    await seedEmbedded(db, 'b0', 'h-nopreempt-b-0', vecAt(20), { repo: 'r2' });
    await seedEmbedded(db, 'b1', 'h-nopreempt-b-1', vecAt(21), { repo: 'r2' });

    const summary = await runConsolidation(db, {
      yieldEveryNPairs: 5,
      preemptIfHigherPriorityPending: () => false,
    });

    expect(summary.preemptedForHigherPriority).toBe(false);
    expect(summary.groupsScanned).toBe(2); // both groups scanned, nothing skipped
    // A run that never stops early, with no ceiling and no pre-existing
    // cursor, never touches the cursor table at all — stays fully untouched
    // (a bare `null`, not even a `{groupKey: null}` row), matching the
    // byte-identical-to-pre-P2.1 contract.
    expect(summary.resumeCursorUpdated).toBe(false);
    expect(getConsolidationCursor(db)).toBeNull();
  });

  it('PR #463 review fix: resume cursor rotates monotonically across repeated preempted runs with NO ceiling configured', async () => {
    db = openDb(':memory:');
    migrate(db);
    // Group A ('r1'/'fact'): 6 orthogonal atoms -> C(6,2) = 15 pairs.
    for (let k = 0; k < 6; k++) {
      await seedEmbedded(db, `a ${k}`, `h-monotonic-a-${k}`, vecAt(k), { repo: 'r1' });
    }
    // Group B ('r2'/'fact'): same shape, sorts after A both by repo name
    // and by created_at (seeded strictly later).
    for (let k = 0; k < 6; k++) {
      await seedEmbedded(db, `b ${k}`, `h-monotonic-b-${k}`, vecAt(20 + k), { repo: 'r2' });
    }
    expect(getConsolidationCursor(db)).toBeNull();

    // Run 1: preempt at the very first checkpoint, no ceiling configured —
    // exactly the shipped default (`maxCandidatePairsPerRun: null`) the
    // review flagged. Before the fix, the cursor write was gated behind
    // `ceilingActive` and this would be silently skipped.
    const summary1 = await runConsolidation(db, {
      yieldEveryNPairs: 3,
      preemptIfHigherPriorityPending: () => true,
    });
    expect(summary1.preemptedForHigherPriority).toBe(true);
    expect(summary1.resumeCursorUpdated).toBe(true);
    expect(summary1.groupsScanned).toBe(1); // only group A reached

    const cursorAfterRun1 = getConsolidationCursor(db);
    expect(cursorAfterRun1?.groupKey).toBe(groupKey('r2')); // group B is next

    // Run 2: preempt at the first checkpoint again. Before the fix, this
    // would restart from the SAME natural-order prefix (group A) every
    // time — the cursor would never be read without a ceiling — leaving
    // group B (and anything sorting after it) permanently unreached. With
    // the fix, run 2's group order is rotated to start at the persisted
    // cursor (group B), so THIS run reaches B instead of re-scanning A.
    const summary2 = await runConsolidation(db, {
      yieldEveryNPairs: 3,
      preemptIfHigherPriorityPending: () => true,
    });
    expect(summary2.preemptedForHigherPriority).toBe(true);
    expect(summary2.resumeCursorUpdated).toBe(true);
    expect(summary2.groupsScanned).toBe(1); // only group B reached this time

    const cursorAfterRun2 = getConsolidationCursor(db);
    // The rotation genuinely moved forward — NOT stuck re-persisting the
    // same group key pass after pass (the exact bug this fix closes).
    expect(cursorAfterRun2?.groupKey).not.toBe(cursorAfterRun1?.groupKey);
    expect(cursorAfterRun2?.groupKey).toBe(groupKey('r1')); // wrapped back to the only other group
  });

  it('a real JobRepo-backed callback preempts once a distill job is actually enqueued mid-run', async () => {
    db = openDb(':memory:');
    migrate(db);
    for (let k = 0; k < 10; k++) {
      await seedEmbedded(db, `a ${k}`, `h-preempt-real-${k}`, vecAt(k), { repo: 'r1' });
    }
    const jobRepo = new JobRepo(db);
    let distillEnqueued = false;

    // Exercises the EXACT production shape (consolidateHandler wires
    // `preemptIfHigherPriorityPending` to
    // `() => jobRepo.hasPendingAbovePriority(JOB_PRIORITY.consolidate)`)
    // against a real jobs table, not a fake boolean — proves the wiring,
    // not just the internal control flow. `onYield` (an existing test-only
    // observability hook, never used in production) enqueues a distill job
    // the first time a yield checkpoint fires; the run must self-preempt at
    // the *next* checkpoint once that job is visible as pending.
    const summary = await runConsolidation(db, {
      yieldEveryNPairs: 5,
      preemptIfHigherPriorityPending: () => jobRepo.hasPendingAbovePriority(JOB_PRIORITY.consolidate),
      onYield: () => {
        if (!distillEnqueued) {
          distillEnqueued = true;
          jobRepo.enqueue('distill', { transcript_id: 't1', session_id: 's1' });
        }
      },
    });

    expect(distillEnqueued).toBe(true);
    expect(summary.preemptedForHigherPriority).toBe(true);
  });
});

describe('runConsolidation preemption — setup phase (atom load)', () => {
  it('stops loading atoms once preemption is detected and never scans a single group this pass', async () => {
    const db = openDb(':memory:');
    migrate(db);
    // 6 atoms, tiny page size -> multiple pages, several preempt checkpoints.
    for (let k = 0; k < 6; k++) {
      await seedEmbedded(db, `a ${k}`, `h-preempt-setup-${k}`, vecAt(k), { repo: 'r1' });
    }

    let checks = 0;
    const summary = await runConsolidation(db, {
      setupYieldEveryNAtoms: 2, // page size 2 -> checkpoint after every page
      preemptIfHigherPriorityPending: () => {
        checks++;
        return checks >= 1; // preempt at the very first setup checkpoint
      },
    });

    expect(summary.preemptedForHigherPriority).toBe(true);
    // issue #387's existing contract: when atom-loading itself is cut
    // short, the pair-scan group loop never starts this pass (every
    // group's deadline check would fail immediately anyway) — preemption
    // reuses that same short-circuit, so no group gets scanned either.
    expect(summary.groupsScanned).toBe(0);
    expect(summary.setupBudgetExceeded).toBe(false); // distinct reason, not conflated
    // No group was ever reached, so there's no meaningful group-level
    // resume point to persist — resumeCursorUpdated correctly stays false
    // (distinct from the pair-scan-phase preemption case, which always has
    // at least one fully-scanned or partially-scanned group to resume from).
    expect(summary.resumeCursorUpdated).toBe(false);
    expect(getConsolidationCursor(db)).toBeNull();
  });
});
