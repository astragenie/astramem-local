// FEAT-407 (ADR-011) — sync pull: dedup-insert by event_id, watermark
// persistence, scoped conflict-resolve wiring.
//
// SIMULATION CAVEAT: there is no live SaaS repo available locally (see the
// FEAT-407 completion report). `PullFetcher` is injectable specifically so
// these tests can simulate a remote event source (either "the cloud", or —
// for AC-5 — a second local device) without a real network round trip.
// AC-5 in particular is proven here as a same-process two-database
// simulation, NOT a live device-A -> cloud -> device-B round trip.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { pullOnce, drainPull, getPullWatermark, httpPullFetcher, type PullFetcher, type RemotePullEvent } from '../../src/sync/puller.js';

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

describe('FEAT-495 item 3 — a malformed usefulness-typed payload arriving mid-batch does not wedge the pull', () => {
  // dedupInsertEvent (src/sync/puller.ts) always routes payload_json through
  // JSON.stringify before insert, which by construction can never itself
  // produce syntactically INVALID JSON text from valid JS input — so a
  // literally malformed wire payload cannot be smuggled through the typed
  // RemotePullEvent contract as-is (review finding: this is why the fix's
  // narrative is "guards against a malformed row however it got there," not
  // "the wire literally sends broken JSON text"). To exercise the REAL
  // pullOnce()/dedupInsertEvent() code paths end-to-end with a payload that
  // becomes genuinely malformed at the DB boundary, this spies on
  // JSON.stringify for exactly ONE object (matched by identity, `===`, so
  // every other call — including pino's own internal JSON.stringify use for
  // structured logging — passes through to the real implementation
  // unaffected) and makes THAT ONE call return invalid JSON text, standing
  // in for "this payload arrived corrupted, by whatever mechanism." This
  // proves the acceptance-critical claim directly through puller.ts's own
  // exported functions, not a bespoke script: a poisoned event mixed into a
  // real pull batch no longer wedges the batch or the watermark.
  // NOTE: `run` is async and must be AWAITED inside the try block — restoring
  // the spy in `finally` without awaiting would restore the real
  // JSON.stringify before pullOnce's internal async work (which awaits the
  // fetcher first, then synchronously calls JSON.stringify from inside its
  // db.transaction callback) ever reaches the point that needs the fake.
  async function withMalformedStringifyFor<T>(sentinel: object, run: () => Promise<T>): Promise<T> {
    const real = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown, ...rest: unknown[]) => {
      if (value === sentinel) return '{not valid json';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (real as any)(value, ...rest);
    });
    try {
      return await run();
    } finally {
      spy.mockRestore();
    }
  }

  it('lands every healthy event and advances the watermark past the batch, with the poisoned event mixed in', async () => {
    const db = openDb(':memory:');
    migrate(db); // applies migration 045's guard — this is the FIXED schema

    const atomA = randomUUID();
    const atomB = randomUUID();
    const malformedPayloadSentinel = { family: 'recall_served' }; // identity-matched below, content irrelevant

    const batch: RemotePullEvent[] = [
      makeCreateEvent(atomA, {
        type: 'fact', text: 'first remote memory', normalized_text: 'first remote memory',
        hash: 'a'.repeat(64), scope: 'team', repo: 'r1',
      }, 1000),
      // The poisoned event: a 'usefulness' event (the type whose leading
      // equality predicate the vulnerable partial indexes share) whose
      // payload_json will stringify to malformed text — mixed in the MIDDLE
      // of the batch, same as a real interleaved multi-device event stream.
      {
        seq: 0,
        event_id: randomUUID(),
        event_type: 'usefulness',
        atom_id: atomA,
        payload_json: malformedPayloadSentinel,
        content_hash: null,
        created_at: 1500,
      },
      makeCreateEvent(atomB, {
        type: 'fact', text: 'second remote memory', normalized_text: 'second remote memory',
        hash: 'b'.repeat(64), scope: 'team', repo: 'r1',
      }, 2000),
    ];

    // Page size 2: page 1 is [healthy A, poisoned] — the poisoned event lands
    // in the SAME round as a healthy one, and page 1's cursor is a genuine
    // non-null intermediate value (not "everything fit in one page, cursor
    // trivially null" — a real mid-stream position the next round must not
    // re-select).
    const fetcher = fakeFetcher(batch, 2);

    const round1 = await withMalformedStringifyFor(malformedPayloadSentinel, () =>
      pullOnce({ db, fetcher }),
    );

    // The batch did not roll back: both page-1 events landed (not 0, not
    // just the healthy one with the poisoned one silently dropped).
    expect(round1.fetched).toBe(2);
    expect(round1.inserted).toBe(2);
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(atomA)).toBeDefined();

    // The poisoned event itself is durably recorded (not silently dropped —
    // this repo's own "no silent error swallowing" rule), just with payload
    // text that doesn't parse as JSON.
    const poisonedRow = db.prepare(
      `SELECT payload_json FROM memory_events WHERE atom_id = ? AND event_type = 'usefulness'`,
    ).get(atomA) as { payload_json: string } | undefined;
    expect(poisonedRow?.payload_json).toBe('{not valid json');

    // The watermark ADVANCED past page 1 — the acceptance-critical claim. A
    // stuck-at-null (or stuck-at-the-prior-cursor) watermark is exactly the
    // "re-fetch the same poisoned batch forever" failure this fix closes.
    expect(round1.cursor).not.toBeNull();
    expect(getPullWatermark(db)).toBe(round1.cursor);

    // Round 2 continues from that watermark and picks up ONLY page 2 (the
    // remaining healthy atom B) — proving the watermark genuinely moved past
    // the poisoned event rather than re-selecting page 1 forever.
    const round2 = await pullOnce({ db, fetcher });
    expect(round2.fetched).toBe(1);
    expect(round2.inserted).toBe(1);
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(atomB)).toBeDefined();
    expect(round2.cursor).toBeNull(); // fully drained
    expect(getPullWatermark(db)).toBeNull();

    // A third round: `fakeFetcher` treats a null cursor as "start from index
    // 0" (same quirk AC-2's replay test exercises), so this re-offers the
    // same 3 events rather than reporting idle — but event_id dedup
    // (AC-2) means nothing NEW is inserted and nothing throws. No infinite
    // re-fetch loop that WEDGES (rolls back / never advances) on the
    // poisoned batch, which is the actual claim this test proves.
    const round3 = await pullOnce({ db, fetcher });
    expect(round3.inserted).toBe(0);
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

describe('httpPullFetcher — real-transport error path (astramem-local#81)', () => {
  function fakeFetch(status: number, bodyText: string): typeof fetch {
    return (async () => ({
      ok: status < 400,
      status,
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText || '{}'),
    })) as unknown as typeof fetch;
  }

  it('a non-2xx response throws with the cloud error body included, not just the status', async () => {
    const fetcher = httpPullFetcher('https://cloud.example', 'tok', fakeFetch(403, '{"error":"sync_disabled"}'));
    await expect(fetcher(null, 100)).rejects.toThrow('sync pull failed: HTTP 403 {"error":"sync_disabled"}');
  });

  it('omits the trailing space when the failure response has no body', async () => {
    const fetcher = httpPullFetcher('https://cloud.example', 'tok', fakeFetch(500, ''));
    let caught: Error | undefined;
    try {
      await fetcher(null, 100);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toBe('sync pull failed: HTTP 500');
  });

  it('a 2xx response with events[] still parses normally', async () => {
    const fetcher = httpPullFetcher('https://cloud.example', 'tok', fakeFetch(200, '{"events":[],"next_cursor":null}'));
    const batch = await fetcher(null, 100);
    expect(batch).toEqual({ events: [], next_cursor: null });
  });
});
