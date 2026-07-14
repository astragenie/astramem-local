/**
 * The distill-wait timeout could not fire.
 *
 * 2026-07-14: a full-suite LoCoMo run sat in `waitForSamplesDistilled` for 90
 * minutes with a 15-MINUTE timeout configured. Its ingest was already complete —
 * 272/272 transcripts, 2521 atoms on disk. It had one socket open to its own
 * daemon, zero to the answer provider, and flat CPU. It would never have scored.
 *
 * Two independent defects, and BOTH had to be true:
 *
 *   1. `sessionDigest` called `fetch` with no timeout and no abort signal, so a
 *      request that never settles never returns.
 *   2. `waitForSamplesDistilled` checked `Date.now() < deadline` ONLY in the outer
 *      `while` condition. Park inside the inner `await` and the condition is never
 *      re-evaluated.
 *
 * Together: a timeout that is structurally unreachable. Not late — unreachable.
 * This is the same shape as the bug that motivated ADR-015 (a guard that looks
 * like protection and cannot execute), which is why it gets a test that asserts
 * the guard FIRES, not merely that the happy path works.
 *
 * A test that only checks "ready sessions are reported ready" passes on the
 * broken code. That is exactly how this shipped.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitForSamplesDistilled } from './distill-wait.mts';
import type { IngestManifest } from './ingest.mts';

const bySample = (n: number): IngestManifest['by_sample'] =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`sample-${i}`, { session_ids: [`sess-${i}`] }]),
  ) as IngestManifest['by_sample'];

const client = { baseUrl: 'http://127.0.0.1:1', token: 'x' };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('waitForSamplesDistilled — the deadline must be REACHABLE', () => {
  it('returns when a digest request HANGS FOREVER (the 90-minute wedge)', async () => {
    // The precise production failure: fetch never settles. On the pre-fix code
    // this test does not fail — it HANGS, and the suite times out. That is the
    // point: an unreachable timeout cannot be caught by a passing assertion,
    // only by the absence of a return.
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      // Honor an abort signal if one is supplied — this is the fix. Without a
      // signal, this promise is a black hole.
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));

    const started = Date.now();
    const result = await waitForSamplesDistilled(client, bySample(3), {
      timeoutMs: 1_500,
      intervalMs: 50,
    });
    const elapsed = Date.now() - started;

    // It RETURNED. That is the whole assertion.
    expect(result.timed_out_sample_ids).toHaveLength(3);
    expect(result.ready_sample_ids).toHaveLength(0);
    // And it returned near the deadline, not at some multiple of it.
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it('a hung digest is NOT treated as ready — it must never silently deflate answers', async () => {
    // The dangerous "fix" would be to swallow the error into `true` and march on.
    // That races ahead of distillation and produces answers against a half-empty
    // store — with no visible error anywhere. Hung means NOT READY, always.
    vi.stubGlobal('fetch', (_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }));

    const result = await waitForSamplesDistilled(client, bySample(2), { timeoutMs: 800, intervalMs: 50 });

    expect(result.ready_sample_ids).toEqual([]);
    expect(result.timed_out_sample_ids.sort()).toEqual(['sample-0', 'sample-1']);
  }, 20_000);

  it('a digest that ERRORS is not fatal — one flaky poll must not kill a 4-hour run', async () => {
    // Rethrowing would abort the entire eval over a single transient failure.
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls <= 2) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ status: 'ready' }), { status: 200 });
    });

    const result = await waitForSamplesDistilled(client, bySample(1), { timeoutMs: 5_000, intervalMs: 20 });

    // It recovered and completed rather than exploding.
    expect(result.ready_sample_ids).toEqual(['sample-0']);
    expect(result.timed_out_sample_ids).toEqual([]);
  }, 20_000);

  it('the deadline bounds a SLOW round, not just a hung one', async () => {
    // 40 sessions x 200ms sequential = 8s per round, against a 1s deadline. The
    // pre-fix code checked the clock only between rounds, so it would run the
    // whole 8s round to completion — an 8x overshoot. The inner check bounds it.
    vi.stubGlobal('fetch', async () => {
      await new Promise(r => setTimeout(r, 200));
      return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
    });

    const started = Date.now();
    const result = await waitForSamplesDistilled(client, bySample(40), { timeoutMs: 1_000, intervalMs: 10 });
    const elapsed = Date.now() - started;

    expect(result.ready_sample_ids).toHaveLength(0);
    // Bounded near the deadline — NOT the 8s a full round would have taken.
    expect(elapsed).toBeLessThan(4_000);
  }, 20_000);

  it('still reports genuinely-ready samples (the happy path the old test covered)', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ status: 'ready' }), { status: 200 }));

    const result = await waitForSamplesDistilled(client, bySample(3), { timeoutMs: 5_000, intervalMs: 10 });

    expect(result.ready_sample_ids.sort()).toEqual(['sample-0', 'sample-1', 'sample-2']);
    expect(result.timed_out_sample_ids).toEqual([]);
  }, 20_000);
});
