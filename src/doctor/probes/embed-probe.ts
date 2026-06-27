import type { EmbedProvider } from '../../contracts/embed.js';
import type { CheckResult } from '../types.js';

const EXPECTED_DIM = 1024;

/**
 * Embed probe: sends a real embedding call to the configured provider.
 *
 * Validates that the provider is reachable, the model is loaded, and the
 * returned vector is the expected 1024-dimensional shape. A dim mismatch
 * indicates a provider misconfiguration (wrong model, wrong dimensions
 * parameter for Azure) before it silently corrupts vector search.
 */
export async function embedProbe(
  provider: EmbedProvider,
  timeoutMs = 5000,
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
    if (!vec || vec.length !== EXPECTED_DIM) {
      return {
        ok: false,
        message: `${provider.name}: dim ${vec?.length ?? 0}, expected ${EXPECTED_DIM}`,
        fix: 'Misconfigured embed provider — check model and dimensions setting',
      };
    }

    return {
      ok: true,
      message: `${provider.name}/${provider.model} returned ${EXPECTED_DIM}-dim in ${latency}ms`,
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
