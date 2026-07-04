/**
 * SLICE-413 — Concurrency tests: parallel ingest + Idempotency-Key race.
 *
 * Per `.claude/artifacts/loop/plans/20260704T-preflight-FEAT-419.md`, the
 * hypothesized bug was a "claim -> finalize await window" inside
 * POST /ingest/transcript that a burst of concurrent same-key requests could
 * land inside, producing inconsistent replay bodies or a double distill
 * enqueue via the stale-pending takeover branch.
 *
 * Reading src/server/routes/ingest.ts closely disproves the premise: the
 * entire claim -> insert -> finalize sequence (both the transcript-kind path,
 * lines ~412-492, and the events-kind path via claimIdempotencySlot /
 * finalizeIdempotencySlot, lines ~296-332) runs inside ONE
 * `db.transaction(() => { ... })` call with ZERO `await` statements between
 * claim and finalize. better-sqlite3 is fully synchronous (blocking C++
 * bindings), and Node is single-threaded with run-to-completion semantics:
 * once a route handler with no internal `await` begins executing, it cannot
 * be preempted until it returns. There is no scheduler point where a second
 * request's code can run between claim and finalize of the first — this
 * holds for real OS sockets exactly as much as for Fastify's in-process
 * inject() (which the existing ingest.test.ts T1 comment already noted for
 * the injected case, attributing it to "better-sqlite3 serialises"; the
 * deeper reason is the absence of any await point in the critical section,
 * which holds regardless of transport).
 *
 * Same reasoning applies to job processing: src/pipeline/worker.ts drains
 * one job at a time (claim -> handle -> complete -> scheduleNext), so two
 * distill jobs can never execute concurrently either. There is therefore no
 * seam left to "gate" a mock provider against to force interleaving — the
 * embed/LLM calls happen later, in the worker, fully decoupled from the
 * ingest route's synchronous critical section. Rather than construct a fake
 * gate that cannot exercise anything, these tests fire real concurrent HTTP
 * requests over genuine OS sockets (not inject(), which serializes at the
 * Fastify dispatch level) and assert the invariants the plan cared about:
 * consistent (non-placeholder) summary_memory_id across a same-key burst,
 * exactly one distill enqueue, no stuck/duplicate jobs, and exactly one
 * winner on a same-key-different-body race.
 *
 * All three scenarios below were GREEN on first run (see run report) —
 * confirming no red-test evidence exists for this codebase revision. No
 * production fix landed (AC-4's "ship tests only" branch applies).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { createHealthState } from '../../src/server/health-state.js';
import { HandlerRegistry } from '../../src/pipeline/registry.js';
import { startWorker, type WorkerHandle } from '../../src/pipeline/worker.js';
import { distillHandler } from '../../src/pipeline/handlers/distill.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { defaultConfig } from '../../src/config/config.js';
import type { ExtendedHandlerCtx } from '../../src/pipeline/handler-ctx-ext.js';

// ---------------------------------------------------------------------------
// Shared fixture: real Fastify listen on an ephemeral port + a live worker
// draining the jobs table with mock providers. inject() would serialize
// requests at the Fastify dispatch layer, defeating the point of a
// concurrency test — a real socket + fetch() gives genuine concurrent
// dispatch.
// ---------------------------------------------------------------------------

let db: DB;
let app: FastifyInstance;
let worker: WorkerHandle;
let baseUrl: string;

const TOKEN = 'conc-test-tok';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

beforeAll(async () => {
  db = openDb(':memory:');
  migrate(db);

  const config = defaultConfig();
  const providers = makeMockProviders(config.embedding.dim);
  const healthState = createHealthState();

  app = await buildApp({ db, token: TOKEN, embed: providers.embed, config, healthState });

  const registry = new HandlerRegistry();
  registry.register(distillHandler);
  const extCtx: ExtendedHandlerCtx = {
    db,
    config,
    providers,
    memoryRepo: new MemoryRepo(db),
    vecStore: new SqliteVecStore(db, config.embedding.dim),
  };
  // Fast poll — this is a test, not production; keeps waitFor() bounds tight.
  worker = startWorker({ pollMs: 20, registry, db, config, ctx: extCtx, healthState });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await worker.stop();
  await app.close();
  db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic keyword match against src/pipeline/mock-providers.ts's
 *  extraction vocabulary — "sqlite-vec" always yields exactly one 'decision'
 *  atom, hence exactly one memory per successful distill. */
function makeCanonical(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'pre_compact',
    session_id: sessionId,
    project_id: 'proj-conc',
    captured_at: '2025-06-30T10:00:00.000Z',
    turns: [
      { role: 'user', text: 'lets use sqlite-vec for storage' },
      { role: 'assistant', text: 'agreed, sqlite-vec it is' },
    ],
    client_scrub_applied: true,
    client_scrub_hits: 0,
    client_version: '0.6.0',
    client_scrub_version: '1.2.0',
    wire_version: 'v1.0',
    ...extra,
  };
}

/** Bounded condition poll — NOT a blind sleep-and-hope; returns as soon as
 *  the predicate is true, throws with the deadline exceeded otherwise. */
async function waitFor(predicate: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const { timeoutMs = 8_000, intervalMs = 20 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}

function countJobs(kind: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE kind = ?').get(kind) as { n: number }).n;
}

function countMemories(sessionId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

function countStuckDistillJobs(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'distill' AND state NOT IN ('completed')").get() as { n: number }).n;
}

/** Look up the distill job state for a given transcript id (payload_json embeds it). */
function distillJobStateForTranscript(transcriptId: string): string | undefined {
  const row = db
    .prepare("SELECT state FROM jobs WHERE kind = 'distill' AND payload_json LIKE ?")
    .get(`%${transcriptId}%`) as { state: string } | undefined;
  return row?.state;
}

// ---------------------------------------------------------------------------
// AC-1 — k=5 identical key+body concurrent
// ---------------------------------------------------------------------------

describe('ingest concurrency — AC-1: k=5 identical Idempotency-Key + body', () => {
  it('exactly one distill job, consistent non-placeholder summary_memory_id, memory count == 1', async () => {
    const sessionId = 'conc-ac1-session';
    const key = 'conc-ac1-key';
    const payload = makeCanonical(sessionId);
    const headers = { ...AUTH, 'idempotency-key': key };
    const jobsBefore = countJobs('distill');

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}/ingest/transcript`, { method: 'POST', headers, body: JSON.stringify(payload) }),
      ),
    );
    const bodies = await Promise.all(
      responses.map(r => r.json() as Promise<{ ok: boolean; summary_memory_id: string; idempotent: boolean }>),
    );

    for (const r of responses) expect(r.status).toBe(200);

    const creators = bodies.filter(b => b.idempotent === false);
    const replays = bodies.filter(b => b.idempotent === true);
    expect(creators.length).toBe(1);
    expect(replays.length).toBe(4);

    // No dangling '__pending__' placeholder leak — every response, winner or
    // replay, must resolve to the SAME real transcript id.
    const ids = new Set(bodies.map(b => b.summary_memory_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe('__pending__');

    // Exactly one distill job enqueued for the whole k=5 burst.
    expect(countJobs('distill') - jobsBefore).toBe(1);

    // Distillation completes and yields exactly one memory (one fixture atom).
    await waitFor(() => countMemories(sessionId) === 1);
    expect(countMemories(sessionId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-2 — N=10 distinct keys/bodies concurrent
// ---------------------------------------------------------------------------

describe('ingest concurrency — AC-2: N=10 distinct concurrent ingests', () => {
  it('all accepted, all distilled within a bounded wait, none stuck or poisoned', async () => {
    const N = 10;
    const sessionIds = Array.from({ length: N }, (_, i) => `conc-ac2-session-${i}`);
    const jobsBefore = countJobs('distill');

    const responses = await Promise.all(
      sessionIds.map((sid, i) => {
        const payload = makeCanonical(sid, {
          turns: [{ role: 'user', text: `case ${i}: use sqlite-vec for storage` }],
        });
        const headers = { ...AUTH, 'idempotency-key': `conc-ac2-key-${i}` };
        return fetch(`${baseUrl}/ingest/transcript`, { method: 'POST', headers, body: JSON.stringify(payload) });
      }),
    );
    const bodies = await Promise.all(
      responses.map(r => r.json() as Promise<{ ok: boolean; summary_memory_id: string; idempotent: boolean }>),
    );

    for (const r of responses) expect(r.status).toBe(200);
    // Every request here has a distinct key + body, so every response is an
    // original create (never a replay) and summary_memory_id === transcript id.
    for (const b of bodies) expect(b.idempotent).toBe(false);
    expect(countJobs('distill') - jobsBefore).toBe(N);

    // AC-2 only requires reaching 'completed' distill state — NOT a per-session
    // memory count. The mock LLM's extraction vocabulary (mock-providers.ts)
    // returns a fixed canned atom TEXT for the "sqlite-vec" keyword regardless
    // of surrounding text, so all 10 sessions' extracted atoms are identical
    // and the pipeline's dedup stage collapses them into ONE memory row
    // (memories_created=0, deduped=1 for 9 of the 10) — that is correct
    // dedup behavior, not a concurrency bug, and orthogonal to what AC-2 tests.
    const transcriptIds = bodies.map(b => b.summary_memory_id);
    await waitFor(
      () => transcriptIds.every(id => distillJobStateForTranscript(id) === 'completed'),
      { timeoutMs: 15_000 },
    );
    for (const id of transcriptIds) expect(distillJobStateForTranscript(id)).toBe('completed');

    expect(countStuckDistillJobs()).toBe(0);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// AC-3 — same key, different bodies, concurrent
// ---------------------------------------------------------------------------

describe('ingest concurrency — AC-3: same Idempotency-Key, different bodies, concurrent', () => {
  it('exactly one 200 + one 409, no partial write', async () => {
    const sessionId = 'conc-ac3-session';
    const key = 'conc-ac3-key';
    const payloadA = makeCanonical(sessionId, { turns: [{ role: 'user', text: 'use sqlite-vec for storage' }] });
    const payloadB = makeCanonical(sessionId, { turns: [{ role: 'user', text: 'use a completely different approach' }] });
    const headers = { ...AUTH, 'idempotency-key': key };

    const [resA, resB] = await Promise.all([
      fetch(`${baseUrl}/ingest/transcript`, { method: 'POST', headers, body: JSON.stringify(payloadA) }),
      fetch(`${baseUrl}/ingest/transcript`, { method: 'POST', headers, body: JSON.stringify(payloadB) }),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const transcripts = db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE session_id = ?').get(sessionId) as { n: number };
    expect(transcripts.n).toBe(1);

    const idemRows = db.prepare('SELECT COUNT(*) AS n FROM ingest_idempotency WHERE key = ?').get(key) as { n: number };
    expect(idemRows.n).toBe(1);
  });
});
