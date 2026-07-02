// Wave 4d — injection-policy v1 (ADR-005 when-to-recall, instrumented per ADR-010).

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { decideInjection, shrinkBudgetForPrompt } from '../../src/recall/policy.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { buildApp } from '../../src/server/app.js';

function seed(db: DB, text: string, importance: number, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'decision', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null, importance,
  });
}

function cfg(overrides?: Partial<Config['recallPack']['policy']>): Config {
  const c = defaultConfig();
  c.recallPack.policy = { ...c.recallPack.policy, ...overrides };
  return c;
}

describe('decideInjection (4d)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('injects for a substantive prompt with eligible memories, and records recall_served', () => {
    seed(db, 'Use SQLite not Postgres', 0.9, 'h-pol-1');
    const d = decideInjection(db, cfg(), {
      repo: 'r1',
      prompt: 'refactor the storage layer to support a second backend implementation',
      now: Date.now(),
    });
    expect(d.inject).toBe(true);
    expect(d.reason).toBe('injected');
    expect(d.pack).toContain('Use SQLite');

    const served = db.prepare(
      `SELECT COUNT(*) AS n FROM memory_events WHERE event_type = 'usefulness'
       AND json_extract(payload_json, '$.family') = 'recall_served'
       AND json_extract(payload_json, '$.mode') = 'pack-policy'`,
    ).get() as { n: number };
    expect(served.n).toBe(1);
  });

  it('gates smalltalk — no injection, nothing recorded', () => {
    seed(db, 'Use SQLite not Postgres', 0.9, 'h-pol-2');
    const d = decideInjection(db, cfg(), { repo: 'r1', prompt: 'thanks!', now: Date.now() });
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('smalltalk');
    const events = db.prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE event_type='usefulness'`).get() as { n: number };
    expect(events.n).toBe(0);
  });

  it('gates prompts below minPromptChars', () => {
    seed(db, 'Use SQLite not Postgres', 0.9, 'h-pol-3');
    const d = decideInjection(db, cfg({ minPromptChars: 12 }), { repo: 'r1', prompt: 'fix bug', now: Date.now() });
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('prompt-too-short');
  });

  it('memory references override the gates ("what did we decide last time")', () => {
    seed(db, 'Use SQLite not Postgres', 0.9, 'h-pol-4');
    const d = decideInjection(db, cfg(), { repo: 'r1', prompt: 'last time?', now: Date.now() });
    expect(d.inject).toBe(true);
  });

  it('filters memories below minScore (weak pack is worse than none)', () => {
    // Old + low-importance memory → tiny score.
    const id = seed(db, 'ancient trivia', 0.1, 'h-pol-5');
    const monthsAgo = Date.now() - 1000 * 60 * 60 * 24 * 120;
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(monthsAgo, id);

    const d = decideInjection(db, cfg({ minScore: 0.15 }), {
      repo: 'r1',
      prompt: 'implement the new authentication middleware for the daemon',
      now: Date.now(),
    });
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('below-min-score');
  });

  it('policy disabled → legacy always-inject behavior', () => {
    seed(db, 'Use SQLite not Postgres', 0.9, 'h-pol-6');
    const d = decideInjection(db, cfg({ enabled: false }), { repo: 'r1', prompt: 'hi', now: Date.now() });
    expect(d.inject).toBe(true);
  });

  it('empty repo → no-eligible-memories', () => {
    const d = decideInjection(db, cfg(), {
      repo: 'empty-repo',
      prompt: 'a long and substantive prompt about implementing things',
      now: Date.now(),
    });
    expect(d.inject).toBe(false);
    expect(d.reason).toBe('no-eligible-memories');
  });
});

describe('shrinkBudgetForPrompt (4d token-budget awareness)', () => {
  it('keeps the base budget for normal prompts and shrinks for huge ones, with a floor', () => {
    expect(shrinkBudgetForPrompt(1500, 500)).toBe(1500);
    expect(shrinkBudgetForPrompt(1500, 4_000)).toBe(1500);
    const shrunk = shrinkBudgetForPrompt(1500, 12_000);
    expect(shrunk).toBeLessThan(1500);
    expect(shrinkBudgetForPrompt(1500, 100_000)).toBe(300); // floor
  });
});

describe('POST /recall/pack with prompt (4d REST surface)', () => {
  it('returns a decision block; smalltalk prompt yields empty pack; legacy no-prompt path unchanged', async () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db, 'Use SQLite not Postgres', 0.9, 'h-pol-rest');
    const app = await buildApp({ db, token: 't' });

    const gated = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'r1', prompt: 'thanks!' },
    });
    expect(gated.statusCode).toBe(200);
    expect(gated.json().decision).toMatchObject({ inject: false, reason: 'smalltalk' });
    expect(gated.json().pack).toBe('');

    const injected = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'r1', prompt: 'refactor the storage layer to support lancedb as well' },
    });
    expect(injected.json().decision).toMatchObject({ inject: true, reason: 'injected' });
    expect(injected.json().pack).toContain('Use SQLite');

    const legacy = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'r1' },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().decision).toBeUndefined();
    expect(legacy.json().pack).toContain('Use SQLite');
  });
});
