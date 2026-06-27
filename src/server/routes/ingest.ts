import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { childLogger } from '../../log/logger.js';

const IngestSchema = z.object({
  session_id: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1),
  repo: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  agent: z.string().nullable().optional()
});

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
      const { session_id, source, content, repo, project, branch, agent } = parsed.data;
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
