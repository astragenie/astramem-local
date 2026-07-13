import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { childLogger } from '../../log/logger.js';
import { stableStringify } from '../lib/stable-stringify.js';
import { type Config, defaultConfig } from '../../config/config.js';
import { redactIfEnabled, type RedactionEvent } from '../../redact/index.js';
import { recordRedactionEvents } from '../../storage/redaction-log.js';
import { deriveRepoFromCwd } from '../../tag-hygiene/derive-repo.js';
import { AtomSchema } from '../../distill/prompts/extract.js';

// ---------------------------------------------------------------------------
// FEAT-4a §4.2.3.4 / CHANGELOG v0.2.0 — response-field metadata (read-only,
// no extraction logic here). `ALL_ATOM_TYPES` mirrors the 7-type registry
// distillHandler's LLM extraction stage can emit (src/distill/prompts/
// extract.ts AtomSchema) — used as the "queued" candidate set for the
// transcript-kind path, where real extraction hasn't run yet (async job).
// ---------------------------------------------------------------------------
const ALL_ATOM_TYPES = AtomSchema.shape.type.options;

// ---------------------------------------------------------------------------
// Legacy envelope (v0.0) — original shape; discriminated by presence of `content`
// ---------------------------------------------------------------------------

const LegacyIngestSchema = z.object({
  session_id: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1),
  repo: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Canonical envelope (v1.0) — FEAT-4a SaaS wire format
// Field names and types mirror TranscriptIngestPayloadSchema in wire.ts exactly,
// with the addition of `wire_version` (^v\d+\.\d+$) which is required here even
// though the plugin schema doesn't yet carry it (pending SaaS DTO catch-up).
//
// Discriminated from legacy by presence of `turns` (array, min 1).
// ---------------------------------------------------------------------------

export const TranscriptTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  ts: z.string().optional(), // ISO-8601 if present
});

// ---------------------------------------------------------------------------
// ADR-008 capture@1 `events` kind — pre-typed atom candidates (runner-plugin
// grades/lessons/review verdicts) that skip pipeline stages 1-5 and enter at
// reduce (stage 6). Type enum mirrors the 7-type registry in
// src/distill/prompts/extract.ts (AtomSchema).
// ---------------------------------------------------------------------------

export const CanonicalEventItemSchema = z.object({
  type: z.enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']),
  text: z.string().min(1),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.string().optional(),
  occurred_at: z.number().optional(),
});

export const CanonicalIngestSchema = z.object({
  event: z.enum(['pre_compact', 'session_end', 'subagent_stop']),
  session_id: z.string(),
  project_id: z.string(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
  captured_at: z.string().datetime({ offset: true }), // ISO-8601 with UTC Z — guards NaN on getTime()
  /** ADR-008 payload kind. Defaults to 'transcript' — existing clients unaffected. */
  kind: z.enum(['transcript', 'events']).optional().default('transcript'),
  turns: z.array(TranscriptTurnSchema).min(1).optional(),
  /** Required (min 1, max 500) when kind === 'events' — see superRefine below. */
  events: z.array(CanonicalEventItemSchema).min(1).max(500).optional(),
  /** Provenance (ADR-008 `tool` field). No default — record what's sent or null. */
  tool: z.string().optional(),
  /** FEAT-455 / ADR-012 decision 4, widened 2026-07-12 (doctor canary
   *  provenance fix): `'auto_capture'` from the hook-tap auto-capture
   *  trigger, `'hook_close'` from the ordinary astramem-plugin close-capture
   *  hook (`buildClaudeEnvelope`'s optional `captureSource` param). Widened
   *  again FEAT-458 S3 (ADR-013 Decision 1, Repudiation row): `'proxy'` from
   *  the LLM proxy's capture fork (`src/capture/proxy.ts`,
   *  `ProxyCaptureEnvelope.capture_source`) — this is the SAME schema
   *  instance `src/ingest/spool-drain.ts`'s `drainIngestSpool` validates
   *  spooled envelopes against before calling `ingestCanonicalTranscript`,
   *  so a spooled `capture_source: 'proxy'` envelope that didn't widen this
   *  enum would fail `safeParse` and quarantine as poison after
   *  `MAX_DRAIN_ATTEMPTS` — a silent proxy-capture data loss this widening
   *  closes. Every other client omits this field and the transcripts/
   *  memories rows it flows into stay NULL (byte-identical). Kept a closed
   *  enum rather than an open string deliberately — an unrecognized value is
   *  a real client bug worth surfacing as 400 on the direct
   *  `/ingest/transcript` path, not something to silently coerce to null. */
  capture_source: z.enum(['auto_capture', 'hook_close', 'proxy']).optional(),
  /** Aggregate scrub flag — required; still consumed for telemetry. Superseded by client_scrub_hits_by_label for per-label breakdown but not deprecated. */
  client_scrub_applied: z.boolean(),
  /** Aggregate scrub hit count — required; still consumed for telemetry. Superseded by client_scrub_hits_by_label sum for per-label breakdown but not deprecated. */
  client_scrub_hits: z.number().int().nonnegative(),
  client_version: z.string(),
  client_scrub_version: z.string(),
  client_scrub_hits_by_label: z.record(z.string(), z.number().int().nonnegative()).optional(),
  // Regex mirrors SaaS IngestTranscriptRequest.cs:65 per FEAT-4a Phase 3 alignment.
  /** Wire protocol version — must match ^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$ (e.g. "v1.0"). */
  wire_version: z.string().regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/, 'wire_version must match ^v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$ (e.g. "v1.0")'),
}).superRefine((data, ctx) => {
  if (data.kind === 'events') {
    if (!data.events || data.events.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'events kind requires a non-empty `events` array', path: ['events'] });
    }
  } else if (!data.turns || data.turns.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'transcript kind requires a non-empty `turns` array', path: ['turns'] });
  }
});

// ---------------------------------------------------------------------------
// Combined schema — canonical tried first (has `wire_version`), legacy as fallback
// ---------------------------------------------------------------------------

const IngestSchema = z.union([CanonicalIngestSchema, LegacyIngestSchema]);

type ParsedIngest = z.infer<typeof IngestSchema>;

function isCanonical(data: ParsedIngest): data is z.infer<typeof CanonicalIngestSchema> {
  // `turns` is now optional on the canonical schema (events kind omits it),
  // so discriminate on `wire_version` instead — required on canonical,
  // absent from the legacy envelope.
  return 'wire_version' in data;
}

// ---------------------------------------------------------------------------
// FEAT-449 — shared canonical-transcript ingest path. Extracted so the
// durable ingest-spool drain worker (src/ingest/spool-drain.ts) can run
// spooled Claude-capture envelopes through the EXACT SAME redact -> session
// upsert -> transcript insert -> distill-job-enqueue -> idempotency logic the
// HTTP route below uses, in-process, without re-POSTing to itself over the
// network. The route's transcript-kind branch is now a thin wrapper: call
// this, map the result (or a thrown sentinel error) to an HTTP response.
// Handles the transcript-kind canonical envelope only — events-kind stays
// inline in the route (captures never produce it).
// ---------------------------------------------------------------------------

export class IdempotentReplayError extends Error {
  constructor(public readonly replayId: string) {
    super('idempotent_replay');
    this.name = 'IdempotentReplayError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super('idempotency_conflict');
    this.name = 'IdempotencyConflictError';
  }
}

export interface CanonicalTranscriptIngestResult {
  transcriptId: string;
  jobId: string;
  /** Server-side redaction hit count (SEC-3/5) — surfaced in the HTTP
   *  response's scrub_hits.server field. */
  serverRedactionHits: number;
}

/**
 * Insert one canonical transcript-kind envelope: stage-0 redact -> session
 * upsert -> transcripts insert -> distill job enqueue, honoring the same
 * Idempotency-Key semantics `POST /ingest/transcript` applies (D-B1/B2/B3).
 *
 * Throws `IdempotentReplayError` when `idempotencyKey` already resolved to a
 * still-live transcript/memory with a matching body hash (valid replay), and
 * `IdempotencyConflictError` when the same key was reused with a DIFFERENT
 * body. Callers decide how to surface those — the HTTP route maps them to
 * 200/409; the spool drain worker (src/ingest/spool-drain.ts) treats a
 * replay as a successful drain (delete the spool file, move on) and a
 * conflict as a quarantine reason (a spooled envelope's key is a content
 * hash, so a genuine conflict means the row was independently created with a
 * different body under the same key — not self-healing via retry).
 *
 * Statements are prepared per call rather than hoisted like the route's
 * factory-scoped ones (D-B6) — this path runs once per HTTP request (already
 * dominated by redaction + a DB transaction) or once per spool-drain tick
 * (seconds-scale cadence), never in a tight loop, so the prepare cost is
 * immaterial; the SQL text below is a direct mirror of the route's own
 * statements (single source of truth for the shape).
 */
export function ingestCanonicalTranscript(
  db: DB,
  config: Config,
  data: z.infer<typeof CanonicalIngestSchema>,
  idempotencyKey: string | null,
): CanonicalTranscriptIngestResult {
  if (data.kind === 'events' || !data.turns || data.turns.length === 0) {
    throw new Error('ingestCanonicalTranscript: requires a non-empty `turns` array (transcript kind only)');
  }

  const stmtSelectIdempotency = db.prepare<[string], { body_hash: string; summary_memory_id: string | null }>(
    'SELECT body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?',
  );
  const stmtUpsertSession = db.prepare<[string, string | null, string | null, string | null, string | null, number]>(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      repo    = COALESCE(excluded.repo, repo),
      project = COALESCE(excluded.project, project),
      agent   = COALESCE(excluded.agent, agent),
      cwd     = COALESCE(excluded.cwd, cwd)
  `);
  const stmtInsertTranscript = db.prepare<[
    string, string, string, string, number,
    string, number, number, number,
    string | null, string | null,
    string | null, string, string | null,
  ]>(`
    INSERT INTO transcripts (
      id, session_id, source, content, ingested_at,
      event, captured_at, client_scrub_applied, client_scrub_hits,
      client_scrub_version, client_scrub_hits_by_label_json,
      client_version, wire_version, capture_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertJob = db.prepare<[string, string, number, number]>(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
    VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
  `);
  const stmtInsertIdempotency = db.prepare<[string, string, string, number]>(`
    INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  const stmtCheckTranscriptExists = db.prepare<[string], { id: string } | undefined>(
    'SELECT id FROM transcripts WHERE id = ?',
  );
  const stmtCheckMemoryExists = db.prepare<[string], { id: string } | undefined>(
    'SELECT id FROM memories WHERE id = ?',
  );
  const stmtDeleteIdempotency = db.prepare<[string]>(
    'DELETE FROM ingest_idempotency WHERE key = ?',
  );

  const turns = data.turns;
  const redactionEvents: RedactionEvent[] = [];
  const redactedTurns = turns.map(turn => {
    const { text, events } = redactIfEnabled(turn.text, config);
    redactionEvents.push(...events);
    return { ...turn, text };
  });

  const bodyHash = createHash('sha256').update(stableStringify(data)).digest('hex');
  const now = Date.now();
  const capturedAtMs = new Date(data.captured_at).getTime();

  let transcriptId!: string;
  let jobId!: string;

  const tx = db.transaction(() => {
    if (idempotencyKey !== null) {
      stmtInsertIdempotency.run(idempotencyKey, bodyHash, '__pending__', now);
      const existing = stmtSelectIdempotency.get(idempotencyKey);

      if (existing && existing.summary_memory_id !== '__pending__') {
        if (existing.body_hash !== bodyHash) {
          throw new IdempotencyConflictError(idempotencyKey);
        }

        const stillExists = existing.summary_memory_id != null
          ? (stmtCheckTranscriptExists.get(existing.summary_memory_id)
              ?? stmtCheckMemoryExists.get(existing.summary_memory_id))
          : undefined;
        if (!stillExists) {
          stmtDeleteIdempotency.run(idempotencyKey);
          stmtInsertIdempotency.run(idempotencyKey, bodyHash, '__pending__', now);
        } else {
          throw new IdempotentReplayError(String(existing.summary_memory_id));
        }
      }
    }

    stmtUpsertSession.run(data.session_id, deriveRepoFromCwd(data.cwd), data.project_id, data.agent_type ?? null, data.cwd ?? null, now);

    transcriptId = randomUUID();
    stmtInsertTranscript.run(
      transcriptId,
      data.session_id,
      `claude-code-${data.event}`,
      JSON.stringify(redactedTurns),
      now,
      data.event,
      capturedAtMs,
      data.client_scrub_applied ? 1 : 0,
      data.client_scrub_hits ?? 0,
      data.client_scrub_version ?? null,
      data.client_scrub_hits_by_label != null
        ? JSON.stringify(data.client_scrub_hits_by_label)
        : null,
      data.client_version ?? null,
      data.wire_version,
      // Same schema instance runs on the HTTP route and the spool-drain
      // worker (src/ingest/spool-drain.ts) — CanonicalIngestSchema.safeParse
      // already rejected anything outside the enum above before this runs.
      data.capture_source ?? null,
    );

    recordRedactionEvents(db, redactionEvents, data.session_id);

    jobId = randomUUID();
    stmtInsertJob.run(
      jobId,
      JSON.stringify({ transcript_id: transcriptId, session_id: data.session_id }),
      now,
      now,
    );

    if (idempotencyKey !== null) {
      stmtDeleteIdempotency.run(idempotencyKey);
      stmtInsertIdempotency.run(idempotencyKey, bodyHash, transcriptId, now);
    }
  });

  tx();

  return { transcriptId, jobId, serverRedactionHits: redactionEvents.length };
}

// ---------------------------------------------------------------------------
// Route factory — prepared statements hoisted to factory scope (D-B6)
// All db.prepare() calls happen ONCE per server start, not per request.
// ---------------------------------------------------------------------------

export function ingestRoute(db: DB, config: Config = defaultConfig()) {
  // ---- Canonical path statements ----
  const stmtSelectIdempotency = db.prepare<[string], { body_hash: string; summary_memory_id: string | null }>(
    'SELECT body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?',
  );

  // cwd (FEAT-403 / migration 009) is stored so the tag-hygiene backfill can
  // still catch stragglers, but FEAT-423 also derives `repo` from it
  // synchronously here — the canonical envelope never sends `repo` directly,
  // so without this the `repo` column (and anything preferring it, e.g.
  // deriveProject) would sit NULL until the async backfill runs.
  const stmtUpsertSession = db.prepare<[string, string | null, string | null, string | null, string | null, number]>(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      repo    = COALESCE(excluded.repo, repo),
      project = COALESCE(excluded.project, project),
      agent   = COALESCE(excluded.agent, agent),
      cwd     = COALESCE(excluded.cwd, cwd)
  `);

  const stmtInsertTranscript = db.prepare<[
    string, string, string, string, number,
    string, number, number, number,
    string | null, string | null,
    string | null, string,
  ]>(`
    INSERT INTO transcripts (
      id, session_id, source, content, ingested_at,
      event, captured_at, client_scrub_applied, client_scrub_hits,
      client_scrub_version, client_scrub_hits_by_label_json,
      client_version, wire_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtInsertJob = db.prepare<[string, string, number, number]>(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
    VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
  `);

  // ADR-008 events kind — same transcripts-row shape as the transcript path
  // (reuses stmtInsertTranscript), but enqueues a distinct job kind so the
  // worker routes it to distillEventsHandler instead of distillHandler.
  const stmtInsertDistillEventsJob = db.prepare<[string, string, number, number]>(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
    VALUES (?, 'distill-events', ?, 'pending', 0, ?, ?)
  `);

  const stmtInsertIdempotency = db.prepare<[string, string, string, number]>(`
    INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);

  // Used for D-B3 dangling-row check on replay. `summary_memory_id` starts
  // out as the transcript id (placeholder, written at ingest time) and may
  // later be backfilled to a real `memories.id` once distillation completes
  // (D-DEF2, see storage/ingest-idempotency.ts) — so "does this id still
  // resolve to something" has to check both tables.
  const stmtCheckTranscriptExists = db.prepare<[string], { id: string } | undefined>(
    'SELECT id FROM transcripts WHERE id = ?',
  );
  const stmtCheckMemoryExists = db.prepare<[string], { id: string } | undefined>(
    'SELECT id FROM memories WHERE id = ?',
  );

  // Used for D-B3 invalidation of dangling idempotency row
  const stmtDeleteIdempotency = db.prepare<[string]>(
    'DELETE FROM ingest_idempotency WHERE key = ?',
  );

  // ---- Legacy path statements ----
  const stmtUpsertSessionLegacy = db.prepare<[string, string | null, string | null, string | null, string | null, number]>(`
    INSERT INTO sessions (id, repo, project, branch, agent, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      repo = COALESCE(excluded.repo, repo),
      project = COALESCE(excluded.project, project),
      branch = COALESCE(excluded.branch, branch),
      agent = COALESCE(excluded.agent, agent)
  `);

  const stmtInsertTranscriptLegacy = db.prepare<[string, string, string, string, number]>(`
    INSERT INTO transcripts (id, session_id, source, content, ingested_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const stmtInsertJobLegacy = db.prepare<[string, string, number, number]>(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
    VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
  `);

  // ---------------------------------------------------------------------
  // Shared idempotency-key handling (D-B1/D-B2/D-B3) — extracted so the
  // events-kind branch can reuse the exact same claim/replay/conflict/
  // dangling-row semantics as the transcript-kind path without duplicating
  // the logic inline. MUST be called from inside a db.transaction().
  // ---------------------------------------------------------------------

  /**
   * Attempt to claim the idempotency slot for `key`. Throws a sentinel error
   * (`_isReplay` or `_isIdempotencyConflict`) to signal the caller's
   * transaction should abort and the route should return early — mirrors
   * the inline logic in the transcript-kind path.
   */
  function claimIdempotencySlot(key: string, bodyHash: string, now: number): void {
    stmtInsertIdempotency.run(key, bodyHash, '__pending__', now);
    const existing = stmtSelectIdempotency.get(key);

    if (existing && existing.summary_memory_id !== '__pending__') {
      if (existing.body_hash !== bodyHash) {
        throw Object.assign(new Error('idempotency_conflict'), { _isIdempotencyConflict: true });
      }

      // D-B3: guard against a dangling row (summary_memory_id may point at
      // either a transcript or a backfilled memory — check both).
      const stillExists = existing.summary_memory_id != null
        ? (stmtCheckTranscriptExists.get(existing.summary_memory_id)
            ?? stmtCheckMemoryExists.get(existing.summary_memory_id))
        : undefined;
      if (!stillExists) {
        stmtDeleteIdempotency.run(key);
        stmtInsertIdempotency.run(key, bodyHash, '__pending__', now);
      } else {
        throw Object.assign(new Error('idempotent_replay'), {
          _isReplay: true,
          _replayId: existing.summary_memory_id,
        });
      }
    }
  }

  /** Update the idempotency placeholder with the real transcript id once the insert has happened. */
  function finalizeIdempotencySlot(key: string, bodyHash: string, transcriptId: string, now: number): void {
    stmtDeleteIdempotency.run(key);
    stmtInsertIdempotency.run(key, bodyHash, transcriptId, now);
  }

  return async (app: FastifyInstance) => {
    app.post('/ingest/transcript', async (req, reply) => {
      const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
      const parsed = IngestSchema.safeParse(req.body);
      if (!parsed.success) {
        const log = childLogger({ request_id: requestId ?? 'unknown' });
        log.warn({ details: parsed.error.flatten() }, 'ingest validation failed');
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }

      const data = parsed.data;

      // ------------------------------------------------------------------
      // Canonical path — real insert (FEAT-4a Phase 2 stage 3)
      // ------------------------------------------------------------------
      if (isCanonical(data)) {
        const log = childLogger({ request_id: requestId ?? 'unknown', session_id: data.session_id });

        // ------------------------------------------------------------------
        // ADR-008 events kind — pre-typed atom candidates (runner-plugin
        // grades/lessons/review verdicts). Redact, store as a transcripts
        // row, enqueue 'distill-events' (skips pipeline stages 1-5, enters
        // at reduce/stage 6 — see src/pipeline/handlers/distill-events.ts).
        // ------------------------------------------------------------------
        if (data.kind === 'events') {
          const events = data.events!; // superRefine guarantees non-empty for kind === 'events'

          // ---- Stage-0 secret redaction (SEC-3/5) applies to events too ----
          const redactionEventsForEvents: RedactionEvent[] = [];
          const redactedEvents = events.map(ev => {
            const { text, events: textRedactions } = redactIfEnabled(ev.text, config);
            redactionEventsForEvents.push(...textRedactions);
            let evidence = ev.evidence;
            if (evidence !== undefined) {
              const { text: redactedEvidence, events: evidenceRedactions } = redactIfEnabled(evidence, config);
              evidence = redactedEvidence;
              redactionEventsForEvents.push(...evidenceRedactions);
            }
            return { ...ev, text, evidence };
          });

          const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
          const bodyHash = createHash('sha256').update(stableStringify(data)).digest('hex');
          const now = Date.now();
          const capturedAtMs = new Date(data.captured_at).getTime();
          const sourceLabel = data.tool ? `${data.tool}-events` : 'events';

          let transcriptId!: string;
          let jobId!: string;

          try {
            const tx = db.transaction(() => {
              if (idempotencyKey !== null) claimIdempotencySlot(idempotencyKey, bodyHash, now);

              stmtUpsertSession.run(data.session_id, deriveRepoFromCwd(data.cwd), data.project_id, data.agent_type ?? null, data.cwd ?? null, now);

              transcriptId = randomUUID();
              stmtInsertTranscript.run(
                transcriptId,
                data.session_id,
                sourceLabel,
                JSON.stringify(redactedEvents),
                now,
                data.event,
                capturedAtMs,
                data.client_scrub_applied ? 1 : 0,
                data.client_scrub_hits ?? 0,
                data.client_scrub_version ?? null,
                data.client_scrub_hits_by_label != null
                  ? JSON.stringify(data.client_scrub_hits_by_label)
                  : null,
                data.client_version ?? null,
                data.wire_version,
              );

              // SEC-6: one redaction_log row per distinct type found in this ingest.
              recordRedactionEvents(db, redactionEventsForEvents, data.session_id);

              jobId = randomUUID();
              stmtInsertDistillEventsJob.run(
                jobId,
                JSON.stringify({ transcript_id: transcriptId, session_id: data.session_id }),
                now,
                now,
              );

              if (idempotencyKey !== null) finalizeIdempotencySlot(idempotencyKey, bodyHash, transcriptId, now);
            });

            tx();
          } catch (err) {
            const e = err as Record<string, unknown>;

            if (e['_isReplay'] === true) {
              log.info({ idempotency_key: idempotencyKey }, 'idempotent replay (events)');
              return reply.code(200).send({
                ok: true,
                summary_memory_id: e['_replayId'],
                session_id: data.session_id,
                idempotent: true,
              });
            }

            if (e['_isIdempotencyConflict'] === true) {
              log.warn({ idempotency_key: idempotencyKey }, 'idempotency key reused with different body (events)');
              return reply.code(409).send({
                error: 'idempotency_conflict',
                idempotency_key: idempotencyKey,
                detail: 'key reused with different body',
              });
            }

            if (
              typeof e['code'] === 'string' &&
              (e['code'] === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e['code'] === 'SQLITE_CONSTRAINT_UNIQUE')
            ) {
              log.warn({ idempotency_key: idempotencyKey, err: String(err) }, 'sqlite constraint on idempotency insert — treating as replay (events)');
              const existing = stmtSelectIdempotency.get(idempotencyKey ?? '');
              return reply.code(200).send({
                ok: true,
                summary_memory_id: existing?.summary_memory_id ?? null,
                session_id: data.session_id,
                idempotent: true,
              });
            }

            throw err;
          }

          log.info(
            { job_id: jobId, transcript_id: transcriptId, wire_version: data.wire_version, event: data.event, event_count: events.length, tool: data.tool ?? null },
            'events ingested, distill-events job enqueued',
          );

          // ADR-008 events kind: each event already carries its own atom
          // `type` (no LLM extraction stage — distillEventsHandler maps
          // events straight to atoms, see distill-events.ts stage 6+).
          // Queued types are therefore the exact distinct types posted,
          // in first-seen order, not the full registry.
          const queuedExtractionTypesForEvents = [...new Set(events.map(ev => ev.type))];

          return reply.code(200).send({
            ok: true,
            summary_memory_id: transcriptId,
            session_id: data.session_id,
            idempotent: false,
            extraction_job_id: jobId,
            // Extraction runs asynchronously off the job queue — not yet run
            // at response time, so these are stubbed per CHANGELOG v0.2.0.
            extracted_count: 0,
            failed_atom_count: 0,
            scrub_hits: { client: data.client_scrub_hits, server: redactionEventsForEvents.length },
            queued_extraction_types: queuedExtractionTypesForEvents,
          });
        }

        // ---- Idempotency-key handling ----
        // D-B1: ingestCanonicalTranscript uses stableStringify on the
        //        Zod-parsed object so key order differences between clients
        //        don't produce different body hashes.
        const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;

        // D-B2/D-B3/FEAT-449: the claim -> insert -> finalize sequence (and
        // the dangling-row / replay / conflict semantics) now live in the
        // shared ingestCanonicalTranscript — this route is a thin wrapper
        // that maps its result or thrown sentinel error to an HTTP response.
        try {
          const result = ingestCanonicalTranscript(db, config, data, idempotencyKey);

          log.info(
            { job_id: result.jobId, transcript_id: result.transcriptId, wire_version: data.wire_version, event: data.event },
            'canonical transcript ingested, distill job enqueued',
          );

          return reply.code(200).send({
            ok: true,
            summary_memory_id: result.transcriptId,
            session_id: data.session_id,
            idempotent: false,
            extraction_job_id: result.jobId,
            // Extraction runs asynchronously off the job queue (distillHandler,
            // stages 4-5 LLM extraction) — not yet run at response time, so
            // these are stubbed per CHANGELOG v0.2.0 ("full job queue in
            // v0.3.0+"). Not fabricated: the real values genuinely don't
            // exist yet when this response is built.
            extracted_count: 0,
            failed_atom_count: 0,
            scrub_hits: { client: data.client_scrub_hits, server: result.serverRedactionHits },
            // Full LLM extraction hasn't run yet, so which types will actually
            // be produced is unknown — report the full candidate registry the
            // distill pipeline can emit (see ALL_ATOM_TYPES above).
            queued_extraction_types: ALL_ATOM_TYPES,
          });
        } catch (err) {
          if (err instanceof IdempotentReplayError) {
            log.info({ idempotency_key: idempotencyKey }, 'idempotent replay');
            return reply.code(200).send({
              ok: true,
              summary_memory_id: err.replayId,
              session_id: data.session_id,
              idempotent: true,
            });
          }

          if (err instanceof IdempotencyConflictError) {
            log.warn({ idempotency_key: idempotencyKey }, 'idempotency key reused with different body');
            return reply.code(409).send({
              error: 'idempotency_conflict',
              idempotency_key: idempotencyKey,
              detail: 'key reused with different body',
            });
          }

          // Belt-and-suspenders: catch SQLite UNIQUE constraint errors that
          // weren't handled by ON CONFLICT DO NOTHING (shouldn't happen, but
          // guard just in case).
          const e = err as Record<string, unknown>;
          if (
            typeof e['code'] === 'string' &&
            (e['code'] === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e['code'] === 'SQLITE_CONSTRAINT_UNIQUE')
          ) {
            log.warn({ idempotency_key: idempotencyKey, err: String(err) }, 'sqlite constraint on idempotency insert — treating as replay');
            const existing = stmtSelectIdempotency.get(idempotencyKey ?? '');
            return reply.code(200).send({
              ok: true,
              summary_memory_id: existing?.summary_memory_id ?? null,
              session_id: data.session_id,
              idempotent: true,
            });
          }

          throw err;
        }
      }

      // ------------------------------------------------------------------
      // Legacy path — unchanged insert logic, plus stage-0 redaction (SEC-3/5)
      // ------------------------------------------------------------------
      const { session_id, source, content, repo, project, branch, agent } = data;
      const now = Date.now();

      const { text: redactedContent, events: redactionEventsLegacy } = redactIfEnabled(content, config);

      let transcriptId!: string;
      let jobId!: string;

      const tx = db.transaction(() => {
        stmtUpsertSessionLegacy.run(session_id, repo ?? null, project ?? null, branch ?? null, agent ?? null, now);

        transcriptId = randomUUID();
        stmtInsertTranscriptLegacy.run(transcriptId, session_id, source, redactedContent, now);

        // SEC-6: one redaction_log row per distinct type found in this ingest.
        recordRedactionEvents(db, redactionEventsLegacy, session_id);

        jobId = randomUUID();
        stmtInsertJobLegacy.run(
          jobId,
          JSON.stringify({ transcript_id: transcriptId, session_id }),
          now,
          now,
        );
      });
      tx();

      // Bind session_id + transcript_id to log context for this ingest
      const log = childLogger({
        request_id: requestId ?? 'unknown',
        session_id,
        transcript_id: transcriptId,
      });
      log.info({ job_id: jobId, source }, 'transcript ingested, distill job enqueued');

      return { ok: true };
    });
  };
}
