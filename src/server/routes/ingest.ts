import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { childLogger } from '../../log/logger.js';

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

export const CanonicalIngestSchema = z.object({
  event: z.enum(['pre_compact', 'session_end', 'subagent_stop']),
  session_id: z.string(),
  project_id: z.string(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
  captured_at: z.string(), // ISO-8601
  turns: z.array(TranscriptTurnSchema).min(1),
  /** @deprecated use client_scrub_version + client_scrub_hits_by_label */
  client_scrub_applied: z.boolean(),
  /** @deprecated use client_scrub_hits_by_label sum */
  client_scrub_hits: z.number().int().nonnegative(),
  client_version: z.string(),
  client_scrub_version: z.string(),
  client_scrub_hits_by_label: z.record(z.string(), z.number().int().nonnegative()).optional(),
  /** Wire protocol version — must match ^v\d+\.\d+$ (e.g. "v1.0"). */
  wire_version: z.string().regex(/^v\d+\.\d+$/, 'wire_version must match ^v\\d+\\.\\d+$ (e.g. "v1.0")'),
});

// ---------------------------------------------------------------------------
// Combined schema — canonical tried first (has `turns`), legacy as fallback
// ---------------------------------------------------------------------------

const IngestSchema = z.union([CanonicalIngestSchema, LegacyIngestSchema]);

type ParsedIngest = z.infer<typeof IngestSchema>;

function isCanonical(data: ParsedIngest): data is z.infer<typeof CanonicalIngestSchema> {
  return 'turns' in data;
}

export function ingestRoute(db: DB) {
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
      // Canonical path — Stage 3 will wire the insert; return stub for now
      // so tests can assert that validation passes in isolation.
      // ------------------------------------------------------------------
      if (isCanonical(data)) {
        const log = childLogger({ request_id: requestId ?? 'unknown', session_id: data.session_id });
        log.info({ wire_version: data.wire_version, event: data.event }, 'canonical envelope accepted (stage-3 insert pending)');
        return reply.code(200).send({ ok: true, stage: 'schema-only-stub' });
      }

      // ------------------------------------------------------------------
      // Legacy path — unchanged insert logic
      // ------------------------------------------------------------------
      const { session_id, source, content, repo, project, branch, agent } = data;
      const now = Date.now();

      let transcriptId!: string;
      let jobId!: string;

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO sessions (id, repo, project, branch, agent, started_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            repo = COALESCE(excluded.repo, repo),
            project = COALESCE(excluded.project, project),
            branch = COALESCE(excluded.branch, branch),
            agent = COALESCE(excluded.agent, agent)
        `).run(session_id, repo ?? null, project ?? null, branch ?? null, agent ?? null, now);

        transcriptId = randomUUID();
        db.prepare(`
          INSERT INTO transcripts (id, session_id, source, content, ingested_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(transcriptId, session_id, source, content, now);

        jobId = randomUUID();
        db.prepare(`
          INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
          VALUES (?, 'distill', ?, 'pending', 0, ?, ?)
        `).run(jobId, JSON.stringify({ transcript_id: transcriptId, session_id }), now, now);
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
