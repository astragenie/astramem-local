// Wave 3d — sync shipper (ADR-003 one-way log shipping, ADR-009 scope filter).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import {
  listUnsynced,
  buildEnvelope,
  shipOnce,
  backoffDelay,
  lastAckedSeq,
  getOrCreateDeviceId,
  SYNC_PROTOCOL,
  recordShipSuccess,
  recordShipFailure,
  getShipAttemptState,
  sanitizeShipError,
  startShipper,
  readErrorBody,
} from '../../src/sync/shipper.js';

function seedMemory(db: DB, scope: 'private' | 'team' | 'org', hash: string): string {
  // MemoryRepo.insert appends nothing to memory_events itself (stage 8 does),
  // so tests append 'create' events explicitly where needed.
  return new MemoryRepo(db).insert({
    type: 'fact',
    text: `text ${hash}`,
    normalized_text: `text ${hash}`,
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null, scope,
  });
}

let tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  tmpDirs = [];
});

describe('listUnsynced — ADR-009 scope filter', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  // U7-local (astramem-local#110, DEC-048): scope renamed 'personal' ->
  // 'private'; this test is the AC-3 regression gate proving the ADR-009
  // "never ships" invariant survives the rename under its new name.
  it('ships team/org events, never private', () => {
    const events = new MemoryEventRepo(db);
    const priv = seedMemory(db, 'private', 'h-p');
    const team = seedMemory(db, 'team', 'h-t');
    const org = seedMemory(db, 'org', 'h-o');
    events.append({ event_type: 'create', atom_id: priv });
    events.append({ event_type: 'create', atom_id: team });
    events.append({ event_type: 'create', atom_id: org });

    const rows = listUnsynced(db, 100);
    const atoms = rows.map(r => r.atom_id);
    expect(atoms).toContain(team);
    expect(atoms).toContain(org);
    expect(atoms).not.toContain(priv);
  });

  it('erase_request for a hard-deleted atom ships when its payload records team/org scope', () => {
    const events = new MemoryEventRepo(db);
    const ghostTeam = randomUUID();
    const ghostPrivate = randomUUID();
    events.append({ event_type: 'erase_request', atom_id: ghostTeam, payload: { scope: 'team' } });
    events.append({ event_type: 'erase_request', atom_id: ghostPrivate, payload: { scope: 'private' } });

    const atoms = listUnsynced(db, 100).map(r => r.atom_id);
    expect(atoms).toContain(ghostTeam);
    expect(atoms).not.toContain(ghostPrivate);
  });

  it('already-synced events are excluded', () => {
    const events = new MemoryEventRepo(db);
    const team = seedMemory(db, 'team', 'h-t2');
    const seq = events.append({ event_type: 'create', atom_id: team });
    db.prepare('UPDATE memory_events SET synced_at = ? WHERE seq = ?').run(Date.now(), seq);
    expect(listUnsynced(db, 100)).toHaveLength(0);
  });

  it('archive/restore never ship, even for team/org scope (local-only retention decision, review fix HIGH); a supersede on the same scope still ships', () => {
    const events = new MemoryEventRepo(db);
    // Same scope (team) on both atoms — proves the exclusion is type-specific,
    // not an accidental scope-filter regression.
    const archivedAtom = seedMemory(db, 'team', 'h-archive-1');
    const supersededAtom = seedMemory(db, 'team', 'h-archive-2');
    const successor = seedMemory(db, 'team', 'h-archive-3');
    events.append({ event_type: 'create', atom_id: archivedAtom });
    events.append({ event_type: 'create', atom_id: supersededAtom });

    events.archive(archivedAtom);
    events.append({ event_type: 'restore', atom_id: archivedAtom }); // direct append — exercises the type filter without needing the archived state cleared first
    events.supersede(supersededAtom, successor);

    const eventTypes = listUnsynced(db, 100).map(r => r.event_type);
    expect(eventTypes).not.toContain('archive');
    expect(eventTypes).not.toContain('restore');
    expect(eventTypes).toContain('supersede');
  });
});

describe('buildEnvelope — wire conformance', () => {
  it('produced envelope validates against sync-envelope.v1.schema.json', () => {
    const db = openDb(':memory:');
    migrate(db);
    const events = new MemoryEventRepo(db);
    const team = seedMemory(db, 'team', 'h-wire');
    events.append({ event_type: 'create', atom_id: team, payload: { scope: 'team' }, content_hash: 'a'.repeat(64) });
    events.append({ event_type: 'invalidate', atom_id: team, payload: { reason: 'stale' } });

    const envelope = buildEnvelope('device-1', 'ws-1', 0, listUnsynced(db, 100));

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = JSON.parse(
      readFileSync(join(__dirname, '../../contracts/schemas/sync-envelope.v1.schema.json'), 'utf8'),
    );
    const validate = ajv.compile(schema);
    const ok = validate(envelope);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(envelope.protocol).toBe(SYNC_PROTOCOL);
    expect(envelope.events[0]!.payload_json).toEqual({ scope: 'team' });
  });

  // FEAT-407 AC-6: WireSyncEvent gains event_id as an ADDITIVE field
  // (ADR-011, migration 010) — every event this daemon ships now carries
  // one, and the schema still validates envelopes that omit it (see the
  // sync-envelope-v1-single-create-event.json fixture, which has no
  // event_id and still passes contracts/validate.mjs), so older push
  // clients are unaffected.
  it('every shipped event carries a UUID event_id (ADR-011 dedup/tie-break key)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const events = new MemoryEventRepo(db);
    const team = seedMemory(db, 'team', 'h-wire-eid');
    events.append({ event_type: 'create', atom_id: team, content_hash: 'b'.repeat(64) });

    const envelope = buildEnvelope('device-1', 'ws-1', 0, listUnsynced(db, 100));
    expect(envelope.events[0]!.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('shipOnce — ack cursor semantics', () => {
  let db: DB;
  let teamIds: string[];

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const events = new MemoryEventRepo(db);
    teamIds = [1, 2, 3].map(i => seedMemory(db, 'team', `h-ack-${i}`));
    for (const id of teamIds) events.append({ event_type: 'create', atom_id: id });
  });

  function fakeFetch(response: { status?: number; body?: unknown; bodyText?: string } | 'network-error') {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      if (response === 'network-error') throw new Error('ECONNREFUSED');
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: (init?.headers ?? {}) as Record<string, string> });
      const bodyText = response.bodyText ?? JSON.stringify(response.body ?? {});
      return {
        ok: (response.status ?? 200) < 400,
        status: response.status ?? 200,
        json: async () => response.body ?? {},
        text: async () => bodyText,
      } as Response;
    }) as typeof fetch;
    return { impl, calls };
  }

  const baseOpts = (impl: typeof fetch) => ({
    db, url: 'https://cloud.example', workspaceId: 'ws-1',
    deviceId: 'dev-1', token: 'tok', fetchImpl: impl,
  });

  it('full ack marks every shipped event synced', async () => {
    const { impl, calls } = fakeFetch({ body: { acked_seq: 3 } });
    const result = await shipOnce(baseOpts(impl));
    expect(result).toEqual({ shipped: 3, acked: 3, idle: false });
    expect(calls[0]!.url).toBe('https://cloud.example/sync/events');
    expect(listUnsynced(db, 100)).toHaveLength(0);
    expect(lastAckedSeq(db)).toBe(3);
  });

  it('sends the device token under the ApiKey scheme (SaaS AuthMiddleware rejects Bearer as JWT-only)', async () => {
    const { impl, calls } = fakeFetch({ body: { acked_seq: 3 } });
    await shipOnce(baseOpts(impl));
    expect(calls[0]!.headers.authorization).toBe('ApiKey tok');
  });

  it('partial ack (mid-batch) leaves the tail unsynced for the next round', async () => {
    const { impl } = fakeFetch({ body: { acked_seq: 2 } });
    const result = await shipOnce(baseOpts(impl));
    expect(result.acked).toBe(2);
    const remaining = listUnsynced(db, 100);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.seq).toBe(3);
  });

  it('HTTP failure throws and leaves everything unsynced (the log is the queue)', async () => {
    const { impl } = fakeFetch({ status: 503, body: {} });
    await expect(shipOnce(baseOpts(impl))).rejects.toThrow('HTTP 503');
    expect(listUnsynced(db, 100)).toHaveLength(3);
  });

  // astramem-local#81: a bare "HTTP 403" swallowed the cloud's error JSON and
  // cost hours of debugging — the response body must ride along in the thrown
  // error so `sync ship failed: HTTP 403 {"error":"sync_disabled"}` is visible
  // in the daemon log without extra instrumentation.
  it('HTTP failure includes the response body in the thrown error', async () => {
    const { impl } = fakeFetch({ status: 403, bodyText: '{"error":"sync_disabled"}' });
    await expect(shipOnce(baseOpts(impl))).rejects.toThrow('sync ship failed: HTTP 403 {"error":"sync_disabled"}');
  });

  it('bounds an oversized error body to ~500 chars', async () => {
    const huge = 'x'.repeat(2000);
    const { impl } = fakeFetch({ status: 500, bodyText: huge });
    await expect(shipOnce(baseOpts(impl))).rejects.toThrow(/x{500}…$/);
  });

  it('omits the trailing space when the failure response has no body', async () => {
    const { impl } = fakeFetch({ status: 500, bodyText: '' });
    let caught: Error | undefined;
    try {
      await shipOnce(baseOpts(impl));
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toBe('sync ship failed: HTTP 500');
  });

  it('network failure leaves everything unsynced', async () => {
    const { impl } = fakeFetch('network-error');
    await expect(shipOnce(baseOpts(impl))).rejects.toThrow('ECONNREFUSED');
    expect(listUnsynced(db, 100)).toHaveLength(3);
  });

  it('nothing eligible → idle, no fetch performed', async () => {
    db.prepare('UPDATE memory_events SET synced_at = 1').run();
    const { impl, calls } = fakeFetch({ body: { acked_seq: 99 } });
    const result = await shipOnce(baseOpts(impl));
    expect(result.idle).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('readErrorBody', () => {
  it('reads and returns the response text verbatim when short', async () => {
    const res = { text: async () => '{"error":"sync_disabled"}' } as Response;
    expect(await readErrorBody(res)).toBe('{"error":"sync_disabled"}');
  });

  it('truncates with an ellipsis past ~500 chars', async () => {
    const huge = 'y'.repeat(600);
    const res = { text: async () => huge } as Response;
    const out = await readErrorBody(res);
    expect(out).toBe(`${'y'.repeat(500)}…`);
  });

  it('never throws — a body-read failure resolves to empty string', async () => {
    const res = { text: async () => { throw new Error('stream already consumed'); } } as unknown as Response;
    expect(await readErrorBody(res)).toBe('');
  });
});

describe('backoffDelay', () => {
  it('doubles per consecutive failure and caps at 15 minutes', () => {
    expect(backoffDelay(30_000, 1)).toBe(60_000);
    expect(backoffDelay(30_000, 2)).toBe(120_000);
    expect(backoffDelay(30_000, 20)).toBe(15 * 60_000);
  });
});

describe('getOrCreateDeviceId', () => {
  it('creates once, then returns the same id', () => {
    const dir = mkTmp('astramem-device-id-');
    const first = getOrCreateDeviceId(dir);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(getOrCreateDeviceId(dir)).toBe(first);
  });
});

// FEAT-434 — last-ship-ATTEMPT state (distinct from lastShipAt, which only
// ever reflects success). Persisted in sync_ship_state (migration 014),
// same single-row convention as sync_pull_state (migration 010).
describe('ship-attempt state (FEAT-434)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('defaults to all-null/zero before any round has run', () => {
    expect(getShipAttemptState(db)).toEqual({
      last_attempt_at: null,
      last_result: null,
      last_error: null,
      consecutive_failures: 0,
      next_retry_at: null,
    });
  });

  it('recordShipFailure captures result, sanitized error, failure count, and backoff', () => {
    recordShipFailure(db, 1000, new Error('sync ship failed: HTTP 503'), 1, 1000 + 60_000, 'sekret-token');
    expect(getShipAttemptState(db)).toEqual({
      last_attempt_at: 1000,
      last_result: 'error',
      last_error: 'sync ship failed: HTTP 503',
      consecutive_failures: 1,
      next_retry_at: 61_000,
    });
  });

  it('recordShipSuccess clears error/backoff state and resets the failure count', () => {
    recordShipFailure(db, 1000, new Error('boom'), 3, 1000 + 240_000, 'tok');
    recordShipSuccess(db, 2000);
    expect(getShipAttemptState(db)).toEqual({
      last_attempt_at: 2000,
      last_result: 'ok',
      last_error: null,
      consecutive_failures: 0,
      next_retry_at: null,
    });
  });

  it('a subsequent failure overwrites (not accumulates) the single persisted row', () => {
    recordShipFailure(db, 1000, new Error('first'), 1, 1060_000, 'tok');
    recordShipFailure(db, 2000, new Error('second'), 2, 2120_000, 'tok');
    const state = getShipAttemptState(db);
    expect(state.last_error).toBe('second');
    expect(state.consecutive_failures).toBe(2);
  });
});

describe('sanitizeShipError (FEAT-434) — no secret ever persisted/exposed', () => {
  it('redacts every occurrence of the device token', () => {
    const msg = sanitizeShipError('sync ship failed: token abc123 rejected, retry with abc123', 'abc123');
    expect(msg).not.toContain('abc123');
    expect(msg).toBe('sync ship failed: token [redacted] rejected, retry with [redacted]');
  });

  it('is a no-op when no token is supplied', () => {
    expect(sanitizeShipError('HTTP 503')).toBe('HTTP 503');
  });

  it('caps message length so an unbounded error body cannot bloat local state', () => {
    const huge = 'x'.repeat(2000);
    const msg = sanitizeShipError(huge);
    expect(msg.length).toBeLessThan(600);
    expect(msg.endsWith('…')).toBe(true);
  });
});

describe('startShipper — records attempt state across rounds (FEAT-434)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const events = new MemoryEventRepo(db);
    const team = seedMemory(db, 'team', 'h-loop-1');
    events.append({ event_type: 'create', atom_id: team });
  });

  it('a failed round records error + failure count; a later successful round clears it', async () => {
    let call = 0;
    const flakyThenOk = (async () => {
      call++;
      if (call === 1) {
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ acked_seq: 1 }) } as Response;
    }) as typeof fetch;

    const handle = startShipper({
      db, url: 'https://cloud.example', workspaceId: 'ws-1',
      deviceId: 'dev-1', token: 'shh-secret', fetchImpl: flakyThenOk,
      intervalMs: 10_000_000, // never auto-fire a second round during the test
    });
    // stop() awaits the in-flight round, so this settles the immediate first attempt.
    await handle.stop();

    const afterFailure = getShipAttemptState(db);
    expect(afterFailure.last_result).toBe('error');
    expect(afterFailure.consecutive_failures).toBe(1);
    expect(afterFailure.last_error).toContain('HTTP 503');
    expect(afterFailure.last_error).not.toContain('shh-secret');
    expect(afterFailure.next_retry_at).not.toBeNull();

    // Second (successful) round, started fresh — as if the backoff timer fired.
    const handle2 = startShipper({
      db, url: 'https://cloud.example', workspaceId: 'ws-1',
      deviceId: 'dev-1', token: 'shh-secret', fetchImpl: flakyThenOk,
      intervalMs: 10_000_000,
    });
    await handle2.stop();

    const afterSuccess = getShipAttemptState(db);
    expect(afterSuccess.last_result).toBe('ok');
    expect(afterSuccess.consecutive_failures).toBe(0);
    expect(afterSuccess.last_error).toBeNull();
    expect(afterSuccess.next_retry_at).toBeNull();
  });
});
