import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { runPipeline, BudgetExceeded } from '../../src/distill/pipeline.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { EntityRelationRepo } from '../../src/storage/entity-relations.js';
import { defaultConfig } from '../../src/config/config.js';
import { EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER } from '../../src/distill/prompts/extract.js';
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
      confidence: 0.85,
      // FEAT-485: lesson atoms require non-empty evidence or the extract-stage
      // provenance guard drops them; this fixture exercises the full 3-atom
      // pass-A flow, not evidence policy.
      evidence: 'Bun does not support better-sqlite3 on Windows without prebuilt binaries'
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

  // ADR-015 headline finding: a well-formed `{"atoms":[]}` extraction
  // completes as SUCCESS at every other layer, so a broken model and a
  // genuinely empty transcript are indistinguishable anywhere else. This
  // exercises the real end-to-end write into extraction_yield (migration
  // 042) for both a healthy run and a zero-atom run, through the real
  // pipeline — not just the storage-layer unit test.
  it('records extraction_yield for a healthy run (chunks_in > 0, atoms_out > 0)', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    const rows = db.prepare('SELECT session_id, chunks_in, atoms_out FROM extraction_yield').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].chunks_in).toBeGreaterThanOrEqual(1);
    expect(rows[0].atoms_out).toBeGreaterThanOrEqual(1);
  });

  it('records a zero atoms_out row when the model returns {"atoms":[]} — the exact ADR-015 silent-failure shape', async () => {
    const llm = makeMockLLM('compressed', JSON.stringify({ atoms: [] }));
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    const rows = db.prepare('SELECT session_id, chunks_in, atoms_out FROM extraction_yield').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].chunks_in).toBeGreaterThanOrEqual(1);
    expect(rows[0].atoms_out).toBe(0);
  });

  // Same diagnostic-write-must-never-fail-the-pipeline posture as the
  // relation_guard_drops test above — DROP the table, force
  // recordExtractionYield to throw a real SqliteError, and confirm the run
  // still completes with the memory persisted.
  it('an extraction_yield write failure does not fail the pipeline — memories still persist', async () => {
    db.exec('DROP TABLE extraction_yield');

    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    expect(result.memoriesCreated).toBeGreaterThanOrEqual(1);
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

// ---------------------------------------------------------------------------
// Dual-pass extraction (opt-in, distill.extractionPasses: 2) — FEAT: single-
// hop root-cause investigation (docs/research/20260713-single-hop-root-
// cause.md) found 36-47% of gold single-hop facts never became an atom at
// all. A second "specifics sweeper" extraction call (prompts/extract.ts's
// EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER) runs over the same chunks and
// is merged/deduped with pass A (src/distill/dedup-merge.ts) before stage 6.
// ---------------------------------------------------------------------------

describe('dual-pass extraction (distill.extractionPasses)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  // Deliberately overlaps EXTRACTION_RESPONSE's port-7777 fact (same words,
  // different case/punctuation — an exact-normalized duplicate the merge
  // step must drop) plus ONE genuinely new, disjoint fact.
  const SPECIFICS_RESPONSE = JSON.stringify({
    atoms: [
      {
        type: 'fact',
        text: 'Default daemon port is 7777.',
        importance: 0.6,
        confidence: 0.9,
      },
      {
        type: 'fact',
        text: 'The team evaluated pgvector before choosing sqlite-vec.',
        importance: 0.5,
        confidence: 0.8,
      },
    ],
  });

  /** Distinguishes pass A's extraction call from pass B's ("specifics
   *  sweeper") by inspecting the actual system prompt sent, not call order —
   *  the real signal that differentiates the two passes in production. */
  function makeDualPassMockLLM(): { llm: LLMProvider; extractionCallCount: () => number } {
    let extractionCalls = 0;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        if (!opts?.json) {
          return { text: 'compressed content', usage: { in: 100, out: 50, usd: 0 } };
        }
        extractionCalls++;
        const system = msgs.find((m) => m.role === 'system')?.content ?? '';
        const reply = system === EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER ? SPECIFICS_RESPONSE : EXTRACTION_RESPONSE;
        return { text: reply, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    return { llm, extractionCallCount: () => extractionCalls };
  }

  it('extractionPasses: 1 (default/unset) is byte-identical to pre-dual-pass behavior — one extraction call per chunk', async () => {
    const { llm, extractionCallCount } = makeDualPassMockLLM();
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 1 } },
    });

    expect(extractionCallCount()).toBe(1); // FIXTURE_TRANSCRIPT is a single chunk
    expect(result.memoriesCreated).toBe(3); // exactly pass A's 3 atoms — pass B never ran
    const texts = (db.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    expect(texts.some((t: string) => t.includes('pgvector'))).toBe(false);
  });

  it('extractionPasses: 2 runs a second "specifics sweeper" call per chunk and merges the two passes', async () => {
    const { llm, extractionCallCount } = makeDualPassMockLLM();
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2 } },
    });

    expect(extractionCallCount()).toBe(2); // pass A + pass B, one chunk

    const texts = (db.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    // The new, disjoint pass-B fact survived the merge.
    expect(texts.some((t: string) => t.includes('pgvector'))).toBe(true);
    // The exact-normalized duplicate ("Default daemon port is 7777.") did
    // NOT create a second port memory — the merge dropped it before stage 6.
    const portMemories = texts.filter((t: string) => t.includes('7777'));
    expect(portMemories.length).toBe(1);
    // 3 pass-A atoms + 1 disjoint pass-B atom (the duplicate was deduped away).
    expect(result.memoriesCreated).toBe(4);
  });

  // ---------------------------------------------------------------------
  // FEAT-534: per-pass extraction provider override
  // (PipelineContext.llmExtractionPassB). Both ACs below use a DISTINCT
  // mock provider per pass (not just a distinct system prompt, as
  // makeDualPassMockLLM above distinguishes) so a capture-provider
  // assertion can pin exactly which provider instance each pass's chat()
  // call landed on — the real signal the FEAT's acceptance criteria ask
  // for ("pass A chat calls hit codex and pass B chat calls hit ollama").
  // ---------------------------------------------------------------------

  /** A named mock provider that counts its OWN chat() calls — used in pairs
   *  so a test can assert calls landed on the right instance, not just that
   *  SOME provider was called N times. */
  function makeNamedMockLLM(modelName: string, extractionReply: string): { llm: LLMProvider; extractionCalls: () => number } {
    let extractionCalls = 0;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: modelName,
      async chat(_msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        if (!opts?.json) return { text: 'compressed content', usage: { in: 100, out: 50, usd: 0 } };
        extractionCalls++;
        return { text: extractionReply, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: modelName, latency_ms: 0 };
      },
    };
    return { llm, extractionCalls: () => extractionCalls };
  }

  it('FEAT-534: llmExtractionPassB set — pass A calls land on llmExtraction, pass B calls land on the override, never crossed', async () => {
    const passA = makeNamedMockLLM('pass-a-model', EXTRACTION_RESPONSE);
    const passB = makeNamedMockLLM('pass-b-model', SPECIFICS_RESPONSE);
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db,
      llmCompaction: passA.llm,
      llmExtraction: passA.llm,
      llmExtractionPassB: passB.llm,
      embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2 } },
    });

    // Each provider instance saw exactly its own pass's one call — not 2 on
    // one and 0 on the other, and not both landing on the same instance.
    expect(passA.extractionCalls()).toBe(1);
    expect(passB.extractionCalls()).toBe(1);

    // Merge behavior is unaffected by which provider produced which pass's
    // atoms — same 4-memory outcome the shared-provider test above asserts.
    expect(result.memoriesCreated).toBe(4);
  });

  it('FEAT-534: llmExtractionPassB unset — both passes hit llmExtraction (byte-identical to pre-FEAT-534 dual-pass)', async () => {
    const { llm, extractionCallCount } = makeDualPassMockLLM();
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db,
      llmCompaction: llm,
      llmExtraction: llm,
      // llmExtractionPassB deliberately omitted.
      embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2 } },
    });

    // Both pass A and pass B calls landed on the ONE shared provider —
    // exactly the same count the pre-FEAT-534 dual-pass test above asserts.
    expect(extractionCallCount()).toBe(2);
    expect(result.memoriesCreated).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// FEAT-551: evidence-gated sweeper — wiring at the runPipeline level. The
// gate itself (checkEvidenceGate) is unit-tested in
// tests/distill/evidence-gate.test.ts; these tests prove the end-to-end
// resolution (mixed-provider default, explicit override, pass-A bypass)
// actually reaches stage 8 through the real pipeline.
// ---------------------------------------------------------------------------
describe('evidence-gated sweeper wiring (distill.extractionPassB.evidenceGate)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  /** A named mock provider — same shape as the dual-pass suite's
   *  makeNamedMockLLM, but with a caller-chosen provider `name` (not always
   *  'ollama') so a test can construct a genuine mixed-PROVIDER case, not
   *  just a mixed-model one. */
  function makeProvider(name: LLMProvider['name'], model: string, extractionReply: string): LLMProvider {
    return {
      name,
      model,
      async chat(_msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        const reply = opts?.json ? extractionReply : 'compressed content';
        return { text: reply, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model, latency_ms: 0 };
      },
    };
  }

  // One real (verifiable) passB atom + one fabricated one, so a run can
  // distinguish "gate admitted the real one" from "gate dropped the fake one"
  // in a single call.
  const MIXED_SPECIFICS_RESPONSE = JSON.stringify({
    atoms: [
      {
        type: 'fact',
        text: 'the default daemon port avoids conflicts with common dev tools',
        importance: 0.5,
        confidence: 0.8,
        // Real substring of FIXTURE_TRANSCRIPT — verifies (whitespace-normalized).
        evidence: 'It avoids conflicts with common dev tools on 3000/8080.',
      },
      {
        type: 'fact',
        text: 'a fabricated passB claim nobody actually said',
        importance: 0.5,
        confidence: 0.8,
        evidence: 'this exact sentence never appears anywhere in the transcript',
      },
    ],
  });

  it('mixed-provider case (unset evidenceGate): defaults ON — the fabricated passB atom is dropped, the verifiable one survives, pass-A atoms are untouched', async () => {
    const passA = makeProvider('codex-subscription', 'gpt-5.4-mini', EXTRACTION_RESPONSE);
    const passB = makeProvider('ollama', 'phi4-mini', MIXED_SPECIFICS_RESPONSE);
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: passA, llmExtraction: passA, llmExtractionPassB: passB, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      // evidenceGate deliberately unset — exercises the mixed-provider default.
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2, extractionPassB: { provider: 'ollama', model: 'phi4-mini' } } },
    });

    const texts = (db.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    // Pass A's 3 atoms all present, untouched.
    expect(texts.some((t: string) => t.includes('sqlite-vec'))).toBe(true);
    expect(texts.some((t: string) => t.includes('7777'))).toBe(true);
    expect(texts.some((t: string) => t.includes('better-sqlite3'))).toBe(true);
    // The verifiable passB atom survived.
    expect(texts.some((t: string) => t.includes('avoids conflicts with common dev tools'))).toBe(true);
    // The fabricated passB atom was dropped by the gate.
    expect(texts.some((t: string) => t.includes('fabricated passb claim'))).toBe(false);
    expect(result.memoriesCreated).toBe(4); // 3 pass-A + 1 surviving pass-B
  });

  it("explicit evidenceGate: 'off' overrides the mixed-provider default — the fabricated passB atom survives too", async () => {
    const passA = makeProvider('codex-subscription', 'gpt-5.4-mini', EXTRACTION_RESPONSE);
    const passB = makeProvider('ollama', 'phi4-mini', MIXED_SPECIFICS_RESPONSE);
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: passA, llmExtraction: passA, llmExtractionPassB: passB, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: {
        ...defaultConfig(),
        distill: {
          ...defaultConfig().distill, extractionPasses: 2,
          extractionPassB: { provider: 'ollama', model: 'phi4-mini', evidenceGate: 'off' },
        },
      },
    });

    const texts = (db.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    expect(texts.some((t: string) => t.includes('fabricated passb claim'))).toBe(true);
    expect(result.memoriesCreated).toBe(5); // 3 pass-A + BOTH pass-B atoms
  });

  it("explicit evidenceGate: 'on' forces the gate even in the SAME-provider case (no mixed-provider default would otherwise apply)", async () => {
    // Same provider INSTANCE drives BOTH passes (no llmExtractionPassB
    // override) — the default resolution alone would leave the gate OFF (no
    // provider mismatch). Explicit 'on' must still force it. Distinguishes
    // pass A's call from pass B's by system prompt (same technique
    // makeDualPassMockLLM above uses) so pass A's own atoms never
    // exact-duplicate pass B's fabricated atom and get merge-deduped into
    // masquerading as a pass-A survivor.
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'same-model',
      async chat(msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        if (!opts?.json) return { text: 'compressed content', usage: { in: 100, out: 50, usd: 0 } };
        const system = msgs.find((m) => m.role === 'system')?.content ?? '';
        const reply = system === EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER ? MIXED_SPECIFICS_RESPONSE : EXTRACTION_RESPONSE;
        return { text: reply, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'same-model', latency_ms: 0 };
      },
    };
    const embed = makeMockEmbed();

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: {
        ...defaultConfig(),
        distill: { ...defaultConfig().distill, extractionPasses: 2, extractionPassB: { evidenceGate: 'on' } },
      },
    });

    const texts = (db.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    expect(texts.some((t: string) => t.includes('fabricated passb claim'))).toBe(false);
    expect(texts.some((t: string) => t.includes('avoids conflicts with common dev tools'))).toBe(true);
  });

  // AC-2: "an integration test asserts pass-A atom count and content are
  // unaffected by the gate being on or off" — run the SAME mixed-provider
  // setup twice, gate explicitly 'on' then explicitly 'off', and diff only
  // the pass-A atoms between the two runs.
  it('AC-2: pass-A atom count and content are byte-identical whether the gate is explicitly on or off', async () => {
    const passAOn = makeProvider('codex-subscription', 'gpt-5.4-mini', EXTRACTION_RESPONSE);
    const passBOn = makeProvider('ollama', 'phi4-mini', MIXED_SPECIFICS_RESPONSE);
    const embed = makeMockEmbed();

    const dbOn = openDb(':memory:');
    migrate(dbOn);
    await runPipeline(FIXTURE_TRANSCRIPT, {
      db: dbOn, llmCompaction: passAOn, llmExtraction: passAOn, llmExtractionPassB: passBOn, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2, extractionPassB: { provider: 'ollama', model: 'phi4-mini', evidenceGate: 'on' } } },
    });

    const passAOff = makeProvider('codex-subscription', 'gpt-5.4-mini', EXTRACTION_RESPONSE);
    const passBOff = makeProvider('ollama', 'phi4-mini', MIXED_SPECIFICS_RESPONSE);
    const dbOff = openDb(':memory:');
    migrate(dbOff);
    await runPipeline(FIXTURE_TRANSCRIPT, {
      db: dbOff, llmCompaction: passAOff, llmExtraction: passAOff, llmExtractionPassB: passBOff, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2, extractionPassB: { provider: 'ollama', model: 'phi4-mini', evidenceGate: 'off' } } },
    });

    const PASS_A_TEXTS = [
      'use sqlite-vec for vector storage in v1',
      'default daemon port is 7777',
      'bun does not support better-sqlite3 on windows without prebuilt binaries',
    ];
    const textsOn = (dbOn.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    const textsOff = (dbOff.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    for (const passAText of PASS_A_TEXTS) {
      expect(textsOn.some((t) => t.includes(passAText))).toBe(true);
      expect(textsOff.some((t) => t.includes(passAText))).toBe(true);
    }
    // Count of pass-A-attributable rows is identical across both runs — only
    // the passB fabricated atom's fate differs (dropped on / kept off).
    const passARowCountOn = textsOn.filter((t) => PASS_A_TEXTS.some((p) => t.includes(p))).length;
    const passARowCountOff = textsOff.filter((t) => PASS_A_TEXTS.some((p) => t.includes(p))).length;
    expect(passARowCountOn).toBe(passARowCountOff);
    expect(passARowCountOn).toBe(3);
  });
});

// ─── FEAT-548: ingest gatekeeper ─────────────────────────────────────────────

describe('runPipeline — FEAT-548 ingest gatekeeper', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  /** Deterministic fake gatekeeper provider: applies ONE fixed verdict to
   *  every numbered chunk in the batch — every test in this describe block
   *  produces exactly one chunk (FIXTURE_TRANSCRIPT fits well under the
   *  default maxChunkChars), so there is no need to key by the chunk's exact
   *  post-cleanup/normalize/pack text (which can legitimately differ from
   *  the raw fixture string's own newline layout — packTurns rejoins turns
   *  with '\n\n', not the original single '\n'). Verifies the marker is
   *  present so a misrouted (non-gatekeeper) call is caught, same posture
   *  makeTriageProvider (08-embed-index.test.ts) uses for its own marker. */
  function makeGatekeeperProvider(verdict: 'keep' | 'skip', confidence = 0.9): LLMProvider {
    return {
      name: 'ollama',
      model: 'test-gatekeeper-model',
      async chat(messages: ChatMsg[], _opts?: ChatOpts) {
        const system = messages.find((m) => m.role === 'system')?.content ?? '';
        if (!system.includes('astramem-gatekeeper-v1')) {
          throw new Error('test provider received a non-gatekeeper call (missing GATEKEEPER_MARKER)');
        }
        const user = messages.find((m) => m.role === 'user')?.content ?? '';
        const verdicts: Array<{ index: number; verdict: string; confidence: number }> = [];
        for (const line of user.split('\n')) {
          const m = line.match(/^\[(\d+)\]\s/);
          if (!m) continue;
          verdicts.push({ index: Number(m[1]), verdict, confidence });
        }
        return { text: JSON.stringify({ verdicts }), usage: { in: 1, out: 1, usd: 0 } };
      },
      async health() {
        return { ok: true, model: 'test-gatekeeper-model', latency_ms: 0 };
      },
    };
  }

  function makeThrowingGatekeeperProvider(message: string): LLMProvider {
    return {
      name: 'ollama',
      model: 'unreachable-gatekeeper-model',
      async chat() {
        throw new Error(message);
      },
      async health() {
        return { ok: false, model: 'unreachable-gatekeeper-model', latency_ms: 0, error: message };
      },
    };
  }

  it("AC-1: mode 'off' (default, including omitted config) never calls the gatekeeper provider — byte-identical to pre-FEAT-548", async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();
    let gatekeeperCalled = false;
    const llmGatekeeper: LLMProvider = {
      name: 'ollama', model: 'unused-gatekeeper-model',
      async chat() { gatekeeperCalled = true; return { text: JSON.stringify({ verdicts: [] }), usage: { in: 1, out: 1, usd: 0 } }; },
      async health() { return { ok: true, model: 'unused-gatekeeper-model', latency_ms: 0 }; },
    };

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed, llmGatekeeper,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      // config intentionally omitted — mode resolves to 'off' via the
      // `ctx.config?.distill.gatekeeper.mode ?? 'off'` fallback.
    });

    expect(gatekeeperCalled).toBe(false);
    expect(result.memoriesCreated).toBe(3); // unfiltered, same as the base fixture
    expect((db.prepare('SELECT COUNT(*) AS n FROM gatekeeper_skips').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM gatekeeper_run_log').get() as any).n).toBe(0);
  });

  it("AC-3: mode 'dry-run' — a 'skip' verdict is logged (DB rows) with a running skip-rate counter but the chunk still reaches extraction unmodified", async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();
    const llmGatekeeper = makeGatekeeperProvider('skip', 0.95);

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed, llmGatekeeper,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, gatekeeper: { mode: 'dry-run', batchSize: 20, maxPerRun: 200, maxWallClockMs: 300_000 } } },
    });

    // Dry-run never filters — the chunk still reaches extraction unmodified.
    expect(result.memoriesCreated).toBe(3);

    const runLog = db.prepare('SELECT session_id, chunks_evaluated, chunks_skipped FROM gatekeeper_run_log').get() as any;
    expect(runLog).toBeDefined();
    expect(runLog.chunks_evaluated).toBe(1);
    expect(runLog.chunks_skipped).toBe(1);

    const skipRow = db.prepare('SELECT model, confidence, mode FROM gatekeeper_skips').get() as any;
    expect(skipRow).toBeDefined();
    expect(skipRow.mode).toBe('dry-run');
    expect(skipRow.confidence).toBeCloseTo(0.95);
  });

  it('AC-2: a throwing gatekeeper provider fails OPEN under mode "enabled" — the chunk is extracted exactly as if verdicted keep', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();
    const llmGatekeeper = makeThrowingGatekeeperProvider('gatekeeper provider down');

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed, llmGatekeeper,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, gatekeeper: { mode: 'enabled', batchSize: 20, maxPerRun: 200, maxWallClockMs: 300_000 } } },
    });

    // Fail-open, ADR-015: the chunk WAS extracted — not silently dropped.
    expect(result.memoriesCreated).toBe(3);

    const runLog = db.prepare('SELECT chunks_evaluated, chunks_skipped FROM gatekeeper_run_log').get() as any;
    expect(runLog.chunks_evaluated).toBe(1); // attempted, counted toward the rate denominator
    expect(runLog.chunks_skipped).toBe(0); // no verdict entry -> implicit keep, never recorded as a skip
    expect((db.prepare('SELECT COUNT(*) AS n FROM gatekeeper_skips').get() as any).n).toBe(0);
  });

  it("mode 'enabled' — a real 'skip' verdict removes the chunk from extraction entirely (extraction never called, zero memories)", async () => {
    let extractionCalls = 0;
    const llm: LLMProvider = {
      name: 'ollama', model: 'test-model',
      async chat(_msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        if (opts?.json) extractionCalls++;
        const reply = opts?.json ? EXTRACTION_RESPONSE : 'compressed content';
        return { text: reply, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test-model', latency_ms: 0 }; },
    };
    const embed = makeMockEmbed();
    const llmGatekeeper = makeGatekeeperProvider('skip', 0.9);

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed, llmGatekeeper,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, gatekeeper: { mode: 'enabled', batchSize: 20, maxPerRun: 200, maxWallClockMs: 300_000 } } },
    });

    expect(extractionCalls).toBe(0); // the metered extraction call was never made
    expect(result.memoriesCreated).toBe(0);
    expect(result.chunksProcessed).toBe(1); // chunking itself is unaffected — this is the gate's own count, not the raw chunk count

    const runLog = db.prepare('SELECT chunks_evaluated, chunks_skipped FROM gatekeeper_run_log').get() as any;
    expect(runLog.chunks_evaluated).toBe(1);
    expect(runLog.chunks_skipped).toBe(1);

    const skipRow = db.prepare('SELECT mode FROM gatekeeper_skips').get() as any;
    expect(skipRow.mode).toBe('enabled');
  });
});

// ---------------------------------------------------------------------------
// Pass-B clerk speed tuning (2026-07-18) — skip-chunk gate + sweeper
// maxTokens cap, both centrally resolved via resolveExtractionPassBTuning
// (EXTRACTION_PASS_B_DEFAULTS, config.ts). Measured motivation: ministral-3:8b
// sweeper calls averaged 62s and 1961 output tokens on the LoCoMo dual-pass
// leg; a chunk pass A already covered well has nothing left to sweep.
// ---------------------------------------------------------------------------

describe('pass-B clerk tuning (skip-chunk gate + maxTokens cap)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  // Pass A yields 8 atoms — AT the default sweepOnlyBelowAtoms threshold (8),
  // so the gate (strictly-below semantics) must skip the chunk.
  const RICH_PASS_A_RESPONSE = JSON.stringify({
    atoms: Array.from({ length: 8 }, (_, i) => ({
      type: 'fact',
      text: `Distinct well-covered pass-A fact number ${i} about the system's design.`,
      importance: 0.6,
      confidence: 0.9,
    })),
  });

  const SWEEPER_RESPONSE = JSON.stringify({
    atoms: [
      { type: 'fact', text: 'The team evaluated pgvector before choosing sqlite-vec.', importance: 0.5, confidence: 0.8 },
    ],
  });

  /** Mock that answers RICH_PASS_A_RESPONSE for pass A and SWEEPER_RESPONSE
   *  for pass B, recording each sweeper call's opts so the maxTokens cap is
   *  assertable at the provider boundary (the only place it's real). */
  function makeTuningMockLLM(passAResponse: string): {
    llm: LLMProvider;
    sweeperCalls: () => number;
    sweeperOpts: () => (ChatOpts | undefined)[];
  } {
    let sweeperCalls = 0;
    const sweeperOpts: (ChatOpts | undefined)[] = [];
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        if (!opts?.json) return { text: 'compressed content', usage: { in: 100, out: 50, usd: 0 } };
        const system = msgs.find((m) => m.role === 'system')?.content ?? '';
        if (system === EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER) {
          sweeperCalls++;
          sweeperOpts.push(opts);
          return { text: SWEEPER_RESPONSE, usage: { in: 100, out: 50, usd: 0 } };
        }
        return { text: passAResponse, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    return { llm, sweeperCalls: () => sweeperCalls, sweeperOpts: () => sweeperOpts };
  }

  it('default gate skips pass B entirely for a chunk pass A covered with >= 8 atoms', async () => {
    const { llm, sweeperCalls } = makeTuningMockLLM(RICH_PASS_A_RESPONSE);

    const result = await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed: makeMockEmbed(),
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2 } },
    });

    expect(sweeperCalls()).toBe(0); // whole local-LLM call saved
    expect(result.memoriesCreated).toBe(8); // pass A's atoms only
    const texts = (db.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    expect(texts.some((t: string) => t.includes('pgvector'))).toBe(false); // sweeper atom never produced
  });

  it('sweepOnlyBelowAtoms: 0 disables the gate — pass B sweeps even a well-covered chunk (legacy behavior)', async () => {
    const { llm, sweeperCalls } = makeTuningMockLLM(RICH_PASS_A_RESPONSE);

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed: makeMockEmbed(),
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: {
        ...defaultConfig(),
        distill: { ...defaultConfig().distill, extractionPasses: 2, extractionPassB: { sweepOnlyBelowAtoms: 0 } },
      },
    });

    expect(sweeperCalls()).toBe(1);
    const texts = (db.prepare('SELECT text FROM memories').all() as any[]).map((r) => r.text.toLowerCase());
    expect(texts.some((t: string) => t.includes('pgvector'))).toBe(true);
  });

  it('under-extracted chunk (below threshold) IS swept, and the sweeper call carries the central maxTokens cap', async () => {
    // EXTRACTION_RESPONSE has 3 atoms — below the default threshold of 8.
    const { llm, sweeperCalls, sweeperOpts } = makeTuningMockLLM(EXTRACTION_RESPONSE);

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed: makeMockEmbed(),
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      config: { ...defaultConfig(), distill: { ...defaultConfig().distill, extractionPasses: 2 } },
    });

    expect(sweeperCalls()).toBe(1);
    // The cap must be the CENTRAL default (1500), not pass A's 6000 ceiling —
    // asserted at the provider boundary where it becomes num_predict.
    expect(sweeperOpts()[0]?.maxTokens).toBe(1500);
  });
});
