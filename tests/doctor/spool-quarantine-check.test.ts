/**
 * tests/doctor/spool-quarantine-check.test.ts
 *
 * Wave A slice A3 — the "Ingest spool quarantine" doctor canary
 * (src/doctor/checks.ts checkSpoolQuarantine). Per ADR-015 rule 6 ("state
 * the denominator"), the message always reports K (currently quarantined)
 * of N (SpoolStats.totalSpooled, cumulative) — never a bare count — and the
 * check goes genuinely RED when a quarantined file has outlived
 * DEFAULT_QUARANTINE_TTL_MS, meaning the TTL sweep (pruneExpiredQuarantine,
 * run every spool-drain tick) failed to remove it. A canary that can only
 * ever go green is decoration (same ADR-015 rule) — the TTL-exceeded case
 * below is what proves this one isn't.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { writeToSpool, listSpoolFiles, quarantineSpoolFile, spoolDir, spoolQuarantineDir } from '../../src/ingest/spool.js';
import { defaultConfig } from '../../src/config/config.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Ingest spool quarantine" check (Wave A slice A3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-quarantine-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function check() {
    return findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Ingest spool quarantine');
  }

  it('reports "0 of N" and ok:true when nothing is quarantined', async () => {
    writeToSpool(dir, 'a'.repeat(64), { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    writeToSpool(dir, 'b'.repeat(64), { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('ingest spool quarantine: 0 of 2 spooled envelopes quarantined');
  });

  it('states the denominator (K of N) and stays ok:true when quarantined content is younger than the TTL', async () => {
    writeToSpool(dir, 'a'.repeat(64), { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    writeToSpool(dir, 'b'.repeat(64), { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dir);
    quarantineSpoolFile(dir, file!, 'schema validation failed');

    const result = await check().run();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^ingest spool quarantine: 1 of 2 spooled envelopes quarantined, oldest is 0\.\dd old \(within 7d TTL\)$/);
  });

  it('goes RED when a quarantined file has outlived the TTL — proves this canary is not decoration', async () => {
    writeToSpool(dir, 'a'.repeat(64), { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dir);
    quarantineSpoolFile(dir, file!, 'schema validation failed');

    // Backdate the quarantined file's mtime past the 7-day TTL — simulates
    // the TTL sweep having failed to prune it (the only way this state can
    // arise in production, since pruneExpiredQuarantine runs every tick).
    const qPath = join(spoolQuarantineDir(dir), `${'a'.repeat(64)}.json`);
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(qPath, eightDaysAgo, eightDaysAgo);

    const result = await check().run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('1 of 1 spooled envelopes quarantined');
    expect(result.message).toContain('exceeds the 7d TTL');
    expect(result.fix).toBeTruthy();
  });

  // Fast-follow to #225 (2026-07-13) — Finding 3: a lost/corrupt
  // .stats.json fabricated a green "0 of 0" instead of admitting the
  // denominator was unknown (ADR-015 rule 6).
  it('reports inconclusive (not a green "0 of N") when .stats.json is corrupt but spool activity exists on disk', async () => {
    writeToSpool(dir, 'a'.repeat(64), { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    // Corrupt the counter in place — simulates a torn/lost stats file after
    // real traffic already happened.
    writeFileSync(join(spoolDir(dir), '.stats.json'), '{not json');

    const result = await check().run();
    expect(result.ok).toBe(true); // a lost counter is not itself a quarantine problem
    expect(result.inconclusive).toBe(true);
    expect(result.message).not.toMatch(/0 of 0/); // must not fabricate a green "0 of 0"
    expect(result.message).toContain('denominator unavailable');
  });

  it('the TTL RED path still fires when .stats.json is corrupt — the RED signal does not depend on the stats file', async () => {
    writeToSpool(dir, 'a'.repeat(64), { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dir);
    quarantineSpoolFile(dir, file!, 'schema validation failed');
    writeFileSync(join(spoolDir(dir), '.stats.json'), '{not json'); // corrupt AFTER quarantining

    const qPath = join(spoolQuarantineDir(dir), `${'a'.repeat(64)}.json`);
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(qPath, eightDaysAgo, eightDaysAgo);

    const result = await check().run();
    expect(result.ok).toBe(false); // still genuinely RED, unaffected by the corrupt counter
    expect(result.inconclusive).toBeFalsy();
    expect(result.message).toContain('exceeds the 7d TTL');
    expect(result.fix).toBeTruthy();
  });
});
