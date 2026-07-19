// FEAT-480 instrumentation (measurement only, no ranking change) — confirms
// GET /search's `_ftsProbe` wiring end-to-end: absent by default, present
// only when the daemon process has ASTRA_FTS_INSTRUMENT=1 set. The route
// reads process.env fresh per-request (src/server/routes/search.ts), so
// this test toggles it directly rather than needing a module reload.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

describe('GET /search _ftsProbe (FEAT-480 instrumentation)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const ORIGINAL_ENV = process.env.ASTRA_FTS_INSTRUMENT;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    repo.insert({
      type: 'fact',
      text: 'the deployment pipeline pushes artifacts to the staging bucket',
      normalized_text: 'the deployment pipeline pushes artifacts to the staging bucket',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'probe-1', source_hash: null,
    });
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  afterEach(() => {
    // Always restore — a leaked env var here would silently turn on
    // instrumentation for every OTHER test in this same worker.
    if (ORIGINAL_ENV === undefined) delete process.env.ASTRA_FTS_INSTRUMENT;
    else process.env.ASTRA_FTS_INSTRUMENT = ORIGINAL_ENV;
  });

  it('env var unset (the default): no `_ftsProbe` field on the response', async () => {
    delete process.env.ASTRA_FTS_INSTRUMENT;
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=what+is+the+deployment+pipeline+for',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body._ftsProbe).toBeUndefined();
  });

  it('ASTRA_FTS_INSTRUMENT=1: `_ftsProbe` reports the OR fallback firing for a plain-English miss', async () => {
    process.env.ASTRA_FTS_INSTRUMENT = '1';
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=what+is+the+deployment+pipeline+for',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body._ftsProbe).toBeDefined();
    expect(body._ftsProbe.gather).toHaveLength(1);
    expect(body._ftsProbe.gather[0].andRows).toBe(0);
    expect(body._ftsProbe.gather[0].orFired).toBe(true);
    expect(body._ftsProbe.gather[0].orRows).toBeGreaterThan(0);
    expect(Array.isArray(body._ftsProbe.coverage)).toBe(true);
  });

  it('ASTRA_FTS_INSTRUMENT=1: hit ranking/content is unaffected by instrumentation being on', async () => {
    // Freeze time — freshness decay (and therefore `score`) otherwise drifts
    // by the real wall-clock gap between the two inject() calls below, which
    // would fail this byte-identical comparison for a reason that has
    // nothing to do with instrumentation (same technique as
    // tests/search/search-debug.test.ts's AC-2).
    const frozenNow = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenNow);
    try {
      const withoutProbe = await app.inject({
        method: 'GET',
        url: '/search?q=what+is+the+deployment+pipeline+for',
        headers: { authorization: 'Bearer tok' },
      });
      const bodyWithout = withoutProbe.json();

      process.env.ASTRA_FTS_INSTRUMENT = '1';
      const withProbe = await app.inject({
        method: 'GET',
        url: '/search?q=what+is+the+deployment+pipeline+for',
        headers: { authorization: 'Bearer tok' },
      });
      const bodyWith = withProbe.json();

      expect(bodyWith.hits).toEqual(bodyWithout.hits);
    } finally {
      dateSpy.mockRestore();
    }
  });
});
