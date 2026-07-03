/**
 * FEAT-409 AC-4 — resumable re-embed dim-migration procedure.
 *
 * Exercises `runReembedDim` (the testable core of `astramem-local
 * reembed-dim`) directly against a real in-memory DB seeded with memories
 * at the OLD dim (simulating an existing 1024-dim DB with live data), then
 * proves: the destructive schema recreate happens once, every memory gets
 * a target-dim vector, a simulated mid-run failure leaves partial progress
 * that a second run resumes from (no re-work, no memory left behind), and
 * the checkpoint table is the resumability mechanism (migration 011).
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { runReembedDim } from '../../src/cli/reembed-dim.js';
import type { EmbedProvider, EmbedHealth } from '../../src/contracts/embed.js';

const OLD_DIM = 1024;
const NEW_DIM = 768;

function seedMemory(db: ReturnType<typeof openDb>, id: string, text: string): void {
  db.prepare(`
    INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
    VALUES (?, 'fact', ?, ?, 0.5, 0.5, ?, 1, 1)
  `).run(id, text, text.toLowerCase(), `hash-${id}`);
}

function makeEmbedProvider(dim: number, failFor: Set<string> = new Set()): { provider: EmbedProvider; calls: string[] } {
  const calls: string[] = [];
  const provider: EmbedProvider = {
    name: 'ollama',
    model: 'test-model',
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      calls.push(...texts);
      return texts.map((t) => {
        if (failFor.has(t)) throw new Error(`simulated transient failure for "${t}"`);
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = Math.sin(t.length + i * 0.01);
        return v;
      });
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-model', dim };
    },
  };
  return { provider, calls };
}

describe('FEAT-409 AC-4 — runReembedDim resumable procedure', () => {
  it('recreates memories_vec at the target dim and re-embeds every memory', async () => {
    const db = openDb(':memory:');
    migrate(db, OLD_DIM);
    seedMemory(db, 'm1', 'first memory');
    seedMemory(db, 'm2', 'second memory');
    seedMemory(db, 'm3', 'third memory');

    const { provider: embed } = makeEmbedProvider(NEW_DIM);
    const result = await runReembedDim(db, NEW_DIM, embed, 20);

    expect(result.schemaRecreated).toBe(true);
    expect(result.totalCandidates).toBe(3);
    expect(result.reembedded).toBe(3);
    expect(result.failed).toEqual([]);

    // New-dim vectors are actually queryable — schema really is FLOAT[768] now.
    const progress = db.prepare('SELECT COUNT(*) AS n FROM dim_migration_progress WHERE target_dim = ?').get(NEW_DIM) as { n: number };
    expect(progress.n).toBe(3);
  });

  it('a second run for the SAME target dim is a no-op (fully resumed, nothing left to do)', async () => {
    const db = openDb(':memory:');
    migrate(db, OLD_DIM);
    seedMemory(db, 'm1', 'first memory');

    const { provider: embed, calls } = makeEmbedProvider(NEW_DIM);
    const first = await runReembedDim(db, NEW_DIM, embed, 20);
    expect(first.reembedded).toBe(1);
    expect(calls).toEqual(['first memory']);

    const second = await runReembedDim(db, NEW_DIM, embed, 20);
    expect(second.schemaRecreated).toBe(false); // resume path — no destructive recreate
    expect(second.totalCandidates).toBe(0); // nothing left — already checkpointed
    expect(second.reembedded).toBe(0);
    expect(second.alreadyDone).toBe(1);
    // embed() was never called again for m1 — no re-work.
    expect(calls).toEqual(['first memory']);
  });

  it('resumes correctly after a partial failure — completed memories are not re-embedded, failed ones retry', async () => {
    const db = openDb(':memory:');
    migrate(db, OLD_DIM);
    seedMemory(db, 'm1', 'good memory');
    seedMemory(db, 'm2', 'bad memory');
    seedMemory(db, 'm3', 'another good memory');

    // First run: m2 fails (simulated transient provider error).
    const failing = makeEmbedProvider(NEW_DIM, new Set(['bad memory']));
    const first = await runReembedDim(db, NEW_DIM, failing.provider, 20);
    expect(first.schemaRecreated).toBe(true);
    expect(first.reembedded).toBe(2);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]?.memoryId).toBe('m2');

    // Second run: provider now succeeds for everything. Only m2 (the
    // uncheckpointed one) should be re-embedded — m1/m3 are already done.
    const succeeding = makeEmbedProvider(NEW_DIM);
    const second = await runReembedDim(db, NEW_DIM, succeeding.provider, 20);
    expect(second.schemaRecreated).toBe(false); // resume — recreate already happened
    expect(second.totalCandidates).toBe(1);
    expect(second.reembedded).toBe(1);
    expect(second.failed).toEqual([]);
    expect(succeeding.calls).toEqual(['bad memory']); // only the previously-failed one

    const progress = db.prepare('SELECT COUNT(*) AS n FROM dim_migration_progress WHERE target_dim = ?').get(NEW_DIM) as { n: number };
    expect(progress.n).toBe(3); // all three eventually checkpointed
  });

  it('updates memories.embedding_provider/model/dim to the NEW values after a re-embed (blocker fix — these must not keep reporting the OLD provider/model/dim)', async () => {
    const db = openDb(':memory:');
    migrate(db, OLD_DIM);
    seedMemory(db, 'm1', 'first memory');
    db.prepare(
      "UPDATE memories SET embedding_provider = 'ollama', embedding_model = 'old-model', embedding_dim = ? WHERE id = 'm1'",
    ).run(OLD_DIM);

    const { provider: embed } = makeEmbedProvider(NEW_DIM);
    (embed as { name: string }).name = 'azure-openai';
    (embed as { model: string }).model = 'new-model';
    const result = await runReembedDim(db, NEW_DIM, embed, 20);
    expect(result.reembedded).toBe(1);

    const row = db
      .prepare('SELECT embedding_provider, embedding_model, embedding_dim FROM memories WHERE id = ?')
      .get('m1') as { embedding_provider: string; embedding_model: string; embedding_dim: number };
    expect(row.embedding_provider).toBe('azure-openai');
    expect(row.embedding_model).toBe('new-model');
    expect(row.embedding_dim).toBe(NEW_DIM);
  });

  it('rejects a vector whose length does not match targetDim (provider misconfiguration surfaces as a per-memory failure)', async () => {
    const db = openDb(':memory:');
    migrate(db, OLD_DIM);
    seedMemory(db, 'm1', 'mismatched memory');

    // Provider CLAIMS dim=768 but actually returns 1024-length vectors.
    const badProvider: EmbedProvider = {
      name: 'ollama',
      model: 'misconfigured',
      dim: NEW_DIM,
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array(OLD_DIM));
      },
      async health(): Promise<EmbedHealth> {
        return { ok: true, model: 'misconfigured', dim: NEW_DIM };
      },
    };

    const result = await runReembedDim(db, NEW_DIM, badProvider, 20);
    expect(result.reembedded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/provider returned dim=1024, expected 768/);
  });
});
