// Wave 4a — Anthropic memory-tool backend adapter (ADR-007).

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { handleMemoryToolCommand } from '../../src/memory-tool/adapter.js';
import { defaultConfig } from '../../src/config/config.js';
import { buildApp } from '../../src/server/app.js';

const cfg = defaultConfig();

function seed(db: DB, type: 'decision' | 'fact', text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type, text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

describe('memory-tool adapter (4a)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('view /memories lists type files; view of a type file renders id-tagged bullets', () => {
    seed(db, 'decision', 'Use SQLite', 'h-mt-1');
    seed(db, 'fact', 'port is 7777', 'h-mt-2');

    const root = handleMemoryToolCommand(db, cfg, { command: 'view', path: '/memories' });
    expect(root).toHaveProperty('content');
    expect((root as { content: string }).content).toContain('decision.md');
    expect((root as { content: string }).content).toContain('fact.md');

    const file = handleMemoryToolCommand(db, cfg, { command: 'view', path: '/memories/decision.md' });
    expect((file as { content: string }).content).toMatch(/^- \[[0-9a-f-]+\] Use SQLite$/m);
  });

  it('view respects view_range and rejects invalid ranges', () => {
    seed(db, 'fact', 'one', 'h-mt-r1');
    seed(db, 'fact', 'two', 'h-mt-r2');
    const ranged = handleMemoryToolCommand(db, cfg, {
      command: 'view', path: '/memories/fact.md', view_range: [2, 2],
    });
    expect((ranged as { content: string }).content).toContain('two');
    expect((ranged as { content: string }).content).not.toContain('one');

    const bad = handleMemoryToolCommand(db, cfg, {
      command: 'view', path: '/memories/fact.md', view_range: [9, 9],
    });
    expect(bad).toHaveProperty('error');
  });

  it('create inserts one redacted memory (secrets never persist)', () => {
    const token = `ghp_${'HKNQTWZcfilorux0369CFILORUXadgjmpsvy'}`;
    const res = handleMemoryToolCommand(db, cfg, {
      command: 'create', path: '/memories/note.md',
      file_text: `deploy uses token ${token} for CI`,
    });
    expect(res).toHaveProperty('content');

    const row = db.prepare(`SELECT text FROM memories WHERE type = 'note'`).get() as { text: string };
    expect(row.text).toContain('[REDACTED:github_token:');
    expect(row.text).not.toContain(token);
    // create event appended (ADR-002)
    const events = db.prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE event_type = 'create'`).get() as { n: number };
    expect(events.n).toBe(1);
  });

  it('create with an unknown type slug falls back to note', () => {
    handleMemoryToolCommand(db, cfg, {
      command: 'create', path: '/memories/random_ideas.md', file_text: 'an idea',
    });
    const row = db.prepare(`SELECT type FROM memories`).get() as { type: string };
    expect(row.type).toBe('note');
  });

  // astramem-local#84: content_hash must be a full 64-char sha256 hex digest
  // (contracts/schemas/sync-envelope.v1.schema.json pattern ^[a-f0-9]{64}$),
  // not the legacy 32-char truncation. Exercises the real adapter hash site
  // (src/memory-tool/adapter.ts handleCreateOrInsert), not a synthetic value.
  it('create stores a full 64-char sha256 hex content hash, not a 32-char truncation', () => {
    handleMemoryToolCommand(db, cfg, {
      command: 'create', path: '/memories/fact.md', file_text: 'astramem-local#84: adapter hash must be 64 chars',
    });
    const row = db.prepare(`SELECT id, hash FROM memories WHERE type = 'fact'`).get() as { id: string; hash: string };
    expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
    const event = db.prepare(`SELECT content_hash FROM memory_events WHERE atom_id = ? AND event_type = 'create'`).get(row.id) as { content_hash: string };
    expect(event.content_hash).toBe(row.hash);
  });

  it('str_replace supersedes: old invalid + linked, new valid', () => {
    const oldId = seed(db, 'decision', 'Use Postgres for storage', 'h-mt-sr');
    const res = handleMemoryToolCommand(db, cfg, {
      command: 'str_replace', path: '/memories/decision.md',
      old_str: 'Postgres', new_str: 'SQLite',
    });
    expect(res).toHaveProperty('content');

    const old = new MemoryRepo(db).get(oldId)!;
    expect(old.valid_to).not.toBeNull();
    expect(old.superseded_by).not.toBeNull();
    const successor = new MemoryRepo(db).get(old.superseded_by!)!;
    expect(successor.text).toBe('Use SQLite for storage');
    expect(successor.valid_to).toBeNull();
    // astramem-local#84: str_replace's hash site (adapter.ts handleStrReplace)
    // must also produce a full 64-char digest, not the legacy 32-char one.
    expect(successor.hash).toMatch(/^[a-f0-9]{64}$/);
    // history chain recorded
    const history = new MemoryEventRepo(db).listForAtom(oldId).map(e => e.event_type);
    expect(history).toContain('supersede');
  });

  it('str_replace errors on zero and on ambiguous matches', () => {
    seed(db, 'decision', 'alpha rule', 'h-mt-a1');
    seed(db, 'decision', 'alpha policy', 'h-mt-a2');
    const none = handleMemoryToolCommand(db, cfg, {
      command: 'str_replace', path: '/memories/decision.md', old_str: 'zzz', new_str: 'x',
    });
    expect(none).toHaveProperty('error');
    const ambiguous = handleMemoryToolCommand(db, cfg, {
      command: 'str_replace', path: '/memories/decision.md', old_str: 'alpha', new_str: 'beta',
    });
    expect((ambiguous as { error: string }).error).toContain('must match exactly one');
  });

  it('delete per-id erases (row gone, tombstone remains)', () => {
    const id = seed(db, 'fact', 'ephemeral', 'h-mt-d1');
    const res = handleMemoryToolCommand(db, cfg, {
      command: 'delete', path: `/memories/fact.md/${id}`,
    });
    expect(res).toHaveProperty('content');
    expect(db.prepare('SELECT 1 FROM memories WHERE id = ?').get(id)).toBeUndefined();
    const tomb = db.prepare(
      `SELECT COUNT(*) AS n FROM memory_events WHERE event_type = 'erase_request' AND atom_id = ?`,
    ).get(id) as { n: number };
    expect(tomb.n).toBe(1);
  });

  it('whole-file delete erases every current memory of the type', () => {
    seed(db, 'fact', 'one', 'h-mt-w1');
    seed(db, 'fact', 'two', 'h-mt-w2');
    const res = handleMemoryToolCommand(db, cfg, { command: 'delete', path: '/memories/fact.md' });
    expect((res as { content: string }).content).toContain('erased 2');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE type='fact'`).get() as { n: number }).n).toBe(0);
  });

  it('rename and unknown commands/paths return errors, never throw', () => {
    expect(handleMemoryToolCommand(db, cfg, {
      command: 'rename', path: '/memories/fact.md', old_path: '/memories/fact.md', new_path: '/memories/note.md',
    })).toHaveProperty('error');
    expect(handleMemoryToolCommand(db, cfg, { command: 'wat', path: '/memories' })).toHaveProperty('error');
    expect(handleMemoryToolCommand(db, cfg, { command: 'view', path: '/etc/passwd' })).toHaveProperty('error');
    expect(handleMemoryToolCommand(db, cfg, { command: 'view', path: '/memories/../../etc.md' })).toHaveProperty('error');
  });
});

describe('POST /memory-tool (4a REST relay)', () => {
  it('roundtrips a view command; 400 without command; 401 without bearer', async () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db, 'decision', 'Use SQLite', 'h-mt-rest');
    const app = await buildApp({ db, token: 't' });

    const ok = await app.inject({
      method: 'POST', url: '/memory-tool',
      headers: { authorization: 'Bearer t' },
      payload: { command: 'view', path: '/memories/decision.md' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().content).toContain('Use SQLite');

    const bad = await app.inject({
      method: 'POST', url: '/memory-tool',
      headers: { authorization: 'Bearer t' },
      payload: { path: '/memories' },
    });
    expect(bad.statusCode).toBe(400);

    const unauthed = await app.inject({
      method: 'POST', url: '/memory-tool',
      payload: { command: 'view', path: '/memories' },
    });
    expect(unauthed.statusCode).toBe(401);
  });
});
