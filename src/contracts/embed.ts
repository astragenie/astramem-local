export interface EmbedHealth {
  ok: boolean;
  model: string;
  dim: number;
  error?: string;
}

/**
 * Embedding provider. v1 invariant: `dim` is 1024 system-wide.
 *
 * Same dimension across providers does NOT make their vectors comparable —
 * each model maps to a different geometric space. Switching the configured
 * embedding provider requires a full re-embed pass on existing memories.
 * Doctor enforces the configured-vs-stored model match at startup.
 *
 * The 1024 literal is intentional and locked for v1 to match both
 * `mxbai-embed-large` (Ollama default, native 1024) and
 * `text-embedding-3-*` (Azure, configured via `dimensions: 1024`).
 */
export interface EmbedProvider {
  readonly name: 'ollama' | 'azure-openai';
  readonly model: string;
  readonly dim: 1024;
  embed(texts: string[]): Promise<Float32Array[]>;
  health(): Promise<EmbedHealth>;
}
