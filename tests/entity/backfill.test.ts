import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { runEntityBackfill } from '../../src/entity/backfill.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../src/contracts/index.js';

// FEAT-402 AC-7 — backfill extracts + links entities over the existing
// corpus WITHOUT re-distilling memory text.

function makeMemory(db: DB, id: string, text: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text,
    repo: null, project: null, branch: null, agent: null, session_id: null,
    hash: `hash-${id}`, source_hash: null,
  });
}

function makeScriptedLLM(byPromptSubstring: Array<[substr: string, response: string]>): LLMProvider {
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      const userMsg = msgs.find(m => m.role === 'user')?.content ?? '';
      const match = byPromptSubstring.find(([substr]) => userMsg.includes(substr));
      const text = match ? match[1] : JSON.stringify({ entities: [] });
      return { text, usage: { in: 50, out: 20, usd: 0 } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

describe('runEntityBackfill', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('extracts and links entities without touching memory text or hash', async () => {
    const id = makeMemory(db, 'm1', 'use Postgres for the analytics store');
    const before = db.prepare('SELECT text, normalized_text, hash, updated_at FROM memories WHERE id = ?').get(id);

    const llm = makeScriptedLLM([
      ['Postgres', JSON.stringify({ entities: [{ name: 'Postgres', kind: 'tech' }] })],
    ]);

    const result = await runEntityBackfill(db, llm, { dryRun: false, capUsd: 10.0 });

    expect(result.scanned).toBe(1);
    expect(result.linked).toBe(1);
    expect(result.entitiesLinked).toBe(1);

    const after = db.prepare('SELECT text, normalized_text, hash, updated_at FROM memories WHERE id = ?').get(id);
    expect(after).toEqual(before);

    const linked = new EntityRepo(db).listForMemory(id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.name).toBe('postgres');
  });

  it('is idempotent — a fully-linked corpus is a pure no-op scan on re-run', async () => {
    const id = makeMemory(db, 'm2', 'use Postgres for storage');
    const llm = makeScriptedLLM([
      ['Postgres', JSON.stringify({ entities: [{ name: 'Postgres', kind: 'tech' }] })],
    ]);

    await runEntityBackfill(db, llm, { dryRun: false, capUsd: 10.0 });
    const secondRun = await runEntityBackfill(db, llm, { dryRun: false, capUsd: 10.0 });

    expect(secondRun.scanned).toBe(0);
    const linked = new EntityRepo(db).listForMemory(id);
    expect(linked).toHaveLength(1); // still just one link, not doubled
  });

  it('a memory whose extraction finds nothing is counted as skipped, not linked', async () => {
    makeMemory(db, 'm3', 'a generic observation with no named entity');
    const llm = makeScriptedLLM([]); // default response: {entities: []}

    const result = await runEntityBackfill(db, llm, { dryRun: false, capUsd: 10.0 });

    expect(result.scanned).toBe(1);
    expect(result.linked).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('dry-run does not mutate the DB', async () => {
    const id = makeMemory(db, 'm4', 'use Postgres for storage');
    const llm = makeScriptedLLM([
      ['Postgres', JSON.stringify({ entities: [{ name: 'Postgres', kind: 'tech' }] })],
    ]);

    const result = await runEntityBackfill(db, llm, { dryRun: true, capUsd: 10.0 });

    expect(result.linked).toBe(1); // computed, but...
    expect(new EntityRepo(db).listForMemory(id)).toEqual([]); // ...not applied
  });

  it('already-linked memories are excluded from candidate selection', async () => {
    const linkedId = makeMemory(db, 'm5', 'use Postgres for storage');
    const unlinkedId = makeMemory(db, 'm6', 'use TypeScript everywhere');
    new EntityRepo(db).linkEntitiesForMemory(linkedId, [{ name: 'Postgres', kind: 'tech' }]);

    const llm = makeScriptedLLM([
      ['TypeScript', JSON.stringify({ entities: [{ name: 'TypeScript', kind: 'tech' }] })],
    ]);

    const result = await runEntityBackfill(db, llm, { dryRun: false, capUsd: 10.0 });

    expect(result.scanned).toBe(1); // only the unlinked memory
    const linked = new EntityRepo(db).listForMemory(unlinkedId);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.name).toBe('typescript');
  });

  it('respects --limit', async () => {
    makeMemory(db, 'm7', 'use Postgres for storage');
    makeMemory(db, 'm8', 'use TypeScript everywhere');
    const llm = makeScriptedLLM([]);

    const result = await runEntityBackfill(db, llm, { dryRun: false, limit: 1, capUsd: 10.0 });
    expect(result.scanned).toBe(1);
  });
});
