/**
 * tests/doctor/proxy-check.test.ts
 *
 * FEAT-458 S1-AC-2 / ADR-013: doctor's "LLM proxy" row. Same `ok: true`-in-
 * every-state posture as tests/doctor/auto-capture-check.test.ts's subject —
 * proxy-enabled-and-running (with or without capture) is a deliberate
 * opt-in, never itself a misconfiguration (see checkProxyCapture's doc
 * comment in src/doctor/checks.ts for why). S2 ships zero capture code, so
 * the "proxy capture is ON" count is exercised here via a raw INSERT that
 * bypasses InsertInput's `capture_source?: 'auto_capture' | null` type
 * (which deliberately does not know about `'proxy'` yet) — simulating what
 * FEAT-458 S3's capture fork will actually write.
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

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "LLM proxy" check (FEAT-458 S1-AC-2 / ADR-013)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-proxy-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor(proxyEnabled: boolean, proxyCaptureEnabled: boolean) {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, proxyEnabled, proxyCaptureEnabled }),
      'LLM proxy',
    );
  }

  it('defaults to off when proxyEnabled/proxyCaptureEnabled are omitted, and is always ok', async () => {
    const check = findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'LLM proxy');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('proxy: off (default)');
  });

  it('proxy disabled — reports off verbatim, never touching the DB', async () => {
    const result = await checkFor(false, false).run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('proxy: off (default)');
  });

  it('proxy disabled — reports off even when captureEnabled is (incoherently) true, since proxy gates capture', async () => {
    const result = await checkFor(false, true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('proxy: off (default)');
  });

  it('proxy enabled, capture off — reports transparent-forward-only, never touching the DB', async () => {
    const result = await checkFor(true, false).run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('proxy is ON — capture is off (transparent forward only)');
  });

  it('proxy + capture enabled, no DB yet — ok:true, 0 count', async () => {
    const result = await checkFor(true, true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
    expect(result.message).toContain('0');
  });

  it('proxy + capture enabled, DB exists with zero proxy-captured memories — ok:true, 0 count', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    new MemoryRepo(db).insert({
      type: 'fact', text: 'a manually captured fact', normalized_text: 'a manually captured fact',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    db.close();

    const result = await checkFor(true, true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('0 proxy-captured memories');
  });

  it('proxy + capture enabled, populated store — reports the proxy-captured count, ignoring other sources', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    const repo = new MemoryRepo(db);
    repo.insert({
      type: 'fact', text: 'manual atom', normalized_text: 'manual atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null,
    });
    repo.insert({
      type: 'fact', text: 'auto-captured atom', normalized_text: 'auto-captured atom',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'auto_capture',
    });
    // FEAT-458 S3 will add 'proxy' to InsertInput.capture_source's union;
    // for now this is a raw write simulating that future producer.
    repo.insert({
      type: 'fact', text: 'proxy-captured atom one', normalized_text: 'proxy-captured atom one',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'proxy' as unknown as 'auto_capture',
    });
    repo.insert({
      type: 'fact', text: 'proxy-captured atom two', normalized_text: 'proxy-captured atom two',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'proxy' as unknown as 'auto_capture',
    });
    db.close();

    const result = await checkFor(true, true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('2 proxy-captured memories');
  });
});
