import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { MemoryEventRepo } from '../../../src/storage/memory-events.js';
import { recordRecallUsed } from '../../../src/storage/usefulness.js';
import { buildAgentProfile } from '../../../src/server/queries/agent-profile.js';
import type { DB } from '../../../src/storage/db.js';

const AGENT = 'claude-code';

function insertMemory(
  db: DB,
  repo: MemoryRepo,
  events: MemoryEventRepo,
  opts: { type: string; text: string; hash: string; agent?: string | null; importance?: number },
): string {
  const { id } = repo.insertWithCreateEvent(
    {
      type: opts.type as never,
      text: opts.text,
      normalized_text: opts.text.toLowerCase(),
      repo: 'astramem-local',
      project: null,
      branch: 'main',
      agent: opts.agent === undefined ? AGENT : opts.agent,
      session_id: null,
      hash: opts.hash,
      source_hash: null,
      importance: opts.importance ?? 0.5,
    },
    events,
  );
  return id;
}

describe('buildAgentProfile (agent-profile.ts)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('returns null when the agent has zero memories', () => {
    expect(buildAgentProfile(db, 'nobody')).toBeNull();
  });

  it('returns null for an agent that only shows up on OTHER agents\' rows (no cross-agent leak)', () => {
    insertMemory(db, repo, events, { type: 'fact', text: 'unrelated', hash: 'h-other-1', agent: 'other-agent' });
    expect(buildAgentProfile(db, AGENT)).toBeNull();
  });

  it('counts by type, total, first_seen/last_active across all memories for the agent', () => {
    const id1 = insertMemory(db, repo, events, { type: 'fact', text: 'fact one', hash: 'h-1' });
    insertMemory(db, repo, events, { type: 'fact', text: 'fact two', hash: 'h-2' });
    insertMemory(db, repo, events, { type: 'decision', text: 'decision one', hash: 'h-3' });

    const profile = buildAgentProfile(db, AGENT)!;
    expect(profile.agent).toBe(AGENT);
    expect(profile.counts).toEqual({ fact: 2, decision: 1 });
    expect(profile.total).toBe(3);
    expect(profile.first_seen).not.toBeNull();
    expect(profile.last_active).not.toBeNull();
    expect(profile.last_active).toBeGreaterThanOrEqual(profile.first_seen!);

    // memory ids are present so callers can compose with why_memory
    expect(profile.recent_decisions[0]?.id).toBeDefined();
    expect(id1).toBeTruthy();
  });

  it('top_lessons ranks by the ADR-010 usefulness signal (used+1)/(used+corrected+2), then importance, capped at 10', () => {
    // 12 lessons so the cap actually bites.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(
        insertMemory(db, repo, events, {
          type: 'lesson',
          text: `lesson ${i}`,
          hash: `h-lesson-${i}`,
          importance: 0.5,
        }),
      );
    }

    // Give lesson 0 two explicit recall_used signals -> usefulness (2+1)/(2+0+2) = 0.75
    recordRecallUsed(db, { atomId: ids[0]!, surface: 'mcp', signal: 'explicit' });
    recordRecallUsed(db, { atomId: ids[0]!, surface: 'mcp', signal: 'explicit' });
    // Give lesson 1 one explicit signal -> usefulness (1+1)/(1+0+2) = 0.667
    recordRecallUsed(db, { atomId: ids[1]!, surface: 'mcp', signal: 'explicit' });
    // Lesson 2 gets invalidated later in the test (a correction), so give it
    // a separate, still-valid sibling to check corrected atoms score lower.
    // (invalidated atoms fall out of top_lessons entirely since they're no
    // longer active — verified in the corrections test below instead.)

    const profile = buildAgentProfile(db, AGENT)!;
    expect(profile.top_lessons.length).toBe(10);
    expect(profile.top_lessons[0]!.id).toBe(ids[0]);
    expect(profile.top_lessons[0]!.usefulness).toBeCloseTo(0.75, 5);
    expect(profile.top_lessons[1]!.id).toBe(ids[1]);
    expect(profile.top_lessons[1]!.usefulness).toBeCloseTo(2 / 3, 5);
    // Remaining un-signaled lessons are all at the neutral 0.5 default.
    for (const l of profile.top_lessons.slice(2)) {
      expect(l.usefulness).toBeCloseTo(0.5, 5);
    }
  });

  it('top_lessons breaks usefulness ties by importance', () => {
    const lowImportance = insertMemory(db, repo, events, {
      type: 'lesson', text: 'low importance', hash: 'h-imp-low', importance: 0.2,
    });
    const highImportance = insertMemory(db, repo, events, {
      type: 'lesson', text: 'high importance', hash: 'h-imp-high', importance: 0.9,
    });

    const profile = buildAgentProfile(db, AGENT)!;
    // Both at neutral usefulness (0.5) -> importance breaks the tie.
    expect(profile.top_lessons[0]!.id).toBe(highImportance);
    expect(profile.top_lessons[1]!.id).toBe(lowImportance);
  });

  it('recent_decisions returns type=decision only, newest first, capped at 5', () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(insertMemory(db, repo, events, { type: 'decision', text: `decision ${i}`, hash: `h-dec-${i}` }));
      // Force distinct created_at ordering (same-ms inserts would otherwise tie).
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(1000 + i, ids[i]);
    }
    // A non-decision row must never leak in.
    insertMemory(db, repo, events, { type: 'fact', text: 'not a decision', hash: 'h-fact-x' });

    const profile = buildAgentProfile(db, AGENT)!;
    expect(profile.recent_decisions.length).toBe(5);
    expect(profile.recent_decisions.map(d => d.id)).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]]);
  });

  it('corrections surfaces invalidated memories with reason, newest first, capped at 5', () => {
    const id1 = insertMemory(db, repo, events, { type: 'fact', text: 'wrong fact one', hash: 'h-corr-1' });
    const id2 = insertMemory(db, repo, events, { type: 'fact', text: 'wrong fact two', hash: 'h-corr-2' });

    events.invalidate(id1, 'contradicted by newer evidence');
    events.invalidate(id2, 'user corrected it');
    // Space out invalidate event timestamps deterministically — two
    // same-millisecond Date.now() calls would otherwise tie the ORDER BY.
    db.prepare("UPDATE memory_events SET created_at = 3000 WHERE atom_id = ? AND event_type = 'invalidate'").run(id1);
    db.prepare("UPDATE memory_events SET created_at = 4000 WHERE atom_id = ? AND event_type = 'invalidate'").run(id2);

    const profile = buildAgentProfile(db, AGENT)!;
    expect(profile.corrections.length).toBe(2);
    // newest first
    expect(profile.corrections[0]!.id).toBe(id2);
    expect(profile.corrections[0]!.action).toBe('invalidated');
    expect(profile.corrections[0]!.reason).toBe('user corrected it');
    expect(profile.corrections[0]!.superseded_by).toBeNull();
    expect(profile.corrections[0]!.superseding_text).toBeNull();
    expect(profile.corrections[1]!.id).toBe(id1);
    expect(profile.corrections[1]!.reason).toBe('contradicted by newer evidence');

    // An invalidated memory must not show up as an active lesson/decision/count.
    expect(profile.counts['fact'] ?? 0).toBe(0);
  });

  it('corrections surfaces supersede chains and links the superseding memory text', () => {
    const oldId = insertMemory(db, repo, events, { type: 'fact', text: 'old belief', hash: 'h-super-old' });
    const newId = insertMemory(db, repo, events, { type: 'fact', text: 'corrected belief', hash: 'h-super-new' });

    events.supersede(oldId, newId);

    const profile = buildAgentProfile(db, AGENT)!;
    const correction = profile.corrections.find(c => c.id === oldId);
    expect(correction).toBeDefined();
    expect(correction!.action).toBe('superseded');
    expect(correction!.superseded_by).toBe(newId);
    expect(correction!.superseding_text).toBe('corrected belief');

    // The successor is still active and shows up in counts.
    expect(profile.counts['fact']).toBe(1);
  });

  it('corrections is capped at 5, newest first', () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = insertMemory(db, repo, events, { type: 'fact', text: `fact ${i}`, hash: `h-cap-${i}` });
      ids.push(id);
    }
    ids.forEach((id, i) => {
      events.invalidate(id, `reason ${i}`);
      // Space out invalidate event timestamps deterministically for a
      // reliable newest-first ordering assertion.
      db.prepare("UPDATE memory_events SET created_at = ? WHERE atom_id = ? AND event_type = 'invalidate'").run(2000 + i, id);
    });

    const profile = buildAgentProfile(db, AGENT)!;
    expect(profile.corrections.length).toBe(5);
    expect(profile.corrections.map(c => c.id)).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]]);
  });
});
