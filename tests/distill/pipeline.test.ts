import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { runPipeline, BudgetExceeded } from '../../src/distill/pipeline.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { EntityRelationRepo } from '../../src/storage/entity-relations.js';
import type { LLMProvider, EmbedProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth, EmbedHealth } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';

const FIXTURE_TRANSCRIPT = `user: what vector store should we use for v1?
assistant: I recommend using sqlite-vec for v1. It bundles well with better-sqlite3 and avoids network dependencies.
user: why not pgvector?
assistant: We decided against PostgreSQL because it adds a service dependency. sqlite-vec keeps the stack single-process. This is a key architecture decision.
user: ok, and the port?
assistant: The default port is 7777. It avoids conflicts with common dev tools on 3000/8080.
user: what is the embedding dimension?
assistant: We pin the dimension at 1024 system-wide. Both nomic-embed-text-v2-moe (Ollama) and text-embedding-3-small (Azure) support exactly 1024 dimensions.
user: any lessons learned today?
assistant: Yes — Bun does not support better-sqlite3 on Windows without the prebuilt binaries. Always check the CI matrix first.
user: thanks
assistant: Happy to help. The sqlite-vec decision is locked for v1.`;

const EXTRACTION_RESPONSE = JSON.stringify({
  atoms: [
    {
      type: 'decision',
      text: 'use sqlite-vec for vector storage in v1',
      importance: 0.9,
      confidence: 0.9,
      evidence: 'We decided to use sqlite-vec'
    },
    {
      type: 'fact',
      text: 'default daemon port is 7777',
      importance: 0.6,
      confidence: 0.95
    },
    {
      type: 'lesson',
      text: 'Bun does not support better-sqlite3 on Windows without prebuilt binaries',
      importance: 0.8,
      confidence: 0.85
    }
  ]
});

function makeMockLLM(compactionReply = 'compressed content', extractionReply = EXTRACTION_RESPONSE): LLMProvider {
  let callCount = 0;
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
      callCount++;
      // Extract calls use json:true, compact calls don't
      const reply = opts?.json ? extractionReply : compactionReply;
      return { text: reply, usage: { in: 100, out: 50, usd: 0 } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

function makeMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'test-embed',
    dim: 1024 as const,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => {
        const v = new Float32Array(1024);
        for (let j = 0; j < 1024; j++) v[j] = Math.sin(i + j * 0.01);
        return v;
      });
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-embed', dim: 1024 };
    },
  };
}

describe('runPipeline', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('runs all 8 stages and creates at least 1 memory', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db,
      llmCompaction: llm,
      llmExtraction: llm,
      embed,
      capUsd: 10.0,
      sessionId: null,
      repo: 'astramemory-local',
      project: null,
      branch: null,
      agent: null,
      sourceHash: null,
    });

    expect(result.memoriesCreated).toBeGreaterThanOrEqual(1);
    expect(result.chunksProcessed).toBeGreaterThanOrEqual(1);
    expect(result.atomsExtracted).toBeGreaterThanOrEqual(1);
  });

  it('fixture transcript yields at least one decision atom about sqlite-vec', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    // Check that at least one memory of type 'decision' exists
    const decisions = db.prepare("SELECT * FROM memories WHERE type = 'decision'").all() as any[];
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const texts = decisions.map((d: any) => d.text.toLowerCase()).join(' ');
    expect(texts).toContain('sqlite-vec');
  });

  it('is idempotent — second run with same sourceHash creates no new memories', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();
    const ctx = {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null,
      sourceHash: 'fixed-source-hash',
    };

    const r1 = await runPipeline(FIXTURE_TRANSCRIPT, ctx);
    const r2 = await runPipeline(FIXTURE_TRANSCRIPT, ctx);

    expect(r1.memoriesCreated).toBeGreaterThan(0);
    // Second run: all memories are deduped (same hash)
    expect(r2.memoriesCreated).toBe(0);
    expect(r2.memoriesDeduped).toBe(r1.memoriesCreated);
  });

  it('throws BudgetExceeded when cap is 0', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    await expect(
      runPipeline(FIXTURE_TRANSCRIPT, {
        db, llmCompaction: llm, llmExtraction: llm, embed,
        capUsd: 0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      }),
    ).rejects.toThrow(BudgetExceeded);
  });

  it('handles empty transcript gracefully', async () => {
    const llm = makeMockLLM('', JSON.stringify({ atoms: [] }));
    const embed = makeMockEmbed();

    const result = await runPipeline('', {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    expect(result.memoriesCreated).toBe(0);
  });

  it('embeds created memories with provider metadata', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: 'test-repo', project: null, branch: null, agent: null, sourceHash: null,
    });

    const mems = db.prepare('SELECT * FROM memories').all() as any[];
    for (const m of mems) {
      expect(m.embedding_provider).toBe('ollama');
      expect(m.embedding_model).toBe('test-embed');
      expect(m.embedding_dim).toBe(1024);
    }
  });

  // FEAT-481 SLICE-430 AC-12/AC-13: end-to-end through the real pipeline —
  // a valid relation lands in entity_relations, and a same-run dropped
  // triple (hallucinated endpoint) is tallied into relation_guard_drops so
  // the doctor canary can see it. Exercises the aggregation path in
  // pipeline.ts (per-chunk relationDropCounts -> one recordRelationGuardDrops
  // call per run), not just the stage-5 unit-level filter.
  it('persists a valid relation to entity_relations and tallies a dropped triple into relation_guard_drops', async () => {
    const relationExtraction = JSON.stringify({
      atoms: [
        {
          type: 'decision',
          text: 'astramemory-local uses SQLite for storage',
          importance: 0.9,
          confidence: 0.9,
          // FEAT-485: decision atoms require non-empty evidence — these
          // fixtures test relations[] aggregation, not evidence policy.
          evidence: 'astramemory-local uses SQLite for storage',
          entities: [
            { name: 'astramemory-local', kind: 'project' },
            { name: 'SQLite', kind: 'tech' },
          ],
          relations: [
            { subject: 'astramemory-local', predicate: 'uses', object: 'SQLite' },
            // hallucinated endpoint — never listed in this atom's entities[]
            { subject: 'astramemory-local', predicate: 'uses', object: 'MongoDB' },
          ],
        },
      ],
    });
    const llm = makeMockLLM('compressed', relationExtraction);
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    const relations = db.prepare('SELECT * FROM entity_relations').all() as any[];
    expect(relations.length).toBeGreaterThanOrEqual(1);
    expect(relations.some(r => r.predicate === 'uses')).toBe(true);

    const drops = db.prepare('SELECT reason, count FROM relation_guard_drops').all() as any[];
    expect(drops.some(d => d.reason === 'no_hallucination_guard' && d.count >= 1)).toBe(true);
  });

  // FEAT-481 SLICE-430 (review fix, MEDIUM): the guard-drop counter write
  // (recordRelationGuardDrops, called from pipeline.ts after stage 5) is a
  // DIAGNOSTIC write, not part of extraction's success/failure contract.
  // Dropping relation_guard_drops out from under it forces the write to
  // throw (real "table not found" SqliteError, not a mock) — proves the
  // pipeline's own try/catch around that call swallows it and the run still
  // completes with the real relation persisted, instead of the failure
  // being reinterpreted as an extract-stage failure that discards an
  // already-successful extraction and forces a job retry.
  it('a relation_guard_drops write failure does not fail the pipeline — atoms and relations still persist', async () => {
    db.exec('DROP TABLE relation_guard_drops');

    const relationExtraction = JSON.stringify({
      atoms: [
        {
          type: 'decision',
          text: 'astramemory-local uses SQLite for storage',
          importance: 0.9,
          confidence: 0.9,
          // FEAT-485: decision atoms require non-empty evidence — these
          // fixtures test relations[] aggregation, not evidence policy.
          evidence: 'astramemory-local uses SQLite for storage',
          entities: [
            { name: 'astramemory-local', kind: 'project' },
            { name: 'SQLite', kind: 'tech' },
          ],
          relations: [
            { subject: 'astramemory-local', predicate: 'uses', object: 'SQLite' },
            // hallucinated endpoint — drives a non-empty relationDropCounts,
            // so recordRelationGuardDrops is actually called (and throws,
            // since the table is gone) rather than short-circuiting on {}.
            { subject: 'astramemory-local', predicate: 'uses', object: 'MongoDB' },
          ],
        },
      ],
    });
    const llm = makeMockLLM('compressed', relationExtraction);
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    expect(result.memoriesCreated).toBeGreaterThanOrEqual(1);

    const relations = db.prepare('SELECT * FROM entity_relations').all() as any[];
    expect(relations.length).toBeGreaterThanOrEqual(1);
    expect(relations.some(r => r.predicate === 'uses' && r.object_entity_id)).toBe(true);
  });

  // FEAT-481 SLICE-430 AC-13 fixture (2): as_of-excluded relation, at the
  // fixture level — a real memory produced by the real distillation pipeline
  // (not hand-inserted via the repo, unlike the SLICE-1/SLICE-3-era unit and
  // MCP conformance tests), then invalidated via the real event-sourced
  // lifecycle op. Mirrors tests/mcp/entity-relations-conformance.test.ts's
  // "asOf excludes..." case one layer down the stack.
  it('a relation produced by the pipeline stops reading as valid once its evidence memory is invalidated (as_of-excluded, AC-13 fixture 2)', async () => {
    const relationExtraction = JSON.stringify({
      atoms: [
        {
          type: 'fact',
          text: 'astramemory-local uses SQLite for storage',
          importance: 0.9,
          confidence: 0.9,
          entities: [
            { name: 'astramemory-local', kind: 'project' },
            { name: 'SQLite', kind: 'tech' },
          ],
          relations: [{ subject: 'astramemory-local', predicate: 'uses', object: 'SQLite' }],
        },
      ],
    });
    const llm = makeMockLLM('compressed', relationExtraction);
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    const relationRepo = new EntityRelationRepo(db);
    const entityRepo = new EntityRepo(db);
    // upsert() is idempotent (FEAT-402) — resolves the same id the pipeline
    // already created for this name via the shared normalizeEntityName seam,
    // rather than inserting a duplicate.
    const subjId = entityRepo.upsert('astramemory-local', 'project');
    const memoryRow = db.prepare(
      "SELECT id FROM memories WHERE text = 'astramemory-local uses SQLite for storage'",
    ).get() as { id: string };

    // Sanity: currently valid before invalidation.
    expect(relationRepo.getForSubject(subjId, { asOf: Date.now() + 10_000 })).toHaveLength(1);

    const events = new MemoryEventRepo(db);
    events.invalidate(memoryRow.id);
    const invalidated = db.prepare('SELECT valid_to FROM memories WHERE id = ?').get(memoryRow.id) as { valid_to: number };
    expect(invalidated.valid_to).not.toBeNull();

    // entity_relations.valid_to itself is untouched — exclusion comes from the JOIN (design doc §4.1).
    const relRow = db.prepare('SELECT valid_to FROM entity_relations WHERE evidence_memory_id = ?').get(memoryRow.id) as { valid_to: number | null };
    expect(relRow.valid_to).toBeNull();

    const afterInvalidate = relationRepo.getForSubject(subjId, { asOf: invalidated.valid_to + 10_000 });
    expect(afterInvalidate).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sessionDateIso — capturedAtLocalDate precedence (2026-07-13 timezone-offset
// fix)
//
// Root cause: the original temporal-grounding fix (#189) derived the stage-5
// extraction anchor via `new Date(capturedAtMs).toISOString().slice(0, 10)`
// — capturedAtMs is a bare epoch with no timezone information, so this
// always yielded the UTC calendar date. A user in UTC-8 capturing at 21:00
// local is at 05:00 UTC the NEXT day, so "yesterday" in that session
// resolved one day off. capturedAtLocalDate (plumbed from the transcripts
// row's new captured_at_local_date column) carries the user's TRUE local
// calendar date and is now preferred whenever present; the UTC-derived
// computation survives only as a fallback for capturedAtMs-only rows (from
// before this fix).
// ---------------------------------------------------------------------------

describe('sessionDateIso — capturedAtLocalDate precedence (2026-07-13 timezone-offset fix)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  /** Captures every user message sent to the extraction (json:true) call —
   *  compaction calls are answered separately and ignored here, mirroring
   *  makeMockLLM's own json-flag branch above. */
  function makeCapturingLLM(): { llm: LLMProvider; extractUserMessages: string[] } {
    const extractUserMessages: string[] = [];
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        if (opts?.json) {
          extractUserMessages.push(msgs.find((m) => m.role === 'user')?.content ?? '');
          return { text: EXTRACTION_RESPONSE, usage: { in: 100, out: 50, usd: 0 } };
        }
        return { text: 'compressed content', usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    return { llm, extractUserMessages };
  }

  it('AC-4a: prefers capturedAtLocalDate over the UTC-derived date from capturedAtMs', async () => {
    const { llm, extractUserMessages } = makeCapturingLLM();
    const embed = makeMockEmbed();

    // The exact bug scenario: 21:00 local on 2026-07-13 in UTC-8 is 05:00 UTC
    // on 2026-07-14 — capturedAtMs alone names the WRONG (UTC) calendar date.
    const capturedAtMs = new Date('2026-07-14T05:00:00.000Z').getTime();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      capturedAtMs,
      capturedAtLocalDate: '2026-07-13',
    });

    expect(extractUserMessages.length).toBeGreaterThan(0);
    for (const msg of extractUserMessages) {
      expect(msg).toMatch(/^Observation date: 2026-07-13\n\n/);
    }
  });

  it('AC-3/AC-4b: falls back to the UTC-derived-from-epoch date when capturedAtLocalDate is null (a row from before this fix)', async () => {
    const { llm, extractUserMessages } = makeCapturingLLM();
    const embed = makeMockEmbed();
    const capturedAtMs = new Date('2026-07-14T05:00:00.000Z').getTime();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      capturedAtMs,
      capturedAtLocalDate: null,
    });

    expect(extractUserMessages.length).toBeGreaterThan(0);
    for (const msg of extractUserMessages) {
      // The old (pre-timezone-fix) fallback behavior — not the correct local
      // date, but a documented, non-crashing degrade for legacy rows.
      expect(msg).toMatch(/^Observation date: 2026-07-14\n\n/);
    }
  });

  it('AC-4c: no anchor at all when both fields are omitted — byte-identical to pre-fix behavior', async () => {
    const { llm, extractUserMessages } = makeCapturingLLM();
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    expect(extractUserMessages.length).toBeGreaterThan(0);
    for (const msg of extractUserMessages) {
      expect(msg).not.toMatch(/Observation date/);
    }
  });
});
