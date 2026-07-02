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

  it('schema_version is 6', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.json().schema_version).toBe(6);
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
    expect(body.schema_version).toBe(6);
  });

  it('includes security.redaction — true by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as { security: { redaction: boolean } };
    expect(body.security.redaction).toBe(true);
  });
});
