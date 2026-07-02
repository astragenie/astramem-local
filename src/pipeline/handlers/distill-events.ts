/**
 * Distill-events handler — ADR-008 `events` capture kind.
 *
 * Pre-typed atom candidates (runner-plugin grades/lessons/review verdicts)
 * are already atom-shaped when they hit the wire, so this handler skips
 * pipeline stages 1-5 (cleanup/normalize/chunk/compact/extract — the raw-text
 * and LLM stages) and enters directly at stage 6 (reduce), chaining straight
 * through stage 7 (memory-normalize) and stage 8 (embed+index), mirroring
 * the same three-stage tail src/distill/pipeline.ts runs for the transcript
 * path. No LLMProvider is used here (no compaction/extraction call), so the
 * BudgetExceeded semantics distillHandler has for stages 4/5 do not apply —
 * only the embed provider is exercised (stage 8).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JobHandler } from '../handler.js';
import { isExtendedCtx } from '../handler-ctx-ext.js';
import { reduce } from '../../distill/stages/06-reduce.js';
import { memoryNormalize } from '../../distill/stages/07-memory-normalize.js';
import { embedAndIndex } from '../../distill/stages/08-embed-index.js';
import { backfillSummaryMemoryId } from '../../storage/ingest-idempotency.js';
import { childLogger } from '../../log/logger.js';
import type { Atom } from '../../distill/prompts/extract.js';

/**
 * Flexible payload schema — ingest route writes {transcript_id, session_id}
 * without the `kind` discriminator. Accept both forms (mirrors distill.ts).
 */
const DistillEventsPayloadFlexSchema = z.object({
  transcript_id: z.string().min(1),
  session_id: z.string().min(1),
  kind: z.string().optional(),
});

/**
 * Shape of one event as stored in `transcripts.content` (redacted, JSON
 * array) — mirrors CanonicalEventItemSchema in server/routes/ingest.ts and
 * the 7-type registry in distill/prompts/extract.ts (AtomSchema).
 */
const StoredEventSchema = z.object({
  type: z.enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']),
  text: z.string().min(1),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().optional(),
  occurred_at: z.number().optional(),
});

const StoredEventsSchema = z.array(StoredEventSchema).min(1);

interface TranscriptRow {
  id: string;
  session_id: string;
  content: string;
  source: string;
}

interface SessionRow {
  id: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
}

/** Applied when the source event omits importance/confidence (ADR-008). */
const DEFAULT_IMPORTANCE = 0.7;
const DEFAULT_CONFIDENCE = 0.9;

export const distillEventsHandler: JobHandler = {
  kind: 'distill-events',

  async handle(payload: unknown, ctx): Promise<void> {
    const parsed = DistillEventsPayloadFlexSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid distill-events payload: ${parsed.error.message}`);
    }

    const { transcript_id, session_id } = parsed.data;

    // Fetch the transcript row the ingest route wrote (content = JSON of
    // redacted events, source = `<tool>-events` or 'events').
    const transcript = ctx.db
      .prepare('SELECT id, session_id, content, source FROM transcripts WHERE id = ?')
      .get(transcript_id) as TranscriptRow | undefined;

    if (!transcript) {
      throw new Error(`Transcript not found: ${transcript_id}`);
    }

    // Fetch session metadata for memory context
    const session = ctx.db
      .prepare('SELECT id, repo, project, branch, agent FROM sessions WHERE id = ?')
      .get(session_id) as SessionRow | undefined;

    let rawEvents: unknown;
    try {
      rawEvents = JSON.parse(transcript.content);
    } catch (e) {
      // Deterministic — retrying will never fix a JSON parse failure.
      throw new Error(`distill-events transcript content is not valid JSON: ${String(e)}`);
    }

    const eventsResult = StoredEventsSchema.safeParse(rawEvents);
    if (!eventsResult.success) {
      throw new Error(`distill-events transcript content does not match the events shape: ${eventsResult.error.message}`);
    }
    const events = eventsResult.data;

    // Map pre-typed events straight to Atoms — the stage-1-5 skip (ADR-008):
    // no cleanup/normalize/chunk/compact/extract, just the atom shape stages
    // 6-8 already expect.
    const atoms: Atom[] = events.map(ev => ({
      type: ev.type,
      text: ev.text,
      importance: ev.importance ?? DEFAULT_IMPORTANCE,
      confidence: ev.confidence ?? DEFAULT_CONFIDENCE,
      evidence: ev.evidence,
    }));

    if (!isExtendedCtx(ctx)) {
      // Fallback: no providers available (e.g. in unit tests without providers)
      console.warn(
        `[distill-events] no providers in ctx — transcript ${transcript_id} logged but not distilled. ` +
          'Ensure ExtendedHandlerCtx is passed when providers are configured.',
      );
      return;
    }

    const pipeLog = childLogger({ session_id });

    // Stage 6: Reduce (merge by content hash)
    pipeLog.info({ stage: 'reduce', atoms_in: atoms.length }, 'stage start');
    const reducedAtoms = reduce(atoms);
    pipeLog.info({ stage: 'reduce', atoms_out: reducedAtoms.length }, 'stage complete');

    // Stage 7: Memory-normalize
    pipeLog.info({ stage: 'memory-normalize' }, 'stage start');
    const normalizedMemories = memoryNormalize(reducedAtoms);
    pipeLog.info({ stage: 'memory-normalize', memories: normalizedMemories.length }, 'stage complete');

    // Stage 8: Embed + index — session/repo/branch/agent come from the
    // session row; embedAndIndex appends a 'create' memory_event per new
    // memory (2b), same as the transcript path.
    const sourceHash = createHash('sha256').update(transcript.content, 'utf8').digest('hex');

    pipeLog.info({ stage: 'embed-index', memories: normalizedMemories.length }, 'stage start');
    const indexResults = await embedAndIndex(normalizedMemories, {
      db: ctx.db,
      embed: ctx.providers.embed,
      sessionId: session_id,
      repo: session?.repo ?? null,
      project: session?.project ?? null,
      branch: session?.branch ?? null,
      agent: session?.agent ?? null,
      sourceHash,
    });

    const created = indexResults.filter(r => r.created).length;
    const deduped = indexResults.filter(r => !r.created).length;
    pipeLog.info({ stage: 'embed-index', memories_created: created, memories_deduped: deduped }, 'stage complete');

    console.log(
      `[distill-events] transcript=${transcript_id} events=${events.length} atoms=${atoms.length} ` +
        `created=${created} deduped=${deduped}`,
    );

    // D-DEF2 parity: backfill ingest_idempotency.summary_memory_id from the
    // transcript-id placeholder to the real created memory id, same as the
    // transcript path.
    if (indexResults.length > 0) {
      backfillSummaryMemoryId(ctx.db, transcript_id, indexResults[0]!.memoryId);
    }
  },
};
