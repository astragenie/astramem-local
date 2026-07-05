// FEAT-423 — search() project filter end-to-end. This is the test the issue's
// empirical proof called for: identical query, different `project` values must
// yield DIFFERENT hit sets (the reporter saw identical counts for every value
// because the client never sent the filter — the daemon side has always
// applied `project = ?` post-fusion, see search.ts).

import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

function seed(db: DB, text: string, hash: string, project: string | null): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

function seedAgent(db: DB, text: string, hash: string, agent: string | null): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent,
    session_id: null, hash, source_hash: null,
  });
}

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('search() project filter (FEAT-423)', () => {
  it('narrows to atoms whose provenance.project matches — same query, different project → different hits', async () => {
    const db = setupDb();
    const runner = seed(db, 'canonical store decision for the pipeline', 'h-pf-1', 'runner-plugin');
    const other = seed(db, 'canonical store decision for the pipeline', 'h-pf-2', 'astramem');

    const runnerHits = await search('canonical store decision pipeline', { project: 'runner-plugin' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const otherHits = await search('canonical store decision pipeline', { project: 'astramem' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(runnerHits.map(h => h.id)).toEqual([runner]);
    expect(otherHits.map(h => h.id)).toEqual([other]);
  });

  it('omitting project returns atoms from every project (unscoped = all)', async () => {
    const db = setupDb();
    const a = seed(db, 'canonical store decision one', 'h-pf-3', 'runner-plugin');
    const b = seed(db, 'canonical store decision two', 'h-pf-4', 'astramem');
    const c = seed(db, 'canonical store decision three', 'h-pf-5', null);

    const hits = await search('canonical store decision', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(hits.map(h => h.id).sort()).toEqual([a, b, c].sort());
  });

  it('a project list matches atoms from any listed project (IN / OR-semantics)', async () => {
    const db = setupDb();
    const a = seed(db, 'canonical store decision one', 'h-pf-in1', 'runner-plugin');
    const b = seed(db, 'canonical store decision two', 'h-pf-in2', 'astramem');
    const c = seed(db, 'canonical store decision three', 'h-pf-in3', 'unrelated');

    const hits = await search('canonical store decision', { project: ['runner-plugin', 'astramem'] }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    const ids = hits.map(h => h.id).sort();
    expect(ids).toEqual([a, b].sort());
    expect(ids).not.toContain(c);
  });

  it('an empty project list is treated as no constraint (all), never match-nothing', async () => {
    const db = setupDb();
    const a = seed(db, 'canonical store decision one', 'h-pf-e1', 'runner-plugin');
    const b = seed(db, 'canonical store decision two', 'h-pf-e2', null);

    const hits = await search('canonical store decision', { project: [] }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(hits.map(h => h.id).sort()).toEqual([a, b].sort());
  });

  it('a project with no matching atoms yields zero results (not an unfiltered search)', async () => {
    const db = setupDb();
    seed(db, 'canonical store decision', 'h-pf-6', 'runner-plugin');

    const hits = await search('canonical store decision', { project: 'nonexistent' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(hits).toEqual([]);
  });

  it('null-project atoms do not match an explicit project filter', async () => {
    const db = setupDb();
    const nullProj = seed(db, 'canonical store decision', 'h-pf-7', null);

    const hits = await search('canonical store decision', { project: 'runner-plugin' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(hits.map(h => h.id)).not.toContain(nullProj);
    expect(hits).toEqual([]);
  });
});

describe('search() agent filter (FEAT-423)', () => {
  it('narrows to atoms whose provenance.agent matches — hard filter', async () => {
    const db = setupDb();
    const reviewer = seedAgent(db, 'prior review lesson about null checks', 'h-af-1', 'crew:reviewer');
    const builder = seedAgent(db, 'prior review lesson about null checks', 'h-af-2', 'crew:builder');

    const hits = await search('prior review lesson null checks', { agent: 'crew:reviewer' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(hits.map(h => h.id)).toEqual([reviewer]);
    expect(hits.map(h => h.id)).not.toContain(builder);
  });

  it('project and agent filters compose (AND) in one search', async () => {
    const db = setupDb();
    const match = new MemoryRepo(db).insert({
      type: 'fact', text: 'runner reviewer lesson one', normalized_text: 'runner reviewer lesson one',
      repo: 'r1', project: 'runner-plugin', branch: null, agent: 'crew:reviewer',
      session_id: null, hash: 'h-af-3', source_hash: null,
    });
    // same project, different agent → excluded by the agent clause
    new MemoryRepo(db).insert({
      type: 'fact', text: 'runner builder lesson one', normalized_text: 'runner builder lesson one',
      repo: 'r1', project: 'runner-plugin', branch: null, agent: 'crew:builder',
      session_id: null, hash: 'h-af-4', source_hash: null,
    });

    const hits = await search('runner lesson one', { project: 'runner-plugin', agent: 'crew:reviewer' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(hits.map(h => h.id)).toEqual([match]);
  });

  it('omitting agent returns atoms from every agent (unscoped = all)', async () => {
    const db = setupDb();
    const a = seedAgent(db, 'shared lesson alpha', 'h-af-5', 'crew:reviewer');
    const b = seedAgent(db, 'shared lesson beta', 'h-af-6', 'crew:builder');

    const hits = await search('shared lesson', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(hits.map(h => h.id).sort()).toEqual([a, b].sort());
  });
});
