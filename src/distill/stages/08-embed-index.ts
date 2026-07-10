/**
 * Stage 8 — Embed + Index (provider call + DB writes)
 *
 * For each normalized memory:
 * 1. Insert into memories table via MemoryRepo.insert (hash dedup built in)
 * 2. Embed the normalizedText via EmbedProvider
 * 3. Upsert vec row via SqliteVecStore.upsert
 * 4. Update embedding_provider/model/dim on the memories row
 */

import type { EmbedProvider } from '../../contracts/index.js';
import type { NormalizedMemory } from './07-memory-normalize.js';
import { MemoryRepo } from '../../storage/memories.js';
import { MemoryEventRepo } from '../../storage/memory-events.js';
import { EntityRepo } from '../../storage/entities.js';
import { SqliteVecStore } from '../../vector/sqlite-vec.js';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { defaultConfig } from '../../config/config.js';
import { redactIfEnabled } from '../../redact/index.js';
import { childLogger } from '../../log/logger.js';
import { gateDurability, type DurabilityGateMode, type GatedReason } from '../durability-gate.js';

export interface IndexResult {
  memoryId: string;
  created: boolean; // false = deduped (already existed)
}

export interface EmbedIndexContext {
  db: DB;
  embed: EmbedProvider;
  sessionId: string | null;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  sourceHash: string | null;
  /**
   * Canonical envelope's `captured_at` (epoch ms), when the ingest route
   * received one (v1.0 envelope only — legacy v0.0 has no such field).
   * Becomes each new memory's `valid_from` so bitemporal `as_of` queries key
   * off when the content was true, not when this distill job happened to
   * run. `null`/omitted falls back to MemoryRepo's insert-time wall-clock
   * default — the pre-existing behavior for legacy envelopes and any
   * pre-fix rows (no migration backfills those; see distill.ts/distill-events.ts).
   */
  capturedAtMs?: number | null;
  /**
   * FEAT-455 / ADR-012 decision 4: provenance tag carried on the transcripts
   * row this distill run's atoms were extracted from — `'auto_capture'` when
   * the source transcript was captured by the hook-tap auto-capture trigger,
   * `null`/omitted for every other producer (byte-identical default). Passed
   * straight through to `MemoryRepo.insertWithCreateEvent`'s `capture_source`
   * so every atom formed from an auto-captured transcript is itself scoped
   * for the doctor WARN-row count and the disable -> purge query.
   */
  captureSource?: 'auto_capture' | null;
  /**
   * FEAT-441: durability quality gate mode. Undefined/omitted behaves as
   * 'off' — every pre-FEAT-441 caller (and the existing test suite) that
   * never sets this field is byte-identical (AC-2): `gateDurability` short
   * circuits to `null` for 'off' without even running the classifier.
   */
  durabilityGateMode?: DurabilityGateMode;
  /**
   * Config used to redact a gated atom's text before it reaches the log
   * sink (AC-7 — same Stage-0 `redactIfEnabled` choke point `/remember`
   * and ingest use). Only consulted when a gate actually fires (mode !==
   * 'off' and a candidate matches); falls back to `defaultConfig()`
   * (redaction ON by default) if omitted so a caller that turns the gate on
   * without also threading its config still redacts rather than silently
   * skipping redaction.
   */
  redactConfig?: Config;
  /**
   * FEAT-441 AC-4 observability out-param: when provided, `.count` is
   * incremented once per atom gated out during this call. Mutated in place
   * (rather than folded into the return value) so the `IndexResult[]`
   * return contract every existing caller already depends on stays
   * unchanged — callers read `.count` back after the call resolves.
   */
  gatedOutCounter?: { count: number };
}

/**
 * Embed and index all normalized memories.
 * Returns one IndexResult per input atom (some may be deduped by hash).
 */
export async function embedAndIndex(
  memories: NormalizedMemory[],
  ctx: EmbedIndexContext,
): Promise<IndexResult[]> {
  if (memories.length === 0) return [];

  const memRepo = new MemoryRepo(ctx.db);
  const eventsRepo = new MemoryEventRepo(ctx.db);
  const entityRepo = new EntityRepo(ctx.db);
  const vecStore = new SqliteVecStore(ctx.db, ctx.embed.dim);

  // Batch embed all texts at once for efficiency
  const texts = memories.map(m => m.normalizedText);
  const vectors = await ctx.embed.embed(texts);

  const results: IndexResult[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const vec = vectors[i];

    if (!mem) continue;
    if (!vec || vec.length !== ctx.embed.dim) {
      throw new Error(
        `embed provider returned dim=${vec?.length ?? 0} for memory ${i}, expected ${ctx.embed.dim}. ` +
        `This is a provider invariant violation — check config.embedding.provider and model.`
      );
    }

    // Erasure replay filter (ADR-006 W5): an erased content hash must never
    // be resurrected by re-distillation — erasure wins over replay.
    if (eventsRepo.isErasedHash(mem.finalHash)) continue;

    // Durability quality gate (FEAT-441): second continue-style filter, same
    // ordering position as the erasure-replay filter above — a second "last
    // line of defense" check every producer's atoms pass through before
    // insertWithCreateEvent. 'off' (the shipped default) never calls the
    // classifier at all (AC-2 byte-identical guarantee).
    //
    // The whole classify→redact→log block is wrapped so a classifier (or
    // redaction/logging) error FAILS OPEN rather than poisoning the whole
    // distill job or silently dropping an atom that was never actually
    // judged low-durability (2026-07-09 review MEDIUM fix — the generic
    // catch in distill.ts would otherwise turn a durability-gate bug into a
    // job-level failure). `gatedForReason` is only ever set after the log
    // line below has been emitted, so `gatedOutCounter` and the
    // persisted-atom-count stay consistent even when a mid-block throw
    // forces a fail-open persist.
    let gatedForReason: GatedReason | null = null;
    try {
      const reason = gateDurability(mem.text, ctx.durabilityGateMode ?? 'off');
      if (reason) {
        // AC-7: rejected-candidate text passes through the same Stage-0
        // redaction choke point as /remember and ingest before it reaches
        // any log sink, and rides the existing pino/ingest.log 10MB
        // rotation policy rather than an unbounded or separately-retained
        // sink — a single structured log line, no side table.
        const { text: redactedText } = redactIfEnabled(mem.text, ctx.redactConfig ?? defaultConfig());
        childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
          { gatedReason: reason, atom_type: mem.type, text: redactedText.slice(0, 500) },
          'durability gate: atom rejected — never passed to insertWithCreateEvent',
        );
        gatedForReason = reason;
      }
    } catch (err) {
      childLogger({ session_id: ctx.sessionId ?? undefined, stage: 'embed-index' }).warn(
        { error_message: err instanceof Error ? err.message : String(err) },
        'durability gate: classifier/redaction/log error — failing open, atom will be persisted',
      );
      gatedForReason = null;
    }

    if (gatedForReason) {
      if (ctx.gatedOutCounter) ctx.gatedOutCounter.count += 1;
      continue;
    }

    // Insert + append a 'create' memory_event (ADR-002) in one transaction.
    // Dedup-aware: `created` is false when this hash already existed.
    const { id: memoryId, created } = memRepo.insertWithCreateEvent({
      type: mem.type,
      text: mem.text,
      normalized_text: mem.normalizedText,
      hash: mem.finalHash,
      importance: mem.importance,
      confidence: mem.confidence,
      session_id: ctx.sessionId,
      repo: ctx.repo,
      project: ctx.project,
      branch: ctx.branch,
      agent: ctx.agent,
      source_hash: ctx.sourceHash,
      embedding_provider: ctx.embed.name,
      embedding_model: ctx.embed.model,
      embedding_dim: ctx.embed.dim,
      evidence: mem.evidence ?? null,
      scope: 'private',
      valid_from: ctx.capturedAtMs ?? undefined,
      capture_source: ctx.captureSource ?? null,
      // atom@2: stage 5 always runs entity extraction as part of this same
      // atom's LLM call, so every atom from this pipeline has "declared"
      // entities even when it found none — default to [] (not undefined)
      // so the sync payload signals "tried, found nothing" rather than
      // "extraction never ran" (see InsertInput.entities doc).
      entities: mem.entities ?? [],
    }, eventsRepo);

    // FEAT-402 AC-1 / FEAT-453 §4: link entities emitted in the same
    // extraction call, carrying each entity's stated fact-level validity
    // hint (if any) through to memory_entities. Idempotent — linkWithValidity
    // silently no-ops a duplicate open-window insert for the same pair (see
    // its doc comment), so this is safe to run on a deduped hit too, exactly
    // like the linkEntitiesForMemory() call it replaces here. valid_at/
    // invalid_at are parsed from the extractor's ISO-8601 strings to epoch
    // ms; a missing or unparseable hint resolves to `null` — "no stated
    // fact-level start/end," never "now" — so it falls back to the parent
    // memory's own valid_from at query time (design doc §3.1), not baked in
    // here.
    for (const entity of mem.entities ?? []) {
      const entityId = entityRepo.upsert(entity.name, entity.kind);
      entityRepo.linkWithValidity(memoryId, entityId, {
        validAt: parseIsoToMs(entity.valid_at),
        invalidAt: parseIsoToMs(entity.invalid_at),
      });
    }

    // Always upsert vec (may update if the memory already existed but had no vec)
    await vecStore.upsert(memoryId, vec);

    // Update embedding metadata on the memories row (in case it pre-existed without it)
    ctx.db
      .prepare(`
        UPDATE memories
        SET embedding_provider = ?, embedding_model = ?, embedding_dim = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(ctx.embed.name, ctx.embed.model, ctx.embed.dim, Date.now(), memoryId);

    results.push({ memoryId, created });
  }

  return results;
}

/**
 * Parse an extractor-emitted ISO-8601 valid_at/invalid_at hint (FEAT-453 §4)
 * to epoch ms. Returns `null` — not `undefined`, not `Date.now()` — for a
 * missing or unparseable value: `linkWithValidity`'s `null` means "no stated
 * fact-level bound," which is the correct fallback whether the extractor
 * omitted the hint entirely or emitted a malformed date string.
 */
function parseIsoToMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
