// FEAT-480 instrumentation (measurement only, no ranking change).
//
// Confirms the AND-first / OR-fallback probe (src/search/search.ts's
// FtsGatherProbe/FtsCoverageProbe, gatherCandidates()'s `instrument` param)
// records the right thing and stays OFF by default:
//  - AND-hit queries: gather probe shows andRows > 0, orFired: false.
//  - AND-miss queries: gather probe shows andRows === 0, orFired: true, and
//    orRows matches what actually came back.
//  - Signal-token coverage is computed for FTS-sourced top-K hits only
//    (SearchHit path), matching the exact token set buildFtsOr() OR-joins.
//  - No sink supplied (the default for every pre-FEAT-480 caller) -> hits
//    are byte-identical to a pre-instrumentation call; nothing is silently
//    attached to the wire response.

import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { search, makeFakeVec, type FtsInstrumentation } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

function seed(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('FTS AND/OR instrumentation (FEAT-480, measurement only)', () => {
  it('AND-hit query: gather probe shows andRows > 0 and orFired: false (OR never runs)', async () => {
    const db = setupDb();
    seed(db, 'hybrid search fusion notes for sqlite-vec', 'i-1');

    const probe: FtsInstrumentation = { gather: [], coverage: [] };
    await search('hybrid search fusion', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', ftsProbeSink: probe,
    });

    expect(probe.gather).toHaveLength(1);
    expect(probe.gather[0]!.andRows).toBeGreaterThan(0);
    expect(probe.gather[0]!.orFired).toBe(false);
    expect(probe.gather[0]!.orRows).toBe(0);
  });

  it('AND-miss query: gather probe shows andRows === 0, orFired: true, orRows matching the recovered candidates', async () => {
    const db = setupDb();
    seed(db, 'the deployment pipeline pushes artifacts to the staging bucket', 'i-2');

    const probe: FtsInstrumentation = { gather: [], coverage: [] };
    const hits = await search('what is the deployment pipeline for', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', ftsProbeSink: probe,
    });

    expect(probe.gather).toHaveLength(1);
    expect(probe.gather[0]!.andRows).toBe(0);
    expect(probe.gather[0]!.orFired).toBe(true);
    expect(probe.gather[0]!.orRows).toBeGreaterThan(0);
    expect(probe.gather[0]!.orRows).toBe(hits.length);
  });

  it('signal-token coverage is recorded for FTS-sourced top-K hits, keyed to the exact buildFtsOr token set', async () => {
    const db = setupDb();
    // Only 2 of the query's 3 non-stopword tokens ("deployment", "pipeline")
    // are present -> coverage should be 2, not 3 (signalTokenCount is 3).
    const id = seed(db, 'the deployment pipeline runs nightly', 'i-3');

    const probe: FtsInstrumentation = { gather: [], coverage: [] };
    const hits = await search('deployment pipeline widget', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', ftsProbeSink: probe,
    });

    expect(hits.some(h => h.id === id)).toBe(true);
    const covProbe = probe.coverage.find(c => c.id === id);
    expect(covProbe).toBeDefined();
    expect(covProbe!.signalTokenCount).toBe(3); // deployment, pipeline, widget (none are stopwords)
    expect(covProbe!.coverage).toBe(2); // deployment + pipeline present, widget absent
  });

  it('no sink supplied (the default) -> results are unaffected, nothing computed', async () => {
    const db = setupDb();
    const id = seed(db, 'sqlite-vec hybrid search fusion notes', 'i-4');

    // No ftsProbeSink at all — exactly every pre-FEAT-480-instrumentation
    // caller's shape. Must behave byte-identically to the AND-first,
    // OR-fallback fix on its own (no instrumentation side effects).
    const hits = await search('fusion', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(id);
  });

  it('all-stopword query (AND and OR coincide): gather probe reports one entry, orFired: false, no double-count', async () => {
    const db = setupDb();
    seed(db, 'unrelated memory content that should not match', 'i-5');

    const probe: FtsInstrumentation = { gather: [], coverage: [] };
    await search('what is this', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, mode: 'keyword', ftsProbeSink: probe,
    });

    expect(probe.gather).toHaveLength(1);
    expect(probe.gather[0]!.andRows).toBe(0);
    // buildFtsOr's own all-stopword fallback makes it identical to
    // buildFtsAnd's output — gatherCandidates' redundant-rerun guard means
    // orFired stays false (the "OR" string was never actually different).
    expect(probe.gather[0]!.orFired).toBe(false);
    expect(probe.gather[0]!.orRows).toBe(0);
  });
});
