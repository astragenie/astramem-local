// FEAT-427 — GET /sync/status: read-only observability over the shipper
// (ADR-003) + puller (ADR-011). Never leaks the device sync token.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { buildApp } from '../../src/server/app.js';
import { defaultConfig } from '../../src/config/config.js';
import { recordShipFailure, recordShipSuccess } from '../../src/sync/shipper.js';

function seedMemory(db: DB, scope: 'personal' | 'team' | 'org', hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact',
    text: `text ${hash}`,
    normalized_text: `text ${hash}`,
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null, scope,
  });
}

describe('GET /sync/status (FEAT-427)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('sync disabled — reports disabled, zero pending, no ship history, no secrets', async () => {
    const config = defaultConfig();
    config.sync.enabled = false;

    const app = await buildApp({ db, token: 't', config });
    const res = await app.inject({ method: 'GET', url: '/sync/status', headers: { authorization: 'Bearer t' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.apiUrl).toBeNull();
    expect(body.workspaceId).toBeNull();
    expect(body.last_ship).toEqual({ at: null, status: 'disabled' });
    // FEAT-434: no ship attempt has ever run against this DB.
    expect(body.last_attempt).toEqual({ at: null, result: null, error: null, consecutive_failures: 0, next_retry_at: null });
    expect(body.pending_count).toBe(0);
    expect(body.cursor).toEqual({ push_seq: 0, pull_watermark: null });

    // Secret-leak assertion: no api key / token field anywhere in the body.
    const raw = JSON.stringify(body).toLowerCase();
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('apikey');
    expect(raw).not.toContain('api_key');
    expect(raw).not.toContain('bearer');
  });

  it('sync enabled, nothing shipped yet — never_shipped status, pending count reflects eligible backlog', async () => {
    const config = defaultConfig();
    config.sync.enabled = true;
    config.sync.url = 'https://cloud.example.com';
    config.sync.workspaceId = 'ws-1';

    const events = new MemoryEventRepo(db);
    const team = seedMemory(db, 'team', 'h-t1');
    const personal = seedMemory(db, 'personal', 'h-p1');
    events.append({ event_type: 'create', atom_id: team });
    events.append({ event_type: 'create', atom_id: personal }); // personal never ships (ADR-009)

    const app = await buildApp({ db, token: 't', config });
    const res = await app.inject({ method: 'GET', url: '/sync/status', headers: { authorization: 'Bearer t' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.apiUrl).toBe('https://cloud.example.com');
    expect(body.workspaceId).toBe('ws-1');
    expect(body.last_ship).toEqual({ at: null, status: 'never_shipped' });
    expect(body.pending_count).toBe(1); // only the team-scoped event is eligible

    const raw = JSON.stringify(body).toLowerCase();
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('apikey');
    expect(raw).not.toContain('api_key');
  });

  it('sync enabled, backlog fully shipped — up_to_date status with a real last-ship timestamp + cursor', async () => {
    const config = defaultConfig();
    config.sync.enabled = true;
    config.sync.url = 'https://cloud.example.com';
    config.sync.workspaceId = 'ws-1';

    const events = new MemoryEventRepo(db);
    const team = seedMemory(db, 'team', 'h-t2');
    const seq = events.append({ event_type: 'create', atom_id: team });
    const shippedAt = Date.now();
    db.prepare('UPDATE memory_events SET synced_at = ? WHERE seq = ?').run(shippedAt, seq);

    const app = await buildApp({ db, token: 't', config });
    const res = await app.inject({ method: 'GET', url: '/sync/status', headers: { authorization: 'Bearer t' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.last_ship).toEqual({ at: shippedAt, status: 'up_to_date' });
    expect(body.pending_count).toBe(0);
    expect(body.cursor.push_seq).toBe(seq);
  });

  it('requires Bearer auth like every non-public route', async () => {
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sync/status' });
    expect(res.statusCode).toBe(401);
  });

  // FEAT-434 — the gap the FEAT-427 review flagged: last_ship can only ever
  // show success/idle. last_attempt covers every attempt, including a
  // failing/backing-off one, without ever leaking the device sync token.
  it('a failed ship attempt is surfaced via last_attempt, never leaks the device token, and clears on the next success', async () => {
    const config = defaultConfig();
    config.sync.enabled = true;
    config.sync.url = 'https://cloud.example.com';
    config.sync.workspaceId = 'ws-1';
    const deviceToken = 'super-secret-device-token-abc123';

    // A realistic failure whose raw message happens to embed the device
    // token — recordShipFailure must strip it before it is ever persisted.
    recordShipFailure(
      db,
      1_000,
      new Error(`sync ship failed: HTTP 401 (token ${deviceToken} rejected)`),
      2,
      1_000 + 120_000,
      deviceToken,
    );

    const app = await buildApp({ db, token: 't', config });
    const res = await app.inject({ method: 'GET', url: '/sync/status', headers: { authorization: 'Bearer t' } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.last_attempt.at).toBe(1_000);
    expect(body.last_attempt.result).toBe('error');
    expect(body.last_attempt.consecutive_failures).toBe(2);
    expect(body.last_attempt.next_retry_at).toBe(1_000 + 120_000);
    expect(body.last_attempt.error).toContain('HTTP 401');
    expect(body.last_attempt.error).not.toContain(deviceToken);

    // Secret-leak assertion extended to cover the new field: the device
    // token must not appear anywhere in the body, including last_attempt.error.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(deviceToken);
    expect(raw.toLowerCase()).not.toContain('apikey');
    expect(raw.toLowerCase()).not.toContain('api_key');

    // A subsequent success clears the error + failure count.
    recordShipSuccess(db, 2_000);
    const res2 = await app.inject({ method: 'GET', url: '/sync/status', headers: { authorization: 'Bearer t' } });
    const body2 = res2.json();
    expect(body2.last_attempt).toEqual({
      at: 2_000,
      result: 'ok',
      error: null,
      consecutive_failures: 0,
      next_retry_at: null,
    });
  });
});
