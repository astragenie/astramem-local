import { defaultDataDir } from './datadir.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';

export interface Config {
  port: number;
  dataDir: string;
  /** FEAT-406: HTTP bind + the derived auth boundary for /health + /version.
   * Default host is loopback-only — changing it is a deliberate opt-in, not
   * a two-flag combination that can drift out of sync (see
   * `isLoopbackHost` in server/lib/network.ts, the single predicate that
   * decides both bind exposure and whether /health + /version require a
   * Bearer token). */
  network: { host: string };
  llm: {
    compaction: { provider: 'ollama' | 'azure-openai'; model: string };
    extraction: { provider: 'ollama' | 'azure-openai'; model: string };
  };
  embedding: {
    provider: 'ollama' | 'azure-openai';
    model: string;
    /** FEAT-409: parameterized — single source of truth is
     * DEFAULT_EMBED_DIM (src/contracts/embed.ts). Changing this for a
     * fresh DB is a plain config edit; changing it against an existing DB
     * with live data requires `astramem-local reembed-dim`
     * (docs/embed-dim-migration.md). */
    dim: number;
  };
  vector: { store: 'sqlite-vec' | 'lancedb' };
  budget: { daily_usd: number };
  ollama: { baseUrl: string };
  azure: { endpoint?: string; deployment?: string; apiVersion: string };
  /** Fusion weights — α bm25, β cosine, γ importance, δ freshness,
   * ε usefulness (ADR-010 v1.x: recall_used/memory_corrected events feed
   * ranking; atoms with no signal score a neutral 0.5, so ε never reshuffles
   * an unsignaled corpus), ζ entity-relevance bonus (FEAT-402 AC-6: DEFAULT
   * 0 = OFF; a candidate entity-linked to an entity mentioned in the query
   * text gets +ζ. At zeta=0 ranking is byte-identical to no-entity ranking —
   * see the AC-6 snapshot test in tests/eval/retrieval-eval.test.ts). */
  search: { alpha: number; beta: number; gamma: number; delta: number; epsilon: number; zeta: number };
  recallPack: {
    enabled: boolean;
    budgetTokens: number;
    /** Injection-policy v1 (ADR-005 when-to-recall, Wave 4d). */
    policy: {
      enabled: boolean;
      /** Minimum selection score a memory needs to be injected. */
      minScore: number;
      /** Prompts shorter than this get no injection (unless they reference memory). */
      minPromptChars: number;
    };
  };
  /** One-way log shipping to the cloud ledger (ADR-003). Off by default;
   * requires url + workspaceId + a device token in the keystore
   * (or ASTRA_SYNC_TOKEN). personal-scoped atoms never ship (ADR-009). */
  sync: {
    enabled: boolean;
    url: string;
    workspaceId: string | null;
    batchSize: number;
    intervalMs: number;
  };
  security: {
    redaction: {
      enabled: boolean;
      /** Shannon-entropy threshold in bits/char for the fallback secret detector. */
      entropyThreshold: number;
      /** Org-specific regex sources applied as detector type 'custom'. */
      customPatterns: string[];
    };
    /** Encryption at rest (SEC-1/2/7/9). Disabling is a deliberate trust
     * trade-off — the daemon logs a prominent WARN at startup (AC-6). */
    encryption: {
      enabled: boolean;
    };
  };
  /** Repo/project tag-hygiene backfill (FEAT-403, W4.3). */
  tagHygiene: {
    /** Tier-2 prompt-assisted inference is opt-in — a data-mutating heuristic
     * pass over legacy rows carries real mis-tag risk (PM pre-mortem), so it
     * never runs silently. Enable via config or the CLI's `--tier2` flag. */
    tier2Enabled: boolean;
    /** Minimum tier-2 confidence required to apply an inferred tag; below
     * this the memory is left untagged rather than risk a mis-tag (AC-4). */
    tier2ConfidenceThreshold: number;
  };
  /** Memory TTL / archival tiers (FEAT-404, W4.4). Both conditions are
   * required to archive an atom: older than ageThresholdDays AND its
   * trailing-7-day usefulness rate at/below usefulnessFloor. Off by default
   * — the PM pre-mortem risk is silently archiving a rarely-used-but-
   * critical memory, so enabling is a deliberate opt-in. Runs on the
   * cleanup job's cadence (src/pipeline/handlers/cleanup.ts). */
  archival: {
    enabled: boolean;
    /** Age is measured from created_at (how old the atom itself is), not
     * valid_from (which supersede() can advance). Default 183 days (~6
     * months), per the FEAT-404 AC-6 proposal. */
    ageThresholdDays: number;
    /** rate_7d <= this floor makes an atom archival-eligible (combined
     * with the age check). Default 0.0 — no explicit recall_used signal
     * in the trailing 7 days. */
    usefulnessFloor: number;
  };
}

export function defaultConfig(): Config {
  return {
    port: 7777,
    dataDir: defaultDataDir(),
    network: { host: '127.0.0.1' },
    llm: {
      compaction: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
      extraction: { provider: 'ollama', model: 'qwen2.5-coder:7b' }
    },
    embedding: { provider: 'ollama', model: 'mxbai-embed-large', dim: DEFAULT_EMBED_DIM },
    vector: { store: 'sqlite-vec' },
    budget: { daily_usd: 10 },
    ollama: { baseUrl: 'http://127.0.0.1:11434' },
    azure: { apiVersion: '2024-10-21' },
    search: { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1, zeta: 0 },
    recallPack: {
      enabled: false,
      budgetTokens: 1500,
      policy: { enabled: true, minScore: 0.15, minPromptChars: 12 },
    },
    sync: { enabled: false, url: '', workspaceId: null, batchSize: 200, intervalMs: 30_000 },
    security: {
      redaction: { enabled: true, entropyThreshold: 4.0, customPatterns: [] },
      encryption: { enabled: true }
    },
    tagHygiene: { tier2Enabled: false, tier2ConfidenceThreshold: 0.7 },
    archival: { enabled: false, ageThresholdDays: 183, usefulnessFloor: 0.0 }
  };
}

export function loadConfig(overrides: Partial<Config> | undefined): Config {
  const base = defaultConfig();
  if (!overrides) return base;
  return { ...base, ...overrides };
}
