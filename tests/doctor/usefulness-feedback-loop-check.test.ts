/**
 * tests/doctor/usefulness-feedback-loop-check.test.ts
 *
 * Canary for the 2026-07-12 production bug: GET /profile on the live daemon
 * returned 30 entries, every one pinned at the Laplace prior 0.5 — the
 * ADR-010 usefulness feedback loop is fully wired (submit_feedback/
 * mark_memory_used, invalidate_memory/supersede_memory) but was never once
 * invoked. See tests/e2e/usefulness-feedback-loop.e2e.test.ts for the proof
 * the mechanism itself works correctly when actually called.
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/memory-health-check.test.ts / auto-capture-check.test.ts)
 * since the check opens `join(dataDir, 'memory.sqlite')` via
 * openProductionDbReadonly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { recordRecallServed, recordRecallUsed } from '../../src/storage/usefulness.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

function seedFacts(repo: MemoryRepo, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(repo.insert({
      type: 'fact', text: `fact ${i}`, normalized_text: `fact ${i}`,
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    }));
  }
  return ids;
}

describe('doctor "Usefulness feedback loop" canary (2026-07-12 "never fired" bug class)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-usefulness-loop-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Usefulness feedback loop');
  }

  // Silent-error audit (2026-07-13): a query error inside this check used to
  // return ok:true indistinguishably from "genuinely no positive signal
  // problem" — the exact "green boot, broken canary" shape this file's own
  // 2026-07-12 bug was about, just one layer deeper (the exception path the
  // #190 logic fix didn't touch).
  it('DB file exists but has not been migrated (query hits a missing table) — inconclusive, not a clean bill of health', async () => {
    // A valid-but-unmigrated DB (rather than a corrupt file) triggers the
    // same "the query itself failed" catch without a Windows file-handle
    // quirk on opening a non-SQLite file.
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });

  it('no DB file yet — ok:true, silent', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('brand-new install below the activity floor — ok:true, does not scream on day one', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    seedFacts(repo, 5); // well below MEANINGFUL_USAGE_THRESHOLD (20)
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough activity yet');
  });

  it('>= threshold memories and served atoms, but 0 used/corrected ever — WARN (the exact production shape)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const ids = seedFacts(repo, 20);
    recordRecallServed(db, { query: 'q', atomIds: ids, surface: 'mcp', mode: 'search' });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('NEVER received a POSITIVE signal');
    expect(result.message).toContain('20 active');
    expect(result.fix).toBeDefined();
  });

  it('>= threshold activity but at least one recall_used event — ok:true (loop is alive)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const ids = seedFacts(repo, 20);
    recordRecallServed(db, { query: 'q', atomIds: ids, surface: 'mcp', mode: 'search' });
    recordRecallUsed(db, { atomId: ids[0]!, surface: 'mcp', signal: 'explicit' });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('active');
    expect(result.message).toContain('1 used');
  });

  // issue #190 regression: this is the EXACT production shape (0 used, N
  // corrected) that used to read as "loop is alive" — the bug the canary
  // exists to catch. Corrections are not positive signal; this must WARN.
  it('>= threshold activity but only memory_corrected events (invalidate), 0 used — WARN, not "loop is alive"', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    // Seed one extra atom above the floor: invalidating one drops activeCount
    // by 1 (invalidate excludes it from the active set), so 21 seeded keeps
    // activeCount at 20 post-invalidate — otherwise this would fall through
    // to the "not enough activity yet" branch instead of exercising the
    // branch this test targets.
    const ids = seedFacts(repo, 21);
    recordRecallServed(db, { query: 'q', atomIds: ids, surface: 'mcp', mode: 'search' });
    new MemoryEventRepo(db).invalidate(ids[0]!, 'test correction');
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('NEVER received a POSITIVE signal');
    expect(result.message).toContain('1 corrected');
    expect(result.message).toContain('0 consolidation-auto');
    expect(result.message).toContain('1 external');
    expect(result.fix).toBeDefined();
  });

  // issue #190 AC-2: the exact live-production shape — corrections sourced
  // from consolidation's own auto-merge, not a human/API caller — must be
  // distinguishable in the WARN message, not lumped in with genuine external
  // corrections.
  it('corrections sourced from consolidation auto-merge are broken out separately in the WARN message', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const ids = seedFacts(repo, 22);
    recordRecallServed(db, { query: 'q', atomIds: ids, surface: 'mcp', mode: 'search' });
    const events = new MemoryEventRepo(db);
    // Mirrors consolidate.ts's mergeAsSupersede: supersede with no human step.
    events.supersede(ids[0]!, ids[1]!, undefined, 'consolidation_auto');
    events.invalidate(ids[2]!, 'a real human correction');
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('2 corrected');
    expect(result.message).toContain('1 consolidation-auto');
    expect(result.message).toContain('1 external');
  });

  // Even with a positive signal present, doctor should still surface the
  // consolidation/external split for corrections rather than silently
  // dropping it once the check goes green.
  it('with a positive signal AND consolidation-sourced corrections — ok:true, breakdown still visible', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const ids = seedFacts(repo, 22);
    recordRecallServed(db, { query: 'q', atomIds: ids, surface: 'mcp', mode: 'search' });
    recordRecallUsed(db, { atomId: ids[0]!, surface: 'mcp', signal: 'explicit' });
    new MemoryEventRepo(db).supersede(ids[1]!, ids[2]!, undefined, 'consolidation_auto');
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 used');
    expect(result.message).toContain('1 corrected');
    expect(result.message).toContain('1 consolidation-auto');
    expect(result.message).toContain('0 external');
  });

  it('>= threshold memories but recalls never served — ok:true (below the served floor, not enough activity to judge)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    seedFacts(repo, 20); // no recordRecallServed at all
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough activity yet');
  });
});
