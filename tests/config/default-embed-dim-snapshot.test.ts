/**
 * FEAT-409 AC-6 — with no dim override, behavior must be byte-identical to
 * pre-change 1024-dim behavior. This is the critical safety property: no
 * accidental behavior shift for existing (default-config) users.
 *
 * Each assertion here pins one coordinated surface to the literal value
 * 1024 when nothing overrides it — the same value that was hardcoded
 * before FEAT-409 parameterized it.
 */
import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { DEFAULT_EMBED_DIM } from '../../src/contracts/embed.js';
import { OllamaEmbedProvider } from '../../src/providers/embed/ollama.js';
import { AzureOpenAIEmbedProvider } from '../../src/providers/embed/azure-openai.js';
import { getProviders } from '../../src/providers/index.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { makeFakeVec } from '../../src/search/search.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

describe('FEAT-409 AC-6 — default dim is byte-identical to pre-change 1024', () => {
  it('DEFAULT_EMBED_DIM constant is 1024', () => {
    expect(DEFAULT_EMBED_DIM).toBe(1024);
  });

  it('defaultConfig().embedding.dim is 1024', () => {
    expect(defaultConfig().embedding.dim).toBe(1024);
  });

  it('OllamaEmbedProvider with no dim override has dim 1024', () => {
    const p = new OllamaEmbedProvider({ model: 'mxbai-embed-large' });
    expect(p.dim).toBe(1024);
  });

  it('AzureOpenAIEmbedProvider with no dim override has dim 1024', () => {
    const p = new AzureOpenAIEmbedProvider({
      endpoint: 'https://example.openai.azure.com',
      deployment: 'dep',
      apiKey: 'key',
    });
    expect(p.dim).toBe(1024);
  });

  it('getProviders(defaultConfig()) yields dim 1024 for the embed provider', () => {
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    const { embed } = getProviders(defaultConfig());
    expect(embed.dim).toBe(1024);
  });

  it('SqliteVecStore with no dim override rejects anything but 1024', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const store = new SqliteVecStore(db);
    await expect(store.upsert('missing-id', new Float32Array(768))).rejects.toThrow(/expected dim 1024, got 768/);
  });

  it('makeFakeVec with no dim override produces a 1024-length vector', () => {
    expect(makeFakeVec('hello world').length).toBe(1024);
  });

  it('migrate() with no dim override bakes FLOAT[1024] into a fresh DB', () => {
    const db = openDb(':memory:');
    migrate(db);
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
