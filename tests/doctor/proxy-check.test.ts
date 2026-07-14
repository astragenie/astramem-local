/**
 * tests/doctor/proxy-check.test.ts
 *
 * FEAT-458 S1-AC-2 / ADR-013: doctor's "LLM proxy" row. Same `ok: true`-in-
 * every-state posture as tests/doctor/auto-capture-check.test.ts's subject —
 * proxy-enabled-and-running (with or without capture) is a deliberate
 * opt-in, never itself a misconfiguration (see checkProxyCapture's doc
 * comment in src/doctor/checks.ts for why). S2 shipped zero capture code;
 * FEAT-458 S3 widened InsertInput.capture_source to admit 'proxy', so the
 * "proxy capture is ON" count below is now exercised via the same typed
 * insert() path every other test in this suite uses, no bypass needed.
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

  // Every one of these passes proxyExperimental: true — they exercise the
  // "live state" branch (the release no-go gate is off scope for them; see
  // the "release no-go gate" describe block below for that dimension).
  function checkFor(proxyEnabled: boolean, proxyCaptureEnabled: boolean) {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, proxyEnabled, proxyExperimental: true, proxyCaptureEnabled }),
      'LLM proxy',
    );
  }

  it('defaults to gated (experimental not opted in) when every proxy opt is omitted, and is always ok', async () => {
    const check = findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'LLM proxy');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('experimental (not for production)');
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

  // Silent-error audit (2026-07-13): a query error inside this check used to
  // return ok:true indistinguishably from a genuinely healthy count.
  it('proxy + capture enabled, DB file exists but has not been migrated — inconclusive', async () => {
    // A valid-but-unmigrated DB (rather than a corrupt file) triggers the
    // same "the query itself failed" catch without a Windows file-handle
    // quirk on opening a non-SQLite file.
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor(true, true).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
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
    repo.insert({
      type: 'fact', text: 'proxy-captured atom one', normalized_text: 'proxy-captured atom one',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'proxy',
    });
    repo.insert({
      type: 'fact', text: 'proxy-captured atom two', normalized_text: 'proxy-captured atom two',
      repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
      hash: randomUUID(), source_hash: null, capture_source: 'proxy',
    });
    db.close();

    const result = await checkFor(true, true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('2 proxy-captured memories');
  });
});

describe('doctor "LLM proxy" check — release no-go gate (proxy.experimental)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-proxy-gate-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('proxyExperimental omitted — gated message, ok:true, never touching the DB, regardless of proxyEnabled', async () => {
    const result = await findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, proxyEnabled: true, proxyCaptureEnabled: true }),
      'LLM proxy',
    ).run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      'proxy: experimental (not for production) — set proxy.experimental: true to opt in; `proxy serve` refuses to start otherwise',
    );
  });

  it('proxyExperimental: false, proxyEnabled: false — still the gated message (experimental dominates, not "off (default)")', async () => {
    const result = await findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, proxyEnabled: false, proxyExperimental: false }),
      'LLM proxy',
    ).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('experimental (not for production)');
  });

  it('proxyExperimental: true, proxyEnabled: false — falls through to the live "off" state, not the gated message', async () => {
    const result = await findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, proxyEnabled: false, proxyExperimental: true }),
      'LLM proxy',
    ).run();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('proxy: off (default)');
  });
});
