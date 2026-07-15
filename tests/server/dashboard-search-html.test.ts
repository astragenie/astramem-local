// FEAT-410 SLICE-410-6 — GET /dashboard/search render internals.
// Contract: SLICE-410-3's `search(..., { debug: true })` -> SearchDebugHit[]
// (src/search/search.ts). Auth + registration are SLICE-410-1 (stable).
//
// AC-1: non-empty query -> id/source/bm25(norm)/cosine(norm)/importance/
//       freshness/fused/rank table from the debug:true output.
// AC-2: no query param (initial load) -> form + current fuse.ts weights,
//       no results table, not an error.
// AC-3: a query with zero candidates -> explicit "no results" state.
// AC-4: embed provider down -> FTS-only rows render, not a 500.
// AC-5: no Authorization header and no cookie -> 401.
// AC-6: valid cookie only -> 200.

import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { makeFakeVec } from '../../src/search/search.js';
import { defaultConfig } from '../../src/config/config.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

const TOKEN = 'testtoken';
const AUTH = { authorization: `Bearer ${TOKEN}` };

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

const failingEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async () => { throw new Error('embed provider down'); },
  health: async () => ({ ok: false, model: 'fake', dim: 1024 as const }),
};

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seed(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

async function seedWithVec(db: DB, text: string, hash: string): Promise<string> {
  const id = seed(db, text, hash);
  const vecStore = new SqliteVecStore(db, fakeEmbed.dim);
  const [vec] = await fakeEmbed.embed([text]);
  await vecStore.upsert(id, vec as Float32Array);
  return id;
}

describe('GET /dashboard/search — score table (SLICE-410-6)', () => {
  it('AC-1: non-empty query renders the per-candidate fusion score table', async () => {
    const db = setupDb();
    const id = await seedWithVec(db, 'sqlite-vec hybrid search fusion', 'sh-1');
    const app = await buildApp({ db, token: TOKEN, embed: fakeEmbed });

    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/search?query=sqlite-vec+hybrid+search+fusion',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const body = res.body;
    expect(body).toContain('<table>');
    for (const col of ['id', 'source', 'bm25(norm)', 'cosine(norm)', 'importance', 'freshness', 'fused', 'rank']) {
      expect(body.toLowerCase()).toContain(col.toLowerCase());
    }
    expect(body).toContain(id.slice(0, 8));
    expect(body).not.toContain('no results');
  });

  it('adds project + profile columns, resolved via a batched memories/transcripts lookup (not per-row)', async () => {
    const db = setupDb();
    db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run('s1', Date.now());
    db.prepare(`
      INSERT INTO transcripts (id, session_id, source, content, ingested_at, extract_profile)
      VALUES ('t1', 's1', 'test', 'content', ?, 'conversational')
    `).run(Date.now());
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'sqlite-vec hybrid search fusion with project', normalized_text: 'x',
      repo: null, project: 'astramemory-local', branch: null, agent: null,
      session_id: 's1', hash: 'sh-proj', source_hash: null,
    });
    const vecStore = new SqliteVecStore(db, fakeEmbed.dim);
    const [vec] = await fakeEmbed.embed(['sqlite-vec hybrid search fusion with project']);
    await vecStore.upsert(id, vec as Float32Array);

    const app = await buildApp({ db, token: TOKEN, embed: fakeEmbed });
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/search?query=sqlite-vec+hybrid+search+fusion+with+project',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.toLowerCase()).toContain('<th>project</th>');
    expect(body.toLowerCase()).toContain('<th>profile</th>');
    expect(body).toContain('astramemory-local');
    expect(body).toContain('conversational');
  });

  it('renders — for a candidate with no project and no derivable profile', async () => {
    const db = setupDb();
    const id = seed(db, 'fts only no project no profile sentinel', 'sh-noproj');
    const app = await buildApp({ db, token: TOKEN, embed: fakeEmbed });

    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/search?query=fts+only+no+project+no+profile+sentinel',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(id.slice(0, 8));
    expect(res.body).toContain('<td>—</td>');
  });

  it('AC-2: no query param shows the form and current fuse.ts weights, no table, not an error', async () => {
    const db = setupDb();
    const app = await buildApp({ db, token: TOKEN, embed: fakeEmbed });

    const res = await app.inject({ method: 'GET', url: '/dashboard/search', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('<form');
    expect(body).toContain('name="query"');
    expect(body).toContain('weights:');
    const weights = defaultConfig().search;
    expect(body).toContain(String(weights.alpha).replace(/^0\./, '.'));
    expect(body).not.toContain('<table>');
    expect(body).not.toContain('no results');
  });

  it('AC-3: a query with zero candidates shows an explicit "no results" state', async () => {
    const db = setupDb();
    const app = await buildApp({ db, token: TOKEN, embed: fakeEmbed });

    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/search?query=nothing+matches+anything+here',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('no results');
    expect(res.body).not.toContain('<table>');
  });

  it('AC-4: embed provider down still renders FTS-only rows, not a 500', async () => {
    const db = setupDb();
    const id = seed(db, 'fts only degraded embed sentinel check', 'sh-4');
    const app = await buildApp({ db, token: TOKEN, embed: failingEmbed });

    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/search?query=fts+only+degraded+embed+sentinel+check',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<table>');
    expect(res.body).toContain(id.slice(0, 8));
    // Documented sentinel (SLICE-410-3 AC-4): no vector leg -> cosine(norm) 0.
    expect(res.body).toContain('0.000');
  });

  it('AC-5: no Authorization header and no cookie -> 401', async () => {
    const db = setupDb();
    const app = await buildApp({ db, token: TOKEN, embed: fakeEmbed });

    const res = await app.inject({ method: 'GET', url: '/dashboard/search' });
    expect(res.statusCode).toBe(401);
  });

  it('AC-6: a valid cookie only -> 200', async () => {
    const db = setupDb();
    const app = await buildApp({ db, token: TOKEN, embed: fakeEmbed });

    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;

    const res = await app.inject({ method: 'GET', url: '/dashboard/search', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });
});
