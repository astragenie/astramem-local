import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import type { DB } from '../../src/storage/db.js';

describe('GET /version', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('returns 200 with the documented shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
  });

  it('name is astramemory-local', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.json().name).toBe('astramemory-local');
  });

  it('version is a non-empty semver-ish string', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    const { version } = res.json() as { version: string };
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('wire_versions_supported includes v0.0 and v1.0', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    const { wire_versions_supported } = res.json() as { wire_versions_supported: string[] };
    expect(wire_versions_supported).toContain('v0.0');
    expect(wire_versions_supported).toContain('v1.0');
  });

  it('schema_version is 7', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.json().schema_version).toBe(7);
  });

  it('ts is a number', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(typeof res.json().ts).toBe('number');
  });

  it('is public — no Bearer token required', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /health (wire metadata)', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('returns 200 and includes wire_versions_supported', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; wire_versions_supported: string[]; schema_version: number };
    expect(body.ok).toBe(true);
    expect(body.wire_versions_supported).toContain('v0.0');
    expect(body.wire_versions_supported).toContain('v1.0');
    expect(body.schema_version).toBe(7);
  });

  it('includes security.redaction — true by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as { security: { redaction: boolean } };
    expect(body.security.redaction).toBe(true);
  });

  // ADR-010 (2e): recall-usefulness rate, sibling to the security object.
  it('includes a usefulness block with served_7d/used_7d/rate_7d — zeros/null on an empty DB', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as { usefulness: { served_7d: number; used_7d: number; rate_7d: number | null } };
    expect(body.usefulness).toEqual({ served_7d: 0, used_7d: 0, rate_7d: null });
  });

  it('usefulness.served_7d reflects recorded recall_served events', async () => {
    const { MemoryRepo } = await import('../../src/storage/memories.js');
    const { recordRecallServed, recordRecallUsed } = await import('../../src/storage/usefulness.js');
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'health usefulness fixture', normalized_text: 'health usefulness fixture',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'h-health-usefulness-1', source_hash: null,
    });
    recordRecallServed(db, { query: 'health usefulness fixture', atomIds: [id], surface: 'rest', mode: 'search' });
    recordRecallUsed(db, { atomId: id, surface: 'rest', signal: 'explicit' });

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as { usefulness: { served_7d: number; used_7d: number; rate_7d: number | null } };
    expect(body.usefulness).toEqual({ served_7d: 1, used_7d: 1, rate_7d: 1 });
  });
});
