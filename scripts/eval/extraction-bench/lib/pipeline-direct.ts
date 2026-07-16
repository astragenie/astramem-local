/**
 * In-process distill pipeline runner — used for the Azure gpt-5-mini
 * reference point (see azure-reasoning-provider.ts for why gpt-5-mini can't
 * go through the daemon's HTTP path today). Reuses the REAL stage functions
 * from src/distill/stages/*, the real redaction stage, and the real
 * flatten-turns helper — the only thing skipped is the HTTP/job-queue/SQLite
 * storage layer (stages 1-7 need no DB; only BudgetTracker does, satisfied
 * here with a throwaway in-memory table).
 *
 * This gives byte-for-byte the same atoms a real /ingest/transcript +
 * distill-job run would produce for the same provider, minus stage 8
 * (embed+index) which this benchmark doesn't need — atom quality is decided
 * entirely by stages 1-6.
 *
 * Uses `bun:sqlite`, NOT `better-sqlite3-multiple-ciphers`, for the
 * throwaway BudgetTracker table: this whole eval toolchain runs under `bun`
 * (per repo convention — see scripts/eval/longmemeval's package.json
 * scripts), and per CLAUDE.md / spawn-daemon.ts, `better-sqlite3` (multiple-
 * ciphers included) is NOT supported under Bun ("'better-sqlite3' is not yet
 * supported in Bun" — confirmed live 2026-07-08 when this was first written
 * against better-sqlite3-multiple-ciphers and threw exactly that). bun:sqlite
 * is API-compatible for the tiny subset BudgetTracker actually calls
 * (`prepare(sql).get(...)` / `.run(...)`, standard SQLite `ON CONFLICT DO
 * UPDATE`), so it's cast to the real `DB` type rather than re-typed — no
 * ambient bun-types package is installed in this repo, hence the local
 * ambient declaration in ./bun-sqlite.d.ts instead of pulling in a new
 * devDependency.
 */
import { Database as BunSqliteDatabase } from 'bun:sqlite';
import type { DB } from '../../../../src/storage/db.js';
import type { LLMProvider } from '../../../../src/contracts/llm.js';
import type { Config } from '../../../../src/config/config.js';
import { defaultConfig } from '../../../../src/config/config.js';
import { redactIfEnabled } from '../../../../src/redact/index.js';
import { flattenTranscriptContent } from '../../../../src/distill/flatten-turns.js';
import { cleanup } from '../../../../src/distill/stages/01-cleanup.js';
import { normalize } from '../../../../src/distill/stages/02-normalize.js';
import { chunk, resolveMaxChunkChars } from '../../../../src/distill/stages/03-chunk.js';
import { compact } from '../../../../src/distill/stages/04-compact.js';
import { extract, extractSpecifics } from '../../../../src/distill/stages/05-extract.js';
import { mergeDualPassAtoms } from '../../../../src/distill/dedup-merge.js';
import { reduce } from '../../../../src/distill/stages/06-reduce.js';
import { memoryNormalize, type NormalizedMemory } from '../../../../src/distill/stages/07-memory-normalize.js';
import { BudgetTracker } from '../../../../src/budget/tracker.js';
import type { Atom } from '../../../../src/distill/prompts/extract.js';
import type { FixtureTurn } from './fixtures.js';

/** Minimal throwaway DB — only the one table BudgetTracker touches. Never
 *  persisted to disk; a fresh one per run means budget never carries over
 *  between fixtures/models. */
function makeBudgetDb(): DB {
  const db = new BunSqliteDatabase(':memory:');
  db.exec(`CREATE TABLE budget_spend (day TEXT PRIMARY KEY, usd_total REAL NOT NULL, calls INTEGER NOT NULL)`);
  return db as unknown as DB;
}

export interface DirectRunResult {
  atoms: Array<{
    type: string;
    text: string;
    importance: number;
    confidence: number;
    /** FEAT-485: pass-through of the atom's own `evidence` excerpt (verbatim
     * source quote per src/distill/prompts/extract.ts's AtomSchema), when the
     * extractor emitted one — same "survives via spread, this mapper just
     * needs to read it" story as `relations` below. Optional and additive —
     * existing callers reading only `.type`/`.text` are unaffected. Added so
     * scripts/eval/extraction-bench/measure-evidence.mts can measure
     * evidence-population rate per profile/model on the real pipeline. */
    evidence?: string;
    /** FEAT-479 AC-481: pass-through of the atom's own entity-relation
     * triples (subject/predicate/object/confidence), when the extractor
     * emitted any — `ReducedAtom`/`NormalizedMemory` both extend `Atom`, so
     * this survives reduce()/memoryNormalize() unchanged; only this
     * function's own output map used to drop it. Optional and additive —
     * existing callers reading only `.type`/`.text` are unaffected. */
    relations?: Array<{ subject: string; predicate: string; object: string; confidence?: number }>;
  }>;
  chunksProcessed: number;
  wallMs: number;
  usageUsd: number;
  /** FEAT-534 (mixed-pass hybrid bench support): atom counts split by pass,
   *  present only when `opts.extractionPasses === 2` was requested. `atoms`
   *  above is always the final MERGED/deduped set (mirrors runPipeline's own
   *  stage-5b merge) — these two counts are the pre-merge per-pass yield,
   *  the measurement gate FEAT-534 AC-4 asks for ("per-pass atom counts are
   *  recorded"). `undefined` on a single-pass run, same as pre-FEAT-534. */
  passAAtomCount?: number;
  passBAtomCount?: number;
}

/**
 * Run stages 1-7 in-process on one fixture's turns, given compaction +
 * extraction providers. Mirrors distillHandler's pre-pipeline steps exactly:
 * JSON.stringify(turns) -> flattenTranscriptContent -> cleanup -> normalize
 * -> chunk -> ... (same as what /ingest/transcript + the distill job do).
 */
export async function runDirectPipeline(
  turns: FixtureTurn[],
  opts: {
    llmCompaction: LLMProvider;
    llmExtraction: LLMProvider;
    capUsd?: number;
    config?: Config;
    /** FEAT-485: which extraction prompt profile to resolve — mirrors
     * PipelineContext.extractProfile / distillHandler's precedence. Defaults
     * to 'engineering' (byte-identical prior behavior) when omitted. */
    extractProfile?: 'engineering' | 'conversational';
    /** FEAT-534: mirrors PipelineContext/runPipeline's dual-pass shape.
     *  `1`/omitted is BYTE-IDENTICAL to pre-FEAT-534 behavior — single
     *  extraction call, no merge. `2` runs the "specifics sweeper" pass
     *  (05-extract.ts's extractSpecifics) on `llmExtractionPassB ??
     *  llmExtraction` and merges via the same dedup-merge.ts rules
     *  runPipeline's stage 5b uses. */
    extractionPasses?: 1 | 2;
    /** FEAT-534: pass-B provider override. Only consulted when
     *  `extractionPasses: 2`; unset rides `llmExtraction`, same identity
     *  default as ProviderSet.llm.extractionPassB. */
    llmExtractionPassB?: LLMProvider;
  },
): Promise<DirectRunResult> {
  const config = opts.config ?? defaultConfig();
  const capUsd = opts.capUsd ?? 50; // generous — this bench tracks real Azure spend separately, never wants a mid-run BudgetExceeded to silently zero out a fixture's atoms.

  const t0 = Date.now();

  // Stage 0: redaction (same as ingest.ts, applied per-turn before storage).
  const redactedTurns = turns.map(t => ({ ...t, text: redactIfEnabled(t.text, config).text }));

  // Same transform distillHandler applies: transcripts.content stores
  // JSON.stringify(turns); flattenTranscriptContent turns it into "role: text"
  // lines before stage 1.
  const transcriptText = flattenTranscriptContent(JSON.stringify(redactedTurns));

  const cleaned = cleanup(transcriptText);
  const normalized = normalize(cleaned);
  // #273 (WS7): resolved from opts.config.distill.maxChunkChars so a sweep
  // caller can vary chunk size per run — falls back to the stage-3 default
  // when the caller passes no override.
  const chunks = chunk(normalized, resolveMaxChunkChars(config));

  const budgetDb = makeBudgetDb();
  try {
    const budget = new BudgetTracker(budgetDb);

    const compactResults = await compact(chunks, opts.llmCompaction, budget, capUsd);
    const compactedChunks = compactResults.map(r => ({ index: r.index, text: r.text || chunks[r.index]?.text || '' }));

    const extractResults = await extract(compactedChunks, opts.llmExtraction, budget, capUsd, opts.extractProfile ?? 'engineering');
    let allAtoms: Atom[] = extractResults.flatMap(r => r.atoms);
    let usageUsd = compactResults.reduce((s, r) => s + r.usageUsd, 0) + extractResults.reduce((s, r) => s + r.usageUsd, 0);

    // FEAT-534: dual-pass, mirrors runPipeline's stage 5b exactly (same
    // extractSpecifics call, same per-chunk mergeDualPassAtoms merge) —
    // this bench previously had NO dual-pass path at all, so a `--models
    // codex:...+passB=...` spec would otherwise silently run single-pass.
    let passAAtomCount: number | undefined;
    let passBAtomCount: number | undefined;
    if (opts.extractionPasses === 2) {
      const passBProvider = opts.llmExtractionPassB ?? opts.llmExtraction;
      const specificsResults = await extractSpecifics(compactedChunks, passBProvider, budget, capUsd);
      usageUsd += specificsResults.reduce((s, r) => s + r.usageUsd, 0);

      const specificsByChunk = new Map(specificsResults.map(r => [r.chunkIndex, r]));
      const merged: Atom[] = [];
      for (const passAResult of extractResults) {
        const passBResult = specificsByChunk.get(passAResult.chunkIndex);
        const { merged: chunkMerged } = mergeDualPassAtoms(passAResult.atoms, passBResult?.atoms ?? []);
        merged.push(...chunkMerged);
      }
      passAAtomCount = extractResults.reduce((s, r) => s + r.atoms.length, 0);
      passBAtomCount = specificsResults.reduce((s, r) => s + r.atoms.length, 0);
      allAtoms = merged;
    }

    const reduced = reduce(allAtoms);
    const normalizedMemories: NormalizedMemory[] = memoryNormalize(reduced);

    return {
      passAAtomCount,
      passBAtomCount,
      atoms: normalizedMemories.map(m => ({
        type: m.type,
        text: m.normalizedText,
        importance: m.importance,
        confidence: m.confidence,
        evidence: m.evidence,
        relations: m.relations,
      })),
      chunksProcessed: chunks.length,
      wallMs: Date.now() - t0,
      usageUsd,
    };
  } finally {
    budgetDb.close();
  }
}
