import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { runPipeline, BudgetExceeded } from '../../src/distill/pipeline.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
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
});
