export interface EmbedHealth {
  ok: boolean;
  model: string;
  dim: number;
  error?: string;
}

/**
 * Default/legacy embedding dimension (FEAT-409). This is the ONE source of
 * truth every coordinated surface derives from: config default
 * (config.ts), embed providers (ollama.ts / azure-openai.ts `dim` ctor
 * arg), the vec schema (migrations/001-init.sql's `__EMBED_DIM__`
 * placeholder, substituted by storage/migrate.ts), the boot-time dim
 * preflight (doctor/probes/embed-probe.ts), and the eval/mock providers.
 *
 * Matches both `mxbai-embed-large` (Ollama default, native 1024) and
 * `text-embedding-3-*` (Azure, configured via `dimensions: 1024`).
 *
 * Changing `config.embedding.dim` for a FRESH database is a plain config
 * edit — migrate() bakes the configured dim into `memories_vec` at
 * creation. Changing it for an EXISTING database with live data requires
 * the resumable re-embed procedure (`astramem-local reembed-dim`, migration
 * 011 / docs/embed-dim-migration.md) because sqlite-vec's vec0 virtual
 * table fixes its dim at CREATE TABLE time — there is no ALTER for it.
 */
export const DEFAULT_EMBED_DIM = 1024;

/**
 * Embedding provider. `dim` is provider-instance-scoped (constructor arg,
 * defaulting to DEFAULT_EMBED_DIM) rather than a fixed literal — FEAT-409
 * parameterized what was a v1 system-wide invariant. All memories embedded
 * by one provider instance must share its `dim`; switching providers/models
 * (even at the same dim) still requires a re-embed pass since different
 * models are different geometric spaces. Doctor enforces the
 * configured-vs-actual dim match at startup (embed-probe.ts).
 */
export interface EmbedProvider {
  readonly name: 'ollama' | 'azure-openai';
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  health(): Promise<EmbedHealth>;
}
