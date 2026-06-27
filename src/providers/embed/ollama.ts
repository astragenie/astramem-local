import type { EmbedHealth, EmbedProvider } from '../../contracts/embed.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';

const EMBED_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 10_000;
const EXPECTED_DIM = 1024;

export interface OllamaEmbedConfig {
  baseUrl?: string;
  model?: string;
}

interface OllamaEmbedResponse {
  embedding?: number[];
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
  readonly dim = EXPECTED_DIM as 1024;
  private readonly baseUrl: string;

  constructor(config: OllamaEmbedConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = config.model ?? 'nomic-embed-text-v2-moe';
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];

    for (const text of texts) {
      const res = await fetchWithRetry(
        `${this.baseUrl}/api/embeddings`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
        },
        EMBED_TIMEOUT_MS,
      );

      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        const snippet = raw.slice(0, 200);
        if (res.status >= 500) {
          throw new TransientError(`Ollama embed failed: HTTP ${res.status} — ${snippet}`);
        }
        if (res.status === 429) {
          throw new TransientError(`Ollama embed rate-limited (429): ${snippet}`);
        }
        throw new DeterministicError(`Ollama embed failed: HTTP ${res.status} — ${snippet}`);
      }

      const data = (await res.json()) as OllamaEmbedResponse;
      if (!data.embedding) {
        throw new Error(`Ollama embed response missing 'embedding' field`);
      }

      if (data.embedding.length !== EXPECTED_DIM) {
        throw new Error(
          `Ollama embed dimension mismatch: expected ${EXPECTED_DIM}, got ${data.embedding.length} (model: ${this.model})`,
        );
      }

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
        return { ok: false, model: this.model, dim: EXPECTED_DIM, error: `HTTP ${res.status}` };
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
        dim: EXPECTED_DIM,
        ...(found ? {} : { error: `model ${this.model} not found in ollama list` }),
      };
    } catch (err) {
      return {
        ok: false,
        model: this.model,
        dim: EXPECTED_DIM,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
