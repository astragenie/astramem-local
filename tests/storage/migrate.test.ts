import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate, getVecSchemaDim } from '../../src/storage/migrate.js';
import { embedProbe } from '../../src/doctor/probes/embed-probe.js';
import type { EmbedProvider, EmbedHealth } from '../../src/contracts/embed.js';

describe('migrate', () => {
  it('creates schema_version table and applies 001-init', () => {
    const db = openDb(':memory:');
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name: string}[];
    const names = tables.map(t => t.name);
    expect(names).toContain('schema_version');
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('transcripts');
    expect(names).toContain('memories');
    expect(names).toContain('jobs');
    expect(names).toContain('artifacts');
    expect(names).toContain('provider_state');
    expect(names).toContain('budget_spend');
    expect(names).toContain('redaction_log');
  });

  it('is idempotent — second run does nothing', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as {n: number};
    // 23 migration files (001-017: 009 = FEAT-403 tag-hygiene, 010 = FEAT-407 sync-pull,
    // 011 = FEAT-409 embed-dim, 012 = FEAT-402 entities, 013 = FEAT-404 archival,
    // 014 = FEAT-434 sync_ship_state, 015 = astramem-local#84 canonical content_hash,
    // 016 = astramem-local#110 scope personal->private rename, 017 = U4-local #111/#112
    // widen memories.type CHECK 7->10, 018 = jobs distill-session expression index,
    // 019 = memory_events usefulness + memories.agent perf indexes, 020 = follow-up
    // memory_events corrections-join index fixing a regression 019 introduced,
    // 021 = FEAT-442 widen memory_events.event_type CHECK to add 'unsupersede',
    // 022 = FEAT-456 consolidation_proposals.metadata_json, 023 = FEAT-453
    // memory_entities surrogate-PK rebuild + valid_at/invalid_at, 024 =
    // FEAT-455 transcripts/memories.capture_source, 025 = FEAT-467 widen
    // memory_events.event_type CHECK to add 'purge'/'unpurge' + purge_batches).
    expect(versions.n).toBe(25);
  });

  it('enables WAL mode', () => {
    const db = openDb(':memory:');
    migrate(db);
    const mode = db.prepare('PRAGMA journal_mode').get() as {journal_mode: string};
    // :memory: DBs report 'memory', file DBs report 'wal'. Confirm setting attempt didn't error.
    expect(['wal', 'memory']).toContain(mode.journal_mode);
  });
});

describe('migration 002-wire-v1', () => {
  it('adds all new columns to transcripts', () => {
    const db = openDb(':memory:');
    migrate(db);

    const cols = db.prepare("PRAGMA table_info(transcripts)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);

    expect(colNames).toContain('event');
    expect(colNames).toContain('captured_at');
    expect(colNames).toContain('client_scrub_applied');
    expect(colNames).toContain('client_scrub_hits');
    expect(colNames).toContain('client_scrub_version');
    expect(colNames).toContain('client_scrub_hits_by_label_json');
    expect(colNames).toContain('client_version');
    expect(colNames).toContain('wire_version');

    // legacy columns still intact
    expect(colNames).toContain('source');
    expect(colNames).toContain('content');
  });

  it('creates ingest_idempotency table with expected columns', () => {
    const db = openDb(':memory:');
    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('ingest_idempotency');

    const cols = db.prepare("PRAGMA table_info(ingest_idempotency)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('key');
    expect(colNames).toContain('tenant_id');
    expect(colNames).toContain('body_hash');
    expect(colNames).toContain('summary_memory_id');
    expect(colNames).toContain('created_at');
  });

  it('is idempotent — re-running migrate after 002 is already applied does nothing extra', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    // See the "is idempotent — second run does nothing" test above: 25
    // migration files (001-022 + 023 FEAT-453 + 024 FEAT-455 + 025 FEAT-467).
    expect(versions.n).toBe(25);
  });

  it('new rows get wire_version DEFAULT v0.0 when inserted without wire_version', () => {
    const db = openDb(':memory:');
    migrate(db);

    // Insert a session so the FK is satisfied
    db.prepare(
      "INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES ('s1', 'r', 'p', 'b', 'a', 0)"
    ).run();

    // Insert a transcript using only the v0.1.x column set (no wire_version)
    db.prepare(
      "INSERT INTO transcripts (id, session_id, source, content, ingested_at) VALUES ('t1', 's1', 'plugin', 'hello', 0)"
    ).run();

    const row = db.prepare("SELECT wire_version FROM transcripts WHERE id='t1'").get() as { wire_version: string };
    expect(row.wire_version).toBe('v0.0');
  });

  it('stores new wire-contract fields when provided', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      "INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES ('s2', 'r', 'p', 'b', 'a', 0)"
    ).run();

    db.prepare(`
      INSERT INTO transcripts
        (id, session_id, source, content, ingested_at,
         event, captured_at, client_scrub_applied, client_scrub_hits,
         client_scrub_version, client_scrub_hits_by_label_json, client_version, wire_version)
      VALUES
        ('t2', 's2', 'saas', '{}', 1000,
         'transcript.ingested', 1700000000000, 1, 3,
         '1.2.0', '{"pii":2,"secret":1}', '0.9.1', 'v1.0')
    `).run();

    const row = db.prepare("SELECT * FROM transcripts WHERE id='t2'").get() as Record<string, unknown>;
    expect(row.event).toBe('transcript.ingested');
    expect(row.captured_at).toBe(1700000000000);
    expect(row.client_scrub_applied).toBe(1);
    expect(row.client_scrub_hits).toBe(3);
    expect(row.client_scrub_version).toBe('1.2.0');
    expect(row.client_scrub_hits_by_label_json).toBe('{"pii":2,"secret":1}');
    expect(row.client_version).toBe('0.9.1');
    expect(row.wire_version).toBe('v1.0');
  });

  it('ingest_idempotency key is primary key — duplicate key rejected', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      "INSERT INTO ingest_idempotency (key, body_hash, created_at) VALUES ('k1', 'abc123', 0)"
    ).run();

    expect(() =>
      db.prepare(
        "INSERT INTO ingest_idempotency (key, body_hash, created_at) VALUES ('k1', 'def456', 1)"
      ).run()
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration 003 — expand memories.type CHECK
// ---------------------------------------------------------------------------

describe('migration 003-expand-memory-types', () => {
  it('applies cleanly on a fresh DB', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(versions.v).toBe(25);
  });

  it('allows inserting type note after migration', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES ('m-note', 'note', 'a note', 'a note', 0.5, 0.5, 'hash-note', 1, 1)`
      ).run()
    ).not.toThrow();
  });

  it('allows inserting type event after migration', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES ('m-event', 'event', 'an event', 'an event', 0.5, 0.5, 'hash-event', 1, 1)`
      ).run()
    ).not.toThrow();
  });

  it('rejects type garbage after migration', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES ('m-bad', 'garbage', 'bad', 'bad', 0.5, 0.5, 'hash-bad', 1, 1)`
      ).run()
    ).toThrow();
  });

  it('preserves existing rows across migration — row count and types intact', () => {
    const db = openDb(':memory:');
    // Apply only migrations 001 + 002 by simulating a v0.3.3 DB state
    // We do this by running migrate() on a temp connection, then running 003 separately.
    // Since migrate() runs all files, we instead seed rows after a full migration
    // (the type constraint widening is additive — existing valid types all survive).
    migrate(db);

    // Insert 5 rows covering all original types
    const types = ['decision', 'fact', 'lesson', 'command', 'todo'] as const;
    for (const t of types) {
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0.5, 0.5, ?, 1, 1)`
      ).run(`id-${t}`, t, `text-${t}`, `text-${t}`, `hash-${t}`);
    }

    const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(count).toBe(5);

    // Verify each original type round-trips correctly
    for (const t of types) {
      const row = db.prepare('SELECT type FROM memories WHERE id = ?').get(`id-${t}`) as { type: string };
      expect(row.type).toBe(t);
    }
  });

  it('FTS5 still finds memories after migration', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
       VALUES ('fts-note', 'note', 'unique fts note content', 'unique fts note content', 0.5, 0.5, 'fts-hash-note', 1, 1)`
    ).run();

    const hits = db
      .prepare(`SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?`)
      .all('unique') as { id: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('fts-note');
  });
});

// ---------------------------------------------------------------------------
// Migration 005 — redaction_log (SEC-6)
// ---------------------------------------------------------------------------

describe('migration 005-security', () => {
  it('creates redaction_log with expected columns', () => {
    const db = openDb(':memory:');
    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('redaction_log');

    const cols = db.prepare('PRAGMA table_info(redaction_log)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('type');
    expect(colNames).toContain('count');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('created_at');
  });

  it('stores counts + type only — no value-shaped column exists', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(redaction_log)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('value');
    expect(colNames).not.toContain('secret');
  });

  it('accepts a row with session_id NULL', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        'INSERT INTO redaction_log (type, count, session_id, created_at) VALUES (?, ?, ?, ?)',
      ).run('github_token', 2, null, Date.now())
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration 007 — memory_events (ADR-002 decision point 1)
// ---------------------------------------------------------------------------

describe('migration 007-memory-events', () => {
  it('creates memory_events with expected columns', () => {
    const db = openDb(':memory:');
    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('memory_events');

    const cols = db.prepare('PRAGMA table_info(memory_events)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('seq');
    expect(colNames).toContain('event_type');
    expect(colNames).toContain('atom_id');
    expect(colNames).toContain('payload_json');
    expect(colNames).toContain('content_hash');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('synced_at');
  });

  it('rejects an event_type outside the CHECK enum', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memory_events (event_type, atom_id, created_at) VALUES ('garbage', 'm1', 1)`
      ).run()
    ).toThrow();
  });

  it('accepts every documented event_type', () => {
    const db = openDb(':memory:');
    migrate(db);
    const types = ['create', 'invalidate', 'supersede', 'promote_scope', 'erase_request', 'usefulness', 'archive', 'restore'];
    for (const t of types) {
      expect(() =>
        db.prepare(
          `INSERT INTO memory_events (event_type, atom_id, created_at) VALUES (?, 'm1', 1)`
        ).run(t)
      ).not.toThrow();
    }
  });
});

describe('migration 015-canonical-content-hash (astramem-local#84)', () => {
  it('recomputes 32-char legacy hashes to the full 64-char sha256 digest, leaves already-64-char hashes untouched, and re-syncs memory_events.content_hash', () => {
    const db = openDb(':memory:');
    migrate(db); // fresh DB — 001-015 all applied, including 015 (a no-op here, nothing to recompute yet)

    // Simulate a row written by one of the pre-fix /remember-family call
    // sites (POST /remember, the MCP remember tool, the memory-tool
    // adapter): a 32-char truncated sha256 hex digest of `text`.
    const text = 'legacy pre-fix remember text';
    const full = createHash('sha256').update(text, 'utf8').digest('hex');
    const legacy32 = full.slice(0, 32);
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at, valid_from, scope)
      VALUES ('legacy-1', 'fact', ?, ?, 0.5, 0.5, ?, 1, 1, 1, 'personal')
    `).run(text, text.toLowerCase(), legacy32);
    db.prepare(`
      INSERT INTO memory_events (event_type, atom_id, content_hash, created_at)
      VALUES ('create', 'legacy-1', ?, 1)
    `).run(legacy32);

    // Simulate a row written by the distill pipeline (stage 6/7's own
    // computeHash): already a full 64-char digest, just over NORMALIZED text
    // rather than raw text — must be left completely untouched.
    const normText = 'distill style already correct';
    const full64 = createHash('sha256').update(normText, 'utf8').digest('hex');
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at, valid_from, scope)
      VALUES ('distill-1', 'fact', ?, ?, 0.5, 0.5, ?, 2, 2, 2, 'personal')
    `).run(normText, normText, full64);
    db.prepare(`
      INSERT INTO memory_events (event_type, atom_id, content_hash, created_at)
      VALUES ('create', 'distill-1', ?, 2)
    `).run(full64);

    // Mark 015 as not-yet-applied so a re-run of migrate() re-executes its
    // recompute against this legacy-shaped data — mirrors the schema-version
    // drift guard tests' own "delete the last schema_version row" idiom
    // below, standing in for a genuine pre-#84 datadir being upgraded.
    db.prepare('DELETE FROM schema_version WHERE version = 15').run();
    migrate(db);

    const legacyRow = db.prepare('SELECT hash FROM memories WHERE id = ?').get('legacy-1') as { hash: string };
    const distillRow = db.prepare('SELECT hash FROM memories WHERE id = ?').get('distill-1') as { hash: string };
    const legacyEvent = db.prepare(`SELECT content_hash FROM memory_events WHERE atom_id = 'legacy-1'`).get() as { content_hash: string };
    const distillEvent = db.prepare(`SELECT content_hash FROM memory_events WHERE atom_id = 'distill-1'`).get() as { content_hash: string };

    // Recomputed to the full digest...
    expect(legacyRow.hash).toBe(full);
    expect(legacyRow.hash).toHaveLength(64);
    // ...and the dedup-safety guarantee: the leading 32 chars are IDENTICAL
    // to what was already stored — this only extends the digest, it never
    // changes what a row's hash prefix already was.
    expect(legacyRow.hash.startsWith(legacy32)).toBe(true);
    // memory_events.content_hash re-synced to mirror the (now 64-char) hash.
    expect(legacyEvent.content_hash).toBe(legacyRow.hash);

    // Already-64-char rows (distill pipeline) are byte-for-byte untouched.
    expect(distillRow.hash).toBe(full64);
    expect(distillEvent.content_hash).toBe(full64);
  });

  it('is idempotent — re-running after 015 already applied does not rehash a 64-char value', () => {
    const db = openDb(':memory:');
    migrate(db);
    const before = db.prepare('SELECT hash FROM memories WHERE 1=0').all(); // schema sanity only
    expect(before).toEqual([]);
    migrate(db); // second run: 015 already recorded in schema_version, skipped entirely
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 15').get() as { n: number };
    expect(versions.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Migration 016 — scope 'personal' -> 'private' rename (U7-local #110, DEC-048)
// AC-1: an existing scope='personal' row must read scope='private' after
// migration, with zero rows left at scope='personal', and any
// memory_events.payload_json `$.scope` occurrence swapped the same way.
// ---------------------------------------------------------------------------

describe("migration 016-scope-private-rename (astramem-local#110)", () => {
  it("renames every memories.scope='personal' row to 'private' and leaves team/org untouched", () => {
    const db = openDb(':memory:');
    migrate(db); // fresh DB — 001-016 all applied, including 016 (no-op here, nothing to seed yet)

    // Simulate a pre-rename datadir: seed rows the way a pre-#110 build would
    // have (scope='personal'), then mark 016 as not-yet-applied so re-running
    // migrate() re-executes the rename against this legacy-shaped data —
    // mirrors migration 015's own "delete the schema_version row" idiom above.
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at, valid_from, scope)
      VALUES ('legacy-personal-1', 'fact', 'legacy personal row', 'legacy personal row', 0.5, 0.5, 'h-personal-1', 1, 1, 1, 'personal')
    `).run();
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at, valid_from, scope)
      VALUES ('legacy-team-1', 'fact', 'legacy team row', 'legacy team row', 0.5, 0.5, 'h-team-1', 2, 2, 2, 'team')
    `).run();
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at, valid_from, scope)
      VALUES ('legacy-org-1', 'fact', 'legacy org row', 'legacy org row', 0.5, 0.5, 'h-org-1', 3, 3, 3, 'org')
    `).run();

    db.prepare('DELETE FROM schema_version WHERE version = 16').run();
    migrate(db);

    const scopes = db.prepare('SELECT id, scope FROM memories ORDER BY id').all() as { id: string; scope: string }[];
    expect(scopes).toEqual([
      { id: 'legacy-org-1', scope: 'org' },
      { id: 'legacy-personal-1', scope: 'private' },
      { id: 'legacy-team-1', scope: 'team' },
    ]);

    const remainingPersonal = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE scope = 'personal'`).get() as { n: number };
    expect(remainingPersonal.n).toBe(0);
  });

  it("rewrites memory_events.payload_json '$.scope' occurrences from 'personal' to 'private'", () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at, valid_from, scope)
      VALUES ('legacy-personal-2', 'fact', 'legacy personal row 2', 'legacy personal row 2', 0.5, 0.5, 'h-personal-2', 1, 1, 1, 'personal')
    `).run();
    // A 'create' event payload carrying the pre-rename literal (mirrors
    // MemoryRepo.insertWithCreateEvent's payload shape).
    db.prepare(`
      INSERT INTO memory_events (event_type, atom_id, payload_json, created_at)
      VALUES ('create', 'legacy-personal-2', '{"text":"legacy personal row 2","type":"fact","scope":"personal","importance":0.5,"confidence":0.5,"repo":""}', 1)
    `).run();
    // An 'erase_request' tombstone payload also carries a top-level `scope` key.
    db.prepare(`
      INSERT INTO memory_events (event_type, atom_id, payload_json, created_at)
      VALUES ('erase_request', 'ghost-personal', '{"scope":"personal","reason":null}', 2)
    `).run();
    // A 'promote_scope' payload uses from/to, not `scope` — must be left alone.
    db.prepare(`
      INSERT INTO memory_events (event_type, atom_id, payload_json, created_at)
      VALUES ('promote_scope', 'legacy-personal-2', '{"from":"personal","to":"team"}', 3)
    `).run();

    db.prepare('DELETE FROM schema_version WHERE version = 16').run();
    migrate(db);

    const createPayload = JSON.parse(
      (db.prepare(`SELECT payload_json FROM memory_events WHERE event_type = 'create' AND atom_id = 'legacy-personal-2'`).get() as { payload_json: string }).payload_json,
    );
    expect(createPayload.scope).toBe('private');

    const erasePayload = JSON.parse(
      (db.prepare(`SELECT payload_json FROM memory_events WHERE event_type = 'erase_request' AND atom_id = 'ghost-personal'`).get() as { payload_json: string }).payload_json,
    );
    expect(erasePayload.scope).toBe('private');

    // promote_scope's from/to keys are untouched — not targeted by AC-1's
    // `$.scope`-only scope.
    const promotePayload = JSON.parse(
      (db.prepare(`SELECT payload_json FROM memory_events WHERE event_type = 'promote_scope'`).get() as { payload_json: string }).payload_json,
    );
    expect(promotePayload).toEqual({ from: 'personal', to: 'team' });
  });

  it('is idempotent — re-running after 016 already applied does not error or re-touch already-private rows', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at, valid_from, scope)
      VALUES ('already-private-1', 'fact', 'already private row', 'already private row', 0.5, 0.5, 'h-already-private-1', 1, 1, 1, 'private')
    `).run();
    expect(() => migrate(db)).not.toThrow(); // 016 already recorded in schema_version, skipped entirely
    const row = db.prepare(`SELECT scope FROM memories WHERE id = 'already-private-1'`).get() as { scope: string };
    expect(row.scope).toBe('private');
  });
});

// ---------------------------------------------------------------------------
// Migration 017 — widen memories.type CHECK 7 -> 10 (U4-local #111/#112, ADR D4)
// ---------------------------------------------------------------------------

describe('migration 017-widen-memory-types', () => {
  it('applies cleanly on a fresh DB', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(versions.v).toBe(25);
  });

  it('accepts all 3 new canonical types (preference, task_result, summary)', () => {
    const db = openDb(':memory:');
    migrate(db);
    for (const t of ['preference', 'task_result', 'summary']) {
      expect(() =>
        db.prepare(
          `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0.5, 0.5, ?, 1, 1)`
        ).run(`m-${t}`, t, `a ${t}`, `a ${t}`, `hash-${t}`)
      ).not.toThrow();
    }
  });

  it('still rejects a type outside the widened 10-value union', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES ('m-bad-017', 'garbage', 'bad', 'bad', 0.5, 0.5, 'hash-bad-017', 1, 1)`
      ).run()
    ).toThrow();
  });

  it('preserves existing rows (all columns grown since 003) across the rewrite — row count, values, and the archival index survive', () => {
    const db = openDb(':memory:');
    migrate(db);

    // Seed a row exercising every column the table has grown since 003
    // (004 evidence; 006 valid_from/valid_to/superseded_by/derived_from/scope;
    // 013 archived/archived_at) — mark 017 not-yet-applied so re-running
    // migrate() re-executes the rewrite against this fully-populated shape,
    // mirroring migrations 015/016's own "delete the schema_version row" idiom.
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, repo, project, branch, agent, session_id,
         importance, confidence, hash, embedding_provider, embedding_model, embedding_dim,
         created_at, updated_at, source_hash, evidence, valid_from, valid_to,
         superseded_by, derived_from, scope, archived, archived_at)
      VALUES
        ('full-row-1', 'fact', 'full row text', 'full row text', 'r1', 'p1', 'b1', 'a1', NULL,
         0.7, 0.6, 'hash-full-row-1', 'ollama', 'mxbai', 1024,
         100, 200, 'src-hash-1', 'evidence excerpt', 100, NULL,
         NULL, '["dep-1","dep-2"]', 'team', 1, 300)
    `).run();

    // FEAT-453 migration 023 also rewrites memory_entities (surrogate-PK
    // shape); 017's own rewrite independently backs memory_entities up and
    // restores it verbatim in its PRE-023 2-column shape (FK-cascade dance
    // around its `memories` rewrite, unrelated to what THIS test asserts).
    // Re-running 017 in isolation on an already-023-migrated db would fail
    // structurally (017's hardcoded recreate expects 2 columns, the live
    // table has 5) — reset memory_entities back to its pre-023 shape here,
    // orthogonal to the `memories`-table behavior this test actually checks,
    // then let both 017 and 023 re-apply in their normal file order.
    db.prepare('DELETE FROM schema_version WHERE version IN (17, 23)').run();
    db.exec(`
      DROP INDEX IF EXISTS idx_memory_entities_entity;
      DROP INDEX IF EXISTS idx_memory_entities_memory;
      DROP INDEX IF EXISTS idx_memory_entities_open_window;
      DROP TABLE memory_entities;
      CREATE TABLE memory_entities (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        PRIMARY KEY (memory_id, entity_id)
      );
      CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);
    `);
    migrate(db);

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get('full-row-1') as Record<string, unknown>;
    expect(row.type).toBe('fact');
    expect(row.text).toBe('full row text');
    expect(row.repo).toBe('r1');
    expect(row.project).toBe('p1');
    expect(row.branch).toBe('b1');
    expect(row.agent).toBe('a1');
    expect(row.importance).toBe(0.7);
    expect(row.confidence).toBe(0.6);
    expect(row.embedding_provider).toBe('ollama');
    expect(row.embedding_dim).toBe(1024);
    expect(row.source_hash).toBe('src-hash-1');
    expect(row.evidence).toBe('evidence excerpt');
    expect(row.valid_from).toBe(100);
    expect(row.derived_from).toBe('["dep-1","dep-2"]');
    expect(row.scope).toBe('team');
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBe(300);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(count).toBe(1);

    // Indexes recreated, including the 013-archival candidate index.
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memories'").all() as { name: string }[];
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_memories_hash');
    expect(indexNames).toContain('idx_memories_repo_type');
    expect(indexNames).toContain('idx_memories_session');
    expect(indexNames).toContain('idx_memories_archival_candidates');
  });

  it('FTS5 still finds memories after the rewrite', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
       VALUES ('fts-017', 'preference', 'unique 017 fts content', 'unique 017 fts content', 0.5, 0.5, 'fts-hash-017', 1, 1)`
    ).run();

    const hits = db
      .prepare(`SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?`)
      .all('017') as { id: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('fts-017');
  });

  it('is idempotent — re-running after 017 already applied does not error', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 17').get() as { n: number };
    expect(versions.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Migration 018 — partial expression index on jobs(json_extract(payload_json,
// '$.session_id')) WHERE kind='distill' (hygiene batch 2026-07-08)
// ---------------------------------------------------------------------------

describe('migration 018-jobs-distill-session-index', () => {
  it('applies cleanly on a fresh DB', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(versions.v).toBe(25);
  });

  it('creates the partial expression index on jobs', () => {
    const db = openDb(':memory:');
    migrate(db);
    const idx = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'")
      .all() as { name: string; sql: string }[];
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_jobs_state');
    expect(names).toContain('idx_jobs_distill_session');
    const distillIdx = idx.find(i => i.name === 'idx_jobs_distill_session')!;
    expect(distillIdx.sql).toContain("json_extract(payload_json, '$.session_id')");
    expect(distillIdx.sql).toContain("WHERE kind = 'distill'");
  });

  it('the index actually serves the digest-style query — same rows returned, EXPLAIN QUERY PLAN shows the index name', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      "INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at) VALUES (?, 'distill', ?, 'poison', 3, 1, 1)"
    ).run('j-poison-1', JSON.stringify({ transcript_id: 't1', session_id: 's-target' }));
    db.prepare(
      "INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at) VALUES (?, 'distill', ?, 'poison', 3, 2, 2)"
    ).run('j-poison-2', JSON.stringify({ transcript_id: 't2', session_id: 's-other' }));
    // A non-distill job sharing the same session_id must not match — proves
    // the partial index (and the query) both scope on kind='distill'.
    db.prepare(
      "INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at) VALUES (?, 'reembed', ?, 'poison', 3, 3, 3)"
    ).run('j-other-kind', JSON.stringify({ session_id: 's-target' }));

    const rows = db.prepare(`
      SELECT id FROM jobs
      WHERE kind = 'distill' AND state = 'poison'
        AND json_extract(payload_json, '$.session_id') = ?
    `).all('s-target') as { id: string }[];
    expect(rows.map(r => r.id)).toEqual(['j-poison-1']);

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM jobs
      WHERE kind = 'distill' AND state = 'poison'
        AND json_extract(payload_json, '$.session_id') = ?
    `).all('s-target') as { detail: string }[];
    expect(plan.some(p => p.detail.includes('idx_jobs_distill_session'))).toBe(true);
  });

  it('is idempotent — re-running after 018 already applied does not error', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 18').get() as { n: number };
    expect(versions.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Migration 019 — memory_events usefulness partial indexes + memories.agent
// covering index (perf baseline 2026-07-08, candidates #2/#3)
// ---------------------------------------------------------------------------

describe('migration 019-health-agent-profile-indexes', () => {
  it('applies cleanly on a fresh DB', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(versions.v).toBe(25);
  });

  it('creates both partial expression indexes on memory_events', () => {
    const db = openDb(':memory:');
    migrate(db);
    const idx = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_events'")
      .all() as { name: string; sql: string }[];
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_memory_events_usefulness_served');
    expect(names).toContain('idx_memory_events_usefulness_used');

    const served = idx.find(i => i.name === 'idx_memory_events_usefulness_served')!;
    expect(served.sql).toContain("json_extract(payload_json, '$.family') = 'recall_served'");
    expect(served.sql).toContain("event_type = 'usefulness'");

    const used = idx.find(i => i.name === 'idx_memory_events_usefulness_used')!;
    expect(used.sql).toContain("json_extract(payload_json, '$.family') = 'recall_used'");
    expect(used.sql).toContain("event_type = 'usefulness'");
  });

  it('creates the covering index on memories(agent, valid_to, archived, type, created_at)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const idx = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memories'")
      .all() as { name: string; sql: string }[];
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_memories_agent');
    const agentIdx = idx.find(i => i.name === 'idx_memories_agent')!;
    expect(agentIdx.sql).toContain('agent');
    expect(agentIdx.sql).toContain('valid_to');
    expect(agentIdx.sql).toContain('archived');
    expect(agentIdx.sql).toContain('type');
    expect(agentIdx.sql).toContain('created_at');
  });

  it('the usefulness-served index actually serves usefulnessRate()\'s served query — EXPLAIN QUERY PLAN shows the index name', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      "INSERT INTO memory_events (event_type, atom_id, payload_json, created_at) VALUES ('usefulness', ?, ?, ?)"
    ).run('m1', JSON.stringify({ family: 'recall_served', surface: 'rest' }), 100);
    // A different family sharing the same event_type must not match the
    // 'served' partial index — proves both the index and the query scope on
    // family, not just event_type.
    db.prepare(
      "INSERT INTO memory_events (event_type, atom_id, payload_json, created_at) VALUES ('usefulness', ?, ?, ?)"
    ).run('m1', JSON.stringify({ family: 'recall_used', surface: 'rest' }), 200);

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(DISTINCT atom_id) AS n
      FROM memory_events
      WHERE event_type = 'usefulness'
        AND json_extract(payload_json, '$.family') = 'recall_served'
        AND created_at >= ?
    `).all(0) as { detail: string }[];
    expect(plan.some(p => p.detail.includes('idx_memory_events_usefulness_served'))).toBe(true);
  });

  it('the memories.agent index actually serves the agent-profile ACTIVE_CLAUSE query — EXPLAIN QUERY PLAN shows the index name', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO memories (id, type, text, normalized_text, agent, importance, confidence, hash, valid_to, archived, created_at, updated_at)
       VALUES ('mem-1', 'lesson', 'x', 'x', 'agent-a', 0.5, 0.5, 'h1', NULL, 0, 1, 1)`
    ).run();

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, text, importance, created_at
      FROM memories
      WHERE agent = ? AND valid_to IS NULL AND archived = 0 AND type = 'lesson'
    `).all('agent-a') as { detail: string }[];
    expect(plan.some(p => p.detail.includes('idx_memories_agent'))).toBe(true);
  });

  it('is idempotent — re-running after 019 already applied does not error', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 19').get() as { n: number };
    expect(versions.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Migration 020 — memory_events corrections-join index (follow-up to 019;
// fixes a query-planner join-order regression 019 introduced in
// buildAgentProfile's queryCorrections — see migration 020 file header)
// ---------------------------------------------------------------------------

describe('migration 020-agent-profile-corrections-index', () => {
  it('applies cleanly on a fresh DB', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(versions.v).toBe(25);
  });

  it('creates the partial expression index on memory_events for invalidate/supersede', () => {
    const db = openDb(':memory:');
    migrate(db);
    const idx = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_events'")
      .all() as { name: string; sql: string }[];
    const names = idx.map(i => i.name);
    expect(names).toContain('idx_memory_events_correction_type');
    const correctionIdx = idx.find(i => i.name === 'idx_memory_events_correction_type')!;
    expect(correctionIdx.sql).toContain("event_type IN ('invalidate', 'supersede')");
  });

  it('restores the memory_events-driven join order for the agent-profile corrections query — EXPLAIN QUERY PLAN drives from memory_events, not memories', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO memories (id, type, text, normalized_text, agent, importance, confidence, hash, valid_to, archived, created_at, updated_at)
       VALUES ('mem-1', 'lesson', 'x', 'x', 'agent-a', 0.5, 0.5, 'h1', NULL, 0, 1, 1)`
    ).run();
    db.prepare(
      "INSERT INTO memory_events (event_type, atom_id, payload_json, created_at) VALUES ('invalidate', 'mem-1', '{}', 5)"
    ).run();

    const rows = db.prepare(`
      SELECT e.event_type, m.id
      FROM memory_events e JOIN memories m ON m.id = e.atom_id
      WHERE m.agent = ? AND e.event_type IN ('invalidate', 'supersede')
      ORDER BY e.created_at DESC LIMIT 5
    `).all('agent-a') as { event_type: string; id: string }[];
    expect(rows).toEqual([{ event_type: 'invalidate', id: 'mem-1' }]);

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT e.event_type, m.id
      FROM memory_events e JOIN memories m ON m.id = e.atom_id
      WHERE m.agent = ? AND e.event_type IN ('invalidate', 'supersede')
      ORDER BY e.created_at DESC LIMIT 5
    `).all('agent-a') as { detail: string }[];
    // The join must be driven from memory_events (via the new index), with
    // memories probed second by its PK — the reverse of what 019 alone
    // produced, which drove from idx_memories_agent and nested-loop-probed
    // memory_events per candidate row.
    expect(plan.some(p => /SEARCH e USING (COVERING )?INDEX idx_memory_events_correction_type/.test(p.detail))).toBe(true);
    expect(plan.some(p => /SEARCH m USING/.test(p.detail) && p.detail.includes('idx_memories_agent'))).toBe(false);
  });

  it('is idempotent — re-running after 020 already applied does not error', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 20').get() as { n: number };
    expect(versions.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Schema-version drift guard (D-R2)
// migrate() must throw when SCHEMA_VERSION constant and DB max diverge.
// ---------------------------------------------------------------------------

describe('migrate — schema-version drift guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes when DB max version matches SCHEMA_VERSION constant', () => {
    const db = openDb(':memory:');
    // Normal path: all migrations applied, constant matches DB
    expect(() => migrate(db)).not.toThrow();
  });

  it('throws a clear error when SCHEMA_VERSION constant is ahead of DB', async () => {
    // Simulate constant drift: mock wire-meta to report a higher version than what migrations apply.
    // migrate.ts only imports SCHEMA_VERSION from wire-meta.js (see src/storage/migrate.ts:5), so
    // WIRE_VERSIONS_SUPPORTED/CONTRACT_SCHEMA_VERSION here are inert stand-ins for shape parity with
    // the real module — kept in the domain@gen shape (U6, #106) so this mock doesn't silently drift
    // from wire-meta.ts's actual exports.
    vi.doMock('../../src/server/lib/wire-meta.js', () => ({
      SCHEMA_VERSION: 999,
      WIRE_VERSIONS_SUPPORTED: ['atom@1', 'retrieval@1', 'sync@1', 'capture@1'],
      CONTRACT_SCHEMA_VERSION: '1',
      PKG_VERSION: '0.2.0',
    }));

    const { migrate: migrateMocked } = await import('../../src/storage/migrate.js');
    const db = openDb(':memory:');

    expect(() => migrateMocked(db)).toThrow(
      /Schema-version constant drift: wire-meta says 999, DB says 25/,
    );
  });
});

// ---------------------------------------------------------------------------
// FEAT-409 AC-3 (HIGH fix) — getVecSchemaDim + boot preflight against the
// PERSISTED schema dim, not just provider self-consistency.
// ---------------------------------------------------------------------------

function makeEmbedProvider(dim: number): EmbedProvider {
  return {
    name: 'ollama',
    model: 'test-model',
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array(dim).fill(0.1));
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-model', dim };
    },
  };
}

describe('getVecSchemaDim', () => {
  it('returns null before migrate() creates memories_vec', () => {
    const db = openDb(':memory:');
    expect(getVecSchemaDim(db)).toBeNull();
  });

  it('reads the dim baked into memories_vec at creation time', () => {
    const db = openDb(':memory:');
    migrate(db, 1024);
    expect(getVecSchemaDim(db)).toBe(1024);
  });

  it('reflects a non-default dim if the DB was created with one', () => {
    const db = openDb(':memory:');
    migrate(db, 768);
    expect(getVecSchemaDim(db)).toBe(768);
  });

  it('keeps reporting the ORIGINAL dim after a no-op re-migrate with a different dim argument (migrate() is a no-op for already-applied migrations)', () => {
    const db = openDb(':memory:');
    migrate(db, 1024);
    migrate(db, 768); // no-op — schema_version already has these migrations
    expect(getVecSchemaDim(db)).toBe(1024);
  });
});

describe('boot preflight against the persisted schema dim (AC-3)', () => {
  it('an existing FLOAT[1024] DB + a provider self-consistently configured for dim=768 fails loud with a clear dim-mismatch message — not a raw sqlite-vec error later', async () => {
    const db = openDb(':memory:');
    migrate(db, 1024); // simulates an existing DB that was never re-embedded

    // Provider is internally self-consistent (claims 768, returns 768) —
    // the OLD preflight (expectedDim defaulting to provider.dim) would pass
    // this. Only checking against the real schema dim catches the drift.
    const provider = makeEmbedProvider(768);
    const schemaDim = getVecSchemaDim(db);
    expect(schemaDim).toBe(1024);

    const result = await embedProbe(provider, 5000, schemaDim ?? provider.dim);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('dim 768');
    expect(result.message).toContain('expected 1024');
  });

  it('an existing FLOAT[1024] DB + a provider configured for dim=1024 (matching schema) still passes', async () => {
    const db = openDb(':memory:');
    migrate(db, 1024);

    const provider = makeEmbedProvider(1024);
    const schemaDim = getVecSchemaDim(db);

    const result = await embedProbe(provider, 5000, schemaDim ?? provider.dim);
    expect(result.ok).toBe(true);
  });
});
