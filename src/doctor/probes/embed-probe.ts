import type { EmbedProvider } from '../../contracts/embed.js';
import type { CheckResult } from '../types.js';

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
 */
export async function embedProbe(
  provider: EmbedProvider,
  timeoutMs = 5000,
  expectedDim: number = provider.dim,
): Promise<CheckResult> {
  try {
    const start = Date.now();
    const vecs = await Promise.race([
      provider.embed(['ping']),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), timeoutMs),
      ),
    ]);
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
