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
import { mkdtempSync, rmSync } from 'node:fs';
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
    expect(result.message).toContain('NEVER fired');
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

  it('>= threshold activity but at least one memory_corrected event (invalidate) — ok:true (loop is alive)', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    // Seed one extra atom above the floor: invalidating one drops activeCount
    // by 1 (invalidate excludes it from the active set), so 21 seeded keeps
    // activeCount at 20 post-invalidate — otherwise this would fall through
    // to the "not enough activity yet" branch instead of exercising the
    // "loop is alive" branch this test targets.
    const ids = seedFacts(repo, 21);
    recordRecallServed(db, { query: 'q', atomIds: ids, surface: 'mcp', mode: 'search' });
    new MemoryEventRepo(db).invalidate(ids[0]!, 'test correction');
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 corrected');
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
