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
} from '../../src/sync/shipper.js';

function seedMemory(db: DB, scope: 'personal' | 'team' | 'org', hash: string): string {
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

  it('ships team/org events, never personal', () => {
    const events = new MemoryEventRepo(db);
    const personal = seedMemory(db, 'personal', 'h-p');
    const team = seedMemory(db, 'team', 'h-t');
    const org = seedMemory(db, 'org', 'h-o');
    events.append({ event_type: 'create', atom_id: personal });
    events.append({ event_type: 'create', atom_id: team });
    events.append({ event_type: 'create', atom_id: org });

    const rows = listUnsynced(db, 100);
    const atoms = rows.map(r => r.atom_id);
    expect(atoms).toContain(team);
    expect(atoms).toContain(org);
    expect(atoms).not.toContain(personal);
  });

  it('erase_request for a hard-deleted atom ships when its payload records team/org scope', () => {
    const events = new MemoryEventRepo(db);
    const ghostTeam = randomUUID();
    const ghostPersonal = randomUUID();
    events.append({ event_type: 'erase_request', atom_id: ghostTeam, payload: { scope: 'team' } });
    events.append({ event_type: 'erase_request', atom_id: ghostPersonal, payload: { scope: 'personal' } });

    const atoms = listUnsynced(db, 100).map(r => r.atom_id);
    expect(atoms).toContain(ghostTeam);
    expect(atoms).not.toContain(ghostPersonal);
  });

  it('already-synced events are excluded', () => {
    const events = new MemoryEventRepo(db);
    const team = seedMemory(db, 'team', 'h-t2');
    const seq = events.append({ event_type: 'create', atom_id: team });
    db.prepare('UPDATE memory_events SET synced_at = ? WHERE seq = ?').run(Date.now(), seq);
    expect(listUnsynced(db, 100)).toHaveLength(0);
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

  function fakeFetch(response: { status?: number; body?: unknown } | 'network-error') {
    const calls: Array<{ url: string; body: unknown }> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      if (response === 'network-error') throw new Error('ECONNREFUSED');
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return {
        ok: (response.status ?? 200) < 400,
        status: response.status ?? 200,
        json: async () => response.body ?? {},
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
