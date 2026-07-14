/**
 * tests/e2e/evidence-transcript-session-canary.e2e.test.ts — FEAT-485
 * acceptance gate.
 *
 * Live-store audit (2026-07-13): sampled 10 recent memories from the
 * operator's real store — evidence excerpt present in 1/10, transcript_ref
 * (`memories.source_hash`, surfaced via why_memory) present in 0/10, session
 * (repo/branch/agent/session_id) present in 0/10. Root cause (this FEAT):
 * NOT a regression in the transcript-ingest/distill pipeline — tracing
 * hook-built envelopes -> POST /ingest/transcript -> distillHandler ->
 * PipelineContext -> embedAndIndex shows session_id/source_hash are threaded
 * correctly end to end (see src/pipeline/handlers/distill.ts,
 * src/distill/stages/08-embed-index.ts). What lacks both fields, always, by
 * design: the `remember` MCP tool and the memory-tool adapter (direct-insert
 * paths with no transcript context — ADR-009 "born-at-scope").
 *
 * This test is the "built, wired, never invoked" guard the FEAT explicitly
 * requires: it does not merely assert the DB columns exist (schema-shape
 * only would pass even if the pipeline never actually populated them) — it
 * drives a REAL transcript through the REAL canonical `/ingest/transcript`
 * -> distill job -> pipeline path (mock LLM/embed providers so it needs no
 * live Ollama, same convention as tests/e2e/plugin-flow.test.ts) and then
 * reads the resulting `memories` + `sessions` rows directly, asserting:
 *   1. `evidence` is a non-empty excerpt (not merely NOT NULL).
 *   2. `source_hash` (the why_memory `transcript_ref` field) is present and
 *      resolvable to the real ingested transcript's content hash — not just
 *      non-null.
 *   3. `session_id` resolves to a real `sessions` row carrying the repo/
 *      project/agent this envelope declared.
 *
 * Uses the `sqlite-vec` mock-extraction-vocab rule (src/pipeline/
 * mock-extraction-vocab.ts), which is the ONE rule that already emits a
 * non-empty `evidence` string alongside its `decision` atom — chosen
 * deliberately so this canary can fail on a REAL regression in the
 * evidence/session/transcript_ref threading without needing a live Ollama
 * call (the mock model's evidence compliance is fixed and deterministic;
 * a real-model compliance measurement is a separate concern, see
 * scripts/eval/extraction-bench/measure-evidence.mts).
 *
 * Isolated daemon (makeIsolatedDaemonEnv) — never touches port 7777,
 * %LOCALAPPDATA%\Astramem, or the operator's real config/keystore.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  spawnDaemon,
  killDaemon,
  waitForHealthReachable,
  pollSearchHits,
  makeIsolatedDaemonEnv,
  cleanupIsolatedDaemonEnv,
  type DaemonHandle,
  type IsolatedDaemonEnv,
} from '../smoke/helpers/daemon.js';
import { openDb } from '../../src/storage/db.js';

const TOKEN = `e2etok-evidence-canary-${randomUUID()}`;

describe('Evidence + transcript_ref + session canary (FEAT-485 acceptance gate)', () => {
  let daemon: DaemonHandle | null = null;
  let isolated: IsolatedDaemonEnv | null = null;

  afterAll(async () => {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 3_000);
    if (isolated) cleanupIsolatedDaemonEnv(isolated);
  });

  it(
    'a real transcript ingested through /ingest/transcript -> distill produces a memory with evidence, a resolvable transcript_ref, and a resolvable session',
    async () => {
      isolated = makeIsolatedDaemonEnv('evidence-canary');

      daemon = await spawnDaemon({ port: 0, token: TOKEN, env: isolated.env });
      daemon.proc.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[daemon] ${chunk.toString()}`);
      });
      await waitForHealthReachable(daemon.baseUrl);
      expect(daemon.exitInfo().code, 'daemon should still be running').toBeNull();

      // ── Canonical envelope, same shape buildClaudeEnvelope produces ────────
      const sessionId = `e2e-evidence-canary-${randomUUID().slice(0, 8)}`;
      const turns = [
        { role: 'user' as const, text: 'What vector store should we use for v1?' },
        { role: 'assistant' as const, text: 'Use sqlite-vec for v1 vector storage — no network dependency.' },
      ];
      const envelope = {
        event: 'session_end' as const,
        session_id: sessionId,
        project_id: 'astramemory-local',
        agent_type: 'claude-code',
        cwd: '/home/u/proj-evidence-canary',
        captured_at: new Date().toISOString(),
        kind: 'transcript' as const,
        tool: 'claude-code',
        turns,
        client_scrub_applied: false,
        client_scrub_hits: 0,
        client_version: 'test-canary',
        client_scrub_version: 'none',
        wire_version: 'v1.0',
      };

      const ingestRes = await fetch(`${daemon.baseUrl}/ingest/transcript`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      expect(ingestRes.status, 'ingest should return 200').toBe(200);
      const ingestBody = await ingestRes.json() as { ok: boolean };
      expect(ingestBody.ok).toBe(true);

      // ── Wait for distill to turn this into a searchable 'decision' memory ──
      const hits = await pollSearchHits(
        daemon.baseUrl,
        TOKEN,
        'sqlite',
        found => found.filter(h => h.type === 'decision' && h.text.toLowerCase().includes('sqlite-vec')),
        {
          label: `GET ${daemon.baseUrl}/search?q=sqlite to return a decision memory containing 'sqlite-vec'`,
          timeoutMs: 30_000,
        },
      );
      expect(hits.length).toBeGreaterThan(0);

      // ── Stop the daemon before touching its sqlite file directly ──────────
      await killDaemon(daemon, 'SIGTERM', 3_000);
      daemon = null;

      const dbPath = join(isolated.dataDir, 'memory.sqlite');
      const db = openDb(dbPath);

      const memory = db
        .prepare(
          `SELECT id, type, text, evidence, source_hash, session_id
             FROM memories
            WHERE type = 'decision' AND text LIKE '%sqlite-vec%' AND valid_to IS NULL`,
        )
        .get() as
        | { id: string; type: string; text: string; evidence: string | null; source_hash: string | null; session_id: string | null }
        | undefined;
      expect(memory, 'expected the distilled sqlite-vec decision memory to exist').toBeDefined();

      // 1. Evidence — a non-empty excerpt, not merely a non-null placeholder.
      expect(memory!.evidence, 'evidence must be a non-empty excerpt').toBeTruthy();
      expect(memory!.evidence!.trim().length).toBeGreaterThan(0);

      // 2. transcript_ref (source_hash) — present AND resolvable: recomputing
      //    the sha256 of the ACTUAL ingested transcript content must match,
      //    proving this is a real content-derived reference to the transcript
      //    this test posted, not a null/placeholder/unrelated value.
      expect(memory!.source_hash, 'transcript_ref (source_hash) must be populated').toBeTruthy();
      const transcriptRow = db
        .prepare(`SELECT content FROM transcripts WHERE session_id = ?`)
        .get(sessionId) as { content: string } | undefined;
      expect(transcriptRow, 'expected a transcripts row for this session').toBeDefined();
      const expectedHash = createHash('sha256').update(transcriptRow!.content, 'utf8').digest('hex');
      expect(memory!.source_hash).toBe(expectedHash);

      // 3. session — resolvable to a real sessions row carrying the envelope's
      //    declared repo/project/agent, not merely a non-null id.
      expect(memory!.session_id, 'session_id must be populated').toBe(sessionId);
      const session = db
        .prepare(`SELECT id, repo, project, agent FROM sessions WHERE id = ?`)
        .get(sessionId) as { id: string; repo: string | null; project: string | null; agent: string | null } | undefined;
      expect(session, 'session_id must resolve to a real sessions row').toBeDefined();
      expect(session!.project).toBe('astramemory-local');
      expect(session!.agent).toBe('claude-code');

      db.close();
    },
    60_000,
  );
});
