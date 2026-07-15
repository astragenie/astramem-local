/**
 * Handler-body deadline wrapper (ADR-019 Tier 1, issue #347, Decision 1b).
 *
 * HONESTY NOTE — read this before treating `withDeadline` as "the fix" for
 * issue #347. This wrapper's own timer is itself an ordinary
 * `setTimeout`-family event-loop timer: it can only fire while the event
 * loop is free to run callbacks. #347's confirmed root cause (ADR-019) is a
 * *fully synchronous*, unyielded stretch inside `runConsolidation()`'s
 * pairwise scan (`src/consolidate/consolidate.ts`) that blocks the entire
 * event loop for the duration of the scan. During that stall this wrapper's
 * timer cannot fire, AND the wrapped route handler is never even entered —
 * Node can't service the incoming-request libuv event until the stall
 * clears, so the request sits queued, not "inside the handler waiting on
 * this timer." **This wrapper provides zero protection against issue
 * #347's confirmed mechanism.** The actual fix for #347 is the
 * cooperative-yield insertion in `runConsolidation`'s double loop
 * (`ConsolidateOpts.yieldEveryNPairs`, Decision 1a) — see ADR-019.
 *
 * What this DOES protect against: a hang *inside* the wrapped handler's own
 * async chain, once the handler has actually been entered — e.g. a future
 * embed/rerank call whose `AbortSignal` never fires due to a provider
 * defect. That is a real, narrower bug class worth guarding, distinct from
 * #347. Both the log line and the response body below restate this
 * limitation explicitly so a timeout here is never mistaken for "the #347
 * fix caught it."
 */

import type { FastifyReply } from 'fastify';
import { childLogger } from '../../log/logger.js';

const log = childLogger({ component: 'deadline' });

/** Default deadline for a wrapped handler body — comfortably inside
 *  Fastify's connection-level `requestTimeout` (60s, `app.ts`), so a clean
 *  504 with a named error has a chance to reach the client before the raw
 *  connection is torn down. */
export const DEFAULT_HANDLER_DEADLINE_MS = 30_000;

// Unique sentinel (not a string literal) so a legitimate handler result can
// never collide with the timeout outcome in the `Promise.race`.
const TIMEOUT_MARKER = Symbol('deadline-timeout');

/**
 * Races `fn()` against a `timeoutMs` timer. On timeout, sends a `504` with
 * a named, honest error body directly via `reply` and resolves `undefined`
 * — it does not throw. On success, resolves `fn()`'s own result unchanged
 * (including the case where `fn()` itself already called `reply.send()`,
 * matching this codebase's existing "return the reply instance" idiom for
 * early-exit branches). A rejection from `fn()` propagates as-is, so
 * Fastify's normal error handling still applies to real handler errors —
 * this wrapper only intercepts the *timeout* outcome, never swallows an
 * exception.
 *
 * Does NOT cancel `fn()` on timeout (no `AbortController` plumbed through
 * today) — if `fn()` eventually settles after the timeout fired, its result
 * is discarded; the reply has already been sent.
 */
export async function withDeadline<T>(
  route: string,
  reply: FastifyReply,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_HANDLER_DEADLINE_MS,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<typeof TIMEOUT_MARKER>(resolve => {
    timer = setTimeout(() => resolve(TIMEOUT_MARKER), timeoutMs);
  });
  try {
    const result = await Promise.race([fn(), timedOut]);
    if (result === TIMEOUT_MARKER) {
      log.warn(
        { route, timeout_ms: timeoutMs },
        'deadline: handler exceeded its own async-chain deadline — sending 504. ' +
        'This does NOT mean a full event-loop stall (e.g. issue #347) was caught; ' +
        'a full stall prevents this timer from firing at all — see ADR-019 / this module\'s doc comment.',
      );
      reply.code(504).send({
        error: 'handler_deadline_exceeded',
        message:
          `Handler did not complete within ${timeoutMs}ms. This timeout only detects a hang inside ` +
          'this request\'s own async chain (e.g. a stuck downstream call) — it cannot detect or protect ' +
          'against a full synchronous event-loop stall elsewhere in the process (see ADR-019).',
        route,
        timeout_ms: timeoutMs,
      });
      return undefined;
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
