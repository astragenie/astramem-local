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
import { chunk, resolveMaxChunkChars } from './stages/03-chunk.js';
import { compact, shouldCompact, compactionDecisionFor, BudgetExceeded as CompactBudgetExceeded } from './stages/04-compact.js';
import { extract, extractSpecifics, BudgetExceeded as ExtractBudgetExceeded } from './stages/05-extract.js';
import { mergeDualPassAtoms } from './dedup-merge.js';
import { reduce } from './stages/06-reduce.js';
import { groundAtomDates } from './ground-dates.js';
import { memoryNormalize } from './stages/07-memory-normalize.js';
import { embedAndIndex } from './stages/08-embed-index.js';
import { BudgetTracker } from '../budget/tracker.js';
import { resolveChunkConcurrency } from './concurrency.js';
import { DistillCostCapTracker, resolveDistillCostCap } from './cost-cap.js';
import { chunkCheckpoints } from './chunk-checkpoint.js';
import type { SourcedAtom } from './prompts/extract.js';
import type { LLMProvider, EmbedProvider } from '../contracts/index.js';
import type { DB } from '../storage/db.js';
import { defaultConfig, type Config } from '../config/config.js';
import type { DurabilityGateMode } from './durability-gate.js';
import { childLogger } from '../log/logger.js';
import { recordRelationGuardDrops } from '../storage/relation-guard-log.js';
import { recordEntityGuardDrops } from '../storage/entity-guard-log.js';
import { recordEvidenceGuardDrops } from '../storage/evidence-guard-log.js';
import { recordExtractionYield } from '../storage/extraction-yield-log.js';
import { runGatekeeperSweep } from './gatekeeper.js';
import { recordGatekeeperSkips, recordGatekeeperRunLog } from '../storage/gatekeeper-log.js';

export { BudgetExceeded } from '../budget/tracker.js';

export interface PipelineContext {
  db: DB;
  llmCompaction: LLMProvider;
  llmExtraction: LLMProvider;
  /** Per-pass extraction provider override (FEAT-534). Optional in the type
   * — every real caller (distillHandler) always sets it via
   * ProviderSet.llm.extractionPassB, which `getProviders` itself always
   * populates (identity default), but hand-built test contexts (this file's
   * own test suite included) may omit it entirely. Consumers read it as
   * `ctx.llmExtractionPassB ?? ctx.llmExtraction` (runPipeline's stage 5b
   * below) — byte-identical to pre-FEAT-534 behavior whenever it's absent.
   * Only consulted when `extractionPasses: 2`; ignored entirely on
   * single-pass. */
  llmExtractionPassB?: LLMProvider;
  /** LLM atom-triage provider override (FEAT-533). Optional in the type —
   * every real caller (distillHandler/distillEventsHandler) always sets it
   * via ProviderSet.llm.atomTriage, which `getProviders` itself always
   * populates (identity default to llmExtraction), but hand-built test
   * contexts may omit it entirely. Only consulted when
   * `config.distill.atomTriage.mode !== 'off'` — see
   * EmbedIndexContext.llmAtomTriage's doc comment. */
  llmAtomTriage?: LLMProvider;
  /** Ingest gatekeeper provider (FEAT-548). Optional in the type — every
   * real caller (distillHandler) always sets it via ProviderSet.llm.gatekeeper,
   * which `getProviders` itself always populates (identity default to
   * llmExtraction), but hand-built test contexts may omit it entirely. Only
   * consulted when `config.distill.gatekeeper.mode !== 'off'` — see
   * runGatekeeperSweep's own no-op-without-provider convention. */
  llmGatekeeper?: LLMProvider;
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
   *  FEAT-458 S3 (ADR-013), FEAT-489 (Slice A), and FEAT-491: provenance tag
   *  plumbed from the transcripts row via distillHandler — see
   *  EmbedIndexContext.captureSource. */
  captureSource?: 'auto_capture' | 'hook_close' | 'proxy' | 'audio_transcribe' | 'meeting_captions' | null;
  /** FEAT-489/FEAT-491 (ADR-017 decision 6): plumbed from
   *  `transcripts.consent_disclosed` via distillHandler, the same "flows
   *  straight through" pattern `captureSource` above already uses —
   *  stamped onto every atom this transcript produces
   *  (EmbedIndexContext.consentDisclosed). `null`/omitted for every envelope
   *  whose source transcript has no `consent_disclosed` value. */
  consentDisclosed?: boolean | null;
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
  // #273 (WS7): maxChunkChars resolved from config the same way stage 4/5's
  // chunkConcurrency is below — falls back to defaultConfig() (byte-
  // identical to pre-#273) when ctx.config is omitted.
  const maxChunkChars = resolveMaxChunkChars(ctx.config ?? defaultConfig());
  pipeLog.info({ stage: 'chunk', max_chunk_chars: maxChunkChars }, 'stage start');
  const chunks = chunk(normalized, maxChunkChars);
  pipeLog.info({ stage: 'chunk', chunk_count: chunks.length }, 'stage complete');

  // Stage 3b: Gatekeeper (FEAT-548) — optional pre-extraction substantiveness
  // gate. 'off' (the shipped default, including an omitted ctx.config) is
  // BYTE-IDENTICAL to pre-FEAT-548 behavior (AC-1): the entire block below is
  // skipped, `chunksForExtraction` stays the same ARRAY REFERENCE as `chunks`,
  // and no gate call is ever made. 'dry-run' runs the gate and logs the
  // would-have-skipped verdicts + a skip-rate counter but does NOT filter
  // `chunksForExtraction` (AC-3 — every chunk still reaches compact/extract
  // unmodified). 'enabled' actually removes 'skip'-verdicted chunks from
  // `chunksForExtraction` before compact()/extract() ever see them — a chunk
  // with no verdict entry (fail-open: provider missing/throwing/unparsable,
  // AC-2) is treated as an implicit 'keep' and stays in.
  const gatekeeperMode = ctx.config?.distill.gatekeeper.mode ?? 'off';
  let chunksForExtraction = chunks;
  if (gatekeeperMode !== 'off') {
    const gatekeeperLog = (message: string) =>
      pipeLog.warn({ stage: 'gatekeeper' }, message);
    pipeLog.info({ stage: 'gatekeeper', chunk_count: chunks.length, mode: gatekeeperMode }, 'stage start');
    const sweep = await runGatekeeperSweep(chunks, ctx.llmGatekeeper, {
      batchSize: ctx.config?.distill.gatekeeper.batchSize ?? 20,
      caps: {
        maxPerRun: ctx.config?.distill.gatekeeper.maxPerRun ?? 200,
        maxWallClockMs: ctx.config?.distill.gatekeeper.maxWallClockMs ?? 300_000,
      },
      log: gatekeeperLog,
    });

    const skipRows: Array<{ model: string; confidence: number; mode: 'dry-run' | 'enabled'; sessionId: string | null }> = [];
    let chunksSkipped = 0;
    for (const c of chunks) {
      const verdict = sweep.verdicts.get(c.index);
      if (verdict && verdict.verdict === 'skip') {
        chunksSkipped++;
        skipRows.push({
          model: ctx.llmGatekeeper?.model ?? 'unknown',
          confidence: verdict.confidence,
          mode: gatekeeperMode,
          sessionId: ctx.sessionId,
        });
      }
    }
    const skipRate = sweep.chunksEvaluated > 0 ? chunksSkipped / sweep.chunksEvaluated : null;
    pipeLog.info(
      {
        stage: 'gatekeeper',
        chunks_evaluated: sweep.chunksEvaluated,
        chunks_skipped: chunksSkipped,
        skip_rate: skipRate,
        mode: gatekeeperMode,
      },
      'stage complete',
    );

    // Diagnostic-only write, same isolation as the relation/entity/evidence
    // guard-drop writes below — a failure here must never be reinterpreted
    // as a gatekeeper (let alone pipeline) failure; the gate decision above
    // has already been applied in-memory regardless of whether this
    // persists.
    try {
      recordGatekeeperSkips(ctx.db, skipRows);
      recordGatekeeperRunLog(ctx.db, {
        sessionId: ctx.sessionId,
        chunksEvaluated: sweep.chunksEvaluated,
        chunksSkipped,
      });
    } catch (err) {
      pipeLog.warn(
        { stage: 'gatekeeper', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
        'gatekeeper counter write failed (non-fatal, diagnostic only — gate decision already applied)',
      );
    }

    if (gatekeeperMode === 'enabled') {
      chunksForExtraction = chunks.filter((c) => sweep.verdicts.get(c.index)?.verdict !== 'skip');
    }
    // 'dry-run': chunksForExtraction stays === chunks (unmodified) — see AC-3.
  }

  const budget = new BudgetTracker(ctx.db);

  // Opt-in call-count/wall-clock cap on compact()+extract() LLM calls,
  // combined, for THIS job — disabled by default (config.distill.costCap,
  // see src/distill/cost-cap.ts's doc comment for why this is separate
  // from BudgetTracker's dollar cap above). ONE tracker instance shared by
  // both stages below so maxCallsPerJob bounds the two stages together, not
  // independently.
  const costCap = new DistillCostCapTracker(
    resolveDistillCostCap(ctx.config ?? defaultConfig()),
    (message) => pipeLog.warn({ stage: 'cost-cap' }, message),
  );

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

  // PROFILE RESOLUTION MOVED UP. It used to be computed AFTER the compact()
  // call below — which is structurally why stage 4 never saw it, and why
  // every conversational transcript got the coding-agent compressor. The
  // profile has to exist before the first stage that needs it, not before
  // the stage that happened to be written first.
  const resolvedExtractProfile = ctx.extractProfile ?? ctx.config?.distill.extractProfile ?? 'engineering';
  const compactionMode = ctx.config?.distill.compaction ?? 'auto';
  // Dual-pass extraction (opt-in): `1` (no ctx.config, or an unset/explicit
  // 1) is BYTE-IDENTICAL to pre-dual-pass behavior — see
  // Config['distill']['extractionPasses']'s own doc comment for the full
  // design. No per-transcript envelope override (unlike extractProfile) —
  // this is a config-only knob.
  const resolvedExtractionPasses = ctx.config?.distill.extractionPasses ?? 1;

  // Stage 4: Compact (LLM, budget-gated)
  // #284: the gate decision (run vs skip) must be OBSERVABLE. A skipped
  // stage that logs identically to a run one is the exact ADR-015 footgun
  // this repo keeps re-discovering — "stage complete" fired either way, so
  // the log alone couldn't tell you whether an LLM call happened or the
  // chunk passed through untouched. `willCompact` mirrors compact()'s own
  // shouldCompact() gate (04-compact.ts) so the log can never drift from
  // the actual decision the stage makes one line later.
  const willCompact = shouldCompact({ profile: resolvedExtractProfile, mode: compactionMode });

  // #284 Bug 2: per-CHUNK size gate on top of the categorical mode/profile
  // gate above. `willCompact` alone can no longer tell the whole story once
  // a batch can be PARTIALLY skipped (mode 'auto' + engineering, some chunks
  // already fitting) — compactionDecisionFor is called here with the exact
  // same (text, profile, mode) compact() itself uses per chunk below, so
  // this summary can never drift from the real per-chunk decision.
  const compactDecisions = chunksForExtraction.map(chk =>
    compactionDecisionFor(chk.text, { profile: resolvedExtractProfile, mode: compactionMode }),
  );
  const compactionSizeSkipped = compactDecisions.filter(d => d.skipReason === 'size').length;
  const compactionSkipReasons = new Set(compactDecisions.filter(d => !d.compact).map(d => d.skipReason));
  const compactionSkipReason =
    compactionSkipReasons.size === 0 ? undefined
    : compactionSkipReasons.size === 1 ? [...compactionSkipReasons][0]
    : 'mixed';

  pipeLog.info(
    {
      stage: 'compact',
      chunk_count: chunksForExtraction.length,
      chunk_concurrency: chunkConcurrency,
      extract_profile: resolvedExtractProfile,
      compaction_mode: compactionMode,
      compaction_skipped: !willCompact,
      compaction_skip_reason: compactionSkipReason,
      compaction_size_skipped: compactionSizeSkipped,
    },
    willCompact ? 'stage start' : 'stage start — SKIPPED (passthrough, no LLM call)',
  );

  let compactedChunks: Array<{ index: number; text: string }>;
  try {
    const compactResults = await compact(
      chunksForExtraction, ctx.llmCompaction, budget, ctx.capUsd, chunkConcurrency, checkpointJobKey,
      { profile: resolvedExtractProfile, mode: compactionMode, costCap },
    );
    // FEAT-548: looked up by chunk.index VALUE, not array position — pre-
    // gatekeeper, chunksForExtraction (== chunks) was never filtered, so
    // chunk.index always coincided with its own array position and a plain
    // `chunks[r.index]` lookup happened to work. Once 'enabled' mode can
    // remove chunks from the middle of the array, position and .index value
    // diverge (e.g. chunk.index 3 can sit at array position 1) — a positional
    // lookup would silently grab the WRONG chunk's raw text as the
    // empty-compaction-result fallback.
    const chunksForExtractionByIndex = new Map(chunksForExtraction.map(chk => [chk.index, chk]));
    compactedChunks = compactResults.map(r => ({ index: r.index, text: r.text || chunksForExtractionByIndex.get(r.index)?.text || '' }));
    pipeLog.info(
      {
        stage: 'compact',
        chunks_compacted: compactedChunks.length,
        compaction_skipped: !willCompact,
        compaction_skip_reason: compactionSkipReason,
        compaction_size_skipped: compactionSizeSkipped,
      },
      'stage complete',
    );
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
  pipeLog.info(
    {
      stage: 'extract', chunk_count: compactedChunks.length, extract_profile: resolvedExtractProfile,
      chunk_concurrency: chunkConcurrency,
      // FEAT-534: provider identity on every extract-stage log line, not just
      // extract-specifics below — a silent model mix on EITHER pass is an
      // ADR-015 hazard, and pass A's own model is otherwise unrecorded here.
      provider: ctx.llmExtraction.name, model: ctx.llmExtraction.model,
    },
    'stage start',
  );
  let extractResults;
  try {
    extractResults = await extract(compactedChunks, ctx.llmExtraction, budget, ctx.capUsd, resolvedExtractProfile, chunkConcurrency, checkpointJobKey, sessionDateIso, costCap);
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

  // Stage 5b: Extract, Pass B ("specifics sweeper") — opt-in
  // (distill.extractionPasses: 2). Cost guard: only reached once pass A above
  // has ALREADY returned successfully (the try/catch above re-throws on any
  // pass-A failure before this line is ever reached) — never doubles a
  // retry storm on a failing/paused pass A. Same chunks, same budget
  // tracker.
  //
  // FEAT-534: provider is `ctx.llmExtractionPassB ?? ctx.llmExtraction` —
  // unset (the default) rides the SAME provider instance pass A used,
  // byte-identical to pre-FEAT-534 behavior. Set, it runs pass B on a
  // distinct provider/model (see Config['distill']['extractionPassB']'s doc
  // comment for the codex-pass-A / qwen3-pass-B hybrid motivation). Logged
  // explicitly below (provider/model on both start and complete) so a
  // silent model mix is never invisible in the distill event log — the
  // exact ADR-015 concern this override introduces.
  const passBProvider = ctx.llmExtractionPassB ?? ctx.llmExtraction;
  let extractResultsSpecifics: typeof extractResults | undefined;
  if (resolvedExtractionPasses === 2) {
    pipeLog.info(
      {
        stage: 'extract-specifics', chunk_count: compactedChunks.length, chunk_concurrency: chunkConcurrency,
        provider: passBProvider.name, model: passBProvider.model,
      },
      'stage start',
    );
    try {
      extractResultsSpecifics = await extractSpecifics(compactedChunks, passBProvider, budget, ctx.capUsd, chunkConcurrency, checkpointJobKey, sessionDateIso);
      const specificsAtoms = extractResultsSpecifics.reduce((sum, r) => sum + r.atoms.length, 0);
      pipeLog.info(
        { stage: 'extract-specifics', atoms_extracted: specificsAtoms, provider: passBProvider.name, model: passBProvider.model },
        'stage complete',
      );
    } catch (err) {
      if (err instanceof ExtractBudgetExceeded) {
        pipeLog.warn({ stage: 'extract-specifics', error_kind: 'BudgetExceeded' }, 'stage aborted — budget exceeded');
        throw err;
      }
      pipeLog.warn({ stage: 'extract-specifics', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200), error_kind: err instanceof Error ? err.name : 'Unknown' }, 'stage failed');
      throw err;
    }
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
    for (const r of [...extractResults, ...(extractResultsSpecifics ?? [])]) {
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
    for (const r of [...extractResults, ...(extractResultsSpecifics ?? [])]) {
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

  // FEAT-485: same diagnostic-write pattern one level up — persist
  // requireEvidenceForRichTypes' per-reason (atom type) drop counts so the
  // doctor "Evidence provenance" canary can tell "model never emits evidence"
  // apart from "model emits lesson/decision atoms without evidence and the
  // guard drops every one". Its own try/catch, never re-thrown — a write
  // failure here must never be reinterpreted as an extract-stage failure.
  // Aggregated across BOTH extraction passes (pass A + the dual-pass specifics
  // sweeper), same as the relation/entity guard-drop counters above.
  try {
    const evidenceDropTotals: Record<string, number> = {};
    for (const r of [...extractResults, ...(extractResultsSpecifics ?? [])]) {
      for (const [reason, count] of Object.entries(r.evidenceDropCounts)) {
        evidenceDropTotals[reason] = (evidenceDropTotals[reason] ?? 0) + count;
      }
    }
    recordEvidenceGuardDrops(
      ctx.db,
      Object.entries(evidenceDropTotals).map(([reason, count]) => ({ reason, count })),
      ctx.sessionId,
    );
  } catch (err) {
    pipeLog.warn(
      { stage: 'extract', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
      'evidence guard-drop counter write failed (non-fatal, diagnostic only — extraction already succeeded)',
    );
  }

  // Flatten all atoms. Dual-pass (extractResultsSpecifics present): merge
  // pass A + pass B per chunk BEFORE reduce (design constraint — dedup must
  // run before stage 6, which merges by content hash, not by the
  // normalized-substring rules dual-pass needs). Single-pass (the default):
  // byte-identical to pre-dual-pass behavior — just pass A's atoms flattened.
  //
  // FEAT-551: each atom is tagged with its originating pass
  // (SourcedAtom.extractionSource) BEFORE the merge — mergeDualPassAtoms
  // never spreads/reconstructs an atom (see its own doc comment), so the tag
  // rides through the merge, reduce, and memory-normalize stages unchanged,
  // all the way to stage 8's evidence gate. Pass-A atoms are tagged 'passA'
  // explicitly (not left untagged) purely so both arrays share one concrete
  // type at the mergeDualPassAtoms call site — the gate itself only ever
  // acts on 'passB' (AC-2: 'passA' is bypassed identically to "untagged").
  let allAtoms: SourcedAtom[];
  if (extractResultsSpecifics) {
    const specificsByChunk = new Map(extractResultsSpecifics.map(r => [r.chunkIndex, r]));
    const mergedAtoms: SourcedAtom[] = [];
    for (const passAResult of extractResults) {
      const passBResult = specificsByChunk.get(passAResult.chunkIndex);
      const passAAtoms: SourcedAtom[] = passAResult.atoms.map(a => ({ ...a, extractionSource: 'passA' as const }));
      const passBAtoms: SourcedAtom[] = (passBResult?.atoms ?? []).map(a => ({ ...a, extractionSource: 'passB' as const }));
      const { merged, dedupedAway } = mergeDualPassAtoms<SourcedAtom>(passAAtoms, passBAtoms);
      pipeLog.info(
        {
          stage: 'extract-dual-pass-merge',
          chunk_index: passAResult.chunkIndex,
          passA_atoms: passAAtoms.length,
          passB_atoms: passBAtoms.length,
          merged: merged.length,
          deduped_away: dedupedAway,
        },
        'chunk merged',
      );
      mergedAtoms.push(...merged);
    }
    allAtoms = mergedAtoms;
  } else {
    allAtoms = extractResults.flatMap(r => r.atoms);
  }

  // ADR-015 headline finding: a well-formed `{"atoms":[]}` extraction
  // completes as SUCCESS at every other layer -- not the Zod gate, not the
  // job queue, not the poison counter (which only increments on failure).
  // A broken model and a genuinely empty transcript are indistinguishable
  // anywhere else. Record chunks-in vs atoms-out for every run (including
  // zero-atom ones -- that IS the signal) so the doctor "Extraction yield"
  // canary can compute a zero-yield RATE over a recent window instead of
  // an existence check. Same diagnostic-only posture as the relation/
  // entity guard-drop writes immediately above: its own try/catch, never
  // re-thrown, so a counter-write failure can never be mistaken for the
  // extract stage itself failing.
  try {
    recordExtractionYield(ctx.db, {
      sessionId: ctx.sessionId,
      // FEAT-548: chunksForExtraction (post-gatekeeper), not the raw
      // chunks.length — a gatekeeper-skipped chunk never reached extraction,
      // so counting it here would conflate "the gate correctly skipped
      // noise" with "the extraction model returned zero atoms", corrupting
      // the zero-yield-rate canary's denominator. Byte-identical to
      // pre-FEAT-548 (chunksForExtraction === chunks) whenever the gate is
      // 'off' or 'dry-run'.
      chunksIn: chunksForExtraction.length,
      atomsOut: allAtoms.length,
    });
  } catch (err) {
    pipeLog.warn(
      { stage: 'extract', error_message: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
      'extraction-yield counter write failed (non-fatal, diagnostic only — extraction already succeeded)',
    );
  }

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
  const normalizedMemories = memoryNormalize(groundResult.atoms, {
    typeHints: ctx.config?.distill.typeHints,
    log: message => pipeLog.warn({ stage: 'memory-normalize' }, message),
  });
  pipeLog.info(
    {
      stage: 'memory-normalize',
      memories: normalizedMemories.length,
      // FEAT-552 sub-scope B: how many atoms the deterministic type-hint
      // tier actually overrode this run — the same "measure the rate, not
      // just existence" posture every other distill-stage canary follows
      // (ADR-015).
      type_hints_applied: normalizedMemories.filter(m => m.typeHintApplied).length,
    },
    'stage complete',
  );

  // FEAT-551: resolve the evidence-gated sweeper's on/off state. Explicit
  // config always wins; unset defaults to ON exactly when passB actually ran
  // on a DIFFERENT provider than pass A — the mixed-provider case is exactly
  // where the junk-crowding risk was measured (see FEAT-551 spec). Computed
  // unconditionally (cheap, two string comparisons) even on a single-pass
  // run — harmless, since checkEvidenceGate only ever acts on an atom tagged
  // `extractionSource: 'passB'`, which a single-pass run never produces.
  const evidenceGateSetting = ctx.config?.distill.extractionPassB?.evidenceGate;
  const evidenceGateEnabled =
    evidenceGateSetting === 'on' ? true
    : evidenceGateSetting === 'off' ? false
    : resolvedExtractionPasses === 2 && passBProvider.name !== ctx.llmExtraction.name;

  // Stage 8: Embed + index
  pipeLog.info(
    { stage: 'embed-index', memories: normalizedMemories.length, evidence_gate_enabled: evidenceGateEnabled },
    'stage start',
  );
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
    consentDisclosed: ctx.consentDisclosed,
    durabilityGateMode: ctx.durabilityGateMode,
    redactConfig: ctx.config,
    gatedOutCounter,
    // FEAT-551: see evidenceGateEnabled's own resolution comment above.
    evidenceGateEnabled,
    // FEAT-533: mode/caps resolved from config (falls back to 'off'/the
    // documented defaults when ctx.config is omitted — same convention
    // ctx.config's other stage-8 consumers above use), provider from
    // ctx.llmAtomTriage (byte-identical no-op when both are absent).
    atomTriageMode: ctx.config?.distill.atomTriage.mode,
    llmAtomTriage: ctx.llmAtomTriage,
    atomTriageBatchSize: ctx.config?.distill.atomTriage.batchSize,
    atomTriageMaxPerRun: ctx.config?.distill.atomTriage.maxPerRun,
    atomTriageMaxWallClockMs: ctx.config?.distill.atomTriage.maxWallClockMs,
    // FEAT-491: the flattened transcript text this run's atoms were
    // extracted from (this function's own `transcript` parameter) — stage 8
    // uses it to recover per-atom speaker attribution from the
    // `role: [Speaker] text` markers flatten-turns.ts embeds (see
    // attribute-speaker.ts). `null` for every atom whose evidence doesn't
    // match a labeled turn, including every transcript with no speaker
    // labels at all (the overwhelming majority).
    sourceText: transcript,
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
