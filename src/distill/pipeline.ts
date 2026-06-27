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
  // Stage 1: Cleanup
  const cleaned = cleanup(transcript);

  // Stage 2: Normalize
  const normalized = normalize(cleaned);

  // Stage 3: Chunk
  const chunks = chunk(normalized);

  const budget = new BudgetTracker(ctx.db);

  // Stage 4: Compact (LLM, budget-gated)
  let compactedChunks: Array<{ index: number; text: string }>;
  try {
    const compactResults = await compact(chunks, ctx.llmCompaction, budget, ctx.capUsd);
    compactedChunks = compactResults.map(r => ({ index: r.index, text: r.text || chunks[r.index]?.text || '' }));
  } catch (err) {
    if (err instanceof CompactBudgetExceeded) throw err;
    throw err;
  }

  // Stage 5: Extract (LLM JSON-mode, budget-gated, retry on parse fail)
  let extractResults;
  try {
    extractResults = await extract(compactedChunks, ctx.llmExtraction, budget, ctx.capUsd);
  } catch (err) {
    if (err instanceof ExtractBudgetExceeded) throw err;
    throw err;
  }

  // Flatten all atoms
  const allAtoms = extractResults.flatMap(r => r.atoms);

  // Stage 6: Reduce (merge by content hash)
  const reducedAtoms = reduce(allAtoms);

  // Stage 7: Memory-normalize
  const normalizedMemories = memoryNormalize(reducedAtoms);

  // Stage 8: Embed + index
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

  return {
    memoriesCreated: created,
    memoriesDeduped: deduped,
    atomsExtracted: allAtoms.length,
    chunksProcessed: chunks.length,
  };
}
