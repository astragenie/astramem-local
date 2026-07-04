// FEAT-407 (ADR-011) — sync pull: dedup-insert by event_id, watermark
// persistence, scoped conflict-resolve wiring.
//
// SIMULATION CAVEAT: there is no live SaaS repo available locally (see the
// FEAT-407 completion report). `PullFetcher` is injectable specifically so
// these tests can simulate a remote event source (either "the cloud", or —
// for AC-5 — a second local device) without a real network round trip.
// AC-5 in particular is proven here as a same-process two-database
// simulation, NOT a live device-A -> cloud -> device-B round trip.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { pullOnce, drainPull, getPullWatermark, type PullFetcher, type RemotePullEvent } from '../../src/sync/puller.js';

let tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'astramem-puller-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  tmpDirs = [];
});

/** Fixed-page fake "remote" event source — an array of already-produced RemotePullEvents. */
function fakeFetcher(allEvents: RemotePullEvent[], pageSize = 100): PullFetcher {
  return async (cursor, limit) => {
    const startIdx = cursor ? Number(cursor) : 0;
    const page = allEvents.slice(startIdx, startIdx + Math.min(limit, pageSize));
    const endIdx = startIdx + page.length;
    const nextCursor = endIdx < allEvents.length ? String(endIdx) : null;
    return { events: page, next_cursor: nextCursor };
  };
}

function makeCreateEvent(atomId: string, snapshot: RemotePullEvent['atom_snapshot'], createdAt: number): RemotePullEvent {
  return {
    seq: 0, // remote seq is not meaningful locally — dedup keys on event_id
    event_id: randomUUID(),
    event_type: 'create',
    atom_id: atomId,
    payload_json: null,
    content_hash: snapshot?.hash ?? null,
    created_at: createdAt,
    atom_snapshot: snapshot,
  };
}

describe('AC-1 — pull merges new remote events and advances the watermark', () => {
  it('inserts events and materializes new atoms from a fresh watermark', async () => {
    const db = openDb(':memory:');
    migrate(db);

    const atomId = randomUUID();
    const remote: RemotePullEvent[] = [
      makeCreateEvent(atomId, {
        type: 'fact', text: 'remote memory', normalized_text: 'remote memory',
        hash: 'h'.repeat(64), scope: 'team', repo: 'r1',
      }, 1000),
    ];

    expect(getPullWatermark(db)).toBeNull();

    const result = await pullOnce({ db, fetcher: fakeFetcher(remote) });

    expect(result.idle).toBe(false);
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.atomsRecomputed).toBe(1);
    expect(getPullWatermark(db)).toBe(result.cursor);

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(atomId) as { hash: string; scope: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.hash).toBe('h'.repeat(64));
    expect(row!.scope).toBe('team');
  });

  it('idle when the fetcher has nothing to offer', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const result = await pullOnce({ db, fetcher: fakeFetcher([]) });
    expect(result.idle).toBe(true);
    expect(result.inserted).toBe(0);
  });
});

describe('AC-2 — replay of the same event batch is idempotent (no duplication), keyed by event_id', () => {
  it('re-running pullOnce with the exact same events inserts nothing new', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const atomId = randomUUID();
    const eventId = randomUUID();
    const remote: RemotePullEvent[] = [{
      seq: 1, event_id: eventId, event_type: 'create', atom_id: atomId,
      payload_json: null, content_hash: 'a'.repeat(64), created_at: 1000,
      atom_snapshot: { type: 'fact', text: 't', normalized_text: 't', hash: 'a'.repeat(64), scope: 'team' },
    }];

    // Same watermark-advancing fetcher invoked twice (simulating a replayed
    // batch — e.g. the cloud resending because it never saw our ack).
    const first = await pullOnce({ db, fetcher: fakeFetcher(remote) });
    expect(first.inserted).toBe(1);

    // Re-pull from watermark 0 again (replay) with the identical batch.
    const replayFetcher: PullFetcher = async () => ({ events: remote, next_cursor: null });
    const second = await pullOnce({ db, fetcher: replayFetcher });

    expect(second.inserted).toBe(0); // dedup by event_id — nothing new
    expect(second.atomsRecomputed).toBe(0); // scoped recompute only touches NEW events

    const count = db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE event_id = ?').get(eventId) as { n: number };
    expect(count.n).toBe(1); // exactly one row, not duplicated

    const memCount = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(atomId) as { n: number };
    expect(memCount.n).toBe(1); // exactly one memory row, not duplicated
  });

  it('drainPull is safe to call twice in a row (whole-drain idempotency)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const remote: RemotePullEvent[] = [
      makeCreateEvent(randomUUID(), { type: 'fact', text: 'a', normalized_text: 'a', hash: 'a'.repeat(64), scope: 'org' }, 100),
      makeCreateEvent(randomUUID(), { type: 'fact', text: 'b', normalized_text: 'b', hash: 'b'.repeat(64), scope: 'org' }, 200),
    ];
    const fetcher = fakeFetcher(remote, 1); // force multiple pages
    const first = await drainPull({ db, fetcher });
    expect(first.totalInserted).toBe(2);

    // Draining again from the now-advanced watermark returns nothing (the
    // fake fetcher's cursor is past the array end) — simulates a second
    // pull invocation finding no new work.
    const second = await drainPull({ db, fetcher });
    expect(second.totalInserted).toBe(0);
  });
});

describe('AC-4 — watermark persists across a daemon restart (resume, no gap, no re-pull from zero)', () => {
  it('a fresh DB handle on the same file resumes from the persisted cursor', async () => {
    const dir = mkTmp();
    const dbPath = join(dir, 'memory.sqlite');

    const remote: RemotePullEvent[] = [
      makeCreateEvent(randomUUID(), { type: 'fact', text: 'p1', normalized_text: 'p1', hash: '1'.repeat(64), scope: 'team' }, 100),
      makeCreateEvent(randomUUID(), { type: 'fact', text: 'p2', normalized_text: 'p2', hash: '2'.repeat(64), scope: 'team' }, 200),
      makeCreateEvent(randomUUID(), { type: 'fact', text: 'p3', normalized_text: 'p3', hash: '3'.repeat(64), scope: 'team' }, 300),
    ];
    const fetcher = fakeFetcher(remote, 1); // one event per page

    let db: DB = openDb(dbPath);
    migrate(db);

    // Pull only the FIRST page, then simulate a restart (close + reopen)
    // before the second page is fetched.
    const round1 = await pullOnce({ db, fetcher });
    expect(round1.inserted).toBe(1);
    const watermarkAfterRound1 = getPullWatermark(db);
    expect(watermarkAfterRound1).not.toBeNull();
    db.close();

    // "Restart": brand-new DB handle against the same file.
    db = openDb(dbPath);
    migrate(db);
    expect(getPullWatermark(db)).toBe(watermarkAfterRound1); // resumed, not reset to null

    // Continue pulling — must NOT re-fetch from cursor null (that would
    // re-insert event 1 with a fresh event_id collision check, but more
    // importantly would violate "no re-pull from zero"). Draining from here
    // should only pick up events 2 and 3.
    const rest = await drainPull({ db, fetcher });
    expect(rest.totalInserted).toBe(2);

    const total = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    expect(total.n).toBe(3); // all three, no duplicates, no gap

    db.close();
  });
});

describe('AC-5 — two-device simulation: B pulls what A pushed and holds an identical content hash', () => {
  it('SIMULATED (no live cloud): device B materializes the same atom with the same hash as device A', async () => {
    // Device A: a real local daemon DB where the memory is authored.
    const dbA = openDb(':memory:');
    migrate(dbA);
    const eventsA = new MemoryEventRepo(dbA);
    const { id: atomId, created } = new MemoryRepo(dbA).insertWithCreateEvent(
      {
        type: 'decision', text: 'use event-log merge for conflicts', normalized_text: 'use event-log merge for conflicts',
        repo: 'r1', project: null, branch: null, agent: null, session_id: null,
        hash: 'd'.repeat(64), source_hash: null, scope: 'team',
      },
      eventsA,
    );
    expect(created).toBe(true);
    const memoryA = dbA.prepare('SELECT * FROM memories WHERE id = ?').get(atomId) as { hash: string; text: string };

    // The 'create' event A actually shipped (event_id-bearing, per migration
    // 010 / ADR-011) — this is what a live cloud round trip would relay to
    // B. Since astramem-sync@1 doesn't carry atom bodies (see puller.ts file
    // header), this test constructs the atom_snapshot from A's own row to
    // model what B's pull response WOULD need to contain.
    const createEvent = eventsA.listForAtom(atomId).find(e => e.event_type === 'create')!;
    const remoteEvent: RemotePullEvent = {
      seq: createEvent.seq,
      event_id: createEvent.event_id,
      event_type: 'create',
      atom_id: atomId,
      payload_json: null,
      content_hash: createEvent.content_hash,
      created_at: createEvent.created_at,
      atom_snapshot: {
        type: 'decision', text: memoryA.text, normalized_text: memoryA.text,
        hash: memoryA.hash, scope: 'team', repo: 'r1',
      },
    };

    // Device B: a separate local daemon DB that has never seen this atom.
    const dbB = openDb(':memory:');
    migrate(dbB);
    const result = await pullOnce({ db: dbB, fetcher: fakeFetcher([remoteEvent]) });
    expect(result.inserted).toBe(1);

    const memoryB = dbB.prepare('SELECT * FROM memories WHERE id = ?').get(atomId) as { hash: string; text: string } | undefined;
    expect(memoryB).toBeDefined();
    expect(memoryB!.hash).toBe(memoryA.hash); // identical content hash (AC-5)
    expect(memoryB!.text).toBe(memoryA.text);
  });
});
