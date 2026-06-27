/**
 * 8-stage distillation pipeline.
 *
 * Stages:
 * 1. cleanup     — deterministic
 * 2. normalize   — deterministic
 * 3. chunk       — deterministic
 * 4. compact     — LLM call (budget-gated)
 * 5. extract     — LLM call, JSON-mode (budget-gated, Zod-validated, retry once)
 * 6. reduce      — deterministic
 * 7. memory-normalize — deterministic
 * 8. embed + index    — provider call + DB writes
 */

import { cleanup } from './stages/01-cleanup.js';
import { normalize } from './stages/02-normalize.js';
import { chunk } from './stages/03-chunk.js';
import { compact, BudgetExceeded as CompactBudgetExceeded } from './stages/04-compact.js';
import { extract, BudgetExceeded as ExtractBudgetExceeded } from './stages/05-extract.js';
import { reduce } from './stages/06-reduce.js';
import { memoryNormalize } from './stages/07-memory-normalize.js';
import { embedAndIndex } from './stages/08-embed-index.js';
import { BudgetTracker } from '../budget/tracker.js';
import type { LLMProvider, EmbedProvider } from '../contracts/index.js';
import type { DB } from '../storage/db.js';
import { childLogger } from '../log/logger.js';

export { BudgetExceeded } from '../budget/tracker.js';

export interface PipelineContext {
  db: DB;
  llmCompaction: LLMProvider;
  llmExtraction: LLMProvider;
  embed: EmbedProvider;
  capUsd: number;
  sessionId: string | null;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  sourceHash: string | null;
}

export interface PipelineResult {
  memoriesCreated: number;
  memoriesDeduped: number;
  atomsExtracted: number;
  chunksProcessed: number;
}

/**
 * Run the full 8-stage distillation pipeline on a raw transcript.
 * Returns count of new memories created.
 *
 * Throws BudgetExceeded if the daily cap is hit during stages 4 or 5.
 * The caller (distill handler) catches this and moves the job to paused.
 */
export async function runPipeline(
  transcript: string,
  ctx: PipelineContext,
): Promise<PipelineResult> {
  // Base logger for the pipeline run — inherits any job_id from caller context
  const pipeLog = childLogger({ session_id: ctx.sessionId ?? undefined });

  // Stage 1: Cleanup
  pipeLog.info({ stage: 'cleanup' }, 'stage start');
  const cleaned = cleanup(transcript);
  pipeLog.info({ stage: 'cleanup' }, 'stage complete');

  // Stage 2: Normalize
  pipeLog.info({ stage: 'normalize' }, 'stage start');
  const normalized = normalize(cleaned);
  pipeLog.info({ stage: 'normalize' }, 'stage complete');

  // Stage 3: Chunk
  pipeLog.info({ stage: 'chunk' }, 'stage start');
  const chunks = chunk(normalized);
  pipeLog.info({ stage: 'chunk', chunk_count: chunks.length }, 'stage complete');

  const budget = new BudgetTracker(ctx.db);

  // Stage 4: Compact (LLM, budget-gated)
  pipeLog.info({ stage: 'compact', chunk_count: chunks.length }, 'stage start');
  let compactedChunks: Array<{ index: number; text: string }>;
  try {
    const compactResults = await compact(chunks, ctx.llmCompaction, budget, ctx.capUsd);
    compactedChunks = compactResults.map(r => ({ index: r.index, text: r.text || chunks[r.index]?.text || '' }));
    pipeLog.info({ stage: 'compact', chunks_compacted: compactedChunks.length }, 'stage complete');
  } catch (err) {
    if (err instanceof CompactBudgetExceeded) {
      pipeLog.warn({ stage: 'compact', error_kind: 'BudgetExceeded' }, 'stage aborted — budget exceeded');
      throw err;
    }
    pipeLog.warn({ stage: 'compact', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200), error_kind: err instanceof Error ? err.name : 'Unknown' }, 'stage failed');
    throw err;
  }

  // Stage 5: Extract (LLM JSON-mode, budget-gated, retry on parse fail)
  pipeLog.info({ stage: 'extract', chunk_count: compactedChunks.length }, 'stage start');
  let extractResults;
  try {
    extractResults = await extract(compactedChunks, ctx.llmExtraction, budget, ctx.capUsd);
    const atomsExtracted = extractResults.reduce((sum, r) => sum + r.atoms.length, 0);
    pipeLog.info({ stage: 'extract', atoms_extracted: atomsExtracted }, 'stage complete');
  } catch (err) {
    if (err instanceof ExtractBudgetExceeded) {
      pipeLog.warn({ stage: 'extract', error_kind: 'BudgetExceeded' }, 'stage aborted — budget exceeded');
      throw err;
    }
    pipeLog.warn({ stage: 'extract', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200), error_kind: err instanceof Error ? err.name : 'Unknown' }, 'stage failed');
    throw err;
  }

  // Flatten all atoms
  const allAtoms = extractResults.flatMap(r => r.atoms);

  // Stage 6: Reduce (merge by content hash)
  pipeLog.info({ stage: 'reduce', atoms_in: allAtoms.length }, 'stage start');
  const reducedAtoms = reduce(allAtoms);
  pipeLog.info({ stage: 'reduce', atoms_out: reducedAtoms.length }, 'stage complete');

  // Stage 7: Memory-normalize
  pipeLog.info({ stage: 'memory-normalize' }, 'stage start');
  const normalizedMemories = memoryNormalize(reducedAtoms);
  pipeLog.info({ stage: 'memory-normalize', memories: normalizedMemories.length }, 'stage complete');

  // Stage 8: Embed + index
  pipeLog.info({ stage: 'embed-index', memories: normalizedMemories.length }, 'stage start');
  const indexResults = await embedAndIndex(normalizedMemories, {
    db: ctx.db,
    embed: ctx.embed,
    sessionId: ctx.sessionId,
    repo: ctx.repo,
    project: ctx.project,
    branch: ctx.branch,
    agent: ctx.agent,
    sourceHash: ctx.sourceHash,
  });

  const created = indexResults.filter(r => r.created).length;
  const deduped = indexResults.filter(r => !r.created).length;

  pipeLog.info({ stage: 'embed-index', memories_created: created, memories_deduped: deduped }, 'stage complete');

  return {
    memoriesCreated: created,
    memoriesDeduped: deduped,
    atomsExtracted: allAtoms.length,
    chunksProcessed: chunks.length,
  };
}
