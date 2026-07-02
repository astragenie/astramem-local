import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { childLogger } from '../../log/logger.js';
import { stableStringify } from '../lib/stable-stringify.js';
import { type Config, defaultConfig } from '../../config/config.js';
import { redactIfEnabled, type RedactionEvent } from '../../redact/index.js';
import { recordRedactionEvents } from '../../storage/redaction-log.js';

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
  /** Aggregate scrub flag — required; still consumed for telemetry. Superseded by client_scrub_hits_by_label for per-label breakdown but not deprecated. */
  client_scrub_applied: z.boolean(),
  /** Aggregate scrub hit count — required; still consumed for telemetry. Superseded by client_scrub_hits_by_label sum for per-label breakdown but not deprecated. */
  client_scrub_hits: z.number().int().nonnegative(),
  client_version: z.string(),
  client_scrub_version: z.string(),
  client_scrub_hits_by_label: z.record(z.string(), z.number().int().nonnegative()).optional(),
  // Regex mirrors SaaS IngestTranscriptRequest.cs:65 per FEAT-4a Phase 3 alignment.
  /** Wire protocol version — must match ^v(?:0|[1-9][0-9]*)\.[0-9]+$ (e.g. "v1.0"). */
  wire_version: z.string().regex(/^v(?:0|[1-9][0-9]*)\.[0-9]+$/, 'wire_version must match ^v(?:0|[1-9][0-9]*)\\.[0-9]+$ (e.g. "v1.0")'),
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
// Route factory — prepared statements hoisted to factory scope (D-B6)
// All db.prepare() calls happen ONCE per server start, not per request.
// ---------------------------------------------------------------------------

export function ingestRoute(db: DB, config: Config = defaultConfig()) {
  // ---- Canonical path statements ----
  const stmtSelectIdempotency = db.prepare<[string], { body_hash: string; summary_memory_id: string | null }>(
    'SELECT body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?',
  );

  const stmtUpsertSession = db.prepare<[string, string | null, string | null, number]>(`
    INSERT INTO sessions (id, repo, project, branch, agent, started_at)
    VALUES (?, NULL, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = COALESCE(excluded.project, project),
      agent   = COALESCE(excluded.agent, agent)
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

              stmtUpsertSession.run(data.session_id, data.project_id, data.agent_type ?? null, now);

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

          return reply.code(200).send({
            ok: true,
            summary_memory_id: transcriptId,
            session_id: data.session_id,
            idempotent: false,
          });
        }

        // ---- Stage-0 secret redaction (SEC-3/5) — BEFORE the transcripts INSERT.
        //      Downstream pipeline stages inherit the redacted turns.
        const turns = data.turns!; // superRefine guarantees non-empty when kind !== 'events'
        const redactionEvents: RedactionEvent[] = [];
        const redactedTurns = turns.map(turn => {
          const { text, events } = redactIfEnabled(turn.text, config);
          redactionEvents.push(...events);
          return { ...turn, text };
        });

        // ---- Idempotency-key handling ----
        // D-B1: use stableStringify on the Zod-parsed object so key order
        //        differences between clients don't produce different hashes.
        const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
        const bodyHash = createHash('sha256').update(stableStringify(data)).digest('hex');

        const now = Date.now();
        const capturedAtMs = new Date(data.captured_at).getTime();

        let transcriptId!: string;
        let jobId!: string;

        // D-B2: move idempotency SELECT inside the transaction and use
        //        INSERT … ON CONFLICT DO NOTHING to make concurrent posts safe.
        //        The UNIQUE constraint can no longer leak a 500 to the caller.
        try {
          const tx = db.transaction(() => {
            // --- Idempotency check (inside transaction — race-safe) ---
            if (idempotencyKey !== null) {
              // Attempt to claim the idempotency slot atomically.
              // stmtInsertIdempotency uses ON CONFLICT DO NOTHING, so concurrent
              // posts with the same key will silently no-op; we then read back
              // the winner row and either replay or conflict.
              stmtInsertIdempotency.run(idempotencyKey, bodyHash, '__pending__', now);

              // Read the winner row (may have been written by a concurrent request)
              const existing = stmtSelectIdempotency.get(idempotencyKey);

              if (existing && existing.summary_memory_id !== '__pending__') {
                // Another request already completed this key
                if (existing.body_hash !== bodyHash) {
                  // Different body — conflict (throw so tx rolls back the DO NOTHING insert)
                  throw Object.assign(new Error('idempotency_conflict'), { _isIdempotencyConflict: true });
                }

                // D-B3: guard against a dangling row. summary_memory_id may
                // point at either a transcript (pre-distillation) or a
                // memory (post-D-DEF2-backfill) — check both.
                const transcriptExists = existing.summary_memory_id != null
                  ? (stmtCheckTranscriptExists.get(existing.summary_memory_id)
                      ?? stmtCheckMemoryExists.get(existing.summary_memory_id))
                  : undefined;
                if (!transcriptExists) {
                  // Dangling row — invalidate and fall through to fresh insert
                  stmtDeleteIdempotency.run(idempotencyKey);
                  // Re-insert placeholder so the fresh insert below can update it
                  stmtInsertIdempotency.run(idempotencyKey, bodyHash, '__pending__', now);
                } else {
                  // Valid replay — signal via special throw to exit tx and return early
                  throw Object.assign(new Error('idempotent_replay'), {
                    _isReplay: true,
                    _replayId: existing.summary_memory_id,
                  });
                }
              }
            }

            // --- Real insert ---
            stmtUpsertSession.run(data.session_id, data.project_id, data.agent_type ?? null, now);

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
            );

            // SEC-6: one redaction_log row per distinct type found in this ingest.
            recordRedactionEvents(db, redactionEvents, data.session_id);

            jobId = randomUUID();
            stmtInsertJob.run(
              jobId,
              JSON.stringify({ transcript_id: transcriptId, session_id: data.session_id }),
              now,
              now,
            );

            // Update the idempotency placeholder with the real transcript id
            if (idempotencyKey !== null) {
              stmtDeleteIdempotency.run(idempotencyKey);
              stmtInsertIdempotency.run(idempotencyKey, bodyHash, transcriptId, now);
            }
          });

          tx();
        } catch (err) {
          // Belt-and-suspenders: catch SQLite UNIQUE constraint errors that
          // weren't handled by ON CONFLICT DO NOTHING (shouldn't happen, but
          // guard just in case).
          const e = err as Record<string, unknown>;

          if (e['_isReplay'] === true) {
            log.info({ idempotency_key: idempotencyKey }, 'idempotent replay');
            return reply.code(200).send({
              ok: true,
              summary_memory_id: e['_replayId'],
              session_id: data.session_id,
              idempotent: true,
            });
          }

          if (e['_isIdempotencyConflict'] === true) {
            log.warn({ idempotency_key: idempotencyKey }, 'idempotency key reused with different body');
            return reply.code(409).send({
              error: 'idempotency_conflict',
              idempotency_key: idempotencyKey,
              detail: 'key reused with different body',
            });
          }

          // SQLite UNIQUE constraint (belt+suspenders)
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

        log.info(
          { job_id: jobId, transcript_id: transcriptId, wire_version: data.wire_version, event: data.event },
          'canonical transcript ingested, distill job enqueued',
        );

        return reply.code(200).send({
          ok: true,
          summary_memory_id: transcriptId,
          session_id: data.session_id,
          idempotent: false,
        });
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
