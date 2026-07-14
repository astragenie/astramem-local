/**
 * tests/doctor/redaction-check.test.ts
 *
 * FEAT-498: the "Secret redaction" doctor row. Pre-existing behavior
 * (off/no-DB/nonzero-fires) is covered implicitly by this suite's baseline
 * cases; the new surface is the zero-fire x capture-active matrix — zero
 * fires alone is ambiguous (no traffic vs. a silent detector gap), and
 * `captureActive` is what disambiguates it. See src/doctor/checks/
 * redaction.ts's doc comment for the full rationale.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Secret redaction" check (FEAT-498 zero-fire x capture-active matrix)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-redaction-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor(opts: { autoCaptureEnabled?: boolean; proxyEnabled?: boolean; proxyCaptureEnabled?: boolean } = {}) {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, redactionEnabled: true, ...opts }),
      'Secret redaction',
    );
  }

  it('redaction disabled — ok:false regardless of capture state', async () => {
    const checks = getChecks({ dataDir: dir, encryptionEnabled: false, redactionEnabled: false, autoCaptureEnabled: true });
    const result = await findCheck(checks, 'Secret redaction').run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('OFF');
  });

  it('no DB yet — ok:true, informational, regardless of capture state', async () => {
    const result = await checkFor({ autoCaptureEnabled: true }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('zero fires, no capture active (default) — ok:true, unchanged from pre-FEAT-498 behavior', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor().run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('redaction: on — 0 secrets redacted in last 7d');
  });

  it('zero fires, auto-capture ACTIVE — WARN (ok:false), names the ambiguity + gives a fix hint', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor({ autoCaptureEnabled: true }).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('0 secrets redacted in last 7d WHILE capture');
    expect(result.fix).toBeDefined();
  });

  it('zero fires, proxy capture ACTIVE (proxyEnabled + proxyCaptureEnabled both true) — WARN', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor({ proxyEnabled: true, proxyCaptureEnabled: true }).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('WHILE capture');
  });

  it('zero fires, proxy ON but proxy capture OFF (transparent forward only) — NOT active capture, stays ok:true', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();

    const result = await checkFor({ proxyEnabled: true, proxyCaptureEnabled: false }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('redaction: on — 0 secrets redacted in last 7d');
  });

  it('nonzero fires — ok:true with breakdown, regardless of capture state (unchanged)', async () => {
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.prepare('INSERT INTO redaction_log (type, count, created_at) VALUES (?, ?, ?)')
      .run('aws_access_key', 3, Date.now());
    db.close();

    const result = await checkFor({ autoCaptureEnabled: true }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('3 secrets redacted');
    expect(result.message).toContain('aws_access_key');
  });
});
