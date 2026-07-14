import type { EmbedHealth, EmbedProvider } from '../../contracts/embed.js';
import { DEFAULT_EMBED_DIM } from '../../contracts/embed.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';
import { childLogger } from '../../log/logger.js';

const EMBED_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL = 'text-embedding-3-small';

export interface AzureOpenAIEmbedConfig {
  endpoint: string;
  deployment: string;
  apiKey: string;
  apiVersion?: string;
  model?: string;
  /** FEAT-409: expected/requested output dim — defaults to
   * DEFAULT_EMBED_DIM (1024). Set from config.embedding.dim by
   * providers/index.ts. Sent as the Azure `dimensions` request param. */
  dim?: number;
  /** RECALL-S1: query-side embedding instruction prefix — resolved by
   * providers/index.ts via resolveEmbedQueryPrefix, not this constructor.
   * See EmbedProvider.queryPrefix (src/contracts/embed.ts) for the full
   * asymmetry contract. Defaults to '' (no prefix). */
  queryPrefix?: string;
}

interface AzureEmbedResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
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
        lastError = new Error(`HTTP ${res.status} from Azure embed`);
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

export class AzureOpenAIEmbedProvider implements EmbedProvider {
  readonly name = 'azure-openai' as const;
  readonly model: string;
  readonly dim: number;
  readonly queryPrefix: string;
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly apiKey: string;
  private readonly apiVersion: string;

  constructor(config: AzureOpenAIEmbedConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.deployment = config.deployment;
    this.apiKey = config.apiKey;
    this.apiVersion = config.apiVersion ?? '2024-10-21';
    this.model = config.model ?? DEFAULT_MODEL;
    this.dim = config.dim ?? DEFAULT_EMBED_DIM;
    this.queryPrefix = config.queryPrefix ?? '';
  }

  private get embedUrl(): string {
    return `${this.endpoint}/openai/deployments/${this.deployment}/embeddings?api-version=${this.apiVersion}`;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const body = {
      input: texts,
      dimensions: this.dim,
    };

    const res = await fetchWithRetry(
      this.embedUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      },
      EMBED_TIMEOUT_MS,
      signal,
    );

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as AzureEmbedResponse;
        detail = parsed.error?.message ?? raw;
      } catch {
        // leave as raw text
      }
      const snippet = detail.slice(0, 200);
      if (res.status >= 500) {
        throw new TransientError(`Azure OpenAI embed failed: HTTP ${res.status} — ${snippet}`);
      }
      if (res.status === 429) {
        throw new TransientError(`Azure OpenAI embed rate-limited (429): ${snippet}`);
      }
      throw new DeterministicError(`Azure OpenAI embed failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as AzureEmbedResponse;
    if (!data.data || data.data.length === 0) {
      throw new Error(`Azure embed response missing 'data' array`);
    }

    // Sort by index to preserve input order
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const results: Float32Array[] = [];
    for (const item of sorted) {
      const embedding = item.embedding;
      if (!embedding) {
        throw new Error(`Azure embed response item missing 'embedding' field`);
      }
      if (embedding.length !== this.dim) {
        throw new Error(
          `Azure embed dimension mismatch: expected ${this.dim}, got ${embedding.length}. ` +
            `Model: ${this.model}. Check that 'dimensions: ${this.dim}' is supported.`,
        );
      }
      results.push(new Float32Array(embedding));
    }

    if (results.length !== texts.length) {
      throw new Error(
        `Azure embed count mismatch: sent ${texts.length} texts, got ${results.length} embeddings`,
      );
    }

    return results;
  }

  async health(): Promise<EmbedHealth> {
    // Ping with a 1-item embed request
    const body = {
      input: ['ping'],
      dimensions: this.dim,
    };
    try {
      const t0 = Date.now();
      const res = await fetch(this.embedUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      void (Date.now() - t0); // latency not part of EmbedHealth interface
      return {
        ok: res.ok,
        model: this.model,
        dim: this.dim,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
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
