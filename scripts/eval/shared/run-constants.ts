/**
 * Effective run-constants block for eval provenance (2026-07-19, operator
 * directive after the 0.5346 replication review): every constant that can
 * move an eval number, DERIVED from the live source of truth — never
 * hand-copied literals (ADR-016). Both harnesses embed this same block:
 *
 *   - LoCoMo:            run-manifest.json  → config.runConstants
 *   - extraction-bench:  run-metadata.json  → runConstants
 *
 * The block reflects THIS process's env at collection time (env-overridable
 * constants like ASTRA_CHUNK_TARGET_TOKENS / ASTRA_EXTRACT_TEMP resolve at
 * module load in their home modules), plus defaultConfig()-derived knobs the
 * sandboxed daemon inherits unless a harness override pins them. Harness
 * overrides (flags like --passb-sweep) are recorded separately by each
 * harness; this block is the BASELINE those overrides act on.
 */
import { defaultConfig, resolveExtractionPassBTuning, EXTRACTION_PASS_B_DEFAULTS } from '../../../src/config/config.js';
import { DEFAULT_MAX_CHUNK_CHARS } from '../../../src/distill/stages/03-chunk.js';
import { EXTRACT_TEMPERATURE, PASS_A_MAX_TOKENS } from '../../../src/distill/stages/05-extract.js';
import { CHARS_PER_TOKEN, NUM_CTX_FLOOR, NUM_CTX_CAP } from '../../../src/providers/llm/ollama.js';
import { DEFAULT_EMBED_DIM } from '../../../src/contracts/embed.js';

export interface RunConstants {
  chunking: {
    maxChunkChars: number;
    targetTokensEnv: string | null;
  };
  extraction: {
    temperature: number;
    tempEnv: string | null;
    passAMaxTokens: number;
    promptEnv: string | null;
    defaultPasses: number;
  };
  passBTuning: {
    sweepOnlyBelowAtoms: number;
    maxTokens: number;
    numCtxCap: number;
    shippedDefaults: typeof EXTRACTION_PASS_B_DEFAULTS;
  };
  ollamaNumCtx: {
    formula: string;
    charsPerToken: number;
    floor: number;
    cap: number;
  };
  embedding: {
    defaultProvider: string;
    defaultModel: string;
    dim: number;
  };
  configDefaults: {
    compactionModel: string;
    extractionModel: string;
    extractionProvider: string;
    atomTriageMode: string;
    gatekeeperMode: string;
  };
  ollamaEnv: Record<string, string | undefined>;
}

export function collectRunConstants(): RunConstants {
  const cfg = defaultConfig();
  const tuning = resolveExtractionPassBTuning(undefined);
  return {
    chunking: {
      maxChunkChars: DEFAULT_MAX_CHUNK_CHARS,
      targetTokensEnv: process.env.ASTRA_CHUNK_TARGET_TOKENS ?? null,
    },
    extraction: {
      temperature: EXTRACT_TEMPERATURE,
      tempEnv: process.env.ASTRA_EXTRACT_TEMP ?? null,
      passAMaxTokens: PASS_A_MAX_TOKENS,
      promptEnv: process.env.ASTRA_EXTRACT_PROMPT ?? null,
      defaultPasses: cfg.distill?.extractionPasses ?? 1,
    },
    passBTuning: {
      ...tuning,
      shippedDefaults: EXTRACTION_PASS_B_DEFAULTS,
    },
    ollamaNumCtx: {
      formula: `clamp(inputChars/${CHARS_PER_TOKEN} + maxTokens + 512, ${NUM_CTX_FLOOR}, min(${NUM_CTX_CAP}, provider numCtxCap))`,
      charsPerToken: CHARS_PER_TOKEN,
      floor: NUM_CTX_FLOOR,
      cap: NUM_CTX_CAP,
    },
    embedding: {
      defaultProvider: cfg.embedding?.provider ?? 'unknown',
      defaultModel: cfg.embedding?.model ?? 'unknown',
      dim: DEFAULT_EMBED_DIM,
    },
    configDefaults: {
      compactionModel: `${cfg.llm?.compaction?.provider ?? '?'}/${cfg.llm?.compaction?.model ?? '?'}`,
      extractionModel: cfg.llm?.extraction?.model ?? '?',
      extractionProvider: cfg.llm?.extraction?.provider ?? '?',
      atomTriageMode: cfg.distill?.atomTriage?.mode ?? 'off',
      gatekeeperMode: cfg.distill?.gatekeeper?.mode ?? 'off',
    },
    ollamaEnv: {
      OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION,
      OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE,
      OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL,
      OLLAMA_MAX_LOADED_MODELS: process.env.OLLAMA_MAX_LOADED_MODELS,
      OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE,
    },
  };
}
