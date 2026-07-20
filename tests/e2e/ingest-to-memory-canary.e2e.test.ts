/**
 * tests/e2e/ingest-to-memory-canary.e2e.test.ts — FEAT-483 SLICE-1 acceptance
 * gate: the ingest -> distill -> embed -> search CI canary.
 *
 * This closes the "extraction returned empty JSON, 30 poisoned jobs, nothing
 * alerted" incident class: every stage of the pipeline can individually be
 * green (unit tests pass, doctor is quiet) while the WHOLE wire from a real
 * POST to a searchable memory is silently broken end to end. Nothing in the
 * unit suite drives the full path; this test does, on every PR.
 *
 * Design notes:
 *
 * 1. Marker phrase choice ("sqlite-vec"). The mock LLM extraction provider
 *    (src/pipeline/mock-providers.ts, vocabulary in
 *    src/pipeline/mock-extraction-vocab.ts) is a CLOSED deterministic
 *    keyword -> canned-atom table — it does not echo arbitrary transcript
 *    content back into the extracted atom text, so a per-run random UUID
 *    embedded in the transcript body could never surface in the resulting
 *    memory. "sqlite-vec" is the vocabulary's own trigger keyword and is
 *    the same convention every sibling e2e test in this directory already
 *    relies on (tests/e2e/plugin-flow.test.ts,
 *    tests/e2e/evidence-transcript-session-canary.e2e.test.ts,
 *    tests/e2e/auto-capture-close.e2e.test.ts). Uniqueness-per-run is
 *    provided by the isolated per-test daemon + tmp data dir
 *    (makeIsolatedDaemonEnv) rather than by the marker text itself — no
 *    other process can ever have written a competing "sqlite-vec" memory
 *    into this sandbox.
 *
 * 2. SLA assertion (<=5s). Distillation with mock LLM/embed providers has no
 *    real network latency — the worker poll loop runs every 500ms
 *    (src/cli/serve.ts) and each of the 8 pipeline stages is a synchronous
 *    in-process call, so an ingest -> searchable-memory round trip has no
 *    structural reason to exceed low seconds. This in-test SLA is distinct
 *    from (and much tighter than) the 5-MINUTE doctor-side SLA that is
 *    SLICE-2's concern — this test only proves the pipeline itself is fast
 *    and correct, not that a production daemon's periodic doctor canary
 *    would catch a regression within 5 minutes.
 *
 * 3. Negative control (empty-atoms poisoning). A canary that can never fail
 *    is worthless (the exact "everything green, nothing works" failure this
 *    FEAT exists to close). The negative case posts a transcript containing
 *    NONE of MOCK_EXTRACTION_VOCAB's keywords, which deterministically makes
 *    the mock LLM return `{"atoms":[]}` — byte-identical in shape to the
 *    real incident's poisoned extraction output — and asserts no memory
 *    referencing that transcript's content ever becomes searchable. Because
 *    "never becomes searchable" cannot be proven by polling for a positive
 *    condition, this waits for the enqueued distill job to reach a terminal
 *    state via GET /health/full's `queue` block (queryJobStates,
 *    src/server/queries/dashboard.ts) before checking search — otherwise a
 *    too-early check would pass for the wrong reason (job still in flight,
 *    not "correctly produced nothing").
 *
 * Isolated daemon (makeIsolatedDaemonEnv) — never touches port 7777,
 * %LOCALAPPDATA%\Astramem, or the operator's real config/keystore.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  spawnDaemon,
  killDaemon,
  waitForHealthReachable,
  pollSearchHits,
  pollUntil,
  makeIsolatedDaemonEnv,
  cleanupIsolatedDaemonEnv,
  type DaemonHandle,
  type IsolatedDaemonEnv,
  type SearchHit,
} from '../smoke/helpers/daemon.js';

const TOKEN = `e2etok-ingest-memory-canary-${randomUUID()}`;

/** In-test SLA for the positive path — see design note 2 above. */
const SLA_MS = 5_000;

interface QueueSnapshot {
  pending: number;
  running: number;
  /** Sum across every state bucket — used to detect "a new job appeared". */
  total: number;
}

/** GET /health/full requires Bearer auth (unlike public GET /health) — see
 *  src/server/app.ts's auth preHandler hook, which only exempts the bare
 *  '/health' and '/version' paths from the loopback-bind bypass. */
async function fetchQueueSnapshot(baseUrl: string, token: string): Promise<QueueSnapshot> {
  const res = await fetch(`${baseUrl}/health/full`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /health/full -> ${res.status}`);
  const body = (await res.json()) as { queue?: Record<string, number> };
  const queue = body.queue ?? {};
  const total = Object.values(queue).reduce((a, b) => a + b, 0);
  return { pending: queue['pending'] ?? 0, running: queue['running'] ?? 0, total };
}

/**
 * Wait until at least one new job (relative to `baselineTotal`) has been
 * enqueued AND every job has reached a terminal state (no pending/running
 * rows left) — the "it's safe to assert absence now" signal the negative
 * control needs (see design note 3 above).
 */
async function waitForQueueDrained(
  baseUrl: string,
  token: string,
  baselineTotal: number,
  timeoutMs: number,
): Promise<void> {
  await pollUntil(
    () => fetchQueueSnapshot(baseUrl, token),
    snap => snap.total > baselineTotal && snap.pending === 0 && snap.running === 0,
    {
      label: 'GET /health/full queue to drain (pending=0, running=0) after the new distill job was enqueued',
      timeoutMs,
      intervalMs: 100,
    },
  );
}

/** Canonical wire envelope (FEAT-4a Phase 2), same shape buildClaudeEnvelope
 *  produces — mirrors tests/e2e/evidence-transcript-session-canary.e2e.test.ts. */
function makeEnvelope(sessionId: string, turns: Array<{ role: 'user' | 'assistant'; text: string }>) {
  return {
    event: 'session_end' as const,
    session_id: sessionId,
    project_id: 'astramemory-local',
    agent_type: 'claude-code',
    cwd: '/home/u/proj-ingest-memory-canary',
    captured_at: new Date().toISOString(),
    kind: 'transcript' as const,
    tool: 'claude-code',
    turns,
    client_scrub_applied: false,
    client_scrub_hits: 0,
    client_version: 'test-canary',
    client_scrub_version: 'none',
    wire_version: 'v1.0',
  };
}

describe('Ingest-to-memory CI e2e canary (FEAT-483 SLICE-1)', () => {
  let daemon: DaemonHandle | null = null;
  let isolated: IsolatedDaemonEnv | null = null;

  beforeAll(async () => {
    isolated = makeIsolatedDaemonEnv('ingest-memory-canary');
    daemon = await spawnDaemon({ port: 0, token: TOKEN, env: isolated.env });
    daemon.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[daemon] ${chunk.toString()}`);
    });
    await waitForHealthReachable(daemon.baseUrl);
    expect(daemon.exitInfo().code, 'daemon should still be running after boot').toBeNull();
  }, 20_000);

  afterAll(async () => {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 3_000);
    if (isolated) cleanupIsolatedDaemonEnv(isolated);
  });

  it(
    'GIVEN a sandboxed mock-provider daemon WHEN a transcript with the marker phrase is ingested THEN it is searchable within the SLA',
    async () => {
      const d = daemon!;
      const sessionId = `e2e-canary-positive-${randomUUID().slice(0, 8)}`;
      const marker = 'sqlite-vec';
      const envelope = makeEnvelope(sessionId, [
        { role: 'user', text: 'What vector store should we use for v1?' },
        { role: 'assistant', text: `OK let's go with ${marker} for v1 vector storage — no network dependency.` },
      ]);

      const startedAt = Date.now();
      const ingestRes = await fetch(`${d.baseUrl}/ingest/transcript`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      expect(ingestRes.status, 'ingest should return 200').toBe(200);
      const ingestBody = (await ingestRes.json()) as { ok: boolean };
      expect(ingestBody.ok).toBe(true);

      const hits = await pollSearchHits(
        d.baseUrl,
        TOKEN,
        'sqlite',
        found => found.filter(h => h.type === 'decision' && h.text.toLowerCase().includes(marker)),
        {
          label: `GET ${d.baseUrl}/search?q=sqlite to return a decision memory containing '${marker}' within the SLA`,
          timeoutMs: SLA_MS,
          intervalMs: 100,
        },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.text.toLowerCase()).toContain(marker);
      expect(elapsedMs, `ingest -> searchable memory should complete within the ${SLA_MS}ms SLA`).toBeLessThanOrEqual(SLA_MS);
    },
    SLA_MS + 15_000,
  );

  it(
    'NEGATIVE control: GIVEN a transcript matching none of the mock extraction vocab WHEN ingested THEN no memory is produced (proves the canary can fail)',
    async () => {
      const d = daemon!;
      const baseline = await fetchQueueSnapshot(d.baseUrl, TOKEN);
      const sessionId = `e2e-canary-negative-${randomUUID().slice(0, 8)}`;
      const negativeMarker = 'quarterly picnic committee';
      // Deliberately avoids every MOCK_EXTRACTION_VOCAB keyword (sqlite-vec,
      // sqlite_vec, priya nair, astramemory-local, typescript, todo:,
      // prefers markdown summaries — src/pipeline/mock-extraction-vocab.ts)
      // so the mock LLM's extraction branch returns the exact `{"atoms":[]}`
      // shape the real incident produced.
      const envelope = makeEnvelope(sessionId, [
        { role: 'user', text: 'Can we sync up about the roadmap sometime this week?' },
        { role: 'assistant', text: `Sure, let's grab time Thursday to review the ${negativeMarker} logistics.` },
      ]);

      const ingestRes = await fetch(`${d.baseUrl}/ingest/transcript`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      expect(ingestRes.status, 'ingest should return 200 even for a zero-atom extraction').toBe(200);
      const ingestBody = (await ingestRes.json()) as { ok: boolean };
      expect(ingestBody.ok).toBe(true);

      // Wait for the enqueued distill job to actually finish before
      // asserting absence — see design note 3 in the file doc comment.
      await waitForQueueDrained(d.baseUrl, TOKEN, baseline.total, SLA_MS + 10_000);

      const searchRes = await fetch(
        `${d.baseUrl}/search?q=${encodeURIComponent('picnic')}&limit=20`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      expect(searchRes.ok, 'search should still respond 200 with zero atoms extracted').toBe(true);
      const searchBody = (await searchRes.json()) as { hits: SearchHit[] };
      const matches = searchBody.hits.filter(h => h.text.toLowerCase().includes(negativeMarker));
      expect(
        matches.length,
        'a poisoned/empty-atoms extraction must not silently produce a searchable memory',
      ).toBe(0);
    },
    SLA_MS + 20_000,
  );
});
