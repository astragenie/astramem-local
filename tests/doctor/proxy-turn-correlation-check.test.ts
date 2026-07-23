/**
 * tests/doctor/proxy-turn-correlation-check.test.ts
 *
 * FEAT-477: doctor's informational sibling to "Usefulness feedback loop" —
 * see src/doctor/checks/proxy-turn-correlation.ts's module doc comment for
 * why this check NEVER returns ok:false (a noisy, best-effort text-overlap
 * heuristic, unlike the explicit-channel canary it sits next to) and always
 * distinguishes "no proxy activity" from a printed 0% rate.
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
import { PROXY_TURN_CORRELATION_BASIS } from '../../src/storage/proxy-turn-correlation.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

function seedServedFacts(repo: MemoryRepo, events: MemoryEventRepo, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = repo.insert({
      type: 'fact', text: `fact ${i}`, normalized_text: `fact ${i}`,
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    events.append({
      event_type: 'usefulness', atom_id: id,
      payload: { family: 'recall_served', query_hash: 'q', score: null, surface: 'mcp', mode: 'search' },
    });
    ids.push(id);
  }
  return ids;
}

describe('doctor "Proxy-turn correlation" check (FEAT-477)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-proxy-correlation-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Proxy-turn correlation');
  }

  it('no DB file yet — ok:true, silent', async () => {
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB exists but is unmigrated — inconclusive, not a clean bill of health', async () => {
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });

  // FEAT-477 AC: never a false signal — no proxy activity reads as "nothing
  // to correlate against", not as a printed 0% rate.
  it('recall_served activity exists but zero capture_source=proxy atoms ever — ok:true, "nothing to correlate against"', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    seedServedFacts(repo, events, 25);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no proxy-captured activity yet');
    expect(result.message).not.toContain('%');
  });

  it('proxy activity exists but below the meaningful-usage floor — ok:true, "not enough activity yet"', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    seedServedFacts(repo, events, 5); // below MEANINGFUL_USAGE_THRESHOLD (20)
    repo.insert({
      type: 'fact', text: 'proxy fact', normalized_text: 'proxy fact',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'proxy',
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough activity yet');
  });

  it('proxy activity + meaningful usage + zero correlated grants — STILL ok:true, prints 0.0%', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    seedServedFacts(repo, events, 20);
    repo.insert({
      type: 'fact', text: 'proxy fact', normalized_text: 'proxy fact',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'proxy',
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true); // never false — see module doc comment
    expect(result.message).toContain('0.0%');
    expect(result.message).toContain('0/20');
  });

  it('proxy activity + meaningful usage + some correlated grants — ok:true, prints the real rate', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    const ids = seedServedFacts(repo, events, 20);
    repo.insert({
      type: 'fact', text: 'proxy fact', normalized_text: 'proxy fact',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'proxy',
    });
    events.append({
      event_type: 'usefulness', atom_id: ids[0]!,
      payload: { family: 'recall_used', surface: 'system', signal: 'heuristic', basis: PROXY_TURN_CORRELATION_BASIS },
    });
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('5.0%');
    expect(result.message).toContain('1/20');
  });
});
