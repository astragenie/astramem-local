import type { EmbedHealth, EmbedProvider } from '../../contracts/embed.js';
import { TransientError, DeterministicError } from '../../pipeline/errors.js';

const EMBED_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 15_000;
const EXPECTED_DIM = 1024;
const DEFAULT_MODEL = 'text-embedding-3-small';

export interface AzureOpenAIEmbedConfig {
  endpoint: string;
  deployment: string;
  apiKey: string;
  apiVersion?: string;
  model?: string;
}

interface AzureEmbedResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
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
  readonly dim = EXPECTED_DIM as 1024;
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
  }

  private get embedUrl(): string {
    return `${this.endpoint}/openai/deployments/${this.deployment}/embeddings?api-version=${this.apiVersion}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const body = {
      input: texts,
      dimensions: EXPECTED_DIM,
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
      if (embedding.length !== EXPECTED_DIM) {
        throw new Error(
          `Azure embed dimension mismatch: expected ${EXPECTED_DIM}, got ${embedding.length}. ` +
            `Model: ${this.model}. Check that 'dimensions: ${EXPECTED_DIM}' is supported.`,
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
      dimensions: EXPECTED_DIM,
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
        dim: EXPECTED_DIM,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
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
