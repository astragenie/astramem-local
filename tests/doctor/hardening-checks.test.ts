import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHardeningChecks } from '../../src/doctor/hardening-checks.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';

function findCheck(checks: ReturnType<typeof getHardeningChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor hardening checks (W1.3)', () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doc-'));
    db = openDb(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function checks() {
    return getHardeningChecks({
      dataDir: dir,
      port: 1, // nothing listens — version check skips, lock health probes fail
      openDbReadonly: async () => db,
    });
  }

  it('pre-encryption bak: green when absent, red with age when present', async () => {
    const check = findCheck(checks(), 'No plaintext pre-encryption backup');
    expect((await check.run()).ok).toBe(true);

    const bak = join(dir, 'memory.sqlite.pre-encryption.bak');
    writeFileSync(bak, 'PLAINTEXT');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(bak, old, old);
    const res = await check.run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('PLAINTEXT');
    expect(res.message).toMatch(/3\.\dd old/);
  });

  it('served version: inconclusive (not a confirmed clean bill of health) when daemon unreachable', async () => {
    const res = await findCheck(checks(), 'Served version matches this build').run();
    expect(res.ok).toBe(true);
    expect(res.inconclusive).toBe(true);
    expect(res.message).toContain('cannot verify');
  });

  it('instance lock: green when absent, red for dead-PID holder', async () => {
    const check = findCheck(checks(), 'Instance lock healthy');
    expect((await check.run()).ok).toBe(true);

    writeFileSync(join(dir, 'daemon.lock'), JSON.stringify({ pid: 2 ** 30, port: 1, startedAt: '', version: '' }));
    const res = await check.run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('dead pid');
  });

  it('instance lock: red for alive-but-unresponsive holder (zombie)', async () => {
    writeFileSync(join(dir, 'daemon.lock'), JSON.stringify({ pid: process.pid, port: 1, startedAt: '', version: '' }));
    const res = await findCheck(checks(), 'Instance lock healthy').run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('zombie');
  });

  it('poison jobs: green at zero, red with count', async () => {
    // File-backed DB: the check closes the connection it is handed, so the
    // factory must mint a fresh connection per call.
    const dbPath = join(dir, 'jobs.sqlite');
    const seed = openDb(dbPath);
    migrate(seed);
    const repo = new JobRepo(seed);
    const okChecks = getHardeningChecks({
      dataDir: dir,
      port: 1,
      openDbReadonly: async () => openDb(dbPath),
    });
    const check = findCheck(okChecks, 'No poisoned jobs');
    expect((await check.run()).ok).toBe(true);

    const id = repo.enqueue('distill', {});
    seed.prepare(`UPDATE jobs SET state = 'poison' WHERE id = ?`).run(id);
    seed.close();
    const res = await check.run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('1 poisoned job');
  });

  // #256 review: these two DB-throw paths had zero coverage — a regression
  // back to bare `ok: true` on either would not have been caught. Both were
  // real, live ADR-015 violations found by widening the catch-scanner's
  // scope past checks/ to include this file.
  it('pending proposals: query failure is inconclusive, not a clean bill of health', async () => {
    const failingChecks = getHardeningChecks({
      dataDir: dir,
      port: 1,
      openDbReadonly: async () => { throw new Error('db unavailable'); },
    });
    const res = await findCheck(failingChecks, 'Consolidation proposals reviewed').run();
    expect(res.ok).toBe(true);
    expect(res.inconclusive).toBe(true);
    expect(res.message).toContain('failed to run');
  });

  it('poison jobs: query failure is inconclusive, not a clean bill of health', async () => {
    const failingChecks = getHardeningChecks({
      dataDir: dir,
      port: 1,
      openDbReadonly: async () => { throw new Error('db unavailable'); },
    });
    const res = await findCheck(failingChecks, 'No poisoned jobs').run();
    expect(res.ok).toBe(true);
    expect(res.inconclusive).toBe(true);
    expect(res.message).toContain('failed to run');
  });
});
