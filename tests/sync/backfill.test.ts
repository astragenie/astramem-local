// sync backfill — bulk-promote + payload backfill (astramem-local#3).

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { planBackfill, applyBackfill, planReship, applyReship } from '../../src/sync/backfill.js';

type Scope = 'personal' | 'team' | 'org';

/** Seed a memory + its create event. `withPayload=false` mimics a pre-#86
 *  create event (null payload). Returns the atom id. */
function seed(db: DB, opts: { scope: Scope; hash: string; project?: string | null; withPayload?: boolean; synced?: boolean }): string {
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  const id = repo.insert({
    type: 'fact', text: `text ${opts.hash}`, normalized_text: `text ${opts.hash}`,
    repo: null, project: opts.project ?? null, branch: null, agent: null,
    session_id: null, hash: opts.hash, source_hash: null, scope: opts.scope,
  });
  const seq = events.append({
    event_type: 'create', atom_id: id, content_hash: opts.hash,
    ...(opts.withPayload ? { payload: { text: `text ${opts.hash}`, type: 'fact', scope: opts.scope } } : {}),
  });
  if (opts.synced) db.prepare('UPDATE memory_events SET synced_at = ? WHERE seq = ?').run(Date.now(), seq);
  return id;
}

describe('sync backfill', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('planBackfill counts personal, shareable, and null-payload unsynced creates', () => {
    seed(db, { scope: 'personal', hash: 'p1', withPayload: false });
    seed(db, { scope: 'personal', hash: 'p2', withPayload: false });
    seed(db, { scope: 'team', hash: 't1', withPayload: false });
    seed(db, { scope: 'team', hash: 't2', withPayload: true }); // already has payload → not counted

    const plan = planBackfill(db, { scope: 'team' });
    expect(plan.personalToPromote).toBe(2);
    expect(plan.alreadyShareable).toBe(2);
    expect(plan.createEventsToBackfill).toBe(3); // p1, p2, t1 (t2 has payload)
  });

  it('planBackfill is read-only (no mutation)', () => {
    seed(db, { scope: 'personal', hash: 'ro1', withPayload: false });
    planBackfill(db, { scope: 'team' });
    expect((db.prepare(`SELECT COUNT(*) n FROM memories WHERE scope='personal'`).get() as { n: number }).n).toBe(1);
  });

  it('applyBackfill promotes personal → target and backfills create payloads', () => {
    const p = seed(db, { scope: 'personal', hash: 'ap1', withPayload: false });

    const result = applyBackfill(db, { scope: 'team' });
    expect(result.promoted).toBe(1);
    expect(result.backfilled).toBe(1);

    // memory promoted
    expect((db.prepare('SELECT scope FROM memories WHERE id=?').get(p) as { scope: string }).scope).toBe('team');
    // create event now carries content, scope reflects the promotion
    const ev = db.prepare(`SELECT payload_json FROM memory_events WHERE atom_id=? AND event_type='create'`).get(p) as { payload_json: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ text: 'text ap1', type: 'fact', scope: 'team' });
    // promote_scope event was emitted too
    expect((db.prepare(`SELECT COUNT(*) n FROM memory_events WHERE atom_id=? AND event_type='promote_scope'`).get(p) as { n: number }).n).toBe(1);
  });

  it('is idempotent — a second apply promotes/backfills nothing', () => {
    seed(db, { scope: 'personal', hash: 'idem1', withPayload: false });
    applyBackfill(db, { scope: 'team' });
    const second = applyBackfill(db, { scope: 'team' });
    expect(second).toEqual({ promoted: 0, backfilled: 0 });
  });

  it('never touches already-synced create events (cloud dedups by atom_id)', () => {
    const s = seed(db, { scope: 'team', hash: 'synced1', withPayload: false, synced: true });
    const result = applyBackfill(db, { scope: 'team' });
    expect(result.backfilled).toBe(0);
    const ev = db.prepare(`SELECT payload_json FROM memory_events WHERE atom_id=? AND event_type='create'`).get(s) as { payload_json: string | null };
    expect(ev.payload_json).toBeNull();
  });

  it('respects the --project filter', () => {
    seed(db, { scope: 'personal', hash: 'proj-a', project: 'A', withPayload: false });
    seed(db, { scope: 'personal', hash: 'proj-b', project: 'B', withPayload: false });

    const result = applyBackfill(db, { scope: 'team', project: 'A' });
    expect(result.promoted).toBe(1);
    expect((db.prepare(`SELECT scope FROM memories WHERE project='B'`).get() as { scope: string }).scope).toBe('personal');
  });

  it('promotes to org when requested (cloud: shared)', () => {
    const p = seed(db, { scope: 'personal', hash: 'org1', withPayload: false });
    applyBackfill(db, { scope: 'org' });
    expect((db.prepare('SELECT scope FROM memories WHERE id=?').get(p) as { scope: string }).scope).toBe('org');
  });
});

// astramem-local#97 / memory#629 — reship already-synced, null-payload
// team/org create events so their empty cloud replica gets re-materialized.
describe('sync backfill --reship', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('planReship counts already-synced, null-payload team/org creates', () => {
    seed(db, { scope: 'team', hash: 'rs-t1', withPayload: false, synced: true }); // pre-#86, shipped empty → counted
    seed(db, { scope: 'org', hash: 'rs-o1', withPayload: false, synced: true }); // counted
    seed(db, { scope: 'team', hash: 'rs-t2', withPayload: true, synced: true }); // already has payload → not counted
    seed(db, { scope: 'team', hash: 'rs-t3', withPayload: false, synced: false }); // unsynced → not counted (normal backfill's job)
    seed(db, { scope: 'personal', hash: 'rs-p1', withPayload: false, synced: true }); // personal → never counted

    const plan = planReship(db, {});
    expect(plan.scope).toBe('team+org');
    expect(plan.createEventsToBackfillAndReship).toBe(2);
  });

  it('planReship is read-only (no mutation)', () => {
    const id = seed(db, { scope: 'team', hash: 'rs-ro1', withPayload: false, synced: true });
    planReship(db, {});
    const ev = db.prepare(`SELECT payload_json, synced_at FROM memory_events WHERE atom_id=? AND event_type='create'`).get(id) as {
      payload_json: string | null;
      synced_at: number | null;
    };
    expect(ev.payload_json).toBeNull();
    expect(ev.synced_at).not.toBeNull();
  });

  it('applyReship backfills payload and resets synced_at on synced null-payload creates', () => {
    const id = seed(db, { scope: 'team', hash: 'rs-ap1', withPayload: false, synced: true });

    const result = applyReship(db, {});
    expect(result.reshipped).toBe(1);

    const ev = db.prepare(`SELECT payload_json, synced_at FROM memory_events WHERE atom_id=? AND event_type='create'`).get(id) as {
      payload_json: string;
      synced_at: number | null;
    };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ text: 'text rs-ap1', type: 'fact', scope: 'team' });
    expect(ev.synced_at).toBeNull();
  });

  it('leaves non-null-payload synced events alone', () => {
    const id = seed(db, { scope: 'team', hash: 'rs-np1', withPayload: true, synced: true });

    const result = applyReship(db, {});
    expect(result.reshipped).toBe(0);

    const ev = db.prepare(`SELECT synced_at FROM memory_events WHERE atom_id=? AND event_type='create'`).get(id) as { synced_at: number | null };
    expect(ev.synced_at).not.toBeNull(); // untouched — still synced
  });

  it('never touches personal-scope creates, even if null-payload and synced', () => {
    const id = seed(db, { scope: 'personal', hash: 'rs-pers1', withPayload: false, synced: true });

    const result = applyReship(db, {});
    expect(result.reshipped).toBe(0);

    const ev = db.prepare(`SELECT payload_json, synced_at FROM memory_events WHERE atom_id=? AND event_type='create'`).get(id) as {
      payload_json: string | null;
      synced_at: number | null;
    };
    expect(ev.payload_json).toBeNull();
    expect(ev.synced_at).not.toBeNull();
  });

  it('is idempotent — a second apply reships nothing new', () => {
    seed(db, { scope: 'team', hash: 'rs-idem1', withPayload: false, synced: true });
    applyReship(db, {});
    const second = applyReship(db, {});
    expect(second).toEqual({ reshipped: 0 });
  });

  it('respects the scope filter — org filter excludes team rows', () => {
    seed(db, { scope: 'team', hash: 'rs-scope-t', withPayload: false, synced: true });
    seed(db, { scope: 'org', hash: 'rs-scope-o', withPayload: false, synced: true });

    const plan = planReship(db, { scope: 'org' });
    expect(plan.scope).toBe('org');
    expect(plan.createEventsToBackfillAndReship).toBe(1);

    const result = applyReship(db, { scope: 'org' });
    expect(result.reshipped).toBe(1);

    const teamEv = db.prepare(`SELECT payload_json FROM memory_events WHERE event_type='create' AND payload_json IS NULL`).all() as { payload_json: null }[];
    expect(teamEv.length).toBe(1); // the team row is still untouched (null payload)
  });

  it('respects the --project filter', () => {
    seed(db, { scope: 'team', hash: 'rs-proj-a', project: 'A', withPayload: false, synced: true });
    seed(db, { scope: 'team', hash: 'rs-proj-b', project: 'B', withPayload: false, synced: true });

    const result = applyReship(db, { project: 'A' });
    expect(result.reshipped).toBe(1);

    const bEv = db.prepare(`SELECT payload_json FROM memory_events e JOIN memories m ON m.id = e.atom_id WHERE m.project='B'`).get() as {
      payload_json: string | null;
    };
    expect(bEv.payload_json).toBeNull();
  });
});
