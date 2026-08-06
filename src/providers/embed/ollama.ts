import type { EmbedHealth, EmbedProvider } from '../../contracts/embed.js';
import { DEFAULT_EMBED_DIM } from '../../contracts/embed.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';
import { parseRetryAfterMs } from '../llm/retry-after.js';

const EMBED_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 10_000;

/** Default `keep_alive` for embed requests — see OllamaEmbedConfig.keepAlive.
 *  30m comfortably spans the gaps between distill bursts without pinning the
 *  model forever, which would contend with a locally-served LLM for VRAM. */
export const DEFAULT_EMBED_KEEP_ALIVE = '30m';

export interface OllamaEmbedConfig {
  baseUrl?: string;
  model?: string;
  /** FEAT-409: expected output dim — defaults to DEFAULT_EMBED_DIM (1024).
   * Set from config.embedding.dim by providers/index.ts. */
  dim?: number;
  /** RECALL-S1: query-side embedding instruction prefix — resolved by
   * providers/index.ts via resolveEmbedQueryPrefix, not this constructor.
   * See EmbedProvider.queryPrefix (src/contracts/embed.ts) for the full
   * asymmetry contract. Defaults to '' (no prefix). */
  queryPrefix?: string;
  /** How long Ollama keeps the embed model resident after each call, in its
   * own duration syntax ('30m', '1h', '-1' for forever, '0' to unload
   * immediately). Sent as `keep_alive` on every request.
   *
   * Ollama's own default is 5 minutes, and the daemon embeds in bursts
   * separated by long idle gaps — so without this the model is evicted
   * between bursts and the next call pays a full reload. Measured on the
   * 2026-08-05 onnx->ollama switch: 26ms warm vs 5,728ms after an idle
   * unload, and 11,353ms when the reload collided with daemon boot. That
   * cold path is the whole cost difference against the in-process ONNX
   * worker, which never unloads.
   *
   * mxbai-embed-large's quantized artifact is a few hundred MB, so holding
   * it resident is cheap next to an 8GB VRAM budget — but it is NOT free if
   * a local LLM is also loaded, which is why this is configurable rather
   * than pinned to '-1'. */
  keepAlive?: string;
}

interface OllamaEmbedResponse {
  embedding?: number[];
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

/**
 * Combines a caller-supplied cancellation signal with a fixed-duration
 * internal ceiling (issue #261): whichever fires first wins, and the
 * caller's signal is never dropped in favor of the internal one. When no
 * caller signal is passed, behaves exactly like the pre-fix
 * `AbortSignal.timeout(timeoutMs)`.
 */
function combineSignals(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const ownSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([externalSignal, ownSignal]) : ownSignal;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { ...init, signal: combineSignals(timeoutMs, externalSignal) });
      if (res.status >= 400 && res.status < 500) return res;
      if (res.status >= 500 && i === 0) {
        lastError = new Error(`HTTP ${res.status} from Ollama embed`);
        continue;
      }
      return res;
    } catch (err) {
      if (i === 0) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export class OllamaEmbedProvider implements EmbedProvider {
  readonly name = 'ollama' as const;
  readonly model: string;
  readonly dim: number;
  readonly queryPrefix: string;
  private readonly baseUrl: string;
  private readonly keepAlive: string;

  constructor(config: OllamaEmbedConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = config.model ?? 'mxbai-embed-large';
    this.dim = config.dim ?? DEFAULT_EMBED_DIM;
    this.queryPrefix = config.queryPrefix ?? '';
    this.keepAlive = config.keepAlive ?? DEFAULT_EMBED_KEEP_ALIVE;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const log = childLogger({ provider: this.name, model: this.model });
    const results: Float32Array[] = [];

    for (const text of texts) {
      const t0 = Date.now();
      const res = await fetchWithRetry(
        `${this.baseUrl}/api/embeddings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text, keep_alive: this.keepAlive }),
        },
        EMBED_TIMEOUT_MS,
        signal,
      );

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        const snippet = raw.slice(0, 200);
        const latency_ms = Date.now() - t0;
        log.warn({ latency_ms, status: res.status, error_kind: res.status >= 500 || res.status === 429 ? 'TransientError' : 'DeterministicError' }, 'ollama embed failed');
        if (res.status >= 500) {
          throw new TransientError(`Ollama embed failed: HTTP ${res.status} — ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
        }
        if (res.status === 429) {
          // Ollama is a local, unauthenticated single-model server — it has no
          // documented rate-limit behavior and is not observed to send this
          // header in practice. Parsed defensively for consistency with the
          // LLM providers; almost always resolves to undefined here.
          throw new TransientError(`Ollama embed rate-limited (429): ${snippet}`, undefined, parseRetryAfterMs(res.headers.get('retry-after')));
        }
        throw new DeterministicError(`Ollama embed failed: HTTP ${res.status} — ${snippet}`);
      }

      const data = (await res.json()) as OllamaEmbedResponse;
      if (!data.embedding) {
        throw new Error(`Ollama embed response missing 'embedding' field`);
      }

      if (data.embedding.length !== this.dim) {
        throw new Error(
          `Ollama embed dimension mismatch: expected ${this.dim}, got ${data.embedding.length} (model: ${this.model})`,
        );
      }

      const latency_ms = Date.now() - t0;
      log.info({ latency_ms, tokens_in: 0, tokens_out: this.dim }, 'ollama embed ok');
      results.push(new Float32Array(data.embedding));
    }

    return results;
  }

  async health(): Promise<EmbedHealth> {
    try {
      const t0 = Date.now();
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const latency_ms = Date.now() - t0;

      if (!res.ok) {
        return { ok: false, model: this.model, dim: this.dim, error: `HTTP ${res.status}` };
      }

      const data = (await res.json()) as OllamaTagsResponse;
      const models = data.models ?? [];
      const found = models.some(
        (m) => m.name === this.model || m.name.startsWith(`${this.model}:`),
      );
      void latency_ms; // latency not part of EmbedHealth interface
      return {
        ok: found,
        model: this.model,
        dim: this.dim,
        ...(found ? {} : { error: `model ${this.model} not found in ollama list` }),
      };
    } catch (err) {
      return {
        ok: false,
        model: this.model,
        dim: this.dim,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
