// ADR-018 Tier 1 (issue #347) Decision 1b — handler-body deadline wrapper.
// See src/server/lib/deadline.ts's doc comment for what this does and does
// NOT protect against: it only catches a hang inside the wrapped handler's
// own async chain, never a full synchronous event-loop stall (that's 1a,
// tested in tests/consolidate/consolidate.test.ts).

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyReply } from 'fastify';
import { withDeadline, DEFAULT_HANDLER_DEADLINE_MS } from '../../../src/server/lib/deadline.js';

/** Minimal FastifyReply double — only the methods withDeadline touches. */
function fakeReply(): { reply: FastifyReply; sent: { code?: number; body?: unknown } } {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    code(statusCode: number) {
      sent.code = statusCode;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the handler result unchanged when it completes before the deadline', async () => {
    const { reply, sent } = fakeReply();
    const result = await withDeadline('TEST /fast', reply, async () => ({ ok: true, value: 42 }));
    expect(result).toEqual({ ok: true, value: 42 });
    expect(sent.code).toBeUndefined(); // reply never touched on the happy path
  });

  it('propagates a real handler error instead of swallowing it as a timeout', async () => {
    const { reply } = fakeReply();
    await expect(
      withDeadline('TEST /throws', reply, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('sends a 504 with a named, honest error body when the handler hangs past the deadline', async () => {
    vi.useFakeTimers();
    const { reply, sent } = fakeReply();
    const neverResolves = new Promise<never>(() => {}); // simulates a hung async chain

    const resultPromise = withDeadline('TEST /hangs', reply, () => neverResolves, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result).toBeUndefined();
    expect(sent.code).toBe(504);
    const body = sent.body as { error: string; message: string; route: string; timeout_ms: number };
    expect(body.error).toBe('handler_deadline_exceeded');
    expect(body.route).toBe('TEST /hangs');
    expect(body.timeout_ms).toBe(1_000);
    // Honesty caveat (ADR-018): must NOT read as "this caught issue #347" —
    // it must explicitly disclaim protection against a full event-loop stall.
    expect(body.message).toMatch(/cannot detect or protect/i);
    expect(body.message).toMatch(/synchronous event-loop stall/i);
  });

  it('does not fire the timeout after the handler already resolved (timer is cleared)', async () => {
    vi.useFakeTimers();
    const { reply, sent } = fakeReply();
    const result = await withDeadline('TEST /quick', reply, async () => 'done', 1_000);
    // Advance well past the deadline — if the timer weren't cleared, this
    // would be a no-op anyway since withDeadline already returned, but this
    // also guards against a dangling timer keeping the process alive.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBe('done');
    expect(sent.code).toBeUndefined();
  });

  it('defaults to DEFAULT_HANDLER_DEADLINE_MS when no explicit timeout is passed', async () => {
    vi.useFakeTimers();
    const { reply, sent } = fakeReply();
    const neverResolves = new Promise<never>(() => {});

    const resultPromise = withDeadline('TEST /default-timeout', reply, () => neverResolves);
    await vi.advanceTimersByTimeAsync(DEFAULT_HANDLER_DEADLINE_MS);
    await resultPromise;

    expect(sent.code).toBe(504);
    expect((sent.body as { timeout_ms: number }).timeout_ms).toBe(DEFAULT_HANDLER_DEADLINE_MS);
  });
});
