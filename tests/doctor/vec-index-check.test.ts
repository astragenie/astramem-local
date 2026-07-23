/**
 * tests/doctor/vec-index-check.test.ts
 *
 * Issue #209 follow-up (after PR #250 / #231): the "Vec-index orphans"
 * doctor row — a RATE canary (K of N active memories flagged
 * needs_vec_index=1) per ADR-015 rule 6, not an existence check, plus the
 * REAL-zero/BROKEN-zero split (rule 1) for a DB that predates migration
 * 041 and has no `needs_vec_index` column at all.
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/atom-validity-extraction-check.test.ts) since the check
 * opens `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

/** Seeds `n` active memories; the first `orphans` of them are flagged
 *  needs_vec_index=1 via the real MemoryRepo.markNeedsVecIndex path (not
 *  raw SQL) so the test exercises the same write surface production uses. */
function seedMemories(dbPath: string, n: number, orphans: number): void {
  const db = openDb(dbPath);
  migrate(db);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  for (let i = 0; i < n; i++) {
    const { id } = repo.insertWithCreateEvent(
      {
        type: 'fact', text: `seed memory ${i}`, normalized_text: `seed memory ${i}`,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      },
      events,
    );
    if (i < orphans) repo.markNeedsVecIndex(id);
  }
  db.close();
}

/** Seeds one ARCHIVED orphan directly via raw SQL (no repo setter for
 *  `archived` exists) to prove archived rows are excluded from both the
 *  numerator and the denominator. */
function seedArchivedOrphan(dbPath: string): void {
  const db = openDb(dbPath);
  migrate(db);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  const { id } = repo.insertWithCreateEvent(
    {
      type: 'fact', text: 'archived orphan', normalized_text: 'archived orphan',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    },
    events,
  );
  repo.markNeedsVecIndex(id);
  db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(id);
  db.close();
}

describe('doctor "Vec-index orphans" check (issue #209 follow-up)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-vec-index-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check() {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false }),
      'Vec-index orphans',
    );
  }

  it('no DB yet — ok:true, informational', async () => {
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBeFalsy();
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists but below MEANINGFUL_USAGE_THRESHOLD active memories — ok:true, not enough activity', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 5, 0);
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough active memories');
    expect(result.message).toContain('5 active');
  });

  // ─── GREEN: genuinely healthy store, real volume ───────────────────────────
  it('>= threshold volume, 0 orphans — ok:true, states the denominator', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 25, 0);
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBeFalsy();
    expect(result.message).toContain('0 of 25');
    expect(result.message).toContain('0.000%');
  });

  // ─── INCONCLUSIVE: orphans exist but this check cannot verify they're
  // harmless ("ok: true" is reserved for VERIFIED healthy, not "not enough
  // to page anyone") ─────────────────────────────────────────────────────────
  it('a handful of orphans below the alarm floor — inconclusive, NOT verified healthy', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 30, 3);
    const result = await check().run();
    expect(result.ok).toBe(true); // never hard-fails doctor's exit code on this
    expect(result.inconclusive).toBe(true); // but is NOT a clean bill of health
    expect(result.message).toContain('3 of 30');
    expect(result.message.toLowerCase()).toContain('cannot distinguish');
  });

  // THE TEST THAT IS THE ENTIRE POINT OF THIS PR.
  //
  // The incident that motivated this canary (#209/#250): production had 13
  // of 18,863 active memories (0.069%) permanently unrecallable by vector
  // search, with every write returning a green response. 13 is well under
  // any count-based alarm floor this check could defensibly set — so if
  // this branch returned `ok: true`, the canary would be GREEN while
  // replaying its own founding incident. That is precisely the "green
  // while broken" shape ADR-015 exists to kill (see issue #200's ~87%
  // entity-extraction failure, the ADR's own headline example).
  //
  // `inconclusive: true` is what makes 13 stuck orphans visible to anything
  // that alarms on `inconclusive > 0` — `ok: true` alone would make them
  // indistinguishable from zero to every machine-readable consumer
  // (CI gates, alerting, an automated loop), even though a human reading
  // full `doctor` table output would still see the count in the message.
  //
  // 13 IS THE LOAD-BEARING NUMBER (it's below the MEANINGFUL_USAGE_THRESHOLD
  // floor of 20) — the branch under test only cares about "orphanCount <
  // floor", not corpus size, so the denominator here is a small, fast stand-
  // in (~60 total) rather than the real production 18,863. Do NOT "restore
  // realism" by inflating this back up — the real figure is already on the
  // record in vec-index.ts's file doc comment, and paying 18,863 real
  // sequential inserts through the repo write path costs ~20-30s per run
  // (proven flaky in review: it exceeded its own 20s timeout on a loaded
  // box) for zero additional proof.
  it('replays the founding incident (13 orphans, below the alarm floor) — does NOT render as verified-healthy', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 60, 13);
    const result = await check().run();
    expect(result.ok).toBe(true); // not a hard failure — 13 is plausibly in-flight
    expect(result.inconclusive).toBe(true); // but MUST NOT be indistinguishable from a real zero
    expect(result.message).toContain('13 of 60');
  });

  // ─── RED: a meaningful, persistent-magnitude orphan rate ───────────────────
  it('orphan count at the alarm floor — ok:false, states numerator/denominator/rate', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 100, 20);
    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('20 of 100');
    expect(result.message).toContain('20.000%');
    expect(result.fix).toBeDefined();
  });

  it('orphan count well above the alarm floor — ok:false', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 200, 50);
    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('50 of 200');
    expect(result.message).toContain('25.000%');
  });

  // ─── Archived exclusion: migration 041's own scoping rule ──────────────────
  it('an archived orphan is excluded from both numerator and denominator', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    seedMemories(dbPath, 25, 0); // 25 healthy active memories, clears the volume floor
    seedArchivedOrphan(dbPath); // +1 archived memory, flagged, but must not count
    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('0 of 25');
  });

  // ─── REAL-zero vs BROKEN-zero (ADR-015 rule 1) ──────────────────────────────
  it('pre-#250 DB with no needs_vec_index column — inconclusive, NOT a clean bill of health', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // Simulate a DB that never picked up migration 041: drop the column
    // migration 041 added, leaving everything else (including the
    // schema_version row claiming 041 applied) alone. What matters to this
    // check is column presence, not the bookkeeping row.
    // migration 059 added a partial index over needs_vec_index — a genuine
    // pre-#250 DB wouldn't have it, and SQLite refuses to drop a column an
    // index depends on, so drop that index first to make the simulation valid.
    db.exec('DROP INDEX IF EXISTS idx_memories_needs_vec_index; ALTER TABLE memories DROP COLUMN needs_vec_index');
    db.close();

    const result = await check().run();
    expect(result.ok).toBe(true); // doctor's exit-code contract: never hard-fails on this
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('predates migration 041');
    expect(result.message).not.toContain('0 of'); // must NOT look like a verified healthy 0
  });

  // THE TEST WHOSE ABSENCE WOULD LET THIS CANARY SHIP AS DECORATION.
  //
  // ADR-015 rule 6: "a canary that can only go green is not a canary; it is
  // decoration." This asserts the RED branch is actually reachable with a
  // realistic seed, not just theoretically present in the source. Combined
  // with the archived-exclusion test above (which proves the denominator
  // is real, not hardcoded), this is the break-it-and-watch-it-fail pair:
  // deleting either the `ok: false` branch or the `archived = 0` predicate
  // in src/doctor/checks/vec-index.ts makes ONE of these two tests fail.
  it('RED is reachable: rate crossing the floor never renders as ok:true', async () => {
    seedMemories(join(dir, 'memory.sqlite'), 40, 20);
    const result = await check().run();
    expect(result.ok).toBe(false);
  });
});
