import type { EmbedProvider } from '../../contracts/embed.js';
import type { CheckResult } from '../types.js';
import { withAbortableTimeout } from '../../util/abortable-timeout.js';

class EmbedProbeTimeoutError extends Error {}

/**
 * Embed probe: sends a real embedding call to the configured provider.
 *
 * Validates that the provider is reachable, the model is loaded, and the
 * returned vector matches the expected dim. A dim mismatch indicates a
 * provider misconfiguration (wrong model, wrong dimensions parameter for
 * Azure, or a stale config after an un-migrated `embedding.dim` edit)
 * before it silently corrupts vector search.
 *
 * FEAT-409: `expectedDim` defaults to `provider.dim` — the provider was
 * itself constructed from config.embedding.dim (providers/index.ts), so
 * this stays config-derived without every caller needing to thread it
 * through explicitly. Pass it explicitly to check against a DIFFERENT
 * expectation (e.g. the schema dim of a DB the provider hasn't been
 * pointed at yet).
 *
 * Issue #261: a bare Promise.race abandoned the losing promise rather than
 * cancelling it — a slow/hung embed call kept running to completion in the
 * background after this probe already "timed out", invisibly holding the
 * provider's execution slot. `withAbortableTimeout` both cancels the
 * in-flight request via EmbedProvider.embed's `signal` param (combined
 * with, not replacing, the provider's own internal timeout) AND still races
 * a timer so a provider that ignores the signal degrades to the old
 * bounded-wait behavior rather than hanging this probe forever.
 */
export async function embedProbe(
  provider: EmbedProvider,
  timeoutMs = 5000,
  expectedDim: number = provider.dim,
): Promise<CheckResult> {
  try {
    const start = Date.now();
    const vecs = await withAbortableTimeout(
      (signal) => provider.embed(['ping'], signal),
      timeoutMs,
      () => new EmbedProbeTimeoutError('timeout'),
    );
    const latency = Date.now() - start;

    const vec = vecs[0];
    if (!vec || vec.length !== expectedDim) {
      return {
        ok: false,
        message: `${provider.name}: dim ${vec?.length ?? 0}, expected ${expectedDim}`,
        fix: 'Misconfigured embed provider — check model and dimensions setting',
      };
    }

    return {
      ok: true,
      message: `${provider.name}/${provider.model} returned ${expectedDim}-dim in ${latency}ms`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `${provider.name}: ${msg}`,
      fix: 'Check provider config + model',
    };
  }
}
