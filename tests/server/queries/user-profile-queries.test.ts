import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { MemoryEventRepo } from '../../../src/storage/memory-events.js';
import { EntityRepo } from '../../../src/storage/entities.js';
import { recordRecallUsed } from '../../../src/storage/usefulness.js';
import { buildUserProfile } from '../../../src/server/queries/user-profile.js';
import type { DB } from '../../../src/storage/db.js';
import type { MemoryScope } from '../../../src/contracts/index.js';

function insertMemory(
  db: DB,
  repo: MemoryRepo,
  events: MemoryEventRepo,
  opts: { type: string; text: string; hash: string; importance?: number; scope?: MemoryScope; evidence?: string | null },
): string {
  const { id } = repo.insertWithCreateEvent(
    {
      type: opts.type as never,
      text: opts.text,
      normalized_text: opts.text.toLowerCase(),
      repo: 'astramem-local',
      project: null,
      branch: 'main',
      agent: 'claude-code',
      session_id: null,
      hash: opts.hash,
      source_hash: null,
      importance: opts.importance ?? 0.5,
      scope: opts.scope,
      evidence: opts.evidence,
    },
    events,
  );
  return id;
}

describe('buildUserProfile (user-profile.ts)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;
  let entities: EntityRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
    entities = new EntityRepo(db);
  });

  it('returns an empty-but-shaped profile when there is no data', () => {
    const profile = buildUserProfile(db);
    expect(profile.scope).toBe('private');
    expect(profile.standing_facts).toEqual([]);
    expect(profile.preferences).toEqual([]);
    expect(profile.recurring_lessons).toEqual([]);
    expect(profile.recent_decisions).toEqual([]);
    expect(profile.known_entities).toEqual([]);
    expect(profile.counts).toEqual({});
    expect(profile.total).toBe(0);
    expect(typeof profile.generated_at).toBe('number');
  });

  it('rolls up fact -> standing_facts, note -> preferences, lesson -> recurring_lessons, decision -> recent_decisions', () => {
    const factId = insertMemory(db, repo, events, { type: 'fact', text: 'the sky is blue', hash: 'h-fact-1', evidence: 'observed directly' });
    const noteId = insertMemory(db, repo, events, { type: 'note', text: 'prefers dark mode', hash: 'h-note-1' });
    const lessonId = insertMemory(db, repo, events, { type: 'lesson', text: 'always check the logs first', hash: 'h-lesson-1' });
    const decisionId = insertMemory(db, repo, events, { type: 'decision', text: 'use SQLite', hash: 'h-decision-1' });
    // command/todo/event are deliberately excluded from v1 (design doc §1).
    insertMemory(db, repo, events, { type: 'command', text: 'npm test', hash: 'h-command-1' });
    insertMemory(db, repo, events, { type: 'todo', text: 'write more tests', hash: 'h-todo-1' });
    insertMemory(db, repo, events, { type: 'event', text: 'deployed to prod', hash: 'h-event-1' });

    const profile = buildUserProfile(db);

    expect(profile.standing_facts.map(i => i.id)).toEqual([factId]);
    expect(profile.standing_facts[0]!.evidence).toBe('observed directly');
    expect(profile.preferences.map(i => i.id)).toEqual([noteId]);
    expect(profile.recurring_lessons.map(i => i.id)).toEqual([lessonId]);
    expect(profile.recent_decisions.map(i => i.id)).toEqual([decisionId]);

    expect(profile.counts).toEqual({ fact: 1, note: 1, lesson: 1, decision: 1 });
    expect(profile.total).toBe(4);
  });

  it('scored sections rank by usefulness DESC, importance DESC, id ASC', () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(insertMemory(db, repo, events, { type: 'fact', text: `fact ${i}`, hash: `h-rank-${i}`, importance: 0.5 }));
    }
    // ids[0] gets an explicit used signal -> usefulness (1+1)/(1+0+2) = 0.667, beats the neutral 0.5 default.
    recordRecallUsed(db, { atomId: ids[0]!, surface: 'mcp', signal: 'explicit' });

    const profile = buildUserProfile(db);
    expect(profile.standing_facts[0]!.id).toBe(ids[0]);
    expect(profile.standing_facts[0]!.usefulness).toBeCloseTo(2 / 3, 5);
    // Remaining two are tied on usefulness (0.5) and importance (0.5) -> id ASC tie-break.
    const remaining = profile.standing_facts.slice(1).map(i => i.id);
    expect(remaining).toEqual([...remaining].sort());
  });

  it('scored sections cap at 10', () => {
    for (let i = 0; i < 12; i++) {
      insertMemory(db, repo, events, { type: 'lesson', text: `lesson ${i}`, hash: `h-lesson-cap-${i}` });
    }
    const profile = buildUserProfile(db);
    expect(profile.recurring_lessons.length).toBe(10);
  });

  it('recent_decisions is newest-first and capped at 5', () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = insertMemory(db, repo, events, { type: 'decision', text: `decision ${i}`, hash: `h-dec-${i}` });
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(1000 + i, id);
      ids.push(id);
    }
    const profile = buildUserProfile(db);
    expect(profile.recent_decisions.length).toBe(5);
    expect(profile.recent_decisions.map(d => d.id)).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]]);
  });

  it('known_entities rolls up linked entities of kind actor/tech/product/tool, ranked by mention count, capped at 10', () => {
    const memId1 = insertMemory(db, repo, events, { type: 'fact', text: 'we use Postgres', hash: 'h-ent-1' });
    const memId2 = insertMemory(db, repo, events, { type: 'fact', text: 'Postgres is fast', hash: 'h-ent-2' });
    const memId3 = insertMemory(db, repo, events, { type: 'lesson', text: 'vitest is nice', hash: 'h-ent-3' });

    const pgId = entities.upsert('Postgres', 'tech');
    entities.link(memId1, pgId);
    entities.link(memId2, pgId);
    const vitestId = entities.upsert('vitest', 'tool');
    entities.link(memId3, vitestId);
    // A 'concept' kind entity must NOT show up in known_entities (design doc §1 kind filter).
    const conceptMemId = insertMemory(db, repo, events, { type: 'fact', text: 'CQRS pattern', hash: 'h-ent-4' });
    const conceptId = entities.upsert('CQRS', 'concept');
    entities.link(conceptMemId, conceptId);

    const profile = buildUserProfile(db);
    expect(profile.known_entities).toEqual([
      { name: 'postgres', kind: 'tech', mention_count: 2 },
      { name: 'vitest', kind: 'tool', mention_count: 1 },
    ]);
  });

  it('lifecycle correctness (AC-3): invalidated/superseded atoms drop out of the profile', () => {
    const factId = insertMemory(db, repo, events, { type: 'fact', text: 'wrong fact', hash: 'h-lifecycle-1' });
    const lessonId = insertMemory(db, repo, events, { type: 'lesson', text: 'old lesson', hash: 'h-lifecycle-2' });
    const newLessonId = insertMemory(db, repo, events, { type: 'lesson', text: 'new lesson', hash: 'h-lifecycle-3' });

    events.invalidate(factId, 'wrong');
    events.supersede(lessonId, newLessonId);

    const profile = buildUserProfile(db);
    expect(profile.standing_facts).toEqual([]);
    expect(profile.recurring_lessons.map(i => i.id)).toEqual([newLessonId]);
    expect(profile.counts['fact'] ?? 0).toBe(0);
    expect(profile.counts['lesson']).toBe(1);
  });

  it('defaults to scope=private and excludes team/org rows', () => {
    insertMemory(db, repo, events, { type: 'fact', text: 'private fact', hash: 'h-scope-1', scope: 'private' });
    insertMemory(db, repo, events, { type: 'fact', text: 'team fact', hash: 'h-scope-2', scope: 'team' });
    insertMemory(db, repo, events, { type: 'fact', text: 'org fact', hash: 'h-scope-3', scope: 'org' });

    const privateProfile = buildUserProfile(db);
    expect(privateProfile.standing_facts.length).toBe(1);
    expect(privateProfile.standing_facts[0]!.text).toBe('private fact');

    const teamProfile = buildUserProfile(db, 'team');
    expect(teamProfile.standing_facts.length).toBe(1);
    expect(teamProfile.standing_facts[0]!.text).toBe('team fact');

    const allProfile = buildUserProfile(db, 'all');
    expect(allProfile.standing_facts.length).toBe(3);
  });
});
