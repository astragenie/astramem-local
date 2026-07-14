/**
 * FEAT-409 (parameterized embedding dim) — AC-1 and AC-2 coverage.
 *
 * AC-1: schema derives FLOAT[D] from the dim passed to migrate(), not a
 * literal — proven by inserting embedding blobs of the WRONG byte length
 * directly against memories_vec and confirming sqlite-vec's own vec0
 * dimension enforcement rejects them (i.e. this isn't just our software
 * guard in SqliteVecStore — the schema itself was created at dim D).
 *
 * AC-2: a fresh DB configured to a non-1024 dim (768) ingests (via the real
 * embedAndIndex distill stage) and searches (via the real search()
 * orchestrator) end-to-end with no dimension-mismatch error.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { embedAndIndex } from '../../src/distill/stages/08-embed-index.js';
import type { NormalizedMemory } from '../../src/distill/stages/07-memory-normalize.js';
import { search } from '../../src/search/search.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';

const NON_DEFAULT_DIM = 768;

function normalizedMem(text: string, hash: string): NormalizedMemory {
  return {
    type: 'decision',
    text,
    normalizedText: text.trim().toLowerCase(),
    importance: 0.7,
    confidence: 0.8,
    contentHash: hash.slice(0, 16),
    finalHash: hash,
    evidence: undefined,
  };
}

describe('FEAT-409 AC-1 — schema derives FLOAT[D] from migrate()', () => {
  it('rejects a wrong-length embedding blob against a DB migrated at dim=768', () => {
    const db = openDb(':memory:');
    migrate(db, NON_DEFAULT_DIM);

    db.prepare(`
      INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
      VALUES ('m1', 'fact', 'x', 'x', 0.5, 0.5, 'hash1', 1, 1)
    `).run();
    const rowid = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('m1') as { rowid: number }).rowid;

    // Correct dim (768 floats = 3072 bytes) — accepted by the schema.
    const correctBuf = Buffer.alloc(NON_DEFAULT_DIM * 4);
    expect(() =>
      db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), correctBuf),
    ).not.toThrow();

    // Wrong dim (1024 floats = 4096 bytes) against the SAME table — rejected
    // by sqlite-vec's own vec0 enforcement, proving the schema was genuinely
    // created as FLOAT[768], not FLOAT[1024].
    db.prepare(`
      INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
      VALUES ('m2', 'fact', 'y', 'y', 0.5, 0.5, 'hash2', 1, 1)
    `).run();
    const rowid2 = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('m2') as { rowid: number }).rowid;
    const wrongBuf = Buffer.alloc(1024 * 4);
    expect(() =>
      db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid2), wrongBuf),
    ).toThrow();
  });

  it('default (no dim arg) still creates FLOAT[1024] — byte-identical baseline', () => {
    const db = openDb(':memory:');
    migrate(db); // no dim override

    db.prepare(`
      INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
      VALUES ('m1', 'fact', 'x', 'x', 0.5, 0.5, 'hash1', 1, 1)
    `).run();
    const rowid = (db.prepare('SELECT rowid FROM memories WHERE id = ?').get('m1') as { rowid: number }).rowid;

    const buf1024 = Buffer.alloc(1024 * 4);
    expect(() =>
      db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), buf1024),
    ).not.toThrow();
  });
});

describe('FEAT-409 AC-2 — fresh DB at non-1024 dim, ingest + search end-to-end', () => {
  it('embeds and indexes a memory at dim=768 with no dimension error', async () => {
    const db = openDb(':memory:');
    migrate(db, NON_DEFAULT_DIM);
    const { embed } = makeMockProviders(NON_DEFAULT_DIM);
    expect(embed.dim).toBe(NON_DEFAULT_DIM);

    const mems = [normalizedMem('use sqlite-vec for the 768-dim index', 'f'.repeat(64))];
    const results = await embedAndIndex(mems, {
      db, embed,
      sessionId: null, repo: 'astramemory-local', project: null, branch: null, agent: null, sourceHash: null,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.created).toBe(true);

    const row = db.prepare('SELECT embedding_dim FROM memories WHERE id = ?').get(results[0]!.memoryId) as { embedding_dim: number };
    expect(row.embedding_dim).toBe(NON_DEFAULT_DIM);
  });

  it('recalls the ingested memory via search() at dim=768', async () => {
    const db = openDb(':memory:');
    migrate(db, NON_DEFAULT_DIM);
    const { embed } = makeMockProviders(NON_DEFAULT_DIM);

    const mems = [normalizedMem('sqlite-vec dim-768 recall test', 'g'.repeat(64))];
    await embedAndIndex(mems, {
      db, embed,
      sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    const hits = await search(
      'dim-768 recall test',
      {},
      10,
      { db, embed, weights: { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1 } },
    );

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.text.includes('dim-768 recall test'))).toBe(true);
  });
});
