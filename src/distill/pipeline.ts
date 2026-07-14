/**
 * 8-stage distillation pipeline.
 *
 * Stages:
 * 1. cleanup     — deterministic
 * 2. normalize   — deterministic
 * 3. chunk       — deterministic
 * 4. compact     — LLM call (budget-gated)
 * 5. extract     — LLM call, JSON-mode (budget-gated, Zod-validated; parse
 *                   failures are transient and retried by the worker)
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
import { groundAtomDates } from './ground-dates.js';
import { memoryNormalize } from './stages/07-memory-normalize.js';
import { embedAndIndex } from './stages/08-embed-index.js';
import { BudgetTracker } from '../budget/tracker.js';
import { resolveChunkConcurrency } from './concurrency.js';
import { chunkCheckpoints } from './chunk-checkpoint.js';
import type { LLMProvider, EmbedProvider } from '../contracts/index.js';
import type { DB } from '../storage/db.js';
import { defaultConfig, type Config } from '../config/config.js';
import type { DurabilityGateMode } from './durability-gate.js';
import { childLogger } from '../log/logger.js';
import { recordRelationGuardDrops } from '../storage/relation-guard-log.js';
import { recordEntityGuardDrops } from '../storage/entity-guard-log.js';

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
  /** See EmbedIndexContext.capturedAtMs — plumbed from the canonical envelope
   * via distillHandler. Also threaded one call deeper into extraction
   * (stage 5) as of the 2026-07-13 temporal-grounding fix — see
   * runPipeline's `sessionDateIso` local. A bare epoch has no timezone
   * information, so `sessionDateIso` prefers `capturedAtLocalDate` below
   * when present and only falls back to formatting THIS field (as a UTC
   * calendar date) for rows from before the 2026-07-13 timezone-offset fix
   * — see that field's own doc for why. */
  capturedAtMs?: number | null;
  /** 2026-07-13 timezone-offset bugfix: the user's LOCAL calendar date at
   * capture (`YYYY-MM-DD`), plumbed from `transcripts.captured_at_local_date`
   * via distillHandler the same way capturedAtMs is above. Unlike
   * capturedAtMs (a bare epoch, timezone-agnostic by construction), this is
   * derived from the offset-bearing `captured_at` wire string's own
   * YYYY-MM-DD prefix at ingest time (src/server/routes/ingest.ts) — that
   * prefix IS the local wall-clock date the user actually captured at.
   * NULL for every row from before this fix and for legacy v0.0 ingests,
   * in which case `sessionDateIso` falls back to the old (UTC-derived-from-
   * epoch) behavior — see runPipeline's `sessionDateIso` local. */
  capturedAtLocalDate?: string | null;
  /** FEAT-455 / ADR-012 decision 4, widened 2026-07-12, widened again
   *  FEAT-458 S3 (ADR-013): provenance tag plumbed from the transcripts row
   *  via distillHandler — see EmbedIndexContext.captureSource. */
  captureSource?: 'auto_capture' | 'hook_close' | 'proxy' | null;
  /** FEAT-479 (D3 §3.2) AC-3: per-transcript extraction profile override,
   *  plumbed from the transcripts row via distillHandler the same way
   *  captureSource is above — NULL for every envelope that omits the
   *  optional `extract_profile` field. `runPipeline` resolves the final
   *  per-run profile as `extractProfile ?? config.distill.extractProfile ??
   *  'engineering'` (AC-2/AC-3 precedence) before calling stage 5. */
  extractProfile?: 'engineering' | 'conversational' | null;
  /** FEAT-441 durability gate mode — undefined behaves as 'off' (AC-2). */
  durabilityGateMode?: DurabilityGateMode;
  /** Full runtime config, threaded through to EmbedIndexContext.redactConfig
   * so a gated atom's logged text is redacted with the real running config
   * (AC-7), not the fallback default. Optional — falls back to
   * defaultConfig() at the embed-index stage when omitted. */
  config?: Config;
}

export interface PipelineResult {
  memoriesCreated: number;
  memoriesDeduped: number;
  atomsExtracted: number;
  chunksProcessed: number;
  /** IDs of every memory this run touched (both newly-created and deduped-existing), in stage-8 order. */
  memoryIds: string[];
  /** FEAT-441 AC-4: count of candidate atoms the durability gate rejected
   * this run (0 when the gate is 'off' or nothing matched). */
  gatedOutCount: number;
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

  // FEAT-487: chunk-level fan-out width for stages 4/5, resolved once per
  // run from config (falls back to defaultConfig() when ctx.config is
  // omitted — same convention as ctx.config's other consumer, stage 8's
  // redactConfig). See resolveChunkConcurrency's doc comment for the [1,8]
  // clamp and the `chunkConcurrency: 1` sequential safety valve.
  const chunkConcurrency = resolveChunkConcurrency(ctx.config ?? defaultConfig());

  // chunk-retry-amplification fix: sourceHash is a sha256 of the transcript
  // content (computed once in distillHandler), so it is stable across every
  // worker-level retry of THIS job while still being derived from content
  // (not a fresh id per attempt) — it doubles as the checkpoint jobKey for
  // compact()/extract() below. `undefined` (any caller that doesn't supply
  // sourceHash, e.g. a test fixture) disables checkpointing entirely and
  // reproduces pre-fix behavior — see chunk-checkpoint.ts.
  const checkpointJobKey = ctx.sourceHash ?? undefined;

  // Stage 4: Compact (LLM, budget-gated)
  pipeLog.info({ stage: 'compact', chunk_count: chunks.length, chunk_concurrency: chunkConcurrency }, 'stage start');
  let compactedChunks: Array<{ index: number; text: string }>;
  try {
    const compactResults = await compact(chunks, ctx.llmCompaction, budget, ctx.capUsd, chunkConcurrency, checkpointJobKey);
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

  // Stage 5: Extract (LLM JSON-mode, budget-gated; parse failures throw
  // TransientError, so a job-level retry re-runs this stage rather than
  // poisoning on one bad sample — see 05-extract.ts)
  // FEAT-479 AC-2/AC-3 precedence (ASTRA_EXTRACT_PROMPT env var override is
  // applied one level down, inside resolveExtractionPrompt via 05-extract.ts
  // — it always wins regardless of what's resolved here): per-transcript
  // extract_profile envelope field > config distill.extractProfile > the
  // 'engineering' default. With neither set anywhere, this resolves to
  // 'engineering' — the byte-identical pre-FEAT-479 default (AC-2).
  const resolvedExtractProfile = ctx.extractProfile ?? ctx.config?.distill.extractProfile ?? 'engineering';
  // Temporal-grounding fix (2026-07-13), timezone-offset fix (2026-07-13,
  // same day): thread an ISO calendar date one call deeper, into extraction,
  // so the model can resolve relative time expressions ("yesterday") to
  // absolute dates in atom text (05-extract.ts / prompts/extract.ts).
  //
  // capturedAtLocalDate (see its own PipelineContext doc) is the user's
  // TRUE local calendar date at capture and is always preferred when
  // present. capturedAtMs is a bare epoch with no timezone information — the
  // original temporal-grounding fix formatted it via `.toISOString()`,
  // which always yields the UTC calendar date; a user in UTC-8 capturing at
  // 21:00 local is at 05:00 UTC the NEXT day, so "yesterday" in that session
  // resolved one day off. That UTC-derived computation is now ONLY a
  // fallback, for rows from before the timezone-offset fix (capturedAtMs
  // set, capturedAtLocalDate NULL) — byte-identical to the original fix's
  // behavior for those. `undefined` when capturedAtMs is also null (legacy
  // v0.0 envelopes, direct /remember calls) — byte-identical to pre-fix
  // behavior for every such caller.
  const sessionDateIso = ctx.capturedAtLocalDate
    ?? (ctx.capturedAtMs != null ? new Date(ctx.capturedAtMs).toISOString().slice(0, 10) : undefined);
  pipeLog.info({ stage: 'extract', chunk_count: compactedChunks.length, extract_profile: resolvedExtractProfile, chunk_concurrency: chunkConcurrency }, 'stage start');
  let extractResults;
  try {
    extractResults = await extract(compactedChunks, ctx.llmExtraction, budget, ctx.capUsd, resolvedExtractProfile, chunkConcurrency, checkpointJobKey, sessionDateIso);
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

  // FEAT-481 SLICE-430: persist filterAtomRelations' per-reason drop counts
  // (aggregated across every chunk this run) so the doctor "Entity
  // relations extraction" canary can tell "model never emitted a relation"
  // apart from "model emitted relations but the guard dropped every one" —
  // both look identical as a zero entity_relations row count otherwise.
  // Deliberately its OWN try/catch, outside the extract-stage try above and
  // never re-thrown: this is a diagnostic counter write, not part of
  // extraction's own success/failure contract. A write failure here
  // (SQLITE_BUSY under contention, disk full) must never be reinterpreted
  // as "the extract stage failed" and trigger a job retry that throws away
  // an already-successful extraction (review finding, this slice).
  try {
    const relationDropTotals: Record<string, number> = {};
    for (const r of extractResults) {
      for (const [reason, count] of Object.entries(r.relationDropCounts)) {
        relationDropTotals[reason] = (relationDropTotals[reason] ?? 0) + count;
      }
    }
    recordRelationGuardDrops(
      ctx.db,
      Object.entries(relationDropTotals).map(([reason, count]) => ({ reason, count })),
      ctx.sessionId,
    );
  } catch (err) {
    pipeLog.warn(
      { stage: 'extract', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
      'relation guard-drop counter write failed (non-fatal, diagnostic only — extraction already succeeded)',
    );
  }

  // Issue #207: persist filterAtomEntities' per-reason drop counts (aggregated
  // across every chunk this run), same diagnostic-only posture as the
  // relation-guard-drop write immediately above — its own try/catch, never
  // re-thrown, so a counter-write failure can never be mistaken for the
  // extract stage itself failing.
  try {
    const entityDropTotals: Record<string, number> = {};
    for (const r of extractResults) {
      for (const [reason, count] of Object.entries(r.entityDropCounts)) {
        entityDropTotals[reason] = (entityDropTotals[reason] ?? 0) + count;
      }
    }
    recordEntityGuardDrops(
      ctx.db,
      Object.entries(entityDropTotals).map(([reason, count]) => ({ reason, count })),
      ctx.sessionId,
    );
  } catch (err) {
    pipeLog.warn(
      { stage: 'extract', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
      'entity-name guard-drop counter write failed (non-fatal, diagnostic only — extraction already succeeded)',
    );
  }

  // Flatten all atoms
  const allAtoms = extractResults.flatMap(r => r.atoms);

  // Stage 6: Reduce (merge by content hash)
  pipeLog.info({ stage: 'reduce', atoms_in: allAtoms.length }, 'stage start');
  const reducedAtoms = reduce(allAtoms);
  pipeLog.info({ stage: 'reduce', atoms_out: reducedAtoms.length }, 'stage complete');

  // Date-grounding retry (2026-07-13): a second, narrow LLM call for atoms
  // whose text still carries an unresolved relative-date expression after
  // stage 5's own resolve-in-place instruction — see ground-dates.ts's doc
  // comment (graphiti's pattern; NOT PR #257's regex rewrite, which
  // fabricated dates and was closed unmerged). Runs AFTER reduce (not
  // between 5 and 6) so a phrase repeated across chunks is only ever
  // resolved once, not once per chunk occurrence. `sessionDateIso` absent is
  // a total no-op inside groundAtomDates — byte-identical to pre-retry
  // behavior for every caller with no real anchor (legacy v0.0 envelopes,
  // direct /remember calls). Reuses ctx.llmExtraction — same posture as
  // contradiction-judge.ts (no new provider config surface). Never throws:
  // any call/parse failure inside groundAtomDates is its own no-op fallback,
  // so this can never turn a successful extraction into a failed pipeline
  // run.
  pipeLog.info({ stage: 'ground-dates', atoms_in: reducedAtoms.length }, 'stage start');
  const groundResult = await groundAtomDates(reducedAtoms, sessionDateIso, ctx.llmExtraction);
  pipeLog.info(
    {
      stage: 'ground-dates',
      atoms_in: groundResult.totalAtoms,
      fired: groundResult.fired,
      resolved: groundResult.resolved,
      errors: groundResult.errors,
    },
    'stage complete',
  );

  // Stage 7: Memory-normalize
  pipeLog.info({ stage: 'memory-normalize' }, 'stage start');
  const normalizedMemories = memoryNormalize(groundResult.atoms);
  pipeLog.info({ stage: 'memory-normalize', memories: normalizedMemories.length }, 'stage complete');

  // Stage 8: Embed + index
  pipeLog.info({ stage: 'embed-index', memories: normalizedMemories.length }, 'stage start');
  const gatedOutCounter = { count: 0 };
  const indexResults = await embedAndIndex(normalizedMemories, {
    db: ctx.db,
    embed: ctx.embed,
    sessionId: ctx.sessionId,
    repo: ctx.repo,
    project: ctx.project,
    branch: ctx.branch,
    agent: ctx.agent,
    sourceHash: ctx.sourceHash,
    capturedAtMs: ctx.capturedAtMs,
    captureSource: ctx.captureSource,
    durabilityGateMode: ctx.durabilityGateMode,
    redactConfig: ctx.config,
    gatedOutCounter,
  });

  const created = indexResults.filter(r => r.created).length;
  const deduped = indexResults.filter(r => !r.created).length;

  pipeLog.info(
    { stage: 'embed-index', memories_created: created, memories_deduped: deduped, gatedOutCount: gatedOutCounter.count },
    'stage complete',
  );

  // chunk-retry-amplification fix: the job reached terminal success — drop
  // its checkpoint entries now rather than waiting for the FIFO eviction
  // cap (chunk-checkpoint.ts) to reclaim them. A job that later gets
  // re-ingested under the same content would otherwise (harmlessly, but
  // pointlessly) hit stale cached results from this run.
  if (checkpointJobKey) chunkCheckpoints.clear(checkpointJobKey);

  return {
    memoriesCreated: created,
    memoriesDeduped: deduped,
    atomsExtracted: allAtoms.length,
    chunksProcessed: chunks.length,
    memoryIds: indexResults.map(r => r.memoryId),
    gatedOutCount: gatedOutCounter.count,
  };
}
