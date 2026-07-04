import { describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { runTagHygieneBackfill } from '../../src/tag-hygiene/backfill.js';
import { deriveRepoFromCwd } from '../../src/tag-hygiene/derive-repo.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { DB } from '../../src/storage/db.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { Tier2InferFn } from '../../src/tag-hygiene/tier2-infer.js';

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function insertSession(
  db: DB,
  id: string,
  opts: { repo?: string | null; project?: string | null; cwd?: string | null } = {},
): void {
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?)
  `).run(id, opts.repo ?? null, opts.project ?? null, opts.cwd ?? null, Date.now());
}

function insertMemory(
  db: DB,
  opts: { text?: string; repo?: string | null; project?: string | null; session_id?: string | null } = {},
): string {
  const id = randomUUID();
  const now = Date.now();
  const text = opts.text ?? 'some memory text';
  db.prepare(`
    INSERT INTO memories (id, type, text, normalized_text, repo, project, branch, agent, session_id,
      importance, confidence, hash, created_at, updated_at, source_hash)
    VALUES (?, 'fact', ?, ?, ?, ?, NULL, NULL, ?, 0.5, 0.5, ?, ?, ?, NULL)
  `).run(id, text, text.toLowerCase(), opts.repo ?? null, opts.project ?? null, opts.session_id ?? null, randomUUID(), now, now);
  return id;
}

function hashMemoriesTable(db: DB): string {
  const rows = db.prepare('SELECT id, repo, project, updated_at FROM memories ORDER BY id').all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function makeFakeTier2(confidence: number, repo: string | null = 'inferred-repo', project: string | null = 'inferred-proj'): Tier2InferFn {
  return async () => ({ repo, project, confidence });
}

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

describe('deriveRepoFromCwd (tier-1 building block)', () => {
  it('takes the last path segment, POSIX and Windows separators', () => {
    expect(deriveRepoFromCwd('/home/user/my-repo')).toBe('my-repo');
    expect(deriveRepoFromCwd('C:\\work\\my-repo')).toBe('my-repo');
    expect(deriveRepoFromCwd('/home/user/my-repo/')).toBe('my-repo');
    expect(deriveRepoFromCwd(null)).toBeNull();
    expect(deriveRepoFromCwd('')).toBeNull();
  });
});

describe('runTagHygieneBackfill', () => {
  // ---- AC-1: tier-1 derives repo/project from session cwd/project_id ----
  it('AC-1: derives repo from session cwd and project from session project_id', async () => {
    const db = setupDb();
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'proj-alpha', cwd: '/home/user/my-repo' });
    const memId = insertMemory(db, { session_id: sessionId, repo: null, project: null });

    const result = await runTagHygieneBackfill(db, { dryRun: false, tier2Enabled: false, confidenceThreshold: 0.7 });

    expect(result.tier1Applied).toBe(1);
    expect(result.tier2Applied).toBe(0);
    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string; project: string };
    expect(row.repo).toBe('my-repo');
    expect(row.project).toBe('proj-alpha');
    db.close();
  });

  it('AC-1: prefers session.repo over cwd-derived repo when both present', async () => {
    const db = setupDb();
    const sessionId = randomUUID();
    insertSession(db, sessionId, { repo: 'explicit-repo', project: 'proj-alpha', cwd: '/home/user/other-dir' });
    const memId = insertMemory(db, { session_id: sessionId });

    await runTagHygieneBackfill(db, { dryRun: false, tier2Enabled: false, confidenceThreshold: 0.7 });

    const row = db.prepare('SELECT repo FROM memories WHERE id = ?').get(memId) as { repo: string };
    expect(row.repo).toBe('explicit-repo');
    db.close();
  });

  // ---- AC-2: --dry-run prints proposed tags, mutates zero rows ----
  it('AC-2: dry-run proposes tags but mutates zero rows (row-hash before/after)', async () => {
    const db = setupDb();
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'proj-alpha', cwd: '/home/user/my-repo' });
    const memId = insertMemory(db, { session_id: sessionId });
    const before = hashMemoriesTable(db);

    const result = await runTagHygieneBackfill(db, { dryRun: true, tier2Enabled: false, confidenceThreshold: 0.7 });

    const after = hashMemoriesTable(db);
    expect(after).toBe(before);
    expect(result.dryRun).toBe(true);

    const candidate = result.candidates.find(c => c.id === memId)!;
    expect(candidate.proposedRepo).toBe('my-repo');
    expect(candidate.proposedProject).toBe('proj-alpha');
    expect(candidate.applied).toBe(false);
    expect(candidate.tier).toBe(1);

    // Confirm the DB row itself is untouched.
    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string | null; project: string | null };
    expect(row.repo).toBeNull();
    expect(row.project).toBeNull();
    db.close();
  });

  // ---- AC-3: idempotent — re-run on a fully-tagged corpus changes zero rows ----
  it('AC-3: re-running after tags are applied is a pure no-op (zero rows change)', async () => {
    const db = setupDb();
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'proj-alpha', cwd: '/home/user/my-repo' });
    insertMemory(db, { session_id: sessionId });
    // Already-tagged row seeded up front — must never be selected as a candidate.
    insertMemory(db, { repo: 'other-repo', project: 'other-proj' });

    const first = await runTagHygieneBackfill(db, { dryRun: false, tier2Enabled: false, confidenceThreshold: 0.7 });
    expect(first.tier1Applied).toBe(1);

    const hashAfterFirst = hashMemoriesTable(db);
    const second = await runTagHygieneBackfill(db, { dryRun: false, tier2Enabled: false, confidenceThreshold: 0.7 });
    const hashAfterSecond = hashMemoriesTable(db);

    expect(second.scanned).toBe(0);
    expect(second.tier1Applied).toBe(0);
    expect(second.tier2Applied).toBe(0);
    expect(hashAfterSecond).toBe(hashAfterFirst);
    db.close();
  });

  it('AC-3: re-running a corpus that was already fully tagged before any run is a no-op', async () => {
    const db = setupDb();
    insertMemory(db, { repo: 'repo-a', project: 'proj-a' });
    insertMemory(db, { repo: 'repo-b', project: 'proj-b' });

    const result = await runTagHygieneBackfill(db, { dryRun: false, tier2Enabled: false, confidenceThreshold: 0.7 });

    expect(result.scanned).toBe(0);
    expect(result.tier1Applied).toBe(0);
    expect(result.tier2Applied).toBe(0);
    expect(result.leftUntagged).toBe(0);
    db.close();
  });

  // ---- AC-4: tier-2 confidence threshold — never mis-tag below 0.7 ----
  it('AC-4: tier-2 confidence below threshold (0.5 < 0.7) leaves the memory untagged', async () => {
    const db = setupDb();
    // Seed a tagged memory so tier-2's known-vocabulary grounding isn't empty.
    insertMemory(db, { repo: 'seed-repo', project: 'seed-proj' });
    // No session_id — ambiguous/missing session metadata, tier-1 finds nothing.
    const memId = insertMemory(db, { text: 'ambiguous text with no session metadata' });

    const result = await runTagHygieneBackfill(
      db,
      { dryRun: false, tier2Enabled: true, confidenceThreshold: 0.7 },
      makeFakeTier2(0.5),
    );

    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string | null; project: string | null };
    expect(row.repo).toBeNull();
    expect(row.project).toBeNull();
    expect(result.tier2Applied).toBe(0);
    const candidate = result.candidates.find(c => c.id === memId)!;
    expect(candidate.applied).toBe(false);
    expect(candidate.tier).toBeNull();
    expect(candidate.confidence).toBe(0.5);
    db.close();
  });

  it('AC-4: tier-2 confidence at/above threshold (0.85 >= 0.7) applies the inferred tag', async () => {
    const db = setupDb();
    insertMemory(db, { repo: 'seed-repo', project: 'seed-proj' });
    const memId = insertMemory(db, { text: 'clear reference to seed-repo work' });

    const result = await runTagHygieneBackfill(
      db,
      { dryRun: false, tier2Enabled: true, confidenceThreshold: 0.7 },
      makeFakeTier2(0.85, 'seed-repo', 'seed-proj'),
    );

    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string | null; project: string | null };
    expect(row.repo).toBe('seed-repo');
    expect(row.project).toBe('seed-proj');
    expect(result.tier2Applied).toBe(1);
    db.close();
  });

  it('AC-4: tier-2 is never invoked when disabled — memory stays untagged regardless of what an LLM might say', async () => {
    const db = setupDb();
    insertMemory(db, { repo: 'seed-repo', project: 'seed-proj' });
    const memId = insertMemory(db, { text: 'clear reference to seed-repo work' });

    // High-confidence fn provided but tier2Enabled=false — must never be called.
    let called = false;
    const spy: Tier2InferFn = async () => { called = true; return { repo: 'seed-repo', project: 'seed-proj', confidence: 0.99 }; };

    const result = await runTagHygieneBackfill(db, { dryRun: false, tier2Enabled: false, confidenceThreshold: 0.7 }, spy);

    expect(called).toBe(false);
    expect(result.tier2Applied).toBe(0);
    const row = db.prepare('SELECT repo, project FROM memories WHERE id = ?').get(memId) as { repo: string | null; project: string | null };
    expect(row.repo).toBeNull();
    expect(row.project).toBeNull();
    db.close();
  });

  // ---- AC-5: mixed corpus retag must not leak cross-project search hits ----
  it('AC-5: mixed corpus (tagged + untagged-with-session) retag keeps project-scoped search leak-free', async () => {
    const db = setupDb();
    const repo = new MemoryRepo(db);

    // Project alpha: already fully tagged before this run.
    repo.insert({
      type: 'decision',
      text: 'use sqlite for project alpha storage decision',
      normalized_text: 'use sqlite for project alpha storage decision',
      repo: 'repo-a',
      project: 'proj-alpha',
      branch: null,
      agent: null,
      session_id: null,
      hash: randomUUID(),
      source_hash: null,
    });

    // Project beta: untagged row backed by a session with project_id + cwd.
    const sessionB = randomUUID();
    insertSession(db, sessionB, { project: 'proj-beta', cwd: '/work/repo-b' });
    const memBetaId = insertMemory(db, { text: 'sqlite decision atom for project beta', session_id: sessionB });

    const result = await runTagHygieneBackfill(db, { dryRun: false, tier2Enabled: false, confidenceThreshold: 0.7 });
    expect(result.tier1Applied).toBe(1);

    const embed = buildMockEmbed();
    const weights = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1 };

    const hitsAlpha = await search('sqlite', { project: 'proj-alpha' }, 10, { db, embed, weights });
    const hitsBeta = await search('sqlite', { project: 'proj-beta' }, 10, { db, embed, weights });

    // The retagged beta atom must never leak into an alpha-scoped search.
    expect(hitsAlpha.some(h => h.id === memBetaId)).toBe(false);
    // ... and must be findable in its own project's scoped search.
    expect(hitsBeta.some(h => h.id === memBetaId)).toBe(true);
    for (const h of hitsBeta) {
      const row = db.prepare('SELECT project FROM memories WHERE id = ?').get(h.id) as { project: string };
      expect(row.project).toBe('proj-beta');
    }
    for (const h of hitsAlpha) {
      const row = db.prepare('SELECT project FROM memories WHERE id = ?').get(h.id) as { project: string };
      expect(row.project).toBe('proj-alpha');
    }
    db.close();
  });

  it('--limit caps the number of scanned candidates', async () => {
    const db = setupDb();
    const sessionId = randomUUID();
    insertSession(db, sessionId, { project: 'proj-alpha', cwd: '/home/user/my-repo' });
    insertMemory(db, { session_id: sessionId, text: 'one' });
    insertMemory(db, { session_id: sessionId, text: 'two' });
    insertMemory(db, { session_id: sessionId, text: 'three' });

    const result = await runTagHygieneBackfill(db, { dryRun: false, limit: 2, tier2Enabled: false, confidenceThreshold: 0.7 });

    expect(result.scanned).toBe(2);
    db.close();
  });
});
